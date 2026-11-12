# Draft: asking FsHub for Aeroconomy job data

A message you can send FsHub (their forum's Developers section, the contact form at fshub.io/contact, or
their Discord's Aeroconomy channel). Fill in the bracketed parts and trim to taste. It is a draft, so check
the details before sending.

---

**Subject:** Read-only API access to Aeroconomy job / virtual airline assignment data for a Discord bot

Hi FsHub team,

I'm building a Discord bot for **[virtual airline name]** that lets pilots reserve flights and see at a glance
who is flying what. Pilots press a Reserve button on a panel, the bot confirms with them in DM, and the panel
shows each pilot's name next to the flight (and per leg for multi-leg jobs), so nobody doubles up.

The bot needs a list of the airline's open jobs, and I can't find a documented way to read it. The Aeroconomy
for Developers page in the wiki is marked Work In Progress, and the FsHub v3 REST API doesn't expose jobs or
assignments. I'd much rather use an official route than scrape the website, so I'm writing to ask whether
you can offer one.

**What the bot would need (read-only):**

- The open jobs/assignments for a given virtual airline, **[or, if that's not how Aeroconomy models it, the
  Pilots for Hire job list]**.
- For each job: a stable ID, the legs (departure and arrival airport, in order), the required aircraft type,
  when it becomes available and the deadline by which it must be completed.
- Authentication with a normal FsHub personal access token (`X-Pilot-Token`), as the v3 API does today.

**How it would be used:** one request per virtual airline every 24 hours (I'm happy to go slower), cached on
our side, with no writes back to FsHub. The bot only displays the jobs and records which Discord user has
reserved them. It doesn't submit flights or touch Aeroconomy accounts or balances.

If a documented endpoint, an early-access API, an export format (CSV/JSON) that a VA admin can download, or a
webhook would suit you better, any of those would work. The bot already accepts a CSV/JSON import and a
pluggable source, so it can adopt whatever you provide quickly.

Please let me know if there's a way forward, or if there's anything I should know first (terms of use, rate
limits, premium requirements). Thanks for FsHub and Aeroconomy, and for any help.

**[your name]** · **[virtual airline]** · **[contact / Discord handle]**

---

## Notes for you

- What I found while researching: Aeroconomy's developer page is "Work In Progress", PFH jobs are reached
  through FsHub's desktop app (which authenticates with an FsHub API token) and were premium-only during
  testing, and FsHub's blog says Aeroconomy is "API-first" and that developers and VAs can build on it. That
  last point is why this request is reasonable.
- Don't send anyone your FsHub token. Only mention that you'd use one.
- If they answer with a documented endpoint, share it and the bot can get a real source written against it.
