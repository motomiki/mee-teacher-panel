// main.js  (ESM)
import { app, BrowserWindow, shell, dialog } from 'electron';
import express from 'express';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { listWorlds, worldsDir, readLevelInfo, renderWorldMap, renderWorldMapAuto } from './worldmap.js';

// 二重起動するとポート 3000/8080 が衝突するため、2 つ目は既存ウィンドウを前面に出して即終了する
// （app.quit() は非同期で、この後のサーバー起動コードまで走ってしまうので process.exit を使う）
if (!app.requestSingleInstanceLock()) {
  process.exit(0);
}

// ポートが他のアプリに使われている場合は、未処理例外ではなく分かりやすいメッセージを出して終了する
function handleListenError(err, port) {
  const msg = err.code === 'EADDRINUSE'
    ? `ポート ${port} が他のアプリで使用中のため起動できません。\nそのアプリを終了してから、もう一度起動してください。`
    : `ポート ${port} で待ち受けを開始できませんでした。\n${err.message}`;
  console.error(`[listen] port ${port}`, err);
  dialog.showErrorBox('MEE Teacher Panel を起動できません', msg);
  app.exit(1);
}

/* =========================
   サーバ状態（インメモリ管理）
   ========================= */
let meeSocket = null;

// 参加者名簿: name -> { name, lastSeen: Date.now(), pos:{x,y,z,yaw,dim,t} }
const players = new Map();
// 位置が更新されたプレイヤー名（一定間隔でまとめて送信する）
const dirtyPositions = new Set();
const POS_FLUSH_MS = 100;
// 教員（/connect したプレイヤー）の名前
let teacherName = '';
// チャットログ: 最大100件を保持
const chatLog = [];
// ポーズ状態（維持用フラグ）
let pauseOn = false;
// ポーズ維持: 一定間隔で停止を再適用（入室・リスポーンした生徒も止める）
let pauseTimer = null;
const PAUSE_REAPPLY_MS = 5000;
const PAUSE_EFFECT_SECONDS = 900;
// 停止方式: inputpermission が使えなければ effect に切り替える（接続ごとに判定）
let freezeMode = 'inputpermission';
const PAUSE_ACTIONBAR = '⏸ 停止中 — 先生の話を聞こう';
// 先生の飛行能力（画面を開き直しても表示が合うようサーバーで持つ。能力はワールド側に残るので切断ではリセットしない）
let mayflyOn = false;

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
// 背景画像（base64）を受け取るため上限を引き上げる
httpApp.use(express.json({ limit: '30mb' }));

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
    mayflyOn,
    meeConnected: !!meeSocket,
    teacher: teacherName
  };
  const data = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of sseClients) c.write(data);
}

// 位置更新は state を送らず、変化したプレイヤー分だけを pos イベントでまとめて送る
function flushPositions() {
  if (!dirtyPositions.size) return;
  const list = [];
  for (const name of dirtyPositions) {
    const rec = players.get(name);
    if (rec?.pos) list.push({ name, ...rec.pos });
  }
  dirtyPositions.clear();
  if (!list.length || !sseClients.size) return;
  const data = `event: pos\ndata: ${JSON.stringify({ t: Date.now(), players: list })}\n\n`;
  for (const c of sseClients) c.write(data);
}
setInterval(flushPositions, POS_FLUSH_MS);
function pushChat(entry) {
  const data = `event: chat\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const c of sseClients) c.write(data);
}

/* =========================
   UI 配信
   ========================= */
httpApp.use(express.static(path.join(__dirname, 'public')));
httpApp.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// 画面に出すバージョン（package.json の version）
httpApp.get('/api/version', (_req, res) => {
  res.json({ version: app.getVersion() });
});

/* =========================
   Minecraft Education へコマンド送信
   ========================= */
// requestId -> { fn: 応答（commandResponse / error の body）を受け取る関数, t: 送信時刻 }
const pendingRequests = new Map();
// 応答待ちがこれ以上溜まったらポーリングを見送る（MEE は未処理コマンド数に上限がある）
const MAX_PENDING = 150;
// これ以上応答が無い要求は捨てる
const PENDING_TIMEOUT_MS = 30000;

// 成功時は requestId（truthy）を返す。onResponse を省略すると送信内容と応答をログに出す
// plain: true のときは暗号化の準備を待たずに平文で送る（enableencryption 用）
function sendCommand(cmd, onResponse, { plain = false } = {}) {
  if (!meeSocket) return false;
  const requestId = uuidv4();
  const fn = onResponse || ((body) => {
    console.log('[cmd応答]', cmd, '→', body?.statusCode, body?.statusMessage ?? '');
  });
  if (!onResponse) console.log('[cmd]', cmd);
  pendingRequests.set(requestId, { fn, t: Date.now() });
  const payload = {
    header: {
      version: 1,
      requestId,
      messagePurpose: 'commandRequest',
      messageType: 'commandRequest',
    },
    body: { version: 1, commandLine: cmd }
  };
  if (plain) meeSocket.send(JSON.stringify(payload));
  else wsSend(payload);
  return requestId;
}

// コマンド内でプレイヤー名を使うときの引用（名前に " や \ が含まれても壊れないようにする）
function quoteName(name) {
  return `"${String(name).replace(/[\\"]/g, '\\$&')}"`;
}

/* =========================
   WebSocket の暗号化（MEE が「暗号化されたセッション」を必須にしている場合に必要）
   enableencryption で ECDH(secp384r1) の鍵交換をし、以後は AES-256-CFB8 で送受信する
   ========================= */
// 接続ごとの状態。state: 'handshake'（鍵交換中。送信はキューに積む）/ 'encrypted' / 'plain'
let meeLink = null;
const HANDSHAKE_TIMEOUT_MS = 10000;

// AES-256-CFB8 のストリーム。Electron の暗号ライブラリ（BoringSSL）は aes-256-cfb8 を持たないため、
// AES-256-ECB で1バイトずつ組み立てる。暗号化・復号とも「暗号文の1バイト」でレジスタを進める
function createCfb8(key, iv, decrypt) {
  const ecb = crypto.createCipheriv('aes-256-ecb', key, null);
  ecb.setAutoPadding(false);
  const reg = Buffer.from(iv);
  return {
    update(input) {
      const out = Buffer.alloc(input.length);
      for (let i = 0; i < input.length; i++) {
        const k = ecb.update(reg)[0];
        out[i] = input[i] ^ k;
        reg.copy(reg, 0, 1);
        reg[15] = decrypt ? input[i] : out[i];
      }
      return out;
    }
  };
}

