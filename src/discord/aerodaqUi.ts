import { EmbedBuilder } from 'discord.js';
import type { AirportFuel, FuelPrice, Stock } from '../aerodaq/client.js';
import { plainText, truncate, ts } from '../util/format.js';
import { COLORS } from './ui.js';

/** Said on everything AeroDAQ-related, so nobody mistakes it for real money or a real exchange. */
export const AERODAQ_FOOTER = 'Data from AeroDAQ (aerodaq.com) · in-game only, not real money or real stocks · Unofficial companion bot';

/** Discord allows ten embeds in a message, and 6000 characters across all of them. */
const MAX_EMBEDS = 10;
const MAX_TOTAL_CHARS = 5800;

/* ------------------------------------------------------------------ fuel */

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };

function money(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
  return symbol ? `${symbol}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${plainText(currency)}`;
}

/** Jet fuel first, since that is what most pilots here want, then avgas, then anything else by name. */
export function sortFuel(prices: FuelPrice[]): FuelPrice[] {
  const rank = (p: FuelPrice) => (p.type === 'J' ? 0 : p.type === 'A' ? 1 : 2);
  return [...prices].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function fuelField(p: FuelPrice) {
  const units = [`**${money(p.perKg, p.currency)}** per kg`];
  if (p.perLb !== null) units.push(`${money(p.perLb, p.currency)}/lb`);
  if (p.perGallon !== null) units.push(`${money(p.perGallon, p.currency)}/US gal`);
  if (p.perLitre !== null) units.push(`${money(p.perLitre, p.currency)}/L`);
  const lines = [units.join(' · ')];

  if (p.baseline !== null && p.baseline > 0) {
    const diff = ((p.perKg - p.baseline) / p.baseline) * 100;
    lines.push(
      Math.abs(diff) < 0.05
        ? `at its usual ${money(p.baseline, p.currency)}`
        : `${diff < 0 ? '▼' : '▲'} ${Math.abs(diff).toFixed(1)}% ${diff < 0 ? 'below' : 'above'} its usual ${money(p.baseline, p.currency)}`,
    );
  }
  const extra: string[] = [];
  if (p.stockPercent !== null) extra.push(`stock ${p.stockPercent.toFixed(1)}% of target`);
  if (p.updatedAt !== null) extra.push(`updated ${ts(p.updatedAt, 'R')}`);
  if (extra.length > 0) lines.push(extra.join(' · '));
  return { name: truncate(plainText(p.name), 256), value: truncate(lines.join('\n'), 1024), inline: false };
}

/** The answer to `/fuel`: one field per kind of fuel the airport sells. */
export function renderFuel(fuel: AirportFuel): EmbedBuilder {
  const where = [fuel.city, fuel.country].filter(Boolean).join(', ');
  const e = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(truncate(`⛽ Fuel at ${fuel.icao}${fuel.name ? ` · ${fuel.name}` : ''}`, 256))
    .setFooter({ text: AERODAQ_FOOTER });
  if (fuel.prices.length === 0) return e.setDescription(`${where ? `${plainText(where)}\n\n` : ''}AeroDAQ has no fuel prices for this airport.`);
  if (where) e.setDescription(plainText(where));
  e.addFields(sortFuel(fuel.prices).slice(0, 10).map(fuelField));
  return e;
}

/* ------------------------------------------------------------------ the market board */

const SECTOR_EMOJI: Record<string, string> = {
  aircraft: '✈️',
  fuel: '⛽',
  airports: '🛬',
  airlines: '🛫',
  cargo: '📦',
  tourism: '🏝️',
  community: '👥',
};

/** Text for inside a code block: nothing in it can end the block or start a line of its own. */
const code = (v: string) => v.replace(/`/g, "'").replace(/[\r\n]+/g, ' ');

/** "+0.02%", "-8.37%", and a plain "0.00%" for anything that rounds to nothing. */
export function changeText(percent: number): string {
  const rounded = Math.round(percent * 100) / 100;
  if (rounded === 0) return '0.00%';
  return `${rounded > 0 ? '+' : '-'}${Math.abs(rounded).toFixed(2)}%`;
}

const priceText = (price: number) => price.toFixed(2);

interface Table {
  names: boolean;
  /** Most rows shown per sector. */
  cap: number;
}

/** A table is cut to this many characters, well inside Discord's 4096 for an embed's text, with room for the "and more" line. */
const MAX_TABLE_CHARS = 3800;

function sectorTable(rows: Stock[], width: { sym: number; name: number; price: number }, t: Table): { block: string; hidden: number } {
  const row = (sym: string, name: string, price: string, change: string) => [sym, ...(t.names ? [name] : []), price, change].join(' ');
  const head = row('SYM'.padEnd(width.sym), 'NAME'.padEnd(width.name), 'PRICE'.padStart(width.price), 'CHG'.padStart(7));
  const lineOf = (s: Stock) => row(code(s.symbol).padEnd(width.sym), code(truncate(s.name, width.name)).padEnd(width.name), priceText(s.price).padStart(width.price), changeText(s.changePercent).padStart(7));
  const fence = '`'.repeat(3);
  // Show as many rows as the cap allows, and as many as fit in one embed.
  const lines: string[] = [];
  let size = head.length + 2 * fence.length + 4;
  for (const s of rows.slice(0, t.cap)) {
    const line = lineOf(s);
    if (lines.length > 0 && size + line.length + 1 > MAX_TABLE_CHARS) break;
    lines.push(line);
    size += line.length + 1;
  }
  return { block: [fence, head, ...lines, fence].join('\n'), hidden: rows.length - lines.length };
}

function totalChars(embeds: EmbedBuilder[]): number {
  return embeds.reduce((sum, e) => {
    const j = e.toJSON();
    return sum + (j.title?.length ?? 0) + (j.description?.length ?? 0) + (j.footer?.text.length ?? 0);
  }, 0);
}

function summary(stocks: Stock[], now: number): string {
  const up = stocks.filter((s) => Math.round(s.changePercent * 100) > 0);
  const down = stocks.filter((s) => Math.round(s.changePercent * 100) < 0);
  const flat = stocks.length - up.length - down.length;
  const movers = (list: Stock[]) => list.slice(0, 3).map((s) => `**${code(s.symbol)}** ${changeText(s.changePercent)}`).join(' · ');
  const gainers = [...up].sort((a, b) => b.changePercent - a.changePercent);
  const losers = [...down].sort((a, b) => a.changePercent - b.changePercent);
  const newest = stocks.reduce((m, s) => Math.max(m, s.updatedAt ?? 0), 0);
  return [
    `**${stocks.length}** companies · ▲ ${up.length} up · ▼ ${down.length} down${flat > 0 ? ` · ▬ ${flat} unchanged` : ''}`,
    gainers.length > 0 ? `Biggest gainers: ${movers(gainers)}` : '',
    losers.length > 0 ? `Biggest losers: ${movers(losers)}` : '',
    `${newest > 0 ? `Prices as of ${ts(newest, 'R')} · ` : ''}board refreshed ${ts(now, 'R')}`,
    "This is AeroDAQ's **in-game** market: not real stocks or money.",
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The whole market as one message: a summary, then a table for each sector. It is squeezed (company
 * names first, then rows) until it fits Discord's limits, so it can never fail to post.
 */
export function renderMarket(stocks: Stock[], now: number): EmbedBuilder[] {
  if (stocks.length === 0) {
    return [new EmbedBuilder().setColor(COLORS.info).setTitle('📈 AeroDAQ · in-game market').setDescription('AeroDAQ lists no companies right now.').setFooter({ text: AERODAQ_FOOTER })];
  }

  // Sectors alphabetically, companies by symbol; sectors past the ninth share one table.
  const bySector = new Map<string, { slug: string; name: string; rows: Stock[] }>();
  for (const s of stocks) {
    const entry = bySector.get(s.sectorSlug) ?? { slug: s.sectorSlug, name: s.sectorName, rows: [] };
    entry.rows.push(s);
    bySector.set(s.sectorSlug, entry);
  }
  let sectors = [...bySector.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const sec of sectors) sec.rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (sectors.length > MAX_EMBEDS - 1) {
    const rest = sectors.slice(MAX_EMBEDS - 2);
    sectors = [...sectors.slice(0, MAX_EMBEDS - 2), { slug: 'other', name: 'More sectors', rows: rest.flatMap((r) => r.rows).sort((a, b) => a.symbol.localeCompare(b.symbol)) }];
  }

  const build = (t: Table): EmbedBuilder[] => {
    const width = {
      sym: Math.max(3, ...stocks.map((s) => s.symbol.length)),
      name: Math.min(15, Math.max(4, ...stocks.map((s) => s.name.length))),
      price: Math.max(5, ...stocks.map((s) => priceText(s.price).length)),
    };
    const embeds = [
      new EmbedBuilder().setColor(COLORS.info).setTitle('📈 AeroDAQ · in-game market').setDescription(summary(stocks, now)),
    ];
    for (const sec of sectors) {
      const { block, hidden } = sectorTable(sec.rows, width, t);
      embeds.push(
        new EmbedBuilder()
          .setColor(COLORS.panel)
          .setTitle(`${SECTOR_EMOJI[sec.slug] ?? '📊'} ${truncate(plainText(sec.name), 200)} · ${sec.rows.length}`)
          .setDescription(hidden > 0 ? `${block}\n…and ${hidden} more at aerodaq.com` : block),
      );
    }
    embeds[embeds.length - 1]!.setFooter({ text: AERODAQ_FOOTER });
    return embeds;
  };

  let last: EmbedBuilder[] = [];
  // Prefer everything, with names; then everything without names; only then leave companies out.
  const attempts: Table[] = [{ names: true, cap: Infinity }, { names: false, cap: Infinity }, ...[12, 8, 5, 3, 1].map((cap) => ({ names: false, cap }))];
  for (const attempt of attempts) {
    last = build(attempt);
    if (totalChars(last) <= MAX_TOTAL_CHARS) return last;
  }
  return last;
}
