import express from 'express';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json());
app.use(express.static('public')); // 簡易UI

// ===== MEE(教育版)からのWebSocket接続を受ける =====
const wss = new WebSocketServer({ port: 8080 });
let meeSocket = null;

wss.on('connection', (ws) => {
  meeSocket = ws;
  console.log('Minecraft Education connected');

  ws.on('message', (msg) => {
    // 必要ならイベントログ
    // console.log('EVENT:', msg.toString());
  });

  ws.on('close', () => {
    meeSocket = null;
    console.log('Minecraft disconnected');
  });
});

// ===== MEEへBedrock WS形式のコマンド送信 =====
function sendCommand(commandLine) {
  if (!meeSocket) return;
  const payload = {
    header: {
      version: 1,
      requestId: uuidv4(),
      messagePurpose: "commandRequest",
      messageType: "commandRequest"
    },
    body: { version: 1, commandLine }
  };
  meeSocket.send(JSON.stringify(payload));
}

// ===== API（ブラウザUIから叩く） =====
app.post('/api/pause_on', (_req, res) => {
  // 粒子非表示引数(true)がエラーになる環境があるので省略版にしています
  sendCommand('effect @a[tag=!canMove] slowness 1000000 255');
  sendCommand('effect @a[tag=!canMove] mining_fatigue 2 255');
  sendCommand('gamemode adventure @a[tag=!canMove]');
  res.json({ ok: true });
});

app.post('/api/pause_off', (_req, res) => {
  sendCommand('effect @a clear');
  sendCommand('gamemode survival @a');
  res.json({ ok: true });
});

app.post('/api/allow_name', (req, res) => {
  const name = req.body?.name;
  if (!name) return res.status(400).json({ error: 'name required' });
  // スペースや日本語名対策で二重引用符を付与
  sendCommand(`tag "${name}" add canMove`);
  sendCommand(`effect "${name}" clear`);
  sendCommand(`gamemode survival "${name}"`);
  res.json({ ok: true });
});

app.listen(3000, () =>
  console.log('UI: http://localhost:3000  /  WS: :8080 待受中')
);
