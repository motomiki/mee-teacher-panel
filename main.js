// main.js  (ESM)
import { app, BrowserWindow, shell, dialog } from 'electron';
import express from 'express';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
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

// 授業中にアプリごと落ちないよう、想定外の例外は記録だけして動き続ける
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));

/* =========================
   設定（userData/settings.json に保存）
   ========================= */
const GAMEMODES = ['creative', 'survival', 'adventure', 'keep'];
const DEFAULT_SETTINGS = {
  // 地図：プレイヤー周辺のチャンクをゲームに保存させる／背景地図を自動で作り直す
  autoRecord: true,
  autoRefreshMap: true,
  // 停止を解除した後のゲームモード。keep は「停止・解除のどちらでもゲームモードを変えない」
  resumeGamemode: 'creative',
  // 先生からこの距離（ブロック）以上離れた生徒を強調する。0 は無効
  alertDistance: 0,
  timerMinutes: 10,
  timerPauseAtEnd: false,
  timerSunset: false,
  timerStartText: 'あと{時間}で終わりだよ',
  timerEndText: '終わりだよ',
  announcements: ['集合してください', 'あと5分です', '片付けを始めましょう', '先生の話を聞きましょう'],
  // 左の操作列で折りたたんでいるグループ
  collapsed: {}
};

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}
// 受け取った値のうち、型と範囲が正しいものだけを取り出す
function sanitizeSettings(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const key of ['autoRecord', 'autoRefreshMap', 'timerPauseAtEnd', 'timerSunset']) {
    if (typeof src[key] === 'boolean') out[key] = src[key];
  }
  if (GAMEMODES.includes(src.resumeGamemode)) out.resumeGamemode = src.resumeGamemode;
  const dist = Number(src.alertDistance);
  if (src.alertDistance !== undefined && Number.isFinite(dist)) out.alertDistance = Math.max(0, Math.min(10000, Math.round(dist)));
  const min = Number(src.timerMinutes);
  if (src.timerMinutes !== undefined && Number.isFinite(min)) out.timerMinutes = Math.max(0.1, Math.min(180, min));
  for (const key of ['timerStartText', 'timerEndText']) {
    if (typeof src[key] === 'string') out[key] = cleanLine(src[key]).slice(0, 40);
  }
  if (Array.isArray(src.announcements)) {
    out.announcements = src.announcements.map(s => cleanLine(s).slice(0, 40)).filter(Boolean).slice(0, 12);
  }
  if (src.collapsed && typeof src.collapsed === 'object') {
    out.collapsed = {};
    for (const [k, v] of Object.entries(src.collapsed)) {
      if (/^[a-z]{1,20}$/.test(k)) out.collapsed[k] = !!v;
    }
  }
  return out;
}
// コマンドに埋め込む 1 行の文字列にする（改行を空白に）
function cleanLine(s) {
  return (s ?? '').toString().replace(/[\r\n]+/g, ' ').trim();
}
function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...sanitizeSettings(JSON.parse(fsSync.readFileSync(settingsFile(), 'utf8'))) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
const settings = loadSettings();

// 書き込み途中で落ちてもファイルが壊れないよう、一時ファイルに書いてから置き換える
async function writeFileAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}
let settingsSaving = Promise.resolve();
function saveSettings() {
  settingsSaving = settingsSaving
    .then(() => writeFileAtomic(settingsFile(), JSON.stringify(settings, null, 2)))
    .catch(err => console.error('[settings] 保存に失敗しました', err));
  return settingsSaving;
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
// 記録用（CSV 書き出し）: チャットは全件、位置は一定間隔で間引いて残す
const chatArchive = [];
const CHAT_ARCHIVE_MAX = 5000;
const posArchive = [];
const POS_ARCHIVE_MAX = 300000;
const POS_ARCHIVE_MS = 5000;
// MEE から一定時間なにも届いていない（ゲームの一時停止や通信断の可能性）
let meeStalled = false;
const STALL_MS = 20000;
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
// 照合されなかった分が溜まり続けないよう、期限切れを定期的に捨てる
setInterval(() => {
  const now = Date.now();
  for (const [msg, expiry] of suppressedChatMessages) {
    if (now > expiry) suppressedChatMessages.delete(msg);
  }
}, 30000);

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
  res.on('error', () => sseClients.delete(res));
});

// 全画面へイベントを送る。書き込めなくなった相手は一覧から外す
function sseBroadcast(event, payload) {
  const data = event ? `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n` : payload;
  for (const c of sseClients) {
    try {
      c.write(data);
    } catch {
      sseClients.delete(c);
    }
  }
}
// 無通信で切られないよう、コメント行を定期的に流す
setInterval(() => sseBroadcast(null, ': ping\n\n'), 20000);

