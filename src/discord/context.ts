import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  StringSelectMenuInteraction,
} from 'discord.js';
import type { AeroDaqClient } from '../aerodaq/client.js';
import type { Config } from '../config.js';
import type { Store } from '../db/store.js';
import type { FsHubApi } from '../fshub/client.js';
import type { MetarClient } from '../metar/client.js';
import type { AutoCompleter } from '../services/autoComplete.js';
import type { AeroNumbers } from '../services/aeroNumbers.js';
import type { AirlineProfits } from '../services/airlineProfits.js';
import type { DailyNote } from '../services/dailyNote.js';
import type { HourlySlot } from '../services/hourlySlot.js';
import type { FlightEtas } from '../services/flightEtas.js';
import type { FsHubSync } from '../services/fshubSync.js';
import type { JobService } from '../services/jobs.js';
import type { SourceRefresher } from '../services/refresh.js';
import type { SheetWriteBack } from '../services/writeback.js';
import type { Logger } from '../util/log.js';
import type { MarketService } from './market.js';
import type { PanelService } from './panel.js';

/** Everything a command handler needs, created once at startup. */
export interface BotContext {
  config: Config;
  store: Store;
  jobs: JobService;
  panels: PanelService;
  refresher: SourceRefresher;
  /** AeroDAQ's in-game market and fuel prices (public, read-only). */
  aerodaq: AeroDaqClient;
  /** Keeps each server's market board up to date. */
  market: MarketService;
  /** VATSIM's public METAR service, for the `metar` message to the bot. Only asked when someone asks for a weather report. */
  metar: MetarClient;
  /** Writes pilots' names and completions into a linked Google Sheet; null when the bot has no Google credentials. */
  writeback: SheetWriteBack | null;
  /** FsHub, for checking pilot IDs and reading an airline's roster; null when the host saved no FsHub token. */
  fshub: FsHubApi | null;
  /** Reads linked airlines' FsHub rosters; null together with `fshub`. */
  fshubSync: FsHubSync | null;
  /** Completes flights FsHub shows flown, once an hour; null together with `fshub`. */
  autoComplete: AutoCompleter | null;
  /** The once-a-day note to one configured person; absent or null when none is set up. */
  dailyNote?: DailyNote | null;
  /** When each flight that is in the air is expected to land, from FsHub's live feed; absent or null when it is not followed. */
  etas?: FlightEtas | null;
  /** Aeroconomy's own flight numbers for flights whose sheet row has none; absent or null in tests that do not use it. */
  numbers?: AeroNumbers | null;
  /** Compares Aeroconomy's profit per flight with the sheet's Profit Made, for `/setup profit`; null when the bot has no FsHub token. */
  profits?: AirlineProfits | null;
  /** The one moment each hour at which all the hourly checks happen; absent in tests that do not use it. */
  slot?: HourlySlot;
  log: Logger;
  now: () => number;
  /** For downloading admin-uploaded files; replaceable in tests. */
  fetchFn: typeof fetch;
}

export interface Command {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  execute(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void>;
  autocomplete?(ctx: BotContext, interaction: AutocompleteInteraction): Promise<void>;
}

export type ComponentInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

export interface ComponentHandler {
  /** Matches custom IDs that start with `${prefix}:`. */
  prefix: string;
  handle(ctx: BotContext, interaction: ComponentInteraction): Promise<void>;
}
