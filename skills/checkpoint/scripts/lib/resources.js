import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CairnError } from './lib.js';
// The compiled CLI lives in <skill>/scripts/lib, so the skill folder is two levels up.
export function skillFile(...parts) {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', ...parts);
}
export function readSkillFile(...parts) {
    const file = skillFile(...parts);
    try {
        return fs.readFileSync(file, 'utf8');
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error) {
            throw new CairnError(`Missing skill file ${file}`);
        }
        throw error;
    }
}
export function cliCommand(event, host) {
    const wrapper = fs.realpathSync(skillFile('scripts', 'cairn'));
    return `${quote(wrapper)} hook ${event} --host ${host}`;
}
function quote(value) {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