function pushState() {
  const roster = [...players.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(p => ({ name: p.name, lastSeen: p.lastSeen, pos: p.pos || null }));
  sseBroadcast('state', {
    type: 'state',
    roster,
    chat: chatLog,
    pauseOn,
    mayflyOn,
    meeConnected: !!meeSocket,
    meeStalled,
    teacher: teacherName,
    settings,
    timer: timer ? { endAt: timer.endAt, totalMs: timer.totalMs } : null,
    rules: worldRules,
    record: recordStatus(),
    now: Date.now()
  });
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
  sseBroadcast('pos', { t: Date.now(), players: list });
}
setInterval(flushPositions, POS_FLUSH_MS);
function pushChat(entry) {
  sseBroadcast('chat', entry);
}

// 位置の記録（CSV 書き出し用）。全員の現在地を一定間隔で残す
setInterval(() => {
  if (!meeSocket) return;
  const now = Date.now();
  for (const p of players.values()) {
    if (!p.pos) continue;
    posArchive.push([now, p.name, p.pos.x, p.pos.y, p.pos.z, p.pos.dim]);
  }
  if (posArchive.length > POS_ARCHIVE_MAX) posArchive.splice(0, posArchive.length - POS_ARCHIVE_MAX + 10000);
}, POS_ARCHIVE_MS);

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
  if (plain) safeSend(JSON.stringify(payload));
  else wsSend(payload);
  return requestId;
}

// 閉じかけのソケットへ送ると例外になるので、開いているときだけ送る
function safeSend(data) {
  const ws = meeSocket;
  if (!ws || ws.readyState !== 1) return false;
  try {
    ws.send(data);
    return true;
  } catch (err) {
    console.error('[send] 送信に失敗しました', err.message);
    return false;
  }
}

// 応答を待つ版。{ ok, message } を返す（ok は statusCode が 0 のとき）
function sendCommandAsync(cmd, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish({ ok: false, message: 'ゲームから応答がありません' }), timeoutMs);
    const id = sendCommand(cmd, (body) => {
      finish({ ok: body?.statusCode === 0, message: (body?.statusMessage ?? '').toString() });
    });
    if (!id) finish({ ok: false, message: 'MEE 未接続' });
  });
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
  // 暗号はストリームなので、送れないときは暗号化もしない（状態がずれるため）
  if (meeSocket.readyState !== 1) return;
  safeSend(meeLink.cipher ? meeLink.cipher.update(Buffer.from(text, 'utf8')) : text);
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
    const queue = link.queue;
    link.queue = [];
    if (meeSocket?.readyState === 1) {
      for (const text of queue) {
        safeSend(link.cipher ? link.cipher.update(Buffer.from(text, 'utf8')) : text);
      }
    }
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
  // 停止中はブロックを壊せないようアドベンチャーにする（設定が「変更しない」のときは触らない）
  if (settings.resumeGamemode !== 'keep') sendCommand(`gamemode adventure ${sel}`);
}

// gmSel: ゲームモードを戻す対象。全員解除のときは停止していた生徒だけにして、先生のモードは変えない
function releaseFreeze(sel, gmSel = sel) {
  if (freezeMode === 'inputpermission') {
    sendCommand(`inputpermission set ${sel} movement enabled`);
    sendCommand(`inputpermission set ${sel} camera enabled`);
  }
  sendCommand(`effect ${sel} clear`);
  if (settings.resumeGamemode !== 'keep') sendCommand(`gamemode ${settings.resumeGamemode} ${gmSel}`);
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
    // タイマー動作中は、タイマー側が残り時間と合わせて毎秒表示する
    if (!timer) sendCommand(`title ${PAUSE_TARGET} actionbar ${PAUSE_ACTIONBAR}`, noop);
  }, PAUSE_REAPPLY_MS);
}

function stopPauseTimer() {
  if (pauseTimer) clearInterval(pauseTimer);
  pauseTimer = null;
}

// 応答をログに出さないコマンド用
function noop() {}

function doPauseOn({ showTitle = true } = {}) {
  pauseOn = true;
  suppressChatMessage('ストップ');
  suppressChatMessage('話を聞く時間だよ');
  // 全員を停止対象に戻し、先生（接続元 @s）だけ除外する
  sendCommand('tag @a remove canMove');
  sendCommand('tag @s add canMove');
  applyFreeze(PAUSE_TARGET);
  if (showTitle) showPauseTitle(PAUSE_TARGET);
  startPauseTimer();
  pushState();
}

function doPauseOff() {
  // 未接続でもパネル側の停止状態は解除する（再接続時に停止が復活しないように）
  pauseOn = false;
  stopPauseTimer();
  if (meeSocket) releaseFreeze('@a', PAUSE_TARGET);
  pushState();
}

