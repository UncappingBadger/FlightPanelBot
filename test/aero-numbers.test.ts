import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AeroconomyClient, AeroconomyError, AEROCONOMY_API, type AeroContract, type AeroFlight } from '../src/aeroconomy/client.js';
import { commands } from '../src/discord/commands/index.js';
import type { SourceJob, JobSource } from '../src/jobs/types.js';
import { AeroNumbers, flightCodes, matchNumbers, type NumberedJob } from '../src/services/aeroNumbers.js';
import { matchFlight } from '../src/services/flightEtas.js';
import type { AirlineFlight } from '../src/fshub/liveFeed.js';
import { SourceRefresher } from '../src/services/refresh.js';
import { HOUR, T0, USER_A, makeHarness, sj, type Harness } from './helpers.js';
import { fakeInteraction, makeDiscordHarness, settle, type DiscordHarness, type FakeInteractionOptions } from './discord-helpers.js';

/* Everything below is made up: the airline (callsign code TST, FsHub airline 4242), its contracts and its flights. */

const MIN = 60_000;
const DAY = 24 * HOUR;
const AIRLINE = 4242;
const NOW = T0 + 6 * HOUR;
const setup = commands.find((c) => c.data.name === 'setup')!;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const contract = (id: number, over: Record<string, unknown> = {}) => ({ id, status: 'active', awardee: { type: 'airline', id: AIRLINE, name: 'Test Air' }, progress: { total: 4, completed: 1, failed: 0 }, ...over });
const manifest = (number: string, dep: string, arr: string, start: string, end: string, over: Record<string, unknown> = {}) => ({
  id: 1,
  flight_number: number,
  origin_icao: dep,
  destination_icao: arr,
  status: 'planned',
  arrival_window: { starts_at: start, ends_at: end },
  payload: { type: 'passengers', count: 100 },
  ...over,
});

/** A flight as the client hands it over. */
const flt = (number: string, dep: string, arr: string, start: number, end: number, status = 'planned'): AeroFlight => ({ number, dep, arr, start, end, status });
/** A sheet row's window: from `T0 + startH` to `T0 + endH` less a second, as Aeroconomy writes it (the sheet says :00, Aeroconomy :59). */
const win = (startH: number, endH: number) => ({ start: T0 + startH * HOUR, end: T0 + endH * HOUR - 1000 });
const job = (chain: string, startH: number, endH: number, over: Partial<NumberedJob> = {}): NumberedJob => {
  const a = chain.split('-');
  return { legs: a.slice(0, -1).map((dep, i) => ({ dep, arr: a[i + 1] as string })), availableFrom: T0 + startH * HOUR, deadline: T0 + endH * HOUR, ...over };
};
const flightAt = (number: string, chain: string, startH: number, endH: number, status = 'planned'): AeroFlight => {
  const [dep, arr] = chain.split('-') as [string, string];
  return flt(number, dep, arr, win(startH, endH).start, win(startH, endH).end, status);
};

/* ------------------------------------------------------------------ the client */

