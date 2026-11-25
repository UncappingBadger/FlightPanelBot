import { fullSetupCommand, payrollEnabled } from '../../features.js';
import type { Command, ComponentHandler } from '../context.js';
import { bankingHandler } from '../banking.js';
import { dmHandler, panelHandler } from '../dm.js';
import { noticesHandler } from '../notices.js';
import { payrollHandler } from '../payrollUi.js';
import { payTestHandler } from '../payTestUi.js';
import { safetyHandler } from '../safetyUi.js';
import { profitHandler } from '../profitUi.js';
import { weatherHandler } from '../weatherBoard.js';
import { commandsCommand } from './commands.js';
import { etaCommand } from './eta.js';
import { fuelCommand } from './fuel.js';
import { helpCommand } from './help.js';
import { hideUnavailableCommand } from './hideunavailable.js';
import { payrollCommand } from './payroll.js';
import { setupCommand } from './setup.js';
import { setupSlimCommand } from './setupSlim.js';

/** Only admins configure anything; everyone else uses the buttons on the panel, `/fuel`, `/eta`, `/commands`, and `/hideunavailable` for their own view. */
export const commandSet = (withPayroll: boolean, fullSetup = false): Command[] => [fullSetup ? setupCommand : setupSlimCommand, helpCommand, commandsCommand, fuelCommand, etaCommand, hideUnavailableCommand, ...(withPayroll ? [payrollCommand] : [])];

export const handlerSet = (withPayroll: boolean): ComponentHandler[] => [panelHandler, dmHandler, noticesHandler, profitHandler, weatherHandler, bankingHandler, safetyHandler, ...(withPayroll ? [payrollHandler, payTestHandler] : [])];

/** Paying pilots is on unless the person running the bot switched it off (see `src/features.ts`); off, it is neither registered nor handled. */
export const commands: Command[] = commandSet(payrollEnabled(), fullSetupCommand());

export const componentHandlers: ComponentHandler[] = handlerSet(payrollEnabled());
