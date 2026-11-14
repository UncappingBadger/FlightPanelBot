import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commands } from '../src/discord/commands/index.js';
import { UserError } from '../src/discord/errors.js';
import { CHANNEL, GUILD, makeHarness, sj, type Harness } from './helpers.js';
import { fakeInteraction, makeDiscordHarness, messageText, settle, type DiscordHarness, type FakeInteractionOptions } from './discord-helpers.js';

const setup = commands.find((c) => c.data.name === 'setup')!;
const REFRESHERS = '600000000000000001';
const OTHER_ROLE = '600000000000000002';
const OTHER_GUILD = '900000000000000099';

describe('who may run /setup refresh', () => {
  let h: Harness;
  let d: DiscordHarness;
  const pid = () => h.panel.id;

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
    await d.panels.refresh(pid());
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const run = async (sub: string, o: FakeInteractionOptions = {}) => {
    const f = fakeInteraction({ sub, ...o });
    await setup.execute(d.ctx, f.i);
    await settle();
    return String(f.calls.edits.at(-1)?.content ?? '');
  };
  const admin = (sub: string, options: Record<string, unknown> = {}) => run(sub, { admin: true, options });
  const asMember = (sub: string, roles: string[], options: Record<string, unknown> = {}) => run(sub, { admin: false, roles, options });
  const refuses = (promise: Promise<unknown>, pattern = /Manage Server/) => assert.rejects(promise, (e: unknown) => e instanceof UserError && pattern.test(e.message));

  describe('designating roles', () => {
    it('adds a role, says what it lets them do, and what Discord needs besides', async () => {
      const text = await admin('refresh-roles', { role: { id: REFRESHERS } });
      assert.match(text, new RegExp(`Members with <@&${REFRESHERS}> can now refresh the panels`));
      assert.match(text, /\/setup refresh` and nothing else from `\/setup`/);
      assert.match(text, /Server Settings, Integrations/);
      assert.deepEqual(h.store.listRefreshRoles(GUILD), [REFRESHERS]);
    });

    it('shows the roles, or says there are none', async () => {
      assert.match(await admin('refresh-roles'), /No roles are set, so only admins/);
      await admin('refresh-roles', { role: { id: REFRESHERS } });
      await admin('refresh-roles', { role: { id: OTHER_ROLE }, mode: 'add' });
      const text = await admin('refresh-roles');
      assert.match(text, new RegExp(`<@&${REFRESHERS}>, <@&${OTHER_ROLE}>`));
    });

    it('says so when the role was already one, and keeps a single copy', async () => {
      await admin('refresh-roles', { role: { id: REFRESHERS } });
      assert.match(await admin('refresh-roles', { role: { id: REFRESHERS } }), /was already one of the roles/);
      assert.equal(h.store.listRefreshRoles(GUILD).length, 1);
    });

    it('removes one role, or clears them all', async () => {
      await admin('refresh-roles', { role: { id: REFRESHERS } });
      await admin('refresh-roles', { role: { id: OTHER_ROLE } });
      assert.match(await admin('refresh-roles', { role: { id: REFRESHERS }, mode: 'remove' }), new RegExp(`Removed <@&${REFRESHERS}>.*<@&${OTHER_ROLE}>`));
      assert.deepEqual(h.store.listRefreshRoles(GUILD), [OTHER_ROLE]);
      assert.match(await admin('refresh-roles', { role: { id: REFRESHERS }, mode: 'remove' }), /wasn't one of the roles/);
      assert.match(await admin('refresh-roles', { mode: 'clear' }), /Cleared 1 role/);
      assert.deepEqual(h.store.listRefreshRoles(GUILD), []);
      assert.match(await admin('refresh-roles', { mode: 'clear' }), /nothing to clear/);
    });

    it('needs a role to remove, and refuses a role beside clear', async () => {
      await assert.rejects(admin('refresh-roles', { mode: 'remove' }), /Say which role to remove/);
      await assert.rejects(admin('refresh-roles', { mode: 'clear', role: { id: REFRESHERS } }), /leave the `role` option out/);
    });

    it('refuses @everyone, which would let every member refresh, and more than ten roles', async () => {
      await assert.rejects(admin('refresh-roles', { role: { id: GUILD } }), /@everyone/);
      for (let i = 0; i < 10; i++) await admin('refresh-roles', { role: { id: `61000000000000000${i}` } });
      await assert.rejects(admin('refresh-roles', { role: { id: REFRESHERS } }), /10 roles is the most/);
      assert.equal(h.store.listRefreshRoles(GUILD).length, 10);
      assert.match(await admin('refresh-roles', { role: { id: '610000000000000003' } }), /already one of the roles/, 'a role already there is still fine at the limit');
    });

    it('is only for admins: a member with the role cannot change who has it', async () => {
      await admin('refresh-roles', { role: { id: REFRESHERS } });
      await refuses(asMember('refresh-roles', [REFRESHERS], { role: { id: OTHER_ROLE } }));
      await refuses(asMember('refresh-roles', [REFRESHERS], { mode: 'clear' }));
      assert.deepEqual(h.store.listRefreshRoles(GUILD), [REFRESHERS]);
    });

    it('is kept per server', async () => {
      h.store.addRefreshRole(OTHER_GUILD, REFRESHERS, h.clock.now);
      assert.deepEqual(h.store.listRefreshRoles(GUILD), []);
      await refuses(asMember('refresh', [REFRESHERS]), /Manage Server/);
    });
  });

  describe('using /setup refresh', () => {
    beforeEach(async () => {
      await admin('refresh-roles', { role: { id: REFRESHERS } });
    });

    it('lets a member with a designated role redraw the panel', async () => {
      const posted = d.client.channel(CHANNEL).live.map((m) => m.id);
      const text = await asMember('refresh', [REFRESHERS]);
      assert.match(text, /Redrew the \*\*Test Air\*\* panel/);
      const after = d.client.channel(CHANNEL).live;
      assert.equal(after.length, posted.length);
      assert.match(messageText(after[0]!), /TST-001/);
    });

    it('works with any one of several roles the member has', async () => {
      assert.match(await asMember('refresh', [OTHER_ROLE, REFRESHERS]), /Redrew/);
    });

    it('still works for admins who hold no such role', async () => {
      assert.match(await admin('refresh'), /Redrew/);
    });

    it('is refused to a member who has no designated role, with a pointer to how to get one', async () => {
      await refuses(asMember('refresh', []), /\/setup refresh-roles/);
      await refuses(asMember('refresh', [OTHER_ROLE]));
    });

    it('is refused again once the role is removed', async () => {
      await admin('refresh-roles', { role: { id: REFRESHERS }, mode: 'remove' });
      await refuses(asMember('refresh', [REFRESHERS]));
    });

    it('is the only thing such a member can do: every other /setup subcommand is refused, and changes nothing', async () => {
      const others = ['panel-add', 'panel-role', 'panel-remove', 'panels', 'import', 'sheet', 'reminders', 'window', 'writeback', 'market', 'fshub', 'completed', 'refresh-roles', 'release', 'template'];
      const before = JSON.stringify(h.store.getPanel(pid()));
      for (const sub of others) {
        await assert.rejects(
          asMember(sub, [REFRESHERS], { airline: 'Test Air', channel: { id: CHANNEL }, code: 'TST-001', role: { id: OTHER_ROLE }, days: 3 }),
          (e: unknown) => e instanceof UserError && /^Only server admins \(with the \*\*Manage Server\*\* permission\) can do that\.$/.test(e.message),
          sub,
        );
      }
      assert.equal(JSON.stringify(h.store.getPanel(pid())), before);
      assert.deepEqual(h.store.listRefreshRoles(GUILD), [REFRESHERS]);
    });

    it('is refused outside a server', async () => {
      await assert.rejects(run('refresh', { guildId: null, roles: [REFRESHERS] }), /inside a server/);
    });
  });

  it('has the setting in a table the database upgrade creates', () => {
    assert.equal(h.store.addRefreshRole(GUILD, REFRESHERS, h.clock.now), true);
    assert.equal(h.store.addRefreshRole(GUILD, REFRESHERS, h.clock.now), false);
    assert.equal(h.store.removeRefreshRole(GUILD, REFRESHERS), true);
    assert.equal(h.store.removeRefreshRole(GUILD, REFRESHERS), false);
  });
});
