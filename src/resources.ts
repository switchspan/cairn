import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CairnError } from './lib.js';

export function packageFile(...parts: string[]): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', ...parts);
}

export function readPackageFile(...parts: string[]): string {
  const file = packageFile(...parts);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      throw new CairnError(`Missing package file ${file}`);
    }
    throw error;
  }
}

export function cliCommand(event: 'session-start' | 'stop', host: string): string {
  const node = process.execPath;
  const cli = fs.realpathSync(packageFile('dist', 'src', 'cli.js'));
  return `${quote(node)} ${quote(cli)} hook ${event} --host ${host}`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
