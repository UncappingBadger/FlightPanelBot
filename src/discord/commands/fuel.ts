import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { AeroDaqError, normalizeIcao } from '../../aerodaq/client.js';
import { renderFuel } from '../aerodaqUi.js';
import type { Command } from '../context.js';
import { UserError } from '../errors.js';
import { noPings } from '../ui.js';

/** One person can look up an airport this often, so a busy channel cannot flood AeroDAQ through the bot. */
export const FUEL_COOLDOWN_MS = 3_000;
const lastUse = new Map<string, number>();

export const fuelCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('fuel')
    .setDescription('Look up fuel prices at an airport (AeroDAQ, in-game prices)')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('airport').setDescription('The airport\'s ICAO code, for example EGLL').setRequired(true).setMinLength(3).setMaxLength(4))
    .addBooleanOption((o) => o.setName('share').setDescription('Show the answer to everyone in the channel (default: only you see it)')),

  async execute(ctx, interaction) {
    // Private unless the person asked to share it. (A shared lookup that fails says so in the channel too.)
    const share = interaction.options.getBoolean('share') ?? false;
    await interaction.deferReply(share ? {} : { flags: MessageFlags.Ephemeral });

    const icao = normalizeIcao(interaction.options.getString('airport', true));
    if (!icao) throw new UserError('Give an airport\'s ICAO code: three or four letters or digits, like `EGLL` or `KJFK`.');

    const now = ctx.now();
    const last = lastUse.get(interaction.user.id);
    if (last !== undefined && now - last < FUEL_COOLDOWN_MS) throw new UserError('One moment, then ask again.');
    lastUse.set(interaction.user.id, now);
    if (lastUse.size > 5000) for (const [k, t] of lastUse) if (now - t > FUEL_COOLDOWN_MS) lastUse.delete(k);

    let fuel;
    try {
      fuel = await ctx.aerodaq.fuel(icao);
    } catch (e) {
      if (e instanceof AeroDaqError) throw new UserError(e.message);
      throw e;
    }
    if (!fuel) throw new UserError(`AeroDAQ doesn't list fuel prices for **${icao}**. Check the ICAO code (for example \`EGLL\`, not \`LHR\`).`);

    await interaction.editReply({ embeds: [renderFuel(fuel)], allowedMentions: noPings });
  },
};
