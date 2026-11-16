// Tessly untuk VS Code: total token Claude Code di status bar, dashboard lengkap di tab editor.
// Penghitungnya sama dengan aplikasi Tessly (scanner.js + history.js); hanya tampilannya yang dipindah.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Scanner, localDay } = require('./scanner');
const { History } = require('./history');

const FULL_SCAN_MS = 30_000; // cadangan; perubahan log biasanya sudah tertangkap lewat fs.watch
const WATCH_DEBOUNCE_MS = 200;
const PREFS_KEY = 'tessly.prefs'; // pilihan dashboard (tema, bahasa, jenis token), sama seperti localStorage di aplikasi

let ctx;
let scanner;
let history;
let panel = null;
let status;
let scanned = false;
let snapshotCache = null;
const watchers = [];

const TEXT = {
  id: { locale: 'id-ID', today: '{n} token hari ini', tip: 'Tessly: {n} token hari ini (input + output). Klik untuk membuka dashboard.', loading: 'Tessly: membaca log Claude Code' },
  en: { locale: 'en-US', today: '{n} tokens today', tip: 'Tessly: {n} tokens today (input + output). Click to open the dashboard.', loading: 'Tessly: reading Claude Code logs' },
};

function prefs() {
  return ctx.globalState.get(PREFS_KEY, {});
}

function lang() {
  const l = prefs()['tessly.lang'];
  if (l === 'id' || l === 'en') return l;
  return vscode.env.language.toLowerCase().startsWith('id') ? 'id' : 'en';
}

const tr = (key, vars = {}) => TEXT[lang()][key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

// ---------- data ----------
function snapshot() {
  if (snapshotCache) return snapshotCache;
  const daily = history.rows();
  const months = new Map();
  for (const r of daily) {
    const k = `${r.d.slice(0, 7)}|${r.mo}`;
    const a = months.get(k) || { d: r.d.slice(0, 7), mo: r.mo, i: 0, o: 0, cw: 0, cr: 0, n: 0 };
    for (const f of ['i', 'o', 'cw', 'cr', 'n']) a[f] += r[f];
    months.set(k, a);
  }
  snapshotCache = { ready: scanned || history.size > 0, daily, monthly: [...months.values()] };
  return snapshotCache;
}

function publish() {
  snapshotCache = null;
  if (panel) panel.webview.postMessage({ type: 'data', data: snapshot() });
  updateStatus();
}

function updateStatus() {
  if (!status) return;
  if (!scanned && history.size === 0) {
    status.text = '$(loading~spin) Tessly';
    status.tooltip = tr('loading');
    return;
  }
  const today = localDay(Date.now());
  const t = snapshot().daily.filter((r) => r.d === today).reduce((a, r) => a + r.i + r.o, 0);
  const n = new Intl.NumberFormat(tr('locale'), { notation: 'compact', maximumFractionDigits: 1 }).format(t);
  status.text = `$(pulse) ${tr('today', { n })}`;
  status.tooltip = tr('tip', { n: new Intl.NumberFormat(tr('locale')).format(t) });
}

function applyStatusVisibility() {
  if (vscode.workspace.getConfiguration('tessly').get('showStatusBar', true)) status.show();
  else status.hide();
}

// ---------- membaca log ----------
const pending = new Set();
let scanning = false;
let fullAgain = false;
let watchTimer = null;

async function scan(full) {
  if (scanning) {
    fullAgain = fullAgain || full;
    return;
  }
  scanning = true;
  try {
    let changed;
    if (full) {
      pending.clear();
      changed = await scanner.scan();
    } else {
      const files = [...pending];
      pending.clear();
      changed = await scanner.scanFiles(files);
    }
    const first = !scanned;
    scanned = true;
    if ((changed && history.merge(scanner.aggregate())) || first) publish();
  } catch (e) {
    console.error('Tessly:', e);
  } finally {
    scanning = false;
  }
  if (fullAgain || pending.size) {
    const f = fullAgain;
    fullAgain = false;
    scan(f);
  }
}

function watchLogs() {
  for (const root of scanner.roots) {
    try {
      const w = fs.watch(root, { recursive: true }, (_event, file) => {
        if (!file || !file.endsWith('.jsonl')) return;
        pending.add(path.join(root, file));
        clearTimeout(watchTimer);
        watchTimer = setTimeout(() => scan(false), WATCH_DEBOUNCE_MS);
      });
      w.on('error', () => { /* folder dihapus: pembacaan berkala tetap berjalan */ });
      watchers.push(w);
    } catch {
      /* folder log belum ada: pembacaan berkala tetap berjalan */
    }
  }
}

// Pengguna aplikasi Tessly (Windows) sudah punya riwayat yang lebih panjang dari log Claude Code; ikut dibawa.
function importDesktopHistory() {
  const appData = process.env.APPDATA;
  if (!appData) return;
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(appData, 'Tessly', 'history.json'), 'utf8'));
    if (Array.isArray(saved.rows)) history.merge(saved.rows);
  } catch {
    /* aplikasi Tessly tidak terpasang */
  }
}

