import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commandsCommand } from '../src/discord/commands/commands.js';
import { commandsMessages, COMMANDS_REQUEST, slashCommands, standingIn, type ServerStanding, type SlashCommandInfo } from '../src/discord/commandsList.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { GUILD, makeHarness, sj, T0, type Harness } from './helpers.js';
import { fakeDm, fakeInteraction, FakeUser, makeDiscordHarness, settle, type DiscordHarness, type FakeDmOptions } from './discord-helpers.js';

const ROLE = '555555555555555555';
const OTHER_GUILD = '900000000000000099';
let nextUser = 700000000000000000n;
/** A new person every time, so nothing one test leaves behind (a message cooldown, say) can reach another. */
const person = (name: string): FakeUser => new FakeUser(String(++nextUser), name);

const member = (over: Partial<ServerStanding> = {}): ServerStanding => ({ name: 'Test Server', admin: false, manager: false, airlines: [{ name: 'Test Air', canBook: true, limited: false, roleName: null }], ...over });
const all = (texts: string[]): string => texts.join('\n');

describe('asking for the commands', () => {
  describe('what counts as asking', () => {
    it('is `commands` or `help`, with or without a slash, in any case', () => {
      for (const ok of ['commands', '/commands', 'Commands?', 'command', 'list commands', 'show my commands', 'show all commands', 'help', 'HELP!', '/help']) assert.ok(COMMANDS_REQUEST.test(ok), ok);
    });
    it('is not anything else', () => {
      for (const no of ['commands for reserving', 'help me please', 'metar EGLL', 'my contributions', 'flights', 'what are the commands for admins', 'help 2', '']) assert.ok(!COMMANDS_REQUEST.test(no), no);
    });
  });

  describe('the bot\'s own slash commands, read from the commands themselves', () => {
    let slash: SlashCommandInfo[];
    beforeEach(async () => {
      slash = await slashCommands();
    });
    it('knows which are for everyone and which are for admins', () => {
      assert.deepEqual(slash.filter((c) => !c.adminOnly).map((c) => c.name).sort(), ['commands', 'eta', 'fuel', 'help', 'hideunavailable']);
      assert.deepEqual(slash.filter((c) => c.adminOnly).map((c) => c.name), ['setup']);
    });
    it('knows the parts of /setup, with what each does', () => {
      const names = slash.find((c) => c.name === 'setup')!.subs.map((s) => s.name);
      for (const n of ['panel-add', 'weather', 'refresh', 'id-add', 'refresh-roles', 'release']) assert.ok(names.includes(n), n);
      assert.ok(slash.find((c) => c.name === 'setup')!.subs.every((s) => s.description.length > 0));
    });
  });

  describe('the list itself', () => {
    let slash: SlashCommandInfo[];
    beforeEach(async () => {
      slash = await slashCommands();
    });

    it('gives a member what a DM understands, the commands anyone can use in a server, and the airlines they may reserve for', () => {
      const t = all(commandsMessages([member()], slash, { where: 'dm' }));
      for (const word of ['`reserve <flight ID>`', '`backup <flight ID>`', '`flights`', '`my contributions`', '`metar EGLL`', '`notifications`', '`name <your name>`', '`fshub <your ID>`', '`/banking`', '`/monitor <flight number>`', '`cancel`', '`commands`']) {
        assert.ok(t.includes(word), word);
      }
      for (const word of ['`/help`', '`/fuel`', '`/eta`', '`/hideunavailable`', '`/commands`']) assert.ok(t.includes(word), word);
      assert.match(t, /• \*\*Test Server\*\*: you are a member\. You can reserve and back up flights for \*\*Test Air\*\*\./);
      assert.ok(!t.includes('/setup'), 'nothing of /setup for a member');
    });

    it('gives a server admin every /setup command, and says so', () => {
      const texts = commandsMessages([member({ admin: true })], slash, { where: 'dm' });
      const t = all(texts);
      assert.match(t, /you are a server admin \(you have Manage Server\)/);
      for (const s of slash.find((c) => c.name === 'setup')!.subs) assert.ok(t.includes(`\`/setup ${s.name}\``), s.name);
      assert.match(t, /\*\*Server admin: `\/setup`\*\* \(Test Server\)/);
      assert.ok(texts.length > 1, 'it takes more than one message');
    });

    it('gives a manager (a role the admins chose) only the two commands that role can run', () => {
      const t = all(commandsMessages([member({ manager: true })], slash, { where: 'dm' }));
      assert.match(t, /you are a manager \(you can run `\/setup refresh` and `\/setup id-add`\)/);
      assert.ok(t.includes('`/setup refresh`') && t.includes('`/setup id-add`'));
      assert.ok(!t.includes('`/setup panel-add`') && !t.includes('`/setup weather`'));
      assert.match(t, /\*\*Manager\*\* \(a role your admins chose\) in Test Server/);
    });

    it('names the role an airline is limited to, when the person lacks it', () => {
      const t = all(commandsMessages([member({ airlines: [{ name: 'Test Air', canBook: true, limited: false, roleName: null }, { name: 'Far Air', canBook: false, limited: true, roleName: 'Pilot' }] })], slash, { where: 'dm' }));
      assert.match(t, /You can reserve and back up flights for \*\*Test Air\*\*\. Reserving for \*\*Far Air\*\* is limited to the \*\*Pilot\*\* role, which you don't have\./);
      const noName = all(commandsMessages([member({ airlines: [{ name: 'Far Air', canBook: false, limited: true, roleName: null }] })], slash, { where: 'dm' }));
      assert.match(noName, /Reserving for \*\*Far Air\*\* is limited to a role, which you don't have\./);
      assert.ok(!noName.includes('You can reserve and back up'));
    });

    it('says when a server has no panel yet', () => {
      assert.match(all(commandsMessages([member({ airlines: [] })], slash, { where: 'dm' })), /you are a member\. No airline has a panel here yet\./);
    });

    it('says what to do with several servers, and names the ones the person is an admin in', () => {
      const t = all(commandsMessages([member({ name: 'Alpha', admin: true }), member({ name: 'Beta' })], slash, { where: 'dm' }));
      assert.match(t, /• \*\*Alpha\*\*: you are a server admin/);
      assert.match(t, /• \*\*Beta\*\*: you are a member/);
      assert.match(t, /\*\*Server admin: `\/setup`\*\* \(Alpha\)/);
      assert.ok(!/\(Alpha, Beta\)/.test(t));
    });

    it('says plainly when the person shares no server with the bot, and that a DM still does some things', () => {
      const t = all(commandsMessages([], slash, { where: 'dm' }));
      assert.match(t, /I don't share a server with you, so there is nothing to reserve or set up\. The weather, `\/banking` and `\/monitor` still work in a DM\./);
      assert.ok(t.includes('`metar EGLL`'));
    });

    it('says when a server could not be checked', () => {
      assert.match(all(commandsMessages([member()], slash, { where: 'dm', unsure: 1 })), /I couldn't check one server just now, so it is not above\. Ask again in a minute\./);
      assert.match(all(commandsMessages([member()], slash, { where: 'dm', unsure: 3 })), /I couldn't check 3 servers just now, so they are not above\./);
    });

    it('is worded for the server when it is asked there', () => {
      const t = all(commandsMessages([member({ admin: true })], slash, { where: 'server' }));
      assert.match(t, /\*\*This server\*\*\nYou are a server admin/);
      assert.match(t, /\*\*Server admin: `\/setup`\*\*\n/, 'no list of servers to name');
    });

    it('keeps every message inside what Discord allows, and never cuts a line, however long a list is', () => {
      const long: SlashCommandInfo[] = [
        ...slash,
        { name: 'big', description: 'many', adminOnly: true, subs: Array.from({ length: 60 }, (_, i) => ({ name: `part-${i}`, description: `does a thing, number ${i}, with a fairly long explanation of it so the list grows and grows` })) },
      ];
      const texts = commandsMessages([member({ admin: true })], long, { where: 'dm' });
      for (const text of texts) assert.ok(text.length <= 2000, `${text.length} characters`);
      const t = all(texts);
      for (let i = 0; i < 60; i++) assert.ok(t.includes(`• \`/big part-${i}\`: does a thing, number ${i}, with a fairly long explanation of it so the list grows and grows`), `part-${i} is whole`);
      assert.match(t, /\*\*Server admin: `\/big`\*\* \(Test Server\) \(continued\)/);
    });

    it('works out someone\'s standing in a server: an admin counts as holding every role', () => {
      const h = { store: { listPanels: () => [{ airlineName: 'A', requiredRoleId: ROLE }, { airlineName: 'B', requiredRoleId: null }], listRefreshRoles: () => ['r1'] } } as never;
      const standing = (admin: boolean, roles: string[]) => standingIn(h, 'g', 'S', admin, (id) => roles.includes(id), (id) => (id === ROLE ? 'Pilot' : null));
      assert.deepEqual(standing(false, []).airlines.map((a) => a.canBook), [false, true]);
      assert.deepEqual(standing(false, [ROLE]).airlines.map((a) => a.canBook), [true, true]);
      assert.deepEqual(standing(true, []).airlines.map((a) => a.canBook), [true, true]);
      assert.equal(standing(false, []).airlines[0]!.roleName, 'Pilot');
      assert.deepEqual([standing(false, ['r1']).manager, standing(true, ['r1']).manager, standing(false, []).manager], [true, false, false], 'an admin is not also listed as a manager');
    });
  });

  describe('in a DM', () => {
    let h: Harness;
    let d: DiscordHarness;
    beforeEach(async () => {
      h = await makeHarness();
      d = makeDiscordHarness(h);
    });
    afterEach(async () => {
      await settle(40);
      await h.close();
    });
    const ask = async (text: string, o: FakeDmOptions = {}, who: FakeUser = person('pilot')) => {
      await handleDmMessage(d.ctx, fakeDm(who, text, o));
      return who;
    };
    const said = (u: FakeUser) => u.dms.map((m) => String(m.content)).join('\n');

    it('answers a member in the DM, with their server and what they can reserve, and nothing for admins', async () => {
      const u = await ask('commands');
      const t = said(u);
      assert.match(t, /\*\*What you can do with me\*\*/);
      assert.match(t, /• \*\*Test Server\*\*: you are a member\. You can reserve and back up flights for \*\*Test Air\*\*\./);
      assert.ok(!t.includes('/setup panel-add'));
      assert.ok(u.dms.every((m) => JSON.stringify(m.allowedMentions) === JSON.stringify({ parse: [] })));
    });

    it('is also answered to `help`, `/commands` and `list commands`', async () => {
      for (const text of ['help', '/commands', 'list commands']) assert.match(said(await ask(text)), /What you can do with me/, text);
    });

    it('lists every /setup command for a server admin', async () => {
      const u = await ask('commands', { admin: true });
      const t = said(u);
      assert.match(t, /you are a server admin \(you have Manage Server\)/);
      for (const s of (await slashCommands()).find((c) => c.name === 'setup')!.subs) assert.ok(t.includes(`\`/setup ${s.name}\``), s.name);
      assert.ok(u.dms.length > 1);
      assert.ok(u.dms.every((m) => String(m.content).length <= 2000));
    });

    it('lists just refresh and id-add for someone who holds a role the admins chose', async () => {
      h.store.addRefreshRole(GUILD, ROLE, T0);
      const t = said(await ask('commands', { roles: [ROLE] }));
      assert.match(t, /you are a manager/);
      assert.ok(t.includes('`/setup refresh`') && t.includes('`/setup id-add`'));
      assert.ok(!t.includes('`/setup panel-add`'));
      assert.ok(!said(await ask('commands', { roles: ['999'] })).includes('you are a manager'), 'a different role is no use');
    });

    it('says which airline is limited to a role the person lacks, naming the role', async () => {
      h.store.updatePanel(h.panel.id, { requiredRoleId: ROLE });
      const t = said(await ask('commands', { roleNames: { [ROLE]: 'Pilot' } }));
      assert.match(t, /Reserving for \*\*Test Air\*\* is limited to the \*\*Pilot\*\* role, which you don't have\./);
      assert.ok(!t.includes('You can reserve and back up'));
      assert.match(said(await ask('commands', { roles: [ROLE], roleNames: { [ROLE]: 'Pilot' } })), /You can reserve and back up flights for \*\*Test Air\*\*\./);
    });

    it('says so for someone who is in none of the bot\'s servers', async () => {
      const t = said(await ask('commands', { guilds: [] }));
      assert.match(t, /I don't share a server with you/);
      assert.ok(t.includes('`metar EGLL`'), 'what a DM does for anyone is still listed');
    });

    it('lists each of several servers', async () => {
      const far = h.store.createPanel({ guildId: OTHER_GUILD, name: 'Far Air', abbr: 'FAR', prefix: 'FAR', channelId: '700000000000000050', now: T0 });
      h.jobs.sync(far.id, [sj('f', 'EGLL-EGKK')]);
      const t = said(await ask('commands', { guilds: [GUILD, OTHER_GUILD] }));
      assert.match(t, /• \*\*Test Server\*\*: you are a member\. You can reserve and back up flights for \*\*Test Air\*\*\./);
      assert.match(t, new RegExp(`• \\*\\*Server ${OTHER_GUILD}\\*\\*: you are a member\\. You can reserve and back up flights for \\*\\*Far Air\\*\\*\\.`));
    });

    it('only the servers the person is in: another server\'s airline is not shown', async () => {
      h.store.createPanel({ guildId: OTHER_GUILD, name: 'Far Air', abbr: 'FAR', prefix: 'FAR', channelId: '700000000000000050', now: T0 });
      const t = said(await ask('commands', { botGuilds: [GUILD, OTHER_GUILD], guilds: [GUILD] }));
      assert.ok(!t.includes('Far Air'));
    });

    it('says it could not check, rather than leaving a server out without a word', async () => {
      const t = said(await ask('commands', { memberError: Object.assign(new Error('Discord is busy'), { code: 500 }) }));
      assert.match(t, /I couldn't check one server just now, so it is not above\./);
    });

    it('leaves an open conversation alone', async () => {
      const u = person('mid');
      h.jobs.sync(h.panel.id, [sj('s1', 'EGLL-EGKK')]);
      h.store.upsertSession({ discordId: u.id, panelId: h.panel.id, step: 'await_code', expiresAt: h.clock.now + 600_000 });
      await ask('commands', {}, u);
      assert.match(said(u), /What you can do with me/);
      assert.equal(h.store.getSession(u.id, h.clock.now)?.step, 'await_code');
      assert.equal(h.store.getSession(u.id, h.clock.now)?.attempts, 0, 'and it was not counted as a wrong flight ID');
    });

    it('asked again straight away, says nothing new; asked after a few seconds, answers', async () => {
      const u = await ask('commands');
      const first = u.dms.length;
      await ask('commands', {}, u);
      assert.equal(u.dms.length, first);
      h.clock.advance(6000);
      await ask('commands', {}, u);
      assert.equal(u.dms.length, first * 2);
    });

    it('is mentioned in the pointer people get when they message the bot out of the blue', async () => {
      const u = await ask('hello there');
      assert.match(u.lastText, /Send me `commands` for everything I can do\.$/);
    });
  });

  describe('as /commands in a server', () => {
    let h: Harness;
    let d: DiscordHarness;
    beforeEach(async () => {
      h = await makeHarness();
      d = makeDiscordHarness(h);
    });
    afterEach(async () => {
      await settle(40);
      await h.close();
    });
    const guild = (roleNames: Record<string, string> = {}) => ({ name: 'Test Server', roles: { cache: new Map(Object.entries(roleNames).map(([id, name]) => [id, { name }])) } });

    it('is registered for servers only, for everyone', () => {
      const json = commandsCommand.data.toJSON();
      assert.equal(json.name, 'commands');
      assert.deepEqual(json.contexts, [0]);
      assert.equal(json.default_member_permissions ?? null, null);
    });

    it('answers only the person who asked, for a member', async () => {
      const f = fakeInteraction({ guild: guild() });
      await commandsCommand.execute(d.ctx, f.i);
      assert.deepEqual(f.calls.defers, [{ flags: 64 }]);
      const text = String(f.calls.edits[0].content);
      assert.match(text, /\*\*What you can do with me\*\*/);
      assert.match(text, /\*\*This server\*\*\nYou are a member\. You can reserve and back up flights for \*\*Test Air\*\*\./);
      assert.ok(!text.includes('/setup panel-add'));
      assert.deepEqual(f.calls.edits[0].allowedMentions, { parse: [] });
    });

    it('gives an admin every /setup command, across ephemeral messages', async () => {
      const f = fakeInteraction({ admin: true, guild: guild() });
      await commandsCommand.execute(d.ctx, f.i);
      const texts = [String(f.calls.edits[0].content), ...f.calls.followUps.map((m) => String(m.content))];
      assert.ok(f.calls.followUps.length >= 1);
      assert.ok(f.calls.followUps.every((m) => m.flags === 64), 'each one private');
      assert.ok(texts.every((t) => t.length <= 2000));
      for (const s of (await slashCommands()).find((c) => c.name === 'setup')!.subs) assert.ok(all(texts).includes(`\`/setup ${s.name}\``), s.name);
    });

    it('gives a manager just refresh and id-add, and names the role an airline needs', async () => {
      h.store.addRefreshRole(GUILD, ROLE, T0);
      h.store.updatePanel(h.panel.id, { requiredRoleId: '777777777777777777' });
      const f = fakeInteraction({ roles: [ROLE], guild: guild({ '777777777777777777': 'Crew' }) });
      await commandsCommand.execute(d.ctx, f.i);
      const text = all([String(f.calls.edits[0].content), ...f.calls.followUps.map((m) => String(m.content))]);
      assert.match(text, /You are a manager/);
      assert.match(text, /Reserving for \*\*Test Air\*\* is limited to the \*\*Crew\*\* role, which you don't have\./);
      assert.ok(text.includes('`/setup refresh`') && !text.includes('`/setup panel-add`'));
    });
  });
});