function wsSend(payload) {
  if (!meeSocket || !meeLink) return;
  const text = JSON.stringify(payload);
  if (meeLink.state === 'handshake') {
    meeLink.queue.push(text);
    return;
  }
  meeSocket.send(meeLink.cipher ? meeLink.cipher.update(Buffer.from(text, 'utf8')) : text);
}

function startEncryption() {
  const link = meeLink;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const salt = crypto.randomBytes(16);
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  let done = false;
  const finish = (gamePubB64, reason) => {
    if (done || link !== meeLink) return;
    done = true;
    clearTimeout(timer);
    if (gamePubB64) {
      try {
        const gamePub = crypto.createPublicKey({ key: Buffer.from(gamePubB64, 'base64'), format: 'der', type: 'spki' });
        const secret = crypto.diffieHellman({ privateKey, publicKey: gamePub });
        const key = crypto.createHash('sha256').update(salt).update(secret).digest();
        const iv = key.subarray(0, 16);
        link.cipher = createCfb8(key, iv, false);
        link.decipher = createCfb8(key, iv, true);
      } catch (err) {
        reason = `鍵の計算に失敗: ${err.message}`;
      }
    }
    if (link.cipher) {
      link.state = 'encrypted';
      console.log('[暗号化] 有効になりました');
    } else {
      link.state = 'plain';
      console.log('[暗号化] ハンドシェイク失敗。平文のまま続けます:', reason);
    }
    for (const text of link.queue) {
      meeSocket.send(link.cipher ? link.cipher.update(Buffer.from(text, 'utf8')) : text);
    }
    link.queue = [];
  };
  const timer = setTimeout(() => finish(null, '応答がありません'), HANDSHAKE_TIMEOUT_MS);

  sendCommand(`enableencryption "${pubB64}" "${salt.toString('base64')}"`, (body) => {
    if (typeof body?.publicKey === 'string' && body.publicKey) finish(body.publicKey);
    else finish(null, `${body?.statusCode ?? ''} ${body?.statusMessage ?? ''}`.trim());
  }, { plain: true });
}

/* =========================
   PAUSE: 停止の適用・解除
   ========================= */
const PAUSE_TARGET = '@a[tag=!canMove]';

function applyEffectFreeze(sel) {
  // 末尾の true でパーティクルを隠す
  sendCommand(`effect ${sel} slowness ${PAUSE_EFFECT_SECONDS} 255 true`);
  sendCommand(`effect ${sel} mining_fatigue ${PAUSE_EFFECT_SECONDS} 255 true`);
}

function applyFreeze(sel) {
  if (freezeMode === 'inputpermission') {
    // 移動と視点操作を止める。失敗したら effect 方式に切り替える
    sendCommand(`inputpermission set ${sel} movement disabled`, (body) => {
      if (body?.statusCode === 0) return;
      if (freezeMode !== 'inputpermission') return;
      console.log('[pause] inputpermission が使えないため effect 方式に切り替えます', body?.statusCode, body?.statusMessage ?? '');
      freezeMode = 'effect';
      applyEffectFreeze(sel);
    });
    sendCommand(`inputpermission set ${sel} camera disabled`);
  } else {
    applyEffectFreeze(sel);
  }
  sendCommand(`gamemode adventure ${sel}`);
}

function releaseFreeze(sel) {
  if (freezeMode === 'inputpermission') {
    sendCommand(`inputpermission set ${sel} movement enabled`);
    sendCommand(`inputpermission set ${sel} camera enabled`);
  }
  sendCommand(`effect ${sel} clear`);
  sendCommand(`gamemode creative ${sel}`);
  sendCommand(`title ${sel} clear`);
}

function showPauseTitle(sel) {
  // times は title より先に送らないと反映されない
  sendCommand(`title ${sel} times 10 6000 20`);
  sendCommand(`title ${sel} subtitle 話を聞く時間だよ`);
  sendCommand(`title ${sel} title ストップ`);
}

function startPauseTimer() {
  stopPauseTimer();
  pauseTimer = setInterval(() => {
    if (!pauseOn || !meeSocket) return;
    applyFreeze(PAUSE_TARGET);
    sendCommand(`title ${PAUSE_TARGET} actionbar ${PAUSE_ACTIONBAR}`);
  }, PAUSE_REAPPLY_MS);
}

function stopPauseTimer() {
  if (pauseTimer) clearInterval(pauseTimer);
  pauseTimer = null;
}

/* =========================
   API: PAUSE/RESUME/ALLOW/CHAT/他
   ========================= */
// MEE 未接続のときは送れないので失敗を返す（画面側で「送信エラー」になる）
function requireMee(_req, res, next) {
  if (!meeSocket) return res.status(503).json({ error: 'MEE 未接続' });
  next();
}

// モブ削除で残すエンティティ（授業で置いた NPC・エージェント・カメラや、置物・乗り物）
const KILL_EXCLUDE_TYPES = [
  'player', 'item', 'npc', 'agent', 'tripod_camera', 'armor_stand',
  'painting', 'minecart', 'boat', 'chest_boat', 'leash_knot'
];

httpApp.post('/api/pause_on', requireMee, (_req, res) => {
  pauseOn = true;
  suppressChatMessage('ストップ');
  suppressChatMessage('話を聞く時間だよ');
  // 全員を停止対象に戻し、先生（接続元 @s）だけ除外する
  sendCommand('tag @a remove canMove');
  sendCommand('tag @s add canMove');
  applyFreeze(PAUSE_TARGET);
  showPauseTitle(PAUSE_TARGET);
  startPauseTimer();
  pushState();
  res.json({ ok: true });
});
httpApp.post('/api/pause_off', (req, res, next) => {
  // 未接続でもパネル側の停止状態は解除する（再接続時に停止が復活しないように）
  pauseOn = false;
  stopPauseTimer();
  pushState();
  requireMee(req, res, () => {
    releaseFreeze('@a');
    res.json({ ok: true });
  });
});
httpApp.post('/api/allow_name', requireMee, (req, res) => {
  const name = req.body?.name;
  if (!name) return res.status(400).json({ error: 'name required' });
  sendCommand(`tag ${quoteName(name)} add canMove`);
  releaseFreeze(quoteName(name));
  res.json({ ok: true });
});

