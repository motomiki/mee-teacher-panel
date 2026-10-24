// worldmap.js  (ESM)
// Minecraft Education（Bedrock）のワールド保存データ（LevelDB）を直接読み、真上から見た地図画像（PNG）を作る。
// main.js からワーカースレッドとして起動され、結果を postMessage で返す（重い処理で UI や WebSocket を止めないため）。
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { parentPort, workerData } from 'worker_threads';

/* =========================
   ワールド一覧・level.dat
   ========================= */
export function worldsDir() {
  const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return path.join(local, 'Packages', 'Microsoft.MinecraftEducationEdition_8wekyb3d8bbwe',
    'LocalState', 'games', 'com.mojang', 'minecraftWorlds');
}

export function listWorlds() {
  const base = worldsDir();
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const worlds = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(base, e.name);
    if (!fs.existsSync(path.join(dir, 'db'))) continue;
    let name = e.name;
    try { name = fs.readFileSync(path.join(dir, 'levelname.txt'), 'utf8').trim() || e.name; } catch { /* ID のまま */ }
    let modified = 0;
    try { modified = fs.statSync(path.join(dir, 'level.dat')).mtimeMs; } catch { /* 不明 */ }
    worlds.push({ id: e.name, name, modified });
  }
  return worlds.sort((a, b) => b.modified - a.modified);
}

// level.dat は 8 バイトのヘッダ（版・長さ）の後にリトルエンディアン NBT が続く
export function readLevelInfo(worldPath) {
  try {
    const buf = fs.readFileSync(path.join(worldPath, 'level.dat'));
    const root = readNbt(buf, 8).value;
    return {
      name: typeof root.LevelName === 'string' ? root.LevelName : '',
      spawnX: Number.isFinite(root.SpawnX) ? root.SpawnX : 0,
      spawnZ: Number.isFinite(root.SpawnZ) ? root.SpawnZ : 0
    };
  } catch {
    return { name: '', spawnX: 0, spawnZ: 0 };
  }
}

/* =========================
   NBT（リトルエンディアン）
   ========================= */
function readNbt(buf, start = 0) {
  let pos = start;
  const u8 = () => buf[pos++];
  const str = () => {
    const len = buf.readUInt16LE(pos);
    pos += 2;
    const s = buf.toString('utf8', pos, pos + len);
    pos += len;
    return s;
  };
  const payload = (type) => {
    switch (type) {
      case 1: { const v = buf.readInt8(pos); pos += 1; return v; }
      case 2: { const v = buf.readInt16LE(pos); pos += 2; return v; }
      case 3: { const v = buf.readInt32LE(pos); pos += 4; return v; }
      case 4: { const v = buf.readBigInt64LE(pos); pos += 8; return v; }
      case 5: { const v = buf.readFloatLE(pos); pos += 4; return v; }
      case 6: { const v = buf.readDoubleLE(pos); pos += 8; return v; }
      case 7: { const n = buf.readInt32LE(pos); pos += 4; const v = buf.subarray(pos, pos + n); pos += n; return v; }
      case 8: return str();
      case 9: {
        const t = u8();
        const n = buf.readInt32LE(pos);
        pos += 4;
        const list = [];
        for (let i = 0; i < n; i++) list.push(payload(t));
        return list;
      }
      case 10: {
        const obj = {};
        for (;;) {
          const t = u8();
          if (t === 0) break;
          const name = str();
          obj[name] = payload(t);
        }
        return obj;
      }
      case 11: { const n = buf.readInt32LE(pos); pos += 4; const v = []; for (let i = 0; i < n; i++, pos += 4) v.push(buf.readInt32LE(pos)); return v; }
      case 12: { const n = buf.readInt32LE(pos); pos += 4; pos += n * 8; return null; }
      default: throw new Error(`unknown NBT tag ${type}`);
    }
  };
  const type = u8();
  if (type === 0) return { value: null, end: pos };
  str();
  const value = payload(type);
  return { value, end: pos };
}

/* =========================
   LevelDB（読み取り専用の最小実装）
   ========================= */
function readVarint(buf, pos) {
  let result = 0;
  let mul = 1;
  for (;;) {
    const b = buf[pos++];
    result += (b & 0x7f) * mul;
    if (b < 0x80) return [result, pos];
    mul *= 128;
  }
}

