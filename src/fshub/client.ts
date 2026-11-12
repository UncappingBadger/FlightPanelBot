import { z } from 'zod';
import { readTextCapped } from '../util/http.js';
import { silentLogger, type Logger } from '../util/log.js';

/**
 * A small, read-only client for FsHub's REST API (v3). It exists for two things: checking that a pilot ID
 * someone typed is real (and learning the name FsHub has for it), and reading an airline's roster, which
 * lists each pilot's Discord account, so the bot can link people without asking them.
 *
 * It only ever sends GET requests, only to FsHub, with the host's own personal access token in a header.
 * The token is never logged, never put in an address and never part of an error message.
 */
export const FSHUB_API = 'https://fshub.io/api/v3';
export const FSHUB_SITE = 'https://fshub.io';

const TIMEOUT_MS = 12_000;
const MAX_BODY_CHARS = 2_000_000;
const ACCOUNT_TTL_MS = 10 * 60_000;
const PILOT_TTL_MS = 10 * 60_000;
/** A pilot or airline FsHub doesn't know is remembered only briefly, so a just-created one is found soon. */
const MISSING_TTL_MS = 60_000;
const MAX_CACHE = 500;
/** FsHub gives out 100 items a page at most. */
const PAGE_SIZE = 100;
/**
 * No airline has anywhere near this many pilots (3,000); the cap is only there so a misbehaving answer can't loop.
 * It also keeps one roster read inside the request budget below.
 */
const MAX_PAGES = 30;
/**
 * FsHub allows 100 requests in a window it doesn't state (it reports what is left in `x-ratelimit-remaining`).
 * The bot makes a handful an hour, so it holds itself to well under half of that every minute.
 */
const REQUESTS_PER_MINUTE = 40;

export interface FsHubAccount {
  id: number;
  name: string;
  premium: boolean;
}

export interface FsHubPilot {
  id: number;
  name: string;
  base: string | null;
  country: string | null;
}

export interface FsHubAirline {
  id: number;
  name: string;
  abbr: string | null;
}

/** One pilot on an airline's roster. `discordId` is only there if the pilot gave FsHub their Discord account. */
export interface RosterPilot {
  id: number;
  name: string;
  discordId: string | null;
}

/** A flight (a landing) FsHub recorded, reduced to what matching it to a scheduled flight needs. */
export interface FsHubFlight {
  id: number;
  pilotId: number;
  pilotName: string | null;
  /** Departure and arrival airports (ICAO). */
  dep: string;
  arr: string;
  departedAt: number | null;
  arrivedAt: number;
  /** The aircraft type as FsHub recorded it (`B738`) and its name (`Boeing 737-800`). Either can be missing. */
  aircraftIcao: string | null;
  aircraftName: string | null;
  /** FsHub's own word for how the flight went against its schedule: `ON-TIME`, `DELAYED` or `LATE`. */
  scheduleStatus: 'ON-TIME' | 'DELAYED' | 'LATE' | null;
}

/** One page of an airline's flights, oldest first. */
export interface FlightPage {
  /** The flights on the page that can be matched (they have both airports and a landing time). */
  flights: FsHubFlight[];
  /** How many flights the page held in all. A full page means there may be more. */
  count: number;
  /** The highest FsHub flight ID on the page, whether or not it could be used; where the next page starts. */
  lastId: number | null;
  /** When the first flight on the page landed (or took off), whether or not it could be used. Used to search for a start. */
  firstAt: number | null;
  /** The same for the last flight on the page: if it is old, everything on the page is. */
  lastAt: number | null;
}

export type FsHubErrorKind ='unavailable' | 'rejected' | 'no-access' | 'rate-limited' | 'bad-response';

/** FsHub could not be asked, or refused. `message` is safe to show to people. */
export class FsHubError extends Error {
  constructor(
    readonly kind: FsHubErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'FsHubError';
  }
}

/** What the bot needs from FsHub. Tests supply a fake. */
export interface FsHubApi {
  /** Whose token this is. */
  account(): Promise<FsHubAccount>;
  /** A pilot's public profile, or null if FsHub has no such pilot. */
  pilot(id: number): Promise<FsHubPilot | null>;
  /** An airline, or null if FsHub has no such airline. */
  airline(id: number): Promise<FsHubAirline | null>;
  /** The airlines the token's own account belongs to. */
  myAirlines(): Promise<FsHubAirline[]>;
  /** Everyone on an airline's roster. FsHub only shows this to the airline's members (and premium accounts). */
  roster(airlineId: number): Promise<RosterPilot[]>;
  /**
   * A page of an airline's flights with a FsHub flight ID greater than `cursor` (0 for the very start), oldest
   * first. An empty page means there is nothing after `cursor`. Members (and premium accounts) only.
   */
  airlineFlights(airlineId: number, cursor: number, limit: number): Promise<FlightPage>;
}

