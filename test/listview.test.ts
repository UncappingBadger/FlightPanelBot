import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MessageFlags, type Client } from 'discord.js';
import { commands, componentHandlers } from '../src/discord/commands/index.js';
import { UserError } from '../src/discord/errors.js';
import { MAX_FOLLOWERS, PanelService } from '../src/discord/panel.js';
import { silentLogger } from '../src/util/log.js';
import { CHANNEL, makeHarness, sj, USER_A, USER_B, type Harness } from './helpers.js';
import { fakeComponent, fakeInteraction, fakeModal, FakeUser, makeDiscordHarness, messageText, settle, type DiscordHarness } from './discord-helpers.js';

const setup = commands.find((c) => c.data.name === 'setup')!;
const DONE = '800000000000000009';

describe("a pilot's list view in their DMs", () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  const pid = () => h.panel.id;

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK'), sj('m', 'EGLL-EGKK-EGCC')]);
    await d.panels.refresh(pid());
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const handlerFor = (customId: string) => componentHandlers.find((x) => x.prefix === customId.split(':')[0])!;
  const press = async (user: FakeUser, customId: string, o: { guildId?: string | null; roles?: string[]; notMember?: boolean; values?: string[] } = {}) => {
    const f = fakeComponent(user, customId, o);
    await handlerFor(customId).handle(d.ctx, f.i);
    return f.calls;
  };
  const follow = (user = alice) => press(user, `panel:list:${pid()}`);
  /** Let the redraw the change caused, and the update of people's lists after it, finish. */
  const redrawn = async () => {
    await settle();
    await d.panels.followersIdle();
  };
  const list = (user = alice) => user.dmChannel.live;
  const idsOf = (user = alice) => list(user).map((m) => m.id);
  const buttonIds = (m: { payload: any }) => m.payload.components.map((r: any) => r.toJSON()).flatMap((r: any) => r.components.map((c: any) => c.custom_id));
  const longList = () => Array.from({ length: 40 }, (_, i) => sj(`j${i}`, 'EGLL-EGKK-EGCC', { notes: 'n'.repeat(150) }));

  describe('asking for it', () => {
    it('has a List view button on every message of the open flights, on a row of its own', () => {
      const first = d.client.channel(CHANNEL).live[0]!;
      const rows = (first.payload.components as any[]).map((r) => r.toJSON().components.map((c: any) => c.custom_id));
      assert.equal(rows.length, 2);
      assert.deepEqual(rows[1], [`panel:list:${pid()}`]);
    });

    it('posts the panel as a plain list in their DMs, and says where', async () => {
      const calls = await follow();
      assert.deepEqual(calls.defers[0], { flags: 64 }, 'the reply is private');
      assert.match(calls.edits[0].content, /Your list is in your DMs/);
      assert.match(calls.edits[0].content, /discord\.com\/channels\/@me\/dmc-111111111111111111/);

      const text = list().map((m) => messageText(m)).join('\n');
      assert.match(text, /your own copy of the panel, as a list/);
      assert.match(text, /\*\*TST-001\*\* · EGLL → EGKK · ✈ A320/);
      assert.match(text, /↳ \*open\*/);
      assert.match(text, /EGLL → EGKK → EGCC \(2 legs\)/);
      assert.match(text, /completed flights/);
      assert.match(text, /Nothing has been completed in the last 24 hours\./);
      const f = h.store.getFollower(pid(), alice.id)!;
      assert.deepEqual(f.messageIds, idsOf());
      assert.equal(f.channelId, alice.dmChannel.id);
    });

    it('sends it quietly, so no sound or badge', async () => {
      await follow();
      for (const m of list()) assert.equal(m.payload.flags, MessageFlags.SuppressNotifications);
    });

    it('has no buttons but Stop updates, under the open flights, and none under the completed ones', async () => {
      await follow();
      assert.deepEqual(buttonIds(list()[0]!), [`panel:unlist:${pid()}`]);
      assert.deepEqual(buttonIds(list().at(-1)!), []);
    });

    it("says where the panel's buttons are, and gives each date and time with its day of the week", async () => {
      await follow();
      const text = list().map((m) => messageText(m)).join('\n');
      assert.match(text, new RegExp(`use the buttons under the panel in <#${CHANNEL}>`));
      assert.match(text, /⏰ complete by <t:\d+:F> \(<t:\d+:R>\)/);
      assert.doesNotMatch(text, /Press \*\*Reserve\*\*/, 'no instruction for a button that is not there');
    });

    it('lists a backup pilot under the flight, and who has each leg', async () => {
      h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
      h.jobs.addBackup(h.jobs.open(pid())[0]!.job.id, { discordId: USER_B.discordId, username: USER_B.username });
      await redrawn();
      await follow();
      const text = list().map((m) => messageText(m)).join('\n');
      assert.match(text, new RegExp(`↳ <@${USER_A.discordId}>`));
      assert.match(text, new RegExp(`🛟 backup: <@${USER_B.discordId}>`));
    });

    it('lists the flights completed in the last day, one line each', async () => {
      const view = h.jobs.open(pid())[0]!;
      h.jobs.reserve(view.job.id, [1], USER_A);
      h.jobs.complete(view.job.id, USER_A.discordId);
      await redrawn();
      await follow();
      const text = list().map((m) => messageText(m)).join('\n');
      assert.match(text, new RegExp(`✅ \\*\\*${view.job.code}\\*\\* · EGLL → EGKK · flown by <@${USER_A.discordId}>`));
    });

    it('explains how to open their DMs when they are closed, and keeps nothing', async () => {
      alice.failDms = true;
      await assert.rejects(follow(), (e: unknown) => e instanceof UserError && /Allow direct messages/.test(e.message));
      assert.equal(h.store.getFollower(pid(), alice.id), null);
      assert.equal(list().length, 0);
    });

    it('asking again replaces the list with a fresh one at the bottom of the DM', async () => {
      await follow();
      const before = idsOf();
      await follow();
      const after = idsOf();
      assert.equal(after.length, before.length);
      assert.ok(after.every((id) => !before.includes(id)), 'new messages');
      assert.deepEqual(h.store.getFollower(pid(), alice.id)!.messageIds, after);
      assert.equal(h.store.countFollowers(pid()), 1);
    });

    it(`stops at ${MAX_FOLLOWERS} people, but someone who already has a list can always ask again`, async () => {
      for (let i = 0; i < MAX_FOLLOWERS - 1; i++) h.store.saveFollower({ panelId: pid(), discordId: `9${String(i).padStart(17, '0')}`, channelId: `x${i}`, messageIds: [], createdAt: 1 });
      await follow(alice);
      assert.equal(h.store.countFollowers(pid()), MAX_FOLLOWERS);
      await assert.rejects(follow(bob), (e: unknown) => e instanceof UserError && new RegExp(`${MAX_FOLLOWERS} people`).test(e.message));
      await follow(alice);
      assert.equal(h.store.countFollowers(pid()), MAX_FOLLOWERS);
    });
  });

  describe('keeping it up to date', () => {
    it('edits it in place when the panel changes, without posting anything new', async () => {
      await follow();
      const before = idsOf();
      const sent = alice.dmChannel.sent.length;
      h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
      await redrawn();
      assert.deepEqual(idsOf(), before);
      assert.equal(alice.dmChannel.sent.length, sent, 'no new message');
      assert.match(messageText(list()[0]!), new RegExp(`↳ <@${USER_A.discordId}>`));
      assert.ok(list()[0]!.edits.length >= 1);
    });

    it('goes on updating at every later change, not just the first', async () => {
      await follow();
      for (const [n, key] of [[0, 'a'], [1, 'm']] as const) {
        h.jobs.reserve(h.jobs.open(pid()).find((v) => v.job.sourceKey === key)!.job.id, [1], USER_B);
        await redrawn();
        const text = list().map((m) => messageText(m)).join('\n');
        assert.equal((text.match(new RegExp(`<@${USER_B.discordId}>`, 'g')) ?? []).length, n + 1, `after change ${n + 1}`);
      }
    });

    it('waits between updates of one panel, and a burst of requests shares one update', async () => {
      const slow = new PanelService(h.store, h.jobs, silentLogger, () => h.clock.now, 0, 60);
      slow.attach(d.client as unknown as Client);
      await slow.follow(pid(), alice);
      const a = slow.refreshFollowers(pid());
      const b = slow.refreshFollowers(pid());
      assert.equal(a, b, 'requests made while one is waiting share it');
      const started = Date.now();
      await a;
      await slow.refreshFollowers(pid());
      assert.ok(Date.now() - started >= 50, 'the second update waited for the gap');
      await slow.followersIdle();
    });

    it("keeps everyone's list in step, and leaves out people who never asked", async () => {
      await follow(alice);
      await follow(bob);
      h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_B);
      await redrawn();
      for (const u of [alice, bob]) assert.match(messageText(list(u)[0]!), new RegExp(`<@${USER_B.discordId}>`));
      const carol = d.client.user(new FakeUser('333333333333333333', 'carol'));
      assert.equal(list(carol).length, 0);
    });

    it('adds messages at the end when the list grows (quietly), and takes them off when it shrinks', async () => {
      await follow();
      const first = idsOf();
      h.jobs.sync(pid(), longList());
      await redrawn();
      const grown = idsOf();
      assert.ok(grown.length > first.length, 'more messages');
      assert.deepEqual(grown.slice(0, first.length), first, 'the ones it had are kept, in place');
      for (const m of list().slice(first.length)) assert.equal(m.payload.flags, MessageFlags.SuppressNotifications);
      assert.deepEqual(h.store.getFollower(pid(), alice.id)!.messageIds, grown);
      // the last of the open flights' messages now says what the panel's does
      const panelText = d.client.channel(CHANNEL).live.map((m) => messageText(m)).join('\n');
      assert.match(panelText, /TST-040/);

      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      await redrawn();
      assert.equal(list().length, first.length);
      assert.deepEqual(idsOf(), first, 'back to the messages it started with');
      assert.deepEqual(h.store.getFollower(pid(), alice.id)!.messageIds, idsOf());
    });

    it('posts the whole list again, in order, if a message of it is gone', async () => {
      await follow();
      const before = idsOf();
      alice.dmChannel.deleteMessage(before[0]!);
      h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
      await redrawn();
      assert.equal(list().length, before.length);
      assert.ok(list().every((m) => !before.includes(m.id)), 'a fresh set');
      assert.deepEqual(h.store.getFollower(pid(), alice.id)!.messageIds, idsOf());
    });

    it('does not edit a message that would say the same', async () => {
      await follow();
      const m = list().at(-1)!; // the completed flights' message
      await d.panels.refresh(pid());
      await redrawn();
      assert.equal(m.edits.length, 0);
    });

    it('stops keeping a list for someone who has closed their DMs to the bot', async () => {
      await follow();
      alice.failDms = true;
      h.jobs.sync(pid(), longList()); // needs new messages, which is what a closed DM refuses
      await redrawn();
      assert.equal(h.store.getFollower(pid(), alice.id), null);
    });

    it('stops (and takes the list away) for someone who has left the server, once it next checks', async () => {
      await follow();
      d.client.members = new Set(); // nobody is in the server any more
      h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_B);
      await redrawn();
      assert.ok(h.store.getFollower(pid(), alice.id), 'checked when it was sent, so not asked again straight away');
      h.clock.advance(31 * 60_000);
      h.jobs.reserve(h.jobs.open(pid())[1]!.job.id, [1], USER_B);
      await redrawn();
      assert.equal(h.store.getFollower(pid(), alice.id), null);
      assert.equal(list().length, 0, 'the DM messages are deleted');
    });

    it('stops for someone who can no longer see the panel channel', async () => {
      await follow();
      d.client.channel(CHANNEL).hiddenFrom.add(alice.id);
      h.clock.advance(31 * 60_000);
      h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_B);
      await redrawn();
      assert.equal(h.store.getFollower(pid(), alice.id), null);
      assert.equal(list().length, 0);
    });

    it('is not updated while the panel itself could not be drawn', async () => {
      await follow();
      const m = list()[0]!;
      const edits = m.edits.length;
      d.client.channels_.delete(CHANNEL);
      d.client.autoCreate = false;
      h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
      await redrawn();
      assert.equal(m.edits.length, edits);
    });
  });

  describe('stopping it', () => {
    it('Stop updates takes the list out of their DMs and stops keeping it', async () => {
      await follow();
      const calls = await press(alice, `panel:unlist:${pid()}`, { guildId: null });
      assert.match(calls.edits[0].content, /taken your list out of your DMs/);
      assert.equal(list().length, 0);
      assert.equal(h.store.getFollower(pid(), alice.id), null);
      const sent = alice.dmChannel.sent.length;
      h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_B);
      await redrawn();
      assert.equal(alice.dmChannel.sent.length, sent, 'nothing is sent to them again');
    });

    it("says so when they had no list, and leaves other people's lists alone", async () => {
      await follow(bob);
      const calls = await press(alice, `panel:unlist:${pid()}`, { guildId: null });
      assert.match(calls.edits[0].content, /don't have a list/);
      assert.ok(h.store.getFollower(pid(), bob.id));
      assert.equal(list(bob).length, 2);
    });

    it('takes every list away when the panel is removed', async () => {
      await follow(alice);
      await follow(bob);
      const f = fakeInteraction({ sub: 'panel-remove', admin: true, options: { airline: 'TST' } });
      await setup.execute(d.ctx, f.i);
      assert.equal(list(alice).length, 0);
      assert.equal(list(bob).length, 0);
      assert.equal(h.store.countFollowers(pid()), 0);
    });
  });

  describe('with the completed flights in a channel of their own', () => {
    it('leaves them out of the list, and says where they are', async () => {
      h.store.updatePanel(pid(), { completedChannelId: DONE });
      await d.panels.refresh(pid());
      await follow();
      const text = list().map((m) => messageText(m)).join('\n');
      assert.match(text, new RegExp(`Completed flights are in <#${DONE}>`));
      assert.doesNotMatch(text, /· completed flights/);
      assert.equal(list().length, 1);
    });
  });

  describe("the panel's buttons are not in it", () => {
    beforeEach(async () => {
      await follow();
    });

    it('refuses a panel button pressed in a DM (a button id is not a permission), whoever presses it', async () => {
      for (const action of ['reserve', 'mine', 'backup', 'complete', 'search', 'list']) {
        await assert.rejects(press(alice, `panel:${action}:${pid()}`, { guildId: null }), (e: unknown) => e instanceof UserError && /no longer active/.test(e.message), action);
      }
      assert.equal(h.store.getSession(alice.id, h.clock.now), null);
    });
  });
});
