import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../src/db/db.js';
import { Store, type FlownFlight } from '../src/db/store.js';
import { commands } from '../src/discord/commands/index.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { landingRateOf, parseFlightPage, type FsHubFlight } from '../src/fshub/client.js';
import { DailyNote } from '../src/services/dailyNote.js';
import {
  composeRemark,
  FRESH_FOR_MS,
  HARD_FPM,
  HardLandings,
  IMPLAUSIBLE_FPM,
  QUIET_AFTER_MS,
  REMARKS,
  SEVERE_FPM,
  severityOf,
  switchRemarks,
  VERY_HARD_FPM,
} from '../src/services/hardLanding.js';
import { parseNoticeChange } from '../src/services/notices.js';
import { HOUR, T0, USER_A, USER_B, USER_C, makeHarness, type Harness } from './helpers.js';
import { FakeUser, fakeDm, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

/* Everything below is made up: the pilots, the airline and the flights. */

const AIRLINE_ID = 8123;
const NOW = T0 + 6 * HOUR;

/* ------------------------------------------------------------------ how hard is hard */

describe('how hard a landing was', () => {
  it('is nothing for a normal or firm landing, and for a reading that is missing or cannot be right', () => {
    for (const rate of [null, undefined, Number.NaN, Infinity, 0, -150, -300, -HARD_FPM + 1, -(HARD_FPM - 0.5)]) {
      assert.equal(severityOf(rate), null, String(rate));
    }
    assert.equal(severityOf(HARD_FPM + 100), null, 'a positive rate is not a descent, so it is not a hard landing');
    assert.equal(severityOf(-IMPLAUSIBLE_FPM - 1), null, 'a rate nobody could survive is a bad reading');
    assert.equal(severityOf(-10_000), null);
  });

  it('is hard from the limit, very hard and severe above it, with each limit counted in the harder group', () => {
    assert.equal(severityOf(-HARD_FPM), 'hard');
    assert.equal(severityOf(-(VERY_HARD_FPM - 1)), 'hard');
    assert.equal(severityOf(-VERY_HARD_FPM), 'very-hard');
    assert.equal(severityOf(-(SEVERE_FPM - 1)), 'very-hard');
    assert.equal(severityOf(-SEVERE_FPM), 'severe');
    assert.equal(severityOf(-IMPLAUSIBLE_FPM), 'severe', 'the top of what is believed is still a landing');
  });

  it('has the limits in order', () => {
    assert.ok(HARD_FPM < VERY_HARD_FPM && VERY_HARD_FPM < SEVERE_FPM && SEVERE_FPM < IMPLAUSIBLE_FPM);
  });

  it('has the numbers the documentation gives: 600, 800 and 1,000 feet a minute, nothing past 2,500, recent means three hours, and a quiet time of six', () => {
    assert.deepEqual([HARD_FPM, VERY_HARD_FPM, SEVERE_FPM, IMPLAUSIBLE_FPM], [600, 800, 1000, 2500]);
    assert.equal(FRESH_FOR_MS, 3 * HOUR);
    assert.equal(QUIET_AFTER_MS, 6 * HOUR);
  });

  it('counts the size of the descent, not the sign it was written with', () => {
    assert.equal(severityOf(-(HARD_FPM + 0.4)), 'hard');
    assert.equal(severityOf(-(VERY_HARD_FPM + 0.4)), 'very-hard');
  });
});

/* ------------------------------------------------------------------ what is said */

describe('the remark', () => {
  const subject = { rate: -(HARD_FPM + 42), route: 'EGLL → EGKK', aircraft: 'A320', airline: 'Test Air', flightId: 7 };

  it('is from the scheduler, in a short note with the way to stop it', () => {
    const text = composeRemark(subject);
    const lines = text.split('\n');
    assert.equal(lines[0], '☕ **Kevin, Scheduler**');
    assert.equal(lines.at(-2), '— Kevin');
    assert.match(lines.at(-1)!, /^_Reply `fire kevin` to make me stop commenting on your landings, or DM me `notifications`\./);
    assert.ok(text.length < 900, `${text.length}`);
  });

  it('says the size of the descent as a plain positive number', () => {
    assert.ok(composeRemark(subject).includes(String(HARD_FPM + 42)));
    assert.ok(!composeRemark(subject).includes(`-${HARD_FPM + 42}`));
    assert.ok(composeRemark({ ...subject, rate: -(HARD_FPM + 42.6) }).includes(String(HARD_FPM + 43)), 'to the nearest');
  });

  it('chooses the words from the group that matches how hard it was', () => {
    const pick = (rate: number, flightId: number) => composeRemark({ ...subject, rate, flightId }).split('\n')[1]!;
    for (const [severity, rate] of [['hard', -HARD_FPM], ['very-hard', -VERY_HARD_FPM], ['severe', -SEVERE_FPM]] as const) {
      for (let id = 0; id < REMARKS[severity].length; id++) {
        const words = REMARKS[severity][id]!.split('{rate}').join(String(Math.abs(rate))).split('{route}').join('EGLL → EGKK').split('{aircraft}').join('A320').split('{airline}').join('Test Air');
        assert.equal(pick(rate, id), words, `${severity} #${id}`);
      }
    }
  });

  it('is the same words for the same flight and a different set of words for different flights', () => {
    assert.equal(composeRemark(subject), composeRemark(subject));
    const seen = new Set(Array.from({ length: REMARKS.hard.length }, (_, id) => composeRemark({ ...subject, flightId: id })));
    assert.equal(seen.size, REMARKS.hard.length);
  });

  it('works with any flight number, even a very large one', () => {
    for (const flightId of [0, 1, 2_000_000_000, 4_900_123]) assert.ok(composeRemark({ ...subject, flightId }).length > 50);
  });

  it('copes with a missing aircraft or airline, and shortens and tidies ones that are long or odd', () => {
    const none = composeRemark({ ...subject, aircraft: null, airline: null });
    assert.doesNotMatch(none, /\{|\}|null|undefined/);
    const odd = composeRemark({ ...subject, aircraft: '**@everyone**'.repeat(5), airline: '<@123> ' + 'x'.repeat(200) });
    assert.doesNotMatch(odd, /@everyone(?!​)/);
    assert.doesNotMatch(odd, /<@123>/);
    assert.ok(odd.length < 1200);
  });

  it('has words for a missing aircraft or airline, and uses them in every remark that names one', () => {
    let named = 0;
    for (const [severity, rate] of [['hard', -HARD_FPM], ['very-hard', -VERY_HARD_FPM], ['severe', -SEVERE_FPM]] as const) {
      for (let id = 0; id < REMARKS[severity].length; id++) {
        const note = REMARKS[severity][id]!;
        if (!/\{(aircraft|airline)\}/.test(note)) continue;
        named++;
        const expected = note.split('{rate}').join(String(Math.abs(rate))).split('{route}').join('EGLL → EGKK').split('{aircraft}').join('aircraft').split('{airline}').join('the airline');
        assert.equal(composeRemark({ rate, route: 'EGLL → EGKK', aircraft: null, airline: null, flightId: id }).split('\n')[1], expected, `${severity} #${id}`);
      }
    }
    assert.ok(named >= 2, 'at least one remark names the aircraft and one the airline');
    assert.ok(REMARKS.hard.some((n) => n.includes('{airline}')), 'one names the airline');
    assert.ok(Object.values(REMARKS).flat().some((n) => n.includes('{aircraft}')), 'one names the aircraft');
  });

  it('has a good supply of remarks in each group, each with the number in it, none unfinished, and none repeated', () => {
    const all = Object.values(REMARKS).flat();
    assert.ok(REMARKS.hard.length >= 8 && REMARKS['very-hard'].length >= 6 && REMARKS.severe.length >= 5);
    assert.equal(new Set(all).size, all.length, 'no remark twice');
    for (const note of all) {
      assert.ok(note.includes('{rate}'), `says how hard: ${note}`);
      assert.ok(note.length <= 420, `short enough: ${note}`);
      const left = note.replace(/\{(rate|route|aircraft|airline)\}/g, '');
      assert.doesNotMatch(left, /[{}]/, note);
    }
  });
});

/* ------------------------------------------------------------------ the switch (fire kevin / rehire kevin) */

describe('turning the remarks off and on by replying', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());
  const say = (user: { discordId: string }, text: string) => switchRemarks(h.store, user.discordId, text, T0);

  it('is off after "fire kevin", and says so in the voice of the note', () => {
    assert.equal(h.store.wantsNotice(USER_A.discordId, 'landing'), true);
    const reply = say(USER_A, 'fire kevin');
    assert.match(reply!, /^Understood\. I'll clear my desk/);
    assert.match(reply!, /`rehire kevin`/);
    assert.equal(h.store.wantsNotice(USER_A.discordId, 'landing'), false);
  });

  it('is on again after "rehire kevin"', () => {
    say(USER_A, 'fire kevin');
    const reply = say(USER_A, 'rehire kevin');
    assert.match(reply!, /^New Kevin reporting for duty/);
    assert.equal(h.store.wantsNotice(USER_A.discordId, 'landing'), true);
  });

  it('says it is already done when it is, and changes nothing', () => {
    assert.match(say(USER_A, 'rehire kevin')!, /^I'm already on the payroll/);
    assert.equal(h.store.wantsNotice(USER_A.discordId, 'landing'), true);
    say(USER_A, 'fire kevin');
    assert.match(say(USER_A, 'fire kevin')!, /^I'm already fired/);
    assert.equal(h.store.wantsNotice(USER_A.discordId, 'landing'), false);
  });

  it('is read in any case, with a full stop, a bang or a question mark, and "hire" as well as "rehire"', () => {
    for (const text of ['Fire Kevin', 'FIRE KEVIN!', '  fire kevin.  ', 'fire   kevin?']) {
      h.store.setNotice(USER_A.discordId, 'landing', true, T0);
      assert.ok(say(USER_A, text), text);
      assert.equal(h.store.wantsNotice(USER_A.discordId, 'landing'), false, text);
    }
    for (const text of ['rehire kevin', 'Re-hire Kevin', 'hire kevin!']) {
      h.store.setNotice(USER_A.discordId, 'landing', false, T0);
      assert.ok(say(USER_A, text), text);
      assert.equal(h.store.wantsNotice(USER_A.discordId, 'landing'), true, text);
    }
  });

  it('is nothing for anything else, which is left to be read as any message is', () => {
    for (const text of ['fire', 'kevin', 'fire kevin now please', 'please fire kevin', 'hello', 'TST-001']) {
      assert.equal(say(USER_A, text), null, text);
    }
    assert.equal(h.store.wantsNotice(USER_A.discordId, 'landing'), true);
  });

  it('is for the person who said it, and leaves the other two switches alone', () => {
    h.store.setNotice(USER_A.discordId, 'takeoff', false, T0);
    say(USER_A, 'fire kevin');
    assert.deepEqual(h.store.getNotices(USER_A.discordId), { completed: true, takeoff: false, landing: false });
    assert.deepEqual(h.store.getNotices(USER_B.discordId), { completed: true, takeoff: true, landing: true });
    say(USER_A, 'rehire kevin');
    assert.deepEqual(h.store.getNotices(USER_A.discordId), { completed: true, takeoff: false, landing: true });
  });
});

describe('turning the remarks off and on in a DM', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });
  const say = (user: FakeUser, text: string) => handleDmMessage(d.ctx, fakeDm(user, text));
  /** The scheduler has spoken to this person: a remark was sent to them once. */
  const met = (user: FakeUser) => h.store.recordLandingRemark(user.id.length, user.id, -700, true, T0);

  it('turns them off for someone who has been sent a remark and replies "fire kevin", and shows as off under notifications', async () => {
    met(alice);
    await say(alice, 'fire kevin');
    assert.match(alice.lastText, /^Understood\. I'll clear my desk/);
    assert.equal(h.store.wantsNotice(alice.id, 'landing'), false);
    await say(alice, 'notifications');
    assert.match(alice.lastText, /• \*\*Hard-landing remarks\*\*: 🔕 off\./);
  });

  it('turns them back on with "rehire kevin", and the same switch is the one under notifications', async () => {
    met(alice);
    await say(alice, 'notifications landing off');
    assert.equal(h.store.wantsNotice(alice.id, 'landing'), false);
    await say(alice, 'rehire kevin');
    assert.match(alice.lastText, /^New Kevin reporting for duty/);
    assert.equal(h.store.wantsNotice(alice.id, 'landing'), true);
  });

  it('is only for the person who said it', async () => {
    met(alice);
    await say(alice, 'fire kevin');
    assert.equal(h.store.wantsNotice(bob.id, 'landing'), true);
    assert.equal(bob.dms.length, 0);
  });

  it('is just another message to someone who has never been sent a remark: nothing changes and nothing of it is said', async () => {
    await say(bob, 'fire kevin');
    assert.equal(h.store.wantsNotice(bob.id, 'landing'), true);
    assert.ok(!bob.dms.some((m) => /clear my desk|payroll|Kevin/.test(String(m.content))));
    assert.match(bob.lastText, /^To reserve a flight, press \*\*Reserve\*\*/, 'the usual pointer, as for any message');
    await say(bob, 'rehire kevin');
    assert.ok(!bob.dms.some((m) => /reporting for duty|payroll/.test(String(m.content))));
  });

  it('is just another message for someone who was only held back from a remark, not sent one', async () => {
    h.store.recordLandingRemark(5, bob.id, -700, false, T0);
    await say(bob, 'fire kevin');
    assert.ok(!bob.dms.some((m) => /clear my desk/.test(String(m.content))));
  });

  it('goes on working for someone a month after their remark', async () => {
    met(alice);
    h.clock.advance(400 * 24 * HOUR);
    h.store.pruneLandingRemarks(h.clock.now - 30 * 24 * HOUR);
    await say(alice, 'fire kevin');
    assert.match(alice.lastText, /^Understood\. I'll clear my desk/);
  });

  it('leaves an open Reserve conversation alone', async () => {
    h.store.upsertSession({ discordId: alice.id, panelId: h.panel.id, step: 'await_code', expiresAt: h.clock.now + 60_000 });
    await say(alice, 'fire kevin');
    assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_code');
  });

  it('also switches the remarks for the person who gets the daily note, whose own reply is the note\'s', async () => {
    d.ctx.dailyNote = new DailyNote({ store: h.store, target: { userId: alice.id, fromHour: 9, toHour: 17 }, send: async () => true, now: () => h.clock.now });
    await say(alice, 'fire kevin');
    assert.match(alice.lastText, /^Understood\. I'll clear my desk\. I'm keeping the stapler and the shirt\./, "the daily note's own words");
    assert.equal(d.ctx.dailyNote.fired, true);
    assert.equal(h.store.wantsNotice(alice.id, 'landing'), false);
    await say(alice, 'rehire kevin');
    assert.match(alice.lastText, /^New Kevin reporting for duty\. Please ignore anything the last Kevin told you, although he was probably right\. I own a shirt\./);
    assert.equal(h.store.wantsNotice(alice.id, 'landing'), true);
    // Somebody else's reply never reaches the daily note, and does nothing at all unless they have been sent a remark.
    await say(bob, 'fire kevin');
    assert.equal(d.ctx.dailyNote.fired, false);
    assert.equal(h.store.wantsNotice(bob.id, 'landing'), true);
    met(bob);
    await say(bob, 'fire kevin');
    assert.equal(d.ctx.dailyNote.fired, false, 'still not the daily note');
    assert.equal(h.store.wantsNotice(bob.id, 'landing'), false);
  });
});

describe('the landing switch among the notification words', () => {
  const set = (kinds: string[], on: boolean) => ({ kind: 'set', kinds, on });
  it('is reached by the words for it, and for nothing else', () => {
    for (const text of ['landing off', 'landings off', 'landed off', 'hard landing off', 'hard off', 'touchdown off', 'thump off', 'bounce off', 'remarks off', 'jokes off', 'funny off', 'banter off', 'kevin off']) {
      assert.deepEqual(parseNoticeChange(text), set(['landing'], false), text);
    }
    assert.deepEqual(parseNoticeChange('landing on'), set(['landing'], true));
    for (const text of ['completed off', 'fshub off', 'take-off off', 'warnings off']) {
      assert.ok(parseNoticeChange(text).kind === 'set' && !(parseNoticeChange(text) as { kinds: string[] }).kinds.includes('landing'), text);
    }
  });

  it('can be named with another kind', () => {
    assert.deepEqual(parseNoticeChange('take-off and landing off'), set(['takeoff', 'landing'], false));
    assert.deepEqual(parseNoticeChange('completed and landing on'), set(['completed', 'landing'], true));
  });
});

/* ------------------------------------------------------------------ who is remarked on, and when */

describe('remarking on a very hard landing', () => {
  let h: Harness;
  let sent: Array<{ to: string; content: string }>;
  let deliverable: boolean;
  let svc: HardLandings;
  const BOB_ID = 1002;
  const hard = -(HARD_FPM + 80);
  let fid: number;

  const flight = (over: Partial<FlownFlight> = {}): FlownFlight => ({
    flightId: ++fid,
    pilotId: 1001,
    pilotName: 'Alice Pilot',
    dep: 'EGLL',
    arr: 'EGKK',
    departedAt: NOW - 2 * HOUR,
    arrivedAt: NOW - 10 * 60_000,
    aircraftIcao: 'A320',
    aircraftName: 'Airbus A320',
    scheduleStatus: 'ON-TIME',
    landingRate: hard,
    ...over,
  });
  const check = (...flights: FlownFlight[]) => svc.check(h.panel, flights);
  const to = (u: { discordId: string }) => sent.filter((s) => s.to === u.discordId);

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    sent = [];
    deliverable = true;
    fid = 4_900_000;
    h.store.setPilotId(USER_A.discordId, 1001, NOW); // typed
    h.store.applyRosterLinks([{ discordId: USER_B.discordId, fshubId: BOB_ID, name: 'Bob Pilot' }], NOW); // from the roster
    svc = new HardLandings(
      h.store,
      async (id, content) => {
        sent.push({ to: id, content });
        return deliverable;
      },
      { now: () => h.clock.now },
    );
  });
  afterEach(() => h.close());

  describe('what gets one', () => {
    it('is a very hard landing by a pilot the bot knows, just landed: one message, from the scheduler, with the number', async () => {
      assert.equal(await check(flight()), 1);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.to, USER_A.discordId);
      assert.ok(sent[0]!.content.startsWith('☕ **Kevin, Scheduler**\n'));
      assert.ok(sent[0]!.content.includes(String(Math.abs(hard))));
      assert.equal(sent[0]!.content, composeRemark({ rate: hard, route: 'EGLL → EGKK', aircraft: 'A320', airline: 'Test Air', flightId: 4_900_001 }), 'the words for this flight, with its route and aircraft filled in');
    });

    it('is not a landing that was not hard, or one FsHub gave no rate for, or one that cannot be right', async () => {
      assert.equal(await check(flight({ landingRate: -(HARD_FPM - 1) }), flight({ landingRate: -200 }), flight({ landingRate: null }), flight({ landingRate: undefined }), flight({ landingRate: 0 }), flight({ landingRate: -(IMPLAUSIBLE_FPM + 1) }), flight({ landingRate: 500 })), 0);
      assert.deepEqual(sent, []);
    });

    it('is a landing exactly at the limit', async () => {
      assert.equal(await check(flight({ landingRate: -HARD_FPM })), 1);
    });

    it('uses the words for how hard it was', async () => {
      for (const [rate, severity] of [[-HARD_FPM, 'hard'], [-VERY_HARD_FPM, 'very-hard'], [-SEVERE_FPM, 'severe']] as const) {
        sent = [];
        h.clock.advance(QUIET_AFTER_MS + 1);
        const f = flight({ landingRate: rate, arrivedAt: h.clock.now - 60_000 });
        await check(f);
        const words = sent[0]!.content.split('\n')[1]!;
        const options = REMARKS[severity].map((n) => n.split('{rate}').join(String(Math.abs(rate))));
        assert.ok(options.some((o) => words.startsWith(o.split('{route}')[0]!.slice(0, 10))), `${severity}: ${words}`);
        assert.equal(sent[0]!.content, composeRemark({ rate, route: 'EGLL → EGKK', aircraft: 'A320', airline: 'Test Air', flightId: f.flightId }));
      }
    });

    it('names the airline from the panel', async () => {
      const named = new HardLandings(h.store, async (id, content) => (sent.push({ to: id, content }), true), { now: () => h.clock.now, airlineName: () => 'Sample Airways' });
      await named.check(h.panel, [flight({ landingRate: -(SEVERE_FPM + 50) })]);
      assert.equal(sent.length, 1);
    });
  });

  describe('how recent', () => {
    it('is a landing in the last few hours, and not one older than that', async () => {
      assert.equal(await check(flight({ arrivedAt: NOW - FRESH_FOR_MS - 1 })), 0);
      assert.equal(await check(flight({ arrivedAt: NOW - FRESH_FOR_MS })), 1);
    });

    it('is not remarked on for a week of old flights read for the first time', async () => {
      const week = Array.from({ length: 20 }, (_, i) => flight({ arrivedAt: NOW - (i + 5) * 6 * HOUR }));
      assert.equal(await check(...week), 0);
    });

    it('is not a landing that FsHub dates well into the future', async () => {
      assert.equal(await check(flight({ arrivedAt: NOW + 3 * HOUR })), 0);
    });
  });

  describe('only once', () => {
    it('is a flight remarked on once, however many times it is read again', async () => {
      const f = flight();
      assert.equal(await check(f), 1);
      assert.equal(await check(f), 0);
      h.clock.advance(10 * HOUR);
      assert.equal(await check({ ...f, arrivedAt: h.clock.now - 60_000 }), 0, 'even much later');
      assert.equal(sent.length, 1);
    });

    it('is remembered, and told or not', async () => {
      const f = flight();
      await check(f);
      assert.equal(h.store.hasLandingRemark(f.flightId), true);
      assert.equal(h.store.hasLandingRemark(f.flightId + 1), false);
      assert.equal(h.store.lastLandingRemarkAt(USER_A.discordId), NOW);
    });

    it('is two flights in one read, one message each for two different pilots', async () => {
      assert.equal(await check(flight(), flight({ pilotId: BOB_ID, pilotName: 'Bob Pilot' })), 2);
      assert.deepEqual(sent.map((s) => s.to).sort(), [USER_A.discordId, USER_B.discordId].sort());
    });

    it('is one message for a pilot with two hard landings close together, and the second is held back for good', async () => {
      const first = flight();
      const second = flight({ arrivedAt: NOW - 5 * 60_000 });
      assert.equal(await check(first, second), 1);
      assert.equal(to(USER_A).length, 1);
      assert.equal(h.store.hasLandingRemark(second.flightId), true, 'dealt with, though not told');
      h.clock.advance(QUIET_AFTER_MS + HOUR);
      assert.equal(await check({ ...second, arrivedAt: h.clock.now - 60_000 }), 0, 'and it does not come back later');
    });

    it('is another message once the quiet time has gone by', async () => {
      await check(flight());
      h.clock.advance(QUIET_AFTER_MS - 1);
      assert.equal(await check(flight({ arrivedAt: h.clock.now - 60_000 })), 0, 'one millisecond too soon');
      h.clock.advance(2);
      assert.equal(await check(flight({ arrivedAt: h.clock.now - 60_000 })), 1);
      assert.equal(to(USER_A).length, 2);
    });

    it('is another message at exactly the end of the quiet time', async () => {
      await check(flight());
      h.clock.advance(QUIET_AFTER_MS);
      assert.equal(await check(flight({ arrivedAt: h.clock.now - 60_000 })), 1);
    });

    it('keeps what it first recorded about a flight', async () => {
      h.store.recordLandingRemark(99, USER_A.discordId, -700, true, T0);
      h.store.recordLandingRemark(99, USER_A.discordId, -900, false, T0 + 1);
      assert.equal(h.store.wasRemarkedOn(USER_A.discordId), true, 'still counts as told');
      assert.equal(h.store.lastLandingRemarkAt(USER_A.discordId), T0);
    });

    it('is a quiet time for each person on their own', async () => {
      await check(flight());
      assert.equal(await check(flight({ pilotId: BOB_ID })), 1);
    });
  });

  describe('who counts as the pilot', () => {
    it('is nobody the bot cannot name: an unknown FsHub pilot is left alone', async () => {
      assert.equal(await check(flight({ pilotId: 9999 })), 0);
      assert.deepEqual(sent, []);
    });

    it('is the roster\'s Discord account when the roster names one, over someone who typed the same ID', async () => {
      h.store.setPilotId(USER_C.discordId, BOB_ID, NOW); // carol typed Bob's ID
      assert.equal(await check(flight({ pilotId: BOB_ID })), 1);
      assert.equal(sent[0]!.to, USER_B.discordId);
    });

    it('is nobody when two people have typed the same ID and no roster says whose it is', async () => {
      h.store.setPilotId(USER_C.discordId, 1001, NOW); // carol also typed Alice's 1001
      assert.equal(await check(flight()), 0);
      assert.deepEqual(sent, []);
    });
  });

  describe('when the person has switched it off', () => {
    it('is not sent, and the landing is dealt with so switching on later does not bring it back', async () => {
      h.store.setNotice(USER_A.discordId, 'landing', false, NOW);
      const f = flight();
      assert.equal(await check(f), 0);
      assert.deepEqual(sent, []);
      assert.equal(h.store.hasLandingRemark(f.flightId), true);
      h.store.setNotice(USER_A.discordId, 'landing', true, NOW);
      assert.equal(await check(f), 0);
      assert.deepEqual(sent, []);
    });

    it('is not held against the next one: a landing they were not told about does not start the quiet time', async () => {
      h.store.setNotice(USER_A.discordId, 'landing', false, NOW);
      await check(flight());
      h.store.setNotice(USER_A.discordId, 'landing', true, NOW);
      assert.equal(await check(flight({ arrivedAt: NOW - 5 * 60_000 })), 1);
    });

    it('is only for that person', async () => {
      h.store.setNotice(USER_A.discordId, 'landing', false, NOW);
      assert.equal(await check(flight(), flight({ pilotId: BOB_ID })), 1);
      assert.equal(sent[0]!.to, USER_B.discordId);
    });

    it('is not a thing the other two switches change', async () => {
      h.store.setNotice(USER_A.discordId, 'completed', false, NOW);
      h.store.setNotice(USER_A.discordId, 'takeoff', false, NOW);
      assert.equal(await check(flight()), 1);
    });
  });

  describe('when it cannot be delivered', () => {
    it('is not tried again: a joke that arrives late is not a joke', async () => {
      deliverable = false;
      const f = flight();
      assert.equal(await check(f), 0);
      assert.equal(sent.length, 1, 'it tried once');
      deliverable = true;
      assert.equal(await check(f), 0);
      assert.equal(sent.length, 1);
    });

    it('does not count as told, so it does not start the quiet time', async () => {
      deliverable = false;
      await check(flight());
      deliverable = true;
      assert.equal(await check(flight({ arrivedAt: NOW - 5 * 60_000 })), 1);
    });

    it('survives the sender failing outright, and carries on with the rest', async () => {
      let calls = 0;
      const grumpy = new HardLandings(
        h.store,
        async (id) => {
          calls++;
          if (calls === 1) throw new Error('the notifier broke');
          sent.push({ to: id, content: '' });
          return true;
        },
        { now: () => h.clock.now },
      );
      assert.equal(await grumpy.check(h.panel, [flight(), flight({ pilotId: BOB_ID })]), 1);
      assert.deepEqual(sent.map((s) => s.to), [USER_B.discordId]);
    });

    it('never throws, even if the store does', async () => {
      const broken = new HardLandings({ ...h.store, pruneLandingRemarks: () => { throw new Error('disk on fire'); } } as unknown as Store, async () => true, { now: () => h.clock.now });
      assert.equal(await broken.check(h.panel, [flight()]), 0);
    });
  });

  it('forgets a flight it held back after a month, and keeps one it told the pilot about', async () => {
    h.store.setNotice(USER_A.discordId, 'landing', false, NOW);
    const held = flight();
    await check(held);
    const told = flight({ pilotId: BOB_ID });
    await check(told);
    assert.equal(h.store.hasLandingRemark(held.flightId) && h.store.hasLandingRemark(told.flightId), true);
    h.clock.advance(31 * 24 * HOUR);
    await check();
    assert.equal(h.store.hasLandingRemark(held.flightId), false, 'held back: forgotten');
    assert.equal(h.store.hasLandingRemark(told.flightId), true, 'told: kept');
    assert.equal(h.store.wasRemarkedOn(USER_B.discordId), true);
    assert.equal(h.store.wasRemarkedOn(USER_A.discordId), false);
  });
});

