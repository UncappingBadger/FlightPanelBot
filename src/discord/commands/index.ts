import type { Command, ComponentHandler } from '../context.js';
import { dmHandler, panelHandler } from '../dm.js';
import { fuelCommand } from './fuel.js';
import { helpCommand } from './help.js';
import { setupCommand } from './setup.js';

/** Only admins configure anything; everyone else uses the buttons on the panel, and `/fuel`. */
export const commands: Command[] = [setupCommand, helpCommand, fuelCommand];

export const componentHandlers: ComponentHandler[] = [panelHandler, dmHandler];
