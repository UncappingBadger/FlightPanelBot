import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setupCommand } from '../src/discord/commands/setup.js';
import { UserError } from '../src/discord/errors.js';
import { MAX_REMINDER_FLIGHTS, reminderTarget, renderReminder, utcDayLabel } from '../src/discord/ui.js';
import type { SourceJob } from '../src/jobs/types.js';
import { CATCH_UP_UNTIL_MS, CLEANUP_BEFORE_MIDNIGHT_MS, DAY_MS, ReminderService, startOfUtcDay, type DeliverReminder, type Reminder } from '../src/services/reminders.js';
import { Scheduler } from '../src/services/scheduler.js';
import { SourceRefresher } from '../src/services/refresh.js';
import { CHANNEL, GUILD, HOUR, makeHarness, sj, T0, USER_A, USER_B, type Harness } from './helpers.js';
import { fakeInteraction, makeDiscordHarness, settle, type DiscordHarness, type FakeInteractionOptions } from './discord-helpers.js';

const MIN = 60_000;
/** Midnight UTC at the start of "today" in these tests: 2026-11-11 00:00Z, a Wednesday (T0 is noon that day). */
const D0 = startOfUtcDay(T0);
/** A moment `hours` into the day `days` days after today. */
const at = (days: number, hours: number) => D0 + days * DAY_MS + hours * HOUR;

/** A flight whose window opens `hours` into the day `days` after today, and runs for a day after that. */
const opens = (key: string, days: number, hours: number, chain = 'EGLL-EGKK', over: Partial<SourceJob> = {}) =>
  sj(key, chain, { availableFrom: at(days, hours), deadline: at(days, hours + 24), ...over });

