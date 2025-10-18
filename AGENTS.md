# MEE Teacher Panel のエージェント構成

## 表記ルール
- 本ドキュメントをもとに運用する際は、UI 表示・ログ・チャット送信など利用者に見える出力をすべて日本語に統一する。
- Codex（開発支援エージェント）に指示を出すときは、「日本語で出力してください」などと明記し、日本語での応答を徹底する。

## 全体像
- 本アプリは Electron のメインプロセス（`main.js`）、ブラウザ UI（`public/index.html`）、Minecraft Education Edition（MEE）本体の 3 エージェントで構成される。
- Electron 側がローカルの橋渡し役となり、HTTP (API/SSE)・WebSocket を介して UI と MEE を双方向に同期させる。
- 教員は UI から操作を実行し、サーバーはゲーム内コマンドとして MEE へ送信、結果はイベント購読で受信して UI へストリーム配信する。

## エージェント別の役割

### Electron Main / Control Server（`main.js`）
- `express` により `http://localhost:3000` で UI と REST API を提供し、SSE `/events` で状態を UI にプッシュする。
- `ws` により `ws://127.0.0.1:8080` で MEE からの WebSocket 接続を受け付け、`subscribe()` で各種イベントを購読する。
- プレイヤー情報 `players`、チャットログ `chatLog`、停止状態 `pauseOn` などをメモリ管理し、イベント受信時に整形・更新する。
- `/api/*` エンドポイント経由で受けた操作を `sendCommand()` で Bedrock コマンドへ変換し MEE に転送する。効果の再付与やチャット重複抑制などの補助処理も実装する。
- Electron のウィンドウ生成を担当し、ローカル UI を埋め込みブラウザとして表示する。

### 教員向け UI（`public/index.html`）
- シングルページで動作し、SSE `/events` を購読してロスター・チャット・マップなどを即時更新する。
- `/connect 127.0.0.1:8080` コマンドのコピー支援、接続状態のオーバーレイ、PAUSE 状態の可視化を行う。
- Canvas ベースの俯瞰マップを提供し、プレイヤー移動履歴をインタラクティブに表示する（ドラッグ・ズーム対応、軌跡補間描画）。
- 各種ボタン（PAUSE、許可、集合、アイテム配布、チャット送信、Mayfly 切り替え 等）から REST API を呼び出す。

### Minecraft Education Edition（MEE）クライアント
- ゲーム内チャットで `/connect 127.0.0.1:8080` を実行しローカル WebSocket に接続、イベント通知とコマンド応答を相互送信する。
- サーバー側から送られる `commandRequest` を実行し、結果としてイベント（PlayerJoined/Left/Message/Transform/Tick 等）を返送する。
- `canMove` タグとステータス効果を用いて PAUSE 制御に参加する。

## コミュニケーション経路
- UI → サーバー：`fetch('/api/...')` で JSON POST。結果は `ok: true` のみ返却する。
- サーバー → UI：`/events` SSE で `state`（ロスター・チャット・PAUSE・接続状態）や `chat` 増分を送信する。
- サーバー ↔ MEE：WebSocket (`ws://127.0.0.1:8080`) 上で Bedrock の JSON プロトコルを使用し、`commandRequest` と `event` をやり取りする。

## REST API 一覧（UI 起点）
| パス | 主な用途 | 送信コマンド例 |
| ---- | -------- | -------------- |
| `POST /api/pause_on` | 全員停止（タグ削除 + 効果 + アドベンチャーモード化） | `tag @a remove canMove` ほか |
| `POST /api/pause_off` | 停止解除 | `effect @a clear`, `gamemode creative @a` |
| `POST /api/allow_name` | 指定プレイヤーを可動化 | `tag "<name>" add canMove`, `gamemode creative "<name>"` |
| `POST /api/gather` | 教員位置へ全員テレポート | `tp @a @s` |
| `POST /api/review_items` | Writable Book 配布 | `give @a writable_book 1` |
| `POST /api/camera_items` | カメラ & ポートフォリオ配布 | `give @a camera 1`, `give @a portfolio 1` |
| `POST /api/kill_mob_r50` | 半径 50 の非プレイヤー殲滅 | `kill @e[type=!player,type=!item,r=50]` |
| `POST /api/mayfly` | Mayfly 能力の ON/OFF | `ability @s mayfly <true|false>` |
| `POST /api/chat_send` | 教員からの一斉チャット送信 | `say <message>` |

## サーバー側イベント購読
- 初期接続時に `PlayerJoined`, `PlayerSpawned`, `PlayerLeft`, `PlayerRemoved`, `PlayerMessage`, `PlayerTransform`, `PlayerTravelled`, `PlayerMoved`, `Tick` を購読する。
- 各イベントで `players` を更新し、`PlayerMessage` ではチャットログを整形して 100 件まで保持する。`Tick` では PAUSE 効果を再適用する（`REAPPLY_TICKS = 20`）。
- `normalizeChatMessage()` と `suppressedChatMessages` によりプレイヤー名の重複表示やタイトル経由の自動メッセージをフィルタリングする。

## 運用のポイント
- MEE 側接続が切れると SSE `state` の `meeConnected` が `false` になり、UI が再接続手順を案内する。
- PAUSE 中でも 45 秒ごとに効果が切れないよう Tick 基準で再適用するため、サーバーが動作している限り停止状態が維持される。
- UI はメモリ内状態のみを参照するため、再読み込み時はサーバーが保持している `players` / `chatLog` / `pauseOn` が即座に反映される。
- Electron ウィンドウは外部リンクを既定ブラウザで開き、メニューバーを非表示にするなど教室運用を前提とした設定になっている。
