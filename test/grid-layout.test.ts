import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { JobView } from '../src/db/store.js';
import { componentHandlers, commands } from '../src/discord/commands/index.js';
import { DETAILS_SHOWN_MS } from '../src/discord/gridHandlers.js';
import {
  buttonLabel,
  DOT,
  FLIGHTS_PER_MESSAGE,
  flightState,
  keyLine,
  LABEL_MAX,
  MAX_GRID_MESSAGES,
  renderGridPanel,
  summaryLine,
  utcLabel,
  type GridFlight,
} from '../src/discord/gridUi.js';
import { UserError } from '../src/discord/errors.js';
import { FOLD_IDLE_MS } from '../src/discord/panel.js';
import { HOUR, T0, USER_A, USER_B, makeHarness, sj, type Harness } from './helpers.js';
import { FakeUser, fakeComponent, fakeInteraction, makeDiscordHarness, messageText, settle, type DiscordHarness, type FakeInteractionOptions } from './discord-helpers.js';

/* Everything below is made up: the pilots, the airline and the flights. */

const MIN = 60_000;
const DAY = 24 * HOUR;
const CHANNEL = '700000000000000001';
const setup = commands.find((c) => c.data.name === 'setup')!;
const panelHandler = componentHandlers.find((h) => h.prefix === 'panel')!;

/* ------------------------------------------------------------------ what a button says */

describe('a moment on a button', () => {
  it('is the weekday, the day, the month and the time, in UTC, ending in Z', () => {
    assert.equal(utcLabel(Date.UTC(2026, 10, 13, 6, 0)), 'Fri 13 Nov 06:00Z');
    assert.equal(utcLabel(Date.UTC(2026, 0, 1, 23, 5)), 'Thu 1 Jan 23:05Z');
    assert.equal(utcLabel(Date.UTC(2026, 11, 31, 0, 0)), 'Thu 31 Dec 00:00Z');
  });
});