httpApp.post('/api/gather', requireMee, (_req, res) => {
  sendCommand('tp @a @s');
  res.json({ ok: true });
});
httpApp.post('/api/gather_name', requireMee, (req, res) => {
  const name = req.body?.name;
  if (!name) return res.status(400).json({ error: 'name required' });
  sendCommand(`tp ${quoteName(name)} @s`);
  res.json({ ok: true });
});

httpApp.post('/api/review_items', requireMee, (_req, res) => {
  sendCommand('give @a writable_book 1');
  res.json({ ok: true });
});
httpApp.post('/api/camera_items', requireMee, (_req, res) => {
  sendCommand('give @a camera 1');
  sendCommand('give @a portfolio 1');
  res.json({ ok: true });
});

httpApp.post('/api/kill_mob_r50', requireMee, (_req, res) => {
  const exclude = KILL_EXCLUDE_TYPES.map(t => `type=!${t}`).join(',');
  sendCommand(`kill @e[${exclude},r=50]`);
  res.json({ ok: true });
});

httpApp.post('/api/mayfly', requireMee, (req, res) => {
  const enable = !!req.body?.enable;
  sendCommand(`ability @s mayfly ${enable ? 'true' : 'false'}`);
  mayflyOn = enable;
  pushState();
  res.json({ ok: true });
});

httpApp.post('/api/chat_send', requireMee, (req, res) => {
  // say は残りをそのまま表示するので引用符のエスケープは不要。改行だけ空白にする
  const msg = (req.body?.message || '').toString().replace(/[\r\n]+/g, ' ').trim();
  if (!msg) return res.status(400).json({ error: 'message required' });
  sendCommand(`say ${msg}`);
  res.json({ ok: true });
});

httpApp.post('/api/clear_fluids_r16_self', requireMee, (_req, res) => {
  // 水源だけでなく流れている水・溶岩も消す
  for (const block of ['water', 'flowing_water', 'lava', 'flowing_lava']) {
    sendCommand(`fill ~-15 ~-15 ~-15 ~15 ~15 ~15 air replace ${block}`);
  }
  res.json({ ok: true });
});

/* =========================
   API: マップ背景プリセット
   保存先: userData/map-presets/{presets.json, <id>.<ext>}
   ========================= */
const PRESET_IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const PRESET_ID_RE = /^[0-9a-f-]{36}$/;

function presetDir() {
  return path.join(app.getPath('userData'), 'map-presets');
}
async function loadPresetStore() {
  try {
    const raw = await fs.readFile(path.join(presetDir(), 'presets.json'), 'utf8');
    const store = JSON.parse(raw);
    return {
      selectedId: typeof store.selectedId === 'string' ? store.selectedId : null,
      presets: Array.isArray(store.presets) ? store.presets : []
    };
  } catch {
    return { selectedId: null, presets: [] };
  }
}
async function savePresetStore(store) {
  await fs.mkdir(presetDir(), { recursive: true });
  await fs.writeFile(path.join(presetDir(), 'presets.json'), JSON.stringify(store, null, 2), 'utf8');
}
function sanitizeCalib(calib) {
  const pt = (p) => {
    const v = { px: Number(p?.px), py: Number(p?.py), x: Number(p?.x), z: Number(p?.z) };
    return Object.values(v).every(Number.isFinite) ? v : null;
  };
  const a = pt(calib?.a);
  const b = pt(calib?.b);
  if (!a || !b) return null;
  if (a.px === b.px && a.py === b.py) return null;
  if (a.x === b.x && a.z === b.z) return null;
  return { a, b };
}
function clampOpacity(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

httpApp.get('/api/map_presets', async (_req, res) => {
  res.json(await loadPresetStore());
});

httpApp.get('/api/map_presets/:id/image', async (req, res) => {
  const store = await loadPresetStore();
  const preset = store.presets.find(p => p.id === req.params.id);
  if (!preset) return res.status(404).end();
  res.sendFile(path.join(presetDir(), preset.file));
});

// 新規作成（image 必須）または既存の更新（id 指定・image 省略可）
httpApp.post('/api/map_presets', async (req, res) => {
  const body = req.body || {};
  const store = await loadPresetStore();
  const existing = body.id ? store.presets.find(p => p.id === body.id) : null;
  if (body.id && !existing) return res.status(404).json({ error: 'preset not found' });

  const preset = existing || { id: uuidv4() };
  if (body.name !== undefined || !existing) {
    preset.name = (body.name || '').toString().trim().slice(0, 60) || '無題の背景';
  }
  if (body.calib !== undefined || !existing) {
    const calib = sanitizeCalib(body.calib);
    if (!calib) return res.status(400).json({ error: 'invalid calib' });
    preset.calib = calib;
  }
  if (body.opacity !== undefined || !existing) preset.opacity = clampOpacity(body.opacity ?? 1);

  if (body.image) {
    const m = /^data:([^;]+);base64,(.+)$/s.exec(body.image.toString());
    const ext = m && PRESET_IMAGE_TYPES[m[1]];
    if (!ext) return res.status(400).json({ error: 'unsupported image' });
    await fs.mkdir(presetDir(), { recursive: true });
    const file = `${preset.id}.${ext}`;
    await fs.writeFile(path.join(presetDir(), file), Buffer.from(m[2], 'base64'));
    if (preset.file && preset.file !== file) {
      await fs.rm(path.join(presetDir(), preset.file), { force: true });
    }
    preset.file = file;
  } else if (!existing) {
    return res.status(400).json({ error: 'image required' });
  }

  if (!existing) store.presets.push(preset);
  if (body.select) store.selectedId = preset.id;
  await savePresetStore(store);
  res.json({ ok: true, preset, selectedId: store.selectedId });
});

httpApp.delete('/api/map_presets/:id', async (req, res) => {
  const id = req.params.id;
  if (!PRESET_ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
  const store = await loadPresetStore();
  const preset = store.presets.find(p => p.id === id);
  if (!preset) return res.status(404).json({ error: 'preset not found' });
  store.presets = store.presets.filter(p => p.id !== id);
  if (store.selectedId === id) store.selectedId = null;
  await savePresetStore(store);
  await fs.rm(path.join(presetDir(), preset.file), { force: true });
  res.json({ ok: true, selectedId: store.selectedId });
});

httpApp.post('/api/map_presets/select', async (req, res) => {
  const id = req.body?.id || null;
  const store = await loadPresetStore();
  if (id && !store.presets.some(p => p.id === id)) return res.status(404).json({ error: 'preset not found' });
  store.selectedId = id;
  await savePresetStore(store);
  res.json({ ok: true, selectedId: id });
});

/* =========================
   API: ワールドの保存データから背景地図を生成
   ========================= */
const WORLDMAP_SIZES = [256, 512, 1024, 2048];
let worldMapBusy = false;

httpApp.get('/api/worlds', (_req, res) => {
  const teacher = players.get(teacherName)?.pos;
  res.json({
    worlds: listWorlds(),
    teacherPos: teacher && (teacher.dim == null || teacher.dim === 0) ? { x: teacher.x, z: teacher.z } : null
  });
});

// 重い処理なのでワーカースレッドで実行する。ワーカーを起動できない環境ではこのスレッドで実行する
function runWorldMapRender(job, params) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./worldmap.js', import.meta.url), { workerData: { job, ...params } });
    } catch (err) {
      console.warn('[worldmap] ワーカーを起動できないため同期実行します:', err.message);
      try { resolve(job === 'auto' ? renderWorldMapAuto(params) : renderWorldMap(params)); } catch (e) { reject(e); }
      return;
    }
    worker.once('message', (msg) => {
      if (msg.ok) resolve({ ...msg, png: msg.png && Buffer.from(msg.png) });
      else reject(new Error(msg.error));
    });
    worker.once('error', reject);
  });
}

