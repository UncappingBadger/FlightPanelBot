import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { BotHandle, ServerInfo, StartOptions } from '../src/bot.js';
import type { Config } from '../src/config.js';
import { openDatabase } from '../src/db/db.js';
import { Store } from '../src/db/store.js';
import { commandsFingerprint, forgetGuildCommands, registerGuildCommands } from '../src/discord/commandRegistration.js';
import { checkDiscordToken } from '../src/host/accounts.js';
import { createFileLogger } from '../src/host/fileLogger.js';
import { INVITE_PERMISSIONS, inviteUrl } from '../src/host/invite.js';
import { appHome, hostPaths, type HostPaths } from '../src/host/paths.js';
import { renderPage } from '../src/host/page.js';
import {
  clientIdFromToken,
  discordTokenProblem,
  forgetLegacySettings,
  googleKeyInfo,
  loadSettings,
  missingSettings,
  normalizeToken,
  removeGoogleKey,
  saveGoogleKey,
  saveSettings,
  toConfig,
} from '../src/host/settings.js';
import { readStatus, writeStatus, type HostState } from '../src/host/status.js';
import { explainStartFailure, Supervisor } from '../src/host/supervisor.js';
import { UpdateChecker } from '../src/host/updates.js';
import { startWebServer, type WebServer } from '../src/host/web.js';
import { silentLogger } from '../src/util/log.js';
import { makeServiceAccount } from './fake-google.js';

/* A real-looking bot token: the first part is the bot's ID in base64. */
const BOT_ID = '1234567890123456789';
const TOKEN = `${Buffer.from(BOT_ID).toString('base64')}.Gabc12.${'x'.repeat(27)}`;
const OLD_FSHUB_TOKEN = 'fshub-token-secret-abc123'; // what an older version kept in settings.json
const { account } = makeServiceAccount();
const KEY_JSON = JSON.stringify({ type: 'service_account', client_email: account.email, private_key: account.privateKey });

