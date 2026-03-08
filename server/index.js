const http = require('http');
const { WebSocketServer } = require('ws');
const config = require('./config');
const Bridge = require('./bridge');
const createHandler = require('./handler');

const bridge = new Bridge();
const handler = createHandler(bridge);

const server = http.createServer(handler);

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      bridge.attach(ws);
    });
  } else {
    socket.destroy();
  }
});

bridge.on('connect', () => {
  console.log('[server] Extension bridge established');
});

bridge.on('disconnect', () => {
  console.log('[server] Extension bridge lost, waiting for reconnection...');
});

server.listen(config.API_PORT, () => {
  console.log('');
  console.log('='.repeat(60));
  console.log('  Local Model Connector');
  console.log('='.repeat(60));
  console.log(`  API server:    http://localhost:${config.API_PORT}`);
  console.log(`  WebSocket:     ws://localhost:${config.API_PORT}/ws`);
  console.log(`  Target:        ${config.OLLAMA_BASE_URL}`);
  console.log('');
  console.log('  Endpoints:');
  console.log(`    GET  /v1/models`);
  console.log(`    POST /v1/chat/completions`);
  console.log(`    POST /v1/completions`);
  console.log(`    POST /v1/embeddings`);
  console.log(`    GET  /health`);
  console.log('');
  console.log('  Usage with opencode/openclaw:');
  console.log(`    OPENAI_BASE_URL=http://localhost:${config.API_PORT}/v1`);
  console.log('='.repeat(60));
  console.log('');
  console.log('  Waiting for Chrome extension to connect...');
  console.log('');
});