describe('the Aeroconomy client', () => {
  let calls: Array<{ url: string; headers: Record<string, string>; method?: string; redirect?: string }>;
  let reply: (url: string) => Response;
  let sleeps: number[];
  let clock: number;
  let client: AeroconomyClient;
  beforeEach(() => {
    calls = [];
    sleeps = [];
    clock = 1_000_000;
    reply = () => json({}, 404);
    client = new AeroconomyClient({
      fetchFn: (async (input: unknown, init?: RequestInit) => (calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string>, method: init?.method, redirect: init?.redirect }), reply(String(input)))) as typeof fetch,
      userAgent: 'FlightPanelBot/test',
      gapMs: 1000,
      sleep: async (ms) => void (sleeps.push(ms), (clock += ms)),
      now: () => clock,
    });
  });

  describe('the airline\'s contracts', () => {
    it('reads the live contracts a page at a time, picks out the airline\'s, and asks for nothing but plain GETs with no credentials', async () => {
      reply = (url) => {
        if (url.includes('status=active') && !url.includes('cursor=')) return json({ data: [contract(10), contract(11, { awardee: { type: 'airline', id: 9999, name: 'Other' } })], meta: { has_more: true, next_cursor: 'abc/=' } });
        if (url.includes('status=active')) return json({ data: [contract(12, { progress: { total: 0 } }), contract(13, { awardee: { type: 'business', id: AIRLINE } })], meta: { has_more: false, next_cursor: null } });
        return json({ data: [contract(14, { status: 'awarded' }), contract(10)], meta: { has_more: false } });
      };
      const got = await client.airlineContracts(AIRLINE);
      assert.deepEqual(got, [{ id: 10, status: 'active', total: 4 }, { id: 12, status: 'active', total: 0 }, { id: 14, status: 'awarded', total: 4 }], 'the airline\'s own, once each');
      assert.deepEqual(
        calls.map((c) => c.url.replace(AEROCONOMY_API, '')),
        ['/contracts?status=active&limit=100', '/contracts?status=active&limit=100&cursor=abc%2F%3D', '/contracts?status=awarded&limit=100'],
      );
      for (const c of calls) {
        assert.equal(c.method, 'GET');
        assert.deepEqual(Object.keys(c.headers).sort(), ['accept', 'user-agent'], 'no authorization header, nothing about anyone');
        assert.equal(c.redirect, 'manual', 'never follows a redirect');
        assert.ok(c.url.startsWith('https://aeroconomy.com/api/v1/'));
      }
    });

    it('leaves out a row it cannot read, and says so when the whole answer is nonsense', async () => {
      reply = () => json({ data: [{ nothing: true }, 'junk', contract(10)], meta: {} });
      assert.deepEqual((await client.airlineContracts(AIRLINE)).map((c) => c.id), [10]);
      reply = () => json({ data: 'many' });
      await assert.rejects(client.airlineContracts(AIRLINE), (e: unknown) => e instanceof AeroconomyError);
    });

    it('leaves out a flight whose landing window is not a date', async () => {
      reply = () => json({ data: [manifest('TST290', 'EGLL', 'EGKK', 'soon', 'later'), manifest('TST291', 'EGLL', 'EGKK', '2026-11-17T06:00:00Z', '2026-11-17T23:59:59Z')], meta: { last_page: 1 } });
      assert.deepEqual((await client.manifests(55)).map((f) => f.number), ['TST291']);
    });

    it('does not ask about something that is not an airline number', async () => {
      for (const bad of [0, -3, 1.5, Number.NaN]) assert.deepEqual(await client.airlineContracts(bad), []);
      assert.equal(calls.length, 0);
    });

    it('stops after a number of pages even when the server never says it is the last', async () => {
      reply = () => json({ data: [], meta: { has_more: true, next_cursor: 'again' } });
      await client.airlineContracts(AIRLINE);
      assert.ok(calls.length <= 40, `${calls.length} requests`);
    });
  });

  describe('a contract\'s flights', () => {
    it('reads every page, with the number and airports tidied, and leaves out a flight it cannot read', async () => {
      reply = (url) =>
        url.endsWith('page=1')
          ? json({ data: [manifest(' tst290 ', 'egll', 'egkk', '2026-11-17T06:00:00+00:00', '2026-11-17T23:59:59+00:00'), { flight_number: 7 }], meta: { last_page: 2 } })
          : json({ data: [manifest('TST330', 'EGKK', 'EGLL', '2026-11-18T06:00:00Z', '2026-11-18T23:59:59Z', { status: 'COMPLETED' })], meta: { last_page: 2 } });
      const got = await client.manifests(55);
      assert.deepEqual(got, [
        { number: 'TST290', dep: 'EGLL', arr: 'EGKK', start: Date.UTC(2026, 10, 17, 6), end: Date.UTC(2026, 10, 17, 23, 59, 59), status: 'planned' },
        { number: 'TST330', dep: 'EGKK', arr: 'EGLL', start: Date.UTC(2026, 10, 18, 6), end: Date.UTC(2026, 10, 18, 23, 59, 59), status: 'completed' },
      ]);
      assert.deepEqual(calls.map((c) => c.url.replace(AEROCONOMY_API, '')), ['/contracts/55/manifests?page=1', '/contracts/55/manifests?page=2']);
    });

    it('carries the serial of the aircraft attached to a flight that has been taken, and nothing for a flight that has none or one it cannot read', async () => {
      const w = ['2026-11-17T06:00:00Z', '2026-11-17T23:59:59Z'] as const;
      reply = () =>
        json({
          data: [
            manifest('TST290', 'EGLL', 'EGKK', ...w, { status: 'assigned', aircraft_serial: '00000618' }),
            manifest('TST291', 'EGLL', 'EGKK', ...w, { status: 'assigned', aircraft_serial: 557 }),
            manifest('TST292', 'EGLL', 'EGKK', ...w, { aircraft_serial: null }),
            manifest('TST293', 'EGLL', 'EGKK', ...w, { aircraft_serial: 'N738PM' }),
            manifest('TST294', 'EGLL', 'EGKK', ...w, { aircraft_serial: '00000000' }),
            manifest('TST295', 'EGLL', 'EGKK', ...w, { aircraft_serial: '-5' }),
            manifest('TST296', 'EGLL', 'EGKK', ...w, { aircraft_serial: '1e3' }),
            manifest('TST297', 'EGLL', 'EGKK', ...w, { aircraft_serial: '0x10' }),
            manifest('TST298', 'EGLL', 'EGKK', ...w, { aircraft_serial: ' 00000042 ' }),
          ],
          meta: { last_page: 1 },
        });
      const got = await client.manifests(55);
      assert.deepEqual(got.map((f) => [f.number, f.aircraftSerial]), [['TST290', 618], ['TST291', 557], ['TST292', undefined], ['TST293', undefined], ['TST294', undefined], ['TST295', undefined], ['TST296', undefined], ['TST297', undefined], ['TST298', 42]]);
      assert.ok(got.slice(2, 8).every((f) => !('aircraftSerial' in f)), 'no empty field on a flight without an aircraft');
    });

    it('says a contract that is gone has no flights, and does not ask for a bad number', async () => {
      assert.deepEqual(await client.manifests(55), []);
      assert.deepEqual(await client.manifests(0), []);
      assert.equal(calls.length, 1);
    });
  });

  describe('being gentle', () => {
    it('leaves a pause between requests', async () => {
      reply = () => json({ data: [], meta: { last_page: 1 } });
      await client.manifests(1);
      await client.manifests(2);
      assert.ok(sleeps.some((ms) => ms >= 1), 'it waited before the second request');
      assert.ok(Math.max(...sleeps) <= 1000);
    });

    it('waits as long as a 429 says (at most a minute) and then tries again', async () => {
      let n = 0;
      reply = () => (++n === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }) : json({ data: [], meta: { last_page: 1 } }));
      assert.deepEqual(await client.manifests(1), []);
      assert.equal(calls.length, 2);
      assert.ok(sleeps.includes(60_000), 'capped at a minute');
    });

    it('gives up when it is still told to slow down after waiting', async () => {
      reply = () => new Response('slow down', { status: 429 });
      await assert.rejects(client.manifests(1), (e: unknown) => e instanceof AeroconomyError && /slow down/.test(e.message));
      assert.equal(calls.length, 3);
    });
  });

  describe('when it goes wrong', () => {
    it('fails clearly: a server error, a redirect, something that is not JSON, far too much, or nothing reachable', async () => {
      reply = () => json({}, 500);
      await assert.rejects(client.manifests(1), (e: unknown) => e instanceof AeroconomyError && /answered 500/.test(e.message));
      reply = () => new Response('', { status: 302, headers: { location: 'https://elsewhere.invalid/' } });
      await assert.rejects(client.manifests(1), (e: unknown) => e instanceof AeroconomyError && /answered 302/.test(e.message));
      reply = () => new Response('<html>', { status: 200 });
      await assert.rejects(client.manifests(1), (e: unknown) => e instanceof AeroconomyError && /did not send JSON/.test(e.message));
      reply = () => new Response('x', { status: 200, headers: { 'content-length': '999999999' } });
      await assert.rejects(client.manifests(1), (e: unknown) => e instanceof AeroconomyError && /far more/.test(e.message));
      const down = new AeroconomyClient({ fetchFn: async () => Promise.reject(new TypeError('fetch failed')), gapMs: 0 });
      await assert.rejects(down.manifests(1), (e: unknown) => e instanceof AeroconomyError && /could not be reached/.test(e.message));
    });
  });
});

