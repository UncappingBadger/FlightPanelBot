import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MIGRATIONS, openDatabase } from '../src/db/db.js';
import { Store } from '../src/db/store.js';
import { commands } from '../src/discord/commands/index.js';
import { startOfUtcDay } from '../src/discord/panel.js';
import type { Reminder } from '../src/services/reminders.js';
import { Scheduler } from '../src/services/scheduler.js';
import { CHANNEL, GUILD, HOUR, makeHarness, sj, T0, type Harness } from './helpers.js';
import { fakeInteraction, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

const DAY = 24 * HOUR;
/** The start of the UTC day that the test clock (2026-11-11 12:00Z) is in. */
const MIDNIGHT = Date.UTC(2026, 10, 11, 0, 0, 0);

describe('midnight, UTC', () => {
  it('is the start of the UTC day, whatever the time of day or the computer\'s timezone', () => {
    assert.equal(startOfUtcDay(T0), MIDNIGHT);
    assert.equal(startOfUtcDay(MIDNIGHT), MIDNIGHT);
    assert.equal(startOfUtcDay(MIDNIGHT - 1), MIDNIGHT - DAY);
    assert.equal(startOfUtcDay(MIDNIGHT + DAY - 1), MIDNIGHT);
    assert.equal(startOfUtcDay(0), 0);
  });
});

describe('clearing the "pilots needed" announcements at midnight', () => {
  let h: Harness;
  let d: DiscordHarness;
  const pid = () => h.panel.id;
  const channel = () => d.client.channel(CHANNEL);
  const panel = () => h.store.getPanel(pid())!;
  /** Post an announcement now, as the reminder service would. */
  const announce = async (): Promise<string> => {
    h.jobs.sync(pid(), [sj(`k${h.clock.now}`, 'EGLL-EGKK', { availableFrom: h.clock.now + HOUR, deadline: h.clock.now + 30 * HOUR })]);
    const due: Reminder[] = h.jobs.open(pid()).slice(-1).map((view) => ({ view, openLegs: [1], startsAt: view.job.availableFrom! }));
    assert.equal(await d.panels.remind(panel(), due), 'sent');
    return channel().live.at(-1)!.id;
  };
  const alive = (id: string) => channel().existsOnServer(id);

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
  });
  afterEach(async () => {
    await settle(20);
    await h.close();
  });

  describe('remembering them', () => {
    it('keeps a note of each announcement it posts, with where and when', async () => {
      const id = await announce();
      assert.deepEqual(h.store.listReminderMessages(pid()), [{ messageId: id, channelId: CHANNEL, postedAt: T0 }]);
    });

    it('does not keep a note when the panel keeps its announcements, or when nothing was posted', async () => {
      h.store.updatePanel(pid(), { reminderCleanup: false });
      await announce();
      assert.deepEqual(h.store.listReminderMessages(pid()), []);
      h.store.updatePanel(pid(), { reminderCleanup: true, reminderMode: 'off' });
      h.jobs.sync(pid(), [sj('x', 'EGLL-EGKK', { availableFrom: T0 + HOUR, deadline: T0 + 30 * HOUR })]);
      assert.equal(await d.panels.remind(panel(), []), 'skipped');
      assert.deepEqual(h.store.listReminderMessages(pid()), []);
    });

    it('never touches the panel itself', async () => {
      h.jobs.sync(pid(), [sj('p', 'EGLL-EGKK', { availableFrom: T0 + HOUR, deadline: T0 + 30 * HOUR })]);
      await d.panels.refresh(pid());
      const panelMessages = [...panel().messageIds];
      await announce();
      h.clock.advance(DAY);
      await d.panels.cleanReminders();
      assert.deepEqual(panel().messageIds, panelMessages);
      assert.ok(panelMessages.every(alive));
    });
  });

  describe('deleting them', () => {
    it('keeps today\'s announcement, then deletes it once midnight (UTC) has passed', async () => {
      const id = await announce(); // 12:00Z
      assert.equal(await d.panels.cleanReminders(), 0);
      assert.ok(alive(id), 'still there during the day');

      h.clock.advance(11 * HOUR + 59 * 60_000); // 23:59Z
      assert.equal(await d.panels.cleanReminders(), 0);
      assert.ok(alive(id), 'a minute before midnight');

      h.clock.advance(60_000); // 00:00Z next day
      assert.equal(await d.panels.cleanReminders(), 1);
      assert.equal(alive(id), false, 'gone at midnight');
      assert.deepEqual(h.store.listReminderMessages(pid()), [], 'and forgotten');
    });

    it('clears yesterday\'s but not the ones posted since midnight', async () => {
      const old1 = await announce();
      h.clock.advance(6 * HOUR);
      const old2 = await announce(); // 18:00Z
      h.clock.advance(7 * HOUR); // 01:00Z next day
      const fresh = await announce();
      assert.equal(await d.panels.cleanReminders(), 2);
      assert.deepEqual([alive(old1), alive(old2), alive(fresh)], [false, false, true]);
      h.clock.advance(DAY);
      assert.equal(await d.panels.cleanReminders(), 1);
      assert.equal(alive(fresh), false);
    });

    it('catches up if the bot was switched off over midnight, as soon as it runs again', async () => {
      const id = await announce();
      h.clock.advance(3 * DAY + 5 * HOUR);
      assert.equal(await d.panels.cleanReminders(), 1);
      assert.equal(alive(id), false);
    });

    it('does nothing on a second pass', async () => {
      await announce();
      h.clock.advance(DAY);
      assert.equal(await d.panels.cleanReminders(), 1);
      assert.equal(await d.panels.cleanReminders(), 0);
    });
  });

  describe('the on/off switch', () => {
    it('leaves announcements alone for a panel that keeps them, and forgets the old notes', async () => {
      const id = await announce(); // tracked while cleanup was on
      h.store.updatePanel(pid(), { reminderCleanup: false });
      h.clock.advance(DAY);
      assert.equal(await d.panels.cleanReminders(), 0);
      assert.ok(alive(id), 'not deleted');
      assert.deepEqual(h.store.listReminderMessages(pid()), [], 'and no longer tracked');
    });

    it('applies per panel: one tidies up, the other does not', async () => {
      const other = h.store.createPanel({ guildId: GUILD, name: 'Other Air', abbr: 'OTH', prefix: 'OTH', channelId: '700000000000000002', now: T0 });
      const mine = await announce();
      h.store.addReminderMessage(other.id, '700000000000000002', 'theirs', T0);
      const theirChannel = d.client.channel('700000000000000002');
      const theirs = await theirChannel.send({ content: 'pilots needed' });
      h.store.deleteReminderMessage('theirs');
      h.store.addReminderMessage(other.id, '700000000000000002', theirs.id, T0);
      h.store.updatePanel(other.id, { reminderCleanup: false });
      h.clock.advance(DAY);
      await d.panels.cleanReminders();
      assert.equal(alive(mine), false);
      assert.equal(theirChannel.existsOnServer(theirs.id), true);
    });
  });

  describe('when something is not as expected', () => {
    it('treats a message someone already deleted as done', async () => {
      const id = await announce();
      channel().deleteMessage(id);
      h.clock.advance(DAY);
      assert.equal(await d.panels.cleanReminders(), 1);
      assert.deepEqual(h.store.listReminderMessages(pid()), []);
    });

    it('treats a channel that no longer exists as done', async () => {
      await announce();
      d.client.channels.fetch = async () => {
        throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
      };
      h.clock.advance(DAY);
      assert.equal(await d.panels.cleanReminders(), 1);
      assert.deepEqual(h.store.listReminderMessages(pid()), []);
    });

    it('gives up on a message it is not allowed to touch, rather than trying forever', async () => {
      const id = await announce();
      const m = await channel().messages.fetch({ message: id, force: true });
      m.delete = async () => {
        throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      };
      h.clock.advance(DAY);
      assert.equal(await d.panels.cleanReminders(), 1);
      assert.deepEqual(h.store.listReminderMessages(pid()), []);
    });

    it('tries again on the next pass after a hiccup, and gives up after three days', async () => {
      const id = await announce();
      const m = await channel().messages.fetch({ message: id, force: true });
      const real = m.delete.bind(m);
      m.delete = async () => {
        throw new Error('Discord is having a moment');
      };
      h.clock.advance(DAY);
      assert.equal(await d.panels.cleanReminders(), 0);
      assert.equal(h.store.listReminderMessages(pid()).length, 1, 'kept for another try');
      assert.ok(alive(id));

      m.delete = real;
      h.clock.advance(HOUR);
      assert.equal(await d.panels.cleanReminders(), 1);
      assert.equal(alive(id), false);

      const stuck = await announce();
      const sm = await channel().messages.fetch({ message: stuck, force: true });
      sm.delete = async () => {
        throw new Error('still down');
      };
      h.clock.advance(DAY);
      await d.panels.cleanReminders();
      assert.equal(h.store.listReminderMessages(pid()).length, 1);
      h.clock.advance(3 * DAY);
      await d.panels.cleanReminders();
      assert.equal(h.store.listReminderMessages(pid()).length, 0, 'forgotten after three days');
    });

    it('does nothing before the bot is connected to Discord', async () => {
      await announce();
      h.clock.advance(DAY);
      const detached = makeDiscordHarness(h);
      (detached.panels as unknown as { client: null }).client = null;
      assert.equal(await detached.panels.cleanReminders(), 0);
    });
  });

  describe('removing a panel', () => {
    it('deletes its announcements too, not just the panel', async () => {
      const id = await announce();
      await d.panels.deleteReminderMessages(panel());
      assert.equal(alive(id), false);
      assert.deepEqual(h.store.listReminderMessages(pid()), []);
    });

    it('/setup panel-remove does it, and the notes go with the panel', async () => {
      const id = await announce();
      const setup = commands.find((c) => c.data.name === 'setup')!;
      const f = fakeInteraction({ sub: 'panel-remove', admin: true, options: { airline: 'TST' } });
      await setup.execute(d.ctx, f.i);
      assert.equal(alive(id), false);
      assert.equal(h.store.getPanel(pid()), null);
      assert.equal(h.store.listReminderMessagesBefore(Number.MAX_SAFE_INTEGER).length, 0);
    });
  });

  describe('the scheduler runs it', () => {
    it('every pass, after the announcements and before the market boards, and survives a failure', async () => {
      const calls: string[] = [];
      const ok = new Scheduler(h.jobs, d.refresher, {
        reminders: { run: async () => calls.push('reminders') },
        cleanup: { run: async () => void calls.push('cleanup') },
        markets: { run: async () => void calls.push('markets') },
      });
      await ok.tick();
      assert.deepEqual(calls, ['reminders', 'cleanup', 'markets']);

      const failing = new Scheduler(h.jobs, d.refresher, {
        cleanup: { run: async () => Promise.reject(new Error('boom')) },
        markets: { run: async () => void calls.push('markets again') },
      });
      await assert.doesNotReject(failing.tick());
      assert.equal(calls.at(-1), 'markets again', 'the rest of the pass still ran');
    });

    it('end to end: a pass after midnight removes yesterday\'s announcement', async () => {
      const id = await announce();
      const s = new Scheduler(h.jobs, d.refresher, { cleanup: { run: () => d.panels.cleanReminders() } });
      await s.tick();
      assert.ok(alive(id));
      h.clock.advance(DAY);
      await s.tick();
      assert.equal(alive(id), false);
    });
  });
});

