import type { AeroContract, AeroFlight, AeroconomyClient } from '../aeroconomy/client.js';
import type { JobView, Panel, Store } from '../db/store.js';
import { normalizeFlightNumber } from '../jobs/types.js';
import { HourlySlot } from './hourlySlot.js';
import { silentLogger, type Logger } from '../util/log.js';

/**
 * The airline's own flight numbers from Aeroconomy, for flights whose sheet row has none.
 *
 * Aeroconomy publishes every contract and its flights (each with the airline's flight number, the two airports and the landing window)
 * without any account or token, and a sheet row has the same airports and window, so a row that is exactly one published flight takes
 * that flight's number as its ID. See `aeroconomy/client.ts` for what is read, and how slowly.
 */

/** How many hourly slots what was read is used before the contracts are read again (so the read starts at the same moment as the hourly checks). */
const REFRESH_SLOTS = 6;
/** After a failed read, the next try is no sooner than this. */
const RETRY_MS = 30 * 60_000;
/** A sheet row's landing window is the flight's, give or take this (a sheet says 23:59:00, Aeroconomy 23:59:59). */
const WINDOW_TOLERANCE_MS = 2 * 60_000;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const cacheKey = (airlineId: number) => `aeronum.${airlineId}`;

/** What is needed of a flight on a panel to find its number: a sheet row (`SourceJob`) has all of it. */
export interface NumberedJob {
  legs: Array<{ dep: string; arr: string }>;
  availableFrom: number | null;
  deadline: number | null;
  /** A number the source gave the flight itself. It is never replaced. */
  flightNumber?: string | null;
}

/**
 * How a flight stands: `own` (its source already gave it a number), `numbered` (exactly one Aeroconomy flight is it), `ambiguous` (more
 * than one could be, or two rows want the same one: it is not guessed), or `none` (no Aeroconomy flight has its two airports and window).
 */
export type NumberState = 'own' | 'numbered' | 'ambiguous' | 'none';
export interface NumberMatch {
  state: NumberState;
  /** The ID the flight takes (the number, with the day on the end when the same number is flown on several days). */
  code: string | null;
  /** The flight number itself, as the airline writes it, for a flight that is exactly one published flight (what goes in a sheet's Flight Number cell). */
  number: string | null;
}

/**
 * The ID each usable flight would have. A number flown on several days is not unique, so it carries the day (`SKY330-17NOV`, as in the
 * sheet reader); a number flown once is plain (`SKY290`). A code that two flights would both have (the same number twice in a day) is not
 * used for either.
 */
export function flightCodes(flights: AeroFlight[]): Map<AeroFlight, string> {
  const usable = flights.filter((f) => f.status !== 'cancelled' && normalizeFlightNumber(f.number) !== null && Number.isFinite(f.start) && Number.isFinite(f.end));
  const times = new Map<string, number>();
  for (const f of usable) times.set(f.number, (times.get(f.number) ?? 0) + 1);
  const code = (f: AeroFlight): string => {
    if ((times.get(f.number) ?? 0) <= 1) return f.number;
    const day = new Date(f.start);
    return `${f.number}-${String(day.getUTCDate()).padStart(2, '0')}${MONTHS[day.getUTCMonth()]}`;
  };
  const withCode = usable.map((f) => ({ f, code: code(f) }));
  const uses = new Map<string, number>();
  for (const { code: c } of withCode) uses.set(c, (uses.get(c) ?? 0) + 1);
  const out = new Map<AeroFlight, string>();
  for (const { f, code: c } of withCode) if ((uses.get(c) ?? 0) === 1 && (normalizeFlightNumber(c) ?? '') === c) out.set(f, c);
  return out;
}

/**
 * For each flight (in order), the Aeroconomy flight number it takes. Only a flight of one leg with a landing window can be found, and
 * only when it is exactly one published flight: the same two airports, the same window, and nobody else wanting that flight.
 */
