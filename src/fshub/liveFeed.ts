import { z } from 'zod';
import { readTextCapped } from '../util/http.js';
import { silentLogger, type Logger } from '../util/log.js';

/**
 * A small, read-only client for FsHub's public live-flight feed (https://movements.fshub.io), which says who is flying right now
 * and what phase of the flight they are in. It needs no account or token. It only ever sends GET requests, only to that host, and
 * the only thing in a request is a pilot's FsHub ID (a public number, the one in their FsHub profile address).
 *
 * Three calls are used: the list of pilots online (small), one pilot's current flight, and the flights of one airline (also small).
 * A pilot with no flight is a 404, which is "not flying", not an error.
 */
export const LIVE_FEED = 'https://movements.fshub.io';

const TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 1_000_000;
/** The bot asks for a handful a minute; this is only a ceiling so a bug cannot hammer FsHub. */
const REQUESTS_PER_MINUTE = 90;

/** The feed could not be asked, or answered in a way that makes no sense. `message` is safe to show. */
export class LiveFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveFeedError';
  }
}

/** A flight someone is flying now. */
export interface LiveFlight {
  flightId: string;
  /** FsHub's phase: `awaiting_departure`, `taxiing_to_runway`, `climbing`, `level_flight`, `cruise`, `descending`, `arrived`, `taxiing_to_gate`... */
  phase: string | null;
  onGround: boolean | null;
  /** The flight plan's airports (upper case), when the pilot filed one: most do not. */
  dep: string | null;
  arr: string | null;
}

/** One pilot's flight as the live feed shows it right now, with the figures a viewer of their stream would ask about. */
export interface LiveDetail {
  flightId: string;
  /** FsHub's phase (`climbing`, `cruise`, `descending`, `taxiing_to_gate`, ...). */
  phase: string | null;
  airborne: boolean;
  onGround: boolean | null;
  aircraftIcao: string | null;
  callsign: string | null;
  /** The flight plan's airports, when one was filed. */
  dep: string | null;
  arr: string | null;
  altitudeFt: number | null;
  /** True airspeed, in knots. */
  speedKts: number | null;
  headingDeg: number | null;
  /** How far there is still to go, in nautical miles, and how far through the plan the flight is (0 to 100). */
  distanceToGoNm: number | null;
  progressPct: number | null;
  etaMinutes: number | null;
  /** FsHub's word for how the flight is running against its schedule (`ON-TIME`, `DELAYED`, ...). */
  flightStatus: string | null;
}

export interface LivePilot {
  pilotId: number;
  /** In the air right now. */
  airborne: boolean;
  flight: LiveFlight | null;
}

/**
 * Phases that mean the aircraft is flying, for when the feed does not say outright. (FsHub's list, from its November 2026 announcement:
 * calculating, awaiting_departure, taxiing_to_runway, take_off, climbing, cruise, level_flight, descending, on_approach, landed,
 * taxiing_to_gate, arrived. `approach` is an older spelling of `on_approach`.)
 */
const AIRBORNE_PHASES = new Set(['take_off', 'climbing', 'level_flight', 'cruise', 'descending', 'on_approach', 'approach']);
/** Phases that mean the aircraft is on the ground, or has just come down. */
const GROUND_PHASES = new Set(['awaiting_departure', 'taxiing_to_runway', 'landed', 'taxiing_to_gate', 'arrived']);

/**
 * Whether the aircraft is flying, from FsHub's phase and the aircraft's own on-ground flag. A phase of the ground, or an aircraft on the
 * ground, is not flying; a phase of the air is. Any other phase is not told by its name: FsHub's tracker says `calculating` until it has
 * worked the phase out, which can be well into the flight (a long-haul seen at 37,000 ft and 494 knots was still `calculating` hours in), and
 * a phase it adds later is no better known. For those the aircraft decides: flying only when it says it is off the ground.
 */
export function isFlying(phase: string | null | undefined, onGround: boolean | null | undefined): boolean {
  if (onGround === true) return false;
  if (phase != null && GROUND_PHASES.has(phase)) return false;
  if (phase != null && AIRBORNE_PHASES.has(phase)) return true;
  return onGround === false;
}