/* ------------------------------------------------------------------ the numbers */

describe('the ID each Aeroconomy flight would have', () => {
  it('is the flight number, with the day on the end when the number is flown on several days', () => {
    const a = flightAt('TST290', 'EGLL-EGKK', 0, 6);
    const b = flightAt('TST330', 'EGLL-EGKK', 0, 6);
    const c = flightAt('TST330', 'EGKK-EGLL', 24, 30); // a day later
    const codes = flightCodes([a, b, c]);
    assert.deepEqual([...codes.values()], ['TST290', 'TST330-11NOV', 'TST330-12NOV']);
  });

  it('does not count a cancelled flight, so a number flown again after a cancelled one stays plain', () => {
    const codes = flightCodes([flightAt('TST330', 'EGLL-EGKK', 0, 6, 'cancelled'), flightAt('TST330', 'EGLL-EGKK', 24, 30)]);
    assert.deepEqual([...codes.values()], ['TST330']);
  });

  it('uses a code for neither of two flights that would have the same one, and none that is not a usable flight number', () => {
    const codes = flightCodes([flightAt('TST330', 'EGLL-EGKK', 0, 6), flightAt('TST330', 'EGKK-EGLL', 1, 7), flightAt('TST1 2', 'EGLL-EGKK', 0, 6), flightAt('X'.repeat(20), 'EGLL-EGKK', 0, 6)]);
    assert.deepEqual([...codes.values()], []);
  });
});

