#!/usr/bin/env node
/**
 * Devin CLI PostCompaction hook.
 *
 * After Devin's built-in compaction runs, this hook reloads the session
 * transcript, asks Jev which tool calls/results still matter, dedupes those
 * against the post-compaction context (the compactor's summary plus the
 * retained tail of the transcript), and re-injects whatever verbatim detail
 * was lost via hookSpecificOutput.additionalContext.
 *
 * stdin : {"session_id": "...", "summary": "..."|null, ...}
 * stdout: hookSpecificOutput JSON (or nothing)
 * Never blocks: any failure exits 0 silently (logged to compaction-restores.log).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { compactMessages } from './messages.js';
import { collectToolCalls } from './state.js';
import { envOptions } from './config.js';
import type { CallDecision, Message } from './types.js';

const TRANSCRIPTS_DIR = join(homedir(), '.local/share/devin/cli/transcripts');
const LOG_FILE = join(homedir(), '.local/share/devin/cli/compaction-restores.log');
const TAIL_STEPS = 15; // approximate the verbatim tail Devin keeps post-compaction
const MAX_ITEMS = 10;
const MAX_CHARS = 6000;
const RESULT_SNIPPET = 900;

function log(line: string): void {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging is best-effort */
  }
}

interface DevinStep {
  source?: string;
  message?: unknown;
  tool_calls?: { tool_call_id: string; function_name: string; arguments?: Record<string, unknown> }[];
  observation?: { results?: { source_call_id: string; content?: unknown }[] };
}

/** Transcript steps sometimes carry non-string `message` payloads (structured blocks). */
const stepText = (v: unknown): string =>
  typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);

function toMessages(steps: DevinStep[]): Message[] {
  const out: Message[] = [];
  for (const step of steps) {
    if (step.source === 'user') {
      out.push({ role: 'user', text: stepText(step.message), toolUses: [] });
    } else if (step.source === 'agent') {
      const toolUses = (step.tool_calls ?? []).map((c) => ({
        tool_use_id: c.tool_call_id,
        tool: c.function_name,
        input: c.arguments ?? {},
      }));
      out.push({ role: 'assistant', text: stepText(step.message), toolUses });
      const results = step.observation?.results ?? [];
      if (results.length) {
        out.push({
          role: 'user',
          text: '',
          toolUses: [],
          toolResults: results.map((r) => {
            const text = typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? '');
            return {
              tool_use_id: r.source_call_id,
              text,
              isError: /\b(error|failed|exception|traceback|exit code [1-9])\b/i.test(text.slice(0, 400)),
            };
          }),
        });
      }
    }
  }
  return out;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** True if a result's distinctive lines already appear verbatim in the kept context. */
function resultCovered(resultText: string, keptContext: string): boolean {
  const lines = resultText.split('\n').map(norm).filter((l) => l.length >= 24);
  if (lines.length === 0) {
    const probe = norm(resultText).slice(0, 60);
    return probe.length < 12 || keptContext.includes(probe);
  }
  const probes = [...new Set([0, 1, 2, Math.floor(lines.length / 2), lines.length - 2, lines.length - 1])]
    .filter((i) => i >= 0 && i < lines.length)
    .map((i) => lines[i]!);
  const hits = probes.filter((p) => keptContext.includes(p)).length;
  return hits / probes.length >= 0.6;
}

/** Distinctive input values used to recognize a call (paths, commands, patterns…). */
function callSignature(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'command', 'pattern', 'path', 'query', 'url', 'notebook_path']) {
    const v = input[key];
    if (typeof v === 'string' && v.length >= 4) return `${key}=${v.slice(0, 160)}`;
  }
  return norm(JSON.stringify(input)).slice(0, 160);
}

interface KeptItem {
  tool: string;
  signature: string;
  snippet: string;
  keepResult: number;
}

