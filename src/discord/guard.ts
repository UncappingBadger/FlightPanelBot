import { PermissionFlagsBits, type Interaction } from 'discord.js';
import { UserError } from './errors.js';

/** Has Manage Server in the guild where the interaction happened. */
export function isAdmin(interaction: Interaction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

export function requireGuild(interaction: Interaction): string {
  if (!interaction.guildId) throw new UserError('This only works inside a server.');
  return interaction.guildId;
}

/**
 * Does the person who pressed a button have this role? Server admins always count, since they can
 * give themselves any role anyway. Works with discord.js members and with raw API members.
 */
export function memberHasRole(interaction: Interaction, roleId: string): boolean {
  if (isAdmin(interaction)) return true;
  const roles = (interaction.member as { roles?: unknown } | null)?.roles;
  if (Array.isArray(roles)) return roles.includes(roleId);
  const cache = (roles as { cache?: { has(id: string): boolean } } | undefined)?.cache;
  return cache ? cache.has(roleId) : false;
}

/** Does the person have at least one of these roles? (No shortcut for admins: ask `isAdmin` for that.) */
export function memberHasAnyRole(interaction: Interaction, roleIds: string[]): boolean {
  if (roleIds.length === 0) return false;
  const roles = (interaction.member as { roles?: unknown } | null)?.roles;
  if (Array.isArray(roles)) return roleIds.some((id) => roles.includes(id));
  const cache = (roles as { cache?: { has(id: string): boolean } } | undefined)?.cache;
  return cache ? roleIds.some((id) => cache.has(id)) : false;
}

/**
 * Admin-only gate. Discord lets server owners change who can see a command, so the permission is
 * checked here for real rather than trusting the command's default visibility.
 */
export function requireAdmin(interaction: Interaction): string {
  const guildId = requireGuild(interaction);
  if (!isAdmin(interaction)) throw new UserError('Only server admins (with the **Manage Server** permission) can do that.');
  return guildId;
}
