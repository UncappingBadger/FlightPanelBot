import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commands } from '../src/discord/commands/index.js';
import { UserError } from '../src/discord/errors.js';
import { MAX_REMINDER_FLIGHTS, reminderTarget, renderReminder } from '../src/discord/ui.js';
import type { SourceJob } from '../src/jobs/types.js';
import { REMINDER_LEAD_MS, ReminderService, type DeliverReminder, type Reminder } from '../src/services/reminders.js';
import { Scheduler } from '../src/services/scheduler.js';
import { SourceRefresher } from '../src/services/refresh.js';
import { CHANNEL, GUILD, HOUR, makeHarness, sj, T0, USER_A, USER_B, type Harness } from './helpers.js';
import { fakeInteraction, makeDiscordHarness, settle, type DiscordHarness, type FakeInteractionOptions } from './discord-helpers.js';

/** A flight that starts `inHours` from "now" (2026-11-11 12:00Z) and runs for a day after that. */
const starting = (key: string, inHours: number, chain = 'EGLL-EGKK', over: Partial<SourceJob> = {}) =>
  sj(key, chain, { availableFrom: T0 + inHours * HOUR, deadline: T0 + (inHours + 24) * HOUR, ...over });

describe('asking for pilots a day before a flight starts', () => {
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

  beforeEach(async () => {
    h = await makeHarness();
    delivered = [];
    outcome = true;
    reminders = new ReminderService(h.store, h.jobs, deliver, { now: () => h.clock.now });
  });
  afterEach(async () => {
    await h.close();
  });

  describe('which flights count', () => {
    it('includes an unstaffed flight starting within 24 hours, including exactly 24 hours out', () => {
      h.jobs.sync(pid(), [starting('a', 23), starting('b', 24), starting('c', 24.01), starting('d', 72)]);
      assert.deepEqual(codesDue(), ['TST-001', 'TST-002'], 'TST-003 and TST-004 are more than a day away');
      assert.equal(REMINDER_LEAD_MS, 24 * HOUR);
    });

    it('still asks about a flight whose window has already opened but is not over', () => {
      h.jobs.sync(pid(), [starting('open-now', -6)]);
      assert.deepEqual(codesDue(), ['TST-001']);
    });

    it('never asks about a flight that is already over', () => {
      h.jobs.sync(pid(), [starting('a', 5)]);
      h.clock.advance(40 * HOUR); // past its deadline, even before the sweep has closed it
      assert.deepEqual(codesDue(), []);
    });

    it('counts a flight with no start time from its deadline', () => {
      h.jobs.sync(pid(), [sj('soon', 'EGLL-EGKK', { availableFrom: null, deadline: T0 + 10 * HOUR }), sj('later', 'EGLL-EGCC', { availableFrom: null, deadline: T0 + 90 * HOUR })]);
      assert.deepEqual(codesDue(), ['TST-001']);
    });

    it('ignores a flight with no times at all', () => {
      h.jobs.sync(pid(), [sj('x', 'EGLL-EGKK', { availableFrom: null, deadline: null })]);
      assert.deepEqual(codesDue(), []);
    });

    it('measures from the start of the window, not the deadline', () => {
      // starts in 30 hours but must be done within 36: not yet due. (A deadline-based rule would be due at 12 hours.)
      h.jobs.sync(pid(), [starting('a', 30, 'EGLL-EGKK', { deadline: T0 + 36 * HOUR })]);
      assert.deepEqual(codesDue(), []);
      h.clock.advance(6 * HOUR + 1);
      assert.deepEqual(codesDue(), ['TST-001']);
    });

    it('skips a flight someone has reserved, or whose pilot is named in the airline\'s own schedule', () => {
      const named = { ...starting('named', 5, 'EGLL-EGCC') };
      named.legs = named.legs.map((l) => ({ ...l, heldBy: 'Taylor' }));
      h.jobs.sync(pid(), [starting('taken', 5), named, starting('free', 5, 'EGLL-EGPH')]);
      h.jobs.reserve(job('TST-001').job.id, [1], USER_A);
      assert.deepEqual(codesDue(), ['TST-003']);
    });

    it('for a multi-leg flight, asks about the legs that are still open', () => {
      h.jobs.sync(pid(), [starting('m', 5, 'EGLL-EGKK-EGCC-EGPH')]);
      h.jobs.reserve(job('TST-001').job.id, [2], USER_A);
      const [r] = reminders.due(h.store.getPanel(pid())!);
      assert.deepEqual(r!.openLegs, [1, 3]);
      h.jobs.reserve(job('TST-001').job.id, [1, 3], USER_B);
      assert.deepEqual(codesDue(), [], 'fully staffed now');
    });

    it('lists the soonest flight first', () => {
      h.jobs.sync(pid(), [starting('later', 20), starting('sooner', 3, 'EGLL-EGCC'), starting('middle', 9, 'EGLL-EGPH')]);
      assert.deepEqual(codesDue(), ['TST-002', 'TST-003', 'TST-001']);
    });
  });

  describe('announcing', () => {
    it('sends one message for the panel covering every flight that needs it', async () => {
      h.jobs.sync(pid(), [starting('a', 5), starting('b', 8, 'EGLL-EGCC'), starting('far', 90, 'EGLL-EGPH')]);
      assert.equal(await reminders.run(), 1);
      assert.deepEqual(delivered.map((d) => d.codes), [['TST-001', 'TST-002']]);
    });

    it('says nothing when nothing needs a pilot', async () => {
      h.jobs.sync(pid(), [starting('far', 90)]);
      assert.equal(await reminders.run(), 0);
      assert.deepEqual(delivered, []);
    });

    it('announces a flight once, not on every pass', async () => {
      h.jobs.sync(pid(), [starting('a', 5)]);
      await reminders.run();
      await reminders.run();
      h.clock.advance(3 * HOUR);
      await reminders.run();
      assert.equal(delivered.length, 1);
      assert.equal(job('TST-001').job.remindedAt, T0, 'remembered in the database, so a restart does not repeat it');
    });

    it('announces a flight that comes into range later, and only that one', async () => {
      h.jobs.sync(pid(), [starting('a', 5), starting('b', 40, 'EGLL-EGCC')]);
      await reminders.run();
      h.clock.advance(17 * HOUR); // b is now 23 hours away
      await reminders.run();
      assert.deepEqual(delivered.map((d) => d.codes), [['TST-001'], ['TST-002']]);
    });

    it('keeps a flight\'s announcement across a refresh that changes nothing about it', async () => {
      h.jobs.sync(pid(), [starting('a', 5)]);
      await reminders.run();
      h.jobs.sync(pid(), [starting('a', 5)]);
      await reminders.run();
      assert.equal(delivered.length, 1);
    });

    it('asks again if a flight finds a pilot and then loses them', async () => {
      h.jobs.sync(pid(), [starting('a', 5)]);
      await reminders.run();
      h.jobs.reserve(job('TST-001').job.id, [1], USER_A);
      await reminders.run(); // notices it is staffed and forgets the old announcement
      assert.equal(job('TST-001').job.remindedAt, null);
      h.jobs.release(job('TST-001').job.id, USER_A.discordId);
      await reminders.run();
      assert.deepEqual(delivered.map((d) => d.codes), [['TST-001'], ['TST-001']]);
    });

    it('does not announce twice for a flight that was never staffed, even if someone reserved and released between passes', async () => {
      h.jobs.sync(pid(), [starting('a', 5)]);
      await reminders.run();
      h.jobs.reserve(job('TST-001').job.id, [1], USER_A);
      h.jobs.release(job('TST-001').job.id, USER_A.discordId);
      await reminders.run();
      assert.equal(delivered.length, 1);
    });

    it('does not mark flights as announced when the message could not be sent, and waits an hour before trying again', async () => {
      h.jobs.sync(pid(), [starting('a', 5)]);
      outcome = false;
      assert.equal(await reminders.run(), 0);
      assert.equal(job('TST-001').job.remindedAt, null);

      outcome = true;
      h.clock.advance(30 * 60_000);
      await reminders.run();
      assert.equal(delivered.length, 1, 'still cooling off');

      h.clock.advance(31 * 60_000);
      assert.equal(await reminders.run(), 1);
      assert.equal(delivered.length, 2);
      assert.ok(job('TST-001').job.remindedAt);
    });

    it('treats a throwing delivery like a failed one', async () => {
      h.jobs.sync(pid(), [starting('a', 5)]);
      const throwing = new ReminderService(h.store, h.jobs, async () => {
        throw new Error('boom');
      }, { now: () => h.clock.now });
      assert.equal(await throwing.run(), 0);
      assert.equal(job('TST-001').job.remindedAt, null);
    });

    it('does nothing for a panel with reminders off, and catches up if they are turned back on', async () => {
      h.jobs.sync(pid(), [starting('a', 5)]);
      h.store.updatePanel(pid(), { reminderMode: 'off' });
      assert.equal(await reminders.run(), 0);
      assert.equal(job('TST-001').job.remindedAt, null);
      h.store.updatePanel(pid(), { reminderMode: 'auto' });
      assert.equal(await reminders.run(), 1);
    });

    it('keeps panels apart: each gets its own message with only its own flights', async () => {
      const second = h.store.createPanel({ guildId: GUILD, name: 'Other Air', abbr: 'OTH', prefix: 'OTH', channelId: '700000000000000002', now: T0 });
      h.jobs.sync(pid(), [starting('a', 5)]);
      h.jobs.sync(second.id, [starting('z', 6, 'EGPH-EGLL')]);
      assert.equal(await reminders.run(), 2);
      assert.deepEqual(delivered.map((d) => [d.panelId, d.codes]).sort(), [[pid(), ['TST-001']], [second.id, ['OTH-001']]].sort());
    });
  });

  describe('the scheduler runs it', () => {
    it('on every pass, after expired flights are closed', async () => {
      h.jobs.sync(pid(), [starting('a', 5)]);
      const refresher = new SourceRefresher(h.store, h.jobs, () => null, undefined, () => h.clock.now);
      const s = new Scheduler(h.jobs, refresher, { reminders });
      await s.tick();
      assert.deepEqual(delivered.map((d) => d.codes), [['TST-001']]);
    });

    it('and a failing reminder pass does not stop the rest of the tick', async () => {
      h.jobs.sync(pid(), [starting('a', 5)]);
      const refresher = new SourceRefresher(h.store, h.jobs, () => null, undefined, () => h.clock.now);
      const s = new Scheduler(h.jobs, refresher, { reminders: { run: async () => Promise.reject(new Error('nope')) } });
      h.clock.advance(60 * HOUR);
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
  const dueFor = (n: number, legs = 'EGLL-EGKK'): Reminder[] => {
    h.jobs.sync(pid(), Array.from({ length: n }, (_, i) => starting(`j${i}`, 3 + i * 0.01, legs)));
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
    it('names each flight with its route, aircraft and start, and says what to do', () => {
      const msg = renderReminder(panel(), dueFor(1), T0)!;
      assert.match(msg.content, /^@here ✈️ 1 flight has no pilot yet and starts within 24 hours\./);
      const text = msg.embeds[0]!.toJSON().description!;
      assert.match(text, /\*\*TST-001\*\* · EGLL → EGKK · ✈ A320/);
      assert.match(text, /🕐 starts <t:\d+:f> \(<t:\d+:R>\)/, 'a timestamp, which shows in each reader\'s own timezone');
      assert.match(text, /Can you take it\? Press \*\*Reserve\*\* below/);
      assert.match(msg.embeds[0]!.toJSON().title!, /Pilots needed · Test Air \(TST\)/);
    });

    it('uses plural wording for several flights', () => {
      const msg = renderReminder(panel(), dueFor(3), T0)!;
      assert.match(msg.content, /3 flights have no pilot yet and start within 24 hours/);
      assert.match(msg.embeds[0]!.toJSON().description!, /Can you take one\?/);
    });

    it('for a flight already under way, shows when it must be done by instead', () => {
      h.jobs.sync(pid(), [starting('now', -3)]);
      const view = h.jobs.open(pid())[0]!;
      const msg = renderReminder(panel(), [{ view, openLegs: [1], startsAt: view.job.availableFrom! }], T0)!;
      assert.match(msg.embeds[0]!.toJSON().description!, /⏰ complete by <t:\d+:f>/);
      assert.doesNotMatch(msg.embeds[0]!.toJSON().description!, /starts/);
    });

    it('for a multi-leg flight, says which legs are open', () => {
      h.jobs.sync(pid(), [starting('m', 5, 'EGLL-EGKK-EGCC-EGPH')]);
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
      assert.match(msg.content, new RegExp(`${MAX_REMINDER_FLIGHTS + 5} flights have no pilot`));
    });

    it('carries the buttons for the panel', () => {
      const msg = renderReminder(panel(), dueFor(1), T0)!;
      assert.deepEqual(msg.components[0]!.toJSON().components.map((c: any) => c.custom_id), [`panel:reserve:${pid()}`, `panel:search:${pid()}`, `panel:backup:${pid()}`, `panel:mine:${pid()}`, `panel:complete:${pid()}`]);
    });

    it('never lets text from a flight pull in extra mentions', () => {
      h.jobs.sync(pid(), [starting('x', 5, 'EGLL-EGKK', { notes: '@everyone <@123456789012345678>' })]);
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
      assert.match(posted.payload.content, /^@here .*2 flights have no pilot yet/);
      assert.deepEqual(posted.payload.allowedMentions, { parse: ['everyone'] });
    });

    it('is separate from the panel, which it neither edits nor replaces', async () => {
      h.jobs.sync(pid(), [starting('a', 5)]);
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
});

/* ------------------------------------------------------------------ /setup reminders */

describe('/setup reminders', () => {
  const setup = commands.find((c) => c.data.name === 'setup')!;
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

  it('is on by default, and a new panel says so', async () => {
    assert.equal(panelOf().reminderMode, 'auto');
    const calls = await run('reminders');
    assert.match(text(calls), /announced in <#7000\d+> once, pinging @here/);
  });

  it('tells the admin about reminders when the panel is created', async () => {
    h.store.deletePanel(panelOf().id);
    const calls = await run('panel-add', { options: { airline: 'Test Air', prefix: 'TST', channel: { id: CHANNEL } } });
    assert.match(text(calls), /no pilot 24 hours before it starts will be announced in the channel, pinging @here.*\/setup reminders/s);
  });

  it('with no options only shows the current setting', async () => {
    h.store.updatePanel(panelOf().id, { requiredRoleId: ROLE });
    const calls = await run('reminders');
    assert.match(text(calls), new RegExp(`pinging <@&${ROLE}>`));
    assert.equal(panelOf().reminderMode, 'auto');
  });

  it('turns reminders off and back on', async () => {
    assert.match(text(await run('reminders', { options: { mode: 'off' } })), /Off\. Flights without a pilot are not announced/);
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

  it('has a description Discord will accept', () => {
    const json = setup.data.toJSON().options!.find((o: any) => o.name === 'reminders') as any;
    assert.ok(json.description.length <= 100);
    assert.deepEqual(json.options.find((o: any) => o.name === 'mode').choices.map((c: any) => c.value), ['auto', 'role', 'off']);
  });
});
