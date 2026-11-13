# Aeroconomy Flight Panel Bot

A Discord bot for virtual-airline communities. An admin names the airline; the bot keeps a **panel** in a
channel listing the airline's open flights (route, required airframe, when it must be completed by). Pilots
press **Reserve**, the bot DMs them, they reply with the flight's ID, and the panel shows their name (and
FsHub pilot ID) next to the flight. Multi-leg flights can be split between pilots leg by leg. It can also look
up fuel prices (`/fuel`) and show the AeroDAQ in-game market in a channel.

By UncappingBadger. Unofficial: not affiliated with, endorsed by, or sponsored by FsHub, Aeroconomy or AeroDAQ.

## How it works for pilots

1. A panel in the airline's channel lists the open flights, soonest deadline first. It shows the flights that are
   open now or start within the **next 7 days** (the server admin can set that to anything from 1 to 7 days per
   panel with `/setup window`): a schedule often runs for weeks, and all of it would bury the flights that can be
   flown soon. A line at the end says how many are further off, and they appear on their own once they come within
   the period. (Only the panel is limited: a flight further off can still be reserved by typing its ID.) Below the open flights is a separate panel of the flights completed lately (see
   [below](#how-it-works-for-pilots)), so they never crowd the ones that need a pilot. Each flight is its own **card**
   (an embed with a coloured stripe: amber while a leg still needs a pilot, blue once every leg is taken, green once it
   has been flown), with the route in large type, labelled boxes and who has it, and a gap between cards so flights are
   easy to pick out; a message holds up to 10 cards, so a long list takes several messages, each with the buttons:

   ```
   DMO-004 · 2 legs · A320                      (amber stripe: a leg still needs a pilot)
   EGLL ✈ EGCC ✈ EGPH                           (the route, in large type)
   COMPLETE BY: Sat 14 Nov 18:00 (in 3 days)    PAY: 28,000
   PILOTS: 1 EGLL → EGCC — @alice · FsHub #4821
           2 EGCC → EGPH — open
   ```
2. Press **Reserve**. The bot DMs you. The first time it asks for your **FsHub pilot ID** (see below); after
   that it goes straight to: *"Reply with the flight ID shown on the panel."*
3. Reply with the ID (`DMO-004`, `dmo4` and `4` all work; where your airline's schedule gives flights their own
   numbers, such as `SKY123`, that number is the ID: see [Flight numbers](#flight-numbers)).
4. One-leg flight: you're booked and the panel updates. Several legs: the bot asks **All legs** or **Some
   legs**. For some, pick from a menu of the legs still free. If you ask for all but someone holds a leg, it
   tells you who and offers the legs that are free.
5. **My flights** (under the panel) shows what you hold and lets you give flights back. You can also **DM the
   bot `flights`** (or `my flights`, `list`) at any time to get the same list, for every panel you have flights on,
   with the same menu to give flights back. Each flight shows when it opens and when it must be completed by (with the day of the week, in your own timezone). Say `cancel` in the DM at any point to stop. A conversation closes after
   10 minutes.
6. **Complete** (under the panel) is for when you've flown it. On a panel linked to the airline's FsHub (see
   [Completing from FsHub](#completing-from-fshub)) the bot checks FsHub for your landing and completes the
   flights it shows you flew; there is nothing to pick. Otherwise you pick the flights, confirm, and the panel
   shows them as completed. You have to hold every leg of a flight to complete it, and you can still do it for
   two days after its window closes. On a FsHub-linked panel you don't even have to press it: **once an hour** the
   bot completes the flights FsHub shows you flew and sends you a DM saying so (see
   [Completing automatically](#completing-automatically-every-hour)).

**Looking for a flight.** **Search** (under the panel) opens a small form with three optional boxes: where you want to
fly **from**, where you want to fly **to**, and the **date**. Fill in any of them, one or together, using the airport codes
shown on the panel (`EGLL`; several are fine, `EGLL EGKK`; two or three letters match every airport starting with them, so
`EG` finds EGLL, EGKK and the rest). The bot answers privately with the matching flights as the same cards the panel shows,
so you can see at a glance which still need a pilot, then you press **Reserve** and reply with the ID. A flight with several
legs matches when it leaves from the first airport and later arrives at the second (`LFPG` to `EDDF` finds
`LFPG → EHAM → EDDF`).

The **date** finds the flights you could fly on that day. Type `today`, `tomorrow`, a weekday (`sat`), `14 Nov`, `14/11`
(day first) or `2026-11-14`. Dates are **Zulu (UTC)**, the same as the flight times, so a flight counts for a day if it is
open at some point between 00:00 and 24:00 Zulu that day. A date on its own shows everything that can be flown that day.
**A search only looks as far ahead as the panel does**: the days your admin chose with `/setup window`, so it never finds
flights the panel doesn't list, and a date further ahead than that is turned down with the last day it can search. It shows
the first eight matches and asks you to narrow it down if there are more.

**Backup pilot.** **Backup pilot** (under the panel) lets you put yourself down as the backup for a flight that is already
taken, so there is someone ready if the pilot who has it can't fly it. It works the way **Reserve** does: the bot sends you
a DM asking for the ID of the flight (the first time it asks for your FsHub pilot ID too), and you reply with it. A flight
needs every leg taken (until then you can simply reserve the free legs), you can't back up a flight you're flying, and each
flight has one backup; if the flight you name can't be backed up, the bot says why and you can send a different ID. The
panel shows the backup's name on the flight (*BACKUP*). If the pilot gives the flight back, an
admin frees it, or the airline drops it, the bot DMs the backup that their spot has ended (and, if it's open again, that
they can take it). Stand down any time from **My flights**. The backup is not made the pilot automatically: they
press **Reserve** if they still want the flight. A backup named in the sheet's *Backup Pilot* column still shows as a note on
the flight; a Discord backup is not written to the sheet. Where a role is needed to reserve, it is needed to be a backup too.

**My contributions.** **DM the bot `my contributions`** to see what the flights you completed made for the airline over the
last 7 days (today and the six days before it, Zulu). The bot reads the airline's linked Google Sheet, finds the flights
ticked as completed under your name, and adds up the airline's profit from them, taken from the sheet's *Profit Made*
column, which the managers fill in (a loss counts as a loss). Each flight is listed with its ID, route, day and profit.
**A flight you completed that has no profit entered yet** isn't left out silently: the bot names it by ID, and the total is
marked as only what it can see so far, so it changes once the managers enter the rest. Your name in the sheet is the one
you gave with `name <your name>`, otherwise your Discord name, so if the sheet has you under another name, send `name` first.
It only answers for airlines in servers you are in, and needs the airline's sheet to be linked (`/setup sheet`) and to have
a *Profit Made* column.

If a flight is removed, its route changes, or an admin frees it, the people affected get a DM.

**Your FsHub pilot ID.** So an airline's managers can match a Discord account to the right pilot on their FsHub
roster, even when the names differ, the bot asks for your FsHub pilot ID the first time you press **Reserve**. It
is the number in your profile address (`fshub.io/pilot/`**`1234`**`/overview`); you can reply with the number or paste
the link. It is remembered, shown as `FsHub #1234` next to your name on every flight you hold (and on completed
flights), and not asked for again. Change it any time by DMing the bot `fshub <your ID>`; the panels redraw
with the new number. It is not written to the Google Sheet.

Two things change if the person running the bot has connected it to FsHub (see [FsHub](#fshub-optional)):

- The bot **checks the ID with FsHub** and tells you whose profile it is (*"I've saved your FsHub pilot ID as
  **1234** (Alex Smith on FsHub)"*), so a typo is caught straight away. An ID FsHub has never heard of is not
  accepted. The name is then shown beside the number: `FsHub #1234 (Alex Smith)`.
- If your airline's FsHub roster lists your Discord account, the bot already knows who you are and **never asks**.

Without that connection the bot never contacts FsHub: the ID is exactly what the pilot typed, and managers compare
it with their roster.

**Completed flights are shown.** A flight completed with the **Complete** button, or whose *Flight Completed* box
is ticked in a linked Google Sheet, leaves the open list and appears in the panel of **✅ completed flights** below
it (the last message of the panel, with no buttons, saying *Completed in the last 24 hours*; when there is nothing to
show it says so), as `✅ DMO-004 · EGLL → EGCC · ✈ A320 · flown by <name>`. The name is the Discord person who
reserved it, the pilot named in the schedule, or both. It can no longer be reserved or released, and nobody is
DM'd that it was "removed". After a day it drops off the panel. A box ticked in the sheet is noticed the next
time the sheet is read (every hour, or straight away with `/setup refresh`), and the day is counted from then.
Flights that were completed long before a sheet was linked are not listed. On a panel linked to the airline's
FsHub, a completed flight also shows the aircraft FsHub recorded for it (see [Confirming flights](#fshub-optional)).

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
   works at once. There is no `.env` file and no script to run. (A FsHub token can be added on the same page,
   but only if you want the [FsHub features](#fshub-optional); nothing needs one.)
3. The icon's colour shows the state (green online, amber starting or needs setup, red needs attention). The
   menu opens the setup page, copies the invite link, shows the log and data folder, restarts the bot, switches
   **Start with Windows** on or off, and quits.

Settings, the database and logs live in `%APPDATA%\FlightPanelBot`. The setup page listens on this computer
only, needs a secret key that only the tray program knows, and refuses requests that did not come from its own
page, so nothing else on the machine can read the token or change it. The token is kept in that folder as
plain text, protected by the Windows account's own folder permissions, like the `.env` file would be, and so is
the optional FsHub token. (An older version kept a FsHub token there under another name, `fshubToken`, for a
feature that no longer exists; the app removes it on first start and never uses it, so a token is only ever used
for what its owner pasted it in for. Paste a token again in the FsHub section if you want the new features.)

**New versions.** Once a day (and on the setup page's **Check for updates** button) the app asks GitHub's public
"latest release" page for this project whether a newer version exists. If so, the tray shows a pop-up once, the
menu gets **A new version is available: vX** (opens the release page), and the setup page shows a banner. It
never downloads or installs anything: the host downloads the new `FlightPanelBot.exe` from the release page,
quits the old one from the tray and runs the new one; settings and data carry over. The check sends only an
ordinary HTTPS request naming the app and its version (`FlightPanelBot/0.1.3`) and can be switched off on the
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
bot does not check anyone against an airline roster (the optional [FsHub connection](#fshub-optional) only
matches pilots to their IDs; it never decides who may use the bot).

| Command | What it does |
|---|---|
| `/setup panel-add airline channel [prefix] [role]` | Name the airline (just type it, 2 to 60 characters, no `@`) and post its panel in a channel. Flight IDs look like `DMO-001`; the prefix is made from the name (initials) unless you set one. Optionally require a role to reserve. Typing a name already used here (any capitals) updates that panel instead of adding another; a server can host several airlines. |
| `/setup market [mode] [channel]` | Show the AeroDAQ in-game market in a channel, kept up to date (see [below](#aerodaq-fuel-prices-and-the-market)). With nothing given it says how things stand. |
| `/setup fshub [link] [confirm] [autocomplete] [airline]` | Link a panel to your airline's FsHub roster so pilots are matched to their pilot IDs without being asked, and completed flights show the aircraft FsHub recorded (needs a [FsHub token](#fshub-optional)). `link` is the airline's short name (e.g. `SKY`), its FsHub number or a link to its page; `link:none` stops. `confirm:off` stops reading the airline's flights, which also returns **Complete** to the pilot-picks mode. `autocomplete:off` stops the [hourly automatic completion](#completing-automatically-every-hour) (on by default); `autocomplete:on` turns it back on and checks now. With no options it reads the roster and flights now and runs the check. |
| `/setup panel-role [role] [airline]` | Change which role can reserve on a panel. Leave the role empty to open it to everyone. |
| `/setup sheet link [airline]` | Read the panel's flights from your airline's Google Sheet schedule, every hour. `link:none` stops. |
| `/setup writeback [mode] [airline]` | Check, or switch on or off, writing pilots' names and completions to the panel's sheet (needs the [write-back setup](docs/WRITEBACK_SETUP.md)). |
| `/setup import file [airline]` | Replace the panel's flights from a CSV or JSON file. (Not available while a sheet is linked.) |
| `/setup template` | Download an example flights file (itself a valid import). |
| `/setup release code [leg] [airline]` | Free someone's reservation on a flight (they're told). |
| `/setup panels` | List panels with open flights and how many legs are reserved. |
| `/setup reminders [mode] [role] [cleanup] [airline]` | Choose who is pinged when a flight has no pilot 24 hours before it starts. **Auto** (the default) pings the role that can reserve, or @here if anyone can; or pick a role; or turn it off. `cleanup` (on by default) deletes each announcement at midnight UTC; `off` leaves them in the channel. With no options it shows the current setting. |
| `/setup window [days] [airline]` | Choose how many days ahead the panel lists flights, from **1 to 7** (a new panel shows 7). The panel lists the flights that are open now or start within that many days; later ones are counted in a line at the end and appear once they come within the period. Pilots can still reserve a flight that is left off by typing its ID. With no `days` it shows the current setting and how many flights are left off. `/setup panels` shows it too. |
| `/setup refresh [airline]` | Re-fetch from an automatic source and redraw. **Always sends every panel message again**, even for a panel with no sheet (file imports), so a panel posted by an older version of the bot picks up whatever is new (new buttons, a new look) with no need to remove and re-add it. The bot also redraws every panel each time it starts. |
| `/setup panel-remove airline` | Delete a panel with its flights and reservations. |

### Upgrading from a version that used FsHub

Nothing to do. The first start with the new version keeps every panel, flight and reservation. Admins who had
verified keep that FsHub pilot ID as their pilot ID; the cached airline list, the pending verifications and the
old FsHub token are deleted. Panels are now named by the text the admin typed (existing ones keep the names and
abbreviations FsHub gave them). `/setup verify` no longer exists, and no FsHub token is needed (a new, optional
one adds [extras](#fshub-optional); the old one is not reused).

### FsHub (optional)

Everything works without FsHub. With a FsHub **personal access token** the bot does three extra things, all
read-only (it never sends anything to FsHub except requests for information, and never changes anything there):

1. **Checks the pilot IDs people type**, and learns the name FsHub has for each (`GET /pilot/{id}`), as described
   [above](#how-it-works-for-pilots).
2. **Reads your airline's roster** (`GET /airline/{id}/pilot`) once an hour for each panel linked with
   `/setup fshub`. FsHub's roster lists each pilot's Discord account when they have given it in their profile, so
   those pilots are known without being asked. `/setup fshub link:SKY` links a panel (the name is looked up among
   the airlines the token's own account belongs to; a number or a link to the airline's page also works) and
   reports how many pilots it found and how many are matched. `/setup panels` shows the link and any warning.
3. **Shows the aircraft that was flown, and completes flights from FsHub's record.** For a linked panel it also reads
   the airline's recent flights (`GET /airline/{id}/flight`, about every five minutes, and again when a pilot
   presses **Complete**). A flight shows up on FsHub about a minute after landing. See [below](#confirming-flights);
   it changes what the **Complete** button does on that panel ([Completing from FsHub](#completing-from-fshub)).

**Confirming flights.** A completed flight on the panel then ends with what FsHub recorded:
`✅ WA-009 · KMIA → KBOS · ✈ A333 · flown by … · 🛬 FsHub: A333 (Airbus A330-300), landed 01:26 · on time · flight #1796723`,
where the last part is FsHub's own number for the flight, linked to its report on fshub.io (a flight with several legs
shows one link per leg). It is a link only: the bot's flight IDs (`WA-009`) stay as they are, because they are needed
before a flight is flown and FsHub's number only exists once it has landed. The aircraft is the one FsHub recorded (so it can differ from the scheduled one, and a different type is flagged:
`⚠️ scheduled B738`), the landing time is shown in each reader's own timezone, and `on time`, `delayed` or `late`
is FsHub's own word for how the flight went against its schedule (left out when FsHub has none). Under **My
flights** a pilot is told which of their flights FsHub already shows as flown.

FsHub's flight records carry no job ID, so this is **matching, not a lookup**, and it is deliberately cautious. A
FsHub flight confirms a scheduled flight when it went between the same two airports and landed inside the flight's
window (an hour either side). If the pilot holding the flight has a known FsHub ID, only a flight by that pilot
counts. If not (a pilot named in the schedule sheet, say) it counts only when it is the single candidate: two
flights that could both be it means nothing is claimed rather than something wrong. One FsHub flight confirms at
most one scheduled flight. The aircraft is shown, not required: a pilot who flew another type still flew it. If
FsHub has not recorded a flight (the client was not running, the airports differ), nothing is added; its absence
proves nothing. FsHub's aircraft type is whatever the pilot's client detected, and pilots can ask FsHub to correct
it.

#### Completing from FsHub

**The Complete button has two modes.** The bot is *working from FsHub* on a panel when it has a FsHub token, the panel
is linked to the airline's FsHub (`/setup fshub`), and reading flights is on (`confirm:on`, the default). Then
**Complete** is one press with nothing to pick:

1. The bot brings the airline's FsHub flights up to date if they are more than half a minute old (so a landing from a
   minute ago is there), and looks at the flights the pilot holds that have started.
2. A flight FsHub shows flown (see the matching rules above, but **strict**: the pilot's FsHub ID must be known and the
   flight must be theirs; a lone flight by someone else never counts) is marked completed at once, with what FsHub
   recorded: `✅ WA-009 (KMIA → KBOS) is completed from FsHub: A333 (Airbus A330-300), landed 01:26 · on time`. Where
   the panel's Google Sheet is written to (write-back), the flight is also ticked there, as it always was.
3. A flight FsHub has not shown is left alone and the pilot is told why: `⏳ I can't see WA-010 (KBOS → KMIA) on FsHub`,
   the window it has to have landed in, and that a flight shows up about a minute after landing. A flight with several
   legs needs every leg shown. Flights that have not started are not looked at.

Things this deliberately does and doesn't do:

- **A pilot whose FsHub ID the bot doesn't know** is asked to DM `fshub <your ID>` first. An ID someone *typed* is only
  their word: if the airline's FsHub roster says that pilot is a different Discord account, the bot refuses to
  complete flights for it. An ID from the roster, or a typed one the roster doesn't contradict, is accepted.
- **If FsHub can't be read** (down, token refused) nothing is completed and the pilot is told to try again; it does not
  fall back to taking their word for it. **There is no manual completion on such a panel**: a flight FsHub never
  recorded (the pilot's FsHub client wasn't running) can't be completed with the button; a manager ticks it in the
  sheet, or an admin switches the panel to the other mode with `/setup fshub confirm:off`.
- **A flight completed this way is kept completed** even if the airline's sheet is never ticked, so a bot that can't
  write to the sheet (no service account) works too: it used to refuse Complete there, and a completion the pilot only
  claimed was undone by the next sheet read after ten minutes. The reply says the sheet still shows it as not done.
- Pickers and confirm buttons left over from before the panel was linked to FsHub do nothing but point to **Complete**.

**Without the link (the other mode)**, Complete is as it always was: the pilot picks the flights they flew, confirms,
and the panel shows them as completed, with the bot writing the name and the *Flight Completed* tick into the airline's
Google Sheet where write-back is set up. A sheet panel the bot can't write to still refuses, as before. This is also what
you get with no FsHub token, an unlinked panel, or `/setup fshub confirm:off`.

#### Completing automatically, every hour

On a panel the bot is *working from FsHub* on (the same conditions), the bot doesn't wait to be asked. **Every hour** it
looks at every flight a pilot holds on the panel that has started, brings the airline's FsHub flights up to date first,
and completes the ones FsHub shows were flown: exactly what pressing **Complete** does, for everybody at once, with the
same strict rules (the pilot's FsHub ID must be known, an ID the roster gives to another Discord account is refused, the
pilot must hold every leg, and FsHub must show each leg flown between the right airports inside the flight's window). It
also leaves alone a flight only the airline's sheet names a pilot for, because nothing says whose it is.

- **The pilot is told.** One DM per pilot per check, however many flights it completed: *"FsHub shows you flew a flight
  for **Example Air**, so I marked it completed"*, with the aircraft and landing time, and that there is nothing to do. A
  pilot with DMs closed is simply not told; the flight is still completed.
- **The sheet is ticked too** where write-back is set up, before the flight is marked completed. If the sheet won't
  accept it (it names someone else for that flight, say) the flight is left alone.
- **If FsHub can't be read** nothing is completed and the check is tried again in ten minutes rather than an hour.
- **Pressing Complete still works** and is instant; the hourly check is for pilots who don't press it.
- **An admin can switch it off** per panel: `/setup fshub autocomplete:off` (pilots can still press Complete, and
  completed flights still show what FsHub recorded); `autocomplete:on` turns it back on and checks straight away. It is
  on by default for a panel working from FsHub, and the panel's instructions say so while it is. `/setup panels` shows
  whether it is on and when it last checked. `/setup fshub` with no options also runs the check now and says what it found.
- A flight completed this way is pinned like one completed with the button, so a sheet that is never ticked doesn't undo it.

`/setup fshub confirm:off` stops the reading and deletes the flights the bot had kept; `confirm:on` starts it again.
The kept flights (airline's pilots' FsHub ID and name, route, take-off and landing time, aircraft, schedule status)
are forgotten a week after they land. The first read finds the last week by searching FsHub's list (about 20
requests) and later reads ask for what is new (1 request); the bot reads a little further back each time because
FsHub lists a flight only once it has landed.

**Getting a token.** The person running the bot creates one at <https://fshub.io/settings/integrations> and pastes
it into the setup page's *FsHub* section (or `FSHUB_TOKEN` in `.env` when running from source). It is checked with
FsHub when saved and then kept like the Discord token; the page never shows it again. **A token acts as the FsHub
account that made it**, so keep it private and use an account that belongs to your airline: FsHub only shows an
airline's roster to its members (and premium accounts). It can be deleted on that page at any time, and removed
from the bot with **Remove token**.

**What is and isn't replaced.** An ID a pilot typed themselves is never replaced by the roster's. An ID taken from
the roster is replaced the moment the pilot types one. Roster entries without a Discord account are ignored. The
roster's names, FsHub IDs and Discord IDs for pilots who have a Discord account listed are kept in the bot's
database (on the host's own computer) so they can be recognised when they press Reserve; nothing else from
FsHub is kept.

**If FsHub can't be reached** (down, token refused, busy) nothing stops working: typed IDs are accepted unchecked,
the roster is tried again (after about ten minutes, then every hour), and `/setup panels` shows what went wrong.
FsHub allows 100 requests per minute; the bot keeps itself to 40 and normally makes about a dozen an hour per
linked panel.

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
| `Flight Number` (optional) | the airline's own number for the flight, such as `SKY123` or `SKY-014`. **When it is there it is the flight's ID**: it is what the panel shows and what pilots type to reserve (any case, spaces ignored). A flight with no number keeps the bot's own ID (`WA-031`), so the two can be mixed. The column can also be headed `Flight No`, `Flight #`, `Flight ID`, `Flight Num` or `Flt No`. See [Flight numbers](#flight-numbers) below. |

Other columns (pay, profit, US Central times) are ignored. A sheet without a landing-window column must use the
columns of the flights file below. A flight keeps its bot ID and its reservations from one refresh to the next
as long as its route and date stay the same. If a reserved flight disappears from the sheet, its holder is told;
a flight whose *Flight Completed* box is ticked is not "removed", it is shown as completed.

#### Flight numbers

If the sheet has a *Flight Number* column, the number on a flight's row becomes that flight's ID in place of the bot's
own `PREFIX-NNN` one. The rules, so nothing surprising happens:

- **A flight with a number uses it; a flight without one keeps the bot's ID**, exactly as before. A sheet with no such
  column behaves as it always has.
- **A usable number** is letters, numbers and dashes, up to 16 characters (`SKY123`, `SKY-014`, `sky 123` becomes
  `SKY123`). Anything else (`SKY*1`, a long text) can't be an ID, because the ID is typed by pilots and put in messages:
  that flight keeps its automatic ID and the row is reported in `/setup sheet`, `/setup refresh` and `/setup panels`.
- **A number has to name one flight.** A number that is on two or more rows (the same flight flown on several days)
  gets the day on the end of each of those flights, in the aviation way: `SKY123` on 12 November and 13 November
  become `SKY123-12NOV` and `SKY123-13NOV`. Pilots type that whole ID. A number that is on one row stays as it is. If
  it still can't tell the flights apart (the same number twice on the same day, or a dated number another row already
  is), none of those flights uses it: they keep their automatic IDs and the sheet read says so. Because a flight's ID
  follows its number, it changes if the number starts being repeated (a new row for the same number) or stops being
  repeated (the other rows are cleared out); the flight and its reservations stay the same.
- **Adding numbers later is fine.** A flight the bot already knows by its automatic ID takes the number once it appears
  in the sheet, keeping its reservations. A number changed in the sheet changes the ID. A number taken away leaves the
  ID as it was (IDs don't change back and forth).
- **Pilots type it however they like**: `sky123`, `SKY 123` and `SKY123` all find the flight. The bot's own IDs keep
  their short forms (`WA-7`, `7`), and when a flight number happens to be `7`, `7` means that flight.
- **No two flights on a panel share an ID.** If a number is already the ID of another flight on the panel (including an
  automatic one), the new flight keeps its other ID for now and the sheet read says so; it takes the number when the
  clash is gone. The bot's automatic numbering skips any ID a flight number is using.
- The panel's instructions give a real flight's ID as the example, so they read correctly whichever IDs the panel uses.

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
reads, and **Complete** on a sheet-fed panel explains that the box has to be ticked in the sheet (unless the panel
[works from FsHub](#completing-from-fshub), where Complete works from FsHub's record without write-back).

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
the FsHub pilot ID that person typed or that their airline's FsHub roster lists, with the name FsHub has for it
(shown beside their name on flights they hold), and per server the channel and message of an AeroDAQ market
board if one is switched on. If a panel is linked to a FsHub roster, the airline's FsHub flights of the last week
are kept too (pilot ID and name, route, times, aircraft), until `/setup fshub confirm:off` or a week after landing,
and that roster's pilots who have a Discord
account listed (name, FsHub ID, Discord ID) are kept the same way. It holds no tokens or passwords from users. Finished flights are forgotten a week after their deadline. Pilots must allow DMs from
server members for the Reserve conversation to work; if they haven't, the bot says how to turn it on.

**What the bot contacts**, and when: Discord (always); Google Sheets (`docs.google.com`, for a linked sheet, and
the Sheets API only if write-back is set up); `aerodaq.com` (only for `/fuel` or a market board);
`api.github.com` (the Windows app's daily update check, which can be switched off); and `fshub.io`, **only if
the host saved a FsHub token** (to check a typed pilot ID and to read a linked airline's roster and recent flights; read-only, the
token travels in a request header to `fshub.io` and nowhere else). It does not contact the Aeroconomy site, and
never sends names, IDs or other personal data to anyone: the only thing asked of FsHub about a person is the
pilot ID they typed.

## Development

```bash
npm test              # 1103 tests: import parser, Google Sheet reader and write-back (against a pretend Google), job rules, panel (open flights, completed flights, the 1-to-7-day period, overlapping redraws), DM conversation and FsHub pilot IDs, FsHub client, roster sync, flight confirmation and the hourly automatic completion (against a pretend FsHub), the scheduler, roles, refresh, reminders, database upgrades, AeroDAQ (against real captured responses), update check, host app (settings, setup page security, supervisor)
npm run typecheck     # src and tests
```

`src/services` and `src/jobs` know nothing about Discord; `src/discord` is the thin layer on top (the panel
renderer, the DM conversation, `/setup`, `/fuel`, the market board). `src/jobs/sheet.ts` is the Google Sheet
reader, `src/aerodaq` the AeroDAQ client, `src/fshub` the read-only FsHub client (GET only, fixed host, token in a
header, own request budget; `src/services/fshubSync.ts` reads linked rosters), `src/host/updates.ts` the GitHub
update check. The FsHub client is optional: with no token `ctx.fshub` is null and nothing contacts FsHub. A future
Aeroconomy job feed would be a new class in `src/jobs` with one `fetch` method.

## Licence

MIT. Third-party packages are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
