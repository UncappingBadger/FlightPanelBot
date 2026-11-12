import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '../util/log.js';
import { checkDiscordToken } from './accounts.js';
import type { HostPaths } from './paths.js';
import { renderPage } from './page.js';
import { discordTokenProblem, loadSettings, normalizeToken, removeGoogleKey, saveGoogleKey, saveSettings } from './settings.js';
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
}

export interface WebServer {
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 256 * 1024;

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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send JSON.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'That is too large.');
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

    if (req.method !== 'POST') throw new HttpError(404, 'Not found.');
    // A page on another site can't send JSON with our header, so this also blocks cross-site requests.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) throw new HttpError(403, 'Not allowed.');
    const body = await readJson(req);

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