describe('finding a flight\'s number', () => {
  const flights = [flightAt('TST290', 'EGLL-EGKK', 0, 6), flightAt('TST400', 'EGKK-EGCC', 0, 6), flightAt('TST500', 'EGCC-EGPH', 24, 30)];
  const codeOf = (j: NumberedJob, f: AeroFlight[] = flights) => matchNumbers([j], f)[0]!;

  it('takes the number of the one flight with the same two airports and landing window, whichever way the minute falls', () => {
    assert.deepEqual(codeOf(job('EGLL-EGKK', 0, 6)), { state: 'numbered', code: 'TST290' }, 'the sheet says :00, Aeroconomy :59');
    assert.deepEqual(codeOf({ ...job('EGLL-EGKK', 0, 6), deadline: T0 + 6 * HOUR - 1000 }), { state: 'numbered', code: 'TST290' });
    assert.equal(codeOf({ ...job('EGLL-EGKK', 0, 6), deadline: T0 + 6 * HOUR + 3 * MIN }).state, 'none', 'three minutes out is another window');
    assert.equal(codeOf({ ...job('EGLL-EGKK', 0, 6), availableFrom: T0 + 3 * MIN }).state, 'none');
  });

  it('does not find a flight the other way round, on another day, or by a different route', () => {
    assert.equal(codeOf(job('EGKK-EGLL', 0, 6)).state, 'none');
    assert.equal(codeOf(job('EGLL-EGKK', 24, 30)).state, 'none');
    assert.equal(codeOf(job('EGLL-EGCC', 0, 6)).state, 'none');
  });

  it('cannot find a flight of several legs, or one with no landing window', () => {
    assert.equal(codeOf(job('EGLL-EGKK-EGCC', 0, 6)).state, 'none');
    assert.equal(codeOf({ ...job('EGLL-EGKK', 0, 6), availableFrom: null }).state, 'none');
    assert.equal(codeOf({ ...job('EGLL-EGKK', 0, 6), deadline: null }).state, 'none');
  });

  it('never replaces a number the source gave', () => {
    assert.deepEqual(codeOf({ ...job('EGLL-EGKK', 0, 6), flightNumber: 'MINE1' }), { state: 'own', code: null });
  });

  it('does not use a cancelled flight', () => {
    assert.equal(codeOf(job('EGLL-EGKK', 0, 6), [flightAt('TST290', 'EGLL-EGKK', 0, 6, 'cancelled')]).state, 'none');
  });

  it('does not guess when two Aeroconomy flights could be it, or two rows want the same one', () => {
    const twice = [flightAt('TST290', 'EGLL-EGKK', 0, 6), flightAt('TST291', 'EGLL-EGKK', 0, 6)];
    assert.equal(codeOf(job('EGLL-EGKK', 0, 6), twice).state, 'ambiguous');
    const rows = matchNumbers([job('EGLL-EGKK', 0, 6), job('EGLL-EGKK', 0, 6)], [flightAt('TST290', 'EGLL-EGKK', 0, 6)]);
    assert.deepEqual(rows.map((r) => r.state), ['ambiguous', 'ambiguous']);
    // Two rows a minute apart that both land on one flight are not told apart either.
    const near = matchNumbers([job('EGLL-EGKK', 0, 6), { ...job('EGLL-EGKK', 0, 6), deadline: T0 + 6 * HOUR + MIN }], [flightAt('TST290', 'EGLL-EGKK', 0, 6)]);
    assert.deepEqual(near.map((r) => r.state), ['ambiguous', 'ambiguous']);
  });

  it('finds each of several rows its own flight', () => {
    const got = matchNumbers([job('EGLL-EGKK', 0, 6), job('EGKK-EGCC', 0, 6), job('EGCC-EGPH', 24, 30), job('EGPH-EGLL', 0, 6)], flights);
    assert.deepEqual(got, [{ state: 'numbered', code: 'TST290' }, { state: 'numbered', code: 'TST400' }, { state: 'numbered', code: 'TST500' }, { state: 'none', code: null }]);
  });
});

/* ------------------------------------------------------------------ the service */