/* ------------------------------------------------------------------ the token */

/** Tidy a pasted token: no spaces or quotes, and no "X-Pilot-Token:" or "Bearer " in front. */
export function normalizeFsHubToken(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^(?:x-pilot-token\s*:|bearer)\s*/i, '')
    .trim();
}

/** Why a pasted FsHub token can't be right, or null if it looks usable (FsHub has the final say). */
export function fshubTokenProblem(token: string): string | null {
  const t = normalizeFsHubToken(token);
  if (!t) return 'Paste your FsHub personal access token (fshub.io/settings/integrations).';
  if (!/^[\x21-\x7e]{16,256}$/.test(t)) return "That doesn't look like a FsHub token. It is one long run of letters and numbers with no spaces. Copy it again from fshub.io/settings/integrations.";
  return null;
}

/* ------------------------------------------------------------------ what FsHub sends (read leniently) */

/** Text from outside: one line, no control characters, and not absurdly long. */
const text = (max: number) =>
  z.string().transform((v) => v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max));

const Id = z.number().int().positive().max(2_000_000_000);

const AccountSchema = z.object({ id: Id, name: text(60), is_premium: z.boolean().nullish() });
const PilotSchema = z.object({ id: Id, name: text(60).pipe(z.string().min(1)), base: text(40).nullish(), country: text(40).nullish() });
const AirlineSchema = z.object({ id: Id, name: text(60).pipe(z.string().min(1)), abbr: text(12).nullish() });
const RosterSchema = z.object({ id: Id, name: text(60).pipe(z.string().min(1)), discord_id: z.union([z.string(), z.number()]).nullish() });

const FlightSchema = z.object({
  id: Id,
  user: z.object({ id: Id, name: text(60).nullish() }),
  aircraft: z.object({ icao: text(8).nullish(), icao_name: text(60).nullish() }).nullish(),
  departure: z.object({ icao: text(8).nullish(), time: z.string().nullish() }).nullish(),
  arrival: z.object({ icao: text(8).nullish(), time: z.string().nullish() }).nullish(),
  schedule_status: text(16).nullish(),
});

const dataOf = (body: unknown): unknown => (body as { data?: unknown } | null)?.data;

