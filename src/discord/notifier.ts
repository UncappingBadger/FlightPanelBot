import type { Client } from 'discord.js';
import { dbg } from '../util/debugBuild.js';
import type { Logger } from '../util/log.js';
import type { JobEvent, JobEvents, ReleasedNotice } from '../services/events.js';
import { legList, truncate } from '../util/format.js';
import type { PanelService } from './panel.js';
import type { AutoCompleted } from '../services/autoComplete.js';
import { autoCompletedMessage, backupTookOverMessage, noPings } from './ui.js';
import { appNow } from '../util/clock.js';

const REASON: Record<ReleasedNotice['reason'], string> = {
  removed: 'is no longer listed, so your reservation was released',
  changed: 'changed (different route), so your reservation was released. Check the panel and reserve again if you still want it',
  admin: 'was released by a server admin',
};

/** A server's members are listed this many at a time, and at most this many times (so a very large server is not read in full). */
const MEMBERS_PER_PAGE = 1000;
const MEMBER_PAGES = 10;
/** The most people one message to a role's members goes to. */
const MAX_RECIPIENTS = 25;
/** A list of a role's members is kept this long, so a run of messages to the same managers reads the server once. */
const MANAGERS_KEPT_MS = 10 * 60_000;
/** A list that could not be read is only kept this long, so a hiccup (or the intent being switched on) is not remembered for ten minutes. */
const UNREADABLE_KEPT_MS = 60_000;

/**
 * Who a message to an airline's managers goes to, and how that was found. `found` is how many members hold one of the roles, and `readable` is
 * false when the server's member list could not be read (so `found` is 0 whatever the roles). With nobody found, `ids` is the server's owner.
 */
export interface ManagerCheck {
  ids: string[];
  found: number;
  readable: boolean;
}

/** Redraws panels when jobs change, and tells people when a reservation of theirs is taken away. */
export class Notifier {
  private readonly managerCache = new Map<string, { at: number; check: ManagerCheck }>();

  constructor(
    private readonly client: Client,
    private readonly panels: PanelService,
    private readonly log: Logger,
  ) {}

  subscribe(events: JobEvents): () => void {
    return events.subscribe((e) => this.handle(e));
  }

  /** Tell a pilot their flights were completed from FsHub. Best effort: closed DMs only mean they are not told. */
  async autoCompleted(discordId: string, done: AutoCompleted[]): Promise<void> {
    if (done.length === 0) return;
    try {
      const user = await this.client.users.fetch(discordId);
      await user.send({ content: autoCompletedMessage(done), allowedMentions: noPings });
    } catch (e) {
      this.log.debug(`Could not tell ${discordId} about flights completed from FsHub`, e);
    }
  }

  /** Tell the pilot who held a flight that it was completed for its backup instead. Best effort, and never switched off (it is about their own reservation). */
  async backupTookOver(done: AutoCompleted): Promise<void> {
    if (!done.replaced) return;
    try {
      const user = await this.client.users.fetch(done.replaced.discordId);
      await user.send({ content: backupTookOverMessage(done), allowedMentions: noPings });
    } catch (e) {
      this.log.debug(`Could not tell ${done.replaced.discordId} that ${done.view.job.code} was completed for its backup`, e);
    }
  }

  /**
   * Is this person in any server the bot is in? Discord only lets a bot message someone it shares a server with. A look-up that fails
   * for any other reason says nothing either way, so it counts as yes (the message is then simply tried).
   */
  async sharesServerWith(discordId: string): Promise<boolean> {
    let unsure = false;
    for (const guild of this.client.guilds.cache.values()) {
      try {
        await guild.members.fetch(discordId);
        return true;
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        if (code === 10007 || code === 10013) continue; // Unknown Member / Unknown User: not in this one
        unsure = true;
      }
    }
    return unsure;
  }

  /** A person's Discord name (the name they show, or their username), or null when it can't be found. */
  async nameOf(discordId: string): Promise<string | null> {
    try {
      const user = await this.client.users.fetch(discordId);
      return user.globalName ?? user.username;
    } catch (e) {
      this.log.debug(`Could not look up the name of ${discordId}`, e);
      return null;
    }
  }

