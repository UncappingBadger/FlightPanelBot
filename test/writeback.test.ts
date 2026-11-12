import assert from 'node:assert/strict';
import { createVerify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commands, componentHandlers } from '../src/discord/commands/index.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { UserError } from '../src/discord/errors.js';
import { GoogleAuthError, loadServiceAccount, signJwt, TOKEN_URL, tokenProvider } from '../src/google/serviceAccount.js';
import { SheetsApi, SheetsError } from '../src/google/sheetsApi.js';
import { colLetter, parseScheduleValues } from '../src/jobs/sheet.js';
import { COMPLETE_AFTER_DEADLINE_MS, COMPLETION_GRACE_MS, JobError } from '../src/services/jobs.js';
import { refreshIntervalFor, REFRESH_INTERVAL_MS, SHEET_REFRESH_INTERVAL_MS } from '../src/services/refresh.js';
import { SheetWriteBack, WriteBackError } from '../src/services/writeback.js';
import { AIRLINE, CHANNEL, GUILD, HOUR, makeHarness, sj, T0, USER_A, USER_B, type Harness } from './helpers.js';
import { DONE_COL, FakeGoogle, flightRow, makeServiceAccount, PILOT_COL, scheduleGrid, SHEET_ID, TAB_GID, TAB_TITLE } from './fake-google.js';
import { fakeComponent, fakeDm, fakeInteraction, FakeUser, makeDiscordHarness, settle, type DiscordHarness, type FakeInteractionOptions, messageText } from './discord-helpers.js';

const { account, publicKey } = makeServiceAccount();

/* Flights in the pretend sheet, by their keys (see scheduleGrid). */
const K = {
  open: 'EGLL-EGCC@2026-11-12', // row 3
  taken: 'EGCC-EGLL@2026-11-12', // row 4, Taylor
  overnight: 'KMIA-KORD@2026-11-12', // row 5
  cancelled: 'EGLL-LFPG@2026-11-12', // row 6
  other: 'EGLL-EGPH@2026-11-12', // row 7
  next: 'EGLL-EGKK@2026-11-13', // row 8
};

/* ------------------------------------------------------------------ signing in to Google */

