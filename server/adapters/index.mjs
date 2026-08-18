import { claudeAdapter } from './claude.mjs';
import { codexAdapter } from './codex.mjs';
import { dshAdapter } from './dsh.mjs';
import { openclawAdapter } from './openclaw.mjs';

// Registry of adapter types usable from agents.json ("adapter": "<key>").
// Adapter objects are stateless (sessions live in the hub, keyed by agent id),
// so one adapter object can back multiple configured agents.
export const ADAPTER_TYPES = {
  claude: claudeAdapter,
  codex: codexAdapter,
  dsh: dshAdapter,
  openclaw: openclawAdapter,
};