// ---------- dashboard ----------
function openDashboard() {
  if (panel) {
    panel.reveal();
    return;
  }
  const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
  panel = vscode.window.createWebviewPanel('tessly.dashboard', 'Tessly', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [media],
  });
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'images', 'icon.png');
  panel.webview.html = dashboardHtml(panel.webview, media);
  panel.webview.onDidReceiveMessage(onMessage);
  panel.onDidDispose(() => { panel = null; });
}

function dashboardHtml(webview, media) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  const kind = vscode.window.activeColorTheme.kind;
  const boot = {
    prefs: prefs(),
    lang: lang(),
    theme: kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark',
    version: ctx.extension.packageJSON.version,
  };
  const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');
  let html = fs.readFileSync(path.join(media.fsPath, 'index.html'), 'utf8');
  html = html
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace('<link rel="stylesheet" href="style.css">', `<link rel="stylesheet" href="${uri('style.css')}">\n  <link rel="stylesheet" href="${uri('vscode.css')}">`)
    .replace(/<script src="([\w.]+)"><\/script>/g, (_, f) => `<script nonce="${nonce}" src="${uri(f)}"></script>`)
    .replace('<script nonce', `<script nonce="${nonce}" id="tessly-boot" type="application/json">${bootJson}</script>\n  <script nonce="${nonce}" src="${uri('vscode.js')}"></script>\n  <script nonce`);
  return html;
}

async function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const reply = (data) => panel && panel.webview.postMessage({ type: 'reply', id: msg.id, data });
  switch (msg.type) {
    case 'get-data':
      reply(snapshot());
      break;
    case 'get-settings':
      reply({
        autostart: false,
        hostname: os.hostname(),
        user: os.userInfo().username,
        version: ctx.extension.packageJSON.version,
        logFolders: scanner.roots,
      });
      break;
    case 'set-pref': {
      if (typeof msg.key !== 'string' || !msg.key.startsWith('tessly.')) return;
      const p = { ...prefs() };
      if (msg.value === null) delete p[msg.key];
      else p[msg.key] = String(msg.value);
      await ctx.globalState.update(PREFS_KEY, p);
      if (msg.key === 'tessly.lang') updateStatus();
      break;
    }
    default:
      break;
  }
}

// ---------- siklus hidup ----------
function activate(context) {
  ctx = context;
  scanner = new Scanner();
  history = new History(path.join(context.globalStorageUri.fsPath, 'history.json'));
  importDesktopHistory();

  status = vscode.window.createStatusBarItem('tessly.today', vscode.StatusBarAlignment.Right, 100);
  status.name = 'Tessly';
  status.command = 'tessly.open';
  updateStatus();
  applyStatusVisibility();

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand('tessly.open', openDashboard),
    vscode.commands.registerCommand('tessly.refresh', () => scan(true)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tessly.showStatusBar')) applyStatusVisibility();
    }),
    { dispose: () => watchers.forEach((w) => w.close()) },
  );

  watchLogs();
  scan(true);
  const timer = setInterval(() => scan(true), FULL_SCAN_MS);
  // lewat tengah malam angka "hari ini" kembali ke nol walau belum ada log baru
  const dayTimer = setInterval(updateStatus, 60_000);
  context.subscriptions.push({ dispose: () => { clearInterval(timer); clearInterval(dayTimer); } });
}

function deactivate() {
  if (history) history.save();
}

module.exports = { activate, deactivate };