/** One flight in the list of an airline's flights, as far as the bot reads it. */
export interface AirlineFlight {
  flightId: string;
  /** The FsHub pilot flying it. */
  pilotId: number | null;
  /** The callsign of the flight plan (upper case), or its flight number when it has no usable callsign, or null when the pilot filed no plan. */
  callsign: string | null;
  /**
   * The flight plan's flight number (upper case), when it has one. A pilot may fly under a callsign of their own and still file the airline's
   * number here, so both are looked at to see whether a flight is the airline's.
   */
  flightNo?: string | null;
  dep: string | null;
  arr: string | null;
  phase: string | null;
  onGround: boolean | null;
  /** FsHub's own estimate of the minutes until it lands. Only meaningful while the aircraft is flying. */
  etaMinutes: number | null;
}

/**
 * A part of a flight that is not an object counts as missing. FsHub sends `false`, not null, for a part a flight does not have: `plan`
 * when no flight plan was filed (most flights), `airline` for a pilot flying for none. Without this, those pilots failed to read at all.
 */
const objectOrMissing = (v: unknown): unknown => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined);

const airport = z.unknown().optional().transform((v) => {
  const code = (typeof v === 'string' ? v : '').trim().toUpperCase();
  return /^[A-Z0-9]{3,5}$/.test(code) ? code : null;
});

const PilotsSchema = z.object({ pilots: z.array(z.object({ id: z.number().int() }).passthrough()).default([]) }).passthrough();

const PilotSchema = z
  .object({
    pilot_id: z.number().int(),
    is_airborne: z.boolean().nullish(),
    active_flight: z.preprocess(
      objectOrMissing,
      z
        .object({
          id: z.union([z.string(), z.number()]).transform(String),
          phase: z.string().nullish(),
          position: z.preprocess(objectOrMissing, z.object({ on_ground: z.boolean().nullish() }).passthrough().optional()),
          plan: z.preprocess(objectOrMissing, z.object({ departure: airport, arrival: airport }).passthrough().optional()),
        })
        .passthrough()
        .optional(),
    ),
  })
  .passthrough();

/** A figure that is not a plain number (a string, null, nonsense) counts as missing: an odd value must never cost the whole flight. */
const finiteOrNull = z.unknown().optional().transform((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));

const DetailSchema = z
  .object({
    pilot_id: z.number().int(),
    is_airborne: z.boolean().nullish(),
    active_flight: z.preprocess(
      objectOrMissing,
      z
        .object({
          id: z.union([z.string(), z.number()]).transform(String),
          phase: z.string().nullish(),
          position: z.preprocess(
            objectOrMissing,
            z.object({ on_ground: z.boolean().nullish(), altitude_ft: finiteOrNull, speed_tas_kts: finiteOrNull, heading: finiteOrNull }).passthrough().optional(),
          ),
          aircraft: z.preprocess(objectOrMissing, z.object({ icao: z.string().nullish() }).passthrough().optional()),
          plan: z.preprocess(objectOrMissing, z.object({ callsign: z.string().nullish(), flight_no: z.string().nullish(), departure: airport, arrival: airport }).passthrough().optional()),
          eta_minutes: finiteOrNull,
          distance_nm: finiteOrNull,
          progress: finiteOrNull,
          flight_status: z.string().nullish(),
        })
        .passthrough()
        .optional(),
    ),
  })
  .passthrough();

const callsign = z.unknown().optional().transform((v) => {
  const code = (typeof v === 'string' ? v : '').trim().toUpperCase();
  return /^[A-Z0-9-]{1,12}$/.test(code) ? code : null;
});

/** A part of a flight that is not the kind of value it should be is missing, so one odd value never costs the whole flight. (`optional` so that a part that is simply not there is fine too: in zod 4 a key whose schema is `unknown` is otherwise required.) */
const stringOrNull = z.unknown().optional().transform((v) => (typeof v === 'string' ? v : null));
const booleanOrNull = z.unknown().optional().transform((v) => (typeof v === 'boolean' ? v : null));
const integerOrNull = z.unknown().optional().transform((v) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null));

const AirlineSchema = z.object({ flights: z.array(z.unknown()).default([]) }).passthrough();

const AirlineFlightSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    phase: stringOrNull,
    position: z.preprocess(objectOrMissing, z.object({ on_ground: booleanOrNull }).passthrough().optional()),
    pilot: z.preprocess(objectOrMissing, z.object({ id: integerOrNull }).passthrough().optional()),
    plan: z.preprocess(objectOrMissing, z.object({ callsign, flight_no: callsign, departure: airport, arrival: airport }).passthrough().optional()),
    eta_minutes: finiteOrNull,
  })
  .passthrough();

/** A short airline code as FsHub's feed takes it (the airline's abbreviation, such as `SKY`), or null when it is not one. */
const airlineCode = (raw: string): string | null => (/^[A-Za-z0-9]{2,6}$/.test(raw.trim()) ? raw.trim().toUpperCase() : null);

/**
 * What an airline's flights are remembered for, and shared by everything that asks (the landing estimates, `/monitor`, a person adding a monitor):
 * the feed is read once and they all use it. Short, because the estimates move by the minute; the callers ask about once a minute.
 */
const AIRLINE_CACHE_MS = 20_000;

export interface LiveFeedOptions {
  /** How long an airline's flights are shared between callers, in ms (default 20 seconds; 0 asks the feed every time). */
  airlineCacheMs?: number;
  fetchFn?: typeof fetch;
  logger?: Logger;
  userAgent?: string;
  baseUrl?: string;
  now?: () => number;
}

export class LiveFeed {
  private readonly fetchFn: typeof fetch;
  private readonly log: Logger;
  private readonly userAgent: string;
  private readonly base: string;
  private readonly now: () => number;
  private readonly sent: number[] = [];
  private readonly airlineCacheMs: number;
  /** An airline's flights as last read, and the read that is under way (callers that come while one is waiting share it). */
  private readonly airlines = new Map<string, { at: number; flights?: AirlineFlight[]; pending?: Promise<AirlineFlight[]> }>();

  constructor(opts: LiveFeedOptions = {}) {
    this.airlineCacheMs = opts.airlineCacheMs ?? AIRLINE_CACHE_MS;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.log = opts.logger ?? silentLogger;
    this.userAgent = opts.userAgent ?? 'FlightPanelBot';
    this.base = (opts.baseUrl ?? LIVE_FEED).replace(/\/+$/, '');
    this.now = opts.now ?? Date.now;
  }

  /** The FsHub IDs of the pilots online right now. */
  async onlinePilotIds(): Promise<Set<number>> {
    const body = await this.get('/pilots');
    if (body === null) throw new LiveFeedError('The live feed has no list of pilots.');
    const parsed = PilotsSchema.safeParse(body);
    if (!parsed.success) throw new LiveFeedError('The live feed sent a list of pilots in a form I do not understand.');
    return new Set(parsed.data.pilots.map((p) => p.id));
  }

  /** One pilot's flight, or null when they have no flight (not online, or not flying). */
  async pilot(pilotId: number): Promise<LivePilot | null> {
    if (!Number.isSafeInteger(pilotId) || pilotId <= 0) return null;
    const body = await this.get(`/pilot/${pilotId}`);
    if (body === null) return null;
    const parsed = PilotSchema.safeParse(body);
    if (!parsed.success) throw new LiveFeedError('The live feed sent a pilot in a form I do not understand.');
    const f = parsed.data.active_flight;
    const flight: LiveFlight | null = f
      ? { flightId: f.id, phase: f.phase ?? null, onGround: f.position?.on_ground ?? null, dep: f.plan?.departure ?? null, arr: f.plan?.arrival ?? null }
      : null;
    const airborne = parsed.data.is_airborne ?? (flight !== null && isFlying(flight.phase, flight.onGround));
    return { pilotId: parsed.data.pilot_id, airborne: airborne === true && flight !== null, flight };
  }

