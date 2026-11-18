import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commands } from '../src/discord/commands/index.js';
import { UserError } from '../src/discord/errors.js';
import { FsHubError, type FsHubFlight } from '../src/fshub/client.js';
import { LIVE_FEED, LiveFeed, LiveFeedError, type LivePilot } from '../src/fshub/liveFeed.js';
import { backupWarning, DepartureWarnings, pilotWarning } from '../src/services/departureWarnings.js';
import type { FlightTime } from '../src/services/flightTime.js';
import { LIVE_STALE_MS, LiveTracker, type LiveStatus } from '../src/services/liveTracker.js';
import { Scheduler } from '../src/services/scheduler.js';
import { ts } from '../src/util/format.js';
import { HOUR, T0, USER_A, USER_B, USER_C, makeHarness, sj, type Harness } from './helpers.js';
import { FakeFsHub, FakeUser, fakeInteraction, makeDiscordHarness, settle, type DiscordHarness, type FakeInteractionOptions } from './discord-helpers.js';

/* Everything below is made up: the pilots, the airline and the flights. */

const MIN = 60_000;
const AIRLINE_ID = 8123;
const NOW = T0 + 6 * HOUR;
const setup = commands.find((c) => c.data.name === 'setup')!;

/* ------------------------------------------------------------------ the feed's client */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the live feed client', () => {
  let calls: Array<{ url: string; headers: Record<string, string> }>;
  let reply: (url: string) => Response;
  let feed: LiveFeed;
  let now: number;
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return reply(String(input));
  };

  beforeEach(() => {
    calls = [];
    now = 1_000_000;
    reply = () => json({}, 404);
    feed = new LiveFeed({ fetchFn: fakeFetch, userAgent: 'FlightPanelBot/test', now: () => now });
  });

  it('lists the pilots online, by FsHub ID, and asks nothing else of anyone', async () => {
    reply = () => json({ pilots: [{ id: 1001, name: 'A', flight_id: 'x' }, { id: 1002, name: 'B', flight_id: 'y' }], total: 2 });
    assert.deepEqual([...(await feed.onlinePilotIds())].sort(), [1001, 1002]);
    assert.equal(calls[0]!.url, `${LIVE_FEED}/pilots`);
    assert.equal(calls[0]!.headers['user-agent'], 'FlightPanelBot/test');
    assert.equal(calls[0]!.headers['authorization'], undefined, 'no token goes anywhere');
  });

  it('reads one pilot\'s flight: in the air, the phase, and the plan\'s airports when there is one', async () => {
    reply = () =>
      json({
        pilot_id: 1001,
        pilot: { id: 1001, name: 'Someone' },
        is_airborne: true,
        active_flight: { id: 'abc', phase: 'cruise', position: { on_ground: false, lat: 1, lng: 2 }, plan: { departure: 'egll', arrival: 'EGKK', route: 'DCT' } },
      });
    const p = (await feed.pilot(1001))!;
    assert.deepEqual(p, { pilotId: 1001, airborne: true, flight: { flightId: 'abc', phase: 'cruise', onGround: false, dep: 'EGLL', arr: 'EGKK' } });
    assert.equal(calls[0]!.url, `${LIVE_FEED}/pilot/1001`);
  });

  it('says on the ground when it is, and has no airports when no plan was filed', async () => {
    reply = () => json({ pilot_id: 7, is_airborne: false, active_flight: { id: 9, phase: 'taxiing_to_runway', position: { on_ground: true }, plan: { departure: '', arrival: null } } });
    assert.deepEqual(await feed.pilot(7), { pilotId: 7, airborne: false, flight: { flightId: '9', phase: 'taxiing_to_runway', onGround: true, dep: null, arr: null } });
  });

  it('reads a flight whose plan and airline are `false`, which is how FsHub says a flight has none (most flights)', async () => {
    // The shape FsHub's live service sends (made-up pilot): `plan: false`, `airline: false`, no flight plan filed.
    reply = () =>
      json({
        pilot_id: 5,
        pilot: { id: 5, name: 'Made Up', avatar_url: 'https://example.invalid/a.png', profile_url: 'https://example.invalid/p' },
        is_airborne: true,
        active_flight: {
          id: 'f5',
          phase: 'level_flight',
          joinfs: false,
          position: { lat: 1, lng: 2, altitude_ft: 30000, heading: 90, speed_tas_kts: 450, on_ground: false, squawk: '0000' },
          aircraft: { icao: 'B738' },
          pilot: { id: 5, name: 'Made Up' },
          airline: false,
          plan: false,
          last_seen: '2026-11-17T04:30:05Z',
        },
      });
    assert.deepEqual(await feed.pilot(5), { pilotId: 5, airborne: true, flight: { flightId: 'f5', phase: 'level_flight', onGround: false, dep: null, arr: null } });
  });

  it('is not thrown by any other part of a flight being false, or the flight itself being false', async () => {
    reply = () => json({ pilot_id: 5, is_airborne: false, active_flight: { id: 'f', phase: 'arrived', position: false, plan: false } });
    assert.deepEqual(await feed.pilot(5), { pilotId: 5, airborne: false, flight: { flightId: 'f', phase: 'arrived', onGround: null, dep: null, arr: null } });
    reply = () => json({ pilot_id: 5, is_airborne: false, active_flight: { id: 'g', phase: 'arrived', plan: [] } });
    assert.deepEqual((await feed.pilot(5))!.flight, { flightId: 'g', phase: 'arrived', onGround: null, dep: null, arr: null }, 'an empty list is no plan either');
    reply = () => json({ pilot_id: 5, is_airborne: false, active_flight: false });
    assert.deepEqual(await feed.pilot(5), { pilotId: 5, airborne: false, flight: null });
    reply = () => json({ pilot_id: 5, is_airborne: false, active_flight: { phase: 'arrived' } });
    await assert.rejects(feed.pilot(5), (e: unknown) => e instanceof LiveFeedError, 'a flight with no ID is still nonsense');
  });

  it('counts the take-off and the approach as the air, in FsHub\'s newer phase names, when it does not say outright', async () => {
    for (const phase of ['take_off', 'on_approach']) {
      reply = () => json({ pilot_id: 7, active_flight: { id: 'a', phase, position: { on_ground: false } } });
      assert.equal((await feed.pilot(7))!.airborne, true, phase);
    }
    for (const phase of ['calculating', 'awaiting_departure', 'taxiing_to_runway', 'landed', 'taxiing_to_gate', 'arrived']) {
      reply = () => json({ pilot_id: 7, active_flight: { id: 'a', phase, position: { on_ground: false } } });
      assert.equal((await feed.pilot(7))!.airborne, false, phase);
    }
  });

  it('works out the air from the phase when the feed does not say, and never calls a flight on the ground airborne', async () => {
    reply = () => json({ pilot_id: 7, active_flight: { id: 'a', phase: 'climbing', position: { on_ground: false } } });
    assert.equal((await feed.pilot(7))!.airborne, true);
    reply = () => json({ pilot_id: 7, active_flight: { id: 'a', phase: 'climbing', position: { on_ground: true } } });
    assert.equal((await feed.pilot(7))!.airborne, false);
    reply = () => json({ pilot_id: 7, active_flight: { id: 'a', phase: 'awaiting_departure', position: { on_ground: false } } });
    assert.equal((await feed.pilot(7))!.airborne, false, 'a phase of the ground is not the air');
    reply = () => json({ pilot_id: 7, is_airborne: true, active_flight: null });
    assert.deepEqual(await feed.pilot(7), { pilotId: 7, airborne: false, flight: null }, 'in the air with no flight is not believed');
  });

  describe('one pilot\'s flight in detail (for a stream\'s chat)', () => {
    const full = {
      pilot_id: 7,
      is_airborne: true,
      active_flight: {
        id: 'abc',
        phase: 'cruise',
        position: { lat: 1, lng: 2, altitude_ft: 37_012, speed_tas_kts: 461, heading: 149, on_ground: false },
        aircraft: { icao: 'a320' },
        plan: { callsign: 'tst517', flight_no: 'TST517', departure: 'vhhh', arrival: 'kord' },
        eta_minutes: 125,
        distance_nm: 3000,
        progress: 48,
        flight_status: 'on-time',
      },
    };

    it('reads the aircraft, the figures and the plan, tidied', async () => {
      reply = () => json(full);
      assert.deepEqual(await feed.pilotDetail(7), {
        flightId: 'abc',
        phase: 'cruise',
        airborne: true,
        onGround: false,
        aircraftIcao: 'A320',
        callsign: 'TST517',
        dep: 'VHHH',
        arr: 'KORD',
        altitudeFt: 37_012,
        speedKts: 461,
        headingDeg: 149,
        distanceToGoNm: 3000,
        progressPct: 48,
        etaMinutes: 125,
        flightStatus: 'ON-TIME',
      });
      assert.equal(calls[0]!.url, `${LIVE_FEED}/pilot/7`);
    });

    it('copes with the parts a flight without a plan does not have, and with odd values', async () => {
      reply = () => json({ pilot_id: 7, is_airborne: false, active_flight: { id: 'f', phase: 'taxiing_to_runway', position: { on_ground: true }, aircraft: { icao: 'a b!' }, plan: false, airline: false, progress: 250, eta_minutes: 'soon', distance_nm: null } });
      const d = await feed.pilotDetail(7);
      assert.deepEqual(d, {
        flightId: 'f',
        phase: 'taxiing_to_runway',
        airborne: false,
        onGround: true,
        aircraftIcao: null,
        callsign: null,
        dep: null,
        arr: null,
        altitudeFt: null,
        speedKts: null,
        headingDeg: null,
        distanceToGoNm: null,
        progressPct: 100,
        etaMinutes: null,
        flightStatus: null,
      });
    });

    it('keeps the progress between none and all of the way', async () => {
      reply = () => json({ ...full, active_flight: { ...full.active_flight, progress: 250 } });
      assert.equal((await feed.pilotDetail(7))!.progressPct, 100);
      reply = () => json({ ...full, active_flight: { ...full.active_flight, progress: -5 } });
      assert.equal((await feed.pilotDetail(7))!.progressPct, 0);
    });

    it('works out whether it is in the air from the phase when the feed does not say', async () => {
      reply = () => json({ pilot_id: 7, active_flight: { id: 'a', phase: 'climbing', position: { on_ground: false } } });
      assert.equal((await feed.pilotDetail(7))!.airborne, true);
      reply = () => json({ pilot_id: 7, active_flight: { id: 'a', phase: 'awaiting_departure', position: { on_ground: false } } });
      assert.equal((await feed.pilotDetail(7))!.airborne, false);
    });

    it('says nothing is flying for a pilot with no flight, one not found, or a number that cannot be a pilot, without asking for the last', async () => {
      reply = () => json({ pilot_id: 7, is_airborne: false, active_flight: false });
      assert.equal(await feed.pilotDetail(7), null);
      reply = () => json({ error: 'not found' }, 404);
      assert.equal(await feed.pilotDetail(7), null);
      calls.length = 0;
      for (const bad of [0, -1, 1.5, Number.NaN]) assert.equal(await feed.pilotDetail(bad), null);
      assert.equal(calls.length, 0, 'nothing was asked');
    });

    it('fails clearly when the feed is down or sends something it cannot read', async () => {
      reply = () => json({}, 500);
      await assert.rejects(feed.pilotDetail(7), (e: unknown) => e instanceof LiveFeedError);
      reply = () => json({ pilot_id: 'seven' });
      await assert.rejects(feed.pilotDetail(7), (e: unknown) => e instanceof LiveFeedError);
    });
  });

  it('treats a pilot with no flight (a 404) as not flying, not as a failure', async () => {
    reply = () => json({ error: 'pilot not found or has no active flights' }, 404);
    assert.equal(await feed.pilot(1001), null);
  });

  it('does not ask for something that is not a pilot ID', async () => {
    assert.equal(await feed.pilot(0), null);
    assert.equal(await feed.pilot(-3), null);
    assert.equal(await feed.pilot(1.5), null);
    assert.equal(calls.length, 0);
  });

  it('fails clearly when the feed is down, slow, or talking nonsense', async () => {
    reply = () => json({}, 500);
    await assert.rejects(feed.onlinePilotIds(), (e: unknown) => e instanceof LiveFeedError && /answered 500/.test(e.message));
    reply = () => new Response('<html>', { status: 200 });
    await assert.rejects(feed.pilot(1), (e: unknown) => e instanceof LiveFeedError && /did not send JSON/.test(e.message));
    reply = () => json({ pilots: 'many' });
    await assert.rejects(feed.onlinePilotIds(), (e: unknown) => e instanceof LiveFeedError);
    reply = () => json({ nothing: true });
    await assert.rejects(feed.pilot(1), (e: unknown) => e instanceof LiveFeedError);
    const down = new LiveFeed({ fetchFn: async () => Promise.reject(new TypeError('fetch failed')) });
    await assert.rejects(down.pilot(1), (e: unknown) => e instanceof LiveFeedError && /could not be reached/.test(e.message));
    reply = () => new Response('x', { status: 200, headers: { 'content-length': '999999999' } });
    await assert.rejects(feed.pilot(1), (e: unknown) => e instanceof LiveFeedError && /far more/.test(e.message));
  });

  it('holds itself to a ceiling of requests a minute', async () => {
    reply = () => json({ pilots: [] });
    for (let i = 0; i < 90; i++) await feed.onlinePilotIds();
    await assert.rejects(feed.onlinePilotIds(), (e: unknown) => e instanceof LiveFeedError && /Too many/.test(e.message));
    now += 61_000;
    await assert.doesNotReject(feed.onlinePilotIds());
  });
});

