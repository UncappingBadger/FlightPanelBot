import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { BotHandle } from '../src/bot.js';
import { renderPage } from '../src/host/page.js';
import { hostPaths, type HostPaths } from '../src/host/paths.js';
import { loadSettings, normalizeChannel, saveSettings, toConfig } from '../src/host/settings.js';
import { Supervisor } from '../src/host/supervisor.js';
import { UpdateChecker } from '../src/host/updates.js';
import { startWebServer, type WebServer } from '../src/host/web.js';
import { BUILT_IN_TWITCH_CLIENT_ID, validClientId } from '../src/twitch/clientId.js';
import { readTokens, writeTokens } from '../src/twitch/tokens.js';
import { silentLogger } from '../src/util/log.js';
import { CLIENT, FakeTwitchHttp } from './twitch-fakes.js';

const BOT_ID = '1234567890123456789';
const TOKEN = `${Buffer.from(BOT_ID).toString('base64')}.Gabc12.${'x'.repeat(27)}`;
const KEY = 'test-key-1234567890';
const SCOPES = ['user:read:chat', 'user:write:chat'];

let dir: string;
let paths: HostPaths;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fpb-twitch-host-'));
  paths = hostPaths(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/* ------------------------------------------------------------------ settings */

describe('the Twitch settings', () => {
  it('reads a channel however it was pasted, and refuses what cannot be one', () => {
    assert.deepEqual(
      ['testair', '#TestAir', '@testair', ' https://www.twitch.tv/TestAir ', 'twitch.tv/testair', 'https://twitch.tv/testair?sr=a', 'test_air_99'].map(normalizeChannel),
      ['testair', 'testair', 'testair', 'testair', null, 'testair', 'test_air_99'],
      'a bare "twitch.tv/name" is not a link the browser would have given, and is refused rather than guessed at',
    );
    for (const bad of ['', 'ab', 'a b', 'name!', 'x'.repeat(26), 'https://example.com/testair']) assert.equal(normalizeChannel(bad), null, bad);
  });

  it('leave no trace in the settings file of a host who never set them up', () => {
    saveSettings(paths, loadSettings(paths));
    const text = readFileSync(paths.settings, 'utf8');
    assert.equal(/twitch/i.test(text), false, text);
  });

  it('are kept and read back, with what was not given left out', () => {
    const s = loadSettings(paths);
    s.discordToken = TOKEN;
    s.twitch = { channel: 'testair', commands: false, banter: true, pilotId: 7001, clientId: CLIENT };
    saveSettings(paths, s);
    assert.deepEqual(loadSettings(paths).twitch, { channel: 'testair', commands: false, banter: true, pilotId: 7001, clientId: CLIENT });
    s.twitch = { channel: 'testair', commands: true, banter: true };
    saveSettings(paths, s);
    const text = readFileSync(paths.settings, 'utf8');
    assert.equal(/twitchPilotId|twitchClientId/.test(text), false, 'no pilot or Client ID unless there is one');
    assert.deepEqual(loadSettings(paths).twitch, { channel: 'testair', commands: true, banter: true });
  });

  it('survive a hand-edited file with nonsense in it', () => {
    writeFileSync(paths.settings, JSON.stringify({ discordToken: TOKEN, twitchChannel: 'not a channel!', twitchClientId: 'short', twitchPilotId: -4, twitchCommands: 'yes' }));
    assert.equal(loadSettings(paths).twitch, undefined, 'nothing usable, so nothing');
    writeFileSync(paths.settings, JSON.stringify({ discordToken: TOKEN, twitchChannel: 'TestAir', twitchClientId: CLIENT }));
    assert.deepEqual(loadSettings(paths).twitch, { channel: 'testair', commands: true, banter: true, clientId: CLIENT });
  });

  it('become the bot\'s Twitch config only when a channel is chosen, with the sign-in file beside the settings', () => {
    const s = loadSettings(paths);
    s.discordToken = TOKEN;
    assert.equal(toConfig(paths, s).twitch, undefined);
    s.twitch = { channel: '', commands: true, banter: true, clientId: CLIENT };
    assert.equal(toConfig(paths, s).twitch, undefined, 'a Client ID alone does not start anything');
    s.twitch = { channel: 'testair', commands: true, banter: false, pilotId: 5 };
    assert.deepEqual(toConfig(paths, s).twitch, { tokensFile: paths.twitchTokens, statusFile: paths.twitchStatus, channel: 'testair', commands: true, banter: false, pilotId: 5 });
  });

  it('keeps the sign-in and the status in files of their own, inside the host folder', () => {
    assert.equal(paths.twitchTokens, join(dir, 'twitch.json'));
    assert.equal(paths.twitchStatus, join(dir, 'twitch-status.json'));
  });

  it('knows what a Twitch Client ID looks like, and that this build has none built in yet', () => {
    assert.equal(validClientId(CLIENT), true);
    for (const bad of ['', 'short', 'has spaces in it 0123456789012345', 'x'.repeat(41)]) assert.equal(validClientId(bad), false, bad);
    assert.equal(typeof BUILT_IN_TWITCH_CLIENT_ID, 'string');
  });
});

/* ------------------------------------------------------------------ the setup page's side */

describe('connecting Twitch on the setup page', () => {
  let tw: FakeTwitchHttp;
  let supervisor: Supervisor;
  let web: WebServer;
  let restarts: number;

  beforeEach(async () => {
    tw = new FakeTwitchHttp();
    restarts = 0;
    const s = loadSettings(paths);
    s.discordToken = TOKEN;
    saveSettings(paths, s);
    supervisor = new Supervisor({
      paths,
      log: silentLogger,
      version: '9.9.9',
      onState: () => {},
      startBot: async () => (restarts++, { userTag: 'Bot#1', userId: BOT_ID, servers: () => [], stop: async () => {} } as unknown as BotHandle),
    });
    const updates = new UpdateChecker({ version: '9.9.9', statePath: paths.updateState, autoEnabled: () => false, fetchFn: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch, repo: 'o/r' });
    web = await startWebServer({ supervisor, updates, paths, log: silentLogger, version: '9.9.9', key: KEY, tail: () => [], onQuit: () => {}, fetchFn: tw.fetch });
  });
  afterEach(async () => {
    await web.close();
    await supervisor.stop();
  });

  const url = (path: string, key: string | null = KEY) => `http://127.0.0.1:${web.port}${path}${key === null ? '' : `?k=${key}`}`;
  const get = (path: string) => fetch(url(path));
  const post = (path: string, body: unknown = {}) => fetch(url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it('starts with nothing connected, and the application ID built into this app ready to use', async () => {
    const view = (await (await get('/api/twitch')).json()) as Record<string, unknown>;
    assert.deepEqual(view, { available: true, ownClientId: false, connectedAs: null, channel: '', commands: true, banter: true, pilotId: null, status: null, pending: null });
  });

  it('in a copy of the app with no application ID of its own, says so, and sends nothing to Twitch, until the host gives one', async () => {
    const bare = await startWebServer({ supervisor, updates: new UpdateChecker({ version: '9.9.9', statePath: paths.updateState, autoEnabled: () => false, fetchFn: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch, repo: 'o/r' }), paths, log: silentLogger, version: '9.9.9', key: KEY, tail: () => [], onQuit: () => {}, fetchFn: tw.fetch, builtInTwitchClientId: '' });
    try {
      const at = (path: string) => `http://127.0.0.1:${bare.port}${path}?k=${KEY}`;
      assert.equal(((await (await fetch(at('/api/twitch'))).json()) as { available: boolean }).available, false);
      const r = await fetch(at('/api/twitch/connect'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 400);
      assert.match(((await r.json()) as { error: string }).error, /no Twitch application ID/);
      assert.equal(tw.seen.length, 0, 'nothing was sent to Twitch');
    } finally {
      await bare.close();
    }
  });

  it('signs in with the app\'s own application ID when the host gave none of their own, and with theirs when they did', async () => {
    assert.equal(validClientId(BUILT_IN_TWITCH_CLIENT_ID), true, 'this app has a real-looking Twitch application ID built in');
    const started = await post('/api/twitch/connect');
    assert.equal(started.status, 200);
    assert.equal(tw.seen[0]!.body!.client_id, BUILT_IN_TWITCH_CLIENT_ID);
    const view = (await (await get('/api/twitch')).json()) as { available: boolean; ownClientId: boolean };
    assert.deepEqual({ available: view.available, own: view.ownClientId }, { available: true, own: false });
    await post('/api/twitch/settings', { clientId: CLIENT });
    await post('/api/twitch/connect');
    assert.equal(tw.seen.at(-1)!.body!.client_id, CLIENT, 'the host\'s own takes the place of the built-in one');
  });

  it('saves the host\'s own channel, options and application ID, tidied, and restarts the bot to use them', async () => {
    const r = await post('/api/twitch/settings', { channel: ' https://www.twitch.tv/TestAir ', commands: false, banter: true, pilotId: '7001', clientId: ` ${CLIENT} ` });
    assert.equal(r.status, 200);
    assert.deepEqual(loadSettings(paths).twitch, { channel: 'testair', commands: false, banter: true, pilotId: 7001, clientId: CLIENT });
    assert.equal(restarts, 1);
    const view = (await (await get('/api/twitch')).json()) as Record<string, unknown>;
    assert.deepEqual({ available: view.available, own: view.ownClientId, channel: view.channel, commands: view.commands, pilot: view.pilotId }, { available: true, own: true, channel: 'testair', commands: false, pilot: 7001 });
  });

  it('keeps what was not mentioned, and clears the channel when asked to', async () => {
    await post('/api/twitch/settings', { channel: 'testair', pilotId: 7, clientId: CLIENT });
    await post('/api/twitch/settings', { banter: false });
    assert.deepEqual(loadSettings(paths).twitch, { channel: 'testair', commands: true, banter: false, pilotId: 7, clientId: CLIENT });
    await post('/api/twitch/settings', { pilotId: null });
    assert.equal(loadSettings(paths).twitch?.pilotId, undefined, 'the pilot number can be cleared');
    await post('/api/twitch/settings', { channel: '' });
    assert.deepEqual(loadSettings(paths).twitch, { channel: '', commands: true, banter: false, clientId: CLIENT }, 'clearing the channel keeps the application ID');
    await post('/api/twitch/settings', { clientId: '' });
    assert.equal(loadSettings(paths).twitch, undefined, 'an application ID sent empty is removed, and with nothing left there is nothing saved');
  });

  it('refuses a channel, pilot number or application ID that cannot be right, and changes nothing', async () => {
    await post('/api/twitch/settings', { channel: 'testair' });
    const before = readFileSync(paths.settings, 'utf8');
    restarts = 0;
    for (const body of [{ channel: 'no way!' }, { pilotId: 'abc' }, { pilotId: -3 }, { pilotId: 1.5 }, { clientId: 'short' }]) {
      const r = await post('/api/twitch/settings', body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(readFileSync(paths.settings, 'utf8'), before);
    assert.equal(restarts, 0);
  });

  it('connects an account: a code for the host to type at Twitch, then the saved sign-in once they have, and a restart', async () => {
    await post('/api/twitch/settings', { channel: 'testair', clientId: CLIENT });
    restarts = 0;
    const started = (await (await post('/api/twitch/connect')).json()) as Record<string, unknown>;
    assert.deepEqual(started, { userCode: 'ABCD-EFGH', verificationUri: 'https://www.twitch.tv/activate?public=true', expiresInSec: 1800, intervalSec: 5 });
    assert.deepEqual(tw.seen[0]!.body, { client_id: CLIENT, scopes: 'user:read:chat user:write:chat' });
    assert.equal(((await (await get('/api/twitch')).json()) as { pending: { userCode: string } }).pending.userCode, 'ABCD-EFGH');

    const first = (await (await post('/api/twitch/poll')).json()) as { status: string };
    assert.equal(first.status, 'pending');
    const pollsBefore = tw.seen.filter((s) => s.url.endsWith('/oauth2/token')).length;
    const again = (await (await post('/api/twitch/poll')).json()) as { status: string };
    assert.equal(again.status, 'pending');
    assert.equal(tw.seen.filter((s) => s.url.endsWith('/oauth2/token')).length, pollsBefore, 'asked too soon, so Twitch is not asked');
    assert.equal(readTokens(paths.twitchTokens), null, 'nothing is saved before it is approved');
  });

  it('saves the sign-in once approved, shows who it is, and never gives a token back to the page', async () => {
    await post('/api/twitch/settings', { clientId: CLIENT });
    await post('/api/twitch/connect');
    tw.approved = { access: 'acc-secret-1', refresh: 'ref-secret-1', scope: SCOPES };
    await sleep(5_100); // Twitch asks to be asked every five seconds
    restarts = 0;
    const done = (await (await post('/api/twitch/poll')).json()) as { status: string; login: string };
    assert.deepEqual(done, { status: 'connected', login: 'kevinbot' });
    const saved = readTokens(paths.twitchTokens)!;
    assert.deepEqual({ client: saved.clientId, login: saved.login, user: saved.userId, scopes: saved.scopes, refresh: saved.refreshToken }, { client: CLIENT, login: 'kevinbot', user: '555', scopes: SCOPES, refresh: 'ref-secret-1' });
    assert.equal(restarts, 1, 'the bot restarts to join the chat');
    const view = JSON.stringify(await (await get('/api/twitch')).json());
    assert.match(view, /"connectedAs":"kevinbot"/);
    assert.equal(/secret/.test(view), false, 'no token in what the page is told');
    assert.equal(((await (await get('/api/twitch')).json()) as { pending: unknown }).pending, null);
    assert.equal(/secret/.test(await (await get('/')).text()), false);
  });

  it('says what happened when the host says no, or the code runs out, and then starts again from the top', async () => {
    await post('/api/twitch/settings', { clientId: CLIENT });
    await post('/api/twitch/connect');
    tw.tokenError = { status: 400, message: 'access_denied' };
    await sleep(5_100);
    const r = await post('/api/twitch/poll');
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /refused/);
    const next = await post('/api/twitch/poll');
    assert.equal(next.status, 400);
    assert.match(((await next.json()) as { error: string }).error, /Connect to Twitch/);
    assert.equal(readTokens(paths.twitchTokens), null);
  });

  it('refuses a poll with nothing to poll, and a code that Twitch will not give', async () => {
    await post('/api/twitch/settings', { clientId: CLIENT });
    assert.equal((await post('/api/twitch/poll')).status, 400);
    tw.deviceStatus = 400;
    const r = await post('/api/twitch/connect');
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /Client ID/);
  });

  it('disconnects: Twitch is told, the saved sign-in and status are deleted, and the bot restarts without it', async () => {
    writeTokens(paths.twitchTokens, { clientId: CLIENT, accessToken: 'acc-secret-1', refreshToken: 'ref-secret-1', expiresAt: Date.now() + 3_600_000, userId: '555', login: 'kevinbot', scopes: SCOPES });
    writeFileSync(paths.twitchStatus, '{"state":"running"}');
    restarts = 0;
    const r = await post('/api/twitch/disconnect');
    assert.equal(r.status, 200);
    assert.deepEqual(tw.revoked, ['acc-secret-1']);
    assert.equal(existsSync(paths.twitchTokens), false);
    assert.equal(existsSync(paths.twitchStatus), false);
    assert.equal(restarts, 1);
    assert.equal((await post('/api/twitch/disconnect')).status, 200, 'disconnecting twice is fine');
  });

  it('shows the bot\'s latest status from the file it writes', async () => {
    writeTokens(paths.twitchTokens, { clientId: CLIENT, accessToken: 'a', refreshToken: 'r', expiresAt: 1, userId: '555', login: 'kevinbot', scopes: SCOPES });
    writeFileSync(paths.twitchStatus, JSON.stringify({ state: 'running', detail: "In testair's chat.", login: 'kevinbot', channel: 'testair', at: 1 }));
    const view = (await (await get('/api/twitch')).json()) as { status: { state: string; detail: string } };
    assert.deepEqual({ s: view.status.state, d: view.status.detail }, { s: 'running', d: "In testair's chat." });
    writeFileSync(paths.twitchStatus, 'not json');
    assert.equal(((await (await get('/api/twitch')).json()) as { status: unknown }).status, null);
  });

  it('is as private as the rest of the page: the right key, this computer, and its own page', async () => {
    assert.equal((await fetch(url('/api/twitch', null))).status, 403);
    assert.equal((await fetch(url('/api/twitch', 'wrong'))).status, 403);
    for (const path of ['/api/twitch/connect', '/api/twitch/poll', '/api/twitch/settings', '/api/twitch/disconnect']) {
      const noKey = await fetch(url(path, null), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(noKey.status, 403, path);
      const foreign = await fetch(url(path), { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
      assert.equal(foreign.status, 403, path);
    }
    assert.equal(tw.seen.length, 0);
  });

  it('has a section on the page, which keeps its explanations honest', () => {
    const page = renderPage('1.0.0');
    assert.match(page, /id="s-twitch"/);
    assert.match(page, /Connect to Twitch/);
    assert.match(page, /only speaks when spoken to/);
    assert.match(page, /disconnect it here at any time/);
    for (const id of ['twitch-state', 'twitch-channel', 'twitch-pilot', 'twitch-commands', 'twitch-banter', 'twitch-save', 'twitch-disconnect', 'twitch-client']) assert.match(page, new RegExp(`id="${id}"`), id);
  });
});
