import { createHash } from 'node:crypto';
import { MAX_JOBS, MAX_LEGS, type SourceJob, type SourceLeg } from './types.js';

/** Thrown when a file can't be imported. `problems` is safe to show to an admin. */
export class ImportError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

export const MAX_IMPORT_BYTES = 256 * 1024;

/* ------------------------------------------------------------------ times */

/**
 * Parse a time as UTC. Accepts `2026-11-12 18:30`, `2026-11-12T18:30:00Z`, an offset like `+01:00`,
 * a bare date (start of that day, or 23:59:59 when `endOfDay`), epoch seconds/milliseconds, or a
 * Discord timestamp like `<t:1790000000>`. Returns null if it can't be read.
 */
export function parseUtc(input: string, opts: { endOfDay?: boolean } = {}): number | null {
  const t = input.trim();
  if (!t) return null;

  const discord = /^<t:(\d{9,12})(?::[a-zA-Z])?>$/.exec(t);
  if (discord) return Number(discord[1]) * 1000;
  if (/^\d{9,10}$/.test(t)) return Number(t) * 1000;
  if (/^\d{12,13}$/.test(t)) return Number(t);

  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i.exec(t);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, zone] = m;
  const hasTime = h !== undefined;
  const hour = hasTime ? Number(h) : opts.endOfDay ? 23 : 0;
  const min = hasTime ? Number(mi) : opts.endOfDay ? 59 : 0;
  const second = sec !== undefined ? Number(sec) : hasTime ? 0 : opts.endOfDay ? 59 : 0;
  if (hour > 23 || min > 59 || second > 59) return null;

  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, min, second);
  const back = new Date(ms);
  // Date.UTC rolls 2026-02-31 over to March; reject anything that changed.
  if (back.getUTCFullYear() !== Number(y) || back.getUTCMonth() !== Number(mo) - 1 || back.getUTCDate() !== Number(d)) return null;

  let offsetMin = 0;
  if (zone && !/^(Z|UTC)$/i.test(zone)) {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }
  return ms - offsetMin * 60_000;
}

/* ------------------------------------------------------------------ legs */

const AIRPORT = /^[A-Z0-9]{3,4}$/;

/**
 * Legs as a chain of airports: `EGLL-EGKK-EGCC` is two legs (EGLL to EGKK, then EGKK to EGCC).
 * Separators: `-`, `>`, `→`, `/`, spaces or commas.
 */
export function parseLegChain(input: string): SourceLeg[] | string {
  const airports = input
    .toUpperCase()
    .split(/[\s,>→/-]+/)
    .filter(Boolean);
  return chainToLegs(airports);
}

function chainToLegs(airports: string[]): SourceLeg[] | string {
  if (airports.length < 2) return 'needs at least two airports (e.g. EGLL-EGKK)';
  const bad = airports.find((a) => !AIRPORT.test(a));
  if (bad) return `"${bad}" is not a 3-4 character airport code`;
  if (airports.length - 1 > MAX_LEGS) return `has more than ${MAX_LEGS} legs`;
  const legs: SourceLeg[] = [];
  for (let i = 0; i < airports.length - 1; i++) legs.push({ dep: airports[i] as string, arr: airports[i + 1] as string });
  return legs;
}

/** JSON legs: a chain string, an array of airport strings, or an array of [dep, arr] / {dep, arr} pairs. */
function parseJsonLegs(value: unknown): SourceLeg[] | string {
  if (typeof value === 'string') return parseLegChain(value);
  if (!Array.isArray(value) || value.length === 0) return 'needs legs';
  if (value.every((v) => typeof v === 'string')) return chainToLegs((value as string[]).map((v) => v.trim().toUpperCase()));
  const legs: SourceLeg[] = [];
  for (const item of value) {
    let dep: unknown;
    let arr: unknown;
    if (Array.isArray(item) && item.length === 2) [dep, arr] = item;
    else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      dep = o.dep ?? o.from;
      arr = o.arr ?? o.to;
    }
    if (typeof dep !== 'string' || typeof arr !== 'string') return 'each leg needs a departure and an arrival airport';
    const d = dep.trim().toUpperCase();
    const a = arr.trim().toUpperCase();
    if (!AIRPORT.test(d) || !AIRPORT.test(a)) return `"${d}" → "${a}" must use 3-4 character airport codes`;
    legs.push({ dep: d, arr: a });
  }
  if (legs.length > MAX_LEGS) return `has more than ${MAX_LEGS} legs`;
  return legs;
}