/* =========================
   タイマー（残り時間を全員の画面に出す）
   Timer_Addon と同じ見せ方：3分より多い＝白、3分以下＝水色、1分以下＝ピンク。終了の表示は90秒間
   ========================= */
// { endAt, totalMs, interval, sunset: 夕暮れ演出で時間の流れを止めている間 true }
let timer = null;

function formatDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (!m) return `${s}秒`;
  return s ? `${m}分${s}秒` : `${m}分`;
}

function timerActionbar(msLeft) {
  const sec = Math.max(0, Math.ceil(msLeft / 1000));
  const color = sec > 180 ? '§f' : sec > 60 ? '§b' : '§d';
  return `${color}残り ${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, '0')}秒`;
}

function showBigTitle(sel, text, stayTicks) {
  suppressChatMessage(text);
  // times は title より先に送らないと反映されない
  sendCommand(`title ${sel} times 10 ${stayTicks} 20`, noop);
  sendCommand(`title ${sel} title ${text}`, noop);
}

function timerTick() {
  if (!timer) return;
  const left = timer.endAt - Date.now();
  if (left <= 0) return finishTimer();
  if (!meeSocket) return;
  // 夕暮れ演出：残り3分で時間の流れを戻し、終了に向けて暗くなっていく
  if (timer.sunset && left <= 180000) {
    timer.sunset = false;
    sendCommand('gamerule dodaylightcycle true', noop);
  }
  const text = timerActionbar(left);
  if (pauseOn) {
    sendCommand(`title ${PAUSE_TARGET} actionbar ${PAUSE_ACTIONBAR}　${text}`, noop);
    sendCommand(`title @a[tag=canMove] actionbar ${text}`, noop);
  } else {
    sendCommand(`title @a actionbar ${text}`, noop);
  }
}

function startTimer(minutes) {
  clearTimer();
  const totalMs = Math.round(minutes * 60000);
  timer = { endAt: Date.now() + totalMs, totalMs, interval: setInterval(timerTick, 1000), sunset: false };
  if (settings.timerSunset) {
    sendCommand('time set 12000', noop);
    if (totalMs > 180000) {
      timer.sunset = true;
      sendCommand('gamerule dodaylightcycle false', noop);
    } else {
      sendCommand('gamerule dodaylightcycle true', noop);
    }
  }
  const text = settings.timerStartText.replaceAll('{時間}', formatDuration(totalMs));
  if (text) showBigTitle('@a', text, 70);
  timerTick();
  pushState();
}

// 時間の流れを止めたままにしないよう、演出の途中なら元に戻す
function clearTimer() {
  if (!timer) return;
  clearInterval(timer.interval);
  if (timer.sunset) sendCommand('gamerule dodaylightcycle true', noop);
  timer = null;
}

function cancelTimer() {
  if (!timer) return;
  clearTimer();
  sendCommand('title @a actionbar §7タイマーを中止しました', noop);
  pushState();
}

function finishTimer() {
  clearTimer();
  if (meeSocket) {
    if (settings.timerEndText) showBigTitle('@a', settings.timerEndText, 1800);
    // 終了の表示を残したいので、停止のタイトル（ストップ）は出さない
    if (settings.timerPauseAtEnd && !pauseOn) doPauseOn({ showTitle: false });
  }
  pushState();
}

/* =========================
   授業準備（ゲームルール）
   ========================= */
// rule: 状態を読むゲームルール名（小文字）、onValue: 「ON」とみなす値
const PREP_RULES = {
  day: { rule: 'dodaylightcycle', onValue: false, on: ['time set day', 'gamerule dodaylightcycle false'], off: ['gamerule dodaylightcycle true'] },
  clear: { rule: 'doweathercycle', onValue: false, on: ['weather clear', 'gamerule doweathercycle false'], off: ['gamerule doweathercycle true'] },
  nopvp: { rule: 'pvp', onValue: false, on: ['gamerule pvp false'], off: ['gamerule pvp true'] },
  notnt: { rule: 'tntexplodes', onValue: false, on: ['gamerule tntexplodes false'], off: ['gamerule tntexplodes true'] },
  nomobs: { rule: 'domobspawning', onValue: false, on: ['gamerule domobspawning false'], off: ['gamerule domobspawning true'] },
  keepinv: { rule: 'keepinventory', onValue: true, on: ['gamerule keepinventory true'], off: ['gamerule keepinventory false'] }
};
// 各項目が ON かどうか（true / false）。まだ分からない項目は null
let worldRules = Object.fromEntries(Object.keys(PREP_RULES).map(k => [k, null]));

