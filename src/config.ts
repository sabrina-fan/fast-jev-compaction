import type { CompactMessagesOptions } from './messages.js';

/**
 * Shared env resolution for the CLI and MCP server entry points.
 * `JEV_*` vars take precedence so any System One-compatible endpoint
 * (e.g. OpenCode Zen) can be used without touching TypeSafe settings.
 */
export function envOptions(): CompactMessagesOptions {
  const env = process.env;
  return {
    apiKey: env.JEV_API_KEY ?? env.TYPESAFE_API_KEY,
    baseUrl: env.JEV_BASE_URL ?? env.TYPESAFE_BASE_URL,
    model: env.JEV_MODEL ?? env.TYPESAFE_MODEL,
  };
}
