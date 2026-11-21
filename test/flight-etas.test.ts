import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { etaCommand } from '../src/discord/commands/eta.js';
import { openCard, renderPanelParts } from '../src/discord/ui.js';
import { isFlying, LIVE_FEED, LiveFeed, LiveFeedError, type AirlineFlight } from '../src/fshub/liveFeed.js';
import { callsignCode, FlightEtas, isOwnFlight, matchFlight, type FlightEta } from '../src/services/flightEtas.js';
import { HOUR, T0, USER_A, USER_B, makeHarness, sj, type Harness } from './helpers.js';
import { fakeInteraction, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

/* Everything below is made up: the pilots, the airline (its code is TST) and the flights. */

const MIN = 60_000;
const NOW = T0 + 6 * HOUR;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A flight in the shape the feed lists an airline's flights in. */
const rawFlight = (over: Record<string, unknown> = {}) => ({
  id: 'abc123',
  phase: 'level_flight',
  joinfs: false,
  position: { lat: 1, lng: 2, altitude_ft: 30000, heading: 90, speed_tas_kts: 450, on_ground: false, squawk: '0000' },
  aircraft: { icao: 'A320' },
  pilot: { id: 7001, name: 'Made Up', avatar_url: 'https://example.invalid/a.png', profile_url: 'https://example.invalid/p' },
  airline: { id: 1, name: 'Test Air', abbr: 'TST' },
  plan: { callsign: 'TST123', flight_no: 'TST123', cruise_lvl: 350, route: 'EGLL EGKK', departure: 'EGLL', arrival: 'EGKK', waypoints: ['EGLL', 'EGKK'] },
  eta_minutes: 37,
  distance_nm: 278,
  human_eta: '0hr 37m',
  progress: 35,
  flight_status: 'ON-TIME',
  last_seen: '2026-11-17T04:30:05Z',
  ...over,
});

const flight = (over: Partial<AirlineFlight> = {}): AirlineFlight => ({
  flightId: 'f1',
  pilotId: 7001,
  callsign: 'TST123',
  dep: 'EGLL',
  arr: 'EGKK',
  phase: 'cruise',
  onGround: false,
  etaMinutes: 37,
  ...over,
});

/* ------------------------------------------------------------------ the feed's airline call */

describe('the live feed client: an airline\'s flights', () => {
  let calls: string[];
  let reply: (url: string) => Response;
  let feed: LiveFeed;
  beforeEach(() => {
    calls = [];
    reply = () => json({}, 404);
    feed = new LiveFeed({ fetchFn: (async (input: unknown) => (calls.push(String(input)), reply(String(input)))) as typeof fetch });
  });

  it('asks for one airline in one request, and reads each flight', async () => {
    reply = () => json({ airline_icao: 'TST', count: 1, flights: [rawFlight()] });
    const out = await feed.airlineFlights('tst');
    assert.deepEqual(calls, [`${LIVE_FEED}/airline/TST`]);
    assert.deepEqual(out, [{ flightId: 'abc123', pilotId: 7001, callsign: 'TST123', flightNo: 'TST123', dep: 'EGLL', arr: 'EGKK', phase: 'level_flight', onGround: false, etaMinutes: 37 }]);
  });

  it('reads a flight with no flight plan (`plan: false`) and one with no airline, with no callsign and no airports', async () => {
    reply = () => json({ flights: [rawFlight({ plan: false, airline: false, eta_minutes: undefined })] });
    assert.deepEqual(await feed.airlineFlights('TST'), [{ flightId: 'abc123', pilotId: 7001, callsign: null, flightNo: null, dep: null, arr: null, phase: 'level_flight', onGround: false, etaMinutes: null }]);
  });

  it('upper-cases the callsign, and takes the flight number when the plan has no callsign', async () => {
    reply = () => json({ flights: [rawFlight({ plan: { callsign: ' tst77 ', departure: 'egll', arrival: 'egkk' } }), rawFlight({ id: 'x', plan: { flight_no: 'tst88', departure: 'EGLL', arrival: 'EGKK' } })] });
    assert.deepEqual((await feed.airlineFlights('TST')).map((f) => f.callsign), ['TST77', 'TST88']);
  });

  it('keeps a flight whose parts are odd, losing only the odd part: a number where text should be, a text where a number should be', async () => {
    reply = () =>
      json({
        flights: [
          rawFlight({ eta_minutes: '37', pilot: { id: 'seven' }, position: { on_ground: 'no' }, phase: 12, plan: { callsign: 517, flight_no: 'TST517', departure: 42, arrival: 'EGKK' } }),
          rawFlight({ id: 'b', eta_minutes: null, pilot: { id: 70.5 } }),
        ],
      });
    const out = await feed.airlineFlights('TST');
    assert.deepEqual(out.map((f) => f.flightId), ['abc123', 'b'], 'both flights are kept');
    assert.deepEqual(out[0], { flightId: 'abc123', pilotId: null, callsign: 'TST517', flightNo: 'TST517', dep: null, arr: 'EGKK', phase: null, onGround: null, etaMinutes: null });
    assert.equal(out[1]!.pilotId, null);
  });

  it('keeps a flight with parts missing altogether: a plan with only a callsign, no position, no pilot, no phase', async () => {
    reply = () => json({ flights: [{ id: 'bare', plan: { callsign: 'TST9' } }, { id: 'bare2', plan: {}, position: {}, pilot: {} }, { id: 'bare3' }] });
    const out = await feed.airlineFlights('TST');
    assert.deepEqual(out.map((f) => f.flightId), ['bare', 'bare2', 'bare3']);
    assert.deepEqual(out[0], { flightId: 'bare', pilotId: null, callsign: 'TST9', flightNo: null, dep: null, arr: null, phase: null, onGround: null, etaMinutes: null });
  });

  it('reads the flight number of the plan beside its callsign, so a pilot\'s own callsign does not hide the airline\'s number', async () => {
    reply = () => json({ flights: [rawFlight({ plan: { callsign: 'mymate', flight_no: 'TST123', departure: 'EGLL', arrival: 'EGKK' } })] });
    const [f] = await feed.airlineFlights('TST');
    assert.deepEqual([f!.callsign, f!.flightNo], ['MYMATE', 'TST123']);
  });

  it('leaves out a flight it cannot read, and keeps the others', async () => {
    reply = () => json({ flights: [{ nothing: true }, rawFlight(), 'junk', rawFlight({ id: 'second' })] });
    assert.deepEqual((await feed.airlineFlights('TST')).map((f) => f.flightId), ['abc123', 'second']);
  });

  it('says there are none for an airline the feed does not know (a 404), and does not ask for something that is not an airline code', async () => {
    assert.deepEqual(await feed.airlineFlights('TST'), []);
    for (const bad of ['', 'T', 'TOOLONG', '../all', 'T S']) assert.deepEqual(await feed.airlineFlights(bad), []);
    assert.equal(calls.length, 1, 'only the real code was asked about');
  });

  it('fails clearly on nonsense', async () => {
    reply = () => json({ flights: 'many' });
    await assert.rejects(feed.airlineFlights('TST'), (e: unknown) => e instanceof LiveFeedError);
    reply = () => json({}, 500);
    await assert.rejects(feed.airlineFlights('TST'), (e: unknown) => e instanceof LiveFeedError && /answered 500/.test(e.message));
  });
});

/* ------------------------------------------------------------------ which flights are the airline's own */

describe('which live flights are the airline\'s own', () => {
  it('takes one flown with the airline\'s callsign and a flight plan, in the air, with an estimate', () => {
    assert.equal(isOwnFlight(flight(), 'TST'), true);
    assert.equal(isOwnFlight(flight({ callsign: 'TST1' }), 'tst'), true, 'the code in any case');
    for (const phase of ['take_off', 'climbing', 'level_flight', 'cruise', 'descending', 'on_approach']) assert.equal(isOwnFlight(flight({ phase }), 'TST'), true, phase);
  });

  it('ignores a flight under another callsign, whoever flies it', () => {
    assert.equal(isOwnFlight(flight({ callsign: 'DLH408' }), 'TST'), false);
    assert.equal(isOwnFlight(flight({ callsign: 'SKY123' }), 'TST'), false);
    assert.equal(isOwnFlight(flight({ callsign: 'XTST123' }), 'TST'), false, 'the code has to be the start');
  });

  it('ignores a callsign that is the code and no number, and one where the code runs into a word', () => {
    assert.equal(isOwnFlight(flight({ callsign: 'TST' }), 'TST'), false);
    assert.equal(isOwnFlight(flight({ callsign: 'TSTAIR' }), 'TST'), false);
    assert.equal(isOwnFlight(flight({ callsign: 'TSTA123' }), 'TST'), false);
  });

  it('ignores a flight with no flight plan, or no callsign or airports in it', () => {
    assert.equal(isOwnFlight(flight({ callsign: null, dep: null, arr: null }), 'TST'), false);
    assert.equal(isOwnFlight(flight({ dep: null }), 'TST'), false);
    assert.equal(isOwnFlight(flight({ arr: null }), 'TST'), false);
    assert.equal(isOwnFlight(flight({ callsign: null }), 'TST'), false);
  });

  it('ignores an aircraft on the ground, and an estimate that cannot be believed', () => {
    assert.equal(isOwnFlight(flight({ phase: 'taxiing_to_runway', onGround: true, etaMinutes: 2391 }), 'TST'), false);
    for (const phase of ['awaiting_departure', 'taxiing_to_runway', 'landed', 'taxiing_to_gate', 'arrived']) assert.equal(isOwnFlight(flight({ phase }), 'TST'), false, phase);
    assert.equal(isOwnFlight(flight({ onGround: true }), 'TST'), false, 'a flight in a flying phase that is on the ground is not flying');
    for (const etaMinutes of [null, -1, 17689, Number.NaN]) assert.equal(isOwnFlight(flight({ etaMinutes }), 'TST'), false, String(etaMinutes));
    assert.equal(isOwnFlight(flight({ etaMinutes: 0 }), 'TST'), true, 'about to land is fine');
  });
});

describe('whether a flight is flying: the phase, and what the aircraft says', () => {
  it('follows a flight whose phase FsHub has not worked out (`calculating`) while the aircraft is off the ground: a long-haul at 37,000 ft stayed in it for hours', () => {
    assert.equal(isOwnFlight(flight({ phase: 'calculating', onGround: false, etaMinutes: 128 }), 'TST'), true);
    assert.equal(isFlying('calculating', false), true);
  });

  it('does not follow it while the aircraft is on the ground, or does not say', () => {
    assert.equal(isOwnFlight(flight({ phase: 'calculating', onGround: true }), 'TST'), false);
    assert.equal(isOwnFlight(flight({ phase: 'calculating', onGround: null }), 'TST'), false, 'not told by the name, and the aircraft does not say');
    assert.equal(isFlying('calculating', true), false);
    assert.equal(isFlying('calculating', null), false);
  });

  it('follows a phase it has never heard of when the aircraft is off the ground, and not when it is not', () => {
    for (const phase of ['go_around', 'holding', 'diverting', 'something_new']) {
      assert.equal(isFlying(phase, false), true, phase);
      assert.equal(isFlying(phase, true), false, phase);
      assert.equal(isFlying(phase, null), false, phase);
    }
    assert.equal(isFlying(null, false), true, 'no phase at all, off the ground');
    assert.equal(isFlying(null, null), false);
  });

  it('never calls a phase of the ground flying, whatever the aircraft says', () => {
    for (const phase of ['awaiting_departure', 'taxiing_to_runway', 'landed', 'taxiing_to_gate', 'arrived']) {
      assert.equal(isFlying(phase, false), false, phase);
      assert.equal(isFlying(phase, null), false, phase);
    }
  });

  it('calls a phase of the air flying unless the aircraft is on the ground', () => {
    for (const phase of ['take_off', 'climbing', 'level_flight', 'cruise', 'descending', 'on_approach', 'approach']) {
      assert.equal(isFlying(phase, false), true, phase);
      assert.equal(isFlying(phase, null), true, phase);
      assert.equal(isFlying(phase, true), false, phase);
    }
  });

  it('takes a flight filed under the airline\'s number even when the pilot flies under a callsign of their own', () => {
    assert.equal(isOwnFlight(flight({ callsign: 'MYMATE', flightNo: 'TST123' }), 'TST'), true);
    assert.equal(isOwnFlight(flight({ callsign: 'MYMATE', flightNo: 'DLH408' }), 'TST'), false);
    assert.equal(isOwnFlight(flight({ callsign: 'MYMATE', flightNo: null }), 'TST'), false);
    assert.equal(isOwnFlight(flight({ callsign: 'TST123', flightNo: 'MYMATE' }), 'TST'), true, 'either one');
  });
});

/* ------------------------------------------------------------------ which flight on the panel it is */

describe('which flight of the panel a live flight is', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
  });
  afterEach(async () => {
    await h.close();
  });
  const views = () => h.store.listOpenJobViews(h.panel.id);
  const codeOf = (key: string) => views().find((v) => v.job.sourceKey === key)!.job.code;
  const idOf = (key: string) => views().find((v) => v.job.sourceKey === key)!.job.id;
  const pick = (f: AirlineFlight) => matchFlight(f, views(), NOW);

  it('is the one with a leg between the plan\'s two airports', () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK'), sj('b', 'EGKK-EGCC')]);
    assert.equal(pick(flight())!.view.job.code, codeOf('a'));
    assert.equal(pick(flight({ dep: 'egkk', arr: 'egcc' }))!.view.job.code, codeOf('b'), 'in any case');
    assert.equal(pick(flight({ dep: 'EGLL', arr: 'EGCC' })), null, 'a route no flight of the panel has');
    assert.equal(pick(flight({ dep: 'EGKK', arr: 'EGLL' })), null, 'the other way round is another route');
  });

  it('says which leg of a longer flight is being flown', () => {
    h.jobs.sync(h.panel.id, [sj('m', 'EGLL-EGKK-EGCC')]);
    assert.deepEqual({ leg: pick(flight({ dep: 'EGKK', arr: 'EGCC' }))!.legNo, first: pick(flight())!.legNo }, { leg: 2, first: 1 });
  });

  it('settles two flights of the same route by the callsign, when it is the flight\'s number', () => {
    h.jobs.sync(h.panel.id, [sj('x', 'EGLL-EGKK', { flightNumber: 'TST123' }), sj('y', 'EGLL-EGKK', { flightNumber: 'TST456' })]);
    assert.equal(pick(flight({ callsign: 'TST456' }))!.view.job.code, 'TST456');
    assert.equal(pick(flight({ callsign: 'TST123' }))!.view.job.code, 'TST123');
  });

  it('settles two flights of the same route by the landing window the landing falls in', () => {
    h.jobs.sync(h.panel.id, [
      sj('today', 'EGLL-EGKK', { availableFrom: NOW, deadline: NOW + 4 * HOUR }),
      sj('tomorrow', 'EGLL-EGKK', { availableFrom: NOW + 24 * HOUR, deadline: NOW + 28 * HOUR }),
    ]);
    assert.equal(pick(flight())!.view.job.code, codeOf('today'));
    assert.equal(pick(flight({ etaMinutes: 24 * 60 }))!.view.job.code, codeOf('tomorrow'));
  });

  it('settles two flights that both fit by the pilot who holds one (by FsHub ID), and guesses neither otherwise', () => {
    h.jobs.sync(h.panel.id, [sj('p', 'EGLL-EGKK'), sj('q', 'EGLL-EGKK')]);
    assert.equal(pick(flight()), null, 'nothing says which');
    h.store.setPilotId(USER_A.discordId, 7001, NOW);
    h.jobs.reserve(idOf('q'), [1], USER_A);
    assert.equal(pick(flight({ pilotId: 7001 }))!.view.job.code, codeOf('q'));
    assert.equal(pick(flight({ pilotId: 7002 })), null, 'someone else flying the route is not the holder');
    assert.equal(pick(flight({ pilotId: null })), null);
  });

  it('falls back to the pilot who holds it when the landing fits none of the windows (a flight that is very late or early)', () => {
    h.jobs.sync(h.panel.id, [
      sj('far1', 'EGLL-EGKK', { availableFrom: NOW + 48 * HOUR, deadline: NOW + 52 * HOUR }),
      sj('far2', 'EGLL-EGKK', { availableFrom: NOW + 72 * HOUR, deadline: NOW + 76 * HOUR }),
    ]);
    assert.equal(pick(flight()), null, 'neither fits, and nothing says which');
    h.store.setPilotId(USER_A.discordId, 7001, NOW);
    h.jobs.reserve(idOf('far2'), [1], USER_A);
    assert.equal(pick(flight())!.view.job.code, codeOf('far2'));
  });

  it('does not use a flight that is already completed', () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
    const [view] = views();
    assert.equal(matchFlight(flight(), [{ ...view!, job: { ...view!.job, completedAt: NOW - HOUR } }], NOW), null);
  });
});

