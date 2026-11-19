/**
 * Features that are built and tested but not switched on for the people who use the bot.
 *
 * Paying pilots (`/payroll`, the daily pay list, the Pay button) is one: everything but the bank connection is written, and the bank
 * connection waits for access to the airline's payment system. Until that exists, the command is not registered with Discord, its buttons
 * have no handler, and the daily list is never made, so a server sees nothing of it. A developer turns it on by setting the environment
 * variable below to `1` (in `.env`, or in the shell that starts the bot); there is no setting for it in the host app or the manuals.
 */
export const PAYROLL_FLAG = 'FPB_ENABLE_PAYROLL';

/** Is paying pilots switched on? Off unless the variable is `1`, `true`, `yes` or `on`. */
export function payrollEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(?:1|true|yes|on)$/i.test((env[PAYROLL_FLAG] ?? '').trim());
}
