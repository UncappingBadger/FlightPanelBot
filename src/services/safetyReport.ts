import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FlownFlight, Panel, Store } from '../db/store.js';
import { plainText, truncate } from '../util/format.js';
import type { Logger } from '../util/log.js';
import type { HeldFlight } from './airlineProfits.js';
import { landingWindow } from './flightMatch.js';
import { fineShare, IMPLAUSIBLE_FPM, type FineTier } from './safetyPay.js';

/**
 * What management is told about landing safety, and the file the bot keeps of it.
 *
 *  - When a pilot lands at Tier 2 or Tier 3 (the tiers that cut pay), the airline's managers are sent a report by private message, and the same facts are
 *    added to a CSV file in the bot's data folder: `hard-landings.csv`.
 *  - When safety pay is on and a flight's pay is left unfilled because FsHub's landing rate cannot be trusted, the managers are told that too.
 *
 * "Managers" are the members of the roles an admin set for managing the airline: the `/setup refresh-roles` roles and the `/setup profit` write role.
 */

/** The name of the file, in the data folder. */
export const HARD_LANDINGS_CSV = 'hard-landings.csv';

const DAY = 24 * 3_600_000;

/** The roles that count as the airline's management: the `/setup refresh-roles` roles of the server, and the `/setup profit` write role of the panel. */
export function managerRoles(store: Store, panel: Panel): string[] {
  const roles = [...store.listRefreshRoles(panel.guildId)];
  if (panel.profitRoleId !== null) roles.push(panel.profitRoleId);
  return [...new Set(roles)];
}

/** Who a managers' message goes to: the Discord accounts of the people it is for (empty when there is nobody the bot can reach). */
export type ManagerLookup = (panel: Panel) => Promise<string[]>;

/**
 * The lookup the bot uses: the members of the panel's `managerRoles` (the `/setup refresh-roles` roles and the profit role), as far as `find` can
 * tell who has them in a server. The wiring of the real bot and the tests use this one, so the two cannot differ.
 */
export function managersLookup(store: Store, find: (guildId: string, roleIds: string[]) => Promise<string[]>): ManagerLookup {
  return (panel) => find(panel.guildId, managerRoles(store, panel));
}

/** Sends one person a private message. True if it went out. */
export type SendDm = (discordId: string, content: string) => Promise<boolean>;

/* ------------------------------------------------------------------ the report of a penalty landing */

export interface PenaltyReport {
  airline: string;
  tier: FineTier;
  /** The landing rate in feet per minute, a descent negative (-452). */
  rate: number;
  landedAt: number;
  /** The pilot's name: their Discord name when the bot knows the account, otherwise the name FsHub has. */
  pilotName: string;
  fshubId: number;
  /** The name FsHub has for the pilot, only when it is not the same as `pilotName`. */
  fshubUsername: string | null;
  /** The flight's number in the airline's schedule, when it could be told which one the pilot flew. */
  flightNumber: string | null;
  dep: string;
  arr: string;
  /** FsHub's own number for the flight. */
  flightId: number;
}

/** `2026-11-22 14:05`, in UTC. */
export const utcText = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

/** The columns of the CSV, in the order the airline asked for them, with the airline, the tier and FsHub's flight number after. */
export const CSV_HEADER = ['Pilot Name', 'FsHub ID', 'FsHub Username (if different)', 'Flight Number', 'Departure-Arrival', 'Landed (UTC)', 'Landing Rate (fpm)', 'Tier', 'Airline', 'FsHub Flight ID'] as const;

/**
 * A value as one CSV field. A text that a spreadsheet would run as a formula (it starts with `=`, `+`, `-`, `@`, a tab or a return) is put behind an
 * apostrophe, since names and flight numbers come from outside; one with a comma, a quote or a line break is quoted.
 */
export function csvField(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  let text = value.replace(/\r?\n/g, ' ');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One row of the CSV (no line break). */
export function csvLine(r: PenaltyReport): string {
  return [
    r.pilotName,
    r.fshubId,
    r.fshubUsername,
    r.flightNumber,
    `${r.dep}-${r.arr}`,
    utcText(r.landedAt),
    r.rate,
    `Tier ${r.tier}`,
    r.airline,
    r.flightId,
  ]
    .map((v) => csvField(v))
    .join(',');
}

/** Add a row to the CSV, writing the heading first when the file is new (with the mark that lets Excel read the accents). Throws when the file cannot be written (open in another program, say). */
export function appendPenaltyCsv(file: string, r: PenaltyReport): void {
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, `﻿${CSV_HEADER.join(',')}\r\n`, 'utf8');
  appendFileSync(file, `${csvLine(r)}\r\n`, 'utf8');
}

/**
 * The report a manager is sent, as a private message. `pilotTold` says whether the pilot was sent the safety notice (null: the pilot is not linked to a Discord
 * account). `logged` says whether the row was added to the CSV (null: no file is kept).
 */
