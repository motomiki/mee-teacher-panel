// main.js  (ESM)
import { app, BrowserWindow, shell } from 'electron';
import express from 'express';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

/* =========================
   サーバ状態（インメモリ管理）
   ========================= */
let meeSocket = null;

// 参加者名簿: name -> { name, lastSeen: Date.now(), pos:{x,y,z,rot?} }
const players = new Map();
// チャットログ: 最大100件を保持
const chatLog = [];
// ポーズ状態（維持用フラグ）
let pauseOn = false;
// Tick同期: 20tickごとに効果を再適用
let tickCounter = 0;
const REAPPLY_TICKS = 20;
const PAUSE_EFFECT_SECONDS = 900;

const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);



// SSEクライアント一覧
const sseClients = new Set();
const suppressedChatMessages = new Map();
const SUPPRESS_CHAT_MS = 4000;

function suppressChatMessage(message) {
  if (!message) return;
  suppressedChatMessages.set(message, Date.now() + SUPPRESS_CHAT_MS);
}

function shouldSuppressChatMessage(message) {
  if (!message) return false;
  const expiry = suppressedChatMessages.get(message);
  if (expiry == null) return false;
  if (Date.now() > expiry) {
    suppressedChatMessages.delete(message);
    return false;
  }
  return true;
}

/* =========================
   HTTP (UI/API) with Express
   ========================= */
const httpApp = express();
httpApp.use(express.json());

// --- SSE: ブラウザへ状態をプッシュ ---
httpApp.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  sseClients.add(res);
  pushState();
  req.on('close', () => sseClients.delete(res));
});

function pushState() {
  const roster = [...players.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(p => ({ name: p.name, lastSeen: p.lastSeen, pos: p.pos || null }));
  const payload = {
    type: 'state',
    roster,
    chat: chatLog,
    pauseOn,
    meeConnected: !!meeSocket
  };
  const data = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of sseClients) c.write(data);
}

function pushChat(entry) {
  const data = `event: chat\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const c of sseClients) c.write(data);
}

function normalizeChatMessage(playerName, message) {
  if (typeof message !== 'string') {
    if (message == null) return '';
    return String(message);
  }
  let result = message.trimStart();
  const name = (playerName ?? '').toString().trim();
  if (!name) return result;
  const lowerName = name.toLowerCase();

  const stripBracket = (open, close) => {
    if (!result.startsWith(open)) return false;
    const closeIdx = result.indexOf(close, open.length);
    if (closeIdx === -1) return false;
    const inner = result.slice(open.length, closeIdx).trim();
    if (!inner) return false;
    if (inner.toLowerCase() !== lowerName) return false;
    result = result.slice(closeIdx + close.length).trimStart();
    return true;
  };

  if (stripBracket('[', ']')) return result;
  if (stripBracket('<', '>')) return result;

  const stripPrefix = (prefix) => {
    if (!prefix) return false;
    if (result.length < prefix.length) return false;
    if (result.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return false;
    result = result.slice(prefix.length).trimStart();
    return true;
  };

  if (stripPrefix(`${name}:`)) return result;
  if (stripPrefix(`${name}：`)) return result;
  if (stripPrefix(`${name}>`)) return result;
  if (stripPrefix(`${name}＞`)) return result;
  if (stripPrefix(`${name}]`)) return result;
  if (stripPrefix(`${name}》`)) return result;

  return result;
}

// --- 最小UI: 単一HTMLを返すエンドポイント ---
// --- UI 配信 ---
httpApp.use(express.static(path.join(__dirname, 'public')));
httpApp.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Minecraft Education へコマンド送信 ---
function sendCommand(cmd) {
  if (!meeSocket) return false;
  const payload = {
    header: {
      version: 1,
      requestId: uuidv4(),
      messagePurpose: "commandRequest",
      messageType: "commandRequest"
    },
    body: { version: 1, commandLine: cmd }
  };
  meeSocket.send(JSON.stringify(payload));
  return true;
}

// --- API: PAUSE/RESUME/ALLOW/CHAT ---
httpApp.post('/api/pause_on', (_req, res) => {
  pauseOn = true;
  suppressChatMessage('ストップ');
  suppressChatMessage('話を聞く時間だよ');
  // 全員を停止対象に戻す
  sendCommand('tag @a remove canMove');
  // 効果を再適用
  sendCommand(`effect @a[tag=!canMove] slowness ${PAUSE_EFFECT_SECONDS} 255`);
  sendCommand(`effect @a[tag=!canMove] mining_fatigue ${PAUSE_EFFECT_SECONDS} 255`);
  sendCommand('gamemode adventure @a[tag=!canMove]');
  sendCommand('title @a title ストップ');
  sendCommand('title @a subtitle 話を聞く時間だよ');
  sendCommand('title @a times 10 6000 20');
  pushState();
  res.json({ ok: true });
});
httpApp.post('/api/pause_off', (_req, res) => {
  pauseOn = false;
  sendCommand('effect @a clear');
  sendCommand('title @a clear');
  sendCommand('gamemode creative @a');
  pushState();
  res.json({ ok: true });
});
httpApp.post('/api/allow_name', (req, res) => {
  const name = req.body?.name;
  if (!name) return res.status(400).json({ error: 'name required' });
  sendCommand(`tag "${name}" add canMove`);
  sendCommand(`effect "${name}" clear`);
  sendCommand(`gamemode creative "${name}"`);
  sendCommand(`title "${name}" clear`);
  res.json({ ok: true });
});

httpApp.post('/api/gather', (_req, res) => {
  sendCommand('tp @a @s');
  res.json({ ok: true });
});

httpApp.post('/api/gather_name', (req, res) => {
  const name = req.body?.name;
  if (!name) return res.status(400).json({ error: 'name required' });
  sendCommand(`tp "${name}" @s`);
  res.json({ ok: true });
});

httpApp.post('/api/review_items', (_req, res) => {
  sendCommand('give @a writable_book 1');
  res.json({ ok: true });
});

httpApp.post('/api/camera_items', (_req, res) => {
  sendCommand('give @a camera 1');
  sendCommand('give @a portfolio 1');
  res.json({ ok: true });
});

httpApp.post('/api/kill_mob_r50', (_req, res) => {
  sendCommand('kill @e[type=!player,type=!item,r=50]');
  res.json({ ok: true });
});

httpApp.post('/api/mayfly', (req, res) => {
  const enable = !!req.body?.enable;
  sendCommand(`ability @s mayfly ${enable ? 'true' : 'false'}`);
  res.json({ ok: true });
});

httpApp.post('/api/chat_send', (req, res) => {
  const msg = (req.body?.message || '').toString();
  if (!msg) return res.status(400).json({ error: 'message required' });
  // Forward the chat to Minecraft; we rely on the PlayerMessage event to update the log.
  sendCommand(`say ${msg.replace(/"/g, '\"')}`);
  res.json({ ok: true });
});