/* ------------------------------------------------------------------ reading the flights from FsHub */

describe('landings in the flights read from FsHub', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  let fid = 4_900_000;
  const flown = (over: Partial<FsHubFlight> = {}) => {
    const f: FsHubFlight = { id: ++fid, pilotId: 1001, pilotName: 'Alice Pilot', dep: 'EGLL', arr: 'EGKK', departedAt: NOW - 2 * HOUR, arrivedAt: NOW - 10 * 60_000, aircraftIcao: 'A320', aircraftName: 'Airbus A320', scheduleStatus: 'ON-TIME', landingRate: -(HARD_FPM + 100), ...over };
    d.fshub!.flights.set(AIRLINE_ID, [...(d.fshub!.flights.get(AIRLINE_ID) ?? []), f]);
    return f;
  };
  const panel = () => h.store.getPanel(h.panel.id)!;

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    d = makeDiscordHarness(h, { fshub: true });
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    h.store.updatePanel(h.panel.id, { fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Test Air' });
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('keeps the rate FsHub recorded with the flight', async () => {
    const f = flown({ landingRate: -777 });
    await d.ctx.fshubSync!.syncFlights(panel());
    const kept = h.store.listFshubFlights(h.panel.id, 'EGLL', 'EGKK', 0, NOW + HOUR).find((k) => k.flightId === f.id)!;
    assert.equal(kept.landingRate, -777);
  });

  it('keeps no rate when FsHub gave none', async () => {
    const f = flown({ landingRate: null });
    const g = flown({ landingRate: undefined });
    await d.ctx.fshubSync!.syncFlights(panel());
    const kept = h.store.listFshubFlights(h.panel.id, 'EGLL', 'EGKK', 0, NOW + HOUR);
    assert.equal(kept.find((k) => k.flightId === f.id)!.landingRate, null);
    assert.equal(kept.find((k) => k.flightId === g.id)!.landingRate, null);
  });

  it('sends the pilot a remark when the read shows a very hard landing', async () => {
    flown();
    const r = await d.ctx.fshubSync!.syncFlights(panel());
    assert.equal(r.ok, true);
    assert.equal(alice.dms.length, 1);
    assert.match(alice.lastText, /^☕ \*\*Kevin, Scheduler\*\*\n/);
    assert.match(alice.lastText, /`fire kevin`/);
    assert.deepEqual(alice.last.allowedMentions, { parse: [] });
  });

  it('sends nothing for a normal landing, and nothing twice when the flights are read again', async () => {
    flown({ landingRate: -180 });
    await d.ctx.fshubSync!.syncFlights(panel());
    assert.equal(alice.dms.length, 0);
    flown();
    await d.ctx.fshubSync!.syncFlights(panel());
    await d.ctx.fshubSync!.syncFlights(panel());
    assert.equal(alice.dms.length, 1);
  });

  it('sends nothing to a pilot who has switched it off, and the read is still fine', async () => {
    h.store.setNotice(alice.id, 'landing', false, NOW);
    flown();
    const r = await d.ctx.fshubSync!.syncFlights(panel());
    assert.equal(r.ok, true);
    assert.equal(alice.dms.length, 0);
  });

  it('sends nothing for a pilot whose DMs are closed, and the read is still fine', async () => {
    alice.failDms = true;
    flown();
    const r = await d.ctx.fshubSync!.syncFlights(panel());
    assert.equal(r.ok, true);
  });

  it('reads a week of flights the first time without sending a week of messages', async () => {
    for (let i = 0; i < 12; i++) flown({ arrivedAt: NOW - (i + 5) * 6 * HOUR });
    await d.ctx.fshubSync!.syncFlights(panel());
    assert.equal(alice.dms.length, 0);
    assert.equal(bob.dms.length, 0);
  });

  it('does not make the read look as if it failed when what uses the flights breaks', async () => {
    const broken = d.ctx.fshubSync!;
    (broken as any).opts.onFlights = async () => {
      throw new Error('the remark broke');
    };
    flown();
    const r = await broken.syncFlights(panel());
    assert.equal(r.ok, true);
    assert.equal(panel().fshubFlightsNote, null);
  });
});

/* ------------------------------------------------------------------ reading the rate FsHub sends */

describe('reading the landing rate in what FsHub sends', () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    id: 7,
    user: { id: 500, name: 'Ann Pilot' },
    aircraft: { icao: 'B738', icao_name: 'Boeing 737-800' },
    departure: { icao: 'EGLL', time: '2026-11-11T10:00:00.000000Z' },
    arrival: { icao: 'EGKK', time: '2026-11-11T11:00:00.000000Z' },
    schedule_status: 'ON-TIME',
    ...over,
  });
  const rateOf = (over: Record<string, unknown>) => parseFlightPage([raw(over)]).flights[0]!.landingRate;

  it('is the number FsHub gives in landing_rate, in feet per minute, negative for a descent', () => {
    assert.equal(rateOf({ landing_rate: -155 }), -155);
    assert.equal(rateOf({ landing_rate: -630 }), -630);
    assert.equal(rateOf({ landing_rate: 0 }), 0);
    assert.equal(rateOf({ landing_rate: 42 }), 42, 'a positive one is kept as it is; it is the remark that ignores it');
  });

  it('is none when FsHub gives none', () => {
    assert.equal(rateOf({}), null);
    assert.equal(rateOf({ landing_rate: null }), null);
    assert.equal(rateOf({ landing_rate: undefined }), null);
  });

  it('is rounded to a whole number, and a number written as text is read', () => {
    assert.equal(rateOf({ landing_rate: -155.6 }), -156);
    assert.equal(rateOf({ landing_rate: '-201' }), -201);
    assert.equal(rateOf({ landing_rate: ' -201.4 ' }), -201);
  });

  it('is none for anything that is not a believable number, and never costs the flight', () => {
    for (const odd of ['soft', '', {}, [], true, false, Number.NaN, Number.POSITIVE_INFINITY, 1e12, -1e12, '1e3', '--5', '0x10']) {
      const page = parseFlightPage([raw({ landing_rate: odd })]);
      assert.equal(page.flights.length, 1, `the flight is still read: ${String(odd)}`);
      assert.equal(page.flights[0]!.landingRate, null, String(odd));
    }
  });

  it('is read the same way by the helper', () => {
    assert.equal(landingRateOf(-100), -100);
    assert.equal(landingRateOf('-100'), -100);
    assert.equal(landingRateOf(null), null);
    assert.equal(landingRateOf(100_001), null);
    assert.equal(landingRateOf(100_000), 100_000);
    assert.equal(landingRateOf(-100_000), -100_000);
  });

  it('does not change what else is read from the flight', () => {
    const f = parseFlightPage([raw({ landing_rate: -777 })]).flights[0]!;
    assert.deepEqual([f.id, f.pilotId, f.dep, f.arr, f.aircraftIcao, f.scheduleStatus], [7, 500, 'EGLL', 'EGKK', 'B738', 'ON-TIME']);
  });
});

