# Aeroconomy Flight Panel Bot

A Discord bot for virtual-airline communities. An admin names the airline; the bot keeps a **panel** in a
channel listing the airline's open flights (route, required airframe, when it must be completed by). Pilots
press **Reserve**, the bot DMs them, they reply with the flight's ID, and the panel shows their name (and
FsHub pilot ID) next to the flight. Multi-leg flights can be split between pilots leg by leg. It can also look
up fuel prices (`/fuel`) and show the AeroDAQ in-game market in a channel.

By UncappingBadger. Unofficial: not affiliated with, endorsed by, or sponsored by FsHub, Aeroconomy or AeroDAQ.

## How it works for pilots

1. A panel in the airline's channel lists open flights, soonest deadline first:

   ```
   DMO-004 · EGLL → EGCC → EGPH (2 legs) · ✈ A320
   ⏰ complete by Sat 14 Nov 18:00 (in 3 days) · 💰 28,000
   ↳ 1 EGLL → EGCC — @alice · FsHub #4821
   ↳ 2 EGCC → EGPH — open
   ```
2. Press **Reserve**. The bot DMs you. The first time it asks for your **FsHub pilot ID** (see below); after
   that it goes straight to: *"Reply with the flight ID shown on the panel."*
3. Reply with the ID (`DMO-004`, `dmo4` and `4` all work).
4. One-leg flight: you're booked and the panel updates. Several legs: the bot asks **All legs** or **Some
   legs**. For some, pick from a menu of the legs still free. If you ask for all but someone holds a leg, it
   tells you who and offers the legs that are free.
5. **My flights** (under the panel) shows what you hold and lets you give flights back. Say `cancel` in the DM
   at any point to stop. A conversation closes after 10 minutes.
6. **Complete** (under the panel) is for when you've flown it: pick the flights, confirm, and the panel shows
   them as completed. You have to hold every leg of a flight to complete it, and you can still do it for two
   days after its window closes.

If a flight is removed, its route changes, or an admin frees it, the people affected get a DM.

