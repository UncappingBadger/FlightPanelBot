import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { componentHandlers, commands } from '../src/discord/commands/index.js';
import { handleDmMessage, MAX_ATTEMPTS } from '../src/discord/dm.js';
import { UserError } from '../src/discord/errors.js';
import { FsHubError } from '../src/fshub/client.js';
import { CHANNEL, makeHarness, sj, USER_A, USER_B, type Harness } from './helpers.js';
import { fakeComponent, fakeDm, fakeInteraction, FakeFsHub, FakeUser, makeDiscordHarness, settle, type DiscordHarness, type FakeInteractionOptions, messageText } from './discord-helpers.js';

/* Everything below is made up. The pilots, airlines and Discord IDs are not real people. */

const setup = commands.find((c) => c.data.name === 'setup')!;
const ANN = { id: 4821, name: 'Ann Pilot', base: 'EGLL', country: 'GB' };

describe('checking a pilot ID with FsHub', () => {
  let h: Harness;
  let d: DiscordHarness;
  let fshub: FakeFsHub;
  let alice: FakeUser;
  let pid: number;

  beforeEach(async () => {
    h = await makeHarness();
    fshub = new FakeFsHub();
    fshub.pilots.set(ANN.id, ANN);
    d = makeDiscordHarness(h, { pilotIds: false, fshub });
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

  it('promises to check it, instead of saying it will not', async () => {
    await reserveButton();
    assert.match(alice.lastText, /I'll check it with FsHub, tell you whose profile it is/);
    assert.doesNotMatch(alice.lastText, /don't check it with FsHub/);
  });

  it('says whose profile a real ID is, keeps the name with it, and shows both on the panel', async () => {
    await reserveButton();
    await say(alice, '4821');
    assert.deepEqual(h.store.getPilotLink(alice.id), { fshubId: 4821, name: 'Ann Pilot', source: 'typed' });
    assert.match(alice.lastText, /saved your FsHub pilot ID as \*\*4821\*\* \(Ann Pilot on FsHub\)/);
    assert.match(alice.lastText, /If that isn't you, send `fshub <your ID>`/);
    assert.match(alice.lastText, /Reply with the flight ID shown on the panel/, 'and carries straight on to the flight');
    assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_code');
    assert.deepEqual(fshub.pilotCalls, [4821], 'one question to FsHub');

    await say(alice, 'TST-001');
    await settle();
    assert.match(panelText(), new RegExp(`^PILOT: <@${USER_A.discordId}> · FsHub #4821 \\(Ann Pilot\\)`, 'm'));
  });

  it('does not accept an ID FsHub has never heard of: the person is told, tries again, and nothing is saved', async () => {
    await reserveButton();
    await say(alice, '999999');
    assert.match(alice.lastText, /FsHub has no pilot with the ID \*\*999999\*\*/);
    assert.match(alice.lastText, /Try again, or say `cancel`/);
    assert.equal(h.store.getPilotId(alice.id), null);
    assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_pilot');
    await say(alice, '4821');
    assert.equal(h.store.getPilotId(alice.id), 4821, 'the right one is taken');
    assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_code');
  });

  it('closes the conversation after too many IDs FsHub does not know, saving nothing', async () => {
    await reserveButton();
    for (let i = 0; i < MAX_ATTEMPTS; i++) await say(alice, String(900000 + i));
    assert.match(alice.lastText, /doesn't know any of those pilot IDs/);
    assert.equal(h.store.getSession(alice.id, h.clock.now), null);
    assert.equal(h.store.getPilotId(alice.id), null);
  });

  for (const [what, error] of [
    ['FsHub being unreachable', new FsHubError('unavailable', "I couldn't reach FsHub right now.")],
    ['the token being refused', new FsHubError('rejected', 'no')],
    ['FsHub asking to slow down', new FsHubError('rate-limited', 'slow')],
    ['something unexpected', new Error('kaboom')],
  ] as const) {
    it(`takes the ID as typed, unchecked, when the check fails because of ${what}: reserving never stops over it`, async () => {
      fshub.error = error;
      await reserveButton();
      await say(alice, '4821');
      assert.deepEqual(h.store.getPilotLink(alice.id), { fshubId: 4821, name: null, source: 'typed' });
      assert.match(alice.lastText, /saved your FsHub pilot ID as \*\*4821\*\*\.\s/);
      assert.doesNotMatch(alice.lastText, /on FsHub/);
      assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_code');
      await say(alice, 'TST-001');
      assert.match(alice.lastText, /TST-001.*is reserved for you/);
      await settle();
      assert.match(panelText(), new RegExp(`<@${USER_A.discordId}> · FsHub #4821(?! \\()`), 'shown without a name');
    });
  }

  describe('`fshub <ID>` in a DM', () => {
    it('checks it, says whose it is, and redraws the panel where the person holds a flight', async () => {
      await reserveButton();
      await say(alice, '1111');
      fshub.pilots.set(1111, { id: 1111, name: 'Old Name', base: null, country: null });
      await say(alice, '1111');
      await say(alice, 'TST-001');
      await settle();
      assert.match(panelText(), /FsHub #1111 \(Old Name\)/);
      await say(alice, 'fshub 4821');
      await settle();
      assert.match(alice.lastText, /your FsHub pilot ID is \*\*4821\*\* \(Ann Pilot on FsHub\)/);
      assert.match(panelText(), /FsHub #4821 \(Ann Pilot\)/);
      assert.doesNotMatch(panelText(), /Old Name/);
    });

    it('refuses an ID FsHub does not know, and keeps the old one', async () => {
      h.store.setPilotId(alice.id, 4821, h.clock.now, 'Ann Pilot');
      await say(alice, 'fshub 999999');
      assert.match(alice.lastText, /FsHub has no pilot with the ID \*\*999999\*\*/);
      assert.match(alice.lastText, /I haven't changed anything/);
      assert.deepEqual(h.store.getPilotLink(alice.id), { fshubId: 4821, name: 'Ann Pilot', source: 'typed' });
    });

    it('still works when FsHub cannot be asked', async () => {
      fshub.error = new FsHubError('unavailable', 'down');
      await say(alice, 'fshub 5555');
      assert.equal(h.store.getPilotId(alice.id), 5555);
      assert.doesNotMatch(alice.lastText, /on FsHub/);
    });

    it('replaces an ID that came from the roster, which is then the pilot\'s own', async () => {
      h.store.applyRosterLinks([{ discordId: alice.id, fshubId: 4000, name: 'Roster Name' }], h.clock.now);
      await say(alice, 'fshub 4821');
      assert.deepEqual(h.store.getPilotLink(alice.id), { fshubId: 4821, name: 'Ann Pilot', source: 'typed' });
    });
  });

  it('shows the name under My flights too, and says where a roster-supplied ID came from', async () => {
    h.store.setPilotId(alice.id, 4821, h.clock.now, 'Ann Pilot');
    h.jobs.reserve(h.jobs.open(pid)[0]!.job.id, [1], USER_A);
    const typed = await press(alice, `panel:mine:${pid}`);
    assert.match(typed.edits[0].content, /shown as \*\*4821\*\* \(Ann Pilot on FsHub\)\. Wrong\?/);
    assert.doesNotMatch(typed.edits[0].content, /roster/);

    h.store.deleteSession(alice.id);
    const bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    h.store.applyRosterLinks([{ discordId: bob.id, fshubId: 4000, name: 'Bob Pilot' }], h.clock.now);
    h.jobs.reserve(h.jobs.open(pid)[1]!.job.id, [1], USER_B);
    const fromRoster = await press(bob, `panel:mine:${pid}`);
    assert.match(fromRoster.edits[0].content, /shown as \*\*4000\*\* \(Bob Pilot on FsHub\) \(I took it from your airline's FsHub roster\)\. Wrong\?/);
  });

  it('shows a name from outside as plain text only: no markdown, no links, no pings', async () => {
    const hostile = '**bold** @everyone <@123456789012345678> [x](https://evil.example) `code` ~~s~~';
    fshub.pilots.set(777, { id: 777, name: hostile, base: null, country: null });
    await reserveButton();
    await say(alice, '777');
    for (const shown of [alice.lastText, panelText().length > 0 ? '' : '']) void shown;
    assert.doesNotMatch(alice.lastText, /@everyone|<@123456789012345678>|\[x\]\(/, 'neutralised in the DM');
    await say(alice, 'TST-001');
    await settle();
    const text = panelText();
    const line = text.split('\n').find((l) => l.includes('FsHub #777'))!;
    assert.ok(line, 'the pilot is shown');
    assert.equal(/(^|[^\\])@everyone/.test(line), false, 'no live @everyone');
    assert.equal(line.includes('<@123456789012345678>'), false, 'no live mention of someone else');
    assert.equal(/(^|[^\\])\*\*bold/.test(line), false, 'no markdown');
    assert.equal(/(^|[^\\])\]\(/.test(line), false, 'no link');
    assert.match(line, /^PILOT: <@\d+> · FsHub #777 \(/);
  });

  it('a pilot the airline roster already lists is never asked', async () => {
    h.store.applyRosterLinks([{ discordId: alice.id, fshubId: 4821, name: 'Ann Pilot' }], h.clock.now);
    const calls = await reserveButton();
    assert.match(calls.edits[0].content, /Reply there with the ID of the flight you want/);
    assert.equal(h.store.getSession(alice.id, h.clock.now)!.step, 'await_code');
    assert.doesNotMatch(alice.lastText, /pilot ID/);
    assert.equal(fshub.pilotCalls.length, 0, 'and FsHub was not asked anything');
  });
});

describe('/setup fshub', () => {
  let h: Harness;
  let d: DiscordHarness;
  let fshub: FakeFsHub;
  const AIRLINE = { id: 8123, name: 'Test Air', abbr: 'TST' };
  const ann = { discordId: USER_A.discordId, id: 500, name: 'Ann Pilot' };

  const boot = (withFsHub: boolean) => {
    fshub = new FakeFsHub();
    fshub.mine = [AIRLINE];
    fshub.airlines.set(AIRLINE.id, AIRLINE);
    fshub.rosters.set(AIRLINE.id, [
      { id: ann.id, name: ann.name, discordId: ann.discordId },
      { id: 501, name: 'Bob Pilot', discordId: USER_B.discordId },
      { id: 502, name: 'Cara NoDiscord', discordId: null },
    ]);
    d = makeDiscordHarness(h, { pilotIds: false, fshub: withFsHub ? fshub : false });
  };
  beforeEach(async () => {
    h = await makeHarness();
    boot(true);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const run = async (o: FakeInteractionOptions = {}) => {
    const f = fakeInteraction({ sub: 'fshub', admin: true, ...o });
    await setup.execute(d.ctx, f.i);
    await settle();
    return String(f.calls.edits.at(-1)?.content ?? '');
  };
  const panel = () => h.store.getPanel(h.panel.id)!;
  const userError = (re: RegExp) => (e: unknown) => e instanceof UserError && re.test(e.message);

  it('is a subcommand with an optional link, and admins only', () => {
    const json = setup.data.toJSON();
    const sub = (json.options ?? []).find((o) => o.name === 'fshub') as unknown as { description: string; options: Array<{ name: string; required?: boolean }> };
    assert.ok(sub);
    assert.ok(sub.description.length <= 100);
    assert.equal(sub.options.find((o) => o.name === 'link')!.required ?? false, false, 'no link means "read it now"');
    return assert.rejects(run({ admin: false }), userError(/Manage Server/));
  });

  it('links a panel by the airline\'s short name, reads the roster, and says what it found', async () => {
    const reply = await run({ options: { link: 'tst' } });
    assert.deepEqual([panel().fshubAirlineId, panel().fshubAirlineName, panel().fshubNote], [8123, 'Test Air', null]);
    assert.equal(panel().fshubSyncedAt, h.clock.now);
    assert.match(reply, /linked to \*\*Test Air \(TST\)\*\* on FsHub/);
    assert.match(reply, /read \*\*3\*\* pilots/);
    assert.match(reply, /\*\*2\*\* of them have told FsHub their Discord account/);
    assert.match(reply, /\(2 new or updated just now\)/);
    assert.match(reply, /The other 1 will be asked/);
    assert.match(reply, /never replaced/);
    assert.deepEqual(h.store.getPilotLink(USER_A.discordId), { fshubId: 500, name: 'Ann Pilot', source: 'roster' });
    assert.equal(h.store.getPilotLink('222'), null);
  });

  it('links by number or by a link to the airline\'s FsHub page', async () => {
    await run({ options: { link: '8123' } });
    assert.equal(panel().fshubAirlineId, 8123);
    h.store.updatePanel(h.panel.id, { fshubAirlineId: null, fshubAirlineName: null });
    await run({ options: { link: 'https://fshub.io/airline/8123/overview' } });
    assert.equal(panel().fshubAirlineId, 8123);
  });

  it('says so plainly when nobody on the roster has given FsHub a Discord account', async () => {
    fshub.rosters.set(AIRLINE.id, [{ id: 502, name: 'Cara NoDiscord', discordId: null }]);
    const reply = await run({ options: { link: 'TST' } });
    assert.match(reply, /None of them has told FsHub their Discord account/);
  });

  it('refuses without a FsHub token, saying where to add one, and changes nothing', async () => {
    boot(false);
    await assert.rejects(run({ options: { link: 'TST' } }), userError(/access token.*setup page/));
    await assert.rejects(run({}), userError(/access token/));
    assert.equal(panel().fshubAirlineId, null);
  });

  it('can still unlink with no token, keeping the IDs already matched', async () => {
    h.store.updatePanel(h.panel.id, { fshubAirlineId: 8123, fshubAirlineName: 'Test Air', fshubNote: 'old trouble' });
    h.store.applyRosterLinks([{ discordId: USER_A.discordId, fshubId: 500, name: 'Ann Pilot' }], h.clock.now);
    boot(false);
    const reply = await run({ options: { link: 'none' } });
    assert.match(reply, /Stopped reading a FsHub roster/);
    assert.deepEqual([panel().fshubAirlineId, panel().fshubAirlineName, panel().fshubSyncedAt, panel().fshubNote], [null, null, null, null]);
    assert.equal(h.store.getPilotId(USER_A.discordId), 500);
  });

  it('tells the admin which airlines the token belongs to when the name is not one of them', async () => {
    await assert.rejects(run({ options: { link: 'Other Air' } }), userError(/doesn't belong to an airline called "Other Air".*Test Air \(TST\) — number 8123/));
    fshub.mine = [];
    await assert.rejects(run({ options: { link: 'Other Air' } }), userError(/doesn't belong to any airline, so give me the airline's number/));
    assert.equal(panel().fshubAirlineId, null);
  });

  it('refuses a number FsHub does not know', async () => {
    await assert.rejects(run({ options: { link: '777' } }), userError(/no airline with the number \*\*777\*\*/));
    assert.equal(panel().fshubAirlineId, null);
  });

  it('refuses something that is not an airline at all', async () => {
    await assert.rejects(run({ options: { link: 'https://example.com/airline/8123' } }), userError(/couldn't tell which FsHub airline/));
  });

  it('does not leave a panel linked to a roster it cannot read, and explains why', async () => {
    fshub.rosterError = new FsHubError('no-access', "FsHub only shows an airline's roster to its members (or premium accounts), and the saved token's account isn't one for this airline.");
    await assert.rejects(run({ options: { link: 'TST' } }), userError(/couldn't read the roster of \*\*Test Air \(TST\)\*\*: FsHub only shows an airline's roster to its members/));
    assert.deepEqual([panel().fshubAirlineId, panel().fshubSyncedAt, panel().fshubNote], [null, null, null]);
    assert.equal(h.store.getPilotLink(USER_A.discordId), null);
  });

  it('keeps the earlier link when relinking fails', async () => {
    await run({ options: { link: 'TST' } });
    const before = { ...panel() };
    fshub.airlines.set(6000, { id: 6000, name: 'Second Air', abbr: 'SEC' });
    fshub.rosterError = new FsHubError('unavailable', "I couldn't reach FsHub right now.");
    await assert.rejects(run({ options: { link: '6000' } }), userError(/couldn't reach FsHub/));
    assert.deepEqual([panel().fshubAirlineId, panel().fshubAirlineName, panel().fshubSyncedAt, panel().fshubNote], [before.fshubAirlineId, before.fshubAirlineName, before.fshubSyncedAt, before.fshubNote]);
  });

  it('with no link, reads the roster now and says how it went', async () => {
    assert.match(await run({}), /isn't linked to a FsHub airline.*\/setup fshub link:/);
    await run({ options: { link: 'TST' } });
    fshub.rosters.get(8123)!.push({ id: 503, name: 'Dan New', discordId: '555555555555555555' });
    const reply = await run({});
    assert.match(reply, /✅ \*\*Test Air\*\* is linked/);
    assert.match(reply, /read \*\*4\*\* pilots/);
    assert.match(reply, /\(1 new or updated just now\)/);
    fshub.rosterError = new FsHubError('unavailable', "I couldn't reach FsHub right now.");
    assert.match(await run({}), /⚠️ \*\*Test Air\*\* is linked, but I couldn't read its roster: I couldn't reach FsHub right now/);
    assert.match(panel().fshubNote!, /couldn't reach FsHub/);
  });

  it('shows in /setup panels, with any warning, and with a note when the token has gone', async () => {
    const panels = async () => {
      const f = fakeInteraction({ sub: 'panels', admin: true });
      await setup.execute(d.ctx, f.i);
      return String(f.calls.edits.at(-1)?.content ?? '');
    };
    assert.doesNotMatch(await panels(), /FsHub/);
    await run({ options: { link: 'TST' } });
    assert.match(await panels(), /FsHub roster: Test Air \(read <t:\d+:R>\)/);
    h.store.updatePanel(h.panel.id, { fshubNote: 'FsHub is busy' });
    assert.match(await panels(), /FsHub roster: Test Air ⚠️ FsHub is busy/);
    boot(false);
    assert.match(await panels(), /FsHub roster: Test Air \(no FsHub token saved, so it isn't being read\)/);
  });

  it('neutralises a hostile airline name from FsHub wherever it is shown', async () => {
    const hostile = { id: 7000, name: '**Evil** @everyone <@123456789012345678>', abbr: 'EVL' };
    fshub.airlines.set(7000, hostile);
    fshub.rosters.set(7000, []);
    const reply = await run({ options: { link: '7000' } });
    assert.equal(/(^|[^\\])@everyone/.test(reply), false);
    assert.equal(reply.includes('<@123456789012345678>'), false);
    assert.equal(/(^|[^\\])\*\*Evil/.test(reply.replace(/\*\*Test Air\*\*/g, '')), false);
  });
});