/* ------------------------------------------------------------------ CSV */

/**
 * Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF or LF, optional BOM. Blank lines are
 * dropped unless `keepBlankRows` is set, which keeps row numbers lined up with a spreadsheet's.
 */
export function parseCsv(text: string, opts: { keepBlankRows?: boolean } = {}): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const keep = (r: string[]) => opts.keepBlankRows === true || r.some((f) => f.trim() !== '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') (field += '"', i++);
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') (row.push(field), (field = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (keep(row)) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/* ------------------------------------------------------------------ field mapping */

const ALIASES: Record<string, string[]> = {
  key: ['id', 'key', 'jobid', 'ref', 'reference'],
  legs: ['legs', 'route', 'airports'],
  aircraft: ['aircraft', 'airframe', 'aircrafttype', 'type', 'aircraftrequired'],
  from: ['from', 'availablefrom', 'start', 'starts', 'startdate', 'available'],
  deadline: ['deadline', 'completeby', 'due', 'duedate', 'expires', 'expiry', 'end', 'enddate'],
  title: ['title', 'name', 'description'],
  pay: ['pay', 'payment', 'reward', 'payout'],
  notes: ['notes', 'note', 'comments', 'remarks'],
};

export const canon = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '');

function fieldName(header: string): string | null {
  const c = canon(header);
  for (const [name, aliases] of Object.entries(ALIASES)) if (aliases.includes(c)) return name;
  return null;
}

/** A single line of plain text, control characters removed and cut to `max` characters; null if empty. */
export const str = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

/** Turn one loosely-typed record into a job, or list what is wrong with it. */
function buildJob(raw: Record<string, unknown>, label: string, problems: string[]): SourceJob | null {
  const errors: string[] = [];

  const legsRaw = raw.legs;
  const legs = legsRaw === undefined || legsRaw === null || legsRaw === '' ? 'needs a legs / route column' : parseJsonLegs(legsRaw);
  if (typeof legs === 'string') errors.push(legs);

  const readTime = (v: unknown, name: string, endOfDay: boolean): number | null => {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const ms = typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : parseUtc(String(v), { endOfDay });
    if (ms === null) errors.push(`${name} "${String(v)}" isn't a time I can read (use UTC, e.g. 2026-11-12 18:30)`);
    return ms;
  };
  const availableFrom = readTime(raw.from, 'start time', false);
  const deadline = readTime(raw.deadline, 'deadline', true);
  if (availableFrom !== null && deadline !== null && deadline <= availableFrom) errors.push('deadline is not after the start time');

  const aircraft = str(raw.aircraft, 40);
  const title = str(raw.title, 80);
  const pay = str(raw.pay, 40);
  const notes = str(raw.notes, 200);

  if (errors.length > 0 || typeof legs === 'string') {
    for (const e of errors) problems.push(`${label}: ${e}`);
    return null;
  }

  const explicitKey = str(raw.key, 60);
  const key =
    explicitKey ??
    `h-${createHash('sha1')
      .update([legs.map((l) => `${l.dep}>${l.arr}`).join(','), aircraft ?? '', availableFrom ?? '', deadline ?? ''].join('|'))
      .digest('hex')
      .slice(0, 12)}`;
  return { key, title, legs, aircraft, availableFrom, deadline, pay, notes };
}

