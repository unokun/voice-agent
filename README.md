# OpenAI Realtime 音声エージェント

OpenAI Agents Realtime API を利用した音声エージェントです。React で実装されたクライアントが WebRTC で OpenAI と直接接続し、音声とテキストの両方で応答を受け取ります。Express バックエンドは短命の Realtime セッションキーを生成する役割のみを担います。

## セットアップ

1. 依存関係をインストールします。
   ```bash
   npm install
   ```
2. `.env.example` をコピーして `.env` を作成し、OpenAI の API キーを設定します。
   ```bash
   cp .env.example .env
   # OPENAI_API_KEY に有効なキーを設定
   ```
3. 開発サーバーを起動します。
   ```bash
   npm run dev
   ```
   - Vite (フロントエンド): http://localhost:5173
   - Express (バックエンド): http://localhost:3001

> `npm run dev` は `concurrently` でフロントエンドとバックエンドを同時に起動します。個別に動作確認したい場合は `npm run dev:client` / `npm run dev:server` を利用してください。

## 使い方

1. ブラウザで http://localhost:5173 を開きます。
2. 「開始」ボタンを押すとマイクへのアクセス許可が求められます。許可すると OpenAI Realtime API への接続が確立されます。
3. 接続中はマイク音声がリアルタイムで送信され、エージェントからの応答が音声とテキストで返ります。
4. 「接続を終了する」を押すと WebRTC セッションが終了し、再度「開始」を押すことで新しいセッションを開始できます。

## 技術構成

- **フロントエンド:** React + Vite
  - WebRTC (`RTCPeerConnection`) で OpenAI Realtime と接続
  - 音声ストリームを送受信し、データチャネルでテキストイベントを受信
  - 受信したイベントからユーザー発話の書き起こしとエージェント応答を表示
- **バックエンド:** Express
  - `POST /api/session` で OpenAI の Realtime セッションを生成し、短命の `client_secret` をクライアントに渡す

## 補足

- Realtime API の利用には Beta アクセス権限が必要です。対象モデル (`gpt-4o-realtime-preview-2024-12-17` など) が利用可能か確認してください。
- ブラウザは WebRTC とマイク入力に対応している必要があります。Chrome / Edge / Firefox の最新版を推奨します。
- ネットワーク環境によっては UDP が制限され、接続できない場合があります。その際は VPN などを検討してください。
- `.env` 内で `OPENAI_REALTIME_MODEL` や `AGENT_INSTRUCTIONS` を上書きすると、利用モデルやエージェントの口調をカスタマイズできます。