httpApp.post('/api/worldmap', async (req, res) => {
  const worldId = (req.body?.worldId || '').toString();
  const world = listWorlds().find(w => w.id === worldId);
  if (!world) return res.status(404).json({ error: 'world not found' });
  const auto = req.body?.size === 'auto';
  const size = Number(req.body?.size);
  if (!auto && !WORLDMAP_SIZES.includes(size)) return res.status(400).json({ error: 'invalid size' });
  if (worldMapBusy) return res.status(409).json({ error: '別の地図を生成中です' });

  const worldPath = path.join(worldsDir(), world.id);
  let center;
  if (req.body?.center === 'teacher') {
    const pos = players.get(teacherName)?.pos;
    if (!pos) return res.status(400).json({ error: '先生の現在地がまだ分かりません（/connect 後に少し動いてください）' });
    center = { x: pos.x, z: pos.z };
  } else {
    const info = readLevelInfo(worldPath);
    center = { x: info.spawnX, z: info.spawnZ };
  }

  worldMapBusy = true;
  const t0 = Date.now();
  try {
    const result = auto
      ? await runWorldMapRender('auto', { worldPath, center })
      : await runWorldMapRender('render', { worldPath, minX: Math.floor(center.x) - size / 2, minZ: Math.floor(center.z) - size / 2, size });
    console.log(`[worldmap] ${world.name} ${result.width}x${result.height} を生成（${result.chunkCount} チャンク, ${Date.now() - t0}ms）`);
    if (!result.chunkCount) return res.status(422).json({ error: 'この範囲には保存済みの地形がありません' });

    // 同じワールドから生成した背景があれば置き換える
    const store = await loadPresetStore();
    let preset = store.presets.find(p => p.source?.worldId === world.id);
    if (!preset) {
      preset = { id: uuidv4(), opacity: 1 };
      store.presets.push(preset);
    }
    preset.name = `${world.name}（ワールドから生成）`.slice(0, 60);
    const { minX, minZ, width, height } = result;
    preset.calib = {
      a: { px: 0, py: 0, x: minX, z: minZ },
      b: { px: width, py: height, x: minX + width, z: minZ + height }
    };
    preset.source = {
      worldId: world.id, centerX: center.x, centerZ: center.z, size: auto ? 'auto' : size,
      width, height, chunkCount: result.chunkCount, generatedAt: Date.now()
    };
    // 生成のたびにファイル名を変え、ブラウザに古い画像が残らないようにする
    const file = `${preset.id}-${Date.now()}.png`;
    await fs.mkdir(presetDir(), { recursive: true });
    await fs.writeFile(path.join(presetDir(), file), result.png);
    if (preset.file && preset.file !== file) await fs.rm(path.join(presetDir(), preset.file), { force: true });
    preset.file = file;
    store.selectedId = preset.id;
    await savePresetStore(store);
    res.json({ ok: true, preset, selectedId: store.selectedId, extent: result.extent || null });
  } catch (err) {
    console.error('[worldmap] 生成に失敗しました', err);
    res.status(500).json({ error: err.message });
  } finally {
    worldMapBusy = false;
  }
});

/* =========================
   HTTPサーバ起動
   ========================= */
const HTTP_PORT = 3000;
// 待ち受けはこの PC だけに限る（校内 LAN の他の PC から操作されないように）
httpApp.listen(HTTP_PORT, '127.0.0.1', (err) => {
  if (err) return handleListenError(err, HTTP_PORT);
  console.log(`UI http://127.0.0.1:${HTTP_PORT}`);
});

/* =========================
   WebSocket接続（MEE から /connect）
   ========================= */