export function penaltyMessage(r: PenaltyReport, pilotTold: boolean | null, logged: boolean | null): string {
  const who = [`**${plainText(truncate(r.pilotName, 60))}**`, `FsHub ID ${r.fshubId}`, ...(r.fshubUsername ? [`FsHub username ${plainText(truncate(r.fshubUsername, 60))}`] : [])].join(' · ');
  const share = fineShare(r.tier);
  return [
    `${r.tier === 3 ? '🛑' : '🚨'} **Safety violation, Tier ${r.tier}** · ${plainText(truncate(r.airline, 60))}`,
    `**Pilot:** ${who}`,
    `**Flight:** ${r.flightNumber ? `${plainText(truncate(r.flightNumber, 40))} · ` : ''}${r.dep} → ${r.arr}${r.flightNumber ? '' : ' (not matched to a flight in the schedule)'}`,
    `**Landed:** <t:${Math.floor(r.landedAt / 1000)}:f> (${utcText(r.landedAt)} UTC)`,
    `**Landing rate:** ${r.rate} fpm`,
    `The pilot's pay for this flight is cut (${share}% of the profit instead of 15%, and the airline's minimum-pay rule).`,
    pilotTold === null ? "The pilot isn't linked to a Discord account, so they were not sent the safety notice." : pilotTold ? 'The pilot has been sent the safety notice.' : "The pilot couldn't be sent the safety notice (closed DMs, perhaps).",
    ...(logged === null ? [] : [logged ? `Added to ${HARD_LANDINGS_CSV} in my data folder.` : `I couldn't add it to ${HARD_LANDINGS_CSV} (is the file open in another program?). I'll try again.`]),
  ].join('\n');
}

/**
 * The number of the schedule flight a pilot flew when FsHub recorded this landing, or null when it cannot be told. FsHub's record names no flight number, so
 * this is matching: a flight on the panel between the same two airports whose landing window holds the landing, and that this pilot holds (or is backup for).
 * If more than one flight fits, all are named.
 */
export function flightNumberOf(store: Store, panel: Panel, f: FlownFlight, now: number): string | null {
  const views = new Map<number, ReturnType<Store['listAllHeldJobViews']>[number]>();
  for (const v of store.listCompletedJobViews(panel.id, f.arrivedAt - 7 * DAY)) views.set(v.job.id, v);
  for (const v of store.listAllHeldJobViews(panel.id, f.arrivedAt - 2 * DAY)) views.set(v.job.id, v);
  // Last, so that a flight with a backup pilot is seen with its backup.
  for (const v of store.listBackedJobViews(panel.id, f.arrivedAt - 2 * DAY)) views.set(v.job.id, v);
  const codes: string[] = [];
  for (const v of views.values()) {
    const { from, to } = landingWindow(v.job, now);
    if (f.arrivedAt < from || f.arrivedAt > to) continue;
    const flown = v.legs.some(
      (l) => l.dep.toUpperCase() === f.dep.toUpperCase() && l.arr.toUpperCase() === f.arr.toUpperCase() && (l.holder?.fshubId === f.pilotId || v.backup?.fshubId === f.pilotId),
    );
    if (flown && !codes.includes(v.job.code)) codes.push(v.job.code);
  }
  return codes.length > 0 ? codes.join(' or ') : null;
}

/* ------------------------------------------------------------------ flights left unfilled for want of a landing rate */

const DOUBT_LISTED = 8;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (ms: number): string => `${new Date(ms).getUTCDate()} ${MONTHS[new Date(ms).getUTCMonth()]}`;

/** What managers are told about flights that were left unfilled because the landing rate could not be trusted. */
export function doubtMessage(airline: string, held: HeldFlight[]): string {
  const lines = held.slice(0, DOUBT_LISTED).map((h) => {
    const why = h.reason === 'no-landing-rate' ? 'FsHub has no landing rate for it' : `FsHub's landing rate for it (-${h.fpm ?? IMPLAUSIBLE_FPM + 1} fpm) is too hard to believe as a touchdown`;
    const pilot = h.pilot ? `, pilot in the sheet: ${plainText(truncate(h.pilot, 40))}` : '';
    return `• **${plainText(truncate(h.callsign || h.route, 30))}** ${plainText(h.route)}, ${dayText(h.day)}${pilot}: ${why}.`;
  });
  if (held.length > DOUBT_LISTED) lines.push(`• …and ${held.length - DOUBT_LISTED} more.`);
  return [
    `⏸️ **Safety pay: left unfilled** · ${plainText(truncate(airline, 60))}`,
    `Landing safety pay is on, and I can't tell whether ${held.length === 1 ? 'this flight' : 'these flights'} should have the pay cut for a hard landing, so I haven't filled in the Profit Made or Pilot Pay cells:`,
    ...lines,
    `Please check ${held.length === 1 ? 'it' : 'them'} on FsHub and fill the cells in by hand if you are sure of the pay. I leave them alone until then, and I won't tell you about ${held.length === 1 ? 'this one' : 'these'} again.`,
  ].join('\n');
}

/**
 * Tell the managers about flights that were held back for want of a trustworthy landing rate, once per flight (a flight already told about is left out).
 * Returns how many managers were sent the message. Never throws.
 */
export async function tellDoubts(
  d: { store: Store; send: SendDm; managers: ManagerLookup; now: () => number; log: Logger },
  panel: Panel,
  held: HeldFlight[],
): Promise<number> {
  try {
    const fresh = held.filter((h) => !d.store.hasSafetyDoubt(panel.id, h.sourceKey));
    if (fresh.length === 0) return 0;
    const people = await d.managers(panel);
    let sent = 0;
    const text = doubtMessage(panel.airlineName, fresh);
    for (const id of people) if (await d.send(id, text).catch(() => false)) sent++;
    // Remembered whether or not anybody could be reached: the flights stay out of the sheet, and the preview shows them, so nothing is lost by not repeating it.
    for (const h of fresh) d.store.noteSafetyDoubt(panel.id, h.sourceKey, d.now());
    if (people.length === 0) d.log.info(`Safety pay left ${fresh.length} flight(s) of panel ${panel.id} unfilled, and there is nobody to tell`);
    return sent;
  } catch (e) {
    d.log.debug('Telling managers about unfilled flights failed', e);
    return 0;
  }
}
