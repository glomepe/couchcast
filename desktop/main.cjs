// Couchcast — application macOS.
// Lance la passerelle (couchcast-server) en arrière-plan, l'affiche dans une fenêtre Chromium
// et ajoute ce qu'un navigateur ne peut pas offrir : icône dans la barre des menus,
// raccourcis globaux (clips/REC en pleine partie), notifications, anti-veille.
// Le serveur reste joignable sur http://localhost:8765 (OBS, téléphone).
const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, Notification, powerSaveBlocker, shell, clipboard, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}`;

// Raccourcis globaux (actifs même quand l'app n'est pas au premier plan).
const SHORTCUTS = {
  clip30: 'Control+Alt+C',
  clip120: 'Control+Alt+Shift+C',
  record: 'Control+Alt+R',
  show: 'Control+Alt+S',
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const resources = app.isPackaged
  ? { server: path.join(process.resourcesPath, 'bin', 'couchcast-server'), bridge: path.join(process.resourcesPath, 'bin', 'couchcast-bridge'), web: path.join(process.resourcesPath, 'web') }
  : (() => {
      const gw = path.join(__dirname, '..', 'gateway');
      return { server: path.join(gw, 'build', 'couchcast-server'), bridge: path.join(gw, 'build', 'bridge', 'couchcast-bridge'), web: path.join(gw, 'web', 'dist') };
    })();

let win = null;
let tray = null;
let server = null; // processus lancé par l'app (null si une passerelle tournait déjà)
let status = null;
let quitting = false;
let blockerId = null;
const knownJobs = new Map();

// --- Passerelle ----------------------------------------------------------------

async function fetchJSON(p, init) {
  const res = await fetch(BASE + p, { ...init, signal: AbortSignal.timeout(3000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

const post = (p, body) =>
  fetchJSON(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

async function serverUp() {
  try {
    await fetchJSON('/api/status');
    return true;
  } catch {
    return false;
  }
}

// Migration depuis l'ancien nom du projet (« LG Remote Screen ») : config et clips.
function migrateLegacy() {
  const home = os.homedir();
  const oldData = path.join(app.getPath('appData'), 'LG Remote Screen', 'config.json');
  const newData = path.join(app.getPath('userData'), 'config.json');
  if (fs.existsSync(oldData) && !fs.existsSync(newData)) {
    fs.mkdirSync(path.dirname(newData), { recursive: true });
    fs.copyFileSync(oldData, newData);
    fs.chmodSync(newData, 0o600);
  }
  const oldMedia = path.join(home, 'Movies', 'LG Remote Screen');
  const newMedia = path.join(home, 'Movies', 'Couchcast');
  const hasVideos = (dir) => fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.mp4'));
  if (hasVideos(oldMedia) && !hasVideos(newMedia)) {
    fs.rmSync(newMedia, { recursive: true, force: true }); // dossiers vides créés par une version récente
    fs.renameSync(oldMedia, newMedia);
  }
}

async function startServer() {
  if (await serverUp()) {
    console.log('Passerelle déjà active sur le port', PORT, ': on s\'y connecte.');
    return;
  }
  for (const [name, p] of Object.entries(resources)) {
    if (!fs.existsSync(p)) throw new Error(`${name} introuvable : ${p}\nCompilez d'abord la passerelle (gateway/build.sh).`);
  }
  migrateLegacy();
  const dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.openSync(path.join(dataDir, 'passerelle.log'), 'a');
  server = spawn(
    resources.server,
    ['-listen', `:${PORT}`, '-bridge', resources.bridge, '-web', resources.web, '-config', path.join(dataDir, 'config.json')],
    {
      // Lancée depuis le Finder, l'app n'a pas le PATH du terminal : ffmpeg vient de Homebrew.
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}` },
      stdio: ['ignore', log, log],
    },
  );
  server.on('exit', (code) => {
    server = null;
    if (!quitting) {
      dialog.showErrorBox('Couchcast', `La passerelle s'est arrêtée (code ${code}).\nJournal : ${path.join(dataDir, 'passerelle.log')}`);
      app.quit();
    }
  });
  for (let i = 0; i < 100; i++) {
    if (await serverUp()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('La passerelle ne répond pas (port 8765 occupé ?)');
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const proc = server;
    const timer = setTimeout(() => proc.kill('SIGKILL'), 6000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM'); // la passerelle ferme proprement la session Remote Play
  });
}

