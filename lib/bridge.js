// Resident native-helper bridge.
//
// One long-lived PowerShell process runs `native/agent.ps1`, which compiles the
// C# P/Invoke layer once and then answers newline-delimited JSON requests. This
// module owns the process: host probing, framing, timeouts, abort handling, and
// restart after a crash.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(HERE, '..', 'native', 'agent.ps1');

/** PowerShell hosts to try, most capable first. Windows PowerShell 5.1 is always
 *  present, so the list always terminates in something spawnable. */
function hostCandidates() {
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const list = [];
  if (process.env.DSH_COMPUTER_CONTROL_PWSH) list.push({ exe: process.env.DSH_COMPUTER_CONTROL_PWSH, label: 'env' });
  list.push({ exe: 'pwsh.exe', label: 'pwsh-path' });
  list.push({ exe: path.join(pf, 'PowerShell', '7', 'pwsh.exe'), label: 'pwsh-7' });
  list.push({ exe: path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), label: 'windows-powershell' });
  list.push({ exe: 'powershell.exe', label: 'windows-powershell-path' });
  return list;
}

class BridgeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

export class NativeBridge {
  #logger;
  #child = null;
  #ready = null;
  #nextId = 1;
  #pending = new Map();
  #stderr = [];
  #stdoutBuf = '';
  #hello = null;
  #host = null;
  #disposed = false;
  #lastError = null;

  constructor({ logger } = {}) {
    this.#logger = logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  }

  get hello() {
    return this.#hello;
  }

  get host() {
    return this.#host;
  }

  get running() {
    return this.#child !== null && this.#child.exitCode === null && !this.#child.killed;
  }

  /** Diagnostics for a failing tool call: host selection plus the helper's stderr tail. */
  diagnostics() {
    return {
      host: this.#host,
      running: this.running,
      stderr: this.#stderr.slice(-25).join('\n'),
      lastError: this.#lastError,
    };
  }

  async #start() {
    if (this.running) return;
    if (this.#ready) return this.#ready;
    this.#ready = this.#spawnFirstWorkingHost().finally(() => {
      this.#ready = null;
    });
    return this.#ready;
  }

  async #spawnFirstWorkingHost() {
    if (!existsSync(AGENT)) throw new BridgeError(`native helper script is missing: ${AGENT}`, 'HELPER_MISSING');
    const failures = [];
    for (const candidate of hostCandidates()) {
      if (this.#disposed) throw new BridgeError('bridge disposed', 'DISPOSED');
      try {
        await this.#spawnOne(candidate);
        return;
      } catch (error) {
        failures.push(`${candidate.label} (${candidate.exe}): ${error.message}`);
        this.#kill();
      }
    }
    throw new BridgeError(`no PowerShell host could start the native helper:\n${failures.join('\n')}`, 'NO_HOST');
  }

  #spawnOne(candidate) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(
          candidate.exe,
          // The helper watches this pid and exits with it, so an abruptly killed
          // harness cannot leave a helper - and its on-screen indicator - behind.
          ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', AGENT, '-ParentPid', String(process.pid)],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          },
        );
      } catch (error) {
        reject(error);
        return;
      }
      this.#child = child;
      this.#stdoutBuf = '';
      this.#stderr = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('helper did not report ready within 30000 ms'));
        try { child.kill(); } catch {}
      }, 30_000);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        this.#stdoutBuf += chunk;
        let nl;
        while ((nl = this.#stdoutBuf.indexOf('\n')) >= 0) {
          const line = this.#stdoutBuf.slice(0, nl).trim();
          this.#stdoutBuf = this.#stdoutBuf.slice(nl + 1);
          if (line.length === 0) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            this.#logger.warn?.(`computer-control: unparseable helper output: ${line.slice(0, 300)}`);
            continue;
          }
          if (msg.id === 0 && msg.ok === true && msg.result?.hello === true) {
            this.#hello = msg.result;
            this.#host = candidate;
            this.#logger.info?.(`computer-control: native helper ready via ${candidate.label} (${candidate.exe}), dpi=${msg.result.dpiMode}`);
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve();
            }
            continue;
          }
          this.#settle(msg);
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.trim().length === 0) continue;
          this.#stderr.push(line);
          if (this.#stderr.length > 200) this.#stderr.shift();
        }
      });

      child.on('error', (error) => {
        this.#lastError = error.message;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });

      child.on('exit', (code, signal) => {
        const wasReady = this.#hello !== null;
        this.#lastError = `helper exited with code ${code}${signal ? ` signal ${signal}` : ''}`;
        this.#child = null;
        this.#hello = null;
        for (const [, pending] of this.#pending) {
          clearTimeout(pending.timer);
          pending.reject(new BridgeError(`native helper exited before answering (${this.#lastError})`, 'HELPER_EXITED'));
        }
        this.#pending.clear();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`helper exited during startup with code ${code}`));
        } else if (wasReady) {
          this.#logger.warn?.(`computer-control: native helper exited (code ${code}); it will restart on the next call`);
        }
      });
    });
  }

  #settle(msg) {
    const pending = this.#pending.get(msg.id);
    if (!pending) return;
    this.#pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok === true) pending.resolve(msg.result);
    else pending.reject(new BridgeError(msg.error ?? 'native helper reported an unspecified failure', 'HELPER_ERROR'));
  }

  #kill() {
    const child = this.#child;
    this.#child = null;
    this.#hello = null;
    if (child) {
      try { child.kill(); } catch {}
    }
  }

  /**
   * Invoke one helper operation.
   * @param op - the op name understood by agent.ps1.
   * @param args - JSON-serializable arguments.
   * @param options - `timeoutMs` and an optional `signal`.
   */
  async call(op, args = {}, options = {}) {
    if (this.#disposed) throw new BridgeError('the computer-control bridge was disposed', 'DISPOSED');
    const timeoutMs = options.timeoutMs ?? 20_000;
    await this.#start();
    const child = this.#child;
    if (!child || child.exitCode !== null) throw new BridgeError('native helper is not running', 'HELPER_DOWN');
    const id = this.#nextId++;
    const payload = `${JSON.stringify({ id, op, args })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BridgeError(`native helper did not answer "${op}" within ${timeoutMs} ms`, 'TIMEOUT'));
      }, timeoutMs);
      const onAbort = () => {
        this.#pending.delete(id);
        clearTimeout(timer);
        const error = new BridgeError(`"${op}" was aborted`, 'ABORTED');
        error.name = 'AbortError';
        reject(error);
      };
      if (options.signal) {
        if (options.signal.aborted) {
          clearTimeout(timer);
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#pending.set(id, {
        resolve: (value) => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          options.signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        timer,
      });
      try {
        child.stdin.write(payload);
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new BridgeError(`could not write to the native helper: ${error.message}`, 'WRITE_FAILED'));
      }
    });
  }

  /** Stop the helper and reject anything still in flight. */
  dispose() {
    this.#disposed = true;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeError('the computer-control bridge was disposed', 'DISPOSED'));
    }
    this.#pending.clear();
    this.#kill();
  }
}
