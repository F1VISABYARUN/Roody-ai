const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session, safeStorage } = require('electron');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Memory } = require('./lib/memory');
const { Brain } = require('./lib/brain');
const { activeWindow } = require('./lib/window-context');
const { Credentials } = require('./lib/credentials');

let win, memory, brain, followId = null, lastTitle = '', lastCheckin = 0, polling = false;
let allowedSources = new Set(), jobs = new Set(), reminderTimer;
let credentials, keySource = 'none', keyWarning = '';
const uiFile = path.join(__dirname, 'ui', 'index.html');
const trusted = event => event.sender === win.webContents && event.senderFrame.url === require('node:url').pathToFileURL(uiFile).href;
const register = (name, fn) => ipcMain.handle(name, async (event, value) => {
  if (!trusted(event)) throw new Error('Untrusted desktop request');
  return fn(value);
});
const notify = (event, data) => { if (win && !win.isDestroyed()) win.webContents.send(event, data); };
async function capture(id) {
  if (!allowedSources.has(id)) throw new Error('Select a window using Look at this first');
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1280, height: 800 } });
  const source = sources.find(s => s.id === id);
  if (!source || source.thumbnail.isEmpty()) throw new Error('Window unavailable. Select it again.');
  return { image: 'data:image/jpeg;base64,' + source.thumbnail.toJPEG(75).toString('base64'), title: source.name };
}
function validate(payload) {
  if (!payload || typeof payload.text !== 'string' || payload.text.length > 12000 || !payload.text.trim()) throw new Error('Enter a message (up to 12,000 characters)');
  return { text: payload.text, history: Array.isArray(payload.history) ? payload.history : [], image: payload.image, memory: memory.read() };
}
app.whenReady().then(() => {
  memory = new Memory(path.join(app.getPath('userData'), 'memory.json'));
  credentials = new Credentials({ file: path.join(app.getPath('userData'), 'openai-key.enc'), safeStorage });
  let savedKey = '';
  try { savedKey = credentials.getKey(); } catch { keyWarning = 'Could not unlock the saved key. Enter it again in Settings.'; }
  const initialKey = savedKey || process.env.OPENAI_API_KEY || '';
  keySource = savedKey ? 'saved' : initialKey ? 'environment' : 'none';
  brain = new Brain({ key: initialKey, model: process.env.ROODY_MODEL || 'gpt-4o', realtimeModel: process.env.ROODY_REALTIME_MODEL || 'gpt-realtime' });
  const keyStatus = () => ({ hasKey: !!brain.key, source: keySource, ...credentials.status(), warning: keyWarning });
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({ width: 100, height: 100, x: area.x + area.width - 116, y: area.y + area.height - 116,
    title: 'Roody', transparent: true, frame: false, resizable: false, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const audioOnly = !details.mediaTypes || details.mediaTypes.every(t => t === 'audio');
    callback(contents === win.webContents && permission === 'media' && audioOnly && contents.getURL() === require('node:url').pathToFileURL(uiFile).href);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  register('state', () => ({ memory: memory.read(), hasKey: !!brain.key, credential: keyStatus(), platform: process.platform, model: brain.model }));
  register('save-key', payload => {
    if (!payload || typeof payload.remember !== 'boolean') throw new Error('Choose whether to remember the key');
    credentials.setKey(payload.key, { remember: payload.remember });
    brain.key = credentials.getKey(); keySource = payload.remember ? 'saved' : 'session'; keyWarning = '';
    return keyStatus();
  });
  register('remove-key', () => {
    credentials.remove(); brain.key = process.env.OPENAI_API_KEY || '';
    keySource = brain.key ? 'environment' : 'none'; keyWarning = '';
    return keyStatus();
  });
  register('memory', action => memory.update(action));
  register('ask', payload => brain.ask(validate(payload)));
  register('voice', () => brain.voice(memory.read()));
  register('sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 320, height: 200 } });
    const list = sources.filter(s => s.name !== 'Roody' && !s.thumbnail.isEmpty());
    allowedSources = new Set(list.map(s => s.id));
    return list.map(s => ({ id: s.id, title: s.name, thumbnail: s.thumbnail.toDataURL() }));
  });
  register('capture', capture);
  register('follow', id => {
    if (id !== null && (!allowedSources.has(id) || process.platform !== 'win32')) throw new Error('Follow requires a selected window on Windows');
    followId = id; lastTitle = ''; lastCheckin = 0; return { following: !!id };
  });
  register('delegate', payload => {
    if (jobs.size >= 2) throw new Error('Two investigations are already running');
    const input = validate(payload); const id = randomUUID(); jobs.add(id);
    brain.ask({ ...input, delegated: true }).then(text => notify('job', { id, text }), error => notify('job', { id, error: error.message })).finally(() => jobs.delete(id));
    return { id };
  });
  register('reminder', minutes => {
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) throw new Error('Choose 1–1440 minutes');
    clearTimeout(reminderTimer);
    reminderTimer = setTimeout(() => notify('reminder', { goal: memory.read().goal }), minutes * 60000);
    return { minutes };
  });
  register('expand', open => {
    const bounds = win.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
    const width = open ? Math.min(420, area.width) : 100;
    const height = open ? Math.min(740, area.height) : 100;
    win.setBounds({ x: Math.max(area.x, Math.min(bounds.x + bounds.width - width, area.x + area.width - width)), y: Math.max(area.y, Math.min(bounds.y + bounds.height - height, area.y + area.height - height)), width, height });
  });
  register('quit', () => app.quit());
  const timer = setInterval(async () => {
    if (!followId || polling) return;
    polling = true;
    try {
      const current = await activeWindow();
      const expectedHandle = followId.split(':')[1];
      if (current && current.id === expectedHandle && current.title !== lastTitle && Date.now() - lastCheckin >= 60000) {
        lastTitle = current.title; lastCheckin = Date.now();
        const selected = followId;
        const context = await capture(selected);
        if (followId === selected) notify('context', context);
      }
    } catch (error) { followId = null; notify('context-error', error.message); }
    finally { polling = false; }
  }, 5000);
  timer.unref();
  win.on('closed', () => { clearInterval(timer); clearTimeout(reminderTimer); });
  win.loadFile(uiFile);
}).catch(error => { console.error(error.message); app.quit(); });
app.on('window-all-closed', () => app.quit());