// --- Fenêtre -------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#08090b',
    title: 'Couchcast',
    webPreferences: {
      // Son actif sans clic préalable, et décodage non ralenti quand la fenêtre est en arrière-plan.
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });
  win.loadURL(`${BASE}/`);
  // Liens externes (connexion Sony…) dans le navigateur par défaut.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(BASE) && !url.startsWith(`http://localhost:${PORT}`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  // Fermer la fenêtre ne quitte pas l'app : elle reste dans la barre des menus.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
      if (process.platform === 'darwin') app.dock.hide();
    }
  });
}

// route : undefined = garder la page actuelle, '' = lecteur, sinon page (#/bibliotheque…).
function showWindow(route) {
  if (!win) createWindow();
  if (process.platform === 'darwin') app.dock.show();
  if (route !== undefined) win.loadURL(`${BASE}/#/${route}`);
  win.show();
  win.focus();
}

// --- Actions -------------------------------------------------------------------

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: true });
  if (onClick) n.on('click', onClick);
  n.show();
}

async function action(fn) {
  try {
    await fn();
  } catch (e) {
    notify('Couchcast', e.message);
  }
}

const clip = (seconds) => action(() => post('/api/clip', { seconds }));
const toggleRecord = () =>
  action(() => (status?.studio?.recording?.active ? post('/api/record/stop') : post('/api/record/start')));

// --- Barre des menus --------------------------------------------------------------

// Textes des menus et notifications, dans la langue choisie dans l'interface.
const TXT = {
  fr: {
    state: { unpaired: 'Non associée', idle: 'Prête', waking: 'Réveil…', connecting: 'Connexion…', pin: 'Code requis', streaming: 'En direct', error: 'Erreur' },
    starting: 'démarrage…',
    ping: (p) => `Ping ${p.avgMs.toFixed(1)} ms · gigue ${p.jitterMs.toFixed(1)} ms · perte ${p.lossPct.toFixed(0)} %`,
    stopSession: 'Arrêter la session',
    startSession: 'Démarrer la session',
    stopRec: (c) => `Arrêter l'enregistrement (${c})`,
    rec: 'Enregistrer',
    recToggle: 'Enregistrer / arrêter',
    clip30: 'Clip 30 s',
    clip120: 'Clip 2 min',
    clipMore: 'Clip…',
    buffered: (s) => `${s} s en mémoire`,
    replayOff: 'Replay désactivé',
    openWindow: 'Ouvrir la fenêtre',
    player: 'Lecteur',
    library: 'Bibliothèque',
    remote: 'Télécommande',
    openFolder: 'Ouvrir le dossier des clips',
    copyObs: 'Copier le lien OBS',
    copyRemote: 'Copier le lien télécommande (téléphone)',
    quit: 'Quitter',
    done: { clip: 'Clip sauvegardé', recording: 'Enregistrement sauvegardé', vertical: 'Version verticale prête' },
    failed: (l) => `${l} : échec`,
  },
  en: {
    state: { unpaired: 'Not paired', idle: 'Ready', waking: 'Waking…', connecting: 'Connecting…', pin: 'PIN required', streaming: 'Live', error: 'Error' },
    starting: 'starting…',
    ping: (p) => `Ping ${p.avgMs.toFixed(1)} ms · jitter ${p.jitterMs.toFixed(1)} ms · loss ${p.lossPct.toFixed(0)} %`,
    stopSession: 'Stop session',
    startSession: 'Start session',
    stopRec: (c) => `Stop recording (${c})`,
    rec: 'Record',
    recToggle: 'Record / stop',
    clip30: 'Clip 30 s',
    clip120: 'Clip 2 min',
    clipMore: 'Clip…',
    buffered: (s) => `${s} s buffered`,
    replayOff: 'Replay disabled',
    openWindow: 'Open window',
    player: 'Player',
    library: 'Library',
    remote: 'Remote',
    openFolder: 'Open clips folder',
    copyObs: 'Copy OBS link',
    copyRemote: 'Copy remote link (phone)',
    quit: 'Quit',
    done: { clip: 'Clip saved', recording: 'Recording saved', vertical: 'Vertical version ready' },
    failed: (l) => `${l}: failed`,
  },
};

