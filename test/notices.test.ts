import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../src/db/db.js';
import { NOTICE_KINDS, Store } from '../src/db/store.js';
import { commands, componentHandlers } from '../src/discord/commands/index.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { noticesButtons, noticesText } from '../src/discord/notices.js';
import type { FsHubFlight } from '../src/fshub/client.js';
import { DepartureWarnings } from '../src/services/departureWarnings.js';
import { NOTICE_HINT, NOTICES_REQUEST, parseNoticeChange } from '../src/services/notices.js';
import { HOUR, T0, USER_A, USER_B, USER_C, makeHarness, sj, type Harness } from './helpers.js';
import { FakeUser, fakeComponent, fakeDm, fakeInteraction, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

/* Everything below is made up: the pilots, the airline and the flights. */

const MIN = 60_000;
const setup = commands.find((c) => c.data.name === 'setup')!;

/* ------------------------------------------------------------------ reading what someone typed */

describe('reading a change to the notifications', () => {
  const set = (kinds: string[], on: boolean) => ({ kind: 'set', kinds, on });

  it('shows the settings when nothing follows', () => {
    assert.deepEqual(parseNoticeChange(''), { kind: 'show' });
    assert.deepEqual(parseNoticeChange('   '), { kind: 'show' });
  });

  it('switches both off or on when it says only that', () => {
    for (const word of ['off', 'OFF', 'Off please', 'disable', 'disabled', 'stop', 'mute', 'silence', 'pause', 'no']) {
      assert.deepEqual(parseNoticeChange(word), set(['completed', 'takeoff'], false), word);
    }
    for (const word of ['on', 'ON', 'enable', 'enabled', 'resume', 'unmute', 'yes']) {
      assert.deepEqual(parseNoticeChange(word), set(['completed', 'takeoff'], true), word);
    }
  });

  it('switches only the kind named', () => {
    for (const text of ['completed off', 'completions off', 'off completed', 'done off', 'fshub off', 'landing off', 'landed off']) {
      assert.deepEqual(parseNoticeChange(text), set(['completed'], false), text);
    }
    for (const text of ['takeoff off', 'take-off off', 'take off off', 'off take-off', 'departure off', 'warnings off', 'late off', 'heads-up off']) {
      assert.deepEqual(parseNoticeChange(text), set(['takeoff'], false), text);
    }
    assert.deepEqual(parseNoticeChange('completed on'), set(['completed'], true));
    assert.deepEqual(parseNoticeChange('takeoff on'), set(['takeoff'], true));
  });

  it('does not take the "off" in "take-off" for the answer', () => {
    assert.deepEqual(parseNoticeChange('take-off on'), set(['takeoff'], true));
    assert.deepEqual(parseNoticeChange('take off on'), set(['takeoff'], true));
    assert.deepEqual(parseNoticeChange('take-off warnings on'), set(['takeoff'], true));
    assert.deepEqual(parseNoticeChange('turn off take-off warnings'), set(['takeoff'], false));
  });

  it('can name both kinds', () => {
    assert.deepEqual(parseNoticeChange('completed and takeoff off'), set(['completed', 'takeoff'], false));
    assert.deepEqual(parseNoticeChange('turn on completed and take-off'), set(['completed', 'takeoff'], true));
  });

  it('says it cannot tell when it is neither or both', () => {
    for (const text of ['maybe', 'completed', 'take-off', 'take off', 'on off', 'off on completed', 'hello there']) {
      assert.deepEqual(parseNoticeChange(text), { kind: 'unclear' }, text);
    }
  });

  it('is asked for by the words people use', () => {
    for (const text of ['notifications', 'Notifications', 'notification', 'notify', 'NOTICES', 'notice', 'notifications off', 'notify completed off', 'notifications\ncompleted off']) {
      assert.ok(NOTICES_REQUEST.test(text), text);
    }
    // The word then a space and more is read (and may turn out "unclear"); a word that only starts the same way is not a request.
    assert.ok(NOTICES_REQUEST.test('notifications are annoying'));
    assert.equal(NOTICES_REQUEST.exec('notificationsoff'), null);
    assert.equal(NOTICES_REQUEST.exec('my notifications'), null);
    assert.equal(NOTICES_REQUEST.exec('TST-001'), null);
  });
});

/* ------------------------------------------------------------------ remembering it */

describe('the notification settings in the store', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it('has both kinds on for everyone who has said nothing', () => {
    assert.deepEqual(NOTICE_KINDS, ['completed', 'takeoff']);
    assert.deepEqual(h.store.getNotices(USER_A.discordId), { completed: true, takeoff: true });
    assert.equal(h.store.wantsNotice(USER_A.discordId, 'completed'), true);
    assert.equal(h.store.wantsNotice(USER_A.discordId, 'takeoff'), true);
  });

  it('remembers each kind on its own, for each person on their own', () => {
    h.store.setNotice(USER_A.discordId, 'completed', false, T0);
    assert.deepEqual(h.store.getNotices(USER_A.discordId), { completed: false, takeoff: true });
    h.store.setNotice(USER_A.discordId, 'takeoff', false, T0);
    assert.deepEqual(h.store.getNotices(USER_A.discordId), { completed: false, takeoff: false });
    h.store.setNotice(USER_A.discordId, 'completed', true, T0);
    assert.deepEqual(h.store.getNotices(USER_A.discordId), { completed: true, takeoff: false });
    assert.deepEqual(h.store.getNotices(USER_B.discordId), { completed: true, takeoff: true }, 'somebody else is not touched');
  });

  it('shares a row with the hide-unavailable setting without either undoing the other', () => {
    h.store.setHideUnavailable(USER_A.discordId, true, T0);
    h.store.setNotice(USER_A.discordId, 'takeoff', false, T0 + 1);
    assert.equal(h.store.getHideUnavailable(USER_A.discordId), true);
    assert.deepEqual(h.store.getNotices(USER_A.discordId), { completed: true, takeoff: false });
    h.store.setHideUnavailable(USER_A.discordId, false, T0 + 2);
    assert.deepEqual(h.store.getNotices(USER_A.discordId), { completed: true, takeoff: false }, 'switching the other setting does not bring the warnings back');
    h.store.setHideUnavailable(USER_B.discordId, true, T0);
    assert.deepEqual(h.store.getNotices(USER_B.discordId), { completed: true, takeoff: true }, 'a person who only chose that has everything on');
  });

  it('can be changed again and again', () => {
    for (let i = 0; i < 4; i++) h.store.setNotice(USER_A.discordId, 'completed', i % 2 === 1, T0 + i);
    assert.equal(h.store.wantsNotice(USER_A.discordId, 'completed'), true);
  });

  it('upgrades a v27 database: people who chose nothing have both on, and what they had chosen stays', () => {
    const old = new DatabaseSync(':memory:');
    old.exec('PRAGMA foreign_keys = ON');
    for (let v = 0; v < 27; v++) old.exec(MIGRATIONS[v] as string);
    old.prepare(`INSERT INTO user_prefs(discord_id, hide_unavailable, updated_at) VALUES ('77', 1, 5)`).run();
    assert.ok(MIGRATIONS.length >= 28);
    for (let v = 27; v < MIGRATIONS.length; v++) old.exec(MIGRATIONS[v] as string);
    const store = new Store(old);
    assert.deepEqual(store.getNotices('77'), { completed: true, takeoff: true });
    assert.equal(store.getHideUnavailable('77'), true);
    store.setNotice('77', 'takeoff', false, 9);
    assert.deepEqual(store.getNotices('77'), { completed: true, takeoff: false });
    assert.equal(store.getHideUnavailable('77'), true);
  });

  it('keeps each kind in its own column, so a database written by another build reads the same way', () => {
    const db = new DatabaseSync(':memory:');
    for (const m of MIGRATIONS) db.exec(m);
    db.prepare(`INSERT INTO user_prefs(discord_id, notify_completed, notify_takeoff, updated_at) VALUES ('1', 0, 1, 5), ('2', 1, 0, 5)`).run();
    const store = new Store(db);
    assert.deepEqual(store.getNotices('1'), { completed: false, takeoff: true });
    assert.deepEqual(store.getNotices('2'), { completed: true, takeoff: false });
    store.setNotice('3', 'completed', false, 9);
    const row = db.prepare(`SELECT notify_completed AS c, notify_takeoff AS t FROM user_prefs WHERE discord_id = '3'`).get() as { c: number; t: number };
    assert.deepEqual([row.c, row.t], [0, 1]);
  });
});

