import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { componentHandlers } from '../src/discord/commands/index.js';
import { openCard } from '../src/discord/ui.js';
import { JobError } from '../src/services/jobs.js';
import { CHANNEL, HOUR, T0, USER_A, USER_B, USER_C, makeHarness, sj, type Harness } from './helpers.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { FakeUser, fakeComponent, fakeDm, makeDiscordHarness, messageText, settle, type DiscordHarness } from './discord-helpers.js';

const DAY = 24 * HOUR;

describe('who can be the backup for a flight', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());
  const pid = () => h.panel.id;
  const view = (key: string) => h.jobs.open(pid()).find((v) => v.job.sourceKey === key)!;
  const problem = (key: string, user = USER_B) => h.jobs.backupProblem(view(key), user.discordId);
  const named = (key: string, chain: string, name: string) => {
    const j = sj(key, chain);
    j.legs[0]!.heldBy = name;
    return j;
  };

  it('is for a flight that is already taken: until then it can simply be reserved', () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
    assert.match(problem('a')!, /^TST-001 still has a leg nobody has, so you can reserve it instead of backing it up\.$/);
    h.jobs.reserve(view('a').job.id, [1], USER_A);
    assert.equal(problem('a'), null);
  });

  it('counts a flight the airline\'s own schedule names a pilot for as taken', () => {
    h.jobs.sync(pid(), [named('s', 'EGLL-EGKK', 'Taylor')]);
    assert.equal(problem('s'), null);
  });

  it('needs every leg of a longer flight taken, by anyone', () => {
    h.jobs.sync(pid(), [sj('m', 'EGLL-EGKK-EGCC')]);
    h.jobs.reserve(view('m').job.id, [1], USER_A);
    assert.match(problem('m')!, /still has a leg nobody has/);
    h.jobs.reserve(view('m').job.id, [2], USER_C);
    assert.equal(problem('m'), null, 'two pilots between them have it all');
  });

  it("can't be the pilot who is flying it", () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
    h.jobs.reserve(view('a').job.id, [1], USER_A);
    assert.match(problem('a', USER_A)!, /^You are flying TST-001 yourself, so you can't also be its backup\.$/);
  });

  it('is one pilot a flight', () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
    h.jobs.reserve(view('a').job.id, [1], USER_A);
    h.jobs.addBackup(view('a').job.id, USER_B);
    assert.equal(problem('a', USER_C), 'TST-001 already has a backup pilot.');
    assert.equal(problem('a', USER_B), 'You are already down as backup for TST-001.');
  });

  it('is not for a flight that is over', () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { deadline: T0 + HOUR })]);
    h.jobs.reserve(view('a').job.id, [1], USER_A);
    const v = view('a');
    h.clock.advance(2 * HOUR);
    assert.match(h.jobs.backupProblem(v, USER_B.discordId)!, /no longer open/);
  });
});

