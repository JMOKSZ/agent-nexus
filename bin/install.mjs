#!/usr/bin/env node
// NEXUS Command Deck — interactive installer.
// Sets up dependencies, generates ~/.agent-nexus/agents.json for your agent
// team, and (on macOS) installs the launchd background service.
//
// Usage:
//   node bin/install.mjs              interactive
//   node bin/install.mjs --yes        accept all defaults (non-interactive)
//   node bin/install.mjs --no-launchd skip the background service
//   node bin/install.mjs --skip-deps  skip npm install

import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
const NEXUS_DIR = join(HOME, '.agent-nexus');
const AGENTS_FILE = join(NEXUS_DIR, 'agents.json');
const PORT = 7700;

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) {
  console.log(`usage: node bin/install.mjs [--yes|-y] [--no-launchd] [--skip-deps]

  --yes, -y     accept all defaults (non-interactive)
  --no-launchd  skip the macOS background service
  --skip-deps   skip npm install`);
  process.exit(0);
}
const YES = args.has('--yes') || args.has('-y');
const NO_LAUNCHD = args.has('--no-launchd');
const SKIP_DEPS = args.has('--skip-deps');

const c = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const ok = (s) => console.log(`  ${c.green('✓')} ${s}`);
const warn = (s) => console.log(`  ${c.yellow('!')} ${s}`);
const bad = (s) => console.log(`  ${c.red('✗')} ${s}`);
const step = (s) => console.log(`\n${c.bold(c.cyan(s))}`);

const rl = YES ? null : createInterface({ input: process.stdin, output: process.stdout });
// Piped stdin closes before readline questions attach and lines get lost —
// buffer all of stdin upfront in that case (also makes the installer scriptable).
let pipedLines = null;
async function ask(question, fallback) {
  if (YES) return fallback;
  const suffix = fallback === '' ? ' ' : c.dim(` [${fallback}] `);
  if (!process.stdin.isTTY) {
    if (!pipedLines) {
      let buf = '';
      for await (const chunk of process.stdin) buf += chunk;
      pipedLines = buf.split(/\r?\n/);
    }
    const a = (pipedLines.shift() ?? '').trim();
    console.log(`  ${question}${suffix}${c.cyan(a || fallback)}`);
    return a === '' ? fallback : a;
  }
  const a = (await rl.question(`  ${question}${suffix}`)).trim();
  return a === '' ? fallback : a;
}
async function confirm(question, fallback = true) {
  const hint = fallback ? 'Y/n' : 'y/N';
  const a = (await ask(`${question} ${c.dim(`(${hint})`)}`, '')).toLowerCase();
  if (!a) return fallback;
  return a === 'y' || a === 'yes';
}

function which(bin) {
  try {
    return execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim() || null;
  } catch { return null; }
}

// ── built-in agent catalog (mirrors agents.example.json) ──
const CATALOG = [
  {
    id: 'claude', name: 'CLAUDE', color: '#00f0ff', desc: 'Claude Code CLI',
    adapter: 'claude', modelHint: 'claude-sonnet-4-6 (empty = default)', ctxChars: 900, cwd: '~',
    terminal: true,
    detect: () => which('claude'),
  },
  {
    id: 'codex', name: 'CODEX', color: '#ff2fd6', desc: 'Codex CLI',
    adapter: 'codex', modelHint: 'gpt-5-codex (empty = default)', ctxChars: 900,
    detect: () => which('codex')
      || (existsSync('/Applications/Codex.app/Contents/Resources/codex') ? '/Applications/Codex.app' : null),
  },
  {
    id: 'dsh', name: 'DEEPSEEK', color: '#7cff4f', desc: 'DSH · headless harness',
    adapter: 'dsh', modelHint: '(dsh has no model flag; only extra args apply)', ctxChars: 1800,
    detect: () => which('dsh'),
  },
  {
    id: 'openclaw', name: 'OPENCLAW', color: '#b78bff', desc: 'OpenClaw · local gateway',
    adapter: 'openclaw', modelHint: 'zhipu/glm-5.2 (empty = default)', ctxChars: 700,
    detect: () => which('openclaw'),
  },
  {
    id: 'hermes', name: 'HERMES', color: '#ffd166', desc: 'Hermes Agent CLI',
    adapter: 'hermes', modelHint: '(empty = default model)', ctxChars: 900, cwd: '~',
    detect: () => which('hermes'),
  },
];
const PALETTE = ['#00f0ff', '#ff2fd6', '#7cff4f', '#b78bff', '#ffd166', '#ff8c42', '#6ea8ff', '#f472b6'];
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