describe('reading Aeroconomy\'s flight numbers for a panel', () => {
  let h: Harness;
  let numbers: AeroNumbers;
  let applied: number[];
  let reads: string[];
  let contracts: AeroContract[];
  let byContract: Map<number, AeroFlight[]>;
  let failing: boolean;
  let gate: Promise<void> | null;
  const pid = () => h.panel.id;
  const fakeClient = {
    async airlineContracts(id: number) {
      reads.push(`contracts:${id}`);
      if (failing) throw new AeroconomyError('down');
      if (gate) await gate;
      return contracts;
    },
    async manifests(id: number) {
      reads.push(`manifests:${id}`);
      return byContract.get(id) ?? [];
    },
  };
  const build = () => {
    numbers = new AeroNumbers({ store: h.store, client: fakeClient, apply: async (p) => void applied.push(p.id), now: () => h.clock.now });
  };
  const on = (airlineId: number | null = AIRLINE) => h.store.updatePanel(pid(), { flightNumbers: true, fshubAirlineId: airlineId });

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    applied = [];
    reads = [];
    failing = false;
    gate = null;
    contracts = [{ id: 7, status: 'active', total: 3 }];
    byContract = new Map([[7, [flightAt('TST290', 'EGLL-EGKK', 0, 6), flightAt('TST400', 'EGKK-EGCC', 0, 6)]]]);
    build();
  });
  afterEach(async () => {
    await numbers.idle();
    await h.close();
  });

  it('asks for nothing, and changes nothing, for a panel that has it off or is not linked to an airline', async () => {
    await numbers.run();
    h.store.updatePanel(pid(), { flightNumbers: true });
    await numbers.run();
    assert.deepEqual(reads, []);
    const jobs = [sj('a', 'EGLL-EGKK', { availableFrom: T0, deadline: T0 + 6 * HOUR })];
    assert.equal(numbers.enrich(h.store.getPanel(pid())!, jobs), jobs);
    h.store.updatePanel(pid(), { flightNumbers: false, fshubAirlineId: AIRLINE });
    assert.equal(numbers.enrich(h.store.getPanel(pid())!, jobs), jobs);
  });

  it('starts the read without waiting for it, reads each contract once, and then has the panel refreshed', async () => {
    on();
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    await numbers.run(); // returns while the read is still waiting
    assert.deepEqual(reads, ['contracts:4242']);
    assert.deepEqual(applied, [], 'nothing applied yet');
    release();
    await numbers.idle();
    assert.deepEqual(reads, ['contracts:4242', 'manifests:7']);
    assert.deepEqual(applied, [pid()]);
    const cache = numbers.cacheFor(AIRLINE)!;
    assert.deepEqual({ flights: cache.flights.length, contracts: cache.contracts, at: cache.at }, { flights: 2, contracts: 1, at: NOW });
  });

  it('gives a flight its number once read, and a flight that matches none is left as it was', async () => {
    on();
    await numbers.run();
    await numbers.idle();
    const jobs = [
      sj('a', 'EGLL-EGKK', { availableFrom: T0, deadline: T0 + 6 * HOUR }),
      sj('b', 'EGKK-EGCC', { availableFrom: T0, deadline: T0 + 6 * HOUR, flightNumber: 'OWN1' }),
      sj('c', 'EGPH-EGLL', { availableFrom: T0, deadline: T0 + 6 * HOUR }),
    ];
    const out = numbers.enrich(h.store.getPanel(pid())!, jobs);
    assert.deepEqual(out.map((j) => j.flightNumber ?? null), ['TST290', 'OWN1', null]);
    assert.equal(jobs[0]!.flightNumber, undefined, 'the list it was given is not changed');
  });

  it('stops giving numbers when the panel switches it off, even though it has read them', async () => {
    on();
    await numbers.run();
    await numbers.idle();
    const jobs = [sj('a', 'EGLL-EGKK', { availableFrom: T0, deadline: T0 + 6 * HOUR })];
    assert.equal(numbers.enrich(h.store.getPanel(pid())!, jobs)[0]!.flightNumber, 'TST290');
    h.store.updatePanel(pid(), { flightNumbers: false });
    assert.equal(numbers.enrich(h.store.getPanel(pid())!, jobs), jobs);
    h.store.updatePanel(pid(), { flightNumbers: true, fshubAirlineId: null });
    assert.equal(numbers.enrich(h.store.getPanel(pid())!, jobs), jobs, 'and for a panel that is no longer linked');
  });

  it('keeps what it read across a restart', async () => {
    on();
    await numbers.run();
    await numbers.idle();
    reads.length = 0;
    build();
    const out = numbers.enrich(h.store.getPanel(pid())!, [sj('a', 'EGLL-EGKK', { availableFrom: T0, deadline: T0 + 6 * HOUR })]);
    assert.equal(out[0]!.flightNumber, 'TST290');
    await numbers.run();
    assert.deepEqual(reads, [], 'and does not read again so soon');
  });

  it('reads again after six hours, not before', async () => {
    on();
    await numbers.run();
    await numbers.idle();
    reads.length = 0;
    h.clock.advance(5 * HOUR + 50 * MIN);
    await numbers.run();
    assert.deepEqual(reads, []);
    h.clock.advance(11 * MIN);
    await numbers.run();
    await numbers.idle();
    assert.deepEqual(reads, ['contracts:4242', 'manifests:7']);
  });

  it('skips a contract with no flights, and reads one read for two panels of the same airline', async () => {
    contracts = [{ id: 7, status: 'active', total: 3 }, { id: 8, status: 'active', total: 0 }];
    const second = h.store.createPanel({ guildId: '900000000000000002', name: 'Test Air', abbr: 'TST', prefix: 'TST', channelId: '700000000000000002', now: T0 });
    h.store.updatePanel(second.id, { flightNumbers: true, fshubAirlineId: AIRLINE });
    on();
    await numbers.run();
    await numbers.idle();
    assert.deepEqual(reads, ['contracts:4242', 'manifests:7']);
    assert.deepEqual(applied.sort(), [pid(), second.id].sort());
  });

  it('shrugs off a failed read, keeps what it had, and tries again after half an hour', async () => {
    on();
    await numbers.run();
    await numbers.idle();
    h.clock.advance(7 * HOUR);
    failing = true;
    reads.length = 0;
    await numbers.run();
    await numbers.idle();
    assert.deepEqual(reads, ['contracts:4242']);
    assert.equal(numbers.cacheFor(AIRLINE)!.flights.length, 2, 'the old numbers still stand');
    await numbers.run();
    assert.equal(reads.length, 1, 'not straight away');
    h.clock.advance(31 * MIN);
    failing = false;
    await numbers.run();
    await numbers.idle();
    assert.deepEqual(reads, ['contracts:4242', 'contracts:4242', 'manifests:7']);
  });

  it('reads at once when asked to (the setting was just switched on)', async () => {
    on();
    await numbers.run();
    await numbers.idle();
    reads.length = 0;
    numbers.request(AIRLINE);
    await numbers.idle();
    assert.deepEqual(reads, ['contracts:4242', 'manifests:7']);
  });

  it('says how the open flights stand against what was read', async () => {
    on();
    h.jobs.sync(pid(), [
      sj('a', 'EGLL-EGKK', { availableFrom: NOW, deadline: NOW + 6 * HOUR }),
      sj('b', 'EGKK-EGCC', { availableFrom: NOW, deadline: NOW + 6 * HOUR }),
      sj('multi', 'EGLL-EGKK-EGCC', { availableFrom: NOW, deadline: NOW + 6 * HOUR }),
    ]);
    byContract.set(7, [flt('TST290', 'EGLL', 'EGKK', NOW, NOW + 6 * HOUR - 1000), flt('TST400', 'EGKK', 'EGCC', NOW, NOW + 6 * HOUR - 1000), flt('TST401', 'EGKK', 'EGCC', NOW, NOW + 6 * HOUR - 1000)]);
    assert.deepEqual(numbers.coverage(h.store.getPanel(pid())!), { readAt: null, flights: 0, contracts: 0, open: 3, numbered: 0, ambiguous: 0, none: 3 });
    await numbers.run();
    await numbers.idle();
    assert.deepEqual(numbers.coverage(h.store.getPanel(pid())!), { readAt: NOW, flights: 3, contracts: 1, open: 3, numbered: 1, ambiguous: 1, none: 1 });
    h.store.updatePanel(pid(), { fshubAirlineId: null });
    assert.equal(numbers.coverage(h.store.getPanel(pid())!), null);
  });
});

