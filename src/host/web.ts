import { timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '../util/log.js';
import { setupTabs, tabPhrase, type SetupConsole } from '../discord/setupConsole.js';
import { SettingsError, type AirlineSettings, type LimitsChange, type SafetyPatch } from '../services/airlineSettings.js';
import { fshubTokenProblem, normalizeFsHubToken } from '../fshub/client.js';
import { checkDiscordToken, checkFsHubToken } from './accounts.js';
import type { HostPaths } from './paths.js';
import { renderPage } from './page.js';
import { BUILT_IN_TWITCH_CLIENT_ID, validClientId } from '../twitch/clientId.js';
import { CHAT_SCOPES, pollDeviceFlow, revokeToken, startDeviceFlow, TwitchAuthError, validateToken, type DeviceCode } from '../twitch/oauth.js';
import { readTokens, removeTokens, writeTokens } from '../twitch/tokens.js';
import { discordTokenProblem, loadSettings, normalizeChannel, normalizeToken, removeGoogleKey, saveGoogleKey, saveSettings } from './settings.js';
import type { Supervisor } from './supervisor.js';
import type { UpdateChecker } from './updates.js';

export interface WebOptions {
  supervisor: Supervisor;
  /** Looks for a newer release on GitHub. */
  updates: UpdateChecker;
  paths: HostPaths;
  log: Logger;
  version: string;
  /** Every request must carry this secret; it is only ever handed to the tray launcher, in the status file. */
  key: string;
  /** The port to try first. If it is taken, any free one is used. */
  port?: number;
  /** The most recent log lines. */
  tail: (count: number) => string[];
  /** Called when the host asks to quit. */
  onQuit: () => void;
  /** Used to ask Discord whether a pasted token works. Replaceable in tests. */
  fetchFn?: typeof fetch;
  /** The Twitch application ID built into this app (a fork may have none). Replaceable in tests. */
  builtInTwitchClientId?: string;
}

export interface WebServer {
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 256 * 1024;
/** The settings page's command runner takes more: a flights file for the import tab can be 256 KB of text, which is a little more once it is JSON. */
const MAX_RUN_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send JSON.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'That is too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* handled below */
  }
  throw new HttpError(400, 'That is not valid JSON.');
}

/**
 * The host's local setup page. It listens on this computer only, answers only to the right address
 * and the secret key, and refuses requests that did not come from its own page, so nothing else
 * running on the machine (or open in a browser) can read or change the bot's settings.
 */
export async function startWebServer(opts: WebOptions): Promise<WebServer> {
  const fetchFn = opts.fetchFn ?? fetch;
  let port = 0;

  const send = (res: ServerResponse, status: number, body: string, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data));

  // Connecting a Twitch account: the code shown to the host while they approve it on Twitch's own page. Held in memory only.
  let pending: { device: DeviceCode; clientId: string; expiresAt: number; lastPoll: number } | null = null;
  const clientIdForTwitch = (): string => loadSettings(opts.paths).twitch?.clientId || (opts.builtInTwitchClientId ?? BUILT_IN_TWITCH_CLIENT_ID);
  const twitchView = () => {
    const settings = loadSettings(opts.paths).twitch;
    const tokens = readTokens(opts.paths.twitchTokens);
    let status: unknown = null;
    try {
      status = JSON.parse(readFileSync(opts.paths.twitchStatus, 'utf8'));
    } catch {
      /* the bot has not written one */
    }
    const waiting = pending && Date.now() < pending.expiresAt ? { userCode: pending.device.userCode, verificationUri: pending.device.verificationUri, expiresAt: pending.expiresAt } : null;
    return {
      available: clientIdForTwitch() !== '',
      ownClientId: Boolean(settings?.clientId),
      connectedAs: tokens ? tokens.login : null,
      channel: settings?.channel ?? '',
      commands: settings?.commands ?? true,
      banter: settings?.banter ?? true,
      pilotId: settings?.pilotId ?? null,
      status,
      pending: waiting,
    };
  };

  /** The airline settings of the running bot. */
  const settingsOf = (): AirlineSettings => {
    const settings = opts.supervisor.settings();
    if (!settings) throw new HttpError(409, 'The bot is not running, so there are no airlines to show yet. Once it is online (it needs the Discord token), they appear here.');
    return settings;
  };
  /** The `/setup` console of the running bot. */
  const setupOf = (): SetupConsole => {
    const setup = opts.supervisor.setup();
    if (!setup) throw new HttpError(409, 'The bot is not running, so there is nothing to set up yet. Once it is online (it needs the Discord token), the servers appear here.');
    return setup;
  };
  /** A panel number from the page. */
  const panelOf = (raw: unknown): number => {
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) throw new HttpError(400, 'Choose an airline.');
    return n;
  };
  /** Runs a settings call, turning a refused setting into an answer the page can show. */
  const asHttp = async <T>(run: () => T | Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      if (e instanceof SettingsError) throw new HttpError(e.status, e.message);
      throw e;
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Only our own address: a web page on the internet that points a hostname at this computer is refused.
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'Not allowed.');

    const url = new URL(req.url ?? '/', `http://${host}`);
    const given = url.searchParams.get('k') ?? String(req.headers['x-fpb-key'] ?? '');
    if (!safeEqual(given, opts.key)) throw new HttpError(403, 'Open the setup page from the Flight Panel Bot tray icon.');

    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, renderPage(opts.version), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { ...opts.supervisor.state(), update: opts.updates.status() });
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const count = Math.min(Math.max(Number(url.searchParams.get('n')) || 200, 1), 500);
      return json(res, 200, { lines: opts.tail(count) });
    }

    if (req.method === 'GET' && url.pathname === '/api/twitch') return json(res, 200, twitchView());

    // The airlines the bot is set up for, and their landing safety pay and landing limits (only while the bot is running: its database is open then).
    // The `/setup` commands as tabs: the tabs (and what each one asks), the servers with their airlines, and a server's channels and roles.
    if (req.method === 'GET' && url.pathname === '/api/setup/tabs') return json(res, 200, { tabs: setupTabs() });
    if (req.method === 'GET' && url.pathname === '/api/setup/servers') return json(res, 200, { servers: setupOf().servers() });
    if (req.method === 'GET' && url.pathname === '/api/setup/choices') {
      const guild = url.searchParams.get('guild') ?? '';
      if (!/^\d{15,22}$/.test(guild)) throw new HttpError(400, 'Choose a server.');
      const setup = setupOf();
      try {
        return json(res, 200, await setup.choices(guild));
      } catch (e) {
        throw new HttpError(404, e instanceof Error ? e.message : 'I could not read that server.');
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/airlines') return json(res, 200, { airlines: settingsOf().airlines() });
    if (req.method === 'GET' && url.pathname === '/api/airline/safety') return json(res, 200, await asHttp(async () => settingsOf().safety(panelOf(url.searchParams.get('panel')))));
    if (req.method === 'GET' && url.pathname === '/api/airline/fleet') {
      const business = url.searchParams.get('business');
      const fleet = await asHttp(() => settingsOf().fleet(panelOf(url.searchParams.get('panel')), { refresh: url.searchParams.get('refresh') === '1', ...(business ? { business: Number(business) } : {}) }));
      // The reasons come from the commands' own wording, which names a /setup command: on this page that is a tab.
      return json(res, 200, { ...fleet, problem: fleet.problem === null ? null : tabPhrase(fleet.problem) });
    }

    if (req.method !== 'POST') throw new HttpError(404, 'Not found.');
    // A page on another site can't send JSON with our header, so this also blocks cross-site requests.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) throw new HttpError(403, 'Not allowed.');
    const body = await readJson(req, url.pathname === '/api/setup/run' ? MAX_RUN_BODY_BYTES : MAX_BODY_BYTES);

    switch (url.pathname) {
      case '/api/settings': {
        const current = loadSettings(opts.paths);
        const notes: string[] = [];
        const discord = typeof body.discordToken === 'string' ? normalizeToken(body.discordToken) : '';
        if (!discord) throw new HttpError(400, 'Paste the bot token to save.');

        const problem = discordTokenProblem(discord);
        if (problem) throw new HttpError(400, problem);
        const check = await checkDiscordToken(discord, fetchFn);
        if (check.status === 'rejected') throw new HttpError(400, check.message);
        if (check.status === 'unknown') notes.push(check.message);
        current.discordToken = discord;

        saveSettings(opts.paths, current);
        void opts.supervisor.restart();
        return json(res, 200, { ok: true, notes });
      }

      // Look on GitHub for a newer version right now.
      case '/api/update/check':
        return json(res, 200, await opts.updates.check());

      // Switch the daily automatic check on or off.
      case '/api/update/auto': {
        if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'Say whether to check automatically.');
        const current = loadSettings(opts.paths);
        current.checkForUpdates = body.enabled;
        saveSettings(opts.paths, current);
        return json(res, 200, opts.updates.status());
      }

      case '/api/google-key': {
        if (typeof body.json !== 'string' || body.json.length === 0) throw new HttpError(400, 'Choose the key file you downloaded from Google Cloud.');
        try {
          const info = saveGoogleKey(opts.paths, body.json);
          void opts.supervisor.restart();
          return json(res, 200, { ok: true, email: info.email });
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : 'That is not a usable key.');
        }
      }

      case '/api/google-key/remove':
        removeGoogleKey(opts.paths);
        void opts.supervisor.restart();
        return json(res, 200, { ok: true });

      // The optional FsHub token: checked with FsHub, then kept, and never sent back to the page.
      case '/api/fshub': {
        const token = typeof body.token === 'string' ? normalizeFsHubToken(body.token) : '';
        const problem = fshubTokenProblem(token);
        if (problem) throw new HttpError(400, problem);
        const check = await checkFsHubToken(token, fetchFn);
        if (check.status === 'rejected') throw new HttpError(400, check.message);
        const current = loadSettings(opts.paths);
        current.fshubAccessToken = token;
        saveSettings(opts.paths, current);
        void opts.supervisor.restart();
        return json(res, 200, { ok: true, name: check.status === 'ok' ? (check.name ?? null) : null, notes: check.status === 'unknown' ? [check.message] : [] });
      }

      case '/api/fshub/remove': {
        const current = loadSettings(opts.paths);
        current.fshubAccessToken = '';
        saveSettings(opts.paths, current);
        void opts.supervisor.restart();
        return json(res, 200, { ok: true });
      }

      // Optional Twitch chat. Step one of connecting: Twitch gives a short code, which the host types at Twitch's own page.
      case '/api/twitch/connect': {
        const clientId = clientIdForTwitch();
        if (!clientId) throw new HttpError(400, "This copy of the app has no Twitch application ID yet. Paste one under 'Advanced' below.");
        try {
          const device = await startDeviceFlow(clientId, CHAT_SCOPES, fetchFn);
          pending = { device, clientId, expiresAt: Date.now() + device.expiresInSec * 1000, lastPoll: 0 };
          return json(res, 200, { userCode: device.userCode, verificationUri: device.verificationUri, expiresInSec: device.expiresInSec, intervalSec: device.intervalSec });
        } catch (e) {
          throw new HttpError(400, e instanceof TwitchAuthError ? e.message : 'Could not start the Twitch sign-in.');
        }
      }

      // Step two, asked every few seconds by the page: has the host approved it yet?
      case '/api/twitch/poll': {
        const p = pending;
        if (!p) throw new HttpError(400, 'Start by pressing Connect to Twitch.');
        if (Date.now() >= p.expiresAt) {
          pending = null;
          throw new HttpError(400, 'That code ran out. Press Connect to Twitch to get a new one.');
        }
        if (Date.now() - p.lastPoll < p.device.intervalSec * 1000) return json(res, 200, { status: 'pending' });
        p.lastPoll = Date.now();
        try {
          const set = await pollDeviceFlow(p.clientId, CHAT_SCOPES, p.device.deviceCode, fetchFn);
          if (set === null) return json(res, 200, { status: 'pending' });
          const who = await validateToken(set.accessToken, fetchFn);
          if (!who) throw new TwitchAuthError('invalid', "Twitch didn't accept the new sign-in. Try again.");
          writeTokens(opts.paths.twitchTokens, {
            clientId: p.clientId,
            accessToken: set.accessToken,
            refreshToken: set.refreshToken,
            expiresAt: Date.now() + set.expiresInSec * 1000,
            userId: who.userId,
            login: who.login,
            scopes: set.scopes.length > 0 ? set.scopes : who.scopes,
          });
          pending = null;
          opts.log.info(`Twitch account connected (${who.login})`);
          void opts.supervisor.restart();
          return json(res, 200, { status: 'connected', login: who.login });
        } catch (e) {
          if (e instanceof TwitchAuthError && e.kind === 'unavailable') return json(res, 200, { status: 'pending', note: e.message });
          pending = null;
          throw new HttpError(400, e instanceof TwitchAuthError ? e.message : 'The Twitch sign-in failed.');
        }
      }

      case '/api/twitch/settings': {
        const current = loadSettings(opts.paths);
        const before = current.twitch ?? { channel: '', commands: true, banter: true };
        const channelRaw = typeof body.channel === 'string' ? body.channel.trim() : null;
        let channel = before.channel;
        if (channelRaw !== null) {
          if (channelRaw === '') channel = '';
          else {
            const c = normalizeChannel(channelRaw);
            if (c === null) throw new HttpError(400, "That doesn't look like a Twitch channel name (letters, digits and underscores, 3 to 25 long).");
            channel = c;
          }
        }
        const next: NonNullable<typeof current.twitch> = {
          channel,
          commands: typeof body.commands === 'boolean' ? body.commands : before.commands,
          banter: typeof body.banter === 'boolean' ? body.banter : before.banter,
        };
        if ('pilotId' in body) {
          const raw = body.pilotId;
          if (raw !== null && raw !== '' && raw !== undefined) {
            const n = Number(raw);
            if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, "The FsHub pilot number is the number in the address of the streamer's FsHub profile.");
            next.pilotId = n;
          }
        } else if ('pilotId' in before && before.pilotId !== undefined) next.pilotId = before.pilotId;
        if ('clientId' in body) {
          const raw = typeof body.clientId === 'string' ? body.clientId.trim() : '';
          if (raw !== '') {
            if (!validClientId(raw)) throw new HttpError(400, "That doesn't look like a Twitch Client ID (letters and digits, about 30 long).");
            next.clientId = raw;
          }
        } else if ('clientId' in before && before.clientId) next.clientId = before.clientId;
        if (next.channel === '' && !next.clientId) delete current.twitch;
        else current.twitch = next;
        saveSettings(opts.paths, current);
        void opts.supervisor.restart();
        return json(res, 200, { ok: true, ...twitchView() });
      }

      case '/api/twitch/disconnect': {
        const tokens = readTokens(opts.paths.twitchTokens);
        if (tokens) await revokeToken(tokens.clientId, tokens.accessToken, fetchFn);
        removeTokens(opts.paths.twitchTokens);
        rmSync(opts.paths.twitchStatus, { force: true });
        pending = null;
        opts.log.info('Twitch account disconnected');
        void opts.supervisor.restart();
        return json(res, 200, { ok: true });
      }

      // Landing safety pay for one airline: on or off, what a pilot loses of the minimum, the shares, deductions in the sheet, and the airline's default limits.
      case '/api/airline/safety': {
        const patch: SafetyPatch = {};
        for (const k of ['on', 'deductions'] as const) if (k in body) patch[k] = body[k] as boolean;
        for (const k of ['lossTier1', 'lossTier2', 'shareTier1', 'shareTier2'] as const) if (k in body) patch[k] = body[k] as number;
        if ('defaults' in body) {
          const d = body.defaults as Record<string, unknown> | null;
          if (!d || typeof d !== 'object' || typeof d.warn !== 'number' || typeof d.tier1 !== 'number' || typeof d.tier2 !== 'number') throw new HttpError(400, 'Give the default limits as three numbers: warning, Tier 1 and Tier 2.');
          patch.defaults = { warn: d.warn, tier1: d.tier1, tier2: d.tier2 };
        }
        return json(res, 200, await asHttp(async () => settingsOf().setSafety(panelOf(body.panel), patch)));
      }

      // The landing limits of some aircraft types: each with limits of its own, or null to put it back on the airline's default.
      case '/api/airline/limits': {
        if (!Array.isArray(body.changes)) throw new HttpError(400, 'Send the aircraft to change.');
        const changes: LimitsChange[] = [];
        for (const c of body.changes as unknown[]) {
          const item = c as { aircraft?: unknown; limits?: unknown } | null;
          if (!item || typeof item !== 'object' || typeof item.aircraft !== 'string') throw new HttpError(400, 'Each change needs an aircraft code.');
          if (item.limits === null) changes.push({ aircraft: item.aircraft, limits: null });
          else {
            const l = item.limits as Record<string, unknown> | undefined;
            if (!l || typeof l !== 'object' || typeof l.warn !== 'number' || typeof l.tier1 !== 'number' || typeof l.tier2 !== 'number') throw new HttpError(400, `The ${item.aircraft.slice(0, 8)} needs three limits: warning, Tier 1 and Tier 2.`);
            changes.push({ aircraft: item.aircraft, limits: { warn: l.warn, tier1: l.tier1, tier2: l.tier2 } });
          }
        }
        const done = await asHttp(async () => settingsOf().setLimits(panelOf(body.panel), changes));
        return json(res, 200, { ok: true, ...done });
      }

      // Run a `/setup` command from its tab, as the server's owner (or, with `status`, say how things stand). A refusal is an ordinary answer with `ok: false`.
      case '/api/setup/run': {
        if (typeof body.tab !== 'string' || typeof body.guild !== 'string' || !/^\d{15,22}$/.test(body.guild)) throw new HttpError(400, 'Choose a tab and a server.');
        const values = body.values;
        if (values !== undefined && (values === null || typeof values !== 'object' || Array.isArray(values))) throw new HttpError(400, 'What was typed in the form is not valid.');
        const panel = body.panel === undefined || body.panel === null ? null : Number(body.panel);
        if (panel !== null && (!Number.isSafeInteger(panel) || panel < 1)) throw new HttpError(400, 'Choose an airline.');
        const result = await setupOf().run({ tab: body.tab, guild: body.guild, panel, values: (values ?? {}) as Record<string, unknown>, status: body.status === true });
        if (!result.ok || body.status !== true) opts.log.info(`Settings page: ${body.tab}${result.ok ? '' : ' (refused)'}`);
        return json(res, 200, result);
      }

      case '/api/restart':
        void opts.supervisor.restart();
        return json(res, 200, { ok: true });

      case '/api/quit':
        json(res, 200, { ok: true });
        setImmediate(opts.onQuit);
        return;

      default:
        throw new HttpError(404, 'Not found.');
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      opts.log.error('Setup page request failed', e);
      return json(res, 500, { error: 'Something went wrong. See the log.' });
    });
  });

  const listen = (p: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  try {
    await listen(opts.port ?? 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    await listen(0);
  }
  port = (server.address() as AddressInfo).port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
