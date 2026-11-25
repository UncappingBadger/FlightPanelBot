import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Panel } from '../../db/store.js';
import { callsignCode, type FlightEta, type FlightEtas } from '../../services/flightEtas.js';
import { airlineLabel, plainText, truncate, ts } from '../../util/format.js';
import type { BotContext, Command } from '../context.js';
import { UserError } from '../errors.js';
import { noPings } from '../ui.js';

/** At most this many flights are listed in one answer. */
const MAX_LISTED = 20;

const route = (e: FlightEta): string => `${e.dep} → ${e.arr}${e.legs > 1 ? ` (leg ${e.legNo} of ${e.legs})` : ''}`;
const when = (e: FlightEta): string => `lands about ${ts(e.liveEtaAt, 't')} (${ts(e.liveEtaAt, 'R')})`;
const label = (p: Panel): string => plainText(airlineLabel({ name: p.airlineName, abbr: p.airlineAbbr }));

/** What a flight needs for the bot to follow it, in the airline's own words. */
const needs = (p: Panel): string =>
  `I only follow a flight flown with the airline's own callsign (like \`${callsignCode(p)}123\`) and a flight plan between the flight's airports, once it is in the air. A flight with no flight plan has no landing time to show.`;

/**
 * `/eta`: when the flights of this server's airline that are in the air are expected to land, from FsHub's live feed. Without a flight it
 * lists every one that is in the air; with a flight's ID it answers for that one.
 */
export const etaCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('eta')
    .setDescription("When the airline's flights that are in the air are expected to land")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('flight').setDescription("A flight's ID, for example DMO-004 (leave empty to list every flight in the air)").setMaxLength(20))
    .addBooleanOption((o) => o.setName('share').setDescription('Show the answer to everyone in the channel (default: only you see it)')),

  async execute(ctx, interaction) {
    const share = interaction.options.getBoolean('share') ?? false;
    await interaction.deferReply(share ? {} : { flags: MessageFlags.Ephemeral });

    const panels = interaction.guildId ? ctx.store.listPanels(interaction.guildId) : [];
    if (panels.length === 0) throw new UserError('This server has no flight panel yet.');
    const followed = panels.filter((p) => p.liveTracking);
    if (!ctx.etas || followed.length === 0) {
      throw new UserError("I'm not following flights live here. Whoever runs the bot can switch that on in the **Live tracking** tab of the bot's settings page (tray icon, **Open settings**).");
    }

    const wanted = interaction.options.getString('flight')?.trim() ?? '';
    const text = wanted ? answerFor(ctx, ctx.etas, panels, followed, wanted) : listAll(ctx.etas, followed);
    await interaction.editReply({ content: truncate(text, 1900), allowedMentions: noPings });
  },
};

function listAll(etas: FlightEtas, followed: Panel[]): string {
  const out: string[] = [];
  for (const panel of followed) {
    const flying = etas.airborne(panel.id);
    if (flying.length === 0) {
      out.push(`✈ **${label(panel)}**: no flight is in the air that I can follow right now. ${needs(panel)}`);
      continue;
    }
    out.push(`✈ **${label(panel)}**: ${flying.length} flight${flying.length === 1 ? '' : 's'} in the air`);
    for (const e of flying.slice(0, MAX_LISTED)) out.push(`• **${plainText(e.code)}** ${route(e)}: ${when(e)}`);
    if (flying.length > MAX_LISTED) out.push(`…and ${flying.length - MAX_LISTED} more.`);
  }
  return out.join('\n');
}

function answerFor(ctx: BotContext, etas: FlightEtas, panels: Panel[], followed: Panel[], wanted: string): string {
  let known: { panel: Panel; code: string } | null = null;
  // A flight number flown on more than one day is not one flight: it is said, with the IDs that are, rather than called unknown.
  let several: string[] = [];
  for (const panel of panels) {
    const view = ctx.jobs.findByCode(panel, wanted);
    if (!view) {
      if (several.length === 0) several = ctx.jobs.datedChoices(panel, wanted).map((v) => v.job.code);
      continue;
    }
    const hit = followed.includes(panel) ? etas.forPanel(panel.id).get(view.job.id) : undefined;
    if (hit) return `✈ **${plainText(hit.code)}** ${route(hit)} is in the air: ${when(hit)}. (From FsHub's live tracking of ${plainText(hit.callsign)}.)`;
    known ??= { panel, code: view.job.code };
  }
  if (known) return `**${plainText(known.code)}** is not in the air as far as I can tell. ${followed.includes(known.panel) ? needs(known.panel) : "This panel isn't following flights live."}`;
  if (several.length > 0) {
    return `**${plainText(truncate(wanted, 30))}** is flown on more than one day: ${several.slice(0, 8).map((c) => `\`${plainText(c)}\``).join(', ')}${several.length > 8 ? ' …' : ''}. Ask about one of them, like \`/eta flight:${plainText(several[0]!)}\`.`;
  }
  return `I don't know an open flight called **${plainText(truncate(wanted, 30))}** on this server's panels.`;
}