export function matchNumbers(jobs: NumberedJob[], flights: AeroFlight[]): NumberMatch[] {
  const codes = flightCodes(flights);
  const usable = [...codes.keys()];
  const sameWindow = (a: number, b: number) => Math.abs(a - b) <= WINDOW_TOLERANCE_MS;

  const proposals: Array<AeroFlight | 'ambiguous' | 'none' | 'own'> = jobs.map((j) => {
    if (j.flightNumber) return 'own';
    const leg = j.legs.length === 1 ? j.legs[0] : undefined;
    if (!leg || j.availableFrom === null || j.deadline === null) return 'none';
    const [dep, arr] = [leg.dep.toUpperCase(), leg.arr.toUpperCase()];
    const hits = usable.filter((f) => f.dep === dep && f.arr === arr && sameWindow(f.start, j.availableFrom as number) && sameWindow(f.end, j.deadline as number));
    if (hits.length === 0) return 'none';
    return hits.length > 1 ? 'ambiguous' : (hits[0] as AeroFlight);
  });
  // Two rows that landed on the same flight (the same airports and window, or windows a minute apart) cannot both be it.
  const claimed = new Map<AeroFlight, number>();
  for (const p of proposals) if (typeof p === 'object') claimed.set(p, (claimed.get(p) ?? 0) + 1);
  return proposals.map((p): NumberMatch => {
    if (p === 'own') return { state: 'own', code: null, number: null };
    if (p === 'none') return { state: 'none', code: null, number: null };
    if (p === 'ambiguous' || (claimed.get(p) ?? 0) > 1) return { state: 'ambiguous', code: null, number: null };
    return { state: 'numbered', code: codes.get(p) ?? null, number: normalizeFlightNumber(p.number) };
  });
}

/** What was read for one airline. */
export interface NumbersCache {
  at: number;
  flights: AeroFlight[];
  contracts: number;
}

export interface NumbersCoverage {
  readAt: number | null;
  flights: number;
  contracts: number;
  open: number;
  numbered: number;
  ambiguous: number;
  none: number;
}

export interface AeroNumbersDeps {
  store: Store;
  client: Pick<AeroconomyClient, 'airlineContracts' | 'manifests'>;
  /** Called for each panel when its airline's flights have just been read, so the numbers reach the panel straight away. */
  apply?: (panel: Panel) => Promise<unknown>;
  logger?: Logger;
  now?: () => number;
  /** The moment each hour at which the hourly checks happen together; the read of Aeroconomy starts in every sixth slot. */
  slot?: HourlySlot;
}

export class AeroNumbers {
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly slot: HourlySlot;
  private readonly caches = new Map<number, NumbersCache | null>();
  private readonly failedAt = new Map<number, number>();
  private busy: Promise<void> | null = null;

  constructor(private readonly d: AeroNumbersDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.logger ?? silentLogger;
    this.slot = d.slot ?? new HourlySlot(0);
  }

  /** The panels that take Aeroconomy's flight numbers: switched on, and linked to an airline's FsHub number (which the contracts name). */
  private followed(): Array<Panel & { fshubAirlineId: number }> {
    return this.d.store.listAllPanels().filter((p): p is Panel & { fshubAirlineId: number } => p.flightNumbers && p.fshubAirlineId !== null);
  }

  /** What was read for an airline: from memory, else from what was saved the last time. */
  cacheFor(airlineId: number): NumbersCache | null {
    if (this.caches.has(airlineId)) return this.caches.get(airlineId) ?? null;
    let cache: NumbersCache | null = null;
    try {
      const raw = this.d.store.getKv(cacheKey(airlineId));
      const parsed = raw ? (JSON.parse(raw) as { at?: unknown; contracts?: unknown; flights?: unknown }) : null;
      if (parsed && typeof parsed.at === 'number' && Array.isArray(parsed.flights)) {
        const flights: AeroFlight[] = [];
        for (const f of parsed.flights) {
          if (!Array.isArray(f) || typeof f[0] !== 'string' || typeof f[1] !== 'string' || typeof f[2] !== 'string' || typeof f[3] !== 'number' || typeof f[4] !== 'number') continue;
          flights.push({ number: f[0], dep: f[1], arr: f[2], start: f[3], end: f[4], status: typeof f[5] === 'string' ? f[5] : '' });
        }
        cache = { at: parsed.at, flights, contracts: typeof parsed.contracts === 'number' ? parsed.contracts : 0 };
      }
    } catch {
      cache = null;
    }
    this.caches.set(airlineId, cache);
    return cache;
  }

  private save(airlineId: number, cache: NumbersCache): void {
    this.caches.set(airlineId, cache);
    this.d.store.setKv(cacheKey(airlineId), JSON.stringify({ at: cache.at, contracts: cache.contracts, flights: cache.flights.map((f) => [f.number, f.dep, f.arr, f.start, f.end, f.status]) }));
  }

