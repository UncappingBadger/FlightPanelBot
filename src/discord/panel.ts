import { createHash } from 'node:crypto';
import { MessageFlags, PermissionFlagsBits, type ActionRowBuilder, type Client, type DMChannel, type EmbedBuilder, type MessageActionRowComponentBuilder, type SendableChannels, type User } from 'discord.js';
import type { Panel, PanelFollower, Store } from '../db/store.js';
import { DEBUG_BUILD, dbg } from '../util/debugBuild.js';
import { silentLogger, type Logger } from '../util/log.js';
import type { FlightEta } from '../services/flightEtas.js';
import { confirmationsFor } from '../services/flightMatch.js';
import { COMPLETED_SHOW_MS, panelHorizonMs, type JobService } from '../services/jobs.js';
import { CLEANUP_BEFORE_MIDNIGHT_MS, DAY_MS, startOfUtcDay, type Reminder } from '../services/reminders.js';
import { discordErrorCode, isDmClosed, isMissingAccess, isUnknownMessage } from './errors.js';
import { availableFor } from '../services/availability.js';
import { flightState, renderGridPanel, type GridFlight } from './gridUi.js';
import { avatarIdsOf, defaultAvatar, listRows, noPings, panelRows, renderListParts, renderPanelParts, renderReminder, stampFiles, usesStamp, type Avatar } from './ui.js';
import { appNow, realMs } from '../util/clock.js';

/** What one message of a panel (or of a pilot's list) says and carries. */
interface Payload {
  embeds: EmbedBuilder[];
  components: Array<ActionRowBuilder<MessageActionRowComponentBuilder>>;
  allowedMentions: typeof noPings;
}

/** Debug build: which panels have had the bot's permissions in their channel written to the log already. */
const permsLogged = new Set<number>();

/** The part of a channel's messages the bot uses to look at its own: Discord's own answer (not a copy held from before), one message or a recent batch. */
interface MessageLookup {
  fetch(options: any): Promise<any>;
}
type LookedUp = { editable: boolean; deletable: boolean; edit(options: any): Promise<unknown>; delete(): Promise<unknown> };

/** What one redraw of a panel did: how many messages it has, how many it edited and how many it posted (what Discord was made to do). */
interface DrawStats {
  messages: number;
  edited: number;
  sent: number;
}

/** A redraw that takes longer than this is noted in the log. */
const SLOW_REDRAW_MS = 3_000;

/** How many of a channel's latest messages are asked for in one request when looking for the bot's own. */
const RECENT_MESSAGES = 100;

/**
 * The messages with these IDs as Discord has them now, in the order asked, with null for one that is gone. A person can delete a message and the
 * bot is never told, so each is asked of Discord, not remembered. That used to be one request for each message of a panel; the panel is usually
 * the last thing in its channel, so one request for the channel's latest messages answers for all of them, and only a message that is not
 * among those is asked for by itself.
 */
export async function lookUpMessages(messages: MessageLookup, ids: string[], strict = false): Promise<Array<LookedUp | null>> {
  const found = new Map<string, LookedUp>();
  if (ids.length > 1) {
    try {
      const recent = (await messages.fetch({ limit: RECENT_MESSAGES })) as ReadonlyMap<string, LookedUp>;
      for (const [id, m] of recent) if (ids.includes(id)) found.set(id, m);
    } catch {
      /* asked for one at a time below */
    }
  }
  return Promise.all(
    ids.map(async (id) => {
      const hit = found.get(id);
      if (hit) return hit;
      // `strict`: only a message that is gone counts as gone; any other failure (Discord not answering) is passed on, not taken for a deleted message.
      return (messages.fetch({ message: id, force: true }) as Promise<LookedUp>).catch((e: unknown) => (strict && !isUnknownMessage(e) ? Promise.reject(e) : null));
    }),
  );
}

/** What a message was last made to say (a digest of it, so remembering a long panel costs a few bytes a message), so an edit that would change nothing is not sent. */
const contentOf = (p: Payload): string => createHash('sha256').update(JSON.stringify([p.embeds.map((e) => e.toJSON()), p.components.map((c) => c.toJSON())])).digest('base64');

/** What to post for a panel message: its cards and buttons, and the OPEN stamp's picture when a card wears it. */
const forSend = (p: Payload) => ({ ...p, files: stampFiles(p.embeds) });
/** What to edit a panel message to: the same, with the stamp's picture put on again when a card wears it, or taken off when none does any more. */
const forEdit = (p: Payload) => (usesStamp(p.embeds) ? { ...p, files: stampFiles(p.embeds) } : { ...p, attachments: [] });

/** Folded messages of a grid panel unfold by themselves when nobody has pressed any button on the panel for this long. */
export const FOLD_IDLE_MS = 10 * 60_000;
const NO_FOLDS: ReadonlySet<number> = new Set();

/** At most this many people may have a panel's list in their DMs at once: every redraw edits each of them. */
export const MAX_FOLLOWERS = 200;
/** Whether someone with a list is still in the server and can still see the panel is checked this often. */
const ENTITLED_RECHECK_MS = 30 * 60_000;

/** A person's picture is asked for again after this long (they change it now and then); until then the one we have is used. */
const AVATAR_FRESH_MS = 6 * 3_600_000;
/** The most pilots' pictures kept at once. */
const MAX_AVATARS = 2_000;

/** How asking for a list went: it was posted (in this DM channel), or why not. */
export type FollowResult = { ok: true; channelId: string } | { ok: false; reason: 'dm-closed' | 'full' | 'gone' };

/**
 * - `updated`: edited the existing messages in place
 * - `posted`: (re)posted the panel
 * - `no-access`: the channel is gone or the bot can't see or write in it
 * - `failed`: something else went wrong (details are in the log)
 */