/* ------------------------------------------------------------------ in the refresh of a panel */

describe('flight numbers in a panel\'s refresh', () => {
  let h: Harness;
  let numbers: AeroNumbers;
  let refresher: SourceRefresher;
  let rows: SourceJob[];
  const pid = () => h.panel.id;
  const source: JobSource = { kind: 'test', fetch: async () => rows.map((r) => ({ ...r })) };
  const codes = () => h.store.listOpenJobViews(pid()).map((v) => v.job.code).sort();

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    numbers = new AeroNumbers({
      store: h.store,
      client: {
        airlineContracts: async () => [{ id: 7, status: 'active', total: 4 }],
        manifests: async () => [
          flt('TST290', 'EGLL', 'EGKK', NOW, NOW + 6 * HOUR - 1000),
          flt('TST330', 'EGKK', 'EGCC', NOW, NOW + 6 * HOUR - 1000),
          flt('TST330', 'EGKK', 'EGCC', NOW + 2 * DAY, NOW + 2 * DAY + 6 * HOUR - 1000),
        ],
      },
      apply: async (p) => void (await refresher.refresh(p)),
      now: () => h.clock.now,
    });
    refresher = new SourceRefresher(h.store, h.jobs, () => source, undefined, () => h.clock.now, (p, list) => numbers.enrich(p, list));
    rows = [
      sj('a', 'EGLL-EGKK', { availableFrom: NOW, deadline: NOW + 6 * HOUR }),
      sj('b', 'EGKK-EGCC', { availableFrom: NOW, deadline: NOW + 6 * HOUR }),
      sj('c', 'EGPH-EGLL', { availableFrom: NOW, deadline: NOW + 6 * HOUR }),
    ];
  });
  afterEach(async () => {
    await numbers.idle();
    await h.close();
  });

  it('leaves the automatic IDs alone until it is switched on and has read Aeroconomy', async () => {
    await refresher.refresh(h.panel);
    assert.deepEqual(codes(), ['TST-001', 'TST-002', 'TST-003']);
    h.store.updatePanel(pid(), { flightNumbers: true, fshubAirlineId: AIRLINE });
    await refresher.refresh(h.store.getPanel(pid())!);
    assert.deepEqual(codes(), ['TST-001', 'TST-002', 'TST-003'], 'nothing read yet');
  });

  it('renames flights the bot already knew once Aeroconomy has been read, keeping who holds them, and gives the day to a number flown on several days', async () => {
    await refresher.refresh(h.panel);
    const first = h.store.listOpenJobViews(pid()).find((v) => v.job.sourceKey === 'a')!;
    h.jobs.reserve(first.job.id, [1], USER_A);
    h.store.updatePanel(pid(), { flightNumbers: true, fshubAirlineId: AIRLINE });
    await numbers.run();
    await numbers.idle(); // the read, and then the refresh it asks for
    assert.deepEqual(codes(), ['TST-003', 'TST290', 'TST330-11NOV']);
    const renamed = h.store.getJobView(first.job.id)!;
    assert.equal(renamed.job.code, 'TST290');
    assert.equal(renamed.legs[0]!.holder?.discordId, USER_A.discordId, 'the reservation went with the flight');
  });

  it('gives new flights their number at once, a flight Aeroconomy has no number for an automatic ID, and keeps a number even when a refresh runs without it', async () => {
    h.store.updatePanel(pid(), { flightNumbers: true, fshubAirlineId: AIRLINE });
    await numbers.run();
    await numbers.idle();
    assert.deepEqual(codes(), ['TST-001', 'TST290', 'TST330-11NOV']);
    h.store.updatePanel(pid(), { flightNumbers: false });
    await refresher.refresh(h.store.getPanel(pid())!);
    assert.deepEqual(codes(), ['TST-001', 'TST290', 'TST330-11NOV'], 'switched off: the IDs already given stay');
  });

  it('finds a flight by just its number when the ID carries the day, and not when two flights could be meant', async () => {
    h.store.updatePanel(pid(), { flightNumbers: true, fshubAirlineId: AIRLINE });
    await numbers.run();
    await numbers.idle();
    const panel = h.store.getPanel(pid())!;
    assert.equal(h.jobs.findByCode(panel, 'tst330')?.job.code, 'TST330-11NOV', 'the only open one');
    assert.equal(h.jobs.findByCode(panel, 'TST 330')?.job.code, 'TST330-11NOV');
    assert.equal(h.jobs.findByCode(panel, 'TST330-11NOV')?.job.code, 'TST330-11NOV');
    assert.equal(h.jobs.findByCode(panel, 'TST29'), null, 'a different number');
    assert.equal(h.jobs.findByCode(panel, 'TST290')?.job.code, 'TST290', 'a plain number as before');
  });

  it('does not pick a day for someone who typed just the number when two such flights are open, nor treat any other ending as a day', async () => {
    h.store.updatePanel(pid(), { flightNumbers: true, fshubAirlineId: AIRLINE });
    rows = [
      ...rows,
      sj('d', 'EGKK-EGCC', { availableFrom: NOW + 2 * DAY, deadline: NOW + 2 * DAY + 6 * HOUR }),
      sj('own', 'EGPH-EGLL', { availableFrom: NOW, deadline: NOW + 6 * HOUR, flightNumber: 'TST555-OLD' }),
    ];
    await numbers.run();
    await numbers.idle();
    assert.ok(codes().includes('TST330-11NOV') && codes().includes('TST330-13NOV'), codes().join(', '));
    const panel = h.store.getPanel(pid())!;
    assert.equal(h.jobs.findByCode(panel, 'TST330'), null, 'two days could be meant');
    assert.equal(h.jobs.findByCode(panel, 'TST330-13NOV')?.job.code, 'TST330-13NOV');
    assert.equal(h.jobs.findByCode(panel, 'TST555-OLD')?.job.code, 'TST555-OLD');
    assert.equal(h.jobs.findByCode(panel, 'TST555'), null, '-OLD is not a day');
  });
});

