import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commands } from '../src/discord/commands/index.js';
import { describeError, UserError } from '../src/discord/errors.js';
import { DemoJobSource } from '../src/jobs/demo.js';
import { ImportError, parseJobsFile } from '../src/jobs/import.js';
import { silentLogger } from '../src/util/log.js';
import { CHANNEL, GUILD, HOUR, makeHarness, sj, T0, USER_A, USER_B, type Harness } from './helpers.js';
import { fakeInteraction, FakeUser, makeDiscordHarness, settle, type DiscordHarness, type FakeInteractionOptions } from './discord-helpers.js';

const setup = commands.find((c) => c.data.name === 'setup')!;
const NEW_CHANNEL = '800000000000000001';
const attachment = (name = 'jobs.csv', size = 200) => ({ url: `https://cdn.discordapp.com/attachments/1/2/${name}`, size, name });
const csvResponse = (text: string) => async () => new Response(text, { status: 200 });

const guildFake = (hasPerms = true) => ({
  channels: { fetch: async (id: string) => ({ id, permissionsFor: () => ({ has: () => hasPerms }) }) },
  members: { me: {}, fetchMe: async () => ({}) },
});

const GOOD_CSV = ['id,legs,aircraft,from,deadline', `A1,EGLL-EGKK,A20N,,${new Date(T0 + 30 * HOUR).toISOString().slice(0, 16).replace('T', ' ')}`, `A2,EGLL-EGCC-EGPH,A320,,${new Date(T0 + 40 * HOUR).toISOString().slice(0, 16).replace('T', ' ')}`].join('\n');

