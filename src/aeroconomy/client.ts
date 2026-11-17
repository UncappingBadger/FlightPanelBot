import { z } from 'zod';
import { readTextCapped } from '../util/http.js';
import { silentLogger, type Logger } from '../util/log.js';

/**
 * A small, read-only client for the PUBLIC parts of Aeroconomy's API (https://aeroconomy.com/docs/api-v1): the list of published
 * contracts, and one contract's manifests (its flights, each with the airline's own flight number). Neither needs an account or a token,
 * and nothing about any person is sent: the requests are plain GETs of public pages. It never sends a credential of any kind.
 *
 * Aeroconomy limits how fast it can be asked (a few dozen quick requests get a 429), so this client goes slowly on purpose: one request
 * every couple of seconds, and a wait for as long as a 429 says before trying again.
 */
export const AEROCONOMY_API = 'https://aeroconomy.com/api/v1';

const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 4_000_000;
/** Pages read at most for one list, so a server that never says "that was the last" cannot keep the bot reading. */
const MAX_PAGES = 20;
/** The contract list is filtered to these, since a finished or breached contract has no flights left to number. */
const LIVE_CONTRACT_STATUSES = ['active', 'awarded'] as const;
/** Contracts read for one airline, at most. */
export const MAX_CONTRACTS = 150;

/** Aeroconomy could not be asked, or answered in a way that makes no sense. `message` is safe to show. */
export class AeroconomyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AeroconomyError';
  }
}

/** A contract awarded to an airline. */
export interface AeroContract {
  id: number;
  status: string;
  /** How many flights (manifests) it has in all, when the list says. */
  total: number | null;
}

/** One flight of a contract, as far as the bot reads it. */
export interface AeroFlight {
  /** The airline's own flight number, for example `SKY290`. */
  number: string;
  dep: string;
  arr: string;
  /** The landing window, in epoch ms. */
  start: number;
  end: number;
  /** `planned`, `available`, `assigned`, `completed`, `failed` or `cancelled`. */
  status: string;
}

const ContractsPage = z
  .object({
    data: z.array(z.unknown()).default([]),
    meta: z.object({ next_cursor: z.string().nullish(), has_more: z.boolean().nullish() }).passthrough().nullish(),
  })
  .passthrough();

const objectOrMissing = (v: unknown): unknown => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined);

const ContractRow = z
  .object({
    id: z.number().int(),
    status: z.string().nullish(),
    awardee: z.preprocess(objectOrMissing, z.object({ type: z.string().nullish(), id: z.number().int().nullish() }).passthrough().optional()),
    progress: z.preprocess(objectOrMissing, z.object({ total: z.number().nullish() }).passthrough().optional()),
  })
  .passthrough();

const ManifestsPage = z
  .object({
    data: z.array(z.unknown()).default([]),
    meta: z.object({ last_page: z.number().int().nullish() }).passthrough().nullish(),
  })
  .passthrough();

const iso = z.string().transform((v, ctx) => {
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) ctx.addIssue({ code: 'custom', message: 'not a date' });
  return ms;
});

const ManifestRow = z
  .object({
    flight_number: z.string(),
    origin_icao: z.string(),
    destination_icao: z.string(),
    status: z.string().nullish(),
    arrival_window: z.object({ starts_at: iso, ends_at: iso }).passthrough(),
  })
  .passthrough();

