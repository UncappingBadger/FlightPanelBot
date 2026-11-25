import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { saveAtomically, toCsv, localSheetFile } from '../google/localSheet.js';
import { parseCsv } from '../jobs/import.js';
import type { SheetRef } from '../jobs/sheet.js';
import { silentLogger, type Logger } from '../util/log.js';

/**
 * Made-up schedule data for the test build, which never asks Google for anything: a schedule in the layout of an airline's sign-up sheet,
 * kept in a local file (see `LocalSheet`), and a "feeder" that goes on changing it while the bot runs, the way people do: new days of flights
 * appear, pilots put their names against flights, flown flights get their box ticked and a profit, a few flights are cancelled. Everything
 * here is invented (the airline, the pilots, the flights), so it can be shown, shared and thrown away.
 */

/** A sheet link for the test build. Any sheet link works there (its flights are made up too); this one is just a ready-made. */
export const TEST_SHEET_ID = 'FpbTestSheet00000000000000000001';
export const TEST_SHEET_URL = `https://docs.google.com/spreadsheets/d/${TEST_SHEET_ID}/edit`;

export const HEADER = [
  'Route',
  'Date',
  'Landing Window Zulu',
  'Landing Window US Central',
  'Pilot',
  'Backup Pilot',
  'Aircraft',
  'Flight Completed (by Pilot)',
  'Pilot Paid',
  'Distance (NM)',
  'Flight Number',
  'Profit Made',
  'Pilot Pay',
  'Safety Deductions',
];
const COL = Object.fromEntries(HEADER.map((h, i) => [h, i])) as Record<string, number>;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const startOfDay = (ms: number) => ms - (((ms % DAY) + DAY) % DAY);

/** Real airports (their names are public), with positions to the nearest degree, so every flight has a believable distance. */
const AIRPORTS: Record<string, [number, number]> = {
  EGLL: [51.47, -0.46],
  EGCC: [53.35, -2.27],
  EGPH: [55.95, -3.37],
  EIDW: [53.42, -6.27],
  LFPG: [49.01, 2.55],
  EHAM: [52.31, 4.76],
  EDDF: [50.03, 8.57],
  LEMD: [40.47, -3.56],
  LIRF: [41.8, 12.24],
  LSZH: [47.46, 8.55],
  ENGM: [60.19, 11.1],
  EKCH: [55.62, 12.65],
  LOWW: [48.11, 16.57],
  EPWA: [52.17, 20.97],
  LGAV: [37.94, 23.94],
  LTFM: [41.28, 28.75],
};
const CODES = Object.keys(AIRPORTS);
const AIRCRAFT = ['A320', 'A21N', 'B738', 'B739', 'E190', 'A319', 'B737', 'A20N'];
/** Invented pilots. */
const PILOTS = ['Alex Morgan', 'Sam Rivera', 'Jordan Lee', 'Casey Kim', 'Taylor Brooks', 'Riley Chen', 'Morgan Ellis', 'Jamie Cole', 'Drew Patel', 'Quinn Ortiz', 'Robin Hayes', 'Skye Novak'];

const greatCircleNm = (a: [number, number], b: [number, number]): number => {
  const r = Math.PI / 180;
  const h = Math.sin(((b[0] - a[0]) * r) / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(h));
};

/** A small repeatable random number generator: the same seed makes the same airline. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sheetDate = (dayMs: number): string => {
  const d = new Date(dayMs);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
};
const hhmm = (h: number) => `${String(h).padStart(2, '0')}00`;

/** The flights of one day: six to nine of them, one or two legs each, at different times. `numberFrom` is where the flight numbers go on from. */
export function flightsOfDay(dayMs: number, random: () => number, numberFrom: number): string[][] {
  const count = 6 + Math.floor(random() * 4);
  const rows: string[][] = [];
  for (let i = 0; i < count; i++) {
    const pick = () => CODES[Math.floor(random() * CODES.length)]!;
    const from = pick();
    let to = pick();
    while (to === from) to = pick();
    const legs = random() < 0.15 ? [from, to, from] : [from, to];
    const nm = legs.slice(1).reduce((n, c, k) => n + greatCircleNm(AIRPORTS[legs[k]!]!, AIRPORTS[c]!), 0);
    const start = Math.floor(random() * 17); // 00 to 16 Zulu
    const end = Math.min(23, start + 6 + Math.floor(random() * 3));
    const window = `${hhmm(start)}-${end === 23 ? '2359' : hhmm(end)}z`;
    const row = new Array<string>(HEADER.length).fill('');
    row[COL['Route']!] = legs.join('-');
    row[COL['Date']!] = sheetDate(dayMs);
    row[COL['Landing Window Zulu']!] = window;
    row[COL['Landing Window US Central']!] = `${((start + 18) % 24) || 24}:00 - ${((end + 18) % 24) || 24}:00`;
    row[COL['Aircraft']!] = AIRCRAFT[Math.floor(random() * AIRCRAFT.length)]!;
    row[COL['Flight Completed (by Pilot)']!] = 'FALSE';
    row[COL['Pilot Paid']!] = 'FALSE';
    row[COL['Distance (NM)']!] = String(Math.round(nm));
    row[COL['Flight Number']!] = `SKY${numberFrom + i}`;
    rows.push(row);
  }
  return rows;
}