// HTTPサーバ起動
const HTTP_PORT = 3000;
httpApp.listen(HTTP_PORT, () => console.log(`UI http://localhost:${HTTP_PORT}`));

/* =========================
   WebSocket接続（MEE から /connect）
   ========================= */
const WS_PORT = 8080;
const wss = new WebSocketServer({ port: WS_PORT });
wss.on('connection', (ws) => {
  meeSocket = ws;
  console.log('Minecraft Education connected');
  pushState();

  // 主要イベントを購読
  subscribe('PlayerJoined');
  subscribe('PlayerSpawned');
  subscribe('PlayerLeft');
  subscribe('PlayerRemoved');
  subscribe('PlayerMessage');
  subscribe('PlayerTransform');
  subscribe('PlayerTravelled');
  subscribe('PlayerMoved');
  subscribe('Tick');

  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.header?.messagePurpose === 'event') {
      handleEvent(msg);
    }
  });

  ws.on('close', () => {
    meeSocket = null;
    console.log('Minecraft disconnected');
    pushState();
  });
});

function subscribe(eventName) {
  if (!meeSocket) return;
  const payload = {
    header: {
      version: 1,
      requestId: uuidv4(),
      messagePurpose: 'subscribe',
      messageType: 'commandRequest'
    },
    body: { eventName }
  };
  meeSocket.send(JSON.stringify(payload));
}

