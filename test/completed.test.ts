import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commands } from '../src/discord/commands/index.js';
import type { FlownFlight } from '../src/db/store.js';
import { COLORS, completedCard, embedSize, renderPanel, renderPanelParts } from '../src/discord/ui.js';
import { parseSheetCsv } from '../src/jobs/sheet.js';
import type { SourceJob } from '../src/jobs/types.js';
import { COMPLETED_SHOW_MS } from '../src/services/jobs.js';
import { AIRLINE, CHANNEL, GUILD, HOUR, makeHarness, sj, T0, USER_A, USER_B, type Harness } from './helpers.js';
import { fakeInteraction, FakeUser, makeDiscordHarness, settle, type DiscordHarness, type FakeInteractionOptions, messageText } from './discord-helpers.js';

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
  const panelText = () => d.client.channel(CHANNEL).live.map((m) => messageText(m)).join('\n');

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    d.client.user(new FakeUser(USER_A.discordId, 'alice'));
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  /** The panel's messages as Discord holds them: the open flights, then the completed flights as a panel of their own (the last message). */
  const messages = () => d.client.channel(CHANNEL).live;
  const card = (confirmed?: Map<number, FlownFlight>) => completedCard(h.jobs.completed(pid())[0]!, confirmed).toJSON();
  const boxOf = (c: ReturnType<typeof card>, name: string) => c.fields?.find((f) => f.name === name)?.value;

  it('shows a completed flight as a green card with who flew it, in a panel of its own below the open ones', async () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK', {}, 'Taylor'), flight('b', 'EGLL-EGCC', { aircraft: 'B738' })]);
    await d.panels.refresh(pid());
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK', 'Taylor'), flight('b', 'EGLL-EGCC', { aircraft: 'B738' })]);
    await settle();
    assert.equal(messages().length, 2);
    const [open, doneMessage] = messages().map(messageText) as [string, string];
    assert.match(open, /^TST-002 · B738\n## EGLL ✈ EGCC/m);
    assert.doesNotMatch(open, /^TST-001 ·/m, 'the completed flight is not among the open ones');
    assert.doesNotMatch(open, /Completed in the last 24 hours/);
    assert.match(doneMessage, /^TST-001 · A320\n## EGLL ✈ EGKK\nFLOWN BY: Taylor/m);
    assert.doesNotMatch(doneMessage, /TST-002/, 'and the open flight is not among the completed ones');
    assert.match(doneMessage, /Completed in the last 24 hours\./);
    assert.match(messages()[1]!.payload.embeds[0].toJSON().title, /completed flights/);
    assert.equal(messages()[1]!.payload.embeds[1].toJSON().color, COLORS.success);
  });

  it('names a Discord reservation as the pilot, with the schedule\'s name alongside if it differs', async () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK')]);
    h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK', 'Taylor')]);
    await d.panels.refresh(pid());
    assert.match(panelText(), new RegExp(`FLOWN BY: <@${USER_A.discordId}> · FsHub #1001 \\(Taylor\\)`));
  });

  it('shows a completed flight with nobody named without a FLOWN BY box', () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK')]);
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK')]);
    const c = card();
    assert.equal(c.title, 'TST-001 · A320');
    assert.equal(c.description, '## EGLL ✈ EGKK');
    assert.deepEqual(c.fields ?? [], []);
  });

  it('writes a name from the sheet as plain text, whatever it contains', () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK')]);
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK', '@everyone **bold** <@123456789012345678>')]);
    const text = JSON.stringify(card());
    assert.doesNotMatch(text, /@everyone/);
    assert.doesNotMatch(text, /<@123456789012345678>/);
  });

  it('lists each leg\'s pilot once for a multi-leg flight', () => {
    const m = flight('m', 'EGLL-EGKK-EGCC');
    m.legs[0]!.heldBy = 'Taylor';
    m.legs[1]!.heldBy = 'Jordan';
    h.jobs.sync(pid(), [m]);
    h.jobs.sync(pid(), [{ ...m, closed: true, completed: true }]);
    const c = card();
    assert.equal(c.title, 'TST-001 · 2 legs · A320');
    assert.equal(c.description, '## EGLL ✈ EGKK ✈ EGCC');
    assert.equal(boxOf(c, 'FLOWN BY'), 'Taylor, Jordan');
  });

  it('always has the completed flights panel, and says so when nothing has been completed', async () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK')]);
    await d.panels.refresh(pid());
    assert.equal(messages().length, 2);
    assert.match(messageText(messages()[1]!), /Nothing has been completed in the last 24 hours\./);
    assert.doesNotMatch(panelText(), /Completed in the last 24 hours/);
  });

  it('still says there are no open flights when the only ones listed are completed', () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK')]);
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK', 'Taylor')]);
    const parts = renderPanelParts(h.store.getPanel(pid())!, [], T0, h.jobs.completed(pid()));
    assert.equal(parts.open.length, 1);
    assert.equal(parts.open[0]!.length, 1, 'only the header: no flight cards');
    assert.match(parts.open[0]![0]!.toJSON().description!, /No flights are listed right now\.$/);
    assert.deepEqual(parts.completed[0]!.map((e) => e.toJSON().title ?? '').slice(1), ['TST-001 · A320']);
  });

  it('keeps the original "no flights" message when nothing is open or completed', () => {
    const parts = renderPanelParts(h.store.getPanel(pid())!, [], T0, []);
    assert.match(parts.open[0]![0]!.toJSON().description!, /No flights are listed right now\.$/);
    assert.equal(parts.completed[0]![0]!.toJSON().description, 'Nothing has been completed in the last 24 hours.');
    assert.equal(renderPanel(h.store.getPanel(pid())!, [], T0, []).length, 2);
  });

  it('has the footer once, on the very last card, which is the completed flights', () => {
    const embeds = renderPanel(h.store.getPanel(pid())!, [], T0, []).map((e) => e.toJSON());
    assert.deepEqual(embeds.map((e) => Boolean(e.footer)), [false, true]);
  });

  it('caps the list at two messages and says how many more there are', () => {
    const many = Array.from({ length: 300 }, (_, i) => flight(`f${i}`, 'EGLL-EGKK'));
    h.jobs.sync(pid(), many);
    h.jobs.sync(pid(), many.map((j) => ({ ...j, closed: true, completed: true })));
    const parts = renderPanelParts(h.store.getPanel(pid())!, [], T0, h.jobs.completed(pid()));
    assert.ok(parts.completed.length <= 2);
    for (const message of parts.completed) assert.ok(message.length <= 10 && message.reduce((n, e) => n + embedSize(e), 0) <= 6000);
    const cards = parts.completed.flat().filter((e) => /^TST-\d+ /.test(e.toJSON().title ?? ''));
    assert.ok(cards.length > 10 && cards.length < 300, `${cards.length} shown`);
    const last = parts.completed.at(-1)!.at(-1)!.toJSON();
    assert.match(last.description!, new RegExp(`^…and ${300 - cards.length} more\\.$`));
  });

  it('keeps the completed flights out of the open flights, however long that list is', () => {
    const open = Array.from({ length: 40 }, (_, i) => flight(`o${i}`, 'EGLL-EGKK-EGCC', { notes: 'n'.repeat(150) }));
    const fin = Array.from({ length: 6 }, (_, i) => flight(`d${i}`, 'EGLL-EGCC'));
    h.jobs.sync(pid(), [...open, ...fin]);
    h.jobs.sync(pid(), [...open, ...fin.map((j) => ({ ...j, closed: true, completed: true }))]);
    const parts = renderPanelParts(h.store.getPanel(pid())!, h.jobs.open(pid()), T0, h.jobs.completed(pid()));
    for (const message of [...parts.open, ...parts.completed]) assert.ok(message.reduce((n, e) => n + embedSize(e), 0) <= 6000);
    assert.doesNotMatch(parts.open.flat().map((e) => e.toJSON().description).join('\n'), /Completed in the last 24 hours/);
    assert.equal(parts.completed.flat().filter((e) => /^TST-\d+ /.test(e.toJSON().title ?? '')).length, 6);
  });

  it('drops the completed card a day after it was marked, at the next redraw', async () => {
    h.jobs.sync(pid(), [flight('a', 'EGLL-EGKK'), flight('b', 'EGLL-EGCC')]);
    h.jobs.sync(pid(), [done('a', 'EGLL-EGKK'), flight('b', 'EGLL-EGCC')]);
    await d.panels.refresh(pid());
    assert.match(panelText(), /Completed in the last 24 hours/);
    h.clock.advance(COMPLETED_SHOW_MS + HOUR);
    await d.panels.refresh(pid());
    assert.doesNotMatch(panelText(), /Completed in the last 24 hours/);
    assert.match(messageText(messages().at(-1)!), /Nothing has been completed in the last 24 hours\./);
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
  const panelText = () => d.client.channel(CHANNEL).live.map((m) => messageText(m)).join('\n');

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
    assert.match(panelText(), /Completed in the last 24 hours\.\n\nTST-001 · A320\n## EGLL ✈ EGCC\nFLOWN BY: Taylor/);
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
