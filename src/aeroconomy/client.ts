import { z } from 'zod';
import { AeroHttp, AEROCONOMY_API, AeroconomyError, type AeroHttpOptions } from './http.js';

export { AEROCONOMY_API, AeroconomyError };

/** Pages read at most for one list, so a server that never says "that was the last" cannot keep the bot reading. */
const MAX_PAGES = 20;
/** The contract list is filtered to these, since a finished or breached contract has no flights left to number. */
const LIVE_CONTRACT_STATUSES = ['active', 'awarded'] as const;
/** Contracts read for one airline, at most. */
export const MAX_CONTRACTS = 150;

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
  /** The serial of the aircraft attached to the flight (a flight that has been taken has one), when Aeroconomy says. */
  aircraftSerial?: number;
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

const PilotPage = z
  .object({
    data: z
      .object({ aircraft: z.preprocess(objectOrMissing, z.object({ owner: z.preprocess(objectOrMissing, z.object({ type: z.string().nullish(), fshub_airline_id: z.number().nullish(), business_id: z.number().nullish() }).passthrough().optional()) }).passthrough().optional()) })
      .passthrough()
      .optional(),
  })
  .passthrough();

const iso = z.string().transform((v, ctx) => {
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) ctx.addIssue({ code: 'custom', message: 'not a date' });
  return ms;
});

/** An aircraft serial as Aeroconomy writes it (`00000618`, or a plain number): the number, or null for anything else. */
function serialOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,10}$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const ManifestRow = z
  .object({
    flight_number: z.string(),
    origin_icao: z.string(),
    destination_icao: z.string(),
    status: z.string().nullish(),
    aircraft_serial: z.union([z.string(), z.number()]).nullish(),
    arrival_window: z.object({ starts_at: iso, ends_at: iso }).passthrough(),
  })
  .passthrough();

export type AeroconomyOptions = AeroHttpOptions;

/**
 * A small, read-only client for the PUBLIC parts of Aeroconomy's API (https://aeroconomy.com/docs/api-v1): the list of published
 * contracts, and one contract's manifests (its flights, each with the airline's own flight number). Neither needs an account or a token,
 * and nothing about any person is sent: the requests are plain GETs of public pages. It never sends a credential of any kind.
 *
 * Aeroconomy limits how fast it can be asked (a few dozen quick requests get a 429), so this client goes slowly on purpose: one request
 * every couple of seconds, and a wait for as long as a 429 says before trying again.
 */
export class AeroconomyClient extends AeroHttp {
  constructor(opts: AeroconomyOptions = {}) {
    super(opts);
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
        const body = await this.fetchJson(`/contracts?status=${status}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
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

  /**
   * The airline (and its backing business) that owns the aircraft a pilot is flying, from Aeroconomy's PUBLIC page for that pilot (nothing
   * but the pilot's public FsHub number is sent). Null when the page does not exist, or the pilot has no aircraft locked.
   */
  async pilotAircraftOwner(fshubPilotId: number): Promise<{ airlineId: number; businessId: number } | null> {
    if (!Number.isSafeInteger(fshubPilotId) || fshubPilotId <= 0) return null;
    const body = await this.fetchJson(`/pilots/${fshubPilotId}`);
    const parsed = PilotPage.safeParse(body);
    const owner = parsed.success ? parsed.data.data?.aircraft?.owner : undefined;
    if (!owner || owner.type !== 'airline' || typeof owner.fshub_airline_id !== 'number' || typeof owner.business_id !== 'number') return null;
    return { airlineId: owner.fshub_airline_id, businessId: owner.business_id };
  }

  /** Every flight of one contract. A flight that cannot be read is left out; a contract that is gone is an empty list. */
  async manifests(contractId: number): Promise<AeroFlight[]> {
    if (!Number.isSafeInteger(contractId) || contractId <= 0) return [];
    const out: AeroFlight[] = [];
    let last = 1;
    for (let page = 1; page <= Math.min(last, MAX_PAGES); page++) {
      const body = await this.fetchJson(`/contracts/${contractId}/manifests?page=${page}`);
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
          ...(serialOf(m.data.aircraft_serial) !== null ? { aircraftSerial: serialOf(m.data.aircraft_serial) as number } : {}),
        });
      }
    }
    return out;
  }
}
