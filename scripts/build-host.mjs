// Builds release/FlightPanelBot.exe: the Windows tray app that hosts the bot.
//
//   npm run build:host                     bundles the bot, embeds this machine's Node.js, compiles the launcher
//   npm run build:host -- --node <node.exe> use a different Node.js binary
//   npm run build:host -- --out <folder>    write the result somewhere other than release/ (the old exe may be running)
//   npm run build:host -- --debug           a DIAGNOSTIC build for chasing a problem on someone else's machine: writes release-debug/FlightPanelBot-DEBUG.exe,
//                                           which logs everything to its own bot-debug.log. Not part of the release cycle; never published.
//   npm run build:host -- --test            a TEST build: a diagnostic build whose clock runs fast (default 288 times: a day in five minutes, an hour in twelve and a half
//                                           seconds) so the daily and hourly checks can be watched, that reads made-up schedules from local files (Google is never
//                                           asked) and keeps its own data folder. Writes release-test/FlightPanelBot-TEST.exe. --scale <n> changes the speed.
//
// The result is ONE exe. It carries the bot and a Node.js runtime inside it, unpacks them on first run, and
// needs nothing installed on the host's computer. Everything is built with tools already in this repo plus
// the C# compiler that ships with Windows.

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, gzipSync, deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const test = args.includes('--test');
// A test build is a diagnostic build too: the same detailed log, and sheets kept in local files.
const debug = args.includes('--debug') || test;
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const nodeExe = resolve(argValue('--node') ?? process.execPath);
// A running FlightPanelBot.exe is locked by Windows, so --out lets a new build go somewhere else meanwhile.
const outDir = resolve(argValue('--out') ?? join(root, test ? 'release-test' : debug ? 'release-debug' : 'release'));
const EXE_NAME = test ? 'FlightPanelBot-TEST.exe' : debug ? 'FlightPanelBot-DEBUG.exe' : 'FlightPanelBot.exe';
// How many times faster than real time a test build's clock runs: 288 makes a day last five minutes.
const scale = Number(argValue('--scale') ?? process.env.FPB_TIME_SCALE ?? 288);
if (test && !(scale >= 2 && scale <= 100_000)) throw new Error('--scale must be a number from 2 to 100000 (288 makes a day last five minutes).');
const work = join(outDir, 'work');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const step = (text) => console.log(`\n> ${text}`);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

if (process.platform !== 'win32') throw new Error('The host app is built for Windows, on Windows.');
if (!existsSync(nodeExe)) throw new Error(`Node.js not found at ${nodeExe}`);

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

/* ------------------------------------------------------------------ 1. bundle the bot */

// The built-in person for the once-a-day note: FPB_NOTE_USER in the environment, else "noteUser" in build-local.json (git-ignored, so the
// ID is never in the repository; a clone without that file builds an exe with nobody built in). A diagnostic build never carries one.
function readNoteUser() {
  if (debug) return '';
  let raw = process.env.FPB_NOTE_USER ?? '';
  if (!raw) {
    try {
      raw = String(JSON.parse(readFileSync(join(root, 'build-local.json'), 'utf8')).noteUser ?? '');
    } catch {
      raw = '';
    }
  }
  raw = raw.trim();
  if (raw && !/^\d{15,21}$/.test(raw)) throw new Error('The built-in note user (FPB_NOTE_USER or build-local.json "noteUser") must be a Discord user ID: 15 to 21 digits.');
  return raw;
}
const noteUser = readNoteUser();