describe('listing the day\'s flights that have no pilot, at midnight', () => {
  let h: Harness;
  let delivered: Array<{ panelId: number; codes: string[]; openLegs: number[][] }>;
  let outcome: boolean;
  let reminders: ReminderService;
  const pid = () => h.panel.id;

  const deliver: DeliverReminder = async (panel, due) => {
    delivered.push({ panelId: panel.id, codes: due.map((r) => r.view.job.code), openLegs: due.map((r) => r.openLegs) });
    return outcome;
  };
  const codesDue = () => reminders.due(h.store.getPanel(pid())!).map((r) => r.view.job.code);
  const job = (code: string) => h.jobs.open(pid()).find((v) => v.job.code === code)!;
  const day = () => h.store.getPanel(pid())!.remindedDay;
  /** The bot has looked at the panel once, on the evening before the day under test, as it would have by then. */
  const primed = async () => {
    h.clock.now = at(0, 20);
    await reminders.run();
    delivered = [];
  };

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = T0;
    delivered = [];
    outcome = true;
    reminders = new ReminderService(h.store, h.jobs, deliver, { now: () => h.clock.now });
  });
  afterEach(async () => {
    await h.close();
  });

  describe('which flights count', () => {
    it('is every unstaffed flight whose window opens today, however early or late, and not yesterday\'s or tomorrow\'s', () => {
      h.clock.now = at(0, 0);
      h.jobs.sync(pid(), [
        opens('early', 0, 0), // opens at the stroke of midnight
        opens('morning', 0, 6, 'EGLL-EGCC'),
        opens('late', 0, 23.5, 'EGLL-EGPH'),
        opens('yesterday', -1, 23, 'EGKK-EGCC'),
        opens('tomorrow', 1, 0, 'EGKK-EGPH'),
        opens('later', 3, 10, 'EGCC-EGPH'),
      ]);
      assert.deepEqual(codesDue(), ['TST-001', 'TST-002', 'TST-003'], 'only the first three open today');
    });

    it('does not care how far off each flight is: the 24 hour rule is gone', () => {
      h.clock.now = at(0, 0);
      h.jobs.sync(pid(), [opens('soon', 0, 0.5), opens('far', 0, 23.9, 'EGLL-EGCC')]);
      assert.deepEqual(codesDue(), ['TST-001', 'TST-002'], 'half an hour away and nearly a day away are both listed');
    });

    it('still lists a flight whose window has already opened today but is not over', () => {
      h.jobs.sync(pid(), [opens('open-now', 0, 6)]);
      h.clock.now = at(0, 15);
      assert.deepEqual(codesDue(), ['TST-001']);
    });

    it('never lists a flight whose deadline has passed, even before anything has closed it', () => {
      h.clock.now = at(0, 1);
      h.jobs.sync(pid(), [opens('a', 0, 2, 'EGLL-EGKK', { deadline: at(0, 8) })]);
      assert.deepEqual(h.jobs.open(pid()).map((v) => v.job.code), ['TST-001'], 'still open: nothing has closed it');
      h.clock.now = at(0, 8) - 1;
      assert.deepEqual(codesDue(), ['TST-001'], 'a millisecond before its deadline it is still worth asking about');
      h.clock.now = at(0, 8);
      assert.deepEqual(codesDue(), [], 'at its deadline it is too late');
      h.clock.now = at(0, 9);
      assert.deepEqual(codesDue(), []);
    });

    it('counts a flight with no start time from its deadline', () => {
      h.clock.now = at(0, 0);
      h.jobs.sync(pid(), [sj('today', 'EGLL-EGKK', { availableFrom: null, deadline: at(0, 18) }), sj('later', 'EGLL-EGCC', { availableFrom: null, deadline: at(2, 18) })]);
      assert.deepEqual(codesDue(), ['TST-001']);
    });

    it('ignores a flight with no times at all', () => {
      h.jobs.sync(pid(), [sj('x', 'EGLL-EGKK', { availableFrom: null, deadline: null })]);
      assert.deepEqual(codesDue(), []);
    });

    it('measures from the start of the window, not the deadline', () => {
      h.clock.now = at(0, 0);
      h.jobs.sync(pid(), [opens('a', 1, 2, 'EGLL-EGKK', { deadline: at(1, 5) }), opens('b', 0, 20, 'EGLL-EGCC', { deadline: at(1, 20) })]);
      assert.deepEqual(codesDue(), ['TST-002'], 'a flight that opens tomorrow is tomorrow\'s even if it is short, and one that opens tonight is today\'s even if it runs into tomorrow');
    });

    it('skips a flight someone has reserved, or whose pilot is named in the airline\'s own schedule', () => {
      h.clock.now = at(0, 0);
      const named = opens('named', 0, 5, 'EGLL-EGCC');
      named.legs = named.legs.map((l) => ({ ...l, heldBy: 'Taylor' }));
      h.jobs.sync(pid(), [opens('taken', 0, 5), named, opens('free', 0, 5, 'EGLL-EGPH')]);
      h.jobs.reserve(job('TST-001').job.id, [1], USER_A);
      assert.deepEqual(codesDue(), ['TST-003']);
    });

    it('for a multi-leg flight, lists the legs that are still open', () => {
      h.clock.now = at(0, 0);
      h.jobs.sync(pid(), [opens('m', 0, 5, 'EGLL-EGKK-EGCC-EGPH')]);
      h.jobs.reserve(job('TST-001').job.id, [2], USER_A);
      const [r] = reminders.due(h.store.getPanel(pid())!);
      assert.deepEqual(r!.openLegs, [1, 3]);
      h.jobs.reserve(job('TST-001').job.id, [1, 3], USER_B);
      assert.deepEqual(codesDue(), [], 'fully staffed now');
    });

    it('lists the soonest flight first', () => {
      h.clock.now = at(0, 0);
      h.jobs.sync(pid(), [opens('later', 0, 20), opens('sooner', 0, 3, 'EGLL-EGCC'), opens('middle', 0, 9, 'EGLL-EGPH')]);
      assert.deepEqual(codesDue(), ['TST-002', 'TST-003', 'TST-001']);
    });

    it('lists them by when they open, not by deadline or by the order they were added, and by ID when they open together', () => {
      h.clock.now = at(0, 0);
      h.jobs.sync(pid(), [
        opens('a', 0, 3, 'EGLL-EGKK', { deadline: at(1, 20) }),
        opens('b', 0, 9, 'EGLL-EGCC', { deadline: at(0, 20) }),
        opens('c', 0, 1, 'EGLL-EGPH', { deadline: at(2, 0) }),
        opens('d', 0, 12, 'EGKK-EGCC', { deadline: at(1, 12) }),
        opens('e', 0, 12, 'EGKK-EGPH', { deadline: at(1, 12) }),
      ]);
      assert.deepEqual(codesDue(), ['TST-003', 'TST-001', 'TST-002', 'TST-004', 'TST-005']);
    });
  });

  describe('the list', () => {
    it('is one message at midnight with every flight of the day that has no pilot, however differently they open', async () => {
      await primed(); // 20:00 on the day before
      h.jobs.sync(pid(), [opens('a', 1, 2), opens('b', 1, 9, 'EGLL-EGCC'), opens('c', 1, 17, 'EGLL-EGPH'), opens('d', 1, 22, 'EGKK-EGCC'), opens('next', 2, 1, 'EGKK-EGPH')]);
      h.clock.now = at(1, 0);
      assert.equal(await reminders.run(), 1);
      assert.deepEqual(delivered.map((d) => d.codes), [['TST-001', 'TST-002', 'TST-003', 'TST-004']], 'one message; the day after is not in it');
    });

    it('is only once that day: nothing more at any later pass, whatever happens to the flights', async () => {
      await primed();
      h.jobs.sync(pid(), [opens('a', 1, 2), opens('b', 1, 14, 'EGLL-EGCC')]);
      h.clock.now = at(1, 0);
      await reminders.run();
      for (const [hours, mins] of [[0, 1], [1, 0], [2, 0], [8, 30], [13, 59], [14, 0], [20, 0], [23, 58]] as const) {
        h.clock.now = at(1, hours) + mins * MIN;
        await reminders.run();
      }
      assert.equal(delivered.length, 1, 'including after the times the old 24-hour ping would have gone');
    });

    it('does not announce a flight again when its pilot gives it up later in the day', async () => {
      await primed();
      h.jobs.sync(pid(), [opens('a', 1, 14), opens('b', 1, 16, 'EGLL-EGCC')]);
      h.jobs.reserve(job('TST-001').job.id, [1], USER_A);
      h.clock.now = at(1, 0);
      await reminders.run();
      assert.deepEqual(delivered.map((d) => d.codes), [['TST-002']]);
      h.jobs.release(job('TST-001').job.id, USER_A.discordId);
      h.clock.now = at(1, 5);
      await reminders.run();
      assert.equal(delivered.length, 1, 'nobody is pinged about it; the pilot who gave it back is asked to spread the word');
    });

    it('says nothing, and is done for the day, when every flight of the day has a pilot', async () => {
      await primed();
      h.jobs.sync(pid(), [opens('a', 1, 14)]);
      h.jobs.reserve(job('TST-001').job.id, [1], USER_A);
      h.clock.now = at(1, 0);
      assert.equal(await reminders.run(), 0);
      assert.equal(day(), 1 + D0 / DAY_MS);
      h.jobs.release(job('TST-001').job.id, USER_A.discordId);
      h.clock.now = at(1, 3);
      assert.equal(await reminders.run(), 0, 'and a flight that loses its pilot after that is not announced either');
      assert.deepEqual(delivered, []);
    });

    it('is the next day\'s flights the next midnight, and not the flights that are still unstaffed from yesterday', async () => {
      await primed();
      h.jobs.sync(pid(), [opens('a', 1, 10), opens('b', 2, 10, 'EGLL-EGCC')]);
      h.clock.now = at(1, 0);
      await reminders.run();
      h.clock.now = at(2, 0);
      await reminders.run();
      assert.deepEqual(delivered.map((d) => d.codes), [['TST-001'], ['TST-002']]);
    });

    it('is left out for a day with no flights, and posts again on a day with some', async () => {
      await primed();
      h.clock.now = at(1, 0);
      assert.equal(await reminders.run(), 0);
      h.jobs.sync(pid(), [opens('a', 2, 4)]);
      h.clock.now = at(2, 0);
      assert.equal(await reminders.run(), 1);
    });

    it('is remembered in the database, so a restart does not post it twice', async () => {
      await primed();
      h.jobs.sync(pid(), [opens('a', 1, 4)]);
      h.clock.now = at(1, 0);
      await reminders.run();
      const restarted = new ReminderService(h.store, h.jobs, deliver, { now: () => h.clock.now });
      h.clock.now = at(1, 7);
      assert.equal(await restarted.run(), 0);
      assert.equal(delivered.length, 1);
    });

    it('does not mark flights as announced any more', async () => {
      await primed();
      h.jobs.sync(pid(), [opens('a', 1, 4)]);
      h.clock.now = at(1, 0);
      await reminders.run();
      assert.equal(job('TST-001').job.remindedAt, null);
    });

    it('keeps panels apart: each gets its own message with only its own flights', async () => {
      const second = h.store.createPanel({ guildId: GUILD, name: 'Other Air', abbr: 'OTH', prefix: 'OTH', channelId: '700000000000000002', now: T0 });
      await primed();
      await reminders.run();
      h.jobs.sync(pid(), [opens('a', 1, 5)]);
      h.jobs.sync(second.id, [opens('z', 1, 6, 'EGPH-EGLL')]);
      h.clock.now = at(1, 0);
      assert.equal(await reminders.run(), 2);
      assert.deepEqual(delivered.map((d) => [d.panelId, d.codes]).sort(), [[pid(), ['TST-001']], [second.id, ['OTH-001']]].sort());
    });
  });

  describe('a panel the bot has not looked at before', () => {
    it('is counted as done for that day without a message, so adding a panel or installing this version never pings at an odd hour', async () => {
      h.jobs.sync(pid(), [opens('a', 0, 20)]);
      h.clock.now = at(0, 14);
      assert.equal(h.store.getPanel(pid())!.remindedDay, null);
      assert.equal(await reminders.run(), 0);
      assert.deepEqual(delivered, []);
      assert.equal(day(), D0 / DAY_MS);
    });

    it('is listed from the next midnight', async () => {
      h.jobs.sync(pid(), [opens('a', 1, 6)]);
      h.clock.now = at(0, 14);
      await reminders.run();
      h.clock.now = at(1, 0);
      assert.equal(await reminders.run(), 1);
    });

    it('is dealt with by the first pass even a moment after midnight', async () => {
      h.jobs.sync(pid(), [opens('a', 1, 6)]);
      h.clock.now = at(1, 0) + 20_000;
      assert.equal(await reminders.run(), 0, 'it did not exist at midnight, so there is nothing to catch up on');
    });
  });

  describe('when the bot was off at midnight', () => {
    it('lists the day\'s flights as soon as it is back, if that is before 22:00', async () => {
      await primed();
      h.jobs.sync(pid(), [opens('a', 1, 2), opens('b', 1, 20, 'EGLL-EGCC')]);
      h.clock.now = at(1, 8);
      assert.equal(await reminders.run(), 1);
      assert.deepEqual(delivered.map((d) => d.codes), [['TST-001', 'TST-002']]);
    });

    it('is back at 22:00 sharp: still listed; a minute later, let go for that day', async () => {
      await primed();
      h.jobs.sync(pid(), [opens('a', 1, 23)]);
      h.clock.now = at(1, 0) + CATCH_UP_UNTIL_MS;
      assert.equal(await reminders.run(), 1);

      delivered = [];
      h.store.updatePanel(pid(), { remindedDay: D0 / DAY_MS });
      h.clock.now = at(1, 0) + CATCH_UP_UNTIL_MS + MIN;
      assert.equal(await reminders.run(), 0, 'too late in the day to be worth it');
      assert.equal(day(), 1 + D0 / DAY_MS, 'and the day is recorded as dealt with, so it is not looked at again');
      h.clock.now = at(1, 23);
      assert.equal(await reminders.run(), 0, 'and it is not tried again that day');
      assert.equal(CATCH_UP_UNTIL_MS, 22 * HOUR);
    });

    it('and the next midnight is on time as usual', async () => {
      await primed();
      h.jobs.sync(pid(), [opens('a', 1, 23), opens('b', 2, 3, 'EGLL-EGCC')]);
      h.clock.now = at(1, 22.5);
      await reminders.run();
      h.clock.now = at(2, 0);
      assert.equal(await reminders.run(), 1);
      assert.deepEqual(delivered.map((d) => d.codes), [['TST-002']]);
    });
  });

  describe('when the message cannot be sent', () => {
    it('does not count the day as done, waits an hour, then tries again', async () => {
      await primed();
      h.jobs.sync(pid(), [opens('a', 1, 5)]);
      h.clock.now = at(1, 0);
      outcome = false;
      assert.equal(await reminders.run(), 0);
      assert.equal(day(), D0 / DAY_MS, 'still yesterday');

      outcome = true;
      h.clock.now = at(1, 0) + 30 * MIN;
      await reminders.run();
      assert.equal(delivered.length, 1, 'still cooling off');

      h.clock.now = at(1, 0) + 61 * MIN;
      assert.equal(await reminders.run(), 1);
      assert.equal(delivered.length, 2);
      assert.equal(day(), 1 + D0 / DAY_MS);
    });

    it('gives up for the day if it still cannot be sent by 22:00', async () => {
      await primed();
      h.jobs.sync(pid(), [opens('a', 1, 5)]);
      outcome = false;
      for (let hours = 0; hours <= 23; hours += 1.5) {
        h.clock.now = at(1, hours);
        await reminders.run();
      }
      outcome = true;
      h.clock.now = at(1, 23);
      assert.equal(await reminders.run(), 0);
    });

    it('treats a throwing delivery like a failed one', async () => {
      await primed();
      h.jobs.sync(pid(), [opens('a', 1, 5)]);
      const throwing = new ReminderService(h.store, h.jobs, async () => {
        throw new Error('boom');
      }, { now: () => h.clock.now });
      h.clock.now = at(1, 0);
      assert.equal(await throwing.run(), 0);
      assert.equal(day(), D0 / DAY_MS);
    });
  });

  describe('when reminders are off', () => {
    it('does nothing, and turning them on in the middle of a day waits for the next midnight', async () => {
      await primed();
      h.jobs.sync(pid(), [opens('a', 1, 5), opens('b', 2, 5, 'EGLL-EGCC')]);
      h.store.updatePanel(pid(), { reminderMode: 'off' });
      h.clock.now = at(1, 0);
      assert.equal(await reminders.run(), 0);
      assert.equal(day(), 1 + D0 / DAY_MS, 'kept up to date while it is off');
      h.clock.now = at(1, 15);
      h.store.updatePanel(pid(), { reminderMode: 'auto' });
      assert.equal(await reminders.run(), 0, 'no list at 15:00 because an admin switched it on');
      h.clock.now = at(2, 0);
      assert.equal(await reminders.run(), 1);
      assert.deepEqual(delivered.map((d) => d.codes), [['TST-002']]);
    });
  });

  describe('the scheduler runs it', () => {
    it('on every pass', async () => {
      await primed();
      h.jobs.sync(pid(), [opens('a', 1, 5)]);
      h.clock.now = at(1, 0);
      const refresher = new SourceRefresher(h.store, h.jobs, () => null, undefined, () => h.clock.now);
      const s = new Scheduler(h.jobs, refresher, { reminders });
      await s.tick();
      assert.deepEqual(delivered.map((d) => d.codes), [['TST-001']]);
    });

    it('and a failing reminder pass does not stop the rest of the tick', async () => {
      h.jobs.sync(pid(), [opens('a', 0, 5)]);
      const refresher = new SourceRefresher(h.store, h.jobs, () => null, undefined, () => h.clock.now);
      const s = new Scheduler(h.jobs, refresher, { reminders: { run: async () => Promise.reject(new Error('nope')) } });
      h.clock.now = at(3, 0);
      await s.tick();
      assert.equal(h.jobs.open(pid()).length, 0, 'the flight still expired');
    });
  });
});

