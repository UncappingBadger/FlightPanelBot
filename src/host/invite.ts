/**
 * Permissions the bot asks for when it is added to a server: View Channel, Send Messages, Embed Links,
 * Attach Files (the OPEN stamp on a flight is a picture attached to the panel's messages; without it the panel still
 * works, just without the stamp), Read Message History, and Mention Everyone (only so the 24-hour reminder can actually
 * ping people).
 */
export const INVITE_PERMISSIONS = 248832;

/** The link that adds a host's own bot to a server, with command access. */
export function inviteUrl(clientId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}`;
}