/** A first schedule: some days that are already over (flown, mostly), today, and the days ahead. */
export function startingSchedule(now: number, seed = 1, daysBack = 2, daysAhead = 12): string[][] {
  const random = rng(seed);
  const today = startOfDay(now);
  const rows: string[][] = [HEADER];
  let number = 1000;
  for (let d = -daysBack; d <= daysAhead; d++) {
    const day = flightsOfDay(today + d * DAY, random, number);
    number += day.length;
    if (d < 0) {
      // Days gone by: most were flown by somebody, the box ticked, a profit entered; a few were not taken.
      for (const row of day) {
        if (random() < 0.8) {
          row[COL['Pilot']!] = PILOTS[Math.floor(random() * PILOTS.length)]!;
          row[COL['Flight Completed (by Pilot)']!] = 'TRUE';
          row[COL['Profit Made']!] = `$${(Math.round(random() * 90_000) + 5_000).toLocaleString('en-US')}`;
        }
      }
    }
    rows.push(...day);
  }
  return rows;
}

export const startingCsv = (now: number, seed = 1): string => toCsv(startingSchedule(now, seed));

/** What one pass of the feeder did. */
export interface FeedResult {
  /** Flights added at the end (new days). */
  added: number;
  /** Pilots who put their names against a flight. */
  signedUp: number;
  /** Flights whose box was ticked. */
  completed: number;
  /** Flights cancelled. */
  cancelled: number;
}

/** A flight nobody signs up for by themselves: one in five, by its flight number. */
const isUnpopular = (row: string[]): boolean => /[05]$/.test((row[COL['Flight Number']!] ?? '').trim());

const idle = (r: FeedResult) => r.added + r.signedUp + r.completed + r.cancelled === 0;

/** The window of a row as [start, end] in epoch ms, or null if it can't be read. */
function windowOf(row: string[]): { day: number; start: number; end: number } | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((row[COL['Date']!] ?? '').trim());
  const w = /^(\d{2})(\d{2})-(\d{2})(\d{2})z$/i.exec((row[COL['Landing Window Zulu']!] ?? '').trim());
  if (!m || !w) return null;
  const day = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return { day, start: day + Number(w[1]) * HOUR + Number(w[2]) * 60_000, end: day + Number(w[3]) * HOUR + Number(w[4]) * 60_000 };
}

/**
 * Keeps made-up sheets changing. Each sheet it was asked to look after is changed in place, in its local file, once in a while: the bot reads
 * the change the next time it reads the schedule, exactly as it would a change a person made in Google Sheets. It runs in the bot's own
 * process, so it never changes the file at the same moment as the bot does.
 */
export class TestSheetFeeder {
  private readonly sheets = new Map<string, SheetRef>();
  private readonly random: () => number;
  private readonly log: Logger;

  constructor(
    private readonly dir: string,
    private readonly now: () => number,
    opts: { seed?: number; logger?: Logger; /** How many days ahead there are always flights. */ daysAhead?: number } = {},
  ) {
    this.random = rng(opts.seed ?? 7);
    this.log = opts.logger ?? silentLogger;
    this.daysAhead = opts.daysAhead ?? 12;
  }
  private readonly daysAhead: number;

  /** A made-up schedule for a sheet that has no file yet: written, and looked after from now on. Returns its CSV. */
  make = (ref: SheetRef): string => {
    const csv = startingCsv(this.now(), 1);
    this.sheets.set(this.keyOf(ref), ref);
    return csv;
  };