describe('putting a pilot down as backup', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
    h.jobs.reserve(h.jobs.open(h.panel.id)[0]!.job.id, [1], USER_A);
  });
  afterEach(() => h.close());
  const pid = () => h.panel.id;
  const jobId = () => h.jobs.open(pid())[0]!.job.id;

  it('shows the backup on the flight, and redraws the panel', () => {
    const before = h.emitted.length;
    const v = h.jobs.addBackup(jobId(), USER_B);
    assert.equal(v.backup?.discordId, USER_B.discordId);
    assert.equal(h.jobs.open(pid())[0]!.backup?.discordId, USER_B.discordId);
    assert.deepEqual(h.emitted.slice(before), [{ type: 'changed', panelId: pid() }]);
  });

  it('refuses a second backup, with the reason', () => {
    h.jobs.addBackup(jobId(), USER_B);
    assert.throws(() => h.jobs.addBackup(jobId(), USER_C), (e: unknown) => e instanceof JobError && /already has a backup pilot/.test(e.message));
    assert.equal(h.jobs.open(pid())[0]!.backup?.discordId, USER_B.discordId, 'the first one stays');
  });

  it('refuses a flight that is not on the panel any more', () => {
    const id = jobId();
    h.jobs.sync(pid(), []);
    assert.throws(() => h.jobs.addBackup(id, USER_B), JobError);
  });

  it('lets only the backup stand down, and redraws the panel', () => {
    h.jobs.addBackup(jobId(), USER_B);
    assert.equal(h.jobs.removeBackup(jobId(), USER_C.discordId), false);
    const before = h.emitted.length;
    assert.equal(h.jobs.removeBackup(jobId(), USER_B.discordId), true);
    assert.equal(h.jobs.open(pid())[0]!.backup, null);
    assert.deepEqual(h.emitted.slice(before), [{ type: 'changed', panelId: pid() }]);
    assert.equal(h.jobs.removeBackup(jobId(), USER_B.discordId), false, 'nothing left to stand down from');
  });

  it('lists a pilot\'s own backups', () => {
    h.jobs.addBackup(jobId(), USER_B);
    assert.deepEqual(h.jobs.myBackups(pid(), USER_B.discordId).map((v) => v.job.code), ['TST-001']);
    assert.deepEqual(h.jobs.myBackups(pid(), USER_C.discordId), []);
  });

  it('offers only flights the panel lists and the pilot could back up', () => {
    h.jobs.sync(pid(), [
      sj('a', 'EGLL-EGKK'),
      sj('free', 'EGKK-EGCC'), // nobody has it
      sj('far', 'EGCC-EGPH', { availableFrom: T0 + 10 * DAY, deadline: T0 + 11 * DAY }), // beyond the days
    ]);
    const far = h.jobs.open(pid()).find((v) => v.job.sourceKey === 'far')!;
    h.jobs.reserve(far.job.id, [1], USER_A);
    assert.deepEqual(h.jobs.backupCandidates(h.panel, USER_B.discordId).map((v) => v.job.sourceKey), ['a']);
    assert.deepEqual(h.jobs.backupCandidates(h.panel, USER_A.discordId), [], 'not their own');
    h.store.updatePanel(pid(), { showDays: 7 });
  });
});

describe('when the flight goes away or is given back', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());
  const pid = () => h.panel.id;
  const ended = () => h.emitted.filter((e) => e.type === 'backup-ended').map((e: any) => [e.notice.discordId, e.notice.jobCode, e.notice.reason]);
  const setup = (chain = 'EGLL-EGKK') => {
    h.jobs.sync(pid(), [sj('a', chain)]);
    const v = h.jobs.open(pid())[0]!;
    h.jobs.reserve(v.job.id, v.legs.map((l) => l.legNo), USER_A);
    h.jobs.addBackup(v.job.id, USER_B);
    return v.job.id;
  };

  it('tells the backup, and ends their spot, when the pilot gives the whole flight back', () => {
    const id = setup();
    h.jobs.release(id, USER_A.discordId);
    assert.deepEqual(ended(), [[USER_B.discordId, 'TST-001', 'freed']]);
    assert.equal(h.jobs.view(id)!.backup, null);
  });

  it('keeps the backup while someone is still flying part of it', () => {
    const id = setup('EGLL-EGKK-EGCC');
    h.jobs.release(id, USER_A.discordId, [2]);
    assert.deepEqual(ended(), []);
    assert.equal(h.jobs.view(id)!.backup?.discordId, USER_B.discordId);
    h.jobs.release(id, USER_A.discordId, [1]);
    assert.deepEqual(ended(), [[USER_B.discordId, 'TST-001', 'freed']]);
  });

  it('does the same when an admin frees the flight', () => {
    setup();
    h.jobs.adminRelease(h.panel, 'TST-001');
    assert.deepEqual(ended(), [[USER_B.discordId, 'TST-001', 'freed']]);
  });

  it('does the same when the airline changes the route and the pilot loses it', () => {
    const id = setup();
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGCC')]);
    assert.deepEqual(ended(), [[USER_B.discordId, 'TST-001', 'freed']]);
    assert.equal(h.jobs.view(id)!.backup, null);
  });

  it('tells the backup the flight is no longer listed when it is removed', () => {
    setup();
    h.jobs.sync(pid(), []);
    assert.deepEqual(ended(), [[USER_B.discordId, 'TST-001', 'removed']]);
  });

  it('leaves a backup alone when the flight is simply updated', () => {
    const id = setup();
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { aircraft: 'B738' })]);
    assert.deepEqual(ended(), []);
    assert.equal(h.jobs.view(id)!.backup?.discordId, USER_B.discordId);
  });

  it('goes with the flight when it is finally cleared out', () => {
    const id = setup();
    h.jobs.sync(pid(), []);
    h.clock.advance(30 * DAY);
    h.jobs.cleanup();
    assert.equal(h.store.getJob(id), null);
    const raw = (h.store as unknown as { db: { prepare(sql: string): { get(): { n: number } } } }).db;
    assert.equal(raw.prepare('SELECT count(*) AS n FROM job_backups').get().n, 0);
  });
});