const WS_PORT = 8080;
// 他の PC の MEE から /connect されて接続を奪われないよう、この PC からの接続だけ受ける
const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
wss.on('error', (err) => handleListenError(err, WS_PORT));
wss.on('connection', (ws) => {
  meeSocket = ws;
  meeLink = { state: 'handshake', queue: [], cipher: null, decipher: null };
  const link = meeLink;
  console.log('Minecraft Education connected');
  pushState();

  // 鍵交換が終わるまで、以下の送信はキューに積まれる
  startEncryption();

  // 主要イベントを購読
  subscribe('PlayerJoined');
  subscribe('PlayerSpawned');
  subscribe('PlayerLeft');
  subscribe('PlayerRemoved');
  subscribe('PlayerMessage');
  subscribe('PlayerTransform');
  subscribe('PlayerTravelled');
  subscribe('PlayerMoved');

  // 停止方式は接続ごとに判定し直す。停止中の再接続なら維持を再開する
  freezeMode = 'inputpermission';
  if (pauseOn) startPauseTimer();

  // 教員（接続元プレイヤー）の名前を取得
  sendCommand('getlocalplayername', handleLocalPlayerName);
  // イベントが届かない環境でも名簿・位置が分かるよう、コマンドで定期取得する
  startPolling();

  ws.on('message', (buf) => {
    lastRecvAt = Date.now();
    const text = link.decipher ? link.decipher.update(buf).toString('utf8') : buf.toString();
    let msg; try { msg = JSON.parse(text); } catch {
      console.log('[recv] JSON以外', text.slice(0, 200));
      return;
    }
    if (msg.header?.messagePurpose === 'event') {
      logEvent(msg);
      handleEvent(msg);
      return;
    }
    logRecv(msg.header?.messagePurpose, text);
    if (msg.header?.messagePurpose === 'commandResponse' || msg.header?.messagePurpose === 'error') {
      handleCommandResponse(msg);
    }
  });

  ws.on('close', (code, reason) => {
    console.log('Minecraft disconnected', code, reason?.toString() || '');
    if (meeSocket !== ws) return;
    meeSocket = null;
    meeLink = null;
    teacherName = '';
    stopPolling();
    stopPauseTimer();
    pendingRequests.clear();
    pushState();
  });
});

// 診断用：event 以外の受信メッセージを先頭数件だけそのままログに出す
const RECV_LOG_LIMIT = 30;
let recvLogCount = 0;
let lastRecvAt = 0;
function logRecv(purpose, text) {
  recvLogCount++;
  if (recvLogCount <= RECV_LOG_LIMIT) {
    console.log(`[recv] ${purpose ?? '(no purpose)'} #${recvLogCount}`, text.slice(0, 500));
  } else if (recvLogCount === RECV_LOG_LIMIT + 1) {
    console.log('[recv] 以降は省略');
  }
}

// 診断用：応答待ちの件数と、最後に受信してからの経過秒数を定期的に出す
setInterval(() => {
  if (!meeSocket) return;
  const now = Date.now();
  for (const [id, req] of pendingRequests) {
    if (now - req.t > PENDING_TIMEOUT_MS) pendingRequests.delete(id);
  }
  const idle = lastRecvAt ? ((Date.now() - lastRecvAt) / 1000).toFixed(0) : '-';
  console.log(`[stat] 応答待ち ${pendingRequests.size} 件 / 最終受信から ${idle} 秒`);
}, 10000);

// 診断用：イベント名ごとに先頭数件だけ本文をログに出す
const EVENT_LOG_LIMIT = 3;
const eventLogCounts = new Map();
function logEvent(ev) {
  const eventName = ev.header?.eventName || ev.body?.eventName || '(no name)';
  const count = (eventLogCounts.get(eventName) || 0) + 1;
  eventLogCounts.set(eventName, count);
  if (count <= EVENT_LOG_LIMIT) {
    console.log(`[event] ${eventName} #${count}`, JSON.stringify(ev.body).slice(0, 500));
  } else if (count === EVENT_LOG_LIMIT + 1) {
    console.log(`[event] ${eventName} 以降は省略`);
  }
}

/* =========================
   名簿・位置のポーリング（list / querytarget）
   ========================= */
const LIST_POLL_MS = 3000;
const POS_POLL_MS = 1000;
let pollTimers = [];

function startPolling() {
  stopPolling();
  pollTimers = [setInterval(pollList, LIST_POLL_MS), setInterval(pollPositions, POS_POLL_MS)];
  pollList();
}
function stopPolling() {
  pollTimers.forEach(clearInterval);
  pollTimers = [];
}

function pollList() {
  if (pendingRequests.size > MAX_PENDING) return;
  sendCommand('list', (body) => {
    if (typeof body?.players !== 'string') return;
    const names = body.players.split(',').map(s => s.trim()).filter(Boolean);
    // list には必ず自分（ホスト）が含まれるので、空なら解析失敗とみなす
    if (!names.length) return;
    const present = new Set(names);
    let changed = false;
    for (const n of names) {
      if (players.has(n)) continue;
      players.set(n, { name: n, lastSeen: Date.now(), pos: null });
      changed = true;
    }
    for (const n of [...players.keys()]) {
      if (present.has(n)) continue;
      players.delete(n);
      changed = true;
    }
    if (changed) pushState();
  });
}

function pollPositions() {
  for (const name of players.keys()) {
    if (pendingRequests.size > MAX_PENDING) return;
    sendCommand(`querytarget ${quoteName(name)}`, (body) => {
      const t = parseQueryTarget(body)?.[0];
      const p = t?.position;
      if (!p || !players.has(name)) return;
      updatePlayerPos(name, { x: Number(p.x), y: Number(p.y), z: Number(p.z), yaw: Number(t.yRot), dim: Number(t.dimension) });
    });
  }
}

// querytarget の結果は details（JSON 文字列）に入る。無ければ statusMessage 内の JSON を探す
function parseQueryTarget(body) {
  for (const src of [body?.details, body?.statusMessage]) {
    if (typeof src !== 'string') continue;
    const start = src.indexOf('[');
    if (start === -1) continue;
    try {
      const arr = JSON.parse(src.slice(start));
      if (Array.isArray(arr)) return arr;
    } catch { /* 次の候補へ */ }
  }
  return null;
}

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
  wsSend(payload);
}

function handleCommandResponse(msg) {
  const requestId = msg.header?.requestId;
  const req = pendingRequests.get(requestId);
  if (!req) {
    // 購読（subscribe）の失敗応答もここに来る。内容は [recv] に出ている
    if (msg.header?.messagePurpose !== 'error') console.log('[未照合応答]', JSON.stringify(msg).slice(0, 500));
    return;
  }
  pendingRequests.delete(requestId);
  req.fn(msg.body);
}

function handleLocalPlayerName(body) {
  const name = findStringByKeys(body, ['localplayername', 'localPlayerName', 'LocalPlayerName']);
  if (name && name !== teacherName) {
    teacherName = name;
    pushState();
  }
}

