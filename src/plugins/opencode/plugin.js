// caveman — opencode plugin
//
// Provides dynamic caveman mode tracking for opencode:
// - Writes the mode flag on each session start (via the `event` dispatcher)
// - Parses user messages for /caveman commands and natural-language toggles
// - Injects per-turn reinforcement into the system prompt
//
// Bun ESM module; loads the existing security-hardened helpers directly
// (mirrored from caveman-config.js) to avoid dynamic code evaluation
// (new Function/require) of potentially untrusted config files on disk.
//
// Layout once installed:
//   ~/.config/opencode/plugins/caveman/
//   ├── package.json
//   ├── plugin.js              ← this file
//   └── caveman-config.cjs     ← copied sibling of src/hooks/caveman-config.js
//
// The always-on caveman ruleset is provided separately via
// ~/.config/opencode/AGENTS.md (Tier-3 base). This plugin handles dynamic
// state only: flag writes, slash-command parsing, natural-language
// activation, and per-turn reinforcement.
//
// Hook mapping (opencode >= 1.15.x):
//   - event (event.type === 'session.created'): session-init flag write,
//     re-fires per session rather than once per plugin-process load
//   - chat.message: intercept user prompts for mode changes
//   - experimental.chat.system.transform: inject reinforcement per-turn
//
// Note: opencode does NOT support 'session.created' or 'tui.prompt.append'
// as named plugin-hook keys. 'session.created' is an event *type* dispatched
// through the single `event` handler; the old direct-key handlers were
// silently ignored. See:
// https://github.com/JuliusBrussee/caveman/issues/418
// https://github.com/JuliusBrussee/caveman/issues/421

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs, { existsSync, unlinkSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const VALID_MODES = [
  'off', 'lite', 'full', 'ultra',
  'wenyan-lite', 'wenyan', 'wenyan-full', 'wenyan-ultra',
  'commit', 'review', 'compress'
];

function getConfigDir() {
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'caveman');
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'caveman');
  }
  return path.join(os.homedir(), '.config', 'caveman');
}

function readModeFromConfigFile(configPath) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    if (config && config.defaultMode &&
        VALID_MODES.includes(String(config.defaultMode).toLowerCase())) {
      return String(config.defaultMode).toLowerCase();
    }
  } catch (e) {}
  return null;
}

