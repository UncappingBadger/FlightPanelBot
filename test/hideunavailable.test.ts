import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commands, componentHandlers } from '../src/discord/commands/index.js';
import { availableFor, hasFreeLeg } from '../src/services/availability.js';
import { CHANNEL, makeHarness, sj, USER_A, USER_B, USER_C, type Harness } from './helpers.js';
import { fakeComponent, fakeInteraction, fakeModal, FakeUser, makeDiscordHarness, messageText, settle, type DiscordHarness } from './discord-helpers.js';

const hide = commands.find((c) => c.data.name === 'hideunavailable')!;

describe('/hideunavailable', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  const pid = () => h.panel.id;

  // Flights: TAKEN (bob has it), OPEN, PARTLY (a free leg left), NAMED (a name in the sheet), MINE (alice has it), DONE (flown by carol).
  const code = (key: string) => h.jobs.open(pid()).find((v) => v.job.sourceKey === key)!.job.code;
  const idOf = (key: string) => h.jobs.open(pid()).find((v) => v.job.sourceKey === key)!.job.id;
  let doneCode = '';

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    h.jobs.sync(pid(), [
      sj('taken', 'EGLL-EGKK'),
      sj('open', 'EGLL-EGCC'),
      sj('partly', 'EGLL-EGKK-EGCC'),
      sj('named', 'EGLL-EGPH', { legs: [{ dep: 'EGLL', arr: 'EGPH', heldBy: 'Some Name' }] }),
      sj('mine', 'LFPG-EHAM'),
      sj('done', 'EDDF-EHAM'),
    ]);
    h.jobs.reserve(idOf('taken'), [1], USER_B);
    h.jobs.reserve(idOf('partly'), [1], USER_B);
    h.jobs.reserve(idOf('mine'), [1], USER_A);
    doneCode = code('done');
    h.jobs.reserve(idOf('done'), [1], USER_C);
    h.jobs.complete(idOf('done'), USER_C.discordId);
    await d.panels.refresh(pid());
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const run = async (user: { id: string }, options: Record<string, unknown> = {}, admin = false) => {
    const f = fakeInteraction({ sub: undefined, userId: user.id, options, admin });
    await hide.execute(d.ctx, f.i);
    await settle();
    return { text: String(f.calls.edits.at(-1)?.content ?? ''), defers: f.calls.defers };
  };
  const listText = (user: FakeUser) => user.dmChannel.live.map((m) => messageText(m)).join('\n');
  const handlerFor = (customId: string) => componentHandlers.find((x) => x.prefix === customId.split(':')[0])!;
  const follow = async (user: FakeUser) => handlerFor('panel:list').handle(d.ctx, fakeComponent(user, `panel:list:${pid()}`).i);

  describe('which flights count as no longer available', () => {
    it('are the ones nobody can take: every leg held in Discord or named in the schedule', () => {
      const view = (key: string) => h.jobs.open(pid()).find((v) => v.job.sourceKey === key)!;
      assert.equal(hasFreeLeg(view('taken')), false);
      assert.equal(hasFreeLeg(view('named')), false, 'a name in the sheet is a taken leg');
      assert.equal(hasFreeLeg(view('open')), true);
      assert.equal(hasFreeLeg(view('partly')), true, 'one free leg is enough');
    });

    it("keep the flights the person is part of (flying a leg, or standing by), so they don't lose track of them", () => {
      const keys = (ids: string) => availableFor(h.jobs.open(pid()), ids).map((v) => v.job.sourceKey).sort();
      assert.deepEqual(keys(USER_C.discordId), ['open', 'partly']);
      assert.deepEqual(keys(USER_A.discordId), ['mine', 'open', 'partly']);
      h.jobs.addBackup(idOf('taken'), { discordId: USER_C.discordId, username: USER_C.username });
      assert.deepEqual(keys(USER_C.discordId), ['open', 'partly', 'taken'], 'a backup keeps the flight they stand by for');
    });
  });

  describe('the command', () => {
    it('is for anyone, replies only to them, and switches the setting each time with no option', async () => {
      const first = await run(alice);
      assert.deepEqual(first.defers[0], { flags: 64 });
      assert.match(first.text, /\*\*On\.\*\*/);
      assert.equal(h.store.getHideUnavailable(alice.id), true);
      assert.match((await run(alice)).text, /\*\*Off\.\*\*/);
      assert.equal(h.store.getHideUnavailable(alice.id), false);
    });

    it('can be told on or off, whatever it was', async () => {
      await run(alice, { mode: 'on' });
      await run(alice, { mode: 'on' });
      assert.equal(h.store.getHideUnavailable(alice.id), true);
      await run(alice, { mode: 'off' });
      await run(alice, { mode: 'off' });
      assert.equal(h.store.getHideUnavailable(alice.id), false);
    });

    it("is one person's: nobody else's view changes", async () => {
      await run(alice, { mode: 'on' });
      assert.equal(h.store.getHideUnavailable(alice.id), true);
      assert.equal(h.store.getHideUnavailable(bob.id), false);
      assert.equal(h.store.getHideUnavailable(USER_C.discordId), false);
    });

    it("says what it changes and what it doesn't: the panel in the channel stays the same for everyone", async () => {
      const { text } = await run(alice, { mode: 'on' });
      assert.match(text, /list view and your searches/);
      assert.match(text, /Flights you hold, or are the backup for, stay/);
      assert.match(text, /looks the same for everyone/);
      assert.match(text, /press \*\*List view\*\*/, 'a person with no list is told how to get one');
    });

    it('leaves the panel in the channel exactly as it was', async () => {
      const before = d.client.channel(CHANNEL).live.map((m) => messageText(m)).join('\n');
      await run(alice, { mode: 'on' });
      await d.panels.refresh(pid());
      assert.equal(d.client.channel(CHANNEL).live.map((m) => messageText(m)).join('\n'), before);
      assert.match(before, new RegExp(code('taken')));
    });
  });

  describe("in a person's list view", () => {
    it('leaves out the flights that are already taken and the completed ones, and says so, keeping their own', async () => {
      await run(alice, { mode: 'on' });
      await follow(alice);
      const text = listText(alice);
      assert.match(text, new RegExp(`\\*\\*${code('open')}\\*\\*`));
      assert.match(text, new RegExp(`\\*\\*${code('partly')}\\*\\*`), 'it still has a free leg');
      assert.match(text, new RegExp(`\\*\\*${code('mine')}\\*\\*`), 'their own flight stays');
      assert.doesNotMatch(text, new RegExp(`\\*\\*${code('taken')}\\*\\*`));
      assert.doesNotMatch(text, new RegExp(`\\*\\*${code('named')}\\*\\*`));
      assert.doesNotMatch(text, /completed flights/);
      assert.doesNotMatch(text, new RegExp(doneCode));
      assert.match(text, /🙈 You are hiding flights that are already taken, and completed ones \(`\/hideunavailable`\): 2 hidden right now/);
      assert.equal(alice.dmChannel.live.length, 1, 'no board of completed flights');
    });

    it('is the full list for someone who has not turned it on', async () => {
      await follow(bob);
      const text = listText(bob);
      for (const key of ['taken', 'open', 'partly', 'named', 'mine']) assert.match(text, new RegExp(`\\*\\*${code(key)}\\*\\*`), key);
      assert.match(text, /completed flights/);
      assert.doesNotMatch(text, /hiding flights/);
    });

    it('says so when nothing is left to show', async () => {
      h.jobs.sync(pid(), [sj('taken', 'EGLL-EGKK')]);
      await run(alice, { mode: 'on' });
      await follow(alice);
      assert.match(listText(alice), /No flights you could still take are listed right now/);
    });

    it('changes a list they already have, in place, when they switch it on and off', async () => {
      await follow(alice);
      assert.match(listText(alice), new RegExp(`\\*\\*${code('taken')}\\*\\*`));
      const ids = alice.dmChannel.live.map((m) => m.id);
      const { text } = await run(alice, { mode: 'on' });
      assert.match(text, /Your list view will update in a moment/);
      await d.panels.followersIdle();
      assert.doesNotMatch(listText(alice), new RegExp(`\\*\\*${code('taken')}\\*\\*`));
      assert.ok(alice.dmChannel.live.length <= ids.length);
      assert.deepEqual(alice.dmChannel.live.map((m) => m.id), ids.slice(0, alice.dmChannel.live.length), 'the same messages, edited');
      await run(alice, { mode: 'off' });
      await d.panels.followersIdle();
      assert.match(listText(alice), new RegExp(`\\*\\*${code('taken')}\\*\\*`));
      assert.match(listText(alice), /completed flights/);
    });

    it("stays right as the panel changes, for each person's own list", async () => {
      await run(alice, { mode: 'on' });
      await follow(alice);
      await follow(bob);
      h.jobs.reserve(idOf('open'), [1], USER_C); // the last free flight is taken
      await settle();
      await d.panels.followersIdle();
      assert.doesNotMatch(listText(alice), new RegExp(`\\*\\*${code('open')}\\*\\*`), 'now taken, so hidden for alice');
      assert.match(listText(bob), new RegExp(`\\*\\*${code('open')}\\*\\*`), 'bob sees everything');
      assert.match(listText(bob), new RegExp(`<@${USER_C.discordId}>`));
    });

    it('is applied from the first message when they ask for a list while it is on', async () => {
      await run(alice, { mode: 'on' });
      await follow(alice);
      await follow(alice); // asking again gives a fresh one with the same setting
      assert.doesNotMatch(listText(alice), new RegExp(`\\*\\*${code('taken')}\\*\\*`));
    });
  });

  describe('in their searches', () => {
    const search = async (user: FakeUser, from = 'EGLL', to = '') => {
      const f = fakeModal(user, `panel:searchgo:${pid()}`, { from, to, date: '', aircraft: '' });
      await handlerFor('panel:searchgo').handle(d.ctx, f.i as any);
      const reply = f.calls.edits[0];
      return { text: messageText({ payload: { embeds: reply.embeds } }), reply };
    };

    it('leave out the flights that are already taken, and say how many were left out', async () => {
      await run(alice, { mode: 'on' });
      const { text } = await search(alice);
      assert.match(text, new RegExp(code('open')));
      assert.match(text, new RegExp(code('partly')));
      assert.doesNotMatch(text, new RegExp(`${code('taken')} ·`));
      assert.doesNotMatch(text, new RegExp(`${code('named')} ·`));
      assert.match(text, /2 matching flights that are already taken are hidden \(you turned that on with `\/hideunavailable`\)/);
      assert.match(text, /2 flights match/);
    });

    it('show everything to someone who has not turned it on', async () => {
      const { text } = await search(bob);
      for (const key of ['taken', 'open', 'partly', 'named']) assert.match(text, new RegExp(code(key)), key);
      assert.doesNotMatch(text, /hidden/);
    });

    it('keep the flights they hold, and explain when only taken flights matched', async () => {
      await run(alice, { mode: 'on' });
      const mine = await search(alice, 'LFPG');
      assert.match(mine.text, new RegExp(code('mine')));
      assert.doesNotMatch(mine.text, /hidden/);
      const none = await search(alice, 'EGLL', 'EGPH'); // the only flight on that route is the one named in the sheet
      assert.match(none.text, /Nothing/);
      assert.match(none.text, /1 matching flight that is already taken is hidden/);
    });
  });

  it('keeps the setting in a table the database upgrade creates, per person', () => {
    h.store.setHideUnavailable(alice.id, true, h.clock.now);
    h.store.setHideUnavailable(alice.id, true, h.clock.now + 1);
    assert.equal(h.store.getHideUnavailable(alice.id), true);
    assert.equal(h.store.getHideUnavailable('999999999999999999'), false, 'nobody else has it');
    assert.deepEqual(h.store.listFollowedPanelIds(alice.id), []);
  });
});