describe('a live flight whose callsign is the flight number', () => {
  it('is that flight even when the ID carries the day, and the days that share the number are told apart by the landing', async () => {
    const h = await makeHarness();
    h.clock.now = NOW;
    h.jobs.sync(h.panel.id, [
      sj('x', 'EGLL-EGKK', { flightNumber: 'TST330-11NOV', availableFrom: NOW, deadline: NOW + 6 * HOUR }),
      sj('y', 'EGLL-EGKK', { flightNumber: 'TST330-14NOV', availableFrom: NOW + 3 * DAY, deadline: NOW + 3 * DAY + 6 * HOUR }),
      sj('z', 'EGLL-EGKK', { flightNumber: 'TST777', availableFrom: NOW, deadline: NOW + 6 * HOUR }),
    ]);
    const views = h.store.listOpenJobViews(h.panel.id);
    const live = (over: Partial<AirlineFlight> = {}): AirlineFlight => ({ flightId: 'f', pilotId: null, callsign: 'TST330', dep: 'EGLL', arr: 'EGKK', phase: 'cruise', onGround: false, etaMinutes: 60, ...over });
    assert.equal(matchFlight(live(), views, NOW)!.view.job.code, 'TST330-11NOV', 'today\'s, by the landing');
    assert.equal(matchFlight(live({ etaMinutes: 3 * 24 * 60 }), views, NOW)!.view.job.code, 'TST330-14NOV');
    assert.equal(matchFlight(live({ callsign: 'TST777' }), views, NOW)!.view.job.code, 'TST777');
    await h.close();
  });
});