/* ------------------------------------------------------------------ the DM command and its buttons */

describe('the notifications settings, in a DM', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  const pid = () => h.panel.id;
  const say = (user: FakeUser, text: string) => handleDmMessage(d.ctx, fakeDm(user, text));
  const press = async (user: FakeUser, customId: string, o: { values?: string[] } = {}) => {
    const f = fakeComponent(user, customId, o);
    await componentHandlers.find((x) => x.prefix === customId.split(':')[0])!.handle(d.ctx, f.i);
    return f.calls;
  };
  const buttons = (payload: any) => payload.components.flatMap((r: any) => r.toJSON().components).map((b: any) => [b.custom_id, b.label, b.style]);
  const prefs = (u: FakeUser) => h.store.getNotices(u.id);

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    h.jobs.sync(pid(), [sj('s', 'EGLL-EGKK')]);
    await d.panels.refresh(pid());
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  describe('looking', () => {
    it('shows both kinds, whether each is on, what always stays on, and a button for each', async () => {
      await say(alice, 'notifications');
      assert.equal(alice.dms.length, 1);
      const text = alice.lastText;
      assert.match(text, /^🔔 \*\*Your notifications\*\*\n/);
      assert.match(text, /• \*\*Flights completed for you\*\*: ✅ on\. When FsHub shows you flew a flight, I mark it completed and tell you\./);
      assert.match(text, /• \*\*Take-off warnings\*\*: ✅ on\. A heads-up shortly before the latest time you could take off/);
      assert.match(text, /What I tell you about your reservations always stays on: a flight of yours being released or removed, a backup spot ending, and a manager changing your FsHub pilot ID\./);
      assert.match(text, /`notifications completed off`, `notifications takeoff on`, `notifications off` \(both\) or `notifications on`/);
      assert.deepEqual(buttons(alice.last), [
        ['notices:completed:off', 'Flights completed for you: on', 3],
        ['notices:takeoff:off', 'Take-off warnings: on', 3],
      ]);
      assert.deepEqual(alice.last.allowedMentions, { parse: [] });
    });

    it('is reached by any of its names, in any case', async () => {
      for (const word of ['Notifications', 'notification', 'NOTIFY', 'notices']) {
        const before = alice.dms.length;
        await say(alice, word);
        assert.equal(alice.dms.length, before + 1, word);
        assert.match(alice.lastText, /Your notifications/, word);
      }
    });

    it('changes nothing by showing', async () => {
      await say(alice, 'notifications');
      assert.deepEqual(prefs(alice), { completed: true, takeoff: true });
    });

    it('says so for a kind that is off, with the button offering to switch it back on', async () => {
      h.store.setNotice(alice.id, 'takeoff', false, T0);
      await say(alice, 'notifications');
      assert.match(alice.lastText, /• \*\*Take-off warnings\*\*: 🔕 off\./);
      assert.match(alice.lastText, /• \*\*Flights completed for you\*\*: ✅ on\./);
      assert.deepEqual(buttons(alice.last), [
        ['notices:completed:off', 'Flights completed for you: on', 3],
        ['notices:takeoff:on', 'Take-off warnings: off', 2],
      ]);
    });

    it('is a message that fits in one Discord message, however things are set', async () => {
      for (const on of [true, false]) {
        const text = noticesText({ completed: on, takeoff: on }, 'x'.repeat(100));
        assert.ok(text.length < 1800, `${text.length}`);
      }
      assert.equal(noticesButtons({ completed: true, takeoff: true }).length, 1, 'one row');
    });

    it('is the same whether or not a Reserve conversation is open, and leaves it open', async () => {
      await press(alice, `panel:reserve:${pid()}`);
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_code');
      const before = alice.dms.length;
      await say(alice, 'notifications');
      assert.equal(alice.dms.length, before + 1);
      assert.match(alice.lastText, /Your notifications/);
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_code', 'still open');
      await say(alice, 'TST-001');
      assert.match(alice.lastText, /is reserved for you/);
    });

    it('is mentioned in what people are told when they message the bot with nothing open', async () => {
      await say(bob, 'hello');
      assert.match(bob.lastText, /`notifications` to choose which messages I send you\./);
    });
  });

  describe('changing it by typing', () => {
    it('switches one kind off, says so, and shows the button to switch it back', async () => {
      await say(alice, 'notifications completed off');
      assert.deepEqual(prefs(alice), { completed: false, takeoff: true });
      assert.match(alice.lastText, /^🔕 Switched off: \*\*Flights completed for you\*\*\.\n\n🔔 \*\*Your notifications\*\*/);
      assert.match(alice.lastText, /• \*\*Flights completed for you\*\*: 🔕 off\./);
      assert.equal(buttons(alice.last)[0][0], 'notices:completed:on');
    });

    it('switches the other kind, and the first stays as it was', async () => {
      await say(alice, 'notifications completed off');
      await say(alice, 'notifications takeoff off');
      assert.deepEqual(prefs(alice), { completed: false, takeoff: false });
      await say(alice, 'notifications take-off on');
      assert.deepEqual(prefs(alice), { completed: false, takeoff: true });
      assert.match(alice.lastText, /^✅ Switched on: \*\*Take-off warnings\*\*\./);
    });

    it('switches both with just off, and back with just on', async () => {
      await say(alice, 'notifications off');
      assert.deepEqual(prefs(alice), { completed: false, takeoff: false });
      assert.match(alice.lastText, /^🔕 Switched off: \*\*Flights completed for you\*\* and \*\*Take-off warnings\*\*\./);
      await say(alice, 'notify on');
      assert.deepEqual(prefs(alice), { completed: true, takeoff: true });
    });

    it('is only for the person who asked', async () => {
      await say(alice, 'notifications off');
      assert.deepEqual(prefs(bob), { completed: true, takeoff: true });
    });

    it('says it could not tell, changes nothing, and shows how things are', async () => {
      h.store.setNotice(alice.id, 'completed', false, T0);
      await say(alice, 'notifications maybe later');
      assert.deepEqual(prefs(alice), { completed: false, takeoff: true });
      assert.match(alice.lastText, /^I couldn't tell what you wanted to change, so nothing is different\. Here is how things are:\n\n🔔 \*\*Your notifications\*\*/);
    });

    it('is the same again when it is said twice', async () => {
      await say(alice, 'notifications completed off');
      await say(alice, 'notifications completed off');
      assert.deepEqual(prefs(alice), { completed: false, takeoff: true });
    });
  });

  describe('changing it with a button', () => {
    it('switches that kind and redraws the same message to show how things are now', async () => {
      await say(alice, 'notifications');
      const calls = await press(alice, 'notices:completed:off');
      assert.deepEqual(prefs(alice), { completed: false, takeoff: true });
      assert.equal(calls.updates.length, 1, 'the message is edited in place');
      const u = calls.updates[0];
      assert.match(u.content, /^🔕 Switched off: \*\*Flights completed for you\*\*\.\n\n🔔 \*\*Your notifications\*\*/);
      assert.deepEqual(buttons(u), [
        ['notices:completed:on', 'Flights completed for you: off', 2],
        ['notices:takeoff:off', 'Take-off warnings: on', 3],
      ]);
      assert.deepEqual(u.allowedMentions, { parse: [] });
    });

    it('turns it back on with the button it now shows', async () => {
      await press(alice, 'notices:takeoff:off');
      const calls = await press(alice, 'notices:takeoff:on');
      assert.deepEqual(prefs(alice), { completed: true, takeoff: true });
      assert.match(calls.updates[0].content, /^✅ Switched on: \*\*Take-off warnings\*\*\./);
    });

    it('does not flip back when an old message is pressed twice: a button says which way it goes', async () => {
      await press(alice, 'notices:completed:off');
      await press(alice, 'notices:completed:off');
      assert.equal(prefs(alice).completed, false);
    });

    it('is only for the person who pressed it', async () => {
      await press(alice, 'notices:completed:off');
      assert.deepEqual(prefs(bob), { completed: true, takeoff: true });
    });

    it('says an unknown or damaged button is out of date, and changes nothing', async () => {
      for (const id of ['notices:nonsense:off', 'notices:completed:maybe', 'notices:completed', 'notices:', 'notices:toggle:completed']) {
        const calls = await press(alice, id);
        assert.match(calls.updates[0].content, /That button is out of date\. Send me `notifications` for the current ones\./, id);
        assert.deepEqual(calls.updates[0].components, []);
      }
      assert.deepEqual(prefs(alice), { completed: true, takeoff: true });
    });

    it('is not something a menu can do: only a button', async () => {
      const calls = await press(alice, 'notices:completed:off', { values: ['x'] });
      assert.equal(calls.updates.length, 0);
      assert.deepEqual(prefs(alice), { completed: true, takeoff: true });
    });
  });
});

