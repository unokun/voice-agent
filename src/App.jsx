import { useEffect, useRef, useState } from 'react';

const CONNECTION_STATES = {
  idle: 'idle',
  connecting: 'connecting',
  connected: 'connected',
  error: 'error',
};

function App() {
  const [connectionState, setConnectionState] = useState(CONNECTION_STATES.idle);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [clock, setClock] = useState(Date.now());

  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const conversationRef = useRef(null);

  useEffect(() => {
    const interval = setInterval(() => {
      setClock(Date.now());
    }, 30000);

    return () => {
      clearInterval(interval);
      disconnectAgent();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const container = conversationRef.current;
    if (!container) {
      return;
    }

    requestAnimationFrame(() => {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    });
  }, [messages]);

  const connectAgent = async () => {
    if (connectionState === CONNECTION_STATES.connected || connectionState === CONNECTION_STATES.connecting) {
      return;
    }

    if (!navigator?.mediaDevices?.getUserMedia) {
      setError('このブラウザは音声録音に対応していません。最新のブラウザを利用してください。');
      setConnectionState(CONNECTION_STATES.error);
      return;
    }

    setError('');
    setStatusMessage('マイクにアクセスしています...');
    setConnectionState(CONNECTION_STATES.connecting);

    try {
      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;

      const sessionResponse = await fetch('/api/session', { method: 'POST' });
      if (!sessionResponse.ok) {
        let detail = '';
        try {
          const err = await sessionResponse.json();
          console.error('Session API error:', err);
          detail = err?.error || JSON.stringify(err);
        } catch {
          const text = await sessionResponse.text().catch(() => '');
          console.error('Session API error (non-JSON):', text);
          detail = text;
        }
        throw new Error(`セッションの取得に失敗しました。${detail ? ' 詳細: ' + detail : ''}`);
      }
      const session = await sessionResponse.json();
      const clientSecret = session?.client_secret?.value;

      if (!clientSecret) {
        throw new Error('セッション情報が不正です。');
      }

      const pc = new RTCPeerConnection();
      peerConnectionRef.current = pc;

      pc.addEventListener('connectionstatechange', () => {
        setStatusMessage(`接続状態: ${pc.connectionState}`);
        if (pc.connectionState === 'connected') {
          setConnectionState(CONNECTION_STATES.connected);
        }
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setConnectionState(CONNECTION_STATES.error);
        }
      });

      pc.addEventListener('iceconnectionstatechange', () => {
        setStatusMessage(`接続状態: ${pc.iceConnectionState}`);
      });

      pc.addEventListener('track', event => {
        const [stream] = event.streams;
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = stream;
        }
      });

      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }

      const dataChannel = pc.createDataChannel('oai-events');
      dataChannelRef.current = dataChannel;

      dataChannel.addEventListener('open', () => {
        setStatusMessage('エージェントと通信を開始しました。');
        dataChannel.send(JSON.stringify({ type: 'response.create' }));
      });

      dataChannel.addEventListener('message', handleAgentMessage);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const response = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(session.model)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
      });

      if (!response.ok) {
        throw new Error('OpenAI Realtime API との接続に失敗しました。');
      }

      const answer = await response.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });

      setStatusMessage('接続が確立されました。会話を開始できます。');
      setConnectionState(CONNECTION_STATES.connected);
    } catch (err) {
      console.error(err);
      setError(err.message || '接続に失敗しました。');
      setConnectionState(CONNECTION_STATES.error);
      disconnectAgent();
    }
  };

  const disconnectAgent = () => {
    if (dataChannelRef.current) {
      try {
        dataChannelRef.current.close();
      } catch (err) {
        console.error('データチャネルのクローズに失敗しました:', err);
      }
      dataChannelRef.current = null;
    }

    if (peerConnectionRef.current) {
      try {
        peerConnectionRef.current.close();
      } catch (err) {
        console.error('PeerConnection のクローズに失敗しました:', err);
      }
      peerConnectionRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
    setStatusMessage('');
  };

  const handleAgentMessage = event => {
    try {
      const data = JSON.parse(event.data);
      // console.log(`Agent Message: ${JSON.stringify(data)}`);
      switch (data.type) {
        case 'response.created': {
          const responseId = data.response?.id;
          if (responseId) {
            setMessages(prev => {
              const alreadyExists = prev.some(message => message.id === responseId);
              if (alreadyExists) {
                return prev;
              }
              return [
                ...prev,
                {
                  role: 'assistant',
                  text: '',
                  id: responseId,
                  isStreaming: true,
                  timestamp: Date.now(),
                },
              ];
            });
          }
          break;
        }
        case 'response.output_text.delta': {
          const responseId = data.response_id;
          if (!responseId) {
            break;
          }
          const deltaText = normalizeDeltaText(data.delta);
          if (!deltaText) {
            break;
          }
          setMessages(prev => {
            let hasMatch = false;
            const next = prev.map(message => {
              if (message.id === responseId) {
                hasMatch = true;
                return {
                  ...message,
                  text: `${message.text || ''}${deltaText}`,
                };
              }
              return message;
            });

            if (!hasMatch) {
              return [
                ...next,
                {
                  role: 'assistant',
                  text: deltaText,
                  id: responseId,
                  isStreaming: true,
                  timestamp: Date.now(),
                },
              ];
            }

            return next;
          });
          break;
        }
        case 'response.completed': {
          const responseId = data.response?.id;
          if (!responseId) {
            break;
          }
          const responseText = extractTextFromResponse(data.response);
          updateAssistantMessage(responseId, responseText, { finalize: true });
          break;
        }
        case 'response.audio_transcript.delta': {
          const responseId = data.response_id;
          const transcript = normalizeDeltaText(data.transcript);
          updateAssistantMessage(responseId, transcript, { append: true });
          break;
        }
        case 'response.audio_transcript.done': {
          const responseId = data.response_id;
          const transcript = normalizeDeltaText(data.transcript);
          updateAssistantMessage(responseId, transcript);
          break;
        }
        case 'response.content_part.delta': {
          const responseId = data.response_id;
          const text = normalizeDeltaText(data.delta);
          updateAssistantMessage(responseId, text, { append: true });
          break;
        }
        case 'response.content_part.done': {
          const responseId = data.response_id;
          const text = normalizeDeltaText(data.part);
          updateAssistantMessage(responseId, text);
          break;
        }
        case 'response.output_item.done': {
          const responseId = data.response_id;
          const text = extractTextFromItem(data.item);
          updateAssistantMessage(responseId, text);
          break;
        }
        case 'response.done': {
          const responseId = data.response?.id || data.response_id;
          const responseText = extractTextFromResponse(data.response);
          updateAssistantMessage(responseId, responseText, { finalize: true });
          break;
        }
        case 'response.error': {
          const message = data.error?.message || 'エージェントからエラーが返されました。';
          setError(message);
          break;
        }
        case 'conversation.item.created': {
          const item = data.item;
          if (!item?.id || !item.role) {
            break;
          }

          if (item.role === 'user') {
            const textContent = extractTextFromItem(item);
            setMessages(prev => {
              if (prev.some(message => message.id === item.id)) {
                return prev.map(message =>
                  message.id === item.id
                    ? {
                        ...message,
                        text: textContent || message.text,
                        isStreaming: !textContent && message.isStreaming !== false,
                      }
                    : message,
                );
              }

              return [
                ...prev,
                {
                  role: 'user',
                  text: textContent,
                  id: item.id,
                  timestamp: Date.now(),
                  isStreaming: !textContent,
                },
              ];
            });
          } else if (item.role === 'assistant') {
            const textContent = extractTextFromItem(item);
            if (!textContent) {
              break;
            }
            setMessages(prev => {
              let patched = false;
              const next = prev.map(message => {
                if (!patched && message.role === 'assistant' && (message.isStreaming || !message.text)) {
                  patched = true;
                  return {
                    ...message,
                    text: textContent,
                    isStreaming: false,
                  };
                }
                return message;
              });

              if (patched || prev.some(message => message.id === item.id)) {
                return next;
              }

              return [
                ...next,
                {
                  role: 'assistant',
                  text: textContent,
                  id: item.id,
                  timestamp: Date.now(),
                  isStreaming: false,
                },
              ];
            });
          }
          break;
        }
        case 'conversation.item.input_audio_transcription.delta': {
          const itemId = data.item_id;
          const delta = normalizeDeltaText(data.delta);
          updateUserMessage(itemId, delta, { append: true });
          break;
        }
        case 'conversation.item.input_audio_transcription.done':
        case 'conversation.item.input_audio_transcription.completed': {
          const itemId = data.item?.id || data.item_id;
          const transcript = data.item?.content
            ? extractTextFromItem(data.item)
            : normalizeDeltaText(data.transcript) || '';
          updateUserMessage(itemId, transcript, { finalize: true });
          break;
        }
        case 'conversation.item.completed': {
          const itemId = data.item?.id;
          if (!itemId) {
            break;
          }
          const textContent = extractTextFromItem(data.item);
          updateUserMessage(itemId, textContent, { finalize: true });
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.error('エージェントからのメッセージ解析に失敗しました:', err, event.data);
    }
  };

  const extractTextFromItem = item => {
    if (!item) {
      return '';
    }

    if (item.formatted?.text) {
      return item.formatted.text;
    }

    if (item.formatted?.transcript) {
      return item.formatted.transcript;
    }

    if (Array.isArray(item.content)) {
      for (const content of item.content) {
        if ((content.type === 'input_text' || content.type === 'output_text' || content.type === 'text') && content.text) {
          return content.text;
        }
        if (content.type === 'transcript' && content.transcript) {
          return content.transcript;
        }
        if (content.type === 'input_audio' && content.transcript) {
          return content.transcript;
        }
        if (content.type === 'response_text' && content.text) {
          return content.text;
        }
      }
    }

    return '';
  };

  const extractTextFromResponse = response => {
    if (!response) {
      return '';
    }

    if (Array.isArray(response.output)) {
      for (const output of response.output) {
        if (Array.isArray(output.content)) {
          for (const content of output.content) {
            if (content.type === 'output_text' && content.text) {
              return content.text;
            }
            if (content.type === 'text' && content.text) {
              return content.text;
            }
            if (content.type === 'audio' && content.transcript) {
              return content.transcript;
            }
          }
        }
      }
    }

    if (response.output_text?.length) {
      return response.output_text.join('');
    }

    return '';
  };

  const normalizeDeltaText = delta => {
    if (!delta) {
      return '';
    }
    if (typeof delta === 'string') {
      return delta;
    }
    if (Array.isArray(delta)) {
      return delta.map(normalizeDeltaText).join('');
    }
    if (typeof delta === 'object' && delta !== null) {
      if (typeof delta.text === 'string') {
        return delta.text;
      }
      if (typeof delta.transcript === 'string') {
        return delta.transcript;
      }
    }
    return '';
  };

  const updateAssistantMessage = (responseId, text, { append = false, finalize = false } = {}) => {
    if (!responseId && !text) {
      return;
    }

    const normalized = typeof text === 'string' ? text : normalizeDeltaText(text);
    if (!normalized && !finalize) {
      return;
    }

    setMessages(prev => {
      let matched = false;
      const next = prev.map(message => {
        if (responseId && message.id !== responseId) {
          return message;
        }

        matched = true;
        const currentText = message.text || '';
        const nextText = normalized
          ? append
            ? `${currentText}${normalized}`
            : normalized
          : currentText;

        return {
          ...message,
          text: nextText,
          isStreaming: finalize ? false : message.isStreaming,
        };
      });

      if (!matched) {
        if (!normalized && !finalize) {
          return next;
        }

        return [
          ...next,
          {
            role: 'assistant',
            text: normalized || '',
            id: responseId || `assistant-${Date.now()}`,
            isStreaming: !finalize,
            timestamp: Date.now(),
          },
        ];
      }

      return next;
    });
  };

  const updateUserMessage = (itemId, text, { append = false, finalize = false } = {}) => {
    if (!itemId && !text) {
      return;
    }

    const normalized = typeof text === 'string' ? text : normalizeDeltaText(text);
    if (!normalized && !finalize) {
      return;
    }

    setMessages(prev => {
      let matched = false;
      const next = prev.map(message => {
        if (message.id !== itemId) {
          return message;
        }

        matched = true;
        const currentText = message.text || '';
        const nextText = normalized
          ? append
            ? `${currentText}${normalized}`
            : normalized
          : currentText;

        return {
          ...message,
          text: nextText,
          isStreaming: finalize ? false : message.isStreaming || append,
        };
      });

      if (!matched) {
        if (!normalized && !finalize) {
          return next;
        }

        return [
          ...next,
          {
            role: 'user',
            text: normalized || '',
            id: itemId || `user-${Date.now()}`,
            isStreaming: !finalize,
            timestamp: Date.now(),
          },
        ];
      }

      return next;
    });
  };

  const formatRelativeTime = timestamp => {
    if (!timestamp) {
      return '';
    }

    const diffMs = clock - timestamp;
    if (diffMs < 0) {
      return '';
    }

    const diffMinutes = Math.floor(diffMs / 60000);
    if (diffMinutes < 1) {
      return 'たった今';
    }

    if (diffMinutes < 60) {
      return `${diffMinutes}分前`;
    }

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
      return `${diffHours}時間前`;
    }

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) {
      return `${diffDays}日前`;
    }

    return '';
  };

  const handleToggleConnection = () => {
    if (connectionState === CONNECTION_STATES.connected || connectionState === CONNECTION_STATES.connecting) {
      disconnectAgent();
      setConnectionState(CONNECTION_STATES.idle);
      setStatusMessage('接続を終了しました。');
    } else {
      connectAgent();
    }
  };

  return (
    <div className="app">
      <header>
        <h1>OpenAI Realtime 音声エージェント</h1>
        <p>開始ボタンで Realtime エージェントに接続し、音声で会話できます。</p>
      </header>

      <section className="controls">
        <button
          className={`primary ${connectionState === CONNECTION_STATES.connected ? 'recording' : ''}`}
          onClick={handleToggleConnection}
        >
          {connectionState === CONNECTION_STATES.connected || connectionState === CONNECTION_STATES.connecting
            ? '接続を終了する'
            : '開始'}
        </button>
        {statusMessage && <span className="status">{statusMessage}</span>}
      </section>

      {error && <div className="error">{error}</div>}

      <section className="conversation" ref={conversationRef}>
        {messages.length === 0 && !error && (
          <p className="placeholder">まだ会話はありません。ボタンを押して話しかけてみましょう。</p>
        )}
        {messages.map(message => {
          const roleLabel = message.role === 'user' ? 'あなた' : 'エージェント';
          const classNames = ['message', message.role];
          if (message.isStreaming) {
            classNames.push('streaming');
          } else if (message.role === 'assistant') {
            classNames.push('completed');
          }

          const relativeTime = formatRelativeTime(message.timestamp);
          const absoluteTime = message.timestamp
            ? new Intl.DateTimeFormat('ja-JP', {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              }).format(message.timestamp)
            : '';
          const timeLabel = relativeTime || absoluteTime;

          return (
            <div key={message.id} className={classNames.join(' ')}>
              <div className="meta-row">
                <span className="role">{roleLabel}</span>
                {timeLabel && (
                  <time
                    className="timestamp"
                    dateTime={message.timestamp ? new Date(message.timestamp).toISOString() : undefined}
                    title={absoluteTime}
                  >
                    {timeLabel}
                  </time>
                )}
              </div>
              {message.isStreaming && (
                <span className="streaming-indicator" aria-live="polite">
                  応答を生成しています
                  <span className="dots" aria-hidden="true">
                    <span>.</span>
                    <span>.</span>
                    <span>.</span>
                  </span>
                </span>
              )}
              <p>{message.text}</p>
            </div>
          );
        })}
      </section>

      <audio ref={remoteAudioRef} autoPlay playsInline hidden />
    </div>
  );
}

export default App;