function lang() {
  if (status?.lang === 'fr' || status?.lang === 'en') return status.lang;
  return app.getLocale().toLowerCase().startsWith('fr') ? 'fr' : 'en';
}
const L = () => TXT[lang()];

function trayIcon(recording) {
  const file = recording ? 'trayRec.png' : 'trayTemplate.png';
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', file));
  img.setTemplateImage(!recording);
  return img;
}

function clock(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function lanURL(route) {
  // Adresse privée la plus probable du réseau domestique (192.168.x, puis 10.x, puis 172.16-31.x).
  const addrs = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  const rank = (a) => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3);
  const ip = addrs.sort((a, b) => rank(a) - rank(b))[0];
  return `http://${ip || 'localhost'}:${PORT}/#/${route}`;
}

function updateTray() {
  if (!tray) return;
  const st = status;
  const rec = st?.studio?.recording;
  const streaming = st?.state === 'streaming';
  const replay = st?.studio?.settings?.replaySeconds || 0;
  const available = st?.studio?.replaySeconds || 0;
  const lives = (st?.studio?.live || []).filter((l) => l.state === 'live').length;
  const ping = st?.stats?.ping;

  tray.setImage(trayIcon(!!rec?.active));
  tray.setTitle(rec?.active ? ` ${clock((Date.now() - new Date(rec.startedAt)) / 1000)}` : lives ? ' LIVE' : '');
  const l = L();
  tray.setToolTip(`Couchcast — ${st ? l.state[st.state] || st.state : l.starting}`);

  const items = [
    { label: `${st?.console?.name || 'PS5'} · ${st ? l.state[st.state] || st.state : '…'}`, enabled: false },
    ...(ping?.samples ? [{ label: l.ping(ping), enabled: false }] : []),
    ...(st?.state === 'error' && st.error ? [{ label: st.error.slice(0, 80), enabled: false }] : []),
    { type: 'separator' },
    streaming || st?.state === 'connecting' || st?.state === 'waking'
      ? { label: l.stopSession, click: () => action(() => post('/api/stream/stop')) }
      : { label: l.startSession, enabled: st?.state === 'idle' || st?.state === 'error', click: () => action(() => post('/api/stream/start')) },
    { type: 'separator' },
    {
      label: rec?.active ? l.stopRec(clock((Date.now() - new Date(rec.startedAt)) / 1000)) : l.rec,
      accelerator: SHORTCUTS.record,
      enabled: streaming || !!rec?.active,
      click: toggleRecord,
    },
    { label: l.clip30, accelerator: SHORTCUTS.clip30, enabled: streaming && replay > 0 && available > 0, click: () => clip(30) },
    {
      label: l.clipMore,
      enabled: streaming && replay > 0 && available > 0,
      submenu: [15, 60, 120, 300].map((s) => ({
        label: s < 60 ? `${s} s` : `${s / 60} min`,
        accelerator: s === 120 ? SHORTCUTS.clip120 : undefined,
        enabled: s <= replay,
        click: () => clip(s),
      })),
    },
    { label: replay ? l.buffered(Math.floor(available)) : l.replayOff, enabled: false },
    { type: 'separator' },
    { label: l.openWindow, accelerator: SHORTCUTS.show, click: () => showWindow() },
    { label: l.library, click: () => showWindow('bibliotheque') },
    { label: l.openFolder, click: () => st?.studio?.mediaDir && shell.openPath(st.studio.mediaDir) },
    { type: 'separator' },
    { label: l.copyObs, click: () => clipboard.writeText(`http://localhost:${PORT}/#/obs`) },
    { label: l.copyRemote, click: () => clipboard.writeText(lanURL('telecommande')) },
    { type: 'separator' },
    { label: l.quit, accelerator: 'Command+Q', click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// --- Suivi de l'état -----------------------------------------------------------------

function onStatus(st) {
  status = st;
  if (lang() !== menuLang) buildAppMenu();

  // Notifications de fin de tâche (clip, enregistrement, export vertical).
  for (const job of st.studio?.jobs || []) {
    const prev = knownJobs.get(job.id);
    if (prev && prev !== job.state) {
      if (job.state === 'done') {
        const title = L().done[job.kind];
        notify(title, job.output, () => showWindow('bibliotheque'));
      } else if (job.state === 'error') {
        notify(L().failed(job.label), job.error);
      }
    }
    if (!prev && job.state === 'running' && knownJobs.size) notify('Couchcast', `${job.label}…`);
    knownJobs.set(job.id, job.state);
  }

  // Le Mac ne doit pas s'endormir pendant une session, un enregistrement ou un live.
  const busy =
    ['waking', 'connecting', 'pin', 'streaming'].includes(st.state) ||
    st.studio?.recording?.active ||
    (st.studio?.live || []).some((l) => l.state === 'live' || l.state === 'connecting');
  if (busy && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
  if (!busy && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
  updateTray();
}

async function pollStatus() {
  try {
    onStatus(await fetchJSON('/api/status'));
  } catch {
    /* passerelle momentanément indisponible */
  }
  setTimeout(pollStatus, 1000);
}

let menuLang = null;

// Menu de l'application (reconstruit si la langue change).
function buildAppMenu() {
  const l = L();
  menuLang = lang();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' }, // copier/coller dans les champs (clé de stream, URL Sony…)
      {
        label: 'Studio',
        submenu: [
          { label: l.clip30, accelerator: SHORTCUTS.clip30, click: () => clip(30) },
          { label: l.clip120, accelerator: SHORTCUTS.clip120, click: () => clip(120) },
          { label: l.recToggle, accelerator: SHORTCUTS.record, click: toggleRecord },
          { type: 'separator' },
          { label: l.player, click: () => showWindow('') },
          { label: l.library, click: () => showWindow('bibliotheque') },
          { label: l.remote, click: () => showWindow('telecommande') },
        ],
      },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

// --- Démarrage ------------------------------------------------------------------------

app.on('second-instance', () => showWindow());
app.on('activate', () => showWindow());
app.on('window-all-closed', () => {
  /* on reste dans la barre des menus */
});

app.on('before-quit', async (e) => {
  if (quitting) return;
  quitting = true;
  if (server) {
    e.preventDefault();
    globalShortcut.unregisterAll();
    await stopServer();
    app.quit();
  }
});

app.whenReady().then(async () => {
  app.setName('Couchcast');
  if (process.platform === 'darwin') app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));

  buildAppMenu();

  tray = new Tray(trayIcon(false));
  updateTray();

  try {
    await startServer();
  } catch (e) {
    dialog.showErrorBox('Couchcast', e.message);
    quitting = true;
    app.quit();
    return;
  }

  for (const [name, accel] of Object.entries(SHORTCUTS)) {
    const fn = { clip30: () => clip(30), clip120: () => clip(120), record: toggleRecord, show: () => showWindow() }[name];
    if (!globalShortcut.register(accel, fn)) console.warn(`Raccourci indisponible : ${accel}`);
  }

  createWindow();
  pollStatus();
});