/* ------------------------------------------------------------------ the messages that can be switched off */

describe('the flight-completed message', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  let fid = 4_900_000;
  let pid: number;
  const NOW = T0 + 6 * HOUR;
  const AIRLINE_ID = 8123;

  const flown = (over: Partial<FsHubFlight> = {}) => {
    const f: FsHubFlight = { id: ++fid, pilotId: 1001, pilotName: 'Alice Pilot', dep: 'EGLL', arr: 'EGKK', departedAt: NOW - 3 * HOUR, arrivedAt: NOW - 2 * HOUR, aircraftIcao: 'A320', aircraftName: 'Airbus A320', scheduleStatus: 'ON-TIME', ...over };
    d.fshub!.flights.set(AIRLINE_ID, [...(d.fshub!.flights.get(AIRLINE_ID) ?? []), f]);
  };
  const jobId = (key: string) => h.store.listJobs(pid).find((j) => j.sourceKey === key)!.id;
  const hold = (key: string, user: FakeUser) => h.jobs.reserve(jobId(key), [1], { discordId: user.id, username: user.username });
  const completed = (key: string) => h.store.getJob(jobId(key))!.completedAt !== null;

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    d = makeDiscordHarness(h, { fshub: true });
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    pid = h.panel.id;
    h.store.updatePanel(pid, { fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Test Air' });
    h.jobs.sync(pid, [
      sj('s', 'EGLL-EGKK', { aircraft: 'A320', availableFrom: T0, deadline: T0 + 12 * HOUR }),
      sj('u', 'EGCC-EGPH', { aircraft: 'A320', availableFrom: T0, deadline: T0 + 12 * HOUR }),
    ]);
    await d.panels.refresh(pid);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('is sent to a pilot who has not said otherwise, with a line saying how to stop it', async () => {
    hold('s', alice);
    flown();
    await d.ctx.autoComplete!.run();
    assert.equal(alice.dms.length, 1);
    assert.match(alice.lastText, /so I marked it completed/);
    assert.ok(alice.lastText.endsWith(`\n${NOTICE_HINT}`));
    assert.equal(NOTICE_HINT, "Don't want these? DM me `notifications` to switch them off.");
  });

  it('is not sent to a pilot who switched it off, but the flight is still completed for them', async () => {
    h.store.setNotice(alice.id, 'completed', false, NOW);
    hold('s', alice);
    flown();
    const [r] = await d.ctx.autoComplete!.run();
    assert.equal(r!.completed.length, 1);
    assert.equal(completed('s'), true, 'completed all the same');
    assert.equal(h.store.getJob(jobId('s'))!.completedVia, 'fshub');
    assert.equal(alice.dms.length, 0, 'but not told');
  });

  it('is only left out for the pilot who switched it off', async () => {
    h.store.setNotice(alice.id, 'completed', false, NOW);
    hold('s', alice);
    hold('u', bob);
    flown();
    flown({ dep: 'EGCC', arr: 'EGPH', pilotId: 1002 });
    await d.ctx.autoComplete!.run();
    assert.equal(completed('s') && completed('u'), true);
    assert.equal(alice.dms.length, 0);
    assert.equal(bob.dms.length, 1);
    assert.match(bob.lastText, /TST-002/);
  });

  it('is not left out because the take-off warnings are switched off', async () => {
    h.store.setNotice(alice.id, 'takeoff', false, NOW);
    hold('s', alice);
    flown();
    await d.ctx.autoComplete!.run();
    assert.equal(alice.dms.length, 1);
  });

  it('comes back when it is switched on again', async () => {
    h.store.setNotice(alice.id, 'completed', false, NOW);
    h.store.setNotice(alice.id, 'completed', true, NOW);
    hold('s', alice);
    flown();
    await d.ctx.autoComplete!.run();
    assert.equal(alice.dms.length, 1);
  });

  it('is left out too when the pilot has just landed and the live feed completes the flight', async () => {
    h.store.setNotice(alice.id, 'completed', false, NOW);
    hold('s', alice);
    flown();
    const r = await d.ctx.autoComplete!.runPanel(h.store.getPanel(pid)!, { only: new Set([alice.id]) });
    assert.equal(r.completed.length, 1);
    assert.equal(alice.dms.length, 0);
  });
});

describe('the take-off warning', () => {
  let h: Harness;
  let sent: Array<{ to: string; content: string }>;
  let svc: DepartureWarnings;
  const pid = () => h.panel.id;
  const view = (key: string) => h.jobs.open(pid()).find((v) => v.job.sourceKey === key)!;
  const at = (hours: number) => T0 + hours * HOUR;
  const to = (u: { discordId: string }) => sent.filter((s) => s.to === u.discordId);
  /** A 2 hour flight that must be down by 19:00Z (T0 is 12:00Z): taken by Alice, with Bob as her backup. */
  const taken = () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { availableFrom: at(-2), deadline: at(7) })]);
    h.jobs.reserve(view('a').job.id, [1], USER_A);
    h.jobs.addBackup(view('a').job.id, USER_B);
  };

  beforeEach(async () => {
    h = await makeHarness();
    sent = [];
    svc = new DepartureWarnings(
      h.store,
      h.jobs,
      { forLeg: async () => ({ minutes: 120, source: 'learned', basis: 'made up' }) },
      async (id, content) => {
        sent.push({ to: id, content });
        return true;
      },
      { now: () => h.clock.now },
    );
  });
  afterEach(() => h.close());

  it('goes to the pilot and the backup who have not said otherwise, each with a line saying how to stop it', async () => {
    taken();
    h.clock.now = at(4.5);
    assert.equal(await svc.run(), 2);
    for (const u of [USER_A, USER_B]) assert.ok(to(u)[0]!.content.endsWith(`\n${NOTICE_HINT}`), u.username);
  });

  it('is not sent to a pilot who switched it off, and the backup is still warned', async () => {
    h.store.setNotice(USER_A.discordId, 'takeoff', false, T0);
    taken();
    h.clock.now = at(4.5);
    assert.equal(await svc.run(), 1);
    assert.equal(to(USER_A).length, 0);
    assert.equal(to(USER_B).length, 1);
    assert.match(to(USER_B)[0]!.content, /you are down as its backup/);
  });

  it('is not sent to a backup who switched it off, and the pilot is still warned', async () => {
    h.store.setNotice(USER_B.discordId, 'takeoff', false, T0);
    taken();
    h.clock.now = at(4.5);
    assert.equal(await svc.run(), 1);
    assert.equal(to(USER_B).length, 0);
    assert.equal(to(USER_A).length, 1);
  });

  it('is not sent to anyone when both have switched it off', async () => {
    h.store.setNotice(USER_A.discordId, 'takeoff', false, T0);
    h.store.setNotice(USER_B.discordId, 'takeoff', false, T0);
    taken();
    h.clock.now = at(4.5);
    assert.equal(await svc.run(), 0);
    assert.deepEqual(sent, []);
  });

  it('is not left out because the completed-flight message is switched off', async () => {
    h.store.setNotice(USER_A.discordId, 'completed', false, T0);
    taken();
    h.clock.now = at(4.5);
    assert.equal(await svc.run(), 2);
  });

  it('does not count as sent for someone who switched it off, so switching it on in time still warns them', async () => {
    h.store.setNotice(USER_A.discordId, 'takeoff', false, T0);
    taken();
    h.clock.now = at(4.5);
    await svc.run();
    assert.equal(h.store.wasWarned(view('a').job.id, USER_A.discordId), false, 'not marked as warned');
    h.store.setNotice(USER_A.discordId, 'takeoff', true, h.clock.now);
    h.clock.advance(5 * MIN); // 16:35, still before the 17:00 take-off
    assert.equal(await svc.run(), 1);
    assert.equal(to(USER_A).length, 1);
    assert.equal(h.store.wasWarned(view('a').job.id, USER_A.discordId), true);
  });

  it('does not come late for someone who switches it on after the latest take-off has passed', async () => {
    h.store.setNotice(USER_A.discordId, 'takeoff', false, T0);
    taken();
    h.clock.now = at(4.5);
    await svc.run();
    h.store.setNotice(USER_A.discordId, 'takeoff', true, h.clock.now);
    h.clock.now = at(5.5);
    assert.equal(await svc.run(), 0);
    assert.equal(to(USER_A).length, 0);
  });

  it('is sent only once to someone who switches it off and on again after being warned', async () => {
    taken();
    h.clock.now = at(4.5);
    await svc.run();
    h.store.setNotice(USER_A.discordId, 'takeoff', false, h.clock.now);
    h.store.setNotice(USER_A.discordId, 'takeoff', true, h.clock.now);
    h.clock.advance(MIN);
    await svc.run();
    assert.equal(to(USER_A).length, 1);
  });
});