// 引数なしの gamerule は「名前 = 値」の一覧を返す。読めた項目だけ反映する
async function refreshWorldRules() {
  const res = await sendCommandAsync('gamerule');
  if (!res.ok) return;
  const values = new Map();
  for (const m of res.message.matchAll(/(\w+)\s*=\s*(true|false)/gi)) values.set(m[1].toLowerCase(), m[2].toLowerCase() === 'true');
  let changed = false;
  for (const [key, def] of Object.entries(PREP_RULES)) {
    if (!values.has(def.rule)) continue;
    const on = values.get(def.rule) === def.onValue;
    if (worldRules[key] !== on) { worldRules[key] = on; changed = true; }
  }
  if (changed) pushState();
}

async function applyPrepRule(key, on) {
  const def = PREP_RULES[key];
  let last = { ok: true, message: '' };
  for (const cmd of on ? def.on : def.off) {
    last = await sendCommandAsync(cmd);
    if (!last.ok) return last;
  }
  worldRules[key] = on;
  return last;
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
  doPauseOn();
  res.json({ ok: true });
});
httpApp.post('/api/pause_off', (req, res) => {
  const connected = !!meeSocket;
  doPauseOff();
  if (!connected) return res.status(503).json({ error: 'MEE 未接続' });
  res.json({ ok: true });
});

// コマンドの結果を待って返す。失敗したらゲームのメッセージを添えて 422 にする
async function runAndReply(res, cmd, failHint) {
  const result = await sendCommandAsync(cmd);
  if (result.ok) return res.json({ ok: true });
  res.status(422).json({ error: failHint ? `${failHint}（${result.message || '理由不明'}）` : (result.message || 'コマンドが失敗しました') });
}

/* --- 設定 --- */
httpApp.get('/api/settings', (_req, res) => res.json(settings));
httpApp.post('/api/settings', async (req, res) => {
  Object.assign(settings, sanitizeSettings(req.body));
  await saveSettings();
  pushState();
  res.json({ ok: true, settings });
});

/* --- 移動 --- */
httpApp.post('/api/goto_name', requireMee, (req, res) => {
  const name = req.body?.name;
  if (!name) return res.status(400).json({ error: 'name required' });
  runAndReply(res, `tp @s ${quoteName(name)}`, 'その生徒の所へ移動できませんでした');
});
// 地図で選んだ地点へ移動する。高さが分からないので spreadplayers で地表に置く
httpApp.post('/api/tp_point', requireMee, (req, res) => {
  const x = Math.round(Number(req.body?.x));
  const z = Math.round(Number(req.body?.z));
  if (!Number.isFinite(x) || !Number.isFinite(z)) return res.status(400).json({ error: 'invalid position' });
  const target = req.body?.target;
  const sel = target === 'all' ? '@a' : target === 'teacher' ? '@s' : (typeof target === 'string' && target ? quoteName(target) : null);
  if (!sel) return res.status(400).json({ error: 'target required' });
  runAndReply(res, `spreadplayers ${x} ${z} 0 1 ${sel}`, 'その場所へは移動できませんでした。プレイヤーの近く（読み込み済みの場所）を選んでください');
});

/* --- タイマー・お知らせ --- */
httpApp.post('/api/timer_start', requireMee, async (req, res) => {
  const minutes = Number(req.body?.minutes);
  if (!Number.isFinite(minutes) || minutes < 0.1 || minutes > 180) return res.status(400).json({ error: '時間は 0.1〜180 分で指定してください' });
  settings.timerMinutes = minutes;
  saveSettings();
  startTimer(minutes);
  res.json({ ok: true });
});
httpApp.post('/api/timer_stop', (_req, res) => {
  cancelTimer();
  res.json({ ok: true });
});
httpApp.post('/api/announce', requireMee, (req, res) => {
  const msg = cleanLine(req.body?.message).slice(0, 80);
  if (!msg) return res.status(400).json({ error: 'message required' });
  // 短い文は大きく、長い文は見出し＋小さい字で画面中央に出す。後から読み返せるようチャットにも流す
  suppressChatMessage(msg);
  sendCommand('title @a times 10 100 20', noop);
  if (msg.length <= 12) {
    sendCommand(`title @a title ${msg}`, noop);
  } else {
    suppressChatMessage('§eお知らせ');
    sendCommand(`title @a subtitle ${msg}`, noop);
    sendCommand('title @a title §eお知らせ', noop);
  }
  sendCommand(`say ${msg}`);
  res.json({ ok: true });
});

/* --- 授業準備 --- */
httpApp.post('/api/prep', requireMee, async (req, res) => {
  const on = req.body?.on !== false;
  const keys = req.body?.key === 'all' ? Object.keys(PREP_RULES) : [req.body?.key];
  if (!keys.every(k => Object.prototype.hasOwnProperty.call(PREP_RULES, k))) return res.status(400).json({ error: 'unknown key' });
  const failed = [];
  for (const key of keys) {
    const result = await applyPrepRule(key, on);
    if (!result.ok) failed.push(result.message || key);
  }
  pushState();
  if (failed.length) return res.status(422).json({ error: `設定できない項目がありました（${failed.join(' / ')}）` });
  res.json({ ok: true });
});

