const { URL } = require('url');

function errorJson(status, message) {
  return JSON.stringify({
    error: {
      message,
      type: 'proxy_error',
      code: status === 503 ? 'extension_not_connected' : 'proxy_error',
    },
  });
}

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
    const responseHeaders = { 'Content-Type': 'application/json' };
    if (result.headers && result.headers['content-type']) {
      responseHeaders['Content-Type'] = result.headers['content-type'];
    }
    res.writeHead(result.status, responseHeaders);
    res.end(result.body);
  } catch (err) {
    const status = err.status || 502;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(errorJson(status, err.message || 'Proxy error'));
  }
}

function handleStreamingRequest(bridge, method, path, headers, body, res) {
  const emitter = bridge.sendStreamingRequest(method, path, headers, body);

  let headersSent = false;

  emitter.on('start', (info) => {
    res.writeHead(info.status, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    headersSent = true;
  });

  emitter.on('chunk', (data) => {
    if (!headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      headersSent = true;
    }
    res.write(data);
  });

  emitter.on('end', () => {
    if (!headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
    }
    res.end();
  });

  emitter.on('error', (err) => {
    if (!headersSent) {
      const status = err.status || 502;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(errorJson(status, err.message || 'Proxy stream error'));
    } else {
      // Already streaming, end the connection
      res.end();
    }
  });

  // Handle client disconnect
  res.on('close', () => {
    emitter.removeAllListeners();
  });
}

module.exports = createHandler;