/* ------------------------------------------------------------------ following them */

class FakeFeed {
  flights: AirlineFlight[] = [];
  failing = false;
  calls: string[] = [];
  async airlineFlights(abbr: string) {
    this.calls.push(abbr);
    if (this.failing) throw new LiveFeedError('down');
    return this.flights;
  }
}

describe('when the flights in the air are expected to land', () => {
  let h: Harness;
  let feed: FakeFeed;
  let redraws: number[];
  let etas: FlightEtas;
  const pid = () => h.panel.id;
  const idOf = (key: string) => h.store.listOpenJobViews(pid()).find((v) => v.job.sourceKey === key)!.job.id;
  const minute = async (n = 1) => {
    h.clock.advance(n * MIN);
    await etas.run();
  };
  const shown = (key: string): FlightEta | undefined => etas.forPanel(pid()).get(idOf(key));

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    feed = new FakeFeed();
    redraws = [];
    etas = new FlightEtas({ store: h.store, feed: feed as unknown as LiveFeed, panels: { schedule: (id) => void redraws.push(id) }, now: () => h.clock.now });
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { availableFrom: NOW, deadline: NOW + 6 * HOUR }), sj('m', 'EGKK-EGCC-EGPH', { availableFrom: NOW, deadline: NOW + 6 * HOUR })]);
  });
  afterEach(async () => {
    await h.close();
  });

  it('takes the airline\'s short name as the callsign code when the panel has one, and the start of its flight IDs when it has not', async () => {
    assert.equal(callsignCode({ airlineAbbr: 'sky ', prefix: 'XYZ' }), 'SKY');
    assert.equal(callsignCode({ airlineAbbr: null, prefix: 'sky' }), 'SKY');
    assert.equal(callsignCode({ airlineAbbr: '  ', prefix: 'SKY' }), 'SKY');
  });

  it('follows a panel that has no short name by the prefix of its flight IDs (how a real panel is set up), and asks the feed for that', async () => {
    const bare = h.store.createPanel({ guildId: '900000000000000009', name: 'Sky Air', prefix: 'SKY', channelId: '700000000000000009', now: T0 });
    assert.equal(bare.airlineAbbr, null);
    h.store.updatePanel(pid(), { liveTracking: false });
    h.jobs.sync(bare.id, [sj('w', 'KMSY-KMIA', { availableFrom: NOW, deadline: NOW + 6 * HOUR })]);
    feed.flights = [flight({ callsign: 'SKY290', dep: 'KMSY', arr: 'KMIA' }), flight({ flightId: 'x', callsign: 'TST123', dep: 'KMSY', arr: 'KMIA', pilotId: 1 })];
    await etas.run();
    assert.deepEqual(feed.calls, ['SKY']);
    assert.deepEqual(etas.airborne(bare.id).map((e) => e.callsign), ['SKY290'], 'only the airline\'s own callsign');
  });

  it('shows the landing time of a flight whose phase is still `calculating` hours in (the aircraft is off the ground, 37,000 ft)', async () => {
    feed.flights = [flight({ phase: 'calculating', onGround: false, etaMinutes: 128 })];
    await etas.run();
    const e = shown('a');
    assert.ok(e, 'it is followed');
    assert.equal(e!.etaAt, NOW + 128 * MIN);
    assert.deepEqual(redraws, [pid()], 'and the panel is redrawn to show it');
  });

  it('does not show a `calculating` flight that is on the ground, as before', async () => {
    feed.flights = [flight({ phase: 'calculating', onGround: true, etaMinutes: 128 })];
    await etas.run();
    assert.equal(shown('a'), undefined);
  });

  it('follows a flight whose callsign is the pilot\'s own when its plan carries the airline\'s number', async () => {
    feed.flights = [flight({ callsign: 'MYMATE', flightNo: 'TST123' })];
    await etas.run();
    assert.ok(shown('a'));
  });

  it('shows the time a flight in the air is expected to land, and has the panel redrawn', async () => {
    feed.flights = [flight({ etaMinutes: 37 })];
    await etas.run();
    const e = shown('a')!;
    assert.equal(e.etaAt, NOW + 37 * MIN);
    assert.deepEqual({ code: e.code, route: `${e.dep}-${e.arr}`, callsign: e.callsign, legNo: e.legNo, legs: e.legs }, { code: h.store.getJob(idOf('a'))!.code, route: 'EGLL-EGKK', callsign: 'TST123', legNo: 1, legs: 1 });
    assert.deepEqual(redraws, [pid()]);
    assert.deepEqual(etas.airborne(pid()).map((x) => x.jobId), [idOf('a')]);
  });

  it('says which leg of a longer flight is in the air', async () => {
    feed.flights = [flight({ dep: 'EGCC', arr: 'EGPH', callsign: 'TST9' })];
    await etas.run();
    assert.deepEqual({ leg: shown('m')!.legNo, legs: shown('m')!.legs }, { leg: 2, legs: 2 });
  });

  it('ignores a pilot of the airline flying under another callsign, or with no flight plan, as if they were not there', async () => {
    feed.flights = [flight({ callsign: 'DLH408' }), flight({ callsign: null, dep: null, arr: null, flightId: 'g' })];
    await etas.run();
    assert.equal(shown('a'), undefined);
    assert.deepEqual(redraws, []);
  });

  it('asks the feed once for the airline however many panels it has, and no more than about once a minute', async () => {
    const second = h.store.createPanel({ guildId: '900000000000000002', name: 'Test Air', abbr: 'TST', prefix: 'TST', channelId: '700000000000000002', now: T0 });
    h.jobs.sync(second.id, [sj('a', 'EGLL-EGKK', { availableFrom: NOW, deadline: NOW + 6 * HOUR })]);
    feed.flights = [flight()];
    await etas.run();
    assert.deepEqual(feed.calls, ['TST']);
    assert.equal(etas.forPanel(second.id).size, 1, 'the other panel shows it too');
    await etas.run();
    await minute(0.5);
    assert.equal(feed.calls.length, 1, 'not asked again inside the minute');
    await minute(1);
    assert.equal(feed.calls.length, 2);
  });

  it('leaves the time alone while the estimate wobbles, and moves it when it has really changed', async () => {
    feed.flights = [flight({ etaMinutes: 60 })];
    await etas.run();
    const first = shown('a')!.etaAt;
    redraws.length = 0;
    feed.flights = [flight({ etaMinutes: 58 })]; // a minute on, two minutes less to go: the same landing
    await minute();
    assert.equal(shown('a')!.etaAt, first);
    assert.equal(shown('a')!.liveEtaAt, h.clock.now + 58 * MIN, 'someone who asks still gets the newest');
    assert.deepEqual(redraws, [], 'no redraw');
    feed.flights = [flight({ etaMinutes: 50 })]; // a real change, but too soon after the last move
    await minute();
    assert.equal(shown('a')!.etaAt, first);
    await minute(5); // five minutes on, the estimate is still some minutes off what the panel shows, so now it moves
    assert.equal(shown('a')!.etaAt, h.clock.now + 50 * MIN);
    assert.deepEqual(redraws, [pid()]);
    // Long after a move, a small wobble is still not worth a redraw.
    const moved = shown('a')!.etaAt;
    redraws.length = 0;
    feed.flights = [flight({ etaMinutes: 44 })]; // six minutes on: 44 more minutes is one minute later than the panel's time
    await minute(6);
    assert.equal(shown('a')!.etaAt, moved);
    assert.deepEqual(redraws, []);
  });

  it('follows a flight of several legs from one leg to the next at once', async () => {
    feed.flights = [flight({ dep: 'EGKK', arr: 'EGCC', callsign: 'TST9' })];
    await etas.run();
    assert.deepEqual({ leg: shown('m')!.legNo, arr: shown('m')!.arr }, { leg: 1, arr: 'EGCC' });
    redraws.length = 0;
    feed.flights = [flight({ dep: 'EGCC', arr: 'EGPH', callsign: 'TST9', etaMinutes: 50 })];
    await minute();
    assert.deepEqual({ leg: shown('m')!.legNo, arr: shown('m')!.arr, at: shown('m')!.etaAt }, { leg: 2, arr: 'EGPH', at: h.clock.now + 50 * MIN });
    assert.deepEqual(redraws, [pid()]);
  });

  it('takes a flight off after the feed stops showing it twice (landed), not on a single gap', async () => {
    feed.flights = [flight()];
    await etas.run();
    redraws.length = 0;
    feed.flights = [];
    await minute();
    assert.ok(shown('a'), 'one missed look is not enough');
    assert.deepEqual(redraws, []);
    feed.flights = [flight()];
    await minute();
    feed.flights = [];
    await minute();
    assert.ok(shown('a'), 'and a flight that came back starts counting again');
    await minute();
    assert.equal(shown('a'), undefined);
    assert.deepEqual(redraws, [pid()]);
  });

  it('keeps what it knew for a few minutes when the feed is down, and then stops showing it', async () => {
    feed.flights = [flight()];
    await etas.run();
    feed.failing = true;
    await minute();
    await minute();
    assert.ok(shown('a'), 'a short outage changes nothing');
    redraws.length = 0;
    await minute(3);
    assert.equal(shown('a'), undefined, 'but a long one does not leave an old time on the card');
    assert.deepEqual(redraws, [pid()]);
  });

  it('does nothing for a panel that has live tracking off or no airline code, and forgets what it showed', async () => {
    feed.flights = [flight()];
    await etas.run();
    assert.ok(shown('a'));
    redraws.length = 0;
    h.store.updatePanel(pid(), { liveTracking: false });
    await minute(2);
    assert.equal(shown('a'), undefined);
    assert.deepEqual(redraws, [pid()]);
    const calls = feed.calls.length;
    await minute(2);
    assert.equal(feed.calls.length, calls, 'and the feed is not asked about it');
  });

  it('uses neither of two flights in the air that could be the same panel flight, unless one is its pilot\'s', async () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { availableFrom: NOW, deadline: NOW + 6 * HOUR })]);
    feed.flights = [flight({ flightId: 'f1', pilotId: 7001, callsign: 'TST1' }), flight({ flightId: 'f2', pilotId: 7002, callsign: 'TST2', etaMinutes: 90 })];
    await etas.run();
    assert.equal(shown('a'), undefined);
    h.store.setPilotId(USER_B.discordId, 7002, NOW);
    h.jobs.reserve(idOf('a'), [1], USER_B);
    await minute();
    assert.equal(shown('a')!.callsign, 'TST2');
  });
});