step('Bundling the bot into one file');
console.log(`  once-a-day note: ${noteUser ? 'a person is built in (the ID is not shown)' : 'nobody built in'}`);
await build({
  entryPoints: [join(root, 'src/host/main.ts')],
  outfile: join(work, 'bot.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // Optional native speed-ups that discord.js looks for and happily does without.
  external: ['bufferutil', 'utf-8-validate', 'zlib-sync', 'erlpack', '@discordjs/opus'],
  // Some bundled packages use require(); give the ES module one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  legalComments: 'external',
  // src/util/debugBuild.ts reads the first: true only for a --debug build, so a normal build carries none of the extra logging.
  // src/util/builtInNote.ts reads the second: the person the once-a-day note goes to unless settings.json says otherwise.
  // src/util/clock.ts reads __FPB_FAST__: how many times faster than real time the bot's clock runs (1 in every build but a test build; the test-only
  // code in src/testbuild is in every bundle but never used unless it is more than 1).
  define: { __FPB_DEBUG__: String(debug), __FPB_FAST__: String(test ? scale : 1), __FPB_NOTE_USER__: JSON.stringify(noteUser) },
  logLevel: 'warning',
});
const botMjs = readFileSync(join(work, 'bot.mjs'));
console.log(`  bot.mjs ${mb(botMjs.length)}`);

/* ------------------------------------------------------------------ 2. the icon (drawn here, no image tools needed) */

step('Drawing the icon');

/** A white airliner on a blue rounded square, as RGBA pixels at the given size. */
function drawIcon(size) {
  const half = [
    [0.5, 0.1], [0.545, 0.2], [0.55, 0.4], [0.9, 0.62], [0.9, 0.69], [0.55, 0.62], [0.54, 0.8], [0.68, 0.88], [0.68, 0.93], [0.5, 0.89],
  ];
  const plane = [...half, ...half.slice(1, -1).reverse().map(([x, y]) => [1 - x, y])];
  const inside = (x, y, poly) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const radius = 0.22;
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, radius), 1 - radius);
    const cy = Math.min(Math.max(y, radius), 1 - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  const px = Buffer.alloc(size * size * 4);
  const samples = 4;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (pxl + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          if (!inRounded(x, y)) continue;
          bg++;
          if (inside(x, y, plane)) fg++;
        }
      }
      const total = samples * samples;
      const t = py / size;
      const r = Math.round(0x4c + (0x36 - 0x4c) * t);
      const g = Math.round(0x6e + (0x4f - 0x6e) * t);
      const b = Math.round(0xf5 + (0xc7 - 0xf5) * t);
      const alpha = bg / total;
      const white = bg === 0 ? 0 : fg / bg;
      const o = (py * size + pxl) * 4;
      px[o] = Math.round(r + (255 - r) * white);
      px[o + 1] = Math.round(g + (255 - g) * white);
      px[o + 2] = Math.round(b + (255 - b) * white);
      px[o + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

function encodePng(size, rgba) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => ({ size: s, data: encodePng(s, drawIcon(s)) }));
writeFileSync(join(work, 'tray.png'), pngs.find((p) => p.size === 32).data);
{
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = Buffer.alloc(16 * pngs.length);
  let offset = 6 + entries.length;
  pngs.forEach((p, i) => {
    const e = i * 16;
    entries[e] = p.size === 256 ? 0 : p.size;
    entries[e + 1] = p.size === 256 ? 0 : p.size;
    entries.writeUInt16LE(1, e + 4); // colour planes
    entries.writeUInt16LE(32, e + 6); // bits per pixel
    entries.writeUInt32LE(p.data.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += p.data.length;
  });
  writeFileSync(join(work, 'icon.ico'), Buffer.concat([header, entries, ...pngs.map((p) => p.data)]));
}

/* ------------------------------------------------------------------ 3. compress what goes inside the exe */

step(`Compressing the Node.js runtime (${mb(statSync(nodeExe).size)}) and the bot`);
const nodeBytes = readFileSync(nodeExe);
writeFileSync(join(work, 'node.exe.gz'), gzipSync(nodeBytes, { level: 9 }));
writeFileSync(join(work, 'bot.mjs.gz'), gzipSync(botMjs, { level: 9 }));
console.log(`  node.exe.gz ${mb(statSync(join(work, 'node.exe.gz')).size)}, bot.mjs.gz ${mb(statSync(join(work, 'bot.mjs.gz')).size)}`);

const nodeVersion = spawnSync(nodeExe, ['--version'], { encoding: 'utf8' }).stdout.trim();
const buildId = createHash('sha1').update(botMjs).update(nodeVersion).update(String(nodeBytes.length)).digest('hex').slice(0, 12);
const version = test ? `${pkg.version}-test` : debug ? `${pkg.version}-debug` : pkg.version;
// Windows wants four numbers: 0.3.3 becomes 0.3.3.0, and a hotfix (0.3.3.1) is used as it is.
const assemblyVersion = /^\d+\.\d+\.\d+\.\d+$/.test(pkg.version) ? pkg.version : `${pkg.version}.0`;

// The user manual (a PDF) is carried inside the exe and opened from the tray menu. It is written outside this repository
// (from the online manual), so it is looked for: --manual <file>, else next to the new exe, else in release/. With none
// found the exe is built without it and its menu has no manual entry.
const MANUAL_NAME = 'FlightPanelBot-Server-Owner-Manual.pdf';
// A diagnostic build goes to someone who already has the manual, so it is left out.
const manualPdf = debug ? undefined : [argValue('--manual'), join(outDir, MANUAL_NAME), join(root, 'release', MANUAL_NAME)].filter(Boolean).map((p) => resolve(p)).find(existsSync);
if (manualPdf) {
  if (readFileSync(manualPdf).subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error(`${manualPdf} is not a PDF.`);
  console.log(`  manual ${mb(statSync(manualPdf).size)} (${manualPdf})`);
} else {
  console.log(`  no ${MANUAL_NAME} found (pass --manual <file>): building without the in-app manual`);
}

writeFileSync(
  join(work, 'BuildInfo.cs'),
  `namespace FlightPanelBot { internal static class BuildInfo { public const string Version = "${version}"; public const string BuildId = "${buildId}"; public const bool Debug = ${debug}; public const bool Test = ${test}; } }\n`,
);
writeFileSync(
  join(work, 'AssemblyInfo.cs'),
  `using System.Reflection;
[assembly: AssemblyTitle("Flight Panel Bot")]
[assembly: AssemblyDescription("Runs a virtual airline's Discord flight panel bot from the Windows notification area.")]
[assembly: AssemblyCompany("UncappingBadger")]
[assembly: AssemblyProduct("Flight Panel Bot")]
[assembly: AssemblyCopyright("MIT licence. Unofficial: not affiliated with FsHub, Aeroconomy, AeroDAQ, VATSIM or Discord.")]
[assembly: AssemblyVersion("${assemblyVersion}")]
[assembly: AssemblyFileVersion("${assemblyVersion}")]
`,
);

/* ------------------------------------------------------------------ 4. compile the launcher */

step('Compiling the launcher with the C# compiler that comes with Windows');
const csc = join(process.env.windir ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!existsSync(csc)) throw new Error(`The C# compiler was not found at ${csc}`);
mkdirSync(outDir, { recursive: true });
const exe = join(outDir, EXE_NAME);
rmSync(exe, { force: true });
const compile = spawnSync(
  csc,
  [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    '/codepage:65001',
    `/out:${exe}`,
    `/win32icon:${join(work, 'icon.ico')}`,
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    `/resource:${join(work, 'node.exe.gz')},node.exe.gz`,
    `/resource:${join(work, 'bot.mjs.gz')},bot.mjs.gz`,
    `/resource:${join(work, 'tray.png')},tray.png`,
    ...(manualPdf ? [`/resource:${manualPdf},manual.pdf`] : []),
    join(root, 'host', 'launcher', 'Launcher.cs'),
    join(work, 'BuildInfo.cs'),
    join(work, 'AssemblyInfo.cs'),
  ],
  { encoding: 'utf8' },
);
process.stdout.write(compile.stdout ?? '');
process.stderr.write(compile.stderr ?? '');
if (compile.status !== 0) throw new Error('The launcher did not compile.');

/* ------------------------------------------------------------------ 5. notices and checksum */

step('Writing the licence notices and checksum');
const debugReadme = (v) => `Flight Panel Bot ${v}  -  DIAGNOSTIC BUILD (not a release)

This is a special build of the bot made only to find out what is going wrong. It does the same job as the normal
program, with the same settings and data, but it writes a very detailed log of its own.

IN THIS BUILD a linked sheet is read every 2 minutes (within a minute after that, as the bot checks once a minute), not once
an hour, so the Distance fill can be watched without waiting. The other hourly checks are unchanged.

THIS BUILD NEVER WRITES TO GOOGLE, and the Google key is not used. The airline's schedule is copied once from the
sheet's public link into a file on this computer, and from then on the bot reads that file and writes into it: pilot
names, ticks and the Distance column all go there, so nothing in the real sheet can change. The files are in
        %APPDATA%\\FlightPanelBot\\data\\debug-sheets
(one .csv for each sheet and tab: open it in Excel or Google Sheets to see what the bot wrote). Delete a file to take
a fresh copy of the schedule from Google the next time the bot reads it. A number format cannot be kept in a .csv, so
the formats of cells are in a small file beside it, <the .csv's name>.formats.json. Write a cell into it by hand to see
how the bot treats a Distance cell formatted as a date, for example   { "B5": { "type": "DATE" } }

What to do:
 1. Right-click the Flight Panel Bot icon near the clock and choose Quit, so the normal bot is not running.
    (Only one copy can run at a time.)
 2. Double-click FlightPanelBot-DEBUG.exe. It uses your existing settings, so the bot comes back by itself.
    Its icon's tooltip says "Flight Panel Bot DEBUG".
 3. Use the bot for about an hour as you normally would, and also try the things you have had trouble with
    (for example /setup refresh, and /setup refresh-roles with a member who has the role). Write down roughly
    what time you tried each one. To follow the log as it is written, run this in PowerShell:
        Get-Content -Wait -Tail 50 "$env:APPDATA\\FlightPanelBot\\logs\\bot-debug.log"
    The lines that begin [dbg] distances: and [dbg] airports: say what the bot decided about each Distance cell
    and why it did or did not read the airport list.
 4. Right-click the icon, choose Quit, and send us the file  bot-debug.log  from the folder
        %APPDATA%\\FlightPanelBot\\logs
    (the icon's menu item "Open the log" opens it). Then start the normal FlightPanelBot.exe again.

The log holds Discord user and server IDs, flight codes and the pilot names in your airline's sheet. It does not
hold your bot token, your Google key or a FsHub token. The normal bot.log is left alone. The local copy of the
schedule in debug-sheets holds the same pilot names.

This build never checks for updates. Please do not enable "Start with Windows" while using it.
`;
const testReadme = (v, speed) => `Flight Panel Bot ${v}  -  TEST BUILD (not a release)

A build made to WATCH the bot's timers fire and to see how it performs. Its clock runs ${speed} times faster than real time:
a day lasts ${(24 * 60 / speed).toFixed(1)} minutes and an hour ${(3600 / speed).toFixed(1)} seconds. So the checks that happen once a day (the midnight list of flights
without a pilot, the tidy-up of it, flights leaving the panel a day after they were flown, the daily check) happen every
${(24 * 60 / speed).toFixed(1)} minutes, and the hourly ones (reading the schedule, the hourly slot) every ${(3600 / speed).toFixed(1)} seconds. Every line of the log shows the real time and,
in [clock ...], the time the bot believes it is.

NOTHING HERE TOUCHES YOUR REAL BOT.
 * It keeps everything in its own folder, %APPDATA%\\FlightPanelBot-TEST (settings, database, log), and its setup page is on
   port 47812. It can run beside the real bot, but give it a Discord bot of its own: two programs signed in as the same Discord
   bot would both answer every button.
 * Google is never asked for anything. Whatever sheet link you give /setup sheet, the flights are made up (invented airline,
   pilots and flights) and kept in a file in %APPDATA%\\FlightPanelBot-TEST\\data\\debug-sheets. While it runs, the made-up
   sheet keeps changing the way a real one does: new days of flights appear, pilots put their names against flights, flown
   flights get ticked and a profit, a few are cancelled. Delete the file to start the made-up airline again.
 * FsHub, Aeroconomy accounts, Twitch and the daily note are switched off, whatever the settings say.

What to do:
 1. Double-click FlightPanelBot-TEST.exe. Its setup page opens (port 47812): give it the token of a TEST Discord bot, add it to a
    test server, then in that server run   /setup panel-add   and pick a channel. The panel is given the made-up sheet by itself
    (or run  /setup sheet link:https://docs.google.com/spreadsheets/d/FpbTestSheet00000000000000000001/edit ).
 2. Watch the log (the icon's menu has "Open the log", or in PowerShell):
        Get-Content -Wait -Tail 50 "$env:APPDATA\\FlightPanelBot-TEST\\logs\\bot-debug.log"
    Lines that start  [clock]  say a new day of the bot's clock has begun;  [fired]  say a step did something;  [test]  say what the
    made-up sheet's feeder changed;  [perf]  (once a minute) say how the bot is doing: how late its one thread is for everything
    else, memory, the size of the database, and how many times and how long each scheduled step ran;  Slow:  lines say something
    a person would have waited for.
 3. Press buttons, reserve and complete flights, run /setup refresh, as you would. Then quit from the icon's menu.

Please do not enable "Start with Windows" for this build, and do not give it your real bot's token.
`;

// Node.js's own licence file (it also covers V8, OpenSSL, ICU and the rest that node.exe contains). Windows
// installs don't ship it next to node.exe, so a copy for the version we embed is kept in the repo.
const nodeLicense = [join(dirname(nodeExe), 'LICENSE'), join(dirname(nodeExe), 'LICENSE.txt'), join(root, 'host', 'licenses', 'NODE_LICENSE.txt')].find(existsSync);
if (!nodeLicense) throw new Error("Node.js's licence text is missing (host/licenses/NODE_LICENSE.txt); it must ship with node.exe.");
const legal = existsSync(join(work, 'bot.mjs.LEGAL.txt')) ? readFileSync(join(work, 'bot.mjs.LEGAL.txt'), 'utf8') : '';
const thirdParty = existsSync(join(root, 'THIRD_PARTY_NOTICES.md')) ? readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8') : '';
writeFileSync(
  join(outDir, 'THIRD_PARTY_NOTICES.txt'),
  [
    'Flight Panel Bot includes the following open-source software.',
    '',
    thirdParty,
    '',
    '======================================================================',
    `Node.js ${nodeVersion} (the runtime inside FlightPanelBot.exe)`,
    '======================================================================',
    nodeLicense ? readFileSync(nodeLicense, 'utf8') : 'Node.js is released under the MIT licence: https://github.com/nodejs/node/blob/main/LICENSE',
    '',
    legal ? '======================================================================\nLicence notices embedded in bundled packages\n======================================================================\n' + legal : '',
  ].join('\n'),
);
copyFileSync(join(root, 'LICENSE'), join(outDir, 'LICENSE.txt'));
// The same manual, as a file beside the exe (for the GitHub Release page), whichever folder it was found in.
if (manualPdf && resolve(manualPdf) !== resolve(join(outDir, MANUAL_NAME))) copyFileSync(manualPdf, join(outDir, MANUAL_NAME));
writeFileSync(
  join(outDir, 'README.txt'),
  test
    ? testReadme(version, scale)
    : debug
    ? debugReadme(version)
    : `Flight Panel Bot ${version}
By UncappingBadger. Unofficial: not affiliated with FsHub, Aeroconomy, AeroDAQ, VATSIM or Discord.

Runs your virtual airline's flight panel in your own Discord server, from your own Windows PC.

1. Double-click FlightPanelBot.exe. Windows may say it "protected your PC" because the program is not
   signed: press "More info", then "Run anyway".
2. A small icon appears near the clock (look under the ^ arrow if you don't see it). Drag it onto the taskbar
   to keep it visible. Your web browser opens the setup page.
3. Follow the page: create your own Discord bot, paste its token, then press "Add the bot to a server".
   Type /setup in your server and follow the server owner's manual. No FsHub account or token is needed.
   (If you want, the setup page also takes a FsHub token, so the bot can check the pilot IDs people type and
   match pilots to your airline's FsHub roster. Without one the bot never contacts FsHub.)

Right-click the icon for settings, the user manual, the log, restarting the bot, "Start with Windows", and Quit.
The bot only works while this program is running, so keep it on a computer that stays on.

Your settings, data and logs are in %APPDATA%\\FlightPanelBot. Deleting that folder resets everything.

Updates: once a day the program asks GitHub whether a newer version has been released. If there is one, the
icon pops up a notice (once), its menu shows "A new version is available", and the setup page links to the
release page. Nothing is downloaded for you: download the new FlightPanelBot.exe from that page, quit this
one from the icon, and run the new one. Your settings and data carry over. The check can be switched off on
the setup page, and only sends the program's name and version to github.com.

The bot also uses AeroDAQ (aerodaq.com, an in-game market, not real money) for /fuel and the optional market
board, but only when someone uses them. When someone DMs the bot "metar <airport>", it asks VATSIM's public METAR
service (metar.vatsim.net) for that airport's weather report; only the airport code is sent. If you save a FsHub token, it also asks fshub.io (read-only) about the
pilot IDs people type and about the roster and recent flights of an airline you link with /setup fshub.

The server owner's manual is inside the program: right-click the icon and choose User manual. The same PDF is
FlightPanelBot-Server-Owner-Manual.pdf (when it is in this folder).

Licences: see LICENSE.txt and THIRD_PARTY_NOTICES.txt.
Checksum: compare FlightPanelBot.exe.sha256 with the file's SHA-256 if you want to be sure it is unaltered.
`,
);
const sha = createHash('sha256').update(readFileSync(exe)).digest('hex');
writeFileSync(join(outDir, `${EXE_NAME}.sha256`), `${sha}  ${EXE_NAME}\n`);
rmSync(work, { recursive: true, force: true });

console.log(`\nBuilt ${exe}`);
console.log(`  size    ${mb(statSync(exe).size)}`);
console.log(`  version ${version} (build ${buildId}, Node.js ${nodeVersion})`);
console.log(`  sha256  ${sha}`);
