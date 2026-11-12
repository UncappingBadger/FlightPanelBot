import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commands } from '../src/discord/commands/index.js';
import { completedBlock, completedLine, MAX_COMPLETED_SHOWN, renderPanel } from '../src/discord/ui.js';
import { parseSheetCsv } from '../src/jobs/sheet.js';
import type { SourceJob } from '../src/jobs/types.js';
import { COMPLETED_SHOW_MS } from '../src/services/jobs.js';
import { AIRLINE, CHANNEL, GUILD, HOUR, makeHarness, sj, T0, USER_A, USER_B, type Harness } from './helpers.js';
import { fakeInteraction, FakeUser, makeDiscordHarness, settle, type DiscordHarness, type FakeInteractionOptions } from './discord-helpers.js';

const HEADER = 'Route,Date,Landing Window Zulu,Landing Window US Central,Pilot,Backup Pilot,Aircraft,Flight Completed (by Pilot),Pilot Paid';
const row = (route: string, day: string, pilot: string, done: string, backup = '') => `${route},${day},0600-2359z,x,${pilot},${backup},A320,${done},FALSE`;

/** A flight that is open for the next day or so, optionally named in the schedule and/or completed. */
const flight = (key: string, chain: string, over: Partial<SourceJob> = {}, heldBy: string | null = null): SourceJob => {
  const base = sj(key, chain, { availableFrom: T0 - HOUR, deadline: T0 + 20 * HOUR, ...over });
  return { ...base, legs: base.legs.map((l) => ({ ...l, heldBy })) };
};
const done = (key: string, chain: string, by: string | null = null, over: Partial<SourceJob> = {}) => flight(key, chain, { closed: true, completed: true, ...over }, by);

/* ------------------------------------------------------------------ reading the checkbox */

describe('the schedule sheet\'s Flight Completed checkbox', () => {
  const read = (...rows: string[]) => parseSheetCsv([HEADER, ...rows].join('\n'), T0).jobs;

  it('marks a ticked row completed and closed, keeping the pilot\'s name', () => {
    const [j] = read(row('EGLL-EGCC', '11/11/2026', 'Taylor', 'TRUE'));
    assert.deepEqual([j!.completed, j!.closed, j!.legs[0]!.heldBy], [true, true, 'Taylor']);
  });

  it('leaves an unticked row open', () => {
    const [j] = read(row('EGLL-EGCC', '11/12/2026', 'Taylor', 'FALSE'));
    assert.deepEqual([j!.completed, j!.closed], [false, false]);
  });

  it('does not call a cancelled flight completed, even though the box is ticked on those rows', () => {
    const [j] = read(row('EGLL-EGCC', '11/12/2026', 'CANCELLED', 'TRUE', 'CANCELLED'));
    assert.deepEqual([j!.completed, j!.closed], [false, true], 'closed, but nobody flew it');
  });

  it('accepts other ways of ticking a box', () => {
    for (const yes of ['true', 'TRUE', 'Yes', 'x', '✓']) assert.equal(read(row('EGLL-EGCC', '11/12/2026', 'Taylor', yes))[0]!.completed, true, yes);
    for (const no of ['', 'FALSE', 'no', '0']) assert.equal(read(row('EGLL-EGCC', '11/12/2026', 'Taylor', no))[0]!.completed, false, no);
  });
});

/* ------------------------------------------------------------------ sync */

