import { Events, MessageFlags, type Client, type Interaction } from 'discord.js';
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
    } catch (e) {
      await reportError(interaction, ctx.log, describeError(e, ctx.log));
    }
  }
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