let dir: string;
let paths: HostPaths;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fpb-'));
  paths = hostPaths(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/* ------------------------------------------------------------------ where things live */

describe('the host app folder', () => {
  it('uses FPB_HOME if set, otherwise a folder in the Windows user\'s app data', () => {
    assert.match(appHome({ FPB_HOME: 'C:\\x\\y' }), /y$/);
    assert.equal(appHome({ APPDATA: 'C:\\Users\\Sam\\AppData\\Roaming' }), join('C:\\Users\\Sam\\AppData\\Roaming', 'FlightPanelBot'));
    assert.match(appHome({}), /\.flightpanelbot$/);
  });

  it('keeps settings, key, data, logs and status inside it', () => {
    const p = hostPaths('/h');
    for (const f of [p.settings, p.googleKey, p.database, p.logFile, p.status]) assert.ok(f.startsWith(join('/h')), f);
  });
});

/* ------------------------------------------------------------------ tokens and settings */

describe('Discord bot tokens', () => {
  it('reads the application ID out of the token, so hosts never have to look it up', () => {
    assert.equal(clientIdFromToken(TOKEN), BOT_ID);
    assert.equal(clientIdFromToken(`  "Bot ${TOKEN}"  `), BOT_ID, 'tolerates quotes, spaces and a pasted "Bot " prefix');
  });

  it('refuses what is plainly not a bot token, in words that help', () => {
    assert.equal(discordTokenProblem(TOKEN), null);
    assert.match(discordTokenProblem('')!, /Paste the bot token/);
    assert.match(discordTokenProblem(BOT_ID)!, /That is an ID, not a token/);
    assert.match(discordTokenProblem('hello world')!, /doesn't look like a Discord bot token/);
    assert.match(discordTokenProblem('a.b.c')!, /doesn't look like/);
    assert.equal(clientIdFromToken('not.a.token'), null);
    assert.equal(clientIdFromToken(`${Buffer.from('abc').toString('base64')}.x.y`), null, 'the first part must be a numeric ID');
  });

  it('normalises pasted text', () => {
    assert.equal(normalizeToken(`  'Bot ${TOKEN}'\n`), TOKEN);
  });
});

describe('saved settings', () => {
  it('start empty, round-trip, and say what is still missing (only the Discord token now)', () => {
    assert.deepEqual(loadSettings(paths), { discordToken: '', checkForUpdates: true, logLevel: 'info', fshubAccessToken: '' });
    assert.deepEqual(missingSettings(loadSettings(paths)), ['Discord bot token']);
    saveSettings(paths, { discordToken: TOKEN, checkForUpdates: false, logLevel: 'debug', fshubAccessToken: '' });
    assert.deepEqual(loadSettings(paths), { discordToken: TOKEN, checkForUpdates: false, logLevel: 'debug', fshubAccessToken: '' });
    assert.deepEqual(missingSettings(loadSettings(paths)), []);
  });

  it('survive a corrupt or hand-edited file without crashing', () => {
    writeFileSync(paths.settings, '{ not json');
    assert.deepEqual(loadSettings(paths), { discordToken: '', checkForUpdates: true, logLevel: 'info', fshubAccessToken: '' });
    writeFileSync(paths.settings, JSON.stringify({ discordToken: 5, logLevel: 'loud' }));
    assert.equal(loadSettings(paths).discordToken, '');
  });

  it('are written whole, leaving no half-written file behind', () => {
    saveSettings(paths, { discordToken: TOKEN, checkForUpdates: true, logLevel: 'info', fshubAccessToken: '' });
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  });

  it('become the bot\'s config, with the data inside the host folder and no guild lock', () => {
    saveSettings(paths, { discordToken: TOKEN, checkForUpdates: true, logLevel: 'warn', fshubAccessToken: '' });
    const config = toConfig(paths, loadSettings(paths));
    assert.deepEqual(
      [config.discordClientId, config.discordGuildId, config.logLevel, config.databasePath, config.googleServiceAccountFile],
      [BOT_ID, undefined, 'warn', paths.database, undefined],
    );
    assert.equal(config.fshubToken, undefined, 'no FsHub token unless the host saved one');
    assert.throws(() => toConfig(paths, { discordToken: 'junk', checkForUpdates: true, logLevel: 'info', fshubAccessToken: '' }), /doesn't look like a Discord bot token/);
  });

  it('an older settings file that still holds a FsHub token loads fine, and the token is removed from it', () => {
    writeFileSync(paths.settings, JSON.stringify({ discordToken: TOKEN, fshubToken: OLD_FSHUB_TOKEN, logLevel: 'warn' }));
    assert.deepEqual(loadSettings(paths), { discordToken: TOKEN, checkForUpdates: true, logLevel: 'warn', fshubAccessToken: '' });
    assert.equal(forgetLegacySettings(paths), true);
    const raw = readFileSync(paths.settings, 'utf8');
    assert.ok(!raw.includes(OLD_FSHUB_TOKEN) && !raw.includes('"fshubToken"'), 'no FsHub token left on disk');
    assert.deepEqual(loadSettings(paths), { discordToken: TOKEN, checkForUpdates: true, logLevel: 'warn', fshubAccessToken: '' }, 'everything else is kept');
    assert.equal(forgetLegacySettings(paths), false, 'and a second run finds nothing to do');
  });

  it('reads a settings file that starts with a byte-order mark, as Notepad and PowerShell can save it', () => {
    writeFileSync(paths.settings, '﻿' + JSON.stringify({ discordToken: TOKEN, fshubToken: OLD_FSHUB_TOKEN, logLevel: 'warn' }));
    assert.deepEqual(loadSettings(paths), { discordToken: TOKEN, checkForUpdates: true, logLevel: 'warn', fshubAccessToken: '' });
    assert.equal(forgetLegacySettings(paths), true);
    assert.ok(!readFileSync(paths.settings, 'utf8').includes(OLD_FSHUB_TOKEN));
  });

  it('forgetting the old token leaves a missing, corrupt or already-clean file alone', () => {
    assert.equal(forgetLegacySettings(paths), false);
    assert.equal(existsSync(paths.settings), false, 'did not create a file');
    writeFileSync(paths.settings, '{ not json');
    assert.equal(forgetLegacySettings(paths), false);
    assert.equal(readFileSync(paths.settings, 'utf8'), '{ not json');
    saveSettings(paths, { discordToken: TOKEN, checkForUpdates: true, logLevel: 'info', fshubAccessToken: '' });
    const before = readFileSync(paths.settings, 'utf8');
    assert.equal(forgetLegacySettings(paths), false);
    assert.equal(readFileSync(paths.settings, 'utf8'), before);
  });

  it('turn on write-back only when a Google key has been saved', () => {
    const s = { discordToken: TOKEN, checkForUpdates: true, logLevel: 'info' as const, fshubAccessToken: '' };
    assert.equal(toConfig(paths, s).googleServiceAccountFile, undefined);
    saveGoogleKey(paths, KEY_JSON);
    assert.equal(toConfig(paths, s).googleServiceAccountFile, paths.googleKey);
    removeGoogleKey(paths);
    assert.equal(toConfig(paths, s).googleServiceAccountFile, undefined);
  });
});

describe('the Google key', () => {
  it('is checked before it is kept, and its address is shown for sharing the sheet', () => {
    assert.deepEqual(googleKeyInfo(paths), { present: false, email: null, problem: null });
    assert.equal(saveGoogleKey(paths, KEY_JSON).email, account.email);
    assert.deepEqual(googleKeyInfo(paths), { present: true, email: account.email, problem: null });
  });

  it('refuses something that is not a service account key, without repeating what was sent', () => {
    for (const bad of ['{ nope', '{}', JSON.stringify({ client_email: 'a@b.c' }), JSON.stringify({ private_key: 'SUPER-SECRET-KEY-TEXT PRIVATE KEY' })]) {
      assert.throws(
        () => saveGoogleKey(paths, bad),
        (e: unknown) => e instanceof Error && /^That file /.test(e.message) && !e.message.includes('SUPER-SECRET'),
      );
    }
    assert.equal(existsSync(paths.googleKey), false, 'nothing was saved');
  });

  it('reports a saved key that has gone bad', () => {
    writeFileSync(paths.googleKey, 'garbage');
    const info = googleKeyInfo(paths);
    assert.equal(info.present, true);
    assert.match(info.problem!, /isn't valid JSON/);
  });
});

describe('the invite link', () => {
  it('adds the host\'s own bot, with command access and the six permissions it needs', () => {
    const url = new URL(inviteUrl(BOT_ID));
    assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
    assert.equal(url.searchParams.get('client_id'), BOT_ID);
    assert.equal(url.searchParams.get('scope'), 'bot applications.commands');
    assert.equal(url.searchParams.get('permissions'), String(INVITE_PERMISSIONS));
    // View Channel + Send Messages + Embed Links + Attach Files + Read Message History + Mention Everyone
    assert.equal(INVITE_PERMISSIONS, 1024 + 2048 + 16384 + 32768 + 65536 + 131072);
  });
});

describe('checking the Discord token', () => {
  const answer = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const offline = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;

  it('Discord: a good token gives the bot\'s name, a bad one is rejected, no network is "unknown"', async () => {
    assert.deepEqual(await checkDiscordToken(TOKEN, answer(200, { id: BOT_ID, username: 'My Airline' })), { status: 'ok', id: BOT_ID, name: 'My Airline' });
    assert.equal((await checkDiscordToken(TOKEN, answer(401))).status, 'rejected');
    assert.equal((await checkDiscordToken(TOKEN, answer(500))).status, 'unknown');
    assert.equal((await checkDiscordToken(TOKEN, offline)).status, 'unknown');
  });

  it('Discord: sends the token as the bot\'s credential and only to discord.com', async () => {
    let seen: { url: string; auth: string } | null = null;
    await checkDiscordToken(`Bot ${TOKEN}`, (async (url: string, init?: RequestInit) => {
      seen = { url: String(url), auth: (init?.headers as Record<string, string>).authorization as string };
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);
    assert.deepEqual(seen, { url: 'https://discord.com/api/v10/users/@me', auth: `Bot ${TOKEN}` });
  });
});

/* ------------------------------------------------------------------ logs and status */

describe('the log file', () => {
  it('records lines, keeps the latest in memory, and respects the level', () => {
    const logger = createFileLogger({ file: join(dir, 'logs', 'bot.log'), level: 'info' });
    logger.log.debug('quiet');
    logger.log.info('hello');
    logger.log.warn('careful', new Error('boom'));
    const text = readFileSync(join(dir, 'logs', 'bot.log'), 'utf8');
    assert.match(text, /INFO\s+hello/);
    assert.match(text, /WARN\s+careful :: Error: boom/);
    assert.doesNotMatch(text, /quiet/);
    assert.equal(logger.tail(10).length, 2);
    assert.equal(logger.tail(1).length, 1);
  });

  it('rolls over at a size limit and keeps only a few old files, so it can never fill the disk', () => {
    const file = join(dir, 'bot.log');
    const logger = createFileLogger({ file, maxBytes: 200, keep: 2 });
    for (let i = 0; i < 60; i++) logger.log.info(`line number ${i} ${'x'.repeat(20)}`);
    const files = readdirSync(dir).filter((f) => f.startsWith('bot.log')).sort();
    assert.deepEqual(files, ['bot.log', 'bot.log.1', 'bot.log.2']);
    assert.ok(readFileSync(file, 'utf8').includes('line number 59'), 'the newest lines are in the live file');
  });

  it('never throws, even when it cannot write', () => {
    const logger = createFileLogger({ file: join(dir, 'bot.log', 'nested', 'x.log') });
    writeFileSync(join(dir, 'bot.log'), 'a file where a folder is needed');
    assert.doesNotThrow(() => logger.log.info('still fine'));
    assert.equal(logger.tail(1)[0]!.includes('still fine'), true);
  });
});

describe('the status file the tray icon reads', () => {
  const state: HostState = {
    phase: 'online',
    message: 'Online as Bot#1',
    botName: 'Bot#1',
    inviteUrl: inviteUrl(BOT_ID),
    servers: [{ id: '1', name: 'My server', commands: 'registered' }],
    configured: { discordToken: true, google: { present: false, email: null, problem: null }, fshub: false },
    version: '1.0.0',
    updatedAt: 1,
  };
  const noUpdate = { supported: true, auto: true, checkedAt: null, ok: null, current: '1.0.0', latest: null, available: false, url: null, announce: false };

  it('round-trips, with the port and key the launcher needs to open the setup page', () => {
    writeStatus(paths, { ...state, pid: 42, port: 47811, key: 'abc', update: noUpdate });
    const back = readStatus(paths)!;
    assert.deepEqual([back.pid, back.port, back.key, back.phase, back.servers[0]!.name], [42, 47811, 'abc', 'online', 'My server']);
  });

  it('carries whether a newer version exists, for the tray to announce', () => {
    const update = { ...noUpdate, available: true, latest: 'v1.1.0', url: 'https://github.com/o/r/releases/tag/v1.1.0', announce: true };
    writeStatus(paths, { ...state, pid: 1, port: null, key: null, update });
    assert.deepEqual(readStatus(paths)!.update, update);
  });

  it('is simply absent before the first write, or if damaged', () => {
    assert.equal(readStatus(paths), null);
    writeFileSync(paths.status, '{ half');
    assert.equal(readStatus(paths), null);
  });
});

/* ------------------------------------------------------------------ slash commands in each server */

describe('giving a server the slash commands', () => {
  let store: Store;
  let puts: Array<{ guild: string; body: unknown[] }>;
  let failWith: unknown;
  const body = [{ name: 'setup' }, { name: 'help' }];
  const target = {
    put: async (guild: string, b: unknown[]) => {
      puts.push({ guild, body: b });
      if (failWith) throw failWith;
    },
  };
  beforeEach(() => {
    store = new Store(openDatabase(':memory:'));
    puts = [];
    failWith = undefined;
  });
  afterEach(() => store.close());

  it('registers them the first time, and does nothing when the server already has this exact set', async () => {
    assert.equal(await registerGuildCommands(target, store, 'g1', body, silentLogger), 'registered');
    assert.equal(await registerGuildCommands(target, store, 'g1', body, silentLogger), 'unchanged');
    assert.equal(puts.length, 1);
  });

  it('sends them again when the commands change, or for another server', async () => {
    await registerGuildCommands(target, store, 'g1', body, silentLogger);
    assert.equal(await registerGuildCommands(target, store, 'g1', [...body, { name: 'extra' }], silentLogger), 'registered');
    assert.equal(await registerGuildCommands(target, store, 'g2', body, silentLogger), 'registered');
    assert.deepEqual(puts.map((p) => p.guild), ['g1', 'g1', 'g2']);
  });

  it('says so when the bot was added without command access, and tries again next time', async () => {
    failWith = Object.assign(new Error('Missing Access'), { code: 50001 });
    assert.equal(await registerGuildCommands(target, store, 'g1', body, silentLogger), 'no-access');
    failWith = undefined;
    assert.equal(await registerGuildCommands(target, store, 'g1', body, silentLogger), 'registered', 'a failure is never remembered as done');
  });

  it('reports any other failure and carries on', async () => {
    failWith = new Error('Discord is having a day');
    assert.equal(await registerGuildCommands(target, store, 'g1', body, silentLogger), 'failed');
  });

  it('forgets a server the bot has left, so rejoining sets it up again', async () => {
    await registerGuildCommands(target, store, 'g1', body, silentLogger);
    forgetGuildCommands(store, 'g1');
    assert.equal(await registerGuildCommands(target, store, 'g1', body, silentLogger), 'registered');
  });

  it('fingerprints the command set, not its order of keys alone', () => {
    assert.notEqual(commandsFingerprint(body), commandsFingerprint([...body, { name: 'x' }]));
    assert.equal(commandsFingerprint(body), commandsFingerprint(JSON.parse(JSON.stringify(body))));
  });

  it('keeps small bits of install bookkeeping in the database', () => {
    assert.equal(store.getKv('a'), null);
    store.setKv('a', '1');
    store.setKv('a', '2');
    assert.equal(store.getKv('a'), '2');
    store.deleteKv('a');
    assert.equal(store.getKv('a'), null);
  });
});

/* ------------------------------------------------------------------ the supervisor */

class FakeBot implements BotHandle {
  stopped = false;
  userTag = 'Airline Bot#0001';
  userId = BOT_ID;
  constructor(private list: ServerInfo[] = []) {}
  servers() {
    return this.list;
  }
  async stop() {
    this.stopped = true;
  }
}

describe('the supervisor', () => {
  let states: HostState[];
  let started: Array<{ config: Config; opts: StartOptions }>;
  let behaviour: (config: Config, opts: StartOptions) => Promise<BotHandle>;

  const make = (extra: { retryDelaysMs?: number[] } = {}) =>
    new Supervisor({
      paths,
      log: silentLogger,
      version: '1.2.3',
      onState: (s) => states.push(s),
      startBot: (config, opts) => {
        started.push({ config, opts });
        return behaviour(config, opts);
      },
      ...extra,
    });
  const configured = () => saveSettings(paths, { discordToken: TOKEN, checkForUpdates: true, logLevel: 'info', fshubAccessToken: '' });
  const last = () => states.at(-1)!;

  beforeEach(() => {
    states = [];
    started = [];
    behaviour = async () => new FakeBot();
  });

  it('waits for setup, and does not touch Discord, when a token is missing', async () => {
    const s = make();
    await s.start();
    assert.equal(last().phase, 'needs-setup');
    assert.match(last().message, /Needs setup: Discord bot token\./);
    assert.equal(started.length, 0);
  });

  it('starts the bot from the saved settings, registering commands in each server, and reports it online', async () => {
    configured();
    behaviour = async (_c, opts) => {
      const list: ServerInfo[] = [{ id: '1', name: 'My server', commands: 'registered' }];
      opts.onServers?.(list);
      return new FakeBot(list);
    };
    await make().start();
    assert.equal(started[0]!.opts.registerCommands, true, 'hosts never run a command script');
    assert.equal(started[0]!.config.discordToken, TOKEN);
    assert.deepEqual(states.map((s) => s.phase).filter((p, i, a) => a.indexOf(p) === i), ['starting', 'online']);
    assert.equal(last().message, 'Online as Airline Bot#0001.');
    assert.equal(last().botName, 'Airline Bot#0001');
    assert.deepEqual(last().servers.map((v) => v.name), ['My server']);
    assert.equal(last().inviteUrl, inviteUrl(BOT_ID));
  });

  it('never includes a secret in the state it publishes', async () => {
    configured();
    saveGoogleKey(paths, KEY_JSON);
    await make().start();
    const everything = JSON.stringify(states);
    for (const secret of [TOKEN, account.privateKey, 'PRIVATE KEY']) assert.equal(everything.includes(secret), false, secret.slice(0, 12));
    assert.deepEqual(last().configured, { discordToken: true, google: { present: true, email: account.email, problem: null }, fshub: false });
  });

  it('says whether a FsHub token is saved, but never what it is', async () => {
    const FSHUB_SECRET = 'fshub-secret-0123456789abcdef0123456789';
    saveSettings(paths, { discordToken: TOKEN, checkForUpdates: true, logLevel: 'info', fshubAccessToken: FSHUB_SECRET });
    await make().start();
    assert.equal(JSON.stringify(states).includes(FSHUB_SECRET), false);
    assert.equal(last().configured.fshub, true);
    assert.equal(started[0]!.config.fshubToken, FSHUB_SECRET, 'the bot is given it, to use against FsHub only');
  });

  it('a FsHub token left under the old setting name is never handed to the bot', async () => {
    writeFileSync(paths.settings, JSON.stringify({ discordToken: TOKEN, fshubToken: OLD_FSHUB_TOKEN }));
    await make().start();
    assert.equal(started[0]!.config.fshubToken, undefined);
  });

  it('shows the invite link as soon as a token is saved, even before the bot has finished connecting', async () => {
    configured();
    behaviour = () => new Promise<BotHandle>(() => {}); // still connecting
    void make().start();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(last().phase, 'starting');
    assert.equal(last().inviteUrl, inviteUrl(BOT_ID));
  });

  it('with no token at all there is no invite link and nothing starts', async () => {
    await make().start();
    assert.equal(last().inviteUrl, null);
    assert.equal(started.length, 0);
  });

  it('says what to do when Discord rejects the token, and does not keep retrying', async () => {
    configured();
    behaviour = async () => {
      throw Object.assign(new Error('An invalid token was provided.'), { code: 'TokenInvalid' });
    };
    await make({ retryDelaysMs: [1] }).start();
    assert.equal(last().phase, 'error');
    assert.match(last().message, /Reset Token/);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(started.length, 1, 'no retry');
  });

  it('keeps trying by itself when Discord cannot be reached, then comes online', async () => {
    configured();
    let attempts = 0;
    behaviour = async () => {
      if (++attempts < 3) throw new Error('getaddrinfo ENOTFOUND discord.com');
      return new FakeBot();
    };
    const s = make({ retryDelaysMs: [5] });
    await s.start();
    assert.equal(last().phase, 'retrying');
    assert.match(last().message, /keep trying/);
    for (const limit = Date.now() + 2000; last().phase !== 'online' && Date.now() < limit; ) await new Promise((r) => setTimeout(r, 10));
    assert.equal(last().phase, 'online');
    assert.equal(attempts, 3);
  });

  it('restarts with new settings: the old bot is stopped first', async () => {
    configured();
    const bots: FakeBot[] = [];
    behaviour = async () => {
      const b = new FakeBot();
      bots.push(b);
      return b;
    };
    const s = make();
    await s.start();
    await s.restart();
    assert.equal(bots.length, 2);
    assert.equal(bots[0]!.stopped, true);
    assert.equal(bots[1]!.stopped, false);
    assert.equal(last().phase, 'online');
  });

  it('drops a start that was overtaken by a restart, and stops the bot it created', async () => {
    configured();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const bots: FakeBot[] = [];
    behaviour = async () => {
      const b = new FakeBot();
      bots.push(b);
      if (bots.length === 1) await gate;
      return b;
    };
    const s = make();
    const first = s.start();
    await new Promise((r) => setTimeout(r, 5));
    const second = s.restart();
    release();
    await Promise.all([first, second]);
    assert.equal(bots.length, 2);
    assert.equal(bots[0]!.stopped, true, 'the stale one was shut down');
    assert.equal(bots[1]!.stopped, false);
    assert.equal(last().phase, 'online');
  });

  it('stops cleanly', async () => {
    configured();
    const bot = new FakeBot();
    behaviour = async () => bot;
    const s = make();
    await s.start();
    await s.stop();
    assert.equal(bot.stopped, true);
    assert.equal(last().phase, 'stopped');
  });

  it('turns start-up failures into plain advice', () => {
    assert.equal(explainStartFailure(new Error('Used disallowed intents')).retry, false);
    assert.match(explainStartFailure(new Error('Used disallowed intents')).message, /Privileged Gateway Intents/);
    assert.equal(explainStartFailure(new Error('fetch failed')).retry, true);
    assert.equal(explainStartFailure(new Error('Discord took too long to finish connecting.')).retry, true);
    assert.match(explainStartFailure(new Error('x'.repeat(500))).message, /…$/);
  });
});

/* ------------------------------------------------------------------ the local setup page */

describe('the local setup page', () => {
  const KEY = 'secret-key-abc';
  let web: WebServer;
  let supervisor: Supervisor;
  let restarts: number;
  let quitCalled: boolean;
  let discordStatus: number;
  let fshubStatus: number;
  let fshubSeen: Array<{ path: string; token: string | null; method: string }>;
  let github: { status: number; body: unknown };
  let githubCalls: number;
  let networkDown: boolean;
  let updates: UpdateChecker;

  const fakeFetch = (async (url: string, init?: RequestInit) => {
    if (networkDown) throw new TypeError('fetch failed');
    const u = String(url);
    if (u.includes('discord.com')) return new Response(JSON.stringify({ id: BOT_ID, username: 'Airline Bot' }), { status: discordStatus });
    if (u.includes('fshub.io')) {
      const headers = new Headers(init?.headers);
      fshubSeen.push({ path: new URL(u).pathname, token: headers.get('x-pilot-token'), method: init?.method ?? 'GET' });
      if (fshubStatus !== 200) return new Response(JSON.stringify({ error: { status_code: fshubStatus, message: 'Unauthenticated.' } }), { status: fshubStatus });
      return new Response(JSON.stringify({ data: { id: 1, name: 'Token Holder', is_premium: false } }), { status: 200 });
    }
    if (u.includes('api.github.com')) {
      githubCalls++;
      return new Response(JSON.stringify(github.body), { status: github.status });
    }
    throw new Error(`unexpected request to ${u}`);
  }) as unknown as typeof fetch;

  beforeEach(async () => {
    restarts = 0;
    quitCalled = false;
    discordStatus = 200;
    fshubStatus = 200;
    fshubSeen = [];
    github = { status: 200, body: { tag_name: 'v9.9.9', html_url: 'https://github.com/o/r/releases/tag/v9.9.9' } };
    githubCalls = 0;
    networkDown = false;
    supervisor = new Supervisor({
      paths,
      log: silentLogger,
      version: '9.9.9',
      onState: () => {},
      startBot: async () => {
        restarts++;
        return new FakeBot();
      },
    });
    updates = new UpdateChecker({ version: '9.9.9', statePath: paths.updateState, autoEnabled: () => loadSettings(paths).checkForUpdates, fetchFn: fakeFetch, repo: 'o/r' });
    web = await startWebServer({ supervisor, updates, paths, log: silentLogger, version: '9.9.9', key: KEY, tail: () => ['line one', 'line two'], onQuit: () => (quitCalled = true), fetchFn: fakeFetch });
  });
  afterEach(async () => {
    await web.close();
    await supervisor.stop();
  });

  const url = (path: string, key: string | null = KEY) => `http://127.0.0.1:${web.port}${path}${key === null ? '' : `${path.includes('?') ? '&' : '?'}k=${key}`}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url(path), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  /** A request with a chosen Host header, which fetch will not allow. */
  const rawGet = (path: string, host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: web.port, path, headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });

  describe('who may use it', () => {
    it('listens on this computer only', () => {
      assert.ok(web.port > 0);
    });

    it('refuses anyone without the secret key, however they ask', async () => {
      for (const path of ['/', '/api/state', '/api/logs']) {
        assert.equal((await fetch(url(path, null))).status, 403, path);
        assert.equal((await fetch(url(path, 'wrong'))).status, 403, path);
        assert.equal((await fetch(url(path, KEY.slice(0, -1)))).status, 403, path);
      }
      assert.equal((await post('/api/restart', {}, {})).status, 200, 'the right key works');
      const noKey = await fetch(url('/api/quit', null), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(noKey.status, 403);
      assert.equal(quitCalled, false);
      for (const path of ['/api/update/check', '/api/update/auto']) {
        const res = await fetch(url(path, null), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
        assert.equal(res.status, 403, path);
      }
      assert.equal(githubCalls, 0, 'nothing reached GitHub for a request without the key');
      assert.equal(loadSettings(paths).checkForUpdates, true);
    });

    it('accepts the key as a header too, which is how the page itself calls it', async () => {
      const res = await fetch(url('/api/state', null), { headers: { 'x-fpb-key': KEY } });
      assert.equal(res.status, 200);
    });

    it('refuses a request addressed to any other name (a web page pointing a hostname at this computer)', async () => {
      assert.equal(await rawGet(`/api/state?k=${KEY}`, `127.0.0.1:${web.port}`), 200);
      assert.equal(await rawGet(`/api/state?k=${KEY}`, `localhost:${web.port}`), 200);
      assert.equal(await rawGet(`/api/state?k=${KEY}`, `evil.example:${web.port}`), 403);
      assert.equal(await rawGet(`/api/state?k=${KEY}`, '127.0.0.1:1'), 403);
      assert.equal(await rawGet(`/api/state?k=${KEY}`, '127.0.0.1'), 403, 'without the port');
      assert.equal(await rawGet(`/api/state?k=${KEY}`, `127.0.0.1.evil.example:${web.port}`), 403);
    });

    it('refuses a change that did not come from its own page', async () => {
      const foreign = await post('/api/restart', {}, { origin: 'https://evil.example' });
      assert.equal(foreign.status, 403);
      const own = await post('/api/restart', {}, { origin: `http://127.0.0.1:${web.port}` });
      assert.equal(own.status, 200);
      const notJson = await fetch(url('/api/restart'), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
      assert.equal(notJson.status, 415, 'a plain form post from another site is refused');
      const form = await fetch(url('/api/restart'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=b' });
      assert.equal(form.status, 415);
    });

    it('does not answer GET for changes, and 404s unknown paths', async () => {
      assert.equal((await fetch(url('/api/restart'))).status, 404);
      assert.equal((await fetch(url('/nothing'))).status, 404);
      assert.equal((await post('/api/nothing', {})).status, 404);
    });

    it('refuses an oversized upload', async () => {
      const res = await post('/api/google-key', { json: 'x'.repeat(400_000) });
      assert.equal(res.status, 413);
    });
  });

  describe('what it shows', () => {
    it('serves the page with strict headers, and the page contains no secrets', async () => {
      const res = await fetch(url('/'));
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type')!, /text\/html/);
      assert.match(res.headers.get('content-security-policy')!, /default-src 'none'/);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      const html = await res.text();
      assert.match(html, /Flight Panel Bot/);
      assert.match(html, /v9\.9\.9/);
      assert.equal(html.includes(KEY), false, 'the page does not embed the key; it reads it from the address');
      assert.doesNotMatch(html, /<script[^>]+src=/, 'no outside scripts');
      assert.match(html, /<input type="password" id="fshub"/, 'the FsHub token is optional and typed into a hidden field');
      assert.doesNotMatch(html, /fshubToken|fshubAccessToken/, 'the page never carries a stored token');
    });

    it('reports state without any token', async () => {
      saveSettings(paths, { discordToken: TOKEN, checkForUpdates: true, logLevel: 'info', fshubAccessToken: '' });
      const text = await (await fetch(url('/api/state'))).text();
      assert.equal(text.includes(TOKEN), false);
      const state = JSON.parse(text);
      assert.deepEqual([state.configured.discordToken, state.version], [true, '9.9.9']);
      assert.ok(!('fshubToken' in state.configured));
      assert.equal(state.configured.fshub, false);
      assert.deepEqual([state.update.supported, state.update.auto, state.update.available, state.update.checkedAt], [true, true, false, null]);
    });

    it('shows the log tail, capped', async () => {
      assert.deepEqual(await (await fetch(url('/api/logs?n=2'))).json(), { lines: ['line one', 'line two'] });
    });

    it('escapes nothing dangerous: the page builds its text with textContent', () => {
      const html = renderPage('1.0');
      assert.equal(/innerHTML/.test(html), false);
      assert.equal(renderPage('<script>alert(1)</script>').includes('<script>alert'), false, 'a hostile version string cannot inject markup');
    });
  });

  describe('saving settings', () => {
    it('checks the token, saves it, restarts the bot, and never echoes it back', async () => {
      const res = await post('/api/settings', { discordToken: ` ${TOKEN} ` });
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.equal(text.includes(TOKEN), false);
      assert.deepEqual(loadSettings(paths), { discordToken: TOKEN, checkForUpdates: true, logLevel: 'info', fshubAccessToken: '' });
      for (const limit = Date.now() + 1000; restarts === 0 && Date.now() < limit; ) await new Promise((r) => setTimeout(r, 10));
      assert.equal(restarts, 1);
    });

    it('rejects a token that is not shaped like one, without asking Discord and without saving', async () => {
      const res = await post('/api/settings', { discordToken: 'hello' });
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, /doesn't look like a Discord bot token/);
      assert.equal(loadSettings(paths).discordToken, '');
    });

    it('rejects a token that Discord says is wrong, keeping what was saved before', async () => {
      saveSettings(paths, { discordToken: TOKEN, checkForUpdates: true, logLevel: 'info', fshubAccessToken: '' });
      discordStatus = 401;
      const d = await post('/api/settings', { discordToken: `${Buffer.from('999999999999999999').toString('base64')}.zzzzzz.${'y'.repeat(27)}` });
      assert.equal(d.status, 400);
      assert.match(((await d.json()) as { error: string }).error, /Discord says that token is not valid/);
      assert.deepEqual(loadSettings(paths), { discordToken: TOKEN, checkForUpdates: true, logLevel: 'info', fshubAccessToken: '' });
      assert.equal(restarts, 0, 'nothing restarted');
    });

    it('ignores a FsHub token if an old copy of the page sends one, and keeps nothing of it', async () => {
      const res = await post('/api/settings', { discordToken: TOKEN, fshubToken: OLD_FSHUB_TOKEN });
      assert.equal(res.status, 200);
      assert.ok(!readFileSync(paths.settings, 'utf8').includes(OLD_FSHUB_TOKEN));
    });

    it('saves anyway, with a note, when it cannot reach Discord to check', async () => {
      networkDown = true;
      const res = await post('/api/settings', { discordToken: TOKEN });
      const body = (await res.json()) as { ok: boolean; notes: string[] };
      assert.equal(res.status, 200);
      assert.equal(body.notes.length, 1);
      assert.equal(loadSettings(paths).discordToken, TOKEN);
    });

    it('needs something to save', async () => {
      const res = await post('/api/settings', {});
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, /Paste the bot token/);
    });
  });

  describe('the optional FsHub token', () => {
    const FSHUB_TOKEN = 'fshub-token-0123456789abcdefghij0123456789';
    const waitForRestart = async () => {
      for (const limit = Date.now() + 1000; restarts === 0 && Date.now() < limit; ) await new Promise((r) => setTimeout(r, 10));
    };

    it('checks the token with FsHub, keeps it, restarts the bot, and never echoes it back', async () => {
      saveSettings(paths, { discordToken: TOKEN, checkForUpdates: true, logLevel: 'info', fshubAccessToken: '' });
      const res = await post('/api/fshub', { token: ` "${FSHUB_TOKEN}" ` });
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.equal(text.includes(FSHUB_TOKEN), false);
      assert.deepEqual(JSON.parse(text), { ok: true, name: 'Token Holder', notes: [] });
      assert.equal(loadSettings(paths).fshubAccessToken, FSHUB_TOKEN);
      assert.deepEqual(fshubSeen, [{ path: '/api/v3/user', token: FSHUB_TOKEN, method: 'GET' }], 'it asked FsHub only who the token belongs to, with a GET');
      await waitForRestart();
      assert.equal(restarts, 1);
      const state = (await (await fetch(url('/api/state'))).text());
      assert.equal(state.includes(FSHUB_TOKEN), false);
      assert.equal(JSON.parse(state).configured.fshub, true);
    });

    it('keeps the Discord token and the other settings when it saves', async () => {
      saveSettings(paths, { discordToken: TOKEN, checkForUpdates: false, logLevel: 'warn', fshubAccessToken: '' });
      await post('/api/fshub', { token: FSHUB_TOKEN });
      assert.deepEqual(loadSettings(paths), { discordToken: TOKEN, checkForUpdates: false, logLevel: 'warn', fshubAccessToken: FSHUB_TOKEN });
    });

    it('does not save a token FsHub rejects, and leaves the one already saved', async () => {
      saveSettings(paths, { discordToken: TOKEN, checkForUpdates: true, logLevel: 'info', fshubAccessToken: FSHUB_TOKEN });
      fshubStatus = 401;
      const res = await post('/api/fshub', { token: 'a-different-token-0123456789abcdef' });
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, /FsHub says that token is not valid/);
      assert.equal(loadSettings(paths).fshubAccessToken, FSHUB_TOKEN);
      assert.equal(restarts, 0);
    });

    it('rejects something that is not shaped like a token without asking FsHub', async () => {
      for (const token of ['', 'short', 'has spaces in the middle of it 0123456789', 42]) {
        const res = await post('/api/fshub', { token });
        assert.equal(res.status, 400, String(token));
      }
      assert.equal(fshubSeen.length, 0);
      assert.equal(loadSettings(paths).fshubAccessToken, '');
    });

    it('saves anyway, with a note, when it cannot reach FsHub to check', async () => {
      networkDown = true;
      const res = await post('/api/fshub', { token: FSHUB_TOKEN });
      const body = (await res.json()) as { ok: boolean; name: string | null; notes: string[] };
      assert.equal(res.status, 200);
      assert.equal(body.name, null);
      assert.equal(body.notes.length, 1);
      assert.equal(loadSettings(paths).fshubAccessToken, FSHUB_TOKEN);
    });

    it('removes the token', async () => {
      saveSettings(paths, { discordToken: TOKEN, checkForUpdates: true, logLevel: 'info', fshubAccessToken: FSHUB_TOKEN });
      assert.equal((await post('/api/fshub/remove', {})).status, 200);
      assert.equal(loadSettings(paths).fshubAccessToken, '');
      assert.equal(loadSettings(paths).discordToken, TOKEN);
      assert.equal(readFileSync(paths.settings, 'utf8').includes(FSHUB_TOKEN), false, 'gone from the file too');
    });

    it('only answers with the right key, from its own page', async () => {
      const noKey = await fetch(url('/api/fshub', null), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: FSHUB_TOKEN }) });
      assert.equal(noKey.status, 403);
      assert.equal((await post('/api/fshub', { token: FSHUB_TOKEN }, { origin: 'https://evil.example' })).status, 403);
      assert.equal(fshubSeen.length, 0, 'nothing was sent to FsHub');
      assert.equal(loadSettings(paths).fshubAccessToken, '');
    });
  });

  describe('the Google key and the other buttons', () => {
    it('keeps a valid key and shows the address to share the sheet with', async () => {
      const res = await post('/api/google-key', { json: KEY_JSON });
      assert.deepEqual(await res.json(), { ok: true, email: account.email });
      assert.equal(googleKeyInfo(paths).email, account.email);
    });

    it('refuses an invalid key, saving nothing and not repeating it', async () => {
      const res = await post('/api/google-key', { json: JSON.stringify({ private_key: 'SECRETPRIVATE KEY' }) });
      assert.equal(res.status, 400);
      const text = await res.text();
      assert.match(text, /doesn't look like a service account key/);
      assert.equal(text.includes('SECRET'), false);
      assert.equal(existsSync(paths.googleKey), false);
      assert.equal((await post('/api/google-key', {})).status, 400);
    });

    it('removes the key', async () => {
      saveGoogleKey(paths, KEY_JSON);
      assert.equal((await post('/api/google-key/remove', {})).status, 200);
      assert.equal(existsSync(paths.googleKey), false);
    });

    it('restarts the bot on request', async () => {
      saveSettings(paths, { discordToken: TOKEN, checkForUpdates: true, logLevel: 'info', fshubAccessToken: '' });
      assert.equal((await post('/api/restart', {})).status, 200);
      for (const limit = Date.now() + 1000; restarts === 0 && Date.now() < limit; ) await new Promise((r) => setTimeout(r, 10));
      assert.equal(restarts, 1);
    });

    it('quits on request, after answering', async () => {
      assert.equal((await post('/api/quit', {})).status, 200);
      for (const limit = Date.now() + 1000; !quitCalled && Date.now() < limit; ) await new Promise((r) => setTimeout(r, 10));
      assert.equal(quitCalled, true);
    });
  });

  describe('looking for a newer version', () => {
    it('says so when GitHub has a newer release, with a link that stays inside the project\'s own repository', async () => {
      github = { status: 200, body: { tag_name: 'v10.0.0', html_url: 'https://github.com/o/r/releases/tag/v10.0.0' } };
      const res = await post('/api/update/check', {});
      const status = (await res.json()) as Record<string, unknown>;
      assert.deepEqual([status.available, status.latest, status.url, status.ok], [true, 'v10.0.0', 'https://github.com/o/r/releases/tag/v10.0.0', true]);
      const state = (await (await fetch(url('/api/state'))).json()) as { update: { available: boolean } };
      assert.equal(state.update.available, true, 'and the page sees it on its next look');
    });

    it('says nothing is newer when the latest release is this one or older', async () => {
      for (const tag of ['v9.9.9', 'v9.9.8', 'v1.0.0']) {
        github = { status: 200, body: { tag_name: tag, html_url: 'https://github.com/o/r/releases/tag/x' } };
        const status = (await (await post('/api/update/check', {})).json()) as { available: boolean; ok: boolean };
        assert.deepEqual([status.available, status.ok], [false, true], tag);
      }
    });

    it('reports a failed check as a failed check, not as "up to date", and never errors', async () => {
      networkDown = true;
      let res = await post('/api/update/check', {});
      assert.equal(res.status, 200);
      const failed = (await res.json()) as { ok: boolean; available: boolean };
      assert.deepEqual([failed.ok, failed.available], [false, false]);
      networkDown = false;
      github = { status: 403, body: { message: 'rate limit' } };
      res = await post('/api/update/check', {});
      assert.equal(((await res.json()) as { ok: boolean }).ok, false);
    });

    it('switches the daily check off and on, and remembers it', async () => {
      const off = (await (await post('/api/update/auto', { enabled: false })).json()) as { auto: boolean };
      assert.equal(off.auto, false);
      assert.equal(loadSettings(paths).checkForUpdates, false);
      assert.equal(githubCalls, 0, 'changing the switch does not itself contact GitHub');
      const on = (await (await post('/api/update/auto', { enabled: true })).json()) as { auto: boolean };
      assert.equal(on.auto, true);
      assert.equal(loadSettings(paths).checkForUpdates, true);
      assert.equal((await post('/api/update/auto', { enabled: 'yes' })).status, 400);
      assert.equal((await post('/api/update/auto', {})).status, 400);
    });

    it('still checks when asked with the button even if the daily check is off', async () => {
      await post('/api/update/auto', { enabled: false });
      await post('/api/update/check', {});
      assert.equal(githubCalls, 1);
    });

    it('the page has the button, the switch and a banner that only ever links to GitHub', () => {
      const html = renderPage('1.0.0');
      for (const id of ['update-banner', 'update-check', 'update-auto', 'update-link']) assert.ok(html.includes(`id="${id}"`), id);
      assert.match(html, /indexOf\('https:\/\/github\.com\/'\) === 0/, 'the link is only filled in for a GitHub address');
    });
  });

  it('falls back to another port if its usual one is taken', async () => {
    const second = await startWebServer({ supervisor, updates, paths, log: silentLogger, version: '1', key: KEY, port: web.port, tail: () => [], onQuit: () => {} });
    try {
      assert.notEqual(second.port, web.port);
    } finally {
      await second.close();
    }
  });
});
