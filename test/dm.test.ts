import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { componentHandlers } from '../src/discord/commands/index.js';
import { handleDmMessage, MAX_ATTEMPTS, outcomeText, SESSION_TTL_MS } from '../src/discord/dm.js';
import { UserError } from '../src/discord/errors.js';
import { JobError } from '../src/services/jobs.js';
import { CHANNEL, GUILD, makeHarness, sj, USER_A, USER_B, type Harness } from './helpers.js';
import { fakeComponent, fakeDm, FakeUser, makeDiscordHarness, settle, type DiscordHarness, messageText } from './discord-helpers.js';

describe('the Reserve conversation', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  let pid: number;
  let single: number; // TST-001, one leg
  let multi: number; // TST-002, three legs

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    pid = h.panel.id;
    h.jobs.sync(pid, [sj('s', 'EGLL-EGKK'), sj('m', 'EGLL-EGKK-EGCC-EGPH')]);
    [single, multi] = h.jobs.open(pid).map((v) => v.job.id) as [number, number];
    await d.panels.refresh(pid);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const handlerFor = (customId: string) => componentHandlers.find((x) => x.prefix === customId.split(':')[0])!;
  const press = async (user: FakeUser, customId: string, o: { values?: string[]; guildId?: string | null; roles?: string[]; admin?: boolean } = {}) => {
    const f = fakeComponent(user, customId, o);
    await handlerFor(customId).handle(d.ctx, f.i);
    return f.calls;
  };
  const say = (user: FakeUser, text: string) => handleDmMessage(d.ctx, fakeDm(user, text));
  const startFor = async (user: FakeUser) => press(user, `panel:reserve:${pid}`);
  const panelText = () => d.client.channel(CHANNEL).live.map((m) => messageText(m)).join('\n');
  const legsOf = (id: number) => h.jobs.view(id)!.legs.map((l) => l.holder?.username ?? null);
  const menuOf = (payload: any) => payload.components.map((c: any) => c.toJSON()).flatMap((r: any) => r.components);

  describe('pressing Reserve', () => {
    it('opens a DM asking for the flight ID and tells the person to check it', async () => {
      const calls = await startFor(alice);
      assert.deepEqual(calls.defers[0], { flags: 64 }, 'the reply is private');
      assert.match(calls.edits[0].content, /sent you a DM/);
      assert.equal(alice.dms.length, 1);
      assert.match(alice.lastText, /Reserve a flight for Test Air/);
      assert.match(alice.lastText, /TST-001/);
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_code');
    });

    it('explains how to fix it when the person has DMs closed, and leaves no conversation behind', async () => {
      alice.failDms = true;
      await assert.rejects(startFor(alice), (e: unknown) => e instanceof UserError && /Allow direct messages/.test(e.message));
      assert.equal(h.store.getSession(alice.id, h.clock.now), null);
    });

    it('refuses when there is nothing to reserve', async () => {
      h.jobs.sync(pid, []);
      await assert.rejects(startFor(alice), /no open flights/);
    });

    it('refuses a button from another server or a deleted panel', async () => {
      await assert.rejects(press(alice, `panel:reserve:${pid}`, { guildId: 'other-guild' }), /no longer active/);
      await assert.rejects(press(alice, 'panel:reserve:99999'), /no longer active/);
      await assert.rejects(press(alice, 'panel:reserve:abc'), /out of date/);
      await assert.rejects(press(alice, 'panel:explode:1'), /out of date/);
    });

    describe('when the panel requires a role', () => {
      const ROLE = '555555555555555555';
      beforeEach(() => {
        h.store.updatePanel(pid, { requiredRoleId: ROLE });
      });

      it('refuses someone without the role, names the role, and sends no DM', async () => {
        await assert.rejects(
          startFor(alice),
          (e: unknown) => e instanceof UserError && e.message.includes(`<@&${ROLE}>`) && /limited to members with/.test(e.message),
        );
        assert.equal(alice.dms.length, 0);
        assert.equal(h.store.getSession(alice.id, h.clock.now), null);
        await assert.rejects(press(alice, `panel:reserve:${pid}`, { roles: ['999999999999999999'] }), /limited to members/);
      });

      it('lets someone with the role in', async () => {
        const calls = await press(alice, `panel:reserve:${pid}`, { roles: ['1', ROLE] });
        assert.match(calls.edits[0].content, /sent you a DM/);
        assert.equal(alice.dms.length, 1);
      });

      it('lets server admins in even without the role', async () => {
        await press(alice, `panel:reserve:${pid}`, { admin: true });
        assert.equal(alice.dms.length, 1);
      });

      it('understands members that carry their roles as a discord.js role cache', async () => {
        const f = fakeComponent(alice, `panel:reserve:${pid}`);
        (f.i as any).member = { roles: { cache: new Map([[ROLE, {}]]) } };
        await handlerFor(`panel:reserve:${pid}`).handle(d.ctx, f.i);
        assert.equal(alice.dms.length, 1);
        const g = fakeComponent(bob, `panel:reserve:${pid}`);
        (g.i as any).member = { roles: { cache: new Map() } };
        await assert.rejects(handlerFor(`panel:reserve:${pid}`).handle(d.ctx, g.i), /limited to members/);
      });

      it('copes with a missing member (never lets them through)', async () => {
        const f = fakeComponent(alice, `panel:reserve:${pid}`);
        (f.i as any).member = null;
        await assert.rejects(handlerFor(`panel:reserve:${pid}`).handle(d.ctx, f.i), /limited to members/);
      });

      it('does not stop people viewing or releasing what they already hold', async () => {
        h.jobs.reserve(single, [1], USER_A); // held from before the role was required
        const calls = await press(alice, `panel:mine:${pid}`);
        assert.match(calls.edits[0].content, /TST-001/);
      });

      it('with no role required, anyone can reserve', async () => {
        h.store.updatePanel(pid, { requiredRoleId: null });
        await startFor(alice);
        assert.equal(alice.dms.length, 1);
      });
    });

    it('starting again simply restarts the conversation', async () => {
      await startFor(alice);
      await say(alice, 'TST-002');
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_mode');
      await startFor(alice);
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_code');
    });
  });

  describe('a single-leg flight', () => {
    it('reserves it when the person replies with the ID, and the panel shows their name', async () => {
      await startFor(alice);
      await say(alice, 'TST-001');
      assert.match(alice.lastText, /✅ \*\*TST-001\*\* \(EGLL → EGKK\) is reserved for you/);
      assert.match(alice.lastText, /panel has been updated/);
      assert.equal(h.store.getSession(alice.id, h.clock.now), null, 'conversation is finished');
      await settle();
      assert.match(panelText(), new RegExp(`^TST-001 ·[^\\n]*\\n## [^\\n]*\\n(?:[A-Z ]+: [^\\n]*\\n)*PILOT: <@${USER_A.discordId}>`, 'm'));
      assert.deepEqual(legsOf(single), ['alice']);
    });

    it('accepts the ID however it is typed', async () => {
      for (const typed of ['1', 'tst-1', ' TST 001 ', 'tst001']) {
        h.jobs.release(single, alice.id);
        await startFor(alice);
        await say(alice, typed);
        assert.deepEqual(legsOf(single), ['alice'], typed);
      }
    });

    it('says who has it when it is already taken, and changes nothing', async () => {
      h.jobs.reserve(single, [1], USER_B);
      await startFor(alice);
      await say(alice, 'TST-001');
      assert.match(alice.lastText, new RegExp(`already taken by <@${USER_B.discordId}>`));
      assert.match(alice.lastText, /Nothing was reserved/);
      assert.deepEqual(legsOf(single), ['bob']);
    });

    it('tells someone who already holds it', async () => {
      h.jobs.reserve(single, [1], USER_A);
      await startFor(alice);
      await say(alice, 'TST-001');
      assert.match(alice.lastText, /already had/);
    });
  });

  describe('mistyped IDs', () => {
    it('asks again and keeps the conversation open', async () => {
      await startFor(alice);
      await say(alice, 'TST-999');
      assert.match(alice.lastText, /can't find an open flight with the ID `TST-999`/);
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.attempts, 1);
      await say(alice, 'TST-001'); // then gets it right
      assert.deepEqual(legsOf(single), ['alice']);
    });

    it('does not accept another airline\'s prefix or a closed flight', async () => {
      await startFor(alice);
      await say(alice, 'DMO-001');
      assert.match(alice.lastText, /can't find/);
      h.jobs.sync(pid, [sj('m', 'EGLL-EGKK-EGCC-EGPH')]); // closes TST-001
      await say(alice, 'TST-001');
      assert.match(alice.lastText, /can't find/);
    });

    it(`gives up after ${MAX_ATTEMPTS} wrong IDs`, async () => {
      await startFor(alice);
      for (let i = 0; i < MAX_ATTEMPTS; i++) await say(alice, `nope${i}`);
      assert.match(alice.lastText, /closed this/);
      assert.equal(h.store.getSession(alice.id, h.clock.now), null);
    });

    it('lets the person cancel in plain words', async () => {
      await startFor(alice);
      await say(alice, 'Cancel');
      assert.match(alice.lastText, /cancelled/);
      assert.equal(h.store.getSession(alice.id, h.clock.now), null);
    });

    it('shortens very long junk in its reply', async () => {
      await startFor(alice);
      await say(alice, 'x'.repeat(500));
      assert.ok(alice.lastText.length < 400);
    });
  });

  describe('a multi-leg flight', () => {
    const askAllOrSome = async () => {
      await startFor(alice);
      await say(alice, 'TST-002');
    };

    it('asks whether the person is flying all or some of the legs', async () => {
      await askAllOrSome();
      assert.match(alice.lastText, /\*\*TST-002\*\* has 3 legs/);
      assert.match(alice.lastText, /all of them, or just some/);
      const buttons = alice.last.components[0].toJSON().components;
      assert.deepEqual(buttons.map((b: any) => b.custom_id), ['dm:all', 'dm:some', 'dm:cancel']);
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_mode');
    });

    it('ALL: puts their name on every leg', async () => {
      await askAllOrSome();
      const calls = await press(alice, 'dm:all');
      assert.match(calls.updates[0].content, /✅ \*\*TST-002\*\*: you've got legs 1 \(EGLL → EGKK\), 2 \(EGKK → EGCC\), 3 \(EGCC → EGPH\)/);
      assert.deepEqual(calls.updates[0].components, []);
      assert.deepEqual(legsOf(multi), ['alice', 'alice', 'alice']);
      await settle();
      for (let leg = 1; leg <= 3; leg++) assert.match(panelText(), new RegExp(`\`${leg}\` [A-Z]{4} → [A-Z]{4} — <@${USER_A.discordId}>`));
      assert.equal(h.store.getSession(alice.id, h.clock.now), null);
    });

    it('ALL when a leg is taken: offers the remaining legs, and only takes those', async () => {
      h.jobs.reserve(multi, [2], USER_B);
      await askAllOrSome();
      const ask = await press(alice, 'dm:all');
      assert.match(ask.updates[0].content, new RegExp(`Leg 2 \\(EGKK → EGCC\\) is already taken by <@${USER_B.discordId}>`));
      assert.match(ask.updates[0].content, /other legs \(1 and 3\)/);
      assert.deepEqual(menuOf(ask.updates[0]).map((b: any) => [b.custom_id, b.label]), [['dm:take', 'Take legs 1 and 3'], ['dm:cancel', 'Cancel']]);
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_confirm');

      const done = await press(alice, 'dm:take');
      assert.match(done.updates[0].content, /you've got legs 1/);
      assert.deepEqual(legsOf(multi), ['alice', 'bob', 'alice']);
      await settle();
      assert.match(panelText(), new RegExp(`\`2\` EGKK → EGCC — <@${USER_B.discordId}>`));
    });

    it('ALL when every leg is taken: says so', async () => {
      h.jobs.reserve(multi, [1, 2], USER_B);
      h.jobs.reserve(multi, [3], { discordId: '999999999999999999', username: 'dave' });
      await askAllOrSome();
      const calls = await press(alice, 'dm:all');
      assert.match(calls.updates[0].content, /Every leg of \*\*TST-002\*\* is already taken/);
      assert.deepEqual(legsOf(multi), ['bob', 'bob', 'dave']);
    });

    it('SOME: shows a menu of the free legs, and places their name only on the legs they choose', async () => {
      h.jobs.reserve(multi, [2], USER_B);
      await askAllOrSome();
      const ask = await press(alice, 'dm:some');
      const menu = menuOf(ask.updates[0]).find((c: any) => c.custom_id === 'dm:legs');
      assert.deepEqual(menu.options.map((o: any) => o.value), ['1', '3'], 'taken legs are not offered');
      assert.deepEqual([menu.min_values, menu.max_values], [1, 2]);
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_legs');

      const done = await press(alice, 'dm:legs', { values: ['3'] });
      assert.match(done.updates[0].content, /you've got leg 3 \(EGCC → EGPH\)/);
      assert.deepEqual(legsOf(multi), [null, 'bob', 'alice']);
      await settle();
      assert.match(panelText(), new RegExp(`\`3\` EGCC → EGPH — <@${USER_A.discordId}>`));
      assert.match(panelText(), /`1` EGLL → EGKK — \*open\*/);
    });

    it('SOME: two pilots can split one flight between them', async () => {
      await startFor(alice);
      await say(alice, 'TST-002');
      await press(alice, 'dm:some');
      await press(alice, 'dm:legs', { values: ['1', '2'] });
      await startFor(bob);
      await say(bob, 'TST-002');
      await press(bob, 'dm:some');
      await press(bob, 'dm:legs', { values: ['3'] });
      assert.deepEqual(legsOf(multi), ['alice', 'alice', 'bob']);
    });

    it('SOME: says so when nothing is free', async () => {
      h.jobs.reserve(multi, [1, 2, 3], USER_B);
      await askAllOrSome();
      const calls = await press(alice, 'dm:some');
      assert.match(calls.updates[0].content, /no free legs/);
    });

    it('SOME: reports a leg that someone grabbed while the person was choosing', async () => {
      await askAllOrSome();
      await press(alice, 'dm:some');
      h.jobs.reserve(multi, [3], USER_B); // bob is quicker
      const done = await press(alice, 'dm:legs', { values: ['1', '3'] });
      assert.match(done.updates[0].content, /you've got leg 1/);
      assert.match(done.updates[0].content, new RegExp(`Leg 3 \\(EGCC → EGPH\\) is already taken by <@${USER_B.discordId}>`));
      assert.deepEqual(legsOf(multi), ['alice', null, 'bob']);
    });

    it('the Cancel button ends the conversation without reserving anything', async () => {
      await askAllOrSome();
      const calls = await press(alice, 'dm:cancel');
      assert.match(calls.updates[0].content, /cancelled/);
      assert.deepEqual(legsOf(multi), [null, null, null]);
      assert.equal(h.store.getSession(alice.id, h.clock.now), null);
    });

    it('nudges toward the buttons if the person types instead of pressing one', async () => {
      await askAllOrSome();
      await say(alice, 'all of them please');
      assert.match(alice.lastText, /use the buttons/);
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_mode', 'still waiting');
    });
  });

  describe('stale and foreign buttons', () => {
    it('a button with no open conversation says it has closed', async () => {
      const calls = await press(alice, 'dm:all');
      assert.match(calls.updates[0].content, /has closed/);
      assert.deepEqual(calls.updates[0].components, []);
    });

    it('conversations expire after 10 minutes', async () => {
      await startFor(alice);
      await say(alice, 'TST-002');
      h.clock.advance(SESSION_TTL_MS + 1000);
      const calls = await press(alice, 'dm:all');
      assert.match(calls.updates[0].content, /has closed/);
      assert.deepEqual(legsOf(multi), [null, null, null]);
    });

    it('if the flight closes mid-conversation, nothing is reserved', async () => {
      await startFor(alice);
      await say(alice, 'TST-002');
      h.jobs.sync(pid, [sj('s', 'EGLL-EGKK')]); // multi disappears
      const calls = await press(alice, 'dm:all');
      assert.match(calls.updates[0].content, /just been closed/);
    });

    it("one person's buttons cannot drive another person's conversation", async () => {
      await startFor(alice);
      await say(alice, 'TST-002');
      const calls = await press(bob, 'dm:all'); // bob has no conversation
      assert.match(calls.updates[0].content, /has closed/);
      assert.deepEqual(legsOf(multi), [null, null, null]);
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_mode', "alice's is untouched");
    });

    it('an unknown action is reported as out of date', async () => {
      await startFor(alice);
      await say(alice, 'TST-002');
      const calls = await press(alice, 'dm:wat');
      assert.match(calls.updates[0].content, /out of date/);
    });
  });

  describe('messages outside a conversation', () => {
    it('points people at the Reserve button, but only once in a while', async () => {
      const carol = new FakeUser('444444444444444444', 'carol');
      await say(carol, 'hello?');
      assert.match(carol.lastText, /press \*\*Reserve\*\*/);
      await say(carol, 'anyone there?');
      assert.equal(carol.dms.length, 1, 'no spam');
      h.clock.advance(6 * 60_000);
      await say(carol, 'hello again');
      assert.equal(carol.dms.length, 2);
    });

    it('ignores bots and messages sent in a server', async () => {
      const bot = new FakeUser('555555555555555555', 'otherbot', true);
      await handleDmMessage(d.ctx, fakeDm(bot, 'hi'));
      assert.equal(bot.dms.length, 0);
      await handleDmMessage(d.ctx, { author: alice, guildId: GUILD, content: 'TST-001' } as never);
      assert.equal(alice.dms.length, 0);
      assert.deepEqual(legsOf(single), [null]);
    });
  });

  describe('My flights', () => {
    const mine = (user: FakeUser) => press(user, `panel:mine:${pid}`);

    it('says so when the person has nothing reserved', async () => {
      const calls = await mine(alice);
      assert.match(calls.edits[0].content, /haven't reserved anything/);
    });

    it('lists the person\'s legs with a menu to release them', async () => {
      h.jobs.reserve(single, [1], USER_A);
      h.jobs.reserve(multi, [1, 3], USER_A);
      h.jobs.reserve(multi, [2], USER_B);
      const calls = await mine(alice);
      const text = calls.edits[0].content as string;
      assert.match(text, /\*\*TST-001\*\* · EGLL → EGKK/);
      assert.match(text, /\*\*TST-002\*\* · leg 1: EGLL → EGKK, leg 3: EGCC → EGPH/);
      assert.doesNotMatch(text, /leg 2/, "bob's leg is not listed");
      const menu = menuOf(calls.edits[0])[0];
      assert.equal(menu.custom_id, `panel:release:${pid}`);
      assert.deepEqual(menu.options.map((o: any) => o.value), [`${single}:1`, `${multi}:1`, `${multi}:3`]);
    });

    it("shows deadlines in the person's own timezone (Discord timestamps), never as fixed UTC text", async () => {
      h.jobs.reserve(single, [1], USER_A);
      h.jobs.reserve(multi, [2], USER_A);
      const calls = await mine(alice);
      const text = calls.edits[0].content as string;
      const deadline = h.jobs.view(single)!.job.deadline!;
      const unix = Math.floor(deadline / 1000);
      assert.match(text, new RegExp(`⏰ complete by <t:${unix}:f> \\(<t:${unix}:R>\\)`));
      assert.doesNotMatch(text, /UTC/);
      for (const option of menuOf(calls.edits[0])[0].options) {
        assert.equal(option.description, undefined, 'dropdown captions cannot be localised, so they carry no time');
        assert.doesNotMatch(JSON.stringify(option), /UTC|\d{4}-\d{2}-\d{2}/);
      }
    });

    it('releasing frees the legs and updates the panel', async () => {
      h.jobs.reserve(multi, [1, 2], USER_A);
      const calls = await press(alice, `panel:release:${pid}`, { values: [`${multi}:1`] });
      assert.match(calls.edits[0].content, /Released: TST-002 leg 1/);
      assert.deepEqual(legsOf(multi), [null, 'alice', null]);
      await settle();
      assert.match(panelText(), /`1` EGLL → EGKK — \*open\*/);
    });

    it("cannot release another person's leg, even with a forged choice", async () => {
      h.jobs.reserve(multi, [2], USER_B);
      const calls = await press(alice, `panel:release:${pid}`, { values: [`${multi}:2`, 'junk', `99999:1`] });
      assert.match(calls.edits[0].content, /Nothing to release/);
      assert.deepEqual(legsOf(multi), [null, 'bob', null]);
    });

    it("ignores a choice that points at another panel's job", async () => {
      const other = h.store.createPanel({ guildId: GUILD, name: 'Other', abbr: 'OTH', prefix: 'OTH', channelId: '800000000000000001', now: h.clock.now });
      h.jobs.sync(other.id, [sj('x', 'EGLL-EGKK')]);
      const otherJob = h.jobs.open(other.id)[0]!.job.id;
      h.jobs.reserve(otherJob, [1], USER_A);
      const calls = await press(alice, `panel:release:${pid}`, { values: [`${otherJob}:1`] });
      assert.match(calls.edits[0].content, /Nothing to release/);
      assert.deepEqual(h.jobs.view(otherJob)!.legs.map((l) => l.holder?.username), ['alice']);
    });
  });

  describe('outcomeText', () => {
    it('reads naturally for each mix of results', () => {
      h.jobs.reserve(multi, [2], USER_B);
      const r = h.jobs.reserve(multi, [1, 2, 3], USER_A);
      const text = outcomeText(r);
      assert.match(text, /you've got legs 1 \(EGLL → EGKK\) and 3 \(EGCC → EGPH\)/);
      assert.match(text, /Leg 2 \(EGKK → EGCC\) is already taken by/);
      assert.match(text, /panel has been updated/);
    });
  });

  describe('deadlines', () => {
    it('a flight whose deadline has just passed cannot be reserved, even before the sweep closes it', async () => {
      h.jobs.sync(pid, [sj('s', 'EGLL-EGKK', { deadline: h.clock.now + 5 * 60_000 }), sj('m', 'EGLL-EGKK-EGCC-EGPH')]);
      await startFor(alice);
      h.clock.advance(6 * 60_000); // conversation still open (10 min), flight is over, sweep hasn't run
      await say(alice, 'TST-001');
      assert.match(alice.lastText, /can't find an open flight/);
      assert.deepEqual(legsOf(single), [null]);
    });

    it('an error while reserving is said in the DM instead of leaving the person in silence', async () => {
      await startFor(alice);
      const real = d.ctx.jobs.reserve.bind(d.ctx.jobs);
      d.ctx.jobs.reserve = () => {
        throw new JobError('EXPIRED', 'TST-001 has passed its deadline.');
      };
      await say(alice, 'TST-001');
      d.ctx.jobs.reserve = real;
      assert.match(alice.lastText, /TST-001 has passed its deadline/);
      assert.match(alice.lastText, /Press \*\*Reserve\*\*/);
      assert.equal(h.store.getSession(alice.id, h.clock.now), null, 'the conversation is closed');
    });

    it('a button that hits a booking error says so in the DM and closes the conversation', async () => {
      await startFor(alice);
      await say(alice, 'TST-002');
      const real = d.ctx.jobs.reserve.bind(d.ctx.jobs);
      d.ctx.jobs.reserve = () => {
        throw new JobError('EXPIRED', 'TST-002 has passed its deadline.');
      };
      const calls = await press(alice, 'dm:all');
      d.ctx.jobs.reserve = real;
      assert.match(calls.updates[0].content, /TST-002 has passed its deadline/);
      assert.deepEqual(calls.updates[0].components, []);
      assert.equal(h.store.getSession(alice.id, h.clock.now), null);
    });

    it('unexpected errors are not swallowed (they reach the logger)', async () => {
      await startFor(alice);
      d.ctx.jobs.reserve = () => {
        throw new Error('database exploded');
      };
      await assert.rejects(say(alice, 'TST-001'), /database exploded/);
    });
  });
});

describe('the FsHub pilot ID', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let pid: number;

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h, { pilotIds: false }); // nobody has told the bot their ID yet
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    pid = h.panel.id;
    h.jobs.sync(pid, [sj('s', 'EGLL-EGKK'), sj('t', 'EGLL-EGCC')]);
    await d.panels.refresh(pid);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const press = async (user: FakeUser, customId: string) => {
    const f = fakeComponent(user, customId, {});
    await componentHandlers.find((x) => x.prefix === customId.split(':')[0])!.handle(d.ctx, f.i);
    return f.calls;
  };
  const say = (user: FakeUser, text: string) => handleDmMessage(d.ctx, fakeDm(user, text));
  const reserveButton = () => press(alice, `panel:reserve:${pid}`);
  const panelText = () => d.client.channel(CHANNEL).live.map((m) => messageText(m)).join('\n');

  describe('asking for it', () => {
    it('is the first thing the DM asks, before the flight, and says what it is for and where to find it', async () => {
      const calls = await reserveButton();
      assert.match(calls.edits[0].content, /with your FsHub pilot ID, then the ID of the flight/);
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_pilot');
      assert.match(alice.lastText, /what is your FsHub pilot ID/);
      assert.match(alice.lastText, /fshub\.io\/pilot\/\*\*1234\*\*\/overview/, 'says where the number is');
      assert.match(alice.lastText, /match you to the airline's roster/);
      assert.match(alice.lastText, /don't check it with FsHub/, 'honest that it is not verified');
      assert.match(alice.lastText, /`fshub <your ID>`/, 'says how to change it later');
      assert.doesNotMatch(alice.lastText, /TST-001/, 'the flight comes next');
    });

    it('is asked once: the next Reserve goes straight to the flight', async () => {
      await reserveButton();
      await say(alice, '4821');
      await say(alice, 'cancel');
      const second = await reserveButton();
      assert.match(second.edits[0].content, /Reply there with the ID of the flight you want/);
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_code');
      assert.doesNotMatch(alice.lastText, /pilot ID/);
    });

    it('asks again next time if the person never answered', async () => {
      await reserveButton();
      await say(alice, 'cancel');
      assert.equal(h.store.getPilotId(alice.id), null);
      await reserveButton();
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_pilot');
    });
  });

  describe('answering', () => {
    it('saves a number, moves on to asking for the flight, and then shows the ID beside their name', async () => {
      await reserveButton();
      await say(alice, '4821');
      assert.equal(h.store.getPilotId(alice.id), 4821);
      assert.match(alice.lastText, /saved your FsHub pilot ID as \*\*4821\*\*/);
      assert.match(alice.lastText, /Reply with the flight ID shown on the panel, for example `TST-001`/);
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_code');

      await say(alice, 'TST-001');
      assert.match(alice.lastText, /TST-001.*is reserved for you/);
      await settle();
      assert.match(panelText(), new RegExp(`^PILOT: <@${USER_A.discordId}> · FsHub #4821`, 'm'));
    });

    it('takes a profile link or a number with a # as well', async () => {
      await reserveButton();
      await say(alice, 'https://fshub.io/pilot/777/overview');
      assert.equal(h.store.getPilotId(alice.id), 777);
      await say(alice, 'fshub #31');
      assert.equal(h.store.getPilotId(alice.id), 31);
    });

    it('explains what it needs when the reply is not an ID, and gives up after a few tries without saving anything', async () => {
      await reserveButton();
      await say(alice, 'Alice Anders');
      assert.match(alice.lastText, /I need your FsHub pilot ID: just the number/);
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_pilot');
      for (let i = 1; i < MAX_ATTEMPTS; i++) await say(alice, 'nope');
      assert.match(alice.lastText, /closed this/);
      assert.equal(h.store.getSession(alice.id, h.clock.now), null);
      assert.equal(h.store.getPilotId(alice.id), null);
    });

    it('does not mistake a flight ID for a pilot ID', async () => {
      await reserveButton();
      await say(alice, 'TST-001');
      assert.equal(h.store.getPilotId(alice.id), null);
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_pilot');
      assert.equal(h.jobs.mine(pid, alice.id).length, 0, 'nothing was reserved');
    });

    it('can be cancelled', async () => {
      await reserveButton();
      await say(alice, 'cancel');
      assert.match(alice.lastText, /cancelled/);
      assert.equal(h.store.getSession(alice.id, h.clock.now), null);
    });

    it('buttons from an older conversation do not run while the ID is still being asked for', async () => {
      await reserveButton();
      const calls = await press(alice, 'dm:all');
      assert.match(calls.updates[0].content, /conversation has closed/);
      assert.equal(h.jobs.mine(pid, alice.id).length, 0);
    });
  });

  describe('`fshub <ID>` in a DM', () => {
    it('sets it at any time, with no conversation open', async () => {
      await say(alice, 'fshub 1234');
      assert.equal(h.store.getPilotId(alice.id), 1234);
      assert.match(alice.lastText, /your FsHub pilot ID is \*\*1234\*\*/);
    });

    it('changes it, and redraws the panels where that person holds a flight so the new number shows', async () => {
      await reserveButton();
      await say(alice, '4821');
      await say(alice, 'TST-001');
      await settle();
      assert.match(panelText(), /FsHub #4821/);
      await say(alice, 'fshub 99');
      await settle();
      assert.equal(h.store.getPilotId(alice.id), 99);
      assert.match(panelText(), /FsHub #99\b/);
      assert.doesNotMatch(panelText(), /FsHub #4821/);
    });

    it('works in the middle of a Reserve conversation without ending it', async () => {
      await reserveButton();
      await say(alice, 'fshub 55');
      assert.equal(h.store.getPilotId(alice.id), 55);
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_pilot', 'still waiting; the answer just arrived another way');
      await say(alice, '55');
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_code');
    });

    it('explains itself when given nothing usable, and keeps the old ID', async () => {
      h.store.setPilotId(alice.id, 4821, h.clock.now);
      await say(alice, 'fshub');
      assert.match(alice.lastText, /like this: `fshub 1234`/);
      assert.match(alice.lastText, /currently have \*\*4821\*\*/);
      await say(alice, 'fshub banana');
      assert.equal(h.store.getPilotId(alice.id), 4821);
    });

    it('only that exact word: something that merely starts with the letters is not the command', async () => {
      h.store.setPilotId(alice.id, 4821, h.clock.now);
      await reserveButton();
      await say(alice, 'fshubby');
      assert.equal(h.store.getPilotId(alice.id), 4821, 'unchanged');
      assert.match(alice.lastText, /can't find an open flight/);
    });
  });

  describe('where it shows', () => {
    it('beside everyone who has given one, and nothing beside someone who has not', async () => {
      h.store.setPilotId(alice.id, 4821, h.clock.now);
      h.jobs.reserve(h.jobs.open(pid)[0]!.job.id, [1], USER_A);
      h.jobs.reserve(h.jobs.open(pid)[1]!.job.id, [1], USER_B);
      await d.panels.refresh(pid);
      const text = panelText();
      assert.match(text, new RegExp(`<@${USER_A.discordId}> · FsHub #4821`));
      assert.match(text, new RegExp(`<@${USER_B.discordId}>`));
      assert.doesNotMatch(text, new RegExp(`<@${USER_B.discordId}> · FsHub`));
    });

    it('is mentioned, with how to change it, under My flights', async () => {
      h.store.setPilotId(alice.id, 4821, h.clock.now);
      h.jobs.reserve(h.jobs.open(pid)[0]!.job.id, [1], USER_A);
      const calls = await press(alice, `panel:mine:${pid}`);
      assert.match(calls.edits[0].content, /Your FsHub pilot ID is shown as \*\*4821\*\*\. Wrong\? DM me `fshub <your ID>`/);
    });

    it('is left out of My flights when none has been given', async () => {
      h.jobs.reserve(h.jobs.open(pid)[0]!.job.id, [1], USER_A);
      const calls = await press(alice, `panel:mine:${pid}`);
      assert.doesNotMatch(calls.edits[0].content, /FsHub/);
    });
  });
});
