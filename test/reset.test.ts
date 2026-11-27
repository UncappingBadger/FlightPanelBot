import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { BotHandle } from '../src/bot.js';
import { openDatabase } from '../src/db/db.js';
import { Store } from '../src/db/store.js';
import { createFileLogger } from '../src/host/fileLogger.js';
import { renderPage } from '../src/host/page.js';
import { hostPaths, type HostPaths } from '../src/host/paths.js';
import { deleteEverything, RESET_MARKER, resettable } from '../src/host/reset.js';
import { loadSettings, saveSettings } from '../src/host/settings.js';
import { Supervisor } from '../src/host/supervisor.js';
import { UpdateChecker } from '../src/host/updates.js';
import { RESET_CONFIRMATION, startWebServer, type WebServer } from '../src/host/web.js';
import { writeTokens } from '../src/twitch/tokens.js';
import { silentLogger } from '../src/util/log.js';

/* "Reset everything" on the settings page. Everything here is made up, in a throwaway folder. */

const KEY = 'secret-key-abc';
const TOKEN = `${Buffer.from('123456789012345678').toString('base64')}.abcdef.${'x'.repeat(30)}`;

describe('Reset everything', () => {
  let dir: string;
  let paths: HostPaths;
  let web: WebServer;
  let supervisor: Supervisor;
  let started: number;
  let open: number;
  let startGate: Promise<void> | null;
  let discordGate: Promise<void> | null;
  let revoked: number;
  let cleared: number;

  /** A bot that holds its database open until it is stopped, as the real one does. */
  const startBot = async (): Promise<BotHandle> => {
    mkdirSync(paths.dataDir, { recursive: true });
    const store = new Store(openDatabase(paths.database));
    started++;
    open++;
    if (startGate) await startGate;
    return {
      userTag: 'Airline Bot#0001',
      userId: '123456789012345678',
      servers: () => [],
      settings: null as unknown as BotHandle['settings'],
      setup: null as unknown as BotHandle['setup'],
      stop: async () => {
        store.close();
        open--;
      },
    };
  };
  const fakeFetch = (async (url: string) => {
    if (String(url).includes('id.twitch.tv')) revoked++;
    else if (discordGate) await discordGate;
    return new Response(JSON.stringify({ id: '123456789012345678', username: 'Airline Bot' }), { status: 200 });
  }) as unknown as typeof fetch;

  const url = (path: string) => `http://127.0.0.1:${web.port}${path}?k=${KEY}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url(path), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const reset = () => post('/api/reset', { confirm: RESET_CONFIRMATION });
  const file = (...parts: string[]) => join(dir, ...parts);
  const put = (...parts: string[]) => {
    mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(file(...parts), 'x');
  };
  /** Everything the app writes, as a bot that has been used for a while would have it. */
  const fill = () => {
    saveSettings(paths, { discordToken: TOKEN, checkForUpdates: false, logLevel: 'info', fshubAccessToken: 'fshub-token-value' });
    put('settings.json.unreadable');
    put('google-key.json');
    put('twitch-status.json');
    put('update-state.json');
    put('.startup-tip');
    put('data', 'banking.key');
    put('data', 'hard-landings.csv');
    put('data', 'backups', 'before-upgrade-from-v41', 'bot.sqlite');
    put('logs', 'bot.log');
    put('logs', 'launcher.log');
    writeTokens(paths.twitchTokens, { clientId: 'c'.repeat(30), accessToken: 'a', refreshToken: 'r', expiresAt: 1, userId: '1', login: 'someone', scopes: [] });
    // Not the app's: somebody's own file in the same folder.
    put('my notes.txt');
    put('my folder', 'keep.txt');
  };
  const goneAll = () => {
    for (const target of [paths.settings, `${paths.settings}.unreadable`, paths.googleKey, paths.twitchTokens, paths.twitchStatus, paths.updateState, file('.startup-tip'), paths.database, paths.dataDir, paths.logsDir]) {
      assert.equal(existsSync(target), false, target);
    }
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fpb-reset-'));
    paths = hostPaths(dir);
    started = open = revoked = cleared = 0;
    startGate = discordGate = null;
    supervisor = new Supervisor({ paths, log: silentLogger, version: '9.9.9', onState: () => {}, startBot });
    const updates = new UpdateChecker({ version: '9.9.9', statePath: paths.updateState, autoEnabled: () => false, fetchFn: fakeFetch, repo: 'o/r' });
    web = await startWebServer({ supervisor, updates, paths, log: silentLogger, version: '9.9.9', key: KEY, tail: () => [], clearLog: () => cleared++, onQuit: () => {}, fetchFn: fakeFetch });
  });
  afterEach(async () => {
    await web.close();
    await supervisor.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stops the bot and deletes everything it has saved, and nothing else, leaving first-time setup', async () => {
    fill();
    await supervisor.start();
    assert.equal(supervisor.state().phase, 'online');
    assert.equal(open, 1, 'the database is open');
    const res = await reset();
    assert.equal(res.status, 200);
    goneAll();
    assert.equal(open, 0, 'the database was closed first');
    assert.equal(readFileSync(file('my notes.txt'), 'utf8'), 'x');
    assert.equal(existsSync(file('my folder', 'keep.txt')), true);
    assert.equal(existsSync(file(RESET_MARKER)), true, 'for the launcher, which keeps "Start with Windows"');
    assert.equal(revoked, 1, 'the Twitch sign-in was withdrawn at Twitch');
    assert.equal(cleared, 1, 'and the log lines kept in memory are gone');
    await supervisor.start();
    assert.equal(supervisor.state().phase, 'needs-setup');
    assert.equal(loadSettings(paths).discordToken, '');
    assert.equal(started, 1, 'nothing was started again');
  });

  it('does nothing without the confirmation, or from another site', async () => {
    fill();
    for (const body of [{}, { confirm: true }, { confirm: 'reset' }]) {
      const res = await post('/api/reset', body);
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, /Nothing was reset/);
    }
    assert.equal((await post('/api/reset', { confirm: RESET_CONFIRMATION }, { origin: 'https://example.com' })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${web.port}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: RESET_CONFIRMATION }) })).status, 403, 'without the key');
    assert.equal(loadSettings(paths).discordToken, TOKEN);
    assert.equal(existsSync(file('data', 'banking.key')), true);
  });

  it('waits for a start that is under way, which has the database open, before deleting', async () => {
    fill();
    let let_go!: () => void;
    startGate = new Promise<void>((r) => (let_go = r));
    const starting = supervisor.start();
    while (started === 0) await new Promise((r) => setTimeout(r, 5));
    const resetting = reset();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(existsSync(paths.settings), true, 'nothing is deleted while the start still holds the database');
    let_go();
    assert.equal((await resetting).status, 200);
    await starting;
    assert.equal(open, 0);
    assert.equal(existsSync(paths.database), false);
    assert.equal(existsSync(paths.settings), false);
  });

  it('does not let a save that was being checked put back what was just deleted', async () => {
    fill();
    let let_go!: () => void;
    discordGate = new Promise<void>((r) => (let_go = r));
    const saving = post('/api/settings', { discordToken: TOKEN });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await reset()).status, 200);
    let_go();
    const res = await saving;
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /was not saved/);
    assert.equal(existsSync(paths.settings), false);
  });

  it('says what could not be deleted, rather than claim it all went', () => {
    fill();
    // The same list the reset walks: every entry is inside the app's own folder.
    for (const target of resettable(paths)) assert.ok(target.startsWith(dir) && target !== dir, target);
    assert.deepEqual(deleteEverything(paths), []);
    assert.deepEqual(deleteEverything(paths), [], 'and a second time there is nothing left to fail');
  });

  it('forgets the log lines it holds in memory', () => {
    const logger = createFileLogger({ file: paths.logFile });
    logger.log.info('a line with a pilot name');
    assert.equal(logger.tail(10).length, 1);
    logger.clear();
    assert.deepEqual(logger.tail(10), []);
  });

  it('has a red button at the top of the settings page, which only opens a warning that it cannot be undone', () => {
    const html = renderPage('1.0.0');
    assert.ok(html.indexOf('id="reset-open"') < html.indexOf('id="nav"'), 'above everything else');
    assert.match(html, /<button class="danger" id="reset-open" type="button">Reset everything<\/button>/);
    assert.match(html, /button\.danger \{ background:#c62828;/);
    assert.match(html, /<h2 id="reset-title">Reset everything\? This cannot be undone\.<\/h2>/);
    assert.match(html, /the record of payments made to pilots\./);
    assert.match(html, /id="reset-cancel" type="button" autofocus>Cancel</);
    assert.match(html, /\$\('reset-open'\)\.onclick = function \(\) \{[^}]*showModal\(\)/);
    assert.doesNotMatch(html.slice(html.indexOf("$('reset-open').onclick"), html.indexOf("$('reset-cancel').onclick")), /api\(/, 'the first button deletes nothing');
    assert.ok(html.includes(`confirm: '${RESET_CONFIRMATION}'`), 'the page sends what the server asks for');
  });
});