describe('syncing completed flights', () => {
  let h: Harness;
  let events: string[];
  const pid = () => h.panel.id;
  const byCode = (code: string) => h.store.listJobs(pid()).find((j) => j.code === code)!;

  beforeEach(async () => {
    h = await makeHarness();
    events = [];
    h.events.subscribe((e) => void events.push(e.type));
  });
  afterEach(async () => {
    await h.close();
  });

  it('turns an open flight into a completed one: off the open list, on the completed list, no one told it was "removed"', () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK')]);
    h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
    events.length = 0;

    const r = h.jobs.sync(pid(), [done('a', 'EGLL-EGKK')]);
    assert.deepEqual([r.completed, r.removed, r.released.length], [1, 0, 0]);
    assert.equal(h.jobs.open(pid()).length, 0);
    assert.deepEqual(h.jobs.completed(pid()).map((v) => v.job.code), ['TST-001']);
    assert.equal(byCode('TST-001').completedAt, T0);
    assert.equal(byCode('TST-001').status, 'expired');
    assert.ok(events.includes('changed'), 'the panel is redrawn');
    assert.ok(!events.includes('released'), 'nobody is sent a "removed" DM');
    assert.equal(h.jobs.completed(pid())[0]!.legs[0]!.holder?.username, 'alice', 'the reservation is kept, to show who flew it');
  });

  it('counts a completion once, however many times the sheet is read', () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK')]);
    assert.equal(h.jobs.sync(pid(), [done('a', 'EGLL-EGKK')]).completed, 1);
    h.clock.advance(3 * HOUR);
    const again = h.jobs.sync(pid(), [done('a', 'EGLL-EGKK')]);
    assert.deepEqual([again.completed, again.updated], [0, 0]);
    assert.equal(byCode('TST-001').completedAt, T0, 'the time it was first seen completed is kept');
  });

  it('does not let anyone reserve a completed flight', () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK')]);
    const id = h.jobs.open(pid())[0]!.job.id;
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK')]);
    assert.throws(() => h.jobs.reserve(id, [1], USER_B), /no longer on the panel/);
    assert.equal(h.jobs.findByCode(h.store.getPanel(pid())!, 'TST-001'), null);
    assert.equal(h.jobs.mine(pid(), USER_A.discordId).length, 0, '"My flights" lists only open flights');
  });

  it('shows a flight that first appears already completed, if it was flown in the last day', () => {
    const r = h.jobs.sync(pid(), [done('x', 'EGLL-EGKK', 'Taylor', { deadline: T0 - 2 * HOUR })]);
    assert.deepEqual([r.added, r.completed], [0, 1], 'counted as completed, not as a new open flight');
    assert.deepEqual(h.jobs.completed(pid()).map((v) => v.job.code), ['TST-001']);
    assert.equal(h.jobs.open(pid()).length, 0);
  });

  it('ignores one that finished long ago, so linking a sheet does not dump its whole history on the panel', () => {
    const r = h.jobs.sync(pid(), [done('old', 'EGLL-EGKK', 'Taylor', { deadline: T0 - 3 * 24 * HOUR })]);
    assert.deepEqual([r.added, r.completed], [0, 0]);
    assert.equal(h.jobs.completed(pid()).length, 0);
    assert.equal(h.store.listJobs(pid()).length, 0, 'not even stored, and no ID used up');
  });

  it('keeps the numbering free of gaps when old completed flights are skipped', () => {
    h.jobs.sync(pid(), [done('old', 'EGLL-EGKK', null, { deadline: T0 - 5 * 24 * HOUR }), flight('new', 'EGLL-EGCC')]);
    assert.deepEqual(h.jobs.open(pid()).map((v) => v.job.code), ['TST-001']);
  });

  it('forgets a completion when the box is unticked, and the flight is open again', () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK')]);
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK')]);
    const r = h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK', { completed: false })]); // a sheet says "not completed" explicitly
    assert.equal(r.updated, 1);
    assert.deepEqual(h.jobs.open(pid()).map((v) => v.job.code), ['TST-001']);
    assert.equal(h.jobs.completed(pid()).length, 0);
    assert.equal(byCode('TST-001').completedAt, null);
  });

  it('stops listing a flight 24 hours after it was marked completed', () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK')]);
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK')]);
    h.clock.advance(COMPLETED_SHOW_MS - 1);
    assert.equal(h.jobs.completed(pid()).length, 1);
    h.clock.advance(2);
    assert.equal(h.jobs.completed(pid()).length, 0);
  });

  it('lists the most recently completed first', () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK'), flight('b', 'EGLL-EGCC'), flight('c', 'EGLL-EGPH')]);
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK'), flight('b', 'EGLL-EGCC'), flight('c', 'EGLL-EGPH')]);
    h.clock.advance(HOUR);
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK'), flight('b', 'EGLL-EGCC'), done('c', 'EGLL-EGPH')]);
    assert.deepEqual(h.jobs.completed(pid()).map((v) => v.job.code), ['TST-003', 'TST-001']);
  });

  it('a flight a source simply drops is still "removed" and holders are told; only completion is quiet', () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK')]);
    h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
    const r = h.jobs.sync(pid(), []);
    assert.deepEqual([r.removed, r.released.length, r.completed], [1, 1, 0]);
    assert.equal(h.jobs.completed(pid()).length, 0);
  });

  it('a completed flight is not asked about by the pilot reminders', async () => {
    const { ReminderService } = await import('../src/services/reminders.js');
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK', { availableFrom: T0 + 2 * HOUR })]);
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK', null, { availableFrom: T0 + 2 * HOUR })]);
    const reminders = new ReminderService(h.store, h.jobs, async () => true, { now: () => h.clock.now });
    assert.deepEqual(reminders.due(h.store.getPanel(pid())!), []);
  });
});

/* ------------------------------------------------------------------ the panel */

