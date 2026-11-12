import { z } from 'zod';
import { readTextCapped } from '../util/http.js';
import { silentLogger, type Logger } from '../util/log.js';

/**
 * AeroDAQ is Aeroconomy's in-game market: a pretend stock market for aviation companies, and fuel prices
 * at airports. None of it is real money or real shares. This reads its public API (no account or key is
 * needed) and nothing else: it never sends anything about a pilot, a server or an airline.
 */
export const AERODAQ_API = 'https://aerodaq.com/api/v1';
export const AERODAQ_SITE = 'https://aerodaq.com';

const MARKET_TTL_MS = 60_000;
const FUEL_TTL_MS = 5 * 60_000;
const MAX_FUEL_CACHE = 300;
const TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 2_000_000;

export interface Stock {
  symbol: string;
  name: string;
  sectorSlug: string;
  sectorName: string;
  price: number;
  /** Already a percentage: 0.5 means up half a percent. */
  changePercent: number;
  /** When AeroDAQ last moved this price, or null if it did not say. */
  updatedAt: number | null;
}

export interface FuelPrice {
  /** AeroDAQ's one-letter code, e.g. `J` for jet fuel and `A` for avgas. */
  type: string;
  name: string;
  currency: string;
  perKg: number;
  perLb: number | null;
  perGallon: number | null;
  perLitre: number | null;
  /** The price the airport drifts back towards. */
  baseline: number | null;
  /** How full the airport's tanks are against its target, in percent. */
  stockPercent: number | null;
  updatedAt: number | null;
}

export interface AirportFuel {
  icao: string;
  name: string;
  city: string | null;
  country: string | null;
  prices: FuelPrice[];
}

/** AeroDAQ could not be asked, or answered in a way that makes no sense. `message` is safe to show. */
export class AeroDaqError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'bad-response',
    message: string,
  ) {
    super(message);
    this.name = 'AeroDaqError';
  }
}

/* ------------------------------------------------------------------ what AeroDAQ sends (read leniently) */

/** Text from outside: one line, no control characters, and not absurdly long. */
const text = (max: number) =>
  z
    .string()
    .transform((v) => v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max));

const optionalNumber = z.number().finite().nullish();
const optionalText = (max: number) => text(max).nullish();

const StockSchema = z.object({
  symbol: text(10).pipe(z.string().min(1)),
  name: text(60),
  sector: z.object({ slug: text(40), name: text(60) }).nullish(),
  price: z.number().finite(),
  change_percent: optionalNumber,
  updated_at: z.string().nullish(),
});

const PerUnit = z.object({ price: optionalNumber }).nullish();
const FuelPriceSchema = z.object({
  fuel_type: text(4),
  name: text(40),
  currency: text(6),
  current_price: z.number().finite(),
  price_per: z.object({ kg: PerUnit, lb: PerUnit, gallon: PerUnit, litre: PerUnit }).nullish(),
  baseline_price: optionalNumber,
  inventory_percent: optionalNumber,
  updated_at: z.string().nullish(),
});

const AirportFuelSchema = z.object({
  icao: text(8),
  name: text(60),
  city: optionalText(60),
  country: optionalText(4),
  prices: z.array(z.unknown()),
});

const when = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

export function parseMarket(body: unknown): Stock[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new AeroDaqError('bad-response', 'AeroDAQ sent a market list I could not read.');
  const stocks: Stock[] = [];
  for (const item of data) {
    const r = StockSchema.safeParse(item);
    if (!r.success) continue; // one odd entry should not hide the rest
    const s = r.data;
    stocks.push({
      symbol: s.symbol,
      name: s.name,
      sectorSlug: s.sector?.slug || 'other',
      sectorName: s.sector?.name || 'Other',
      price: s.price,
      changePercent: s.change_percent ?? 0,
      updatedAt: when(s.updated_at),
    });
  }
  if (data.length > 0 && stocks.length === 0) throw new AeroDaqError('bad-response', 'AeroDAQ sent a market list I could not read.');
  return stocks;
}

export function parseFuel(body: unknown): AirportFuel {
  const data = (body as { data?: unknown } | null)?.data;
  const a = AirportFuelSchema.safeParse(data);
  if (!a.success) throw new AeroDaqError('bad-response', 'AeroDAQ sent fuel prices I could not read.');
  const prices: FuelPrice[] = [];
  for (const item of a.data.prices) {
    const r = FuelPriceSchema.safeParse(item);
    if (!r.success) continue;
    const p = r.data;
    prices.push({
      type: p.fuel_type,
      name: p.name || p.fuel_type,
      currency: p.currency || 'USD',
      perKg: p.price_per?.kg?.price ?? p.current_price,
      perLb: p.price_per?.lb?.price ?? null,
      perGallon: p.price_per?.gallon?.price ?? null,
      perLitre: p.price_per?.litre?.price ?? null,
      baseline: p.baseline_price ?? null,
      stockPercent: p.inventory_percent ?? null,
      updatedAt: when(p.updated_at),
    });
  }
  return { icao: a.data.icao, name: a.data.name, city: a.data.city ?? null, country: a.data.country ?? null, prices };
}