console.log(c.bold(`
  ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗
  ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝
  ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗
  ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║
  ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║
  ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝  // COMMAND DECK
`));

// ── step 1: runtime checks ──
step('1/5 · Checking runtime');
const [maj, min] = process.versions.node.split('.').map(Number);
ok(`Node ${process.versions.node} (${process.execPath})`);
try {
  await import('node:sqlite');
  ok('node:sqlite available (shared memory store)');
} catch {
  bad('node:sqlite is not available in this Node build.');
  console.log(`     NEXUS needs Node ≥ 22.5 (recommended ≥ 23.4). Current: ${process.versions.node}`);
  console.log('     Install a newer Node, e.g.:  brew install node');
  process.exit(1);
}
if (maj < 22 || (maj === 22 && min < 5)) warn('Node < 22.5 — expect trouble; upgrade recommended.');

// ── step 2: dependencies ──
step('2/5 · Installing dependencies');
if (SKIP_DEPS || existsSync(join(ROOT, 'node_modules', 'node-pty'))) {
  ok(SKIP_DEPS ? 'skipped (--skip-deps)' : 'node_modules already present — skipped');
} else {
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    bad('npm install failed.');
    console.log('     node-pty needs Xcode Command Line Tools to compile:  xcode-select --install');
    console.log('     Then re-run:  node bin/install.mjs');
    process.exit(1);
  }
  ok('npm install done (node-pty, ws, xterm)');
}

// ── step 3: agent team ──
step('3/5 · Assembling your agent team');
const team = [];
for (const spec of CATALOG) {
  const found = spec.detect();
  if (!found) {
    warn(`${spec.name} — CLI not found, skipped ${c.dim('(install it later and re-run the installer to add)')}`);
    continue;
  }
  ok(`${spec.name} — found at ${c.dim(found)}`);
  if (await confirm(`    Include ${spec.name} in the team?`, true)) {
    const { detect, ...entry } = spec;
    team.push(entry);
  }
}

// custom extra agents (same adapter types, different id — e.g. a second claude)
while (!YES && team.length && await confirm('Add another agent (same adapter, e.g. a second claude)?', false)) {
  const id = await ask('    id (lowercase, used for @targeting)', '');
  if (!ID_RE.test(id)) { bad(`    invalid id "${id}" — skipped`); continue; }
  if (team.some((a) => a.id === id)) { bad(`    id "${id}" already in team — skipped`); continue; }
  const adapter = await ask(`    adapter (${CATALOG.map((a) => a.adapter).join(' | ')})`, 'claude');
  if (!CATALOG.some((a) => a.adapter === adapter)) { bad(`    unknown adapter "${adapter}" — skipped`); continue; }
  const name = (await ask('    display name', id.toUpperCase()));
  const color = PALETTE.find((pc) => !team.some((a) => a.color === pc)) || PALETTE[team.length % PALETTE.length];
  team.push({ id, name, color, desc: `${adapter} adapter`, adapter, ctxChars: 900 });
  ok(`    added ${name} ${c.dim(`(${id}, ${adapter})`)}`);
}

if (!team.length) {
  warn('No agents selected — the deck will start with an empty roster.');
  warn('You can create/edit ~/.agent-nexus/agents.json any time; see agents.example.json.');
}

