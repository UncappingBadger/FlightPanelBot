import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readTextCapped } from '../util/http.js';
import { silentLogger, type Logger } from '../util/log.js';

/** Where releases of this app are published. The check only ever reads this repository's latest release. */
export const UPDATE_REPO = 'UncappingBadger/FlightPanelBot';

const DAY_MS = 24 * 60 * 60_000;
/** Wait a little after start-up so the first connection to Discord isn't competing with it. */
const FIRST_CHECK_DELAY_MS = 20_000;
const TIMEOUT_MS = 8_000;
const MAX_RESPONSE_CHARS = 2_000_000;

/** What the update check knows. The tray launcher and the setup page both show it. */
export interface UpdateStatus {
  /** False for a development run, which has no version to compare. */
  supported: boolean;
  /** Whether the check runs by itself once a day. The "Check now" button always works. */
  auto: boolean;
  /** When the last check finished, or null if none has yet. */
  checkedAt: number | null;
  /** True if the last check reached GitHub and understood the answer, false if it couldn't, null before any check. */
  ok: boolean | null;
  current: string;
  /** The newest release's tag, e.g. `v0.2.0`, or null if there are no releases (or no check yet). */
  latest: string | null;
  available: boolean;
  /** The release's page on GitHub, always an address inside this app's own repository. */
  url: string | null;
  /** True, for this run only, when `latest` is a release the host hasn't been told about before: the tray pops up a notice for it. */
  announce: boolean;
}

/** `v1.2.3`, `1.2`, `V1.0.0-beta` -> [1, 2, 3]. A missing part counts as zero. Null if it doesn't start with a version. */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /^\s*v?(\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?/i.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function isNewer(remote: [number, number, number], local: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (remote[i] !== local[i]) return (remote[i] as number) > (local[i] as number);
  }
  return false;
}

export interface UpdateCheckerOptions {
  /** This build's version, e.g. `0.1.6`. Anything that isn't a version (a dev run says `dev`) switches the check off. */
  version: string;
  /** Where to remember which release the host has been told about. */
  statePath: string;
  /** Whether the daily check is switched on. Read each time, so the setup page's switch takes effect at once. */
  autoEnabled: () => boolean;
  /** Called after every check, so the tray's status file can be rewritten. */
  onChange?: (status: UpdateStatus) => void;
  repo?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  logger?: Logger;
  /** How often the automatic check runs. */
  intervalMs?: number;
  /** How long after `start()` the first automatic check runs. */
  firstCheckDelayMs?: number;
}

/**
 * Looks at GitHub's public "latest release" for this app, once a day and on request, and remembers whether
 * a newer version exists. It never downloads or installs anything: it only says so, and points at the
 * release page, which the host opens themselves. The only thing sent is an ordinary HTTPS request that
 * names this app and its version.
 */
export class UpdateChecker {
  private readonly repo: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly local: [number, number, number] | null;
  private timers: NodeJS.Timeout[] = [];
  private inFlight: Promise<UpdateStatus> | null = null;
  private checkedAt: number | null = null;
  private ok: boolean | null = null;
  private latest: string | null = null;
  private url: string | null = null;
  /** The release this run is announcing, if any. */
  private announcing: string | null = null;

  constructor(private readonly o: UpdateCheckerOptions) {
    this.repo = o.repo ?? process.env.FPB_UPDATE_REPO ?? UPDATE_REPO;
    this.fetchFn = o.fetchFn ?? fetch;
    this.now = o.now ?? Date.now;
    this.log = o.logger ?? silentLogger;
    this.local = parseVersion(o.version);
  }

  /** Where this app's releases are listed, whatever GitHub says. */
  private get releasesUrl(): string {
    return `https://github.com/${this.repo}/releases/latest`;
  }

  status(): UpdateStatus {
    const remote = this.latest ? parseVersion(this.latest) : null;
    const available = Boolean(this.local && remote && isNewer(remote, this.local));
    return {
      supported: this.local !== null,
      auto: this.o.autoEnabled(),
      checkedAt: this.checkedAt,
      ok: this.ok,
      current: this.o.version,
      latest: this.latest,
      available,
      url: available ? this.url ?? this.releasesUrl : null,
      announce: available && this.announcing !== null && this.announcing === this.latest,
    };
  }

  /** Begin the daily check: one soon after start-up, then every 24 hours. Does nothing for a development run. */
  start(): void {
    if (!this.local || this.timers.length > 0) return;
    const run = () => {
      if (this.o.autoEnabled()) void this.check().catch(() => undefined);
    };
    const first = setTimeout(run, this.o.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS);
    const every = setInterval(run, this.o.intervalMs ?? DAY_MS);
    first.unref?.();
    every.unref?.();
    this.timers = [first, every];
  }

  stop(): void {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers = [];
  }

  /** Ask GitHub now. Never throws: a failed check is recorded as such. Overlapping calls share one request. */
  check(): Promise<UpdateStatus> {
    if (!this.local) return Promise.resolve(this.status());
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchLatest()
      .catch((e) => {
        this.ok = false;
        this.log.debug(`Update check failed: ${e instanceof Error ? e.message : e}`);
      })
      .then(() => {
        this.checkedAt = this.now();
        this.noteAnnouncement();
        const status = this.status();
        try {
          this.o.onChange?.(status);
        } catch (e) {
          this.log.warn('Update status listener failed', e);
        }
        return status;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async fetchLatest(): Promise<void> {
    const res = await this.fetchFn(`https://api.github.com/repos/${this.repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `FlightPanelBot/${this.o.version}`, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // No release has been published yet: that is "nothing newer", not a failure.
    if (res.status === 404) {
      this.ok = true;
      this.latest = null;
      this.url = null;
      return;
    }
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
    const text = await readTextCapped(res, MAX_RESPONSE_CHARS);
    if (text === null) throw new Error('GitHub sent far more than expected');
    // GitHub's "latest" never returns a draft or a pre-release, so those need no checking here.
    const body = JSON.parse(text) as { tag_name?: unknown; html_url?: unknown };
    const tag = typeof body.tag_name === 'string' ? body.tag_name.trim() : '';
    // The tag and link are shown and opened, so accept only plain-looking values.
    if (!/^[\w.+-]{1,40}$/.test(tag) || parseVersion(tag) === null) throw new Error('GitHub sent a release tag I do not understand');
    const prefix = `https://github.com/${this.repo}/`;
    this.latest = tag;
    this.url = typeof body.html_url === 'string' && body.html_url.startsWith(prefix) && body.html_url.length <= 300 ? body.html_url : this.releasesUrl;
    this.ok = true;
  }

  /** The first run to see a given newer release announces it, and the host won't be told about that release again on later runs. */
  private noteAnnouncement(): void {
    if (!this.status().available || !this.latest) return;
    if (this.announcing === this.latest) return;
    let told: string | null = null;
    try {
      told = (JSON.parse(readFileSync(this.o.statePath, 'utf8')) as { announced?: unknown }).announced as string | null;
    } catch {
      /* no file yet */
    }
    if (told === this.latest) return;
    this.announcing = this.latest;
    try {
      mkdirSync(dirname(this.o.statePath), { recursive: true });
      const tmp = `${this.o.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ announced: this.latest }), 'utf8');
      renameSync(tmp, this.o.statePath);
    } catch (e) {
      this.log.warn('Could not remember which update was announced', e);
    }
    this.log.info(`A newer version is available: ${this.latest} (this is ${this.o.version}).`);
  }
}
