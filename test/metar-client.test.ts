import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { METAR_TTL_MS, MetarClient, MetarError, normalizeStation, pickReport, VATSIM_METAR_API } from '../src/metar/client.js';

interface Seen {
  url: string;
  headers: Record<string, string>;
  redirect?: string;
  hasSignal: boolean;
}

function fakeFetch(reply: (url: string) => { status?: number; raw?: string } | Error) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, redirect: init?.redirect, hasSignal: init?.signal !== undefined });
    const r = reply(String(url));
    if (r instanceof Error) throw r;
    return new Response(r.raw ?? '', { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

// Shaped like what the real service answers: one METAR to a line, each starting with its airport.
const EGLL = 'EGLL 161350Z COR 26008KT 230V290 9999 NSC 08/01 Q1006 NOSIG';
const KJFK = 'KJFK 161351Z 35011KT 10SM FEW028 08/01 A3039 RMK SLP291 T00830011';

describe('airport codes for a weather report', () => {
  it('accepts exactly four letters or digits, in any case', () => {
    for (const [input, out] of [['egll', 'EGLL'], [' KJFK ', 'KJFK'], ['K1A2', 'K1A2'], ['EGLL\n', 'EGLL']] as const) assert.equal(normalizeStation(input), out, input);
  });

  it('refuses everything else, which also keeps the service from reading a short code as "every airport starting with"', () => {
    for (const bad of ['', 'JFK', 'EG', 'all', 'ALL', 'EGLLL', 'EG LL', 'EGL/', '../x', 'EGLL,KJFK', 'E-LL', 'ÉGLL', '%2e%2e', 'EG?L', 'a'.repeat(50)]) assert.equal(normalizeStation(bad), null, bad);
  });
});

describe('picking the report out of what the service sent', () => {
  it('takes the line that starts with the airport', () => {
    assert.equal(pickReport(`${EGLL}\n${KJFK}\n`, 'KJFK'), KJFK);
    assert.equal(pickReport(`${EGLL}\r\n`, 'EGLL'), EGLL);
  });

  it('is null for an empty answer, or one with no line for that airport', () => {
    assert.equal(pickReport('', 'EGLL'), null);
    assert.equal(pickReport('\n\n', 'EGLL'), null);
    assert.equal(pickReport(KJFK, 'EGLL'), null);
    assert.equal(pickReport('EGLLX 161350Z 00000KT', 'EGLL'), null, 'a different code that starts the same is not it');
  });

  it('cleans the line: one line, no control characters, single spaces', () => {
    assert.equal(pickReport('EGLL   161350Z\t26008KT \u0007 9999\u0000 Q1006', 'EGLL'), 'EGLL 161350Z 26008KT 9999 Q1006');
  });

  it('refuses a "report" that is far too long to be one', () => {
    assert.throws(() => pickReport(`EGLL ${'X'.repeat(900)}`, 'EGLL'), (e: unknown) => e instanceof MetarError && e.kind === 'bad-response');
  });
});

describe('asking VATSIM for a weather report', () => {
  let now: number;
  beforeEach(() => {
    now = 1_000_000;
  });
  const client = (f: ReturnType<typeof fakeFetch>, userAgent?: string) => new MetarClient({ fetchFn: f.fetchFn, now: () => now, userAgent });

  it('makes a plain read-only request for one airport, saying only what the app is', async () => {
    const f = fakeFetch(() => ({ raw: `${EGLL}\n` }));
    assert.equal(await client(f, 'FlightPanelBot/1.2.3').report('EGLL'), EGLL);
    assert.equal(VATSIM_METAR_API, 'https://metar.vatsim.net');
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0]!.url, 'https://metar.vatsim.net/EGLL');
    assert.deepEqual(f.seen[0]!.headers, { accept: 'text/plain', 'user-agent': 'FlightPanelBot/1.2.3' });
    assert.equal(f.seen[0]!.redirect, 'error', 'it does not follow a redirect to somewhere else');
    assert.equal(f.seen[0]!.hasSignal, true, 'it will not wait forever');
  });

  it('only ever asks for a valid four-character code', async () => {
    const f = fakeFetch(() => ({ raw: EGLL }));
    for (const bad of ['JFK', 'all', 'EG', '../x', 'EGLL,KJFK', 'egll']) await assert.rejects(client(f).report(bad), /Not an airport code/, bad);
    assert.equal(f.seen.length, 0);
  });

  it('is null when VATSIM has no report for the airport, and remembers that too', async () => {
    const f = fakeFetch(() => ({ raw: '' }));
    const c = client(f);
    assert.equal(await c.report('ZZZZ'), null);
    assert.equal(await c.report('ZZZZ'), null);
    assert.equal(f.seen.length, 1);
  });

  it('is null for a 404 as well', async () => {
    const f = fakeFetch(() => ({ status: 404 }));
    assert.equal(await client(f).report('ZZZZ'), null);
  });

  it('remembers a report for ten minutes, per airport', async () => {
    const f = fakeFetch((url) => ({ raw: url.endsWith('KJFK') ? KJFK : EGLL }));
    const c = client(f);
    await c.report('EGLL');
    await c.report('EGLL');
    assert.equal(f.seen.length, 1);
    await c.report('KJFK');
    assert.equal(f.seen.length, 2, 'another airport is another request');
    now += METAR_TTL_MS - 1_000;
    await c.report('EGLL');
    assert.equal(f.seen.length, 2);
    now += 2_000;
    await c.report('EGLL');
    assert.equal(f.seen.length, 3, 'and asked again after ten minutes');
    assert.equal(METAR_TTL_MS, 10 * 60_000);
  });

  it('asks again when the caller wants a report younger than ten minutes (a board that redraws every ten minutes does)', async () => {
    const f = fakeFetch(() => ({ raw: EGLL }));
    const c = client(f);
    await c.report('EGLL');
    now += 9 * 60_000 + 30_000;
    await c.report('EGLL');
    assert.equal(f.seen.length, 1, 'nine and a half minutes old is still fine for the usual ten');
    await c.report('EGLL', 9 * 60_000);
    assert.equal(f.seen.length, 2, 'but not for nine');
    await c.report('EGLL', 9 * 60_000);
    assert.equal(f.seen.length, 2, 'and that fresh answer is then remembered');
  });

  it('overlapping requests for one airport share one call', async () => {
    const f = fakeFetch(() => ({ raw: EGLL }));
    const c = client(f);
    const all = await Promise.all([c.report('EGLL'), c.report('EGLL'), c.report('EGLL')]);
    assert.deepEqual(all, [EGLL, EGLL, EGLL]);
    assert.equal(f.seen.length, 1);
  });

  it('says plainly when VATSIM cannot be reached, is busy or is having trouble, and does not remember a failure', async () => {
    let reply: ReturnType<Parameters<typeof fakeFetch>[0]> = new TypeError('fetch failed');
    const f = fakeFetch(() => reply);
    const c = client(f);
    await assert.rejects(c.report('EGLL'), (e: unknown) => e instanceof MetarError && e.kind === 'unavailable' && /couldn't reach VATSIM's weather service/.test(e.message));
    reply = { status: 429 };
    await assert.rejects(c.report('EGLL'), /busy/);
    reply = { status: 503 };
    await assert.rejects(c.report('EGLL'), /having trouble.*503/);
    reply = { raw: EGLL };
    assert.equal(await c.report('EGLL'), EGLL, 'recovers as soon as it is back');
  });

  it('refuses an answer that is absurdly large', async () => {
    const f = fakeFetch(() => ({ raw: `EGLL ${'X '.repeat(20_000)}` }));
    await assert.rejects(client(f).report('EGLL'), (e: unknown) => e instanceof MetarError && e.kind === 'bad-response');
  });

  it('forgets the oldest airports when many are asked about, so the memory cannot grow without end', async () => {
    const f = fakeFetch((url) => ({ raw: `${url.slice(-4)} 161350Z 00000KT` }));
    const c = client(f);
    for (let i = 0; i < 400; i++) await c.report(`E${String(i).padStart(3, '0')}`);
    const before = f.seen.length;
    await c.report('E399');
    assert.equal(f.seen.length, before, 'the newest is still remembered');
    await c.report('E000');
    assert.equal(f.seen.length, before + 1, 'the oldest was forgotten');
  });
});
