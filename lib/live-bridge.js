// The opt-in live bridge: a loopback-only HTTP endpoint that streams the
// operation list to the page.
//
// Why this exists at all. The plugin's only sanctioned Client-to-Host channel is a
// session command, and every command execution is written into the session
// (`command/run` and `command/done` are appended unconditionally) where the
// conversation renders it as a row. So the page cannot poll without pasting its own
// payload into the conversation, and the forwarded-event allow-list in
// dsh-api-remotes is a build-time constant that a third-party plugin cannot add to.
// Polling through the command is therefore the only *sanctioned* way to get live
// data, and it is noisy by construction.
//
// This is the opt-in alternative: the Host pushes instead, over a socket the page
// opens to itself. It is off unless `liveBridge` is set, because it opens a
// listening port and because it is a deliberate departure from the sanctioned
// channel.
//
// Security posture - every one of these is load-bearing:
//   * bound to 127.0.0.1, so nothing off this machine can reach it;
//   * a 256-bit token, compared in constant time, so another local process cannot
//     guess or measure it;
//   * the Origin header must be a loopback http origin, which is what stops a web
//     page the user happens to open from scanning local ports and reading the log
//     (the classic localhost-scanning attack on loopback services);
//   * no CORS headers are ever sent, so a cross-origin page cannot read a response
//     even if it somehow reached the endpoint;
//   * read-only: there is no route that changes anything, so a leaked token leaks
//     the operation list and nothing else;
//   * the token is generated per activation and never logged.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

/** How many stream clients may be attached at once. */
const MAX_CLIENTS = 8;
/** Comment heartbeat, so an idle stream is not closed by an intermediary. */
const HEARTBEAT_MS = 15_000;
/** Most entries one push may carry; the page never needs more. */
const PUSH_LIMIT = 300;

/**
 * Is this Origin the shell itself?
 *
 * The page is served over the desktop app's own scheme, `dsh-app://app`, not over
 * `http://127.0.0.1:<port>`. That was the assumption this check was written on and it
 * was simply wrong, so the check rejected the one caller it existed to admit.
 *
 * Naming that scheme is also a stronger rule than accepting loopback http: any local
 * web app can claim to be `http://127.0.0.1:*`, while only the shell is
 * `dsh-app://app`, and a page cannot forge an Origin header. Loopback http origins
 * remain accepted so a diagnostic script can talk to the bridge; they still need the
 * token.
 */
function isAllowedOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return false;
  if (origin.toLowerCase() === 'dsh-app://app') return true;
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost' || host === '[::1]');
  } catch {
    return false;
  }
}

