import type { Panel } from '../db/store.js';
import { canon, ImportError, parseCsv, parseJobsFile, parseLegChain, str } from './import.js';
import { MAX_JOBS, type FetchedJobs, type JobSource, type SourceAirline, type SourceJob } from './types.js';

/**
 * A job source that reads the schedule an airline already keeps in a Google Sheet.
 *
 * The sheet must be shared as "Anyone with the link can view". The bot only ever reads it, through
 * Google's CSV export, and never signs in as anyone. It reads the layout used by Example Air's sign-up
 * sheet (Route, Date, Landing Window Zulu, Pilot, Backup Pilot, Aircraft, Flight Completed), and
 * falls back to the same columns as `/setup template` for any other sheet.
 */

const DAY = 86_400_000;
const MAX_CSV_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 4;
/** Rows whose window ended longer ago than this are ignored without comment. */
const KEEP_FINISHED_FOR_MS = 3 * DAY;
const MAX_WARNINGS = 8;

/* ------------------------------------------------------------------ the sheet's address */

export interface SheetRef {
  id: string;
  /** The tab. Null means the sheet's first tab. */
  gid: string | null;
}

/**
 * Read a Google Sheets link. Only `https://docs.google.com/spreadsheets/d/<id>/…` is accepted, so the
 * bot can never be pointed at some other server. The tab comes from `gid=` in the link, if present.
 */
export function parseSheetUrl(input: string): SheetRef | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') return null;
  const m = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,120})(?:\/|$)/.exec(url.pathname);
  if (!m) return null;
  // The tab can be named in the query (?gid=…) or after the # (#gid=…).
  const gid = /(?:^|[?&])gid=(\d{1,12})(?:&|$)/.exec(`${url.search}&${url.hash.slice(1)}`);
  return { id: m[1] as string, gid: gid ? (gid[1] as string) : null };
}

export function sheetExportUrl(ref: SheetRef): string {
  return `https://docs.google.com/spreadsheets/d/${ref.id}/export?format=csv${ref.gid ? `&gid=${ref.gid}` : ''}`;
}

/** The link an admin can click to open the sheet (for confirmation messages). */
export function sheetViewUrl(ref: SheetRef): string {
  return `https://docs.google.com/spreadsheets/d/${ref.id}/edit${ref.gid ? `?gid=${ref.gid}` : ''}`;
}

/* ------------------------------------------------------------------ downloading */

const NOT_SHARED =
  'Google would not show me that sheet. In Google Sheets choose Share → General access → "Anyone with the link" → Viewer, then try again.';

const allowedHost = (host: string) => host === 'docs.google.com' || host.endsWith('.googleusercontent.com');

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > max) throw new ImportError('That sheet is too large for me to read.');
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new ImportError('That sheet is too large for me to read.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Fetch the sheet's CSV export. Follows Google's own redirects only; anything else is refused. */
export async function downloadSheetCsv(ref: SheetRef, fetchFn: typeof fetch = fetch): Promise<string> {
  let current = sheetExportUrl(ref);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const host = new URL(current).hostname;
    if (host === 'accounts.google.com') throw new ImportError(NOT_SHARED);
    if (!allowedHost(host) || !current.startsWith('https://')) throw new ImportError('Google sent me somewhere unexpected, so I stopped.');

    let res: Response;
    try {
      res = await fetchFn(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'text/csv,text/plain;q=0.9,*/*;q=0.1' },
      });
    } catch {
      throw new ImportError("I couldn't reach Google Sheets just now.");
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new ImportError('Google answered with a redirect I could not follow.');
      await res.body?.cancel().catch(() => undefined);
      current = new URL(location, current).toString();
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new ImportError(NOT_SHARED);
    if (res.status === 404 || res.status === 400) throw new ImportError("Google couldn't find that sheet or tab. Check the link.");
    if (!res.ok) throw new ImportError(`Google Sheets answered with an error (HTTP ${res.status}).`);

    const type = res.headers.get('content-type') ?? '';
    if (/text\/html/i.test(type)) throw new ImportError(NOT_SHARED);
    return readCapped(res, MAX_CSV_BYTES);
  }
  throw new ImportError('Google redirected me too many times, so I stopped.');
}

/* ------------------------------------------------------------------ reading cells */