/* ------------------------------------------------------------------ the message */

describe('the channel announcement', () => {
  let h: Harness;
  let d: DiscordHarness;
  const pid = () => h.panel.id;
  const channel = () => d.client.channel(CHANNEL);
  /** Flights opening in the afternoon of "today" (2026-11-11); `now` for them is T0, noon that day. */
  const dueFor = (n: number, legs = 'EGLL-EGKK'): Reminder[] => {
    h.jobs.sync(pid(), Array.from({ length: n }, (_, i) => opens(`j${i}`, 0, 15 + i * 0.01, legs)));
    return h.jobs.open(pid()).map((view) => ({ view, openLegs: view.legs.map((l) => l.legNo), startsAt: view.job.availableFrom! }));
  };
  const panel = () => h.store.getPanel(pid())!;

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  describe('the day', () => {
    it('is named as people say it, in UTC', () => {
      assert.equal(utcDayLabel(T0), 'Wednesday 11 November');
      assert.equal(utcDayLabel(D0), 'Wednesday 11 November');
      assert.equal(utcDayLabel(D0 - 1), 'Tuesday 10 November');
      assert.equal(utcDayLabel(Date.UTC(2027, 0, 1, 23, 59)), 'Friday 1 January');
      assert.equal(utcDayLabel(Date.UTC(2026, 11, 31, 0, 0)), 'Thursday 31 December');
      assert.equal(utcDayLabel(Date.UTC(2026, 10, 15, 12)), 'Sunday 15 November');
    });

    it('is the UTC day whatever timezone the computer is set to', () => {
      const was = process.env.TZ;
      try {
        for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Los_Angeles', 'Asia/Kolkata']) {
          process.env.TZ = zone;
          assert.equal(utcDayLabel(Date.UTC(2026, 10, 11, 23, 30)), 'Wednesday 11 November', zone);
          assert.equal(utcDayLabel(Date.UTC(2026, 10, 12, 0, 30)), 'Thursday 12 November', zone);
        }
      } finally {
        if (was === undefined) delete process.env.TZ;
        else process.env.TZ = was;
      }
    });

    it('has the day boundaries in one place', () => {
      assert.equal(DAY_MS, 24 * HOUR);
      assert.equal(CLEANUP_BEFORE_MIDNIGHT_MS, MIN);
      assert.equal(startOfUtcDay(T0), D0);
      assert.equal(startOfUtcDay(D0 - 1), D0 - DAY_MS);
    });
  });

  describe('who is pinged', () => {
    it('@here when anyone can reserve (auto)', () => {
      const t = reminderTarget(panel())!;
      assert.equal(t.text, '@here');
      assert.deepEqual(t.allowed, { parse: ['everyone'] });
    });

    it('the reserving role when there is one (auto)', () => {
      h.store.updatePanel(pid(), { requiredRoleId: '555555555555555555' });
      const t = reminderTarget(panel())!;
      assert.equal(t.text, '<@&555555555555555555>');
      assert.deepEqual(t.allowed, { roles: ['555555555555555555'] }, 'only that role can be pinged, not everyone');
    });

    it('the chosen role in role mode, whatever the reserving role is', () => {
      h.store.updatePanel(pid(), { requiredRoleId: '555555555555555555', reminderMode: 'role', reminderRoleId: '666666666666666666' });
      assert.deepEqual(reminderTarget(panel()), { text: '<@&666666666666666666>', allowed: { roles: ['666666666666666666'] } });
    });

    it('nobody when off', () => {
      h.store.updatePanel(pid(), { reminderMode: 'off' });
      assert.equal(reminderTarget(panel()), null);
      assert.equal(renderReminder(panel(), dueFor(1), T0), null);
    });
  });

  describe('what it says', () => {
    it('names the day, then each flight with its route, aircraft and start, and says what to do', () => {
      const msg = renderReminder(panel(), dueFor(1), T0)!;
      assert.match(msg.content, /^@here ✈️ 1 flight on Wednesday 11 November \(UTC\) has no pilot yet\.$/);
      const text = msg.embeds[0]!.toJSON().description!;
      assert.match(text, /\*\*TST-001\*\* · EGLL → EGKK · ✈ A320/);
      assert.match(text, /🕐 starts <t:\d+:F> \(<t:\d+:R>\)/, 'a timestamp, which shows in each reader\'s own timezone');
      assert.match(text, /Can you take it\? Press \*\*Reserve\*\* below/);
      assert.match(msg.embeds[0]!.toJSON().title!, /Pilots needed · Test Air \(TST\)/);
    });

    it('does not say anything about 24 hours any more', () => {
      const msg = renderReminder(panel(), dueFor(2), T0)!;
      assert.doesNotMatch(JSON.stringify([msg.content, msg.embeds[0]!.toJSON()]), /24 hours|within a day/);
    });

    it('uses plural wording for several flights', () => {
      const msg = renderReminder(panel(), dueFor(3), T0)!;
      assert.match(msg.content, /3 flights on Wednesday 11 November \(UTC\) have no pilot yet\./);
      assert.match(msg.embeds[0]!.toJSON().description!, /Can you take one\?/);
    });

    it('names the day of the moment it is sent, not of the flights\' start', () => {
      const msg = renderReminder(panel(), dueFor(1), at(0, 0.01))!;
      assert.match(msg.content, /on Wednesday 11 November \(UTC\)/);
      assert.match(renderReminder(panel(), dueFor(1), at(1, 0))!.content, /on Thursday 12 November \(UTC\)/);
    });

    it('for a flight already under way, shows when it must be done by instead', () => {
      h.jobs.sync(pid(), [opens('now', 0, 5)]);
      const view = h.jobs.open(pid())[0]!;
      const msg = renderReminder(panel(), [{ view, openLegs: [1], startsAt: view.job.availableFrom! }], T0)!;
      assert.match(msg.embeds[0]!.toJSON().description!, /⏰ complete by <t:\d+:F>/);
      assert.doesNotMatch(msg.embeds[0]!.toJSON().description!, /starts/);
    });

    it('for a multi-leg flight, says which legs are open', () => {
      h.jobs.sync(pid(), [opens('m', 0, 15, 'EGLL-EGKK-EGCC-EGPH')]);
      h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [2], USER_A);
      const view = h.jobs.open(pid())[0]!;
      const text = renderReminder(panel(), [{ view, openLegs: [1, 3], startsAt: view.job.availableFrom! }], T0)!.embeds[0]!.toJSON().description!;
      assert.match(text, /EGLL → EGKK → EGCC → EGPH \(3 legs\)/);
      assert.match(text, /legs 1 and 3 still open/);
    });

    it('lists at most a dozen, and says how many more are on the panel', () => {
      const due = dueFor(MAX_REMINDER_FLIGHTS + 5);
      const msg = renderReminder(panel(), due, T0)!;
      const text = msg.embeds[0]!.toJSON().description!;
      assert.equal((text.match(/\*\*TST-\d+\*\*/g) ?? []).length, MAX_REMINDER_FLIGHTS);
      assert.match(text, /…and 5 more without a pilot, listed on the panel\./);
      assert.ok(text.length < 4096, 'fits in an embed');
      assert.match(msg.content, new RegExp(`${MAX_REMINDER_FLIGHTS + 5} flights on Wednesday 11 November \\(UTC\\) have no pilot`));
    });

    it('carries the buttons for the panel', () => {
      const msg = renderReminder(panel(), dueFor(1), T0)!;
      assert.deepEqual(msg.components[0]!.toJSON().components.map((c: any) => c.custom_id), [`panel:reserve:${pid()}`, `panel:search:${pid()}`, `panel:backup:${pid()}`, `panel:mine:${pid()}`, `panel:complete:${pid()}`]);
    });

    it('never lets text from a flight pull in extra mentions', () => {
      h.jobs.sync(pid(), [opens('x', 0, 15, 'EGLL-EGKK', { notes: '@everyone <@123456789012345678>' })]);
      const view = h.jobs.open(pid())[0]!;
      const msg = renderReminder(panel(), [{ view, openLegs: [1], startsAt: view.job.availableFrom! }], T0)!;
      assert.deepEqual(msg.allowedMentions, { parse: ['everyone'] }, 'exactly the one ping that was asked for');
      h.store.updatePanel(pid(), { reminderMode: 'role', reminderRoleId: '666666666666666666' });
      assert.deepEqual(renderReminder(panel(), [{ view, openLegs: [1], startsAt: view.job.availableFrom! }], T0)!.allowedMentions, { roles: ['666666666666666666'] });
    });
  });

  describe('posting it', () => {
    it('sends it to the panel\'s channel and reports success', async () => {
      assert.equal(await d.panels.remind(panel(), dueFor(2)), 'sent');
      const posted = channel().live.at(-1)!;
      assert.match(posted.payload.content, /^@here .*2 flights on Wednesday 11 November \(UTC\) have no pilot yet/);
      assert.deepEqual(posted.payload.allowedMentions, { parse: ['everyone'] });
    });

    it('is separate from the panel, which it neither edits nor replaces', async () => {
      h.jobs.sync(pid(), [opens('a', 0, 15)]);
      await d.panels.refresh(pid());
      const panelMsgs = channel().live.map((m) => m.id);
      assert.equal(await d.panels.remind(panel(), h.jobs.open(pid()).map((view) => ({ view, openLegs: [1], startsAt: view.job.availableFrom! }))), 'sent');
      assert.equal(channel().live.length, panelMsgs.length + 1);
      assert.deepEqual(h.store.getPanel(pid())!.messageIds, panelMsgs);
    });

    it('does nothing when reminders are off', async () => {
      const due = dueFor(1);
      h.store.updatePanel(pid(), { reminderMode: 'off' });
      const before = channel().live.length;
      assert.equal(await d.panels.remind(panel(), due), 'skipped');
      assert.equal(channel().live.length, before);
    });

    it('reports a missing channel as no-access', async () => {
      const due = dueFor(1);
      d.client.deleteAllChannels();
      assert.equal(await d.panels.remind(panel(), due), 'no-access');
    });
  });

  describe('end to end, with the clean-up', () => {
    it('is posted at midnight by the service and gone again at 23:59, before the next one', async () => {
      const service = new ReminderService(h.store, h.jobs, async (p, due) => (await d.panels.remind(p, due)) === 'sent', { now: () => h.clock.now });
      h.clock.now = at(0, 20);
      await service.run(); // the first look at the panel
      h.jobs.sync(pid(), [opens('a', 1, 9), opens('b', 2, 9, 'EGLL-EGCC')]);
      h.clock.now = at(1, 0);
      await service.run();
      const first = channel().live.at(-1)!;
      assert.match(first.payload.content, /1 flight on Thursday 12 November \(UTC\) has no pilot yet/);

      h.clock.now = at(1, 23) + 58 * MIN;
      await d.panels.cleanReminders();
      assert.ok(channel().existsOnServer(first.id), 'still there at 23:58');
      h.clock.now = at(1, 23) + 59 * MIN;
      await d.panels.cleanReminders();
      assert.equal(channel().existsOnServer(first.id), false, 'gone at 23:59');

      h.clock.now = at(2, 0);
      await service.run();
      const second = channel().live.at(-1)!;
      assert.notEqual(second.id, first.id);
      assert.match(second.payload.content, /on Friday 13 November \(UTC\)/);
      assert.ok(channel().existsOnServer(second.id));
    });
  });
});

