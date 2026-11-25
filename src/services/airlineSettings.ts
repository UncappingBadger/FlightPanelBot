import type { Panel } from '../db/store.js';
import { defaultLimits, limitsOf, readFleet, type FleetRead, type LimitsDeps } from './safetyLimits.js';
import { checkLimits, normalizeAircraft, type SafetyLimits } from './safetyPay.js';

/** A setting that was refused, with a reason a person can act on. The settings page shows its message as it is. */
export class SettingsError extends Error {
  constructor(
    message: string,
    /** 404 for an airline that is not there, 400 for a value that is not acceptable. */
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

/** What the bot needs for the airline settings: the landing limits' needs, and whether the bot has a FsHub token (safety pay needs FsHub's landing rates). */
export interface AirlineSettingsDeps extends LimitsDeps {
  fshub: boolean;
}

/** One airline (panel), as the settings page lists it. */
export interface AirlineSummary {
  id: number;
  guildId: string;
  name: string;
  abbr: string | null;
  /** Whether landing safety pay is on for it. */
  safetyOn: boolean;
}

/** How landing safety pay stands for one airline. */
export interface SafetyView {
  id: number;
  name: string;
  on: boolean;
  /** When it was turned on (milliseconds), or null while it is off. */
  since: number | null;
  /** Why it cannot be turned on yet (it needs FsHub's landing rates), or null. */
  cannotTurnOn: string | null;
  /** What per cent of the $2,000 minimum pay a pilot loses after a Tier 1 and after a Tier 2 landing. */
  lossTier1: number;
  lossTier2: number;
  /** The per cent of a flight's profit a pilot is paid after a Tier 1 and after a Tier 2 landing. */
  shareTier1: number;
  shareTier2: number;
  /** Whether what a hard landing takes off a pilot's pay is written in the sheet's Safety Deductions column. */
  deductions: boolean;
  /** The limits an aircraft with none of its own is judged by. */
  defaults: SafetyLimits;
  /** How many aircraft types have limits of their own. */
  ownCount: number;
}

/** One aircraft type with the limits it is judged by. */
export interface FleetRow {
  code: string;
  owned: number;
  leased: number;
  flown: boolean;
  limits: SafetyLimits;
  /** Whether the limits are its own (and not the airline's default). */
  own: boolean;
}

/** The airline's aircraft types with their limits. */
export interface FleetView {
  id: number;
  name: string;
  /** When Aeroconomy was last asked (milliseconds). */
  readAt: number;
  rows: FleetRow[];
  defaults: SafetyLimits;
  /** Why the fleet could not be read from Aeroconomy (the types seen in flights are still listed), or null. */
  problem: string | null;
  /** Aircraft Aeroconomy lists without saying what type they are. */
  untyped: number;
}

/** What can be changed about landing safety pay in one go. Anything left out stays as it is. */
export interface SafetyPatch {
  on?: boolean;
  lossTier1?: number;
  lossTier2?: number;
  shareTier1?: number;
  shareTier2?: number;
  deductions?: boolean;
  /** The airline's default limits. */
  defaults?: SafetyLimits;
}

/** One aircraft type's limits to save, or null to put it back on the airline's default. */
export interface LimitsChange {
  /** The aircraft's ICAO code. */
  aircraft: string;
  limits: SafetyLimits | null;
}

const isPercent = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 100;

/**
 * What the host's settings page can change about each airline (panel): landing safety pay and, for it, the landing limits aircraft by aircraft. It does what
 * the Discord commands do, with no Discord in it, so the page and the bot work from the same rules.
 */
export class AirlineSettings {
  constructor(private readonly deps: AirlineSettingsDeps) {}

  private panel(id: number): Panel {
    const panel = this.deps.store.getPanel(id);
    if (!panel) throw new SettingsError('That airline is not set up any more. Reload the page.', 404);
    return panel;
  }

  /** Why safety pay cannot be turned on for this panel yet, or null: it needs FsHub's landing rate for each flight. */
  private cannotTurnOn(panel: Panel): string | null {
    if (!this.deps.fshub) return "The bot has no FsHub token, and safety pay needs FsHub's landing rate for each flight. Add the token under FsHub on this page first.";
    if (panel.fshubAirlineId === null) return `Safety pay needs FsHub's landing rates. First link ${panel.airlineName} to its airline's FsHub roster, in the FsHub roster tab of this page.`;
    if (!panel.fshubConfirm) return `Reading FsHub's flights is switched off for ${panel.airlineName}, and safety pay needs them (they carry the landing rates). Switch it on in the FsHub roster tab of this page ("Read the airline's recent FsHub flights").`;
    return null;
  }

  /** Every airline the bot is set up for. */
  airlines(): AirlineSummary[] {
    return this.deps.store.listAllPanels().map((p) => ({ id: p.id, guildId: p.guildId, name: p.airlineName, abbr: p.airlineAbbr ?? null, safetyOn: p.safetyPaySince !== null }));
  }

  /** How landing safety pay stands for one airline. */
  safety(panelId: number): SafetyView {
    const panel = this.panel(panelId);
    return this.viewOf(panel);
  }

  private viewOf(panel: Panel): SafetyView {
    return {
      id: panel.id,
      name: panel.airlineName,
      on: panel.safetyPaySince !== null,
      since: panel.safetyPaySince,
      cannotTurnOn: this.cannotTurnOn(panel),
      lossTier1: panel.safetyLossTier1,
      lossTier2: panel.safetyLossTier2,
      shareTier1: panel.safetyShareTier1,
      shareTier2: panel.safetyShareTier2,
      deductions: panel.safetyDeductions,
      defaults: defaultLimits(panel),
      ownCount: this.deps.store.listSafetyLimits(panel.id).size,
    };
  }

  /** Change how landing safety pay works for one airline. Everything is checked first, so a refused change changes nothing. */
  setSafety(panelId: number, patch: SafetyPatch): SafetyView {
    const { store, now } = this.deps;
    const panel = this.panel(panelId);
    for (const [label, v] of [
      ['What a pilot loses after a Tier 1 landing', patch.lossTier1],
      ['What a pilot loses after a Tier 2 landing', patch.lossTier2],
      ['The Tier 1 share of the profit', patch.shareTier1],
      ['The Tier 2 share of the profit', patch.shareTier2],
    ] as const) {
      if (v !== undefined && !isPercent(v)) throw new SettingsError(`${label} must be a whole number of per cent, from 0 to 100.`);
    }
    if (patch.on !== undefined && typeof patch.on !== 'boolean') throw new SettingsError('Say whether safety pay is on or off.');
    if (patch.deductions !== undefined && typeof patch.deductions !== 'boolean') throw new SettingsError('Say whether deductions are written in the sheet.');
    if (patch.defaults !== undefined) {
      const problem = checkLimits(patch.defaults);
      if (problem) throw new SettingsError(problem);
    }
    if (patch.on === true && panel.safetyPaySince === null) {
      const blocked = this.cannotTurnOn(panel);
      if (blocked) throw new SettingsError(blocked);
    }

    store.updatePanel(panel.id, {
      ...(patch.lossTier1 !== undefined ? { safetyLossTier1: patch.lossTier1 } : {}),
      ...(patch.lossTier2 !== undefined ? { safetyLossTier2: patch.lossTier2 } : {}),
      ...(patch.shareTier1 !== undefined ? { safetyShareTier1: patch.shareTier1 } : {}),
      ...(patch.shareTier2 !== undefined ? { safetyShareTier2: patch.shareTier2 } : {}),
      ...(patch.deductions !== undefined ? { safetyDeductions: patch.deductions } : {}),
      ...(patch.defaults !== undefined ? { safetyWarnFpm: patch.defaults.warn, safetyTier1Fpm: patch.defaults.tier1, safetyTier2Fpm: patch.defaults.tier2 } : {}),
      // Turning it on starts from now (a flight that landed before is paid as it always was); turning it off clears it; already on, the day it started stays.
      ...(patch.on === true && panel.safetyPaySince === null ? { safetyPaySince: now() } : {}),
      ...(patch.on === false ? { safetyPaySince: null } : {}),
    });
    return this.viewOf(this.panel(panel.id));
  }

  /** The airline's aircraft types (read from Aeroconomy and from its flights) with the limits each is judged by. `refresh` asks Aeroconomy afresh. */
  async fleet(panelId: number, opts: { refresh?: boolean; business?: number } = {}): Promise<FleetView> {
    const panel = this.panel(panelId);
    if (opts.business !== undefined && (!Number.isSafeInteger(opts.business) || opts.business < 1)) throw new SettingsError('The business number is a whole number, 1 or more.');
    const read: FleetRead = await readFleet(this.deps, panel, opts.refresh === true || opts.business !== undefined, opts.business);
    // A read of the fleet is kept for an hour, so a type given limits of its own since (one added by its code, say) is put in here, not left out until the next read.
    const entries = [...read.entries];
    for (const code of this.deps.store.listSafetyLimits(panel.id).keys()) if (!entries.some((e) => e.code === code)) entries.push({ code, owned: 0, leased: 0, flown: false });
    entries.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    return {
      id: panel.id,
      name: panel.airlineName,
      readAt: read.at,
      rows: entries.map((e) => ({ code: e.code, owned: e.owned, leased: e.leased, flown: e.flown, ...limitsOf(this.deps.store, panel, e.code) })),
      defaults: defaultLimits(panel),
      problem: read.problem,
      untyped: read.untyped,
    };
  }

  /**
   * Save the limits of some aircraft types (each with its own limits, or null to put it back on the airline's default). Every one is checked before any is
   * saved, so a refused list changes nothing. Returns how many types were set and how many were put back on the default.
   */
  setLimits(panelId: number, changes: readonly LimitsChange[]): { set: number; reset: number } {
    const { store, now } = this.deps;
    const panel = this.panel(panelId);
    if (changes.length > 500) throw new SettingsError('That is too many aircraft at once.');
    const checked: Array<{ code: string; limits: SafetyLimits | null }> = [];
    for (const c of changes) {
      const code = normalizeAircraft(c.aircraft);
      if (code === null) throw new SettingsError(`"${String(c.aircraft).slice(0, 20)}" is not an aircraft code. Use its ICAO code (A320, B738, C172).`);
      if (c.limits !== null) {
        const l = c.limits;
        for (const v of [l?.warn, l?.tier1, l?.tier2]) if (typeof v !== 'number' || !Number.isInteger(v)) throw new SettingsError(`The limits of the ${code} must be whole numbers of feet per minute.`);
        const problem = checkLimits(l);
        if (problem) throw new SettingsError(`${code}: ${problem}`);
      }
      checked.push({ code, limits: c.limits === null ? null : { warn: c.limits.warn, tier1: c.limits.tier1, tier2: c.limits.tier2 } });
    }
    let set = 0;
    let reset = 0;
    for (const c of checked) {
      if (c.limits === null) {
        if (store.clearSafetyLimits(panel.id, c.code)) reset++;
      } else {
        store.setSafetyLimits(panel.id, c.code, c.limits, now());
        set++;
      }
    }
    return { set, reset };
  }
}
