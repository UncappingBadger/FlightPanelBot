import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AERODAQ_API, AeroDaqClient, AeroDaqError, normalizeIcao, parseFuel, parseMarket, type AirportFuel, type Stock } from '../src/aerodaq/client.js';
import { MARKET_REFRESH_MS } from '../src/discord/market.js';
import { AERODAQ_FOOTER, changeText, renderFuel, renderMarket, sortFuel } from '../src/discord/aerodaqUi.js';
import { commands } from '../src/discord/commands/index.js';
import { FUEL_COOLDOWN_MS } from '../src/discord/commands/fuel.js';
import { Scheduler } from '../src/services/scheduler.js';
import { UserError } from '../src/discord/errors.js';
import { silentLogger } from '../src/util/log.js';
import { CHANNEL, GUILD, HOUR, makeHarness, sj, T0, type Harness } from './helpers.js';
import { fakeInteraction, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

/** Real responses from aerodaq.com, captured 2026-11-12. */
const MARKET_JSON = JSON.parse(readFileSync(new URL('./fixtures/aerodaq-market.json', import.meta.url), 'utf8'));
const EGLL_JSON = JSON.parse(readFileSync(new URL('./fixtures/aerodaq-fuel-egll.json', import.meta.url), 'utf8'));

const stock = (symbol: string, o: Partial<Stock> = {}): Stock => ({
  symbol,
  name: `${symbol} Holdings`,
  sectorSlug: 'aircraft',
  sectorName: 'Aircraft Manufacturers',
  price: 100,
  changePercent: 0,
  updatedAt: T0,
  ...o,
});
const MARKET: Stock[] = parseMarket(MARKET_JSON);
const EGLL: AirportFuel = parseFuel(EGLL_JSON);

/** What the rendered embeds add up to, counted the way Discord counts them. */
const chars = (embeds: ReturnType<typeof renderMarket>) =>
  embeds.reduce((n, e) => {
    const j = e.toJSON();
    return n + (j.title?.length ?? 0) + (j.description?.length ?? 0) + (j.footer?.text.length ?? 0) + (j.fields ?? []).reduce((m, f) => m + f.name.length + f.value.length, 0);
  }, 0);

/* ------------------------------------------------------------------ the client */

interface Seen {
  url: string;
  headers: Record<string, string>;
  redirect?: string;
  hasSignal: boolean;
}
function fakeFetch(reply: (url: string) => { status?: number; body?: unknown; raw?: string } | Error) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, redirect: init?.redirect, hasSignal: init?.signal !== undefined });
    const r = reply(String(url));
    if (r instanceof Error) throw r;
    return new Response(r.raw ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

describe('reading the real AeroDAQ responses', () => {
  it('reads the market: every company, with the price and change as the site shows them', () => {
    assert.equal(MARKET.length, 100);
    assert.equal(new Set(MARKET.map((s) => s.sectorSlug)).size, 7);
    const accn = MARKET.find((s) => s.symbol === 'ACCN')!;
    assert.deepEqual(
      [accn.name, accn.sectorName, accn.price, accn.changePercent, typeof accn.updatedAt],
      ['AirCrew Connect', 'Community Technology', 101.2962, -0.024794, 'number'],
    );
    // AeroDAQ's own page shows this as "$101.30 ↓0.02%": the change is already a percentage.
    assert.equal(changeText(accn.changePercent), '0.00%'.replace('0.00', '-0.02'));
  });

  it('reads the fuel prices at Heathrow, in every unit', () => {
    assert.deepEqual([EGLL.icao, EGLL.name, EGLL.city, EGLL.country, EGLL.prices.length], ['EGLL', 'Heathrow', 'London', 'GB', 2]);
    const jet = EGLL.prices.find((p) => p.type === 'J')!;
    assert.deepEqual(
      [jet.name, jet.currency, jet.perKg, jet.perLb, jet.perGallon, jet.perLitre, jet.baseline, jet.stockPercent],
      ['Jet A / Jet A-1', 'USD', 2.1386, 0.9701, 6.6352, 1.7528, 2.2597, 108.84],
    );
  });

  it('skips one odd company rather than losing the whole market', () => {
    const body = { data: [{ symbol: 'GOOD', name: 'Good Co', price: 10, change_percent: 1 }, { symbol: '', price: 'x' }, { nonsense: true }, null] };
    assert.deepEqual(parseMarket(body).map((s) => s.symbol), ['GOOD']);
  });

  it('refuses a market that is not a list, or where nothing in it can be read', () => {
    for (const bad of [null, {}, { data: 'x' }, { data: [{ nonsense: 1 }] }]) {
      assert.throws(() => parseMarket(bad), (e: unknown) => e instanceof AeroDaqError && e.kind === 'bad-response', JSON.stringify(bad));
    }
    assert.deepEqual(parseMarket({ data: [] }), [], 'an empty market is a real answer');
  });

  it('cleans text it did not write: no control characters or line breaks, and a length limit', () => {
    const body = { data: [{ symbol: 'ABC', name: 'Bad\nName\u0007 ' + 'x'.repeat(200), sector: { slug: 'x', name: 'Sec\ntor' }, price: 5 }] };
    const s = parseMarket(body)[0]!;
    assert.doesNotMatch(s.name + s.sectorName, /[\u0000-\u001f]/);
    assert.ok(s.name.length <= 60);
  });

  it('treats a company with no sector or change as unclassified and unchanged', () => {
    const s = parseMarket({ data: [{ symbol: 'NOSEC', name: 'No Sector', price: 7 }] })[0]!;
    assert.deepEqual([s.sectorSlug, s.sectorName, s.changePercent, s.updatedAt], ['other', 'Other', 0, null]);
  });

  it('refuses fuel data it cannot read, and skips a price line it cannot read', () => {
    assert.throws(() => parseFuel({}), (e: unknown) => e instanceof AeroDaqError && e.kind === 'bad-response');
    assert.throws(() => parseFuel({ data: { icao: 'EGLL' } }), AeroDaqError);
    const f = parseFuel({ data: { icao: 'EGLL', name: 'Heathrow', prices: [{ junk: 1 }, { fuel_type: 'J', name: 'Jet A', currency: 'USD', current_price: 2 }] } });
    assert.equal(f.prices.length, 1);
    assert.deepEqual([f.prices[0]!.perKg, f.prices[0]!.perLb, f.prices[0]!.baseline], [2, null, null]);
  });
});

describe('airport codes', () => {
  it('accepts three or four letters or digits in any case', () => {
    for (const [input, out] of [['egll', 'EGLL'], [' KJFK ', 'KJFK'], ['lhr', 'LHR'], ['0I3', '0I3'], ['K1A2', 'K1A2'], ['EGLL\n', 'EGLL']] as const) assert.equal(normalizeIcao(input), out, input);
  });

  it('refuses everything else, so nothing odd can reach the address', () => {
    for (const bad of ['', 'EG', 'EGLLL', 'EG LL', 'EGL/', '../x', 'EGLL/../x', 'E-LL', 'ÉGLL', '%2e%2e', 'EG?L', 'a'.repeat(50)]) assert.equal(normalizeIcao(bad), null, bad);
  });
});

describe('asking AeroDAQ', () => {
  let now: number;
  beforeEach(() => {
    now = 1_000_000;
  });
  const client = (f: ReturnType<typeof fakeFetch>, userAgent?: string) => new AeroDaqClient({ fetchFn: f.fetchFn, now: () => now, userAgent });

  it('makes a plain read-only request to the public API, saying only what the app is', async () => {
    const f = fakeFetch(() => ({ body: MARKET_JSON }));
    await client(f, 'FlightPanelBot/1.2.3').market();
    assert.equal(f.seen[0]!.url, `${AERODAQ_API}/market`);
    assert.equal(AERODAQ_API, 'https://aerodaq.com/api/v1');
    assert.deepEqual(f.seen[0]!.headers, { accept: 'application/json', 'user-agent': 'FlightPanelBot/1.2.3' });
    assert.equal(f.seen[0]!.redirect, 'error', 'it does not follow a redirect to somewhere else');
    assert.equal(f.seen[0]!.hasSignal, true, 'it will not wait forever');
  });

  it('remembers the market for a minute, so a busy server cannot flood AeroDAQ', async () => {
    const f = fakeFetch(() => ({ body: MARKET_JSON }));
    const c = client(f);
    await c.market();
    now += 59_000;
    await c.market();
    assert.equal(f.seen.length, 1);
    now += 2_000;
    await c.market();
    assert.equal(f.seen.length, 2);
  });

  it('overlapping requests share one call', async () => {
    const f = fakeFetch(() => ({ body: MARKET_JSON }));
    const c = client(f);
    const [a, b, d] = await Promise.all([c.market(), c.market(), c.market()]);
    assert.equal(f.seen.length, 1);
    assert.equal(a.length + b.length + d.length, 300);
  });

  it('says plainly when AeroDAQ cannot be reached, is busy or is having trouble, and does not remember a failure', async () => {
    let reply: ReturnType<Parameters<typeof fakeFetch>[0]> = new TypeError('fetch failed');
    const f = fakeFetch(() => reply);
    const c = client(f);
    await assert.rejects(c.market(), (e: unknown) => e instanceof AeroDaqError && e.kind === 'unavailable' && /couldn't reach AeroDAQ/.test(e.message));
    reply = { status: 429 };
    await assert.rejects(c.market(), /busy/);
    reply = { status: 503 };
    await assert.rejects(c.market(), /having trouble.*503/);
    reply = { body: MARKET_JSON };
    assert.equal((await c.market()).length, 100, 'recovers as soon as it is back');
  });

  it('refuses an answer that is not JSON, or is absurdly large', async () => {
    for (const raw of ['<html>maintenance</html>', 'x'.repeat(2_100_000)]) {
      const f = fakeFetch(() => ({ raw }));
      await assert.rejects(client(f).market(), (e: unknown) => e instanceof AeroDaqError && e.kind === 'bad-response');
    }
  });

  it('asks for one airport at its own address, and gives back the prices', async () => {
    const f = fakeFetch(() => ({ body: EGLL_JSON }));
    const fuel = await client(f).fuel('EGLL');
    assert.equal(f.seen[0]!.url, `${AERODAQ_API}/airports/EGLL/fuel`);
    assert.equal(fuel!.name, 'Heathrow');
  });

  it('answers "not listed" (null) for an airport AeroDAQ does not know, and remembers that too', async () => {
    const f = fakeFetch(() => ({ status: 404, body: { message: 'No query results for model [App\\Models\\Airport].' } }));
    const c = client(f);
    assert.equal(await c.fuel('ZZZZ'), null);
    assert.equal(await c.fuel('ZZZZ'), null);
    assert.equal(f.seen.length, 1);
  });

  it('keeps fuel prices for five minutes, per airport', async () => {
    const f = fakeFetch(() => ({ body: EGLL_JSON }));
    const c = client(f);
    await c.fuel('EGLL');
    await c.fuel('EGLL');
    assert.equal(f.seen.length, 1);
    await c.fuel('KJFK');
    assert.equal(f.seen.length, 2);
    now += 301_000;
    await c.fuel('EGLL');
    assert.equal(f.seen.length, 3);
  });

  it('never asks about something that is not an airport code', async () => {
    const f = fakeFetch(() => ({ body: EGLL_JSON }));
    const c = client(f);
    for (const bad of ['egll', 'EGLL/../x', '', 'EG LL', 'EGLLL']) await assert.rejects(c.fuel(bad), /Not an airport code/, bad);
    assert.equal(f.seen.length, 0);
  });

  it('keeps its memory of airports bounded', async () => {
    const f = fakeFetch(() => ({ body: EGLL_JSON }));
    const c = client(f);
    const code = (i: number) => `A${String(i).padStart(3, '0')}`;
    for (let i = 0; i < 305; i++) await c.fuel(code(i));
    assert.equal(f.seen.length, 305);
    await c.fuel(code(304));
    assert.equal(f.seen.length, 305, 'recent ones are still remembered');
    await c.fuel(code(0));
    assert.equal(f.seen.length, 306, 'the oldest was let go');
  });
});

/* ------------------------------------------------------------------ how it looks */

describe('the fuel answer', () => {
  it('shows Heathrow the way a pilot wants it: jet fuel first, every unit, and how it compares with usual', () => {
    const j = renderFuel(EGLL).toJSON();
    assert.equal(j.title, '⛽ Fuel at EGLL · Heathrow');
    assert.equal(j.description, 'London, GB');
    assert.deepEqual(j.fields!.map((f) => f.name), ['Jet A / Jet A-1', 'Avgas 100LL']);
    const jet = j.fields![0]!.value;
    assert.match(jet, /\*\*\$2\.14\*\* per kg · \$0\.97\/lb · \$6\.64\/US gal · \$1\.75\/L/);
    assert.match(jet, /▼ 5\.4% below its usual \$2\.26/);
    assert.match(jet, /stock 108\.8% of target · updated <t:\d+:R>/);
    assert.equal(j.footer!.text, AERODAQ_FOOTER);
    assert.match(AERODAQ_FOOTER, /in-game only, not real money/);
  });

  it('says "above" when the price is above its usual, and "at" when it is on it', () => {
    const p = (perKg: number, baseline: number) => ({ ...EGLL, prices: [{ ...EGLL.prices[0]!, perKg, baseline }] });
    assert.match(renderFuel(p(3, 2)).toJSON().fields![0]!.value, /▲ 50\.0% above its usual \$2\.00/);
    assert.match(renderFuel(p(2, 2)).toJSON().fields![0]!.value, /at its usual \$2\.00/);
  });

  it('leaves out what AeroDAQ did not say', () => {
    const bare: AirportFuel = { icao: 'EGXX', name: '', city: null, country: null, prices: [{ type: 'J', name: 'Jet', currency: 'USD', perKg: 2, perLb: null, perGallon: null, perLitre: null, baseline: null, stockPercent: null, updatedAt: null }] };
    const j = renderFuel(bare).toJSON();
    assert.equal(j.title, '⛽ Fuel at EGXX');
    assert.equal(j.description, undefined);
    assert.equal(j.fields![0]!.value, '**$2.00** per kg');
  });

  it('says so when an airport has no fuel prices', () => {
    assert.match(renderFuel({ ...EGLL, prices: [] }).toJSON().description!, /London, GB\n\nAeroDAQ has no fuel prices for this airport\./);
  });

  it('shows another currency by its code, and cannot be made to inject markup through names', () => {
    const odd: AirportFuel = { ...EGLL, city: '**bold** @everyone [x](http://evil.example)', prices: [{ ...EGLL.prices[0]!, currency: 'XYZ', name: '_Jet_ @here' }] };
    const j = renderFuel(odd).toJSON();
    assert.match(j.fields![0]!.value, /2\.46 XYZ/);
    assert.doesNotMatch(j.description!, /\*\*bold\*\*|@everyone|\]\(http/);
    assert.doesNotMatch(j.fields![0]!.name, /@here|^_Jet_/);
  });

  it('sorts jet fuel, then avgas, then the rest by name', () => {
    const mk = (type: string, name: string) => ({ ...EGLL.prices[0]!, type, name });
    assert.deepEqual(sortFuel([mk('Z', 'Zed'), mk('A', 'Avgas'), mk('Q', 'Alpha'), mk('J', 'Jet')]).map((p) => p.type), ['J', 'A', 'Q', 'Z']);
  });
});

describe('the market board', () => {
  it('fits the real market in one message, with every company and its name', () => {
    const embeds = renderMarket(MARKET, T0);
    assert.equal(embeds.length, 8, 'a summary and seven sectors');
    assert.ok(chars(embeds) <= 6000, `${chars(embeds)} characters`);
    const all = embeds.map((e) => e.toJSON().description ?? '').join('\n');
    for (const s of MARKET) assert.ok(all.includes(s.symbol), s.symbol);
    assert.ok(all.includes('Airbus AC'), 'names are kept when they fit');
  });

  it('opens with the counts and the biggest movers, worked out from the data', () => {
    const head = renderMarket(MARKET, T0)[0]!.toJSON();
    assert.equal(head.title, '📈 AeroDAQ · in-game market');
    const up = MARKET.filter((s) => Math.round(s.changePercent * 100) > 0).length;
    const down = MARKET.filter((s) => Math.round(s.changePercent * 100) < 0).length;
    assert.match(head.description!, new RegExp(`\\*\\*100\\*\\* companies · ▲ ${up} up · ▼ ${down} down`));
    assert.match(head.description!, /Biggest gainers: \*\*PCTH\*\* \+0\.13% · \*\*CSCD\*\* \+0\.12% · \*\*VANW\*\* \+0\.11%/);
    assert.match(head.description!, /Biggest losers: \*\*ATFN\*\* -0\.08% · \*\*SBCR\*\* -0\.07% · \*\*CPTL\*\* -0\.06%/);
    assert.match(head.description!, /Prices as of <t:\d+:R> · board refreshed <t:\d+:R>/);
    assert.match(head.description!, /\*\*in-game\*\* market: not real stocks or money/);
  });

  it('lays each sector out as an aligned table, by symbol, with signed changes', () => {
    const sector = renderMarket(MARKET, T0).find((e) => e.toJSON().title?.includes('Aircraft Manufacturers'))!.toJSON();
    assert.match(sector.title!, /^✈️ Aircraft Manufacturers · 9$/);
    const lines = sector.description!.split('\n');
    assert.equal(lines[0], '```');
    assert.match(lines[1]!, /^SYM\s+NAME\s+PRICE\s+CHG$/);
    assert.match(lines[2]!, /^AIRB\s+Airbus AC\s+143\.74\s+\+0\.01%$/);
    const symbols = lines.slice(2, -1).map((l) => l.split(/\s+/)[0]);
    assert.deepEqual(symbols, [...symbols].sort());
    assert.equal(new Set(lines.slice(1, -1).map((l) => l.length)).size, 1, 'every row is the same width, so the columns line up');
  });

  it('puts the not-real-money notice on the last embed only', () => {
    const embeds = renderMarket(MARKET, T0).map((e) => e.toJSON());
    assert.equal(embeds.at(-1)!.footer!.text, AERODAQ_FOOTER);
    assert.ok(embeds.slice(0, -1).every((e) => e.footer === undefined));
  });

  it('shows a change that rounds to nothing as a plain 0.00%, and never "-0.00%"', () => {
    assert.equal(changeText(0), '0.00%');
    assert.equal(changeText(-0.004), '0.00%');
    assert.equal(changeText(0.004), '0.00%');
    assert.equal(changeText(0.005), '+0.01%');
    assert.equal(changeText(-12.3456), '-12.35%');
    assert.equal(changeText(3), '+3.00%');
  });

  it('squeezes a huge market until it fits, and says how many it left out', () => {
    const many: Stock[] = [];
    for (let i = 0; i < 480; i++) many.push(stock(`S${String(i).padStart(3, '0')}`, { name: `Company number ${i} of many`, sectorSlug: `s${i % 12}`, sectorName: `Sector ${String(i % 12).padStart(2, '0')}`, price: 100 + i, changePercent: (i % 7) - 3 }));
    const embeds = renderMarket(many, T0);
    assert.ok(embeds.length <= 10, `${embeds.length} embeds`);
    assert.ok(chars(embeds) <= 6000, `${chars(embeds)} characters`);
    assert.match(embeds.map((e) => e.toJSON().description).join('\n'), /…and \d+ more at aerodaq\.com/);
    assert.match(embeds.at(-1)!.toJSON().title!, /More sectors/, 'sectors past the ninth share one table');
  });

  it('drops the company names before it drops companies', () => {
    const long: Stock[] = [];
    for (let i = 0; i < 150; i++) long.push(stock(`T${String(i).padStart(3, '0')}`, { name: 'An Extremely Long Company Name Ltd', sectorSlug: `s${i % 7}`, sectorName: `Sector ${i % 7}`, changePercent: 1.5 }));
    const embeds = renderMarket(long, T0);
    assert.ok(chars(embeds) <= 6000);
    const all = embeds.map((e) => e.toJSON().description ?? '').join('\n');
    assert.doesNotMatch(all, /An Extremely/);
    assert.doesNotMatch(all, /…and \d+ more/, 'every company is still listed');
    const tables = embeds.slice(1).map((e) => e.toJSON().description ?? '').join('\n');
    assert.equal((tables.match(/^T\d{3}\b/gm) ?? []).length, 150, 'one row for each company, in the sector tables');
  });

  it('cannot be broken out of by a hostile name, symbol or sector', () => {
    const hostile = [
      stock('EVIL', { name: '```\n@everyone [click](http://evil.example)', sectorName: '**bold** @here <@123>', sectorSlug: 'x' }),
      stock('B`D', { name: 'line\r\nbreak' }),
    ];
    const embeds = renderMarket(hostile, T0);
    for (const e of embeds.slice(1)) {
      const j = e.toJSON();
      const fences = (j.description!.match(/```/g) ?? []).length;
      assert.equal(fences, 2, `exactly one block: ${j.description}`);
      assert.doesNotMatch(j.title!, /\*\*bold\*\*|@here|<@123>/);
    }
  });

  it('says so when AeroDAQ lists nothing', () => {
    const e = renderMarket([], T0);
    assert.equal(e.length, 1);
    assert.match(e[0]!.toJSON().description!, /lists no companies/);
  });
});

/* ------------------------------------------------------------------ keeping a board up to date */

describe('the market board in a channel', () => {
  let h: Harness;
  let d: DiscordHarness;
  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    d.aerodaq.stocks = MARKET;
    h.store.setMarketBoard(GUILD, CHANNEL, h.clock.now);
  });
  afterEach(async () => {
    await settle(20);
    await h.close();
  });
  const board = () => h.store.getMarketBoard(GUILD)!;
  const live = () => d.client.channel(CHANNEL).live;

  it('posts it as one message, without pinging anyone, and remembers which', async () => {
    assert.equal(await d.market.refresh(GUILD), 'posted');
    assert.equal(live().length, 1);
    assert.equal(live()[0]!.payload.embeds.length, 8);
    assert.deepEqual(live()[0]!.payload.allowedMentions, { parse: [] });
    assert.deepEqual(board().messageIds, [live()[0]!.id]);
    assert.deepEqual([board().lastOkAt, board().lastError], [h.clock.now, null]);
  });

  it('edits that message in place on later refreshes', async () => {
    await d.market.refresh(GUILD);
    const first = live()[0]!;
    assert.equal(await d.market.refresh(GUILD), 'updated');
    assert.equal(live().length, 1);
    assert.equal(first.edits.length, 1);
  });

  it('posts it again if someone deleted the message', async () => {
    await d.market.refresh(GUILD);
    d.client.channel(CHANNEL).deleteMessage(live()[0]!.id);
    assert.equal(live().length, 0);
    assert.equal(await d.market.refresh(GUILD), 'posted');
    assert.equal(live().length, 1);
    assert.deepEqual(board().messageIds, [live()[0]!.id]);
  });

  it('leaves the board as it was, and says why, when AeroDAQ cannot be reached', async () => {
    await d.market.refresh(GUILD);
    const shown = live()[0]!;
    const before = shown.edits.length;
    d.aerodaq.error = new AeroDaqError('unavailable', "I couldn't reach AeroDAQ right now.");
    h.clock.advance(HOUR);
    assert.equal(await d.market.refresh(GUILD), 'unavailable');
    assert.equal(shown.edits.length, before, 'untouched');
    assert.equal(live().length, 1);
    assert.deepEqual([board().lastError, board().lastOkAt], ["I couldn't reach AeroDAQ right now.", h.clock.now - HOUR]);
    d.aerodaq.error = null;
    assert.equal(await d.market.refresh(GUILD), 'updated');
    assert.equal(board().lastError, null, 'cleared once it works again');
  });

  it('reports a channel that is gone or closed to it, without throwing', async () => {
    d.client.deleteAllChannels();
    assert.equal(await d.market.refresh(GUILD), 'no-access');
    assert.match(board().lastError!, /missing, or I can't write/);
  });

  it('does nothing for a server whose board is off', async () => {
    assert.equal(await d.market.refresh('another-server'), 'skipped');
    assert.equal(d.aerodaq.marketCalls, 0);
  });

  it('removes its message when asked', async () => {
    await d.market.refresh(GUILD);
    await d.market.deleteMessages(board());
    assert.equal(live().length, 0);
  });

  describe('on a schedule', () => {
    it('draws a new board at once, then only when 15 minutes have passed', async () => {
      await d.market.run();
      assert.equal(d.aerodaq.marketCalls, 1);
      h.clock.advance(MARKET_REFRESH_MS - 1000);
      await d.market.run();
      assert.equal(d.aerodaq.marketCalls, 1, 'not yet');
      h.clock.advance(2000);
      await d.market.run();
      assert.equal(d.aerodaq.marketCalls, 2);
    });

    it('does not hammer AeroDAQ while it is down: a failed try also waits 15 minutes', async () => {
      d.aerodaq.error = new AeroDaqError('unavailable', 'down');
      await d.market.run();
      await d.market.run();
      h.clock.advance(5 * 60_000);
      await d.market.run();
      assert.equal(d.aerodaq.marketCalls, 1);
      h.clock.advance(MARKET_REFRESH_MS);
      await d.market.run();
      assert.equal(d.aerodaq.marketCalls, 2);
    });

    it('serves several servers from one lookup', async () => {
      h.store.setMarketBoard('second-server', '700000000000000009', h.clock.now);
      await d.market.run();
      assert.equal(live().length, 1);
      assert.equal(d.client.channel('700000000000000009').live.length, 1);
    });

    it('is run by the scheduler, and a failure there does not stop the rest of its work', async () => {
      let runs = 0;
      const refresher = d.refresher;
      const ok = new Scheduler(h.jobs, refresher, { markets: { run: async () => void runs++ } });
      await ok.tick();
      assert.equal(runs, 1);
      const bad = new Scheduler(h.jobs, refresher, { markets: { run: async () => Promise.reject(new Error('boom')) } });
      await assert.doesNotReject(bad.tick());
    });
  });
});

/* ------------------------------------------------------------------ /fuel */

describe('/fuel', () => {
  let h: Harness;
  let d: DiscordHarness;
  let user = 0;
  const fuel = commands.find((c) => c.data.name === 'fuel')!;

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    d.aerodaq.airports.set('EGLL', EGLL);
    user++;
  });
  afterEach(() => h.close());

  const ask = async (airport: string, extra: Record<string, unknown> = {}, userId = `9000000000000000${String(user).padStart(2, '0')}`) => {
    const f = fakeInteraction({ userId, options: { airport, ...extra } });
    await fuel.execute(d.ctx, f.i);
    return f.calls;
  };

  it('is a server command with an airport code of three or four characters, and an option to share', () => {
    const json = fuel.data.toJSON() as { contexts: number[]; options: Array<{ name: string; required?: boolean; min_length?: number; max_length?: number }> };
    assert.deepEqual(json.contexts, [0]);
    const airport = json.options.find((o) => o.name === 'airport')!;
    assert.deepEqual([airport.required, airport.min_length, airport.max_length], [true, 3, 4]);
    assert.ok(json.options.some((o) => o.name === 'share'));
  });

  it('answers privately with the fuel prices', async () => {
    const calls = await ask('EGLL');
    assert.deepEqual(calls.defers[0], { flags: 64 }, 'only the asker sees it');
    assert.equal(calls.edits[0].embeds[0].toJSON().title, '⛽ Fuel at EGLL · Heathrow');
    assert.deepEqual(calls.edits[0].allowedMentions, { parse: [] });
  });

  it('shows it to the whole channel when asked to share', async () => {
    const calls = await ask('EGLL', { share: true });
    assert.deepEqual(calls.defers[0], {}, 'a public reply');
    assert.equal(calls.edits[0].embeds.length, 1);
  });

  it('takes the code in any case and asks AeroDAQ for the tidy version', async () => {
    await ask(' egll ');
    assert.deepEqual(d.aerodaq.fuelCalls, ['EGLL']);
  });

  it('tells the person what is wrong with a code that is not one, without asking AeroDAQ', async () => {
    for (const bad of ['E', 'EG LL', 'EGLL/x', '???']) {
      await assert.rejects(ask(bad, {}, `8${user}${bad.length}000000000000000`), (e: unknown) => e instanceof UserError && /ICAO code/.test(e.message), bad);
    }
    assert.deepEqual(d.aerodaq.fuelCalls, []);
  });

  it('says when AeroDAQ does not list the airport, and hints at the usual mix-up', async () => {
    await assert.rejects(ask('LHR'), (e: unknown) => e instanceof UserError && /doesn't list fuel prices for \*\*LHR\*\*.*not `LHR`/.test(e.message));
  });

  it('says when AeroDAQ cannot be reached, in its own words', async () => {
    d.aerodaq.error = new AeroDaqError('unavailable', "I couldn't reach AeroDAQ right now.");
    await assert.rejects(ask('EGLL'), (e: unknown) => e instanceof UserError && /couldn't reach AeroDAQ/.test(e.message));
  });

  it('lets unexpected errors through to be logged rather than shown', async () => {
    d.aerodaq.error = new Error('database exploded');
    await assert.rejects(ask('EGLL'), /database exploded/);
  });

  it('asks one person to wait a moment between lookups, but not other people, and not for long', async () => {
    await ask('EGLL', {}, '777000000000000001');
    await assert.rejects(ask('EGLL', {}, '777000000000000001'), /One moment/);
    await ask('EGLL', {}, '777000000000000002');
    h.clock.advance(FUEL_COOLDOWN_MS + 1);
    await ask('EGLL', {}, '777000000000000001');
    assert.equal(d.aerodaq.fuelCalls.length, 3);
  });
});

/* ------------------------------------------------------------------ /setup market */

describe('/setup market', () => {
  let h: Harness;
  let d: DiscordHarness;
  const setup = commands.find((c) => c.data.name === 'setup')!;
  const OTHER = '800000000000000001';
  const guildFake = (hasPerms = true) => ({
    channels: { fetch: async (id: string) => ({ id, permissionsFor: () => ({ has: () => hasPerms }) }) },
    members: { me: {}, fetchMe: async () => ({}) },
  });

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    d.aerodaq.stocks = MARKET;
  });
  afterEach(async () => {
    await settle(20);
    await h.close();
  });

  const run = async (options: Record<string, unknown> = {}, o: { admin?: boolean; guild?: unknown } = {}) => {
    const f = fakeInteraction({ sub: 'market', admin: o.admin ?? true, guild: o.guild ?? guildFake(), options });
    await setup.execute(d.ctx, f.i);
    return f.calls;
  };
  const text = (calls: { edits: any[] }) => String(calls.edits.at(-1)?.content ?? '');

  it('is for admins only, and changes nothing otherwise', async () => {
    await assert.rejects(run({ mode: 'on', channel: { id: CHANNEL } }, { admin: false }), /Manage Server/);
    assert.equal(h.store.getMarketBoard(GUILD), null);
  });

  it('starts off, and says how to turn it on', async () => {
    assert.match(text(await run()), /market board is \*\*off\*\*.*\/setup market mode:on channel:/);
  });

  it('turns on with a channel: posts the board, and says it is in-game and how often it updates', async () => {
    const calls = await run({ mode: 'on', channel: { id: CHANNEL } });
    assert.match(text(calls), new RegExp(`market board is in <#${CHANNEL}>.*every 15 minutes`));
    assert.match(text(calls), /in-game\* market, not real stocks or money/);
    assert.match(text(calls), /`\/fuel`/);
    assert.equal(h.store.getMarketBoard(GUILD)!.channelId, CHANNEL);
    assert.equal(d.client.channel(CHANNEL).live.length, 1);
  });

  it('a channel alone is enough to turn it on', async () => {
    await run({ channel: { id: CHANNEL } });
    assert.equal(d.client.channel(CHANNEL).live.length, 1);
  });

  it('needs a channel the first time', async () => {
    await assert.rejects(run({ mode: 'on' }), /Choose the channel/);
    assert.equal(h.store.getMarketBoard(GUILD), null);
  });

  it('refuses a channel the bot cannot write to, and stores nothing', async () => {
    await assert.rejects(run({ mode: 'on', channel: { id: CHANNEL } }, { guild: guildFake(false) }), /missing permissions/);
    assert.equal(h.store.getMarketBoard(GUILD), null);
  });

  it('keeps the board and tries again later when AeroDAQ cannot be reached, saying so', async () => {
    d.aerodaq.error = new AeroDaqError('unavailable', "I couldn't reach AeroDAQ right now.");
    const calls = await run({ mode: 'on', channel: { id: CHANNEL } });
    assert.match(text(calls), /couldn't get the market from AeroDAQ.*I try again every 15 minutes/);
    assert.ok(h.store.getMarketBoard(GUILD), 'still switched on');
    assert.equal(d.client.channel(CHANNEL).live.length, 0);
  });

  it('moving it to another channel removes the old message', async () => {
    await run({ mode: 'on', channel: { id: CHANNEL } });
    const old = d.client.channel(CHANNEL).live[0]!;
    await run({ channel: { id: OTHER } });
    assert.equal(old.deleted, true);
    assert.equal(d.client.channel(OTHER).live.length, 1);
    assert.equal(h.store.getMarketBoard(GUILD)!.channelId, OTHER);
  });

  it('running it again in the same channel does not duplicate the board', async () => {
    await run({ mode: 'on', channel: { id: CHANNEL } });
    await run({ mode: 'on', channel: { id: CHANNEL } });
    assert.equal(d.client.channel(CHANNEL).live.length, 1);
  });

  it('says how it stands when given nothing to change', async () => {
    await run({ mode: 'on', channel: { id: CHANNEL } });
    assert.match(text(await run()), new RegExp(`market board is \\*\\*on\\*\\* in <#${CHANNEL}>, last drawn <t:\\d+:R>`));
    d.aerodaq.error = new AeroDaqError('unavailable', 'AeroDAQ is busy right now. Try again in a minute.');
    h.clock.advance(HOUR);
    await d.market.refresh(GUILD);
    assert.match(text(await run()), /last try failed: AeroDAQ is busy/);
  });

  it('turns off: removes the message and forgets the board', async () => {
    await run({ mode: 'on', channel: { id: CHANNEL } });
    const msg = d.client.channel(CHANNEL).live[0]!;
    assert.match(text(await run({ mode: 'off' })), /Removed the AeroDAQ market board/);
    assert.equal(msg.deleted, true);
    assert.equal(h.store.getMarketBoard(GUILD), null);
    assert.match(text(await run({ mode: 'off' })), /already off/);
  });

  it('is part of the /setup command, with its description inside Discord\'s limit', () => {
    const json = setup.data.toJSON() as { options: Array<{ name: string; description: string; options?: Array<{ name: string; choices?: unknown[] }> }> };
    const sub = json.options.find((o) => o.name === 'market')!;
    assert.ok(sub.description.length <= 100);
    assert.deepEqual(sub.options!.map((o) => o.name).sort(), ['channel', 'mode']);
    assert.equal(sub.options!.find((o) => o.name === 'mode')!.choices!.length, 2);
  });
});

/* ------------------------------------------------------------------ storing the board */

describe('storing the market board', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it('has one board per server, and moving it forgets the old message and its history', () => {
    const a = h.store.setMarketBoard('g1', 'c1', 10);
    h.store.updateMarketBoard('g1', { messageIds: ['m1'], lastAttemptAt: 20, lastOkAt: 20, lastError: 'old' });
    assert.deepEqual(h.store.getMarketBoard('g1')!.messageIds, ['m1']);
    assert.equal(h.store.setMarketBoard('g1', 'c1', 99).createdAt, a.createdAt, 'the same channel changes nothing');
    const moved = h.store.setMarketBoard('g1', 'c2', 30);
    assert.deepEqual([moved.channelId, moved.messageIds, moved.lastAttemptAt, moved.lastOkAt, moved.lastError], ['c2', [], null, null, null]);
    assert.equal(h.store.listMarketBoards().length, 1);
  });

  it('lists every server\'s board and deletes one', () => {
    h.store.setMarketBoard('g1', 'c1', 10);
    h.store.setMarketBoard('g2', 'c2', 5);
    assert.deepEqual(h.store.listMarketBoards().map((b) => b.guildId), ['g2', 'g1']);
    assert.equal(h.store.deleteMarketBoard('g1'), true);
    assert.equal(h.store.deleteMarketBoard('g1'), false);
    assert.equal(h.store.getMarketBoard('g1'), null);
  });

  it('is unaffected by the flight panels in the same database', () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
    h.store.setMarketBoard(GUILD, CHANNEL, 1);
    h.store.deleteMarketBoard(GUILD);
    assert.equal(h.jobs.open(h.panel.id).length, 1);
  });
});

void silentLogger;