mkdirSync(NEXUS_DIR, { recursive: true });
if (existsSync(AGENTS_FILE)) {
  if (await confirm(`\n  ${AGENTS_FILE} already exists. Overwrite?`, false)) {
    const bak = `${AGENTS_FILE}.bak.${Date.now()}`;
    copyFileSync(AGENTS_FILE, bak);
    writeFileSync(AGENTS_FILE, JSON.stringify(team, null, 2) + '\n');
    ok(`overwritten (backup: ${bak})`);
  } else {
    ok('kept existing agents.json');
  }
} else if (team.length) {
  writeFileSync(AGENTS_FILE, JSON.stringify(team, null, 2) + '\n');
  ok(`wrote ${AGENTS_FILE} (${team.length} agent${team.length > 1 ? 's' : ''})`);
}

// ── step 4: background service ──
step('4/5 · Background service');
let serviceInstalled = false;
if (platform() !== 'darwin') {
  warn('Not macOS — skipping launchd. Run the deck with:  npm start');
  warn('For autostart use your init system (systemd --user, pm2, …).');
} else if (NO_LAUNCHD) {
  ok('skipped (--no-launchd)');
} else if (await confirm('Install launchd service (auto-start on login, restart on crash)?', true)) {
  const tpl = readFileSync(join(ROOT, 'launchd', 'com.agent-nexus.plist'), 'utf8');
  // Prefer the stable PATH symlink (survives Homebrew upgrades) over the
  // versioned Cellar path that process.execPath resolves to.
  const nodeBin = which('node') || process.execPath;
  const plist = tpl
    .replaceAll('__HOME__', HOME)
    .replace('/opt/homebrew/opt/node/bin/node', nodeBin)
    .replace(join(HOME, 'Projects/agent-nexus/server/index.mjs'), join(ROOT, 'server', 'index.mjs'))
    .replaceAll('__DEEPSEEK_API_KEY__', process.env.DEEPSEEK_API_KEY || '');
  const plistPath = join(HOME, 'Library', 'LaunchAgents', 'com.agent-nexus.plist');
  writeFileSync(plistPath, plist);
  ok(`wrote ${plistPath}`);
  const uid = process.getuid();
  execSync(`launchctl bootout gui/${uid}/com.agent-nexus 2>/dev/null || true`, { shell: '/bin/sh' });
  const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { encoding: 'utf8' });
  if (r.status !== 0) {
    bad(`launchctl bootstrap failed: ${(r.stderr || '').trim()}`);
    console.log('     You can still run the deck in the foreground:  npm start');
  } else {
    serviceInstalled = true;
    ok('service bootstrapped (label: com.agent-nexus)');
  }
} else {
  ok('skipped — run the deck in the foreground with:  npm start');
}

// ── step 5: health check ──
step('5/5 · Health check');
let healthy = false;
if (serviceInstalled) {
  for (let i = 0; i < 16 && !healthy; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/agents`);
      healthy = r.ok;
    } catch { /* not up yet */ }
    if (!healthy) await new Promise((r) => setTimeout(r, 500));
  }
}
if (healthy) {
  const agents = await (await fetch(`http://127.0.0.1:${PORT}/api/agents`)).json();
  ok(`deck is live — ${agents.length} agent${agents.length === 1 ? '' : 's'} online`);
} else if (serviceInstalled) {
  warn('service started but the deck is not responding yet.');
  console.log(`     Check logs:  tail -f ${join(NEXUS_DIR, 'nexus.log')}`);
}

rl?.close();
console.log(`
${c.bold(c.green('  Done.'))} Open ${c.cyan(`http://127.0.0.1:${PORT}`)} in your browser.

  Control:     ${c.dim('bin/nexus start | stop | restart | logs')}
  Ask an agent:${c.dim(' bin/nexus ask <agent-id> "<task>"')}
  Roster:      ${c.dim(AGENTS_FILE + '  (restart to apply)')}
  Settings:    ${c.dim('⚙ in the top-right corner of the deck — models, themes, opacity')}
`);
