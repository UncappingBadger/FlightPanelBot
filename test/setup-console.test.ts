import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Guild } from 'discord.js';
import type { BotHandle } from '../src/bot.js';
import { commands } from '../src/discord/commands/index.js';
import { setupCommand } from '../src/discord/commands/setup.js';
import { SETTINGS_POINTER } from '../src/discord/commands/setupSlim.js';
import { boxWords, SetupConsole, setupTabs, type TabDef } from '../src/discord/setupConsole.js';
import { hostPaths, type HostPaths } from '../src/host/paths.js';
import { loadSettings, saveSettings } from '../src/host/settings.js';
import { Supervisor } from '../src/host/supervisor.js';
import { UpdateChecker } from '../src/host/updates.js';
import { startWebServer, type WebServer } from '../src/host/web.js';
import { AirlineSettings } from '../src/services/airlineSettings.js';
import { silentLogger } from '../src/util/log.js';
import { CHANNEL, GUILD, HOUR, T0, makeHarness, type Harness } from './helpers.js';
import { fakeInteraction, FakeUser, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

const OWNER = '444444444444444444';
const PILOT = '777777777777777777';
const CH_COMPLETED = '700000000000000002';
const CH_GENERAL = '700000000000000003';
const ROLE_PILOTS = '500000000000000001';
const ROLE_STAFF = '500000000000000002';
const OTHER_GUILD = '900000000000000099';
const BOT_ID = '1234567890123456789';
const TOKEN = `${Buffer.from(BOT_ID).toString('base64')}.Gabc12.${'x'.repeat(27)}`;
const KEY = 'test-key-1234567890';

const chan = (id: string, name: string, position: number, type = 0) => ({ id, name, type, rawPosition: position, permissionsFor: () => ({ has: () => true }) });
const role = (id: string, name: string, position: number, managed = false) => ({ id, name, position, managed });

/** A server as the bot sees it: a few channels and roles, an owner, and the bot's own member. */
function fakeGuild() {
  const channels = new Map<string, any>([
    [CHANNEL, chan(CHANNEL, 'flights', 0)],
    [CH_COMPLETED, chan(CH_COMPLETED, 'completed', 1)],
    [CH_GENERAL, chan(CH_GENERAL, 'general', 2)],
    ['700000000000000009', chan('700000000000000009', 'voice-room', 3, 2)],
  ]);
  const roles = new Map<string, any>([
    [GUILD, role(GUILD, '@everyone', 0)],
    [ROLE_PILOTS, role(ROLE_PILOTS, 'Pilots', 2)],
    [ROLE_STAFF, role(ROLE_STAFF, 'Staff', 3)],
    ['500000000000000009', role('500000000000000009', 'Some Bot', 4, true)],
  ]);
  return {
    id: GUILD,
    name: 'Test Server',
    ownerId: OWNER,
    channels: { cache: channels, fetch: async (id: string) => channels.get(id) ?? null },
    roles: { cache: roles, everyone: roles.get(GUILD), fetch: async (id: string) => roles.get(id) ?? null },
    members: { me: {}, fetchMe: async () => ({}) },
  };
}

const CSV = 'id,legs,aircraft\nA1,EGLL-EGKK,A20N\nA2,EGLL-EGCC,A320\n';

describe('the settings page tabs (the /setup commands, one tab each)', () => {
  let h: Harness;
  let d: DiscordHarness;
  let sc: SetupConsole;
  let owner: FakeUser;
  let pilot: FakeUser;
  const pid = () => h.panel.id;

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = T0;
    d = makeDiscordHarness(h, { fshub: true });
    d.fshub!.pilots.set(1234, { id: 1234, name: 'Alex Smith', base: null, country: null });
    owner = d.client.user(new FakeUser(OWNER, 'owner'));
    pilot = d.client.user(new FakeUser(PILOT, 'alex'));
    const guild = fakeGuild();
    sc = new SetupConsole({
      ctx: d.ctx,
      discord: {
        guilds: () => [{ id: GUILD, name: 'Test Server' }],
        guild: async (id) => (id === GUILD ? (guild as unknown as Guild) : null),
        user: async (id) => (d.client.users_.get(id) as never) ?? null,
      },
    });
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const run = (tab: string, values: Record<string, unknown> = {}, extra: { panel?: number | null; guild?: string; status?: boolean } = {}) => sc.run({ tab, guild: extra.guild ?? GUILD, panel: extra.panel === undefined ? pid() : extra.panel, values, ...(extra.status ? { status: true } : {}) });

  describe('the tabs', () => {
    const tabs = setupTabs();
    const full = (setupCommand.data.toJSON().options ?? []).filter((o) => o.type === 1).map((o) => o.name);

    it('are one for every /setup subcommand (24 of them), in the order the page lists them, so none is left off', () => {
      assert.equal(full.length, 24);
      assert.deepEqual([...tabs.map((t) => t.id)].sort(), [...full].sort());
      assert.equal(new Set(tabs.map((t) => t.label)).size, 24, 'each has a name of its own');
    });

    it('are grouped, and each says what it applies to: one airline, or the server', () => {
      assert.deepEqual([...new Set(tabs.map((t) => t.group))], ['Panels', 'Flights', 'Pilots and FsHub', 'Pay and safety', 'Server boards']);
      const server = tabs.filter((t) => t.scope === 'server').map((t) => t.id).sort();
      assert.deepEqual(server, ['id-add', 'market', 'panel-add', 'panels', 'refresh-roles', 'template', 'weather']);
    });

    it('make their boxes from the command\'s own options, with its choices and limits, and leave the airline to the top of the page', () => {
      const by = (id: string): TabDef => tabs.find((t) => t.id === id)!;
      assert.deepEqual(by('panel-add').fields.map((f) => [f.name, f.kind, f.required]), [['airline', 'text', true], ['channel', 'channel', true], ['prefix', 'text', false], ['role', 'role', false]]);
      assert.equal(by('panel-add').fields[0]!.maxLength, 60);
      assert.deepEqual(by('window').fields.map((f) => [f.name, f.kind, f.min, f.max]), [['days', 'number', 1, 7]]);
      assert.deepEqual(by('layout').fields.find((f) => f.name === 'mode')!.choices!.map((c) => c.value), ['cards', 'grid']);
      assert.deepEqual(by('import').fields.map((f) => [f.name, f.kind]), [['file', 'file']]);
      assert.deepEqual(by('id-add').fields.map((f) => [f.name, f.kind]), [['user', 'user'], ['id', 'text']]);
      assert.equal(by('sheet').fields.some((f) => f.name === 'airline'), false, 'the airline is picked at the top');
      assert.equal(by('safety-pay').custom, 'safety');
      assert.deepEqual(by('safety-pay').fields, [], 'landing safety has a page of its own');
    });

    it('ask for confirmation before something that cannot be undone', () => {
      assert.deepEqual(tabs.filter((t) => t.confirm).map((t) => t.id), ['panel-remove', 'import', 'release']);
    });
  });

  describe('wording that cannot be misread', () => {
    const tabs = setupTabs();
    const by = (id: string): TabDef => tabs.find((t) => t.id === id)!;
    const field = (tab: string, name: string) => by(tab).fields.find((f) => f.name === name)!;

    it('says what an empty box means for every box that is not needed, and nothing for one that is', () => {
      for (const t of tabs) {
        for (const f of t.fields) {
          if (f.required) assert.equal(f.blank, '', `${t.id}.${f.name} is needed, so it has no empty meaning`);
          else assert.ok(f.blank.length > 0, `${t.id}.${f.name} must say what empty means`);
        }
      }
    });

    it('does not call an empty box "no change" where empty changes something', () => {
      assert.match(field('panel-role', 'role').blank, /Everyone/, 'an empty role on "Who can reserve" opens the panel to everyone');
      assert.match(by('panel-role').intro, /opens the panel to everyone/);
      assert.match(field('panel-add', 'role').blank, /Anyone .* existing panel keeps/);
      assert.match(field('release', 'leg').blank, /every leg/);
      assert.match(field('profit', 'action').blank, /Check: read and report only, change nothing/);
      assert.match(field('refresh-roles', 'mode').blank, /Add the role/);
      assert.match(field('writeback', 'mode').blank, /only check/);
    });

    it('says on the button, and in the words, what pressing it with everything empty does, where that is something', () => {
      assert.match(by('fshub').submit, /all empty: read the roster now/);
      assert.match(by('fshub').intro, /NOTHING and press the button, the roster and flights are read from FsHub right now/);
      assert.match(by('writeback').submit, /only check the sheet/);
      assert.match(by('refresh-roles').submit, /nothing changes/);
    });

    it('is true of what the command does: a channel alone turns a board on, as the market and weather tabs say', async () => {
      assert.match(by('market').intro, /Choosing a channel turns the board ON/);
      assert.match(by('weather').intro, /Choosing a channel, giving airports, or choosing mode On turns the board on/);
      assert.equal(h.store.getMarketBoard(GUILD), null);
      await run('market', { channel: CH_GENERAL }, { panel: null });
      assert.equal(h.store.getMarketBoard(GUILD)!.channelId, CH_GENERAL, 'on, with the mode left empty');
      assert.equal(h.store.getWeatherBoard(GUILD), null);
      await run('weather', { channel: CH_GENERAL }, { panel: null });
      assert.equal(h.store.getWeatherBoard(GUILD)!.channelId, CH_GENERAL);
    });

    it('is true of what the command does: an empty role on "Who can reserve" opens the panel to everyone', async () => {
      await run('panel-role', { role: ROLE_STAFF });
      assert.equal(h.store.getPanel(pid())!.requiredRoleId, ROLE_STAFF);
      await run('panel-role', {});
      assert.equal(h.store.getPanel(pid())!.requiredRoleId, null);
    });

    it('is true of what the command does: choosing both a channel and Panel for completed flights is refused, as the tab says', async () => {
      assert.match(by('completed').intro, /ONE of the two boxes/);
      const r = await run('completed', { channel: CH_COMPLETED, mode: 'panel' });
      assert.equal(r.ok, false);
      assert.equal(h.store.getPanel(pid())!.completedChannelId, null);
    });

    it('quotes the same limits the code enforces (days, minutes, airports, file size)', async () => {
      const { PANEL_DAYS_MAX, PANEL_DAYS_MIN } = await import('../src/services/jobs.js');
      const { DEPART_WARNING_DEFAULT_MINUTES, DEPART_WARNING_MAX_MINUTES, DEPART_WARNING_MIN_MINUTES } = await import('../src/services/departureWarnings.js');
      const { MAX_TOP_AIRPORTS } = await import('../src/services/weatherAirports.js');
      const { MAX_IMPORT_BYTES } = await import('../src/jobs/import.js');
      assert.match(field('window', 'days').label, new RegExp(`\\(${PANEL_DAYS_MIN} to ${PANEL_DAYS_MAX}\\)`));
      assert.match(field('depart-warning', 'minutes').label, new RegExp(`\\(${DEPART_WARNING_MIN_MINUTES} to ${DEPART_WARNING_MAX_MINUTES}\\)`));
      assert.match(by('depart-warning').intro, new RegExp(`On \\(${DEPART_WARNING_DEFAULT_MINUTES} minutes\\)`));
      assert.match(field('weather', 'airports').label, new RegExp(`up to ${MAX_TOP_AIRPORTS}`));
      assert.match(field('import', 'file').label, new RegExp(`up to ${MAX_IMPORT_BYTES / 1024} KB`));
      assert.deepEqual([field('window', 'days').min, field('window', 'days').max], [PANEL_DAYS_MIN, PANEL_DAYS_MAX]);
      assert.deepEqual([field('depart-warning', 'minutes').min, field('depart-warning', 'minutes').max], [DEPART_WARNING_MIN_MINUTES, DEPART_WARNING_MAX_MINUTES]);
    });

    it('refuses a Fill whose preview would only come back to this page, where it has no Write button, and says what to set first', async () => {
      assert.equal(h.store.getPanel(pid())!.profitSendTo, 'here');
      for (const action of ['fill', 'deductions']) {
        const r = await run('profit', { action });
        assert.equal(r.ok, false, action);
        assert.match(r.text, /Write and Cancel buttons, and those only work in Discord/);
        assert.match(r.text, /set \*\*Send the preview to\*\* to \*\*DM\*\*/);
      }
      assert.match(by('profit').intro, /Write button only exists in Discord/);
      // Check changes nothing, and a Fill set to go to a DM is not stopped by this (it goes on to need the FsHub token, which this test has none of here)
      assert.doesNotMatch((await run('profit', { action: 'check' })).text, /Write and Cancel buttons/);
      d.ctx.profits = null;
      const dm = await run('profit', { action: 'fill', 'send-to': 'dm' });
      assert.doesNotMatch(dm.text, /Write and Cancel buttons/);
    });

    it('says in the choices of the profit and reminders tabs what they mean on this page, not "in the reply" or "the role option"', () => {
      const send = field('profit', 'send-to').choices!.map((c) => c.label).join(' | ');
      assert.match(send, /Here: in the answer on this page \(it has no Write button/);
      assert.match(send, /DM: in the server owner's Discord direct messages/);
      assert.match(field('profit', 'who-can-write').choices!.map((c) => c.label).join(' | '), /only the server owner/);
      assert.match(field('reminders', 'mode').choices!.find((c) => c.value === 'role')!.label, /pick it in the Role to ping box/);
      for (const t of tabs) for (const f of t.fields) for (const c of f.choices ?? []) assert.equal(/in the reply|the role option|the channel option/.test(c.label), false, `${t.id}.${f.name}.${c.value}: ${c.label}`);
    });

    it('points a command\'s option names at the boxes of the page', () => {
      const def = { fields: [{ name: 'mode', label: 'Who is pinged', choices: [{ value: 'auto', label: 'Auto: the usual list' }, { value: 'off', label: 'Off' }] }, { name: 'role', label: 'Role to ping' }] as never };
      assert.equal(boxWords(def, 'Choose a role with the `role` option.'), 'Choose a role with the **Role to ping** box.');
      assert.equal(boxWords(def, 'Use `mode:auto` or `mode:off`.'), 'Use **Who is pinged** set to Auto or **Who is pinged** set to Off.');
      assert.equal(boxWords(def, 'Give a `role` or `panel`; `/x` stays.'), 'Give a **Role to ping** or `panel`; `/x` stays.', 'only names of boxes of this tab are changed');
    });

    it('never leaves a Discord command name or option name in what a tab says (for the tabs and the commands tested here)', async () => {
      for (const r of [await run('window', { days: 3 }), await run('layout', { mode: 'grid' }), await run('reminders', { mode: 'role' }), await run('refresh-roles', {}, { status: true }), await run('market', {}, { panel: null, status: true }), await run('weather', {}, { panel: null, status: true })]) {
        assert.equal(/\/setup/.test(r.text), false, r.text);
        assert.equal(/`(mode|role|channel|days|minutes|airports|link|confirm|autocomplete|cleanup)(:[^`]*)?`/.test(r.text), false, r.text);
      }
    });
  });

  describe('the servers and what they offer', () => {
    it('lists the servers the bot is in, each with its airlines', () => {
      assert.deepEqual(sc.servers(), [{ id: GUILD, name: 'Test Server', airlines: [{ id: pid(), name: 'Test Air', abbr: 'TST', prefix: 'TST' }] }]);
    });

    it('offers the text channels in order, and the roles the bot may hand out, with @everyone', async () => {
      const c = await sc.choices(GUILD);
      assert.deepEqual(c.channels.map((x) => x.name), ['flights', 'completed', 'general'], 'no voice channel');
      assert.deepEqual(c.roles.map((x) => x.name), ['Staff', 'Pilots', '@everyone'], 'a role that belongs to a bot is left out');
    });

    it('says so when the bot is not in the server', async () => {
      await assert.rejects(sc.choices(OTHER_GUILD), /not in that server/);
      const r = await run('panels', {}, { guild: OTHER_GUILD });
      assert.deepEqual([r.ok, /not in that server/.test(r.text)], [false, true]);
    });
  });

  describe('running a tab', () => {
    it('refuses a tab that does not exist, and the landing-safety page (it has its own endpoints)', async () => {
      assert.equal((await run('nonsense')).ok, false);
      assert.equal((await run('safety-pay')).ok, false);
    });

    it('needs an airline for a tab that is for one, and one of this server\'s', async () => {
      const none = await run('window', {}, { panel: null });
      assert.deepEqual([none.ok, /Choose an airline first/.test(none.text)], [false, true]);
      const other = h.store.createPanel({ guildId: OTHER_GUILD, name: 'Other Air', prefix: 'OTH', channelId: '9', now: T0 });
      const wrong = await run('window', { days: 3 }, { panel: other.id });
      assert.equal(wrong.ok, false);
      assert.equal(h.store.getPanel(other.id)!.showDays, 7, 'another server\'s airline is not touched');
      assert.equal((await run('window', { days: 3 }, { panel: 99999 })).ok, false);
    });

    it('says how things stand when opened, for every tab that shows it, without changing anything', async () => {
      const before = JSON.stringify(h.store.getPanel(pid()));
      for (const t of setupTabs().filter((x) => x.status !== 'none' && !x.custom)) {
        const r = await run(t.id, {}, { status: true });
        assert.equal(r.ok, true, `${t.id}: ${r.text}`);
        assert.ok(r.text.length > 10, t.id);
      }
      assert.equal(JSON.stringify(h.store.getPanel(pid())), before, 'looking changed nothing');
    });

    it('shows an airline\'s own line of the list of panels for a tab with no status of its own', async () => {
      h.store.createPanel({ guildId: GUILD, name: 'Second Air', prefix: 'SEC', channelId: '9', now: T0 });
      const r = await run('sheet', {}, { status: true });
      assert.match(r.text, /\*\*Test Air \(TST\)\*\* in #flights · `TST-…`/);
      assert.equal(r.text.includes('Second Air'), false, 'only this airline');
      assert.equal(r.text.includes('\n'), false, 'one line');
    });

    it('changes a setting and says what the command said, in the page\'s words (no Discord mentions, no /setup)', async () => {
      const r = await run('window', { days: '3' });
      assert.equal(r.ok, true);
      assert.equal(h.store.getPanel(pid())!.showDays, 3);
      assert.match(r.text, /^Done\. The \*\*Test Air\*\* panel lists the flights that are open now or start within the next \*\*3 days\*\*/);
      assert.match(r.text, /Change it with the \*\*Days shown\*\* tab/, '/setup window became the name of its tab');
      assert.equal(/\/setup|<[#@]/.test(r.text), false);
    });

    it('writes mentions as names and times as dates', async () => {
      h.store.updatePanel(pid(), { requiredRoleId: ROLE_PILOTS, completedChannelId: CH_COMPLETED });
      const list = await run('panels', {}, { status: true });
      assert.match(list.text, /in #flights/);
      assert.match(list.text, /reserving: role @Pilots/);
      assert.match(list.text, /completed flights: in #completed/);
      assert.equal(/<[#@&]/.test(list.text), false);
      h.store.updatePanel(pid(), { lastRefreshAt: Date.UTC(2026, 10, 11, 18, 5, 0) });
      assert.match((await run('panels', {}, { status: true })).text, /updated 2026-11-11 18:05 UTC/);
    });

    it('turns a person\'s mention into their name', async () => {
      const r = await run('id-add', { user: PILOT, id: '1234' });
      assert.equal(r.ok, true, r.text);
      assert.match(r.text, /@alex's FsHub pilot ID is now \*\*1234\*\*/);
    });
  });

  describe('checking what was typed, as Discord did for the command', () => {
    it('needs the boxes that are needed, trims text, and refuses text that is too long or too short', async () => {
      assert.match((await run('panel-add', { channel: CHANNEL })).text, /Airline name is needed/);
      assert.match((await run('panel-add', { airline: 'Test Air' })).text, /Channel is needed/);
      assert.match((await run('panel-add', { airline: 'A'.repeat(61), channel: CHANNEL })).text, /60 characters or fewer/);
      assert.match((await run('panel-add', { airline: 'Test Air', channel: CHANNEL, prefix: 'X' })).text, /at least 2 characters/);
      assert.deepEqual(h.store.listPanels(GUILD).map((p) => p.prefix), ['TST'], 'nothing was added');
    });

    it('refuses a number that is not whole or out of range, and a choice that was not offered', async () => {
      assert.match((await run('window', { days: '2.5' })).text, /whole number/);
      assert.match((await run('window', { days: 'soon' })).text, /whole number/);
      assert.match((await run('window', { days: 8 })).text, /Days ahead \(1 to 7\) can be at most 7/);
      assert.match((await run('window', { days: 0 })).text, /at least 1/);
      assert.match((await run('layout', { mode: 'sideways' })).text, /choose one of the choices offered/);
      assert.equal(h.store.getPanel(pid())!.showDays, 7);
      assert.equal(h.store.getPanel(pid())!.layout, 'cards');
    });

    it('refuses a channel or a role that is not in the server, or a channel that cannot hold a panel', async () => {
      assert.match((await run('panel-add', { airline: 'Test Air', channel: '700000000000000777' })).text, /choose a text channel of this server/);
      assert.match((await run('panel-add', { airline: 'Test Air', channel: '700000000000000009' })).text, /choose a text channel of this server/, 'a voice channel');
      assert.match((await run('panel-role', { role: '500000000000000777' })).text, /choose a role of this server/);
    });

    it('refuses a person who cannot be found, and a number that is not a Discord ID', async () => {
      assert.match((await run('id-add', { user: 'abc', id: '1234' })).text, /Discord user ID/);
      assert.match((await run('id-add', { user: '123456789012345678', id: '1234' })).text, /couldn't find a Discord user/);
    });

    it('lets a blank box mean "leave it as it is"', async () => {
      const r = await run('window', { days: '' });
      assert.equal(r.ok, true);
      assert.match(r.text, /^The \*\*Test Air\*\* panel lists/);
    });
  });

  describe('the commands, from their tabs', () => {
    it('adds a panel in a channel, with a role, and then changes its channel', async () => {
      const r = await run('panel-add', { airline: 'Second Air', channel: CH_GENERAL, prefix: 'sec', role: ROLE_PILOTS });
      assert.equal(r.ok, true, r.text);
      assert.match(r.text, /Created the \*\*Second Air\*\* panel in #general/);
      const p = h.store.getPanelByName(GUILD, 'Second Air')!;
      assert.deepEqual([p.prefix, p.channelId, p.requiredRoleId], ['SEC', CH_GENERAL, ROLE_PILOTS]);
      const moved = await run('panel-add', { airline: 'Second Air', channel: CH_COMPLETED }, { panel: null });
      assert.match(moved.text, /Updated the \*\*Second Air\*\* panel in #completed/);
      assert.equal(h.store.getPanel(p.id)!.channelId, CH_COMPLETED);
    });

    it('opens a panel to everyone with @everyone, and to a role with the role', async () => {
      assert.equal((await run('panel-role', { role: ROLE_STAFF })).ok, true);
      assert.equal(h.store.getPanel(pid())!.requiredRoleId, ROLE_STAFF);
      assert.equal((await run('panel-role', { role: GUILD })).ok, true);
      assert.equal(h.store.getPanel(pid())!.requiredRoleId, null);
    });

    it('removes a panel', async () => {
      const r = await run('panel-remove');
      assert.match(r.text, /Removed the \*\*Test Air\*\* panel/);
      assert.equal(h.store.getPanel(pid()), null);
    });

    it('draws the panel as a grid, and says so', async () => {
      const r = await run('layout', { mode: 'grid' });
      assert.match(r.text, /grid of buttons/);
      assert.equal(h.store.getPanel(pid())!.layout, 'grid');
    });

    it('imports a file chosen on this computer, for an airline with no sheet, and refuses one that is too big', async () => {
      const r = await run('import', { file: { name: 'flights.csv', text: CSV } });
      assert.equal(r.ok, true, r.text);
      assert.match(r.text, /Imported \*\*2\*\* flights into the \*\*Test Air\*\* panel/);
      assert.equal(h.jobs.open(pid()).length, 2);
      const big = await run('import', { file: { name: 'big.csv', text: 'x'.repeat(300 * 1024) } });
      assert.deepEqual([big.ok, /larger than 256 KB/.test(big.text)], [false, true]);
      assert.match((await run('import', { file: 'flights.csv' })).text, /choose a file/);
      assert.match((await run('import', { file: { name: 'a.csv', text: 'nothing useful here' } })).text, /./);
      assert.equal(h.jobs.open(pid()).length, 2, 'a file that could not be read changed nothing');
    });

    it('hands back the example file to download', async () => {
      const r = await run('template');
      assert.equal(r.ok, true);
      assert.deepEqual(r.files.map((f) => f.name), ['sample-flights.csv']);
      assert.match(r.files[0]!.text, /legs/);
    });

    it('sets a pilot\'s FsHub ID as the server\'s owner, and tells the pilot', async () => {
      const r = await run('id-add', { user: `<@${PILOT}>`, id: 'https://fshub.io/pilot/1234/overview' });
      assert.equal(r.ok, true, r.text);
      assert.equal(h.store.getPilotId(PILOT), 1234);
      assert.equal(pilot.dms.length, 1);
      assert.match(pilot.lastText, new RegExp(`A manager \\(<@${OWNER}>\\) set your FsHub pilot ID to \\*\\*1234\\*\\*`), 'the owner is the one who did it');
      assert.equal(owner.dms.length, 0);
    });

    it('adds and clears the staff roles that may refresh a panel', async () => {
      const r = await run('refresh-roles', { role: ROLE_STAFF });
      assert.match(r.text, /Members with @Staff can now refresh the panels/);
      assert.deepEqual(h.store.listRefreshRoles(GUILD), [ROLE_STAFF]);
      assert.match((await run('refresh-roles', {}, { status: true })).text, /Roles that can run the \*\*Refresh now\*\* tab: @Staff/);
      await run('refresh-roles', { mode: 'clear' });
      assert.deepEqual(h.store.listRefreshRoles(GUILD), []);
    });

    it('sets reminders, the departure warning and live tracking', async () => {
      assert.equal((await run('reminders', { mode: 'role', role: ROLE_PILOTS })).ok, true);
      assert.deepEqual([h.store.getPanel(pid())!.reminderMode, h.store.getPanel(pid())!.reminderRoleId], ['role', ROLE_PILOTS]);
      assert.equal((await run('depart-warning', { minutes: 45 })).ok, true);
      assert.equal(h.store.getPanel(pid())!.departWarningMinutes, 45);
      assert.equal((await run('live-tracking', { mode: 'off' })).ok, true);
      assert.equal(h.store.getPanel(pid())!.liveTracking, false);
    });

    it('turns the market and the weather boards on in a channel, and off again', async () => {
      assert.equal((await run('market', { mode: 'on', channel: CH_GENERAL }, { panel: null })).ok, true);
      assert.equal(h.store.getMarketBoard(GUILD)!.channelId, CH_GENERAL);
      assert.equal((await run('weather', { mode: 'on', channel: CH_COMPLETED, airports: 'EGLL KJFK' }, { panel: null })).ok, true);
      assert.deepEqual(h.store.getWeatherBoard(GUILD)!.airports, ['EGLL', 'KJFK']);
      assert.match((await run('weather', { airports: 'london' }, { panel: null })).text, /four-letter ICAO codes/);
      await run('market', { mode: 'off' }, { panel: null });
      assert.equal(h.store.getMarketBoard(GUILD), null);
    });

    it('says what is wrong, as the command said it, when it is refused (a refusal is not an error)', async () => {
      const r = await run('reminders', { mode: 'role' });
      assert.deepEqual([r.ok, r.text], [false, 'Choose which role to ping with the **Role to ping** box.'], 'the command\'s "role option" is the box with that name on the page');
      const unknown = await run('fshub', { link: 'SKY' });
      assert.deepEqual([unknown.ok, /doesn't belong to an airline/.test(unknown.text)], [false, true], 'FsHub is asked, and says the token\'s account has no such airline');
      assert.equal(h.store.getPanel(pid())!.fshubAirlineId, null, 'nothing was linked');
    });

    it('does not run a command that needs a FsHub token without one, and says where to put it', async () => {
      d.ctx.fshub = null;
      d.ctx.fshubSync = null;
      const r = await run('fshub', { link: 'SKY' });
      assert.equal(r.ok, false);
      assert.match(r.text, /FsHub access token/);
    });
  });

  describe('what is logged', () => {
    it('is nothing but the fact that a tab was run, never what was typed (a sheet link, a token)', async () => {
      const lines: string[] = [];
      d.ctx.log = { debug() {}, info: (m: string) => void lines.push(m), warn: (m: string) => void lines.push(m), error: (m: string) => void lines.push(m) } as never;
      await run('sheet', { link: 'https://docs.google.com/spreadsheets/d/SECRETSHEET/edit' });
      assert.equal(lines.some((l) => l.includes('SECRETSHEET')), false);
    });
  });
});

describe('/setup in Discord', () => {
  let h: Harness;
  let d: DiscordHarness;
  const slim = commands.find((c) => c.data.name === 'setup')!;
  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h, { fshub: true });
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('has only the three parts that a person may need without reaching the host\'s computer, and is for admins', () => {
    const j = slim.data.toJSON();
    assert.deepEqual((j.options ?? []).map((o) => o.name), ['settings', 'refresh', 'id-add']);
    assert.equal(j.default_member_permissions, '32');
    assert.deepEqual(j.contexts, [0]);
  });

  it('says where setting up is done, to the admin only', async () => {
    const f = fakeInteraction({ sub: 'settings', admin: true });
    await slim.execute(d.ctx, f.i);
    assert.equal(f.calls.replies.length, 1);
    assert.equal(f.calls.replies[0].content, SETTINGS_POINTER);
    assert.match(SETTINGS_POINTER, /Open settings/);
    assert.match(SETTINGS_POINTER, /\/setup refresh/);
    assert.match(SETTINGS_POINTER, /Staff roles/);
  });

  it('has the full command back, for a bot that runs without the host app (the demo, development), when FPB_FULL_SETUP is on', async () => {
    const { commandSet } = await import('../src/discord/commands/index.js');
    const { fullSetupCommand, FULL_SETUP_FLAG } = await import('../src/features.js');
    assert.equal(FULL_SETUP_FLAG, 'FPB_FULL_SETUP');
    for (const [v, on] of [[undefined, false], ['', false], ['0', false], ['no', false], ['1', true], ['true', true], ['YES', true], [' on ', true]] as const) assert.equal(fullSetupCommand({ FPB_FULL_SETUP: v }), on, String(v));
    const names = (full: boolean) => ((commandSet(true, full).find((c) => c.data.name === 'setup')!.data.toJSON().options ?? []).map((o) => o.name));
    assert.equal(names(false).length, 3);
    assert.equal(names(true).length, 24, 'every subcommand, as before');
    assert.equal(commandSet(true, true).length, commandSet(true, false).length, 'only /setup differs');
  });

  it('says in /help where setting up is done, and names only the three parts that are in Discord', async () => {
    const help = (await import('../src/discord/commands/help.js')).helpCommand;
    const f = fakeInteraction({ sub: undefined, admin: true });
    await help.execute(d.ctx, f.i);
    const embeds = JSON.stringify((f.calls.replies[0] ?? f.calls.edits[0]).embeds.map((e: { toJSON(): unknown }) => e.toJSON()));
    assert.match(embeds, /settings page/);
    assert.match(embeds, /Open settings/);
    for (const gone of ['/setup panel-add', '/setup sheet', '/setup import', '/setup weather', '/setup market', '/setup profit', '/setup fshub']) assert.equal(embeds.includes(gone), false, gone);
    for (const kept of ['/setup settings', '/setup refresh', '/setup id-add']) assert.ok(embeds.includes(kept), kept);
  });

  it('still refreshes a panel for an admin, with the same checks as before', async () => {
    const ok = fakeInteraction({ sub: 'refresh', admin: true, options: { airline: 'TST' } });
    await slim.execute(d.ctx, ok.i);
    await settle();
    assert.match(String(ok.calls.edits.at(-1)?.content), /Redrew the \*\*Test Air\*\* panel/);
    const no = fakeInteraction({ sub: 'refresh', admin: false, options: { airline: 'TST' } });
    await assert.rejects(slim.execute(d.ctx, no.i), /Only server admins/);
  });
});

describe('the tabs on the setup page', () => {
  let dir: string;
  let paths: HostPaths;
  let h: Harness;
  let d: DiscordHarness;
  let supervisor: Supervisor;
  let web: WebServer;
  let withBot: boolean;
  const pid = () => h.panel.id;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fpb-tabs-'));
    paths = hostPaths(dir);
    h = await makeHarness();
    d = makeDiscordHarness(h, { fshub: true });
    d.client.user(new FakeUser(OWNER, 'owner'));
    withBot = true;
    const guild = fakeGuild();
    const sc = new SetupConsole({
      ctx: d.ctx,
      discord: { guilds: () => [{ id: GUILD, name: 'Test Server' }], guild: async (id) => (id === GUILD ? (guild as unknown as Guild) : null), user: async (id) => (d.client.users_.get(id) as never) ?? null },
    });
    const s = loadSettings(paths);
    s.discordToken = TOKEN;
    saveSettings(paths, s);
    supervisor = new Supervisor({
      paths,
      log: silentLogger,
      version: '9.9.9',
      onState: () => {},
      startBot: async () => ({ userTag: 'Bot#1', userId: BOT_ID, servers: () => [], settings: new AirlineSettings({ store: h.store, profits: null, fshub: true, now: () => h.clock.now }), setup: sc, stop: async () => {} }) as unknown as BotHandle,
    });
    const updates = new UpdateChecker({ version: '9.9.9', statePath: paths.updateState, autoEnabled: () => false, fetchFn: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch, repo: 'o/r' });
    web = await startWebServer({ supervisor, updates, paths, log: silentLogger, version: '9.9.9', key: KEY, tail: () => [], onQuit: () => {} });
  });
  afterEach(async () => {
    await web.close();
    await supervisor.stop();
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const url = (path: string, key: string | null = KEY) => `http://127.0.0.1:${web.port}${path}${key === null ? '' : `${path.includes('?') ? '&' : '?'}k=${key}`}`;
  const get = async (path: string) => {
    const r = await fetch(url(path));
    return { status: r.status, body: (await r.json()) as any };
  };
  const post = async (path: string, body: unknown) => {
    const r = await fetch(url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const runBody = (tab: string, values: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ tab, guild: GUILD, panel: pid(), values, ...extra });

  it('lists the tabs without the bot running (they come from the commands, not from Discord)', async () => {
    const r = await get('/api/setup/tabs');
    assert.equal(r.status, 200);
    assert.equal(r.body.tabs.length, 24);
    assert.equal(r.body.tabs[0].id, 'panel-add');
  });

  it('has nothing to set up while the bot is not running, and says why (409)', async () => {
    for (const path of ['/api/setup/servers', `/api/setup/choices?guild=${GUILD}`]) assert.equal((await get(path)).status, 409, path);
    assert.equal((await post('/api/setup/run', runBody('window'))).status, 409);
  });

  it('is only for whoever has the key, and not for a page on another site', async () => {
    await supervisor.start();
    for (const path of ['/api/setup/tabs', '/api/setup/servers', `/api/setup/choices?guild=${GUILD}`]) {
      assert.equal((await fetch(url(path, null))).status, 403, path);
      assert.equal((await fetch(url(path, 'wrong'))).status, 403, path);
    }
    assert.equal((await fetch(url('/api/setup/run', null), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(runBody('window', { days: 2 })) })).status, 403);
    const foreign = await fetch(url('/api/setup/run'), { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify(runBody('window', { days: 2 })) });
    assert.equal(foreign.status, 403);
    assert.equal(h.store.getPanel(pid())!.showDays, 7);
  });

  describe('with the bot running', () => {
    beforeEach(() => supervisor.start());

    it('lists the servers with their airlines, and a server\'s channels and roles', async () => {
      const servers = await get('/api/setup/servers');
      assert.deepEqual(servers.body.servers.map((s: any) => [s.name, s.airlines.map((a: any) => a.name)]), [['Test Server', ['Test Air']]]);
      const choices = await get(`/api/setup/choices?guild=${GUILD}`);
      assert.deepEqual(choices.body.channels.map((c: any) => c.name), ['flights', 'completed', 'general']);
      assert.equal((await get('/api/setup/choices?guild=abc')).status, 400);
      assert.equal((await get(`/api/setup/choices?guild=${OTHER_GUILD}`)).status, 404);
      assert.equal((await get('/api/setup/choices')).status, 400);
    });

    it('runs a tab and answers with what the command said', async () => {
      const r = await post('/api/setup/run', runBody('window', { days: 3 }));
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.match(r.body.text, /3 days/);
      assert.equal(h.store.getPanel(pid())!.showDays, 3);
    });

    it('answers a refusal as an ordinary answer with ok false, and the reason', async () => {
      const r = await post('/api/setup/run', runBody('window', { days: 99 }));
      assert.deepEqual([r.status, r.body.ok], [200, false]);
      assert.match(r.body.text, /at most 7/);
    });

    it('says how things stand, for a tab that is opened', async () => {
      const r = await post('/api/setup/run', runBody('layout', {}, { status: true }));
      assert.equal(r.body.ok, true);
      assert.match(r.body.text, /drawn as \*\*cards\*\*/);
    });

    it('hands back a file for download', async () => {
      const r = await post('/api/setup/run', runBody('template'));
      assert.equal(r.body.files[0].name, 'sample-flights.csv');
    });

    it('refuses a request that makes no sense (400)', async () => {
      for (const body of [{}, { tab: 'window' }, { tab: 'window', guild: 'x' }, { tab: 'window', guild: GUILD, values: [1] }, { tab: 'window', guild: GUILD, values: 'x' }, { tab: 'window', guild: GUILD, panel: 'abc' }, { tab: 'window', guild: GUILD, panel: 0 }, { tab: 5, guild: GUILD }]) {
        assert.equal((await post('/api/setup/run', body)).status, 400, JSON.stringify(body));
      }
    });

    it('takes a flights file as large as the import allows (256 KB), but nothing else that large', async () => {
      const file = { name: 'flights.csv', text: `${CSV}${'#'.repeat(250 * 1024)}` };
      const ok = await post('/api/setup/run', runBody('import', { file }));
      assert.equal(ok.status, 200, 'a file of that size is read, not refused as too large to send');
      const tooBig = await fetch(url('/api/setup/run'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(runBody('import', { file: { name: 'x.csv', text: 'x'.repeat(1_100_000) } })) });
      assert.equal(tooBig.status, 413);
      const other = await fetch(url('/api/airline/safety'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ panel: pid(), junk: 'x'.repeat(300_000) }) });
      assert.equal(other.status, 413, 'the other endpoints keep their smaller limit');
    });
  });

  describe('the page', () => {
    const html = `${(globalThis as { __page?: string }).__page ?? ''}`;
    let page: string;
    let script: string;
    beforeEach(async () => {
      const { renderPage } = await import('../src/host/page.js');
      page = renderPage('1.0.0');
      script = /<script>([\s\S]*)<\/script>/.exec(page)![1] as string;
    });
    void html;

    it('has a navigation, the server and airline pickers, and the one tab all the commands share', () => {
      for (const id of ['nav', 'scope', 'pick-server', 'pick-airline', 'cmd', 'cmd-title', 'cmd-intro', 'cmd-status', 'cmd-form', 'cmd-run', 'cmd-out', 'cmd-files']) assert.match(page, new RegExp(`id="${id}"`), id);
    });

    it('keeps the settings that are the host\'s own, each as a tab of its own', () => {
      for (const pane of ['bot', 'google', 'fshub-token', 'twitch', 'updates', 'activity']) assert.match(page, new RegExp(`data-pane="${pane}"`), pane);
      for (const [id, name] of [['bot', 'Discord bot'], ['google', 'Google Sheets key'], ['fshub-token', 'FsHub token'], ['twitch', 'Twitch chat'], ['updates', 'Updates'], ['activity', 'Activity']]) assert.ok(script.includes(`['${id}', '${name}']`), id);
    });

    it('builds every tab from what the server says, and shows what a command said as text, never as markup', () => {
      assert.match(script, /api\('\/api\/setup\/tabs'\)/);
      assert.match(script, /api\('\/api\/setup\/run'/);
      assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(page), false);
      assert.match(script, /function fmt\(/);
    });

    it('asks first for what cannot be undone, with the words the server gives', () => {
      assert.match(script, /def\.confirm && !window\.confirm\(def\.confirm\)/);
    });
  });
});

void HOUR;