describe('what a flight is, by its dot', () => {
  let h: Harness;
  const pid = () => h.panel.id;
  const view = (key: string): JobView => h.jobs.open(pid()).find((v) => v.job.sourceKey === key)!;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it('is yellow when it needs a pilot now, white when it has not opened, blue when taken, green when flown', () => {
    const named = sj('named', 'EGLL-EGKK', { availableFrom: T0 - HOUR });
    named.legs[0]!.heldBy = 'Taylor';
    h.jobs.sync(pid(), [sj('open', 'EGLL-EGKK', { availableFrom: T0 - HOUR }), sj('noStart', 'EGLL-EGKK', { availableFrom: null }), sj('later', 'EGLL-EGKK', { availableFrom: T0 + HOUR }), sj('mine', 'EGLL-EGKK', { availableFrom: T0 - HOUR }), named]);
    h.jobs.reserve(view('mine').job.id, [1], USER_A);
    assert.equal(flightState(view('open'), T0, false), 'open');
    assert.equal(flightState(view('noStart'), T0, false), 'open', 'no start time is open');
    assert.equal(flightState(view('later'), T0, false), 'soon');
    assert.equal(flightState(view('mine'), T0, false), 'taken');
    assert.equal(flightState(view('named'), T0, false), 'taken', 'a pilot named in the airline\'s sheet counts as taken');
    assert.equal(flightState(view('later'), T0, true), 'done', 'flown beats everything');
    h.jobs.reserve(view('later').job.id, [1], USER_B);
    assert.equal(flightState(view('later'), T0, false), 'taken', 'taken before it opens is still taken');
    assert.deepEqual(DOT, { open: '🟡', taken: '🔵', done: '🟢', soon: '⚪' });
  });

  it('says the ID, the aircraft, the route and when it opens, and who has it once it is taken', () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { aircraft: 'A320', availableFrom: Date.UTC(2026, 10, 13, 6, 0) })]);
    assert.equal(buttonLabel(view('a'), 'open'), 'TST-001 · A320 · EGLL✈EGKK · from Fri 13 Nov 06:00Z');
    h.jobs.reserve(view('a').job.id, [1], USER_A);
    assert.equal(buttonLabel(view('a'), 'taken'), 'TST-001 · A320 · EGLL✈EGKK · from Fri 13 Nov 06:00Z · alice');
    assert.equal(buttonLabel(view('a'), 'done'), 'TST-001 · A320 · EGLL✈EGKK · from Fri 13 Nov 06:00Z · alice');
    assert.equal(buttonLabel(view('a'), 'soon'), 'TST-001 · A320 · EGLL✈EGKK · from Fri 13 Nov 06:00Z', 'a flight not open yet shows nobody');
  });

  it('leaves out what it does not have: no start time, no aircraft', () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { aircraft: null, availableFrom: null })]);
    assert.equal(buttonLabel(view('a'), 'open'), 'TST-001 · EGLL✈EGKK');
  });

  it('shows a longer flight as a chain, and a pilot named only in the sheet', () => {
    const j = sj('m', 'EGLL-EGKK-EGCC', { aircraft: 'B738', availableFrom: null });
    j.legs[0]!.heldBy = 'Sam Taylor';
    h.jobs.sync(pid(), [j]);
    assert.equal(buttonLabel(view('m'), 'taken'), 'TST-001 · B738 · EGLL✈EGKK✈EGCC · Sam Taylor');
  });

  it('never goes over 80 characters: the pilot goes first, then the aircraft, then the middle of a long chain', () => {
    const j = sj('long', 'EGLL-EGKK-EGCC-EGPH-EGBB-EGNX-EGSS-EGGD-EGHI-EGTE', { aircraft: 'Boeing 737-800W', availableFrom: Date.UTC(2026, 10, 13, 6, 0) });
    j.legs[0]!.heldBy = 'A Very Long Pilot Name Indeed';
    h.jobs.sync(pid(), [j, sj('mid', 'EGLL-EGKK-EGCC-EGPH-EGBB-EGNX-EGSS', { aircraft: 'Boeing 737-800W', availableFrom: Date.UTC(2026, 10, 13, 6, 0) })]);
    const long = buttonLabel(view('long'), 'taken');
    assert.ok(long.length <= LABEL_MAX, long);
    assert.match(long, /EGLL✈…✈EGTE \(9 legs\)/);
    const mid = buttonLabel(view('mid'), 'open');
    assert.ok(mid.length <= LABEL_MAX, mid);
    assert.doesNotMatch(mid, /Boeing/, 'the aircraft was dropped to make it fit');
    h.jobs.reserve(view('mid').job.id, [1], { discordId: USER_A.discordId, username: 'x'.repeat(60) });
    h.jobs.reserve(view('mid').job.id, [2, 3, 4], { discordId: USER_A.discordId, username: 'x'.repeat(60) });
    const taken = buttonLabel(view('mid'), 'taken');
    assert.ok(taken.length <= LABEL_MAX, taken);
  });

  it('drops only as much as it must: the pilot alone, then the aircraft too', () => {
    const five = 'EGLL-EGKK-EGCC-EGPH-EGBB';
    const seven = 'EGLL-EGKK-EGCC-EGPH-EGBB-EGNX-EGSS';
    const opens = Date.UTC(2026, 10, 13, 6, 0);
    h.jobs.sync(pid(), [sj('five', five, { aircraft: 'A320', availableFrom: opens }), sj('seven', seven, { aircraft: 'Boeing 737-800W', availableFrom: opens })]);
    const named = { discordId: USER_A.discordId, username: 'Pilot Name Here' };
    h.jobs.reserve(view('five').job.id, [1], named);
    h.jobs.reserve(view('seven').job.id, [1], named);
    // 66 characters without the pilot, 83 with: only the pilot goes, the aircraft stays.
    assert.equal(buttonLabel(view('five'), 'taken'), 'TST-001 · A320 · EGLL✈EGKK✈EGCC✈EGPH✈EGBB · from Fri 13 Nov 06:00Z');
    // 84 without the pilot, because of the long aircraft name: the aircraft goes too, and the whole chain stays.
    assert.equal(buttonLabel(view('seven'), 'open'), 'TST-002 · EGLL✈EGKK✈EGCC✈EGPH✈EGBB✈EGNX✈EGSS · from Fri 13 Nov 06:00Z');
  });

  it('is never more than 80 characters, whatever the flight is called', () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { aircraft: 'A320', availableFrom: Date.UTC(2026, 10, 13, 6, 0) })]);
    h.store.setJobCode(view('a').job.id, 'AN-EXTREMELY-LONG-FLIGHT-NUMBER-THAT-AN-AIRLINE-ENTERED-IN-ITS-SHEET-BY-MISTAKE-1234567890');
    const label = buttonLabel(view('a'), 'open');
    assert.equal(label.length, LABEL_MAX);
    assert.ok(label.endsWith('…'));
  });

  it('cuts a pilot\'s name short, and cleans a name of control characters', () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { aircraft: 'A320', availableFrom: null })]);
    h.jobs.reserve(view('a').job.id, [1], { discordId: USER_A.discordId, username: 'Name\nWith\tBreaks And Far Too Long' });
    const label = buttonLabel(view('a'), 'taken');
    assert.doesNotMatch(label, /[\n\t]/);
    assert.ok(label.endsWith('Name With Bre…'), label);
  });

  it('counts a range of flights by kind', () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { availableFrom: T0 - HOUR }), sj('b', 'EGLL-EGCC', { availableFrom: T0 - HOUR }), sj('c', 'EGLL-EGPH', { availableFrom: T0 + HOUR })]);
    h.jobs.reserve(view('b').job.id, [1], USER_A);
    const part: GridFlight[] = [view('a'), view('b'), view('c')].map((v) => ({ view: v, state: flightState(v, T0, false) }));
    assert.equal(summaryLine(part), `**TST-001 – TST-003** · 3 flights · ${DOT.open} 1 open · ${DOT.taken} 1 taken · ${DOT.soon} 1 not open yet`);
    assert.equal(summaryLine([part[0]!]), `**TST-001** · 1 flight · ${DOT.open} 1 open`);
    assert.equal(summaryLine([{ view: part[0]!.view, state: 'done' }]), `**TST-001** · 1 flight · ${DOT.done} 1 completed`);
  });

  it('has a key that says what each dot means, without the green one when completed flights have a channel of their own', () => {
    assert.equal(keyLine(true), '**Key:** 🟡 open · 🔵 taken · 🟢 completed in the last 24 hours · ⚪ not open yet');
    assert.equal(keyLine(false), '**Key:** 🟡 open · 🔵 taken · ⚪ not open yet');
  });
});

