# Letting the bot write to your airline's Google Sheet

By default the bot only **reads** the schedule sheet. With write-back on, pilots can do these from Discord and
the sheet follows:

| A pilot… | The bot writes… |
|---|---|
| reserves a flight | their name into the **Pilot** cell of that flight's row |
| gives the flight back (or an admin frees it) | clears that cell, but only if it still holds the name the bot wrote |
| presses **Complete** and confirms | their name into **Pilot** if the cell was empty, and ticks **Flight Completed** |
| tells the bot `name <their name>` in a DM | changes the name the bot wrote on their open flights |

It never writes anywhere else: no other cell, no other tab (the "Pilot Info" tab is never read or written), no
formatting. Before every write it reads the tab again and finds the flight's row by its route and date, so
inserting or sorting rows is safe. If the sheet already names someone else, or already shows the flight
completed or cancelled, the bot refuses and tells the pilot, rather than overwriting.

Writing needs a **Google service account**: a robot Google account that the sheet's owner shares the sheet
with. Neither the bot nor its developer can create one for you, and nobody should hand out their own Google
password for this. It takes about ten minutes and is free.

## 1. Create the service account (once)

Whoever runs the bot does this, signed in to any Google account.

1. Go to <https://console.cloud.google.com/> and create a project (any name, e.g. "Flight panel bot").
2. **APIs & Services → Library**, search for **Google Sheets API**, and press **Enable**.
3. **APIs & Services → Credentials → Create credentials → Service account.** Give it a name and finish
   (it needs no roles).
4. Open the service account, then **Keys → Add key → Create new key → JSON.** A `.json` file downloads. This is
   the bot's key: **anyone holding it can edit every sheet shared with the account.** Keep it out of shared
   folders, chats and screenshots.
5. Note the account's address. It looks like `flight-bot@your-project.iam.gserviceaccount.com`, and is also the
   `client_email` field in the file.

## 2. Tell the bot where the key is

Put the file somewhere only you can read, e.g. `F:\Claude Projects\AeroconomyBot\secrets\google-key.json`, and add
this line to `.env`:

```
GOOGLE_SERVICE_ACCOUNT_FILE=secrets/google-key.json
```

Restart the bot. It logs `Google Sheets write-back is available` and the address to share with. (If the path
or file is wrong it says so and stops, rather than quietly running without it.)

## 3. Share the sheet with it (the sheet's owner does this)

Open the schedule sheet → **Share** → add the service account's address → role **Editor** → untick "Notify
people" → **Share**. A *Viewer* is not enough. The bot never asks for any other permission, and the owner can
take it away at any time by removing that address.

## 4. Check it

In Discord, run `/setup sheet link:<the sheet>` (or `/setup writeback` if it's already linked). You should see
**✅ Write-back is on.** If it says it can't open the sheet, the share in step 3 is missing or the address is
wrong. `/setup writeback mode:off` switches writing off for a panel while keeping the reading.

**Try it on a copy first.** Make a copy of the sheet (File → Make a copy), share the copy with the service
account, link the copy to a test panel, and reserve and complete a flight. Check the Pilot cell and the box in
the copy before pointing a real panel at the real sheet.

## Good to know

- **Names.** The bot writes the pilot's server nickname the first time (their Discord name if they have none).
  If the sheet uses another name for them (it often matches an in-game name that payroll formulas look up), they
  DM the bot `name Alex Smith` once and it uses that from then on, including on flights already in the sheet.
- **One leg per row.** Write-back applies to flights that are a single row with a single leg, which is how the
  schedule sheet is laid out. A flight with several legs has to be ticked in the sheet by hand.
- **If Google can't be reached,** a reservation still stands in Discord and the pilot is told it isn't in the
  sheet yet. A *completion* is not recorded at all in that case, so the bot and the sheet never disagree.
- **The sheet is the record.** If someone types a different name into a flight's Pilot cell, the bot leaves it
  alone and shows both. If an admin unticks *Flight Completed*, the flight reopens on the next hourly read
  (ten minutes of grace is given right after a pilot completes one, since the sheet can lag).
- **Demo mode never writes to a real sheet** unless `AEROBOT_DEMO_WRITEBACK=1` is set, and then only to a sheet
  shared with the service account.
- **Names are stored as plain text.** Whatever a pilot's name contains, the bot writes it as text, so it can't
  be turned into a formula in your sheet.
- **Revoking.** Remove the service account's address from the sheet's sharing, or delete the key in Google
  Cloud, and writing stops at once.