// Bedrock の LevelDB は zlib（2）または raw deflate（4）で圧縮されたブロックを使う
function decompressBlock(type, data) {
  if (type === 0) return data;
  if (type === 2) return zlib.inflateSync(data);
  if (type === 4) return zlib.inflateRawSync(data);
  throw new Error(`unsupported compression ${type}`);
}

function readBlock(fd, offset, size) {
  const raw = Buffer.alloc(size + 5);
  fs.readSync(fd, raw, 0, size + 5, offset);
  return decompressBlock(raw[size], raw.subarray(0, size));
}

// ブロック内のエントリ（先頭一致圧縮されたキー）を順に返す
function* blockEntries(block) {
  const numRestarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - numRestarts * 4;
  let pos = 0;
  let key = Buffer.alloc(0);
  while (pos < end) {
    let shared, nonShared, valueLen;
    [shared, pos] = readVarint(block, pos);
    [nonShared, pos] = readVarint(block, pos);
    [valueLen, pos] = readVarint(block, pos);
    key = Buffer.concat([key.subarray(0, shared), block.subarray(pos, pos + nonShared)]);
    pos += nonShared;
    const value = block.subarray(pos, pos + valueLen);
    pos += valueLen;
    yield [key, value];
  }
}

// 内部キー = ユーザーキー + 8バイト（シーケンス番号 << 8 | 種別）
function splitInternalKey(ikey) {
  const n = ikey.length - 8;
  const trailer = ikey.readBigUInt64LE(n);
  return { userKey: ikey.subarray(0, n), seq: Number(trailer >> 8n), type: Number(trailer & 0xffn) };
}

// sorted（昇順の Buffer 配列）に lo <= t <= hi となる要素があるか
function anyInRange(sorted, lo, hi) {
  let a = 0;
  let b = sorted.length;
  if (lo) {
    while (a < b) {
      const m = (a + b) >> 1;
      if (Buffer.compare(sorted[m], lo) < 0) a = m + 1;
      else b = m;
    }
  }
  return a < sorted.length && Buffer.compare(sorted[a], hi) <= 0;
}

const TABLE_MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);