/** `11/1/2026` (month first, as US sheets show it), `13/11/2026` (day first when it can't be a month) or `2026-11-01`. */
export function parseSheetDate(input: string): { y: number; m: number; d: number } | null {
  const t = input.trim();
  let y: number;
  let m: number;
  let d: number;
  let hit = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
  if (hit) {
    const a = Number(hit[1]);
    const b = Number(hit[2]);
    y = Number(hit[3]) < 100 ? 2000 + Number(hit[3]) : Number(hit[3]);
    [m, d] = a > 12 && b <= 12 ? [b, a] : [a, b];
  } else if ((hit = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) {
    y = Number(hit[1]);
    m = Number(hit[2]);
    d = Number(hit[3]);
  } else return null;

  const back = new Date(Date.UTC(y, m - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return { y, m, d };
}

const toMinutes = (digits: string): number | null => {
  const p = digits.padStart(4, '0');
  const h = Number(p.slice(0, 2));
  const mi = Number(p.slice(2));
  if (mi > 59 || h > 24 || (h === 24 && mi > 0)) return null;
  return h * 60 + mi;
};

/**
 * A landing window in Zulu (UTC) as people type it: `0600-2359z`, ` 1200 - 0600z`, `Fri. 0600-2359z`,
 * `Sun. 1200z-0600`. Returns minutes after midnight on the row's date. An end at or before the start
 * means the window runs into the next day.
 */
export function parseZuluWindow(input: string): { startMin: number; endMin: number } | null {
  const m = /(\d{3,4})\s*z?\s*(?:-|–|—|to)\s*(\d{3,4})\s*z?/i.exec(input);
  if (!m) return null;
  const startMin = toMinutes(m[1] as string);
  const endMin = toMinutes(m[2] as string);
  if (startMin === null || endMin === null) return null;
  return { startMin, endMin };
}

/** Is a checkbox cell ticked? */
export const isTicked = (v: string) => /^(true|yes|y|x|done|✓|✔)$/i.test(v.trim());
/** Does a Pilot cell say the flight was cancelled? */
export const isCancelled = (v: string) => /^cancel/i.test(v.trim());

/* ------------------------------------------------------------------ the schedule layout */

function findHeader(rows: string[][]): { index: number; names: string[] } | null {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const names = (rows[i] as string[]).map(canon);
    if (names.includes('route') && names.includes('date')) return { index: i, names };
  }
  return null;
}

function capWarnings(warnings: string[]): string[] {
  if (warnings.length <= MAX_WARNINGS) return warnings;
  return [...warnings.slice(0, MAX_WARNINGS), `…and ${warnings.length - MAX_WARNINGS} more`];
}

/** A schedule tab as read: the flights, plus where each one sits so it can be written to. */
export interface ParsedSchedule extends FetchedJobs {
  /** The sheet row (1 = the first row) each flight's key was read from. */
  rowOf: Map<string, number>;
  /** Zero-based column positions, or -1 if the tab has no such column. */
  cols: { pilot: number; done: number };
}

/** Spreadsheet column letters for a zero-based index: 0 is A, 25 is Z, 26 is AA. */
export function colLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

const hasWindowColumn = (names: string[]) => names.some((n) => n.includes('window') && (n.includes('zulu') || n.includes('utc')));

/**
 * Read a schedule tab: one flight per row, with a route, a date, a landing window and the pilot who
 * signed up. A row that can't be read is skipped and reported, never allowed to stop the others.
 */
function parseScheduleRows(rows: string[][], header: { index: number; names: string[] }, now: number): ParsedSchedule {
  const { names } = header;
  const at = (pred: (n: string) => boolean) => names.findIndex(pred);
  const iRoute = at((n) => n === 'route');
  const iDate = at((n) => n === 'date');
  const iWindow = at((n) => n.includes('window') && (n.includes('zulu') || n.includes('utc')));
  const iPilot = at((n) => n === 'pilot');
  const iBackup = at((n) => n === 'backuppilot');
  const iAircraft = at((n) => n === 'aircraft' || n === 'aircrafttype');
  const iDone = at((n) => n.startsWith('flightcompleted') || n === 'completed');

  const warnings: string[] = [];
  const jobs: SourceJob[] = [];
  const rowOf = new Map<string, number>();
  const seenKeys = new Map<string, number>();

  for (let i = header.index + 1; i < rows.length; i++) {
    const r = rows[i] as string[];
    const rowNo = i + 1;
    const cell = (c: number) => (c >= 0 ? (r[c] ?? '').trim() : '');

    const route = cell(iRoute);
    if (!route || /^week\b/i.test(route)) continue; // blank filler and "Week 2" divider rows

    const legs = parseLegChain(route);
    if (typeof legs === 'string') {
      warnings.push(`row ${rowNo}: route "${str(route, 30)}" ${legs}`);
      continue;
    }
    const label = `row ${rowNo} (${legs.map((l) => `${l.dep}-${l.arr}`).join(', ')})`;

    const day = parseSheetDate(cell(iDate));
    if (!day) {
      warnings.push(`${label}: the date "${str(cell(iDate), 20) ?? ''}" isn't a date`);
      continue;
    }
    const midnight = Date.UTC(day.y, day.m - 1, day.d);

    let availableFrom = midnight;
    let deadline = midnight + 23 * 3_600_000 + 59 * 60_000;
    const window = iWindow >= 0 ? parseZuluWindow(cell(iWindow)) : null;
    if (window) {
      availableFrom = midnight + window.startMin * 60_000;
      deadline = midnight + window.endMin * 60_000 + (window.endMin <= window.startMin ? DAY : 0);
    } else {
      warnings.push(`${label}: couldn't read the landing window "${str(cell(iWindow), 30) ?? ''}", so the whole day is used`);
    }
    if (deadline < now - KEEP_FINISHED_FOR_MS) continue; // long over; nothing to show

    const pilot = cell(iPilot);
    const backup = cell(iBackup);
    const cancelled = isCancelled(pilot);
    // Cancelled flights often have the box ticked too (to settle the books), but nobody flew them.
    const completed = !cancelled && isTicked(cell(iDone));
    const heldBy = pilot && !cancelled ? str(pilot, 40) : null;
    const backupName = backup && !isCancelled(backup) ? str(backup, 40) : null;

    const dayKey = `${day.y}-${String(day.m).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`;
    const base = `${legs.map((l) => `${l.dep}-${l.arr}`).join('+')}@${dayKey}`;
    const nth = (seenKeys.get(base) ?? 0) + 1;
    seenKeys.set(base, nth);

    const key = nth === 1 ? base : `${base}#${nth}`;
    rowOf.set(key, rowNo);
    jobs.push({
      key,
      title: null,
      legs: legs.map((l) => ({ ...l, heldBy })),
      aircraft: str(cell(iAircraft), 40),
      availableFrom,
      deadline,
      pay: null,
      notes: backupName ? `Backup: ${backupName}` : null,
      closed: cancelled || completed,
      completed,
    });
  }

  if (jobs.length > MAX_JOBS) {
    warnings.push(`the sheet has ${jobs.length} flights; only the last ${MAX_JOBS} are used`);
    jobs.splice(0, jobs.length - MAX_JOBS);
  }
  return { jobs, warnings: capWarnings(warnings), rowOf, cols: { pilot: iPilot, done: iDone } };
}

/** A schedule tab given as rows of cells (as the Sheets API returns it). Null if it isn't a schedule layout. */
export function parseScheduleValues(values: string[][], now: number): ParsedSchedule | null {
  const header = findHeader(values);
  return header && hasWindowColumn(header.names) ? parseScheduleRows(values, header, now) : null;
}

/**
 * Turn a sheet's CSV into jobs. A schedule layout (Route, Date, Landing Window Zulu, …) is read row
 * by row, leniently. Any other sheet must use the columns of `/setup template` and is all-or-nothing,
 * like a file import.
 */
export function parseSheetCsv(text: string, now: number): FetchedJobs {
  const rows = parseCsv(text, { keepBlankRows: true });
  if (rows.length === 0) throw new ImportError('That sheet is empty.');

  const schedule = parseScheduleValues(rows, now);
  if (schedule) return { jobs: schedule.jobs, warnings: schedule.warnings };

  try {
    return { jobs: parseJobsFile(text, 'sheet.csv'), warnings: [] };
  } catch (e) {
    if (e instanceof ImportError) {
      const detail = e.problems.length > 0 ? ` ${e.problems.slice(0, 3).join('; ')}` : '';
      throw new ImportError(`${e.message}${detail}`, e.problems);
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ the source */

export class SheetJobSource implements JobSource {
  readonly kind = 'google-sheet';

  constructor(
    readonly ref: SheetRef,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async fetch(_airline: SourceAirline, now: number): Promise<FetchedJobs> {
    return parseSheetCsv(await downloadSheetCsv(this.ref, this.fetchFn), now);
  }
}

/** The sheet a panel reads from, if an admin linked one. */
export function sheetRefOf(panel: Pick<Panel, 'sheetId' | 'sheetGid'>): SheetRef | null {
  return panel.sheetId ? { id: panel.sheetId, gid: panel.sheetGid } : null;
}

/**
 * Which source feeds a panel: its linked Google Sheet if it has one, otherwise `fallback` (the demo
 * source in demo mode, nothing otherwise, which means the flights come from file imports).
 */
export function sourceSelector(opts: { fallback?: JobSource | null; fetchFn?: typeof fetch } = {}): (panel: Panel) => JobSource | null {
  return (panel) => {
    const ref = sheetRefOf(panel);
    return ref ? new SheetJobSource(ref, opts.fetchFn ?? fetch) : (opts.fallback ?? null);
  };
}
