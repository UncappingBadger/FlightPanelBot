import { z } from 'zod';

const required = (name: string) => z.string({ error: `${name} is required (see .env.example)` }).min(1, `${name} is required`);

const EnvSchema = z.object({
  DISCORD_TOKEN: required('DISCORD_TOKEN'),
  DISCORD_CLIENT_ID: required('DISCORD_CLIENT_ID'),
  DISCORD_GUILD_ID: z.string().optional(),
  DATABASE_PATH: z.string().min(1).default('data/bot.sqlite'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Optional: a Google service account key file, so the bot can write to a linked Google Sheet. */
  GOOGLE_SERVICE_ACCOUNT_FILE: z.string().min(1).optional(),
});

export interface Config {
  discordToken: string;
  discordClientId: string;
  /** When set, slash commands are registered to this one guild (instant) instead of globally. */
  discordGuildId: string | undefined;
  databasePath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Path to the Google service account key, or undefined when write-back is not set up. */
  googleServiceAccountFile: string | undefined;
}

/** Treat blank values in .env (e.g. `DISCORD_GUILD_ID=`) as "not set". */
function clean(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) out[k] = v === undefined || v.trim() === '' ? undefined : v.trim();
  return out;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(clean(env));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration. Check your .env file:\n${problems}`);
  }
  const e = parsed.data;
  return {
    discordToken: e.DISCORD_TOKEN,
    discordClientId: e.DISCORD_CLIENT_ID,
    discordGuildId: e.DISCORD_GUILD_ID,
    databasePath: e.DATABASE_PATH,
    logLevel: e.LOG_LEVEL,
    googleServiceAccountFile: e.GOOGLE_SERVICE_ACCOUNT_FILE,
  };
}
