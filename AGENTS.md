# Agents Realtime ガイド

このプロジェクトでは、OpenAI Agents Realtime API を利用して音声エージェントを実現しています。本書では、仕組みとカスタマイズ方法、運用時の注意点をまとめます。

## 全体像

- フロントエンド (React) がブラウザのマイク入力を取得し、`RTCPeerConnection` を使って OpenAI と直接 WebRTC 接続します。
- バックエンド (Express) は短命の Realtime セッションを作成し、`client_secret` をクライアントへ渡すだけの役割です。
- エージェントからは音声ストリームとテキストイベント (DataChannel) の両方が送られ、UI 上で字幕と履歴として表示されます。

```
ブラウザ ──(HTTP)──> Express ──(OpenAI SDK)──> Agents Realtime
    │                                                ▲
    └─────────(WebRTC)─────────────────────────────┘
```

## バックエンド: セッション生成

`server/index.js` の `POST /api/session` では次の情報を設定できます。

- `OPENAI_REALTIME_MODEL` (既定: `gpt-4o-realtime-preview-2024-12-17`)
- `AGENT_INSTRUCTIONS` (既定: 優しく短く回答する日本語プロンプト)
- `voice`: 現在は `alloy` を指定していますが、他の対応音声に変更可能です。

レスポンスは `id`, `model`, `client_secret` を含み、クライアント側で WebRTC シグナリングに利用します。`client_secret` は短命なのでブラウザから直接 OpenAI の API キーを扱わずに済みます。

## フロントエンド: イベント処理

`src/App.jsx` では以下の流れで Realtime エージェントと通信します。

1. `navigator.mediaDevices.getUserMedia` でマイク入力を取得。
2. `fetch('/api/session')` でセッションを取得し、`client_secret` を受け取る。
3. `RTCPeerConnection` を初期化し、音声トラックを追加。データチャネル `oai-events` を作成。
4. SDP オファーを生成し、`https://api.openai.com/v1/realtime?model=...` へ送信。
5. 応答の SDP を `setRemoteDescription` に設定して接続完了。
6. DataChannel 経由で届くイベントを解析し、ユーザー発話 (`conversation.item.created`) とエージェント応答 (`response.output_text.delta` / `response.completed`) を履歴に追加。
7. `response.create` を送信することでオーディオ応答生成をトリガー。

## カスタマイズのヒント

- **初期プロンプト**: `.env` の `AGENT_INSTRUCTIONS` を変更すると、エージェントの人格や言語をコントロールできます。
- **音声の種類**: `server/index.js` 内の `voice` 値を対応音声に変更可能です (例: `verse`, `sol`).
- **会話ログ**: `messages` ステートに履歴が溜まるため、必要であればバックエンドへ送信して永続化する処理を追加できます。
- **自動応答制御**: `response.create` イベントには追加オプション (例: `instructions`, `conversation`) を渡せます。複数ステップの制御を行いたい場合は JSON ペイロードを拡張してください。

## 運用時の注意

- Realtime API は Beta 版のため、アクセス権限が必要です。アカウントで対象モデルが有効になっているか確認してください。
- WebRTC は UDP を利用するので、企業ネットワークなどではファイアウォール設定が必要な場合があります。
- ブラウザは HTTPS 上で動作する必要があります (例外: `localhost`)。デプロイ時はリバースプロキシや証明書の設定を忘れずに。
- OpenAI API キーはサーバー側のみで扱い、クライアントに直接渡さないでください。

## 参考リンク

- [OpenAI Realtime API ドキュメント](https://platform.openai.com/docs/guides/realtime)
- [WebRTC 公式ガイド](https://developer.mozilla.org/ja/docs/Web/API/WebRTC_API)

上記をベースに、会話ログの保存や途中介入 (tool 呼び出し) なども拡張できます。プロジェクトの要件に合わせて調整してください。
