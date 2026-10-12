#!/usr/bin/env node
/**
 * fast-jev-compact — compact an agent transcript through Jev.
 *
 *   fast-jev-compact [transcript.json] [--stats]
 *
 * Reads a JSON array of messages (or {"messages": [...]}) from a file or stdin,
 * writes the compacted transcript JSON to stdout, stats to stderr.
 */

import { readFileSync } from 'node:fs';
import { compactMessages } from './messages.js';
import { reductionRatio } from './compact.js';
import { envOptions } from './config.js';
import type { Message } from './types.js';

function usage(): never {
  process.stderr.write('usage: fast-jev-compact [transcript.json] [--stats]\n');
  process.exit(2);
}

async function readInput(file?: string): Promise<string> {
  if (file && file !== '-') return readFileSync(file, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const showStats = args.includes('--stats');
if (args.some((a) => a === '-h' || a === '--help')) usage();

const raw = JSON.parse(await readInput(file));
const messages: Message[] = Array.isArray(raw) ? raw : raw.messages;
if (!Array.isArray(messages)) {
  process.stderr.write('error: input must be a JSON array or {"messages": [...]}\n');
  process.exit(2);
}

const result = await compactMessages(messages, envOptions());
const ratio = reductionRatio(result);

process.stderr.write(
  `fast-jev-compact: ${result.stats.messagesBefore} -> ${result.stats.messagesAfter} messages, ` +
    `${result.stats.charsBefore} -> ${result.stats.charsAfter} chars ` +
    `(reduction ${(ratio * 100).toFixed(1)}%, requests ${result.stats.requests})\n`,
);

process.stdout.write(JSON.stringify(showStats ? result : result.messages, null, 2) + '\n');