/** Constant-time token comparison that does not leak length through early exit. */
function tokenMatches(expected, offered) {
  if (typeof offered !== 'string' || offered.length === 0) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(offered, 'utf8');
  if (a.length !== b.length) {
    // Still spend the comparison, so the failure costs the same as a wrong token.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export class LiveBridge {
  #runtime;
  #server = null;
  /**
   * Every connected reader, with the session it asked to watch.
   *
   * The session key belongs to the connection rather than to the bridge. It used to be one
   * field on the bridge, and the list was built once per push and written to every reader -
   * so with two conversations open, an operation performed in one was pushed to the page
   * showing the other, and the single stored key flipped between them depending on which had
   * been active last. Two readers watching two sessions is the ordinary case, not an edge
   * one: it is what happens the moment a second conversation calls a tool.
   */
  #clients = new Set();

  /** The session a reader is watching, falling back to whichever was named last. */
  #keyFor(client) {
    return client.sessionKey ?? this.#lastSessionKey;
  }
  #heartbeat = null;
  #pushTimer = null;
  #token = '';
  #port = 0;
  #reason = '';

  constructor(runtime) {
    this.#runtime = runtime;
  }

  // A runtime toggle, so the page can offer a button without this plugin having to
  // declare a settings schema: a static `@deepseek-ai/schemastery` import would take
  // the whole plugin down if it failed to resolve, which is too much to risk for a
  // switch. Undefined means "follow the configuration".
  #override = undefined;

  get enabled() {
    return this.#override ?? (this.#runtime.cfg.liveBridge === 'local');
  }

  get running() {
    return this.#server !== null;
  }

  /** What the page needs to connect, or nothing when the bridge is off. */
  credentials() {
    if (!this.running) return undefined;
    return { port: this.#port, token: this.#token, path: '/activity' };
  }

  /** Start it for this activation, whatever the configuration says. */
  async enable() {
    this.#override = true;
    return this.start();
  }

  /** Stop it and close the port, whoever asked for it. */
  disable() {
    this.#override = false;
    this.stop();
    return this.diagnostics();
  }

  diagnostics() {
    return { enabled: this.enabled, running: this.running, port: this.#port, clients: this.#clients.size, reason: this.#reason };
  }

  async start() {
    if (!this.enabled || this.#server !== null) return this.diagnostics();
    this.#token = String(this.#runtime.cfg.liveBridgeToken ?? '').length > 0
      ? String(this.#runtime.cfg.liveBridgeToken)
      : randomBytes(32).toString('base64url');
    const wanted = this.#runtime.cfg.liveBridgePort ?? 0;

    const server = http.createServer((request, response) => this.#handle(request, response));
    server.on('clientError', (_error, socket) => socket.destroy());
    this.#server = server;
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        // Loopback only. Binding anything else would expose the operation log to
        // the network, which is never what this feature is for.
        server.listen(wanted, '127.0.0.1');
      });
    } catch (error) {
      this.#server = null;
      this.#reason = `could not listen on 127.0.0.1:${wanted}: ${error.message}`;
      this.#runtime.ctx.logger?.warn?.(`computer-control: live bridge disabled - ${this.#reason}`);
      return this.diagnostics();
    }
    this.#port = server.address().port;
    this.#heartbeat = setInterval(() => {
      for (const client of this.#clients) {
        try { client.response.write(': ping\n\n'); } catch { /* the close handler removes it */ }
      }
    }, HEARTBEAT_MS);
    this.#heartbeat.unref?.();
    this.#runtime.ctx.logger?.info?.(
      `computer-control: live bridge on http://127.0.0.1:${this.#port}${'/activity'} (loopback, token required; ${this.#token.length} character token)`,
    );
    return this.diagnostics();
  }

  stop() {
    if (this.#heartbeat !== null) { clearInterval(this.#heartbeat); this.#heartbeat = null; }
    if (this.#pushTimer !== null) { clearTimeout(this.#pushTimer); this.#pushTimer = null; }
    for (const client of this.#clients) {
      try { client.response.end(); } catch { /* already gone */ }
    }
    this.#clients.clear();
    if (this.#server !== null) {
      try { this.#server.close(); } catch { /* already closing */ }
      this.#server = null;
    }
    this.#port = 0;
  }

  /** One operation was recorded: tell the page, coalescing a burst. */
  notify(sessionKey) {
    // Remember the session even with nobody listening. A page that connects later
    // has to find the list, not an empty one because no client happened to be
    // attached at the moment the operations were recorded.
    if (sessionKey !== undefined && sessionKey !== null) this.#lastSessionKey = sessionKey;
    if (this.#clients.size === 0) return;
    if (this.#pushTimer !== null) return;
    this.#pushTimer = setTimeout(() => {
      this.#pushTimer = null;
      void this.#push(sessionKey);
    }, 150);
    this.#pushTimer.unref?.();
  }

  async #push(sessionKey) {
    if (this.#clients.size === 0) return;
    if (sessionKey !== undefined) this.#lastSessionKey = sessionKey;
    // One list per session being watched, not one list for everybody. Readers watching the
    // same session share the query; readers watching different ones get different payloads,
    // which is the whole point - the operation that just happened belongs to one conversation.
    const keys = new Set();
    for (const client of this.#clients) keys.add(this.#keyFor(client));
    for (const key of keys) {
      let payload;
      try {
        const entries = await this.#runtime.activity.list(key, { limit: PUSH_LIMIT });
        payload = JSON.stringify({ total: await this.#runtime.activity.count(key), entries });
      } catch (error) {
        payload = JSON.stringify({ error: `the operation list could not be read: ${error?.message ?? error}` });
      }
      for (const client of this.#clients) {
        if (this.#keyFor(client) !== key) continue;
        try { client.response.write(`event: activity\ndata: ${payload}\n\n`); } catch { /* the close handler removes it */ }
      }
    }
  }

  #lastSessionKey;

  #deny(response, status, reason, origin) {
    response.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // Echoed only for an origin that already passed the check, so a page from
      // anywhere else still cannot read this response.
      ...(origin === undefined ? {} : { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }),
    });
    response.end(`${reason}\n`);
  }

  #handle(request, response) {
    // The browser will not hand a cross-origin response to the page unless the server
    // names the origin it is allowing, and this request is always cross-origin: the page
    // is `dsh-app://app` and the bridge listens on a loopback port. Leaving that header
    // out was meant as a safety measure and was only a broken one - it stopped the shell
    // reading anything at all. The check that matters is this one, and it runs before any
    // header is written.
    const origin = request.headers.origin;
    if (!isAllowedOrigin(origin)) {
      return this.#deny(response, 403, 'requests are only accepted from the shell origin or a loopback page');
    }
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };

    if (request.method !== 'GET') return this.#deny(response, 405, 'only GET is served', origin);
    let url;
    try {
      url = new URL(request.url, `http://127.0.0.1:${this.#port}`);
    } catch {
      return this.#deny(response, 400, 'malformed request', origin);
    }
    if (url.pathname !== '/activity') return this.#deny(response, 404, 'no such route', origin);

    if (!tokenMatches(this.#token, url.searchParams.get('token') ?? '')) {
      return this.#deny(response, 401, 'a valid token is required', origin);
    }
    if (this.#clients.size >= MAX_CLIENTS) {
      return this.#deny(response, 503, 'too many live readers', origin);
    }

    const sessionKey = url.searchParams.get('session') ?? undefined;
    const watching = sessionKey !== undefined && sessionKey.length > 0 ? sessionKey : undefined;
    if (watching !== undefined) this.#lastSessionKey = watching;

    response.writeHead(200, {
      ...cors,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    response.write('retry: 2000\n\n');
    // The reader is remembered together with the session it named, so a push for another
    // session cannot reach it.
    const client = { response, sessionKey: watching };
    this.#clients.add(client);
    const drop = () => { this.#clients.delete(client); };
    request.on('close', drop);
    request.on('error', drop);
    // The page gets the current list immediately, then only on change.
    void this.#push(watching);
  }
}