export type PanelRefreshResult = 'updated' | 'posted' | 'skipped' | 'no-access' | 'failed';

export { startOfUtcDay };

/** A tracked announcement the bot could not remove is given up on after this long. */
const GIVE_UP_AFTER_MS = 3 * DAY_MS;

/** How an "pilots needed" announcement went: `sent`, `skipped` (reminders are off), or a failure as above. */
export type ReminderResult = 'sent' | 'skipped' | 'no-access' | 'failed';

/**
 * Keeps each panel's Discord messages in step with the job list. Messages are edited in place; if
 * any has been deleted (or the list grew or shrank) the whole panel is reposted so the order stays right.
 */
export class PanelService {
  private client: Client | null = null;
  private readonly timers = new Map<number, NodeJS.Timeout>();
  /** The redraw of each panel that is under way or queued, so the next one starts only when it is done. */
  private readonly chains = new Map<number, Promise<unknown>>();
  /** A redraw that is queued but has not started: requests made meanwhile share it. */
  private readonly waiting = new Map<number, Promise<PanelRefreshResult>>();
  /** What each panel message was last made to say (by message id), so unchanged messages are not edited again. */
  private readonly shown = new Map<string, string>();
  /** Panels whose next redraw must send every message again. */
  private readonly forced = new Set<number>();
  /** When each drawn panel's list will next change by the passing of time alone (see `listing`). Panels not yet drawn are absent. */
  private readonly changeAt = new Map<number, number>();
  /** Whether the bot has a FsHub token, so the panel can say flights are completed from FsHub automatically. Set at start-up. */
  fshubEnabled = false;
  /** Where each flight in the air is expected to land, for the cards. Set at start-up; null (nothing is shown) until then. */
  etas: { forPanel(panelId: number): ReadonlyMap<number, FlightEta> } | null = null;
  /** The work of keeping people's lists up to date, one panel at a time (a list's messages are changed by one task at once). */
  private readonly followChains = new Map<number, Promise<unknown>>();
  /** An update of a panel's lists that is queued but has not started: requests made meanwhile share it. */
  private readonly followWaiting = new Map<number, Promise<void>>();
  /** When each person's list (`panelId:discordId`) was last checked against the server, on the bot's clock. */
  private readonly entitledAt = new Map<string, number>();
  /** When each panel's lists were last updated, in real time. */
  private readonly lastFollowPassAt = new Map<number, number>();
  /** Panels whose channel the bot may not attach files in, so the warning is given once. */
  private readonly warnedNoAttach = new Set<number>();
  /** Debug build: what the last message sent or edited looked like, for a failure to be read against. */
  private lastPayloadNote = '(nothing yet)';
  /** The pictures of the people on the panel's cards, and when each was last asked for. */
  private readonly avatarCache = new Map<string, { at: number; avatar: Avatar }>();
  /** For a grid panel: which of its messages (by position) are folded to one line, and when a button on the panel was last pressed. Not kept across a restart. */
  private readonly folds = new Map<number, { parts: Set<number>; touchedAt: number }>();
  /** How many messages of flights each grid panel was last drawn with, so "collapse all" knows. */
  private readonly gridParts = new Map<number, number>();

  constructor(
    private readonly store: Store,
    private readonly jobs: JobService,
    private readonly log: Logger = silentLogger,
    private readonly now: () => number = appNow,
    private readonly debounceMs = 1500,
    /** The least time between two updates of one panel's lists in people's DMs, so a burst of changes is not a burst of DM edits. */
    private readonly followGapMs = 15_000,
  ) {}

  attach(client: Client): void {
    this.client = client;
  }

  /** Which messages of a grid panel are folded now. */
  foldsOf(panelId: number): ReadonlySet<number> {
    return this.folds.get(panelId)?.parts ?? NO_FOLDS;
  }

  /** A button on the panel was pressed: folded messages stay folded for another ten minutes. */
  touch(panelId: number): void {
    const f = this.folds.get(panelId);
    if (f) f.touchedAt = this.now();
  }

  /** Fold or unfold one message of a grid panel. Redraw to show it. */
  setFold(panelId: number, part: number, folded: boolean): void {
    const f = this.folds.get(panelId) ?? { parts: new Set<number>(), touchedAt: this.now() };
    if (folded) f.parts.add(part);
    else f.parts.delete(part);
    f.touchedAt = this.now();
    if (f.parts.size === 0) this.folds.delete(panelId);
    else this.folds.set(panelId, f);
  }

  /** Fold every message of a grid panel, or unfold them all. Redraw to show it. */
  setAllFolds(panelId: number, folded: boolean): void {
    const count = this.gridParts.get(panelId) ?? 0;
    if (!folded || count === 0) this.folds.delete(panelId);
    else this.folds.set(panelId, { parts: new Set(Array.from({ length: count }, (_, i) => i)), touchedAt: this.now() });
  }

  /** Forget a panel's folds (it went back to cards, or was removed). */
  clearFolds(panelId: number): void {
    this.folds.delete(panelId);
    this.gridParts.delete(panelId);
  }