async function main(): Promise<void> {
  const stdinRaw = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(c as Buffer));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
    setTimeout(() => resolve(''), 3000);
  });

  const payload = JSON.parse(stdinRaw || '{}') as { session_id?: string; summary?: string | null };
  const sessionId = payload.session_id;
  const summary = payload.summary ?? '';
  if (!sessionId) return;

  const transcriptPath = join(TRANSCRIPTS_DIR, `${sessionId}.json`);
  if (!existsSync(transcriptPath)) return log(`no transcript for ${sessionId}`);

  const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8')) as { steps?: DevinStep[] };
  const steps = transcript.steps ?? [];
  if (steps.length === 0) return;

  const messages = toMessages(steps);
  const result = await compactMessages(messages, { ...envOptions(), preserveRecentMessages: TAIL_STEPS });

  // Post-compaction context ≈ summary + verbatim tail Devin retains.
  const tailText = steps
    .slice(-TAIL_STEPS)
    .map((s) => [s.message ?? '', ...(s.observation?.results ?? []).map((r) => String(r.content ?? ''))].join(' '))
    .join('\n');
  const keptContext = `${summary}\n${tailText}`;

  // Re-inject candidates: calls Jev kept (not merely pinned). Dedup vs keptContext.
  const callById = new Map(
    collectToolCalls(messages, TAIL_STEPS).map((c) => [c.id, c] as const),
  );
  const resultByCall = new Map<string, string>();
  for (const s of steps) {
    for (const c of s.tool_calls ?? []) {
      const r = (s.observation?.results ?? []).find((x) => x.source_call_id === c.tool_call_id);
      resultByCall.set(c.tool_call_id, typeof r?.content === 'string' ? r.content : JSON.stringify(r?.content ?? ''));
    }
  }

  const seen = new Set<string>();
  const items: KeptItem[] = [];
  for (const d of result.decisions as CallDecision[]) {
    if (d.reason === 'pinned' || d.action === 'drop_call') continue;
    const toolCall = callById.get(d.id);
    if (!toolCall) continue;
    const toolUse = { tool: toolCall.tool, input: toolCall.input, tool_use_id: toolCall.tool_use_id };
    const signature = callSignature(toolUse.input);
    if (seen.has(`${toolUse.tool}:${signature}`)) continue;
    seen.add(`${toolUse.tool}:${signature}`);

    const resultText = resultByCall.get(toolUse.tool_use_id) ?? '';
    if (d.action === 'keep' && resultText) {
      if (resultCovered(resultText, keptContext)) continue; // already verbatim in context
      items.push({
        tool: toolUse.tool,
        signature,
        snippet: norm(resultText).slice(0, RESULT_SNIPPET),
        keepResult: d.keepResult,
      });
    } else {
      const value = signature.includes('=') ? signature.slice(signature.indexOf('=') + 1) : signature;
      const covered = keptContext.includes(value) || (resultText !== '' && resultCovered(resultText, keptContext));
      if (covered) continue;
      const head = norm(resultText).slice(0, 300);
      items.push({
        tool: toolUse.tool,
        signature,
        snippet: head ? `${head} …(truncated, re-run to see all)` : '(call still relevant)',
        keepResult: d.keepResult,
      });
    }
  }

  items.sort((a, b) => b.keepResult - a.keepResult);
  const picked: KeptItem[] = [];
  let chars = 0;
  for (const item of items) {
    if (picked.length >= MAX_ITEMS || chars + item.snippet.length > MAX_CHARS) break;
    picked.push(item);
    chars += item.snippet.length;
  }
  if (picked.length === 0) return log(`${sessionId}: nothing lost worth restoring (${result.decisions.length} calls judged)`);

  const lines = picked.map((i) => `- ${i.tool} ${i.signature} → ${i.snippet}`).join('\n');
  const context =
    'Post-compaction restore: the tool call details below were judged still relevant by Jev ' +
    'but are not covered verbatim by the compaction summary. Treat them as observed facts from earlier in this session.\n' +
    lines;

  log(`${sessionId}: re-injected ${picked.length} items, ${context.length} chars`);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostCompaction', additionalContext: context },
    }) + '\n',
  );
}

main().catch((e) => {
  log(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0);
});