/* ------------------------------------------------------------------ the grid, message by message */

describe('the grid panel\'s messages', () => {
  let h: Harness;
  const pid = () => h.panel.id;
  const flightsOf = (n: number, over: Partial<Parameters<typeof sj>[2]> = {}): GridFlight[] => {
    h.jobs.sync(
      pid(),
      Array.from({ length: n }, (_, i) => sj(`k${i}`, 'EGLL-EGKK', { availableFrom: T0 - HOUR, deadline: T0 + (10 + i) * HOUR, aircraft: 'A320', ...over })),
    );
    return h.jobs.open(pid()).map((v) => ({ view: v, state: flightState(v, T0, false) }));
  };
  const panel = () => h.store.getPanel(pid())!;
  const render = (flights: GridFlight[], folded: number[] = [], opts: { later?: number } = {}) => renderGridPanel(panel(), flights, T0, { autoCompletes: false, later: opts.later ?? 0, folded: new Set(folded) });
  const rowsOf = (m: { components: Array<{ toJSON(): any }> }): any[][] => m.components.map((r) => r.toJSON().components as any[]);
  const customIds = (m: { components: Array<{ toJSON(): any }> }) => rowsOf(m).flat().map((c) => String(c.custom_id));

  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it('has 15 flights to a message, five to a row, and never more than Discord allows', () => {
    const { messages, parts } = render(flightsOf(40));
    assert.equal(FLIGHTS_PER_MESSAGE, 15);
    assert.deepEqual([messages.length, parts], [3, 3]);
    for (const m of messages) {
      assert.ok(m.components.length <= 5, 'at most 5 rows');
      assert.ok(rowsOf(m).flat().length <= 25, 'at most 25 buttons');
      assert.ok(rowsOf(m).every((r) => r.length <= 5));
      assert.ok(m.embeds.length >= 1, 'a message with no embed or text cannot be sent');
    }
    const flightButtons = (i: number) => customIds(messages[i]!).filter((id) => id.startsWith('panel:flight:'));
    assert.deepEqual(messages.map((_, i) => flightButtons(i).length), [15, 15, 10]);
  });

  it('puts the panel\'s own buttons on every message, and the fold buttons beside them', () => {
    const { messages } = render(flightsOf(20));
    const first = rowsOf(messages[0]!);
    assert.deepEqual(first[0]!.map((c) => c.custom_id), [`panel:reserve:${pid()}`, `panel:search:${pid()}`, `panel:backup:${pid()}`, `panel:mine:${pid()}`, `panel:complete:${pid()}`]);
    assert.deepEqual(first[1]!.map((c) => c.label), ['List view', 'Collapse', 'Collapse all', 'Expand all']);
    assert.deepEqual(first[1]!.map((c) => c.custom_id), [`panel:list:${pid()}`, `panel:fold:${pid()}:0`, `panel:foldall:${pid()}`, `panel:unfoldall:${pid()}`]);
    const second = rowsOf(messages[1]!);
    assert.deepEqual(second[0]!.map((c) => c.custom_id.split(':')[1]), ['reserve', 'search', 'backup', 'mine', 'complete']);
    assert.deepEqual(second[1]!.map((c) => c.custom_id), [`panel:fold:${pid()}:1`], 'only its own fold button');
  });

  it('draws a flight as a grey button with its dot, and a custom ID that names the panel and the flight', () => {
    const flights = flightsOf(2);
    const { messages } = render(flights);
    const buttons = rowsOf(messages[0]!).flat().filter((c) => String(c.custom_id).startsWith('panel:flight:'));
    assert.deepEqual(buttons.map((b) => b.custom_id), flights.map((f) => `panel:flight:${pid()}:${f.view.job.id}`));
    assert.ok(buttons.every((b) => b.style === 2 && b.emoji.name === DOT.open));
    assert.equal(buttons[0].label, 'TST-001 · A320 · EGLL✈EGKK · from Wed 11 Nov 11:00Z');
  });

  it('shows the header on the first message only, with the key above when it was updated', () => {
    const { messages } = render(flightsOf(20));
    const text = messages[0]!.embeds[0]!.toJSON().description!;
    const lines = text.split('\n');
    const key = lines.findIndex((l) => l.startsWith('**Key:**'));
    const updated = lines.findIndex((l) => l.startsWith('Updated'));
    assert.ok(key > 0 && updated > key, 'the key is above the update time');
    assert.match(lines[0]!, /Press a flight to see its details\.$/);
    assert.equal(messages[0]!.embeds.length, 1);
    assert.equal(messages[1]!.embeds[0]!.toJSON().title, undefined, 'the second message has no header');
    assert.match(messages[1]!.embeds[0]!.toJSON().description!, /^\*\*TST-016 – TST-020\*\* · 5 flights/);
  });

  it('says there are no flights, with the panel\'s buttons still there', () => {
    const { messages, parts } = render([]);
    assert.deepEqual([messages.length, parts], [1, 0]);
    assert.match(messages[0]!.embeds[0]!.toJSON().description!, /No flights are listed right now\./);
    assert.deepEqual(rowsOf(messages[0]!)[1]!.map((c) => c.label), ['List view'], 'nothing to fold');
  });

  it('folds a message to one line: the first keeps its header and buttons, the others keep only Expand', () => {
    const { messages } = render(flightsOf(20), [0, 1]);
    const first = messages[0]!;
    assert.equal(first.embeds.length, 2, 'the header, then the summary');
    assert.match(first.embeds[1]!.toJSON().description!, /^\*\*TST-001 – TST-015\*\* · 15 flights/);
    assert.deepEqual(customIds(first).filter((id) => id.startsWith('panel:flight:')), []);
    assert.equal(rowsOf(first)[0]![0].custom_id, `panel:reserve:${pid()}`, 'Reserve stays');
    assert.deepEqual(rowsOf(first)[1]!.map((c) => c.label), ['List view', 'Expand', 'Collapse all', 'Expand all']);
    const second = messages[1]!;
    assert.deepEqual(rowsOf(second).map((r) => r.map((c) => c.label)), [['Expand']], 'only an Expand button');
    assert.equal(second.embeds.length, 1);
  });

  it('keeps a message that is not folded as it was, whatever the others do', () => {
    const open = render(flightsOf(20));
    const folded = render(flightsOf(20), [0]);
    assert.deepEqual(JSON.stringify(folded.messages[1]!.components.map((c) => c.toJSON())), JSON.stringify(open.messages[1]!.components.map((c) => c.toJSON())));
  });

  it('draws the completed flights as green buttons after the others, unless they have a channel of their own', () => {
    const flights = flightsOf(2);
    const done: GridFlight = { view: { ...flights[0]!.view }, state: 'done' };
    const { messages } = render([...flights, done]);
    const emojis = rowsOf(messages[0]!).flat().filter((c) => String(c.custom_id).startsWith('panel:flight:')).map((c) => c.emoji.name);
    assert.deepEqual(emojis, [DOT.open, DOT.open, DOT.done]);
    assert.match(messages[0]!.embeds[0]!.toJSON().description!, /🟢 completed in the last 24 hours/);

    h.store.updatePanel(pid(), { completedChannelId: '800000000000000001' });
    const split = render(flights);
    const text = split.messages[0]!.embeds[0]!.toJSON().description!;
    assert.doesNotMatch(text, /🟢/);
    assert.match(text, /Completed flights are in <#800000000000000001>\./);
  });

  it('is never more than ten messages, and counts the flights it could not show', () => {
    const { messages } = render(flightsOf(MAX_GRID_MESSAGES * FLIGHTS_PER_MESSAGE + 7));
    assert.equal(messages.length, MAX_GRID_MESSAGES);
    const notes = messages[messages.length - 1]!.embeds.map((e) => e.toJSON().description ?? '');
    assert.ok(notes.some((n) => /…and 7 more flights not shown\./.test(n)), notes.join(' | '));
  });

  it('says how many flights start later than the panel\'s days', () => {
    const { messages } = render(flightsOf(3), [], { later: 4 });
    const notes = messages[messages.length - 1]!.embeds.map((e) => e.toJSON().description ?? '');
    assert.ok(notes.some((n) => /4 more flights start more than 7 days from now/.test(n)), notes.join(' | '));
  });

  it('ends with the disclaimer, on the very last embed', () => {
    const { messages } = render(flightsOf(40), [2]);
    const last = messages[messages.length - 1]!.embeds;
    assert.match(last[last.length - 1]!.toJSON().footer!.text, /Unofficial companion bot/);
    assert.equal(messages[0]!.embeds.some((e) => e.toJSON().footer), false);
  });
});

/* ------------------------------------------------------------------ in the channel */

describe('a grid panel in Discord', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  const pid = () => h.panel.id;
  const channel = () => d.client.channel(CHANNEL);
  const rowsOf = (m: { payload: { components: Array<{ toJSON(): any }> } }): any[][] => m.payload.components.map((r) => r.toJSON().components as any[]);
  const labels = (m: { payload: { components: Array<{ toJSON(): any }> } }): string[] => rowsOf(m).flat().map((c) => String(c.label));
  const flightLabels = (m: { payload: { components: Array<{ toJSON(): any }> } }) => rowsOf(m).flat().filter((c) => String(c.custom_id).startsWith('panel:flight:')).map((c) => String(c.label));
  const jobId = (key: string) => h.store.listJobs(pid()).find((j) => j.sourceKey === key)!.id;
  const sync = (n: number) => h.jobs.sync(pid(), Array.from({ length: n }, (_, i) => sj(`k${i}`, 'EGLL-EGKK', { availableFrom: T0 - HOUR, deadline: T0 + (10 + i) * HOUR, aircraft: 'A320' })));
  const grid = async () => {
    h.store.updatePanel(pid(), { layout: 'grid' });
    await d.panels.refresh(pid());
  };
  const press = async (id: string, user: FakeUser = alice, o: Parameters<typeof fakeComponent>[2] = {}) => {
    const f = fakeComponent(user, id, o);
    await panelHandler.handle(d.ctx, f.i);
    await settle(40);
    return f.calls;
  };

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
  });
  afterEach(async () => {
    mock.timers.reset();
    await settle(40);
    await h.close();
  });

  it('is drawn as cards by default, and nothing about the existing panel changes', async () => {
    sync(3);
    await d.panels.refresh(pid());
    assert.equal(h.store.getPanel(pid())!.layout, 'cards');
    const m = channel().live[0]!;
    assert.ok(m.payload.embeds.length >= 4, 'a header and a card for each flight');
    assert.deepEqual(rowsOf(m)[0]!.map((c) => c.label), ['Reserve', 'Search', 'Backup pilot', 'My flights', 'Complete']);
    assert.equal(labels(m).some((l) => /Collapse|Expand/.test(l)), false);
  });

  it('is drawn as a grid when the server chose that, in messages of 15 flights', async () => {
    sync(20);
    await grid();
    assert.equal(channel().live.length, 2);
    assert.equal(flightLabels(channel().live[0]!).length, 15);
    assert.equal(flightLabels(channel().live[1]!).length, 5);
    assert.match(messageText(channel().live[0]!), /\*\*Key:\*\* 🟡 open · 🔵 taken · 🟢 completed in the last 24 hours · ⚪ not open yet/);
  });

  it('shows who has a flight on its button, and a blue dot', async () => {
    sync(2);
    h.jobs.reserve(jobId('k0'), [1], USER_A);
    await grid();
    const buttons = rowsOf(channel().live[0]!).flat().filter((c) => String(c.custom_id).startsWith('panel:flight:'));
    assert.equal(buttons[0].emoji.name, DOT.taken);
    assert.match(buttons[0].label, / · alice$/);
    assert.equal(buttons[1].emoji.name, DOT.open);
  });

  it('shows a flight flown in the last day as a green button, and the full card in a channel of their own when there is one', async () => {
    sync(2);
    h.jobs.reserve(jobId('k0'), [1], USER_A);
    h.jobs.complete(jobId('k0'), USER_A.discordId);
    await grid();
    const greens = rowsOf(channel().live[0]!).flat().filter((c) => c.emoji?.name === DOT.done);
    assert.equal(greens.length, 1);
    assert.match(greens[0].label, /TST-001 .* · alice$/);

    h.store.updatePanel(pid(), { completedChannelId: '800000000000000002' });
    await d.panels.refresh(pid(), { force: true });
    assert.equal(rowsOf(channel().live[0]!).flat().some((c) => c.emoji?.name === DOT.done), false, 'no green buttons in the grid');
    const completed = d.client.channel('800000000000000002').live;
    assert.ok(completed.length >= 1);
    assert.match(messageText(completed[0]!), /completed flights/);
    assert.match(messageText(completed[0]!), /FLOWN BY/, 'the card as ever');
  });

  describe('folding', () => {
    beforeEach(async () => {
      sync(20);
      await grid();
    });

    it('folds the message whose button was pressed, to one line, and puts it back when pressed again', async () => {
      const c = await press(`panel:fold:${pid()}:1`);
      assert.equal(c.updates.length + (c.defers.length > 0 ? 0 : 0), 0, 'the message is redrawn, not answered');
      const second = channel().live[1]!;
      assert.deepEqual(labels(second), ['Expand']);
      assert.match(messageText(second), /TST-016 – TST-020/);
      assert.equal(flightLabels(channel().live[0]!).length, 15, 'the first message was not touched');
      await press(`panel:fold:${pid()}:1`);
      assert.equal(flightLabels(channel().live[1]!).length, 5);
      assert.ok(labels(channel().live[1]!).includes('Collapse'));
    });

    it('lets anyone fold and anyone unfold: it is the same message for everyone', async () => {
      await press(`panel:fold:${pid()}:0`, alice);
      assert.equal(flightLabels(channel().live[0]!).length, 0);
      await press(`panel:fold:${pid()}:0`, bob);
      assert.equal(flightLabels(channel().live[0]!).length, 15);
    });

    it('folds every message with Collapse all, and unfolds them with Expand all', async () => {
      await press(`panel:foldall:${pid()}`);
      assert.deepEqual(channel().live.map((m) => flightLabels(m).length), [0, 0]);
      assert.deepEqual(labels(channel().live[1]!), ['Expand']);
      assert.ok(labels(channel().live[0]!).includes('Reserve'), 'Reserve is still there');
      await press(`panel:unfoldall:${pid()}`);
      assert.deepEqual(channel().live.map((m) => flightLabels(m).length), [15, 5]);
    });

    it('keeps a fold through the panel\'s ordinary redraws, with the counts brought up to date', async () => {
      await press(`panel:fold:${pid()}:1`);
      h.jobs.reserve(jobId('k17'), [1], USER_A);
      await d.panels.refresh(pid());
      assert.match(messageText(channel().live[1]!), /🔵 1 taken/);
      assert.deepEqual(labels(channel().live[1]!), ['Expand']);
    });

    it('unfolds by itself when nobody has pressed any button on the panel for ten minutes', async () => {
      await press(`panel:foldall:${pid()}`);
      assert.equal(FOLD_IDLE_MS, 10 * MIN);
      h.clock.advance(10 * MIN - 1000);
      d.panels.run();
      await settle(60);
      assert.deepEqual(channel().live.map((m) => flightLabels(m).length), [0, 0], 'not yet');
      h.clock.advance(2000);
      d.panels.run();
      await settle(60);
      assert.deepEqual(channel().live.map((m) => flightLabels(m).length), [15, 5], 'now');
    });

    it('starts the ten minutes again with every button pressed on the panel, whatever it is', async () => {
      await press(`panel:foldall:${pid()}`);
      h.clock.advance(9 * MIN);
      await press(`panel:flight:${pid()}:${jobId('k0')}`, bob); // someone looks at a flight
      h.clock.advance(9 * MIN);
      d.panels.run();
      await settle(60);
      assert.deepEqual(channel().live.map((m) => flightLabels(m).length), [0, 0], '18 minutes after folding but 9 after the last press');
      h.clock.advance(2 * MIN);
      d.panels.run();
      await settle(60);
      assert.deepEqual(channel().live.map((m) => flightLabels(m).length), [15, 5]);
    });

    it('starts the ten minutes again whenever a message is folded, not only the first', async () => {
      d.panels.setFold(pid(), 0, true);
      h.clock.advance(9 * MIN);
      d.panels.setFold(pid(), 1, true);
      h.clock.advance(2 * MIN);
      d.panels.run();
      await settle(60);
      assert.deepEqual([...d.panels.foldsOf(pid())].sort(), [0, 1], 'two minutes after the last fold, so still folded');
      h.clock.advance(9 * MIN);
      d.panels.run();
      assert.equal(d.panels.foldsOf(pid()).size, 0);
    });

    it('has nothing to unfold when nothing is folded, and does not redraw for it', async () => {
      await settle(100);
      const before = channel().live.map((m) => m.edits.length);
      h.clock.advance(HOUR);
      d.panels.run();
      await settle(60);
      assert.deepEqual(channel().live.map((m) => m.edits.length), before);
    });

    it('refuses an old button, a wrong server and a panel that is cards again', async () => {
      await assert.rejects(press(`panel:fold:${pid()}:x`), (e: unknown) => e instanceof UserError && /out of date/.test(e.message));
      await assert.rejects(press(`panel:fold:${pid()}:1`, alice, { guildId: '123' }), (e: unknown) => e instanceof UserError && /gone/.test(e.message));
      await assert.rejects(press(`panel:fold:9999:1`), (e: unknown) => e instanceof UserError && /gone/.test(e.message));
      h.store.updatePanel(pid(), { layout: 'cards' });
      await assert.rejects(press(`panel:fold:${pid()}:1`), (e: unknown) => e instanceof UserError && /drawn as cards/.test(e.message));
    });
  });

  describe('pressing a flight', () => {
    beforeEach(async () => {
      sync(4);
      h.jobs.reserve(jobId('k1'), [1], USER_B);
      h.jobs.addBackup(jobId('k1'), { discordId: '333333333333333333', username: 'carol' });
      d.client.user(new FakeUser('333333333333333333', 'carol'));
      await grid();
    });

    it('shows its card to the person who pressed it, and to no one else, with the OPEN stamp on a flight that needs a pilot', async () => {
      const c = await press(`panel:flight:${pid()}:${jobId('k0')}`);
      assert.deepEqual(c.defers, [{ flags: 64 }], 'ephemeral: only the one who pressed it sees it');
      const reply = c.edits.at(-1);
      const embed = reply.embeds[0].toJSON();
      assert.equal(embed.title, 'TST-001 · A320');
      assert.match(embed.description, /EGLL ✈ EGKK/);
      assert.equal(embed.thumbnail?.url, 'attachment://open-stamp.png');
      assert.equal(reply.files.length, 1, 'the stamp is attached');
      const fields = Object.fromEntries(embed.fields.map((f: any) => [f.name, f.value]));
      assert.match(fields['COMPLETE BY'], /<t:\d+:F>/, 'the full date and time, in each reader\'s own timezone');
      assert.equal(fields['PILOT'], '*open*');
    });

    it('shows a taken flight with its pilot\'s picture and its backup', async () => {
      const reply = (await press(`panel:flight:${pid()}:${jobId('k1')}`)).edits.at(-1);
      const embed = reply.embeds[0].toJSON();
      assert.match(embed.thumbnail.url, /^https:\/\/cdn\.test\/avatars\/222222222222222222\.png/);
      assert.match(embed.author.name, /Backup · carol/);
      assert.deepEqual(reply.files, []);
      assert.match(Object.fromEntries(embed.fields.map((f: any) => [f.name, f.value]))['PILOT'], /<@222222222222222222>/);
    });

    it('shows a flight that has been flown as its completed card', async () => {
      h.jobs.reserve(jobId('k2'), [1], USER_A);
      h.jobs.complete(jobId('k2'), USER_A.discordId);
      await d.panels.refresh(pid());
      const reply = (await press(`panel:flight:${pid()}:${jobId('k2')}`)).edits.at(-1);
      const embed = reply.embeds[0].toJSON();
      assert.match(embed.title, /^TST-003/);
      assert.ok(embed.fields.some((f: any) => f.name === 'FLOWN BY'));
      assert.equal(embed.color, 0x2ecc71);
    });

    it('says so, and asks the panel to redraw, for a flight that is no longer there', async () => {
      h.jobs.sync(pid(), []);
      const c = await press(`panel:flight:${pid()}:${jobId('k0')}`);
      assert.match(c.edits.at(-1).content, /no longer on the panel/);
      const c2 = await press(`panel:flight:${pid()}:99999`);
      assert.match(c2.edits.at(-1).content, /no longer on the panel/);
    });

    it('does not show a flight of another panel', async () => {
      const other = h.store.createPanel({ guildId: '900000000000000001', name: 'Other Air', abbr: 'OTH', prefix: 'OTH', channelId: '700000000000000009', now: T0 });
      h.store.updatePanel(other.id, { layout: 'grid' });
      const c = await press(`panel:flight:${other.id}:${jobId('k0')}`);
      assert.match(c.edits.at(-1).content, /no longer on the panel/);
    });

    it('takes the first card away when the same person presses another flight', async () => {
      const first = await press(`panel:flight:${pid()}:${jobId('k0')}`);
      assert.equal(first.deletes, 0);
      await press(`panel:flight:${pid()}:${jobId('k3')}`);
      assert.equal(first.deletes, 1, 'the first one was closed');
    });

    it('leaves another person\'s card alone', async () => {
      const a = await press(`panel:flight:${pid()}:${jobId('k0')}`, alice);
      await press(`panel:flight:${pid()}:${jobId('k3')}`, bob);
      assert.equal(a.deletes, 0);
    });

    it('takes the card away by itself after 90 seconds', async () => {
      // Timers are faked only around the press, and nothing here waits on a real one.
      mock.timers.enable({ apis: ['setTimeout'] });
      const f = fakeComponent(alice, `panel:flight:${pid()}:${jobId('k0')}`);
      await panelHandler.handle(d.ctx, f.i);
      assert.equal(DETAILS_SHOWN_MS, 90_000);
      mock.timers.tick(DETAILS_SHOWN_MS - 1);
      await Promise.resolve();
      assert.equal(f.calls.deletes, 0);
      mock.timers.tick(2);
      for (let i = 0; i < 4; i++) await Promise.resolve();
      assert.equal(f.calls.deletes, 1);
      mock.timers.reset();
    });
  });
});