/* ------------------------------------------------------------------ what always goes out */

describe('the messages that stay on whatever is switched off', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  const pid = () => h.panel.id;
  const idOf = (key: string) => h.store.listJobs(pid()).find((j) => j.sourceKey === key)!.id;
  const off = (u: FakeUser) => {
    h.store.setNotice(u.id, 'completed', false, T0);
    h.store.setNotice(u.id, 'takeoff', false, T0);
  };

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h, { fshub: true });
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK'), sj('b', 'EGKK-EGCC')]);
    await d.panels.refresh(pid());
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('tells a pilot their reservation was released when the flight left the schedule', async () => {
    off(alice);
    h.jobs.reserve(idOf('a'), [1], USER_A);
    h.jobs.sync(pid(), [sj('b', 'EGKK-EGCC')]);
    await settle();
    assert.match(alice.lastText, /^Heads up: flight \*\*TST-001\*\* \(leg 1\) is no longer listed, so your reservation was released\.$/);
  });

  it('tells a pilot their reservation was released when its route changed', async () => {
    off(alice);
    h.jobs.reserve(idOf('a'), [1], USER_A);
    h.jobs.sync(pid(), [sj('a', 'EGLL-LFPG'), sj('b', 'EGKK-EGCC')]);
    await settle();
    assert.match(alice.lastText, /changed \(different route\), so your reservation was released/);
  });

  it('tells a backup that their backup spot ended', async () => {
    off(bob);
    h.jobs.reserve(idOf('a'), [1], USER_A);
    h.jobs.addBackup(idOf('a'), USER_B);
    h.jobs.sync(pid(), [sj('b', 'EGKK-EGCC')]);
    await settle();
    assert.match(bob.lastText, /^Heads up: flight \*\*TST-001\*\*, which you were down as backup for, is no longer listed, so your backup spot has ended\.$/);
  });

  it('tells a pilot when a manager changes their FsHub pilot ID', async () => {
    d.fshub!.pilots.set(1234, { id: 1234, name: 'Alex Smith', base: null, country: null });
    off(alice);
    const f = fakeInteraction({ sub: 'id-add', userId: '555555555555555555', admin: true, options: { user: alice, id: '1234' } });
    await setup.execute(d.ctx, f.i);
    await settle();
    assert.match(alice.lastText, /A manager \(<@555555555555555555>\) set your FsHub pilot ID to \*\*1234\*\*/);
  });

  it('still answers everything the person asks for themselves: reserving, the flights command, metar, and the settings', async () => {
    off(alice);
    await handleDmMessage(d.ctx, fakeDm(alice, 'flights'));
    assert.ok(alice.dms.length >= 1, 'flights');
    const before = alice.dms.length;
    await handleDmMessage(d.ctx, fakeDm(alice, 'notifications'));
    assert.equal(alice.dms.length, before + 1);
    assert.match(alice.lastText, /• \*\*Take-off warnings\*\*: 🔕 off\./);
    const f = fakeComponent(alice, `panel:reserve:${pid()}`);
    await componentHandlers.find((x) => x.prefix === 'panel')!.handle(d.ctx, f.i);
    await handleDmMessage(d.ctx, fakeDm(alice, 'TST-001'));
    assert.match(alice.lastText, /is reserved for you/);
  });

  it('has no switch for any of them: the only kinds there are are the two optional ones', async () => {
    assert.deepEqual(NOTICE_KINDS, ['completed', 'takeoff']);
    for (const text of ['released off', 'reservation off', 'backup off', 'removed off', 'off']) {
      const change = parseNoticeChange(text);
      assert.equal(change.kind, 'set', text);
      if (change.kind === 'set') assert.ok(change.kinds.every((k) => NOTICE_KINDS.includes(k)), text);
    }
    await handleDmMessage(d.ctx, fakeDm(alice, 'notifications backup off'));
    assert.deepEqual(h.store.getNotices(alice.id), { completed: false, takeoff: false }, 'it switched the two optional kinds, and there is nothing else to switch');
    h.jobs.reserve(idOf('a'), [1], USER_A);
    h.jobs.addBackup(idOf('a'), USER_B);
    h.jobs.sync(pid(), [sj('b', 'EGKK-EGCC')]);
    await settle();
    assert.match(alice.lastText, /your reservation was released/, 'and the reservation message still came');
  });
});

/* ------------------------------------------------------------------ where it is mentioned */

describe('where the notification settings are mentioned', () => {
  it('is in /help', async () => {
    const help = commands.find((c) => c.data.name === 'help')!;
    let payload: any = null;
    await (help as any).execute({}, { reply: async (o: any) => (payload = o) });
    const e = payload.embeds[0].toJSON();
    const text = JSON.stringify(e);
    assert.match(text, /`notifications`/);
    const size = (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0) + e.fields.reduce((n: number, f: any) => n + f.name.length + f.value.length, 0);
    assert.ok(size <= 6000, `${size} characters is more than one Discord message of embeds can hold`);
    assert.ok(e.fields.every((f: any) => f.value.length <= 1024));
    assert.ok(e.fields.length <= 25);
  });
});
