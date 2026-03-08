const WS_URL = 'ws://localhost:11435/ws';
const OLLAMA_BASE = 'http://localhost:11434';
const HEARTBEAT_INTERVAL = 30000;
const MAX_RECONNECT_DELAY = 30000;

let ws = null;
let reconnectDelay = 1000;
let reconnectTimer = null;
let heartbeatTimer = null;
let state = 'disconnected'; // 'connected' | 'disconnected' | 'reconnecting'
let requestCount = 0;

function updateState(newState) {
  state = newState;
  chrome.storage.local.set({ connectionState: state, requestCount });
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  updateState('reconnecting');
  console.log('[connector] Connecting to', WS_URL);

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.error('[connector] WebSocket creation failed:', err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[connector] Connected');
    reconnectDelay = 1000;
    updateState('connected');
    startHeartbeat();
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'pong') return;

    if (msg.type === 'request') {
      requestCount++;
      chrome.storage.local.set({ requestCount });
      await handleRequest(msg);
    }
  };

  ws.onclose = () => {
    console.log('[connector] Disconnected');
    stopHeartbeat();
    updateState('disconnected');
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[connector] WebSocket error');
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log(`[connector] Reconnecting in ${reconnectDelay}ms...`);
  updateState('reconnecting');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connect();
  }, reconnectDelay);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

async function handleRequest(msg) {
  const { id, method, path, headers, body, stream } = msg;
  const url = OLLAMA_BASE + path;

  const fetchOpts = {
    method: method || 'GET',
    headers: headers || {},
  };
  if (body && method !== 'GET' && method !== 'HEAD') {
    fetchOpts.body = body;
  }

  try {
    const response = await fetch(url, fetchOpts);

    if (stream) {
      // Send stream-start
      send({
        id,
        type: 'stream-start',
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      });

      // Read body as stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        send({ id, type: 'stream-chunk', data: text });
      }

      send({ id, type: 'stream-end' });
    } else {
      // Non-streaming: read full body
      const responseBody = await response.text();
      send({
        id,
        type: 'response',
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      });
    }
  } catch (err) {
    send({
      id,
      type: 'error',
      status: 502,
      message: err.message || 'Failed to fetch from model service',
    });
  }
}

// Start connection on service worker load
connect();