  /** Look after a sheet whose file already exists (the bot was restarted). */
  adopt(ref: SheetRef): void {
    if (existsSync(localSheetFile(this.dir, ref))) this.sheets.set(this.keyOf(ref), ref);
  }

  private keyOf = (ref: SheetRef) => `${ref.id}#${ref.gid ?? ''}`;

  /** The sheets looked after. */
  get count(): number {
    return this.sheets.size;
  }

  /** One pass over every sheet. Returns what changed, summed. */
  feed(): FeedResult {
    const total: FeedResult = { added: 0, signedUp: 0, completed: 0, cancelled: 0 };
    for (const ref of this.sheets.values()) {
      const r = this.feedOne(ref);
      total.added += r.added;
      total.signedUp += r.signedUp;
      total.completed += r.completed;
      total.cancelled += r.cancelled;
    }
    if (!idle(total)) {
      this.log.info(`[test] sheet feed: +${total.added} flights, ${total.signedUp} pilots signed up, ${total.completed} flights ticked as flown, ${total.cancelled} cancelled`);
    }
    return total;
  }

  private feedOne(ref: SheetRef): FeedResult {
    const out: FeedResult = { added: 0, signedUp: 0, completed: 0, cancelled: 0 };
    const file = localSheetFile(this.dir, ref);
    if (!existsSync(file)) return out;
    const rows = parseCsv(readFileSync(file, 'utf8'), { keepBlankRows: true });
    if (rows.length === 0) return out;
    const now = this.now();
    const today = startOfDay(now);
    const col = (name: string) => COL[name]!;
    const cell = (r: string[], name: string) => (r[col(name)] ?? '').trim();
    const set = (r: string[], name: string, v: string) => {
      while (r.length <= col(name)) r.push('');
      r[col(name)] = v;
    };

    // 1. New days at the end, so there are always flights ahead.
    let lastDay = 0;
    let number = 1000;
    for (const r of rows.slice(1)) {
      const w = windowOf(r);
      if (w) lastDay = Math.max(lastDay, w.day);
      const n = /^SKY(\d+)$/.exec(cell(r, 'Flight Number'));
      if (n) number = Math.max(number, Number(n[1]) + 1);
    }
    for (let day = lastDay + DAY; day <= today + this.daysAhead * DAY; day += DAY) {
      const flights = flightsOfDay(day, this.random, number);
      number += flights.length;
      rows.push(...flights);
      out.added += flights.length;
    }

    // 2. Flown flights get their box ticked (most of them, not all), and often a profit.
    for (const r of rows.slice(1)) {
      const w = windowOf(r);
      const pilot = cell(r, 'Pilot');
      if (!w || !pilot || /^cancel/i.test(pilot) || /^true$/i.test(cell(r, 'Flight Completed (by Pilot)'))) continue;
      if (w.end < now && this.random() < 0.7) {
        set(r, 'Flight Completed (by Pilot)', 'TRUE');
        if (!cell(r, 'Profit Made') && this.random() < 0.6) set(r, 'Profit Made', `$${(Math.round(this.random() * 90_000) + 5_000).toLocaleString('en-US')}`);
        out.completed++;
      }
    }

    // 3. A couple of pilots put their names against flights in the next few days.
    // (Flights whose number ends in 0 or 5 are the ones nobody wants: they stay unstaffed, so the list of flights without a pilot has something in it each midnight.)
    const open = rows.slice(1).filter((r) => {
      const w = windowOf(r);
      return w !== null && w.end > now && w.day <= today + 3 * DAY && !cell(r, 'Pilot') && !isUnpopular(r);
    });
    for (let i = 0; i < 2 && open.length > 0; i++) {
      if (this.random() < 0.5) continue;
      const r = open.splice(Math.floor(this.random() * open.length), 1)[0]!;
      set(r, 'Pilot', PILOTS[Math.floor(this.random() * PILOTS.length)]!);
      out.signedUp++;
    }

    // 4. Now and then a flight further ahead is cancelled.
    if (this.random() < 0.15) {
      const ahead = rows.slice(1).filter((r) => {
        const w = windowOf(r);
        return w !== null && w.day >= today + DAY && !cell(r, 'Pilot');
      });
      if (ahead.length > 0) {
        set(ahead[Math.floor(this.random() * ahead.length)]!, 'Pilot', 'CANCELLED');
        out.cancelled++;
      }
    }

    if (!idle(out)) {
      mkdirSync(this.dir, { recursive: true });
      saveAtomically(file, toCsv(rows));
    }
    return out;
  }
}