function findRepoConfigPath(start) {
  try {
    let dir = path.resolve(start || process.cwd());
    const candidates = ['.caveman/config.json', '.caveman.json'];
    for (let i = 0; i < 64; i++) {
      for (const rel of candidates) {
        const p = path.join(dir, rel);
        try {
          const st = fs.lstatSync(p);
          if (st.isSymbolicLink() || !st.isFile()) continue;
          return p;
        } catch (e) {}
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch (e) {}
  return null;
}

function getDefaultMode() {
  const envMode = process.env.CAVEMAN_DEFAULT_MODE;
  if (envMode && VALID_MODES.includes(envMode.toLowerCase())) return envMode.toLowerCase();
  const repoConfigPath = findRepoConfigPath(process.cwd());
  if (repoConfigPath) {
    const repoMode = readModeFromConfigFile(repoConfigPath);
    if (repoMode) return repoMode;
  }
  const userMode = readModeFromConfigFile(path.join(getConfigDir(), 'config.json'));
  if (userMode) return userMode;
  return 'full';
}

function safeWriteFlag(flagPath, content) {
  try {
    const flagDir = path.dirname(flagPath);
    fs.mkdirSync(flagDir, { recursive: true });
    let realFlagDir;
    try {
      const lstat = fs.lstatSync(flagDir);
      if (lstat.isSymbolicLink()) {
        realFlagDir = fs.realpathSync(flagDir);
        const realStat = fs.statSync(realFlagDir);
        if (!realStat.isDirectory()) return;
        if (typeof process.getuid === 'function') {
          if (realStat.uid !== process.getuid()) return;
        } else {
          const home = os.homedir();
          const normalizedReal = path.resolve(realFlagDir).toLowerCase();
          const normalizedHome = path.resolve(home).toLowerCase();
          if (!normalizedReal.startsWith(normalizedHome + path.sep) &&
              normalizedReal !== normalizedHome) return;
        }
      } else {
        realFlagDir = flagDir;
      }
    } catch (e) { return; }

    const realFlagPath = path.join(realFlagDir, path.basename(flagPath));
    try {
      if (fs.lstatSync(realFlagPath).isSymbolicLink()) return;
    } catch (e) { if (e.code !== 'ENOENT') return; }

    const tempPath = path.join(realFlagDir, `.caveman-active.${process.pid}.${Date.now()}`);
    const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;
    let fd;
    try {
      fd = fs.openSync(tempPath, flags, 0o600);
      fs.writeSync(fd, String(content));
      try { fs.fchmodSync(fd, 0o600); } catch (e) {}
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    fs.renameSync(tempPath, realFlagPath);
  } catch (e) {}
}

function readFlag(flagPath) {
  try {
    const st = fs.lstatSync(flagPath);
    if (st.isSymbolicLink() || !st.isFile() || st.size > 64) return null;
    const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
    const flags = fs.constants.O_RDONLY | O_NOFOLLOW;
    let fd;
    try {
      fd = fs.openSync(flagPath, flags);
      const buf = Buffer.alloc(64);
      const n = fs.readSync(fd, buf, 0, 64, 0);
      const raw = buf.slice(0, n).toString('utf8').trim().toLowerCase();
      return VALID_MODES.includes(raw) ? raw : null;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  } catch (e) { return null; }
}

// Modes handled by independent skills — not selectable via /caveman <arg>.
const INDEPENDENT_MODES = new Set(['commit', 'review', 'compress']);

// opencode resolves its config dir from $XDG_CONFIG_HOME, else ~/.config/opencode
// on every platform — including Windows, where it uses %USERPROFILE%\.config\opencode
// (NOT %APPDATA%). os.homedir() is %USERPROFILE% on win32, so the default branch
// is already correct cross-platform.
function opencodeConfigDir() {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  }
  return path.join(os.homedir(), '.config', 'opencode');
}

const flagPath = path.join(opencodeConfigDir(), '.caveman-active');

function reinforcementLine(mode) {
  return 'CAVEMAN MODE ACTIVE (' + mode + '). ' +
    'Drop articles/filler/pleasantries/hedging. Fragments OK. ' +
    'Code/commits/security: write normal.';
}

// Parse a prompt for slash-command activation or natural-language toggles.
// Returns the new mode to write, the literal string 'off' to deactivate, or
// null when the prompt doesn't change state. Mirrors caveman-mode-tracker.js.
function parseModeChange(promptRaw) {
  let prompt = (promptRaw || '').trim();
  // opencode's non-interactive `run` path delivers the message wrapped in
  // literal quote characters ("/caveman ultra"\n) — unwrap symmetric quotes
  // so the slash-command branch still matches.
  const wrapped = /^(["'`])([\s\S]*)\1$/.exec(prompt);
  if (wrapped) prompt = wrapped[2].trim();
  prompt = prompt.toLowerCase();
  if (!prompt) return null;

  // Natural-language deactivation — checked before activation so "stop talking
  // like caveman" doesn't trip the activation regex.
  if (/\b(stop|disable|deactivate|turn off)\b.*\bcaveman\b/i.test(prompt) ||
      /\bcaveman\b.*\b(stop|disable|deactivate|turn off)\b/i.test(prompt) ||
      /\bnormal mode\b/i.test(prompt)) {
    return 'off';
  }

  // Expanded /caveman command template. opencode replaces a typed
  // "/caveman <level>" with the command file's body ("Activate caveman
  // mode: $ARGUMENTS ...") before chat.message fires, so the literal
  // slash-command branch below never sees it — recover the level argument
  // from the template's first line instead. Must run before the generic
  // NL-activation match, which would swallow it and drop the level.
  const tpl = /^activate caveman mode:[ \t]*(\S*)/.exec(prompt);
  if (tpl) {
    const arg = tpl[1] || '';
    if (arg === 'off' || arg === 'stop' || arg === 'disable') return 'off';
    if (arg === 'wenyan-full') return 'wenyan';
    if (VALID_MODES.includes(arg) && !INDEPENDENT_MODES.has(arg)) return arg;
    return getDefaultMode();
  }

  // Natural-language activation
  if (/\b(activate|enable|turn on|start|talk like)\b.*\bcaveman\b/i.test(prompt) ||
      /\bcaveman\b.*\b(mode|activate|enable|turn on|start)\b/i.test(prompt)) {
    const mode = getDefaultMode();
    return mode === 'off' ? null : mode;
  }

  // Slash-command parsing — opencode also expands command files, but if the
  // user types the literal slash command we still want to flip the flag.
  if (prompt.startsWith('/caveman')) {
    const parts = prompt.split(/\s+/);
    const cmd = parts[0];
    const arg = parts[1] || '';

    if (cmd === '/caveman-commit')   return 'commit';
    if (cmd === '/caveman-review')   return 'review';
    if (cmd === '/caveman-compress') return 'compress';

    if (cmd === '/caveman') {
      if (!arg)                                     return getDefaultMode();
      if (arg === 'off' || arg === 'stop' || arg === 'disable') return 'off';
      if (arg === 'wenyan-full')                    return 'wenyan';
      if (VALID_MODES.includes(arg) && !INDEPENDENT_MODES.has(arg)) return arg;
      // Unknown arg — leave flag alone. No silent overwrite.
      return null;
    }
  }

  return null;
}

function applyModeChange(mode) {
  if (!mode) return;
  if (mode === 'off') {
    try { if (existsSync(flagPath)) unlinkSync(flagPath); } catch (e) {}
    return;
  }
  safeWriteFlag(flagPath, mode);
}

// Session-start logic — extracted so the `event` dispatcher (opencode >= 1.15)
// drives one shared implementation. Re-fires on every `session.created` event,
// so a new session in a long-lived plugin process re-asserts the flag.
function handleSessionCreated() {
  const mode = getDefaultMode();
  if (mode === 'off') {
    try { if (existsSync(flagPath)) unlinkSync(flagPath); } catch (e) {}
    return;
  }
  safeWriteFlag(flagPath, mode);
}

export const CavemanPlugin = async (_ctx) => {
  // Assert the flag at plugin load as well: in one-shot `opencode run` the
  // first session.created publishes before plugin event dispatch is wired,
  // so the event handler alone misses it. The factory-time write covers that
  // race; the event handler re-asserts on every later session in long-lived
  // TUI processes.
  handleSessionCreated();

  return {
  // opencode dispatches session/lifecycle events through a single `event`
  // handler keyed on event.type; the older direct top-level
  // 'session.created' key is silently ignored. Routing session-init through
  // here means the flag is rewritten on every new session, not just once when
  // the plugin module loads. See https://opencode.ai/docs/plugins#events.
  event: async ({ event } = {}) => {
    if (event && event.type === 'session.created') handleSessionCreated();
  },

  // Intercept user messages to detect /caveman commands and natural-language
  // mode toggles. opencode fires chat.message with (input, output) where
  // output.parts is the array of message parts; text parts carry .text.
  // Return value is ignored — state changes happen via the flag file.
  'chat.message': async (_input, output) => {
    if (!output || !output.parts) return;
    for (const part of output.parts) {
      if (part && part.type === 'text' && part.text) {
        const change = parseModeChange(part.text);
        if (change) applyModeChange(change);
      }
    }
  },

  // Inject the reinforcement line into the system prompt when caveman is
  // active. opencode calls this before every LLM request and expects the hook
  // to mutate output.system (a string[]); the return value is discarded.
  'experimental.chat.system.transform': async (_input, output) => {
    if (!output || !Array.isArray(output.system)) return;
    const active = readFlag(flagPath);
    if (active && !INDEPENDENT_MODES.has(active)) {
      output.system.push(reinforcementLine(active));
    }
  },
  };
};

export default CavemanPlugin;
