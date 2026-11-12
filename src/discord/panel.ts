import type { Client } from 'discord.js';
import type { Panel, Store } from '../db/store.js';
import { silentLogger, type Logger } from '../util/log.js';
import type { JobService } from '../services/jobs.js';
import type { Reminder } from '../services/reminders.js';
import { discordErrorCode, isMissingAccess, isUnknownMessage } from './errors.js';
import { noPings, panelButtons, renderPanel, renderReminder } from './ui.js';

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
      void this.refresh(panelId);
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(panelId, timer);
  }

  async refresh(panelId: number): Promise<PanelRefreshResult> {
    const panel = this.store.getPanel(panelId);
    if (!panel || !this.client) return 'skipped';
    try {
      const channel = await this.client.channels.fetch(panel.channelId).catch(() => null);
      if (!channel || !channel.isSendable()) {
        this.log.warn(`Panel channel ${panel.channelId} for ${panel.airlineName} is missing or not writable`);
        return 'no-access';
      }

      const embeds = renderPanel(panel, this.jobs.open(panel.id), this.now(), this.jobs.completed(panel.id));
      // Every message carries the buttons, so a long panel never makes people scroll to the end to reserve.
      const payloadFor = (i: number) => ({
        embeds: [embeds[i]!],
        components: [panelButtons(panel.id)],
        allowedMentions: noPings,
      });

      // `force: true` asks Discord itself. Without it discord.js answers from its cache, and the bot
      // is never told when a person deletes a message, so it would "find" panels that are long gone.
      const lookup = (id: string) =>
        'messages' in channel ? channel.messages.fetch({ message: id, force: true }).catch(() => null) : Promise.resolve(null);

      // Edit in place if every existing message is still there and the count matches.
      if ('messages' in channel && panel.messageIds.length === embeds.length) {
        const existing = [];
        for (const id of panel.messageIds) existing.push(await lookup(id));
        if (existing.every((m) => m && m.editable)) {
          try {
            for (let i = 0; i < embeds.length; i++) await existing[i]!.edit(payloadFor(i));
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
      const ids: string[] = [];
      for (let i = 0; i < embeds.length; i++) ids.push((await channel.send(payloadFor(i))).id);
      this.store.updatePanel(panel.id, { messageIds: ids });
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
