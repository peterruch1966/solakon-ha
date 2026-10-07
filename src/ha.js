// Minimal Home Assistant WebSocket API client with automatic reconnect.
import { EventEmitter } from 'node:events';

export class HomeAssistant extends EventEmitter {
  constructor(url, token, log = console) {
    super();
    this.wsUrl = url.replace(/^http/, 'ws') + '/api/websocket';
    this.token = token;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.subscriptions = new Map();
    this.connected = false;
    this.lastError = null;
    this.retryMs = 1000;
    this.closed = false;
  }

  start() {
    if (!this.token) {
      this.lastError = 'HA_TOKEN is not set';
      this.log.error(this.lastError);
      return;
    }
    this.connect();
  }

  stop() {
    this.closed = true;
    this.ws?.close();
  }

  connect() {
    let ws;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch (err) {
      this.lastError = err.message;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('message', (ev) => this.onMessage(JSON.parse(ev.data)));
    ws.addEventListener('error', (ev) => {
      this.lastError = ev.message || 'WebSocket error';
    });
    ws.addEventListener('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      for (const { reject } of this.pending.values()) reject(new Error('Connection closed'));
      this.pending.clear();
      this.subscriptions.clear();
      if (wasConnected) {
        this.log.warn('Home Assistant connection lost');
        this.emit('disconnected');
      }
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.closed) return;
    setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 30000);
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'auth_required':
        this.ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        break;
      case 'auth_ok':
        this.connected = true;
        this.lastError = null;
        this.retryMs = 1000;
        this.log.info(`Connected to Home Assistant ${msg.ha_version}`);
        this.emit('connected');
        break;
      case 'auth_invalid':
        this.lastError = `Authentication failed: ${msg.message}`;
        this.log.error(this.lastError);
        // Invalid tokens will not become valid by retrying quickly.
        this.retryMs = 60000;
        break;
      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.success) p.resolve(msg.result);
        else p.reject(new Error(msg.error?.message || 'Request failed'));
        break;
      }
      case 'event':
        this.subscriptions.get(msg.id)?.(msg.event);
        break;
    }
  }

  send(payload, timeoutMs = 30000) {
    if (!this.connected) return Promise.reject(new Error('Not connected to Home Assistant'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${payload.type} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, ...payload }));
    });
  }

  async subscribe(payload, handler) {
    const id = this.nextId;
    this.subscriptions.set(id, handler);
    try {
      await this.send(payload);
    } catch (err) {
      this.subscriptions.delete(id);
      throw err;
    }
    return id;
  }

  callService(domain, service, entityId, data = {}) {
    return this.send({
      type: 'call_service',
      domain,
      service,
      target: { entity_id: entityId },
      service_data: data,
    });
  }
}
