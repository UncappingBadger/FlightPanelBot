import type { Client } from 'discord.js';
import type { Panel, Store } from '../db/store.js';
import { silentLogger, type Logger } from '../util/log.js';
import { confirmationsFor } from '../services/flightMatch.js';
import { COMPLETED_SHOW_MS, panelHorizonMs, type JobService } from '../services/jobs.js';
import type { Reminder } from '../services/reminders.js';
import { discordErrorCode, isMissingAccess, isUnknownMessage } from './errors.js';
import { noPings, panelButtons, renderPanelParts, renderReminder } from './ui.js';

/**
 * - `updated`: edited the existing messages in place
 * - `posted`: (re)posted the panel
 * - `no-access`: the channel is gone or the bot can't see or write in it
 * - `failed`: something else went wrong (details are in the log)
 */
export type PanelRefreshResult = 'updated' | 'posted' | 'skipped' | 'no-access' | 'failed';

const DAY_MS = 86_400_000;

/**
 * The start of the UTC day that `ms` falls in. The "pilots needed" announcements are deleted at this
 * "midnight": UTC because every flight time here is Zulu, whatever timezone the host's PC is set to.
 */
export function startOfUtcDay(ms: number): number {
  return ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS);
}

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

  constructor(
    private readonly store: Store,
    private readonly jobs: JobService,
    private readonly log: Logger = silentLogger,
    private readonly now: () => number = Date.now,
    private readonly debounceMs = 1500,
  ) {}

  attach(client: Client): void {
    this.client = client;
  }

  /** Request a redraw; a burst of changes inside the debounce window becomes one edit. */
  schedule(panelId: number): void {
    if (this.timers.has(panelId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(panelId);
      this.refresh(panelId).catch((e) => this.log.warn(`Could not refresh panel ${panelId}`, e));
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
  private render(panel: Panel, l: ReturnType<PanelService['listing']>) {
    // Completed flights show what FsHub recorded for them, where the panel is linked to its airline's FsHub flights.
    const autoCompletes = this.fshubEnabled && panel.fshubAirlineId !== null && panel.fshubConfirm && panel.fshubAutoComplete;
    return renderPanelParts(panel, l.shown, l.now, l.completed, confirmationsFor(this.store, panel, l.completed, l.now), autoCompletes, l.later);
  }

  /**
   * Redraw the panels whose list has changed only because time passed. Cheap: it looks at one remembered time per panel,
   * and only a panel whose time has come is touched. A panel that has not been drawn since the bot started is left to
   * whatever draws it next (the bot draws every panel at start-up).
   */
  run(): void {
    const now = this.now();
    for (const [panelId, at] of this.changeAt) {
      if (now < at) continue;
      this.changeAt.delete(panelId); // the redraw records the next one; a failed redraw is not retried every minute
      this.schedule(panelId);
    }
  }

  private async redraw(panelId: number): Promise<PanelRefreshResult> {
    const panel = this.store.getPanel(panelId);
    if (!panel) this.changeAt.delete(panelId);
    if (this.forced.delete(panelId) && panel) for (const id of panel.messageIds) this.shown.delete(id);
    if (!panel || !this.client) return 'skipped';
    try {
      const channel = await this.client.channels.fetch(panel.channelId).catch(() => null);
      if (!channel || !channel.isSendable()) {
        this.log.warn(`Panel channel ${panel.channelId} for ${panel.airlineName} is missing or not writable`);
        return 'no-access';
      }

      const listing = this.listing(panel);
      const parts = this.render(panel, listing);
      // Each message holds several cards (embeds). The flights that can be reserved carry the buttons on every message, so a
      // long list never makes people scroll to the end to reserve. The completed flights, below them, are only for reading.
      const messages = [...parts.open, ...parts.completed];
      const payloadFor = (i: number) => ({
        embeds: messages[i]!,
        components: i < parts.open.length ? [panelButtons(panel.id)] : [],
        allowedMentions: noPings,
      });
      /** What a message was last made to say, so an edit that would change nothing is not sent (a long panel is many messages). */
      const contentOf = (i: number) => JSON.stringify([messages[i]!.map((e) => e.toJSON()), payloadFor(i).components.map((c) => c.toJSON())]);

      // `force: true` asks Discord itself. Without it discord.js answers from its cache, and the bot
      // is never told when a person deletes a message, so it would "find" panels that are long gone.
      const lookup = (id: string) =>
        'messages' in channel ? channel.messages.fetch({ message: id, force: true }).catch(() => null) : Promise.resolve(null);

      // Edit in place if every existing message is still there and the count matches.
      if ('messages' in channel && panel.messageIds.length === messages.length) {
        const existing = [];
        for (const id of panel.messageIds) existing.push(await lookup(id));
        if (existing.every((m) => m && m.editable)) {
          try {
            for (let i = 0; i < messages.length; i++) {
              const id = panel.messageIds[i]!;
              const content = contentOf(i);
              if (this.shown.get(id) === content) continue; // already says exactly this
              await existing[i]!.edit(payloadFor(i));
              this.shown.set(id, content);
            }
            this.changeAt.set(panel.id, listing.changeAt);
            return 'updated';
          } catch (e) {
            // Deleted between the check and the edit: fall through and repost.
            if (!isUnknownMessage(e)) throw e;
          }
        }
      }

      // Otherwise start the panel afresh so the messages stay in order.
      for (const id of panel.messageIds) {
        const m = await lookup(id);
        if (m && m.deletable) await m.delete().catch(() => undefined);
      }
      this.store.updatePanel(panel.id, { messageIds: [] });
      const ids: string[] = [];
      try {
        for (let i = 0; i < messages.length; i++) {
          const sent = await channel.send(payloadFor(i));
          ids.push(sent.id);
          this.shown.set(sent.id, contentOf(i));
        }
      } finally {
        // Even if posting stops halfway, what was posted is remembered, so the next redraw clears it away.
        this.store.updatePanel(panel.id, { messageIds: ids });
        for (const id of panel.messageIds) this.shown.delete(id); // the old messages are gone
      }
      this.changeAt.set(panel.id, listing.changeAt);
      return 'posted';
    } catch (e) {
      if (isMissingAccess(e)) {
        this.log.warn(`Missing access posting the panel for ${panel.airlineName} in ${panel.channelId}`, e);
        return 'no-access';
      }
      this.log.warn(`Could not refresh the panel for ${panel.airlineName}`, e);
      return 'failed';
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
      // Remember it, so it can be cleared at midnight (unless this panel keeps its announcements).
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
   * Delete the "pilots needed" announcements posted before the start of today (UTC): the midnight tidy-up.
   * Panels that keep their announcements are skipped (those records are simply forgotten). A message that is
   * already gone, or whose channel is, counts as done; a hiccup is retried on the next pass. Because it asks
   * "posted before today" rather than "is it midnight", a bot that was off at midnight catches up when it starts.
   * Returns how many announcements were dealt with.
   */
  async cleanReminders(): Promise<number> {
    if (!this.client) return 0;
    const now = this.now();
    let done = 0;
    for (const m of this.store.listReminderMessagesBefore(startOfUtcDay(now))) {
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

  /** Delete a panel's messages (best effort). The caller deletes the panel record. */
  async deleteMessages(panel: Panel): Promise<void> {
    if (!this.client) return;
    await this.chains.get(panel.id); // let a redraw that is under way finish first, so it cannot post the panel again
    panel = this.store.getPanel(panel.id) ?? panel;
    const channel = await this.client.channels.fetch(panel.channelId).catch(() => null);
    if (!channel || !('messages' in channel)) return;
    for (const id of panel.messageIds) {
      const m = await channel.messages.fetch({ message: id, force: true }).catch(() => null);
      if (m && m.deletable) await m.delete().catch(() => undefined);
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
