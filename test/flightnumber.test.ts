import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { componentHandlers } from '../src/discord/commands/index.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { openCard, renderPanelParts } from '../src/discord/ui.js';
import { parseSheetCsv } from '../src/jobs/sheet.js';
import { normalizeFlightNumber } from '../src/jobs/types.js';
import { CHANNEL, HOUR, T0, USER_A, makeHarness, sj, type Harness } from './helpers.js';
import { FakeUser, fakeComponent, fakeDm, makeDiscordHarness, messageText, settle, type DiscordHarness } from './discord-helpers.js';

const HEADER = 'Flight Number,Route,Date,Landing Window Zulu,Pilot,Aircraft,Flight Completed (by Pilot)';
const row = (number: string, route: string, day = '11/12/2026', pilot = '') => `${number},${route},${day},0600-2359z,${pilot},A320,FALSE`;
const read = (...rows: string[]) => parseSheetCsv([HEADER, ...rows].join('\n'), T0);

describe('flight numbers on the schedule sheet', () => {
  it('reads the Flight Number column, tidied (upper case, no spaces)', () => {
    const { jobs, warnings } = read(row(' sky 123 ', 'EGLL-EGKK'), row('SKY-014', 'EGKK-EGCC'));
    assert.deepEqual(jobs.map((j) => j.flightNumber), ['SKY123', 'SKY-014']);
    assert.deepEqual(warnings, []);
  });

  it('finds the column under the other names an airline might give it', () => {
    for (const name of ['Flight No', 'Flight No.', 'Flight #', 'Flight ID', 'Flight Num', 'Flt No', 'Flight']) {
      const csv = [`${name},Route,Date,Landing Window Zulu,Pilot,Aircraft,Flight Completed (by Pilot)`, row('SKY123', 'EGLL-EGKK')].join('\n');
      assert.equal(parseSheetCsv(csv, T0).jobs[0]!.flightNumber, 'SKY123', name);
    }
  });

  it('does not mistake the Flight Completed column for it', () => {
    const csv = ['Route,Date,Landing Window Zulu,Pilot,Aircraft,Flight Completed (by Pilot)', 'EGLL-EGKK,11/12/2026,0600-2359z,,A320,TRUE'].join('\n');
    assert.equal(parseSheetCsv(csv, T0).jobs[0]!.flightNumber ?? null, null);
  });

  it('has no flight numbers when the sheet has no such column (as before)', () => {
    const csv = ['Route,Date,Landing Window Zulu,Pilot,Aircraft', 'EGLL-EGKK,11/12/2026,0600-2359z,,A320'].join('\n');
    const { jobs, warnings } = parseSheetCsv(csv, T0);
    assert.equal(jobs[0]!.flightNumber ?? null, null);
    assert.deepEqual(warnings, []);
  });

  it('leaves a flight with an empty cell on the automatic ID, without a warning', () => {
    const { jobs, warnings } = read(row('SKY123', 'EGLL-EGKK'), row('', 'EGKK-EGCC'));
    assert.deepEqual(jobs.map((j) => j.flightNumber), ['SKY123', null]);
    assert.deepEqual(warnings, []);
  });

  it("refuses a number that has anything but letters, numbers and dashes, or is too long, and says which row", () => {
    const { jobs, warnings } = read(row('SKY*1', 'EGLL-EGKK'), row('<@123456789012345678>', 'EGKK-EGCC'), row('A'.repeat(17), 'EGCC-EGPH'), row('SKY_9', 'EGPH-EGLL'));
    assert.deepEqual(jobs.map((j) => j.flightNumber), [null, null, null, null]);
    assert.equal(warnings.filter((w) => /can't be used as an ID/.test(w)).length, 4);
    assert.match(warnings[0]!, /^row 2 \(EGLL-EGKK\): the flight number "SKY\*1" can't be used as an ID/);
  });

  it('puts the day on the end of a number that is on several rows (the same flight on several days), in the aviation style', () => {
    const { jobs, warnings } = read(row('SKY123', 'EGLL-EGKK', '11/12/2026'), row('sky 123', 'EGLL-EGKK', '11/13/2026'), row('SKY123', 'EGLL-EGKK', '2026-12-05'), row('SKY200', 'EGKK-EGCC'));
    assert.deepEqual(jobs.map((j) => j.flightNumber), ['SKY123-12NOV', 'SKY123-13NOV', 'SKY123-05DEC', 'SKY200'], 'only the repeated number gets a day');
    assert.deepEqual(warnings, [], 'that is how it is meant to work, so nothing to report');
  });

  it('takes the day from the row\'s date, whatever the landing window does', () => {
    const csv = [HEADER, `SKY9,EGLL-EGKK,11/20/2026, 1200 - 0600z,,A320,FALSE`, `SKY9,EGLL-EGKK,11/21/2026,not a window,,A320,FALSE`].join('\n');
    assert.deepEqual(parseSheetCsv(csv, T0).jobs.map((j) => j.flightNumber), ['SKY9-20NOV', 'SKY9-21NOV']);
  });

  it('keeps a number that is on one row as it is, however many other numbers repeat', () => {
    const { jobs } = read(row('SKY-014', 'EGLL-EGKK', '11/12/2026'), row('SKY123', 'EGKK-EGCC', '11/12/2026'), row('SKY123', 'EGKK-EGCC', '11/13/2026'));
    assert.deepEqual(jobs.map((j) => j.flightNumber), ['SKY-014', 'SKY123-12NOV', 'SKY123-13NOV']);
  });

  it('cannot tell two flights apart that have the same number on the same day, so neither uses it, and says so', () => {
    const { jobs, warnings } = read(row('SKY123', 'EGLL-EGKK', '11/12/2026'), row('SKY123', 'EGKK-EGCC', '11/12/2026'), row('SKY200', 'EGCC-EGPH'));
    assert.deepEqual(jobs.map((j) => j.flightNumber), [null, null, 'SKY200']);
    assert.ok(warnings.some((w) => /the flight number SKY123-12NOV is on 2 rows even with the day added, so those flights keep their automatic IDs/.test(w)), warnings.join(' | '));
  });

  it('does not let a dated number take the ID another row already has', () => {
    const { jobs, warnings } = read(row('SKY123', 'EGLL-EGKK', '11/12/2026'), row('SKY123', 'EGLL-EGKK', '11/13/2026'), row('SKY123-12NOV', 'EGKK-EGCC', '11/14/2026'));
    assert.deepEqual(jobs.map((j) => j.flightNumber), [null, 'SKY123-13NOV', null]);
    assert.ok(warnings.some((w) => /SKY123-12NOV is on 2 rows/.test(w)), warnings.join(' | '));
  });

  it('normalises as documented', () => {
    assert.equal(normalizeFlightNumber(' wa 101 '), 'WA101');
    assert.equal(normalizeFlightNumber('SKY-014'), 'SKY-014');
    for (const bad of ['', '   ', '-SKY', 'SKY#1', 'a'.repeat(17), 'SKY.1', '**x**']) assert.equal(normalizeFlightNumber(bad), null, JSON.stringify(bad));
  });
});

describe('a flight number as the flight\'s ID', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });
  const pid = () => h.panel.id;
  const code = (key: string) => h.store.listJobs(pid()).find((j) => j.sourceKey === key)!.code;
  const numbered = (key: string, chain: string, flightNumber: string | null, over = {}) => sj(key, chain, { flightNumber, deadline: T0 + 48 * HOUR, ...over });

  it('is the ID when the flight has one, and the automatic ID (TST-001...) when it does not', () => {
    h.jobs.sync(pid(), [numbered('a', 'EGLL-EGKK', 'SKY123'), numbered('b', 'EGKK-EGCC', null), numbered('c', 'EGCC-EGPH', 'SKY-014'), numbered('d', 'EGPH-EGLL', null)]);
    assert.deepEqual(['a', 'b', 'c', 'd'].map(code), ['SKY123', 'TST-001', 'SKY-014', 'TST-002'], 'the automatic counter is not used up by numbered flights');
  });

  it('keeps flights without a number exactly as before when no flight has one', () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK'), sj('b', 'EGKK-EGCC')]);
    assert.deepEqual(['a', 'b'].map(code), ['TST-001', 'TST-002']);
  });

  it('replaces the automatic ID of a flight the bot already knew once the sheet gets a number for it, keeping its reservations', () => {
    h.jobs.sync(pid(), [numbered('a', 'EGLL-EGKK', null)]);
    const view = h.jobs.open(pid())[0]!;
    h.jobs.reserve(view.job.id, [1], USER_A);
    assert.equal(code('a'), 'TST-001');
    const result = h.jobs.sync(pid(), [numbered('a', 'EGLL-EGKK', 'SKY123')]);
    assert.equal(code('a'), 'SKY123');
    assert.equal(result.updated, 1, 'counts as a change, so the panel is redrawn');
    assert.equal(h.jobs.open(pid())[0]!.legs[0]!.holder?.discordId, USER_A.discordId, 'the reservation is still theirs');
    assert.equal(h.jobs.open(pid())[0]!.job.id, view.job.id, 'the same flight');
  });

  it('follows a number that is changed in the sheet, and keeps the ID if the number is taken away', () => {
    h.jobs.sync(pid(), [numbered('a', 'EGLL-EGKK', 'SKY123')]);
    h.jobs.sync(pid(), [numbered('a', 'EGLL-EGKK', 'SKY124')]);
    assert.equal(code('a'), 'SKY124');
    h.jobs.sync(pid(), [numbered('a', 'EGLL-EGKK', null)]);
    assert.equal(code('a'), 'SKY124', 'IDs do not change back and forth');
  });

  it('never gives two flights on a panel the same ID: the second keeps its own, and the clash is reported', () => {
    h.jobs.sync(pid(), [numbered('a', 'EGLL-EGKK', 'SKY123')]);
    const result = h.jobs.sync(pid(), [numbered('a', 'EGLL-EGKK', 'SKY123'), numbered('b', 'EGKK-EGCC', 'SKY123')]);
    assert.deepEqual(result.numberClashes, ['SKY123']);
    assert.deepEqual([code('a'), code('b')], ['SKY123', 'TST-001']);
    // a number that clashes with an automatic ID is refused the same way
    const clash = h.jobs.sync(pid(), [numbered('a', 'EGLL-EGKK', 'SKY123'), numbered('b', 'EGKK-EGCC', 'SKY123'), numbered('c', 'EGCC-EGPH', 'TST-001')]);
    assert.deepEqual(clash.numberClashes, ['SKY123', 'TST-001']);
    assert.equal(code('c'), 'TST-002');
  });

  it('skips an automatic ID a flight number is already using', () => {
    h.jobs.sync(pid(), [numbered('a', 'EGLL-EGKK', 'TST-001'), numbered('b', 'EGKK-EGCC', null)]);
    assert.deepEqual([code('a'), code('b')], ['TST-001', 'TST-002']);
    h.jobs.sync(pid(), [numbered('a', 'EGLL-EGKK', 'TST-001'), numbered('b', 'EGKK-EGCC', null), numbered('c', 'EGCC-EGPH', null)]);
    assert.equal(code('c'), 'TST-003');
  });

  it('is found by typing it in any case with or without spaces, and the automatic forms still work', () => {
    h.jobs.sync(pid(), [numbered('a', 'EGLL-EGKK', 'SKY123'), numbered('b', 'EGKK-EGCC', null), numbered('c', 'EGCC-EGPH', 'SKY-014')]);
    const find = (typed: string) => h.jobs.findByCode(h.panel, typed)?.job.sourceKey ?? null;
    assert.deepEqual(['SKY123', 'sky123', ' sky 123 ', 'SKY-014', 'sky-014'].map(find), ['a', 'a', 'a', 'c', 'c']);
    assert.deepEqual(['TST-001', 'tst1', '1'].map(find), ['b', 'b', 'b'], 'the automatic ID keeps its shorter forms');
    assert.equal(find('SKY999'), null);
  });

  it('gives each day of a repeated number its own ID, found by typing it however it is written', () => {
    const csv = [HEADER, row('SKY123', 'EGLL-EGKK', '11/12/2026'), row('SKY123', 'EGLL-EGKK', '11/13/2026'), row('', 'EGKK-EGCC', '11/12/2026')].join('\n');
    h.jobs.sync(pid(), parseSheetCsv(csv, T0).jobs);
    assert.deepEqual(h.store.listJobs(pid()).map((j) => j.code), ['SKY123-12NOV', 'SKY123-13NOV', 'TST-001']);
    const find = (typed: string) => h.jobs.findByCode(h.panel, typed)?.job.code ?? null;
    assert.deepEqual(['sky123-12nov', ' SKY 123-13 NOV ', 'SKY123'].map(find), ['SKY123-12NOV', 'SKY123-13NOV', null], 'the plain number is no longer one flight');
  });

  it('is tried before the shorter forms of an automatic ID, so a flight numbered 1 is flight 1', () => {
    h.jobs.sync(pid(), [numbered('a', 'EGLL-EGKK', '1'), numbered('b', 'EGKK-EGCC', null)]);
    assert.equal(h.jobs.findByCode(h.panel, '1')?.job.sourceKey, 'a');
    assert.equal(h.jobs.findByCode(h.panel, 'TST-001')?.job.sourceKey, 'b');
  });
});

