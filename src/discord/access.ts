import { PermissionFlagsBits, type Client } from 'discord.js';
import type { Panel } from '../db/store.js';

/**
 * Looking someone up as a member of a server, from somewhere that is not that server (a DM). A button pressed on a panel shows who pressed it
 * and what roles they hold; a message in a DM shows nothing of the kind, so it is asked of Discord. Asking for one member by ID needs no
 * privileged intent, and is what the bot already does for people it messages.
 *
 * It is always asked of Discord (`force`). Without the members intent the bot is never told when someone's roles change or they leave, so a member
 * it was handed earlier (when they last pressed a button, say) goes stale and would be believed for as long as the bot runs.
 */
/** Ask Discord about a member, ignoring the copy the bot may hold. */
export const memberQuery = (userId: string): { user: string; force: true } => ({ user: userId, force: true });


/** What this module needs of a server member, as discord.js gives it (and as tests can fake it). */
export interface MemberLike {
  displayName?: string;
  permissions?: { has(flag: bigint): boolean };
  roles?: { cache?: { has(id: string): boolean } };
}

/** What it needs of a server. */
export interface GuildLike {
  id?: string;
  name?: string;
  roles?: { cache?: { get(id: string): { name?: string } | undefined } };
  members: { fetch(options: { user: string; force: boolean }): Promise<MemberLike> };
}

const codeOf = (e: unknown): unknown => (e as { code?: unknown } | null)?.code;

export type MemberLookup = { ok: true; member: MemberLike; guild: GuildLike } | { ok: false; reason: 'not-member' | 'unsure' };

/**
 * The person as a member of this server. `not-member` is Discord saying so (they are not there, or the bot is not); anything else going wrong
 * (Discord busy, a network hiccup) is `unsure`, which callers treat as "could not check", never as a yes.
 */
export async function lookUpMember(client: Client, guildId: string, userId: string): Promise<MemberLookup> {
  let guild: GuildLike;
  try {
    guild = (client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId))) as unknown as GuildLike;
  } catch (e) {
    return { ok: false, reason: codeOf(e) === 10004 ? 'not-member' : 'unsure' };
  }
  try {
    return { ok: true, member: await guild.members.fetch(memberQuery(userId)), guild };
  } catch (e) {
    const code = codeOf(e);
    return { ok: false, reason: code === 10007 || code === 10013 ? 'not-member' : 'unsure' };
  }
}

/** Does this member hold Manage Server, the permission that makes someone a server admin for the bot? */
export const isAdminMember = (m: MemberLike): boolean => m.permissions?.has(PermissionFlagsBits.ManageGuild) === true;

export type BookingAccess =
  | { ok: true; displayName: string | null }
  | { ok: false; reason: 'not-member' | 'unsure' | 'cannot-see' }
  | { ok: false; reason: 'no-role'; roleName: string | null };

/**
 * Whether someone may reserve (or stand by for) flights on a panel, asked about in a DM. The same three things the Reserve button settles by
 * where it is: they are a member of the panel's server, they hold the role the panel is limited to (server admins always count), and they can
 * see the panel's channel (servers often keep a panel private by hiding its channel, rather than by naming a role). Anything the bot cannot
 * find out is a no.
 */
export async function bookingAccess(client: Client, panel: Panel, userId: string): Promise<BookingAccess> {
  const found = await lookUpMember(client, panel.guildId, userId);
  if (!found.ok) return found;
  const { member, guild } = found;
  if (panel.requiredRoleId && !isAdminMember(member) && member.roles?.cache?.has(panel.requiredRoleId) !== true) {
    return { ok: false, reason: 'no-role', roleName: guild.roles?.cache?.get(panel.requiredRoleId)?.name ?? null };
  }
  try {
    const channel = await client.channels.fetch(panel.channelId);
    if (channel && 'permissionsFor' in channel) {
      const perms = channel.permissionsFor(member as never);
      if (perms && !perms.has(PermissionFlagsBits.ViewChannel)) return { ok: false, reason: 'cannot-see' };
    }
  } catch {
    // The channel cannot be looked at (it is gone, or the bot cannot see it): this check then says nothing, and the others stand.
  }
  return { ok: true, displayName: member.displayName ?? null };
}
