// Refreshes the aircraft aliases the bot knows (src/services/aircraftAliases.ts) from FsHub's aircraft page.
//
// FsHub keeps adding aliases, and its aircraft page needs a FsHub sign-in, so the bot carries a snapshot and this brings it up to date:
//
//   1. Sign in to FsHub and open https://fshub.io/aircraft-list
//   2. In the browser's developer console, run this and copy what it prints:
//
//        copy(JSON.stringify(Object.fromEntries([...document.querySelectorAll('.aircraft-aliases-popup')].map((p) =>
//          [p.id.replace('aircraft-aliases-', ''), [...p.querySelectorAll('.aircraft-icao-badge')].map((e) => e.innerText.trim())]))))
//
//   3. Save it to a file (for example aliases.json) and run:   node scripts/import-aircraft-aliases.mjs aliases.json
//
// It rewrites the table and the "as of" date in the module, and says what changed. Nothing else is touched.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'src', 'services', 'aircraftAliases.ts');
const source = process.argv[2];
if (!source) throw new Error('Give the file you saved from the aircraft page: node scripts/import-aircraft-aliases.mjs aliases.json');

const incoming = JSON.parse(readFileSync(resolve(source), 'utf8'));
if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) throw new Error('The file should be an object of aircraft type to its list of aliases.');
const code = /^[A-Z0-9]{2,5}$/;
const table = {};
for (const [type, list] of Object.entries(incoming).sort(([a], [b]) => a.localeCompare(b))) {
  if (!code.test(type) || !Array.isArray(list) || !list.every((a) => typeof a === 'string' && code.test(a))) throw new Error(`${type} does not look like an aircraft type with a list of aliases.`);
  if (list.length > 0) table[type] = list;
}
if (Object.keys(table).length === 0) throw new Error('The file has no aliases in it, so nothing was changed.');

let text = readFileSync(target, 'utf8');
const crlf = text.includes('\r\n');
if (crlf) text = text.split('\r\n').join('\n');
const start = text.indexOf('export const FSHUB_ALIASES');
const end = text.indexOf('\n};\n', start);
if (start < 0 || end < 0) throw new Error('Could not find the table in aircraftAliases.ts.');
const before = text.slice(start, end);
const old = new Map([...before.matchAll(/^\s+([A-Z0-9]+): \[(.*)\],$/gm)].map((m) => [m[1], m[2].replace(/'/g, '').split(', ').join(' ')]));

const rows = Object.entries(table).map(([type, list]) => `  ${type}: [${list.map((a) => `'${a}'`).join(', ')}],`);
const header = 'export const FSHUB_ALIASES: Readonly<Record<string, readonly string[]>> = {\n';
text = text.slice(0, start) + header + rows.join('\n') + text.slice(end);
const today = new Date().toISOString().slice(0, 10);
text = text.replace(/export const ALIASES_AS_OF = '[^']*';/, `export const ALIASES_AS_OF = '${today}';`);
writeFileSync(target, crlf ? text.split('\n').join('\r\n') : text);

const now = new Map(Object.entries(table).map(([t, l]) => [t, l.join(' ')]));
const added = [...now.keys()].filter((t) => !old.has(t));
const removed = [...old.keys()].filter((t) => !now.has(t));
const changed = [...now.keys()].filter((t) => old.has(t) && old.get(t) !== now.get(t));
console.log(`Wrote ${Object.keys(table).length} aircraft with aliases to ${target} (as of ${today}).`);
console.log(`  new: ${added.join(' ') || 'none'}\n  gone: ${removed.join(' ') || 'none'}\n  changed: ${changed.join(' ') || 'none'}`);
