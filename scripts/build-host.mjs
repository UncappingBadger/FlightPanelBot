// Builds release/FlightPanelBot.exe: the Windows tray app that hosts the bot.
//
//   npm run build:host                     bundles the bot, embeds this machine's Node.js, compiles the launcher
//   npm run build:host -- --node <node.exe> use a different Node.js binary
//   npm run build:host -- --out <folder>    write the result somewhere other than release/ (the old exe may be running)
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
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const nodeExe = resolve(argValue('--node') ?? process.execPath);
// A running FlightPanelBot.exe is locked by Windows, so --out lets a new build go somewhere else meanwhile.
const outDir = resolve(argValue('--out') ?? join(root, 'release'));
const work = join(outDir, 'work');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const step = (text) => console.log(`\n> ${text}`);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

if (process.platform !== 'win32') throw new Error('The host app is built for Windows, on Windows.');
if (!existsSync(nodeExe)) throw new Error(`Node.js not found at ${nodeExe}`);

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

/* ------------------------------------------------------------------ 1. bundle the bot */

step('Bundling the bot into one file');
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
const version = pkg.version;

writeFileSync(
  join(work, 'BuildInfo.cs'),
  `namespace FlightPanelBot { internal static class BuildInfo { public const string Version = "${version}"; public const string BuildId = "${buildId}"; } }\n`,
);
writeFileSync(
  join(work, 'AssemblyInfo.cs'),
  `using System.Reflection;
[assembly: AssemblyTitle("Flight Panel Bot")]
[assembly: AssemblyDescription("Runs a virtual airline's Discord flight panel bot from the Windows notification area.")]
[assembly: AssemblyCompany("UncappingBadger")]
[assembly: AssemblyProduct("Flight Panel Bot")]
[assembly: AssemblyCopyright("MIT licence. Unofficial: not affiliated with FsHub, Aeroconomy, AeroDAQ or Discord.")]
[assembly: AssemblyVersion("${version}.0")]
[assembly: AssemblyFileVersion("${version}.0")]
`,
);

/* ------------------------------------------------------------------ 4. compile the launcher */

step('Compiling the launcher with the C# compiler that comes with Windows');
const csc = join(process.env.windir ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!existsSync(csc)) throw new Error(`The C# compiler was not found at ${csc}`);
mkdirSync(outDir, { recursive: true });
const exe = join(outDir, 'FlightPanelBot.exe');
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
writeFileSync(
  join(outDir, 'README.txt'),
  `Flight Panel Bot ${version}
By UncappingBadger. Unofficial: not affiliated with FsHub, Aeroconomy, AeroDAQ or Discord.

Runs your virtual airline's flight panel in your own Discord server, from your own Windows PC.

1. Double-click FlightPanelBot.exe. Windows may say it "protected your PC" because the program is not
   signed: press "More info", then "Run anyway".
2. A small icon appears near the clock (look under the ^ arrow if you don't see it). Drag it onto the taskbar
   to keep it visible. Your web browser opens the setup page.
3. Follow the page: create your own Discord bot, paste its token, then press "Add the bot to a server".
   Type /setup in your server and follow the server owner's manual. No FsHub account or token is needed.

Right-click the icon for settings, the log, restarting the bot, "Start with Windows", and Quit.
The bot only works while this program is running, so keep it on a computer that stays on.

Your settings, data and logs are in %APPDATA%\\FlightPanelBot. Deleting that folder resets everything.

Updates: once a day the program asks GitHub whether a newer version has been released. If there is one, the
icon pops up a notice (once), its menu shows "A new version is available", and the setup page links to the
release page. Nothing is downloaded for you: download the new FlightPanelBot.exe from that page, quit this
one from the icon, and run the new one. Your settings and data carry over. The check can be switched off on
the setup page, and only sends the program's name and version to github.com.

The bot also uses AeroDAQ (aerodaq.com, an in-game market, not real money) for /fuel and the optional market
board, but only when someone uses them.

The server owner's manual is in FlightPanelBot-Server-Owner-Manual.pdf (when it is in this folder).

Licences: see LICENSE.txt and THIRD_PARTY_NOTICES.txt.
Checksum: compare FlightPanelBot.exe.sha256 with the file's SHA-256 if you want to be sure it is unaltered.
`,
);
const sha = createHash('sha256').update(readFileSync(exe)).digest('hex');
writeFileSync(join(outDir, 'FlightPanelBot.exe.sha256'), `${sha}  FlightPanelBot.exe\n`);
rmSync(work, { recursive: true, force: true });

console.log(`\nBuilt ${exe}`);
console.log(`  size    ${mb(statSync(exe).size)}`);
console.log(`  version ${version} (build ${buildId}, Node.js ${nodeVersion})`);
console.log(`  sha256  ${sha}`);
