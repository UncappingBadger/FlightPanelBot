import { Events, MessageFlags, type Client, type Interaction } from 'discord.js';
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
    void handleDmMessage(ctx, message).catch((e) => ctx.log.error('DM handling failed', e));
  });

  async function dispatch(interaction: Interaction): Promise<void> {
    const started = Date.now();
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
      if (DEBUG_BUILD && !interaction.isAutocomplete()) dbg(ctx.log, `interaction OK (${Date.now() - started} ms): ${interaction.isChatInputCommand() ? `/${interaction.commandName}` : interaction.isMessageComponent() || interaction.isModalSubmit() ? interaction.customId.split(':')[0] : interaction.type}`);
    } catch (e) {
      if (DEBUG_BUILD && !interaction.isAutocomplete()) dbg(ctx.log, `interaction REFUSED/FAILED (${Date.now() - started} ms): ${e instanceof Error ? `${e.name}: ${e.message}` : e}`);
      await reportError(interaction, ctx.log, describeError(e, ctx.log));
    }
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