// 位置を記録する。名簿に新しく載る時だけ state を送り、それ以外は pos イベントでまとめて送る
function updatePlayerPos(name, { x, y, z, yaw, dim }) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;
  const isNew = !players.has(name);
  const rec = players.get(name) || { name, lastSeen: Date.now(), pos: null };
  const now = Date.now();
  rec.lastSeen = now;
  rec.pos = {
    x,
    y: Number.isFinite(y) ? y : null,
    z,
    yaw: Number.isFinite(yaw) ? yaw : null,
    dim: Number.isFinite(dim) ? dim : null,
    t: now
  };
  players.set(name, rec);
  if (isNew) pushState();
  else dirtyPositions.add(name);
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
        // 停止中に入室・リスポーンした生徒はすぐ止める（個別許可済みの生徒は除く）
        if (pauseOn && n !== teacherName) {
          const sel = `@a[name=${quoteName(n)},tag=!canMove]`;
          applyFreeze(sel);
          showPauseTitle(sel);
        }
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
      const yaw = pickNum(ev.body, ['yRot', 'YRot', 'Yaw', 'yaw']);
      const dim = pickNum(ev.body, ['dimension', 'Dimension']);
      updatePlayerPos(n, { x: px, y: py, z: pz, yaw, dim });
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

// 発言ログを見やすくするための前処理（プレイヤー名の重複接頭辞を除去）
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
  win.loadURL(`http://127.0.0.1:${HTTP_PORT}/`);
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url); return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
// 2 回目の起動時は、既存のウィンドウを前面に出す
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { if (app.isReady()) createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.focus();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });










// // main.js  (ESM)
// import { app, BrowserWindow, shell } from 'electron';
// import express from 'express';
// import { WebSocketServer } from 'ws';
// import { v4 as uuidv4 } from 'uuid';
// import path from 'path';
// import { fileURLToPath } from 'url';

// /* =========================
//    サーバ状態（インメモリ管理）
//    ========================= */
// let meeSocket = null;

// // 参加者名簿: name -> { name, lastSeen: Date.now(), pos:{x,y,z,rot?} }
// const players = new Map();
// // チャットログ: 最大100件を保持
// const chatLog = [];
// // ポーズ状態（維持用フラグ）
// let pauseOn = false;
// // Tick同期: 20tickごとに効果を再適用
// let tickCounter = 0;
// const REAPPLY_TICKS = 20;
// const PAUSE_EFFECT_SECONDS = 900;

// const __filename = fileURLToPath(import.meta.url);

// const __dirname = path.dirname(__filename);



// // SSEクライアント一覧
// const sseClients = new Set();
// const suppressedChatMessages = new Map();
// const SUPPRESS_CHAT_MS = 4000;

// function suppressChatMessage(message) {
//   if (!message) return;
//   suppressedChatMessages.set(message, Date.now() + SUPPRESS_CHAT_MS);
// }

// function shouldSuppressChatMessage(message) {
//   if (!message) return false;
//   const expiry = suppressedChatMessages.get(message);
//   if (expiry == null) return false;
//   if (Date.now() > expiry) {
//     suppressedChatMessages.delete(message);
//     return false;
//   }
//   return true;
// }

// /* =========================
//    HTTP (UI/API) with Express
//    ========================= */
// const httpApp = express();
// httpApp.use(express.json());

// // --- SSE: ブラウザへ状態をプッシュ ---
// httpApp.get('/events', (req, res) => {
//   res.setHeader('Content-Type', 'text/event-stream');
//   res.setHeader('Cache-Control', 'no-cache');
//   res.setHeader('Connection', 'keep-alive');
//   res.flushHeaders();
//   res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
//   sseClients.add(res);
//   pushState();
//   req.on('close', () => sseClients.delete(res));
// });

// function pushState() {
//   const roster = [...players.values()]
//     .sort((a, b) => a.name.localeCompare(b.name))
//     .map(p => ({ name: p.name, lastSeen: p.lastSeen, pos: p.pos || null }));
//   const payload = {
//     type: 'state',
//     roster,
//     chat: chatLog,
//     pauseOn,
//     meeConnected: !!meeSocket
//   };
//   const data = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
//   for (const c of sseClients) c.write(data);
// }

// function pushChat(entry) {
//   const data = `event: chat\ndata: ${JSON.stringify(entry)}\n\n`;
//   for (const c of sseClients) c.write(data);
// }

// function normalizeChatMessage(playerName, message) {
//   if (typeof message !== 'string') {
//     if (message == null) return '';
//     return String(message);
//   }
//   let result = message.trimStart();
//   const name = (playerName ?? '').toString().trim();
//   if (!name) return result;
//   const lowerName = name.toLowerCase();

//   const stripBracket = (open, close) => {
//     if (!result.startsWith(open)) return false;
//     const closeIdx = result.indexOf(close, open.length);
//     if (closeIdx === -1) return false;
//     const inner = result.slice(open.length, closeIdx).trim();
//     if (!inner) return false;
//     if (inner.toLowerCase() !== lowerName) return false;
//     result = result.slice(closeIdx + close.length).trimStart();
//     return true;
//   };

//   if (stripBracket('[', ']')) return result;
//   if (stripBracket('<', '>')) return result;

//   const stripPrefix = (prefix) => {
//     if (!prefix) return false;
//     if (result.length < prefix.length) return false;
//     if (result.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return false;
//     result = result.slice(prefix.length).trimStart();
//     return true;
//   };

//   if (stripPrefix(`${name}:`)) return result;
//   if (stripPrefix(`${name}：`)) return result;
//   if (stripPrefix(`${name}>`)) return result;
//   if (stripPrefix(`${name}＞`)) return result;
//   if (stripPrefix(`${name}]`)) return result;
//   if (stripPrefix(`${name}》`)) return result;

//   return result;
// }

// // --- 最小UI: 単一HTMLを返すエンドポイント ---
// // --- UI 配信 ---
// httpApp.use(express.static(path.join(__dirname, 'public')));
// httpApp.get('/', (_req, res) => {
//   res.sendFile(path.join(__dirname, 'public', 'index.html'));
// });

// // --- Minecraft Education へコマンド送信 ---
// function sendCommand(cmd) {
//   if (!meeSocket) return false;
//   const payload = {
//     header: {
//       version: 1,
//       requestId: uuidv4(),
//       messagePurpose: "commandRequest",
//       messageType: "commandRequest"
//     },
//     body: { version: 1, commandLine: cmd }
//   };
//   meeSocket.send(JSON.stringify(payload));
//   return true;
// }