describe('/setup reminders cleanup', () => {
  let h: Harness;
  let d: DiscordHarness;
  const setup = commands.find((c) => c.data.name === 'setup')!;
  const guildFake = () => ({
    channels: { fetch: async (id: string) => ({ id, permissionsFor: () => ({ has: () => true }) }) },
    roles: { fetch: async () => null },
    members: { me: {}, fetchMe: async () => ({}) },
  });
  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
  });
  afterEach(async () => {
    await settle(20);
    await h.close();
  });
  const run = async (options: Record<string, unknown> = {}) => {
    const f = fakeInteraction({ sub: 'reminders', admin: true, guild: guildFake(), options });
    await setup.execute(d.ctx, f.i);
    return String(f.calls.edits.at(-1)?.content ?? '');
  };

  it('is on for every panel to begin with, and the reply says so', async () => {
    assert.equal(h.panel.reminderCleanup, true);
    assert.match(await run(), /deleted at midnight UTC.*`\/setup reminders cleanup:off` keeps them/);
  });

  it('switches off, says what that means, and remembers', async () => {
    const reply = await run({ cleanup: 'off' });
    assert.match(reply, /stay in the channel until someone deletes them.*cleanup:on/);
    assert.equal(h.store.getPanel(h.panel.id)!.reminderCleanup, false);
    assert.match(await run(), /stay in the channel/, 'still off when asked again');
  });

  it('switches back on', async () => {
    await run({ cleanup: 'off' });
    assert.match(await run({ cleanup: 'on' }), /deleted at midnight UTC/);
    assert.equal(h.store.getPanel(h.panel.id)!.reminderCleanup, true);
  });

  it('can be changed together with the ping setting, and does not disturb it', async () => {
    const reply = await run({ mode: 'auto', cleanup: 'off' });
    assert.match(reply, /pinging @here/);
    const p = h.store.getPanel(h.panel.id)!;
    assert.deepEqual([p.reminderMode, p.reminderCleanup], ['auto', false]);
  });

  it('says nothing about tidying when reminders are off altogether', async () => {
    const reply = await run({ mode: 'off' });
    assert.match(reply, /Off\. Flights without a pilot are not announced\./);
    assert.doesNotMatch(reply, /midnight/);
  });

  it('is an option of the command, with a short description and two choices', () => {
    const json = setup.data.toJSON() as { options: Array<{ name: string; options?: Array<{ name: string; description: string; choices?: unknown[] }> }> };
    const sub = json.options.find((o) => o.name === 'reminders')!;
    const opt = sub.options!.find((o) => o.name === 'cleanup')!;
    assert.ok(opt.description.length <= 100);
    assert.equal(opt.choices!.length, 2);
  });
});