describe('completed flights on the panel', () => {
  let h: Harness;
  let d: DiscordHarness;
  const pid = () => h.panel.id;
  const panelText = () => d.client.channel(CHANNEL).live.map((m) => m.payload.embeds[0].toJSON().description as string).join('\n');

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    d.client.user(new FakeUser(USER_A.discordId, 'alice'));
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('shows a completed flight as a ✅ line with who flew it, under the open ones', async () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK', {}, 'Taylor'), flight('b', 'EGLL-EGCC', { aircraft: 'B738' })]);
    await d.panels.refresh(pid());
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK', 'Taylor'), flight('b', 'EGLL-EGCC', { aircraft: 'B738' })]);
    await settle();
    const text = panelText();
    assert.match(text, /\*\*TST-002\*\* · EGLL → EGCC · ✈ B738/);
    assert.match(text, /\*\*✅ Completed in the last 24 hours\*\*\n✅ \*\*TST-001\*\* · EGLL → EGKK · ✈ A320 · flown by Taylor/);
    assert.ok(text.indexOf('TST-002') < text.indexOf('Completed in the last 24 hours'), 'open flights come first');
    assert.doesNotMatch(text, /TST-001\*\*[^\n]*\n[^\n]*complete by/, 'no longer shown as an open flight');
  });

  it('names a Discord reservation as the pilot, with the schedule\'s name alongside if it differs', async () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK')]);
    h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK', 'Taylor')]);
    await d.panels.refresh(pid());
    assert.match(panelText(), new RegExp(`flown by <@${USER_A.discordId}> · FsHub #1001 \\(Taylor\\)`));
  });

  it('shows a completed flight with nobody named, without "flown by"', () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK')]);
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK')]);
    assert.equal(completedLine(h.jobs.completed(pid())[0]!), '✅ **TST-001** · EGLL → EGKK · ✈ A320');
  });

  it('writes a name from the sheet as plain text, whatever it contains', () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK')]);
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK', '@everyone **bold** <@123456789012345678>')]);
    const line = completedLine(h.jobs.completed(pid())[0]!);
    assert.doesNotMatch(line, /@everyone/);
    assert.doesNotMatch(line, /<@123456789012345678>/);
  });

  it('lists each leg\'s pilot once for a multi-leg flight', () => {
    const m = flight('m', 'EGLL-EGKK-EGCC');
    m.legs[0]!.heldBy = 'Taylor';
    m.legs[1]!.heldBy = 'Jordan';
    h.jobs.sync(pid(), [m]);
    h.jobs.sync(pid(), [{ ...m, closed: true, completed: true }]);
    assert.match(completedLine(h.jobs.completed(pid())[0]!), /EGLL → EGKK → EGCC · ✈ A320 · flown by Taylor, Jordan$/);
  });

  it('says nothing about completed flights when there are none', async () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK')]);
    await d.panels.refresh(pid());
    assert.doesNotMatch(panelText(), /Completed in the last 24 hours/);
    assert.equal(completedBlock([]), '');
  });

  it('still says there are no open flights when the only ones listed are completed', () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK')]);
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK', 'Taylor')]);
    const embeds = renderPanel(h.store.getPanel(pid())!, [], T0, h.jobs.completed(pid()));
    const text = embeds[0]!.toJSON().description!;
    assert.match(text, /No flights are listed right now\.\n\n\*\*✅ Completed in the last 24 hours\*\*\n✅ \*\*TST-001\*\*/);
  });

  it('keeps the original "no flights" message when nothing is open or completed', () => {
    const text = renderPanel(h.store.getPanel(pid())!, [], T0, [])[0]!.toJSON().description!;
    assert.match(text, /No flights are listed right now\.$/);
  });

  it('caps the list and says how many more there are', () => {
    const many = Array.from({ length: MAX_COMPLETED_SHOWN + 4 }, (_, i) => flight(`f${i}`, 'EGLL-EGKK'));
    h.jobs.sync(pid(), many);
    h.jobs.sync(pid(), many.map((j) => ({ ...j, closed: true, completed: true })));
    const block = completedBlock(h.jobs.completed(pid()));
    assert.equal((block.match(/✅ \*\*TST-/g) ?? []).length, MAX_COMPLETED_SHOWN);
    assert.match(block, /…and 4 more\.$/);
  });

  it('moves to the next message rather than overflowing a full one', () => {
    const open = Array.from({ length: 40 }, (_, i) => flight(`o${i}`, 'EGLL-EGKK-EGCC', { notes: 'n'.repeat(150) }));
    const fin = Array.from({ length: 6 }, (_, i) => flight(`d${i}`, 'EGLL-EGCC'));
    h.jobs.sync(pid(), [...open, ...fin]);
    h.jobs.sync(pid(), [...open, ...fin.map((j) => ({ ...j, closed: true, completed: true }))]);
    const embeds = renderPanel(h.store.getPanel(pid())!, h.jobs.open(pid()), T0, h.jobs.completed(pid()));
    for (const e of embeds) assert.ok(e.toJSON().description!.length <= 4096);
    assert.match(embeds.map((e) => e.toJSON().description).join('\n'), /Completed in the last 24 hours/);
  });

  it('drops the completed line a day after it was marked, at the next redraw', async () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK'), flight('b', 'EGLL-EGCC')]);
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK'), flight('b', 'EGLL-EGCC')]);
    await d.panels.refresh(pid());
    assert.match(panelText(), /Completed in the last 24 hours/);
    h.clock.advance(COMPLETED_SHOW_MS + HOUR);
    await d.panels.refresh(pid());
    assert.doesNotMatch(panelText(), /Completed in the last 24 hours/);
  });
});