// // --- API: PAUSE/RESUME/ALLOW/CHAT ---
// httpApp.post('/api/pause_on', (_req, res) => {
//   pauseOn = true;
//   suppressChatMessage('ストップ');
//   suppressChatMessage('話を聞く時間だよ');
//   // 全員を停止対象に戻す
//   sendCommand('tag @a remove canMove');
//   // 効果を再適用
//   sendCommand(`effect @a[tag=!canMove] slowness ${PAUSE_EFFECT_SECONDS} 255`);
//   sendCommand(`effect @a[tag=!canMove] mining_fatigue ${PAUSE_EFFECT_SECONDS} 255`);
//   sendCommand('gamemode adventure @a[tag=!canMove]');
//   sendCommand('title @a title ストップ');
//   sendCommand('title @a subtitle 話を聞く時間だよ');
//   sendCommand('title @a times 10 6000 20');
//   pushState();
//   res.json({ ok: true });
// });
// httpApp.post('/api/pause_off', (_req, res) => {
//   pauseOn = false;
//   sendCommand('effect @a clear');
//   sendCommand('title @a clear');
//   sendCommand('gamemode creative @a');
//   pushState();
//   res.json({ ok: true });
// });
// httpApp.post('/api/allow_name', (req, res) => {
//   const name = req.body?.name;
//   if (!name) return res.status(400).json({ error: 'name required' });
//   sendCommand(`tag "${name}" add canMove`);
//   sendCommand(`effect "${name}" clear`);
//   sendCommand(`gamemode creative "${name}"`);
//   sendCommand(`title "${name}" clear`);
//   res.json({ ok: true });
// });

// httpApp.post('/api/gather', (_req, res) => {
//   sendCommand('tp @a @s');
//   res.json({ ok: true });
// });

// httpApp.post('/api/gather_name', (req, res) => {
//   const name = req.body?.name;
//   if (!name) return res.status(400).json({ error: 'name required' });
//   sendCommand(`tp "${name}" @s`);
//   res.json({ ok: true });
// });

// httpApp.post('/api/review_items', (_req, res) => {
//   sendCommand('give @a writable_book 1');
//   res.json({ ok: true });
// });

// httpApp.post('/api/camera_items', (_req, res) => {
//   sendCommand('give @a camera 1');
//   sendCommand('give @a portfolio 1');
//   res.json({ ok: true });
// });

// httpApp.post('/api/kill_mob_r50', (_req, res) => {
//   sendCommand('kill @e[type=!player,type=!item,r=50]');
//   res.json({ ok: true });
// });

// httpApp.post('/api/mayfly', (req, res) => {
//   const enable = !!req.body?.enable;
//   sendCommand(`ability @s mayfly ${enable ? 'true' : 'false'}`);
//   res.json({ ok: true });
// });

// httpApp.post('/api/chat_send', (req, res) => {
//   const msg = (req.body?.message || '').toString();
//   if (!msg) return res.status(400).json({ error: 'message required' });
//   // Forward the chat to Minecraft; we rely on the PlayerMessage event to update the log.
//   sendCommand(`say ${msg.replace(/"/g, '\"')}`);
//   res.json({ ok: true });
// });

// // HTTPサーバ起動
// const HTTP_PORT = 3000;
// httpApp.listen(HTTP_PORT, () => console.log(`UI http://localhost:${HTTP_PORT}`));

// /* =========================
//    WebSocket接続（MEE から /connect）
//    ========================= */
// const WS_PORT = 8080;
// const wss = new WebSocketServer({ port: WS_PORT });
// wss.on('connection', (ws) => {
//   meeSocket = ws;
//   console.log('Minecraft Education connected');
//   pushState();

//   // 主要イベントを購読
//   subscribe('PlayerJoined');
//   subscribe('PlayerSpawned');
//   subscribe('PlayerLeft');
//   subscribe('PlayerRemoved');
//   subscribe('PlayerMessage');
//   subscribe('PlayerTransform');
//   subscribe('PlayerTravelled');
//   subscribe('PlayerMoved');
//   subscribe('Tick');

//   ws.on('message', (buf) => {
//     let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
//     if (msg.header?.messagePurpose === 'event') {
//       handleEvent(msg);
//     }
//   });

//   ws.on('close', () => {
//     meeSocket = null;
//     console.log('Minecraft disconnected');
//     pushState();
//   });
// });

// function subscribe(eventName) {
//   if (!meeSocket) return;
//   const payload = {
//     header: {
//       version: 1,
//       requestId: uuidv4(),
//       messagePurpose: 'subscribe',
//       messageType: 'commandRequest'
//     },
//     body: { eventName }
//   };
//   meeSocket.send(JSON.stringify(payload));
// }