/* --- 記録の書き出し（Excel で開けるよう BOM 付き UTF-8 の CSV） --- */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  // 生徒の発言が = などで始まると Excel が数式として実行してしまうので、文字列として扱わせる
  if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function sendCsv(res, baseName, header, rows) {
  const stamp = csvTime(Date.now()).replace(/[-: ]/g, '').slice(0, 12);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}-${stamp}.csv"`);
  res.send('﻿' + [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
}
httpApp.get('/api/export/chat.csv', (_req, res) => {
  sendCsv(res, 'chat', ['時刻', '名前', '発言'], chatArchive.map(c => [csvTime(c.t), c.player, c.message]));
});
httpApp.get('/api/export/positions.csv', (_req, res) => {
  const round = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : '');
  sendCsv(res, 'positions', ['時刻', '名前', 'x', 'y', 'z', 'ディメンション'],
    posArchive.map(([t, name, x, y, z, dim]) => [csvTime(t), name, round(x), round(y), round(z), dim ?? '']));
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
  await writeFileAtomic(path.join(presetDir(), 'presets.json'), JSON.stringify(store, null, 2));
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
    // 応答なしで終了した場合や固まった場合に、生成中のまま戻らなくなるのを防ぐ
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };
    const timeout = setTimeout(() => {
      worker.terminate();
      settle(reject, new Error('地図の生成が時間内に終わりませんでした'));
    }, WORLDMAP_TIMEOUT_MS);
    worker.once('message', (msg) => {
      if (msg.ok) settle(resolve, { ...msg, png: msg.png && Buffer.from(msg.png) });
      else settle(reject, new Error(msg.error));
    });
    worker.once('error', (err) => settle(reject, err));
    worker.once('exit', (code) => settle(reject, new Error(`地図の生成が途中で終了しました（コード ${code}）`)));
  });
}
const WORLDMAP_TIMEOUT_MS = 180000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// db フォルダの「いま」の状態を表す文字列。前回の生成時と同じなら、作り直しても結果は変わらない
async function dbStamp(worldId) {
  const dir = path.join(worldsDir(), worldId, 'db');
  let latest = 0;
  let total = 0;
  for (const name of await fs.readdir(dir)) {
    if (!/\.(ldb|sst|log)$/.test(name)) continue;
    try {
      const st = await fs.stat(path.join(dir, name));
      latest = Math.max(latest, st.mtimeMs);
      total += st.size;
    } catch { /* 読んでいる間に消えたファイルは数えない */ }
  }
  return `${Math.round(latest)}:${total}`;
}

// ワールドの保存データから背景地図を作り、プリセットとして保存する
// size: 'auto' か WORLDMAP_SIZES のいずれか。select: 作った背景を選択中にするか
async function generateWorldMap({ worldId, size, center, select = true }) {
  const world = listWorlds().find(w => w.id === worldId);
  if (!world) throw new HttpError(404, 'world not found');
  const auto = size === 'auto';
  if (!auto && !WORLDMAP_SIZES.includes(size)) throw new HttpError(400, 'invalid size');
  if (worldMapBusy) throw new HttpError(409, '別の地図を生成中です');

  const worldPath = path.join(worldsDir(), world.id);
  worldMapBusy = true;
  const t0 = Date.now();
  try {
    const stamp = await dbStamp(world.id).catch(() => '');
    const result = auto
      ? await runWorldMapRender('auto', { worldPath, center })
      : await runWorldMapRender('render', { worldPath, minX: Math.floor(center.x) - size / 2, minZ: Math.floor(center.z) - size / 2, size });
    const durationMs = Date.now() - t0;
    console.log(`[worldmap] ${world.name} ${result.width}x${result.height} を生成（${result.chunkCount} チャンク, ${durationMs}ms）`);
    if (!result.chunkCount) throw new HttpError(422, 'この範囲には保存済みの地形がありません');

    // 自動記録で「もう保存されているチャンク」を飛ばすために覚えておく
    savedChunks = new Set(result.savedChunks || []);
    savedChunksWorldId = world.id;

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
      width, height, chunkCount: result.chunkCount, generatedAt: Date.now(), dbStamp: stamp, durationMs
    };
    // 生成のたびにファイル名を変え、ブラウザに古い画像が残らないようにする
    const file = `${preset.id}-${Date.now()}.png`;
    await fs.mkdir(presetDir(), { recursive: true });
    await fs.writeFile(path.join(presetDir(), file), result.png);
    if (preset.file && preset.file !== file) await fs.rm(path.join(presetDir(), preset.file), { force: true });
    preset.file = file;
    if (select) store.selectedId = preset.id;
    await savePresetStore(store);
    return { preset, selectedId: store.selectedId, extent: result.extent || null };
  } finally {
    worldMapBusy = false;
  }
}