/** A letters-and-digits airport code of three or four characters, upper-cased; null for anything else. */
export function normalizeIcao(input: string): string | null {
  const code = input.trim().toUpperCase();
  return /^[A-Z0-9]{3,4}$/.test(code) ? code : null;
}

/* ------------------------------------------------------------------ the client */

export interface AeroDaqOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  logger?: Logger;
  baseUrl?: string;
  /** Sent as the User-Agent so AeroDAQ can tell this app from a browser. Carries nothing about the user. */
  userAgent?: string;
}

/** Asks AeroDAQ, remembering answers briefly so a busy server cannot flood it. */
export class AeroDaqClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly base: string;
  private readonly userAgent: string;
  private market_: { at: number; stocks: Stock[] } | null = null;
  private marketInFlight: Promise<Stock[]> | null = null;
  private readonly fuel_ = new Map<string, { at: number; value: AirportFuel | null }>();
  private readonly fuelInFlight = new Map<string, Promise<AirportFuel | null>>();

  constructor(opts: AeroDaqOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.logger ?? silentLogger;
    this.base = (opts.baseUrl ?? AERODAQ_API).replace(/\/+$/, '');
    this.userAgent = opts.userAgent ?? 'FlightPanelBot';
  }

  /** Every company on the market. Answers up to a minute old are reused. */
  market(): Promise<Stock[]> {
    const cached = this.market_;
    if (cached && this.now() - cached.at < MARKET_TTL_MS) return Promise.resolve(cached.stocks);
    if (this.marketInFlight) return this.marketInFlight;
    this.marketInFlight = this.get('/market')
      .then((body) => {
        const stocks = parseMarket(body.json);
        this.market_ = { at: this.now(), stocks };
        return stocks;
      })
      .finally(() => {
        this.marketInFlight = null;
      });
    return this.marketInFlight;
  }

  /**
   * Fuel prices at an airport, or null if AeroDAQ doesn't know it. `icao` must already be a valid code
   * (see `normalizeIcao`), so nothing a person types is ever put into the address unchecked.
   */
  fuel(icao: string): Promise<AirportFuel | null> {
    if (normalizeIcao(icao) !== icao) return Promise.reject(new Error(`Not an airport code: ${icao}`));
    const cached = this.fuel_.get(icao);
    if (cached && this.now() - cached.at < FUEL_TTL_MS) return Promise.resolve(cached.value);
    const running = this.fuelInFlight.get(icao);
    if (running) return running;
    const p = this.get(`/airports/${icao}/fuel`)
      .then((body) => {
        const value = body.status === 404 ? null : parseFuel(body.json);
        if (this.fuel_.size >= MAX_FUEL_CACHE) this.fuel_.delete(this.fuel_.keys().next().value as string);
        this.fuel_.set(icao, { at: this.now(), value });
        return value;
      })
      .finally(() => {
        this.fuelInFlight.delete(icao);
      });
    this.fuelInFlight.set(icao, p);
    return p;
  }

  private async get(path: string): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        headers: { accept: 'application/json', 'user-agent': this.userAgent },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (e) {
      this.log.debug(`AeroDAQ ${path} failed: ${e instanceof Error ? e.message : e}`);
      throw new AeroDaqError('unavailable', "I couldn't reach AeroDAQ right now.");
    }
    if (res.status === 404) return { status: 404, json: null };
    if (!res.ok) {
      this.log.debug(`AeroDAQ ${path} answered HTTP ${res.status}`);
      throw new AeroDaqError('unavailable', res.status === 429 ? 'AeroDAQ is busy right now. Try again in a minute.' : `AeroDAQ is having trouble right now (HTTP ${res.status}).`);
    }
    const body = await readTextCapped(res, MAX_BODY_CHARS).catch(() => '');
    if (body === null) throw new AeroDaqError('bad-response', 'AeroDAQ sent far more than I expected.');
    try {
      return { status: res.status, json: JSON.parse(body) };
    } catch {
      throw new AeroDaqError('bad-response', 'AeroDAQ sent an answer I could not read.');
    }
  }
}
