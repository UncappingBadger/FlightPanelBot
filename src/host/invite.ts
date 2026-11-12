/**
 * Permissions the bot asks for when it is added to a server: View Channel, Send Messages, Embed Links,
 * Read Message History, and Mention Everyone (only so the 24-hour reminder can actually ping people).
 */
export const INVITE_PERMISSIONS = 216064;

/** The link that adds a host's own bot to a server, with command access. */
export function inviteUrl(clientId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}`;
}