  /**
   * The people a message to an airline's managers goes to: the members of these roles. Discord only lets a bot list a server's members when "Server
   * Members Intent" is switched on for it in the Developer Portal (the bot does not ask for the intent itself, so it connects either way). When the list
   * cannot be read, or nobody in it has a role, or no role is set, the message goes to the server's owner instead, so a report is never lost.
   */
  async managerIds(guildId: string, roleIds: string[]): Promise<string[]> {
    return (await this.managerCheck(guildId, roleIds)).ids;
  }

  /** `managerIds` with how the people were found, so a screen can say who a report reaches and whether the roles could be looked up. */
  async managerCheck(guildId: string, roleIds: string[]): Promise<ManagerCheck> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return { ids: [], found: 0, readable: true };
    const key = `${guildId}:${[...roleIds].sort().join(',')}`;
    const kept = this.managerCache.get(key);
    if (kept && appNow() - kept.at < (kept.check.readable ? MANAGERS_KEPT_MS : UNREADABLE_KEPT_MS)) return kept.check;
    const ids = new Set<string>();
    let readable = true;
    if (roleIds.length > 0) {
      try {
        let after: string | undefined;
        for (let page = 0; page < MEMBER_PAGES; page++) {
          const members = await guild.members.list({ limit: MEMBERS_PER_PAGE, ...(after ? { after } : {}) });
          for (const m of members.values()) if (!m.user.bot && roleIds.some((r) => m.roles.cache.has(r))) ids.add(m.id);
          if (members.size < MEMBERS_PER_PAGE) break;
          after = members.lastKey();
        }
      } catch (e) {
        readable = false;
        this.log.warn(`Could not list the members of server ${guildId} to find its managers (switch on "Server Members Intent" for the bot in the Discord Developer Portal)`, e);
      }
    }
    const found = ids.size;
    if (found === 0 && guild.ownerId) ids.add(guild.ownerId);
    const check: ManagerCheck = { ids: [...ids].slice(0, MAX_RECIPIENTS), found, readable };
    this.managerCache.set(key, { at: appNow(), check });
    return check;
  }

  /** Send a person a private message. True if it went out, false if they could not be reached (closed DMs, an unknown user). */
  async dm(discordId: string, content: string): Promise<boolean> {
    try {
      const user = await this.client.users.fetch(discordId);
      await user.send({ content: truncate(content, 1990), allowedMentions: noPings });
      return true;
    } catch (e) {
      this.log.debug(`Could not send ${discordId} a private message`, e);
      return false;
    }
  }

  async handle(event: JobEvent): Promise<void> {
    if (event.type === 'changed') {
      this.panels.schedule(event.panelId);
      return;
    }
    if (event.type === 'backup-ended') {
      // A backup whose flight has nobody flying it any more (or is gone) is told, so they can take it themselves if they want it.
      const b = event.notice;
      if (b.reason === 'stood-down') return; // they did it themselves

      try {
        const user = await this.client.users.fetch(b.discordId);
        await user.send({
          content:
            b.reason === 'removed'
              ? `Heads up: flight **${b.jobCode}**, which you were down as backup for, is no longer listed, so your backup spot has ended.`
              : `Heads up: nobody is flying **${b.jobCode}** any more, and you were down as its backup. Your backup spot has ended, and the flight is open again: press **Reserve** on the panel if you want it.`,
          allowedMentions: noPings,
        });
      } catch (e) {
        this.log.debug(`Could not tell ${b.discordId} that a backup spot ended`, e);
      dbg(this.log, `backup-ended notice NOT DELIVERED to ${b.discordId}: ${b.jobCode} - ${e instanceof Error ? e.message : e}`);
      }
      return;
    }
    const n = event.notice;
    try {
      const user = await this.client.users.fetch(n.discordId);
      const legs = n.legNos.length === 1 ? `leg ${n.legNos[0]}` : `legs ${legList(n.legNos)}`;
      await user.send({ content: `Heads up: flight **${n.jobCode}** (${legs}) ${REASON[n.reason]}.`, allowedMentions: noPings });
      dbg(this.log, `release notice DELIVERED to ${n.discordId}: ${n.jobCode} ${legs} (${n.reason})`);
    } catch (e) {
      // Closed DMs or an unknown user; the panel is already right, so this is only a courtesy.
      this.log.debug(`Could not tell ${n.discordId} about a released reservation`, e);
      dbg(this.log, `release notice NOT DELIVERED to ${n.discordId}: ${n.jobCode} (${n.reason}) - ${e instanceof Error ? e.message : e}`);
    }
  }
}