describe('/setup (admins only)', () => {
  let h: Harness;
  let d: DiscordHarness;

  const boot = async (opts: Parameters<typeof makeDiscordHarness>[1] = {}) => {
    d = makeDiscordHarness(h, opts);
    h.store.deletePanel(h.panel.id); // start each test with a server that has no panels
  };
  beforeEach(async () => {
    h = await makeHarness();
    await boot();
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const run = async (sub: string, o: FakeInteractionOptions = {}) => {
    const f = fakeInteraction({ sub, admin: true, guild: guildFake(), ...o });
    await setup.execute(d.ctx, f.i);
    await settle();
    return f.calls;
  };
  const text = (calls: { edits: any[] }) => String(calls.edits.at(-1)?.content ?? '');
  const addPanel = (o: Record<string, unknown> = {}) => run('panel-add', { options: { airline: 'Test Air', prefix: 'TST', channel: { id: CHANNEL }, ...o } });
  const channelMsgs = (id = CHANNEL) => d.client.channel(id).live;

  describe('permissions', () => {
    it('refuses every subcommand to people without Manage Server, and changes nothing', async () => {
      const subs = ['panel-add', 'panel-role', 'panel-remove', 'panels', 'import', 'sheet', 'reminders', 'refresh', 'release', 'template'];
      for (const sub of subs) {
        await assert.rejects(
          run(sub, { admin: false, options: { airline: 'Test Air', channel: { id: CHANNEL }, code: 'TST-001', file: attachment() } }),
          (e: unknown) => e instanceof UserError && /Manage Server/.test(e.message),
          sub,
        );
      }
      assert.deepEqual(h.store.listPanels(GUILD), []);
      assert.equal(channelMsgs().length, 0);
    });

    it('is registered as admin-only and guild-only, and is the only way to name an airline', () => {
      const json = setup.data.toJSON();
      assert.equal(json.default_member_permissions, '32'); // ManageGuild
      assert.deepEqual(json.contexts, [0]);
      assert.deepEqual(commands.map((c) => c.data.name).sort(), ['fuel', 'help', 'setup'], 'no user-facing command picks an airline');
    });

    it('no longer has anything to do with FsHub: no verify step, and the airline is just typed', () => {
      const json = setup.data.toJSON();
      const subs = (json.options ?? []).map((o) => o.name);
      assert.ok(!subs.includes('verify'));
      const add = (json.options ?? []).find((o) => o.name === 'panel-add') as unknown as { options: Array<{ name: string; max_length?: number }> };
      const airline = add.options.find((o) => o.name === 'airline')!;
      assert.equal(airline.max_length, 60);
    });
  });

  describe('panel-add', () => {
    it('creates the panel from the typed name, derives the prefix from it, and posts it', async () => {
      const calls = await run('panel-add', { options: { airline: 'Test Air', channel: { id: CHANNEL } } });
      const panel = h.store.getPanelByName(GUILD, 'Test Air')!;
      assert.deepEqual([panel.prefix, panel.channelId, panel.airlineName, panel.airlineAbbr], ['TA', CHANNEL, 'Test Air', null]);
      assert.match(text(calls), /Created the \*\*Test Air\*\* panel/);
      assert.match(text(calls), /\/setup template/, 'tells the admin how to load flights');
      assert.equal(channelMsgs().length, 1);
      assert.match(channelMsgs()[0]!.payload.embeds[0].toJSON().title, /Test Air · open flights/);
      assert.deepEqual(h.store.getPanel(panel.id)!.messageIds, [channelMsgs()[0]!.id]);
    });

    it('accepts a custom prefix, validates it and keeps it unique within the server', async () => {
      await addPanel({ prefix: 'va' });
      assert.equal(h.store.getPanelByName(GUILD, 'Test Air')!.prefix, 'VA');
      await assert.rejects(run('panel-add', { options: { airline: 'Other Cargo', channel: { id: CHANNEL }, prefix: 'VA' } }), /already uses the prefix/);
      await assert.rejects(run('panel-add', { options: { airline: 'Other Cargo', channel: { id: CHANNEL }, prefix: 'no way!' } }), /letters and numbers/);
      await run('panel-add', { options: { airline: 'Other Cargo', channel: { id: NEW_CHANNEL } } }); // OC, no clash
      assert.deepEqual(h.store.listPanels(GUILD).map((p) => p.prefix).sort(), ['OC', 'VA']);
    });

    it('can host several airlines, each with its own panel and codes', async () => {
      await addPanel();
      await run('panel-add', { options: { airline: 'Other Cargo', prefix: 'OCG', channel: { id: NEW_CHANNEL } } });
      const [a, b] = ['TST', 'OCG'].map((p) => h.store.listPanels(GUILD).find((x) => x.prefix === p)!);
      h.jobs.sync(a!.id, [sj('x', 'EGLL-EGKK')]);
      h.jobs.sync(b!.id, [sj('x', 'EGLL-EGKK')]);
      assert.equal(h.jobs.open(a!.id)[0]!.job.code, 'TST-001');
      assert.equal(h.jobs.open(b!.id)[0]!.job.code, 'OCG-001');
    });

    it('refuses a channel the bot cannot write to', async () => {
      await assert.rejects(run('panel-add', { guild: guildFake(false), options: { airline: 'Test Air', channel: { id: CHANNEL } } }), /missing permissions/);
      assert.deepEqual(h.store.listPanels(GUILD), []);
    });

    it('takes any sensible name, and tidies it', async () => {
      await run('panel-add', { options: { airline: '   Blue   Sky \n Cargo ', channel: { id: CHANNEL } } });
      assert.equal(h.store.listPanels(GUILD)[0]!.airlineName, 'Blue Sky Cargo');
    });

    it('rejects a name that is blank, too short, too long, or could ping people', async () => {
      const cases: Array<[string, RegExp]> = [['', /at least 2/], ['x', /at least 2/], ['y'.repeat(61), /too long/], ['@everyone Air', /can't contain an @/], ['Air @here', /can't contain an @/]];
      for (const [name, why] of cases) {
        await assert.rejects(run('panel-add', { options: { airline: name, channel: { id: CHANNEL } } }), why, name);
      }
      assert.deepEqual(h.store.listPanels(GUILD), []);
    });

    it('treats the same name in other capitals as the same airline, so it updates rather than duplicates', async () => {
      await addPanel();
      const calls = await run('panel-add', { options: { airline: 'TEST AIR', channel: { id: NEW_CHANNEL } } });
      assert.match(text(calls), /Updated the/);
      assert.equal(h.store.listPanels(GUILD).length, 1);
      assert.equal(h.store.listPanels(GUILD)[0]!.airlineName, 'Test Air', 'keeps the name as first typed');
    });

    it('running it again moves the panel to a new channel without duplicating it', async () => {
      await addPanel();
      const first = channelMsgs()[0]!;
      await addPanel({}); // same channel: nothing duplicated
      assert.equal(h.store.listPanels(GUILD).length, 1);
      await run('panel-add', { options: { airline: 'Test Air', channel: { id: NEW_CHANNEL } } });
      assert.equal(h.store.getPanelByName(GUILD, 'Test Air')!.channelId, NEW_CHANNEL);
      assert.equal(first.deleted, true, 'old panel message removed');
      assert.equal(channelMsgs().length, 0);
      assert.equal(channelMsgs(NEW_CHANNEL).length, 1);
    });

    it('will not change the prefix of an existing panel (it would break known IDs)', async () => {
      await addPanel();
      await assert.rejects(addPanel({ prefix: 'NEW' }), /would break the IDs/);
      assert.equal(h.store.getPanelByName(GUILD, 'Test Air')!.prefix, 'TST');
    });

    it('with an automatic source (demo), loads the flights straight away', async () => {
      await boot({ source: new DemoJobSource() });
      const calls = await addPanel();
      assert.match(text(calls), /It lists \d+ open flights/);
      assert.match(text(calls), /refresh automatically every 24 hours/);
      assert.ok(h.jobs.open(h.store.getPanelByName(GUILD, 'Test Air')!.id).length > 0);
    });

    it('says how many flights are listed even when re-running adds none (it is not "loaded 0")', async () => {
      await boot({ source: new DemoJobSource() });
      await addPanel();
      const again = await addPanel();
      assert.match(text(again), /Updated the/);
      assert.match(text(again), /It lists [1-9]\d* open flights/);
      assert.doesNotMatch(text(again), /loaded 0/);
    });

    it('brings the panel back after someone deleted its message, with no permissions warning', async () => {
      await addPanel();
      const first = channelMsgs()[0]!;
      d.client.channel(CHANNEL).deleteMessage(first.id); // a person deletes the panel in Discord
      assert.equal(channelMsgs().length, 0);

      const calls = await addPanel(); // /setup panel-add again
      assert.match(text(calls), /Updated the \*\*Test Air\*\* panel/);
      assert.doesNotMatch(text(calls), /⚠️/);
      assert.equal(channelMsgs().length, 1);
      assert.notEqual(channelMsgs()[0]!.id, first.id);
    });

    it('blames permissions only for a real permissions problem, and says what is needed', async () => {
      d.client.channel(CHANNEL).send = async () => {
        throw Object.assign(new Error('Missing Access'), { code: 50001 });
      };
      const calls = await addPanel();
      assert.match(text(calls), /can't see or write in that channel.*View Channel, Send Messages, Embed Links and Read Message History/);

      d.client.channel(CHANNEL).send = async () => {
        throw new Error('network hiccup');
      };
      const other = await addPanel();
      assert.match(text(other), /unexpected error.*in my log/);
      assert.doesNotMatch(text(other), /permissions/i);
    });
  });

  describe('import', () => {
    const importFile = (csv: string, o: Record<string, unknown> = {}, ctxOpts?: Parameters<typeof makeDiscordHarness>[1]) => {
      if (ctxOpts) d = makeDiscordHarness(h, ctxOpts);
      return run('import', { options: { file: attachment(), ...o } });
    };
    beforeEach(async () => {
      await addPanel();
    });
    const withFile = (csv: string) => {
      d.ctx.fetchFn = csvResponse(csv) as unknown as typeof fetch;
    };

    it('loads the flights, gives them IDs and redraws the panel', async () => {
      withFile(GOOD_CSV);
      const calls = await run('import', { options: { file: attachment() } });
      assert.match(text(calls), /Imported \*\*2\*\* flights.*2 new, 0 changed, 0 closed/);
      const panel = h.store.getPanelByName(GUILD, 'Test Air')!;
      assert.deepEqual(h.jobs.open(panel.id).map((v) => [v.job.code, v.job.aircraft, v.legs.length]), [['TST-001', 'A20N', 1], ['TST-002', 'A320', 2]]);
      assert.match(channelMsgs()[0]!.payload.embeds[0].toJSON().description, /\*\*TST-002\*\* · EGLL → EGCC → EGPH \(2 legs\)/);
    });

    it('re-importing keeps IDs and reservations, closes flights that left the file, and tells the holders', async () => {
      const alice = d.client.user(new FakeUser(USER_A.discordId, 'alice'));
      withFile(GOOD_CSV);
      await run('import', { options: { file: attachment() } });
      const panel = h.store.getPanelByName(GUILD, 'Test Air')!;
      const a2 = h.jobs.open(panel.id)[1]!.job.id;
      h.jobs.reserve(a2, [2], USER_A);

      const next = GOOD_CSV.split('\n').filter((l) => !l.startsWith('A1')).join('\n'); // A1 gone, A2 stays
      withFile(next);
      const calls = await run('import', { options: { file: attachment() } });
      assert.match(text(calls), /0 new, 0 changed, 1 closed/);
      assert.deepEqual(h.jobs.open(panel.id).map((v) => v.job.code), ['TST-002']);
      assert.equal(h.jobs.open(panel.id)[0]!.legs[1]!.holder?.username, 'alice', 'reservation kept');
      assert.equal(alice.dms.length, 0, 'alice was not affected, so not messaged');

      // now A2 disappears too: alice is told
      withFile('id,legs,deadline\nA3,EGLL-EGKK,' + new Date(T0 + 30 * HOUR).toISOString().slice(0, 16));
      const last = await run('import', { options: { file: attachment() } });
      assert.match(text(last), /1 pilot was told/);
      assert.match(alice.lastText, /TST-002.*leg 2.*no longer listed/);
    });

    it('rejects a bad file whole, listing what is wrong, and leaves the panel alone', async () => {
      withFile(GOOD_CSV);
      await run('import', { options: { file: attachment() } });
      withFile('id,legs,deadline\nB1,EGLL,2026-11-20\nB2,EGLL-EGKK,whenever\n');
      const err = await run('import', { options: { file: attachment() } }).catch((e: unknown) => e);
      assert.ok(err instanceof ImportError);
      const shown = describeError(err, silentLogger);
      assert.match(shown, /Nothing was imported: 2 problems/);
      assert.match(shown, /• row 2: .*two airports/);
      assert.match(shown, /• row 3: deadline "whenever"/);
      assert.equal(h.jobs.open(h.store.getPanelByName(GUILD, 'Test Air')!.id).length, 2, 'existing flights untouched');
    });

    it('only reads files uploaded to Discord, within the size limit', async () => {
      withFile(GOOD_CSV);
      await assert.rejects(run('import', { options: { file: { url: 'https://evil.example/jobs.csv', size: 10, name: 'jobs.csv' } } }), /attach the file directly/);
      await assert.rejects(run('import', { options: { file: { url: 'http://169.254.169.254/latest', size: 10, name: 'jobs.csv' } } }), /attach the file directly/);
      await assert.rejects(run('import', { options: { file: { url: 'not a url', size: 10, name: 'jobs.csv' } } }), /attach the file directly/);
      await assert.rejects(run('import', { options: { file: attachment('big.csv', 10_000_000) } }), /larger than/);
    });

    it('reports a failed download plainly', async () => {
      d.ctx.fetchFn = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
      await assert.rejects(run('import', { options: { file: attachment() } }), /couldn't download/);
      d.ctx.fetchFn = (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch;
      await assert.rejects(run('import', { options: { file: attachment() } }), /couldn't download/);
    });

    it('needs to know which panel when the server has several', async () => {
      await run('panel-add', { options: { airline: 'Other Cargo', prefix: 'OCG', channel: { id: NEW_CHANNEL } } });
      withFile(GOOD_CSV);
      await assert.rejects(run('import', { options: { file: attachment() } }), /several panels/);
      const calls = await run('import', { options: { file: attachment(), airline: 'ocg' } });
      assert.match(text(calls), /into the \*\*Other Cargo\*\* panel/);
      assert.equal(h.jobs.open(h.store.getPanelByName(GUILD, 'Test Air')!.id).length, 0, 'the other panel is untouched');
    });

    it('works with JSON too', async () => {
      d.ctx.fetchFn = csvResponse(JSON.stringify([{ id: 'j1', legs: 'EGLL-EGKK-EGCC', aircraft: 'A320' }])) as unknown as typeof fetch;
      const calls = await run('import', { options: { file: attachment('jobs.json') } });
      assert.match(text(calls), /Imported \*\*1\*\*/);
    });

    void importFile;
  });

  describe('the role that may reserve', () => {
    const ROLE = '555555555555555555';
    const panel = () => h.store.getPanelByName(GUILD, 'Test Air')!;

    it('panel-add can set it, and the panel and confirmation say who may reserve', async () => {
      const calls = await addPanel({ role: { id: ROLE } });
      assert.equal(panel().requiredRoleId, ROLE);
      assert.match(text(calls), new RegExp(`Only members with <@&${ROLE}> can reserve`));
      assert.match(channelMsgs()[0]!.payload.embeds[0].toJSON().description, new RegExp(`Reserving is open to members with <@&${ROLE}>`));
      assert.deepEqual(channelMsgs()[0]!.payload.allowedMentions, { parse: [] }, 'naming a role never pings it');
    });

    it('with no role, it says anyone with channel access can reserve, and how to change that', async () => {
      const calls = await addPanel();
      assert.equal(panel().requiredRoleId, null);
      assert.match(text(calls), /Anyone who can see the channel can reserve.*\/setup panel-role/);
      assert.doesNotMatch(channelMsgs()[0]!.payload.embeds[0].toJSON().description, /Reserving is open to members/);
    });

    it('re-running panel-add without a role keeps the existing one; @everyone clears it', async () => {
      await addPanel({ role: { id: ROLE } });
      await addPanel();
      assert.equal(panel().requiredRoleId, ROLE);
      await addPanel({ role: { id: GUILD } }); // the @everyone role has the server's own ID
      assert.equal(panel().requiredRoleId, null);
    });

    it('panel-role changes and clears it, and redraws the panel', async () => {
      await addPanel();
      const set = await run('panel-role', { options: { role: { id: ROLE } } });
      assert.equal(panel().requiredRoleId, ROLE);
      assert.match(text(set), new RegExp(`Only members with <@&${ROLE}> can reserve on the \\*\\*Test Air\\*\\* panel now \\(server admins always can\\)`));
      assert.match(channelMsgs()[0]!.payload.embeds[0].toJSON().description, new RegExp(`<@&${ROLE}>`));

      const cleared = await run('panel-role', {});
      assert.equal(panel().requiredRoleId, null);
      assert.match(text(cleared), /Anyone who can see the channel can reserve/);
      assert.doesNotMatch(channelMsgs()[0]!.payload.embeds[0].toJSON().description, /Reserving is open to members/);
    });

    it('panel-role needs to know which panel when there are several', async () => {
      await addPanel();
      await run('panel-add', { options: { airline: 'Other Cargo', prefix: 'OCG', channel: { id: NEW_CHANNEL } } });
      await assert.rejects(run('panel-role', { options: { role: { id: ROLE } } }), /several panels/);
      await run('panel-role', { options: { role: { id: ROLE }, airline: 'ocg' } });
      assert.equal(h.store.getPanelByName(GUILD, 'Other Cargo')!.requiredRoleId, ROLE);
      assert.equal(panel().requiredRoleId, null);
    });

    it('panels shows who may reserve', async () => {
      await addPanel({ role: { id: ROLE } });
      assert.match(text(await run('panels')), new RegExp(`reserving: role <@&${ROLE}>`));
    });
  });

  describe('everything else', () => {
    beforeEach(async () => {
      await addPanel();
    });

    it('panels lists each panel with its counts', async () => {
      const panel = h.store.getPanelByName(GUILD, 'Test Air')!;
      h.jobs.sync(panel.id, [sj('m', 'EGLL-EGKK-EGCC')]);
      h.jobs.reserve(h.jobs.open(panel.id)[0]!.job.id, [1], USER_A);
      const calls = await run('panels');
      assert.match(text(calls), /\*\*Test Air\*\* in <#7000.*> · `TST-…` · flights from: file import · reserving: anyone with channel access · 1 open flights, 1\/2 legs reserved/);
    });

    it('release frees reservations on a flight and names who was released', async () => {
      const panel = h.store.getPanelByName(GUILD, 'Test Air')!;
      h.jobs.sync(panel.id, [sj('m', 'EGLL-EGKK-EGCC')]);
      const id = h.jobs.open(panel.id)[0]!.job.id;
      h.jobs.reserve(id, [1], USER_A);
      h.jobs.reserve(id, [2], USER_B);
      const calls = await run('release', { options: { code: 'tst-1', leg: 2 } });
      assert.match(text(calls), new RegExp(`<@${USER_B.discordId}> \\(leg 2\\)`));
      assert.deepEqual(h.jobs.view(id)!.legs.map((l) => l.holder?.username ?? null), ['alice', null]);
      const all = await run('release', { options: { code: 'TST-001' } });
      assert.match(text(all), new RegExp(`<@${USER_A.discordId}>`));
      assert.match(text(await run('release', { options: { code: 'TST-001' } })), /Nobody holds/);
      await assert.rejects(run('release', { options: { code: 'TST-404' } }), /can't find an open flight/);
    });

    it('template attaches an example file that is itself a valid import', async () => {
      const calls = await run('template');
      const file = calls.edits.at(-1).files[0];
      assert.equal(file.name, 'sample-flights.csv');
      assert.equal(parseJobsFile(file.attachment.toString('utf8'), 'sample-flights.csv').length, 3);
      assert.match(text(calls), /only `legs` is required/);
    });

    it('refresh redraws, and explains when there is no automatic source', async () => {
      const calls = await run('refresh');
      assert.match(text(calls), /Redrew the \*\*Test Air\*\* panel/);
      assert.match(text(calls), /takes flights from `\/setup import`/);
    });

    it('panel-remove deletes the panel, its messages, flights and reservations', async () => {
      const panel = h.store.getPanelByName(GUILD, 'Test Air')!;
      h.jobs.sync(panel.id, [sj('a', 'EGLL-EGKK')]);
      h.jobs.reserve(h.jobs.open(panel.id)[0]!.job.id, [1], USER_A);
      await run('panel-remove', { options: { airline: 'TST' } });
      assert.equal(h.store.getPanel(panel.id), null);
      assert.equal(h.store.listJobs(panel.id).length, 0);
      assert.equal(channelMsgs().length, 0);
      await assert.rejects(run('panel-remove', {}), /no flight panel yet/);
    });

    it('autocomplete offers the panels in this server, by name when adding and by flight prefix otherwise', async () => {
      await addPanel();
      await run('panel-add', { options: { airline: 'Other Cargo', prefix: 'OCG', channel: { id: NEW_CHANNEL } } });
      const add = fakeInteraction({ sub: 'panel-add', focused: { name: 'airline', value: 'cargo' } });
      await setup.autocomplete!(d.ctx, add.i);
      assert.deepEqual(add.calls.responds[0], [{ name: 'Other Cargo', value: 'Other Cargo' }]);
      const imp = fakeInteraction({ sub: 'import', focused: { name: 'airline', value: '' } });
      await setup.autocomplete!(d.ctx, imp.i);
      assert.deepEqual(imp.calls.responds[0], [
        { name: 'Other Cargo', value: 'OCG' },
        { name: 'Test Air', value: 'TST' },
      ]);
      const byPrefix = fakeInteraction({ sub: 'import', focused: { name: 'airline', value: 'ocg' } });
      await setup.autocomplete!(d.ctx, byPrefix.i);
      assert.equal(byPrefix.calls.responds[0].length, 1);
    });
  });
});
