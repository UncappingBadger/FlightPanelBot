import { Events, MessageFlags, type Client, type Interaction } from 'discord.js';
import { realMs } from '../util/clock.js';
import { DEBUG_BUILD, dbg } from '../util/debugBuild.js';
import type { Logger } from '../util/log.js';
import { componentHandlers, commands } from './commands/index.js';
import type { BotContext } from './context.js';
import { handleDmMessage } from './dm.js';
import { describeError } from './errors.js';
import { noPings } from './ui.js';

export function registerInteractionRouter(client: Client, ctx: BotContext): void {
  const byName = new Map(commands.map((c) => [c.data.name, c]));
  const byPrefix = new Map(componentHandlers.map((h) => [h.prefix, h]));

  client.on(Events.InteractionCreate, (interaction) => {
    void dispatch(interaction).catch((e) => ctx.log.error('Interaction dispatch failed', e));
  });

  // The Reserve conversation happens in DMs: the person replies with a flight ID.
  client.on(Events.MessageCreate, (message) => {
    const started = realMs();
    void whileTyping(message.channel, () => handleDmMessage(ctx, message))
      .catch((e) => ctx.log.error('DM handling failed', e))
      .finally(() => noteIfSlow(ctx.log, 'a message in a DM', realMs() - started));
  });

  async function dispatch(interaction: Interaction): Promise<void> {
    const started = realMs();
    // Nothing is logged for a quick one; a slow one is, with what it was and how long it took (never who asked, or what they typed).
    const done = () => noteIfSlow(ctx.log, interaction.isChatInputCommand() ? `/${interaction.commandName}${interaction.options.getSubcommand(false) ? ` ${interaction.options.getSubcommand(false)}` : ''}` : interaction.isAutocomplete() ? `autocomplete /${interaction.commandName}` : interaction.isMessageComponent() || interaction.isModalSubmit() ? `the ${interaction.customId.split(':')[0]} ${interaction.isModalSubmit() ? 'form' : 'button'}` : `an interaction of type ${interaction.type}`, realMs() - started);
    if (DEBUG_BUILD && !interaction.isAutocomplete()) dbg(ctx.log, `interaction IN: ${describeInteraction(interaction)}`);
    try {
      if (interaction.isChatInputCommand()) {
        const command = byName.get(interaction.commandName);
        if (command) await command.execute(ctx, interaction);
      } else if (interaction.isAutocomplete()) {
        const command = byName.get(interaction.commandName);
        if (command?.autocomplete) await command.autocomplete(ctx, interaction);
      } else if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
        const handler = byPrefix.get(interaction.customId.split(':')[0] ?? '');
        if (handler) await handler.handle(ctx, interaction);
      }
      if (DEBUG_BUILD && !interaction.isAutocomplete()) dbg(ctx.log, `interaction OK (${Math.round(realMs() - started)} ms): ${interaction.isChatInputCommand() ? `/${interaction.commandName}` : interaction.isMessageComponent() || interaction.isModalSubmit() ? interaction.customId.split(':')[0] : interaction.type}`);
    } catch (e) {
      if (DEBUG_BUILD && !interaction.isAutocomplete()) dbg(ctx.log, `interaction REFUSED/FAILED (${Math.round(realMs() - started)} ms): ${e instanceof Error ? `${e.name}: ${e.message}` : e}`);
      await reportError(interaction, ctx.log, describeError(e, ctx.log));
    } finally {
      done();
    }
  }
}

/** Slower than this is worth a line in the log: it is what a person waits for. */
export const SLOW_MS = 2_000;

/** Say in the log that something took a while (and nothing at all when it was quick), so what is slow can be seen from the log, not guessed at. */
export function noteIfSlow(log: Logger, what: string, ms: number, limit = SLOW_MS): void {
  if (ms >= limit) log.info(`Slow: ${what} took ${(ms / 1000).toFixed(1)} s`);
}

/** How long a reply may take before the person sees that the bot is working on it, and how often that is said again (Discord shows it for ten seconds). */
const TYPING_AFTER_MS = 700;
const TYPING_EVERY_MS = 8_000;

/**
 * Run `work` and, if it takes more than a moment, show "the bot is typing" in the channel until it is done: a person who sent a message to the bot
 * in a DM otherwise sees nothing at all while it asks Google, FsHub or Discord. A quick reply never shows it, so it costs no request.
 */
export async function whileTyping<T>(channel: { sendTyping?: () => Promise<unknown> } | null | undefined, work: () => Promise<T>): Promise<T> {
  if (!channel || typeof channel.sendTyping !== 'function') return work();
  const ping = () => void Promise.resolve(channel.sendTyping?.()).catch(() => undefined);
  let every: NodeJS.Timeout | null = null;
  const first = setTimeout(() => {
    ping();
    every = setInterval(ping, TYPING_EVERY_MS);
    every.unref?.();
  }, TYPING_AFTER_MS);
  first.unref?.();
  try {
    return await work();
  } finally {
    clearTimeout(first);
    if (every) clearInterval(every);
  }
}

const SECRETISH = /token|key|secret|password/i;

/** Debug build only: who did what, in one line. Option values that could be secrets are hidden. */
function describeInteraction(interaction: Interaction): string {
  const who = `user ${interaction.user.id} (${interaction.user.username})`;
  const where = interaction.guildId ? `guild ${interaction.guildId}` : 'DM';
  let what: string;
  if (interaction.isChatInputCommand()) {
    const flat = (opts: ReadonlyArray<{ name: string; type: number; value?: unknown; options?: ReadonlyArray<any> }>): string =>
      opts
        .map((o) => (o.options ? `${o.name} ${flat(o.options)}` : `${o.name}:${SECRETISH.test(o.name) ? '(hidden)' : String(o.value).slice(0, 80)}`))
        .join(' ');
    what = `/${interaction.commandName} ${flat(interaction.options.data as any)}`.trim();
  } else if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
    what = `component ${interaction.customId.slice(0, 80)}`;
  } else {
    what = `type ${interaction.type}`;
  }
  const roles = (interaction.member as { roles?: unknown } | null)?.roles;
  const roleIds = Array.isArray(roles) ? roles : (roles as { cache?: { keys(): IterableIterator<string> } } | undefined)?.cache ? [...(roles as { cache: { keys(): IterableIterator<string> } }).cache.keys()] : null;
  const perms = interaction.memberPermissions;
  return `${what} by ${who} in ${where}; manage-server=${perms ? perms.has('ManageGuild') : 'unknown'}; member roles=${roleIds ? `[${roleIds.join(',')}]` : 'not available'}`;
}

async function reportError(interaction: Interaction, log: Logger, text: string): Promise<void> {
  try {
    if (interaction.isAutocomplete()) {
      await interaction.respond([]).catch(() => undefined);
      return;
    }
    if (!interaction.isRepliable()) return;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: `⚠️ ${text}`, embeds: [], components: [], allowedMentions: noPings });
    } else {
      await interaction.reply({ content: `⚠️ ${text}`, flags: MessageFlags.Ephemeral, allowedMentions: noPings });
    }
  } catch (e) {
    // The interaction token may have expired; nothing more we can do for this user.
    log.warn('Could not deliver an error message to the user', e);
  }
}