/* ------------------------------------------------------------------ /setup reminders */

describe('/setup reminders', () => {
  const setup = setupCommand;
  const ROLE = '666666666666666666';
  let h: Harness;
  let d: DiscordHarness;

  const guildFake = (opts: { canPing?: boolean; roleMentionable?: boolean } = {}) => ({
    channels: { fetch: async (id: string) => ({ id, permissionsFor: () => ({ has: () => opts.canPing ?? true }) }) },
    members: { me: {}, fetchMe: async () => ({}) },
    roles: { fetch: async (id: string) => ({ id, mentionable: opts.roleMentionable ?? true }) },
  });
  const run = async (sub: string, o: FakeInteractionOptions = {}, guild = guildFake()) => {
    const f = fakeInteraction({ sub, admin: true, guild, ...o });
    await setup.execute(d.ctx, f.i);
    await settle();
    return f.calls;
  };
  const text = (calls: { edits: any[] }) => String(calls.edits.at(-1)?.content ?? '');
  const panelOf = () => h.store.getPanelByName(GUILD, 'Test Air')!;

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    h.store.deletePanel(h.panel.id);
    await run('panel-add', { options: { airline: 'Test Air', prefix: 'TST', channel: { id: CHANNEL } } });
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('is admin-only', async () => {
    await assert.rejects(run('reminders', { admin: false, options: { mode: 'off' } }), (e: unknown) => e instanceof UserError && /Manage Server/.test(e.message));
    assert.equal(panelOf().reminderMode, 'auto');
  });

  it('is on by default, and says when the list goes out and how often', async () => {
    assert.equal(panelOf().reminderMode, 'auto');
    const calls = await run('reminders');
    assert.match(text(calls), /At midnight UTC each day, the flights starting that day that still have no pilot are listed in <#7000\d+> in one message, pinging @here\. Nothing else is pinged that day\./);
  });

  it('tells the admin about it when the panel is created', async () => {
    h.store.deletePanel(panelOf().id);
    const calls = await run('panel-add', { options: { airline: 'Test Air', prefix: 'TST', channel: { id: CHANNEL } } });
    assert.match(text(calls), /Once a day, at midnight UTC, the flights starting that day that still have no pilot will be listed in the channel, pinging @here, and the list is deleted at 23:59 UTC.*\/setup reminders/s);
    assert.doesNotMatch(text(calls), /24 hours/);
  });

  it('with no options only shows the current setting', async () => {
    h.store.updatePanel(panelOf().id, { requiredRoleId: ROLE });
    const calls = await run('reminders');
    assert.match(text(calls), new RegExp(`pinging <@&${ROLE}>`));
    assert.equal(panelOf().reminderMode, 'auto');
  });

  it('turns reminders off and back on', async () => {
    assert.match(text(await run('reminders', { options: { mode: 'off' } })), /Off\. Flights without a pilot are not listed\./);
    assert.equal(panelOf().reminderMode, 'off');
    assert.match(text(await run('reminders')), /Off\./);
    await run('reminders', { options: { mode: 'auto' } });
    assert.equal(panelOf().reminderMode, 'auto');
  });

  it('pings a role the admin picks, and a role alone is enough', async () => {
    const calls = await run('reminders', { options: { role: { id: ROLE, mentionable: true } } });
    assert.deepEqual([panelOf().reminderMode, panelOf().reminderRoleId], ['role', ROLE]);
    assert.match(text(calls), new RegExp(`pinging <@&${ROLE}>`));
    assert.equal(calls.edits.at(-1).allowedMentions.parse.length, 0, 'the confirmation itself pings nobody');
  });

  it('remembers the role when switching away and back', async () => {
    await run('reminders', { options: { role: { id: ROLE } } });
    await run('reminders', { options: { mode: 'off' } });
    await run('reminders', { options: { mode: 'role' } });
    assert.deepEqual([panelOf().reminderMode, panelOf().reminderRoleId], ['role', ROLE]);
  });

  it('refuses role mode with no role, a role with another mode, and @everyone as the role', async () => {
    await assert.rejects(run('reminders', { options: { mode: 'role' } }), /Choose which role/);
    await assert.rejects(run('reminders', { options: { mode: 'off', role: { id: ROLE } } }), /only applies to the "A role I choose" mode/);
    await assert.rejects(run('reminders', { options: { role: { id: GUILD } } }), /Pick a specific role/);
    assert.equal(panelOf().reminderMode, 'auto', 'nothing changed');
  });

  it('warns when @here cannot actually ping because I lack Mention Everyone', async () => {
    const calls = await run('reminders', {}, guildFake({ canPing: false }));
    assert.match(text(calls), /Mention Everyone.*@here would appear without notifying anyone/);
  });

  it('warns when the chosen role is not mentionable and I cannot override that', async () => {
    const calls = await run('reminders', { options: { role: { id: ROLE } } }, guildFake({ canPing: false, roleMentionable: false }));
    assert.match(text(calls), /isn't mentionable/);
    const fine = await run('reminders', { options: { role: { id: ROLE } } }, guildFake({ canPing: false, roleMentionable: true }));
    assert.doesNotMatch(text(fine), /⚠️/);
  });

  it('shows the setting in /setup panels', async () => {
    assert.match(text(await run('panels')), /pilot reminders: @here/);
    await run('reminders', { options: { mode: 'off' } });
    assert.match(text(await run('panels')), /pilot reminders: off/);
  });

  it('has a description Discord will accept, that says what it is now', () => {
    const json = setup.data.toJSON().options!.find((o: any) => o.name === 'reminders') as any;
    assert.ok(json.description.length <= 100);
    assert.doesNotMatch(json.description, /24 hours/);
    assert.deepEqual(json.options.find((o: any) => o.name === 'mode').choices.map((c: any) => c.value), ['auto', 'role', 'off']);
  });
});
