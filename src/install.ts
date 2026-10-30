import fs from 'node:fs';
import path from 'node:path';
import { CairnError } from './lib.js';
import { quote, readSkillFile, skillFile } from './resources.js';

type HookEvent = 'session-start' | 'stop';

interface HostSpec {
  id: 'cursor' | 'claude' | 'codex';
  directory: string;
  file: string;
  style: 'cursor' | 'claude';
  events: Record<HookEvent, string>;
}

// The installed skill is the portable unit (ADR 0002): hooks run its wrapper.
const SKILL_NAME = 'cairn';
const SKILL_HOME = ['.agents', 'skills'];
const SKILL_READERS = ['.codex', '.cursor', '.grok'];

const HOOK_HOSTS: HostSpec[] = [
  {
    id: 'cursor',
    directory: '.cursor',
    file: 'hooks.json',
    style: 'cursor',
    events: { 'session-start': 'sessionStart', stop: 'stop' },
  },
  {
    id: 'codex',
    directory: '.codex',
    file: 'hooks.json',
    style: 'claude',
    events: { 'session-start': 'SessionStart', stop: 'Stop' },
  },
];

// Claude Code uses the plugin; earlier installs wrote these entries.
const LEGACY_CLAUDE: HostSpec = {
  id: 'claude',
  directory: '.claude',
  file: 'settings.json',
  style: 'claude',
  events: { 'session-start': 'SessionStart', stop: 'Stop' },
};
const LEGACY_SKILL_HOSTS = ['.claude', '.cursor', '.codex'];

export function installAdapters(home: string): string[] {
  readSkillFile('SKILL.md');
  const readers = SKILL_READERS.filter((directory) => hostDirectory(home, directory));
  const lines: string[] = [];
  if (readers.length === 0) {
    lines.push('skill: skipped; no Codex, Cursor, or Grok configuration found');
  } else {
    const skill = installSkill(home);
    lines.push(`skill: installed ${skill}`);
    const wrapper = path.join(skill, 'scripts', 'cairn');
    for (const host of HOOK_HOSTS) lines.push(...installHooks(home, host, wrapper));
    if (readers.includes('.grok')) lines.push('grok: skill only; ask the agent to resume');
  }
  lines.push(...removeLegacy(home));
  lines.push(pluginHint());
  return lines;
}

export function uninstallAdapters(home: string): string[] {
  const lines = HOOK_HOSTS.flatMap((host) => removeHooks(home, host));
  const skill = path.join(home, ...SKILL_HOME, SKILL_NAME);
  if (removeDirectory(skill)) lines.push(`skill: removed ${skill}`);
  lines.push(...removeLegacy(home));
  return lines;
}

export function templateText(): string {
  return readSkillFile('template.md');
}

function installHooks(home: string, host: HostSpec, wrapper: string): string[] {
  const directory = hostDirectory(home, host.directory);
  if (!directory) return [`${host.id}: skipped`];
  const configPath = path.join(directory, host.file);
  const { existed, value } = readConfig(configPath);
  for (const event of ['session-start', 'stop'] as const) {
    const command = `${quote(wrapper)} hook ${event} --host ${host.id}`;
    const key = host.events[event];
    if (host.style === 'cursor') upsertFlat(value, key, event, command);
    else upsertNested(value, key, event, command);
  }
  if (host.style === 'cursor' && value.version === undefined) value.version = 1;
  writeConfig(configPath, value, existed);
  // Codex runs a new or changed hook only after the user trusts it in the interactive UI.
  if (host.id === 'codex') return [`${host.id}: wrote ${configPath}; start codex and trust the two cairn hooks`];
  return [`${host.id}: wrote ${configPath}`];
}

function removeHooks(home: string, host: HostSpec): string[] {
  const directory = hostDirectory(home, host.directory);
  if (!directory) return [];
  const configPath = path.join(directory, host.file);
  if (!fs.existsSync(configPath)) return [];
  const { existed, value } = readConfig(configPath);
  let removed = false;
  for (const event of ['session-start', 'stop'] as const) {
    const key = host.events[event];
    if (host.style === 'cursor') removed = removeFlat(value, key) || removed;
    else removed = removeNested(value, key) || removed;
  }
  if (!removed) return [];
  writeConfig(configPath, value, existed);
  return [`${host.id}: removed cairn hooks from ${configPath}`];
}

function removeLegacy(home: string): string[] {
  const lines = removeHooks(home, LEGACY_CLAUDE);
  for (const directory of LEGACY_SKILL_HOSTS) {
    const skill = path.join(home, directory, 'skills', SKILL_NAME);
    if (removeDirectory(skill)) lines.push(`${directory.slice(1)}: removed old skill ${skill}`);
  }
  return lines;
}

