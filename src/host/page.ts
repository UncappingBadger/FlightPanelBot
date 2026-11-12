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
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h1 small { color:var(--muted); font-weight:400; font-size:13px; margin-left:8px; }
  h2 { font-size: 16px; margin: 0 0 10px; }
  p { margin: 0 0 10px; } .muted { color: var(--muted); }
  section, .status { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin:14px 0; }
  .status { display:flex; gap:12px; align-items:center; } .dot { width:14px; height:14px; border-radius:50%; background:var(--warn); flex:none; }
  .dot.online { background:var(--ok); } .dot.error { background:var(--bad); } .dot.update { background:var(--accent); } .status b { display:block; }
  .status.update { border-color:var(--accent); } label.check { display:flex; gap:8px; align-items:center; font-weight:400; margin:10px 0 0; }
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
</style>
</head>
<body>
<main>
  <h1>Flight Panel Bot <small>v${safeVersion}</small></h1>
  <p class="muted">Runs on this computer and keeps your airline's flight panel working in your Discord server. This page is only reachable from this computer.</p>

  <div class="status"><span class="dot" id="dot"></span><div><b id="phase">Checking…</b><span class="muted" id="message"></span></div></div>

  <div class="status update hidden" id="update-banner">
    <span class="dot update"></span>
    <div style="flex:1"><b id="update-title">A new version is available</b><span class="muted" id="update-text"></span></div>
    <a class="btn" id="update-link" target="_blank" rel="noopener">Open the download page</a>
  </div>

  <section id="s-tokens">
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

  <section id="s-invite">
    <h2>2. Add the bot to your Discord server</h2>
    <p id="invite-text" class="muted">Save your Discord token above and the link appears here.</p>
    <div class="row"><a class="btn hidden" id="invite" target="_blank" rel="noopener">Add the bot to a server</a><button class="secondary hidden" id="copy">Copy the link</button></div>
    <p class="muted" style="margin-top:12px">You need the <b>Manage Server</b> permission on that server. Once it's added, type <code>/setup</code> in any channel to start. The setup manual walks through the rest.</p>
    <table id="servers" class="hidden"></table>
  </section>

  <section id="s-google">
    <h2>3. Optional: let the bot write to your Google Sheet</h2>
    <p class="muted">Only needed if you want reservations and completions to appear in your sheet. Choose the JSON key file of your Google service account (see the manual for how to create one).</p>
    <p id="google-state" class="muted"></p>
    <div class="row"><input type="file" id="google-file" accept=".json,application/json"><button class="secondary" id="google-remove">Remove key</button></div>
    <div class="msg hidden" id="google-msg"></div>
  </section>

  <section id="s-fshub">
    <h2>4. Optional: connect the bot to FsHub</h2>
    <p class="muted">With a FsHub token the bot checks the pilot IDs people type and shows the name FsHub has for each, and <code>/setup fshub</code> can read your airline's roster so pilots are matched to their Discord accounts without being asked. It only reads from FsHub and never changes anything there. Without a token the bot never contacts FsHub.</p>
    <p class="muted">Create a personal access token at <a href="https://fshub.io/settings/integrations" target="_blank" rel="noopener">fshub.io/settings/integrations</a>. FsHub only shows an airline's roster to its members, so use an account that belongs to your airline. The token acts as that account, so keep it private; you can delete it on that page at any time.</p>
    <label for="fshub">FsHub access token</label>
    <input type="password" id="fshub" autocomplete="off" spellcheck="false" placeholder="Paste the token here">
    <p id="fshub-state" class="muted"></p>
    <div class="row"><button id="fshub-save">Check and save token</button><button class="secondary" id="fshub-remove">Remove token</button></div>
    <div class="msg hidden" id="fshub-msg"></div>
  </section>

  <section>
    <h2>Updates</h2>
    <p id="update-state" class="muted">Checking…</p>
    <div class="row" style="margin-top:0"><button class="secondary" id="update-check">Check for updates</button></div>
    <label class="check"><input type="checkbox" id="update-auto"> Check GitHub once a day for a new version</label>
    <p class="muted" style="margin-top:8px">The check asks github.com for the latest release of this app, nothing else. Nothing is downloaded or installed: when a newer version exists you are told, and you download it yourself.</p>
    <div class="msg hidden" id="update-msg"></div>
  </section>

  <section>
    <h2>Activity</h2>
    <div class="row" style="margin-top:0"><button class="secondary" id="restart">Restart the bot</button><button class="secondary" id="logs-refresh">Refresh log</button></div>
    <pre id="logs">Loading…</pre>
  </section>

  <p class="muted">To stop the bot, right-click the tray icon (near the clock) and choose Quit. Your settings and data stay on this computer, in <code>%APPDATA%\\FlightPanelBot</code>.</p>
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
  $('restart').onclick = function () { api('/api/restart', {}).then(poll); };
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
  poll(); logs(); setInterval(poll, 2500); setInterval(logs, 5000);
})();
</script>
</body>
</html>`;
}