/* ------------------------------------------------------------------ the tracker */

class FakeFeed {
  online = new Set<number>();
  pilots = new Map<number, LivePilot | null>();
  failList = false;
  failPilot = false;
  calls: string[] = [];
  async onlinePilotIds() {
    this.calls.push('online');
    if (this.failList) throw new LiveFeedError('down');
    return new Set(this.online);
  }
  async pilot(id: number) {
    this.calls.push(`pilot:${id}`);
    if (this.failPilot) throw new LiveFeedError('down');
    return this.pilots.get(id) ?? null;
  }
  fly(id: number, flight: Partial<NonNullable<LivePilot['flight']>> = {}) {
    this.online.add(id);
    this.pilots.set(id, { pilotId: id, airborne: true, flight: { flightId: 'f1', phase: 'cruise', onGround: false, dep: null, arr: null, ...flight } });
  }
  land(id: number) {
    this.pilots.set(id, { pilotId: id, airborne: false, flight: { flightId: 'f1', phase: 'arrived', onGround: true, dep: null, arr: null } });
  }
  disconnect(id: number) {
    this.online.delete(id);
    this.pilots.delete(id);
  }
}

describe('following pilots live', () => {
  let h: Harness;
  let d: DiscordHarness;
  let fshub: FakeFsHub;
  let feed: FakeFeed;
  let tracker: LiveTracker;
  let alice: FakeUser;
  let bob: FakeUser;
  let pid: number;
  let fid: number;

  const flown = (over: Partial<FsHubFlight> = {}): FsHubFlight => {
    const f: FsHubFlight = {
      id: ++fid,
      pilotId: 1001,
      pilotName: 'Alice Pilot',
      dep: 'EGLL',
      arr: 'EGKK',
      departedAt: NOW - 3 * HOUR,
      arrivedAt: NOW - 2 * HOUR,
      aircraftIcao: 'A320',
      aircraftName: 'Airbus A320',
      scheduleStatus: 'ON-TIME',
      ...over,
    };
    fshub.flights.set(AIRLINE_ID, [...(fshub.flights.get(AIRLINE_ID) ?? []), f]);
    return f;
  };
  const windowed = (key: string, chain: string, over: Record<string, unknown> = {}) => sj(key, chain, { availableFrom: T0, deadline: T0 + 12 * HOUR, ...over });
  const jobId = (key: string) => h.store.listJobs(pid).find((j) => j.sourceKey === key)!.id;
  const job = (key: string) => h.store.getJob(jobId(key))!;
  const panel = () => h.store.getPanel(pid)!;
  const hold = (key: string, user: FakeUser = alice) => h.jobs.reserve(jobId(key), [1], { discordId: user.id, username: user.username });
  let checks = 0;
  const build = (complete = true) => {
    checks = 0;
    tracker = new LiveTracker({
      store: h.store,
      feed: feed as unknown as LiveFeed,
      complete: complete ? (p, scope) => (checks++, d.ctx.autoComplete!.runPanel(p, scope)) : null,
      now: () => h.clock.now,
    });
  };
  const minute = async (n = 1) => {
    h.clock.advance(n * MIN);
    await tracker.run();
  };

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    fshub = new FakeFsHub();
    fid = 4_900_000;
    feed = new FakeFeed();
    d = makeDiscordHarness(h, { fshub });
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    pid = h.panel.id;
    h.store.updatePanel(pid, { fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Test Air' });
    h.jobs.sync(pid, [windowed('s', 'EGLL-EGKK', { aircraft: 'A320' }), windowed('t', 'EGKK-EGCC', { aircraft: 'B738' })]);
    build();
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  describe('who is flying', () => {
    it('says in the air, on the ground, or not online, for a pilot who holds a flight and whose FsHub ID is known', async () => {
      hold('s');
      assert.equal(tracker.statusOf(alice.id), null, 'nothing known before the first look');
      await tracker.run();
      assert.equal(tracker.statusOf(alice.id)!.state, 'offline');
      feed.fly(1001, { dep: 'EGLL', arr: 'EGKK', phase: 'climbing' });
      await minute();
      assert.deepEqual(tracker.statusOf(alice.id), { state: 'airborne', phase: 'climbing', dep: 'EGLL', arr: 'EGKK', flightId: 'f1', checkedAt: h.clock.now });
      feed.land(1001);
      await minute();
      assert.equal(tracker.statusOf(alice.id)!.state, 'ground');
    });

    it('follows only people who hold a flight, and knows nothing of anyone else', async () => {
      hold('s');
      await tracker.run();
      assert.equal(tracker.statusOf(bob.id), null, 'Bob holds nothing');
      assert.deepEqual(feed.calls, ['online'], 'and Alice is not online, so nothing more was asked');
      feed.fly(1001);
      feed.fly(1002);
      await minute();
      assert.deepEqual(feed.calls.slice(1), ['online', 'pilot:1001'], 'only the pilot who holds a flight is looked up');
    });

    it('asks nothing at all when nobody holds a flight', async () => {
      await tracker.run();
      assert.deepEqual(feed.calls, []);
    });

    it('does not follow a pilot whose FsHub ID is not known, or not trusted', async () => {
      const stranger = d.client.user(new FakeUser('555555555555555555', 'stranger'));
      h.jobs.reserve(jobId('t'), [1], { discordId: stranger.id, username: 'stranger' });
      await tracker.run();
      assert.equal(tracker.statusOf(stranger.id), null);
      assert.deepEqual(feed.calls, []);
    });

    it('does not follow a panel that has it switched off', async () => {
      hold('s');
      h.store.updatePanel(pid, { liveTracking: false });
      await tracker.run();
      assert.deepEqual(feed.calls, []);
    });

    it('asks the feed at most every 45 seconds', async () => {
      hold('s');
      feed.fly(1001);
      await tracker.run();
      h.clock.advance(30_000);
      await tracker.run();
      assert.equal(feed.calls.filter((c) => c === 'online').length, 1);
      h.clock.advance(16_000);
      await tracker.run();
      assert.equal(feed.calls.filter((c) => c === 'online').length, 2);
    });

    it('does not trust what it learned once the feed has been unreadable for three minutes, and says nothing wrong meanwhile', async () => {
      hold('s');
      feed.fly(1001);
      await tracker.run();
      feed.failList = true;
      await minute(2);
      assert.equal(tracker.statusOf(alice.id)!.state, 'airborne', 'a minute or two old is still believed');
      await minute(2);
      assert.equal(tracker.statusOf(alice.id), null);
      assert.ok(LIVE_STALE_MS === 3 * MIN);
      assert.equal(tracker.waiting, 0, 'and a failed read never counts as a landing');
    });

    it('keeps the last status of a pilot whose own read failed, rather than calling them offline', async () => {
      hold('s');
      feed.fly(1001);
      await tracker.run();
      feed.failPilot = true;
      await minute();
      assert.equal(tracker.statusOf(alice.id)!.state, 'airborne');
      assert.equal(tracker.waiting, 0);
    });

    it('forgets a pilot who no longer holds a flight, while others are still followed', async () => {
      hold('s');
      hold('t', bob);
      feed.fly(1001);
      feed.fly(1002);
      await tracker.run();
      assert.equal(tracker.statusOf(alice.id)!.state, 'airborne');
      h.jobs.release(jobId('s'), alice.id, [1]);
      await minute();
      assert.equal(tracker.statusOf(alice.id), null);
      assert.equal(tracker.statusOf(bob.id)!.state, 'airborne');
    });

    it('does not follow a pilot whose FsHub ID somebody typed that the airline roster gives to another Discord account', async () => {
      const dave = d.client.user(new FakeUser('444444444444444444', 'dave'));
      h.store.setPilotId(dave.id, 500, NOW, 'Roster Pilot');
      h.store.applyRosterLinks([{ discordId: '666666666666666666', fshubId: 500, name: 'Roster Pilot' }], NOW);
      h.jobs.reserve(jobId('t'), [1], { discordId: dave.id, username: 'dave' });
      feed.fly(500);
      await tracker.run();
      assert.equal(tracker.statusOf(dave.id), null);
      assert.deepEqual(feed.calls, []);
    });
  });

  describe('completing a flight when its pilot lands', () => {
    /** Alice flies, then lands, with the tracker looking each minute. */
    const flyAndLand = async () => {
      hold('s');
      feed.fly(1001, { dep: 'EGLL', arr: 'EGKK' });
      await tracker.run();
      await minute();
      feed.land(1001);
      await minute();
    };

    it('looks for the flight in FsHub the minute the pilot lands, and completes it as soon as FsHub shows it flown', async () => {
      await flyAndLand();
      assert.equal(job('s').completedAt, null, 'FsHub has not registered the flight yet, so nothing is completed');
      assert.equal(tracker.waiting, 1, 'and it keeps looking');
      flown({ arrivedAt: h.clock.now - MIN });
      await minute();
      const j = job('s');
      assert.deepEqual([j.status, j.completedBy, j.completedVia], ['expired', alice.id, 'fshub']);
      assert.equal(tracker.waiting, 0);
      await settle(60);
      assert.equal(alice.dms.length, 1, 'the pilot is told, as with the hourly check');
      assert.match(String(alice.dms[0].content), /TST-001/);
    });

    it('never completes a flight FsHub does not show, however long the pilot has been down', async () => {
      await flyAndLand();
      for (let i = 0; i < 20; i++) await minute();
      assert.equal(job('s').completedAt, null);
      assert.equal(job('s').status, 'open');
      assert.equal(tracker.waiting, 0, 'it gave up after a while: the hourly check is left to find it');
    });

    it('does not complete a flight on FsHub\'s say-so when the flight is another pilot\'s, or the wrong route', async () => {
      await flyAndLand();
      flown({ pilotId: 1002, pilotName: 'Bob', arrivedAt: h.clock.now - MIN });
      flown({ dep: 'EGKK', arr: 'EGCC', arrivedAt: h.clock.now - MIN });
      await minute();
      assert.equal(job('s').completedAt, null);
    });

    it('checks the pilot who landed and nobody else, and leaves the hourly timer alone', async () => {
      hold('t', bob);
      flown({ pilotId: 1002, pilotName: 'Bob', dep: 'EGKK', arr: 'EGCC', arrivedAt: NOW - HOUR }); // Bob flew his, but did not just land
      await flyAndLand();
      flown({ arrivedAt: h.clock.now - MIN });
      await minute();
      assert.equal(job('s').completedAt !== null, true, 'Alice\'s is completed');
      assert.equal(job('t').completedAt, null, 'Bob\'s waits for the hourly check');
      assert.equal(panel().fshubAutoCompleteAt, null, 'which still runs when it is due');
    });

    it('looks again at most once a minute', async () => {
      await flyAndLand();
      assert.equal(checks, 1, 'at once, the minute she lands');
      h.clock.advance(20_000);
      await tracker.run();
      h.clock.advance(20_000);
      await tracker.run();
      assert.equal(checks, 1, 'and not again within the minute');
      h.clock.advance(21_000);
      await tracker.run();
      assert.equal(checks, 2, 'but again once the minute is up');
    });

    it('counts a pilot dropping out of the feed after being in the air as a landing too, and still needs FsHub to agree', async () => {
      hold('s');
      feed.fly(1001);
      await tracker.run();
      await minute();
      feed.disconnect(1001);
      await minute();
      assert.equal(tracker.waiting, 1);
      assert.equal(job('s').completedAt, null);
      flown({ arrivedAt: h.clock.now - MIN });
      await minute();
      assert.equal(job('s').completedAt !== null, true);
    });

    it('does nothing for a pilot it never saw in the air', async () => {
      hold('s');
      feed.land(1001);
      feed.online.add(1001);
      await tracker.run();
      await minute();
      flown();
      await minute();
      assert.equal(tracker.waiting, 0);
      assert.equal(job('s').completedAt, null, 'the hourly check is the one for that');
    });

    it('does nothing where automatic completion is switched off, FsHub is not linked, or tracking is off', async () => {
      h.store.updatePanel(pid, { fshubAutoComplete: false });
      await flyAndLand();
      assert.equal(tracker.waiting, 0);
      assert.equal(tracker.statusOf(alice.id)!.state, 'ground', 'but it still says who is flying');

      h.store.updatePanel(pid, { fshubAutoComplete: true, fshubConfirm: false });
      feed.fly(1001);
      await minute();
      feed.land(1001);
      await minute();
      assert.equal(tracker.waiting, 0);
    });

    it('still says who is flying with no FsHub token to complete with', async () => {
      build(false);
      await flyAndLand();
      assert.equal(tracker.waiting, 0);
      assert.equal(tracker.statusOf(alice.id)!.state, 'ground');
    });

    it('stops looking once nothing of the pilot\'s could be completed (what they hold has not opened yet)', async () => {
      h.jobs.sync(pid, [windowed('s', 'EGLL-EGKK', { aircraft: 'A320' }), windowed('later', 'EGKK-EGCC', { availableFrom: NOW + 3 * HOUR })]);
      hold('later');
      feed.fly(1001);
      await tracker.run();
      await minute();
      feed.land(1001);
      await minute();
      assert.equal(checks, 1, 'looked once');
      assert.equal(tracker.waiting, 0, 'and found nothing of hers that FsHub could show she flew');
      await minute();
      assert.equal(checks, 1, 'so it did not look again');
    });

    it('keeps trying when FsHub cannot be read, and completes once it can', async () => {
      await flyAndLand();
      flown({ arrivedAt: h.clock.now - MIN });
      fshub.flightError = new FsHubError('unavailable', "I couldn't reach FsHub right now.");
      await minute();
      assert.equal(job('s').completedAt, null);
      assert.equal(panel().fshubAutoCompleteAt, null, 'a failed landing check does not move the hourly check');
      fshub.flightError = null;
      await minute();
      assert.equal(job('s').completedAt !== null, true);
    });

    it('leaves the Complete button as the way when a pilot\'s FsHub ID is wrong: nothing here changes that', async () => {
      // FsHub shows the flight under another pilot ID, so the strict check refuses it, however it is triggered.
      await flyAndLand();
      flown({ pilotId: 9999, arrivedAt: h.clock.now - MIN });
      for (let i = 0; i < 5; i++) await minute();
      assert.equal(job('s').completedAt, null);
    });
  });
});

/* ------------------------------------------------------------------ the late-departure warning */

const learned = (minutes: number): FlightTime => ({ minutes, source: 'learned', basis: 'the middle time of the 6 flights of this route' });

describe('the late-departure warning and the live feed', () => {
  let h: Harness;
  let sent: Array<{ to: string; content: string }>;
  let statuses: Map<string, LiveStatus | null>;
  let svc: DepartureWarnings;
  const pid = () => h.panel.id;
  const at = (hours: number) => T0 + hours * HOUR;
  const status = (state: LiveStatus['state'], over: Partial<LiveStatus> = {}): LiveStatus => ({ state, phase: null, dep: null, arr: null, flightId: null, checkedAt: h.clock.now, ...over });
  const view = (key: string) => h.jobs.open(pid()).find((v) => v.job.sourceKey === key)!;
  /** A 2 hour flight, down by 19:00Z; Alice has it and Bob is her backup. It is 16:30Z. */
  const taken = (chain = 'EGLL-EGKK') => {
    h.jobs.sync(pid(), [sj('a', chain, { availableFrom: at(-2), deadline: at(7) })]);
    h.jobs.reserve(view('a').job.id, view('a').legs.map((l) => l.legNo), USER_A);
    h.jobs.addBackup(view('a').job.id, USER_B);
    h.clock.now = at(4.5);
  };

  beforeEach(async () => {
    h = await makeHarness();
    sent = [];
    statuses = new Map();
    svc = new DepartureWarnings(
      h.store,
      h.jobs,
      { forLeg: async () => learned(120) },
      async (to, content) => (sent.push({ to, content }), true),
      { now: () => h.clock.now, live: { statusOf: (id) => statuses.get(id) ?? null } },
    );
  });
  afterEach(() => h.close());

  it('is not sent to a pilot who is already in the air on the flight, and is not used up: nothing is marked warned', async () => {
    taken();
    statuses.set(USER_A.discordId, status('airborne', { dep: 'EGLL', arr: 'EGKK', phase: 'cruise' }));
    assert.equal(await svc.run(), 0);
    assert.deepEqual(sent, [], 'neither the pilot nor the backup');
    assert.equal(h.store.wasWarned(view('a').job.id, USER_A.discordId), false);
  });

  it('is not sent to a pilot in the air with no flight plan filed either', async () => {
    taken();
    statuses.set(USER_A.discordId, status('airborne'));
    assert.equal(await svc.run(), 0);
  });

  it('is still sent to a pilot in the air on a different flight plan, who may still have this one to fly', async () => {
    taken();
    statuses.set(USER_A.discordId, status('airborne', { dep: 'EGPH', arr: 'EGLL' }));
    assert.equal(await svc.run(), 2);
  });

  it('matches a leg of a longer flight in either position', async () => {
    h.jobs.sync(pid(), [sj('m', 'EGLL-EGKK-EGCC', { availableFrom: at(-2), deadline: at(7) })]);
    h.jobs.reserve(view('m').job.id, [1, 2], USER_A);
    h.clock.now = at(3.5);
    statuses.set(USER_A.discordId, status('airborne', { dep: 'EGKK', arr: 'EGCC' }));
    assert.equal(await svc.run(), 0, 'flying the second leg is flying the flight');
  });

  it('says the live feed does not show the pilot in the air when that is what it knows, in place of "ignore it if you have taken off"', async () => {
    taken();
    statuses.set(USER_A.discordId, status('ground', { phase: 'taxiing_to_runway' }));
    statuses.set(USER_B.discordId, null);
    assert.equal(await svc.run(), 2);
    const pilot = sent.find((s) => s.to === USER_A.discordId)!.content;
    assert.match(pilot, /FsHub's live feed doesn't show you in the air right now\./);
    assert.doesNotMatch(pilot, /ignore it/);
    const backup = sent.find((s) => s.to === USER_B.discordId)!.content;
    assert.match(backup, /^.*\n.*\n.*FsHub's live feed doesn't show the pilot in the air yet/);
    assert.doesNotMatch(backup, /FsHub shows a flight only once it has landed/);
  });

  it('counts a pilot who is not online as not in the air', async () => {
    taken();
    statuses.set(USER_A.discordId, status('offline'));
    await svc.run();
    assert.match(sent.find((s) => s.to === USER_A.discordId)!.content, /live feed doesn't show you in the air/);
  });

  it('keeps the old wording when nothing is known, so it never claims what it cannot see', async () => {
    taken();
    assert.equal(await svc.run(), 2);
    const pilot = sent.find((s) => s.to === USER_A.discordId)!.content;
    assert.match(pilot, /If you have already taken off, ignore it: I only see a flight once FsHub shows it landed\./);
    assert.match(sent.find((s) => s.to === USER_B.discordId)!.content, /FsHub shows a flight only once it has landed/);
  });

  it('does not warn a backup while the pilot is flying, and warns them when they are not', async () => {
    taken();
    statuses.set(USER_A.discordId, status('airborne'));
    await svc.run();
    assert.deepEqual(sent, []);
    statuses.set(USER_A.discordId, status('ground'));
    assert.equal(await svc.run(), 2);
  });

  it('warns once the pilot has landed without finishing the flight, as before', async () => {
    taken();
    statuses.set(USER_A.discordId, status('airborne'));
    await svc.run();
    statuses.set(USER_A.discordId, status('ground'));
    h.clock.advance(MIN);
    assert.equal(await svc.run(), 2);
  });

  it('writes the messages the same as before when asked for the old kind', () => {
    taken();
    const panel = h.store.getPanel(pid())!;
    const plan = { view: view('a'), deadline: at(7), latest: at(5), legs: [{ legNo: 1, dep: 'EGLL', arr: 'EGKK', time: learned(120) }], totalMinutes: 120 };
    assert.ok(pilotWarning(panel, plan).includes(`${ts(at(5), 't')}`));
    assert.match(pilotWarning(panel, plan), /If you have already taken off/);
    assert.match(pilotWarning(panel, plan, true), /live feed/);
    assert.match(backupWarning(panel, plan, [USER_A.discordId]), /FsHub shows a flight only once it has landed/);
    assert.match(backupWarning(panel, plan, [USER_A.discordId], true), /live feed/);
  });
});

/* ------------------------------------------------------------------ the scheduler */

describe('the scheduler and live tracking', () => {
  let h: Harness;
  let d: DiscordHarness;
  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
  });
  afterEach(() => h.close());

  it('runs it in the lane after the FsHub reads and before the warnings', async () => {
    const calls: string[] = [];
    const s = new Scheduler(h.jobs, d.refresher, {
      fshub: { run: async () => void calls.push('fshub') },
      autoComplete: { run: async () => void calls.push('auto-complete') },
      live: { run: async () => void calls.push('live') },
      departures: { run: async () => void calls.push('departures') },
    });
    await s.tick();
    await s.idle();
    assert.deepEqual(calls, ['fshub', 'auto-complete', 'live', 'departures']);
  });

  it('runs it with nothing else, and a failure does not stop the warnings', async () => {
    const calls: string[] = [];
    const s = new Scheduler(h.jobs, d.refresher, {
      live: { run: async () => Promise.reject(new Error('boom')) },
      departures: { run: async () => void calls.push('departures') },
    });
    await assert.doesNotReject(s.tick());
    await s.idle();
    assert.deepEqual(calls, ['departures']);
  });
});

/* ------------------------------------------------------------------ /setup live-tracking */

describe('/setup live-tracking', () => {
  let h: Harness;
  let d: DiscordHarness;
  const pid = () => h.panel.id;
  const run = async (o: FakeInteractionOptions = {}) => {
    const f = fakeInteraction({ sub: 'live-tracking', admin: true, ...o });
    await setup.execute(d.ctx, f.i);
    await settle(40);
    return String(f.calls.edits.at(-1)?.content ?? '');
  };
  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h, { fshub: true });
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('is on for every panel, and a description Discord accepts', () => {
    assert.equal(h.store.getPanel(pid())!.liveTracking, true);
    const sub = (setup.data.toJSON().options ?? []).find((o) => o.name === 'live-tracking') as unknown as { description: string; options: Array<{ name: string; choices?: Array<{ value: string }> }> };
    assert.ok(sub && sub.description.length <= 100);
    assert.deepEqual(sub.options.find((o) => o.name === 'mode')!.choices!.map((c) => c.value), ['on', 'off']);
    assert.ok(sub.options.some((o) => o.name === 'airline'));
  });

  it('says what it does, and that Complete stays, when it can complete flights', async () => {
    h.store.updatePanel(pid(), { fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Test Air' });
    const reply = await run();
    assert.doesNotMatch(reply, /^Done/);
    assert.match(reply, /I follow your pilots' flights live, using FsHub's public live feed/);
    assert.match(reply, /not sent to a pilot who is already in the air/);
    assert.match(reply, /complete it only once FsHub shows it flown/);
    assert.match(reply, /Pilots can still press \*\*Complete\*\*/);
  });

  it('says completing on landing needs the FsHub link when the panel has none, and that the warnings still use it', async () => {
    assert.match(await run(), /needs this panel linked to FsHub with automatic completion on.*only the warnings use the live feed/);
  });

  it('switches off and on, saying so, and nothing changes when it is already so', async () => {
    assert.match(await run({ options: { mode: 'off' } }), /^Done\. Live tracking is \*\*off\*\* for \*\*Test Air\*\*/);
    assert.equal(h.store.getPanel(pid())!.liveTracking, false);
    assert.doesNotMatch(await run({ options: { mode: 'off' } }), /^Done/);
    assert.match(await run(), /Live tracking is \*\*off\*\*/);
    assert.match(await run({ options: { mode: 'on' } }), /^Done\. For \*\*Test Air\*\*/);
    assert.equal(h.store.getPanel(pid())!.liveTracking, true);
  });

  it('is for admins only', async () => {
    await assert.rejects(run({ admin: false, options: { mode: 'off' } }), (e: unknown) => e instanceof UserError && /Manage Server/.test(e.message));
    assert.equal(h.store.getPanel(pid())!.liveTracking, true);
  });
});