/** An airport code as FsHub writes it: three or four letters or digits. Null for anything else. */
const airportCode = (v: string | null | undefined): string | null => {
  const code = (v ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{3,4}$/.test(code) ? code : null;
};

const instant = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * A page of an airline's flights. A flight that is missing an airport or its landing time can't be matched to
 * anything and is left out, but it still counts towards the page (a full page means there is more) and towards
 * where the next page starts.
 */
export function parseFlightPage(items: unknown[]): FlightPage {
  const flights: FsHubFlight[] = [];
  let lastId: number | null = null;
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  items.forEach((item, i) => {
    const raw = item as { id?: unknown; arrival?: { time?: unknown } | null; departure?: { time?: unknown } | null } | null;
    const id = Number(raw?.id);
    if (Number.isSafeInteger(id) && id > 0 && (lastId === null || id > lastId)) lastId = id;
    // Where the page sits in time is judged from the raw entry, so an entry that can't be matched still counts.
    const when = instant(typeof raw?.arrival?.time === 'string' ? raw.arrival.time : null) ?? instant(typeof raw?.departure?.time === 'string' ? raw.departure.time : null);
    if (i === 0) firstAt = when;
    if (i === items.length - 1) lastAt = when;
    const r = FlightSchema.safeParse(item);
    if (!r.success) return;
    const f = r.data;
    const arrivedAt = instant(f.arrival?.time);
    const departedAt = instant(f.departure?.time);
    const dep = airportCode(f.departure?.icao);
    const arr = airportCode(f.arrival?.icao);
    if (!dep || !arr || arrivedAt === null) return;
    const status = (f.schedule_status ?? '').toUpperCase();
    flights.push({
      id: f.id,
      pilotId: f.user.id,
      pilotName: f.user.name || null,
      dep,
      arr,
      departedAt,
      arrivedAt,
      aircraftIcao: f.aircraft?.icao ? f.aircraft.icao.toUpperCase() : null,
      aircraftName: f.aircraft?.icao_name || null,
      scheduleStatus: status === 'ON-TIME' || status === 'DELAYED' || status === 'LATE' ? status : null,
    });
  });
  return { flights, count: items.length, lastId, firstAt, lastAt };
}

/** A Discord account ID is a "snowflake": 17 to 20 digits. Anything else FsHub holds in that field is not one. */
const snowflake = (v: string | number | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const id = String(v);
  return /^\d{17,20}$/.test(id) ? id : null;
};

export function parseAccount(body: unknown): FsHubAccount {
  const r = AccountSchema.safeParse(dataOf(body));
  if (!r.success) throw new FsHubError('bad-response', 'FsHub sent an answer I could not read.');
  return { id: r.data.id, name: r.data.name, premium: r.data.is_premium === true };
}

export function parsePilot(body: unknown): FsHubPilot {
  const r = PilotSchema.safeParse(dataOf(body));
  if (!r.success) throw new FsHubError('bad-response', 'FsHub sent a pilot profile I could not read.');
  return { id: r.data.id, name: r.data.name, base: r.data.base || null, country: r.data.country || null };
}

export function parseAirline(item: unknown): FsHubAirline | null {
  const r = AirlineSchema.safeParse(item);
  return r.success ? { id: r.data.id, name: r.data.name, abbr: r.data.abbr || null } : null;
}

/** A page of the roster. One odd entry is skipped rather than hiding everyone else. */
export function parseRosterPage(items: unknown[]): RosterPilot[] {
  const out: RosterPilot[] = [];
  for (const item of items) {
    const r = RosterSchema.safeParse(item);
    if (r.success) out.push({ id: r.data.id, name: r.data.name, discordId: snowflake(r.data.discord_id) });
  }
  return out;
}

/**
 * FsHub writes Discord IDs as bare numbers, which are bigger than JavaScript can hold exactly (the last
 * digits would change). Quote them in the raw text before it is parsed so they arrive as the strings they are.
 */
export function quoteDiscordIds(raw: string): string {
  return raw.replace(/("discord_id"\s*:\s*)(\d{15,})/g, '$1"$2"');
}

const messageOf = (json: unknown): string => {
  const j = json as { message?: unknown; error?: { message?: unknown } } | null;
  const m = typeof j?.message === 'string' ? j.message : typeof j?.error?.message === 'string' ? j.error.message : '';
  return m.slice(0, 200);
};

const safeId = (id: number): number => {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Not a FsHub ID: ${id}`);
  return id;
};

/* ------------------------------------------------------------------ the client */

export interface FsHubOptions {
  token: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  logger?: Logger;
  baseUrl?: string;
  /** Sent as the User-Agent. Carries nothing about the user. */
  userAgent?: string;
}

export class FsHubClient implements FsHubApi {
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly base: string;
  private readonly userAgent: string;
  private readonly stamps: number[] = [];
  private account_: { at: number; value: FsHubAccount } | null = null;
  private readonly pilots = new Map<number, { at: number; value: FsHubPilot | null }>();
  private readonly airlines = new Map<number, { at: number; value: FsHubAirline | null }>();

  constructor(opts: FsHubOptions) {
    this.token = normalizeFsHubToken(opts.token);
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.logger ?? silentLogger;
    this.base = (opts.baseUrl ?? FSHUB_API).replace(/\/+$/, '');
    this.userAgent = opts.userAgent ?? 'FlightPanelBot';
  }

  async account(): Promise<FsHubAccount> {
    const cached = this.account_;
    if (cached && this.now() - cached.at < ACCOUNT_TTL_MS) return cached.value;
    const res = await this.get('/user');
    const value = parseAccount(res.json);
    this.account_ = { at: this.now(), value };
    return value;
  }

  async pilot(id: number): Promise<FsHubPilot | null> {
    safeId(id);
    const cached = this.pilots.get(id);
    if (cached && this.now() - cached.at < (cached.value ? PILOT_TTL_MS : MISSING_TTL_MS)) return cached.value;
    const res = await this.get(`/pilot/${id}`);
    const value = res.status === 404 ? null : parsePilot(res.json);
    this.remember(this.pilots, id, value);
    return value;
  }

  async airline(id: number): Promise<FsHubAirline | null> {
    safeId(id);
    const cached = this.airlines.get(id);
    if (cached && this.now() - cached.at < (cached.value ? PILOT_TTL_MS : MISSING_TTL_MS)) return cached.value;
    const res = await this.get(`/airline/${id}`);
    const value = res.status === 404 ? null : parseAirline(dataOf(res.json));
    if (res.status !== 404 && value === null) throw new FsHubError('bad-response', 'FsHub sent an airline I could not read.');
    this.remember(this.airlines, id, value);
    return value;
  }

  async myAirlines(): Promise<FsHubAirline[]> {
    const me = await this.account();
    const res = await this.get(`/pilot/${me.id}/airline`);
    if (res.status === 204 || res.status === 404) return [];
    const data = dataOf(res.json);
    if (!Array.isArray(data)) throw new FsHubError('bad-response', 'FsHub sent a list of airlines I could not read.');
    return data.map(parseAirline).filter((a): a is FsHubAirline => a !== null);
  }

  async roster(airlineId: number): Promise<RosterPilot[]> {
    safeId(airlineId);
    const byId = new Map<number, RosterPilot>();
    let cursor = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.get(`/airline/${airlineId}/pilot?limit=${PAGE_SIZE}${cursor > 0 ? `&cursor=${cursor}` : ''}`);
      // FsHub answers "No records found" (404) past the last page, and 204 for an airline with nobody.
      if (res.status === 404 || res.status === 204) break;
      const data = dataOf(res.json);
      if (!Array.isArray(data)) throw new FsHubError('bad-response', 'FsHub sent a roster I could not read.');
      for (const p of parseRosterPage(data)) byId.set(p.id, p);
      if (data.length < PAGE_SIZE) break;
      const next = Number((res.json as { meta?: { cursor?: { next?: unknown } } } | null)?.meta?.cursor?.next);
      if (!Number.isSafeInteger(next) || next <= cursor) break; // not moving on: stop rather than loop
      cursor = next;
    }
    return [...byId.values()];
  }

  /** Text for a log line, with the token taken out in case something quoted it. */
  private redact(text: string): string {
    return this.token ? text.split(this.token).join('[token]') : text;
  }

  async airlineFlights(airlineId: number, cursor: number, limit: number): Promise<FlightPage> {
    safeId(airlineId);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error(`Not a FsHub cursor: ${cursor}`);
    const size = Math.min(Math.max(Math.trunc(limit) || 1, 1), PAGE_SIZE);
    const res = await this.get(`/airline/${airlineId}/flight?limit=${size}${cursor > 0 ? `&cursor=${cursor}` : ''}`);
    // FsHub says "No records found" (404) when there is nothing after the cursor, and 204 for an airline with no flights.
    if (res.status === 404 || res.status === 204) return { flights: [], count: 0, lastId: null, firstAt: null, lastAt: null };
    const data = dataOf(res.json);
    if (!Array.isArray(data)) throw new FsHubError('bad-response', 'FsHub sent a list of flights I could not read.');
    return parseFlightPage(data);
  }

  private remember<T>(cache: Map<number, { at: number; value: T }>, id: number, value: T): void {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as number);
    cache.set(id, { at: this.now(), value });
  }

  /** One GET. 404 and 204 come back as plain statuses; everything else that isn't a success throws a FsHubError. */
  private async get(path: string): Promise<{ status: number; json: unknown }> {
    const t = this.now();
    while (this.stamps.length > 0 && t - (this.stamps[0] as number) >= 60_000) this.stamps.shift();
    if (this.stamps.length >= REQUESTS_PER_MINUTE) throw new FsHubError('rate-limited', 'FsHub is busy right now. Try again in a minute.');
    this.stamps.push(t);

    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': this.userAgent, 'x-pilot-token': this.token },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (e) {
      this.log.debug(`FsHub ${path} failed: ${this.redact(e instanceof Error ? e.message : String(e))}`);
      throw new FsHubError('unavailable', "I couldn't reach FsHub right now.");
    }
    if (res.status === 204) return { status: 204, json: null };

    const raw = await readTextCapped(res, MAX_BODY_CHARS).catch(() => '');
    if (raw === null) throw new FsHubError('bad-response', 'FsHub sent far more than I expected.');
    let json: unknown = null;
    try {
      json = raw ? JSON.parse(quoteDiscordIds(raw)) : null;
    } catch {
      /* judged below, by the status */
    }
    if (res.status === 404) return { status: 404, json };

    if (res.status === 401 || res.status === 403) {
      const why = messageOf(json);
      this.log.debug(`FsHub ${path} answered HTTP ${res.status}: ${this.redact(why)}`);
      // FsHub says "Only airline members or premium accounts can access this endpoint." for a valid token without access.
      if (res.status === 403 || /member|premium|permission/i.test(why)) {
        throw new FsHubError('no-access', "FsHub only shows an airline's roster to its members (or premium accounts), and the saved token's account isn't one for this airline.");
      }
      throw new FsHubError('rejected', "FsHub didn't accept the access token. Make a new one at fshub.io/settings/integrations and save it on the setup page.");
    }
    if (res.status === 429) throw new FsHubError('rate-limited', 'FsHub is busy right now. Try again in a minute.');
    if (!res.ok) {
      this.log.debug(`FsHub ${path} answered HTTP ${res.status}`);
      throw new FsHubError('unavailable', `FsHub is having trouble right now (HTTP ${res.status}).`);
    }
    if (json === null) throw new FsHubError('bad-response', 'FsHub sent an answer I could not read.');
    return { status: res.status, json };
  }
}
