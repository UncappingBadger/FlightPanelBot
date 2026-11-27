/**
 * The setup page the tray icon opens: a single self-contained page (no outside resources). It holds
 * no secrets; it asks the local server for state, and the server never returns a token.
 */
export function renderPage(version: string): string {
  const safeVersion = version.replace(/[^\w.\-+]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flight Panel Bot</title>
<style>
  :root { --bg:#f6f7fb; --card:#fff; --ink:#1c2230; --muted:#5b6478; --line:#dfe3ee; --accent:#3b5bdb; --ok:#2b9348; --warn:#e8a200; --bad:#d64045; --code:#eef1f8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12151c; --card:#1b2030; --ink:#e9ecf5; --muted:#9aa3b8; --line:#2b3248; --accent:#7c93ff; --ok:#4cc26a; --warn:#f2b632; --bad:#ff6b70; --code:#232a3f; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui,"Segoe UI",sans-serif; }
  main { max-width: 1120px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h1 small { color:var(--muted); font-weight:400; font-size:13px; margin-left:8px; }
  h2 { font-size: 16px; margin: 0 0 10px; }
  p { margin: 0 0 10px; } .muted { color: var(--muted); }
  section, .status { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin:14px 0; }
  .status { display:flex; gap:12px; align-items:center; } .dot { width:14px; height:14px; border-radius:50%; background:var(--warn); flex:none; }
  .dot.online { background:var(--ok); } .dot.error { background:var(--bad); } .dot.update { background:var(--accent); } .status b { display:block; }
  .status.update { border-color:var(--accent); } label.check { display:flex; gap:8px; align-items:center; font-weight:400; margin:10px 0 0; }
  .top { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; } .top h1 { min-width:0; }
  button.danger { background:#c62828; color:#fff; flex:none; } button.danger:hover { background:#a81f1f; }
  dialog { width:min(560px, calc(100vw - 32px)); border:2px solid #c62828; border-radius:12px; padding:18px 20px; background:var(--card); color:var(--ink); }
  dialog::backdrop { background:rgba(0,0,0,.6); } dialog h2 { color:var(--bad); } .row.end { justify-content:flex-end; }
  ol { padding-left: 20px; margin: 0 0 12px; } li { margin: 4px 0; }
  label { display:block; font-weight:600; margin:12px 0 4px; }
  input[type=password], input[type=text] { width:100%; padding:9px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); font:inherit; }
  button, a.btn { display:inline-block; border:0; border-radius:8px; padding:9px 14px; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; text-decoration:none; }
  button.secondary { background:transparent; color:var(--accent); border:1px solid var(--line); }
  button:disabled { opacity:.55; cursor:default; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top:12px; }
  .msg { margin-top:10px; padding:8px 10px; border-radius:8px; background:var(--code); } .msg.bad { color:var(--bad); }
  code { background:var(--code); padding:1px 5px; border-radius:4px; }
  table { width:100%; border-collapse:collapse; margin-top:8px; } td { padding:6px 4px; border-top:1px solid var(--line); }
  pre { background:var(--code); border-radius:8px; padding:10px; max-height:260px; overflow:auto; font-size:12px; white-space:pre-wrap; word-break:break-word; margin:8px 0 0; }
  .hidden { display:none; }
  h3 { font-size:14px; margin:18px 0 4px; }
  select, input[type=number] { padding:7px 8px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); font:inherit; }
  select { width:100%; } input.num { width:96px; }
  .fields { display:flex; gap:14px; flex-wrap:wrap; margin-top:8px; } .fields .field { max-width:230px; } .field label { margin:0 0 3px; font-size:13px; }
  table.fleet th { text-align:left; font-weight:600; padding:6px 4px; color:var(--muted); font-size:13px; } table.fleet td { vertical-align:middle; }
  button.small { padding:4px 9px; font-size:13px; }
  .layout { display:grid; grid-template-columns: 220px minmax(0,1fr); gap:18px; align-items:start; }
  nav#nav { position:sticky; top:12px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:8px; margin:14px 0; max-height:calc(100vh - 24px); overflow:auto; }
  nav#nav h4 { margin:12px 8px 4px; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); } nav#nav h4:first-child { margin-top:4px; }
  nav#nav button { display:block; width:100%; text-align:left; background:transparent; color:var(--ink); font-weight:500; padding:6px 10px; border-radius:8px; }
  nav#nav button:hover { background:var(--code); } nav#nav button.on { background:var(--accent); color:#fff; }
  .scope { display:flex; gap:14px; flex-wrap:wrap; align-items:end; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px 18px 14px; margin:14px 0; }
  .scope .field { flex:1 1 220px; } .scope label { margin-top:4px; }
  .out { background:var(--code); border-radius:8px; padding:10px 12px; margin-top:10px; overflow-wrap:anywhere; } .out.bad { color:var(--bad); } .out div + div { margin-top:3px; }
  .field.wide { margin-top:12px; } .field.wide label { margin:0 0 3px; } .field.wide input[type=text], .field.wide select { width:100%; } .field .help { margin:3px 0 0; font-size:13px; color:var(--muted); }
  @media (max-width: 800px) { .layout { grid-template-columns: 1fr; } nav#nav { position:static; max-height:none; } }
</style>
</head>
<body>
<main>
  <div class="top">
    <h1>Flight Panel Bot <small>v${safeVersion}</small></h1>
    <button class="danger" id="reset-open" type="button">Reset everything</button>
  </div>
  <dialog id="reset-dialog" aria-labelledby="reset-title">
    <h2 id="reset-title">Reset everything? This cannot be undone.</h2>
    <p>Everything this app has saved on this computer is deleted:</p>
    <ul>
      <li>the Discord bot token, the FsHub token, the Google key and the Twitch sign-in;</li>
      <li>every airline, flight panel, reservation, pilot name and setting;</li>
      <li><b>the record of payments made to pilots.</b> The bot will no longer know what it has paid, so first tick <b>Pilot Paid</b> in your sheet for every flight that has been paid, or it can be paid again;</li>
      <li>pilots' <code>/banking</code> sign-ins, the backup copies of the database and the logs.</li>
    </ul>
    <p><b>Start with Windows</b> is switched off. Your Google Sheet is not changed. Messages the bot has posted in Discord stay there: delete them by hand.</p>
    <div class="msg hidden" id="reset-msg"></div>
    <div class="row end"><button class="secondary" id="reset-cancel" type="button" autofocus>Cancel</button><button class="danger" id="reset-go" type="button">Delete everything</button></div>
  </dialog>
  <p class="muted">Runs on this computer and keeps your airline's flight panel working in your Discord server. This page is only reachable from this computer.</p>

  <div class="msg hidden" id="reset-done"></div>
  <div class="status"><span class="dot" id="dot"></span><div><b id="phase">Checking…</b><span class="muted" id="message"></span></div></div>

  <div class="status update hidden" id="update-banner">
    <span class="dot update"></span>
    <div style="flex:1"><b id="update-title">A new version is available</b><span class="muted" id="update-text"></span></div>
    <a class="btn" id="update-link" target="_blank" rel="noopener">Open the download page</a>
  </div>

  <div class="layout">
  <nav id="nav" aria-label="Settings"></nav>
  <div id="panes">

  <div class="scope hidden" id="scope">
    <div class="field" id="scope-server"><label for="pick-server">Server</label><select id="pick-server"></select></div>
    <div class="field" id="scope-airline"><label for="pick-airline">Airline</label><select id="pick-airline"></select></div>
  </div>
  <p class="muted hidden" id="pane-note"></p>

  <section id="cmd" style="display:none">
    <h2 id="cmd-title"></h2>
    <p class="muted" id="cmd-intro"></p>
    <p id="cmd-scope" style="font-weight:600"></p>
    <div class="hidden" id="cmd-status-box"><h3 style="margin-top:6px">Current settings (read just now)</h3><div class="out" id="cmd-status"></div></div>
    <div id="cmd-form"></div>
    <div class="row"><button id="cmd-run">Apply</button></div>
    <div class="out hidden" id="cmd-out"></div>
    <div id="cmd-files"></div>
  </section>

  <section id="s-tokens" data-pane="bot">
    <h2>1. Create your own Discord bot</h2>
    <p>Each server runs its own bot, so you make one for yours. It's free and takes about two minutes.</p>
    <ol>
      <li>Open the <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">Discord Developer Portal</a>, sign in, and press <b>New Application</b>. Give it a name your members will see, such as your airline's name.</li>
      <li>Open the <b>Bot</b> tab on the left and press <b>Reset Token</b>, then <b>Copy</b>. Paste it below. (Discord shows it only once.)</li>
      <li>On the same tab, leave the three <b>Privileged Gateway Intents</b> switched <b>off</b>, and switch <b>Public Bot</b> off so nobody else can add your bot to their servers.</li>
    </ol>
    <label for="discord">Discord bot token</label>
    <input type="password" id="discord" autocomplete="off" spellcheck="false" placeholder="Paste the token here">
    <p class="muted" id="discord-set"></p>

    <div class="row"><button id="save">Save and start</button></div>
    <div class="msg hidden" id="save-msg"></div>
  </section>

  <section id="s-invite" data-pane="bot">
    <h2>2. Add the bot to your Discord server</h2>
    <p id="invite-text" class="muted">Save your Discord token above and the link appears here.</p>
    <div class="row"><a class="btn hidden" id="invite" target="_blank" rel="noopener">Add the bot to a server</a><button class="secondary hidden" id="copy">Copy the link</button></div>
    <p class="muted" style="margin-top:12px">You need the <b>Manage Server</b> permission on that server. Once it's added, create the airline's panel in the <b>Add or change a panel</b> tab of this page. The user manual walks through the rest: right-click the tray icon and choose <b>User manual</b>.</p>
    <table id="servers" class="hidden"></table>
  </section>

  <section id="s-google" data-pane="google">
    <h2>3. Optional: let the bot write to your Google Sheet</h2>
    <p class="muted">Only needed if you want reservations and completions to appear in your sheet. Choose the JSON key file of your Google service account (the user manual, from the tray icon's menu, shows how to create one).</p>
    <p id="google-state" class="muted"></p>
    <div class="row"><input type="file" id="google-file" accept=".json,application/json"><button class="secondary" id="google-remove">Remove key</button></div>
    <div class="msg hidden" id="google-msg"></div>
  </section>

  <section id="s-fshub" data-pane="fshub-token">
    <h2>4. Optional: connect the bot to FsHub</h2>
    <p class="muted">With a FsHub token the bot checks the pilot IDs people type and shows the name FsHub has for each, and the <b>FsHub roster</b> tab can read your airline's roster so pilots are matched to their Discord accounts without being asked. It only reads from FsHub and never changes anything there. Without a token the bot never contacts FsHub. Aeroconomy accepts the same token: only when the <b>Profit and pay</b> tab is used does the bot send it to Aeroconomy, and then only to read the airline's aircraft logbooks. It never writes anything to Aeroconomy.</p>
    <p class="muted">Create a personal access token at <a href="https://fshub.io/settings/integrations" target="_blank" rel="noopener">fshub.io/settings/integrations</a>. FsHub only shows an airline's roster to its members, so use an account that belongs to your airline. The token acts as that account, so keep it private; you can delete it on that page at any time.</p>
    <label for="fshub">FsHub access token</label>
    <input type="password" id="fshub" autocomplete="off" spellcheck="false" placeholder="Paste the token here">
    <p id="fshub-state" class="muted"></p>
    <div class="row"><button id="fshub-save">Check and save token</button><button class="secondary" id="fshub-remove">Remove token</button></div>
    <div class="msg hidden" id="fshub-msg"></div>
  </section>

  <section id="s-twitch" data-pane="twitch">
    <h2>5. Optional: answer a Twitch chat about your flight</h2>
    <p class="muted">For streamers. The bot joins one Twitch channel's chat and answers <code>!flight</code>, <code>!distance</code>, <code>!landing</code>, <code>!aircraft</code> and <code>!eta</code> with your current flight from FsHub, and replies to chat's compliments, jokes and insults in a family-friendly way. It only speaks when spoken to, and nothing happens until you connect a Twitch account below. You can disconnect it here at any time, or under Connections in your Twitch settings.</p>
    <p class="muted">Connect a separate Twitch account made for the bot, and make it a moderator of your channel: the bot will not join your chat as the channel's own account, and its replies come from it and not from you. It uses your FsHub token above to know whose flights to talk about.</p>
    <p id="twitch-state" class="muted">Checking…</p>
    <div class="row"><button id="twitch-connect">Connect to Twitch</button><button class="secondary hidden" id="twitch-disconnect">Disconnect</button></div>
    <div class="msg hidden" id="twitch-code"></div>
    <label for="twitch-channel">Channel to join (the streamer's Twitch name)</label>
    <input type="text" id="twitch-channel" autocomplete="off" spellcheck="false" placeholder="for example yourchannel">
    <label for="twitch-pilot">Optional: the streamer's FsHub pilot number</label>
    <input type="text" id="twitch-pilot" autocomplete="off" spellcheck="false" placeholder="Leave empty to use the owner of the FsHub token">
    <label class="check"><input type="checkbox" id="twitch-commands" checked> Answer <code>!flight</code>, <code>!distance</code>, <code>!landing</code>, <code>!aircraft</code> and <code>!eta</code></label>
    <label class="check"><input type="checkbox" id="twitch-banter" checked> Reply to chat's compliments, jokes and insults</label>
    <div class="row"><button id="twitch-save">Save</button></div>
    <details style="margin-top:10px"><summary class="muted">Advanced: my own Twitch application ID</summary>
      <p class="muted">Only needed if this copy of the app has no Twitch application ID built in. Register a free application at <a href="https://dev.twitch.tv/console" target="_blank" rel="noopener">dev.twitch.tv/console</a> (Client Type: Public), then paste its Client ID here.</p>
      <input type="text" id="twitch-client" autocomplete="off" spellcheck="false" placeholder="Client ID">
    </details>
    <div class="msg hidden" id="twitch-msg"></div>
  </section>

  <section id="s-airline" style="display:none">
    <h2>Landing safety</h2>
    <p class="muted">Link a pilot's pay to how well they land. A landing is judged by its landing rate in feet per minute, as FsHub recorded it. From the <b>warning</b> limit the pilot is sent a warning and nothing is cut. From the <b>Tier 1</b> limit the pilot is paid only the Tier 1 share of the flight's profit, and from the <b>Tier 2</b> limit the Tier 2 share. Every type of aircraft can have limits of its own; a type without them uses the airline's default. A change applies to flights that land from now on, and a pay already written in the sheet is never changed.</p>
    <p id="airline-state" class="muted">Choose an airline at the top of the page.</p>
    <div id="airline-body" class="hidden">
      <p id="sf-scope" style="font-weight:600"></p>
      <label class="check"><input type="checkbox" id="sf-on"> Link the pilots' pay to landing safety</label>
      <p class="muted" id="sf-since" style="margin:6px 0 0"></p>
      <div class="msg hidden" id="sf-block"></div>

      <h3>Default limits (feet per minute)</h3>
      <p class="muted" style="margin:0">Used by every aircraft type that has no limits of its own below. A landing at least this hard is in the band.</p>
      <div class="fields">
        <div class="field"><label for="sf-warn">Warning from (feet per minute)</label><input class="num" type="number" min="1" max="2500" step="1" id="sf-warn"></div>
        <div class="field"><label for="sf-t1">Tier 1 from (feet per minute)</label><input class="num" type="number" min="1" max="2500" step="1" id="sf-t1"></div>
        <div class="field"><label for="sf-t2">Tier 2 from (feet per minute)</label><input class="num" type="number" min="1" max="2500" step="1" id="sf-t2"></div>
      </div>

      <h3>What a hard landing does to the pay</h3>
      <p class="muted" style="margin:0">The share is the per cent of the flight's profit a pilot is paid instead of the usual 15%. A flight that made little, or lost money, normally pays at least $2,000: the loss lowers that minimum by this per cent (0 keeps all of it, 100 means there is no minimum). Check them before you turn safety pay on.</p>
      <div class="fields">
        <div class="field"><label for="sf-s1">After a Tier 1 landing the pilot is paid this % of the flight's profit</label><input class="num" type="number" min="0" max="100" step="1" id="sf-s1"></div>
        <div class="field"><label for="sf-s2">After a Tier 2 landing the pilot is paid this % of the flight's profit</label><input class="num" type="number" min="0" max="100" step="1" id="sf-s2"></div>
        <div class="field"><label for="sf-l1">After a Tier 1 landing the pilot loses this % of the $2,000 minimum pay</label><input class="num" type="number" min="0" max="100" step="1" id="sf-l1"></div>
        <div class="field"><label for="sf-l2">After a Tier 2 landing the pilot loses this % of the $2,000 minimum pay</label><input class="num" type="number" min="0" max="100" step="1" id="sf-l2"></div>
      </div>
      <label class="check"><input type="checkbox" id="sf-ded"> Write what a hard landing takes off the pay in the sheet's Safety Deductions column</label>
      <div class="row"><button id="sf-save">Save the safety pay settings above</button></div>
      <div class="msg hidden" id="sf-msg"></div>

      <h3>Aircraft</h3>
      <p class="muted" style="margin:0">The aircraft the airline owns and leases (read from Aeroconomy) and the types its recent flights were flown in. Change the three limits of a type and press Save aircraft limits; <b>Use the default</b> puts a type back on the airline's default.</p>
      <p class="muted" id="fleet-state">Loading…</p>
      <table class="fleet hidden" id="fleet-table"><thead><tr><th>Type</th><th>In the fleet</th><th>Warning</th><th>Tier 1</th><th>Tier 2</th><th></th></tr></thead><tbody id="fleet-body"></tbody></table>
      <div class="row"><button id="fleet-save">Save aircraft limits</button><button class="secondary" id="fleet-refresh">Read the fleet from Aeroconomy again</button></div>
      <div class="msg hidden" id="fleet-msg"></div>
      <div class="fields">
        <div class="field"><label for="fleet-add">Add an aircraft type by its code</label><input type="text" id="fleet-add" maxlength="8" autocomplete="off" spellcheck="false" placeholder="for example A320" style="width:160px"> <button class="secondary small" id="fleet-add-btn">Add</button></div>
      </div>
      <details style="margin-top:10px"><summary class="muted">The airline's aircraft are not found</summary>
        <p class="muted">Aeroconomy lists an airline's aircraft by its business number. Most airlines are found without it. If yours is not, type its business number (the number in the address of the airline's page on Aeroconomy) and read the fleet again.</p>
        <input type="text" id="fleet-business" autocomplete="off" spellcheck="false" placeholder="Business number" style="width:200px">
      </details>
    </div>
  </section>

  <section data-pane="updates">
    <h2>Updates</h2>
    <p id="update-state" class="muted">Checking…</p>
    <div class="row" style="margin-top:0"><button class="secondary" id="update-check">Check for updates</button></div>
    <label class="check"><input type="checkbox" id="update-auto"> Check GitHub once a day for a new version</label>
    <p class="muted" style="margin-top:8px">The check asks github.com for the latest release of this app, nothing else. Nothing is downloaded or installed: when a newer version exists you are told, and you download it yourself.</p>
    <div class="msg hidden" id="update-msg"></div>
  </section>

  <section data-pane="activity">
    <h2>Activity</h2>
    <div class="row" style="margin-top:0"><button class="secondary" id="restart">Restart the bot</button><button class="secondary" id="logs-refresh">Refresh log</button></div>
    <pre id="logs">Loading…</pre>
  </section>

  <p class="muted" data-pane="activity">To stop the bot, right-click the tray icon (near the clock) and choose Quit. Your settings and data stay on this computer, in <code>%APPDATA%\\FlightPanelBot</code>.</p>
  </div>
  </div>
</main>
<script>
(function () {
  var key = new URLSearchParams(location.search).get('k') || '';
  var $ = function (id) { return document.getElementById(id); };
  function api(path, body) {
    var opts = { headers: { 'X-FPB-Key': key } };
    if (body !== undefined) { opts.method = 'POST'; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong.'); return j; }); });
  }
  function show(el, text, bad) { el.textContent = text; el.className = 'msg' + (bad ? ' bad' : ''); }
  var PHASES = { 'needs-setup': 'Needs setup', starting: 'Starting…', online: 'Online', retrying: 'Can\\u2019t reach Discord', error: 'Needs attention', stopped: 'Stopped' };
  var CMD = { registered: 'ready', unchanged: 'ready', pending: 'setting up\\u2026', failed: 'couldn\\u2019t set up commands, will retry on restart', 'no-access': 'added without command access: remove the bot and add it again with the link above' };

  function render(s) {
    setupSync(s.phase);
    $('phase').textContent = PHASES[s.phase] || s.phase;
    $('message').textContent = ' ' + (s.message ? '\\u2014 ' + s.message : '');
    $('dot').className = 'dot ' + (s.phase === 'online' ? 'online' : s.phase === 'error' ? 'error' : '');
    $('discord-set').textContent = s.configured.discordToken ? 'A token is saved. Paste a new one only to replace it.' + (s.botName ? ' Bot: ' + s.botName : '') : '';
    if (s.inviteUrl) {
      $('invite').href = s.inviteUrl; $('invite').className = 'btn'; $('copy').className = 'secondary';
      $('invite-text').textContent = 'Press the button, choose your server, and authorise.';
    }
    var t = $('servers');
    if (s.servers.length) {
      t.className = ''; t.textContent = '';
      s.servers.forEach(function (v) {
        var tr = document.createElement('tr'), a = document.createElement('td'), b = document.createElement('td');
        a.textContent = v.name; b.textContent = CMD[v.commands] || v.commands; tr.appendChild(a); tr.appendChild(b); t.appendChild(tr);
      });
    } else { t.className = 'hidden'; }
    renderUpdate(s.update);
    var g = s.configured.google;
    $('google-state').textContent = g.present ? (g.email ? 'Key saved. Share your sheet with ' + g.email + ' as an Editor.' : (g.problem || 'A key is saved but unusable.')) : 'No key saved: the bot only reads your sheet.';
    $('google-remove').style.display = g.present ? '' : 'none';
    $('fshub-state').textContent = s.configured.fshub ? 'A token is saved. Paste a new one only to replace it.' : 'No token saved: the bot never contacts FsHub.';
    $('fshub-remove').style.display = s.configured.fshub ? '' : 'none';
  }
  function ago(ms) {
    var m = Math.round((Date.now() - ms) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago';
  }
  function renderUpdate(u) {
    if (!u) return;
    var banner = $('update-banner');
    // Only ever link to GitHub, whatever the status says.
    var linkOk = u.available && typeof u.url === 'string' && u.url.indexOf('https://github.com/') === 0;
    if (linkOk) {
      banner.className = 'status update';
      $('update-title').textContent = 'A new version is available: ' + u.latest;
      $('update-text').textContent = 'You are running v' + u.current + '. Download the new one, quit this app from the tray icon, and run the new file; your settings and data carry over.';
      $('update-link').href = u.url;
    } else banner.className = 'status update hidden';
    var line;
    if (!u.supported) line = 'This is a development build, so it does not look for updates.';
    else if (u.available) line = 'A newer version (' + u.latest + ') is available. You are running v' + u.current + '.';
    else if (u.ok === false) line = 'You are running v' + u.current + '. The last check could not reach GitHub' + (u.checkedAt ? ' (' + ago(u.checkedAt) + ')' : '') + '.';
    else if (u.checkedAt) line = 'You are running v' + u.current + ', the latest version' + (u.latest ? '' : ' (no release is published yet)') + '. Checked ' + ago(u.checkedAt) + '.';
    else line = 'You are running v' + u.current + '. Not checked yet.';
    $('update-state').textContent = line;
    $('update-check').style.display = u.supported ? '' : 'none';
    $('update-auto').checked = !!u.auto;
    $('update-auto').disabled = !u.supported;
  }
  var twitchWait = null;
  function renderTwitch(t) {
    var parts = [];
    parts.push(t.connectedAs ? 'Connected as ' + t.connectedAs + '.' : 'No Twitch account is connected.');
    var st = t.status;
    // Connecting an account is not enough: the bot joins nothing until a channel is chosen and saved.
    if (t.connectedAs && !t.channel) parts.push('Next: type the channel to join below (for your own channel, that is ' + t.connectedAs + ') and press Save.');
    else if (st && t.connectedAs) parts.push('Bot: ' + st.detail);
    $('twitch-state').textContent = parts.join(' ');
    $('twitch-disconnect').className = t.connectedAs ? 'secondary' : 'secondary hidden';
    $('twitch-connect').textContent = t.connectedAs ? 'Connect a different account' : 'Connect to Twitch';
    $('twitch-connect').disabled = !t.available && !$('twitch-client').value;
    if (document.activeElement !== $('twitch-channel')) $('twitch-channel').value = t.channel || '';
    if (document.activeElement !== $('twitch-pilot')) $('twitch-pilot').value = t.pilotId || '';
    if (document.activeElement !== $('twitch-commands')) $('twitch-commands').checked = !!t.commands;
    if (document.activeElement !== $('twitch-banter')) $('twitch-banter').checked = !!t.banter;
    if (!t.available) show($('twitch-msg'), 'This copy of the app has no Twitch application ID yet. Open Advanced below and paste one.', true);
  }
  function twitchPoll() { api('/api/twitch').then(renderTwitch).catch(function () {}); }
  function twitchBody() {
    var b = { channel: $('twitch-channel').value, commands: $('twitch-commands').checked, banter: $('twitch-banter').checked, pilotId: $('twitch-pilot').value.trim() === '' ? null : $('twitch-pilot').value.trim() };
    // The saved application ID is never shown, so an empty box means "leave it", not "remove it".
    if ($('twitch-client').value.trim() !== '') b.clientId = $('twitch-client').value;
    return b;
  }
  function twitchWatch(intervalSec) {
    clearTimeout(twitchWait);
    twitchWait = setTimeout(function () {
      api('/api/twitch/poll', {}).then(function (r) {
        if (r.status === 'connected') { $('twitch-code').className = 'msg hidden'; show($('twitch-msg'), 'Connected as ' + r.login + '. The bot is restarting to join the chat.', false); twitchPoll(); }
        else twitchWatch(intervalSec);
      }).catch(function (e) { $('twitch-code').className = 'msg hidden'; show($('twitch-msg'), e.message, true); });
    }, Math.max(intervalSec, 3) * 1000);
  }
  /* ---- Tabs. The host's own settings come first; every /setup command is a tab of its own, made from the command's definition. ---- */
  var HOST_TABS = [['bot', 'Discord bot'], ['google', 'Google Sheets key'], ['fshub-token', 'FsHub token'], ['twitch', 'Twitch chat'], ['updates', 'Updates'], ['activity', 'Activity']];
  var tabs = [], tabById = {}, current = '', online = false, setupLoaded = false, servers = [], choices = { channels: [], roles: [] };
  var scope = { guild: '', panel: '' };
  var airlineId = '', fleetDefaults = { warn: 400, tier1: 500, tier2: 600 };
  var NL = String.fromCharCode(10), TICK = String.fromCharCode(96);
  function inputNumber(el) { var t = el.value.trim(); return t === '' ? null : Number(t); }
  function nv(id) { return inputNumber($(id)); }
  function add(parent, tag, text, cls) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; parent.appendChild(e); return e; }
  /* What a command said: **bold** and code marks become elements (never markup), one line each. */
  function fmt(el, text) {
    el.textContent = '';
    String(text).split(NL).forEach(function (line) {
      var div = add(el, 'div'), pos = 0;
      if (line === '') div.style.height = '6px';
      while (pos < line.length) {
        var b1 = line.indexOf('**', pos), c1 = line.indexOf(TICK, pos);
        var useBold = b1 >= 0 && (c1 < 0 || b1 < c1), at = useBold ? b1 : c1;
        var mark = useBold ? '**' : TICK, end = at >= 0 ? line.indexOf(mark, at + mark.length) : -1;
        if (at < 0 || end < 0) { div.appendChild(document.createTextNode(line.slice(pos))); break; }
        if (at > pos) div.appendChild(document.createTextNode(line.slice(pos, at)));
        add(div, useBold ? 'b' : 'code', line.slice(at + mark.length, end));
        pos = end + mark.length;
      }
    });
  }
  function buildNav() {
    var nav = $('nav'); nav.textContent = '';
    function item(id, label) { var b = add(nav, 'button', label); b.setAttribute('data-tab', id); b.onclick = function () { selectTab(id); }; }
    add(nav, 'h4', 'This computer');
    HOST_TABS.forEach(function (t) { item(t[0], t[1]); });
    var group = '';
    tabs.forEach(function (t) { if (t.group !== group) { group = t.group; add(nav, 'h4', group); } item(t.id, t.label); });
  }
  /* Why a tab cannot be used yet, or empty when it can. */
  function needScope(def) {
    if (!online) return 'Start the bot first (it needs the Discord token, on the Discord bot tab). The servers it is in appear here once it is online.';
    if (!servers.length) return 'The bot is not in a Discord server yet. Add it with the link on the Discord bot tab.';
    if (def.scope === 'airline' && !scope.panel) return 'This server has no airline yet. Create one in the Add or change a panel tab.';
    return '';
  }
  /* Which server and airline a tab acts on, in words, so nobody has to guess from the drop-downs. */
  function scopeText(def) {
    var s = servers.filter(function (x) { return x.id === scope.guild; })[0];
    if (!s) return '';
    if (def.scope === 'server') return 'This applies to the whole server ' + s.name + '.';
    var a = s.airlines.filter(function (x) { return String(x.id) === scope.panel; })[0];
    return a ? 'This applies to the airline ' + a.name + ' in the server ' + s.name + '.' : '';
  }
  function selectTab(id) {
    current = id;
    try { localStorage.setItem('fpb-tab', id); } catch (e) {}
    [].forEach.call(document.querySelectorAll('#nav button'), function (b) { b.className = b.getAttribute('data-tab') === id ? 'on' : ''; });
    var def = tabById[id];
    [].forEach.call(document.querySelectorAll('[data-pane]'), function (p) {
      p.style.display = !def && p.getAttribute('data-pane') === id ? '' : 'none';
    });
    $('scope').style.display = def ? '' : 'none';
    $('scope-airline').style.display = def && def.scope === 'airline' ? '' : 'none';
    $('cmd').style.display = def && !def.custom ? '' : 'none';
    $('s-airline').style.display = def && def.custom === 'safety' ? '' : 'none';
    if (!def) return;
    if (def.custom === 'safety') {
      var why = needScope(def);
      $('airline-state').textContent = why || '';
      $('airline-body').className = why ? 'hidden' : '';
      $('sf-scope').textContent = why ? '' : scopeText(def);
      if (!why) loadAirline();
    } else renderTab(def);
  }
  function option(sel, value, label) { var o = add(sel, 'option', label); o.value = value; return o; }
  function fieldEl(f) {
    var wrap = document.createElement('div'); wrap.className = 'field wide';
    var label = add(wrap, 'label', f.label + (f.required ? ' (needed)' : '')), el;
    if (f.kind === 'select' || f.kind === 'channel' || f.kind === 'role') {
      el = add(wrap, 'select');
      option(el, '', f.required ? 'Choose\u2026' : (f.blank || 'no change'));
      var list = f.kind === 'select' ? f.choices : f.kind === 'channel' ? choices.channels : choices.roles;
      (list || []).forEach(function (c) { option(el, c.value !== undefined ? c.value : c.id, c.label !== undefined ? c.label : (f.kind === 'channel' ? '#' : '') + c.name); });
    } else if (f.kind === 'file') {
      el = add(wrap, 'input'); el.type = 'file'; el.accept = '.csv,.json,.txt,text/csv,application/json';
    } else if (f.kind === 'number') {
      el = add(wrap, 'input', undefined, 'num'); el.type = 'number'; el.step = '1'; el.style.width = '100%'; el.style.maxWidth = '420px';
      if (f.min !== undefined) el.min = String(f.min);
      if (f.max !== undefined) el.max = String(f.max);
    } else {
      el = add(wrap, 'input'); el.type = 'text'; el.autocomplete = 'off'; el.spellcheck = false;
      if (f.maxLength !== undefined) el.maxLength = f.maxLength;
    }
    if (!f.required && f.blank && f.kind !== 'select' && f.kind !== 'channel' && f.kind !== 'role') el.placeholder = f.blank;
    el.id = 'f-' + f.name; label.htmlFor = el.id;
    el.setAttribute('data-name', f.name);
    add(wrap, 'p', f.help, 'help');
    return wrap;
  }
  function renderTab(def) {
    $('cmd-title').textContent = def.label;
    $('cmd-intro').textContent = def.intro;
    $('cmd-scope').textContent = '';
    $('cmd-run').textContent = def.submit;
    $('cmd-out').className = 'out hidden'; $('cmd-files').textContent = '';
    $('cmd-status-box').style.display = 'none';
    var form = $('cmd-form'); form.textContent = '';
    var why = needScope(def);
    $('cmd-run').style.display = why ? 'none' : '';
    if (why) { show($('cmd-out'), why, false); return; }
    $('cmd-scope').textContent = scopeText(def);
    def.fields.forEach(function (f) { form.appendChild(fieldEl(f)); });
    if (def.status !== 'none') runCommand(def, true).catch(function () {});
  }
  function readFile(file) {
    return new Promise(function (resolve, reject) { var r = new FileReader(); r.onload = function () { resolve(String(r.result)); }; r.onerror = function () { reject(new Error('I could not read that file.')); }; r.readAsText(file); });
  }
  function collect() {
    var vals = {}, pending = [];
    [].forEach.call($('cmd-form').querySelectorAll('[data-name]'), function (el) {
      var name = el.getAttribute('data-name');
      if (el.type === 'file') {
        var file = el.files[0];
        if (file) pending.push(readFile(file).then(function (text) { vals[name] = { name: file.name, text: text }; }));
      } else if (el.value.trim() !== '') vals[name] = el.value.trim();
    });
    return Promise.all(pending).then(function () { return vals; });
  }
  function showFiles(files) {
    var box = $('cmd-files'); box.textContent = '';
    files.forEach(function (f) {
      var a = add(box, 'a', 'Download ' + f.name, 'btn'); a.style.marginTop = '10px';
      a.href = URL.createObjectURL(new Blob([f.text], { type: 'text/plain' })); a.download = f.name;
    });
  }
  function runCommand(def, status) {
    return (status ? Promise.resolve({}) : collect()).then(function (values) {
      return api('/api/setup/run', { tab: def.id, guild: scope.guild, panel: scope.panel ? Number(scope.panel) : null, status: !!status, values: values });
    }).then(function (r) {
      if (current !== def.id) return;
      if (status) { $('cmd-status-box').style.display = ''; fmt($('cmd-status'), r.text); $('cmd-status').className = 'out' + (r.ok ? '' : ' bad'); return; }
      fmt($('cmd-out'), (r.ok ? "**The bot's answer:**" : '**The bot refused this, or could not finish it:**') + NL + r.text); $('cmd-out').className = 'out' + (r.ok ? '' : ' bad');
      showFiles(r.files || []);
      // An airline was added or removed, say: the lists at the top, and how this tab stands, change.
      if (r.ok) loadServers().then(function () { if (current === def.id && def.status !== 'none') return runCommand(def, true); }).catch(function () {});
    });
  }
  $('cmd-run').onclick = function () {
    var def = tabById[current]; if (!def) return;
    if (def.confirm && !window.confirm(def.confirm)) return;
    $('cmd-run').disabled = true; show($('cmd-out'), 'Working\u2026 nothing is final until the answer appears here.', false);
    runCommand(def, false).catch(function (e) { show($('cmd-out'), e.message, true); }).then(function () { $('cmd-run').disabled = false; });
  };
  /* The server and the airline the tabs act on. */
  function fillAirlines() {
    var s = servers.filter(function (x) { return x.id === scope.guild; })[0], list = s ? s.airlines : [], pa = $('pick-airline');
    pa.textContent = '';
    list.forEach(function (a) { option(pa, String(a.id), a.name + (a.abbr ? ' (' + a.abbr + ')' : '')); });
    if (!list.some(function (a) { return String(a.id) === scope.panel; })) scope.panel = list.length ? String(list[0].id) : '';
    pa.value = scope.panel;
  }
  function loadServers() {
    return api('/api/setup/servers').then(function (r) {
      servers = r.servers;
      var ps = $('pick-server'); ps.textContent = '';
      servers.forEach(function (s) { option(ps, s.id, s.name); });
      if (!servers.some(function (s) { return s.id === scope.guild; })) scope.guild = servers.length ? servers[0].id : '';
      ps.value = scope.guild;
      fillAirlines();
    });
  }
  function loadChoices() {
    if (!scope.guild) { choices = { channels: [], roles: [] }; return Promise.resolve(); }
    var guild = scope.guild;
    return api('/api/setup/choices?guild=' + encodeURIComponent(guild)).then(function (c) { if (guild === scope.guild) choices = c; }).catch(function () { choices = { channels: [], roles: [] }; });
  }
  $('pick-server').onchange = function () { scope.guild = $('pick-server').value; scope.panel = ''; fillAirlines(); loadChoices().then(function () { selectTab(current); }); };
  $('pick-airline').onchange = function () { scope.panel = $('pick-airline').value; selectTab(current); };
  /* The bot being online decides whether there is anything to set up. */
  function setupSync(phase) {
    online = phase === 'online';
    if (online) {
      if (setupLoaded) return;
      setupLoaded = true;
      loadServers().then(loadChoices).then(function () { selectTab(current); }).catch(function () { setupLoaded = false; });
      return;
    }
    if (setupLoaded) { setupLoaded = false; servers = []; scope.guild = ''; scope.panel = ''; $('pick-server').textContent = ''; $('pick-airline').textContent = ''; selectTab(current); }
  }
  /* ---- Landing safety (the Landing safety tab): pay and limits, airline by airline. ---- */
  function loadAirline() {
    airlineId = scope.panel;
    $('sf-msg').className = 'msg hidden'; $('fleet-msg').className = 'msg hidden';
    api('/api/airline/safety?panel=' + encodeURIComponent(airlineId)).then(renderSafety).catch(function (e) { show($('sf-msg'), e.message, true); });
    loadFleet(false);
  }
  function renderSafety(v) {
    if (String(v.id) !== airlineId) return;
    $('sf-on').checked = !!v.on;
    $('sf-on').disabled = !v.on && !!v.cannotTurnOn;
    $('sf-since').textContent = v.on
      ? 'On since ' + new Date(v.since).toLocaleString() + '. A flight that landed before then is paid as it always was.'
      : 'Off: pilots are paid as they always were, and a hard landing only gets the light-hearted remark.';
    $('sf-block').className = v.cannotTurnOn && !v.on ? 'msg' : 'msg hidden';
    $('sf-block').textContent = v.cannotTurnOn || '';
    $('sf-warn').value = v.defaults.warn; $('sf-t1').value = v.defaults.tier1; $('sf-t2').value = v.defaults.tier2;
    $('sf-s1').value = v.shareTier1; $('sf-s2').value = v.shareTier2;
    $('sf-l1').value = v.lossTier1; $('sf-l2').value = v.lossTier2;
    $('sf-ded').checked = !!v.deductions;
    fleetDefaults = v.defaults;
  }
  function fleetCount(r) {
    var n = r.owned + r.leased;
    if (n === 0) return r.flown ? 'flown lately' : 'has limits of its own';
    var p = []; if (r.owned) p.push(r.owned + ' owned'); if (r.leased) p.push(r.leased + ' leased');
    return p.join(', ') + (r.flown ? ', flown lately' : '');
  }
  function fleetRow(r, fresh) {
    var tr = document.createElement('tr'); tr.setAttribute('data-code', r.code);
    var c1 = document.createElement('td'), b = document.createElement('b'); b.textContent = r.code; c1.appendChild(b); tr.appendChild(c1);
    var c2 = document.createElement('td'); c2.className = 'muted'; c2.textContent = fleetCount(r); tr.appendChild(c2);
    var st = document.createElement('span'); st.className = 'muted';
    st.textContent = fresh ? 'new, not saved yet' : r.own ? 'its own limits' : 'the airline default';
    ['warn', 'tier1', 'tier2'].forEach(function (k) {
      var td = document.createElement('td'), i = document.createElement('input');
      i.type = 'number'; i.min = '1'; i.max = '2500'; i.step = '1'; i.className = 'num'; i.value = String(r.limits[k]);
      i.oninput = function () { tr.setAttribute('data-dirty', '1'); st.textContent = 'changed, not saved yet'; };
      td.appendChild(i); tr.appendChild(td);
    });
    var last = document.createElement('td'); last.appendChild(st);
    if (r.own && !fresh) {
      var rb = document.createElement('button'); rb.className = 'secondary small'; rb.textContent = 'Use the default'; rb.style.marginLeft = '8px';
      rb.onclick = function () {
        api('/api/airline/limits', { panel: Number(airlineId), changes: [{ aircraft: r.code, limits: null }] })
          .then(function () { show($('fleet-msg'), 'The ' + r.code + ' uses the airline default again.', false); loadFleet(false); })
          .catch(function (e) { show($('fleet-msg'), e.message, true); });
      };
      last.appendChild(rb);
    }
    tr.appendChild(last);
    if (fresh) tr.setAttribute('data-dirty', '1');
    return tr;
  }
  function renderFleet(f) {
    if (String(f.id) !== airlineId) return;
    fleetDefaults = f.defaults;
    var body = $('fleet-body'); body.textContent = '';
    f.rows.forEach(function (r) { body.appendChild(fleetRow(r, false)); });
    $('fleet-table').className = f.rows.length ? 'fleet' : 'fleet hidden';
    var notes = [f.rows.length ? f.rows.length + ' aircraft type' + (f.rows.length === 1 ? '' : 's') + ' found.' : 'No aircraft types found yet. They appear once the airline has aircraft on Aeroconomy or flights on FsHub; you can also add one by its code below.'];
    if (f.problem) notes.push('Note: ' + f.problem);
    if (f.untyped > 0) notes.push(f.untyped + ' aircraft are listed without a type, so they are not here.');
    $('fleet-state').textContent = notes.join(' ');
  }
  function loadFleet(refresh) {
    var q = '/api/airline/fleet?panel=' + encodeURIComponent(airlineId) + (refresh ? '&refresh=1' : '');
    var biz = $('fleet-business').value.trim(); if (biz) q += '&business=' + encodeURIComponent(biz);
    $('fleet-state').textContent = refresh ? 'Asking Aeroconomy for the airline aircraft\\u2026' : 'Loading\\u2026';
    return api(q).then(renderFleet).catch(function (e) { $('fleet-state').textContent = e.message; });
  }
  $('fleet-refresh').onclick = function () { $('fleet-refresh').disabled = true; loadFleet(true).then(function () { $('fleet-refresh').disabled = false; }); };
  $('sf-save').onclick = function () {
    var body = {
      panel: Number(airlineId), on: $('sf-on').checked, deductions: $('sf-ded').checked,
      shareTier1: nv('sf-s1'), shareTier2: nv('sf-s2'), lossTier1: nv('sf-l1'), lossTier2: nv('sf-l2'),
      defaults: { warn: nv('sf-warn'), tier1: nv('sf-t1'), tier2: nv('sf-t2') }
    };
    $('sf-save').disabled = true;
    api('/api/airline/safety', body).then(function (v) {
      renderSafety(v); show($('sf-msg'), 'Saved. It applies to flights that land from now on.', false); loadFleet(false);
    }).catch(function (e) { show($('sf-msg'), e.message, true); }).then(function () { $('sf-save').disabled = false; });
  };
  $('fleet-save').onclick = function () {
    var rows = $('fleet-body').querySelectorAll('tr[data-dirty]'), changes = [];
    for (var n = 0; n < rows.length; n++) {
      var ins = rows[n].querySelectorAll('input');
      changes.push({ aircraft: rows[n].getAttribute('data-code'), limits: { warn: inputNumber(ins[0]), tier1: inputNumber(ins[1]), tier2: inputNumber(ins[2]) } });
    }
    if (!changes.length) { show($('fleet-msg'), 'Nothing was changed.', false); return; }
    $('fleet-save').disabled = true;
    api('/api/airline/limits', { panel: Number(airlineId), changes: changes }).then(function (r) {
      show($('fleet-msg'), 'Saved the limits of ' + r.set + ' aircraft type' + (r.set === 1 ? '' : 's') + '. They apply to flights that land from now on.', false); return loadFleet(false);
    }).catch(function (e) { show($('fleet-msg'), e.message, true); }).then(function () { $('fleet-save').disabled = false; });
  };
  $('fleet-add-btn').onclick = function () {
    var code = $('fleet-add').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(code)) { show($('fleet-msg'), 'Use the aircraft ICAO code, like A320, B738 or C172.', true); return; }
    var existing = $('fleet-body').querySelectorAll('tr[data-code]');
    for (var n = 0; n < existing.length; n++) if (existing[n].getAttribute('data-code') === code) { show($('fleet-msg'), 'The ' + code + ' is already in the list.', true); return; }
    $('fleet-body').appendChild(fleetRow({ code: code, owned: 0, leased: 0, flown: false, own: false, limits: fleetDefaults }, true));
    $('fleet-table').className = 'fleet'; $('fleet-add').value = '';
    show($('fleet-msg'), 'The ' + code + ' is added to the list: set its limits and press Save aircraft limits.', false);
  };
  function poll() { api('/api/state').then(render).catch(function () { $('phase').textContent = 'Lost contact with the bot'; }); }
  function logs() { api('/api/logs?n=150').then(function (j) { var p = $('logs'); var atEnd = p.scrollTop + p.clientHeight >= p.scrollHeight - 20; p.textContent = j.lines.join('\\n') || 'Nothing yet.'; if (atEnd) p.scrollTop = p.scrollHeight; }); }

  $('save').onclick = function () {
    var body = { discordToken: $('discord').value };
    $('save').disabled = true; show($('save-msg'), 'Checking…', false);
    api('/api/settings', body).then(function (r) {
      $('discord').value = '';
      show($('save-msg'), 'Saved. ' + (r.notes || []).join(' '), false); poll();
    }).catch(function (e) { show($('save-msg'), e.message, true); }).then(function () { $('save').disabled = false; });
  };
  $('copy').onclick = function () { navigator.clipboard.writeText($('invite').href).then(function () { $('copy').textContent = 'Copied'; setTimeout(function () { $('copy').textContent = 'Copy the link'; }, 1500); }); };
  $('update-check').onclick = function () {
    $('update-check').disabled = true; show($('update-msg'), 'Checking GitHub…', false);
    api('/api/update/check', {}).then(function (u) {
      renderUpdate(u);
      show($('update-msg'), u.ok === false ? 'I could not reach GitHub. Try again later.' : u.available ? 'A newer version is available.' : 'You are up to date.', u.ok === false);
    }).catch(function (e) { show($('update-msg'), e.message, true); }).then(function () { $('update-check').disabled = false; });
  };
  $('update-auto').onchange = function () {
    api('/api/update/auto', { enabled: $('update-auto').checked }).then(renderUpdate).catch(function (e) { show($('update-msg'), e.message, true); });
  };
  $('fshub-save').onclick = function () {
    $('fshub-save').disabled = true; show($('fshub-msg'), 'Checking with FsHub\\u2026', false);
    api('/api/fshub', { token: $('fshub').value }).then(function (r) {
      $('fshub').value = '';
      show($('fshub-msg'), 'Saved.' + (r.name ? ' Connected as ' + r.name + '.' : '') + ' ' + (r.notes || []).join(' ') + ' The bot is restarting to use it.', false); poll();
    }).catch(function (e) { show($('fshub-msg'), e.message, true); }).then(function () { $('fshub-save').disabled = false; });
  };
  $('fshub-remove').onclick = function () { api('/api/fshub/remove', {}).then(function () { show($('fshub-msg'), 'Token removed.', false); poll(); }); };
  $('twitch-connect').onclick = function () {
    $('twitch-connect').disabled = true; show($('twitch-msg'), 'Asking Twitch for a code\u2026', false);
    var save = $('twitch-client').value.trim() ? api('/api/twitch/settings', { clientId: $('twitch-client').value }) : Promise.resolve();
    save.then(function () { return api('/api/twitch/connect', {}); }).then(function (r) {
      var box = $('twitch-code'); box.className = 'msg'; box.textContent = '';
      var a = document.createElement('a'); a.href = r.verificationUri; a.target = '_blank'; a.rel = 'noopener'; a.textContent = r.verificationUri.replace('https://', '');
      box.appendChild(document.createTextNode('Open ')); box.appendChild(a); box.appendChild(document.createTextNode(' (sign in as the account the bot should use), type this code, and press Authorise: '));
      var b = document.createElement('b'); b.textContent = r.userCode; box.appendChild(b);
      show($('twitch-msg'), 'Waiting for you to approve it on Twitch\u2026', false);
      twitchWatch(r.intervalSec);
    }).catch(function (e) { show($('twitch-msg'), e.message, true); }).then(function () { $('twitch-connect').disabled = false; });
  };
  $('twitch-save').onclick = function () {
    $('twitch-save').disabled = true;
    api('/api/twitch/settings', twitchBody()).then(function (r) { renderTwitch(r); show($('twitch-msg'), 'Saved. The bot is restarting to use it.', false); poll(); })
      .catch(function (e) { show($('twitch-msg'), e.message, true); }).then(function () { $('twitch-save').disabled = false; });
  };
  $('twitch-disconnect').onclick = function () { api('/api/twitch/disconnect', {}).then(function () { show($('twitch-msg'), 'Disconnected from Twitch.', false); twitchPoll(); poll(); }); };
  $('restart').onclick = function () { api('/api/restart', {}).then(poll); };
  /* Reset everything: the button only opens the warning; nothing is deleted until Delete everything is pressed there. */
  $('reset-open').onclick = function () { $('reset-msg').className = 'msg hidden'; $('reset-dialog').showModal(); $('reset-cancel').focus(); };
  $('reset-cancel').onclick = function () { $('reset-dialog').close(); };
  $('reset-go').onclick = function () {
    $('reset-go').disabled = true; $('reset-cancel').disabled = true;
    show($('reset-msg'), 'Stopping the bot and deleting everything\\u2026', false);
    api('/api/reset', { confirm: 'DELETE EVERYTHING' }).then(function () {
      try { localStorage.removeItem('fpb-tab'); sessionStorage.setItem('fpb-reset', '1'); } catch (e) {}
      location.reload();
    }).catch(function (e) {
      show($('reset-msg'), e.message, true);
      $('reset-go').disabled = false; $('reset-cancel').disabled = false;
    });
  };
  /* Esc must not hide the box while the deleting is going on. */
  $('reset-dialog').addEventListener('cancel', function (ev) { if ($('reset-go').disabled) ev.preventDefault(); });
  try {
    if (sessionStorage.getItem('fpb-reset')) { sessionStorage.removeItem('fpb-reset'); show($('reset-done'), 'Everything was reset. Set the bot up again from the Discord bot tab.', false); }
  } catch (e) {}
  $('logs-refresh').onclick = logs;
  $('google-remove').onclick = function () { api('/api/google-key/remove', {}).then(function () { show($('google-msg'), 'Key removed.', false); poll(); }); };
  $('google-file').onchange = function () {
    var f = this.files[0]; if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      api('/api/google-key', { json: String(reader.result) }).then(function (r) { show($('google-msg'), 'Saved. Share your sheet with ' + r.email + ' as an Editor.', false); poll(); })
        .catch(function (e) { show($('google-msg'), e.message, true); });
    };
    reader.readAsText(f);
  };
  buildNav();
  var wanted = 'bot';
  try { wanted = localStorage.getItem('fpb-tab') || 'bot'; } catch (e) {}
  selectTab(HOST_TABS.some(function (t) { return t[0] === wanted; }) ? wanted : 'bot');
  api('/api/setup/tabs').then(function (r) {
    tabs = r.tabs; tabs.forEach(function (t) { tabById[t.id] = t; });
    buildNav();
    selectTab(tabById[wanted] || HOST_TABS.some(function (t) { return t[0] === wanted; }) ? wanted : 'bot');
  }).catch(function () {});
  poll(); logs(); twitchPoll(); setInterval(poll, 2500); setInterval(logs, 5000); setInterval(twitchPoll, 5000);
})();
</script>
</body>
</html>`;
}
