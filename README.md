# Aeroconomy Flight Panel Bot

A Discord bot for virtual-airline communities. An admin names the airline; the bot keeps a **panel** in a
channel listing the airline's open flights (route, required airframe, when it must be completed by). Pilots
press **Reserve**, the bot DMs them, they reply with the flight's ID (or they skip the button and DM the bot the ID), and the panel shows their name (and
FsHub pilot ID) next to the flight. Multi-leg flights can be split between pilots leg by leg. It can also look
up fuel prices (`/fuel`), show the AeroDAQ in-game market in a channel, and keep a weather board in a channel: a grid of airports, press one for its METAR.

By UncappingBadger. Unofficial: not affiliated with, endorsed by, or sponsored by FsHub, Aeroconomy, AeroDAQ or VATSIM.

## How it works for pilots

1. A panel in the airline's channel lists the open flights, soonest deadline first. It shows the flights that are
   open now or start within the **next 7 days** (the server admin can set that to anything from 1 to 7 days per
   panel with `/setup window`): a schedule often runs for weeks, and all of it would bury the flights that can be
   flown soon. A line at the end says how many are further off, and they appear on their own once they come within
   the period. (The period limits what a pilot can reach, not only what is drawn: a flight further off cannot be
   reserved, stood by for or searched for, and typing its ID does not get round that.) Below the open flights is a separate panel of the flights completed lately (see
   [below](#how-it-works-for-pilots)), so they never crowd the ones that need a pilot (the server admin can give them
   a channel of their own with `/setup completed`). Each flight is its own **card**
   (an embed with a coloured stripe: amber while a leg still needs a pilot, blue once every leg is taken, green once it
   has been flown), with the route in large type, labelled boxes and who has it, and a gap between cards so flights are
   easy to pick out. **You can tell at a glance whether a flight is open:** a flight that still needs a pilot wears a
   green, worn-ink **OPEN** stamp in the card's corner; once it is taken, the stamp gives way to its pilot's own Discord
   picture, with their name (a mention, which opens their profile) and FsHub ID beside it. A backup pilot gets the same
   in a smaller size: their picture on a line above the card, linking to their profile, and their name and FsHub ID in
   the card. (Discord does not let a picture in a message be a link itself, which is why the name beside it is the
   link.) Every date and time on a card, in the list view and in the "pilots needed" announcements shows the **day of the
   week** as well (in your own timezone), so nobody mistakes the 13th for the 14th. A message holds up to 10 cards, so a long list takes several messages, each with the buttons:

   ```
   DMO-004 · 2 legs · A320                      (amber stripe: a leg still needs a pilot)
   EGLL ✈ EGCC ✈ EGPH                           (the route, in large type)
   COMPLETE BY: Sat 14 Nov 18:00 (in 3 days)    PAY: 28,000
   PILOTS: 1 EGLL → EGCC — @alice · FsHub #4821
           2 EGCC → EGPH — open
   ```
2. Press **Reserve**. The bot DMs you. The first time it asks for your **FsHub pilot ID** (see below); after
   that it goes straight to: *"Reply with the flight ID shown on the panel."* **Or skip the button**: DM the bot the flight ID
   yourself (see [Reserving straight from a DM](#reserving-straight-from-a-dm)).
3. Reply with the ID (`DMO-004`, `dmo4` and `4` all work; where your airline's schedule gives flights their own
   numbers, such as `SKY123`, that number is the ID: see [Flight numbers](#flight-numbers)).
   **To reserve several flights at once, send all their IDs in one message**: `DMO-004, DMO-007, DMO-011`, or one to a
   line, or with `and`, `&`, `;` or a space between them. The bot reserves each one-leg flight straight away, as if you
   had sent it alone (the airline's sheet gets your name against each), and answers once, saying how every flight went:
   reserved, already yours, taken by someone (and who), no open flight with that ID, or too far ahead to book yet. The
   same flight written twice, or in two ways (`DMO-004` and `4`), counts once, and the words around the IDs ("please
   reserve ...") are ignored. A flight with several legs is not taken for you in a batch, because the bot has to ask
   which legs you want; it names those flights and keeps the conversation open, so you send each one on its own and
   answer the usual buttons. Up to 10 flights are taken from one message; the bot lists any it did not get to so you
   can send them again. (Standing by as backup is still one flight at a time: send more than one ID there and the bot says so.)
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
7. **List view** (a second row of buttons under the panel) is for people who prefer a plain list to cards. It posts
   the panel to you as a list in your DMs (each flight as a few lines of text, then the flights completed lately) and
   **keeps it up to date there**: whenever the panel changes, your list changes with it, in the same messages (quietly,
   with no notification). The list is for reading: its only button is **Stop updates**, which takes it away, and it
   points you back to the panel's buttons for reserving, searching and the rest. It is for you alone: the panel in the
   channel does not change for anyone else. Press **List view** again to get a fresh copy at the bottom of the DM. **`/hideunavailable`** (anyone can use it) hides, for you only, the flights that are no longer available to you from your list view and your searches: the ones already taken by others (every leg held in Discord or named in the schedule) and the completed ones. Flights you hold or stand by for stay. It switches on and off (`mode:on`, `mode:off`, or just run it again), and a list you already have is redrawn to match. The panel in the channel is one message everybody shares, so Discord cannot show it differently to one person. At most 200 people can have a list of one panel at once, and one is dropped if the person leaves the
   server, can no longer see the panel's channel (checked every half hour) or closes their DMs to the bot. If the
   admin has put completed flights in a channel of their own, the list leaves them out and says where they are.
8. **Notifications** (DM the bot **`notifications`**) lets each person choose which of the bot's *optional* private
   messages they get. There are three, all on until you switch them off: **Flights completed for you** (the DM saying the bot
   marked a flight completed from FsHub; the flight is still completed, you are just not told), **Take-off warnings** (the
   late-departure heads-up, both to a pilot and to a backup) and **Hard-landing remarks** (a light-hearted message when FsHub
   shows you landed very hard; see *Remarks about very hard landings* below; an airline that links pay to landing safety also sends a
   *safety notice* first, and that one is not optional, see *Landing safety and pay*). The reply shows each as on or off with a button
   to switch it, or you can type `notifications completed off`, `notifications takeoff on`, `notifications landing off`,
   `notifications off` (all three) or `notifications on`. It is yours alone and covers every airline you fly for, and each of
   these messages carries a line saying how to switch it off.
   **What the bot tells you about your reservations always stays on**: a flight of yours released or removed, a backup spot
   that ended, a manager changing your FsHub pilot ID, and every answer to something you did yourself (reserving, the buttons,
   your commands). A warning switched off is not counted as sent, so switching it back on before the latest take-off still
   warns you in time.
9. **Commands** (DM the bot **`commands`**, or run **`/commands`** in a server) lists everything you can do with the bot **at your
   level**: what a DM understands (`reserve`, `backup`, `flights`, `my contributions`, `metar`, `notifications`, `name`, `fshub`,
   `/banking`, `/monitor`, `cancel`), the commands anyone can use in a server, and, for each server you share with the bot,
   whether you are a member (and which airlines you may reserve for, naming the role one needs when you lack it), a **manager**
   (a role the admins chose with `/setup refresh-roles`: `/setup refresh` and `/setup id-add`) or a **server admin** (Manage Server:
   every `/setup` command, each with what it does). The list is read from the commands themselves, so it cannot fall behind them;
   a long one comes as several messages, and in a server it is shown only to you. `help` works in a DM too.

### A flight number flown on more than one day

When the same flight number is flown on several days, each of those flights carries its day (`SKY216-21NOV`, `SKY216-22NOV`), so
the ID names one flight. A pilot who types just the number (`SKY216`) is **asked which day**, in the DM, instead of being told the
flight cannot be found:

```
SKY216 is flown on more than one day. Which one do you want to reserve?
• SKY216-21NOV · Sat 21 Nov · EGLL → EGKK · open
• SKY216-22NOV · Sun 22 Nov · EGLL → EGKK · taken
Press a day below, or reply with the date (like 21 Nov) or the full ID. Days are Zulu (UTC), like the IDs. Say cancel to stop.
[Sat 21 Nov · EGLL → EGKK] [Sun 22 Nov · EGLL → EGKK] [Cancel]
```

- **Answer with a button, a date or the full ID.** A date is read the way the Search form reads one (`21 Nov`, `21NOV`, `Sat 21 Nov`, `21/11`,
  `tomorrow`) as a Zulu day, and the flight on that day is taken. A date that is not a day of that flight is said so and the question
  is asked again (five misses close the conversation, as five wrong IDs do). Anything else is read as a new flight ID, and the question
  is over.
- **It is asked wherever a flight is reserved or stood by for**: after the **Reserve** or **Backup pilot** buttons, and when the ID is sent
  straight in a DM (`SKY216`, `reserve SKY216`, `backup SKY216`). The question says *reserve* or *stand by for*, and shows what each day is
  (open, taken, still has a free leg, has a backup). Whichever day is chosen then goes through every rule of a typed ID (legs, the airline's
  sheet, the panel's days, who has it).
- **Only open flights count.** A day already flown, completed or past its deadline is not one of the choices. If only one flight of that
  number is open, the bare number is that flight and nothing is asked.
- **Days the panel does not list yet** (beyond its 1 to 7 days) are shown but cannot be pressed. If **no** day can be booked yet, nothing is
  asked and the bot says, as for any flight too far ahead, when the soonest opens.
- **Several IDs in one message** (`SKY329, SKY216`): the bot reserves the ones that are one flight, says that `SKY216` is flown on more
  than one day (naming the IDs) and keeps the conversation open, so sending `SKY216` on its own asks the question.
- **`/eta flight:SKY216`** names the days (`SKY216-21NOV`, ...) instead of saying it does not know the flight, and an admin's
  **`/setup release code:SKY216`** must say which day, and is told the choices (it never frees the wrong day).
- **A flight whose ID lost its day** (the other days left the schedule, so `SKY216-21NOV` became `SKY216`) is still found by the dated ID
  it had, while that is the day it opens.

### Reserving straight from a DM

You do not have to press **Reserve** first. DM the bot a flight ID and it reserves the flight for you, the same as if you had
pressed the button and replied with it:

- `DMO-004`, `reserve DMO-004`, `book DMO-004` or `please reserve DMO-004 for me` all work, and so do several flights in one message
  (`DMO-004, DMO-007`), with every rule of a reply in the Reserve conversation: one-leg flights are taken at once, a flight with
  several legs asks *all or some* with the usual buttons, the airline's sheet gets your name, a flight beyond the panel's days is
  turned down.
- **Standing by as backup works the same way**: `backup DMO-004` (or `back up DMO-004`). Backup is one flight at a time, and you are
  told the reason when the flight cannot have a backup (it still has a free leg, it has one already, it is yours).
- **A bare number is never taken for a flight**: a message with no word that says what to do (`reserve`, `book`, `backup`) has to
  look like a flight ID itself, with letters and digits together (`DMO-004`, `SKY330`). So `7`, `thanks 2` or `A320` are just
  messages and get the usual pointer, and the short forms (`dmo4`, `4`) need the word: `reserve 4`.
- **The word on its own** (`reserve`, `book a flight`, `backup`) opens the conversation and asks for the flight, as the button does.
  If you can use more than one airline there, the bot asks you to send the ID with it.
- **The first time**, the bot asks for your FsHub pilot ID before anything else, as the button does, and then carries out what you
  sent (it keeps your message for the ten minutes the conversation stays open) rather than asking for the flight again.
- **The bot looks for the flight on the panels of the servers you are in**, and asks Discord about you before reserving, because a
  DM, unlike a button on a panel, proves nothing about who sent it. You must be a **member of that server**, hold **the role the
  panel is limited to** (server admins always count), and be able to **see the panel's channel**: a server that keeps its panel
  private by hiding the channel stays private. If you are not in the airline's server the message is simply answered as any other;
  if you lack the role, you are told so, naming it; if Discord cannot be asked just then, nothing is reserved and you are told to
  try again. If the same ID is on the panels of two airlines you can use, the bot asks you to press **Reserve** on the one you mean.
- A conversation you already have open carries on as before (a bare ID goes to it); only a word that says what to do starts
  something new, and a conversation waiting for your FsHub pilot ID is left to its answer.

**Looking for a flight.** **Search** (under the panel) opens a small form with four optional boxes: where you want to
fly **from**, where you want to fly **to**, the **date**, and the **aircraft type**. Fill in any of them, one or together,
using the airport codes shown on the panel (`EGLL`; several are fine, `EGLL EGKK`; two or three letters match every airport
starting with them, so `EG` finds EGLL, EGKK and the rest). Aircraft types are the short codes on the flight cards (`A320`,
`B738`); several are fine (`A320 B738`), and a few characters match every type that starts with them, so `B73` finds B737,
B738 and B739. An aircraft type on its own lists every flight in that type. **FsHub's aircraft aliases count**: FsHub lets a pilot fly an Aeroconomy job in a compatible aircraft (an A20N for an A320 job, a B738 for a B38M job, the A330-200, -300 and -900 for one another), so a search adds the types FsHub lists as aliases of the ones asked for (an A20N search also finds the A320 flights) and the reply says which it added. The bot answers privately with the matching flights as the same cards the panel shows,
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
a DM asking for the ID of the flight (the first time it asks for your FsHub pilot ID too), and you reply with it. **Or skip the button and DM `backup DMO-004`** (see [Reserving straight from a DM](#reserving-straight-from-a-dm)). A flight
needs every leg taken (until then you can simply reserve the free legs), you can't back up a flight you're flying, and each
flight has one backup; if the flight you name can't be backed up, the bot says why and you can send a different ID. The
panel shows the backup's name on the flight (*BACKUP*). If the pilot gives the flight back, an
admin frees it, or the airline drops it, the bot DMs the backup that their spot has ended (and, if it's open again, that
they can take it). Stand down any time from **My flights**. The backup is not made the pilot automatically: they
press **Reserve** if they still want the flight. Where the bot writes to the sheet and the sheet has a *Backup Pilot* column, the
backup's name is written into that cell for a single-leg flight, on the same terms as a reservation writes the *Pilot* cell: only
into an empty cell, never over another name or a finished flight (the bot says so and doesn't make you the backup), and it comes
off again, if it is still the name the bot wrote, when they stand down, give the flight back, an admin frees it, or `name <your
name>` changes it. A backup named in the sheet's *Backup Pilot* column by a person still shows as a note on the flight. Once an hour
the bot also **goes back over every backup already down for a flight** and writes in any whose name never reached the sheet (they
were put down before the bot wrote backups there, or the sheet could not be reached at the time), leaving alone any cell that
names someone else or any finished flight, and never undoing the backup itself. **If the backup flies the flight in the pilot's
place**, the bot completes it for them (see [Completing automatically](#completing-automatically-every-hour)). Where a role is needed
to reserve, it is needed to be a backup too.

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

**Flights with no pilot get listed once a day.** At **midnight UTC** the bot posts once in the panel's channel: a ping,
the flights that start *that day* and still have nobody, and a **Reserve** button. A flight belongs to the day its landing
window opens (its deadline, if it has no start time), however early or late in the day that is, so there is one message a
day however differently the flights open, and nothing else is pinged that day. It lists the soonest 12 and, for a
multi-leg flight, says which legs are open. A pilot named in a linked Google Sheet counts as a pilot. A day on which
every flight has a pilot gets no message. A flight that loses its pilot later in the day is not announced again: the pilot
who gave it back is sent a direct message instead (see below).

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
   menu opens the setup page, copies the invite link, opens the **User manual**, shows the log and data folder,
   restarts the bot, switches **Start with Windows** on or off, and quits.

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
ordinary HTTPS request naming the app and its version (`FlightPanelBot/0.2.0`) and can be switched off on the
setup page. A new release is published by creating a GitHub release on the project's repository
(`UncappingBadger/FlightPanelBot`, set in `src/host/updates.ts`) with a tag such as `v0.2.0` and the
exe attached; the tag must be higher than the version in `package.json`.

**Build it:** `npm run build:host` bundles the bot with esbuild, compresses the bundle and this machine's Node.js,
and compiles a small C# tray launcher (using the compiler that ships with Windows) with both embedded. Output is
`release/FlightPanelBot.exe` plus its licence notices and a checksum. The user manual (a PDF made from the online
manual, so not kept in this repository) is embedded too and opens from the tray menu: the build takes it from
`--manual <file>`, else from `FlightPanelBot-Server-Owner-Manual.pdf` beside the new exe or in `release/`, and builds
without the menu entry if there is none. The exe is **not code-signed**, which is
why Windows shows a warning; signing needs a certificate. `FPB_HOME` moves the data folder, and `FPB_NO_BROWSER=1`
stops the tray program opening the browser (used by tests).

**Diagnostic build:** `npm run build:host -- --debug` makes `release-debug/FlightPanelBot-DEBUG.exe` for chasing a problem on a real
install. It is not part of the release cycle and is never published. It logs everything it decides to its own `bot-debug.log`
(the `[dbg]` lines, for example why the airport list was or was not read and what the Distance fill found), and **it never writes
to Google and never uses the Google key**, and it reads a linked sheet every two minutes instead of once an hour so the Distance fill can be watched: the schedule is copied once from the sheet's public link into a local file in
`debug-sheets` (beside the database), and from then on the bot reads that file and writes into it, so pilots' names, ticks and
distances can all be watched without touching the real sheet. Delete the file to take a fresh copy. A cell's number format is kept
in `<file>.formats.json`, which can be written by hand to try how a cell formatted as a date is handled.

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
3. **Invite the bot** (replace `YOUR_CLIENT_ID`). It needs View Channel, Send Messages, Embed Links, Attach Files (for the OPEN stamp;
   without it the panel works but has no stamp) and Read Message History:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=117760
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
| `/setup weather [mode] [channel] [airports]` | Keep a weather board in a channel: a grid of buttons, one per airport (just its code, with a dot for how its weather rates), for the airports you choose (default KBOS KMIA SKBO EGLL) and then the airports of the flights in the next 24 hours; pressing one shows its METAR to that person only, and a **Search airport** button finds any other (see [below](#the-weather-board)). With nothing given it says how things stand. |
| `/setup fshub [link] [confirm] [autocomplete] [airline]` | Link a panel to your airline's FsHub roster so pilots are matched to their pilot IDs without being asked, and completed flights show the aircraft FsHub recorded (needs a [FsHub token](#fshub-optional)). `link` is the airline's short name (e.g. `SKY`), its FsHub number or a link to its page; `link:none` stops. `confirm:off` stops reading the airline's flights, which also returns **Complete** to the pilot-picks mode. `autocomplete:off` stops the [hourly automatic completion](#completing-automatically-every-hour) (on by default); `autocomplete:on` turns it back on and checks now. With no options it reads the roster and flights now and runs the check. |
| `/setup panel-role [role] [airline]` | Change which role can reserve on a panel. Leave the role empty to open it to everyone. |
| `/setup sheet link [airline]` | Read the panel's flights from your airline's Google Sheet schedule, every hour. `link:none` stops. |
| `/setup writeback [mode] [airline]` | Check, or switch on or off, writing pilots' names and completions to the panel's sheet (needs the [write-back setup](docs/WRITEBACK_SETUP.md)). |
| `/setup import file [airline]` | Replace the panel's flights from a CSV or JSON file. (Not available while a sheet is linked.) |
| `/setup template` | Download an example flights file (itself a valid import). |
| `/setup release code [leg] [airline]` | Free someone's reservation on a flight (they're told). |
| `/setup panels` | List panels with open flights and how many legs are reserved. |
| `/setup reminders [mode] [role] [cleanup] [airline]` | Choose who is pinged by the midnight (UTC) list of the day's flights that have no pilot. **Auto** (the default) pings the role that can reserve, or @here if anyone can; or pick a role; or turn it off. `cleanup` (on by default) deletes each list at 23:59 UTC; `off` leaves them in the channel. With no options it shows the current setting. |
| `/setup window [days] [airline]` | Choose how many days ahead the panel lists flights, from **1 to 7** (a new panel shows 7). The panel lists the flights that are open now or start within that many days; later ones are counted in a line at the end and appear once they come within the period. Pilots can still reserve a flight that is left off by typing its ID. With no `days` it shows the current setting and how many flights are left off. `/setup panels` shows it too. |
| `/setup depart-warning [minutes] [mode] [airline]` | Warn the pilot of a flight, and its backup, by private message shortly before the **latest take-off that still lands inside the flight's window** (see *Late-departure warnings* below). `minutes` (5 to 180, default **30**) is how long before; `mode:off` switches it off and `mode:on` back on. With no options it shows the setting. |
| `/setup live-tracking [mode] [airline]` | Follow your pilots' flights **live** with FsHub's public live feed: a late-departure warning skips a pilot already in the air, and a flight is looked for in FsHub's own record the minute its pilot lands (and completed only when FsHub shows it flown). On by default; `mode:off` switches it off, `mode:on` back on. With no options it shows the setting. See *Live tracking* below. |
| `/setup safety-pay [mode] [minimum-loss] [tier2-loss] [tier3-loss] [airline]` | Link the **pilot's pay to landing safety** (see *Landing safety and pay* below): a landing at -400 to -599 fpm pays the pilot only **8%** of the flight's profit, one at -600 or harder only **5%**, and a pilot landing at -375 to -399 is sent a warning with no fine. Off by default. `mode:on` asks you one question first: **what percentage of the $2,000 minimum pay does a pilot lose** after a hard landing? The same for both tiers (buttons for **0%**, **25%**, **50%** and **100%**, or `minimum-loss:15`), or different for each tier (the **Different for each tier** button asks about Tier 2, then Tier 3, or give `tier2-loss:10 tier3-loss:40`); `mode:off` switches it off, and the same options on their own change the answers while it is on. It only affects flights that land **after** you turn it on. When a pilot lands at Tier 2 or 3 your managers are sent a report by DM and a row is added to `hard-landings.csv` in the data folder; a flight whose landing rate can't be trusted is left out of `/setup profit` and your managers are told. Needs the bot's FsHub token and the panel linked to its airline's FsHub roster (`/setup fshub`). With no options it shows the setting. |
| `/setup flight-numbers [mode] [airline]` | Take **Aeroconomy's own flight numbers** as the flights' IDs, for a flight whose sheet row has none (read from Aeroconomy's public contracts, no account or token). The panel must be linked to its airline's FsHub roster (`/setup fshub`). Off by default, because it changes the IDs people know; `mode:on` turns it on and `mode:off` off. With no options it shows the setting and how many open flights have a number. Where the bot writes to the sheet and the sheet has a *Flight Number* column, it also writes each flight's number into the column's empty cells. |
| `/setup profit [action] [send-to] [channel] [who-can-write] [role] [airline] [business]` | Compare what Aeroconomy says each flight **made** (its aircraft logbooks) with the sheet's **Profit Made** column. By default it only **reports** (what agrees, what differs, what is blank) and changes nothing. `action:fill` shows the blank cells it would fill in and writes them only after someone presses **Write** on that preview. `send-to` chooses where that preview appears (only to you in the reply, your DMs, or a channel) and `who-can-write` / `role` lets the members of a role press **Write** too; `action:settings` shows what is set. Needs the bot's FsHub token, the panel linked to FsHub, and (to write) write-back on. Admins only. |
| `/setup layout [mode] [dates] [airline]` | Choose how the panel looks: `cards` (a card for each flight, the **default**) or `grid` (a button for each flight, with Collapse and Expand buttons; much less scrolling), and, for the grid, whether its short dates are `dmy` (day first, 16/11/26, the default) or `mdy` (month first, 11/16/26). The panel is redrawn at once. With no options it shows the setting. See *The grid layout* below. |
| `/payroll settings [enabled] [source-account] [pilot-info] [start-from] [at] [airline]` | **Paying pilots** (see *Paying pilots* below). Shows how it is set up, or changes it: the airline's account the pay comes out of (`source-account`), the link of the sheet's **Pilot Info** tab (`pilot-info`), the first flight day to pay (`start-from`), the time of day (Zulu) the daily list is made (`at`) and whether it is made every day (`enabled`). Changing it pays nothing. |
| `/payroll run [airline]` | Make the list of what is due **now** and send it to be checked. Nothing is paid until someone presses **Pay**. |
| `/payroll history [airline]` | The latest payments the bot has made or tried, and what became of each. |
| `/payroll accounts [airline]` | The Aeroconomy bank accounts the bot's FsHub token can see, with their numbers (to find the `source-account`, or for a test transfer). |
| `/payroll test-transfer from to [amount] [airline]` | Send a **small test payment** (a dollar unless you say, ten at most) between two accounts the bot can see, to prove paying works before any pilot is paid. It shows what it would send and sends nothing until you press **Send**. |
| `/setup completed [channel] [mode] [airline]` | Show the **completed flights in a channel of their own**, so the panel lists only the flights that can still be flown (the default is to show them below the open flights, in the same channel). Give a `channel` to move them there: the bot needs to view, write, embed links and read history in it, and the completed flights stay up for 24 hours after they are done, as before. Moving them to another channel deletes the old messages; `mode:panel` puts them back below the open flights. With no options it shows the current setting; `/setup panels` shows it too. A pilot's List view leaves them out. |
| `/setup refresh [airline]` | Re-fetch from an automatic source and redraw. **Always sends every panel message again**, even for a panel with no sheet (file imports), so a panel posted by an older version of the bot picks up whatever is new (new buttons, a new look) with no need to remove and re-add it. The bot also redraws every panel each time it starts. |
| `/setup refresh-roles [role] [mode]` | Let members with a role run **`/setup refresh` and `/setup id-add`, and nothing else from `/setup`** (every other subcommand stays admin-only, and so does this one). `role` adds it (`mode:add` is the default); `mode:remove` with a `role` takes it off; `mode:clear` takes every role off; with no options it lists them. Up to 10 roles per server, and not @everyone. **Discord also has to let those members see `/setup`**: in Server Settings, Integrations, choose the bot, then `/setup`, and add the role there (a bot cannot do that part itself). |
| `/setup id-add user id` | Set a pilot's **FsHub pilot ID** in the bot by hand, to fix a wrong one. `id` is the number from their profile address (fshub.io/pilot/**1234**/overview) or a link to their profile. With a FsHub token the bot checks the number exists and shows the name FsHub has for it; it refuses an ID FsHub has no pilot for, and one the airline's FsHub roster gives to a different Discord account (flights could not be completed with it). It replaces whatever was saved (and says what that was), it is not overwritten by later roster reads, the panels showing that pilot are redrawn, and the pilot is told in a DM. Admins, and members with a role from `/setup refresh-roles`, can use it. |
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
`⚠️ scheduled B738`; but a type FsHub lists as an alias of the scheduled one, such as an A20N for an A320, is not flagged and shows `counts as A320`), the landing time is shown in each reader's own timezone, and `on time`, `delayed` or `late`
is FsHub's own word for how the flight went against its schedule (left out when FsHub has none). Under **My
flights** a pilot is told which of their flights FsHub already shows as flown.

FsHub's flight records carry no job ID, so this is **matching, not a lookup**, and it is deliberately cautious. A
FsHub flight confirms a scheduled flight when it went between the same two airports and landed inside the flight's
window (an hour either side). If the pilot holding the flight has a known FsHub ID, only a flight by that pilot
counts. If not (a pilot named in the schedule sheet, say) it counts only when it is the single candidate: two
flights that could both be it means nothing is claimed rather than something wrong. One FsHub flight confirms at
most one scheduled flight. The aircraft is shown, not required: a pilot who flew another type still flew it. (The aliases come from FsHub's aircraft page, https://fshub.io/aircraft-list, which needs a FsHub sign-in, so the bot carries a snapshot in `src/services/aircraftAliases.ts`; `scripts/import-aircraft-aliases.mjs` refreshes it from a copy of that page's data, as its header explains.) If
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

- **A flight the sheet names for the pilot counts as theirs, if FsHub backs it up.** Pilots often type their own name
  into the sheet's Pilot column instead of pressing **Reserve**, so the bot has no reservation for them. **Complete**
  also looks at flights the sheet names for them (the name they gave with `name <your name>`, or else their Discord
  name, or one the bot wrote for them before; capitals and spaces at the ends don't matter), where nobody holds any leg
  in Discord and every leg is named for them. A name in a sheet is only someone's word, so such a flight is completed
  only when FsHub shows the pilot's **own** FsHub ID flying it (the strict rule above): another pilot's landing on the
  same route never completes it. The flight then becomes the pilot's reservation, is ticked in the sheet under the
  sheet's own spelling of the name where write-back is on, and the reply says it took the name in the sheet to be them.
  A pilot with nothing to complete is told to DM `name <your name as the sheet has it>`.
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
pilot must hold every leg, and FsHub must show each leg flown between the right airports inside the flight's window). A
flight only the airline's sheet names a pilot for (no reservation here) is completed too, but only for a pilot who has
told the bot that name with `name <your name>` (or had the bot write it for them before), whom no other account shares
the name with, and whom FsHub shows flying every leg. It does not guess from Discord names it was never told; pressing
**Complete** does, because the pilot is there to be asked.

- **The pilot is told.** One DM per pilot per check, however many flights it completed: *"FsHub shows you flew a flight
  for **Example Air**, so I marked it completed"*, with the aircraft and landing time, and that there is nothing to do. A
  pilot with DMs closed is simply not told; the flight is still completed. A pilot can also switch this message off for
  themselves by DMing the bot `notifications` (the flight is still completed), and the message ends with a line saying so.
- **The sheet is ticked too** where write-back is set up, before the flight is marked completed. If the sheet won't
  accept it (it names someone else for that flight, say) the flight is left alone.
- **A flight its backup flew is the backup's.** A flight that has a backup pilot, held by one pilot, is checked for the
  backup as well: if FsHub shows the **backup** flying every leg between the right airports inside the window, and shows the
  pilot who held it flying **none** of it, the flight is completed for the backup, who takes the pilot's place on it. The pilot
  who held it is told in a DM (always: it was their reservation that was replaced), and so is the backup. Where write-back is
  set up and the flight has one leg, the sheet follows in a single write: the **Pilot** cell takes the backup's name (only if
  it still holds the name the bot wrote for the pilot, or is empty; any other name is never replaced, and then the flight is
  left alone), the **Flight Completed** box is ticked, and the backup's own name comes off the **Backup Pilot** cell (if it is
  still the name the bot wrote). So the profit fill and payroll, which find a flight's pilot by the sheet's **Pilot** name,
  see the pilot who actually flew it. If the pilot flew any of it, the pilot is the one credited, as always; if each flew
  a part, nothing is changed and an admin sorts it out. Both pilots' FsHub IDs must be known, since the bot can't say a pilot
  did not fly a flight it can't look up. A backup is followed live like a pilot, so this happens the minute they land.
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

- **`/eta [flight]`** (anyone): when the airline's flights in the air are expected to land, or when one flight is (see *Live tracking*).
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

### Weather reports (METAR) in plain language

A METAR is an airport's routine weather report, written in a compact code (`EGLL 161350Z 26008KT 9999 NSC 08/01 Q1006`).
**DM the bot `metar EGLL`** (any four-letter ICAO code, up to three at once) and it fetches the current report from
[VATSIM's public METAR service](https://vatsim.dev/api/metar-api/get-metar) (`https://metar.vatsim.net/<ICAO>`, no account or key)
and answers with a card that explains it for someone who doesn't know the abbreviations: a one-line summary first, then
wind, visibility (and runway visual range), weather, clouds, temperature, humidity, pressure, anything else the report
carries (wind shear, sea state, runway condition, military colour states), what to expect over the next two hours, and the remarks,
each with the units a pilot of either habit would want (knots and km/h, metres and miles, hPa and inHg, °C and °F). The report
as written is shown at the bottom. It is for flight simulation only, and says so on every card.

- **Pasting works too.** **Paste a METAR after `metar`, or on its own**, and the bot translates that instead, without
  contacting anyone (so it also works when VATSIM can't be reached, and is never held up by the pause below). Several
  reports can be pasted at once, one to a line or ending in `=`; the first three are translated.
- **Units are read from each report, never guessed from the country.** METARs share one group order worldwide, but the
  United States and Canada give visibility in statute miles and pressure in inches of mercury (`A2992`), most of the world
  gives metres and hectopascals (`Q1013`), Russia and China give wind in metres per second, a few stations give both
  pressures, and the remarks after `RMK` are national and free-form. The decoder understands all of those, plus the common US
  remarks (`AO2`, `SLP`, the exact temperature group, peak wind, lightning, precipitation totals, pressure tendency), Canadian
  cloud-by-type groups, Russian `QFE` and runway state groups, Australian rainfall, and military colour states. **Anything it
  does not recognise is handed back as written ("Left as written"), never dropped or guessed.**
- **A US-style rating (VFR, MVFR, IFR, LIFR)** is worked out from the ceiling and visibility and shown with what it means.
  Those names come from the US; the card says where they are in everyday use (the US and Canada) and that elsewhere they are a
  rough guide.
- **Only full four-character codes are asked for.** VATSIM reads a code of three characters or fewer as "every airport starting
  with these", and `all` as every airport, so the bot refuses those (and tells people that US airports start with a K: `KJFK`,
  not `JFK`) instead of passing them on. An airport with no report gets a plain message.
- **Kind to VATSIM.** An airport's report is remembered for ten minutes (what the service itself asks of caches), the airports of
  one message (up to three) or one lookup are asked for **in one request** (VATSIM takes them comma-separated), overlapping
  requests share one call, one person can ask about every few seconds, answers are size-capped, redirects are not followed,
  and only the airport codes and the bot's name and version are ever sent. The service is only contacted when someone asks.
  VATSIM sits behind a rate limit: when it answers **429 busy** (with a wait), the bot **does not ask again until that time has passed**
  and says how long (`I couldn't ...busy right now. Try again in about 3 minutes.`) instead of asking over and over.
- It leaves an open Reserve conversation alone, so asking for the weather halfway through reserving a flight costs nothing.

### The weather board

**`/setup weather mode:on channel:#weather`** (admins) posts a weather board in a channel and keeps it up to date. It is a **grid of
buttons, laid out like the Reserve panel**: one button for each airport, saying only its four-letter ICAO code, so a channel with dozens of
airports stays short and easy to read. **Pressing an airport shows its full METAR**, to the person who pressed it and nobody else. No report is
written out in the channel.

1. **The airports followed**, in the first message, with the **Search airport** button under them. Out of the box these are
   **KBOS KMIA SKBO EGLL**; an admin can choose up to eight others with `airports:` (four-letter ICAO codes, `airports:default` goes back to the four).
2. **The airports of the flights in the next 24 hours**, in messages of their own, 25 buttons to a message, in order of code. They come
   from the schedule: every open flight of every panel in the server whose landing window overlaps the next 24 hours (one already open and
   not yet flown counts; a flight with no time, a completed one, and one whose window is over do not). The flights themselves are **not**
   listed; an airport the server already follows is not repeated, and one that several flights use is there once. A code that is not four
   characters is named under the buttons, and not asked for.

- **The dot on a button is the weather's rating:** 🟢 VFR, 🔵 MVFR, 🔴 IFR, 🟣 LIFR (US-style flying conditions, worked out from the report's
  visibility and cloud ceiling), ⚪ no report. A key is in the board's header.
- **What pressing one shows** is the DM `metar` card: the report in plain language (*In short*, wind, visibility, weather, clouds,
  temperature, pressure) with **the report as written at the bottom**. If VATSIM has no report for the airport it says so (small airfields often
  have none). If VATSIM cannot be reached it shows the last report the bot had for that airport, and says when that was.
- **It follows VATSIM.** The board is redrawn every ten minutes, which is as often as VATSIM's service (which asks caches to keep an
  answer for ten minutes) has anything new, and it asks for reports a little younger than that, so a redraw never reuses its own
  previous answer. Its header says when it was last checked. The messages are edited in place, and only the ones whose buttons or dots changed.
  Airports come and go as the 24 hours move.
- **If VATSIM cannot be reached,** the board stays as it was, `/setup weather` says why, and it tries again at the next redraw. One
  report that is too odd to read gets a grey dot and does not stop the rest.
- **It fits Discord.** Up to 40 airports of flights are shown, and it says how many more there were; if someone deletes a message, or the number
  of messages changes, the board is posted again. The bot needs View Channel, Send Messages, Embed Links and Read Message History in the channel, and never pings anyone.
- **Search airport.** The button under the first message opens a box for an airport's four-letter ICAO code (or several, up to
  five) and answers only to the person who asked, with the METAR as written and a pointer to the DM `metar` for the plain-language
  version. A three-letter code is explained rather than guessed (`KJFK`, not `JFK`). One person can search every few seconds.
- **Kind to VATSIM.** **One request per redraw, for all of the board's airports together** (up to 50 in a request, a few dozen in practice), answers shared with the DM
  `metar`, with pressing an airport and with other servers' boards, and only the airport codes are ever sent. (The first version asked for each airport separately, which
  was refused as too many requests at once: a board with a day of flights has dozens of airports.) When VATSIM says it is busy the bot waits as long
  as it asks (at most 15 minutes) before asking again, leaves the board as it was, and `/setup weather` says how long. `/setup weather mode:off` removes the board and its messages.

### Payment messages: `/banking`

**DM the bot `/banking`** and it messages you, in that DM, whenever money goes **into or out of** the Aeroconomy bank accounts you choose: your own, and any
business accounts you have. It only ever **reads**. It cannot pay, move or change anything.

- **It needs your own API token**, because Aeroconomy's banking API asks for one on every request (its documentation does not say where to get one; FsHub and
  Aeroconomy are one system, and the **FsHub personal access token** from `fshub.io/settings/integrations` is accepted). The bot explains this in the DM
  and tells you to make a new token just for this, so you can delete it at any time without touching anything else. **You send it to the bot in that DM.**
  Aeroconomy's documentation lists no scopes, so treat the token like a password; the bot says that too, and tells you to delete your message with it.
- **Then it asks which accounts to watch**, as a list to pick from (it asks Aeroconomy which accounts the token can see, and labels each as personal or business).
  Only payments **from then on** are told: it notes the newest payment of each account and never sends your history.
- **`/banking` again** shows what is watched, lets you pick a different set of accounts (a kept one keeps its place, a new one starts from now) and has a
  **Turn off** button. `/banking off` does the same by typing.
- **Turning it off deletes the token and the list of accounts** from the bot, and the bot says so. The same happens, with a message, if Aeroconomy stops
  accepting the token, the token can no longer be read, or no account is left that Aeroconomy will show. An account Aeroconomy stops showing is dropped with a
  message and the rest carry on.
- **What a message says:** money in (`💰 +$1,250 into <account> (…0111) · From <name> · For: <description>` and the time), money out (`💸 -$80.50 out of ...`),
  or a payment between two of your own watched accounts (`↔️`, one message, not two). The lines of a payment of several are listed. Names and descriptions
  come from other players, so they are shown with no formatting and no mentions, and an account is named with only the last four characters of its number.
- **How often:** every five minutes the bot reads the newest payments of each watched account (a payment number higher than the last one told is new), at most
  the newest ten are sent one by one when there are many (with a line saying how many), and a payment is told once. If your DMs from the bot are closed it tries
  again after an hour; nothing is marked as told until it has reached you. If Aeroconomy is having trouble it simply looks again next time.
- **How the token is kept.** Only **sealed**: AES-256-GCM, with a random key in a file of its own (`banking.key`, next to the database in the bot's data folder),
  so a copy of the database alone holds nothing that works. It is never logged, never put in an address, never sent anywhere but Aeroconomy, and decrypted only
  for each request. It does not protect against someone who can read the whole data folder, which is the computer the bot runs on: the DM says so, and that
  whoever runs the bot can reach that computer. If the key file cannot be made, tokens are kept only in memory and people are asked again after a restart. A
  setup left half done (a token sent and no accounts chosen) is deleted after 30 minutes, and the DM says it will be. Deleted rows are overwritten in the file
  (`secure_delete`).
- **Requests:** `GET /banking/accounts` and `GET /banking/accounts/<number>/transactions` on `aeroconomy.com`, one at a time, spaced out like every other
  Aeroconomy request the bot makes, redirects not followed, only for pilots who turned this on.

### Watching a flight: `/monitor`

**DM the bot `/monitor SKY330`** (a flight number: the airline's letters and the number) and it messages you when that flight is **about 10 minutes from
landing**, and again when it has **landed**. It finds the flight in FsHub's public live feed by its callsign, which for an airline's flight is its flight
number, so it works for any airline whose flights show there, not only the ones on your panel.

- If the flight is not in the air yet the bot keeps looking for up to **24 hours** (a flight seen in the air is then followed until it lands). It says how the flight
  stands when you ask (in the air with about so many minutes to go, on the ground, or not in the feed yet).
- **The 10 minutes** is FsHub's own estimate of the time to landing, used only while the aircraft is flying (it is not meaningful on the ground), and is told once.
  If the flight is first seen already that close you are told at once.
- **Landed** is the feed showing the flight landed, taxiing to the gate or arrived, or a flight that was in the air and is now on the ground. A flight seen in the
  air that then drops out of the feed (two looks in a row) is reported as no longer in the feed, most likely landed or the pilot disconnected.
- **`/monitor`** shows what is being watched; **`/monitor stop SKY330`** stops one and **`/monitor stop all`** every one. Up to five flights at once. A flight number
  already on the ground and shown as arrived when you ask is reported as landed straight away.
- Once a minute, one request to FsHub's live feed for each airline that anyone is watching a flight of, however many people watch it; nothing about you is sent.
  A message that could not be delivered is tried again at the next look.

### Who can reserve

By default anyone who can see the panel's channel can press **Reserve**, so channel permissions are the first
line of control. To go further, choose a role with the `role` option on `/setup panel-add`, or change it later
with `/setup panel-role` (leave the role empty to remove the requirement, or pick `@everyone`). The panel then
says "Reserving is open to members with @Role", and anyone without it who presses Reserve is told why. Server
admins can always reserve. The role only gates *starting* a reservation; people can still see the panel, view
**My flights** and give flights back. **Reserving from a DM** (`reserve DMO-004`) is held to the same rules: the bot asks Discord
whether the person is a member of the panel's server, holds the role, and can see the panel's channel (see
[Reserving straight from a DM](#reserving-straight-from-a-dm)), so hiding the channel or naming a role works for both ways in.

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
| `Backup Pilot` | shown as a note on the flight (the bot also writes a backup pilot's name here when they stand by, see [Writing to the sheet](#writing-to-the-sheet)) |
| `Aircraft` | the required airframe |
| `Flight Completed (by Pilot)` | `TRUE` takes the flight off the open list and shows it on the panel as ✅ completed, with the pilot's name, for 24 hours (see below). A `CANCELLED` pilot is never shown as completed. |
| `Flight Number` (optional) | the airline's own number for the flight, such as `SKY123` or `SKY-014`. **When it is there it is the flight's ID**: it is what the panel shows and what pilots type to reserve (any case, spaces ignored). A flight with no number keeps the bot's own ID (`WA-031`), so the two can be mixed. With `/setup flight-numbers` on and write-back set up, the bot writes the number into empty cells itself (see [Flight numbers from Aeroconomy](#flight-numbers-from-aeroconomy)). The column can also be headed `Flight No`, `Flight #`, `Flight ID`, `Flight Num` or `Flt No`. See [Flight numbers](#flight-numbers) below. |

| `Daily Flight Sequence` (optional) | for flights that depend on one another (the same aircraft flies them one after another): where the flight stands in the day's run, `1`, `2`, `3`... (also headed `Flight Sequence`, `Daily Sequence` or `Sequence`). It is shown on the flight with its other notes, as *Flight sequence: 2*, so nobody needs a colour to see it. The bot only shows it; it does not hold a flight back for another. |
| `Distance (NM)` (optional) | the distance of the flight in nautical miles (also headed `Distance`). **The bot fills this in itself**, see below. |

Other columns (pay, profit, US Central times) are ignored. A sheet without a landing-window column must use the
columns of the flights file below. A flight keeps its bot ID and its reservations from one refresh to the next
as long as its route and date stay the same. If a reserved flight disappears from the sheet, its holder is told;
a flight whose *Flight Completed* box is ticked is not "removed", it is shown as completed.

#### The Distance column

The distance of a flight is known before it is flown, so a sheet with a **Distance (NM)** column gets it filled in **when the bot reads
the schedule** (every hour, and with `/setup refresh`). Nothing is asked of any pilot.

- **How it is worked out.** The great-circle distance between the airports of the flight, in whole nautical miles, added up for a flight of
  several legs. The airports' positions are the ones the bot keeps for the late-departure warnings (OurAirports' public list), so no
  new service is involved. Whenever the list is read, **every** airport in it that has an airline-style code is kept (about 35,000 large, medium and small
  airports, 2 to 3 MB in the database), not only the ones a flight asked about, so a schedule full of airports the bot has never seen is filled in at the
  next read, and a read made a moment earlier for something else (a late-departure warning, say) can never leave half of them unknown. The list is read at most once
  every ten minutes, and again after twelve hours so new airports arrive. A flight still waiting for an airport (one the list does not have, or a
  read that failed) is tried again about eleven minutes later, up to three times, rather than at the next hourly read. It is the straight-line distance between the airports, not the distance a pilot ends up flying: FsHub's own
  record of a flown flight can be longer, and is not used here.
- **Only empty cells.** A Distance cell with anything in it (a number you typed, a zero, a note, a stray space, a formula) is never changed. The sheet is
  read afresh just before writing, each flight is found again by its route and date, and a cancelled flight is skipped. Values go in as numbers, in one request.
- **When it happens.** Only for a sheet that has the column, only where writing to the sheet is switched on for the panel (`/setup writeback`,
  needs the Google key), and in the background: it never holds up the refresh, and if anything goes wrong it is logged and tried again at the next
  read. A flight whose airport the bot cannot find is left blank for later.
- **Cell formats.** What a number looks like is up to the cell's format: a Distance column copied from the Date column would show 392 as `1/26/1901`,
  one copied from a money column as `$392.00`. So before it writes, the bot looks at the format of the cells it is about to fill. A cell formatted as a date,
  a time, money, a percentage or in scientific notation is given a plain number format (`#,##0`), those cells only and nothing else about them (colours, fonts
  and borders are not touched); a cell with no format, a number format (plain, or like `0 "NM"`) or a text format is left exactly as it is. If the format
  cannot be changed, nothing is written. A distance somebody typed into a date-formatted cell is read as the number it stands for (`427` shows as `3/2/1901`).
  The bot does not reformat cells it does not write to, so the tidy fix is to format the whole Distance column as a number yourself (*Format, Number*).
- **Older rows.** Only the flights the bot is showing (recent and coming ones) are filled; the sheet's history is left alone.
- **On the card.** A flight's card shows its distance in small type under the route, like `📏 2,991 nm` (`in all` for a flight of several legs). It is
  the number in the sheet's Distance cell, so a distance a manager typed is the one shown; for a blank cell it is the one the bot works out from the airports
  it already knows, so the card does not wait for the write to the sheet. A sheet with no Distance column shows no distance.

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
  become `SKY123-12NOV` and `SKY123-13NOV`. Pilots can type that whole ID, or just the number and be asked which day (see
  [below](#a-flight-number-flown-on-more-than-one-day)). A number that is on one row stays as it is. If
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

The daily list described above is on for every panel. Discord only lets a bot ping `@here` or a role that
isn't set to "mentionable" if the bot has the **Mention Everyone** permission in that channel, so grant it (or
make the role mentionable). Without it the message still appears, but nobody is notified. `/setup reminders`
warns you when that is the case. The check runs once a minute, a failed post is retried after an hour (until 22:00 UTC),
and nothing is posted for a panel whose channel the bot can't write in.

**Exactly once a day.** The bot remembers which UTC day it last dealt with each panel, so a restart never repeats the list.
A bot that was off at midnight posts the list when it is back, as long as that is before 22:00 UTC (later than that it would
be gone almost as soon as it appeared, so that day is let go). The first time the bot looks at a panel, whether it is new or
this is the first start after an upgrade, it counts that day as done without posting, so nothing is ever posted at an odd
hour; turning reminders back on in the middle of a day likewise waits for the next midnight.

**The channel tidies itself at 23:59.** The bot remembers each list it posts and deletes it at **23:59 UTC** (UTC because
every flight time here is Zulu, whatever timezone the host's PC is set to), a minute before the next one is posted, so
old pings don't pile up. A list posted at 00:00Z lives until 23:59Z. If the bot was off at 23:59 it clears the old one as
soon as it starts, before posting the new one. It only ever deletes its own lists (never the panel), treats one that
someone already deleted as done, gives up on one it can't delete rather than trying forever, and removes a panel's lists
when you remove the panel. `/setup reminders cleanup:off` leaves them in the channel for that panel (`cleanup:on` turns
it back on); it is on by default.

**When a pilot gives a flight back.** There is no ping for it. Instead, if the pilot takes themselves off a flight (from
**My flights**) and nobody is down as its backup, the bot sends **that pilot** a direct message saying the flight is open
again and asking them to tell anyone they know who is free to fly it (they can press **Reserve** and reply with the flight
ID). If the flight did have a backup, the backup is told instead, as before, and the pilot is not. It is only said for a flight
that is still open and that the panel lists, and, like any message about reserving or releasing a flight, it cannot be
switched off. A pilot with DMs closed is told in the answer to the menu instead.

### Late-departure warnings

A pilot who holds a flight, and its backup pilot, is sent a **private message shortly before the latest moment they
could take off and still land inside the flight's window**: the end of the window (the flight's deadline) less how
long the flight takes. Say a flight must be down by 19:00Z and takes 2 hours: the latest take-off is 17:00Z, and at
16:30Z (the default is 30 minutes before) they are told to take off by 17:00Z or miss the window. The message gives the
time, the deadline, the flight time it used **and where that time came from**:

1. **Learned from your airline's own FsHub flights.** When a panel is linked to FsHub the bot already reads the airline's
   recent flights, and it keeps how long each took (from the departure time to the arrival time FsHub records) after the flights themselves are forgotten.
   The time used is the **middle (median) time** of the flights of that route in the same aircraft (an A20N counts as an
   A320 where FsHub says it does), or in the same kind of aircraft when there are too few of those, and it needs **at
   least two** flights, since one may be an odd one. The message says how many flights it was taken from.
2. **Estimated from the distance.** With too few flights seen, the bot works out the straight-line distance between the
   two airports, adds 5% for the route, and divides by a typical speed for the aircraft's kind (about 440 knots for a
   narrowbody airliner, 470 for a widebody, 270 for an airliner turboprop, 120 for a light piston; the table is in
   `src/services/aircraftSpeeds.ts`), plus a few minutes for the climb and the approach. The message says it is an
   estimate and what it assumed, including when it did not recognise the aircraft type and used a typical airliner. The
   airports' positions come from [OurAirports](https://ourairports.com), whose data is public domain (see below).
3. **Neither:** with an airport whose position it cannot find and no flight of the route seen, **it says nothing** rather
   than guess.

A few things it does and does not do:

- **Anyone can switch the warning off for themselves** by DMing the bot `notifications` (pilots and backups alike; the warning
  ends with a line saying so). Someone who has switched it off is not warned and is not counted as warned, so switching it back
  on before the latest take-off still warns them in time. The server's own setting (`/setup depart-warning`) is unchanged.
- With **live tracking** (below, on by default) it can see who is already in the air: a pilot flying the flight is not warned.
  Without it, or when the live feed cannot be read, it **cannot see a flight in the air** (FsHub's records show a flight only
  after it has landed), so the message tells anyone who has already taken off to ignore it.
- A flight with several legs is counted from the first leg the person holds that FsHub has not shown flown yet, adding
  up the legs still to fly (it does **not** allow for time on the ground between them, and says so).
- Each person is warned **once per flight**, and **not at all once the latest take-off has passed** (the pilot is flying,
  or has lost the window, and the bot cannot tell which). A flight reserved when the time is already close is warned about
  at once. A message that cannot be delivered (closed DMs) is retried every ten minutes until then.
- It is for flights with a deadline that someone holds in Discord; a flight only the airline's sheet names a pilot for
  has nobody the bot can message.
- `/setup depart-warning [minutes] [mode] [airline]` shows the setting, changes how long before (5 to 180 minutes, 30 by
  default) or switches it off (`mode:off`; `mode:on` turns it back on). It is on for every panel, including existing ones.

The check runs once a minute, in the same background lane as the FsHub reads and after them.

### Live tracking: take-offs and landings

The bot follows the pilots who hold flights, using FsHub's **public live feed** (`movements.fshub.io`: no account or token is
needed). It reads each airline's own list of flights, one request for the airline however many pilots there are (the list the landing
estimates use too, below), which names every pilot flying or just landed, and takes each followed pilot's state from it. Only for a
followed pilot that no airline's list has (they are not a pilot of that airline, or the list could not be read) does it ask for the list of
pilots online and then, for one who is online, that one pilot's current flight, as it always did. Whether a pilot is in the air is
decided the same way as for the landing estimates (see below). It uses what it learns for two things:

- **The late-departure warning skips a pilot who is already flying.** If the feed shows the holder in the air on that flight (or
  in the air with no flight plan filed, which is most pilots), no warning is sent. A pilot who filed a plan for different airports
  is still warned, since they may have this flight left to fly. When the feed shows the pilot is *not* in the air, the warning
  says so ("FsHub's live feed doesn't show you in the air right now") instead of asking them to ignore it if they have taken off.
- **A flight is checked the minute its pilot lands.** When a pilot who was in the air is no longer (landed, or dropped out of the
  feed), the bot reads FsHub's flights straight away and again every minute for twelve minutes, and completes the pilot's flight
  **only when FsHub itself shows it flown**, by exactly the same strict rules as the hourly check and the **Complete** button (the
  holder's FsHub ID known and trusted, the right two airports, inside the flight's window). The feed is only a nudge to look: it
  never completes anything on its own. The pilot gets the usual direct message. After twelve minutes it leaves the flight to the
  hourly check, which is unchanged. Only that pilot's flights are looked at, and the hourly timer is left alone.

**The Complete button stays** exactly as it is: it is the way to finish a flight when a pilot's FsHub ID does not match, or when
live tracking is off or has missed a landing.

#### When a flight in the air will land

The same feed says when each of the airline's flights in the air is expected to land (FsHub works out the estimate from the
flight plan and the aircraft's position). It is shown on the flight's card as a **LANDS** box (the time in your own timezone, and
how long from now), and `/eta` (anyone) lists every flight in the air, or answers for one (`/eta flight:DMO-004`). Only flights the
airline itself flies are followed:

- the **callsign** starts with the airline's code and a number (`SKY290` for an airline whose flight IDs start `SKY`; the code is the
  panel's short name when it has one, otherwise the prefix of its flight IDs). A pilot who flies under a callsign of their own but files the
  airline's number as the **flight plan's flight number** is followed too,
- a **flight plan** is filed, and its two airports are the two ends of a leg of a flight on the panel (when several flights of the
  panel have that route, the callsign being the flight's number, the landing falling inside the window, or the pilot holding it
  decides; if that still does not settle it, none is shown rather than a guess),
- the aircraft is **in the air** and FsHub gives an estimate. In the air means FsHub's phase is one of the air (take-off, climbing, level
  flight, cruise, descending, approach) **or** the phase is one it has not worked out and the aircraft itself says it is off the ground. FsHub
  shows `calculating` until it has worked the phase out, which can be hours into a long-haul flight (one was seen at 37,000 ft and 494 knots
  with its phase still `calculating`), so a flight is not ignored for that; a phase of the ground (awaiting departure, taxiing, landed,
  arrived), or an aircraft on the ground, is never followed. The same rule decides whether a pilot is flying for live tracking and `/monitor`.

A pilot of the airline flying under another callsign (with no airline flight number in the plan), or without a flight plan, is ignored: they
are not flying one of its flights. (FsHub gives a flight with no flight plan no destination, so it has no estimate to show.)
The bot asks the feed once a minute for each airline, in one request (`movements.fshub.io/airline/SKY`). The landing estimates, live
tracking and `/monitor` share each read for 20 seconds, so an airline is asked about once whichever of them wants it first. The panel is only
redrawn when a time first appears, goes, or has moved by about three minutes (at most every five minutes), so the card does not
change every minute; the "in 37 minutes" beside the time counts down by itself. A time is dropped after the feed stops showing the
flight for two looks, and none is trusted after four minutes without a good read. It follows the panel's live-tracking setting.

Good to know:

- Which pilots are followed: those who hold a flight in Discord and whose FsHub ID the bot knows (and trusts: an ID somebody typed
  that the airline's roster gives to another Discord account is not used). Flights only the sheet names a pilot for are not
  followed, and are left to the hourly check.
- Only a pilot's public FsHub ID is ever sent, in the address, to `movements.fshub.io`. The bot asks at most about once every
  45 seconds, and only if somebody is being followed. Nothing is stored: after a restart the bot learns who is flying afresh.
- A feed that can't be read for three minutes is not trusted: the warning then falls back to its old wording, and a failed read is
  never taken as a landing.
- Completing on landing also needs the panel linked to FsHub with automatic completion on (`/setup fshub`); without them only the
  warnings use the live feed.
- `/setup live-tracking [mode] [airline]` shows the setting or switches it (`mode:off`, `mode:on`). It is **on** for every panel.

### Flight numbers from Aeroconomy

Aeroconomy publishes every contract and its flights without any account or token (`https://aeroconomy.com/api/v1/contracts` and
`/contracts/{id}/manifests`, documented at `aeroconomy.com/docs/api-v1`). Each flight there has the airline's own **flight number**
(`SKY290`), the two airports and the landing window, which is what a schedule sheet row has too. `/setup flight-numbers mode:on` makes a
flight whose sheet row has **no flight number of its own** take that number as its ID, when exactly one Aeroconomy flight has the same
two airports and landing window (the end of a window may differ by up to two minutes: a sheet says 23:59:00, Aeroconomy 23:59:59).

- **It is off by default**, because it changes the IDs people know (`SKY-091` becomes `SKY290`). Switching it on starts a first read; the
  flights are renamed when that finishes, once. An ID that was changed is never changed back, so switching it off leaves them as they are.
- **The panel has to be linked to its airline's FsHub roster** (`/setup fshub`), since Aeroconomy's contracts name the airline by its
  FsHub number. The bot reads the contracts awarded to that airline that are still running.
- **A number flown on several days carries the day**: `SKY330-17NOV`. A number flown only once is plain. Pilots can type just
  `SKY330` when only one such flight is open; when more than one is, the bot asks which day (see
  [below](#a-flight-number-flown-on-more-than-one-day)).
- **It never guesses.** A flight of several legs, a row with no landing window, a flight that two Aeroconomy flights could be, or two rows
  that want the same flight keep their automatic ID. A number the sheet gives itself (a *Flight Number* column) is never replaced.
- **It fills the sheet's Flight Number column in.** Where the bot writes to the sheet and the sheet has a *Flight Number* column, each
  row whose cell is **empty** and that is exactly one Aeroconomy flight (the same rules as above) gets that flight's number written
  into it, as the schedule is read: every such row in the sheet, past flights as well as future ones. The number written is the plain
  flight number (`SKY330`, never `SKY330-17NOV`; the bot adds the day itself when a number is on several rows). Only a cell with
  nothing in it is ever written (not a space, a note or a formula), the sheet is read afresh just before, and a number is not written
  to a row when another row for the same flight (the same two airports on the same day) already has it. A row with no match is left
  empty. The next read then finds the numbers as the rows' own, so they are the flights' IDs by the sheet's say-so.
- **It goes slowly, in the background.** Aeroconomy limits how fast it can be asked, so the bot reads one page every two and a half
  seconds (a first read takes a few minutes), waits as long as a "slow down" says, and reads again every six hours. What it read is kept
  in the bot's database, so a restart does not start over. Nothing else the bot does waits for it.
- **Only public pages are read**, with plain requests that carry no account, token or name: nothing about any person is sent.
- With flight numbers as IDs, the landing-time matching (see *Live tracking*) knows exactly which flight a live callsign is.

### Profit and loss from Aeroconomy (optional)

Aeroconomy works out what every flight made or lost and records it in the logbook of the aircraft that flew it, together with the callsign, the
FsHub flight and the pilot. `/setup profit` reads the airline's aircraft and their logbooks and compares that with the **Profit Made** your managers
type into the schedule sheet. **It is a command an admin runs; nothing happens by itself.** The bot never reads these logbooks, and never touches the
sheet's numbers, unless an admin asks.

- **`/setup profit`** (the default, `action:check`) **only reports**: how many completed flights agree with Aeroconomy (within a dollar, since the sheet
  is kept in whole dollars), which have a Profit Made that **differs** (listed by row, with the sheet's figure and Aeroconomy's, for a manager to look at:
  typing slips show up here), which have a **blank** Profit Made that Aeroconomy could fill, and how many it could not match. Nothing is changed.
- **`/setup profit action:fill`** shows **exactly** the blank cells it would fill (row, flight, the amount rounded **up** to a whole dollar, as Aeroconomy has no cents, and Aeroconomy's figure to
  the cent) and waits. **Nothing is written until someone who is allowed to presses *Write*** (by default only the admin who asked, and the preview
  expires after ten minutes; see *Where the preview goes, and who can press Write* below). It then reads the sheet afresh and writes a profit only where the row is where it was, still names the same pilot, is still ticked as
  completed and the cell is **still empty**; anything else is skipped and reported. It writes **only blank Profit Made cells, as numbers**, in one
  request, and **never changes a cell that has anything in it**: a difference is shown, not corrected. *Empty means empty*: a note such as `TBD`, a
  stray space, a zero, an error, or a formula that happens to show nothing all count as filled, and are left exactly as they are (the bot reads what is really
  stored in the cell, not just what it displays, and the report counts those cells as left alone).
- **Where the preview goes, and who can press Write.** The preview normally appears only to the admin who asked, in the reply to the command, and only
  they can press *Write*. Two settings, kept for each panel, change that, so the boss does not have to be the one who does it:
  - **`send-to`**: `here` (the default), `dm` (the preview goes to the DMs of the admin who asked) or `channel` (it is posted in the channel given with `channel:`,
    which the bot must be able to see and write in). If the DMs are closed, or the channel has gone or the bot cannot post in it, the preview is shown in the reply
    instead, with a line saying why: it is never lost. Whoever it goes to, nothing is written by sending it. A preview in a DM or a channel waits an hour for
    *Write* instead of ten minutes (every cell is still checked again when *Write* is pressed).
  - **`who-can-write`**: `admins` (the default: only the admin who asked) or `role` (with `role:`): **members of that role can press *Write* or *Cancel* as well as
    the admin who asked**. It is checked when the button is pressed, so changing the role takes effect on previews that are already up. `@everyone` is refused. A
    preview in a channel says who may press it, and after it is written or cancelled says **who pressed the button**. If two people press at the same moment
    only the first writes. Nobody else (not even another admin who did not ask, unless they are in the role) can press it.
  - `/setup profit action:settings` shows what is set; giving any of the options on their own (without `action`) saves them and reads nothing from Aeroconomy.
- **The pilot's pay, beside the profit.** If the sheet has a **Pilot Pay** column (not the *Pilot Paid* box), `fill` also offers the pay for each flight it
  fills, worked out by the airline's rule: a flight that made a profit pays the pilot **15% of the profit, rounded up to the next whole dollar (Aeroconomy has no cents), and never less than $2,000**; a flight that made
  a **loss** still pays **$2,000, plus $1,000 for every further 500 nautical miles beyond the first 1,000** (a started 500 counts, so 1,001 nm pays $3,000
  and 1,502 nm pays $4,000). The distance is **FsHub's**: the bot asks FsHub for each such flight (one request each, at most 25 a run, and it stops if FsHub
  says it is busy), and the logbook's own distance has to agree with it to within a mile. If FsHub gives none, or the two disagree, **no pay is worked out for
  that flight** and the preview says why: it never guesses. The pay goes in **only into a Pilot Pay cell that has no pay in it**: empty, or holding just a
  zero (`$0`, `0`), since a column formatted as money shows `$0` for an empty cell. **Anything above zero is left exactly as it is**, and so is a formula (even
  one that works out to zero), a note or a stray space. Both what the cell shows and what is stored in it are checked again when *Write* is pressed, and the
  pay is written as a number. A sheet whose Pilot Pay cells already hold amounts or formulas therefore gets only its profits; the preview says how many Pilot
  Pay cells were left as they are. The bot remembers each Pilot Pay cell it writes: if someone later sets one back to `$0` on purpose, the bot sees that it
  wrote there before, treats the zero as their decision, and leaves it at `$0` (the preview says so). A pay is only ever written beside a profit the bot is
  writing in the same row. With `/setup safety-pay` on, the pay of a flight that landed hard is **cut** as described under *Landing safety and pay*, and the
  preview shows it flight by flight; a flight whose landing rate can't be trusted is **left out** of the fill altogether.
- **What counts as the same flight.** A completed row is matched to the logbook flight with the same two airports that landed in the row's day (a little
  before it, or up to a day and a half after it begins), flown under the airline's own callsign (the code and a number, as for landing times); if
  several flights could be it, the pilot's name decides, and if that does not, the row is left alone. A flight cannot belong to two rows, and a flight of
  several legs is never matched.
- **How far back it can see.** Aeroconomy gives only the **newest 100 entries of each aircraft's logbook** (no paging), so a completed flight older than that
  shows as one the bot found no logbook flight for, and the report says so when there are any. The sheet side has no such limit: *Write* finds a row
  wherever it is in the sheet, however long ago it was flown, and a number or date that only looks like an amount (`2026-11-20`, `0-0`, `8,131-`) is
  never read as one.
- **What it needs.** The bot's FsHub token (Aeroconomy accepts it), the panel linked to its airline's FsHub roster (`/setup fshub`), a sheet with a
  *Profit Made* column, and, to write, the Google key and `/setup writeback` on. The airline's Aeroconomy business is found the first time from an aircraft
  that is out right now, either attached to a flight of the airline's contracts or flown by one of its recent pilots (public Aeroconomy pages, plus a read
  of that one aircraft with the token), and remembered, so it is only ever looked for once. When no aircraft of the airline is out the bot says so: try
  again later, or give `business:` its number, the number in the web address of the airline's business page on Aeroconomy
  (aeroconomy.com/businesses/…); the aircraft it lists must belong to this airline.
- **Leased aircraft are read too.** The aircraft the airline **owns** and the ones it **leases** (Aeroconomy lists them separately) all have their
  logbooks read, and a flight is matched whichever of them flew it. The report says how many of each were read (`3 aircraft logbooks (2 owned, 1 leased)`) when
  there are leased ones, and an aircraft on both lists is read once. Nothing about leasing is needed from you: an airline that leases nothing sees no change.
  The leased side is read carefully, because it is new ground: if Aeroconomy will not list them, the check carries on with the owned aircraft and says the
  leased ones are not in it; a leased aircraft whose logbook this account is not allowed to see is left out and counted in the report, without costing the
  rest. (A refusal for an **owned** aircraft still stops the check, as before.) A business number given with `business:` is still proved by the airline's
  own aircraft; a business that owns none can only be proved by one of its leased aircraft naming this airline as the one whose pilots fly it, and is refused
  (before anything is read) otherwise. The business is still *found* from aircraft the airline owns, so an airline that only leases gives its business
  number once with `business:` (it is remembered after that).
- **What it costs.** About 26 requests, spread out one every couple of seconds (about 30 seconds in all), when an admin runs it (one more for the list of leased aircraft, and one more logbook for each leased aircraft), plus one FsHub request for
  each blank-pay flight that lost money (and, with `/setup safety-pay` on, for each flight whose pay is to be written, to read its landing rate; at most 25 a run in all), and, the first time only, about 5 more to find the airline's business (at most about 20, when it has to look
  through several contracts). The token is only ever sent to Aeroconomy and FsHub, only in plain read requests (`GET`), without following a
  redirect, and **`/setup profit` never writes anything to Aeroconomy**. (The only thing the bot ever sends to Aeroconomy is a payment, when an admin presses **Pay** or **Send** under *Paying pilots* below.)

### Remarks about very hard landings

The airline's FsHub flights the bot reads (see *FsHub (optional)*) carry the **landing rate** FsHub recorded: the vertical speed at
touchdown, in feet per minute, a descent being negative (the `landing_rate` field of a FsHub flight). When a pilot the bot can name
lands at **600 feet a minute or more**, the bot sends them one short, light-hearted private message about it, in stronger words
from 800 and from 1,000. Nothing is ever said in a channel, and a normal or merely firm landing never gets a message.

- **Where 600 comes from.** 10 feet a second (600 a minute) is the descent velocity airliners are certified to take at their design
  landing weight (14 CFR 25.473 and EASA CS-25.473), and what Boeing itself calls a hard landing. 800 is a little above the 720 the
  landing gear is tested to survive, and 1,000 is where real airliners have been damaged. They are lines for a joke, not a verdict: a
  simulator's reading is noisier than an aeroplane's instruments, and FsHub does not say how it measures.
- **Who counts as the pilot.** A FsHub flight is matched to a Discord account by the pilot's FsHub ID: the one your airline's FsHub
  roster gives to a Discord account, or, with no roster entry, one a single person typed. An ID two people typed is nobody's, and
  nothing is sent.
- **Only once, and not too often.** A landing is only remarked on if it happened in the last three hours (so reading a week of
  flights for the first time sends nothing), each flight once, and a pilot gets at most one message in six hours. A message that
  can't be delivered (closed DMs) is not tried again. A reading beyond 2,500 feet a minute is taken as a bad one and ignored.
- **Pilots can switch it off**: `notifications landing off` (or the button), and it stays off until they switch it back on. A
  landing that happened while it was off is never remarked on later.
- **Nothing to set up.** It works wherever the bot reads the airline's FsHub flights, and stops if you switch that off with
  `/setup fshub confirm:off`.

### Landing safety and pay (optional)

An airline can link the pilot's pay to how well they land. It is **off** until a server admin turns it on with `/setup safety-pay mode:on`, and it is a setting of each
panel. Turning it on asks one question first: **what percentage of the $2,000 minimum pay does a pilot lose when they land hard?** You choose whether it is the
**same for both tiers** or **different for each**:

- *The same for both:* press **Lose nothing (0%)**, **Lose 25%**, **Lose 50%** or **Lose all (100%)**, or give any whole number from 0 to 100 in the command
  (`minimum-loss:15`), which skips the question.
- *Different for each tier:* press **Different for each tier** and the bot asks about **Tier 2** (the same four buttons), then about **Tier 3**. Or give both in the command
  (`tier2-loss:10 tier3-loss:40`), which skips the questions. A Tier 3 landing, the harder one, can then lose more of the minimum than a Tier 2 landing, or less, as you choose.

`/setup safety-pay minimum-loss:...` (both tiers) or `tier2-loss:...` and `tier3-loss:...` (either one, on its own) change the answers later, and `mode:off` switches the whole
thing off. Giving `minimum-loss` together with a tier's own percentage is refused, and turning it on with a percentage for just one tier is too: the bot needs both.

The tiers use the landing rate FsHub recorded (the vertical speed at touchdown, in feet per minute):

| Landing | What it is | What the pilot is told | The pilot's pay |
|---|---|---|---|
| gentler than -375 | an ordinary landing | nothing | as usual |
| -375 to -399 | **Tier 1 Safety Warning** | a private message: an acceptable level of extra stress, and that landing rates above -400 will incur safety fines | as usual (no fine) |
| -400 to -599 | **Tier 2 Safety Violation** | a private message: excessive stress, a hard landing | **8%** of the flight's profit |
| -600 or harder | **Tier 3 Critical Safety Violation** | a private message: dangerous and extreme stress, an extremely hard landing | **5%** of the flight's profit |

- **The pay is worked out where the sheet's Pilot Pay cell is filled** (`/setup profit action:fill`, see *Profit and loss from Aeroconomy*). A flight that made a profit
  pays 8% or 5% of the profit, rounded up to the next whole dollar, **but never less than the minimum after the percentage you chose for that tier**: $2,000 less that many per cent.
  At 0% the whole $2,000 minimum is kept, so a small profit costs the pilot nothing; at 25% the pay is never below $1,500; at 100% there is no minimum, and the pay is
  just the share. A flight that **lost money** is paid by its distance as usual, less the percentage for the tier of the landing: at 25%, $4,000 becomes $3,000, and at
  100% it pays nothing. With the tiers set apart (say 10% for Tier 2 and 40% for Tier 3) each landing uses its own tier's percentage, and the safety notice the pilot is sent
  says that one. Both are rounded up to the next whole dollar.
- **Only flights that landed after it was turned on.** Each panel remembers the moment it was turned on; a flight that landed earlier is paid by the usual rule and its
  pilot is sent nothing, however hard it was.
- **The messages.** The airline's own **safety notice** goes to the pilot first, privately, once per flight, shortly after landing (a bot that was off for a while still sends
  one for a landing in the last three days). A pilot **cannot switch it off** with `notifications`, because it is about their pay. Then, for a landing of **-600 or harder**,
  the light-hearted remark follows (see *Remarks about very hard landings*), in gentler words that say it is the unofficial message and send the pilot off kindly. That
  remark is still the pilot's to switch off, and still comes at most once in six hours. Nothing is ever said in a channel.
- **If in doubt, nothing is filled in.** The landing rate is FsHub's. A flight it gave **no rate** for, or a rate beyond 2,500 feet a minute (a bad reading, not a touchdown),
  or a logbook entry that names no FsHub flight, is **left out of `/setup profit` altogether, profit and pay**, so a hard landing is never paid in full by accident. The
  report lists those flights under **Left alone (safety pay)**, and your managers are sent a message naming each one (once per flight), so someone can look at it on
  FsHub and fill the cells in by hand. A flight whose landing rate simply **couldn't be read yet** (FsHub didn't answer, or the run reached its limit) just waits for the next
  run, and nobody is told.
- **The report to your managers.** When a pilot lands at **Tier 2 or Tier 3**, your managers are sent a private message with the **pilot's name, their FsHub ID (and their
  FsHub username, if it isn't the same as their Discord name), the flight number, the departure and arrival, the time of landing and the landing rate**. The flight number
  is the schedule flight the pilot holds (or is backup for) between those airports, when the bot can tell which; if not, the message says it couldn't match one. A pilot
  who isn't linked to a Discord account is reported all the same (and the message says they weren't sent the notice).
- **The CSV.** The same facts are added, one row a landing, to **`hard-landings.csv`** in the bot's data folder (the folder that holds its database, `data` by default).
  Its columns are Pilot Name, FsHub ID, FsHub Username (if different), Flight Number, Departure-Arrival, Landed (UTC), Landing Rate (fpm), then Tier, Airline and
  FsHub Flight ID. It is made, with a heading, the first time; it opens in Excel with accents intact; and a name or flight number that a spreadsheet could take for a formula
  is written behind an apostrophe. If the file is open in another program the row can't be added, the message to your managers says so, and the row is added the next time the flight is
  seen. The bot never reads the file back or deletes from it.
- **Who the managers are.** The members of the roles an admin set for managing the airline: the roles of `/setup refresh-roles` and the `/setup profit` write role (`who-can-write`).
  Discord only lets a bot list a server's members when **Server Members Intent** is switched on for it in the Discord Developer Portal (Bot, then Privileged Gateway Intents);
  the bot doesn't ask for that itself, so it connects either way. Without it, or with no manager role set, the reports go to the **server owner** instead, so they are never lost
  (the status from `/setup safety-pay` says who it is). At most 25 people are sent one.
- **What it needs.** The bot's FsHub token, the panel linked to its airline's FsHub roster (`/setup fshub link:`) and FsHub flights being read (`/setup fshub
  confirm:on`, the default). The bot says what is missing when you try to turn it on, and `/setup profit` refuses to fill pay for a panel with it on and no token, rather than
  pay without the landing rates.
- **Payroll.** `/payroll` (off by default) pays the Pilot Pay cell exactly as it stands when safety pay is on, because the cut was made when the cell was filled and raising it to
  the usual minimum would undo it.
- **It is a house rule, not a verdict.** A simulator's reading is noisier than an aeroplane's instruments, and FsHub does not say how it measures; the tiers and shares are the
  airline's own rules, set by the CEO of the airline, not something the bot decides. That is why a reading it can't trust is left for a person.

### Paying pilots: `/payroll`

The bot can pay your pilots from the airline's Aeroconomy bank account. It does the sums and the bookkeeping, and an admin looks at the list and presses **Pay**: **nothing is
ever paid without someone pressing it.** It is on for every copy of the bot, and nothing happens until an admin sets it up with `/payroll settings` (a person who runs the bot and
wants none of it can set the environment variable `FPB_DISABLE_PAYROLL=1`, and the command is not registered).

**What it needs**
- The bot's **FsHub token** (the same one `/setup fshub` uses). Aeroconomy accepts it as its API key, and it acts as the account it belongs to, so that account must be an owner or
  manager of the airline's business, which is what lets it pay from the airline's account. Without a token the bot says paying isn't connected, and sends nothing.
- The airline's schedule sheet with a **Pilot Pay** column, as for `/setup profit` (see *Profit and loss from Aeroconomy*), and a **Pilot Info** tab in the same sheet that lists each
  pilot: a name, a **FSHUB ID** and a **Bank Acct** column (the titles can be written a few ways; if the tab has none the bot says which titles it did find). An account looks like
  `2002-0001234`.
- `/payroll settings source-account:<the airline's account> pilot-info:<the link of that tab> enabled:on`. The link must be the Pilot Info tab's own (it ends with `#gid=` and a
  number). `/payroll accounts` lists the accounts the token can see, with their numbers. Turning it on starts paying from the day it was switched on: earlier flights are never put on a
  list unless you give an earlier `start-from`.

**Try it first: the test transfer.** `/payroll test-transfer from:<account> to:<account> amount:1` works out a one-dollar payment, shows it with a **Send** button and sends nothing
until the admin who asked presses it. It only ever moves money between two accounts the token can see (never to an account typed in that it cannot), never more than $10, and
pressing the button twice sends it once. It tells you Aeroconomy's transaction number and what the source account then holds. Do it once each way, say from the airline's account to
yours and back, to know that paying works.

**The daily list.** Every day at the time you chose (12:00 Zulu if you didn't) the bot reads the sheet and makes a list of what is due: each flight ticked as **completed** whose
**Pilot Pay** has an amount, on or after the first day to pay, that hasn't been paid (its **Pilot Paid** box isn't ticked and the bot's ledger has no payment for it). It goes where
`/setup profit send-to` sends its previews (the admin's DMs by default), and the same people may work on it: the admin who set it up and members of the `/setup profit` **who-can-write**
role. `/payroll run` makes one now.
- **The amount** is the Pilot Pay cell, but never less than the airline's rule: at least **$2,000** a flight, and a flight that lost money gets $2,000 for its first 1,000 nm and $1,000
  more for each further 500 nm, by the distance FsHub recorded. (Where `/setup safety-pay` is on, the cell is paid exactly as it stands, because a hard landing has already cut it.)
  The list says when it raised a pay and why. A payment is never more than $500,000.
- **Each payment has a unique ID**, like `32411-KORD-EGLL-111926` (the pilot's FsHub ID, the airports and the date), with the flight number's digits added when the same pilot flies the
  same route twice in a day. It is kept in a **ledger**, and Aeroconomy is sent it as the payment's *idempotency key*, so sending the same payment twice pays once.
- **Flags.** A line with anything about it to check is **not paid** until someone **amends** it (submitting a line unchanged counts as having checked it): the pilot isn't on the Pilot Info
  tab (or is on it twice), has no bank account or one that isn't an account number, has no FsHub ID the bot knows, has a FsHub ID or name that doesn't match what the bot knows, is being paid
  into a different account from last time, or the amount is out of range, or a loss flight's distance couldn't be read.
- **Amend** turns the list into a menu of its payments; pick one and a form opens with its account, amount and unique ID. Amending a payment's amount to **0** leaves it out of that run: it stays unpaid and comes up on the next list.
- **Pay** pays everything that is ready. Before each payment the sheet is read again, and a row that has changed (a different pay, no longer completed, the pilot changed) is skipped and comes
  up on the next list as it now is.

**What happens when it pays**
- The payment is written to the ledger **before** Aeroconomy is asked, so it can never be made twice.
- Aeroconomy takes it, or refuses it (not enough money, an account it doesn't know: nothing is sent, and the line is back on the next list), or **gives no answer**. In that last case the bot
  tries again with the same ID (which is safe), and if there is still no answer nobody knows whether the money moved, so the payment is left marked **no answer**, stays off every list and is
  never tried again by itself. `/payroll history` shows it, and you check the account on Aeroconomy.
- A payment is only counted as paid if Aeroconomy's answer is the payment that was sent: the same amount, to the same account.
- After a payment goes through, the bot ticks **Pilot Paid** on its row (only an empty box is ever ticked) when write-back is on for the panel (`/setup writeback`), and otherwise lists the
  rows to tick by hand.

**What the token can do, and what the bot does with it.** Aeroconomy's API has no separate permission for paying, so the FsHub token can move money from every account its owner controls.
The bot only ever pays from the `source-account` you set, only to the account on a pilot's line (or, for a test transfer, one of the accounts the token can see), and only after a person presses
**Pay** or **Send**. The token is only ever sent to `aeroconomy.com` and FsHub, redirects are never followed, it is never shown or logged, and accounts appear in the log only by their last four
digits. Keep the token to someone you trust with the airline's account, as you would a bank card.

### Twitch chat (optional)

For a host who streams their flying. The bot can join **one Twitch channel's chat** and tell viewers about the streamer's flight, and answer
what chat says to it, in the voice of a cheerful, overworked airline scheduler. It is entirely opt-in: nothing runs, and nothing is sent to Twitch, until the host
connects a Twitch account and names a channel in step 5 of the setup page.

| Viewers type | The bot answers with |
|---|---|
| `!flight` (or `!route`) | the route, callsign and aircraft, the phase, height and speed, how far through the flight it is, and the time to go; or that nobody is flying, and what the last flight was |
| `!distance` | how far there is still to go, and of how many nautical miles in all; or how far the last flight was |
| `!landing` | the last landing rate in feet per minute, with a kind word for it ("butter", "a nice one", "a proper thump") |
| `!aircraft` (or `!plane`) | what the streamer is flying, or flew last |
| `!eta` | the time to go, and roughly when it lands (Zulu) |
| `!commands` | the list above |

A message that names the bot (its Twitch account name), or that answers one of its messages, is answered too: compliments are thanked,
"lazy" is taken with good humour, an insult is waved off, and a question about the flight in plain words ("@botname how far are we?") gets the
same answer as the command. The lines are all family-friendly, and the butt of the joke is always the bot. Anything crude is not answered at
all, and what a viewer typed is never repeated back.

- **Connecting.** Press **Connect to Twitch**. The page shows a short code and a link to Twitch's own page; open it signed in as the Twitch
  account the bot should speak as, type the code and press Authorise. No password and no token is typed or pasted anywhere (Twitch's tokens
  last four hours, so a pasted one would stop working the same day). Twitch hands the bot a sign-in that it keeps in `twitch.json` beside
  `settings.json` (readable by that Windows user only, never written to the log, never sent back to the page) and keeps fresh by itself. It
  asks for two permissions only: to read the chat it is in and to write to it (`user:read:chat`, `user:write:chat`). **Disconnect** on the
  page (or Connections in the Twitch settings) takes it away at any time. If Twitch stops accepting it (the host disconnected the app, changed
  their password, or the bot went 30 days without running) the page says so and the host connects again.
- **Which account.** The bot needs a Twitch account of its own. Make a free account for it, connect that, and make it a moderator of the
  channel (`/mod name`): the replies then come from the bot and not from the streamer, and a moderator is not held back by slow mode or
  followers-only chat and may send 100 messages in 30 seconds where an ordinary account may send 20. The bot will not join a chat as that
  channel's own account (the setup page says to connect a separate one), and it never answers messages from its own account.
- **Whose flights.** The streamer's FsHub pilot: the owner of the FsHub token saved in step 4, or the pilot number given on the page. The
  current flight comes from FsHub's public live feed (no token); the last landing needs the FsHub token.
- **The application ID.** Twitch wants to know which application is asking. This is a public number (a Client ID, not a secret), and this
  app has one built in. A host who would rather use a Twitch application of their own registers one at
  [dev.twitch.tv/console](https://dev.twitch.tv/console) (Client Type: **Public**) and pastes its Client ID under *Advanced* on the page.
- **It never floods a chat.** It only speaks when spoken to. A command has a cooldown (10 seconds for everyone, 4 for one person), a joke has
  one (20 seconds for one person, 5 for the room), it never sends more than 10 messages in 30 seconds or two at once, and it ignores itself
  and the usual chat bots (Nightbot, StreamElements and so on). It answers as a reply to the message that asked.
- **What it reads, and where it goes.** It reads the channel's chat only to see whether a message is for it, and keeps none of it. The only
  thing sent anywhere is its own reply, to Twitch. It talks to `id.twitch.tv` (sign-in), `api.twitch.tv` (find the channel, send a message) and
  `eventsub.wss.twitch.tv` (the chat connection), and to FsHub as for live tracking.
- **If something is wrong** the setup page says what (not connected, the sign-in no longer accepted, no such channel, Twitch not reachable,
  banned from the chat) and the log has the same in a line, and the Discord side of the bot carries on regardless. The two switches on the page
  turn off the commands, or the jokes, separately.

### The grid layout

By default the panel is a **card** for each flight. A server can choose a more compact **grid of buttons** instead with
`/setup layout mode:grid` (`mode:cards` goes back; the cards stay the default and are not changed). The panel is redrawn at once.

- **A button for each flight**, grey, with a coloured dot: 🟡 open (needs a pilot now), 🔵 taken, 🟢 completed in the last 24 hours,
  ⚪ not open yet. The label is the dot, the aircraft, the route, **when the flight opens** as a short date and time and, once it is
  taken, who has it: `🔵 B738 · EGKK✈EGCC · 12/11/26 12:00Z · alice`. The **flight's ID is not on the button**: it is in the card that
  opens when you press it. The date is **day first (16/11/26, as in the UK and Europe) by default, or month first (11/16/26, as in the
  US)**, chosen with `/setup layout dates:mdy` (or `dmy`). A label is the same text for everyone who reads it, and cannot use Discord's
  local-time stamps, so the order is the server's choice and the time is in **UTC** (the `Z`), the zone landing windows are in; the
  card has the full date in each reader's own timezone. A label is at most 80 characters: if it would be longer the pilot is dropped,
  then the aircraft, then the middle of a long chain of airports.
- **A key above "Updated"** in the header says what the dots mean.
- **Pressing a flight** shows its card (everything the panel's card in its default layout shows: the flight's ID, the OPEN stamp or the
  pilot's picture, the full dates and times in the reader's own timezone, the backup; plus when the flight **opened**) **to that person only**, as a private reply that closes by itself
  after 90 seconds, or when they press another flight. For a completed flight it is the completed card (who flew it, when it
  landed, FsHub's link). Discord puts a private reply at the bottom of the channel, so the buttons carry what matters at a glance.
- **15 flights to a message** (Discord allows 5 buttons in a row and 5 rows in a message, and two rows are the panel's own
  buttons), up to ten messages. The panel's buttons (Reserve, Search, Backup pilot, My flights, Complete) are under every message.
- **Collapse and Expand.** Every message has a **Collapse** button that folds it to one line, such as
  `Flights 16–20 · 🟡 3 open · 🔵 2 taken` (numbered by where they come in the panel, not by ID), with an **Expand** button to open it again; the first
  message has **Collapse all** and **Expand all**. **Anyone can fold or unfold**: it is the same message for everyone. A folded
  message **unfolds by itself when nobody has pressed any button on the panel for 10 minutes**. The first message keeps its header
  and buttons when folded. Folds are kept in memory only, so a restart unfolds everything.
- **Completed flights** are green buttons in the grid unless the server has chosen a channel of their own for them with
  `/setup completed channel:`, in which case they appear there as full cards, exactly as before, and the grid has no green buttons.
- A pilot's **List view** (in their direct messages) and **Search** results are unchanged.

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
Completed** box ticked when they press **Complete**, and a backup pilot's name into the **Backup Pilot** cell when they stand by (if the sheet has that
column; cleared again when their spot ends). It touches only those three cells of that flight's row, and
re-reads the tab and finds the row by route and date before every write. The only other things it writes are *blank* cells:
the **Distance (NM)** of a flight, if the sheet has that column (see [The Distance column](#the-distance-column)), and a *blank*
**Profit Made** cell (and the pilot's pay in a blank or `$0` **Pilot Pay** cell beside it), which only happens when an admin asks for exactly that and confirms it (see
[Profit and loss from Aeroconomy](#profit-and-loss-from-aeroconomy-optional)), and the *blank* cells of the **Flight Number** column when
`/setup flight-numbers` is on (see [Flight numbers from Aeroconomy](#flight-numbers-from-aeroconomy)). One more case changes the **Pilot** cell of a
flight that already has a pilot: when the flight's backup flew it instead, the cell takes the backup's name, but only if it still holds the name the bot
wrote for the pilot. It never changes any other cell that has anything in it. It refuses rather than overwrite if the
sheet already names someone else or shows the flight finished, and a *completion* is never recorded if the sheet
can't be updated, so the two never disagree. Names are written as plain text, never as formulas.

Setting it up needs credentials only a person can create: **[docs/WRITEBACK_SETUP.md](docs/WRITEBACK_SETUP.md)**
is the step-by-step (about ten minutes), and it suggests trying it on a copy of the sheet first.
`/setup writeback` checks it and can switch it off per panel. Without credentials nothing changes: the bot only
reads, and **Complete** on a sheet-fed panel explains that the box has to be ticked in the sheet (unless the panel
[works from FsHub](#completing-from-fshub), where Complete works from FsHub's record without write-back).

## The refresh

A linked Google Sheet is re-read **every hour**; any other automatic source (the demo) every 24 hours (a
failed fetch keeps the existing flights, records the error in `/setup panels`, and retries in the next hourly slot, see below). Flights keep their IDs and reservations
across refreshes; new flights get the next ID; flights the source drops are closed and their holders told; a
flight whose route changed loses the reservation on the changed leg. Panels fed by file import don't fetch,
since an admin decides when the list changes. `/setup refresh` re-reads a sheet on demand.

### The hourly slot: all the hourly checks together

The bot's hourly checks (reading each linked **schedule sheet**, reading each linked airline's **FsHub roster**, **completing the flights
FsHub shows flown**, and the read of **Aeroconomy's flight numbers**, which is every sixth hour) all happen **together**, at one minute of
every hour (UTC), instead of each running an hour after its own last run and drifting apart. They run one after another in a single pass, in
this order: the sheets first (so the flights are current), then the FsHub roster and flights, then the completing of flown flights.

- **The minute is fixed for an install** and shown in `/setup panels` (and in the log when the bot starts). It is picked at random the first
  time the bot runs (between 3 and 56 past the hour, so not on the hour itself) and kept in the database, so every copy of the bot does not ask
  FsHub, Google and Aeroconomy at the same instant. It never changes.
- **A check is due when it has not been done since the slot began.** A restart does not move it, a check missed while the bot was off is done as soon
  as it is back, and a read somebody asked for (`/setup refresh`) in the middle of a slot is not done again in that slot.
- **A failure waits for the next slot**: a sheet that could not be read is tried again in the next slot. A FsHub roster or completing check that
  failed for a reason that may pass by itself (FsHub down or busy) is tried again after ten minutes, and then waits for the next slot.
- Not hourly, and so not part of this: the FsHub flight read (every five minutes), live tracking (every 45 seconds), expected landing times
  (every minute), late-departure warnings (every minute), the AeroDAQ market boards (every 15 minutes), the weather boards (every 10 minutes), the midnight (UTC) list of flights
  with no pilot, and the daily check for a new version.

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
(shown beside their name on flights they hold), per Discord user their own settings (whether `/hideunavailable` is on, and
which of the three optional private messages they have switched off with `notifications`, and which hard landings they have been sent a remark or a safety notice about), and per server the channel and message of an AeroDAQ market
board if one is switched on, per panel whether landing safety pay is on (the moment it was turned on, and what percentage of the $2,000 minimum pay a pilot loses after a Tier 2 landing and after a Tier 3 landing), which hard landings it has told a pilot and the managers about, and which flights it left unfilled, and the channel, messages and chosen airports of a weather board if one is. For each pilot who asked for `/banking`: which accounts they chose (name and number) and the number of the newest payment already told, with their sealed token (the key is in `banking.key` beside the database); for each flight someone asked to be told about with `/monitor`: who, the flight number and how far it has got. For each person who asked for a list of a panel in their DMs it keeps their Discord ID, the DM channel and the IDs of the list's messages (until they press Stop updates, or the panel is removed). It also remembers, in memory only, each pilot's Discord picture address for a few hours. If a panel is linked to a FsHub roster, the airline's FsHub flights of the last week
are kept too (pilot ID and name, route, times, aircraft), until `/setup fshub confirm:off` or a week after landing (how long each flight took, with its route and aircraft but no pilot, is kept for six months for the late-departure warning),
and that roster's pilots who have a Discord
account listed (name, FsHub ID, Discord ID) are kept the same way. It holds no passwords from users, and a token only from a pilot who turned on `/banking` (see *Payment messages*): sealed, in a table of its own, and deleted when they turn it off. Finished flights are forgotten a week after their deadline. Pilots must allow DMs from
server members for the Reserve conversation to work; if they haven't, the bot says how to turn it on. What a pilot sends in a DM to reserve a flight before the bot has their FsHub pilot ID is kept, as written, for the ten minutes the conversation stays open and then forgotten. When someone reserves from a DM, or asks for `commands`, Discord is asked, by their ID, whether they are a member of the server (and what roles they hold and whether they can see the panel's channel); nothing about the answer is kept.

Paying pilots keeps, per airline, how it is set up (the airline's account number, the link of the Pilot Info tab, the first day to pay and the time of the daily list), and a **ledger** of every payment it has made or tried (the pilot's name and FsHub ID, the account number paid into, the amount, the unique ID, the result and when). A pay list waiting to be checked (it carries the pilots' account numbers, read from the airline's own sheet) is kept for a day at most, and is deleted once it is paid or replaced. Nothing of this is sent anywhere but Aeroconomy, with each payment.

An airline that turns on `/setup safety-pay` also gets one plain file beside the database, `hard-landings.csv`: a row for each Tier 2 or Tier 3 landing with the pilot's Discord name, FsHub ID and FsHub name, the flight number, route, time of landing and landing rate. Nothing reads it but you; delete it whenever you like (the bot makes a new one with its heading the next time it has a row to add). The same facts are sent as a private message to the people with the airline's manager roles, or to the server owner when there are none the bot can find.

**What the bot contacts**, and when: Discord (always); Google Sheets (`docs.google.com`, for a linked sheet, and
the Sheets API only if write-back is set up); `aerodaq.com` (only for `/fuel` or a market board); `aeroconomy.com` (its public contract pages, only for a panel that has `/setup flight-numbers` on; and, only when an admin runs `/setup profit`, the airline's aircraft and logbooks, read with the FsHub token in plain `GET` requests);
`aeroconomy.com` payments (`POST /banking/payments`, with the FsHub token, **only** when an admin presses **Pay** under `/payroll`, or **Send** on a `/payroll test-transfer`; and `GET /banking/accounts` for `/payroll accounts` and test transfers); `aeroconomy.com` banking (`/banking/accounts` and each account's transactions, read with a pilot's own token, in plain `GET` requests, only for a pilot who turned on `/banking`, every five minutes for each account they chose; see *Payment messages*); `movements.fshub.io` is also asked for the airline of any flight someone is watching with `/monitor`, once a minute (see *Watching a flight*);
`metar.vatsim.net` (VATSIM's public METAR service, no account or key, only when someone DMs the bot `metar <airport>`, presses an airport on a weather board or uses its Search button, and, for a server with a weather board, once every ten minutes, all its airports in one request; only the airport codes are sent; read-only; see *Weather reports* and *The weather board*);
`movements.fshub.io` (FsHub's public live-flight feed, no account or key: an airline's list of flights, one request for the airline about once a minute, shared by the landing estimates, live tracking and `/monitor`; and, only for a followed pilot that list does not have, the list of pilots online and the current flight of that pilot if online, asked about by their public FsHub ID, at most about once every 45 seconds and only while someone is being followed; read-only, nothing else is sent; see *Live tracking*); `davidmegginson.github.io` (OurAirports' public airport list, `airports.csv`, a plain download of about 12 MB with no account or key, read when a late-departure warning or a sheet's Distance column needs the position of an airport the bot does not know yet, never twice within ten minutes and otherwise at most twice a day; the positions of all the airports in it that have an airline-style code are kept (about 35,000, 2 to 3 MB), and nothing else from it; nothing is sent but the request itself);
`api.github.com` (the Windows app's daily update check, which can be switched off); and `fshub.io`, **only if
the host saved a FsHub token** (to check a typed pilot ID and to read a linked airline's roster and recent flights; read-only, the
token travels in a request header to `fshub.io` and nowhere else). It does not contact the Aeroconomy site, and
never sends names, IDs or other personal data to anyone: the only thing asked of FsHub about a person is the
pilot ID they typed. **Only if the host connected a Twitch account and chose a channel** (*Twitch chat*), it also contacts `id.twitch.tv`, `api.twitch.tv` and `eventsub.wss.twitch.tv`: the sign-in, the channel's chat as it arrives (read to see whether a message is for the bot, and not kept) and the bot's own replies; the Twitch sign-in is a file of its own beside the settings, and is deleted by *Disconnect*. (The green OPEN stamp on a card is a picture kept inside the bot and attached to the panel's
messages; it is drawn by `scripts/make-stamp.mjs`. A pilot's picture is Discord's own, asked of Discord.)

## Development

```bash
npm test              # 2431 tests: import parser, Google Sheet reader and write-back (against a pretend Google), job rules, panel (open flights, completed flights, the 1-to-7-day period, overlapping redraws), DM conversation and FsHub pilot IDs, the list view in pilots' DMs, the METAR decoder, VATSIM client and weather DM command, the completed-flights channel, the OPEN stamp and pilot pictures on cards, FsHub client, roster sync, flight confirmation and the hourly automatic completion (against a pretend FsHub), live tracking of take-offs and landings (against a pretend FsHub live feed and FsHub), the grid layout (buttons, folds, the private flight cards), the late-departure warnings (flight times learned from FsHub flights or worked out from the airports' positions, read from a pretend OurAirports list), the scheduler, roles, refresh, reminders, database upgrades, AeroDAQ (against real captured responses), update check, host app (settings, setup page security, supervisor)
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
