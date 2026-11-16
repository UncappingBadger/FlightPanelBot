import { EmbedBuilder } from 'discord.js';
import { CATEGORY_WORDS, type DecodedMetar, type FlightCategory } from '../services/metar.js';
import { truncate, ts } from '../util/format.js';
import { COLORS } from './ui.js';

/** Shown under every weather report: these are simulation weather reports, read by a hobby bot. */
export const METAR_FOOTER = 'Unofficial companion bot, not affiliated with VATSIM · for flight simulation only, not for real-world flying';

const CATEGORY_COLOR: Record<FlightCategory, number> = { VFR: 0x2ecc71, MVFR: 0x3498db, IFR: 0xe74c3c, LIFR: 0x9b59b6 };

/** Text for inside a code block: nothing in it can end the block. */
const code = (s: string): string => s.replace(/`/g, "'");

/**
 * One decoded METAR as a card: a plain-language summary first, then a box for each part of the report (wind, visibility, weather,
 * clouds, temperature, pressure, anything else, what to expect), then the report exactly as it was written.
 */
export function metarEmbed(d: DecodedMetar, source: 'vatsim' | 'pasted'): EmbedBuilder {
  const where = d.station ? `Weather at ${d.station}` : 'Weather report';
  const e = new EmbedBuilder()
    .setColor(d.category ? CATEGORY_COLOR[d.category] : COLORS.panel)
    .setTitle(truncate(`🌦️ ${where}`, 256))
    .setFooter({ text: METAR_FOOTER });

  if (d.nil) return e.setDescription(truncate(`${d.summary}\n\n**The report as sent**\n\`${code(d.raw)}\``, 4000));

  const observed = d.observedAt === null ? `Observed ${d.when}.` : `Observed ${ts(d.observedAt, 'f')} (${ts(d.observedAt, 'R')}).`;
  e.setDescription(truncate(`**In short:** ${d.summary}\n${observed}${source === 'vatsim' ? ' Fetched from VATSIM.' : ''}`, 1500));

  const fields = d.sections
    .filter((s) => s.title !== 'The report')
    .map((s) => ({ name: s.title, value: truncate(s.lines.join('\n'), 1000), inline: false }));
  const notes: string[] = [];
  if (d.kind === 'SPECI') notes.push('A special report, issued because the weather changed (not the routine hourly one).');
  if (d.auto) notes.push('Made automatically, with nobody watching the weather.');
  if (d.corrected) notes.push('A corrected report.');
  if (notes.length > 0) fields.unshift({ name: 'About this report', value: notes.join('\n'), inline: false });

  if (d.category) {
    const regional = d.usStyleRating
      ? 'These ratings are in everyday use in the US and Canada.'
      : 'These names come from the US. Most countries do not use them, so treat this as a rough guide.';
    fields.push({ name: `Flying conditions: ${d.category} (US-style rating)`, value: truncate(`${CATEGORY_WORDS[d.category]}.\n${regional}`, 1000), inline: false });
  }

  const unread = [...d.unread, ...d.remarksUnread];
  if (unread.length > 0) {
    fields.push({
      name: "Left as written",
      value: truncate(`I couldn't translate: ${unread.slice(0, 20).map((u) => `\`${code(u)}\``).join(' ')}${unread.length > 20 ? ' …' : ''}\nRemarks differ from country to country, so some stay as the airport wrote them.`, 1000),
      inline: false,
    });
  }
  fields.push({ name: 'The report as written', value: `\`\`\`\n${code(truncate(d.raw, 900))}\n\`\`\``, inline: false });
  return e.addFields(fields.slice(0, 25));
}