/* ------------------------------------------------------------------ /setup flight-numbers */

describe('/setup flight-numbers', () => {
  let h: Harness;
  let d: DiscordHarness;
  let numbers: AeroNumbers;
  let requested: number[];
  const pid = () => h.panel.id;
  const run = async (o: FakeInteractionOptions = {}) => {
    const f = fakeInteraction({ sub: 'flight-numbers', admin: true, ...o });
    let error: Error | null = null;
    try {
      await setup.execute(d.ctx, f.i);
    } catch (e) {
      error = e as Error;
    }
    await settle(40);
    return { text: String(f.calls.edits.at(-1)?.content ?? ''), error };
  };
  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    d = makeDiscordHarness(h);
    requested = [];
    numbers = new AeroNumbers({
      store: h.store,
      client: { airlineContracts: async () => [{ id: 7, status: 'active', total: 4 }], manifests: async () => [flt('TST290', 'EGLL', 'EGKK', NOW, NOW + 6 * HOUR - 1000)] },
      now: () => h.clock.now,
    });
    const original = numbers.request.bind(numbers);
    numbers.request = (id: number) => (requested.push(id), original(id));
    d.ctx.numbers = numbers;
  });
  afterEach(async () => {
    await numbers.idle();
    await settle(40);
    await h.close();
  });

  it('is off for every panel, and is a subcommand Discord accepts', () => {
    assert.equal(h.store.getPanel(pid())!.flightNumbers, false);
    const sub = (setup.data.toJSON().options ?? []).find((o) => o.name === 'flight-numbers') as unknown as { description: string; options: Array<{ name: string; choices?: Array<{ value: string }> }> };
    assert.ok(sub && sub.description.length <= 100);
    assert.deepEqual(sub.options.find((o) => o.name === 'mode')!.choices!.map((c) => c.value), ['on', 'off']);
    assert.ok(sub.options.some((o) => o.name === 'airline'));
  });

  it('is for admins only', async () => {
    const { error } = await run({ admin: false });
    assert.ok(error, 'refused');
    assert.equal(h.store.getPanel(pid())!.flightNumbers, false);
  });

  it('says it is off and how to turn it on, changing nothing', async () => {
    const { text } = await run();
    assert.match(text, /off\*\* for \*\*Test Air\*\*/);
    assert.doesNotMatch(text, /^Done/);
    assert.match(text, /`\/setup flight-numbers mode:on`/);
  });

  it('will not switch on for a panel that is not linked to its airline\'s FsHub roster', async () => {
    const { error } = await run({ options: { mode: 'on' } });
    assert.match(error?.message ?? '', /Link this panel to your airline's FsHub roster first/);
    assert.equal(h.store.getPanel(pid())!.flightNumbers, false);
  });

  it('switches on for a linked panel, starts the first read, and says what will happen', async () => {
    h.store.updatePanel(pid(), { fshubAirlineId: AIRLINE });
    const { text } = await run({ options: { mode: 'on' } });
    assert.equal(h.store.getPanel(pid())!.flightNumbers, true);
    assert.deepEqual(requested, [AIRLINE]);
    assert.match(text, /^Done\. For \*\*Test Air\*\* \(FsHub airline number 4242\)/);
    assert.match(text, /I haven't read Aeroconomy yet/);
    assert.match(text, /no account or token/);
    await numbers.idle();
    const again = await run();
    assert.doesNotMatch(again.text, /^Done/);
    assert.match(again.text, /Last read <t:\d+:R>: 1 flights from 1 contract\. Of the 0 open flights, 0 have a number, 0 could be more than one Aeroconomy flight \(left alone\) and 0 match none\./);
    assert.equal(requested.length, 1, 'showing the setting does not read again');
  });

  it('switches off again, and says the IDs already given stay', async () => {
    h.store.updatePanel(pid(), { fshubAirlineId: AIRLINE, flightNumbers: true });
    const { text } = await run({ options: { mode: 'off' } });
    assert.equal(h.store.getPanel(pid())!.flightNumbers, false);
    assert.match(text, /^Done\. Flight numbers from Aeroconomy are \*\*off\*\*/);
    assert.match(text, /not changed back/);
  });

  it('does nothing when it is already so', async () => {
    h.store.updatePanel(pid(), { fshubAirlineId: AIRLINE, flightNumbers: true });
    const { text } = await run({ options: { mode: 'on' } });
    assert.doesNotMatch(text, /^Done/);
    assert.deepEqual(requested, []);
  });
});