httpApp.post('/api/worldmap', async (req, res) => {
  const worldId = (req.body?.worldId || '').toString();
  const size = req.body?.size === 'auto' ? 'auto' : Number(req.body?.size);
  try {
    let center;
    if (req.body?.center === 'teacher') {
      const pos = players.get(teacherName)?.pos;
      if (!pos) throw new HttpError(400, '先生の現在地がまだ分かりません（/connect 後に少し動いてください）');
      center = { x: pos.x, z: pos.z };
    } else {
      const info = readLevelInfo(path.join(worldsDir(), path.basename(worldId)));
      center = { x: info.spawnX, z: info.spawnZ };
    }
    res.json({ ok: true, ...(await generateWorldMap({ worldId, size, center })) });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error('[worldmap] 生成に失敗しました', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 選択中の背景を、前回と同じ条件で作り直す（「更新」ボタンと自動更新で使う）
async function regenerateSelectedMap({ onlyIfChanged = false } = {}) {
  const store = await loadPresetStore();
  const preset = store.presets.find(p => p.id === store.selectedId);
  const src = preset?.source;
  if (!src?.worldId) throw new HttpError(400, 'ワールドから生成した背景を選んでください');
  if (onlyIfChanged) {
    const stamp = await dbStamp(src.worldId).catch(() => null);
    if (!stamp || stamp === src.dbStamp) return null;
  }
  const result = await generateWorldMap({
    worldId: src.worldId, size: src.size === 'auto' ? 'auto' : Number(src.size),
    center: { x: Number(src.centerX) || 0, z: Number(src.centerZ) || 0 }, select: false
  });
  sseBroadcast('map', { presetId: result.preset.id });
  return result;
}

httpApp.post('/api/worldmap/refresh', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await regenerateSelectedMap()) });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error('[worldmap] 更新に失敗しました', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 自動更新：接続中、保存データが変わっていたら作り直す。生成に時間がかかるワールドほど間隔を空ける
const AUTO_REFRESH_CHECK_MS = 15000;
const AUTO_REFRESH_MIN_MS = 60000;
let autoRefreshRunning = false;
setInterval(async () => {
  if (!settings.autoRefreshMap || !meeSocket || worldMapBusy || autoRefreshRunning) return;
  autoRefreshRunning = true;
  try {
    const store = await loadPresetStore();
    const src = store.presets.find(p => p.id === store.selectedId)?.source;
    if (!src?.worldId) return;
    const wait = Math.max(AUTO_REFRESH_MIN_MS, (Number(src.durationMs) || 0) * 10);
    if (Date.now() - (Number(src.generatedAt) || 0) < wait) return;
    await regenerateSelectedMap({ onlyIfChanged: true });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error('[worldmap] 自動更新に失敗しました', err);
  } finally {
    autoRefreshRunning = false;
  }
}, AUTO_REFRESH_CHECK_MS);

/* =========================
   自動記録：歩いた場所を地図に残す
   Minecraft は「ブロックが変化したチャンク」しか保存しないため、歩いただけの場所は地図に出ない。
   そこで、プレイヤー周辺のチャンクの最上部に見えないブロックを置いてすぐ戻し、ゲームに保存させる。
   空気だけを置き換え、戻すときは置いたブロックだけを消すので、建築物には触れない
   ========================= */
const RECORD_RADIUS = 4;          // プレイヤーの周囲何チャンクまで記録するか
const RECORD_SCAN_MS = 5000;
const RECORD_DRAIN_MS = 250;
const RECORD_PER_DRAIN = 2;
const RECORD_MAX_TRIES = 3;
const RECORD_BLOCK = 'barrier';
let savedChunks = new Set();      // 最後の地図生成で保存済みと分かったチャンク（"cx,cz"）
let savedChunksWorldId = null;
let currentWorld = { id: null, at: 0 };
const touchedChunks = new Set();  // この接続で処理したチャンク
const queuedChunks = new Set();
let touchQueue = [];
const touchTries = new Map();
// y: ブロックを置く高さ（新しいワールドは 319、古い形式は 255）。disabled: このワールドでは使えないと判断した
const recordState = { y: 319, ok: 0, fail: 0, disabled: false };

function recordStatus() {
  return {
    queued: touchQueue.length,
    done: recordState.ok,
    disabled: recordState.disabled
  };
}
let lastRecordStatus = '';
function pushRecordStatus() {
  const status = recordStatus();
  const text = JSON.stringify(status);
  if (text === lastRecordStatus) return;
  lastRecordStatus = text;
  sseBroadcast('record', status);
}

function resetRecord() {
  touchedChunks.clear();
  queuedChunks.clear();
  touchTries.clear();
  touchQueue = [];
  Object.assign(recordState, { y: 319, ok: 0, fail: 0, disabled: false });
}

function inOverworld(pos) {
  return !!pos && (pos.dim == null || pos.dim === 0);
}

// いま開いているワールド（最後に保存されたもの）の地図を作ってあれば、保存済みのチャンクは飛ばせる
function knownSavedChunks() {
  const now = Date.now();
  if (now - currentWorld.at > 60000) currentWorld = { id: listWorlds()[0]?.id ?? null, at: now };
  return savedChunksWorldId && savedChunksWorldId === currentWorld.id ? savedChunks : null;
}

function scanRecordTargets() {
  if (!settings.autoRecord || !meeSocket || recordState.disabled) return;
  // コマンドは先生のいるディメンションで実行されるので、先生が地上にいる間だけ行う
  if (!inOverworld(players.get(teacherName)?.pos)) return;
  const saved = knownSavedChunks();
  const found = [];
  for (const p of players.values()) {
    if (!inOverworld(p.pos)) continue;
    const pcx = Math.floor(p.pos.x / 16);
    const pcz = Math.floor(p.pos.z / 16);
    for (let dx = -RECORD_RADIUS; dx <= RECORD_RADIUS; dx++) {
      for (let dz = -RECORD_RADIUS; dz <= RECORD_RADIUS; dz++) {
        const key = `${pcx + dx},${pcz + dz}`;
        if (touchedChunks.has(key) || queuedChunks.has(key) || saved?.has(key)) continue;
        if ((touchTries.get(key) || 0) >= RECORD_MAX_TRIES) continue;
        queuedChunks.add(key);
        found.push({ key, d: dx * dx + dz * dz });
      }
    }
  }
  // プレイヤーに近いチャンクから先に処理する
  found.sort((a, b) => a.d - b.d);
  for (const f of found) touchQueue.push(f.key);
  pushRecordStatus();
}

// 読み込まれているのはプレイヤーの近くだけ。離れてしまったチャンクは見送る（近づいたらまた対象になる）
function nearAnyPlayer(cx, cz) {
  for (const p of players.values()) {
    if (!inOverworld(p.pos)) continue;
    if (Math.abs(Math.floor(p.pos.x / 16) - cx) <= RECORD_RADIUS + 1 && Math.abs(Math.floor(p.pos.z / 16) - cz) <= RECORD_RADIUS + 1) return true;
  }
  return false;
}

function drainRecordQueue() {
  if (!touchQueue.length) return;
  if (!settings.autoRecord || !meeSocket || recordState.disabled) {
    touchQueue = [];
    queuedChunks.clear();
    return pushRecordStatus();
  }
  for (let i = 0; i < RECORD_PER_DRAIN && touchQueue.length; i++) {
    // 名簿・位置の取得を邪魔しないよう、応答待ちが溜まっているときは休む
    if (pendingRequests.size > MAX_PENDING / 2) break;
    const key = touchQueue.shift();
    queuedChunks.delete(key);
    const [cx, cz] = key.split(',').map(Number);
    if (nearAnyPlayer(cx, cz)) touchChunk(key, cx, cz);
  }
  pushRecordStatus();
}

function touchChunk(key, cx, cz) {
  const x = cx * 16 + 8;
  const z = cz * 16 + 8;
  const y = recordState.y;
  const at = `${x} ${y} ${z} ${x} ${y} ${z}`;
  touchedChunks.add(key);
  sendCommand(`fill ${at} ${RECORD_BLOCK} replace air`, (body) => {
    if (body?.statusCode === 0) {
      recordState.ok++;
      sendCommand(`fill ${at} air replace ${RECORD_BLOCK}`, noop);
      return;
    }
    // 失敗：読み込まれていない、最上部が空気でない、など。回数を限ってやり直す
    touchedChunks.delete(key);
    touchTries.set(key, (touchTries.get(key) || 0) + 1);
    recordState.fail++;
    if (recordState.ok > 0 || recordState.fail < 8) return;
    // 一度も成功しないまま失敗が続く：高さを変えて試し、それでも駄目ならこのワールドでは諦める
    if (recordState.y === 319) {
      console.log('[record] y=319 に置けないため y=255 で試します:', body?.statusMessage ?? '');
      recordState.y = 255;
      recordState.fail = 0;
      touchTries.clear();
    } else {
      console.log('[record] このワールドでは自動記録が使えません:', body?.statusMessage ?? '');
      recordState.disabled = true;
    }
  });
}
setInterval(scanRecordTargets, RECORD_SCAN_MS);
setInterval(drainRecordQueue, RECORD_DRAIN_MS);

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
  // 接続し直された場合、古い接続は閉じる（閉じないと古い方のイベントも処理し続けてしまう）
  const old = meeSocket;
  meeSocket = ws;
  if (old && old !== ws) {
    try { old.terminate(); } catch { /* すでに閉じている */ }
  }
  pendingRequests.clear();
  meeLink = { state: 'handshake', queue: [], cipher: null, decipher: null };
  const link = meeLink;
  lastRecvAt = Date.now();
  meeStalled = false;
  resetRecord();
  console.log('Minecraft Education connected');
  pushState();
  ws.on('error', (err) => console.error('[ws] 通信エラー', err.message));

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
  // 授業準備の各項目がいまどうなっているかを読む
  worldRules = Object.fromEntries(Object.keys(PREP_RULES).map(k => [k, null]));
  refreshWorldRules();

  ws.on('message', (buf) => {
    if (meeSocket !== ws) return;
    lastRecvAt = Date.now();
    if (meeStalled) {
      meeStalled = false;
      pushState();
    }
    // 1 通の処理で例外が出ても、接続とアプリは動かし続ける
    try {
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
    } catch (err) {
      console.error('[recv] 処理中にエラー', err);
    }
  });

  ws.on('close', (code, reason) => {
    console.log('Minecraft disconnected', code, reason?.toString() || '');
    if (meeSocket !== ws) return;
    meeSocket = null;
    meeLink = null;
    meeStalled = false;
    teacherName = '';
    stopPolling();
    stopPauseTimer();
    pendingRequests.clear();
    resetRecord();
    pushState();
  });
});

// 一定時間なにも届かないときは画面に知らせる。ゲームの一時停止（メニューを開いている等）でも
// 起きるので、こちらから切断はしない（切ると /connect の打ち直しが必要になる）
setInterval(() => {
  if (!meeSocket || meeStalled) return;
  if (Date.now() - lastRecvAt < STALL_MS) return;
  meeStalled = true;
  pushState();
}, 5000);

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
      // タイトルやアクションバーの表示（タイマーの残り時間など）は発言ではないので載せない
      if (ev.body?.type === 'title') break;
      const n = findPlayerName(ev) || 'Unknown';
      const m = findChatMessage(ev);
      if (!m) break;
      const cleanedMessage = normalizeChatMessage(n, m);
      if (shouldSuppressChatMessage(cleanedMessage)) break;
      const entry = { id: uuidv4(), t: Date.now(), player: n, message: cleanedMessage };
      chatLog.push(entry);
      if (chatLog.length > 100) chatLog.shift();
      chatArchive.push(entry);
      if (chatArchive.length > CHAT_ARCHIVE_MAX) chatArchive.shift();
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
let quitConfirmed = false;

function createWindow() {
  const win = new BrowserWindow({
    width: 900, height: 680,
    webPreferences: { sandbox: true }
  });
  const url = `http://127.0.0.1:${HTTP_PORT}/`;
  win.loadURL(url);
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url); return { action: 'deny' };
  });
  // 起動直後など画面を読み込めなかったときは、白い画面のままにせず読み込み直す
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: 読み込みの中断（再読み込み時など）
    console.error('[window] 読み込みに失敗:', code, desc);
    setTimeout(() => { if (!win.isDestroyed()) win.loadURL(url); }, 1000);
  });
  // 画面のプロセスが落ちたら読み込み直す。起動自体ができない環境で繰り返さないよう、回数を限る
  let reloads = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[window] 画面のプロセスが終了しました:', details.reason);
    if (details.reason === 'clean-exit' || details.reason === 'launch-failed') return;
    if (++reloads > 3) return;
    setTimeout(() => { if (!win.isDestroyed()) win.loadURL(url); }, 1000);
  });
  // 生徒を停止させたまま閉じると、解除する手段がなくなる。閉じる前に確認する
  win.on('close', (e) => {
    if (quitConfirmed || !meeSocket || (!pauseOn && !timer)) return;
    e.preventDefault();
    let release = true;
    if (pauseOn) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        title: 'MEE Teacher Panel',
        message: '生徒が停止中です',
        detail: 'このまま終了すると、生徒は動けないままになります。停止を解除してから終了しますか？',
        buttons: ['解除して終了', '停止したまま終了', 'キャンセル'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      });
      if (choice === 2) return;
      release = choice === 0;
    }
    quitConfirmed = true;
    if (release && pauseOn) doPauseOff();
    // タイマーの夕暮れ演出で止めた時間の流れを戻す
    clearTimer();
    // 送ったコマンドがゲームに届くのを少し待ってから閉じる
    setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 700);
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