  /** The flights as a panel's refresh found them, with the Aeroconomy flight number given to each that has none and is exactly one published flight. */
  enrich<T extends NumberedJob>(panel: Panel, jobs: T[]): T[] {
    if (!panel.flightNumbers || panel.fshubAirlineId === null) return jobs;
    const cache = this.cacheFor(panel.fshubAirlineId);
    if (!cache) return jobs;
    const matches = matchNumbers(jobs, cache.flights);
    return jobs.map((j, i) => (matches[i]?.code ? { ...j, flightNumber: matches[i]!.code } : j));
  }

  /**
   * The flight number (as the airline writes it) of each of these flights, for a sheet's empty Flight Number cells: the same flights that
   * `enrich` would give a number to, and null for the others. Nothing is known for a panel that does not follow Aeroconomy's numbers or has not
   * read them yet.
   */
  numbersFor(panel: Panel, jobs: NumberedJob[]): Array<string | null> {
    if (!panel.flightNumbers || panel.fshubAirlineId === null) return jobs.map(() => null);
    const cache = this.cacheFor(panel.fshubAirlineId);
    if (!cache) return jobs.map(() => null);
    return matchNumbers(jobs, cache.flights).map((m) => m.number);
  }

  /** How a panel's open flights stand against what was read: for `/setup flight-numbers`. Null when the panel does not follow. */
  coverage(panel: Panel): NumbersCoverage | null {
    if (panel.fshubAirlineId === null) return null;
    const cache = this.cacheFor(panel.fshubAirlineId);
    const views: JobView[] = this.d.store.listOpenJobViews(panel.id);
    const jobs: NumberedJob[] = views.map((v) => ({ legs: v.legs, availableFrom: v.job.availableFrom, deadline: v.job.deadline }));
    const states = matchNumbers(jobs, cache?.flights ?? []);
    const count = (s: NumberState) => states.filter((m) => m.state === s).length;
    return { readAt: cache?.at ?? null, flights: cache?.flights.length ?? 0, contracts: cache?.contracts ?? 0, open: views.length, numbered: count('numbered'), ambiguous: count('ambiguous'), none: count('none') };
  }

  /** Ask for a fresh read of an airline's flights (the next pass starts it), for when the setting has just been switched on. */
  request(airlineId: number): void {
    const cache = this.cacheFor(airlineId);
    if (cache) this.save(airlineId, { ...cache, at: 0 });
    this.failedAt.delete(airlineId);
    void this.run();
  }

  /**
   * One pass: start reading any airline that is due. The read goes slowly (see the client), so it is NOT waited for: it carries on in the
   * background and the pass returns at once, so nothing else the scheduler does is held up. Never throws.
   */
  async run(): Promise<void> {
    if (this.busy) return;
    const now = this.now();
    const due = new Set<number>();
    for (const p of this.followed()) {
      const cache = this.cacheFor(p.fshubAirlineId);
      const failed = this.failedAt.get(p.fshubAirlineId);
      if (failed !== undefined && now - failed < RETRY_MS) continue;
      if (!cache || this.slot.slotsSince(cache.at, now) >= REFRESH_SLOTS) due.add(p.fshubAirlineId);
    }
    if (due.size === 0) return;
    this.busy = this.readAll([...due]).finally(() => {
      this.busy = null;
    });
  }

  /** Resolves once the read that is under way has finished (for tests, and for a tidy shutdown). */
  async idle(): Promise<void> {
    while (this.busy) await this.busy;
  }

  private async readAll(airlineIds: number[]): Promise<void> {
    for (const id of airlineIds) {
      try {
        await this.read(id);
      } catch (e) {
        this.failedAt.set(id, this.now());
        this.log.warn(`Could not read Aeroconomy's flight numbers for FsHub airline ${id}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  private async read(airlineId: number): Promise<void> {
    const contracts: AeroContract[] = await this.d.client.airlineContracts(airlineId);
    const flights: AeroFlight[] = [];
    for (const c of contracts) {
      if (c.total === 0) continue; // nothing to fly yet
      flights.push(...(await this.d.client.manifests(c.id)));
    }
    this.save(airlineId, { at: this.now(), flights, contracts: contracts.length });
    this.failedAt.delete(airlineId);
    this.log.info(`Read ${flights.length} flight${flights.length === 1 ? '' : 's'} from ${contracts.length} Aeroconomy contract${contracts.length === 1 ? '' : 's'} for FsHub airline ${airlineId}`);
    for (const panel of this.followed()) {
      if (panel.fshubAirlineId !== airlineId || !this.d.apply) continue;
      try {
        await this.d.apply(panel);
      } catch (e) {
        this.log.warn(`Could not apply the flight numbers to ${panel.airlineName}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}
