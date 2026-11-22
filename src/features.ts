/**
 * Features that a person running the bot can switch off.
 *
 * Paying pilots (`/payroll`, the daily pay list, the Pay button, the test transfer) is on. Nothing is paid by it being on: an airline sets it up
 * with `/payroll settings`, and every payment waits for an admin to press Pay. A person who runs the bot and wants none of it can set the
 * environment variable below to `1` (in `.env`, or in the shell that starts the bot): the command is then not registered with Discord, its buttons have
 * no handler, and no list is ever made.
 */
export const PAYROLL_OFF_FLAG = 'FPB_DISABLE_PAYROLL';

/** Is paying pilots available? Yes, unless the variable is `1`, `true`, `yes` or `on`. */
export function payrollEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(?:1|true|yes|on)$/i.test((env[PAYROLL_OFF_FLAG] ?? '').trim());
}
