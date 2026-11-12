# Third-party notices

This bot is built on the open-source packages below, each used under its own licence. They are installed from npm, not copied into this repository; each package's full licence text ships in its folder under `node_modules`.

The Windows app (`FlightPanelBot.exe`, built with `npm run build:host`) bundles these packages into its bot file and carries the **Node.js** runtime (MIT licence, <https://github.com/nodejs/node/blob/main/LICENSE>). The build writes a `THIRD_PARTY_NOTICES.txt` beside the exe that adds Node.js's licence text and the licence headers found in the bundled code, so that file travels with the program.

Regenerate this list after changing dependencies with `npm ls --omit=dev --all`.

| Package | Version | Licence |
|---|---|---|
| @discordjs/builders | 1.15.0 | Apache-2.0 |
| @discordjs/collection | 1.5.3 | Apache-2.0 |
| @discordjs/collection | 2.1.1 | Apache-2.0 |
| @discordjs/formatters | 0.6.2 | Apache-2.0 |
| @discordjs/rest | 2.6.3 | Apache-2.0 |
| @discordjs/util | 1.2.0 | Apache-2.0 |
| @discordjs/ws | 1.2.3 | Apache-2.0 |
| @sapphire/async-queue | 1.5.5 | MIT |
| @sapphire/shapeshift | 4.0.0 | MIT |
| @sapphire/snowflake | 3.5.5 | MIT |
| @types/node | 24.19.2 | MIT |
| @types/ws | 8.18.2 | MIT |
| @vladfrangu/async_event_emitter | 2.4.7 | MIT |
| discord.js | 14.28.1 | Apache-2.0 |
| discord-api-types | 0.38.58 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| lodash | 4.18.1 | MIT |
| lodash.snakecase | 4.1.1 | MIT |
| magic-bytes.js | 1.13.1 | MIT |
| tslib | 2.9.1 | 0BSD |
| ts-mixer | 6.0.4 | MIT |
| undici | 6.29.1 | MIT |
| undici-types | 7.24.6 | MIT |
| ws | 8.22.2 | MIT |
| zod | 4.6.7 | MIT |

Development-only tools (TypeScript, tsx, @types/node) are not distributed with the bot.

## Services

The bot is an unofficial companion and is not affiliated with, endorsed by, or sponsored by FsHub, Aeroconomy or AeroDAQ. It includes no FsHub, Aeroconomy or AeroDAQ logos or artwork.

- **FsHub** (https://fshub.io): contacted only if the person running the bot saves a FsHub personal access token (optional). The bot then makes read-only requests to FsHub's REST API v3: a pilot's public profile when someone types a pilot ID (to check it and show the name), the roster of an airline an admin linked with `/setup fshub` (read once an hour), and that airline's recent flights (read about every five minutes, to show the aircraft flown on completed flights). The token is sent only to fshub.io, in a request header; nothing about a pilot is sent except the pilot ID they typed. Names, IDs and Discord links are FsHub's data, kept in the bot's own database on the host's computer. Without a token the bot never contacts FsHub, and a pilot ID is only a number a pilot types in, stored and shown.
- **AeroDAQ** (https://aerodaq.com): the bot reads its public, read-only API (`/api/v1/market` and `/api/v1/airports/<ICAO>/fuel`) when someone uses `/fuel` or a server switches on a market board. Company names, prices and the in-game market are AeroDAQ's, shown as they arrive and always labelled in-game, not real money or real stocks. No account or key is used, and nothing about pilots, servers or airlines is sent.
- **GitHub** (https://api.github.com): the Windows app asks for this project's public "latest release" once a day to say whether a newer version exists (switchable off). Nothing is downloaded.
- **Google Sheets** (https://docs.google.com): a panel's linked schedule sheet is read through its public CSV link; write-back, if set up, uses the Sheets API.
