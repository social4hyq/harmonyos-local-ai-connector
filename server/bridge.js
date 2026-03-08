const { EventEmitter } = require('events');
const crypto = require('crypto');
const config = require('./config');

class Bridge extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._pending = new Map(); // requestId -> { resolve, reject, timer, emitter? }
  }

  get connected() {
    return this._ws !== null && this._ws.readyState === 1; // WebSocket.OPEN
  }

  attach(ws) {
    if (this._ws) {
      try { this._ws.close(); } catch (_) {}
    }
    this._ws = ws;
    console.log('[bridge] Extension connected');

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      this._handleMessage(msg);
    });

    ws.on('close', () => {
      console.log('[bridge] Extension disconnected');
      this._ws = null;
      this._rejectAll('Extension disconnected');
      this.emit('disconnect');
    });

    ws.on('error', (err) => {
      console.error('[bridge] WebSocket error:', err.message);
    });

    this.emit('connect');
  }

  _handleMessage(msg) {
    // Handle heartbeat
    if (msg.type === 'ping') {
      this._send({ type: 'pong' });
      return;
    }
    if (msg.type === 'pong') {
      return;
    }

    const pending = this._pending.get(msg.id);
    if (!pending) return;

    switch (msg.type) {
      case 'response':
        clearTimeout(pending.timer);
        this._pending.delete(msg.id);
        pending.resolve({
          status: msg.status,
          headers: msg.headers || {},
          body: msg.body,
        });
        break;

      case 'stream-start':
        if (pending.emitter) {
          pending.emitter.emit('start', {
            status: msg.status,
            headers: msg.headers || {},
          });
        }
        break;

      case 'stream-chunk':
        if (pending.emitter) {
          pending.emitter.emit('chunk', msg.data);
        }
        break;

      case 'stream-end':
        clearTimeout(pending.timer);
        this._pending.delete(msg.id);
        if (pending.emitter) {
          pending.emitter.emit('end');
        }
        break;

      case 'error':
        clearTimeout(pending.timer);
        this._pending.delete(msg.id);
        pending.reject({
          status: msg.status || 502,
          message: msg.message || 'Unknown error from extension',
        });
        break;
    }
  }

  /**
   * Send a non-streaming request through the extension.
   * Returns a Promise that resolves with { status, headers, body }.
   */
  sendRequest(method, path, headers, body) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        return reject({ status: 503, message: 'Extension not connected' });
      }

      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject({ status: 504, message: 'Request timeout' });
      }, config.REQUEST_TIMEOUT);

      this._pending.set(id, { resolve, reject, timer });

      this._send({
        id,
        type: 'request',
        method,
        path,
        headers,
        body,
        stream: false,
      });
    });
  }

  /**
   * Send a streaming request through the extension.
   * Returns an EventEmitter that emits 'start', 'chunk', 'end', 'error'.
   */
  sendStreamingRequest(method, path, headers, body) {
    const emitter = new EventEmitter();

    if (!this.connected) {
      process.nextTick(() => {
        emitter.emit('error', { status: 503, message: 'Extension not connected' });
      });
      return emitter;
    }

    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      this._pending.delete(id);
      emitter.emit('error', { status: 504, message: 'Request timeout' });
    }, config.REQUEST_TIMEOUT);

    this._pending.set(id, {
      resolve: () => {},
      reject: (err) => emitter.emit('error', err),
      timer,
      emitter,
    });

    this._send({
      id,
      type: 'request',
      method,
      path,
      headers,
      body,
      stream: true,
    });

    return emitter;
  }

  _send(data) {
    if (this._ws && this._ws.readyState === 1) {
      this._ws.send(JSON.stringify(data));
    }
  }

  _rejectAll(message) {
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject({ status: 503, message });
    }
    this._pending.clear();
  }
}

module.exports = Bridge;
