import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { commands } from './discord/commands/index.js';

/**
 * Registers the slash commands with Discord. Run it once, and again whenever commands change.
 *
 * - With DISCORD_GUILD_ID set, they appear in that one server instantly (handy while developing).
 * - With `--global` (or no DISCORD_GUILD_ID) they are registered for every server the bot is in,
 *   which Discord can take up to an hour to roll out. If DISCORD_GUILD_ID is also set, that server's
 *   own copies are removed afterwards, since otherwise every command would appear there twice.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const body = commands.map((c) => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  const wantGlobal = process.argv.includes('--global') || !config.discordGuildId;

  if (!wantGlobal && config.discordGuildId) {
    const registered = (await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), { body })) as unknown[];
    console.log(`Registered ${registered.length} command(s) to server ${config.discordGuildId}.`);
    return;
  }

  const registered = (await rest.put(Routes.applicationCommands(config.discordClientId), { body })) as unknown[];
  console.log(`Registered ${registered.length} command(s) globally (can take up to an hour to appear in every server).`);

  // Only after the global ones are safely in place: drop the single-server copies so nothing shows twice.
  if (config.discordGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), { body: [] });
    console.log(`Removed the copies registered to server ${config.discordGuildId}, so commands don't appear twice there.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