function finish(jobs: SourceJob[], problems: string[]): SourceJob[] {
  const seen = new Map<string, number>();
  jobs.forEach((j, i) => {
    const prev = seen.get(j.key);
    if (prev !== undefined) problems.push(`two jobs share the id "${j.key}" (entries ${prev + 1} and ${i + 1}); each needs a unique id`);
    else seen.set(j.key, i);
  });
  if (problems.length > 0) {
    const shown = problems.slice(0, 10);
    const more = problems.length > shown.length ? [`…and ${problems.length - shown.length} more`] : [];
    throw new ImportError(`Nothing was imported: ${problems.length} problem${problems.length === 1 ? '' : 's'} found.`, [...shown, ...more]);
  }
  if (jobs.length === 0) throw new ImportError('The file has no jobs in it.');
  return jobs;
}

/* ------------------------------------------------------------------ entry point */

/**
 * Parse an uploaded jobs file (CSV or JSON). The whole file is rejected if any row is bad, so a
 * typo can never silently drop a job from the panel.
 */
export function parseJobsFile(text: string, filename: string): SourceJob[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw new ImportError(`The file is larger than ${MAX_IMPORT_BYTES / 1024} KB.`);
  const trimmed = text.replace(/^﻿/, '').trim();
  if (!trimmed) throw new ImportError('The file is empty.');

  const looksJson = /\.json$/i.test(filename) || trimmed.startsWith('[') || trimmed.startsWith('{');
  const problems: string[] = [];
  const jobs: SourceJob[] = [];

  if (looksJson) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      throw new ImportError("That isn't valid JSON. Check for a missing comma or bracket.");
    }
    const list = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { jobs?: unknown }).jobs) ? (data as { jobs: unknown[] }).jobs : null;
    if (!list) throw new ImportError('Expected a JSON list of jobs, or an object with a "jobs" list.');
    if (list.length > MAX_JOBS) throw new ImportError(`More than ${MAX_JOBS} jobs in one file.`);
    list.forEach((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        problems.push(`job ${i + 1}: expected an object`);
        return;
      }
      const raw: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        const name = fieldName(k);
        if (name && raw[name] === undefined) raw[name] = v;
      }
      const job = buildJob(raw, `job ${i + 1}`, problems);
      if (job) jobs.push(job);
    });
    return finish(jobs, problems);
  }

  const rows = parseCsv(trimmed);
  const header = rows[0];
  if (!header) throw new ImportError('The file is empty.');
  const names = header.map(fieldName);
  if (!names.includes('legs')) {
    throw new ImportError("I couldn't find a `legs` (or `route`) column in the first row. See `/setup template` for the layout.");
  }
  if (rows.length - 1 > MAX_JOBS) throw new ImportError(`More than ${MAX_JOBS} jobs in one file.`);
  rows.slice(1).forEach((cells, i) => {
    const raw: Record<string, unknown> = {};
    names.forEach((name, col) => {
      if (name && raw[name] === undefined) raw[name] = cells[col] ?? '';
    });
    const job = buildJob(raw, `row ${i + 2}`, problems);
    if (job) jobs.push(job);
  });
  return finish(jobs, problems);
}

/** A small example file for admins (served by `/setup template`), with dates relative to `now`. */
export function sampleCsv(now: number): string {
  const at = (days: number, hour: number) => {
    const d = new Date(now + days * 86_400_000);
    const pad = (x: number) => String(x).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(hour)}:00`;
  };
  return [
    'id,legs,aircraft,from,deadline,pay,notes',
    `A-1001,EGLL-EGKK,A20N,${at(0, 8)},${at(3, 23)},"12,500",Quick hop`,
    `A-1002,EGLL-EGCC-EGPH,A320,${at(0, 8)},${at(4, 20)},"28,000","Two legs, can be shared"`,
    `A-1003,KJFK-KBOS-KORD-KJFK,B738,,${at(5, 12)},"41,000",Three-leg loop`,
    '',
  ].join('\n');
}