  /** One pilot's flight in detail, or null when they have none (not online, or not flying). */
  async pilotDetail(pilotId: number): Promise<LiveDetail | null> {
    if (!Number.isSafeInteger(pilotId) || pilotId <= 0) return null;
    const body = await this.get(`/pilot/${pilotId}`);
    if (body === null) return null;
    const parsed = DetailSchema.safeParse(body);
    if (!parsed.success) throw new LiveFeedError('The live feed sent a pilot in a form I do not understand.');
    const f = parsed.data.active_flight;
    if (!f) return null;
    const code = (v: string | null | undefined, ok: RegExp): string | null => {
      const t = (v ?? '').trim().toUpperCase();
      return ok.test(t) ? t : null;
    };
    const onGround = f.position?.on_ground ?? null;
    const phase = f.phase ?? null;
    const airborne = parsed.data.is_airborne ?? isFlying(phase, onGround);
    return {
      flightId: f.id,
      phase,
      airborne: airborne === true,
      onGround,
      aircraftIcao: code(f.aircraft?.icao, /^[A-Z0-9]{2,5}$/),
      callsign: code(f.plan?.callsign ?? f.plan?.flight_no, /^[A-Z0-9-]{1,12}$/),
      dep: f.plan?.departure ?? null,
      arr: f.plan?.arrival ?? null,
      altitudeFt: f.position?.altitude_ft ?? null,
      speedKts: f.position?.speed_tas_kts ?? null,
      headingDeg: f.position?.heading ?? null,
      distanceToGoNm: f.distance_nm,
      progressPct: f.progress === null ? null : Math.min(100, Math.max(0, f.progress)),
      etaMinutes: f.eta_minutes,
      flightStatus: f.flight_status ? f.flight_status.toUpperCase().slice(0, 16) : null,
    };
  }

  /**
   * Every flight FsHub's live feed shows for an airline, in one request. A flight that cannot be read is left out (the others still are),
   * and an airline with nothing flying (or one the feed does not know) is an empty list.
   */
  async airlineFlights(abbr: string): Promise<AirlineFlight[]> {
    const code = airlineCode(abbr);
    if (code === null) return [];
    const now = this.now();
    const have = this.airlines.get(code);
    if (have?.pending) return have.pending;
    if (have?.flights && now - have.at < this.airlineCacheMs) return have.flights;
    const pending = this.readAirline(code).then(
      (flights) => {
        this.airlines.set(code, { at: this.now(), flights });
        return flights;
      },
      (e: unknown) => {
        this.airlines.delete(code); // a failure is not remembered: the next caller asks again
        throw e;
      },
    );
    this.airlines.set(code, { at: have?.at ?? 0, ...(have?.flights ? { flights: have.flights } : {}), pending });
    return pending;
  }

  private async readAirline(code: string): Promise<AirlineFlight[]> {
    const body = await this.get(`/airline/${code}`);
    if (body === null) return [];
    const list = AirlineSchema.safeParse(body);
    if (!list.success) throw new LiveFeedError('The live feed sent an airline in a form I do not understand.');
    const out: AirlineFlight[] = [];
    for (const raw of list.data.flights) {
      const f = AirlineFlightSchema.safeParse(raw);
      if (!f.success) continue;
      const plan = f.data.plan;
      out.push({
        flightId: f.data.id,
        pilotId: f.data.pilot?.id ?? null,
        callsign: plan?.callsign ?? plan?.flight_no ?? null,
        flightNo: plan?.flight_no ?? null,
        dep: plan?.departure ?? null,
        arr: plan?.arrival ?? null,
        phase: f.data.phase ?? null,
        onGround: f.data.position?.on_ground ?? null,
        etaMinutes: f.data.eta_minutes ?? null,
      });
    }
    return out;
  }

  /** The JSON at a path, or null for a 404. Anything else that is not a good answer throws. */
  private async get(path: string): Promise<unknown | null> {
    const now = this.now();
    while (this.sent.length > 0 && now - (this.sent[0] as number) > 60_000) this.sent.shift();
    if (this.sent.length >= REQUESTS_PER_MINUTE) throw new LiveFeedError('Too many requests to the live feed in a minute; waiting.');
    this.sent.push(now);

    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        headers: { accept: 'application/json', 'user-agent': this.userAgent },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new LiveFeedError(`The live feed could not be reached (${e instanceof Error ? e.name : 'error'}).`);
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new LiveFeedError(`The live feed answered ${res.status}.`);
    }
    const text = await readTextCapped(res, MAX_BODY_CHARS);
    if (text === null) throw new LiveFeedError('The live feed sent far more than expected.');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      this.log.debug('The live feed sent something that is not JSON');
      throw new LiveFeedError('The live feed did not send JSON.');
    }
  }
}
