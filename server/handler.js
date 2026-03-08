const { URL } = require('url');
const crypto = require('crypto');

// ── OpenAI format adaptation ──────────────────────────────────────────

function generateId() {
  return 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

/**
 * Adapt a non-streaming response body to strict OpenAI format.
 */
function adaptResponseBody(bodyStr) {
  try {
    const data = JSON.parse(bodyStr);
    if (!data.id) data.id = generateId();
    if (data.choices) {
      for (const choice of data.choices) {
        if (choice.finish_reason === '') {
          choice.finish_reason = 'stop';
        }
      }
    }
    return JSON.stringify(data);
  } catch {
    return bodyStr;
  }
}

/**
 * Adapt a streaming SSE chunk. Processes each `data: {...}` line,
 * injecting missing fields for OpenAI compatibility.
 * Returns the adapted chunk string.
 */
function adaptStreamChunk(raw, requestId) {
  const lines = raw.split('\n');
  const adapted = [];

  for (const line of lines) {
    if (line.startsWith('data: [DONE]')) {
      adapted.push(line);
      continue;
    }

    if (line.startsWith('data: ')) {
      const jsonStr = line.slice(6);
      try {
        const data = JSON.parse(jsonStr);
        if (!data.id) data.id = requestId;
        if (data.choices) {
          for (const choice of data.choices) {
            if (choice.finish_reason === '') {
              choice.finish_reason = null;
            }
          }
        }
        adapted.push('data: ' + JSON.stringify(data));
      } catch {
        adapted.push(line);
      }
    } else {
      adapted.push(line);
    }
  }

  return adapted.join('\n');
}

// ── Error helpers ─────────────────────────────────────────────────────

function errorJson(status, message) {
  return JSON.stringify({
    error: {
      message,
      type: 'proxy_error',
      code: status === 503 ? 'extension_not_connected' : 'proxy_error',
    },
  });
}

// ── Handler ───────────────────────────────────────────────────────────

function createHandler(bridge) {
  return async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    const path = parsed.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check
    if (path === '/health') {
      const status = bridge.connected ? 200 : 503;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: bridge.connected ? 'ok' : 'extension_disconnected',
        connected: bridge.connected,
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // Only proxy /v1/* routes
    if (!path.startsWith('/v1/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(errorJson(404, `Not found: ${path}`));
      return;
    }

    // Check extension connection
    if (!bridge.connected) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(errorJson(503, 'Chrome extension is not connected. Please ensure the extension is loaded and running in the browser.'));
      return;
    }

    // Read request body
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    // Determine if streaming
    let isStream = false;
    if (body) {
      try {
        const parsed = JSON.parse(body);
        isStream = parsed.stream === true;
      } catch {
        // not JSON or malformed, just forward as-is
      }
    }

    const forwardHeaders = {
      'Content-Type': req.headers['content-type'] || 'application/json',
    };
    if (req.headers.authorization) {
      forwardHeaders['Authorization'] = req.headers.authorization;
    }

    if (isStream) {
      handleStreamingRequest(bridge, req.method, path, forwardHeaders, body, res);
    } else {
      handleNonStreamingRequest(bridge, req.method, path, forwardHeaders, body, res);
    }
  };
}

async function handleNonStreamingRequest(bridge, method, path, headers, body, res) {
  try {
    const result = await bridge.sendRequest(method, path, headers, body);
    const adapted = adaptResponseBody(result.body);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(adapted);
  } catch (err) {
    const status = err.status || 502;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(errorJson(status, err.message || 'Proxy error'));
  }
}

function handleStreamingRequest(bridge, method, path, headers, body, res) {
  const emitter = bridge.sendStreamingRequest(method, path, headers, body);
  const requestId = generateId();

  let headersSent = false;
  let sentDone = false;

  function ensureHeaders(status) {
    if (!headersSent) {
      res.writeHead(status || 200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      headersSent = true;
    }
  }

  emitter.on('start', (info) => {
    ensureHeaders(info.status);
  });

  emitter.on('chunk', (data) => {
    ensureHeaders(200);
    const adapted = adaptStreamChunk(data, requestId);
    res.write(adapted);
    if (adapted.includes('data: [DONE]')) {
      sentDone = true;
    }
  });

  emitter.on('end', () => {
    ensureHeaders(200);
    if (!sentDone) {
      res.write('data: [DONE]\n\n');
    }
    res.end();
  });

  emitter.on('error', (err) => {
    if (!headersSent) {
      const status = err.status || 502;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(errorJson(status, err.message || 'Proxy stream error'));
    } else {
      res.end();
    }
  });

  // Handle client disconnect
  res.on('close', () => {
    emitter.removeAllListeners();
  });
}

module.exports = createHandler;