// Copies the whole skill folder, renamed to cairn so it stays distinct in the shared skills directory.
function installSkill(home: string): string {
  const parent = path.join(home, ...SKILL_HOME);
  const destination = path.join(parent, SKILL_NAME);
  const source = fs.realpathSync(skillFile());
  if (fs.existsSync(destination) && fs.realpathSync(destination) === source) return destination;
  fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
  const staging = `${destination}.cairn-new`;
  removeDirectory(staging);
  fs.cpSync(source, staging, { recursive: true });
  const manifest = path.join(staging, 'SKILL.md');
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace(/^name: .*$/m, `name: ${SKILL_NAME}`));
  fs.chmodSync(path.join(staging, 'scripts', 'cairn'), 0o755);
  removeDirectory(destination);
  fs.renameSync(staging, destination);
  return destination;
}

function removeDirectory(directory: string): boolean {
  const stat = lstatOrNull(directory);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CairnError(`${directory} must be a real directory`);
  fs.rmSync(directory, { recursive: true, force: true });
  return true;
}

function pluginHint(): string {
  const root = skillFile('..', '..');
  const source = fs.existsSync(path.join(root, '.claude-plugin', 'marketplace.json')) ? root : 'this repository';
  return `claude: use the plugin: /plugin marketplace add ${source}, then /plugin install cairn@cairn-checkpoints`;
}

function hostDirectory(home: string, name: string): string | null {
  const directory = path.join(home, name);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(directory);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isDirectory()) throw new CairnError(`${directory} must be a directory`);
  return directory;
}

function readConfig(file: string): { existed: boolean; value: Record<string, unknown> } {
  const stat = lstatOrNull(file);
  if (!stat) return { existed: false, value: {} };
  if (stat.isSymbolicLink() || !stat.isFile()) throw new CairnError(`${file} must be a regular file`);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new CairnError(`Could not parse ${file}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CairnError(`Could not parse ${file}`);
  }
  return { existed: true, value: value as Record<string, unknown> };
}

function writeConfig(file: string, value: Record<string, unknown>, existed: boolean): void {
  if (existed) {
    const backup = `${file}.cairn-bak`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  }
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function upsertFlat(config: Record<string, unknown>, key: string, event: HookEvent, command: string): void {
  const hooks = hooksObject(config);
  const list = arrayField(hooks, key);
  let replaced = false;
  const next = list.flatMap((entry) => {
    if (!matchesEvent(entry, event)) return [entry];
    if (replaced) return [];
    replaced = true;
    return [{ ...asRecord(entry), command }];
  });
  if (!replaced) next.push({ command });
  hooks[key] = next;
}

function removeFlat(config: Record<string, unknown>, key: string): boolean {
  const hooks = asRecord(config.hooks);
  if (!hooks || !Array.isArray(hooks[key])) return false;
  const list = hooks[key];
  const next = list.filter((entry) => !isCairnCommand(commandOf(entry)));
  const removed = next.length !== list.length;
  if (next.length === 0) delete hooks[key];
  else hooks[key] = next;
  return removed;
}

function upsertNested(config: Record<string, unknown>, key: string, event: HookEvent, command: string): void {
  const hooks = hooksObject(config);
  const groups = arrayField(hooks, key);
  let replaced = false;
  const next = groups.map((group) => {
    const record = asRecord(group);
    if (!record || !Array.isArray(record.hooks)) return group;
    const nested = record.hooks.flatMap((hook) => {
      if (!matchesEvent(hook, event)) return [hook];
      if (replaced) return [];
      replaced = true;
      return [{ ...asRecord(hook), type: 'command', command }];
    });
    return { ...record, hooks: nested };
  });
  if (!replaced) next.push({ hooks: [{ type: 'command', command }] });
  hooks[key] = next;
}

function removeNested(config: Record<string, unknown>, key: string): boolean {
  const hooks = asRecord(config.hooks);
  if (!hooks || !Array.isArray(hooks[key])) return false;
  let removed = false;
  const next = hooks[key].flatMap((group) => {
    const record = asRecord(group);
    if (!record || !Array.isArray(record.hooks)) return [group];
    const nested = record.hooks.filter((hook) => {
      const drop = isCairnCommand(commandOf(hook));
      if (drop) removed = true;
      return !drop;
    });
    if (nested.length === 0) return [];
    return [{ ...record, hooks: nested }];
  });
  if (next.length === 0) delete hooks[key];
  else hooks[key] = next;
  return removed;
}

function hooksObject(config: Record<string, unknown>): Record<string, unknown> {
  if (config.hooks === undefined) config.hooks = {};
  const hooks = asRecord(config.hooks);
  if (!hooks) throw new CairnError('hooks must be an object');
  return hooks;
}

function arrayField(hooks: Record<string, unknown>, key: string): unknown[] {
  if (hooks[key] === undefined) hooks[key] = [];
  if (!Array.isArray(hooks[key])) throw new CairnError(`${key} must be an array`);
  return hooks[key];
}

function matchesEvent(entry: unknown, event: HookEvent): boolean {
  return commandOf(entry).includes(` hook ${event} --host `);
}

function isCairnCommand(command: string): boolean {
  return command.includes(' hook session-start --host ') || command.includes(' hook stop --host ');
}

function commandOf(entry: unknown): string {
  const record = asRecord(entry);
  return record && typeof record.command === 'string' ? record.command : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