export interface AeroconomyOptions {
  fetchFn?: typeof fetch;
  logger?: Logger;
  userAgent?: string;
  baseUrl?: string;
  /** The least time between two requests. Tests set it to 0. */
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class AeroconomyClient {
  private readonly fetchFn: typeof fetch;
  private readonly log: Logger;
  private readonly userAgent: string;
  private readonly base: string;
  private readonly gapMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private lastAt = 0;

  constructor(opts: AeroconomyOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.log = opts.logger ?? silentLogger;
    this.userAgent = opts.userAgent ?? 'FlightPanelBot';
    this.base = (opts.baseUrl ?? AEROCONOMY_API).replace(/\/+$/, '');
    this.gapMs = opts.gapMs ?? 2500;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  /**
   * The contracts awarded to an airline (by its FsHub airline number) that still have flights to fly. The list of published contracts
   * is read a page at a time, filtered by Aeroconomy to the live ones, and the airline's are picked out here.
   */
  async airlineContracts(airlineId: number): Promise<AeroContract[]> {
    if (!Number.isSafeInteger(airlineId) || airlineId <= 0) return [];
    const out: AeroContract[] = [];
    for (const status of LIVE_CONTRACT_STATUSES) {
      let cursor: string | null = null;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = await this.get(`/contracts?status=${status}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        const parsed = ContractsPage.safeParse(body);
        if (!parsed.success) throw new AeroconomyError('Aeroconomy sent a list of contracts in a form I do not understand.');
        for (const raw of parsed.data.data) {
          const row = ContractRow.safeParse(raw);
          if (!row.success) continue;
          const c = row.data;
          if (c.awardee?.type !== 'airline' || c.awardee.id !== airlineId) continue;
          out.push({ id: c.id, status: c.status ?? status, total: typeof c.progress?.total === 'number' ? c.progress.total : null });
        }
        cursor = parsed.data.meta?.has_more ? (parsed.data.meta.next_cursor ?? null) : null;
        if (!cursor) break;
      }
    }
    const seen = new Set<number>();
    return out.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true))).slice(0, MAX_CONTRACTS);
  }

  /** Every flight of one contract. A flight that cannot be read is left out; a contract that is gone is an empty list. */
  async manifests(contractId: number): Promise<AeroFlight[]> {
    if (!Number.isSafeInteger(contractId) || contractId <= 0) return [];
    const out: AeroFlight[] = [];
    let last = 1;
    for (let page = 1; page <= Math.min(last, MAX_PAGES); page++) {
      const body = await this.get(`/contracts/${contractId}/manifests?page=${page}`);
      if (body === null) return out;
      const parsed = ManifestsPage.safeParse(body);
      if (!parsed.success) throw new AeroconomyError('Aeroconomy sent a contract in a form I do not understand.');
      last = parsed.data.meta?.last_page ?? 1;
      for (const raw of parsed.data.data) {
        const m = ManifestRow.safeParse(raw);
        if (!m.success) continue;
        out.push({
          number: m.data.flight_number.trim().toUpperCase(),
          dep: m.data.origin_icao.trim().toUpperCase(),
          arr: m.data.destination_icao.trim().toUpperCase(),
          start: m.data.arrival_window.starts_at,
          end: m.data.arrival_window.ends_at,
          status: (m.data.status ?? '').toLowerCase(),
        });
      }
    }
    return out;
  }

  /** The JSON at a path, or null for a 404. Anything else that is not a good answer throws. Waits its turn, and out a 429. */
  private async get(path: string): Promise<unknown | null> {
    for (let attempt = 1; ; attempt++) {
      const wait = this.lastAt + this.gapMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastAt = this.now();

      let res: Response;
      try {
        res = await this.fetchFn(`${this.base}${path}`, {
          method: 'GET',
          redirect: 'manual',
          headers: { accept: 'application/json', 'user-agent': this.userAgent },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        throw new AeroconomyError(`Aeroconomy could not be reached (${e instanceof Error ? e.name : 'error'}).`);
      }
      if (res.status === 429) {
        await res.body?.cancel().catch(() => undefined);
        const asked = Number(res.headers.get('retry-after'));
        const seconds = Math.min(60, Number.isFinite(asked) && asked > 0 ? asked : 20 * attempt);
        if (attempt >= 3) throw new AeroconomyError('Aeroconomy asked me to slow down, and still did after waiting.');
        this.log.debug(`Aeroconomy said slow down; waiting ${seconds} seconds`);
        await this.sleep(seconds * 1000);
        this.lastAt = this.now();
        continue;
      }
      if (res.status === 404) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new AeroconomyError(`Aeroconomy answered ${res.status}.`);
      }
      const text = await readTextCapped(res, MAX_BODY_BYTES);
      if (text === null) throw new AeroconomyError('Aeroconomy sent far more than expected.');
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new AeroconomyError('Aeroconomy did not send JSON.');
      }
    }
  }
}
