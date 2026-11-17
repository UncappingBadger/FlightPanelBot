import { z } from 'zod';
import { AeroHttp, AeroconomyError, type AeroHttpOptions } from './http.js';

/**
 * Read-only access to the parts of Aeroconomy's API that need a token: an airline's aircraft and each aircraft's logbook (every flight with
 * the profit or loss Aeroconomy worked out for it). The token is the host's FsHub personal access token, which Aeroconomy accepts too.
 *
 * It only ever sends GET requests, only to Aeroconomy (the address is fixed, and a redirect is never followed, so the token cannot be sent
 * anywhere else), and it is only used when an admin runs `/setup profit`. Nothing is ever written to Aeroconomy.
 */

/** An aircraft of an airline. */
export interface AeroAircraft {
  /** The numeric serial (`00000151` is 151). */
  serial: number;
  registration: string | null;
  type: string | null;
  /** `airline` or `business`, and the FsHub airline number when it is an airline's. */
  ownerType: string | null;
  ownerAirlineId: number | null;
  /** The business that backs an airline (what the aircraft list is asked by). */
  businessId: number | null;
}

/** One flight in an aircraft's logbook. */
export interface LogFlight {
  entryId: number;
  /** The FsHub flight ID of the flight, when the entry names one. */
  flightId: number | null;
  /** The callsign the flight was flown under (upper case), or null when it had none. */
  callsign: string | null;
  dep: string;
  arr: string;
  pilotId: number | null;
  pilotName: string | null;
  /** What Aeroconomy worked out the flight made (negative for a loss), in dollars, to the cent. */
  profit: number;
  /** When the flight landed, in epoch ms. */
  landedAt: number;
  /** The distance Aeroconomy logged for the flight, in nautical miles (it takes it from FsHub), or null when it gave none. */
  distanceNm: number | null;
}

const objectOrMissing = (v: unknown): unknown => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined);

const AircraftRow = z
  .object({
    serial: z.union([z.string(), z.number()]),
    registration: z.string().nullish(),
    airframe: z.preprocess(objectOrMissing, z.object({ icao: z.string().nullish() }).passthrough().optional()),
    owner: z.preprocess(objectOrMissing, z.object({ type: z.string().nullish(), fshub_airline_id: z.number().nullish(), business_id: z.number().nullish() }).passthrough().optional()),
  })
  .passthrough();

const ListPage = z.object({ data: z.array(z.unknown()).default([]) }).passthrough();
const OnePage = z.object({ data: z.unknown() }).passthrough();

const LogRow = z
  .object({
    id: z.number().int(),
    event_type: z.string(),
    description: z.string().nullish(),
    callsign: z.string().nullish(),
    source_flight_id: z.number().int().nullish(),
    pilot: z.preprocess(objectOrMissing, z.object({ fshub_user_id: z.number().int().nullish(), name: z.string().nullish() }).passthrough().optional()),
    profit_loss: z.union([z.string(), z.number()]).nullish(),
    distance_nm: z.unknown().optional(),
    occurred_at: z.string(),
  })
  .passthrough();

/** A distance as the logbook gives it (a number, or text like `392.00`), or null when it is not a sensible one. */
function nauticalMiles(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100_000 ? n : null;
}

const ROUTE = /^Flight \[([A-Za-z0-9]{3,5}) > ([A-Za-z0-9]{3,5})\]$/;

function aircraftFrom(raw: unknown): AeroAircraft | null {
  const row = AircraftRow.safeParse(raw);
  if (!row.success) return null;
  const serial = Number(row.data.serial);
  if (!Number.isSafeInteger(serial) || serial <= 0) return null;
  return {
    serial,
    registration: row.data.registration ?? null,
    type: row.data.airframe?.icao ?? null,
    ownerType: row.data.owner?.type ?? null,
    ownerAirlineId: row.data.owner?.fshub_airline_id ?? null,
    businessId: row.data.owner?.business_id ?? null,
  };
}

export class AeroconomyAccountClient extends AeroHttp {
  constructor(
    private readonly token: string,
    opts: AeroHttpOptions = {},
  ) {
    super(opts);
    if (!token.trim()) throw new AeroconomyError('There is no FsHub token to read Aeroconomy with.');
  }

  /** One aircraft, by serial; null when there is none. */
  async aircraft(serial: number): Promise<AeroAircraft | null> {
    if (!Number.isSafeInteger(serial) || serial <= 0) return null;
    const body = await this.fetchJson(`/aircraft/${serial}`, this.token);
    if (body === null) return null;
    const page = OnePage.safeParse(body);
    return page.success ? aircraftFrom(page.data.data) : null;
  }

  /** The aircraft a business (an airline's backing business) owns. An aircraft that cannot be read is left out. */
  async ownedAircraft(businessId: number): Promise<AeroAircraft[]> {
    if (!Number.isSafeInteger(businessId) || businessId <= 0) return [];
    const body = await this.fetchJson(`/businesses/${businessId}/aircraft/owned`, this.token);
    if (body === null) return [];
    const page = ListPage.safeParse(body);
    if (!page.success) throw new AeroconomyError('Aeroconomy sent a list of aircraft in a form I do not understand.');
    const out: AeroAircraft[] = [];
    for (const raw of page.data.data) {
      const a = aircraftFrom(raw);
      if (a) out.push(a);
    }
    return out;
  }

  /**
   * The flights in an aircraft's logbook (the newest hundred entries Aeroconomy gives), each with its profit or loss. Entries that are not
   * flights (a registration, a check, a transfer), and flights that cannot be read, are left out.
   */
  async logbook(serial: number): Promise<LogFlight[]> {
    if (!Number.isSafeInteger(serial) || serial <= 0) return [];
    const body = await this.fetchJson(`/aircraft/${serial}/logbook`, this.token);
    if (body === null) return [];
    const page = ListPage.safeParse(body);
    if (!page.success) throw new AeroconomyError('Aeroconomy sent a logbook in a form I do not understand.');
    const out: LogFlight[] = [];
    for (const raw of page.data.data) {
      const row = LogRow.safeParse(raw);
      if (!row.success || row.data.event_type !== 'flight') continue;
      const route = ROUTE.exec(row.data.description ?? '');
      const profit = row.data.profit_loss === null || row.data.profit_loss === undefined ? Number.NaN : Number(row.data.profit_loss);
      const landedAt = Date.parse(row.data.occurred_at);
      if (!route || !Number.isFinite(profit) || !Number.isFinite(landedAt)) continue;
      const callsign = (row.data.callsign ?? '').trim().toUpperCase();
      out.push({
        entryId: row.data.id,
        flightId: row.data.source_flight_id ?? null,
        callsign: callsign || null,
        dep: (route[1] as string).toUpperCase(),
        arr: (route[2] as string).toUpperCase(),
        pilotId: row.data.pilot?.fshub_user_id ?? null,
        pilotName: row.data.pilot?.name?.trim() || null,
        profit: Math.round(profit * 100) / 100,
        landedAt,
        distanceNm: nauticalMiles(row.data.distance_nm),
      });
    }
    return out;
  }
}