/* ------------------------------------------------------------------ on the card, and /eta */

describe('showing it', () => {
  let h: Harness;
  let d: DiscordHarness;
  let etas: FlightEtas;
  let feed: FakeFeed;
  const pid = () => h.panel.id;
  const views = () => h.store.listOpenJobViews(pid());
  const fieldsOf = (embed: { toJSON(): { fields?: Array<{ name: string; value: string }> } }) => embed.toJSON().fields ?? [];

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    d = makeDiscordHarness(h);
    feed = new FakeFeed();
    etas = new FlightEtas({ store: h.store, feed: feed as unknown as LiveFeed, panels: { schedule: () => undefined }, now: () => h.clock.now });
    d.ctx.etas = etas;
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { availableFrom: NOW, deadline: NOW + 6 * HOUR }), sj('m', 'EGKK-EGCC-EGPH', { availableFrom: NOW, deadline: NOW + 6 * HOUR }), sj('z', 'LFPG-EHAM', { availableFrom: NOW, deadline: NOW + 6 * HOUR })]);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const eta = (key: string, over: Partial<FlightEta> = {}): FlightEta => {
    const v = views().find((x) => x.job.sourceKey === key)!;
    return { panelId: pid(), jobId: v.job.id, code: v.job.code, legNo: 1, legs: v.legs.length, dep: 'EGLL', arr: 'EGKK', callsign: 'TST123', etaAt: NOW + 37 * MIN, liveEtaAt: NOW + 37 * MIN, ...over };
  };

  describe('on the flight\'s card', () => {
    it('adds a LANDS box with the time and how long from now, only for a flight that has an estimate', () => {
      const v = views().find((x) => x.job.sourceKey === 'a')!;
      const withEta = fieldsOf(openCard(v, NOW, undefined, { eta: eta('a') }));
      const box = withEta.find((f) => f.name === 'LANDS')!;
      assert.equal(box.value, `<t:${Math.floor((NOW + 37 * MIN) / 1000)}:t>\n<t:${Math.floor((NOW + 37 * MIN) / 1000)}:R>`);
      assert.equal(fieldsOf(openCard(v, NOW)).some((f) => f.name.startsWith('LANDS')), false);
      assert.equal(fieldsOf(openCard(v, NOW, undefined, { eta: null })).some((f) => f.name.startsWith('LANDS')), false);
    });

    it('names the leg for a flight of several', () => {
      const v = views().find((x) => x.job.sourceKey === 'm')!;
      assert.ok(fieldsOf(openCard(v, NOW, undefined, { eta: eta('m', { legNo: 2, dep: 'EGKK', arr: 'EGCC' }) })).some((f) => f.name === 'LANDS · LEG 2'));
    });

    it('is on the panel for the flights that have one, and only those', () => {
      const parts = renderPanelParts(h.panel, views(), NOW, [], undefined, false, 0, undefined, new Map([[eta('a').jobId, eta('a')]]));
      const cards = parts.open.flat().filter((c) => (c.toJSON().title ?? '').includes('·') || (c.toJSON().title ?? '').startsWith('TST'));
      const withBox = cards.filter((c) => fieldsOf(c).some((f) => f.name.startsWith('LANDS')));
      assert.equal(withBox.length, 1);
      assert.match(withBox[0]!.toJSON().title ?? '', new RegExp(eta('a').code));
    });
  });

  describe('/eta', () => {
    const run = async (options: Record<string, unknown> = {}, guildId?: string | null) => {
      const f = fakeInteraction({ options, ...(guildId !== undefined ? { guildId } : {}) });
      let error: Error | null = null;
      try {
        await etaCommand.execute(d.ctx, f.i);
      } catch (e) {
        error = e as Error;
      }
      return { text: String(f.calls.edits.at(-1)?.content ?? ''), defers: f.calls.defers, error };
    };
    const inAir = async (...flights: AirlineFlight[]) => {
      feed.flights = flights;
      await etas.run();
    };

    it('lists the flights in the air, soonest landing first, privately unless asked to share', async () => {
      await inAir(flight({ etaMinutes: 90 }), flight({ flightId: 'f2', dep: 'EGKK', arr: 'EGCC', callsign: 'TST2', pilotId: 7002, etaMinutes: 20 }));
      const { text, defers } = await run();
      assert.equal(defers[0].flags !== undefined, true, 'ephemeral');
      assert.match(text, /2 flights in the air/);
      assert.ok(text.indexOf('EGKK → EGCC') < text.indexOf('EGLL → EGKK'), 'soonest first');
      assert.match(text, /leg 1 of 2/);
      assert.match(text, new RegExp(`<t:${Math.floor((NOW + 20 * MIN) / 1000)}:t> \\(<t:${Math.floor((NOW + 20 * MIN) / 1000)}:R>\\)`));
      assert.equal((await run({ share: true })).defers[0]?.flags, undefined, 'a shared answer is not ephemeral');
    });

    it('says plainly when nothing is in the air, and what a flight needs to be followed', async () => {
      const { text } = await run();
      assert.match(text, /no flight is in the air that I can follow/);
      assert.match(text, /own callsign \(like `TST123`\) and a flight plan/);
      assert.match(text, /A flight with no flight plan has no landing time to show\./);
    });

    it('answers for one flight by its ID, in any form of it', async () => {
      await inAir(flight());
      const code = views().find((v) => v.job.sourceKey === 'a')!.job.code;
      for (const typed of [code, code.toLowerCase(), code.replace('-', ' ')]) {
        const { text } = await run({ flight: typed });
        assert.match(text, new RegExp(`\\*\\*${code}\\*\\* EGLL → EGKK is in the air: lands about`), typed);
        assert.match(text, /TST123/);
      }
    });

    it('says a flight that is not in the air is not, and a flight it has never heard of is unknown', async () => {
      await inAir(flight());
      const idle = views().find((v) => v.job.sourceKey === 'z')!.job.code;
      assert.match((await run({ flight: idle })).text, new RegExp(`\\*\\*${idle}\\*\\* is not in the air as far as I can tell`));
      assert.match((await run({ flight: 'NOPE-999' })).text, /I don't know an open flight called \*\*NOPE-999\*\*/);
    });

    it('says what is wrong when live tracking is off, or the panel has no airline code, or there is no panel', async () => {
      h.store.updatePanel(pid(), { liveTracking: false });
      assert.match((await run()).error?.message ?? '', /not following flights live here/);
      h.store.updatePanel(pid(), { liveTracking: true });
      d.ctx.etas = null;
      assert.match((await run()).error?.message ?? '', /not following flights live here/);
      d.ctx.etas = etas;
      assert.match((await run({}, '123456789012345678')).error?.message ?? '', /no flight panel yet/);
    });

    it('does not answer for a panel that does not follow flights live, even if something was left for it', async () => {
      const quiet = h.store.createPanel({ guildId: h.panel.guildId, name: 'Quiet Air', abbr: 'QUI', prefix: 'QUI', channelId: '700000000000000003', now: T0 });
      h.store.updatePanel(quiet.id, { liveTracking: false });
      h.jobs.sync(quiet.id, [sj('q', 'EGLL-EGKK', { availableFrom: NOW, deadline: NOW + 6 * HOUR })]);
      const qv = h.store.listOpenJobViews(quiet.id)[0]!;
      const stale: FlightEta = { panelId: quiet.id, jobId: qv.job.id, code: qv.job.code, legNo: 1, legs: 1, dep: 'EGLL', arr: 'EGKK', callsign: 'QUI1', etaAt: NOW + MIN, liveEtaAt: NOW + MIN };
      d.ctx.etas = { forPanel: () => new Map([[qv.job.id, stale]]), airborne: () => [stale] } as unknown as FlightEtas;
      const { text } = await run({ flight: qv.job.code });
      assert.match(text, /isn't following flights live/);
      assert.doesNotMatch(text, /is in the air/);
    });

    it('never shows a flight of another server\'s panel', async () => {
      const other = h.store.createPanel({ guildId: '900000000000000002', name: 'Other Air', abbr: 'OTH', prefix: 'OTH', channelId: '700000000000000002', now: T0 });
      h.jobs.sync(other.id, [sj('o', 'EGLL-EGKK', { availableFrom: NOW, deadline: NOW + 6 * HOUR })]);
      feed.flights = [flight({ callsign: 'OTH55' })];
      await etas.run();
      assert.ok(etas.airborne(other.id).length === 1);
      assert.match((await run()).text, /no flight is in the air/);
    });
  });
});
