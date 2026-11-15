import { z } from 'zod';
import { readTextCapped } from '../util/http.js';
import { silentLogger, type Logger } from '../util/log.js';

/**
 * A small, read-only client for FsHub's public live-flight feed (https://movements.fshub.io), which says who is flying right now
 * and what phase of the flight they are in. It needs no account or token. It only ever sends GET requests, only to that host, and
 * the only thing in a request is a pilot's FsHub ID (a public number, the one in their FsHub profile address).
 *
 * Two calls are used: the list of pilots online (small), and one pilot's current flight. A pilot with no flight is a 404, which is
 * "not flying", not an error.
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

export interface LivePilot {
  pilotId: number;
  /** In the air right now. */
  airborne: boolean;
  flight: LiveFlight | null;
}

/** Phases that mean the aircraft is flying, for when the feed does not say outright. */
const AIRBORNE_PHASES = new Set(['climbing', 'level_flight', 'cruise', 'descending', 'approach']);

const airport = z
  .string()
  .nullish()
  .transform((v) => {
    const code = (v ?? '').trim().toUpperCase();
    return /^[A-Z0-9]{3,5}$/.test(code) ? code : null;
  });

const PilotsSchema = z.object({ pilots: z.array(z.object({ id: z.number().int() }).passthrough()).default([]) }).passthrough();

const PilotSchema = z
  .object({
    pilot_id: z.number().int(),
    is_airborne: z.boolean().nullish(),
    active_flight: z
      .object({
        id: z.union([z.string(), z.number()]).transform(String),
        phase: z.string().nullish(),
        position: z.object({ on_ground: z.boolean().nullish() }).passthrough().nullish(),
        plan: z.object({ departure: airport, arrival: airport }).passthrough().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export interface LiveFeedOptions {
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

  constructor(opts: LiveFeedOptions = {}) {
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
    const airborne = parsed.data.is_airborne ?? (flight !== null && flight.onGround === false && flight.phase !== null && AIRBORNE_PHASES.has(flight.phase));
    return { pilotId: parsed.data.pilot_id, airborne: airborne === true && flight !== null, flight };
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
