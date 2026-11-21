import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { componentHandlers } from '../src/discord/commands/index.js';
import { handleDmMessage, MAX_ATTEMPTS } from '../src/discord/dm.js';
import { parseScheduleValues } from '../src/jobs/sheet.js';
import { flightIdChunks, MAX_ID_WORDS } from '../src/services/flightIds.js';
import { andList, beyondDaysManyText, JobError, MAX_IDS_AT_ONCE } from '../src/services/jobs.js';
import { SheetWriteBack } from '../src/services/writeback.js';
import { SheetsApi } from '../src/google/sheetsApi.js';
import { tokenProvider } from '../src/google/serviceAccount.js';
import { FakeGoogle, makeServiceAccount, SHEET_ID, TAB_GID } from './fake-google.js';
import { HOUR, makeHarness, sj, T0, USER_A, USER_B, type Harness } from './helpers.js';
import { fakeComponent, fakeDm, FakeUser, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ cutting a message into IDs */

describe('reading several flight IDs out of a message', () => {
  const ids = (text: string) => flightIdChunks(text);

  it('cuts at commas, semicolons, new lines, "and", & and +', () => {
    assert.deepEqual(ids('TST-001, TST-002'), [['TST-001'], ['TST-002']]);
    assert.deepEqual(ids('TST-001;TST-002'), [['TST-001'], ['TST-002']]);
    assert.deepEqual(ids('TST-001\nTST-002\r\nTST-003'), [['TST-001'], ['TST-002'], ['TST-003']]);
    assert.deepEqual(ids('TST-001 and TST-002'), [['TST-001'], ['TST-002']]);
    assert.deepEqual(ids('TST-001 AND TST-002 And TST-003'), [['TST-001'], ['TST-002'], ['TST-003']]);
    assert.deepEqual(ids('TST-001 & TST-002 + TST-003 / TST-004 | TST-005'), [['TST-001'], ['TST-002'], ['TST-003'], ['TST-004'], ['TST-005']]);
    assert.deepEqual(ids('TST-001, TST-002 and TST-003'), [['TST-001'], ['TST-002'], ['TST-003']]);
  });

  it('keeps words that a space separates together in one chunk, for the caller to try alone or joined', () => {
    assert.deepEqual(ids('TST 7'), [['TST', '7']]);
    assert.deepEqual(ids('TST-001 TST-002'), [['TST-001', 'TST-002']]);
    assert.deepEqual(ids('7 8 9'), [['7', '8', '9']]);
    assert.deepEqual(ids('TST 7, TST 8'), [['TST', '7'], ['TST', '8']]);
  });

  it('takes off the formatting a copied list carries', () => {
    assert.deepEqual(ids('**TST-001**\n**TST-002**'), [['TST-001'], ['TST-002']]);
    assert.deepEqual(ids('`TST-001` `TST-002`'), [['TST-001'], ['TST-002']]);
    assert.deepEqual(ids('~~TST-001~~'), [['TST-001']]);
    assert.deepEqual(ids('"TST-001", "TST-002"'), [['TST-001'], ['TST-002']]);
    assert.deepEqual(ids('• TST-001\n• TST-002'), [['TST-001'], ['TST-002']]);
    assert.deepEqual(ids('(TST-001) [TST-002] <TST-003>'), [['TST-001', 'TST-002', 'TST-003']]);
  });

  it('takes a full stop or other punctuation off the end of an ID in a sentence', () => {
    assert.deepEqual(ids('Reserve TST-001 and TST-002.'), [['Reserve', 'TST-001'], ['TST-002']]);
    assert.deepEqual(ids('TST-001!'), [['TST-001']]);
    assert.deepEqual(ids('TST-001?'), [['TST-001']]);
    assert.deepEqual(ids('flights: TST-001'), [['flights', 'TST-001']]);
  });

  it('cuts at a tab, a bullet, a middle dot and an en or em dash as well', () => {
    assert.deepEqual(ids('TST 7\tTST 8'), [['TST', '7'], ['TST', '8']]);
    assert.deepEqual(ids('TST 7 • TST 8'), [['TST', '7'], ['TST', '8']]);
    assert.deepEqual(ids('TST 7 · TST 8'), [['TST', '7'], ['TST', '8']]);
    assert.deepEqual(ids('TST 7 – TST 8'), [['TST', '7'], ['TST', '8']]);
    assert.deepEqual(ids('TST 7 — TST 8'), [['TST', '7'], ['TST', '8']]);
  });

  it('does not cut at a hyphen, which is part of an ID', () => {
    assert.deepEqual(ids('TST-001-A'), [['TST-001-A']]);
  });

  it('keeps the full stop on a bare number, so a list\'s numbering is never read as a flight', () => {
    assert.deepEqual(ids('1. TST-003'), [['1.', 'TST-003']]);
    assert.deepEqual(ids('2) TST-004'), [['2)', 'TST-004']]);
  });

  it('leaves out words with nothing in them to read (a dash, an arrow)', () => {
    assert.deepEqual(ids('TST-001 - TST-002'), [['TST-001', 'TST-002']]);
    assert.deepEqual(ids('TST-001 → TST-002'), [['TST-001', 'TST-002']]);
    assert.deepEqual(ids('  ,, ;; '), []);
    assert.deepEqual(ids(''), []);
  });

  it('does not cut inside a word that has "and" in it', () => {
    assert.deepEqual(ids('Sand 1'), [['Sand', '1']]);
    assert.deepEqual(ids('BRANDON7'), [['BRANDON7']]);
    assert.deepEqual(ids('and TST-001'), [['and', 'TST-001']]);
  });
});

describe('the wording for flights too far ahead, said once for several', () => {
  it('names them all in one sentence, with the days', () => {
    assert.equal(
      beyondDaysManyText(3, ['TST-008', 'TST-009']),
      "You can't book flights more than 3 days ahead, and **TST-008** and **TST-009** start further off than that. They will be open for booking once they come within 3 days.",
    );
    assert.equal(
      beyondDaysManyText(1, ['A-1', 'B-2', 'C-3']),
      "You can't book flights more than 1 day ahead, and **A-1**, **B-2** and **C-3** start further off than that. They will be open for booking once they come within 1 day.",
    );
  });
  it('is the one-flight sentence for one flight', () => {
    assert.equal(
      beyondDaysManyText(7, ['TST-008']),
      "You can't book flights more than 7 days ahead, and **TST-008** starts further off than that. It will be open for booking once it comes within 7 days.",
    );
  });
  it('lists words as a person would', () => {
    assert.equal(andList([]), '');
    assert.equal(andList(['a']), 'a');
    assert.equal(andList(['a', 'b']), 'a and b');
    assert.equal(andList(['a', 'b', 'c']), 'a, b and c');
  });
});

/* ------------------------------------------------------------------ the conversation */

describe('reserving several flights with one message', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let pid: number;

  // TST-001..005 have one leg each, TST-006 and TST-007 have three, TST-008 starts ten days from now (beyond the panel's 7).
  const jobs = () => [
    sj('s1', 'EGLL-EGKK'),
    sj('s2', 'EGKK-EGCC'),
    sj('s3', 'EGCC-EGPH'),
    sj('s4', 'EGPH-EGLL'),
    sj('s5', 'EGLL-EGCC'),
    sj('m1', 'EGLL-EGKK-EGCC-EGPH'),
    sj('m2', 'EGPH-EGCC-EGKK-EGLL'),
    sj('far', 'EGLL-EGPH', { availableFrom: T0 + 10 * DAY, deadline: T0 + 11 * DAY }),
  ];

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    pid = h.panel.id;
    h.jobs.sync(pid, jobs());
    assert.deepEqual(h.store.listJobs(pid).map((j) => j.code), ['TST-001', 'TST-002', 'TST-003', 'TST-004', 'TST-005', 'TST-006', 'TST-007', 'TST-008']);
    await d.panels.refresh(pid);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const handlerFor = (customId: string) => componentHandlers.find((x) => x.prefix === customId.split(':')[0])!;
  const press = async (user: FakeUser, customId: string, o: { values?: string[] } = {}) => {
    const f = fakeComponent(user, customId, o);
    await handlerFor(customId).handle(d.ctx, f.i);
    return f.calls;
  };
  const say = (user: FakeUser, text: string) => handleDmMessage(d.ctx, fakeDm(user, text));
  const startFor = (user: FakeUser) => press(user, `panel:reserve:${pid}`);
  const session = (user: FakeUser) => h.store.getSession(user.id, h.clock.now);
  const job = (code: string) => h.store.listJobs(pid).find((j) => j.code === code)!;
  const holders = (code: string) => h.jobs.view(job(code).id)!.legs.map((l) => l.holder?.username ?? null);
  /** Press Reserve, send the message, and give back what the bot answered. */
  const send = async (text: string, user: FakeUser = alice) => {
    await startFor(user);
    const before = user.dms.length;
    await say(user, text);
    return { text: user.lastText, messages: user.dms.length - before };
  };

  describe('flights with one leg', () => {
    it('reserves each one named and says so in one message, with the panel footer once', async () => {
      const r = await send('TST-001, TST-003 and TST-004');
      assert.equal(r.messages, 1, 'a single reply');
      assert.equal(
        r.text,
        [
          '✅ **TST-001** (EGLL → EGKK) is reserved for you.',
          '✅ **TST-003** (EGCC → EGPH) is reserved for you.',
          '✅ **TST-004** (EGPH → EGLL) is reserved for you.',
          'The panel has been updated with your name.',
        ].join('\n'),
      );
      assert.deepEqual(['TST-001', 'TST-002', 'TST-003', 'TST-004', 'TST-005'].map((c) => holders(c)[0]), ['alice', null, 'alice', 'alice', null]);
      assert.equal(session(alice), null, 'the conversation is finished');
    });

    it('takes them in the order written, however the message is laid out', async () => {
      for (const text of ['TST-004\nTST-001\nTST-003', 'tst-4; tst-1; tst-3', 'TST-004 TST-001 TST-003', '4 & 1 + 3', '**TST-004**, `TST-001` and (TST-003).']) {
        for (const c of ['TST-001', 'TST-003', 'TST-004']) h.jobs.release(job(c).id, alice.id);
        const r = await send(text);
        assert.deepEqual([...r.text.matchAll(/\*\*(TST-\d+)\*\*/g)].map((m) => m[1]), ['TST-004', 'TST-001', 'TST-003'], text);
        assert.deepEqual(['TST-001', 'TST-003', 'TST-004'].map((c) => holders(c)[0]), ['alice', 'alice', 'alice'], text);
      }
    });

    it('puts the pilot on the panel for every one of them', async () => {
      await send('TST-001, TST-002');
      await settle();
      const panelText = d.client.channel('700000000000000001').live.map((m) => JSON.stringify(m.payload.embeds.map((e: any) => e.toJSON()))).join('\n');
      assert.equal((panelText.match(new RegExp(USER_A.discordId, 'g')) ?? []).length >= 2, true);
    });

    it('names each flight once when it is written twice, or in different ways', async () => {
      const r = await send('TST-001, tst-1, 1, TST 001, TST-002');
      assert.equal([...r.text.matchAll(/TST-001/g)].length, 1);
      assert.equal(r.text.split('\n').filter((l) => l.startsWith('✅')).length, 2);
    });

    it('reads a number with a space in it as one flight, and bare numbers as separate flights', async () => {
      let r = await send('TST 1, TST 2');
      assert.deepEqual(['TST-001', 'TST-002'].map((c) => holders(c)[0]), ['alice', 'alice'], r.text);
      for (const c of ['TST-001', 'TST-002']) h.jobs.release(job(c).id, alice.id);
      r = await send('1 2 3');
      assert.deepEqual(['TST-001', 'TST-002', 'TST-003'].map((c) => holders(c)[0]), ['alice', 'alice', 'alice'], 'not flight 123');
    });

    it('does not read the numbering of a list as a flight', async () => {
      const r = await send('1. TST-003\n2. TST-004');
      assert.deepEqual(['TST-001', 'TST-002', 'TST-003', 'TST-004'].map((c) => holders(c)[0]), [null, null, 'alice', 'alice']);
      assert.match(r.text, /can't find open flights with the IDs `1\.`, `2\.`/);
    });

    it('ignores the words of a sentence around the IDs', async () => {
      const r = await send('Hi, please reserve TST-001 and TST-002 for me, thanks!');
      assert.deepEqual(['TST-001', 'TST-002'].map((c) => holders(c)[0]), ['alice', 'alice']);
      assert.doesNotMatch(r.text, /can't find/);
    });
  });

  describe('when some cannot be had', () => {
    it('says how each went: reserved, already theirs, taken by someone, taken by a name in the schedule', async () => {
      h.jobs.reserve(job('TST-002').id, [1], { discordId: USER_B.discordId, username: 'bob' });
      h.jobs.reserve(job('TST-003').id, [1], { discordId: USER_A.discordId, username: 'alice' });
      h.store.setLegSheetHolder(job('TST-004').id, 1, 'Sam');
      const r = await send('TST-001, TST-002, TST-003, TST-004, TST-005');
      assert.equal(
        r.text,
        [
          '✅ **TST-001** (EGLL → EGKK) is reserved for you.',
          `⚠️ **TST-002** is already taken by <@${USER_B.discordId}>.`,
          'ℹ️ You already had **TST-003**.',
          "⚠️ **TST-004** is already taken by **Sam** (named in the airline's schedule).",
          '✅ **TST-005** (EGLL → EGCC) is reserved for you.',
          'The panel has been updated with your name.',
        ].join('\n'),
      );
      assert.deepEqual(['TST-001', 'TST-002', 'TST-003', 'TST-004', 'TST-005'].map((c) => holders(c)[0]), ['alice', 'bob', 'alice', null, 'alice']);
    });

    it('says nothing was reserved when every one was taken', async () => {
      h.jobs.reserve(job('TST-001').id, [1], { discordId: USER_B.discordId, username: 'bob' });
      h.jobs.reserve(job('TST-002').id, [1], { discordId: USER_B.discordId, username: 'bob' });
      const r = await send('TST-001, TST-002');
      assert.match(r.text, /already taken by[^\n]*\n⚠️ \*\*TST-002\*\*[^\n]*\nNothing was reserved\.$/);
      assert.equal(session(alice), null);
    });

    it('says nothing more than "you already had" when they were all theirs', async () => {
      h.jobs.reserve(job('TST-001').id, [1], { discordId: USER_A.discordId, username: 'alice' });
      h.jobs.reserve(job('TST-002').id, [1], { discordId: USER_A.discordId, username: 'alice' });
      const r = await send('TST-001, TST-002');
      assert.equal(r.text, 'ℹ️ You already had **TST-001**.\nℹ️ You already had **TST-002**.');
    });

    it('reserves what it can and names an ID it cannot find, once, however many there are', async () => {
      const r = await send('TST-001, TST-099 and TST-098, TST-002');
      assert.equal(
        r.text,
        [
          '✅ **TST-001** (EGLL → EGKK) is reserved for you.',
          '✅ **TST-002** (EGKK → EGCC) is reserved for you.',
          'The panel has been updated with your name.',
          '',
          "❓ I can't find open flights with the IDs `TST-099`, `TST-098`.",
        ].join('\n'),
      );
      assert.equal(session(alice), null, 'the conversation is finished');
    });

    it('names one ID it cannot find in the singular', async () => {
      const r = await send('TST-001, TST-099');
      assert.match(r.text, /❓ I can't find an open flight with the ID `TST-099`\.$/);
      assert.equal(holders('TST-001')[0], 'alice');
    });

    it('names an ID it cannot find once, however many times it was written', async () => {
      const r = await send('TST-001, TST-099, tst-099, TST-098, TST-099');
      assert.match(r.text, /❓ I can't find open flights with the IDs `TST-099`, `TST-098`\.$/);
    });

    it('shows no more than a short stretch of an ID it cannot find, so a pasted wall of text cannot fill the answer', async () => {
      const r = await send(`TST-001, X${'9'.repeat(200)}`);
      assert.match(r.text, /with the ID `X9{19}`\.$/);
      assert.ok(r.text.length < 400);
    });

    it('treats a closed flight as one it cannot find', async () => {
      h.jobs.sync(pid, jobs().filter((x) => x.key !== 's2')); // TST-002 is gone
      const r = await send('TST-001, TST-002');
      assert.match(r.text, /can't find an open flight with the ID `TST-002`/);
      assert.equal(holders('TST-001')[0], 'alice');
    });

    it('does not accept another airline\'s IDs', async () => {
      const r = await send('TST-001, DMO-002');
      assert.match(r.text, /can't find an open flight with the ID `DMO-002`/);
    });

    it('says when a flight went wrong while it was being reserved, and carries on with the rest', async () => {
      const real = d.ctx.jobs.reserve.bind(d.ctx.jobs);
      const bad = job('TST-002').id;
      d.ctx.jobs.reserve = (jobId, legNos, user) => {
        if (jobId === bad) throw new JobError('NOT_FOUND', 'That flight is no longer on the panel.');
        return real(jobId, legNos, user);
      };
      const r = await send('TST-001, TST-002, TST-003');
      assert.match(r.text, /^✅ \*\*TST-001\*\*[^\n]*\n⚠️ That flight is no longer on the panel\.\n✅ \*\*TST-003\*\*[^\n]*\nThe panel has been updated with your name\.$/);
      assert.deepEqual(['TST-001', 'TST-002', 'TST-003'].map((c) => holders(c)[0]), ['alice', null, 'alice']);
    });

    it('survives an unexpected failure on one flight: the others are still answered', async () => {
      const real = d.ctx.jobs.reserve.bind(d.ctx.jobs);
      const bad = job('TST-002').id;
      d.ctx.jobs.reserve = (jobId, legNos, user) => {
        if (jobId === bad) throw new Error('disk on fire');
        return real(jobId, legNos, user);
      };
      const r = await send('TST-001, TST-002, TST-003');
      assert.match(r.text, /⚠️ Something went wrong with \*\*TST-002\*\*\. Press \*\*My flights\*\*/);
      assert.doesNotMatch(r.text, /disk on fire/, 'internals are not shown');
      assert.deepEqual(['TST-001', 'TST-003'].map((c) => holders(c)[0]), ['alice', 'alice']);
    });
  });

  describe('when none can be used', () => {
    it('says which IDs it could not find, keeps the conversation open and counts a wrong try', async () => {
      await startFor(alice);
      await say(alice, 'TST-097, TST-098, TST-099');
      assert.match(alice.lastText, /^❓ I can't find open flights with the IDs `TST-097`, `TST-098`, `TST-099`\.\nIDs look like `TST-001` and are listed on the panel\. Try again, or say `cancel`\.$/);
      assert.equal(session(alice)!.attempts, 1);
      assert.equal(session(alice)!.step, 'await_code');
      await say(alice, 'TST-001, TST-002'); // then gets it right
      assert.deepEqual(['TST-001', 'TST-002'].map((c) => holders(c)[0]), ['alice', 'alice']);
    });

    it(`gives up after ${MAX_ATTEMPTS} tries like that`, async () => {
      await startFor(alice);
      for (let i = 0; i < MAX_ATTEMPTS; i++) await say(alice, `TST-9${i}1, TST-9${i}2`);
      assert.match(alice.lastText, /^❓ I can't find open flights with the IDs `TST-941`, `TST-942`\.\nThat's a few IDs I couldn't use, so I've closed this\. Press \*\*Reserve\*\* on the panel to start again\.$/);
      assert.equal(session(alice), null);
    });

    it('treats two IDs it cannot find as a batch, not as one mistyped ID', async () => {
      await startFor(alice);
      await say(alice, 'TST-097, TST-098');
      assert.match(alice.lastText, /^❓ I can't find open flights with the IDs `TST-097`, `TST-098`\./);
    });

    it('goes the single-ID way for one ID it cannot find, as it always did', async () => {
      await startFor(alice);
      await say(alice, 'TST-099');
      assert.match(alice.lastText, /^I can't find an open flight with the ID `TST-099`\. IDs look like `TST-001`/);
      await say(alice, 'hello there');
      assert.match(alice.lastText, /^I can't find an open flight with the ID `hello there`\./);
      assert.equal(session(alice)!.attempts, 2);
    });

    it('cancel still cancels', async () => {
      await startFor(alice);
      await say(alice, 'cancel');
      assert.equal(session(alice), null);
    });
  });

  describe("flights beyond the panel's days", () => {
    it('are not reserved, and are named together with the number of days', async () => {
      h.jobs.sync(pid, [...jobs(), sj('far2', 'EGLL-EGCC', { availableFrom: T0 + 12 * DAY, deadline: T0 + 13 * DAY })]);
      const r = await send('TST-001, TST-008, TST-009');
      assert.match(r.text, /^✅ \*\*TST-001\*\*[^\n]*\nThe panel has been updated with your name\.\n\nYou can't book flights more than 7 days ahead, and \*\*TST-008\*\* and \*\*TST-009\*\* start further off than that\. They will be open for booking once they come within 7 days\.$/);
      assert.equal(holders('TST-008')[0], null);
      assert.equal(holders('TST-001')[0], 'alice');
    });

    it('use the panel\'s own number of days', async () => {
      h.store.updatePanel(pid, { showDays: 2 });
      h.jobs.sync(pid, [...jobs(), sj('later', 'EGLL-EGCC', { availableFrom: T0 + 3 * DAY, deadline: T0 + 4 * DAY })]);
      const r = await send('TST-001, TST-009');
      assert.match(r.text, /more than 2 days ahead, and \*\*TST-009\*\* starts further off than that\. It will be open for booking once it comes within 2 days\./);
    });

    it('count as a wrong try when they are all there is, and the conversation stays open', async () => {
      h.jobs.sync(pid, [...jobs(), sj('far2', 'EGLL-EGCC', { availableFrom: T0 + 12 * DAY, deadline: T0 + 13 * DAY })]);
      await startFor(alice);
      await say(alice, 'TST-008, TST-009');
      assert.match(alice.lastText, /^You can't book flights more than 7 days ahead, and \*\*TST-008\*\* and \*\*TST-009\*\*[^\n]*\nSend different flight IDs, or say `cancel`\.$/);
      assert.equal(session(alice)!.attempts, 1);
      assert.equal(holders('TST-008')[0], null);
    });

    it('are said together with IDs that cannot be found', async () => {
      await startFor(alice);
      await say(alice, 'TST-008, TST-099');
      assert.match(alice.lastText, /^❓ I can't find an open flight with the ID `TST-099`\.\nYou can't book flights more than 7 days ahead, and \*\*TST-008\*\* starts/);
      assert.equal(session(alice)!.attempts, 1);
    });

    it('can be reserved once they come within the days', async () => {
      h.clock.advance(4 * DAY);
      const r = await send('TST-008, TST-001');
      assert.match(r.text, /✅ \*\*TST-008\*\*/);
      assert.equal(holders('TST-008')[0], 'alice');
    });
  });

  describe('flights with several legs', () => {
    it('reserves the single-leg ones now, and leaves a multi-leg one to be asked about, with the conversation still open', async () => {
      const r = await send('TST-001, TST-006, TST-002');
      assert.equal(
        r.text,
        [
          '✅ **TST-001** (EGLL → EGKK) is reserved for you.',
          '✅ **TST-002** (EGKK → EGCC) is reserved for you.',
          'The panel has been updated with your name.',
          '',
          "↪️ **TST-006** has several legs, so I need to know which you're flying. Send me its ID on its own and I'll ask.",
          'Say `cancel` when you are done.',
        ].join('\n'),
      );
      assert.deepEqual(holders('TST-006'), [null, null, null], 'nothing is taken on a flight that has to be asked about');
      assert.equal(session(alice)!.step, 'await_code');
      assert.equal(session(alice)!.attempts, 0);

      await say(alice, 'TST-006');
      assert.match(alice.lastText, /\*\*TST-006\*\* has 3 legs\. Are you flying all of them, or just some\?/);
      await press(alice, 'dm:all');
      assert.deepEqual(holders('TST-006'), ['alice', 'alice', 'alice']);
    });

    it('names several of them together', async () => {
      const r = await send('TST-006, TST-001, TST-007');
      assert.match(r.text, /↪️ \*\*TST-006\*\* and \*\*TST-007\*\* have several legs, so I need to know which you're flying\. Send me one of those IDs on its own and I'll ask\./);
      assert.equal(holders('TST-001')[0], 'alice');
      assert.equal(session(alice)!.step, 'await_code');
    });

    it('asks about the legs straight away when that is the only flight that can be acted on', async () => {
      const r = await send('TST-006, TST-099');
      assert.match(r.text, /^❓ I can't find an open flight with the ID `TST-099`\.\n\n[^\n]*TST-006[\s\S]*\*\*TST-006\*\* has 3 legs\. Are you flying all of them, or just some\?$/);
      assert.equal(session(alice)!.step, 'await_mode');
      assert.equal(session(alice)!.jobId, job('TST-006').id);
      assert.deepEqual(h.store.getSession(alice.id, h.clock.now)!.pendingLegs, []);
      const buttons = alice.last.components[0].toJSON().components;
      assert.deepEqual(buttons.map((b: any) => b.custom_id), ['dm:all', 'dm:some', 'dm:cancel']);
    });

    it('says nothing is reserved yet when only flights with several legs were named', async () => {
      const r = await send('TST-006, TST-007');
      assert.match(r.text, /^Nothing was reserved\.\n\n↪️ \*\*TST-006\*\* and \*\*TST-007\*\* have several legs/);
      assert.equal(session(alice)!.step, 'await_code');
    });

    it('does not start a second conversation over one the person began while this was being answered', async () => {
      // The conversation is closed while the flights are reserved; if the person has opened a new one by the end, it is left alone.
      const real = d.ctx.jobs.reserve.bind(d.ctx.jobs);
      d.ctx.jobs.reserve = (jobId, legNos, user) => {
        h.store.upsertSession({ discordId: alice.id, panelId: pid, step: 'await_code', expiresAt: h.clock.now + 60_000, purpose: 'backup' });
        return real(jobId, legNos, user);
      };
      await send('TST-001, TST-006');
      assert.equal(session(alice)!.purpose, 'backup');
    });
  });

  describe(`a long list (${MAX_IDS_AT_ONCE} flights at a time)`, () => {
    // Thirty more one-leg flights after the eight above: TST-009 to TST-038. Counting only the one-leg flights, they are numbers 6 to 35.
    beforeEach(async () => {
      h.jobs.sync(pid, [...jobs(), ...Array.from({ length: 30 }, (_, i) => sj(`n${i}`, i % 2 ? 'EGLL-EGKK' : 'EGKK-EGLL'))]);
      await d.panels.refresh(pid);
    });
    /** The p-th one-leg flight: TST-001 to TST-005, then TST-009 onwards (006 and 007 have three legs, 008 is far off). */
    const code = (p: number) => `TST-${String(p <= 5 ? p : p + 3).padStart(3, '0')}`;
    const codes = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => code(from + i));

    it('takes the first ones, says which it did not get to, and keeps the conversation open for the rest', async () => {
      const r = await send(codes(1, 13).join(', '));
      assert.equal(r.text.split('\n').filter((l) => l.startsWith('✅')).length, MAX_IDS_AT_ONCE);
      assert.ok(
        r.text.endsWith(`I take up to ${MAX_IDS_AT_ONCE} flights at a time, so I haven't looked at \`TST-014\`, \`TST-015\`, \`TST-016\`. Send them again.\nSay \`cancel\` when you are done.`),
        r.text,
      );
      assert.deepEqual(codes(1, 13).map((c) => holders(c)[0] === 'alice'), [...Array(10).fill(true), false, false, false]);
      assert.equal(session(alice)!.step, 'await_code');

      await say(alice, codes(11, 13).join(', '));
      assert.deepEqual(codes(11, 13).map((c) => holders(c)[0]), ['alice', 'alice', 'alice']);
      assert.equal(session(alice), null);
    });

    it('does not count a flight written twice towards the limit', async () => {
      const r = await send(`${codes(1, 5).join(', ')}, ${codes(1, 5).join(', ')}, ${codes(6, 10).join(', ')}`);
      assert.equal(r.text.split('\n').filter((l) => l.startsWith('✅')).length, 10);
      assert.doesNotMatch(r.text, /haven't looked at/);
      assert.equal(session(alice), null);
    });

    it('shows only a few of the IDs it did not get to', async () => {
      const r = await send(codes(1, 25).join(' '));
      assert.match(r.text, /haven't looked at `TST-014`, `TST-015`, `TST-016`, `TST-017`, `TST-018` and 10 more\./);
    });

    it('does not list the ordinary words after the limit as IDs it did not get to', async () => {
      const r = await send(`${codes(1, 10).join(', ')}, please also take TST-014, thanks`);
      assert.match(r.text, /haven't looked at `TST-014`\. Send it again\./);
      assert.doesNotMatch(r.text, /`please`|`also`|`thanks`/);
    });

    it('keeps the conversation open, with the rest still to send, when a flight with several legs is the only one named before the words ran out', async () => {
      const chatter = Array.from({ length: MAX_ID_WORDS - 1 }, () => 'blah').join(' ');
      const r = await send(`TST-006 ${chatter} TST-099`);
      assert.match(r.text, /^Nothing was reserved\.\n\n/);
      assert.match(r.text, /↪️ \*\*TST-006\*\* has several legs/);
      assert.match(r.text, /That's a lot for one message, so I haven't looked at `TST-099`\./);
      assert.equal(session(alice)!.step, 'await_code', 'not asked about the legs yet: the rest has to be sent first');
    });

    it('names an ID it did not get to once, however many times it was written', async () => {
      const r = await send(`${codes(1, 10).join(', ')}, TST-014, tst-014, TST-015, TST-014`);
      assert.match(r.text, /haven't looked at `TST-014`, `TST-015`\. Send them again\./);
    });

    it(`looks at no more than ${MAX_ID_WORDS} words, and says what it left`, async () => {
      const chatter = Array.from({ length: MAX_ID_WORDS }, () => 'blah').join(' ');
      await startFor(alice);
      await say(alice, `${chatter} TST-001 TST-002`);
      assert.equal(alice.lastText, "That's a lot for one message, so I haven't looked at `TST-001`, `TST-002`. Send them again.\nSend different flight IDs, or say `cancel`.");
      assert.equal(holders('TST-001')[0], null);
      assert.equal(session(alice)!.attempts, 1);
    });

    it('sends an answer that is too long for one Discord message as two, rather than cut it', async () => {
      // Ten flights the schedule names long-named pilots for (a long line each), and fifty IDs that are not flights.
      for (const c of codes(1, 10)) h.store.setLegSheetHolder(job(c).id, 1, 'N'.repeat(40));
      const nonsense = Array.from({ length: 50 }, (_, i) => `NOSUCHFLIGHT${i}`);
      const r = await send([...nonsense, ...codes(1, 10)].join(', '));
      assert.equal(r.messages, 2);
      const [first, second] = alice.dms.slice(-2).map((m: any) => m.content as string);
      assert.ok(first!.length < 2000 && second!.length < 2000, `${first!.length} and ${second!.length} characters`);
      assert.equal(first!.split('\n').filter((l) => l.startsWith('⚠️ **TST-')).length, 10);
      assert.ok(first!.endsWith('Nothing was reserved.'));
      assert.ok(second!.startsWith("❓ I can't find open flights with the IDs `NOSUCHFLIGHT0`"));
      assert.ok(second!.includes('`NOSUCHFLIGHT49`'));
    });

    it('does not report the ordinary words of a sentence as IDs it cannot find', async () => {
      const r = await send('Could you please reserve TST-001 and TST-002 for my next shift, thank you very much');
      assert.doesNotMatch(r.text, /can't find/);
      assert.equal(r.text.split('\n').filter((l) => l.startsWith('✅')).length, 2);
    });
  });

  describe('one ID, as always', () => {
    it('is reserved exactly as before, with the same wording', async () => {
      const r = await send('TST-001');
      assert.equal(r.text, '✅ **TST-001** (EGLL → EGKK) is reserved for you.\nThe panel has been updated with your name.');
    });

    it('is reserved when written with a full stop, a comma or quotes around it', async () => {
      for (const text of ['TST-001.', 'TST-001,', '"TST-001"', '**TST-001**', 'reserve TST-001 please']) {
        h.jobs.release(job('TST-001').id, alice.id);
        const r = await send(text);
        assert.equal(r.text, '✅ **TST-001** (EGLL → EGKK) is reserved for you.\nThe panel has been updated with your name.', text);
      }
    });

    it('still asks about the legs of a flight with several', async () => {
      const r = await send('TST-006');
      assert.match(r.text, /\*\*TST-006\*\* has 3 legs/);
      assert.equal(session(alice)!.step, 'await_mode');
    });

    it('still refuses a flight beyond the panel\'s days with the single-flight wording', async () => {
      const r = await send('TST-008');
      assert.equal(r.text, "You can't book flights more than 7 days ahead, and **TST-008** starts further off than that. It will be open for booking once it comes within 7 days.\nSend a different flight ID, or say `cancel`.");
    });

    it('reads "TST 001" as one flight', async () => {
      await send(' TST 001 ');
      assert.equal(holders('TST-001')[0], 'alice');
    });

    it('reads a flight number from the airline\'s own schedule, which is not in the bot\'s own form', async () => {
      h.jobs.sync(pid, [sj('fn', 'EGLL-EGKK', { flightNumber: 'WA123' }), sj('fm', 'EGKK-EGCC', { flightNumber: 'WA124' })]);
      const r = await send('wa123, WA 124');
      assert.match(r.text, /✅ \*\*WA123\*\*[^\n]*\n✅ \*\*WA124\*\*/);
    });

    it('does not read the number of a flight number that has a space in it as a flight of its own', async () => {
      // "WA 7" is the flight number WA7. The 7 on its own would be TST-007, a different flight.
      h.jobs.sync(pid, [...jobs(), sj('wa', 'EGLL-EGKK', { flightNumber: 'WA7' })]);
      const r = await send('WA 7, TST-001');
      assert.equal(r.text.split('\n').filter((l) => l.startsWith('✅')).length, 2, r.text);
      assert.doesNotMatch(r.text, /TST-007/);
      assert.match(r.text, /✅ \*\*WA7\*\*/);
    });
  });

  describe('standing by as backup', () => {
    it('still takes one flight at a time: several IDs are not read there', async () => {
      h.jobs.reserve(job('TST-001').id, [1], { discordId: USER_B.discordId, username: 'bob' });
      h.jobs.reserve(job('TST-002').id, [1], { discordId: USER_B.discordId, username: 'bob' });
      await press(alice, `panel:backup:${pid}`);
      await say(alice, 'TST-001, TST-002');
      assert.match(alice.lastText, /^You can stand by for one flight at a time\. Send me the ID of just one, or say `cancel`\.$/);
      assert.equal(h.jobs.view(job('TST-001').id)!.backup, null);
      await say(alice, 'TST-001');
      assert.match(alice.lastText, /down as backup for \*\*TST-001\*\*/);
    });
  });

  describe('what the Reserve prompt says', () => {
    it('tells the person they can send several IDs, with an example from the panel', async () => {
      await startFor(alice);
      assert.match(alice.lastText, /Reply with the flight ID shown on the panel, for example `TST-001`\. To reserve several at once, send their IDs in one message, like `TST-001, TST-002`\./);
    });

    it('leaves that out when the panel lists only one flight', async () => {
      h.jobs.sync(pid, [sj('only', 'EGLL-EGKK')]);
      await startFor(alice);
      assert.doesNotMatch(alice.lastText, /several/);
    });
  });
});

/* ------------------------------------------------------------------ with the airline's sheet */

const { account, publicKey } = makeServiceAccount();

describe('reserving several flights with one message, when the airline keeps its flights in a Google Sheet', () => {
  let h: Harness;
  let d: DiscordHarness;
  let g: FakeGoogle;
  let wb: SheetWriteBack;
  let alice: FakeUser;
  const pid = () => h.panel.id;

  const syncFromSheet = () => h.jobs.sync(pid(), parseScheduleValues(g.values, h.clock.now)!.jobs);
  const say = (user: FakeUser, text: string) => handleDmMessage(d.ctx, fakeDm(user, text));
  const holder = (code: string) => h.jobs.view(h.store.listJobs(pid()).find((j) => j.code === code)!.id)!.legs[0]!.holder?.username ?? null;
  const send = async (text: string) => {
    const f = fakeComponent(alice, `panel:reserve:${pid()}`, {});
    await componentHandlers.find((x) => x.prefix === 'panel')!.handle(d.ctx, f.i);
    await say(alice, text);
    return alice.lastText;
  };

  beforeEach(async () => {
    h = await makeHarness();
    g = new FakeGoogle(publicKey);
    wb = new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, { now: () => h.clock.now });
    d = makeDiscordHarness(h, { writeback: wb });
    alice = d.client.user(new FakeUser(USER_A.discordId, 'alice'));
    h.store.updatePanel(pid(), { sheetId: SHEET_ID, sheetGid: String(TAB_GID) });
    syncFromSheet(); // TST-001 EGLL-EGCC (row 3), TST-002 EGCC-EGLL (Taylor), TST-003 KMIA-KORD (row 5), TST-004 EGLL-EGPH (row 7), TST-005 EGLL-EGKK (row 8)
    await d.panels.refresh(pid());
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('puts the pilot\'s name against each flight in the sheet, and says so once', async () => {
    const text = await send('TST-001, TST-003, TST-004');
    assert.deepEqual([g.cell('E3'), g.cell('E5'), g.cell('E7')], ['alice', 'alice', 'alice']);
    assert.equal(g.cell('E8'), '', 'a flight that was not named is left alone');
    assert.equal(text.split('\n').filter((l) => l.startsWith('📝')).length, 1);
    assert.match(text, /The panel has been updated with your name\.\n📝 I've put \*\*alice\*\* against 3 of them in the airline's sheet\. Not how you appear there\? Reply `name <your name>` and I'll use that from now on\.$/);
    assert.equal(holder('TST-001'), 'alice');
  });

  it('names the flight when only one was written', async () => {
    h.jobs.reserve(h.store.listJobs(pid()).find((j) => j.code === 'TST-003')!.id, [1], { discordId: USER_A.discordId, username: 'alice' });
    const text = await send('TST-001, TST-003');
    assert.match(text, /ℹ️ You already had \*\*TST-003\*\*\./);
    assert.match(text, /📝 I've put \*\*alice\*\* against \*\*TST-001\*\* in the airline's sheet\./);
  });

  it('does not take a flight the sheet has given to someone else, says who, and reserves the rest', async () => {
    g.values[6]![4] = 'Sam'; // TST-004's row, typed in after the last read
    const text = await send('TST-001, TST-004, TST-005');
    assert.match(text, /⚠️ [^\n]*names \*\*Sam\*\* for that flight\. So I haven't reserved \*\*TST-004\*\* for you\./);
    assert.match(text, /✅ \*\*TST-001\*\*/);
    assert.match(text, /✅ \*\*TST-005\*\*/);
    assert.match(text, /against 2 of them in the airline's sheet/);
    assert.equal(holder('TST-004'), null);
    assert.equal(g.cell('E7'), 'Sam');
    assert.equal(h.store.getJobView(h.store.listJobs(pid()).find((j) => j.code === 'TST-004')!.id)!.legs[0]!.sheetHolder, 'Sam', 'the panel learns it is taken');
    assert.deepEqual([holder('TST-001'), holder('TST-005')], ['alice', 'alice']);
  });

  it('says nothing was reserved when the sheet gave every one of them to others', async () => {
    g.values[2]![4] = 'Sam';
    g.values[6]![4] = 'Kim';
    const text = await send('TST-001, TST-004');
    assert.match(text, /So I haven't reserved \*\*TST-001\*\*[^\n]*\n⚠️[^\n]*So I haven't reserved \*\*TST-004\*\*[^\n]*\nNothing was reserved\.$/);
    assert.doesNotMatch(text, /📝/);
  });

  it('knows a flight the schedule already names someone for, without asking the sheet', async () => {
    const text = await send('TST-001, TST-002');
    assert.match(text, /⚠️ \*\*TST-002\*\* is already taken by \*\*Taylor\*\* \(named in the airline's schedule\)\./);
    assert.match(text, /against \*\*TST-001\*\* in the airline's sheet/);
  });

  it('keeps the reservations and says once that the sheet could not be updated, naming the flights, when Google cannot be reached', async () => {
    g.mode = 'down';
    const text = await send('TST-001, TST-003, TST-004');
    assert.deepEqual(['TST-001', 'TST-003', 'TST-004'].map(holder), ['alice', 'alice', 'alice']);
    const warnings = text.split('\n').filter((l) => l.includes("couldn't update the airline's sheet"));
    assert.equal(warnings.length, 1, text);
    assert.match(warnings[0]!, /\(.*HTTP 503.*\), so it doesn't show your name on \*\*TST-001\*\*, \*\*TST-003\*\* and \*\*TST-004\*\* yet\. Please ask a manager to add you to them there\.$/);
    assert.doesNotMatch(text, /📝/);
  });

  it('says "it" when only one flight could not be written to the sheet', async () => {
    g.mode = 'down';
    const text = await send('TST-001, TST-099');
    assert.match(text, /doesn't show your name on \*\*TST-001\*\* yet\. Please ask a manager to add you to it there\./);
  });

  it('does not touch the sheet for flights it did not reserve', async () => {
    g.writes.length = 0;
    await send('TST-099, TST-098');
    assert.equal(g.writes.length, 0);
  });

  it('does not touch the sheet for a flight with several legs that is left to be asked about', async () => {
    h.jobs.sync(pid(), [...parseScheduleValues(g.values, h.clock.now)!.jobs, sj('multi', 'EGLL-EGKK-EGCC')]);
    g.calls.length = 0;
    const text = await send('TST-006, TST-001');
    assert.match(text, /↪️ \*\*TST-006\*\* has several legs/);
    assert.deepEqual(g.writes.length, 1, 'only the one-leg flight was written');
    assert.equal(g.cell('E3'), 'alice');
  });

  it('uses the name the pilot has chosen', async () => {
    await say(alice, 'name Captain Alice');
    const text = await send('TST-001, TST-003');
    assert.deepEqual([g.cell('E3'), g.cell('E5')], ['Captain Alice', 'Captain Alice']);
    assert.match(text, /I've put \*\*Captain Alice\*\* against 2 of them/);
  });
});