describe('flight numbers on the panel and in the Reserve conversation', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  const pid = () => h.panel.id;
  const csv = [HEADER, row('SKY123', 'EGLL-EGKK', '11/11/2026'), row('', 'EGKK-EGCC', '11/11/2026')].join('\n');

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    h.jobs.sync(pid(), parseSheetCsv(csv, T0).jobs);
    await d.panels.refresh(pid());
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it("shows the flight number as the card's ID, and the automatic ID on a flight without one", () => {
    const titles = renderPanelParts(h.panel, h.jobs.open(pid()), T0).open.flat().map((e) => e.toJSON().title ?? '');
    assert.ok(titles.some((t) => t.startsWith('SKY123 · ')), titles.join(' | '));
    assert.ok(titles.some((t) => t.startsWith('TST-001 · ')), titles.join(' | '));
    assert.match(openCard(h.jobs.open(pid())[0]!, T0).toJSON().title!, /^SKY123 · /);
  });

  it('gives a real ID from the panel as the example, in the panel text and in the DM', async () => {
    const panelText = d.client.channel(CHANNEL).live.map(messageText).join('\n');
    assert.match(panelText, /\(like `SKY123`\)/);
    const press = fakeComponent(alice, `panel:reserve:${pid()}`, {});
    await componentHandlers.find((x) => x.prefix === 'panel')!.handle(d.ctx, press.i);
    assert.match(alice.lastText, /for example `SKY123`/);
  });

  it('reserves by the flight number, however it is typed', async () => {
    const press = fakeComponent(alice, `panel:reserve:${pid()}`, {});
    await componentHandlers.find((x) => x.prefix === 'panel')!.handle(d.ctx, press.i);
    await handleDmMessage(d.ctx, fakeDm(alice, ' sky 123 '));
    const view = h.jobs.open(pid()).find((v) => v.job.code === 'SKY123')!;
    assert.equal(view.legs[0]!.holder?.discordId, alice.id);
    assert.match(alice.lastText, /SKY123/);
  });

  it('says what an ID looks like using a real one when it cannot find what was typed', async () => {
    const press = fakeComponent(alice, `panel:reserve:${pid()}`, {});
    await componentHandlers.find((x) => x.prefix === 'panel')!.handle(d.ctx, press.i);
    await handleDmMessage(d.ctx, fakeDm(alice, 'NOPE999'));
    assert.match(alice.lastText, /I can't find an open flight with the ID `NOPE999`\. IDs look like `SKY123`/);
  });
});