describe('upgrading a database that has panels (schema v10 to v11)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aerobot-v11-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('turns the tidy-up on for existing panels and leaves everything else as it was', () => {
    const path = join(dir, 'bot.sqlite');
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON;');
    for (let v = 0; v < 10; v++) raw.exec(MIGRATIONS[v] as string);
    raw.exec('PRAGMA user_version = 10');
    raw.exec(`
      INSERT INTO panels(guild_id, airline_id, airline_name, prefix, channel_id, created_at) VALUES ('g1', 1, 'Old Air', 'OLD', 'c1', 1);
      INSERT INTO jobs(panel_id, code, source_key, status, first_seen, last_seen) VALUES (1, 'OLD-001', 'k', 'open', 1, 1);
    `);
    raw.close();

    const store = new Store(openDatabase(path));
    try {
      const p = store.listPanels('g1')[0]!;
      assert.equal(p.reminderCleanup, true);
      assert.equal(store.listJobs(p.id).length, 1);
      store.addReminderMessage(p.id, 'c1', 'm1', 5);
      assert.equal(store.listReminderMessagesBefore(10).length, 1);
      assert.equal(store.deletePanel(p.id), true);
      assert.equal(store.listReminderMessagesBefore(10).length, 0, 'the notes go with the panel');
    } finally {
      store.close();
    }
  });
});