  /** Request a redraw; a burst of changes inside the debounce window becomes one edit. */
  schedule(panelId: number): void {
    if (this.stopped || this.timers.has(panelId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(panelId);
      this.refresh(panelId).catch((e) => {
        if (!this.stopped) this.log.warn(`Could not refresh panel ${panelId}`, e);
      });
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(panelId, timer);
  }

  /**
   * Redraw a panel. Redraws of one panel never overlap: two at once would each see the messages as they were, and
   * if the panel had to be reposted both would post it, leaving a second copy in the channel that nothing knows
   * about. So a request made while a redraw is under way waits for it and then draws once more, and any number of
   * requests made during that wait share the one redraw (it reads the jobs when it starts, so it shows them all).
   */
  refresh(panelId: number, opts: { force?: boolean } = {}): Promise<PanelRefreshResult> {
    if (this.stopped) return Promise.resolve('skipped'); // shutting down: the database and Discord are about to go
    // A forced redraw sends every message again (it forgets what each was last made to say), so that anything new about
    // a panel, such as buttons added by a newer version of the bot, reaches the messages already in the channel.
    if (opts.force) this.forced.add(panelId);
    const waiting = this.waiting.get(panelId);
    if (waiting) return waiting;
    const after = this.chains.get(panelId) ?? Promise.resolve();
    const run = after.then(() => {
      this.waiting.delete(panelId);
      return this.redraw(panelId);
    });
    this.waiting.set(panelId, run);
    const done = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(panelId, done);
    void done.then(() => {
      if (this.chains.get(panelId) === done) this.chains.delete(panelId);
    });
    return run;
  }

  /**
   * What a panel lists right now. Only the flights open now or starting within the panel's period are listed; later ones
   * are counted, not shown. `changeAt` is when the list will next change by the passing of time alone (a flight coming
   * within the period, a completed one aging out), so the panel can be redrawn then even though nothing else happened.
   */
  private listing(panel: Panel) {
    const now = this.now();
    const horizon = panelHorizonMs(panel.showDays);
    const all = this.jobs.open(panel.id);
    const shown = all.filter((v) => v.job.availableFrom === null || v.job.availableFrom <= now + horizon);
    const completed = this.jobs.completed(panel.id);
    let changeAt = Infinity;
    for (const v of all) if (v.job.availableFrom !== null && v.job.availableFrom > now + horizon) changeAt = Math.min(changeAt, v.job.availableFrom - horizon);
    for (const v of completed) if (v.job.completedAt !== null) changeAt = Math.min(changeAt, v.job.completedAt + COMPLETED_SHOW_MS);
    return { now, shown, later: all.length - shown.length, completed, changeAt };
  }

  /** The messages of a panel, in order: the flights that can be reserved (with the buttons), then the completed flights. */
  private render(panel: Panel, l: ReturnType<PanelService['listing']>, avatars: ReadonlyMap<string, Avatar>) {
    // Completed flights show what FsHub recorded for them, where the panel is linked to its airline's FsHub flights.
    const autoCompletes = this.fshubEnabled && panel.fshubAirlineId !== null && panel.fshubConfirm && panel.fshubAutoComplete;
    return renderPanelParts(panel, l.shown, l.now, l.completed, confirmationsFor(this.store, panel, l.completed, l.now), autoCompletes, l.later, avatars, this.etas?.forPanel(panel.id));
  }

  /**
   * The pictures of these people, by Discord ID, for the cards. A person is asked about once and remembered for a few hours; one
   * Discord will not tell us about (or a hiccup) gets the picture Discord gives everyone who has not chosen one, and is asked again soon.
   */
  /** Keep a picture, forgetting the longest-kept ones once there are a great many (an airline with years of pilots must not grow this for ever). */
  private rememberAvatar(id: string, entry: { at: number; avatar: Avatar }): void {
    this.avatarCache.delete(id);
    this.avatarCache.set(id, entry);
    while (this.avatarCache.size > MAX_AVATARS) this.avatarCache.delete(this.avatarCache.keys().next().value as string);
  }

  async avatarsFor(ids: Iterable<string>): Promise<Map<string, Avatar>> {
    const out = new Map<string, Avatar>();
    const now = this.now();
    const queue: string[] = [];
    for (const id of new Set(ids)) {
      const hit = this.avatarCache.get(id);
      if (hit && now - hit.at < AVATAR_FRESH_MS) out.set(id, hit.avatar);
      else queue.push(id);
    }
    const client = this.client;
    if (!client || queue.length === 0) {
      for (const id of queue) out.set(id, this.avatarCache.get(id)?.avatar ?? defaultAvatar(id));
      return out;
    }
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const known = this.avatarCache.get(id);
        try {
          const user = await client.users.fetch(id, { force: known !== undefined });
          const avatar = {
            large: user.displayAvatarURL({ extension: 'png', size: 128, forceStatic: true }),
            small: user.displayAvatarURL({ extension: 'png', size: 32, forceStatic: true }),
          };
          this.rememberAvatar(id, { at: now, avatar });
          out.set(id, avatar);
        } catch (e) {
          const avatar = known?.avatar ?? defaultAvatar(id);
          this.rememberAvatar(id, { at: now - AVATAR_FRESH_MS + 10 * 60_000, avatar }); // ask again in ten minutes
          out.set(id, avatar);
          this.log.debug(`Could not get the picture of ${id}`, e);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    return out;
  }

  /**
   * Redraw the panels whose list has changed only because time passed. Cheap: it looks at one remembered time per panel,
   * and only a panel whose time has come is touched. A panel that has not been drawn since the bot started is left to
   * whatever draws it next (the bot draws every panel at start-up).
   */
  run(): void {
    const now = this.now();
    // Folded messages unfold once nobody has pressed any button on their panel for a while.
    for (const [panelId, f] of this.folds) {
      if (now - f.touchedAt < FOLD_IDLE_MS) continue;
      this.folds.delete(panelId);
      this.schedule(panelId);
    }
    for (const [panelId, at] of this.changeAt) {
      if (now < at) continue;
      this.changeAt.delete(panelId); // the redraw records the next one; a failed redraw is not retried every minute
      this.schedule(panelId);
    }
  }

  /** Redraw a panel, then (without waiting for it) bring the lists people keep in their DMs up to date to match. */
  /** What every redraw since the bot started has asked of Discord: how many there were, how many messages they edited and posted, and how long they took in all (for the test build's report). */
  readonly totals = { redraws: 0, edited: 0, sent: 0, ms: 0 };

  private async redraw(panelId: number): Promise<PanelRefreshResult> {
    // A redraw that was waiting its turn when the bot began to shut down: the database and Discord are about to go, so it draws nothing.
    if (this.stopped) return 'skipped';
    const started = realMs();
    const stats: DrawStats = { messages: 0, edited: 0, sent: 0 };
    const result = await this.redrawPanel(panelId, stats);
    this.totals.redraws++;
    this.totals.edited += stats.edited;
    this.totals.sent += stats.sent;
    this.totals.ms += realMs() - started;
    // Discord answers edits slowly when there are many: worth a line in the log when it took a while, so it can be seen what a slow panel costs.
    if (realMs() - started >= SLOW_REDRAW_MS) this.log.info(`Slow: drawing panel ${panelId} (${result}: ${stats.edited} edited, ${stats.sent} posted, of ${stats.messages} messages) took ${((realMs() - started) / 1000).toFixed(1)} s`);
    if ((result === 'updated' || result === 'posted') && this.store.countFollowers(panelId) > 0) {
      this.refreshFollowers(panelId).catch((e) => {
        if (!this.stopped) this.log.warn(`Could not update the lists kept for panel ${panelId}`, e);
      });
    }
    return result;
  }

  private async redrawPanel(panelId: number, stats: DrawStats = { messages: 0, edited: 0, sent: 0 }): Promise<PanelRefreshResult> {
    const panel = this.store.getPanel(panelId);
    if (!panel) this.changeAt.delete(panelId);
    if (this.forced.delete(panelId) && panel) for (const id of [...panel.messageIds, ...panel.completedMessageIds]) this.shown.delete(id);
    if (!panel || !this.client) return 'skipped';
    try {
      const channel = await this.client.channels.fetch(panel.channelId).catch(() => null);
      if (!channel || !channel.isSendable()) {
        this.log.warn(`Panel channel ${panel.channelId} for ${panel.airlineName} is missing or not writable`);
        return 'no-access';
      }

      const listing = this.listing(panel);
      let open: Payload[];
      let done: Payload[];
      if (panel.layout === 'grid') {
        // A button for each flight (the completed ones too, unless they have a channel of their own, where they are cards as ever).
        const flights: GridFlight[] = [
          ...listing.shown.map((view) => ({ view, state: flightState(view, listing.now, false) })),
          ...(panel.completedChannelId === null ? listing.completed.map((view) => ({ view, state: 'done' as const })) : []),
        ];
        const autoCompletes = this.fshubEnabled && panel.fshubAirlineId !== null && panel.fshubConfirm && panel.fshubAutoComplete;
        const grid = renderGridPanel(panel, flights, listing.now, { autoCompletes, later: listing.later, folded: this.foldsOf(panel.id), dates: panel.gridDates });
        this.gridParts.set(panel.id, grid.parts);
        open = grid.messages.map((m) => ({ embeds: m.embeds, components: m.components, allowedMentions: noPings }));
        done = panel.completedChannelId === null ? [] : this.render(panel, listing, new Map()).completed.map((embeds) => ({ embeds, components: [], allowedMentions: noPings }));
      } else {
        const parts = this.render(panel, listing, await this.avatarsFor(avatarIdsOf(listing.shown)));
        // Each message holds several cards (embeds). The flights that can be reserved carry the buttons on every message, so a
        // long list never makes people scroll to the end to reserve. The completed flights, below them, are only for reading.
        open = parts.open.map((embeds) => ({ embeds, components: panelRows(panel.id), allowedMentions: noPings }));
        done = parts.completed.map((embeds) => ({ embeds, components: [], allowedMentions: noPings }));
      }
      if (DEBUG_BUILD && !permsLogged.has(panel.id) && 'guild' in channel && 'permissionsFor' in channel) {
        permsLogged.add(panel.id);
        const me = channel.guild?.members?.me;
        dbg(this.log, `panel ${panel.id} (${panel.airlineName}) channel ${panel.channelId}: the bot's permissions there are [${me ? (channel.permissionsFor(me)?.toArray().join(', ') ?? 'unknown') : 'unknown'}]`);
      }
      // Where the bot may not attach files (older invites did not ask for it), the stamp is left off rather than the panel not drawn.
      if (!this.canAttachFiles(channel)) {
        if (!this.warnedNoAttach.has(panel.id)) {
          this.warnedNoAttach.add(panel.id);
          this.log.warn(`I can't attach files in the channel of the ${panel.airlineName} panel, so open flights show no OPEN stamp. Give the bot Attach Files there.`);
        }
        for (const p of open) for (const e of p.embeds) if (usesStamp([e])) e.setThumbnail(null);
      } else {
        this.warnedNoAttach.delete(panel.id);
      }

      // With a channel of their own for the completed flights, they are a second set of messages there; otherwise they follow the open flights.
      const split = panel.completedChannelId !== null;
      const result = await this.place(channel, panel.messageIds, split ? open : [...open, ...done], (ids) => this.store.updatePanel(panel.id, { messageIds: ids }), stats);
      if (split) await this.placeCompleted(panel, done);
      this.changeAt.set(panel.id, listing.changeAt);
      return result;
    } catch (e) {
      // Cut short by the bot shutting down (Discord is disconnected, or the database closed under it): not a failure worth a warning.
      if (this.stopped) return 'skipped';
      if (isMissingAccess(e)) {
        if (DEBUG_BUILD) permsLogged.delete(panel.id); // log the permissions again at the next redraw, next to this failure
        dbg(this.log, `panel ${panel.id} redraw hit Missing Permissions; payload had ${this.lastPayloadNote}`);
        this.log.warn(`Missing access posting the panel for ${panel.airlineName} in ${panel.channelId}`, e);
        return 'no-access';
      }
      this.log.warn(`Could not refresh the panel for ${panel.airlineName}`, e);
      return 'failed';
    }
  }

  /**
   * Make a channel show these messages, as the panel's. Edit them in place if every existing message is still there and the
   * count matches; otherwise delete what is there and post them afresh, so the order stays right. `save` is told the IDs of
   * the messages the channel now holds (also when posting stops halfway, so the next redraw clears them away).
   */
  private async place(channel: SendableChannels, ids: string[], payloads: Payload[], save: (ids: string[]) => void, stats: DrawStats = { messages: 0, edited: 0, sent: 0 }): Promise<'updated' | 'posted'> {
    stats.messages += payloads.length;
    // Discord is asked itself (see `lookUpMessages`). Without that discord.js answers from its cache, and the bot
    // is never told when a person deletes a message, so it would "find" panels that are long gone.
    let looked: Awaited<ReturnType<typeof lookUpMessages>> | null = null;
    if ('messages' in channel && ids.length === payloads.length) {
      // One request for the channel's latest messages answers for the whole panel (see `lookUpMessages`), not a round trip to Discord for each message.
      const existing = (looked = await lookUpMessages(channel.messages, ids));
      if (existing.every((m) => m && m.editable)) {
        try {
          for (let i = 0; i < payloads.length; i++) {
            const id = ids[i]!;
            const content = contentOf(payloads[i]!);
            if (this.shown.get(id) === content) continue; // already says exactly this
            if (DEBUG_BUILD) this.lastPayloadNote = `message ${i + 1}/${payloads.length} (edit): ${payloads[i]!.embeds.length} embed(s), ${(forEdit(payloads[i]!) as { files?: unknown[] }).files?.length ?? 0} file(s), attachments=${JSON.stringify((forEdit(payloads[i]!) as { attachments?: unknown[] }).attachments ?? 'untouched')}`;
            await existing[i]!.edit(forEdit(payloads[i]!));
            stats.edited++;
            this.shown.set(id, content);
          }
          return 'updated';
        } catch (e) {
          // Deleted between the check and the edit: fall through and repost.
          if (!isUnknownMessage(e)) throw e;
        }
      }
    }

    // Otherwise start afresh so the messages stay in order. The old ones are looked up with one request and taken away together, not one after another
    // (a panel of fifteen messages that had to be posted again on the day's change took thirty requests, one at a time, before anything new appeared).
    if ('messages' in channel && ids.length > 0) {
      const old = looked ?? (await lookUpMessages(channel.messages, ids));
      await Promise.all(old.map((m) => (m && m.deletable ? m.delete().catch(() => undefined) : undefined)));
    }
    save([]);
    const fresh: string[] = [];
    try {
      for (const payload of payloads) {
        if (DEBUG_BUILD) this.lastPayloadNote = `message ${fresh.length + 1}/${payloads.length} (send): ${payload.embeds.length} embed(s), ${forSend(payload).files.length} file(s)`;
        const sent = await channel.send(forSend(payload));
        stats.sent++;
        fresh.push(sent.id);
        this.shown.set(sent.id, contentOf(payload));
      }
    } finally {
      // Even if posting stops halfway, what was posted is remembered, so the next redraw clears it away.
      save(fresh);
      for (const id of ids) this.shown.delete(id); // the old messages are gone
    }
    return 'posted';
  }

  /** Whether the bot may attach files where it posts (true when that cannot be told). */
  private canAttachFiles(channel: SendableChannels): boolean {
    const me = 'guild' in channel ? channel.guild?.members?.me : null;
    if (!me || !('permissionsFor' in channel)) return true;
    const perms = channel.permissionsFor(me);
    return perms ? perms.has(PermissionFlagsBits.AttachFiles) : true;
  }

  /** Draw the completed flights in their own channel. A problem there is logged and never undoes the panel itself. */
  private async placeCompleted(panel: Panel, payloads: Payload[]): Promise<void> {
    if (!this.client || panel.completedChannelId === null) return;
    try {
      const channel = await this.client.channels.fetch(panel.completedChannelId).catch(() => null);
      if (!channel || !channel.isSendable()) {
        this.log.warn(`The completed-flights channel ${panel.completedChannelId} for ${panel.airlineName} is missing or not writable`);
        return;
      }
      await this.place(channel, panel.completedMessageIds, payloads, (ids) => this.store.updatePanel(panel.id, { completedMessageIds: ids }));
    } catch (e) {
      this.log.warn(`Could not draw the completed flights for ${panel.airlineName}`, e);
    }
  }

  /**
   * Ask the panel's channel for pilots for flights that have none, pinging whoever the panel is set
   * to ping. One message covers every flight listed in `due`.
   */
  async remind(panel: Panel, due: Reminder[]): Promise<ReminderResult> {
    const message = renderReminder(panel, due, this.now());
    if (!message) return 'skipped';
    if (!this.client) return 'failed';
    try {
      const channel = await this.client.channels.fetch(panel.channelId).catch(() => null);
      if (!channel || !channel.isSendable()) {
        this.log.warn(`Panel channel ${panel.channelId} for ${panel.airlineName} is missing or not writable`);
        return 'no-access';
      }
      const sent = await channel.send(message);
      // Remember it, so it can be cleared at 23:59 UTC (unless this panel keeps its announcements).
      if (panel.reminderCleanup) this.store.addReminderMessage(panel.id, panel.channelId, sent.id, this.now());
      return 'sent';
    } catch (e) {
      if (isMissingAccess(e)) {
        this.log.warn(`Missing access announcing unstaffed flights for ${panel.airlineName} in ${panel.channelId}`, e);
        return 'no-access';
      }
      this.log.warn(`Could not announce unstaffed flights for ${panel.airlineName}`, e);
      return 'failed';
    }
  }

  /**
   * Delete the "pilots needed" announcements of a day once it is 23:59 UTC, a minute before the next list is posted at midnight, so the old
   * one is gone before the new one pings. Panels that keep their announcements are skipped (those records are simply forgotten). A message
   * that is already gone, or whose channel is, counts as done; a hiccup is retried on the next pass. Because it asks "posted on a day that is
   * nearly over" rather than "is it 23:59", a bot that was off then catches up when it starts. Returns how many announcements were dealt with.
   */
  async cleanReminders(): Promise<number> {
    if (!this.client) return 0;
    const now = this.now();
    let done = 0;
    for (const m of this.store.listReminderMessagesBefore(startOfUtcDay(now + CLEANUP_BEFORE_MIDNIGHT_MS))) {
      if (!m.cleanup) {
        this.store.deleteReminderMessage(m.messageId);
        continue;
      }
      const gone = await this.removeMessage(m.channelId, m.messageId);
      if (gone || now - m.postedAt > GIVE_UP_AFTER_MS) this.store.deleteReminderMessage(m.messageId);
      if (gone) done++;
    }
    return done;
  }

  /** Delete every announcement still tracked for a panel that is being removed. The caller deletes the panel record. */
  async deleteReminderMessages(panel: Panel): Promise<void> {
    for (const m of this.store.listReminderMessages(panel.id)) {
      if (await this.removeMessage(m.channelId, m.messageId)) this.store.deleteReminderMessage(m.messageId);
    }
  }

  /** True if the message is gone afterwards (deleted now, already gone, or nothing more can be done); false for a hiccup worth retrying. */
  private async removeMessage(channelId: string, messageId: string): Promise<boolean> {
    if (!this.client) return false;
    let channel;
    try {
      channel = await this.client.channels.fetch(channelId);
    } catch (e) {
      // Deleted channel, or one the bot can no longer see: the message is out of reach for good.
      return discordErrorCode(e) === 10003 || isMissingAccess(e);
    }
    if (!channel || !('messages' in channel)) return true;
    try {
      const message = await channel.messages.fetch({ message: messageId, force: true });
      if (message.deletable) await message.delete();
      return true;
    } catch (e) {
      if (isUnknownMessage(e) || isMissingAccess(e)) return true;
      this.log.warn(`Could not delete the announcement ${messageId}`, e);
      return false;
    }
  }

  /** Delete a panel's messages, in its channel and in the completed-flights channel (best effort). The caller deletes the panel record. */
  async deleteMessages(panel: Panel): Promise<void> {
    if (!this.client) return;
    await this.chains.get(panel.id); // let a redraw that is under way finish first, so it cannot post the panel again
    panel = this.store.getPanel(panel.id) ?? panel;
    await this.deleteIn(panel.channelId, panel.messageIds);
    await this.deleteCompletedMessages(panel);
  }

  /** Delete the completed flights' messages in their own channel and forget them. Used before that channel changes, or the flights go back onto the panel. */
  async deleteCompletedMessages(panel: Panel): Promise<void> {
    if (!this.client) return;
    await this.chains.get(panel.id);
    panel = this.store.getPanel(panel.id) ?? panel;
    if (panel.completedChannelId !== null) await this.deleteIn(panel.completedChannelId, panel.completedMessageIds);
    for (const id of panel.completedMessageIds) this.shown.delete(id);
    this.store.updatePanel(panel.id, { completedMessageIds: [] });
  }

  private async deleteIn(channelId: string, messageIds: string[]): Promise<void> {
    if (!this.client || messageIds.length === 0) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !('messages' in channel)) return;
    for (const id of messageIds) {
      const m = await channel.messages.fetch({ message: id, force: true }).catch(() => null);
      if (m && m.deletable) await m.delete().catch(() => undefined);
    }
  }

  /* ------------------------------------------------------------------ lists kept in people's DMs */

  /** The panel as the plain list a pilot keeps in their DMs, as the messages it is made of. */
  private listPayloads(panel: Panel, l: ReturnType<PanelService['listing']>, hideFor: string | null = null): Payload[] {
    const autoCompletes = this.fshubEnabled && panel.fshubAirlineId !== null && panel.fshubConfirm && panel.fshubAutoComplete;
    // Someone who hid the flights that are no longer available to them (`/hideunavailable`) gets a list without the taken and completed ones.
    const shown = hideFor === null ? l.shown : availableFor(l.shown, hideFor);
    const hiding = hideFor === null ? undefined : { taken: l.shown.length - shown.length };
    const parts = renderListParts(
      panel,
      shown,
      l.now,
      hiding ? [] : l.completed,
      hiding ? undefined : confirmationsFor(this.store, panel, l.completed, l.now),
      autoCompletes,
      l.later,
      hiding,
    );
    return [
      ...parts.open.map((embeds) => ({ embeds, components: listRows(panel.id), allowedMentions: noPings })),
      ...parts.completed.map((embeds) => ({ embeds, components: [], allowedMentions: noPings })),
    ];
  }

  /** Run something that changes a panel's lists in people's DMs after whatever is already doing so, never alongside it. */
  private inFollowQueue<T>(panelId: number, task: () => Promise<T>): Promise<T> {
    const after = this.followChains.get(panelId) ?? Promise.resolve();
    const run = after.then(task);
    const done = run.then(
      () => undefined,
      () => undefined,
    );
    this.followChains.set(panelId, done);
    void done.then(() => {
      if (this.followChains.get(panelId) === done) this.followChains.delete(panelId);
    });
    return run;
  }

  /**
   * Bring the list in each follower's DMs up to date with the panel. Updates of one panel's lists never overlap, requests made
   * while one is waiting share it, and two updates start at least `followGapMs` apart, so a busy hour is not a flood of DM edits.
   * (Waiting happens before the update joins the queue, so a person asking for a list is never held up by it.)
   */
  refreshFollowers(panelId: number): Promise<void> {
    const waiting = this.followWaiting.get(panelId);
    if (waiting) return waiting;
    const run = (async () => {
      const wait = this.followGapMs - (appNow() - (this.lastFollowPassAt.get(panelId) ?? 0));
      // Always yield once, even with nothing to wait for, so this run is recorded as waiting before it is taken off the list below.
      await new Promise<void>((resolve) => {
        if (wait > 0 && this.followGapMs > 0) {
          const timer = setTimeout(resolve, wait);
          timer.unref?.();
        } else {
          resolve();
        }
      });
      this.followWaiting.delete(panelId); // from here on, a new request is a new update
      this.lastFollowPassAt.set(panelId, appNow());
      await this.inFollowQueue(panelId, () => this.updateFollowers(panelId));
    })();
    this.followWaiting.set(panelId, run);
    return run;
  }

  /** Resolves when every update of people's lists that is under way or waiting is done (for tests and shutdown). */
  async followersIdle(): Promise<void> {
    while (this.followChains.size > 0 || this.followWaiting.size > 0) {
      await Promise.allSettled([...this.followChains.values(), ...this.followWaiting.values()]);
    }
  }

  private async updateFollowers(panelId: number): Promise<void> {
    if (this.stopped) return;
    const panel = this.store.getPanel(panelId);
    if (!panel || !this.client) return;
    const followers = this.store.listFollowers(panelId);
    if (followers.length === 0) return;
    const listing = this.listing(panel);
    let common: Payload[] | null = null;
    for (const f of followers) {
      if (this.stopped) return; // shutting down: the rest are drawn again when the bot starts
      // Everyone shares one list, except people who hid the flights that are no longer available to them: each has their own.
      const payloads = this.store.getHideUnavailable(f.discordId) ? this.listPayloads(panel, listing, f.discordId) : (common ??= this.listPayloads(panel, listing));
      await this.syncFollower(panel, f, payloads);
    }
  }

  private async syncFollower(panel: Panel, f: PanelFollower, payloads: Payload[]): Promise<void> {
    try {
      if (!(await this.stillEntitled(panel, f.discordId))) {
        this.log.info(`Stopped keeping a list of ${panel.airlineName} for ${f.discordId}: they can no longer see the panel`);
        await this.removeListMessages(f);
        this.store.deleteFollower(panel.id, f.discordId);
        return;
      }
      const dm = await this.dmChannel(f.discordId);
      await this.placeList(dm, f.messageIds, payloads, (ids) => this.store.saveFollower({ ...f, channelId: dm.id, messageIds: ids }));
    } catch (e) {
      if (isDmClosed(e) || discordErrorCode(e) === 10013) {
        // Their DMs are closed to me now, or the account is gone: there is nobody to keep a list for.
        this.log.info(`Stopped keeping a list of ${panel.airlineName} for ${f.discordId}: I can't message them`);
        this.store.deleteFollower(panel.id, f.discordId);
        return;
      }
      this.log.warn(`Could not update the list of ${panel.airlineName} kept for ${f.discordId}`, e);
    }
  }

  private async dmChannel(discordId: string): Promise<DMChannel> {
    if (!this.client) throw new Error('The bot is not connected');
    const user = await this.client.users.fetch(discordId);
    return user.createDM();
  }

  /**
   * Make a DM show these messages, in place. Messages are edited position by position, extra ones are added at the end (quietly: they
   * make no sound) and surplus ones deleted, so a list that grows or shrinks never has to be posted again. Only if one has gone is the
   * whole list posted afresh. `save` is told the IDs of the messages the DM now holds.
   */
  private async placeList(dm: DMChannel, ids: string[], payloads: Payload[], save: (ids: string[]) => void): Promise<void> {
    const keep = Math.min(ids.length, payloads.length);
    // One request for the DM's latest messages answers for the whole list (see `lookUpMessages`), not one after another for each message.
    const existing = await lookUpMessages(dm.messages, ids.slice(0, keep), true);
    if (!existing.every((m) => m && m.editable)) return this.repostList(dm, ids, payloads, save);

    for (let i = 0; i < keep; i++) {
      const content = contentOf(payloads[i]!);
      if (this.shown.get(ids[i]!) === content) continue; // already says exactly this
      try {
        await existing[i]!.edit(payloads[i]!);
        this.shown.set(ids[i]!, content);
      } catch (e) {
        if (!isUnknownMessage(e)) throw e;
        return this.repostList(dm, ids, payloads, save); // deleted between the check and the edit
      }
    }

    const current = ids.slice(0, keep);
    try {
      for (let i = keep; i < payloads.length; i++) {
        const sent = await dm.send({ ...payloads[i]!, flags: MessageFlags.SuppressNotifications });
        current.push(sent.id);
        this.shown.set(sent.id, contentOf(payloads[i]!));
      }
    } finally {
      if (current.length !== ids.length) save(current);
    }
    for (let i = payloads.length; i < ids.length; i++) await this.deleteListMessage(dm, ids[i]!);
  }

  /** Delete what is in the DM and post the whole list again. */
  private async repostList(dm: DMChannel, ids: string[], payloads: Payload[], save: (ids: string[]) => void): Promise<void> {
    for (const id of ids) await this.deleteListMessage(dm, id);
    save([]);
    const fresh: string[] = [];
    try {
      for (const payload of payloads) {
        const sent = await dm.send({ ...payload, flags: MessageFlags.SuppressNotifications });
        fresh.push(sent.id);
        this.shown.set(sent.id, contentOf(payload));
      }
    } finally {
      save(fresh);
    }
  }

  private async deleteListMessage(dm: DMChannel, id: string): Promise<void> {
    this.shown.delete(id);
    const m = await dm.messages.fetch({ message: id, force: true }).catch(() => null);
    if (m && m.deletable) await m.delete().catch(() => undefined);
  }

  /** Delete the list messages someone has (best effort). */
  private async removeListMessages(f: PanelFollower): Promise<void> {
    if (f.messageIds.length === 0) return;
    try {
      const dm = await this.dmChannel(f.discordId);
      for (const id of f.messageIds) await this.deleteListMessage(dm, id);
    } catch (e) {
      this.log.debug(`Could not delete the list kept for ${f.discordId}`, e);
    }
  }

  /**
   * Whether someone is still in the server and can still see the panel's channel. Asked when a list is first sent and then every
   * half hour, so a person who left (or lost access) stops being sent a copy of the panel. A hiccup in asking counts as "yes".
   */
  /** Note when someone was last found to be entitled, forgetting the ones no longer worth remembering (their half hour is long over). */
  private rememberEntitled(key: string): void {
    const now = this.now();
    this.entitledAt.set(key, now);
    if (this.entitledAt.size > MAX_FOLLOWERS * 4) for (const [k, at] of this.entitledAt) if (now - at >= ENTITLED_RECHECK_MS) this.entitledAt.delete(k);
  }

  private async stillEntitled(panel: Panel, discordId: string): Promise<boolean> {
    if (!this.client) return true;
    const key = `${panel.id}:${discordId}`;
    const last = this.entitledAt.get(key);
    if (last !== undefined && this.now() - last < ENTITLED_RECHECK_MS) return true;
    try {
      const guild = await this.client.guilds.fetch(panel.guildId);
      const member = await guild.members.fetch({ user: discordId, force: true }); // not the copy held from before: it would never learn they had left or lost the channel
      const channel = await this.client.channels.fetch(panel.channelId).catch(() => null);
      if (channel && 'permissionsFor' in channel) {
        const perms = channel.permissionsFor(member);
        if (perms && !perms.has(PermissionFlagsBits.ViewChannel)) return false;
      }
    } catch (e) {
      const code = discordErrorCode(e);
      if (code === 10007 || code === 10004) return false; // not a member, or the bot is not in the server any more
      this.log.debug(`Could not check whether ${discordId} can still see panel ${panel.id}`, e);
      return true;
    }
    this.rememberEntitled(key);
    return true;
  }

  /**
   * Post someone their own copy of the panel as a plain list in their DMs, and keep it up to date from now on. If they already
   * have one it is replaced by a fresh one at the bottom of the DM.
   */
  follow(panelId: number, user: Pick<User, 'id' | 'createDM'>): Promise<FollowResult> {
    return this.inFollowQueue(panelId, async (): Promise<FollowResult> => {
      const panel = this.store.getPanel(panelId);
      if (!panel) return { ok: false, reason: 'gone' };
      const existing = this.store.getFollower(panelId, user.id);
      if (!existing && this.store.countFollowers(panelId) >= MAX_FOLLOWERS) return { ok: false, reason: 'full' };
      const payloads = this.listPayloads(panel, this.listing(panel), this.store.getHideUnavailable(user.id) ? user.id : null);
      let dm: DMChannel;
      try {
        dm = await user.createDM();
      } catch (e) {
        if (isDmClosed(e)) return { ok: false, reason: 'dm-closed' };
        throw e;
      }
      if (existing) {
        await this.removeListMessages(existing);
        this.store.deleteFollower(panelId, user.id);
      }
      const ids: string[] = [];
      try {
        for (const payload of payloads) {
          const sent = await dm.send({ ...payload, flags: MessageFlags.SuppressNotifications });
          ids.push(sent.id);
          this.shown.set(sent.id, contentOf(payload));
        }
      } catch (e) {
        // What was sent is remembered, so the next update carries on from it (or clears it away).
        if (ids.length > 0) this.store.saveFollower({ panelId, discordId: user.id, channelId: dm.id, messageIds: ids, createdAt: this.now() });
        if (isDmClosed(e)) return { ok: false, reason: 'dm-closed' };
        throw e;
      }
      this.store.saveFollower({ panelId, discordId: user.id, channelId: dm.id, messageIds: ids, createdAt: this.now() });
      this.rememberEntitled(`${panelId}:${user.id}`);
      return { ok: true, channelId: dm.id };
    });
  }

  /** Stop keeping someone's list up to date and take it out of their DMs. False if they had none. */
  unfollow(panelId: number, discordId: string): Promise<boolean> {
    return this.inFollowQueue(panelId, async () => {
      const f = this.store.getFollower(panelId, discordId);
      if (!f) return false;
      await this.removeListMessages(f);
      this.store.deleteFollower(panelId, discordId);
      return true;
    });
  }

  /** Take every list of a panel out of people's DMs (it is being removed). The caller deletes the panel record, which forgets them. */
  async deleteListMessages(panel: Panel): Promise<void> {
    await this.followChains.get(panel.id);
    for (const f of this.store.listFollowers(panel.id)) await this.removeListMessages(f);
  }

  private stopped = false;

  /** Shutting down: nothing new is drawn (what was asked for but not yet drawn is dropped; the panels are drawn again when the bot starts). */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Resolves once the redraws that are under way have finished, or after `ms`, whichever is first (for a tidy shutdown). */
  async drain(ms: number): Promise<void> {
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());
    await Promise.race([Promise.all([...this.chains.values()]).then(() => undefined), timeout]);
  }
}
