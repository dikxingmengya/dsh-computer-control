// A Chrome DevTools Protocol client with no dependencies.
//
// CDP speaks WebSocket, and this package has no runtime dependencies by design - the whole
// native layer is a PowerShell helper for the same reason. `globalThis.WebSocket` exists in
// recent Node, but not reliably inside an Electron main process, so relying on it would
// mean a feature that works depending on which runtime happens to be hosting the plugin.
//
// What follows is the subset of RFC 6455 that a client needs: one handshake, text and close
// frames out (always masked, as the RFC requires of clients), and text, continuation, ping
// and close frames in.
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CONNECT_TIMEOUT_MS = 8000;

/** Ask the browser what it is listening to, over plain HTTP. */
export function fetchJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`${url} answered ${response.statusCode}`));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(new Error(`${url} did not answer with JSON: ${error.message}`)); }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`${url} did not answer within ${timeoutMs} ms`)));
    request.on('error', reject);
  });
}

/** One WebSocket connection to one DevTools target. */
export class CdpSocket {
  #socket = null;
  #rest = Buffer.alloc(0);
  #pending = new Map();
  #listeners = new Map();
  #nextId = 1;
  #closed = false;

  /**
   * Subscribe to a protocol event, e.g. `Browser.downloadProgress`.
   *
   * Events are the other half of CDP, and this client did not have them: a message without an
   * `id` was dropped on the floor, which is every event the protocol sends. Without them,
   * anything that happens over time - a download finishing, a navigation completing, a dialog
   * opening - can only be reached by asking repeatedly and hoping to catch it between polls.
   *
   * Returns an unsubscribe function.
   */
  on(method, handler) {
    let set = this.#listeners.get(method);
    if (set === undefined) { set = new Set(); this.#listeners.set(method, set); }
    set.add(handler);
    return () => { set.delete(handler); };
  }

  /**
   * Open a connection and complete the upgrade handshake.
   *
   * `url` is a `ws://host:port/path` string, which is exactly what the browser reports as a
   * target's `webSocketDebuggerUrl`.
   */
  static async open(url) {
    const socket = new CdpSocket();
    await socket.#connect(url);
    return socket;
  }

  #connect(url) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const key = crypto.randomBytes(16).toString('base64');
      const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      const raw = net.connect(Number(parsed.port), parsed.hostname);
      this.#socket = raw;
      raw.setNoDelay(true);

      const timer = setTimeout(() => { raw.destroy(); reject(new Error(`the DevTools socket did not open within ${CONNECT_TIMEOUT_MS} ms`)); }, CONNECT_TIMEOUT_MS);
      let handshake = Buffer.alloc(0);

      const onData = (chunk) => {
        handshake = Buffer.concat([handshake, chunk]);
        const end = handshake.indexOf('\r\n\r\n');
        if (end < 0) return;
        raw.off('data', onData);
        clearTimeout(timer);
        const head = handshake.subarray(0, end).toString('latin1');
        if (!/^HTTP\/1\.1 101/.test(head)) {
          raw.destroy();
          reject(new Error(`the DevTools socket refused the upgrade: ${head.split('\r\n')[0]}`));
          return;
        }
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
        if (accept !== expected) {
          raw.destroy();
          reject(new Error('the DevTools socket answered with a wrong Sec-WebSocket-Accept'));
          return;
        }
        const leftover = handshake.subarray(end + 4);
        if (leftover.length > 0) this.#consume(leftover);
        raw.on('data', (next) => this.#consume(next));
        raw.on('error', (error) => this.#fail(error));
        raw.on('close', () => this.#fail(new Error('the DevTools socket closed')));
        resolve();
      };

      raw.on('error', (error) => { clearTimeout(timer); reject(error); });
      raw.on('data', onData);
      raw.write(
        `GET ${parsed.pathname || '/'}${parsed.search} HTTP/1.1\r\n`
        + `Host: ${parsed.host}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${key}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
  }

  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }

  /** Send one text frame, masked as a client must. */
  #sendFrame(text) {
    const payload = Buffer.from(text, 'utf8');
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];

    let header;
    if (payload.length < 126) {
      header = Buffer.alloc(6);
      header[1] = 0x80 | payload.length;
    } else if (payload.length < 65536) {
      header = Buffer.alloc(8);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(14);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    header[0] = 0x81; // FIN + text
    mask.copy(header, header.length - 4);
    this.#socket.write(Buffer.concat([header, masked]));
  }

  /** Pull as many complete frames out of the buffer as it holds. */
  #consume(chunk) {
    this.#rest = this.#rest.length === 0 ? chunk : Buffer.concat([this.#rest, chunk]);
    for (;;) {
      const buffer = this.#rest;
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;

      let payload = buffer.subarray(offset, offset + length);
      if (maskKey) {
        const unmasked = Buffer.alloc(length);
        for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ maskKey[i % 4];
        payload = unmasked;
      }
      this.#rest = buffer.subarray(offset + length);

      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.#pong(payload); continue; }
      if (opcode !== 0x1 && opcode !== 0x0) continue;

      let message;
      try { message = JSON.parse(payload.toString('utf8')); } catch { continue; }
      // An event carries a method and no id; a reply carries an id and wakes its caller. Before
      // this branch existed, every event the protocol sent was discarded one line below.
      if (message.method !== undefined && message.id === undefined) {
        const handlers = this.#listeners.get(message.method);
        if (handlers !== undefined) {
          for (const handler of [...handlers]) {
            try { handler(message.params ?? {}); } catch { /* a listener must not break the socket */ }
          }
        }
        continue;
      }
      const waiter = this.#pending.get(message.id);
      if (waiter === undefined) continue;
      this.#pending.delete(message.id);
      if (message.error !== undefined) waiter.reject(new Error(`${message.error.message ?? 'the browser reported an error'}`));
      else waiter.resolve(message.result);
    }
  }

  #pong(payload) {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
    const header = Buffer.alloc(6);
    header[0] = 0x8a; // FIN + pong
    header[1] = 0x80 | payload.length;
    mask.copy(header, 2);
    this.#socket.write(Buffer.concat([header, masked]));
  }

  /** Issue one CDP command and resolve with its result. */
  send(method, params = {}, timeoutMs = 20000) {
    if (this.#closed) return Promise.reject(new Error('the DevTools socket is not open'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`the browser did not answer ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try { this.#sendFrame(JSON.stringify({ id, method, params })); } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const { reject } of this.#pending.values()) reject(new Error('the DevTools socket was closed'));
    this.#pending.clear();
    try { this.#socket?.destroy(); } catch { /* already gone */ }
  }
}