/* ------------------------------------------------------------------ the upgrade */

describe('upgrading a database that does not have the landing remarks yet', () => {
  it('v28 to v29: flights kept have no rate, everyone has the remarks on, and there is a place to remember them', () => {
    const old = new DatabaseSync(':memory:');
    old.exec('PRAGMA foreign_keys = ON');
    for (let v = 0; v < 28; v++) old.exec(MIGRATIONS[v] as string);
    old.prepare(`INSERT INTO panels(guild_id, airline_id, airline_name, prefix, channel_id, created_at) VALUES ('g', 1, 'Old Air', 'OLD', 'c', 1)`).run();
    old.prepare(`INSERT INTO fshub_flights(panel_id, flight_id, pilot_id, dep, arr, arrived_at) VALUES (1, 55, 7, 'EGLL', 'EGKK', 100)`).run();
    old.prepare(`INSERT INTO user_prefs(discord_id, hide_unavailable, updated_at) VALUES ('77', 1, 5)`).run();
    assert.ok(MIGRATIONS.length >= 29);
    for (let v = 28; v < MIGRATIONS.length; v++) old.exec(MIGRATIONS[v] as string);
    const store = new Store(old);
    const [kept] = store.listFshubFlights(1, 'EGLL', 'EGKK', 0, 1000);
    assert.equal(kept!.landingRate, null);
    assert.deepEqual(store.getNotices('77'), { completed: true, takeoff: true, landing: true });
    assert.equal(store.getHideUnavailable('77'), true);
    assert.equal(store.hasLandingRemark(1), false);
    store.recordLandingRemark(1, '77', -700, true, 9);
    assert.equal(store.hasLandingRemark(1), true);
  });

  it('keeps each switch in its own column', () => {
    const db = new DatabaseSync(':memory:');
    for (const m of MIGRATIONS) db.exec(m);
    db.prepare(`INSERT INTO user_prefs(discord_id, notify_completed, notify_takeoff, notify_landing, updated_at) VALUES ('1', 0, 1, 1, 5), ('2', 1, 0, 1, 5), ('3', 1, 1, 0, 5)`).run();
    const store = new Store(db);
    assert.deepEqual(store.getNotices('1'), { completed: false, takeoff: true, landing: true });
    assert.deepEqual(store.getNotices('2'), { completed: true, takeoff: false, landing: true });
    assert.deepEqual(store.getNotices('3'), { completed: true, takeoff: true, landing: false });
    store.setNotice('4', 'landing', false, 9);
    const row = db.prepare(`SELECT notify_completed AS c, notify_takeoff AS t, notify_landing AS l FROM user_prefs WHERE discord_id = '4'`).get() as { c: number; t: number; l: number };
    assert.deepEqual([row.c, row.t, row.l], [1, 1, 0]);
  });
});

/* ------------------------------------------------------------------ what the public words say */

describe('what is written down about it', () => {
  it('says it plainly, and never names the scheduler character, in the README and /help', async () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    assert.doesNotMatch(readme, /kevin/i);
    const help = commands.find((c) => c.data.name === 'help')!;
    let payload: any = null;
    await (help as any).execute({}, { reply: async (o: any) => (payload = o) });
    assert.doesNotMatch(JSON.stringify(payload.embeds[0].toJSON()), /kevin/i);
  });

  it('is one of the switches on the notifications settings, without the character\'s name', async () => {
    const h = await makeHarness();
    const d = makeDiscordHarness(h);
    const alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    await handleDmMessage(d.ctx, fakeDm(alice, 'notifications'));
    assert.match(alice.lastText, /• \*\*Hard-landing remarks\*\*: ✅ on\. When FsHub shows you landed very hard, a light-hearted message about it\. A normal landing never gets one\./);
    assert.doesNotMatch(alice.lastText, /kevin/i);
    await settle(40);
    await h.close();
  });
});