// function handleEvent(ev) {
//   const eventName = ev.header?.eventName || ev.body?.eventName;
//   if (!eventName) return;
//   switch (eventName) {
//     case 'PlayerJoined':
//     case 'PlayerSpawned': {
//       const n = findPlayerName(ev);
//       if (n) {
//         const rec = players.get(n) || { name: n, lastSeen: Date.now(), pos: null };
//         rec.lastSeen = Date.now();
//         players.set(n, rec);
//         pushState();
//       }
//       break;
//     }
//     case 'PlayerLeft':
//     case 'PlayerRemoved': {
//       const n = findPlayerName(ev);
//       if (n && players.delete(n)) pushState();
//       break;
//     }
//     case 'PlayerMessage': {
//       const n = findPlayerName(ev) || 'Unknown';
//       const m = findChatMessage(ev);
//       if (!m) break;
//       const cleanedMessage = normalizeChatMessage(n, m);
//       if (shouldSuppressChatMessage(cleanedMessage)) break;
//       const entry = { id: uuidv4(), t: Date.now(), player: n, message: cleanedMessage };
//       chatLog.push(entry);
//       if (chatLog.length > 100) chatLog.shift();
//       let rosterTouched = false;
//       const rec = players.get(n);
//       if (rec) {
//         rec.lastSeen = Date.now();
//         rosterTouched = true;
//       } else if (n !== 'Unknown') {
//         players.set(n, { name: n, lastSeen: Date.now(), pos: null });
//         rosterTouched = true;
//       }
//       if (rosterTouched) pushState();
//       pushChat(entry);
//       break;
//     }
//     case 'PlayerTransform':
//     case 'PlayerTravelled':
//     case 'PlayerMoved': {
//       const n = findPlayerName(ev);
//       if (!n) break;
//       const px = pickNum(ev.body, ['X', 'PosX', 'x']);
//       const py = pickNum(ev.body, ['Y', 'PosY', 'y']);
//       const pz = pickNum(ev.body, ['Z', 'PosZ', 'z']);
//       if (!Number.isFinite(px) || !Number.isFinite(pz)) break;
//       const rec = players.get(n) || { name: n, lastSeen: Date.now(), pos: null };
//       rec.lastSeen = Date.now();
//       rec.pos = { x: px, y: Number.isFinite(py) ? py : null, z: pz };
//       players.set(n, rec);
//       pushState();
//       break;
//     }
//     case 'Tick': {
//       if (pauseOn) {
//         tickCounter++;
//         if (tickCounter >= REAPPLY_TICKS) {
//           tickCounter = 0;
//           // 維持用の効果を再適用
//           sendCommand(`effect @a[tag=!canMove] slowness ${PAUSE_EFFECT_SECONDS} 255`);
//           sendCommand(`effect @a[tag=!canMove] mining_fatigue ${PAUSE_EFFECT_SECONDS} 255`);
//           sendCommand('gamemode adventure @a[tag=!canMove]');
//         }
//       }
//       break;
//     }
//     default:
//       // 未使用イベントは無視
//       break;
//   }
// }
// const NAME_KEYS = ['PlayerName', 'playerName', 'Name', 'name', 'Username', 'username', 'Sender', 'sender', 'Owner', 'owner', 'TargetName', 'targetName', 'SourceName', 'sourceName'];
// const MESSAGE_KEYS = ['Message', 'message', 'Text', 'text', 'BodyText', 'bodyText', 'DisplayText', 'displayText'];
// function findPlayerName(ev) {
//   return findStringByKeys(ev?.body, NAME_KEYS);
// }
// function findChatMessage(ev) {
//   return findStringByKeys(ev?.body, MESSAGE_KEYS);
// }
// function findStringByKeys(obj, keys, depth = 0, seen = new WeakSet()) {
//   if (!obj || depth > 6) return '';
//   if (typeof obj === 'string') return '';
//   if (typeof obj !== 'object') return '';
//   if (seen.has(obj)) return '';
//   seen.add(obj);
//   if (Array.isArray(obj)) {
//     for (const item of obj) {
//       const res = findStringByKeys(item, keys, depth + 1, seen);
//       if (res) return res;
//     }
//     return '';
//   }
//   for (const key of keys) {
//     if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
//     const value = obj[key];
//     if (typeof value === 'string' && value.trim()) return value.trim();
//   }
//   for (const value of Object.values(obj)) {
//     if (typeof value === 'string') continue;
//     const res = findStringByKeys(value, keys, depth + 1, seen);
//     if (res) return res;
//   }
//   return '';
// }
// function axisFromKeys(keys) {
//   for (const key of keys) {
//     const lower = key.toLowerCase();
//     if (lower === 'x' || lower.endsWith('x') || lower.includes('posx') || lower.includes('coordx')) return 'x';
//     if (lower === 'y' || lower.endsWith('y') || lower.includes('posy') || lower.includes('coordy')) return 'y';
//     if (lower === 'z' || lower.endsWith('z') || lower.includes('posz') || lower.includes('coordz')) return 'z';
//   }
//   return null;
// }
// function pickNum(obj, keys, depth = 0, seen = new WeakSet()) {
//   if (obj == null || depth > 6) return NaN;
//   if (typeof obj === 'number') return obj;
//   if (typeof obj === 'string') {
//     if (obj.trim() === '') return NaN;
//     const n = Number(obj);
//     return Number.isFinite(n) ? n : NaN;
//   }
//   if (typeof obj !== 'object') return NaN;
//   if (seen.has(obj)) return NaN;
//   seen.add(obj);
//   if (Array.isArray(obj)) {
//     const axis = axisFromKeys(keys);
//     if (axis !== null) {
//       const idx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
//       if (idx < obj.length) {
//         const direct = pickNum(obj[idx], keys, depth + 1, seen);
//         if (Number.isFinite(direct)) return direct;
//       }
//     }
//     for (const item of obj) {
//       const n = pickNum(item, keys, depth + 1, seen);
//       if (Number.isFinite(n)) return n;
//     }
//     return NaN;
//   }
//   for (const k of keys) {
//     if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
//     const v = obj[k];
//     if (typeof v === 'number') return v;
//     if (typeof v === 'string' && v.trim() !== '') {
//       const n = Number(v);
//       if (Number.isFinite(n)) return n;
//     }
//   }
//   const nestedKeys = ['Position', 'position', 'Pos', 'pos', 'Coordinates', 'coordinates', 'Transform', 'transform', 'Location', 'location', 'Player', 'player', 'Entity', 'entity', 'Target', 'target', 'Origin', 'origin', 'Properties', 'properties', 'Data', 'data', 'Body', 'body', 'Actor', 'actor'];
//   for (const nk of nestedKeys) {
//     if (!Object.prototype.hasOwnProperty.call(obj, nk)) continue;
//     const nested = obj[nk];
//     const n = pickNum(nested, keys, depth + 1, seen);
//     if (Number.isFinite(n)) return n;
//   }
//   for (const value of Object.values(obj)) {
//     if (typeof value !== 'object') continue;
//     const n = pickNum(value, keys, depth + 1, seen);
//     if (Number.isFinite(n)) return n;
//   }
//   return NaN;
// }
// /* =========================
//    Electron ウィンドウ生成
//    ========================= */
// function createWindow() {
//   const win = new BrowserWindow({
//     width: 900, height: 680,
//     webPreferences: { sandbox: true }
//   });
//   win.loadURL(`http://localhost:${HTTP_PORT}/`);
//   win.setMenuBarVisibility(false);
//   win.webContents.setWindowOpenHandler(({ url }) => {
//     shell.openExternal(url); return { action: 'deny' };
//   });
// }

// app.whenReady().then(() => {
//   createWindow();
//   app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
// });
// app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });


