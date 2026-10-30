import fs from 'node:fs';
import path from 'node:path';
import { CairnError } from './lib.js';
import { cliCommand, readSkillFile, skillFile } from './resources.js';

type HookEvent = 'session-start' | 'stop';

interface HostSpec {
  id: 'cursor' | 'claude' | 'codex';
  directory: string;
  file: string;
  style: 'cursor' | 'claude';
  events: Record<HookEvent, string>;
}

const HOSTS: HostSpec[] = [
  {
    id: 'cursor',
    directory: '.cursor',
    file: 'hooks.json',
    style: 'cursor',
    events: { 'session-start': 'sessionStart', stop: 'stop' },
  },
  {
    id: 'claude',
    directory: '.claude',
    file: 'settings.json',
    style: 'claude',
    events: { 'session-start': 'SessionStart', stop: 'Stop' },
  },
  {
    id: 'codex',
    directory: '.codex',
    file: 'hooks.json',
    style: 'claude',
    events: { 'session-start': 'SessionStart', stop: 'Stop' },
  },
];

export function installAdapters(home: string): string[] {
  readSkillFile('SKILL.md');
  return HOSTS.flatMap((host) => installHost(home, host));
}

export function uninstallAdapters(home: string): string[] {
  return HOSTS.flatMap((host) => uninstallHost(home, host));
}

export function templateText(): string {
  return readSkillFile('template.md');
}

function installHost(home: string, host: HostSpec): string[] {
  const directory = hostDirectory(home, host);
  if (!directory) return [`${host.id}: skipped`];
  const configPath = path.join(directory, host.file);
  const { existed, value } = readConfig(configPath);
  for (const event of ['session-start', 'stop'] as const) {
    const command = cliCommand(event, host.id);
    const key = host.events[event];
    if (host.style === 'cursor') upsertFlat(value, key, event, command);
    else upsertNested(value, key, event, command);
  }
  if (host.style === 'cursor' && value.version === undefined) value.version = 1;
  writeConfig(configPath, value, existed);
  const skill = installSkill(directory);
  return [`${host.id}: wrote ${configPath}`, `${host.id}: installed ${skill}`];
}

function uninstallHost(home: string, host: HostSpec): string[] {
  const directory = hostDirectory(home, host);
  if (!directory) return [`${host.id}: skipped`];
  const lines: string[] = [];
  const configPath = path.join(directory, host.file);
  if (fs.existsSync(configPath)) {
    const { existed, value } = readConfig(configPath);
    let removed = false;
    for (const event of ['session-start', 'stop'] as const) {
      const key = host.events[event];
      if (host.style === 'cursor') removed = removeFlat(value, key) || removed;
      else removed = removeNested(value, key) || removed;
    }
    if (removed) {
      writeConfig(configPath, value, existed);
      lines.push(`${host.id}: updated ${configPath}`);
    } else {
      lines.push(`${host.id}: unchanged ${configPath}`);
    }
  }
  const skill = path.join(directory, 'skills', 'cairn');
  if (fs.existsSync(skill)) {
    const stat = fs.lstatSync(skill);
    if (stat.isSymbolicLink()) throw new CairnError(`${skill} must be a real directory`);
    fs.rmSync(skill, { recursive: true, force: true });
    lines.push(`${host.id}: removed ${skill}`);
  }
  return lines;
}

function installSkill(directory: string): string {
  const skillDir = path.join(directory, 'skills', 'cairn');
  const existing = lstatOrNull(skillDir);
  if (existing?.isSymbolicLink()) throw new CairnError(`${skillDir} must be a real directory`);
  fs.mkdirSync(skillDir, { recursive: true, mode: 0o755 });
  const destination = path.join(skillDir, 'SKILL.md');
  if (lstatOrNull(destination)?.isSymbolicLink()) throw new CairnError(`${destination} must be a regular file`);
  fs.copyFileSync(skillFile('SKILL.md'), destination);
  return destination;
}

function hostDirectory(home: string, host: HostSpec): string | null {
  const directory = path.join(home, host.directory);
  if (!fs.existsSync(directory)) return null;
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
