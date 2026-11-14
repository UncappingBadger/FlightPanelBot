import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commands } from '../src/discord/commands/index.js';
import { UserError } from '../src/discord/errors.js';
import { CHANNEL, makeHarness, sj, USER_A, type Harness } from './helpers.js';
import { fakeInteraction, FakeUser, makeDiscordHarness, messageText, settle, type DiscordHarness, type FakeInteractionOptions } from './discord-helpers.js';

const setup = commands.find((c) => c.data.name === 'setup')!;
const MANAGER = '555555555555555555';
const MANAGER_ROLE = '600000000000000007';
const OTHER_ROLE = '600000000000000008';
const OTHER_PILOT = '777777777777777777';

describe('/setup id-add', () => {
  let h: Harness;
  let d: DiscordHarness;
  let pilot: FakeUser;
  const pid = () => h.panel.id;

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h, { fshub: true });
    d.fshub!.pilots.set(1234, { id: 1234, name: 'Alex Smith', base: null, country: null });
    d.fshub!.pilots.set(5678, { id: 5678, name: 'Sam Jones', base: null, country: null });
    pilot = d.client.user(new FakeUser('444444444444444444', 'alex'));
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const run = async (options: Record<string, unknown>, o: FakeInteractionOptions = {}) => {
    const f = fakeInteraction({ sub: 'id-add', userId: MANAGER, admin: true, options, ...o });
    await setup.execute(d.ctx, f.i);
    await settle();
    return String(f.calls.edits.at(-1)?.content ?? '');
  };
  const add = (id: string, user: FakeUser = pilot) => run({ user, id });

  describe('setting an ID', () => {
    it("saves the pilot's ID with the name FsHub has for it, and tells the manager what changed", async () => {
      const text = await add('1234');
      assert.match(text, /<@444444444444444444>'s FsHub pilot ID is now \*\*1234\*\* \(Alex Smith on FsHub\)/);
      assert.match(text, /They had no ID saved/);
      assert.deepEqual(h.store.getPilotLink(pilot.id), { fshubId: 1234, name: 'Alex Smith', source: 'typed' });
    });

    it('replaces a wrong one, saying what it was', async () => {
      h.store.setPilotId(pilot.id, 9999, h.clock.now);
      const text = await add('1234');
      assert.match(text, /Before: \*\*9999\*\*\./);
      assert.equal(h.store.getPilotId(pilot.id), 1234);
    });

    it("says when the old ID came from the airline's FsHub roster, and keeps the manager's choice against later roster reads", async () => {
      h.store.applyRosterLinks([{ discordId: pilot.id, fshubId: 5678, name: 'Sam Jones' }], h.clock.now);
      const text = await add('1234');
      assert.match(text, /Before: \*\*5678\*\* \(Sam Jones on FsHub\) \(from the airline's FsHub roster\)/);
      h.store.applyRosterLinks([{ discordId: pilot.id, fshubId: 5678, name: 'Sam Jones' }], h.clock.now + 1);
      assert.equal(h.store.getPilotId(pilot.id), 1234, 'what a manager set is not replaced by the roster');
    });

    it('takes a link to the pilot\'s FsHub profile as well as the number', async () => {
      await add('https://fshub.io/pilot/1234/overview');
      assert.equal(h.store.getPilotId(pilot.id), 1234);
      await add('#5678');
      assert.equal(h.store.getPilotId(pilot.id), 5678);
    });

    it('tells the pilot in a DM who changed it, and how to correct it', async () => {
      const text = await add('1234');
      assert.match(text, /I've told them in a DM/);
      assert.equal(pilot.dms.length, 1);
      assert.match(pilot.lastText, new RegExp(`A manager \\(<@${MANAGER}>\\) set your FsHub pilot ID to \\*\\*1234\\*\\* \\(Alex Smith on FsHub\\)`));
      assert.match(pilot.lastText, /`fshub <your ID>`/);
    });

    it('still saves it, and says so, when the pilot has DMs closed', async () => {
      pilot.failDms = true;
      const text = await add('1234');
      assert.match(text, /Their DMs are closed, so I couldn't tell them/);
      assert.equal(h.store.getPilotId(pilot.id), 1234);
    });

    it('redraws the panels where the pilot holds a flight, so the new ID shows at once', async () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], { discordId: pilot.id, username: 'alex' });
      await d.panels.refresh(pid());
      assert.doesNotMatch(messageText(d.client.channel(CHANNEL).live[0]!), /FsHub #1234/);
      await add('1234');
      await settle();
      assert.match(messageText(d.client.channel(CHANNEL).live[0]!), /FsHub #1234 \(Alex Smith\)/);
    });
  });

  describe('what it refuses', () => {
    it('something that is not an ID or a profile link', async () => {
      await assert.rejects(add('not an id'), (e: unknown) => e instanceof UserError && /couldn't read that as a FsHub pilot ID/.test(e.message));
      await assert.rejects(add('0'), /couldn't read that/);
      assert.equal(h.store.getPilotLink(pilot.id), null);
    });

    it('an ID FsHub has no pilot for (a typo), changing nothing', async () => {
      h.store.setPilotId(pilot.id, 9999, h.clock.now);
      await assert.rejects(add('4321'), /FsHub has no pilot with the ID \*\*4321\*\*.*I haven't changed anything/);
      assert.equal(h.store.getPilotId(pilot.id), 9999);
      assert.equal(pilot.dms.length, 0, 'the pilot is not told about a change that did not happen');
    });

    it("an ID the airline's FsHub roster gives to another Discord account, since flights could not be completed with it", async () => {
      h.store.applyRosterLinks([{ discordId: OTHER_PILOT, fshubId: 1234, name: 'Alex Smith' }], h.clock.now);
      await assert.rejects(add('1234'), (e: unknown) => e instanceof UserError && new RegExp(`lists pilot \\*\\*1234\\*\\* as <@${OTHER_PILOT}>`).test(e.message));
      assert.equal(h.store.getPilotLink(pilot.id), null);
    });

    it('a bot', async () => {
      const bot = new FakeUser('888888888888888888', 'somebot', true);
      await assert.rejects(add('1234', bot), /That's a bot/);
    });

    it('being used outside a server', async () => {
      await assert.rejects(run({ user: pilot, id: '1234' }, { guildId: null }), /inside a server/);
    });
  });

  describe('when FsHub cannot be asked', () => {
    it('saves the ID as given and says it was not checked (no FsHub token)', async () => {
      d.ctx.fshub = null;
      const text = await add('4321');
      assert.match(text, /I couldn't check it with FsHub/);
      assert.deepEqual(h.store.getPilotLink(pilot.id), { fshubId: 4321, name: null, source: 'typed' });
    });

    it('does the same when FsHub is down', async () => {
      d.fshub!.error = new Error('down');
      const text = await add('1234');
      assert.match(text, /I couldn't check it with FsHub/);
      assert.equal(h.store.getPilotId(pilot.id), 1234);
    });
  });

  describe('who may use it', () => {
    it('admins, always', async () => {
      assert.match(await add('1234'), /is now/);
    });

    it('members with a role an admin chose with /setup refresh-roles, the same ones that can run /setup refresh', async () => {
      h.store.addRefreshRole(h.panel.guildId, MANAGER_ROLE, h.clock.now);
      assert.match(await run({ user: pilot, id: '1234' }, { admin: false, roles: [MANAGER_ROLE] }), /is now/);
      assert.equal(h.store.getPilotId(pilot.id), 1234);
    });

    it('nobody else: not a member with no role, nor one with some other role', async () => {
      h.store.addRefreshRole(h.panel.guildId, MANAGER_ROLE, h.clock.now);
      for (const roles of [[], [OTHER_ROLE]]) {
        await assert.rejects(
          run({ user: pilot, id: '1234' }, { admin: false, roles }),
          (e: unknown) => e instanceof UserError && /Manage Server.*\/setup refresh-roles/.test(e.message),
        );
      }
      assert.equal(h.store.getPilotLink(pilot.id), null);
      assert.equal(pilot.dms.length, 0);
    });

    it('does not give such a role anything else: every other /setup subcommand is still refused', async () => {
      h.store.addRefreshRole(h.panel.guildId, MANAGER_ROLE, h.clock.now);
      for (const sub of ['panel-add', 'panel-role', 'panel-remove', 'panels', 'import', 'sheet', 'reminders', 'window', 'writeback', 'market', 'fshub', 'completed', 'refresh-roles', 'release', 'template']) {
        await assert.rejects(
          run({ airline: 'Test Air', channel: { id: CHANNEL }, code: 'TST-001', role: { id: OTHER_ROLE }, days: 3 }, { sub, admin: false, roles: [MANAGER_ROLE] }),
          (e: unknown) => e instanceof UserError && /^Only server admins \(with the \*\*Manage Server\*\* permission\) can do that\.$/.test(e.message),
          sub,
        );
      }
    });

    it('works for a pilot who already has an ID (to fix it), without changing anyone else', async () => {
      h.store.setPilotId(USER_A.discordId, 9999, h.clock.now);
      const other = h.store.getPilotId('222222222222222222');
      await add('1234', d.client.user(new FakeUser(USER_A.discordId, USER_A.username)));
      assert.equal(h.store.getPilotId(USER_A.discordId), 1234);
      assert.equal(h.store.getPilotId('222222222222222222'), other);
    });
  });
});
