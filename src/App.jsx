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

  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const responseBufferRef = useRef({});

  useEffect(() => {
    return () => {
      disconnectAgent();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        throw new Error('セッションの取得に失敗しました。');
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

    responseBufferRef.current = {};
    setStatusMessage('');
  };

  const handleAgentMessage = event => {
    try {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'response.created': {
          if (data.response?.id) {
            responseBufferRef.current[data.response.id] = '';
          }
          break;
        }
        case 'response.output_text.delta': {
          const responseId = data.response_id;
          if (!responseId) {
            break;
          }
          const current = responseBufferRef.current[responseId] || '';
          responseBufferRef.current[responseId] = current + (data.delta || '');
          break;
        }
        case 'response.completed': {
          const responseId = data.response?.id;
          if (!responseId) {
            break;
          }
          const text = (responseBufferRef.current[responseId] || '').trim();
          if (text) {
            setMessages(prev => [...prev, { role: 'assistant', text, id: responseId }]);
          }
          delete responseBufferRef.current[responseId];
          break;
        }
        case 'response.error': {
          const message = data.error?.message || 'エージェントからエラーが返されました。';
          setError(message);
          break;
        }
        case 'conversation.item.created': {
          const item = data.item;
          if (item?.role === 'user') {
            const textContent = extractTextFromItem(item);
            if (textContent) {
              setMessages(prev => [...prev, { role: 'user', text: textContent, id: item.id }]);
            }
          }
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
    if (!Array.isArray(item?.content)) {
      return '';
    }

    for (const content of item.content) {
      if (content.type === 'input_text' && content.text) {
        return content.text;
      }
      if (content.type === 'transcript' && content.transcript) {
        return content.transcript;
      }
      if (content.type === 'output_text' && content.text) {
        return content.text;
      }
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

      <section className="conversation">
        {messages.length === 0 && !error && (
          <p className="placeholder">まだ会話はありません。ボタンを押して話しかけてみましょう。</p>
        )}
        {messages.map(message => (
          <div key={message.id} className={`message ${message.role}`}>
            <span className="role">{message.role === 'user' ? 'あなた' : 'エージェント'}</span>
            <p>{message.text}</p>
          </div>
        ))}
      </section>

      <audio ref={remoteAudioRef} autoPlay playsInline hidden />
    </div>
  );
}

export default App;