describe('the Google service account', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aero-key-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, content: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
    return path;
  };

  it('reads the email and key from the downloaded key file, and ignores the rest', () => {
    const path = write('key.json', { type: 'service_account', client_email: account.email, private_key: account.privateKey, token_uri: 'https://evil.example/token', project_id: 'x' });
    assert.deepEqual(loadServiceAccount(path), { email: account.email, privateKey: account.privateKey });
  });

  it('says plainly what is wrong with a key file, without ever repeating its contents', () => {
    assert.throws(() => loadServiceAccount(join(dir, 'nope.json')), /can't read that file/);
    assert.throws(() => loadServiceAccount(write('bad.json', '{ not json')), /isn't valid JSON/);
    const secret = '-----BEGIN PRIVATE KEY-----\nSUPERSECRET\n-----END PRIVATE KEY-----';
    for (const content of [{ private_key: secret }, { client_email: account.email }, { client_email: 'no-at-sign', private_key: secret }, [], 'null']) {
      assert.throws(
        () => loadServiceAccount(write('x.json', content)),
        (e: unknown) => e instanceof Error && /doesn't look like a service account key/.test(e.message) && !e.message.includes('SUPERSECRET'),
      );
    }
  });

  it('signs a token request that Google could verify, for the sheets scope and the fixed token address', () => {
    const jwt = signJwt(account, T0);
    const [header, claims, signature] = jwt.split('.') as [string, string, string];
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
    assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), {
      iss: account.email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: TOKEN_URL,
      iat: Math.floor(T0 / 1000),
      exp: Math.floor(T0 / 1000) + 3600,
    });
    assert.ok(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url')));
  });

  describe('access tokens', () => {
    let g: FakeGoogle;
    let now: number;
    beforeEach(() => {
      g = new FakeGoogle(publicKey);
      now = T0;
    });

    it('asks Google once and reuses the token until shortly before it expires', async () => {
      const token = tokenProvider(account, g.fetchFn, () => now);
      assert.equal(await token(), 'tok-1');
      assert.equal(await token(), 'tok-1');
      now += 58 * 60_000;
      assert.equal(await token(), 'tok-1', 'still good with two minutes left');
      now += 2 * 60_000;
      assert.equal(await token(), 'tok-2', 'within a minute of expiry, so a fresh one');
      assert.equal(g.tokenRequests, 2);
    });

    it('shares one request between calls made at the same moment', async () => {
      const token = tokenProvider(account, g.fetchFn, () => now);
      const all = await Promise.all([token(), token(), token()]);
      assert.deepEqual(all, ['tok-1', 'tok-1', 'tok-1']);
      assert.equal(g.tokenRequests, 1);
    });

    it('reports a refused sign-in, an unreachable Google and an odd answer', async () => {
      g.tokenStatus = 401;
      await assert.rejects(tokenProvider(account, g.fetchFn, () => now)(), (e: unknown) => e instanceof GoogleAuthError && /refused the service account's sign-in \(HTTP 401\)/.test(e.message));
      const offline = (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;
      await assert.rejects(tokenProvider(account, offline, () => now)(), /couldn't reach Google/);
      const odd = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
      await assert.rejects(tokenProvider(account, odd, () => now)(), /did not understand/);
    });

    it('tries again after a failure rather than remembering it', async () => {
      const token = tokenProvider(account, g.fetchFn, () => now);
      g.tokenStatus = 500;
      await assert.rejects(token(), GoogleAuthError);
      g.tokenStatus = 200;
      assert.equal(await token(), 'tok-2');
    });
  });
});

/* ------------------------------------------------------------------ the Sheets API */

describe('the Sheets API client', () => {
  let g: FakeGoogle;
  let api: SheetsApi;
  const ref = { id: SHEET_ID, gid: String(TAB_GID) };

  beforeEach(() => {
    g = new FakeGoogle(publicKey);
    api = new SheetsApi(tokenProvider(account, g.fetchFn), g.fetchFn);
  });

  it('finds a tab by its id, or the first tab when none is given', async () => {
    assert.equal(await api.tabTitle(ref), TAB_TITLE);
    assert.equal(await api.tabTitle({ id: SHEET_ID, gid: null }), TAB_TITLE);
    await assert.rejects(api.tabTitle({ id: SHEET_ID, gid: '999' }), (e: unknown) => e instanceof SheetsError && e.code === 'NOT_FOUND');
  });

  it('reads the whole tab, sending the token and quoting the tab name', async () => {
    const tab = await api.readTab(ref);
    assert.equal(tab.title, TAB_TITLE);
    assert.deepEqual(tab.values[2], ['EGLL-EGCC', '11/12/2026', '0600-2359z', 'x', '', '', 'A320', 'FALSE', 'FALSE'].slice(0, 9).filter((_, i, a) => i < a.length), 'rows come back as cells');
    const read = g.calls.find((c) => c.url.includes('/values/'))!;
    assert.match(read.url, /\/values\/'Example%20Air%20Sign%20Up'\?/, "the tab name is quoted: 'Example Air Sign Up'");
    assert.match(read.auth!, /^Bearer tok-/);
    assert.ok(read.url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/'), 'only ever talks to the Sheets API');
  });

  it('writes cells as RAW values, so text can never be read as a formula, and a checkbox as a real boolean', async () => {
    await api.update(ref, TAB_TITLE, [
      { a1: 'E3', value: '=IMPORTXML("https://evil.example","//a")' },
      { a1: 'H3', value: true },
    ]);
    assert.equal(g.writes[0]!.valueInputOption, 'RAW');
    assert.deepEqual(g.writes[0]!.data, [
      { range: "'Example Air Sign Up'!E3", values: [['=IMPORTXML("https://evil.example","//a")']] },
      { range: "'Example Air Sign Up'!H3", values: [[true]] },
    ]);
    assert.equal(g.cell('E3'), '=IMPORTXML("https://evil.example","//a")', 'stored as plain text');
    assert.equal(g.cell('H3'), 'TRUE');
  });

  it('doubles a quote inside a tab name, as A1 ranges require', async () => {
    await assert.rejects(api.update(ref, "Bob's tab", [{ a1: 'A1', value: 'x' }]), SheetsError); // the fake only knows the real tab
    assert.equal(g.calls.at(-1)!.body.data[0].range, "'Bob''s tab'!A1");
  });

  it('writes nothing, and sends nothing, for an empty list', async () => {
    await api.update(ref, TAB_TITLE, []);
    assert.equal(g.calls.length, 0);
  });

  it('turns Google\'s refusals into plain errors', async () => {
    const code = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        return e instanceof SheetsError ? e.code : `other: ${e}`;
      }
      return 'none';
    };
    g.mode = 'not-shared';
    assert.equal(await code(() => api.readTab(ref)), 'NO_ACCESS');
    g.mode = 'view-only';
    assert.equal(await code(() => api.readTab(ref)), 'none', 'viewing is fine');
    assert.equal(await code(() => api.update(ref, TAB_TITLE, [{ a1: 'E3', value: 'x' }])), 'NO_ACCESS', 'editing is not');
    g.mode = 'down';
    assert.equal(await code(() => api.readTab(ref)), 'UNAVAILABLE');
    g.mode = 'ok';
    g.tokenStatus = 401;
    assert.equal(await code(() => new SheetsApi(tokenProvider(account, g.fetchFn), g.fetchFn).readTab(ref)), 'AUTH');
    const offline = (async (url: string) => {
      if (String(url) === TOKEN_URL) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    assert.equal(await code(() => new SheetsApi(tokenProvider(account, offline), offline).readTab(ref)), 'UNAVAILABLE');
  });
});

/* ------------------------------------------------------------------ rows and columns */

describe('finding a flight in the sheet', () => {
  it('turns column numbers into spreadsheet letters', () => {
    assert.deepEqual([0, 4, 7, 25, 26, 27, 51, 52, 701, 702].map(colLetter), ['A', 'E', 'H', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('reports each flight\'s row and where the Pilot and Completed columns are', () => {
    const parsed = parseScheduleValues(scheduleGrid(), T0)!;
    assert.deepEqual(parsed.cols, { pilot: 4, done: 7 });
    assert.equal(parsed.rowOf.get(K.open), 3);
    assert.equal(parsed.rowOf.get(K.taken), 4);
    assert.equal(parsed.rowOf.get(K.next), 8);
    assert.equal(parsed.rowOf.has('Week 2'), false);
  });

  it('says there are no such columns when the tab is not a schedule', () => {
    assert.equal(parseScheduleValues([['Name', 'Score'], ['Anna', '5']], T0), null);
  });
});

/* ------------------------------------------------------------------ writing safely */

describe('writing to the sheet', () => {
  let h: Harness;
  let g: FakeGoogle;
  let wb: SheetWriteBack;
  const panel = () => h.store.getPanel(h.panel.id)!;

  beforeEach(async () => {
    h = await makeHarness();
    g = new FakeGoogle(publicKey);
    wb = new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, { now: () => h.clock.now });
    h.store.updatePanel(h.panel.id, { sheetId: SHEET_ID, sheetGid: String(TAB_GID) });
  });
  afterEach(async () => {
    await h.close();
  });

  const failure = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as WriteBackError;
    }
    throw new Error('expected a WriteBackError');
  };

  it('is on for a panel with a linked sheet unless an admin turned it off', () => {
    assert.equal(wb.enabledFor(panel()), true);
    assert.equal(wb.enabledFor({ ...panel(), writeback: false }), false);
    assert.equal(wb.enabledFor({ ...panel(), sheetId: null }), false);
  });

  describe('putting a pilot against a flight', () => {
    it('writes the name into that flight\'s Pilot cell and nowhere else', async () => {
      const before = JSON.stringify(g.values);
      await wb.claim(panel(), K.open, 'Alex');
      assert.equal(g.cell(`${PILOT_COL}3`), 'Alex');
      assert.equal(g.writes.length, 1);
      assert.deepEqual(g.writes[0]!.data.map((d) => d.range), [`'${TAB_TITLE}'!E3`]);
      const after = JSON.parse(before) as string[][];
      after[2]![4] = 'Alex';
      assert.deepEqual(g.values, after, 'every other cell is as it was');
    });

    it('finds the row by the flight, not by a remembered position, so a re-sorted sheet is safe', async () => {
      g.values.splice(2, 0, flightRow('EGLL-EGBB', '11/12/2026'), flightRow('EGLL-EGNX', '11/12/2026')); // two rows inserted above
      await wb.claim(panel(), K.open, 'Alex');
      assert.equal(g.cell('E5'), 'Alex', 'the flight is now on row 5');
      assert.equal(g.cell('E3'), '', 'the row that used to be there is untouched');
    });

    it('does nothing if the same name is already there (any capitalisation)', async () => {
      g.values[2]![4] = 'alex';
      await wb.claim(panel(), K.open, 'Alex');
      assert.equal(g.writes.length, 0);
      assert.equal(g.cell('E3'), 'alex');
    });

    it('refuses, and changes nothing, if the sheet already names someone else', async () => {
      const e = await failure(wb.claim(panel(), K.taken, 'Alex'));
      assert.deepEqual([e.code, e.existing], ['CONFLICT', 'Taylor']);
      assert.match(e.message, /already names \*\*Taylor\*\*/);
      assert.equal(g.writes.length, 0);
    });

    it('refuses a flight the sheet shows as completed or cancelled', async () => {
      assert.equal((await failure(wb.claim(panel(), K.cancelled, 'Alex'))).code, 'CLOSED');
      g.values[2]![7] = 'TRUE';
      assert.equal((await failure(wb.claim(panel(), K.open, 'Alex'))).code, 'CLOSED');
      assert.equal(g.writes.length, 0);
    });

    it('says so when the flight has gone from the sheet, or the tab has no Pilot column', async () => {
      g.values = g.values.filter((r) => r[0] !== 'EGLL-EGCC');
      assert.equal((await failure(wb.claim(panel(), K.open, 'Alex'))).code, 'FLIGHT_NOT_FOUND');
      g.values = scheduleGrid().map((r, i) => (i === 0 ? r.filter((c) => c !== 'Pilot') : r));
      assert.equal((await failure(wb.claim(panel(), K.open, 'Alex'))).code, 'NO_COLUMNS');
      g.values = [['Name', 'Score']];
      assert.equal((await failure(wb.claim(panel(), K.open, 'Alex'))).code, 'NO_COLUMNS');
    });

    it('says so when the panel has no sheet', async () => {
      assert.equal((await failure(wb.claim({ ...panel(), sheetId: null }, K.open, 'Alex'))).code, 'NO_SHEET');
    });

    it('stores a name that looks like a formula as plain text', async () => {
      await wb.claim(panel(), K.open, '=HYPERLINK("https://evil.example","x")');
      assert.equal(g.writes[0]!.valueInputOption, 'RAW');
      assert.equal(g.cell('E3'), '=HYPERLINK("https://evil.example","x")');
    });

    it('passes Google\'s problems on in plain words', async () => {
      g.mode = 'view-only';
      const e = await failure(wb.claim(panel(), K.open, 'Alex'));
      assert.deepEqual([e.code, e.message], ['GOOGLE', "The sheet isn't shared with me as an editor."]);
      g.mode = 'down';
      assert.match((await failure(wb.claim(panel(), K.open, 'Alex'))).message, /HTTP 503/);
    });

    it('lets two pilots act at the same moment without trampling each other: the second sees the first', async () => {
      const results = await Promise.allSettled([wb.claim(panel(), K.open, 'Alex'), wb.claim(panel(), K.open, 'Blake')]);
      assert.equal(results[0]!.status, 'fulfilled');
      assert.equal(results[1]!.status, 'rejected');
      assert.equal(((results[1] as PromiseRejectedResult).reason as WriteBackError).code, 'CONFLICT');
      assert.equal(g.cell('E3'), 'Alex');
    });

    it('re-reads the sheet before writing, so a change a moment ago is respected', async () => {
      g.beforeNextRead = () => {
        g.values[2]![4] = 'Sam'; // someone types a name between the bot deciding and the bot looking
      };
      const e = await failure(wb.claim(panel(), K.open, 'Alex'));
      assert.deepEqual([e.code, e.existing], ['CONFLICT', 'Sam']);
      assert.equal(g.cell('E3'), 'Sam');
    });
  });

  describe('taking a pilot off', () => {
    it('clears the Pilot cell if it is still the name the bot wrote', async () => {
      await wb.claim(panel(), K.open, 'Alex');
      assert.equal(await wb.unclaim(panel(), K.open, 'alex'), true);
      assert.equal(g.cell('E3'), '');
    });

    it('leaves it alone if someone else has since been named, or the flight was completed', async () => {
      g.values[2]![4] = 'Sam';
      assert.equal(await wb.unclaim(panel(), K.open, 'Alex'), false);
      assert.equal(g.cell('E3'), 'Sam');
      g.values[2]![4] = 'Alex';
      g.values[2]![7] = 'TRUE';
      assert.equal(await wb.unclaim(panel(), K.open, 'Alex'), false, 'a completed flight keeps its pilot');
      assert.equal(g.cell('E3'), 'Alex');
    });
  });

  describe('renaming', () => {
    it('changes the name only where it is still the one the bot wrote', async () => {
      g.values[2]![4] = 'Alex';
      assert.equal(await wb.rename(panel(), K.open, 'Alex', 'Alex Smith'), true);
      assert.equal(g.cell('E3'), 'Alex Smith');
      assert.equal(await wb.rename(panel(), K.open, 'Alex', 'Zed'), false);
      assert.equal(g.cell('E3'), 'Alex Smith');
    });
  });

  describe('ticking a flight completed', () => {
    it('writes the pilot\'s name and ticks the box, in one write, when the row had no pilot', async () => {
      await wb.complete(panel(), K.open, 'Alex');
      assert.equal(g.writes.length, 1);
      assert.deepEqual(g.writes[0]!.data, [
        { range: `'${TAB_TITLE}'!E3`, values: [['Alex']] },
        { range: `'${TAB_TITLE}'!H3`, values: [[true]] },
      ]);
      assert.deepEqual([g.cell('E3'), g.cell(`${DONE_COL}3`)], ['Alex', 'TRUE']);
    });

    it('only ticks the box when the pilot is already on the row', async () => {
      g.values[2]![4] = 'Alex';
      await wb.complete(panel(), K.open, 'ALEX');
      assert.deepEqual(g.writes[0]!.data.map((d) => d.range), [`'${TAB_TITLE}'!H3`]);
      assert.equal(g.cell('E3'), 'Alex');
    });

    it('writes nothing if the box is already ticked', async () => {
      g.values[2]![4] = 'Alex';
      g.values[2]![7] = 'TRUE';
      await wb.complete(panel(), K.open, 'Alex');
      assert.equal(g.writes.length, 0);
    });

    it('refuses to tick a flight that names someone else, and changes nothing', async () => {
      const e = await failure(wb.complete(panel(), K.taken, 'Alex'));
      assert.deepEqual([e.code, e.existing], ['CONFLICT', 'Taylor']);
      assert.match(e.message, /names \*\*Taylor\*\*.*haven't ticked it/);
      assert.equal(g.cell('H4'), 'FALSE');
      assert.equal(g.writes.length, 0);
    });

    it('refuses a cancelled flight', async () => {
      assert.equal((await failure(wb.complete(panel(), K.cancelled, 'Alex'))).code, 'CLOSED');
    });

    it('never touches any cell but the two', async () => {
      const before = scheduleGrid();
      await wb.complete(panel(), K.overnight, 'Alex');
      before[4]![4] = 'Alex';
      before[4]![7] = 'TRUE';
      assert.deepEqual(g.values, before);
    });
  });

  describe('checking access', () => {
    it('passes when the sheet can be opened, and says why not otherwise', async () => {
      await wb.check(panel());
      g.mode = 'not-shared';
      const e = await failure(wb.check(panel()));
      assert.deepEqual([e.code, e.message], ['GOOGLE', "The sheet isn't shared with me as an editor."]);
    });
  });
});

/* ------------------------------------------------------------------ what pilots do in Discord */

describe('pilots reserving, releasing and completing flights with write-back on', () => {
  let h: Harness;
  let d: DiscordHarness;
  let g: FakeGoogle;
  let wb: SheetWriteBack;
  let alice: FakeUser;
  let bob: FakeUser;
  const pid = () => h.panel.id;

  /** Make the panel's flights the ones in the sheet, as the hourly read does. */
  const syncFromSheet = () => h.jobs.sync(pid(), parseScheduleValues(g.values, h.clock.now)!.jobs);
  const job = (key: string) => h.store.listJobs(pid()).find((j) => j.sourceKey === key)!;
  const view = (key: string) => h.jobs.view(job(key).id)!;
  const press = async (user: FakeUser, customId: string, o: { values?: string[]; guildId?: string | null; nickname?: string } = {}) => {
    const f = fakeComponent(user, customId, o);
    if (o.nickname) (f.i as any).member.displayName = o.nickname;
    await componentHandlers.find((x) => x.prefix === customId.split(':')[0])!.handle(d.ctx, f.i);
    return f.calls;
  };
  const say = (user: FakeUser, text: string) => handleDmMessage(d.ctx, fakeDm(user, text));
  /** Press Reserve and reply with a flight ID, the way a pilot would. */
  const reserve = async (user: FakeUser, code: string, o: { nickname?: string } = {}) => {
    await press(user, `panel:reserve:${pid()}`, o);
    await say(user, code);
  };
  const panelText = () => d.client.channel(CHANNEL).live.map((m) => messageText(m)).join('\n');

  beforeEach(async () => {
    h = await makeHarness();
    g = new FakeGoogle(publicKey);
    wb = new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, { now: () => h.clock.now });
    d = makeDiscordHarness(h, { writeback: wb });
    alice = d.client.user(new FakeUser(USER_A.discordId, 'alice'));
    bob = d.client.user(new FakeUser(USER_B.discordId, 'bob'));
    h.store.updatePanel(pid(), { sheetId: SHEET_ID, sheetGid: String(TAB_GID) });
    syncFromSheet(); // TST-001 EGLL-EGCC (row 3), TST-002 EGCC-EGLL (Taylor), TST-003 KMIA-KORD, TST-004 EGLL-EGPH, TST-005 EGLL-EGKK
    await d.panels.refresh(pid());
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  describe('reserving', () => {
    it('puts the pilot\'s name in the sheet, remembers what it wrote, and tells them how to change it', async () => {
      await reserve(alice, 'TST-001');
      assert.equal(g.cell('E3'), 'alice');
      assert.equal(view(K.open).legs[0]!.holder?.sheetName, 'alice');
      assert.match(alice.lastText, /reserved for you/);
      assert.match(alice.lastText, /📝 I've put \*\*alice\*\* against it in the airline's sheet\. Not how you appear there\? Reply `name <your name>`/);
    });

    it('starts from their server nickname when they have one', async () => {
      await reserve(alice, 'TST-001', { nickname: 'Alice N' });
      assert.equal(g.cell('E3'), 'Alice N');
      assert.equal(h.store.getPilotName(alice.id), 'Alice N');
    });

    it('keeps using the name they have chosen', async () => {
      await say(alice, 'name Captain Alice');
      await reserve(alice, 'TST-001', { nickname: 'Something Else' });
      assert.equal(g.cell('E3'), 'Captain Alice');
    });

    it('shows the pilot once on the panel, not twice, after the sheet is read back', async () => {
      await reserve(alice, 'TST-001');
      syncFromSheet(); // the hourly read now sees "alice" in the Pilot column
      assert.equal(view(K.open).legs[0]!.sheetHolder, 'alice');
      await d.panels.refresh(pid());
      assert.match(panelText(), new RegExp(`^TST-001 ·[^\\n]*\\n## [^\\n]*\\n(?:[A-Z ]+: [^\\n]*\\n)*PILOT: <@${USER_A.discordId}> · FsHub #1001$`, 'm'));
      assert.doesNotMatch(panelText(), /schedule: alice/);
    });

    it('still shows a different name in the sheet beside the reserver', async () => {
      await reserve(alice, 'TST-001');
      g.values[2]![4] = 'Someone Else';
      syncFromSheet();
      await d.panels.refresh(pid());
      assert.match(panelText(), new RegExp(`<@${USER_A.discordId}> · FsHub #1001 · \\*schedule: Someone Else\\*`));
    });

    it('does not reserve a flight the sheet has already given to someone, and says who has it', async () => {
      g.values[2]![4] = 'Sam'; // typed into the sheet after the last hourly read
      await reserve(alice, 'TST-001');
      assert.match(alice.lastText, /already names \*\*Sam\*\* for that flight\. So I haven't reserved \*\*TST-001\*\* for you/);
      assert.equal(view(K.open).legs[0]!.holder, null);
      assert.equal(view(K.open).legs[0]!.sheetHolder, 'Sam', 'the panel learns it is taken without waiting for the next read');
      assert.equal(g.cell('E3'), 'Sam');
      await settle();
      assert.match(panelText(), /Sam \*\(in the schedule\)\*/);
    });

    it('does not reserve a flight the sheet shows as completed', async () => {
      g.values[2]![7] = 'TRUE';
      await reserve(alice, 'TST-001');
      assert.match(alice.lastText, /already shows that flight as completed or cancelled/);
      assert.equal(h.jobs.mine(pid(), alice.id).length, 0);
    });

    it('keeps the reservation, and says the sheet was not updated, if Google cannot be reached', async () => {
      g.mode = 'down';
      await reserve(alice, 'TST-001');
      assert.match(alice.lastText, /reserved for you/);
      assert.match(alice.lastText, /⚠️ I couldn't update the airline's sheet \(.*HTTP 503.*\).*ask a manager to add you to \*\*TST-001\*\*/);
      assert.equal(view(K.open).legs[0]!.holder?.username, 'alice');
      assert.equal(view(K.open).legs[0]!.holder?.sheetName, null, 'nothing was written, so nothing is remembered');
    });

    it('keeps the reservation, with a clear note, if the sheet is only shared for viewing', async () => {
      g.mode = 'view-only';
      await reserve(alice, 'TST-001');
      assert.match(alice.lastText, /isn't shared with me as an editor/);
      assert.equal(view(K.open).legs[0]!.holder?.username, 'alice');
    });

    it('leaves the sheet alone when an admin has switched write-back off for the panel', async () => {
      h.store.updatePanel(pid(), { writeback: false });
      await reserve(alice, 'TST-001');
      assert.equal(g.writes.length, 0);
      assert.equal(g.calls.length, 0, 'does not even look');
      assert.doesNotMatch(alice.lastText, /📝/);
      assert.equal(view(K.open).legs[0]!.holder?.username, 'alice');
    });

    it('leaves the sheet alone for a flight with several legs, since a sheet row is one leg', async () => {
      h.jobs.sync(pid(), [...parseScheduleValues(g.values, h.clock.now)!.jobs, sj('multi', 'EGLL-EGKK-EGCC')]);
      g.calls.length = 0;
      await press(alice, `panel:reserve:${pid()}`);
      await say(alice, 'TST-006');
      await press(alice, 'dm:all');
      assert.equal(g.calls.length, 0);
      assert.equal(view('multi').legs.every((l) => l.holder?.username === 'alice'), true);
    });

    it('leaves the sheet alone when the bot has no Google credentials', async () => {
      d = makeDiscordHarness(h, { writeback: null });
      await reserve(alice, 'TST-001');
      assert.equal(g.calls.length, 0);
      assert.doesNotMatch(alice.lastText, /📝/);
    });

  });

  describe('releasing', () => {
    const release = (user: FakeUser, key: string) => press(user, `panel:release:${pid()}`, { values: [`${job(key).id}:1`] });

    it('takes the name the bot wrote off the sheet', async () => {
      await reserve(alice, 'TST-001');
      const calls = await release(alice, K.open);
      assert.equal(g.cell('E3'), '');
      assert.match(calls.edits[0].content, /Released: TST-001 leg 1\./);
      assert.match(calls.edits[0].content, /I've taken your name off the airline's sheet too/);
      assert.equal(view(K.open).legs[0]!.holder, null);
    });

    it('leaves the sheet alone if someone else has since been named there', async () => {
      await reserve(alice, 'TST-001');
      g.values[2]![4] = 'Sam';
      const calls = await release(alice, K.open);
      assert.equal(g.cell('E3'), 'Sam');
      assert.doesNotMatch(calls.edits[0].content, /taken your name off/);
    });

    it('still releases, and says the sheet needs a manager, when Google cannot be reached', async () => {
      await reserve(alice, 'TST-001');
      g.mode = 'down';
      const calls = await release(alice, K.open);
      assert.match(calls.edits[0].content, /Released: TST-001/);
      assert.match(calls.edits[0].content, /⚠️ I couldn't take your name off the airline's sheet; please ask a manager/);
      assert.equal(view(K.open).legs[0]!.holder, null);
    });

    it('does not touch the sheet for a reservation the bot never wrote there', async () => {
      h.store.updatePanel(pid(), { writeback: false });
      await reserve(alice, 'TST-001');
      h.store.updatePanel(pid(), { writeback: true });
      g.calls.length = 0;
      await release(alice, K.open);
      assert.equal(g.calls.length, 0);
    });
  });

  describe('changing the name', () => {
    it('remembers it for next time and tells them', async () => {
      await say(alice, 'name Alex Smith');
      assert.equal(h.store.getPilotName(alice.id), 'Alex Smith');
      assert.match(alice.lastText, /I'll call you \*\*Alex Smith\*\* in airline sheets from now on/);
    });

    it('also corrects the name already in the sheet on their reservations', async () => {
      await reserve(alice, 'TST-001');
      await reserve(alice, 'TST-004');
      await say(alice, 'name Alex Smith');
      assert.deepEqual([g.cell('E3'), g.cell('E7')], ['Alex Smith', 'Alex Smith']);
      assert.equal(view(K.open).legs[0]!.holder?.sheetName, 'Alex Smith');
      assert.match(alice.lastText, /changed it on 2 flights/);
    });

    it('does not overwrite a name someone else put there since', async () => {
      await reserve(alice, 'TST-001');
      g.values[2]![4] = 'Sam';
      await say(alice, 'name Alex Smith');
      assert.equal(g.cell('E3'), 'Sam');
    });

    it('says when the sheet could not be updated', async () => {
      await reserve(alice, 'TST-001');
      g.mode = 'down';
      await say(alice, 'name Alex Smith');
      assert.match(alice.lastText, /⚠️ I couldn't change it on 1 flight; please ask a manager/);
      assert.equal(h.store.getPilotName(alice.id), 'Alex Smith', 'the new name is used from now on regardless');
    });

    it('needs a name, and keeps it short and plain', async () => {
      await say(alice, 'name');
      assert.match(alice.lastText, /Tell me the name like this/);
      await say(alice, `name ${'x'.repeat(100)}\u0007`);
      assert.equal(h.store.getPilotName(alice.id)!.length, 40);
      assert.doesNotMatch(h.store.getPilotName(alice.id)!, /[\u0000-\u001f]/);
    });

    it('works in the middle of a Reserve conversation without ending it', async () => {
      await press(alice, `panel:reserve:${pid()}`);
      await say(alice, 'name Alex Smith');
      assert.ok(h.store.getSession(alice.id, h.clock.now), 'the conversation is still open');
      await say(alice, 'TST-001');
      assert.equal(g.cell('E3'), 'Alex Smith');
    });
  });

  describe('completing a flight', () => {
    const jobId = (key: string) => job(key).id;
    /** Reserve, press Complete, pick, confirm. Returns what the last step said. */
    const complete = async (user: FakeUser, keys: string[]) => {
      const start = await press(user, `panel:complete:${pid()}`);
      const pick = await press(user, `panel:completepick:${pid()}`, { values: keys.map((k) => String(jobId(k))) });
      const confirm = pick.updates[0]?.components?.[0]?.toJSON().components[0].custom_id as string | undefined;
      const done = confirm ? await press(user, confirm) : null;
      return { start, pick, confirm, done };
    };

    it('lists the flights they hold, asks for a yes, then ticks the box and shows the flight as completed', async () => {
      await reserve(alice, 'TST-001');
      const start = await press(alice, `panel:complete:${pid()}`);
      assert.deepEqual(start.defers[0], { flags: 64 }, 'private to them');
      const menu = start.edits[0].components[0].toJSON().components[0];
      assert.equal(menu.custom_id, `panel:completepick:${pid()}`);
      assert.deepEqual(menu.options.map((o: any) => [o.label, o.value]), [['TST-001 · EGLL → EGCC', String(jobId(K.open))]]);

      const pick = await press(alice, `panel:completepick:${pid()}`, { values: [String(jobId(K.open))] });
      assert.match(pick.updates[0].content, /Mark \*\*TST-001\*\* as completed\? This ticks \*Flight Completed\* in the airline's sheet/);
      const confirm = pick.updates[0].components[0].toJSON().components[0].custom_id as string;
      assert.equal(confirm, `panel:completeyes:${pid()}:${jobId(K.open)}`);
      assert.equal(g.cell('H3'), 'FALSE', 'nothing is written until they confirm');
      assert.equal(job(K.open).completedAt, null);

      const done = await press(alice, confirm);
      assert.match(done.edits[0].content, /✅ \*\*TST-001\*\* is completed and ticked in the airline's sheet\. Nice flying!/);
      assert.deepEqual([g.cell('E3'), g.cell('H3')], ['alice', 'TRUE']);
      const j = job(K.open);
      assert.deepEqual([j.status, j.completedAt, j.completedBy], ['expired', T0, alice.id]);
      assert.equal(h.jobs.open(pid()).some((v) => v.job.id === j.id), false);
      await settle();
      assert.match(panelText(), new RegExp(`^TST-001 · A320\\n## EGLL ✈ EGCC\\n(?:[A-Z ]+: [^\\n]*\\n)*FLOWN BY: <@${USER_A.discordId}>`, 'm'));
    });

    it('can complete several at once', async () => {
      await reserve(alice, 'TST-001');
      await reserve(alice, 'TST-004');
      const { done } = await complete(alice, [K.open, K.other]);
      assert.match(done!.edits[0].content, /TST-001.*completed[\s\S]*TST-004.*completed/);
      assert.deepEqual([g.cell('H3'), g.cell('H7')], ['TRUE', 'TRUE']);
    });

    it('fills in the pilot\'s name too if the row had none (they reserved before write-back was on)', async () => {
      h.store.updatePanel(pid(), { writeback: false });
      await reserve(alice, 'TST-001');
      h.store.updatePanel(pid(), { writeback: true });
      assert.equal(g.cell('E3'), '');
      await complete(alice, [K.open]);
      assert.deepEqual([g.cell('E3'), g.cell('H3')], ['alice', 'TRUE']);
    });

    it('does not complete a flight the sheet has given to someone else', async () => {
      await reserve(alice, 'TST-001');
      g.values[2]![4] = 'Sam';
      const { done } = await complete(alice, [K.open]);
      assert.match(done!.edits[0].content, /⚠️ \*\*TST-001\*\* isn't completed: The sheet names \*\*Sam\*\* for that flight, so I haven't ticked it/);
      assert.equal(g.cell('H3'), 'FALSE');
      assert.equal(job(K.open).completedAt, null);
      assert.equal(h.jobs.open(pid()).some((v) => v.job.sourceKey === K.open), true, 'still open, still theirs');
    });

    it('does not mark it completed here if the sheet cannot be updated, so the two never disagree', async () => {
      await reserve(alice, 'TST-001');
      g.mode = 'view-only';
      const { done } = await complete(alice, [K.open]);
      assert.match(done!.edits[0].content, /⚠️ \*\*TST-001\*\* isn't completed: The sheet isn't shared with me as an editor/);
      assert.equal(job(K.open).completedAt, null);
      g.mode = 'ok';
      const again = await complete(alice, [K.open]);
      assert.match(again.done!.edits[0].content, /is completed/, 'and they can simply try again');
    });

    it('does each flight on its own: one failing does not stop the others', async () => {
      await reserve(alice, 'TST-001');
      await reserve(alice, 'TST-004');
      g.values[2]![4] = 'Sam'; // TST-001 is taken in the sheet
      const { done } = await complete(alice, [K.open, K.other]);
      assert.match(done!.edits[0].content, /TST-001.*isn't completed/);
      assert.match(done!.edits[0].content, /TST-004.*is completed/);
      assert.deepEqual([g.cell('H3'), g.cell('H7')], ['FALSE', 'TRUE']);
    });

    it('has nothing to offer someone who holds nothing', async () => {
      const calls = await press(bob, `panel:complete:${pid()}`);
      assert.match(calls.edits[0].content, /You don't have a flight to complete/);
      assert.equal(calls.edits[0].components, undefined);
    });

    it('only offers their own flights, never someone else\'s', async () => {
      await reserve(alice, 'TST-001');
      await reserve(bob, 'TST-004');
      const menu = (await press(alice, `panel:complete:${pid()}`)).edits[0].components[0].toJSON().components[0];
      assert.deepEqual(menu.options.map((o: any) => o.label), ['TST-001 · EGLL → EGCC']);
    });

    it('will not let someone complete a flight by sending another person\'s flight number', async () => {
      await reserve(alice, 'TST-001');
      const pick = await press(bob, `panel:completepick:${pid()}`, { values: [String(jobId(K.open))] });
      assert.match(pick.updates[0].content, /aren't yours to complete any more/);
      const sneaky = await press(bob, `panel:completeyes:${pid()}:${jobId(K.open)}`);
      assert.match(sneaky.edits[0].content, /no longer yours to complete/);
      assert.equal(g.cell('H3'), 'FALSE');
      assert.equal(job(K.open).completedAt, null);
    });

    it('can be cancelled at the confirmation, changing nothing', async () => {
      await reserve(alice, 'TST-001');
      const calls = await press(alice, `panel:completeno:${pid()}`);
      assert.match(calls.updates[0].content, /nothing was changed/);
      assert.equal(g.writes.length > 0, true, 'only the name from reserving');
      assert.equal(g.cell('H3'), 'FALSE');
    });

    it('completing twice does not tick it twice', async () => {
      await reserve(alice, 'TST-001');
      await complete(alice, [K.open]);
      const writes = g.writes.length;
      const second = await press(alice, `panel:completeyes:${pid()}:${jobId(K.open)}`);
      assert.match(second.edits[0].content, /no longer yours to complete/);
      assert.equal(g.writes.length, writes);
    });

    it('refuses in plain words when the panel keeps its flights in a sheet the bot cannot write to', async () => {
      await reserve(alice, 'TST-001');
      d = makeDiscordHarness(h, { writeback: null });
      await assert.rejects(press(alice, `panel:complete:${pid()}`), (e: unknown) => e instanceof UserError && /keeps its flights in a Google Sheet, and I can't write to it/.test(e.message) && /\/setup writeback/.test(e.message));
      h.store.updatePanel(pid(), { writeback: false });
      d = makeDiscordHarness(h, { writeback: wb });
      await assert.rejects(press(alice, `panel:complete:${pid()}`), /can't write to it/);
    });

    it('leaves a flight with several legs to be ticked in the sheet', async () => {
      h.jobs.sync(pid(), [...parseScheduleValues(g.values, h.clock.now)!.jobs, sj('multi', 'EGLL-EGKK-EGCC')]);
      await press(alice, `panel:reserve:${pid()}`);
      await say(alice, 'TST-006');
      await press(alice, 'dm:all');
      const menu = (await press(alice, `panel:complete:${pid()}`)).edits[0];
      assert.match(menu.content, /You don't have a flight to complete/);
    });

    it('can still be done shortly after the landing window closes, but not days later', async () => {
      await reserve(alice, 'TST-003'); // KMIA-KORD, window ends 11/13 06:00Z
      h.clock.advance(20 * HOUR); // 11/12 08:00Z: still in the window
      h.clock.advance(24 * HOUR); // 11/13 08:00Z: window closed two hours ago
      h.jobs.expireDue();
      assert.equal(job(K.overnight).status, 'expired');
      const { done } = await complete(alice, [K.overnight]);
      assert.match(done!.edits[0].content, /TST-003.*is completed/);
    });
  });

  describe('admins releasing someone', () => {
    const setup = commands.find((c) => c.data.name === 'setup')!;
    it('takes the bot\'s name off the sheet too, and says so', async () => {
      await reserve(alice, 'TST-001');
      const f = fakeInteraction({ sub: 'release', admin: true, options: { code: 'TST-001' } });
      await setup.execute(d.ctx, f.i);
      assert.equal(g.cell('E3'), '');
      assert.match(f.calls.edits.at(-1).content, /Released <@\d+> \(leg 1\) on TST-001\. They have been told\. I've taken their name off the airline's sheet too\./);
    });

    it('says when it could not', async () => {
      await reserve(alice, 'TST-001');
      g.mode = 'down';
      const f = fakeInteraction({ sub: 'release', admin: true, options: { code: 'TST-001' } });
      await setup.execute(d.ctx, f.i);
      assert.match(f.calls.edits.at(-1).content, /⚠️ I couldn't take their name off the airline's sheet, so you'll need to/);
    });
  });
});

/* ------------------------------------------------------------------ completion rules (no Discord) */

describe('completing flights: the rules', () => {
  let h: Harness;
  const pid = () => h.panel.id;
  const onlyJob = () => h.jobs.open(pid())[0]!;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });
  const flightAt = (over: object = {}) => sj('a', 'EGLL-EGKK', { availableFrom: T0 - HOUR, deadline: T0 + 20 * HOUR, ...over });

  it('needs every leg of the flight to be yours', () => {
    h.jobs.sync(pid(), [sj('m', 'EGLL-EGKK-EGCC')]);
    h.jobs.reserve(onlyJob().job.id, [1], USER_A);
    assert.deepEqual(h.jobs.completable(pid(), USER_A.discordId), [], 'one leg of two is not enough');
    assert.throws(() => h.jobs.complete(onlyJob().job.id, USER_A.discordId), (e: unknown) => e instanceof JobError && /legs that aren't yours/.test(e.message));
    h.jobs.reserve(onlyJob().job.id, [2], USER_B);
    h.jobs.release(onlyJob().job.id, USER_B.discordId);
    h.jobs.reserve(onlyJob().job.id, [2], USER_A);
    assert.equal(h.jobs.completable(pid(), USER_A.discordId).length, 1);
    assert.equal(h.jobs.complete(onlyJob().job.id, USER_A.discordId).job.completedBy, USER_A.discordId);
  });

  it('is only for the person who holds the flight', () => {
    h.jobs.sync(pid(), [flightAt()]);
    h.jobs.reserve(onlyJob().job.id, [1], USER_A);
    assert.throws(() => h.jobs.complete(onlyJob().job.id, USER_B.discordId), JobError);
    assert.equal(h.jobs.open(pid()).length, 1, 'nothing changed');
  });

  it('cannot be done twice or on a flight that has gone', () => {
    h.jobs.sync(pid(), [flightAt()]);
    const id = onlyJob().job.id;
    h.jobs.reserve(id, [1], USER_A);
    h.jobs.complete(id, USER_A.discordId);
    assert.throws(() => h.jobs.complete(id, USER_A.discordId), /no longer open/);
    h.jobs.sync(pid(), [sj('b', 'EGLL-EGCC')]);
    assert.throws(() => h.jobs.complete(id, USER_A.discordId), JobError, 'a flight the source dropped (removed) cannot be completed either');
  });

  it('is allowed for two days after the deadline, then not', () => {
    h.jobs.sync(pid(), [flightAt({ deadline: T0 + HOUR })]);
    const id = onlyJob().job.id;
    h.jobs.reserve(id, [1], USER_A);
    h.clock.advance(2 * HOUR);
    h.jobs.expireDue();
    assert.equal(h.jobs.completable(pid(), USER_A.discordId).length, 1);
    h.clock.advance(COMPLETE_AFTER_DEADLINE_MS);
    assert.equal(h.jobs.completable(pid(), USER_A.discordId).length, 0);
    assert.throws(() => h.jobs.complete(id, USER_A.discordId), /no longer open/);
  });

  it('tells the panel to redraw', () => {
    const seen: string[] = [];
    h.events.subscribe((e) => void seen.push(e.type));
    h.jobs.sync(pid(), [flightAt()]);
    h.jobs.reserve(onlyJob().job.id, [1], USER_A);
    seen.length = 0;
    h.jobs.complete(onlyJob().job.id, USER_A.discordId);
    assert.deepEqual(seen, ['changed']);
  });

  describe('against what the source says next', () => {
    const complete = () => {
      h.jobs.sync(pid(), [flightAt()]);
      h.jobs.reserve(onlyJob().job.id, [1], USER_A);
      h.jobs.complete(onlyJob().job.id, USER_A.discordId);
    };
    const status = () => h.store.listJobs(pid())[0]!;

    it('a source that does not track completion cannot undo it', () => {
      complete();
      h.clock.advance(5 * HOUR);
      h.jobs.sync(pid(), [flightAt()]); // `completed` is not set at all
      assert.deepEqual([status().status, status().completedBy], ['expired', USER_A.discordId]);
      assert.equal(h.jobs.open(pid()).length, 0);
      assert.equal(h.jobs.completed(pid()).length, 1);
    });

    it('a sheet that has not caught up yet is not believed for ten minutes', () => {
      complete();
      h.clock.advance(COMPLETION_GRACE_MS - 1);
      const r = h.jobs.sync(pid(), [flightAt({ completed: false })]);
      assert.equal(r.updated, 0);
      assert.equal(status().completedAt, T0);
      assert.equal(h.jobs.open(pid()).length, 0);
    });

    it('but one that still says "not completed" after that is believed: the flight reopens', () => {
      complete();
      h.clock.advance(COMPLETION_GRACE_MS);
      h.jobs.sync(pid(), [flightAt({ completed: false })]);
      assert.equal(status().completedAt, null);
      assert.equal(status().completedBy, null);
      assert.equal(h.jobs.open(pid()).length, 1);
    });

    it('a sheet that agrees keeps who completed it', () => {
      complete();
      h.clock.advance(HOUR);
      h.jobs.sync(pid(), [flightAt({ completed: true, closed: true })]);
      assert.deepEqual([status().completedAt, status().completedBy], [T0, USER_A.discordId]);
    });

    it('a flight the sheet itself marks completed has no pilot recorded as the one who did it here', () => {
      h.jobs.sync(pid(), [flightAt()]);
      h.jobs.sync(pid(), [flightAt({ completed: true, closed: true })]);
      assert.equal(status().completedBy, null);
    });
  });
});

/* ------------------------------------------------------------------ admin commands */

describe('/setup writeback and the sheet link', () => {
  const setup = commands.find((c) => c.data.name === 'setup')!;
  let h: Harness;
  let d: DiscordHarness;
  let g: FakeGoogle;
  let wb: SheetWriteBack;
  let csvOf: () => string;

  const guild = { channels: { fetch: async (id: string) => ({ id, permissionsFor: () => ({ has: () => true }) }) }, members: { me: {}, fetchMe: async () => ({}) } };
  const run = async (sub: string, o: FakeInteractionOptions = {}) => {
    const f = fakeInteraction({ sub, admin: true, guild, ...o });
    await setup.execute(d.ctx, f.i);
    await settle();
    return f.calls;
  };
  const text = (calls: { edits: any[] }) => String(calls.edits.at(-1)?.content ?? '');
  const panelOf = () => h.store.getPanelByName(GUILD, 'Test Air')!;

  /** The public CSV address a linked sheet is read from. */
  const csvFetch = (async (url: string) => {
    const u = String(url);
    if (u.includes('/export?format=csv')) return new Response(null, { status: 307, headers: { location: 'https://doc-0g-34-sheets.googleusercontent.com/export/x' } });
    return new Response(csvOf(), { status: 200, headers: { 'content-type': 'text/csv' } });
  }) as unknown as typeof fetch;

  const boot = async (writeback: SheetWriteBack | null) => {
    d = makeDiscordHarness(h, { writeback, fetchFn: csvFetch });
    h.store.deletePanel(h.panel.id);
    await run('panel-add', { options: { airline: 'Test Air', prefix: 'TST', channel: { id: CHANNEL } } });
  };
  const link = () => run('sheet', { options: { link: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=${TAB_GID}` } });

  beforeEach(async () => {
    h = await makeHarness();
    g = new FakeGoogle(publicKey);
    wb = new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, { now: () => h.clock.now });
    csvOf = () => g.values.map((r) => r.join(',')).join('\n');
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('is admin-only', async () => {
    await boot(wb);
    await assert.rejects(run('writeback', { admin: false, options: { mode: 'off' } }), (e: unknown) => e instanceof UserError && /Manage Server/.test(e.message));
    assert.equal(panelOf().writeback, true);
  });

  describe('linking a sheet', () => {
    it('says it only reads when the bot has no Google credentials, and where to set that up', async () => {
      await boot(null);
      const calls = await link();
      assert.match(text(calls), /read again every hour/);
      assert.match(text(calls), /only \*\*read\*\* the sheet and never change it/);
      assert.match(text(calls), /docs\/WRITEBACK_SETUP\.md/);
    });

    it('says write-back is on, and exactly what it will touch, when the bot can open the sheet', async () => {
      await boot(wb);
      const calls = await link();
      assert.match(text(calls), /✅ \*\*Write-back is on\.\*\*/);
      assert.match(text(calls), /write their name in the \*Pilot\* column and tick \*Flight Completed\* on that flight's row, and nothing else/);
      assert.doesNotMatch(text(calls), /only \*\*read\*\*/);
    });

    it('tells the admin to share the sheet with the bot, naming the address, when it cannot open it yet', async () => {
      g.mode = 'not-shared';
      await boot(wb);
      const calls = await link();
      assert.match(text(calls), new RegExp(`⚠️ Write-back is on, but I can't open the sheet yet: .* Share it with \\*\\*${account.email.replace(/\./g, '\\.')}\\*\\* as an \\*Editor\\*`));
      assert.match(text(calls), /reads its flights from your sheet/, 'linking itself still works');
    });

    it('says it is off when an admin has switched it off', async () => {
      await boot(wb);
      h.store.updatePanel(panelOf().id, { writeback: false });
      assert.match(text(await link()), /write-back is switched \*\*off\*\* for this panel/);
    });
  });

  describe('/setup writeback', () => {
    it('explains when there is no sheet', async () => {
      await boot(wb);
      assert.match(text(await run('writeback')), /write-back is \*\*on\*\*\.\nThis panel has no Google Sheet linked/);
    });

    it('explains when the bot has no credentials', async () => {
      await boot(null);
      await link();
      assert.match(text(await run('writeback')), /no Google credentials, so it can only read the sheet.*WRITEBACK_SETUP/);
    });

    it('confirms access, or says what to share, when credentials exist', async () => {
      await boot(wb);
      await link();
      assert.match(text(await run('writeback')), /write-back is \*\*on\*\*\.\n✅ \*\*Write-back is on\.\*\*/);
      g.mode = 'not-shared';
      assert.match(text(await run('writeback')), /Share it with \*\*flight-bot@test-project/);
    });

    it('switches it off and on for a panel', async () => {
      await boot(wb);
      await link();
      assert.match(text(await run('writeback', { options: { mode: 'off' } })), /write-back is \*\*off\*\*\./);
      assert.equal(panelOf().writeback, false);
      assert.match(text(await run('writeback', { options: { mode: 'on' } })), /write-back is \*\*on\*\*\./);
      assert.equal(panelOf().writeback, true);
    });

    it('shows in /setup panels', async () => {
      await boot(wb);
      assert.doesNotMatch(text(await run('panels')), /write-back/, 'nothing to say without a sheet');
      await link();
      assert.match(text(await run('panels')), /sheet write-back: on/);
      await run('writeback', { options: { mode: 'off' } });
      assert.match(text(await run('panels')), /sheet write-back: off/);
      await boot(null);
      await link();
      assert.match(text(await run('panels')), /sheet write-back: unavailable/);
    });
  });
});

/* ------------------------------------------------------------------ hourly reads */

describe('how often a sheet is read', () => {
  it('every hour for a linked sheet, every 24 hours for anything else', () => {
    assert.equal(SHEET_REFRESH_INTERVAL_MS, HOUR);
    assert.equal(REFRESH_INTERVAL_MS, 24 * HOUR);
    assert.equal(refreshIntervalFor({ sheetId: SHEET_ID }), HOUR);
    assert.equal(refreshIntervalFor({ sheetId: null }), 24 * HOUR);
  });

  it('the scheduler\'s refresher reads a sheet panel after an hour, and a demo panel not until a day', async () => {
    const h = await makeHarness();
    try {
      let reads = 0;
      const { SourceRefresher } = await import('../src/services/refresh.js');
      const source = { kind: 'fake', fetch: async () => (reads++, []) };
      const refresher = new SourceRefresher(h.store, h.jobs, () => source, undefined, () => h.clock.now);

      await refresher.refreshDue(); // first ever read
      assert.equal(reads, 1);
      h.clock.advance(HOUR + 1);
      await refresher.refreshDue();
      assert.equal(reads, 1, 'a panel with no sheet waits a day');

      h.store.updatePanel(h.panel.id, { sheetId: SHEET_ID, sheetGid: '1' });
      await refresher.refreshDue();
      assert.equal(reads, 2, 'a sheet is due after an hour');
      h.clock.advance(HOUR - 1);
      await refresher.refreshDue();
      assert.equal(reads, 2, 'but not before');
      h.clock.advance(2);
      await refresher.refreshDue();
      assert.equal(reads, 3);
    } finally {
      await h.close();
    }
  });
});