// SSTable（.ldb）を読み、目的のキーを含みうるデータブロックだけを展開する（targets が null なら全ブロック）
function scanTable(file, targets, onEntry) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 48) return;
    const footer = Buffer.alloc(48);
    fs.readSync(fd, footer, 0, 48, size - 48);
    if (!footer.subarray(40).equals(TABLE_MAGIC)) return;
    let pos = 0;
    [, pos] = readVarint(footer, pos); // metaindex offset
    [, pos] = readVarint(footer, pos); // metaindex size
    let indexOffset, indexSize;
    [indexOffset, pos] = readVarint(footer, pos);
    [indexSize, pos] = readVarint(footer, pos);
    const index = readBlock(fd, indexOffset, indexSize);
    let prev = null;
    for (const [sepKey, handle] of blockEntries(index)) {
      const sep = sepKey.length >= 8 ? sepKey.subarray(0, sepKey.length - 8) : sepKey;
      const lo = prev;
      prev = Buffer.from(sep);
      if (targets && !anyInRange(targets, lo, sep)) continue;
      let p = 0, off, len;
      [off, p] = readVarint(handle, p);
      [len, p] = readVarint(handle, p);
      const block = readBlock(fd, off, len);
      for (const [ikey, value] of blockEntries(block)) {
        if (ikey.length < 8) continue;
        const { userKey, seq, type } = splitInternalKey(ikey);
        onEntry(userKey, value, seq, type === 1);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

// ログ（.log）：32KB ブロック単位のレコードを繋げると WriteBatch になる
function scanLog(file, onEntry) {
  const buf = fs.readFileSync(file);
  const BLOCK = 32768;
  let pos = 0;
  let parts = [];
  while (pos + 7 <= buf.length) {
    const left = BLOCK - (pos % BLOCK);
    if (left < 7) { pos += left; continue; }
    const len = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6];
    const data = buf.subarray(pos + 7, pos + 7 + len);
    pos += 7 + len;
    if (type === 0 && len === 0) continue; // 事前確保された領域
    if (type === 1) parts = [data];
    else if (type === 2) { parts = [data]; continue; }
    else if (type === 3) { parts.push(data); continue; }
    else if (type === 4) parts.push(data);
    else continue;
    applyBatch(Buffer.concat(parts), onEntry);
    parts = [];
  }
}

function applyBatch(batch, onEntry) {
  if (batch.length < 12) return;
  let seq = Number(batch.readBigUInt64LE(0));
  const count = batch.readUInt32LE(8);
  let pos = 12;
  try {
    for (let i = 0; i < count; i++, seq++) {
      const tag = batch[pos++];
      let klen, vlen;
      [klen, pos] = readVarint(batch, pos);
      const key = batch.subarray(pos, pos + klen);
      pos += klen;
      if (tag === 1) {
        [vlen, pos] = readVarint(batch, pos);
        onEntry(key, batch.subarray(pos, pos + vlen), seq, true);
        pos += vlen;
      } else {
        onEntry(key, null, seq, false);
      }
    }
  } catch { /* 書き込み途中の末尾は無視 */ }
}

/* =========================
   チャンク（SubChunk）の解析
   ========================= */
const SUBCHUNK_TAG = 0x2f; // 47: SubChunkPrefix
const SUB_MIN = -4;        // 1.18 以降の地上世界は y=-64..319（サブチャンク -4..19）
const SUB_MAX = 19;

function subChunkKey(cx, cz, sy) {
  const k = Buffer.alloc(10);
  k.writeInt32LE(cx, 0);
  k.writeInt32LE(cz, 4);
  k[8] = SUBCHUNK_TAG;
  k.writeInt8(sy, 9);
  return k;
}

// 先頭のブロック層だけを読み、{ indices, palette } を返す。index = (x << 8) | (z << 4) | y
function decodeSubChunk(buf) {
  let pos = 0;
  const version = buf[pos++];
  if (version !== 1 && version !== 8 && version !== 9) return null;
  if (version !== 1) pos++;      // 層の数
  if (version === 9) pos++;      // y 位置
  const header = buf[pos++];
  if (header & 1) return null;   // 実行時 ID 形式（保存データでは使われない）
  const bits = header >> 1;
  let indices = null;
  if (bits > 0) {
    const perWord = Math.floor(32 / bits);
    const words = Math.ceil(4096 / perWord);
    const mask = (1 << bits) - 1;
    indices = new Uint16Array(4096);
    let i = 0;
    for (let w = 0; w < words; w++, pos += 4) {
      const word = buf.readUInt32LE(pos);
      for (let j = 0; j < perWord && i < 4096; j++) indices[i++] = (word >>> (j * bits)) & mask;
    }
  }
  // 1種類だけの層ではパレット数が省略されることがある
  let count = 1;
  const peek = pos + 4 <= buf.length ? buf.readInt32LE(pos) : -1;
  if (peek >= 1 && peek <= 4096) {
    count = peek;
    pos += 4;
  }
  const palette = [];
  for (let i = 0; i < count; i++) {
    const { value, end } = readNbt(buf, pos);
    pos = end;
    palette.push(value || {});
  }
  return { indices, palette };
}

/* =========================
   ブロックの色
   ========================= */
const DYE = [
  ['light_blue', [58, 175, 217]], ['light_gray', [142, 142, 134]], ['silver', [142, 142, 134]],
  ['white', [233, 236, 236]], ['orange', [240, 118, 19]], ['magenta', [189, 68, 179]],
  ['yellow', [248, 197, 39]], ['lime', [112, 185, 25]], ['pink', [237, 141, 172]],
  ['gray', [62, 68, 71]], ['cyan', [21, 137, 145]], ['purple', [121, 42, 172]],
  ['blue', [53, 57, 157]], ['brown', [114, 71, 40]], ['green', [84, 109, 27]],
  ['red', [160, 39, 34]], ['black', [20, 21, 25]]
];
// 上から順に、名前に含まれる語で判定する
const BLOCK_COLORS = [
  ['water', [63, 118, 228]], ['lava', [220, 95, 20]], ['magma', [140, 60, 20]],
  ['leaves', [56, 112, 40]], ['azalea', [80, 130, 50]], ['vine', [60, 110, 40]],
  ['grass_block', [109, 160, 62]], ['grass_path', [148, 122, 65]], ['dirt_path', [148, 122, 65]],
  ['seagrass', [50, 100, 80]], ['kelp', [50, 100, 60]], ['lily_pad', [40, 120, 40]],
  ['short_grass', [100, 150, 55]], ['tall_grass', [100, 150, 55]], ['tallgrass', [100, 150, 55]],
  ['fern', [90, 140, 50]], ['minecraft:grass', [109, 160, 62]],
  ['snow', [240, 250, 250]], ['powder_snow', [240, 250, 250]], ['packed_ice', [140, 175, 240]],
  ['blue_ice', [120, 160, 240]], ['ice', [160, 190, 250]],
  ['red_sandstone', [180, 98, 40]], ['red_sand', [190, 102, 33]], ['sandstone', [216, 203, 155]], ['sand', [219, 207, 163]],
  ['gravel', [136, 126, 126]], ['clay', [160, 166, 179]], ['mud', [60, 57, 60]],
  ['farmland', [120, 82, 52]], ['podzol', [106, 75, 40]], ['mycelium', [111, 99, 105]],
  ['dirt', [134, 96, 67]],
  ['concrete_powder', null], ['concrete', null], ['wool', null], ['carpet', null], ['terracotta', null],
  ['stained_glass', null], ['glass', [200, 220, 230]],
  ['birch', [196, 176, 118]], ['spruce', [104, 78, 47]], ['dark_oak', [66, 43, 20]], ['jungle', [160, 115, 80]],
  ['acacia', [168, 90, 50]], ['mangrove', [117, 54, 48]], ['cherry', [226, 178, 172]], ['bamboo', [190, 175, 80]],
  ['crimson', [148, 63, 97]], ['warped', [43, 104, 99]],
  ['log', [102, 76, 50]], ['wood', [102, 76, 50]], ['planks', [162, 130, 78]], ['fence', [162, 130, 78]],
  ['crop', [120, 160, 50]], ['wheat', [200, 180, 80]], ['carrots', [120, 160, 50]], ['potatoes', [120, 160, 50]],
  ['pumpkin', [220, 130, 30]], ['melon', [120, 170, 40]], ['hay', [200, 170, 40]],
  ['flower', [180, 70, 70]], ['poppy', [180, 50, 40]], ['dandelion', [230, 210, 60]], ['tulip', [200, 90, 90]],
  ['brick', [150, 85, 70]], ['quartz', [235, 230, 222]], ['prismarine', [99, 156, 151]],
  ['granite', [150, 103, 85]], ['diorite', [188, 188, 188]], ['andesite', [136, 136, 136]],
  ['deepslate', [80, 80, 82]], ['blackstone', [42, 36, 41]], ['netherrack', [111, 54, 52]],
  ['obsidian', [20, 18, 30]], ['bedrock', [85, 85, 85]], ['iron', [210, 210, 210]],
  ['gold', [240, 210, 70]], ['coal', [50, 50, 50]], ['copper', [190, 110, 80]],
  ['stone', [125, 125, 125]], ['cobble', [120, 120, 120]], ['ore', [125, 125, 125]], ['tuff', [108, 109, 102]]
];
const TRANSPARENT = new Set([
  'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:barrier',
  'minecraft:structure_void', 'minecraft:light_block', 'minecraft:border_block'
]);
const DEFAULT_COLOR = [140, 140, 140];

function dyeColor(text) {
  for (const [word, rgb] of DYE) if (text.includes(word)) return rgb;
  return null;
}

// null は「透明（下のブロックを見る）」
function blockColor(entry) {
  const name = typeof entry.name === 'string' ? entry.name : '';
  if (!name || TRANSPARENT.has(name) || name.startsWith('minecraft:light_block')) return null;
  const local = name.replace(/^minecraft:/, '');
  for (const [word, rgb] of BLOCK_COLORS) {
    if (!(word.includes(':') ? name : local).includes(word)) continue;
    if (rgb) return rgb;
    // 染色ブロック：名前（white_wool など）か、旧形式の color ステート
    const state = entry.states && (entry.states.color || entry.states.color_bit);
    return dyeColor(local) || (typeof state === 'string' && dyeColor(state)) || [200, 200, 200];
  }
  return DEFAULT_COLOR;
}

function isWater(entry) {
  return entry.name === 'minecraft:water' || entry.name === 'minecraft:flowing_water';
}

/* =========================
   PNG 出力
   ========================= */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/* =========================
   地図の生成
   ========================= */
// db フォルダ内の全ファイルを読む
function scanDb(dbDir, targets, onEntry) {
  for (const name of fs.readdirSync(dbDir)) {
    const file = path.join(dbDir, name);
    try {
      if (name.endsWith('.ldb') || name.endsWith('.sst')) scanTable(file, targets, onEntry);
      else if (name.endsWith('.log')) scanLog(file, onEntry);
    } catch (err) {
      console.warn('[worldmap] 読み込みに失敗:', name, err.message);
    }
  }
}

// 地形が保存されているチャンクの範囲（ブロック座標）。保存済みのチャンクがなければ null
export function scanChunkExtent(worldPath) {
  const latest = new Map();
  scanDb(path.join(worldPath, 'db'), null, (key, _value, seq, alive) => {
    if (key.length !== 10 || key[8] !== SUBCHUNK_TAG) return;
    const id = key.toString('latin1');
    const cur = latest.get(id);
    if (cur && cur.seq > seq) return;
    latest.set(id, { seq, alive, cx: key.readInt32LE(0), cz: key.readInt32LE(4) });
  });
  const seen = new Set();
  let cx0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cz1 = -Infinity;
  for (const rec of latest.values()) {
    if (!rec.alive) continue;
    seen.add(`${rec.cx},${rec.cz}`);
    cx0 = Math.min(cx0, rec.cx); cx1 = Math.max(cx1, rec.cx);
    cz0 = Math.min(cz0, rec.cz); cz1 = Math.max(cz1, rec.cz);
  }
  if (!seen.size) return null;
  return { minX: cx0 * 16, minZ: cz0 * 16, maxX: cx1 * 16 + 15, maxZ: cz1 * 16 + 15, chunkCount: seen.size };
}

// 保存済みの地形すべてが入る範囲を決める。1辺が maxSize を超える場合は center を含むように切り詰める
export function autoRange(extent, center, { margin = 16, maxSize = 2048 } = {}) {
  const axis = (lo, hi, c) => {
    lo -= margin;
    hi += margin;
    let len = hi - lo + 1;
    if (len > maxSize) {
      const mid = Math.min(Math.max(Math.floor(c), lo + maxSize / 2), hi - maxSize / 2 + 1);
      lo = mid - maxSize / 2;
      len = maxSize;
    }
    return [lo, len];
  };
  const [minX, width] = axis(extent.minX, extent.maxX, center.x);
  const [minZ, height] = axis(extent.minZ, extent.maxZ, center.z);
  return { minX, minZ, width, height };
}

// 指定範囲（ブロック座標 minX..minX+width-1, minZ..minZ+height-1）を 1ブロック = 1px で描く
export function renderWorldMap({ worldPath, minX, minZ, size, width = size, height = size }) {
  const dbDir = path.join(worldPath, 'db');
  const cx0 = Math.floor(minX / 16);
  const cz0 = Math.floor(minZ / 16);
  const cx1 = Math.floor((minX + width - 1) / 16);
  const cz1 = Math.floor((minZ + height - 1) / 16);

  const targets = [];
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let sy = SUB_MIN; sy <= SUB_MAX; sy++) targets.push(subChunkKey(cx, cz, sy));
    }
  }
  targets.sort(Buffer.compare);

  // 同じキーはシーケンス番号の大きい方（新しい方）を採用する
  const latest = new Map();
  const onEntry = (key, value, seq, alive) => {
    if (key.length !== 10 || key[8] !== SUBCHUNK_TAG) return;
    const cx = key.readInt32LE(0);
    const cz = key.readInt32LE(4);
    if (cx < cx0 || cx > cx1 || cz < cz0 || cz > cz1) return;
    const id = `${cx},${cz},${key.readInt8(9)}`;
    const cur = latest.get(id);
    if (cur && cur.seq > seq) return;
    latest.set(id, { seq, value: alive ? Buffer.from(value) : null });
  };

  scanDb(dbDir, targets, onEntry);

  // チャンクごとに、存在するサブチャンクを上から並べる
  const chunks = new Map();
  for (const [id, rec] of latest) {
    if (!rec.value) continue;
    const [cx, cz, sy] = id.split(',').map(Number);
    const ck = `${cx},${cz}`;
    if (!chunks.has(ck)) chunks.set(ck, []);
    chunks.get(ck).push({ sy, buf: rec.value, decoded: undefined });
  }

  const rgba = Buffer.alloc(width * height * 4);
  const heights = new Int16Array(width * height).fill(-32768);
  const waterDepth = new Uint8Array(width * height);
  let chunkCount = 0;

  for (const [ck, subs] of chunks) {
    subs.sort((a, b) => b.sy - a.sy);
    const [cx, cz] = ck.split(',').map(Number);
    chunkCount++;
    for (let lx = 0; lx < 16; lx++) {
      const wx = cx * 16 + lx;
      const px = wx - minX;
      if (px < 0 || px >= width) continue;
      for (let lz = 0; lz < 16; lz++) {
        const wz = cz * 16 + lz;
        const py = wz - minZ;
        if (py < 0 || py >= height) continue;
        let color = null;
        let topY = null;
        let depth = 0;
        outer:
        for (const sub of subs) {
          if (sub.decoded === undefined) {
            try { sub.decoded = decodeSubChunk(sub.buf); } catch { sub.decoded = null; }
          }
          const d = sub.decoded;
          if (!d) continue;
          for (let ly = 15; ly >= 0; ly--) {
            const entry = d.palette[d.indices ? d.indices[(lx << 8) | (lz << 4) | ly] : 0];
            if (!entry) continue;
            if (isWater(entry)) {
              if (topY === null) { topY = sub.sy * 16 + ly; color = blockColor(entry); }
              depth++;
              if (depth >= 12) break outer;
              continue;
            }
            const c = blockColor(entry);
            if (!c) continue;
            if (topY === null) { topY = sub.sy * 16 + ly; color = c; }
            break outer;
          }
        }
        if (!color) continue;
        const i = py * width + px;
        heights[i] = topY;
        waterDepth[i] = depth;
        rgba[i * 4] = color[0];
        rgba[i * 4 + 1] = color[1];
        rgba[i * 4 + 2] = color[2];
        rgba[i * 4 + 3] = 255;
      }
    }
  }

  // 陰影：北隣より高ければ明るく、低ければ暗く（公式の地図と同じ考え方）。水は深さで暗くする
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const i = py * width + px;
      if (!rgba[i * 4 + 3]) continue;
      let f = 1;
      if (waterDepth[i]) {
        f = 1.1 - Math.min(waterDepth[i], 12) * 0.04;
      } else if (py > 0 && heights[i - width] !== -32768) {
        const dh = heights[i] - heights[i - width];
        f = dh > 0 ? 1.12 : dh < 0 ? 0.82 : 1;
      }
      if (f === 1) continue;
      for (let k = 0; k < 3; k++) rgba[i * 4 + k] = Math.max(0, Math.min(255, Math.round(rgba[i * 4 + k] * f)));
    }
  }

  return { png: encodePng(rgba, width, height), minX, minZ, width, height, chunkCount };
}

// 範囲を保存済みの地形から自動で決めて描く。center は範囲を切り詰めるときの基準
export function renderWorldMapAuto({ worldPath, center }) {
  const extent = scanChunkExtent(worldPath);
  if (!extent) return { chunkCount: 0, extent: null };
  const range = autoRange(extent, center);
  return { ...renderWorldMap({ worldPath, ...range }), extent };
}

/* =========================
   ワーカーとして起動された場合
   ========================= */
if (parentPort && (workerData?.job === 'render' || workerData?.job === 'auto')) {
  try {
    const result = workerData.job === 'auto' ? renderWorldMapAuto(workerData) : renderWorldMap(workerData);
    parentPort.postMessage({ ok: true, ...result });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message });
  }
}