/* ------------------------------------------------------------------ the whole path: sheet -> panel */

describe('ticking the box in a linked sheet', () => {
  const setup = commands.find((c) => c.data.name === 'setup')!;
  const SHEET_ID = 'Q1w2E3r4T5y6U7i8O9p0AaSsDdFfGgHhJjKkLlZz';
  const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=1`;
  const EXPORT = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=1`;
  const SERVED = 'https://doc-0g-34-sheets.googleusercontent.com/export/x';
  let h: Harness;
  let d: DiscordHarness;
  let csv: string;

  const fetchFn = (async (url: string) => {
    if (String(url) === EXPORT) return new Response(null, { status: 307, headers: { location: SERVED } });
    return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } });
  }) as unknown as typeof fetch;
  const guild = { channels: { fetch: async (id: string) => ({ id, permissionsFor: () => ({ has: () => true }) }) }, members: { me: {}, fetchMe: async () => ({}) } };
  const run = async (sub: string, o: FakeInteractionOptions = {}) => {
    const f = fakeInteraction({ sub, admin: true, guild, ...o });
    await setup.execute(d.ctx, f.i);
    await settle();
    return f.calls;
  };
  const text = (calls: { edits: any[] }) => String(calls.edits.at(-1)?.content ?? '');
  const panelText = () => d.client.channel(CHANNEL).live.map((m) => m.payload.embeds[0].toJSON().description as string).join('\n');

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h, { fetchFn });
    h.store.deletePanel(h.panel.id);
    csv = [HEADER, row('EGLL-EGCC', '11/11/2026', 'Taylor', 'FALSE'), row('EGCC-EGLL', '11/12/2026', '', 'FALSE')].join('\n');
    await run('panel-add', { options: { airline: 'Test Air', prefix: 'TST', channel: { id: CHANNEL } } });
    await run('sheet', { options: { link: SHEET_URL } });
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('shows the flight as completed after the next read, and says so in the refresh reply', async () => {
    const panel = h.store.getPanelByName(GUILD, 'Test Air')!;
    assert.deepEqual(h.jobs.open(panel.id).map((v) => v.job.code), ['TST-001', 'TST-002']);
    assert.doesNotMatch(panelText(), /Completed in the last 24 hours/);

    csv = [HEADER, row('EGLL-EGCC', '11/11/2026', 'Taylor', 'TRUE'), row('EGCC-EGLL', '11/12/2026', '', 'FALSE')].join('\n');
    const calls = await run('refresh');
    assert.match(text(calls), /Fetched: 0 new, 1 changed, 0 closed, 1 newly completed\./);
    assert.deepEqual(h.jobs.open(panel.id).map((v) => v.job.code), ['TST-002']);
    assert.match(panelText(), /\*\*✅ Completed in the last 24 hours\*\*\n✅ \*\*TST-001\*\* · EGLL → EGCC · ✈ A320 · flown by Taylor/);
  });

  it('says in the link reply that completed flights are shown, and counts them when linking a sheet that has some', async () => {
    csv = [HEADER, row('EGLL-EGCC', '11/11/2026', 'Taylor', 'TRUE')].join('\n');
    await run('sheet', { options: { link: 'none' } });
    h.store.deletePanel(h.store.getPanelByName(GUILD, 'Test Air')!.id);
    await run('panel-add', { options: { airline: 'Test Air', prefix: 'TST', channel: { id: CHANNEL } } });
    const calls = await run('sheet', { options: { link: SHEET_URL } });
    assert.match(text(calls), /1 shown as completed/);
    assert.match(text(calls), /Flight Completed\* ticked is shown on the panel as ✅ completed for a day/);
  });
});