function handleEvent(ev) {
  const eventName = ev.header?.eventName || ev.body?.eventName;
  if (!eventName) return;
  switch (eventName) {
    case 'PlayerJoined':
    case 'PlayerSpawned': {
      const n = findPlayerName(ev);
      if (n) {
        const rec = players.get(n) || { name: n, lastSeen: Date.now(), pos: null };
        rec.lastSeen = Date.now();
        players.set(n, rec);
        pushState();
      }
      break;
    }
    case 'PlayerLeft':
    case 'PlayerRemoved': {
      const n = findPlayerName(ev);
      if (n && players.delete(n)) pushState();
      break;
    }
    case 'PlayerMessage': {
      const n = findPlayerName(ev) || 'Unknown';
      const m = findChatMessage(ev);
      if (!m) break;
      const cleanedMessage = normalizeChatMessage(n, m);
      if (shouldSuppressChatMessage(cleanedMessage)) break;
      const entry = { id: uuidv4(), t: Date.now(), player: n, message: cleanedMessage };
      chatLog.push(entry);
      if (chatLog.length > 100) chatLog.shift();
      let rosterTouched = false;
      const rec = players.get(n);
      if (rec) {
        rec.lastSeen = Date.now();
        rosterTouched = true;
      } else if (n !== 'Unknown') {
        players.set(n, { name: n, lastSeen: Date.now(), pos: null });
        rosterTouched = true;
      }
      if (rosterTouched) pushState();
      pushChat(entry);
      break;
    }
    case 'PlayerTransform':
    case 'PlayerTravelled':
    case 'PlayerMoved': {
      const n = findPlayerName(ev);
      if (!n) break;
      const px = pickNum(ev.body, ['X', 'PosX', 'x']);
      const py = pickNum(ev.body, ['Y', 'PosY', 'y']);
      const pz = pickNum(ev.body, ['Z', 'PosZ', 'z']);
      if (!Number.isFinite(px) || !Number.isFinite(pz)) break;
      const rec = players.get(n) || { name: n, lastSeen: Date.now(), pos: null };
      rec.lastSeen = Date.now();
      rec.pos = { x: px, y: Number.isFinite(py) ? py : null, z: pz };
      players.set(n, rec);
      pushState();
      break;
    }
    case 'Tick': {
      if (pauseOn) {
        tickCounter++;
        if (tickCounter >= REAPPLY_TICKS) {
          tickCounter = 0;
          // 維持用の効果を再適用
          sendCommand(`effect @a[tag=!canMove] slowness ${PAUSE_EFFECT_SECONDS} 255`);
          sendCommand(`effect @a[tag=!canMove] mining_fatigue ${PAUSE_EFFECT_SECONDS} 255`);
          sendCommand('gamemode adventure @a[tag=!canMove]');
        }
      }
      break;
    }
    default:
      // 未使用イベントは無視
      break;
  }
}
const NAME_KEYS = ['PlayerName', 'playerName', 'Name', 'name', 'Username', 'username', 'Sender', 'sender', 'Owner', 'owner', 'TargetName', 'targetName', 'SourceName', 'sourceName'];
const MESSAGE_KEYS = ['Message', 'message', 'Text', 'text', 'BodyText', 'bodyText', 'DisplayText', 'displayText'];
function findPlayerName(ev) {
  return findStringByKeys(ev?.body, NAME_KEYS);
}
function findChatMessage(ev) {
  return findStringByKeys(ev?.body, MESSAGE_KEYS);
}
function findStringByKeys(obj, keys, depth = 0, seen = new WeakSet()) {
  if (!obj || depth > 6) return '';
  if (typeof obj === 'string') return '';
  if (typeof obj !== 'object') return '';
  if (seen.has(obj)) return '';
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const res = findStringByKeys(item, keys, depth + 1, seen);
      if (res) return res;
    }
    return '';
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  for (const value of Object.values(obj)) {
    if (typeof value === 'string') continue;
    const res = findStringByKeys(value, keys, depth + 1, seen);
    if (res) return res;
  }
  return '';
}
function axisFromKeys(keys) {
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (lower === 'x' || lower.endsWith('x') || lower.includes('posx') || lower.includes('coordx')) return 'x';
    if (lower === 'y' || lower.endsWith('y') || lower.includes('posy') || lower.includes('coordy')) return 'y';
    if (lower === 'z' || lower.endsWith('z') || lower.includes('posz') || lower.includes('coordz')) return 'z';
  }
  return null;
}
function pickNum(obj, keys, depth = 0, seen = new WeakSet()) {
  if (obj == null || depth > 6) return NaN;
  if (typeof obj === 'number') return obj;
  if (typeof obj === 'string') {
    if (obj.trim() === '') return NaN;
    const n = Number(obj);
    return Number.isFinite(n) ? n : NaN;
  }
  if (typeof obj !== 'object') return NaN;
  if (seen.has(obj)) return NaN;
  seen.add(obj);
  if (Array.isArray(obj)) {
    const axis = axisFromKeys(keys);
    if (axis !== null) {
      const idx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      if (idx < obj.length) {
        const direct = pickNum(obj[idx], keys, depth + 1, seen);
        if (Number.isFinite(direct)) return direct;
      }
    }
    for (const item of obj) {
      const n = pickNum(item, keys, depth + 1, seen);
      if (Number.isFinite(n)) return n;
    }
    return NaN;
  }
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  const nestedKeys = ['Position', 'position', 'Pos', 'pos', 'Coordinates', 'coordinates', 'Transform', 'transform', 'Location', 'location', 'Player', 'player', 'Entity', 'entity', 'Target', 'target', 'Origin', 'origin', 'Properties', 'properties', 'Data', 'data', 'Body', 'body', 'Actor', 'actor'];
  for (const nk of nestedKeys) {
    if (!Object.prototype.hasOwnProperty.call(obj, nk)) continue;
    const nested = obj[nk];
    const n = pickNum(nested, keys, depth + 1, seen);
    if (Number.isFinite(n)) return n;
  }
  for (const value of Object.values(obj)) {
    if (typeof value !== 'object') continue;
    const n = pickNum(value, keys, depth + 1, seen);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}
/* =========================
   Electron ウィンドウ生成
   ========================= */
function createWindow() {
  const win = new BrowserWindow({
    width: 900, height: 680,
    webPreferences: { sandbox: true }
  });
  win.loadURL(`http://localhost:${HTTP_PORT}/`);
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url); return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });


