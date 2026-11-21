import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { handleDmMessage } from '../src/discord/dm.js';
import { MONITOR_COOLDOWN_MS, MONITOR_HELP } from '../src/discord/monitor.js';
import type { AirlineFlight } from '../src/fshub/liveFeed.js';
import { MAX_MONITORS, NEAR_MINUTES, parseFlightNumber, WAIT_FOR_FLIGHT_MS } from '../src/services/flightMonitor.js';
import { Scheduler } from '../src/services/scheduler.js';
import { HOUR, makeHarness, type Harness } from './helpers.js';
import { fakeDm, FakeUser, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

const MINUTE = 60_000;

/** A flight in the live feed, by default in the cruise with 45 minutes to go. */
const flight = (over: Partial<AirlineFlight> = {}): AirlineFlight => ({ flightId: '1', pilotId: 7001, callsign: 'SKY330', dep: 'KMIA', arr: 'KBOS', phase: 'cruise', onGround: false, etaMinutes: 45, ...over });

let people = 0;

describe('reading a flight number', () => {
  it('takes the airline\'s letters and the number in any case, with spaces or dashes', () => {
    for (const [input, no, airline] of [['SKY330', 'SKY330', 'SKY'], [' sky 330 ', 'SKY330', 'SKY'], ['SKY-330', 'SKY330', 'SKY'], ['ba9', 'BA9', 'BA'], ['SKY0290', 'SKY0290', 'SKY'], ['DLH408A', 'DLH408A', 'DLH']] as const) {
      assert.deepEqual(parseFlightNumber(input), { flightNo: no, airline }, input);
    }
  });

  it('refuses what is not one', () => {
    for (const bad of ['', 'SKY', '330', 'W330', 'TOOLONG123', 'SKY123456', 'SKY 330 extra', '<@1>', 'SKY/330', 'N738PM', 'KMIA']) assert.equal(parseFlightNumber(bad), null, bad);
  });
});

describe('watching a flight (/monitor)', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(`3${String(++people).padStart(17, '0')}`, 'alice'));
    bob = d.client.user(new FakeUser(`4${String(people).padStart(17, '0')}`, 'bob'));
  });
  afterEach(async () => {
    await settle(20);
    await h.close();
  });

  /** Says something to the bot in a DM (a little later than the last time, so the pause between asks has passed). */
  const say = async (u: FakeUser, text: string) => {
    h.clock.advance(MONITOR_COOLDOWN_MS);
    await handleDmMessage(d.ctx, fakeDm(u, text));
  };
  const texts = (u: FakeUser, from = 0) => u.dms.slice(from).map((m) => String(m.content));
  const last = (u: FakeUser) => texts(u).at(-1)!;
  const mine = (u: FakeUser = alice) => h.store.listFlightMonitors(u.id);
  const look = async (minutes = 1) => {
    h.clock.advance(minutes * MINUTE);
    await d.monitors.run();
  };
  const fly = (...flights: AirlineFlight[]) => d.live.flights.set('SKY', flights);

  describe('asking', () => {
    it('shows how it works when there is nothing watched, with /monitor on its own', async () => {
      await say(alice, '/monitor');
      assert.equal(last(alice), MONITOR_HELP);
      assert.match(MONITOR_HELP, /about \*\*10 minutes from landing\*\*, and again when it has \*\*landed\*\*/);
      assert.match(MONITOR_HELP, /up to 24 hours/);
      assert.match(MONITOR_HELP, new RegExp(`${MAX_MONITORS} flights at once`));
      assert.equal(NEAR_MINUTES, 10);
    });

    it('starts watching a flight that is not in the air yet, and says it keeps looking', async () => {
      await say(alice, '/monitor SKY330');
      assert.match(last(alice), /^✈️ I'm watching \*\*SKY330\*\*\. It isn't in the live feed right now, so I'll keep looking for it\.\nI'll message you when it is about 10 minutes from landing, and again when it has landed\./);
      assert.match(last(alice), /`\/monitor stop SKY330` stops it/);
      assert.deepEqual(mine().map((m) => [m.flightNo, m.airline, m.state]), [['SKY330', 'SKY', 'waiting']]);
      assert.deepEqual(d.live.calls, ['SKY'], 'the airline\'s flights were asked for');
    });

    it('says how a flight that is flying stands right now', async () => {
      fly(flight());
      await say(alice, 'monitor sky-330');
      assert.match(last(alice), /It is in the air now \(KMIA → KBOS\), about 45 minutes from landing by FsHub's estimate\./);
      fly(flight({ phase: 'taxiing_to_runway', onGround: true, etaMinutes: null }));
      await say(alice, '/monitor stop all');
      await say(alice, '/monitor SKY330');
      assert.match(last(alice), /in the feed but on the ground at the moment \(KMIA → KBOS\)/);
    });

    it('refuses what is not a flight number, and asks nothing of anyone', async () => {
      for (const bad of ['hello', 'SKY', '330', 'N738PM']) {
        await say(alice, `/monitor ${bad}`);
        assert.match(last(alice), /I need a flight number: the airline's letters and the number, like `SKY330`/);
      }
      assert.deepEqual(mine(), []);
      assert.deepEqual(d.live.calls, []);
    });

    it('says so when it is already watching it, and lists what it watches', async () => {
      await say(alice, '/monitor SKY330');
      await say(alice, '/monitor SKY 330');
      assert.match(last(alice), /already watching \*\*SKY330\*\* for you/);
      assert.equal(mine().length, 1);
      fly(flight());
      await say(alice, '/monitor SKY331');
      await look();
      await say(alice, '/monitor');
      const list = last(alice);
      assert.match(list, /watching \*\*2\*\* flights for you:/);
      assert.match(list, /• \*\*SKY330\*\* \(in the air, to KBOS\)/);
      assert.match(list, /• \*\*SKY331\*\* \(not seen in the air yet\)/);
    });

    it('watches five at once and no more', async () => {
      for (let i = 0; i < MAX_MONITORS; i++) await say(alice, `/monitor SKY${300 + i}`);
      assert.equal(mine().length, MAX_MONITORS);
      await say(alice, '/monitor SKY999');
      assert.match(last(alice), /can watch 5 flights for you at once\. Stop one first with `\/monitor stop <flight number>`/);
      assert.equal(mine().length, MAX_MONITORS);
    });

    it('keeps each person\'s flights their own, and stops one, or all', async () => {
      await say(alice, '/monitor SKY330');
      await say(alice, '/monitor SKY331');
      await say(bob, '/monitor SKY330');
      await say(bob, '/monitor stop SKY331');
      assert.match(last(bob), /wasn't watching that flight for you/);
      assert.equal(mine().length, 2, 'Bob could not stop Alice\'s');
      await say(alice, '/monitor stop sky-330');
      assert.match(last(alice), /Stopped\. I'm no longer watching \*\*SKY330\*\* for you/);
      assert.deepEqual(mine().map((m) => m.flightNo), ['SKY331']);
      assert.deepEqual(mine(bob).map((m) => m.flightNo), ['SKY330']);
      await say(alice, '/monitor stop all');
      assert.match(last(alice), /Stopped\. I'm no longer watching \*\*1\*\* flights? for you/);
      assert.deepEqual(mine(), []);
      await say(alice, '/monitor stop');
      assert.match(last(alice), /Which flight\? Send `\/monitor stop SKY330`/);
    });

    it('does not let someone ask over and over: a few seconds between asks, and not asked of FsHub again', async () => {
      await say(alice, '/monitor SKY330');
      await handleDmMessage(d.ctx, fakeDm(alice, '/monitor SKY331'));
      assert.match(last(alice), /One moment, then ask again\./);
      assert.deepEqual(mine().map((m) => m.flightNo), ['SKY330']);
      assert.equal(d.live.calls.length, 1);
    });

    it('is mentioned in the pointer people get', async () => {
      await say(alice, 'hello');
      assert.match(last(alice), /`\/monitor SKY330` tells you when a flight is about to land/);
    });
  });

  describe('telling them', () => {
    beforeEach(async () => {
      await say(alice, '/monitor SKY330');
    });
    const dms = () => alice.dms.length;

    it('says nothing while the flight is not in the air, or is far from landing, and watches it as airborne from then', async () => {
      const before = dms();
      await look();
      assert.equal(dms(), before);
      assert.equal(mine()[0]!.state, 'waiting');
      fly(flight({ etaMinutes: 45 }));
      await look();
      assert.equal(dms(), before);
      assert.deepEqual([mine()[0]!.state, mine()[0]!.arr, mine()[0]!.nearSent], ['airborne', 'KBOS', false]);
    });

    it('tells them once when it is about ten minutes from landing', async () => {
      fly(flight({ etaMinutes: 45 }));
      await look();
      const before = dms();
      fly(flight({ etaMinutes: 10 }));
      await look();
      assert.equal(texts(alice, before).length, 1);
      assert.equal(texts(alice, before)[0], "🛬 **SKY330** is about **10 minutes** from landing at **KBOS** (FsHub's estimate).");
      fly(flight({ etaMinutes: 4, phase: 'descending' }));
      await look();
      assert.equal(dms(), before + 1, 'told once');
      assert.equal(mine()[0]!.nearSent, true);
    });

    it('tells them at once when it is first seen already close', async () => {
      const before = dms();
      fly(flight({ etaMinutes: 8 }));
      await look();
      assert.match(last(alice), /about \*\*8 minutes\*\* from landing/);
      assert.equal(dms(), before + 1);
    });

    it('watches a flight whose phase FsHub has not worked out (`calculating`) as in the air, and tells them when it is close', async () => {
      fly(flight({ phase: 'calculating', etaMinutes: 45 }));
      await look();
      assert.equal(mine()[0]!.state, 'airborne');
      const before = dms();
      fly(flight({ phase: 'calculating', etaMinutes: 9 }));
      await look();
      assert.match(last(alice), /about \*\*9 minutes\*\* from landing/);
      assert.equal(dms(), before + 1);
    });

    it('finds a flight by the plan\'s flight number when the pilot flies under a callsign of their own', async () => {
      fly(flight({ callsign: 'MYMATE', flightNo: 'SKY330', etaMinutes: 8 }));
      await look();
      assert.match(last(alice), /about \*\*8 minutes\*\* from landing/);
    });

    it('says a minute rather than nought or one minutes', async () => {
      fly(flight({ etaMinutes: 0 }));
      await look();
      assert.match(last(alice), /about \*\*a minute\*\* from landing/);
    });

    it('does not take a time on the ground for a time to land', async () => {
      const before = dms();
      fly(flight({ phase: 'taxiing_to_runway', onGround: true, etaMinutes: 5 }));
      await look();
      assert.equal(dms(), before);
      assert.equal(mine()[0]!.state, 'waiting');
    });

    it('tells them it has landed, with the route, and stops watching it', async () => {
      fly(flight({ etaMinutes: 40 }));
      await look();
      const before = dms();
      fly(flight({ phase: 'landed', onGround: true, etaMinutes: null }));
      await look();
      assert.equal(texts(alice, before).length, 1);
      assert.equal(texts(alice, before)[0], '✅ **SKY330** has landed at **KBOS** (KMIA → KBOS).');
      assert.deepEqual(mine(), []);
      await look();
      assert.equal(dms(), before + 1, 'nothing more');
    });

    it('takes taxiing to the gate, and arrived, as landed too', async () => {
      for (const phase of ['taxiing_to_gate', 'arrived']) {
        await say(alice, '/monitor SKY330');
        fly(flight({ phase, onGround: true, etaMinutes: null }));
        const before = dms();
        await look();
        assert.match(last(alice), /has landed at \*\*KBOS\*\*/, phase);
        assert.equal(dms(), before + 1);
        assert.deepEqual(mine(), []);
      }
    });

    it('takes a flight that was in the air and is now on the ground as landed, whatever phase it names', async () => {
      fly(flight());
      await look();
      fly(flight({ phase: 'something_new', onGround: true, etaMinutes: null }));
      await look();
      assert.match(last(alice), /has landed/);
      assert.deepEqual(mine(), []);
    });

    it('says so when a flight it saw in the air has dropped out of the feed, after it has missed it twice', async () => {
      fly(flight());
      await look();
      const before = dms();
      fly();
      await look();
      assert.equal(dms(), before, 'once is not enough: a feed can miss a flight');
      assert.equal(mine()[0]!.misses, 1);
      fly(flight());
      await look();
      assert.equal(mine()[0]!.misses, 0, 'seen again');
      fly();
      await look();
      await look();
      assert.match(last(alice), /^⚠️ \*\*SKY330\*\* is no longer in FsHub's live feed, so I've stopped watching it\. It most likely landed, or its pilot disconnected\.$/);
      assert.deepEqual(mine(), []);
    });

    it('tells nothing and changes nothing when the live feed cannot be asked', async () => {
      fly(flight());
      await look();
      d.live.error = new Error('down');
      const before = dms();
      await look(3);
      assert.equal(dms(), before);
      assert.deepEqual([mine()[0]!.state, mine()[0]!.misses], ['airborne', 0], 'not taken as missing');
    });

    it('gives up on a flight that is never seen in the air, after a day, and says so', async () => {
      const before = dms();
      await look(60 * 23);
      assert.equal(dms(), before);
      await look(61);
      assert.equal(texts(alice, before).length, 1);
      assert.match(last(alice), new RegExp(`I never saw \\*\\*SKY330\\*\\* in the air within ${WAIT_FOR_FLIGHT_MS / HOUR} hours`));
      assert.match(last(alice), /`\/monitor SKY330` to start again/);
      assert.deepEqual(mine(), []);
    });

    it('keeps watching a flight that has been seen in the air past that day', async () => {
      await look(60 * 22);
      fly(flight({ etaMinutes: 300 }));
      await look();
      await look(60 * 3);
      assert.equal(mine().length, 1);
    });

    it('does not mistake another flight for it, and prefers the one in the air when two share a number', async () => {
      const before = dms();
      fly(flight({ callsign: 'SKY331', etaMinutes: 5 }), flight({ callsign: 'SKY3300', etaMinutes: 5 }));
      await look();
      assert.equal(dms(), before);
      fly(flight({ flightId: '2', phase: 'awaiting_departure', onGround: true, etaMinutes: null }), flight({ flightId: '3', etaMinutes: 6 }));
      await look();
      assert.match(last(alice), /about \*\*6 minutes\*\*/);
    });

    it('tries again later when a message could not be delivered, and does not lose it', async () => {
      alice.failDms = true;
      fly(flight({ etaMinutes: 9 }));
      const before = dms();
      await look();
      assert.equal(dms(), before);
      assert.equal(mine()[0]!.nearSent, false);
      alice.failDms = false;
      await look();
      assert.equal(texts(alice, before).length, 1);
      assert.equal(mine()[0]!.nearSent, true);
      alice.failDms = true;
      fly(flight({ phase: 'landed', onGround: true, etaMinutes: null }));
      await look();
      assert.equal(mine().length, 1, 'still watched: they have not been told');
      alice.failDms = false;
      await look();
      assert.match(last(alice), /has landed/);
      assert.deepEqual(mine(), []);
    });

    it('asks the feed once for each airline, however many people watch its flights, and tells each of them', async () => {
      await say(bob, '/monitor SKY330');
      await say(bob, '/monitor SKY331');
      await say(alice, '/monitor DLH12');
      d.live.calls.length = 0;
      fly(flight({ etaMinutes: 9 }), flight({ callsign: 'SKY331', flightId: '9', etaMinutes: 3 }));
      d.live.flights.set('DLH', [flight({ callsign: 'DLH12', etaMinutes: 50 })]);
      const [a, b] = [dms(), bob.dms.length];
      await look();
      assert.deepEqual([...d.live.calls].sort(), ['DLH', 'SKY']);
      assert.equal(texts(alice, a).length, 1);
      assert.equal(texts(bob, b).length, 2);
    });

    it('is run by the scheduler with the other live work, and a failure there stops nothing else', async () => {
      let runs = 0;
      const ok = new Scheduler(h.jobs, d.refresher, { monitors: { run: async () => void runs++ } });
      await ok.tick();
      await ok.idle();
      assert.equal(runs, 1);
      const bad = new Scheduler(h.jobs, d.refresher, { monitors: { run: async () => Promise.reject(new Error('boom')) } });
      await assert.doesNotReject(bad.tick());
      await assert.doesNotReject(bad.idle());
    });

    it('keeps what it watches across a restart', async () => {
      fly(flight({ etaMinutes: 30 }));
      await look();
      const again = d.monitors;
      assert.equal(again.list(alice.id)[0]!.state, 'airborne', 'it is in the database, not in memory');
    });
  });
});