**Your FsHub pilot ID.** So an airline's managers can match a Discord account to the right pilot on their FsHub
roster, even when the names differ, the bot asks for your FsHub pilot ID the first time you press **Reserve**. It
is the number in your profile address (`fshub.io/pilot/`**`1234`**`/overview`); you can reply with the number or paste
the link. It is remembered, shown as `FsHub #1234` next to your name on every flight you hold (and on completed
flights), and not asked for again. Change it any time by DMing the bot `fshub <your ID>`; the panels redraw
with the new number. **The bot never checks it with FsHub** (it doesn't talk to FsHub at all), so it is exactly
what the pilot typed; managers compare it with their roster. It is not written to the Google Sheet.

**Completed flights are shown.** A flight completed with the **Complete** button, or whose *Flight Completed* box
is ticked in a linked Google Sheet, leaves the open list and appears under **✅ Completed in the last 24 hours**
on the panel, as `✅ DMO-004 · EGLL → EGCC · ✈ A320 · flown by <name>`. The name is the Discord person who
reserved it, the pilot named in the schedule, or both. It can no longer be reserved or released, and nobody is
DM'd that it was "removed". After a day it drops off the panel. A box ticked in the sheet is noticed the next
time the sheet is read (every hour, or straight away with `/setup refresh`), and the day is counted from then.
Flights that were completed long before a sheet was linked are not listed.

**The sheet can follow what pilots do here** ("write-back", optional; see [Writing to the sheet](#writing-to-the-sheet)).
When it is on, reserving a flight puts the pilot's name in the sheet's Pilot column, giving it back clears it,
and **Complete** ticks the *Flight Completed* box. DM the bot `name <your name>` if you appear in the sheet under
a different name than your Discord one.

**Flights with no pilot get announced.** A day before a flight starts (when its landing window opens, or its
deadline if it has no start time), if nobody has it, the bot posts once in the panel's channel: a ping, the
flights that still need someone, and a **Reserve** button. One message covers every such flight, listing the
soonest 12. For a multi-leg flight it says which legs are open. A flight is announced once, and again only if
it gets a pilot and later loses them. A pilot named in a linked Google Sheet counts as a pilot. Flights whose
window is already open and still unclaimed are announced the first time the bot sees them.

**Times are shown in each person's own timezone.** Everything on the panel and in the bot's messages uses
Discord timestamps, which each person's Discord app converts to their own timezone and date format (plus a
live "in 3 days" countdown). The only place times are *typed* in is the admins' import file, where they are
read as UTC (or with an explicit offset such as `+01:00`).

## Where the flight list comes from (read this)

**Aeroconomy has no public API.** Its developer page says "Work In Progress"; its job board (Pilots for Hire)
is reached through FsHub's desktop app, and a virtual airline's own assignment list sits behind the member
login on the FsHub site. The bot does **not** log in as anyone or reverse-engineer the app, so it cannot pull a
live job list from the Aeroconomy website today.

So the list comes from a swappable **job source** (`src/jobs/types.ts`):

| Source | When | Refresh |
|---|---|---|
| **Google Sheet**: link the schedule sheet your airline already keeps, with `/setup sheet` | real use today, if the airline coordinates flights in a sheet | every hour, automatically |
| **File import**: an admin uploads a CSV or JSON of flights with `/setup import` | real use today | each time you import |
| **Demo**: fictional flights | `npm run demo` | every 24 hours, automatically |
| **Aeroconomy feed** | only if FsHub provides an API | every 24 hours (the scheduler and refresher are already built; only the source is missing) |

[docs/FSHUB_API_REQUEST.md](docs/FSHUB_API_REQUEST.md) is a ready-to-send message asking FsHub for read access.
Once they publish or grant one, a new source (a class with one `fetch` method) plugs in and everything else,
including the 24-hourly refresh, works unchanged.

## Run it as a Windows app (for hosts)

Every server runs **its own copy** of the bot, on a computer of its own. `release/FlightPanelBot.exe` is one
file that carries the bot and the Node.js it needs, so the host installs nothing:

1. Double-click it. (Windows may warn that the program is unsigned: **More info**, then **Run anyway**.)
2. A tray icon appears near the clock and the setup page opens in the browser. The host creates **their own
   Discord bot** (a bot token belongs to one bot, so tokens are never shared), pastes its token, and presses
   **Add the bot to a server**. The bot gives itself its slash commands in each server it joins, so `/setup`
   works at once. There is no `.env` file, no FsHub account or token, and no script to run.
3. The icon's colour shows the state (green online, amber starting or needs setup, red needs attention). The
   menu opens the setup page, copies the invite link, shows the log and data folder, restarts the bot, switches
   **Start with Windows** on or off, and quits.

Settings, the database and logs live in `%APPDATA%\FlightPanelBot`. The setup page listens on this computer
only, needs a secret key that only the tray program knows, and refuses requests that did not come from its own
page, so nothing else on the machine can read the token or change it. The token is kept in that folder as
plain text, protected by the Windows account's own folder permissions, like the `.env` file would be. (An older
version kept a FsHub token there too; the app removes it on first start, since nothing uses it any more.)

**New versions.** Once a day (and on the setup page's **Check for updates** button) the app asks GitHub's public
"latest release" page for this project whether a newer version exists. If so, the tray shows a pop-up once, the
menu gets **A new version is available: vX** (opens the release page), and the setup page shows a banner. It
never downloads or installs anything: the host downloads the new `FlightPanelBot.exe` from the release page,
quits the old one from the tray and runs the new one; settings and data carry over. The check sends only an
ordinary HTTPS request naming the app and its version (`FlightPanelBot/0.1.0`) and can be switched off on the
setup page. A new release is published by creating a GitHub release on the project's repository
(`UncappingBadger/FlightPanelBot`, set in `src/host/updates.ts`) with a tag such as `v0.2.0` and the
exe attached; the tag must be higher than the version in `package.json`.

**Build it:** `npm run build:host` bundles the bot with esbuild, compresses the bundle and this machine's Node.js,
and compiles a small C# tray launcher (using the compiler that ships with Windows) with both embedded. Output is
`release/FlightPanelBot.exe` plus its licence notices and a checksum. The exe is **not code-signed**, which is
why Windows shows a warning; signing needs a certificate. `FPB_HOME` moves the data folder, and `FPB_NO_BROWSER=1`
stops the tray program opening the browser (used by tests).

## Setup from source (developers)

You need Node.js 22.13 or newer.

1. **Create the Discord application** at <https://discord.com/developers/applications>: add a Bot, copy its
   token and the Application ID. No privileged intents are needed.
2. **Configure and build:**

   ```bash
   npm install
   copy .env.example .env     # then fill in DISCORD_TOKEN and DISCORD_CLIENT_ID
   npm run build
   npm run deploy-commands
   npm start
   ```

   Set `DISCORD_GUILD_ID` while testing so commands appear instantly in one server. To let **other servers**
   use the bot, run `npm run deploy-commands:global` instead: it registers the commands for every server (Discord
   can take up to an hour to show them) and removes the single-server copies so nothing appears twice. Run it
   again whenever the commands change. The bot must also be set to **Public** in the Developer Portal. On
   Windows, if PowerShell says "running scripts is disabled", use `npm.cmd` instead of `npm`. Stop the bot with
   Ctrl-C.
3. **Invite the bot** (replace `YOUR_CLIENT_ID`). It needs View Channel, Send Messages, Embed Links and Read
   Message History:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=84992
   ```

## Admin guide

Only people with **Manage Server** can use `/setup`. **Naming the airline is an admin-only action**; pilots
never do it. Because the bot runs in your own server, Discord's Manage Server permission is the only gate: the
bot does not check anyone against an airline roster (it never contacts FsHub).

| Command | What it does |
|---|---|
| `/setup panel-add airline channel [prefix] [role]` | Name the airline (just type it, 2 to 60 characters, no `@`) and post its panel in a channel. Flight IDs look like `DMO-001`; the prefix is made from the name (initials) unless you set one. Optionally require a role to reserve. Typing a name already used here (any capitals) updates that panel instead of adding another; a server can host several airlines. |
| `/setup market [mode] [channel]` | Show the AeroDAQ in-game market in a channel, kept up to date (see [below](#aerodaq-fuel-prices-and-the-market)). With nothing given it says how things stand. |
| `/setup panel-role [role] [airline]` | Change which role can reserve on a panel. Leave the role empty to open it to everyone. |
| `/setup sheet link [airline]` | Read the panel's flights from your airline's Google Sheet schedule, every hour. `link:none` stops. |
| `/setup writeback [mode] [airline]` | Check, or switch on or off, writing pilots' names and completions to the panel's sheet (needs the [write-back setup](docs/WRITEBACK_SETUP.md)). |
| `/setup import file [airline]` | Replace the panel's flights from a CSV or JSON file. (Not available while a sheet is linked.) |
| `/setup template` | Download an example flights file (itself a valid import). |
| `/setup release code [leg] [airline]` | Free someone's reservation on a flight (they're told). |
| `/setup panels` | List panels with open flights and how many legs are reserved. |
| `/setup reminders [mode] [role] [cleanup] [airline]` | Choose who is pinged when a flight has no pilot 24 hours before it starts. **Auto** (the default) pings the role that can reserve, or @here if anyone can; or pick a role; or turn it off. `cleanup` (on by default) deletes each announcement at midnight UTC; `off` leaves them in the channel. With no options it shows the current setting. |
| `/setup refresh [airline]` | Re-fetch from an automatic source and redraw. |
| `/setup panel-remove airline` | Delete a panel with its flights and reservations. |

### Upgrading from a version that used FsHub

Nothing to do. The first start with the new version keeps every panel, flight and reservation. Admins who had
verified keep that FsHub pilot ID as their pilot ID; the cached airline list, the pending verifications and the
FsHub token are deleted. Panels are now named by the text the admin typed (existing ones keep the names and
abbreviations FsHub gave them). `/setup verify` no longer exists, and the FsHub token is no longer needed.

### AeroDAQ: fuel prices and the market

[AeroDAQ](https://aerodaq.com) is Aeroconomy's in-game market: a pretend stock market for aviation companies,
and fuel prices at airports. **None of it is real money or real stocks**, and everything the bot shows from it
says so. The bot reads AeroDAQ's public API (`https://aerodaq.com/api/v1`, no account or key) and sends nothing
about pilots, servers or airlines.

- **`/fuel airport:EGLL`** (anyone): the current fuel prices at an airport, jet fuel first, as price per kg, lb,
  US gallon and litre, how far above or below the airport's usual price it is, how full its tanks are, and when
  it last changed. The answer is private to whoever asked; add `share:True` to post it in the channel. The ICAO
  code is checked before anything is asked (three or four letters or digits); an airport AeroDAQ doesn't know
  gets a plain message. Answers are remembered for five minutes and one person can ask every few seconds, so a
  busy channel can't flood AeroDAQ.
- **`/setup market mode:on channel:#market`** (admins): posts the whole market as one message (a summary with the
  biggest gainers and losers, then a table per sector: symbol, name, price, change) and redraws it every 15
  minutes by editing it in place. If someone deletes it, the next refresh posts it again; if AeroDAQ is
  unreachable the old board stays and `/setup market` says why. The table is squeezed to fit Discord's limits
  (company names first, then rows). `mode:off` removes it. One board per server. It needs the same four channel
  permissions as a panel. The figures are percentages exactly as AeroDAQ shows them (`+0.13%`).

The bot only contacts AeroDAQ when someone uses `/fuel` or a server has a market board switched on.

### Who can reserve

By default anyone who can see the panel's channel can press **Reserve**, so channel permissions are the first
line of control. To go further, choose a role with the `role` option on `/setup panel-add`, or change it later
with `/setup panel-role` (leave the role empty to remove the requirement, or pick `@everyone`). The panel then
says "Reserving is open to members with @Role", and anyone without it who presses Reserve is told why. Server
admins can always reserve. The role only gates *starting* a reservation; people can still see the panel, view
**My flights** and give flights back.

### Reading your airline's Google Sheet

Many airlines coordinate flights in a spreadsheet. Link it with `/setup sheet link:<the sheet's address>` and
the bot reads it now and then every hour. Three rules keep this safe:

- **Share it as "Anyone with the link → Viewer."** Reading uses the public link, so the bot signs in to nothing;
  if the sheet isn't shared it says so and saves nothing. Only `docs.google.com` links are accepted, and the bot
  follows Google's own redirects only.
- **Reading never changes anything.** Unless you set up [write-back](#writing-to-the-sheet), the bot only reads:
  a pilot reserving through the bot shows on the Discord panel, not in the sheet, so someone still copies names
  across if the sheet is the airline's record.
- **Rows it can't read are skipped and reported**, never allowed to stop the rest. `/setup sheet`, `/setup refresh`
  and `/setup panels` list them with their row numbers.

The tab is found by its column headings, in any order. The layout it understands is one flight per row:

| Column | Used for |
|---|---|
| `Route` | `EGLL-EGCC` (one row per leg; `EGLL-EGCC-EGPH` would be two legs) |
| `Date` | the day the landing window opens, month first (`11/12/2026`) or `2026-11-12` |
| `Landing Window Zulu` | `0600-2359z`, ` 1200 - 0600z` (an end earlier than the start runs into the next day), weekday words ignored. Times are UTC and shown to each pilot in their own timezone. |
| `Pilot` | a name already against the flight. It shows on the panel as *(in the schedule)* and can't be reserved. `CANCELLED` closes the flight. |
| `Backup Pilot` | shown as a note on the flight |
| `Aircraft` | the required airframe |
| `Flight Completed (by Pilot)` | `TRUE` takes the flight off the open list and shows it on the panel as ✅ completed, with the pilot's name, for 24 hours (see below). A `CANCELLED` pilot is never shown as completed. |

Other columns (pay, profit, US Central times) are ignored. A sheet without a landing-window column must use the
columns of the flights file below. A flight keeps its bot ID and its reservations from one refresh to the next
as long as its route and date stay the same. If a reserved flight disappears from the sheet, its holder is told;
a flight whose *Flight Completed* box is ticked is not "removed", it is shown as completed.

### Pilot reminders

The announcement described above is on for every panel. Discord only lets a bot ping `@here` or a role that
isn't set to "mentionable" if the bot has the **Mention Everyone** permission in that channel, so grant it (or
make the role mentionable). Without it the message still appears, but nobody is notified. `/setup reminders`
warns you when that is the case. The check runs once a minute, a failed post is retried after an hour, and
nothing is posted for a panel whose channel the bot can't write in.

**The channel tidies itself at midnight.** The bot remembers each announcement it posts and deletes it at the
next midnight **UTC** (UTC because every flight time here is Zulu, whatever timezone the host's PC is set to), so
old pings don't pile up. An announcement posted at 12:00Z lives until 00:00Z; one posted at 23:55Z goes five
minutes later. If the bot was off over midnight it clears the old ones as soon as it starts. It only ever
deletes its own announcements (never the panel), treats one that someone already deleted as done, gives up on
one it can't delete rather than trying forever, and removes a panel's announcements when you remove the panel.
`/setup reminders cleanup:off` leaves them in the channel for that panel (`cleanup:on` turns it back on); it is
on by default, including for panels that existed before this feature. Flights are still announced only once,
so a flight whose announcement was cleared is not announced again unless it gets a pilot and later loses them.

### The flights file

CSV (first row is the header; only `legs` is required) or JSON (a list of objects with the same fields):

```csv
id,legs,aircraft,from,deadline,pay,notes
A-1001,EGLL-EGKK,A20N,2026-11-12 08:00,2026-11-14 23:59,"12,500",Quick hop
A-1002,EGLL-EGCC-EGPH,A320,2026-11-12 08:00,2026-11-15 20:00,"28,000","Two legs, can be shared"
```

- `legs`: airports in order. `EGLL-EGKK-EGCC` is **two legs** (EGLL to EGKK, then EGKK to EGCC).
- `aircraft` is the required airframe. `from` and `deadline` are **UTC**: `2026-11-12 18:30`, a bare date
  (a deadline then means the end of that day), or a Discord timestamp. `title`, `pay`, `notes` are optional.
- `id` is your own reference. **Keep it the same between imports** and the flight keeps its bot ID and its
  reservations. Without an `id`, a flight is matched on its legs, aircraft and times.
- Import the **full list each time**: flights missing from the file are closed. If any row is invalid the whole
  file is rejected with the row numbers, so a typo can never silently drop a flight.
- Flights already past their deadline are skipped, and open flights close automatically at their deadline.

### Writing to the sheet

Optional. With a Google service account the sheet's owner shares the sheet with, the bot also writes: a pilot's
name into the **Pilot** cell when they reserve, cleared when they give the flight back, and the **Flight
Completed** box ticked when they press **Complete**. It touches only those two cells of that flight's row, and
re-reads the tab and finds the row by route and date before every write. It refuses rather than overwrite if the
sheet already names someone else or shows the flight finished, and a *completion* is never recorded if the sheet
can't be updated, so the two never disagree. Names are written as plain text, never as formulas.

Setting it up needs credentials only a person can create: **[docs/WRITEBACK_SETUP.md](docs/WRITEBACK_SETUP.md)**
is the step-by-step (about ten minutes), and it suggests trying it on a copy of the sheet first.
`/setup writeback` checks it and can switch it off per panel. Without credentials nothing changes: the bot only
reads, and **Complete** on a sheet-fed panel explains that the box has to be ticked in the sheet.

## The refresh

A linked Google Sheet is re-read **every hour**; any other automatic source (the demo) every 24 hours (a
failed fetch keeps the existing flights, records the error in `/setup panels`, and retries hourly). Flights keep their IDs and reservations
across refreshes; new flights get the next ID; flights the source drops are closed and their holders told; a
flight whose route changed loses the reservation on the changed leg. Panels fed by file import don't fetch,
since an admin decides when the list changes. `/setup refresh` re-reads a sheet on demand.

## Demo mode

Try the whole flow without any real data:

```bash
npm run build
npm run demo
```

This is the real bot on real Discord with generated, fictional flights; demo data lives in `data/demo.sqlite`,
wiped on every start. The exceptions are `/setup sheet`, which works in demo mode too (so you can point a demo
panel at a real schedule sheet), and `/fuel` and `/setup market`, which read AeroDAQ's real public data. In your
server: `/setup panel-add airline:Demo Air channel:#somewhere`, then press **Reserve** on the panel (the bot asks
for a FsHub pilot ID; any number will do). Stop the normal bot first, since two copies of one bot would both answer.

## Data and privacy

SQLite file at `DATABASE_PATH` (default `data/bot.sqlite`). It stores server and channel IDs, the flights, and
per reservation the Discord user ID and username, plus any pilot name a linked Google Sheet shows against a leg
(taken from a sheet the airline shared publicly). With write-back on it also keeps, per Discord user, the name
that person goes by in airline sheets, and per reservation the name it wrote. It holds a Google service account
key only as a file path in `.env`; the key file itself stays wherever you put it. It also keeps, per Discord user,
the FsHub pilot ID that person typed (shown beside their name on flights they hold; never checked with anyone),
and per server the channel and message of an AeroDAQ market board if one is switched on. It holds no tokens or
passwords from users. Finished flights are forgotten a week after their deadline. Pilots must allow DMs from
server members for the Reserve conversation to work; if they haven't, the bot says how to turn it on.

**What the bot contacts**, and when: Discord (always); Google Sheets (`docs.google.com`, for a linked sheet, and
the Sheets API only if write-back is set up); `aerodaq.com` (only for `/fuel` or a market board);
`api.github.com` (the Windows app's daily update check, which can be switched off). It does not contact FsHub
or the Aeroconomy site, and never sends names, IDs or other personal data to any of them.

## Development

```bash
npm test              # 648 tests: import parser, Google Sheet reader and write-back (against a pretend Google), job rules, panel, DM conversation and FsHub pilot IDs, roles, refresh, reminders, database upgrades, AeroDAQ (against real captured responses), update check, host app (settings, setup page security, supervisor)
npm run typecheck     # src and tests
```

`src/services` and `src/jobs` know nothing about Discord; `src/discord` is the thin layer on top (the panel
renderer, the DM conversation, `/setup`, `/fuel`, the market board). `src/jobs/sheet.ts` is the Google Sheet
reader, `src/aerodaq` the AeroDAQ client, `src/host/updates.ts` the GitHub update check. The bot has no FsHub
client: a FsHub pilot ID is just a number a pilot types, stored and shown. A future Aeroconomy job feed would be a
new class in `src/jobs` with one `fetch` method.

## Licence

MIT. Third-party packages are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
