import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { componentHandlers } from '../src/discord/commands/index.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { GUILD, makeHarness, sj, T0, type Harness } from './helpers.js';
import { fakeComponent, fakeDm, FakeUser, makeDiscordHarness, settle, type DiscordHarness, type FakeDmOptions } from './discord-helpers.js';

const ROLE = '555555555555555555';
const OTHER_GUILD = '900000000000000099';
let nextUser = 800000000000000000n;
/** A new person every time, so nothing one test leaves behind (a message cooldown, say) can reach another. */
const person = (name: string): FakeUser => new FakeUser(String(++nextUser), name);

describe('asking for a flight straight in a DM, without pressing a button first', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let pid: number;
  let bob: FakeUser;

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(person('alice'));
    bob = d.client.user(person('bob'));
    pid = h.panel.id;
    h.jobs.sync(pid, [sj('s1', 'EGLL-EGKK'), sj('s2', 'EGKK-EGCC'), sj('m', 'EGLL-EGKK-EGCC-EGPH')]); // TST-001, TST-002 one leg; TST-003 three legs
    // Both people have given their FsHub pilot ID before, unless a test says otherwise.
    h.store.setPilotId(alice.id, 1234, T0, 'Alice');
    h.store.setPilotId(bob.id, 5678, T0, 'Bob');
    await d.panels.refresh(pid);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const say = (user: FakeUser, text: string, o: FakeDmOptions = {}) => handleDmMessage(d.ctx, fakeDm(user, text, o));
  const job = (code: string) => h.jobs.open(pid).find((v) => v.job.code === code)!;
  const holder = (code: string) => job(code).legs.map((l) => l.holder?.discordId ?? null);
  const session = (u: FakeUser) => h.store.getSession(u.id, h.clock.now);
  const press = async (user: FakeUser, customId: string) => {
    const f = fakeComponent(user, customId);
    await componentHandlers.find((x) => x.prefix === customId.split(':')[0])!.handle(d.ctx, f.i);
    return f.calls;
  };
  const hint = /^To reserve a flight, press \*\*Reserve\*\* on a flight panel/;

  describe('reserving', () => {
    it('reserves a flight from its ID alone, and leaves no conversation open', async () => {
      await say(alice, 'TST-001');
      assert.match(alice.lastText, /^✅ \*\*TST-001\*\* \(EGLL → EGKK\) is reserved for you\.\nThe panel has been updated with your name\.$/);
      assert.deepEqual(holder('TST-001'), [alice.id]);
      assert.equal(session(alice), null);
      assert.equal(alice.dms.length, 1);
    });

    it('also takes it with a word that says what to do, in any case and with other words around it', async () => {
      await say(alice, 'reserve tst-001');
      assert.deepEqual(holder('TST-001'), [alice.id]);
      await say(alice, 'Please BOOK TST-002 for me');
      assert.deepEqual(holder('TST-002'), [alice.id]);
    });

    it('takes the short form of an ID only with a word that says what to do', async () => {
      await say(alice, 'reserve 2');
      assert.deepEqual(holder('TST-002'), [alice.id]);
      await say(alice, '1');
      assert.match(alice.lastText, hint, 'a bare number is never taken for a flight');
      assert.deepEqual(holder('TST-001'), [null]);
    });

    it('reserves several flights named in one message, as the conversation does', async () => {
      await say(alice, 'TST-001, TST-002');
      assert.match(alice.lastText, /TST-001/);
      assert.match(alice.lastText, /TST-002/);
      assert.deepEqual([holder('TST-001'), holder('TST-002')], [[alice.id], [alice.id]]);
    });

    it('asks which legs for a flight with several, and carries on with the buttons', async () => {
      await say(alice, 'TST-003');
      assert.match(alice.lastText, /\*\*TST-003\*\* has 3 legs\. Are you flying all of them, or just some\?/);
      assert.equal(session(alice)?.step, 'await_mode');
      const calls = await press(alice, 'dm:all');
      assert.match(calls.updates[0].content, /you've got legs/);
      assert.deepEqual(holder('TST-003'), [alice.id, alice.id, alice.id]);
    });

    it('says a flight someone else has is taken, and changes nothing', async () => {
      h.jobs.reserve(job('TST-001').job.id, [1], { discordId: bob.id, username: 'bob' });
      await say(alice, 'TST-001');
      assert.match(alice.lastText, /already taken by <@\d+>/);
      assert.deepEqual(holder('TST-001'), [bob.id]);
      assert.equal(session(alice), null);
    });

    it('does nothing for ordinary messages, which get the usual pointer', async () => {
      for (const text of ['hello there', 'thanks 2', '12345', 'A320', 'see you at 4pm', '7', 'what about ZZZ-999']) {
        const stranger = person('stranger'); // the pointer is sent to one person at most once in a while
        h.store.setPilotId(stranger.id, 1, T0, 'Stranger');
        await say(stranger, text);
        assert.match(stranger.lastText, hint, text);
        assert.equal(session(stranger), null, text);
      }
      assert.deepEqual([holder('TST-001'), holder('TST-002'), holder('TST-003')], [[null], [null], [null, null, null]]);
    });

    it('answers a flight ID that is not on any panel only when asked outright, and then says what IDs look like', async () => {
      await say(alice, 'reserve ZZZ-999');
      assert.match(alice.lastText, /^I can't find an open flight with the ID `ZZZ-999`\. IDs look like `TST-001` and are listed on the panel\.$/);
      alice.dms.length = 0;
      await say(alice, 'ZZZ-999');
      assert.match(alice.lastText, hint, 'a bare ID that matches nothing is just a message');
    });

    it('reserves a flight that is on the panel of another server the person is also in', async () => {
      const far = h.store.createPanel({ guildId: OTHER_GUILD, name: 'Far Air', abbr: 'FAR', prefix: 'FAR', channelId: '700000000000000050', now: T0 });
      h.jobs.sync(far.id, [sj('f1', 'EGLL-EGKK')]);
      await say(alice, 'FAR-001', { guilds: [GUILD, OTHER_GUILD] });
      assert.match(alice.lastText, /\*\*FAR-001\*\* \(EGLL → EGKK\) is reserved for you/);
      assert.equal(h.jobs.open(far.id)[0]!.legs[0]!.holder?.discordId, alice.id);
    });

    it('asks which panel when the same ID is on more than one the person can use', async () => {
      const far = h.store.createPanel({ guildId: OTHER_GUILD, name: 'Far Air', abbr: 'FAR', prefix: 'TST', channelId: '700000000000000050', now: T0 });
      h.jobs.sync(far.id, [sj('f1', 'EGLL-EGKK')]);
      await say(alice, 'TST-001', { guilds: [GUILD, OTHER_GUILD] });
      assert.match(alice.lastText, /^That ID is on more than one panel you can use \(\*\*Test Air\*\*, \*\*Far Air\*\*\)\. Press \*\*Reserve\*\* on the one you mean\.$/);
      assert.deepEqual(holder('TST-001'), [null]);
      assert.equal(h.jobs.open(far.id)[0]!.legs[0]!.holder, null);
    });

    it('asks Discord about the person every time, never trusting a copy the bot may hold (without the members intent it is never told a role was taken away or they left)', async () => {
      const asked: unknown[] = [];
      await say(alice, 'TST-001', { memberFetches: asked });
      assert.deepEqual(asked, [{ user: alice.id, force: true }]);
    });

    describe('who may', () => {
      it('is not for someone who is not in the airline\'s server: they get the usual pointer, and nothing is reserved', async () => {
        await say(alice, 'TST-001', { guilds: [OTHER_GUILD] });
        assert.match(alice.lastText, hint);
        assert.deepEqual(holder('TST-001'), [null]);
        await say(bob, 'reserve TST-001', { guilds: [OTHER_GUILD] });
        assert.match(bob.lastText, hint, 'even when they ask outright');
        assert.deepEqual(holder('TST-001'), [null]);
      });

      it('is not for someone who cannot see the panel\'s channel', async () => {
        await say(alice, 'TST-001', { canSee: false });
        assert.match(alice.lastText, hint);
        assert.deepEqual(holder('TST-001'), [null]);
      });

      it('does not guess when Discord cannot say who the person is: it says so and reserves nothing', async () => {
        await say(alice, 'TST-001', { memberError: Object.assign(new Error('Discord is busy'), { code: 500 }) });
        assert.match(alice.lastText, /^I couldn't check your place in the airline's server just now\. Try again in a minute, or press the button on the panel\.$/);
        assert.deepEqual(holder('TST-001'), [null]);
      });

      describe('on a panel limited to a role', () => {
        beforeEach(() => {
          h.store.updatePanel(pid, { requiredRoleId: ROLE });
        });

        it('turns someone without the role away and names it', async () => {
          await say(alice, 'TST-001', { roleNames: { [ROLE]: 'Pilot' } });
          assert.match(alice.lastText, /^Reserving flights for \*\*Test Air\*\* is limited to members with the \*\*Pilot\*\* role\.$/);
          assert.deepEqual(holder('TST-001'), [null]);
        });

        it('lets someone with the role, and a server admin without it, reserve', async () => {
          await say(alice, 'TST-001', { roles: [ROLE] });
          assert.deepEqual(holder('TST-001'), [alice.id]);
          await say(bob, 'TST-002', { admin: true });
          assert.deepEqual(holder('TST-002'), [bob.id]);
        });

        it('says it plainly when the role cannot be named', async () => {
          await say(alice, 'TST-001');
          assert.match(alice.lastText, /is limited to members with a role you do not have\.$/);
        });
      });
    });

    describe('the first time, before the FsHub pilot ID is known', () => {
      let carol: FakeUser;
      beforeEach(() => {
        carol = d.client.user(person('carol'));
      });

      it('asks for it first, says what it will do after, and does that as soon as it has the ID', async () => {
        await say(carol, 'reserve TST-001');
        assert.match(carol.lastText, /First, what is your FsHub pilot ID\?/);
        assert.match(carol.lastText, /Then I'll carry on with `reserve TST-001`\./);
        assert.deepEqual([session(carol)?.step, session(carol)?.pendingText], ['await_pilot', 'reserve TST-001']);
        assert.deepEqual(holder('TST-001'), [null]);

        await say(carol, '4321');
        assert.equal(h.store.getPilotId(carol.id), 4321);
        assert.match(carol.dms.at(-2)!.content, /^Thanks, I've saved your FsHub pilot ID as/);
        assert.match(carol.lastText, /\*\*TST-001\*\* \(EGLL → EGKK\) is reserved for you/);
        assert.deepEqual(holder('TST-001'), [carol.id]);
        assert.equal(session(carol), null);
      });

      it('is not fooled into taking the request for the answer', async () => {
        await say(carol, 'TST-001');
        await say(carol, 'reserve TST-002');
        assert.match(carol.lastText, /I need your FsHub pilot ID/);
        assert.deepEqual([holder('TST-001'), holder('TST-002')], [[null], [null]]);
        assert.equal(session(carol)?.pendingText, 'TST-001', 'the first request is still waiting');
      });

      it('with only the word, asks for the pilot ID and then for the flight, as the button does', async () => {
        await say(carol, 'reserve');
        assert.match(carol.lastText, /First, what is your FsHub pilot ID\?/);
        assert.equal(session(carol)?.pendingText, null);
        await say(carol, '4321');
        assert.match(carol.lastText, /Reply with the flight ID shown on the panel, for example `TST-001`\./);
        assert.equal(session(carol)?.step, 'await_code');
      });
    });

    describe('the word on its own', () => {
      it('opens the conversation asking for the flight, as the Reserve button does', async () => {
        for (const text of ['reserve', 'Book a flight', 'I want to book a flight please']) {
          await say(alice, text);
          assert.match(alice.lastText, /^\*\*Reserve a flight for Test Air\.\*\*\nReply with the flight ID shown on the panel, for example `TST-001`\./, text);
          assert.deepEqual([session(alice)?.step, session(alice)?.purpose], ['await_code', 'reserve'], text);
        }
        await say(alice, 'TST-002');
        assert.deepEqual(holder('TST-002'), [alice.id], 'and the next message is the ID');
      });

      it('is just a message for someone who cannot reserve there', async () => {
        await say(alice, 'reserve', { guilds: [OTHER_GUILD] });
        assert.match(alice.lastText, hint);
        assert.equal(session(alice), null);
      });

      it('says there is nothing to reserve when no flight is open', async () => {
        h.jobs.sync(pid, []);
        await say(alice, 'reserve');
        assert.equal(alice.lastText, 'There are no open flights to reserve right now.');
      });

      it('asks for the ID with it when the person can use several airlines', async () => {
        const far = h.store.createPanel({ guildId: OTHER_GUILD, name: 'Far Air', abbr: 'FAR', prefix: 'FAR', channelId: '700000000000000050', now: T0 });
        h.jobs.sync(far.id, [sj('f1', 'EGLL-EGKK')]);
        await say(alice, 'reserve', { guilds: [GUILD, OTHER_GUILD] });
        assert.match(alice.lastText, /^You can use more than one airline here \(\*\*Test Air\*\*, \*\*Far Air\*\*\)\. Send the flight ID with it, like `reserve TST-001`\.$/);
        assert.equal(session(alice), null);
      });
    });

    describe('with a conversation already open', () => {
      it('sends a bare ID to that conversation, as it always has', async () => {
        await press(alice, `panel:reserve:${pid}`);
        assert.equal(session(alice)?.step, 'await_code');
        await say(alice, 'TST-002');
        assert.deepEqual(holder('TST-002'), [alice.id]);
      });

      it('lets a word that says what to do start something new', async () => {
        await press(alice, `panel:backup:${pid}`).catch(() => undefined);
        h.jobs.reserve(job('TST-001').job.id, [1], { discordId: bob.id, username: 'bob' });
        await press(alice, `panel:backup:${pid}`);
        assert.equal(session(alice)?.purpose, 'backup');
        await say(alice, 'reserve TST-002');
        assert.deepEqual(holder('TST-002'), [alice.id], 'a reservation, not a backup');
      });
    });
  });

  describe('standing by as backup', () => {
    beforeEach(() => {
      h.jobs.reserve(job('TST-001').job.id, [1], { discordId: bob.id, username: 'bob' }); // TST-001 is taken, so it can have a backup
    });
    const backupOf = (code: string) => job(code).backup?.discordId ?? null;

    it('puts the person down as backup from `backup <ID>`, with nothing else open', async () => {
      await say(alice, 'backup TST-001');
      assert.match(alice.lastText, /^🛟 You're down as backup for \*\*TST-001\*\* \(EGLL → EGKK\)\./);
      assert.equal(backupOf('TST-001'), alice.id);
      assert.equal(session(alice), null);
    });

    it('takes the other ways of saying it', async () => {
      await say(alice, 'Back up TST-001 please');
      assert.equal(backupOf('TST-001'), alice.id);
    });

    it('does not make a bare ID a backup: that is a reservation', async () => {
      await say(alice, 'TST-002');
      assert.deepEqual(holder('TST-002'), [alice.id]);
      assert.equal(backupOf('TST-001'), null);
    });

    it('explains a flight that cannot have a backup yet, and leaves the conversation open to try another', async () => {
      await say(alice, 'backup TST-002');
      assert.match(alice.lastText, /^TST-002 still has a leg nobody has, so you can reserve it instead of backing it up\./);
      assert.match(alice.lastText, /Send a different flight ID, or say `cancel`\./);
      assert.equal(session(alice)?.purpose, 'backup');
      assert.equal(backupOf('TST-002'), null);
      await say(alice, 'TST-001');
      assert.equal(backupOf('TST-001'), alice.id);
    });

    it('will not make you the backup of your own flight', async () => {
      await say(bob, 'backup TST-001');
      assert.match(bob.lastText, /^You are flying TST-001 yourself, so you can't also be its backup\./);
      assert.equal(backupOf('TST-001'), null);
    });

    it('stands by for one flight at a time', async () => {
      h.jobs.reserve(job('TST-002').job.id, [1], { discordId: bob.id, username: 'bob' });
      await say(alice, 'backup TST-001, TST-002');
      assert.equal(alice.lastText, 'You can stand by for one flight at a time. Send me the ID of just one, or say `cancel`.');
      assert.equal(backupOf('TST-001'), null);
    });

    it('has the same rules about who may as reserving does', async () => {
      h.store.updatePanel(pid, { requiredRoleId: ROLE });
      await say(alice, 'backup TST-001', { roleNames: { [ROLE]: 'Pilot' } });
      assert.match(alice.lastText, /^Standing by for flights of \*\*Test Air\*\* is limited to members with the \*\*Pilot\*\* role\.$/);
      await say(alice, 'backup TST-001', { guilds: [OTHER_GUILD] });
      assert.match(alice.lastText, hint);
      assert.equal(backupOf('TST-001'), null);
      await say(alice, 'backup TST-001', { roles: [ROLE] });
      assert.equal(backupOf('TST-001'), alice.id);
    });

    it('asks for the pilot ID first the first time, then does it', async () => {
      const carol = d.client.user(person('carol'));
      await say(carol, 'backup TST-001');
      assert.match(carol.lastText, /^\*\*Stand by as backup for Test Air\.\*\* First, what is your FsHub pilot ID\?/);
      assert.match(carol.lastText, /Then I'll carry on with `backup TST-001`\./);
      await say(carol, '4321');
      assert.match(carol.lastText, /You're down as backup for \*\*TST-001\*\*/);
      assert.equal(backupOf('TST-001'), carol.id);
    });

    it('with only the word, opens the backup conversation asking for the flight', async () => {
      await say(alice, 'backup');
      assert.match(alice.lastText, /^\*\*Stand by as backup for Test Air\.\*\*\nReply with the ID of the flight you'd fly if the pilot who has it can't, for example `TST-001`\./);
      assert.deepEqual([session(alice)?.purpose, session(alice)?.step], ['backup', 'await_code']);
      await say(alice, 'TST-001');
      assert.equal(backupOf('TST-001'), alice.id);
    });

    it('says when there is no flight the person could stand by for', async () => {
      await say(bob, 'backup'); // bob flies the only taken flight
      assert.match(bob.lastText, /^There's no flight for you to be backup for right now\./);
      assert.equal(session(bob), null);
    });
  });
});