/* ------------------------------------------------------------------ /setup layout */

describe('/setup layout', () => {
  let h: Harness;
  let d: DiscordHarness;
  const pid = () => h.panel.id;
  const channel = () => d.client.channel(CHANNEL);
  const run = async (o: FakeInteractionOptions = {}) => {
    const f = fakeInteraction({ sub: 'layout', admin: true, ...o });
    await setup.execute(d.ctx, f.i);
    await settle(60);
    return String(f.calls.edits.at(-1)?.content ?? '');
  };

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    h.jobs.sync(pid(), Array.from({ length: 3 }, (_, i) => sj(`k${i}`, 'EGLL-EGKK', { availableFrom: T0 - HOUR, deadline: T0 + (10 + i) * HOUR })));
    await d.panels.refresh(pid());
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('is cards or grid, an optional panel, and a description Discord accepts', () => {
    const sub = (setup.data.toJSON().options ?? []).find((o) => o.name === 'layout') as unknown as { description: string; options: Array<{ name: string; choices?: Array<{ value: string }> }> };
    assert.ok(sub && sub.description.length <= 100);
    assert.deepEqual(sub.options.find((o) => o.name === 'mode')!.choices!.map((c) => c.value), ['cards', 'grid']);
    assert.ok(sub.options.some((o) => o.name === 'airline'));
  });

  it('keeps the whole /setup command inside what Discord allows', () => {
    const json = setup.data.toJSON();
    assert.ok((json.options ?? []).length <= 25);
    const weigh = (o: any): number => (o.name?.length ?? 0) + (o.description?.length ?? 0) + (typeof o.value === 'string' ? o.value.length : 0) + [...(o.options ?? []), ...(o.choices ?? [])].reduce((n: number, c: any) => n + weigh(c), 0);
    assert.ok(weigh(json) < 8000, `${weigh(json)}`);
  });

  it('shows cards as the setting a panel starts with, and says what the grid is', async () => {
    const reply = await run();
    assert.doesNotMatch(reply, /^Done/);
    assert.match(reply, /drawn as \*\*cards\*\*, one for each flight \(the default\)/);
    assert.match(reply, /`\/setup layout mode:grid`/);
    assert.equal(h.store.getPanel(pid())!.layout, 'cards');
  });

  it('switches to the grid, redraws the panel at once, and explains how it works', async () => {
    const reply = await run({ options: { mode: 'grid' } });
    assert.match(reply, /^Done\. The \*\*Test Air\*\* panel is drawn as a \*\*grid of buttons\*\*/);
    assert.match(reply, /\*\*Collapse\*\*.*Anyone can fold or unfold.*10 minutes/s);
    assert.match(reply, /Pressing a flight shows its card to that person only/);
    assert.equal(h.store.getPanel(pid())!.layout, 'grid');
    const m = channel().live[0]!;
    assert.ok(m.payload.components.some((r: any) => r.toJSON().components.some((c: any) => String(c.custom_id).startsWith('panel:flight:'))));
    assert.equal(m.payload.embeds.length, 1, 'no cards any more');
  });

  it('goes back to cards, redrawn at once, and forgets any folds', async () => {
    await run({ options: { mode: 'grid' } });
    d.panels.setAllFolds(pid(), true);
    const reply = await run({ options: { mode: 'cards' } });
    assert.match(reply, /^Done\. The \*\*Test Air\*\* panel is drawn as \*\*cards\*\*/);
    assert.equal(d.panels.foldsOf(pid()).size, 0);
    assert.ok(channel().live[0]!.payload.embeds.length >= 4);
  });

  it('says nothing was done when it is already so, and does not redraw', async () => {
    await run({ options: { mode: 'grid' } });
    const edits = channel().live.map((m) => m.edits.length);
    assert.doesNotMatch(await run({ options: { mode: 'grid' } }), /^Done/);
    assert.deepEqual(channel().live.map((m) => m.edits.length), edits);
  });

  it('names the completed flights\' channel when there is one, and is for admins only', async () => {
    h.store.updatePanel(pid(), { completedChannelId: '800000000000000002' });
    assert.match(await run({ options: { mode: 'grid' } }), /which are in <#800000000000000002> as cards instead/);
    await assert.rejects(run({ admin: false, options: { mode: 'cards' } }), (e: unknown) => e instanceof UserError && /Manage Server/.test(e.message));
    assert.equal(h.store.getPanel(pid())!.layout, 'grid');
  });

  it('refuses a layout it does not know, at the store too', async () => {
    await assert.rejects(run({ options: { mode: 'tiles' } }), (e: unknown) => e instanceof UserError && /cards or grid/.test(e.message));
    assert.throws(() => h.store.updatePanel(pid(), { layout: 'tiles' as never }), /cards or a grid/);
  });
});
