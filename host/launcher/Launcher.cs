// Flight Panel Bot: the Windows tray launcher.
//
// One small program that (1) unpacks the bundled Node runtime and the bot on first run, (2) starts the
// bot with no window, (3) shows a tray icon with its status, and (4) opens the bot's local setup page.
// Written for the C# 5 compiler that ships with Windows, so it needs nothing installed.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace FlightPanelBot
{
    internal static class Paths
    {
        public static string AppHome
        {
            get
            {
                string env = Environment.GetEnvironmentVariable("FPB_HOME");
                if (!string.IsNullOrEmpty(env)) return Path.GetFullPath(env);
                return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "FlightPanelBot");
            }
        }
        public static string Status { get { return Path.Combine(AppHome, "status.json"); } }
        public static string LogsDir { get { return Path.Combine(AppHome, "logs"); } }
        public static string BotLog { get { return Path.Combine(LogsDir, "bot.log"); } }
        public static string LauncherLog { get { return Path.Combine(LogsDir, "launcher.log"); } }
        public static string RuntimeRoot
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FlightPanelBot", "runtime"); }
        }
        public static string RuntimeDir { get { return Path.Combine(RuntimeRoot, BuildInfo.BuildId); } }
    }

    internal static class Log
    {
        private static readonly object Gate = new object();
        public static void Write(string line)
        {
            try
            {
                lock (Gate)
                {
                    Directory.CreateDirectory(Paths.LogsDir);
                    FileInfo fi = new FileInfo(Paths.LauncherLog);
                    if (fi.Exists && fi.Length > 500000) fi.Delete();
                    File.AppendAllText(Paths.LauncherLog, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line + Environment.NewLine);
                }
            }
            catch (Exception) { }
        }
    }

    internal static class Shell
    {
        /// <summary>Open a link or folder with the default program. FPB_NO_BROWSER=1 only logs it (for automated tests).</summary>
        public static void Open(string target)
        {
            if (Environment.GetEnvironmentVariable("FPB_NO_BROWSER") == "1") { Log.Write("(would open) " + target); return; }
            try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
            catch (Exception e) { Log.Write("Could not open " + target + ": " + e.Message); }
        }
    }

    internal static class Native
    {
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool DestroyIcon(IntPtr handle);
    }

    /// <summary>What the bot says about itself, read from status.json.</summary>
    internal class BotStatus
    {
        public string Phase = "starting";
        public string Message = "Starting…";
        public string BotName = "";
        public string InviteUrl = "";
        public int Port;
        public string Key = "";
        public int Servers;
        /// <summary>A newer release exists on GitHub (the bot checks; nothing is downloaded).</summary>
        public bool UpdateAvailable;
        public string UpdateLatest = "";
        public string UpdateUrl = "";
        /// <summary>True during the run that first found this release, so the pop-up appears once per release.</summary>
        public bool UpdateAnnounce;

        /// <summary>Only ever hand the shell an address inside GitHub, whatever the status file says.</summary>
        public string SafeUpdateUrl
        {
            get { return UpdateAvailable && UpdateUrl.StartsWith("https://github.com/", StringComparison.Ordinal) ? UpdateUrl : null; }
        }

        public string SettingsUrl
        {
            get { return Port > 0 && Key.Length > 0 ? "http://127.0.0.1:" + Port + "/?k=" + Uri.EscapeDataString(Key) : null; }
        }

        public static BotStatus Read()
        {
            try
            {
                if (!File.Exists(Paths.Status)) return null;
                string text;
                using (FileStream fs = new FileStream(Paths.Status, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (StreamReader sr = new StreamReader(fs, Encoding.UTF8)) text = sr.ReadToEnd();
                Dictionary<string, object> d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(text);
                BotStatus s = new BotStatus();
                s.Phase = Str(d, "phase", "starting");
                s.Message = Str(d, "message", "");
                s.BotName = Str(d, "botName", "");
                s.InviteUrl = Str(d, "inviteUrl", "");
                s.Key = Str(d, "key", "");
                object port;
                if (d.TryGetValue("port", out port) && port != null) int.TryParse(port.ToString(), out s.Port);
                object servers;
                if (d.TryGetValue("servers", out servers) && servers is ArrayList) s.Servers = ((ArrayList)servers).Count;
                object update;
                Dictionary<string, object> u = d.TryGetValue("update", out update) ? update as Dictionary<string, object> : null;
                if (u != null)
                {
                    s.UpdateAvailable = Bool(u, "available");
                    s.UpdateAnnounce = Bool(u, "announce");
                    s.UpdateLatest = Str(u, "latest", "");
                    s.UpdateUrl = Str(u, "url", "");
                }
                return s;
            }
            catch (Exception) { return null; }
        }

        private static string Str(Dictionary<string, object> d, string key, string fallback)
        {
            object v;
            return d.TryGetValue(key, out v) && v != null ? v.ToString() : fallback;
        }

        private static bool Bool(Dictionary<string, object> d, string key)
        {
            object v;
            return d.TryGetValue(key, out v) && v is bool && (bool)v;
        }
    }

    /// <summary>Unpacks the bundled Node runtime and bot, once per build.</summary>
    internal static class Runtime
    {
        public static string NodeExe { get { return Path.Combine(Paths.RuntimeDir, "node.exe"); } }
        public static string BotScript { get { return Path.Combine(Paths.RuntimeDir, "bot.mjs"); } }

        public static void Ensure()
        {
            string dir = Paths.RuntimeDir;
            string marker = Path.Combine(dir, ".complete");
            if (File.Exists(NodeExe) && File.Exists(BotScript) && File.Exists(marker)) return;

            Log.Write("Unpacking the runtime to " + dir);
            string tmp = dir + ".tmp" + Process.GetCurrentProcess().Id;
            if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
            Directory.CreateDirectory(tmp);
            Extract("node.exe.gz", Path.Combine(tmp, "node.exe"));
            Extract("bot.mjs.gz", Path.Combine(tmp, "bot.mjs"));
            File.WriteAllText(Path.Combine(tmp, ".complete"), BuildInfo.BuildId);
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            Directory.CreateDirectory(Paths.RuntimeRoot);
            Directory.Move(tmp, dir);

            // Tidy up runtimes left by older builds; one that is still running simply can't be deleted yet.
            try
            {
                foreach (string other in Directory.GetDirectories(Paths.RuntimeRoot))
                {
                    if (string.Equals(Path.GetFileName(other), BuildInfo.BuildId, StringComparison.OrdinalIgnoreCase)) continue;
                    try { Directory.Delete(other, true); } catch (Exception) { }
                }
            }
            catch (Exception) { }
        }

        private static void Extract(string resource, string target)
        {
            using (Stream raw = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource))
            {
                if (raw == null) throw new InvalidOperationException("This program is missing its bundled file " + resource + ".");
                using (GZipStream gz = new GZipStream(raw, CompressionMode.Decompress))
                using (FileStream outFile = new FileStream(target, FileMode.Create, FileAccess.Write))
                {
                    byte[] buffer = new byte[1 << 16];
                    int n;
                    while ((n = gz.Read(buffer, 0, buffer.Length)) > 0) outFile.Write(buffer, 0, n);
                }
            }
        }
    }

    /// <summary>Runs the bot as a hidden child process, and restarts it if it dies.</summary>
    internal class BotProcess
    {
        private Process proc;
        private readonly List<DateTime> starts = new List<DateTime>();
        private bool stopping;
        /// <summary>"restarting", "gaveup" (too many quick failures) or "stopped" (we asked it to stop).</summary>
        public event Action<string> Exited;
        public bool GaveUp { get; private set; }

        public bool Running
        {
            get { try { return proc != null && !proc.HasExited; } catch (Exception) { return false; } }
        }

        public void Start()
        {
            stopping = false;
            GaveUp = false;
            try { File.Delete(Paths.Status); } catch (Exception) { }
            Directory.CreateDirectory(Paths.AppHome);

            ProcessStartInfo psi = new ProcessStartInfo(Runtime.NodeExe, "--disable-warning=ExperimentalWarning \"" + Runtime.BotScript + "\"");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WorkingDirectory = Paths.AppHome;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.EnvironmentVariables["FPB_PARENT_PID"] = Process.GetCurrentProcess().Id.ToString();
            psi.EnvironmentVariables["FPB_VERSION"] = BuildInfo.Version;

            Process p = new Process();
            p.StartInfo = psi;
            p.EnableRaisingEvents = true;
            p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) Log.Write("bot: " + e.Data); };
            p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) Log.Write("bot!: " + e.Data); };
            p.Exited += delegate(object s, EventArgs e) { OnExited(p); };
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            proc = p;
            starts.Add(DateTime.UtcNow);
            Log.Write("Started the bot (pid " + p.Id + ")");
        }

        private void OnExited(Process p)
        {
            if (!object.ReferenceEquals(p, proc)) return;
            int code = -1;
            try { code = p.ExitCode; } catch (Exception) { }
            Log.Write("The bot exited with code " + code);
            if (stopping) { if (Exited != null) Exited("stopped"); return; }

            // Too many quick restarts means something is badly wrong; stop and let the host look at the log.
            DateTime cutoff = DateTime.UtcNow.AddMinutes(-2);
            starts.RemoveAll(delegate(DateTime t) { return t < cutoff; });
            if (starts.Count >= 5)
            {
                GaveUp = true;
                Log.Write("The bot keeps stopping; giving up until it is restarted by hand.");
                if (Exited != null) Exited("gaveup");
                return;
            }
            if (Exited != null) Exited("restarting");
            ThreadPool.QueueUserWorkItem(delegate(object state)
            {
                Thread.Sleep(3000);
                if (stopping) return;
                try { Start(); } catch (Exception ex) { Log.Write("Could not restart the bot: " + ex.Message); }
            });
        }

        /// <summary>Ask the bot to shut down cleanly, then insist if it doesn't.</summary>
        public void Stop(BotStatus status)
        {
            stopping = true;
            Process p = proc;
            if (p == null) return;
            try
            {
                if (status != null && status.Port > 0 && status.Key.Length > 0)
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + status.Port + "/api/quit");
                    req.Method = "POST";
                    req.ContentType = "application/json";
                    req.Headers["X-FPB-Key"] = status.Key;
                    req.Timeout = 3000;
                    req.Proxy = null;
                    byte[] body = Encoding.UTF8.GetBytes("{}");
                    req.ContentLength = body.Length;
                    using (Stream s = req.GetRequestStream()) s.Write(body, 0, body.Length);
                    using (req.GetResponse()) { }
                }
            }
            catch (Exception) { }
            try { if (!p.WaitForExit(9000)) p.Kill(); } catch (Exception) { }
        }

        public void Restart(BotStatus status)
        {
            Stop(status);
            Start();
        }
    }

    internal class TrayApp : IDisposable
    {
        private readonly NotifyIcon tray = new NotifyIcon();
        private readonly ContextMenuStrip menu = new ContextMenuStrip();
        private readonly ToolStripMenuItem statusItem = new ToolStripMenuItem();
        private readonly ToolStripMenuItem startupItem = new ToolStripMenuItem("Start with Windows");
        private readonly ToolStripMenuItem inviteItem = new ToolStripMenuItem("Add the bot to a Discord server…");
        private readonly ToolStripMenuItem copyItem = new ToolStripMenuItem("Copy the invite link");
        private readonly ToolStripMenuItem updateItem = new ToolStripMenuItem("A new version is available");
        private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        private readonly BotProcess bot = new BotProcess();
        private readonly Control ui = new Control();
        private readonly Bitmap baseIcon;
        private BotStatus status;
        private string shownKey = "";
        private bool openedSetup;
        private bool announcedOnline;
        private bool quitting;
        private bool crashed;
        private Icon currentIcon;
        private string lastBalloonKind = "";
        private string announcedUpdate = "";

        public TrayApp()
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("tray.png")) baseIcon = new Bitmap(s);
            IntPtr force = ui.Handle; // makes sure callbacks from other threads can be marshalled to this one

            statusItem.Enabled = false;
            ToolStripMenuItem settings = new ToolStripMenuItem("Open settings");
            settings.Font = new Font(settings.Font, FontStyle.Bold);
            settings.Click += delegate { OpenSettings(); };
            inviteItem.Click += delegate { if (status != null && status.InviteUrl.Length > 0) Open(status.InviteUrl); };
            copyItem.Click += delegate
            {
                if (status != null && status.InviteUrl.Length > 0)
                {
                    try { Clipboard.SetText(status.InviteUrl); tray.ShowBalloonTip(3000, "Flight Panel Bot", "The invite link is on your clipboard.", ToolTipIcon.Info); } catch (Exception) { }
                }
            };
            ToolStripMenuItem log = new ToolStripMenuItem("Open the log");
            log.Click += delegate { Open(File.Exists(Paths.BotLog) ? Paths.BotLog : Paths.AppHome); };
            ToolStripMenuItem data = new ToolStripMenuItem("Open the data folder");
            data.Click += delegate { Directory.CreateDirectory(Paths.AppHome); Open(Paths.AppHome); };
            ToolStripMenuItem restart = new ToolStripMenuItem("Restart the bot");
            restart.Click += delegate { RestartBot(); };
            startupItem.Click += delegate { ToggleStartup(); };
            ToolStripMenuItem about = new ToolStripMenuItem("About");
            about.Click += delegate { About(); };
            ToolStripMenuItem quit = new ToolStripMenuItem("Quit");
            quit.Click += delegate { Quit(); };

            updateItem.Font = new Font(updateItem.Font, FontStyle.Bold);
            updateItem.Visible = false;
            updateItem.Click += delegate { OpenUpdatePage(); };

            menu.Items.Add(statusItem);
            menu.Items.Add(updateItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(settings);
            menu.Items.Add(inviteItem);
            menu.Items.Add(copyItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(log);
            menu.Items.Add(data);
            menu.Items.Add(restart);
            menu.Items.Add(startupItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(about);
            menu.Items.Add(quit);
            menu.Opening += delegate { RefreshMenu(); };

            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { OpenSettings(); };
            tray.BalloonTipClicked += delegate
            {
                if (lastBalloonKind == "setup" || lastBalloonKind == "error") OpenSettings();
                else if (lastBalloonKind == "update") OpenUpdatePage();
            };
            SetIcon("starting");
            tray.Text = "Flight Panel Bot: starting";
            tray.Visible = true;

            bot.Exited += delegate(string kind)
            {
                ui.BeginInvoke(new MethodInvoker(delegate
                {
                    if (quitting) return;
                    crashed = kind == "gaveup";
                    if (crashed) Balloon("error", "The bot stopped", "It kept stopping. Open the log from the tray menu to see why, then choose Restart the bot.", ToolTipIcon.Error);
                    Tick();
                }));
            };

            timer.Interval = 2000;
            timer.Tick += delegate { Tick(); };
        }

        public void Run()
        {
            try
            {
                Runtime.Ensure();
                bot.Start();
            }
            catch (Exception e)
            {
                Log.Write("Start-up failed: " + e);
                MessageBox.Show("Flight Panel Bot could not start.\n\n" + e.Message + "\n\nThe log is in " + Paths.LogsDir, "Flight Panel Bot", MessageBoxButtons.OK, MessageBoxIcon.Error);
                tray.Visible = false;
                return;
            }
            SystemEventsHook();
            timer.Start();
            Application.Run();
        }

        private void SystemEventsHook()
        {
            // Windows is signing out or shutting down: let the bot disconnect properly first.
            Microsoft.Win32.SystemEvents.SessionEnding += delegate { if (!quitting) { quitting = true; bot.Stop(status); } };
        }

        private void Tick()
        {
            BotStatus s = BotStatus.Read();
            if (s != null) status = s;
            string phase;
            string text;
            if (crashed || bot.GaveUp) { phase = "error"; text = "The bot stopped. Open the log, then restart it."; }
            else if (!bot.Running && status == null) { phase = "starting"; text = "Starting…"; }
            else if (status == null) { phase = "starting"; text = "Starting…"; }
            else { phase = status.Phase; text = status.Message; }

            string key = phase + "|" + text;
            if (key != shownKey)
            {
                shownKey = key;
                SetIcon(phase);
                tray.Text = Truncate("Flight Panel Bot: " + Friendly(phase), 63);
                OnPhase(phase, text);
            }
            AnnounceUpdate();
            RefreshMenu();
        }

        /// <summary>Tell the host, once per release, that a newer version is out. The menu item stays until they update.</summary>
        private void AnnounceUpdate()
        {
            if (status == null || status.SafeUpdateUrl == null || !status.UpdateAnnounce) return;
            if (status.UpdateLatest == announcedUpdate) return;
            announcedUpdate = status.UpdateLatest;
            Log.Write("A newer version is available (" + status.UpdateLatest + "); showing the notice.");
            Balloon("update", "A new Flight Panel Bot is available", "Version " + Truncate(status.UpdateLatest, 20) + " is out. Click here to open the download page.", ToolTipIcon.Info);
        }

        private void OpenUpdatePage()
        {
            string url = status != null ? status.SafeUpdateUrl : null;
            if (url != null) Open(url);
        }

        private void OnPhase(string phase, string text)
        {
            if (phase == "needs-setup")
            {
                Balloon("setup", "Finish setting up", "Click here to enter your Discord bot token.", ToolTipIcon.Info);
                if (!openedSetup && status != null && status.SettingsUrl != null) { openedSetup = true; OpenSettings(); }
            }
            else if (phase == "online" && !announcedOnline)
            {
                announcedOnline = true;
                Balloon("online", "Flight Panel Bot is online", status != null && status.BotName.Length > 0 ? status.BotName + " is running. It keeps working while this icon is here." : "The bot is running.", ToolTipIcon.Info);
                ShowStartupTipOnce();
            }
            else if (phase == "error")
            {
                Balloon("error", "Flight Panel Bot needs attention", Truncate(text, 200), ToolTipIcon.Warning);
            }
        }

        private void ShowStartupTipOnce()
        {
            try
            {
                string marker = Path.Combine(Paths.AppHome, ".startup-tip");
                if (File.Exists(marker) || StartupEnabled()) return;
                File.WriteAllText(marker, "shown");
                Balloon("tip", "Keep the bot running", "Right-click this icon and choose Start with Windows so it comes back after a restart.", ToolTipIcon.Info);
            }
            catch (Exception) { }
        }

        private void RefreshMenu()
        {
            string line;
            if (crashed || bot.GaveUp) line = "The bot has stopped";
            else if (status == null) line = "Starting…";
            else if (status.Phase == "online") line = "Online" + (status.BotName.Length > 0 ? " as " + status.BotName : "") + " (" + status.Servers + (status.Servers == 1 ? " server)" : " servers)");
            else line = Friendly(status.Phase) + (status.Message.Length > 0 ? ": " + status.Message : "");
            statusItem.Text = Truncate(line, 70);
            bool hasUpdate = status != null && status.SafeUpdateUrl != null;
            updateItem.Visible = hasUpdate;
            if (hasUpdate) updateItem.Text = Truncate("A new version is available: " + status.UpdateLatest, 60);
            bool hasInvite = status != null && status.InviteUrl.Length > 0;
            inviteItem.Enabled = hasInvite;
            copyItem.Enabled = hasInvite;
            startupItem.Checked = StartupEnabled();
        }

        private static string Friendly(string phase)
        {
            switch (phase)
            {
                case "online": return "online";
                case "needs-setup": return "needs setup";
                case "starting": return "starting";
                case "retrying": return "can't reach Discord";
                case "error": return "needs attention";
                case "stopped": return "stopped";
                default: return phase;
            }
        }

        private void Balloon(string kind, string title, string text, ToolTipIcon icon)
        {
            lastBalloonKind = kind;
            try { tray.ShowBalloonTip(6000, title, text, icon); } catch (Exception) { }
        }

        private void SetIcon(string phase)
        {
            Color dot;
            switch (phase)
            {
                case "online": dot = Color.FromArgb(46, 160, 67); break;
                case "error": dot = Color.FromArgb(214, 64, 69); break;
                case "stopped": dot = Color.FromArgb(140, 140, 140); break;
                default: dot = Color.FromArgb(232, 162, 0); break;
            }
            using (Bitmap b = new Bitmap(baseIcon))
            {
                using (Graphics g = Graphics.FromImage(b))
                {
                    g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                    int d = Math.Max(8, b.Width / 2 - 2);
                    Rectangle r = new Rectangle(b.Width - d - 1, b.Height - d - 1, d, d);
                    using (SolidBrush ring = new SolidBrush(Color.White)) g.FillEllipse(ring, r.X - 2, r.Y - 2, r.Width + 4, r.Height + 4);
                    using (SolidBrush fill = new SolidBrush(dot)) g.FillEllipse(fill, r);
                }
                IntPtr h = b.GetHicon();
                Icon previous = currentIcon;
                currentIcon = (Icon)Icon.FromHandle(h).Clone();
                Native.DestroyIcon(h);
                tray.Icon = currentIcon;
                if (previous != null) previous.Dispose();
            }
        }

        private void OpenSettings()
        {
            BotStatus s = status ?? BotStatus.Read();
            if (s != null && s.SettingsUrl != null) Open(s.SettingsUrl);
            else tray.ShowBalloonTip(3000, "Flight Panel Bot", "The bot is still starting. Try again in a moment.", ToolTipIcon.Info);
        }

        private static void Open(string target)
        {
            Shell.Open(target);
        }

        private void RestartBot()
        {
            crashed = false;
            shownKey = "";
            status = null;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try { bot.Restart(BotStatus.Read()); }
                catch (Exception e) { Log.Write("Restart failed: " + e.Message); }
            });
        }

        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunValue = "FlightPanelBot";

        private static bool StartupEnabled()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey, false)) return k != null && k.GetValue(RunValue) != null;
            }
            catch (Exception) { return false; }
        }

        private void ToggleStartup()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    if (StartupEnabled()) k.DeleteValue(RunValue, false);
                    else k.SetValue(RunValue, "\"" + Application.ExecutablePath + "\"");
                }
            }
            catch (Exception e) { Log.Write("Could not change start-with-Windows: " + e.Message); }
            RefreshMenu();
        }

        private void About()
        {
            MessageBox.Show(
                "Flight Panel Bot " + BuildInfo.Version + "\nBy UncappingBadger\n\n" +
                "Keeps your virtual airline's flight panel running in your own Discord server.\n" +
                "Unofficial: not affiliated with, endorsed by, or sponsored by FsHub, Aeroconomy, AeroDAQ or Discord.\n\n" +
                "Settings, data and logs: " + Paths.AppHome + "\n" +
                "Licence: MIT. Includes Node.js and other open-source software; see THIRD_PARTY_NOTICES.txt that came with this program.",
                "About Flight Panel Bot", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private void Quit()
        {
            if (quitting) return;
            quitting = true;
            tray.Text = "Flight Panel Bot: stopping";
            ThreadPool.QueueUserWorkItem(delegate
            {
                try { bot.Stop(status ?? BotStatus.Read()); } catch (Exception) { }
                ui.BeginInvoke(new MethodInvoker(delegate { tray.Visible = false; Application.Exit(); }));
            });
        }

        private static string Truncate(string s, int max)
        {
            if (s == null) return "";
            return s.Length <= max ? s : s.Substring(0, max - 1) + "…";
        }

        public void Dispose()
        {
            timer.Dispose();
            tray.Visible = false;
            tray.Dispose();
            menu.Dispose();
            if (currentIcon != null) currentIcon.Dispose();
            baseIcon.Dispose();
        }
    }

    internal static class Program
    {
        private static string HomeHash()
        {
            using (MD5 md5 = MD5.Create())
            {
                byte[] h = md5.ComputeHash(Encoding.UTF8.GetBytes(Paths.AppHome.ToLowerInvariant()));
                return BitConverter.ToString(h).Replace("-", "").Substring(0, 16);
            }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length >= 2 && args[0] == "--selftest") return SelfTest(args[1]);

            bool created;
            using (Mutex single = new Mutex(true, "Local\\FlightPanelBot.Host." + HomeHash(), out created))
            {
                if (!created)
                {
                    // Already running: bring up its setup page instead of starting a second bot.
                    BotStatus s = BotStatus.Read();
                    if (s != null && s.SettingsUrl != null) Shell.Open(s.SettingsUrl);
                    else MessageBox.Show("Flight Panel Bot is already running. Look for its icon near the clock (it may be under the ^ arrow).", "Flight Panel Bot", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return 0;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (TrayApp app = new TrayApp()) app.Run();
                GC.KeepAlive(single);
            }
            return 0;
        }

        /// <summary>
        /// A headless check for the build: unpack, start the bot, wait for its setup page, ask it for its
        /// state, ask it to quit, and write what happened to a file. No window, no tray icon.
        /// </summary>
        private static int SelfTest(string outFile)
        {
            StringBuilder report = new StringBuilder();
            int result = 1;
            BotProcess bot = new BotProcess();
            BotStatus status = null;
            try
            {
                Runtime.Ensure();
                report.AppendLine("runtime=" + Paths.RuntimeDir);
                report.AppendLine("node_exists=" + File.Exists(Runtime.NodeExe));
                report.AppendLine("bot_exists=" + File.Exists(Runtime.BotScript));
                bot.Start();
                for (int i = 0; i < 160 && (status == null || status.Port == 0); i++) { Thread.Sleep(250); status = BotStatus.Read(); }
                if (status == null || status.Port == 0) throw new Exception("The bot never published its status.");
                report.AppendLine("phase=" + status.Phase);
                report.AppendLine("message=" + status.Message);
                report.AppendLine("port=" + status.Port);

                string baseUrl = "http://127.0.0.1:" + status.Port;
                report.AppendLine("page=" + Get(baseUrl + "/?k=" + Uri.EscapeDataString(status.Key), null));
                report.AppendLine("page_without_key=" + Get(baseUrl + "/", null));
                report.AppendLine("state=" + Get(baseUrl + "/api/state", status.Key));
                result = 0;
            }
            catch (Exception e) { report.AppendLine("error=" + e.Message); }
            finally
            {
                try { bot.Stop(status); } catch (Exception) { }
                report.AppendLine("bot_running_after_quit=" + bot.Running);
                try { File.WriteAllText(outFile, report.ToString()); } catch (Exception) { }
            }
            return result;
        }

        private static string Get(string url, string key)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 5000;
                req.Proxy = null;
                if (key != null) req.Headers["X-FPB-Key"] = key;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                using (StreamReader sr = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                {
                    string body = sr.ReadToEnd();
                    return (int)res.StatusCode + " " + (body.Length > 160 ? body.Substring(0, 160) : body).Replace("\r", " ").Replace("\n", " ");
                }
            }
            catch (WebException we)
            {
                HttpWebResponse r = we.Response as HttpWebResponse;
                return r != null ? ((int)r.StatusCode).ToString() : "failed: " + we.Message;
            }
        }
    }
}