describe('the Backup pilot button and the DM that asks for the flight', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  const pid = () => h.panel.id;
  const press = async (user: FakeUser, customId: string, o: { values?: string[]; roles?: string[]; admin?: boolean; guildId?: string | null } = {}) => {
    const f = fakeComponent(user, customId, o);
    await componentHandlers.find((x) => x.prefix === customId.split(':')[0])!.handle(d.ctx, f.i);
    return f.calls;
  };
  const say =(user: FakeUser, text: string) => handleDmMessage(d.ctx, fakeDm(user, text));
  const jobId = (key: string) => h.store.listJobs(pid()).find((j) => j.sourceKey === key)!.id;
  const backupOf = (key: string) => h.jobs.open(pid()).find((v) => v.job.sourceKey === key)!.backup ?? null;
  const panelText = () => d.client.channel(CHANNEL).live.map(messageText).join('\n');
  const session = (user: FakeUser) => h.store.getSession(user.id, h.clock.now);

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    h.jobs.sync(pid(), [sj('taken', 'EGLL-EGKK'), sj('free', 'EGKK-EGCC')]);
    h.jobs.reserve(jobId('taken'), [1], USER_A);
    await d.panels.refresh(pid());
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('says so when there is nothing to back up, and starts no conversation', async () => {
    const calls = await press(alice, `panel:backup:${pid()}`);
    assert.deepEqual(calls.defers[0], { flags: 64 });
    assert.match(calls.edits[0].content, /There's no flight for you to be backup for right now/);
    assert.equal(calls.edits[0].components, undefined);
    assert.equal(alice.dms.length, 0);
    assert.equal(session(alice), null);
  });

  it('sends a DM asking for the flight ID, as Reserve does, and tells you privately to look there', async () => {
    const calls = await press(bob, `panel:backup:${pid()}`);
    assert.deepEqual(calls.defers[0], { flags: 64 }, 'only the person who pressed sees the answer');
    assert.match(calls.edits[0].content, /^📬 I've sent you a DM\. Reply there with the ID of the flight you want to stand by for\.\nhttps:\/\/discord\.com\/channels\/@me\/dm-/);
    assert.equal(calls.edits[0].components, undefined, 'no menu: the flight is typed in the DM');

    assert.equal(bob.dms.length, 1);
    assert.match(bob.lastText, /^\*\*Stand by as backup for Test Air\.\*\*\n/);
    assert.match(bob.lastText, /Reply with the ID of the flight you'd fly if the pilot who has it can't, for example `TST-001`\./);
    assert.match(bob.lastText, /already taken, and not one you're flying yourself/);
    assert.match(bob.lastText, /Say `cancel` to stop\. This conversation closes in 10 minutes\.$/);
    assert.deepEqual(bob.last.allowedMentions, { parse: [] });
    assert.deepEqual([session(bob)?.purpose, session(bob)?.step, session(bob)?.panelId], ['backup', 'await_code', pid()]);
  });

  it('puts the pilot down for the flight they reply with, and the panel shows who the backup is', async () => {
    await press(bob, `panel:backup:${pid()}`);
    await say(bob, 'tst001'); // forms of the ID work as they do for Reserve
    assert.match(bob.lastText, /^🛟 You're down as backup for \*\*TST-001\*\* \(EGLL → EGKK\)\. The panel shows your name\. If the pilot gives it back I'll tell you, and you can stand down any time from \*\*My flights\*\*\.$/);
    assert.deepEqual(bob.last.allowedMentions, { parse: [] });
    assert.equal(session(bob), null, 'the conversation is over');
    assert.equal(backupOf('taken')?.discordId, USER_B.discordId);
    assert.deepEqual(h.store.listReservationsByUser(pid(), USER_B.discordId), [], 'being backup is not a reservation');
    assert.equal(h.jobs.open(pid()).find((v) => v.job.sourceKey === 'taken')!.legs[0]!.holder?.discordId, USER_A.discordId, 'the pilot still has the flight');
    await settle(1700);
    assert.match(panelText(), new RegExp(`^BACKUP: <@${USER_B.discordId}> · FsHub #1002$`, 'm'));
    const card = openCard(h.jobs.open(pid()).find((v) => v.job.sourceKey === 'taken')!, T0).toJSON();
    assert.deepEqual(card.fields!.map((f) => f.name), ['COMPLETE BY', 'PILOT', 'BACKUP']);
  });

  it('asks for the FsHub pilot ID first from someone who has not given it, then for the flight', async () => {
    const dave = d.client.user(new FakeUser('444444444444444444', 'dave'));
    const calls = await press(dave, `panel:backup:${pid()}`);
    assert.match(calls.edits[0].content, /Reply there with your FsHub pilot ID, then the ID of the flight you want to stand by for\./);
    assert.match(dave.lastText, /^\*\*Stand by as backup for Test Air\.\*\* First, what is your FsHub pilot ID\?/);
    assert.equal(session(dave)?.step, 'await_pilot');

    await say(dave, '4321');
    assert.match(dave.lastText, /^Thanks, I've saved your FsHub pilot ID as .*4321.*\./);
    assert.match(dave.lastText, /\*\*Stand by as backup for Test Air\.\*\*\nReply with the ID of the flight you'd fly if the pilot who has it can't, for example `TST-001`\./);
    assert.deepEqual([session(dave)?.purpose, session(dave)?.step], ['backup', 'await_code']);

    await say(dave, 'TST-001');
    assert.match(dave.lastText, /^🛟 You're down as backup for \*\*TST-001\*\*/);
    assert.equal(backupOf('taken')?.discordId, '444444444444444444');
  });

  it("says why a flight can't be backed up and lets them try another ID in the same conversation", async () => {
    await press(bob, `panel:backup:${pid()}`);
    await say(bob, 'TST-002');
    assert.match(bob.lastText, /^TST-002 still has a leg nobody has, so you can reserve it instead of backing it up\.\nSend a different flight ID, or say `cancel`\.$/);
    assert.equal(session(bob)?.step, 'await_code', 'still open');
    assert.equal(backupOf('free'), null);

    await say(bob, 'TST-001');
    assert.match(bob.lastText, /^🛟 You're down as backup for \*\*TST-001\*\*/);
    assert.equal(session(bob), null);
  });

  it("will not make you the backup for a flight you fly, or one that already has a backup", async () => {
    h.jobs.reserve(jobId('free'), [1], USER_C); // TST-002 is taken, by carol, so alice has something to back up
    await press(alice, `panel:backup:${pid()}`);
    assert.equal(session(alice)?.purpose, 'backup');
    await say(alice, 'TST-001');
    assert.match(alice.lastText, /^You are flying TST-001 yourself, so you can't also be its backup\./);
    h.jobs.addBackup(jobId('free'), USER_B);
    await say(alice, 'TST-002');
    assert.match(alice.lastText, /^TST-002 already has a backup pilot\./);
    assert.equal(backupOf('taken'), null);
  });

  it('says so when the ID is not a flight, and closes after a few tries like Reserve does, naming the right button', async () => {
    await press(bob, `panel:backup:${pid()}`);
    await say(bob, 'nonsense');
    assert.match(bob.lastText, /^I can't find an open flight with the ID `nonsense`\. IDs look like `TST-001` and are listed on the panel\. Try again, or say `cancel`\.$/);
    for (let i = 0; i < 3; i++) await say(bob, 'nonsense');
    assert.equal(session(bob)?.attempts, 4);
    await say(bob, 'nonsense');
    assert.match(bob.lastText, /^That's a few IDs I couldn't find, so I've closed this\. Press \*\*Backup pilot\*\* on the panel to start again\.$/);
    assert.equal(session(bob), null);
  });

  it('can be cancelled, and then nothing has changed', async () => {
    await press(bob, `panel:backup:${pid()}`);
    await say(bob, 'cancel');
    assert.match(bob.lastText, /^Okay, cancelled\. Press \*\*Backup pilot\*\* on the panel whenever you want to start again\.$/);
    assert.equal(session(bob), null);
    await say(bob, 'TST-001');
    assert.match(bob.lastText, /press \*\*Reserve\*\* on a flight panel/, 'a flight ID with no conversation open reserves nothing');
    assert.equal(backupOf('taken'), null);
  });

  it('says the flight is not there when it has gone from the schedule since the button was pressed', async () => {
    await press(bob, `panel:backup:${pid()}`);
    h.jobs.sync(pid(), [sj('free', 'EGKK-EGCC')]); // TST-001 has gone from the schedule
    await say(bob, 'TST-001');
    assert.match(bob.lastText, /^I can't find an open flight with the ID `TST-001`/);
    assert.equal(session(bob)?.purpose, 'backup', 'and they can try another');
  });

  it('is taken as backup by someone else first: the DM says so and nothing is overwritten', async () => {
    await press(bob, `panel:backup:${pid()}`);
    h.jobs.addBackup(jobId('taken'), USER_C);
    await say(bob, 'TST-001');
    assert.match(bob.lastText, /^TST-001 already has a backup pilot\.\nSend a different flight ID, or say `cancel`\.$/);
    assert.equal(backupOf('taken')?.discordId, USER_C.discordId);
  });

  it("takes a flight beyond the panel's days when its ID is typed, as Reserve does", async () => {
    h.jobs.sync(pid(), [sj('taken', 'EGLL-EGKK'), sj('far', 'EGLL-LFMN', { availableFrom: T0 + 10 * DAY, deadline: T0 + 11 * DAY })]);
    h.jobs.reserve(jobId('far'), [1], USER_C);
    await press(bob, `panel:backup:${pid()}`);
    const far = h.jobs.open(pid()).find((v) => v.job.sourceKey === 'far')!.job.code;
    await say(bob, far);
    assert.match(bob.lastText, new RegExp(`^🛟 You're down as backup for \\*\\*${far}\\*\\*`));
  });

  it('is replaced by a Reserve conversation when you press Reserve instead', async () => {
    await press(bob, `panel:backup:${pid()}`);
    await press(bob, `panel:reserve:${pid()}`);
    assert.equal(session(bob)?.purpose, 'reserve');
    await say(bob, 'TST-002');
    assert.match(bob.lastText, /^✅ \*\*TST-002\*\*/);
    assert.equal(backupOf('taken'), null);
  });

  it('is limited to the role that can reserve, like Reserve is', async () => {
    h.store.updatePanel(pid(), { requiredRoleId: '555555555555555555' });
    await assert.rejects(press(bob, `panel:backup:${pid()}`, { roles: [] }), /Standing by for flights of \*\*Test Air\*\* is limited to members with the <@&555555555555555555> role/);
    assert.equal(bob.dms.length, 0);
    const ok = await press(bob, `panel:backup:${pid()}`, { roles: ['555555555555555555'] });
    assert.match(ok.edits[0].content, /I've sent you a DM/);
    assert.equal(session(bob)?.purpose, 'backup');
  });

  it('explains how to allow DMs when they are closed, and leaves no conversation open', async () => {
    bob.failDms = true;
    await assert.rejects(press(bob, `panel:backup:${pid()}`), /I couldn't send you a DM\. Allow direct messages from server members .* press \*\*Backup pilot\*\* again\./);
    assert.equal(session(bob), null);
  });

  it('refuses a panel that is gone, or from another server', async () => {
    await assert.rejects(press(bob, `panel:backup:${pid()}`, { guildId: '123' }), /no longer active/);
    h.store.deletePanel(pid());
    await assert.rejects(press(bob, `panel:backup:${pid()}`), /no longer active/);
  });

  it('has no menu any more: an old backup menu still on a pilot\'s screen is told it is out of date', async () => {
    await assert.rejects(press(bob, `panel:backuppick:${pid()}`, { values: [String(jobId('taken'))] }), /That button is out of date\./);
    assert.equal(backupOf('taken'), null);
  });

  it('shows in My flights, and standing down from there takes the name off the panel', async () => {
    h.jobs.addBackup(jobId('taken'), USER_B);
    const mine = await press(bob, `panel:mine:${pid()}`);
    assert.doesNotMatch(mine.edits[0].content, /haven't reserved anything/);
    assert.match(mine.edits[0].content, /\*\*TST-001\*\* · EGLL → EGKK[^\n]*\n↳ 🛟 You're the backup/);
    const menu = mine.edits[0].components[0].toJSON().components[0];
    assert.deepEqual(menu.options.map((o: any) => o.value), [`b:${jobId('taken')}`]);
    assert.equal(menu.placeholder, 'Release a flight or stand down…');

    const down = await press(bob, `panel:release:${pid()}`, { values: [`b:${jobId('taken')}`] });
    assert.match(down.edits[0].content, /^You're no longer the backup for TST-001\.$/);
    assert.equal(h.jobs.open(pid()).find((v) => v.job.sourceKey === 'taken')!.backup, null);
  });

  it('can stand down and give back a flight in the same go', async () => {
    h.jobs.reserve(jobId('free'), [1], USER_B);
    h.jobs.addBackup(jobId('taken'), USER_B);
    const down = await press(bob, `panel:release:${pid()}`, { values: [`${jobId('free')}:1`, `b:${jobId('taken')}`] });
    assert.match(down.edits[0].content, /Released: TST-002 leg 1\./);
    assert.match(down.edits[0].content, /You're no longer the backup for TST-001\./);
  });

  it("is told by a direct message when the pilot gives the flight back, and when it is dropped from the schedule", async () => {
    h.jobs.addBackup(jobId('taken'), USER_B);
    await press(alice, `panel:release:${pid()}`, { values: [`${jobId('taken')}:1`] });
    await settle();
    assert.match(bob.lastText, /^Heads up: nobody is flying \*\*TST-001\*\* any more, and you were down as its backup\. Your backup spot has ended, and the flight is open again: press \*\*Reserve\*\* on the panel if you want it\.$/);
    assert.deepEqual(bob.last.allowedMentions, { parse: [] });

    h.jobs.reserve(jobId('taken'), [1], USER_A);
    h.jobs.addBackup(jobId('taken'), USER_B);
    h.jobs.sync(pid(), [sj('free', 'EGKK-EGCC')]);
    await settle();
    assert.match(bob.lastText, /^Heads up: flight \*\*TST-001\*\*, which you were down as backup for, is no longer listed, so your backup spot has ended\.$/);
  });

  it('does not fail when the backup has direct messages closed', async () => {
    h.jobs.addBackup(jobId('taken'), USER_B);
    bob.failDms = true;
    await press(alice, `panel:release:${pid()}`, { values: [`${jobId('taken')}:1`] });
    await settle();
    assert.equal(h.jobs.open(pid()).find((v) => v.job.sourceKey === 'taken')!.backup, null, 'the spot still ended');
  });
});
