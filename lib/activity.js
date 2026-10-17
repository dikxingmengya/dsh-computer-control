// Per-session operation log and the on-screen notices derived from it.
//
// Every tool call that touches the machine is recorded: what ran, with what
// arguments, how long it took, and whether it succeeded, was refused by a risk
// gate, or was only rehearsed under dryRun. Screenshots are operations like any
// other - the person at the machine should be able to see that the screen was
// read even though nothing moved.
//
// One table drives both surfaces, so the floating notice and the operation list
// always describe the same call the same way.
//
// The log is an in-memory ring per session, mirrored to a JSONL file so a restart
// does not lose the history. It is deliberately NOT written into the session
// event log: live `Session.append` cannot mark a custom event ignorable, and a
// session carrying one would refuse to reopen.
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_LIMIT = 300;

/** Phrasing for the floating notice. An empty string means "do not announce". */
const NOTICES = {
  zh: {
    screen_capture: (args) => `正在截屏 · ${targetLabel(args)}`,
    ocr_screen: (args) => (args.query ? `正在读屏找字 · ${JSON.stringify(args.query)}` : '正在读屏取字'),
    find_image: (args) => `正在屏幕找图 · ${fileName(args.template)}`,
    find_color: (args) => (args.color ? `正在屏幕找色 · ${args.color}` : ''),
    screen_info: () => '',
    window_list: () => '',
    computer_activity: () => '',
    mouse_control: (args) => (args.action === 'position' ? '' : `正在控制鼠标 · ${mouseAction(args)}`),
    keyboard_control: (args) => `正在控制键盘 · ${keyAction(args)}`,
    clipboard_control: (args) => (args.action === 'set' ? `正在写入剪贴板 · ${String(args.text ?? '').length} 个字符` : ''),
    window_control: (args) => `正在操作窗口 · ${args.action} ${args.window ?? '(前台)'}`,
    app_control: (args) => (args.action === 'list' ? '' : `正在${appVerb(args.action)}应用 · ${args.target ?? args.process ?? ''}`.trim()),
    wait_for: (args) => (args.mode === 'sleep' ? '' : `正在等待 · ${waitLabel(args)}`),
    input_record: (args) => `正在${args.action === 'replay' ? '回放操作' : '录制操作'} · ${args.action}`,
    system_control: (args) => `正在执行系统操作 · ${args.action}`,
  },
  en: {
    screen_capture: (args) => `capturing · ${targetLabel(args)}`,
    ocr_screen: (args) => (args.query ? `reading screen text · looking for ${JSON.stringify(args.query)}` : 'reading screen text'),
    find_image: (args) => `finding on screen · ${fileName(args.template)}`,
    find_color: (args) => (args.color ? `finding colour on screen · ${args.color}` : ''),
    screen_info: () => '',
    window_list: () => '',
    computer_activity: () => '',
    mouse_control: (args) => (args.action === 'position' ? '' : `mouse · ${mouseAction(args)}`),
    keyboard_control: (args) => `keyboard · ${keyAction(args)}`,
    clipboard_control: (args) => (args.action === 'set' ? `writing the clipboard · ${String(args.text ?? '').length} characters` : ''),
    window_control: (args) => `window · ${args.action} ${args.window ?? '(foreground)'}`,
    app_control: (args) => (args.action === 'list' ? '' : `${appVerb(args.action)} app · ${args.target ?? args.process ?? ''}`.trim()),
    wait_for: (args) => (args.mode === 'sleep' ? '' : `waiting · ${waitLabel(args)}`),
    input_record: (args) => `${args.action === 'replay' ? 'replaying' : 'recording'} input`,
    system_control: (args) => `system · ${args.action}`,
  },
};

/** Phrasing for one row of the operation list. */
const SUMMARIES = {
  zh: {
    screen_capture: (args) => `截屏 · ${targetLabel(args)}`,
    screen_info: () => '查看屏幕信息',
    find_image: (args) => `找图 · ${fileName(args.template)}`,
    find_color: (args) => (args.color ? `找色 · ${args.color}` : `取色 · (${args.at?.x},${args.at?.y})`),
    ocr_screen: (args) => (args.query ? `读屏找字 · ${JSON.stringify(args.query)}` : '读屏取字'),
    mouse_control: (args) => `鼠标 · ${mouseAction(args)}`,
    keyboard_control: (args) => `键盘 · ${keyAction(args)}`,
    clipboard_control: (args) => (args.action === 'set' ? `剪贴板 · 写入 ${String(args.text ?? '').length} 个字符` : '剪贴板 · 读取'),
    browser_launch: () => '浏览器 · 启动',
    browser_tabs: () => '浏览器 · 列出标签页',
    browser_read: () => '浏览器 · 读取页面元素',
    browser_eval: (args) => `浏览器 · 执行 JS · ${String(args.expression ?? '').replace(/\s+/g, ' ').slice(0, 60)}`,
    browser_screenshot: (args) => (args.fullPage === true ? '浏览器 · 整页截图' : '浏览器 · 截图'),
    browser_command: (args) => `浏览器 · ${args.method ?? 'command'}`,
    browser_click: (args) => `浏览器 · 点击 ${args.selector ?? ''}`,
    browser_fill: (args) => `浏览器 · 填写 ${args.selector ?? ''}`,
    browser_wait: (args) => `浏览器 · 等待 ${args.selector ?? ''}`,
    browser_downloads: (args) => `浏览器 · 下载 · ${args.action ?? ''}`,
    window_list: (args) => (args.title || args.process ? `窗口列表 · ${args.title ?? args.process}` : '窗口列表'),
    window_control: (args) => `窗口 · ${args.action} ${args.window ?? '(前台)'}`,
    app_control: (args) => `应用 · ${args.action} ${args.target ?? args.process ?? ''}`.trim(),
    wait_for: (args) => `等待 · ${waitLabel(args)}`,
    input_record: (args) => `录制 · ${args.action}`,
    system_control: (args) => `系统 · ${args.action}`,
    computer_activity: () => '查看操作列表',
    fallback: (args, tool) => tool,
    kinds: { screen: '屏幕', control: '控制', browser: '浏览器', wait: '等待', query: '查询', other: '其他' },
    outcomes: { ok: '完成', refused: '被拒绝', failed: '失败', 'dry-run': '演练', aborted: '已中止' },
    blocked: '（未执行）',
  },
  en: {
    screen_capture: (args) => `capture · ${targetLabel(args)}`,
    screen_info: () => 'read display layout',
    find_image: (args) => `find image · ${fileName(args.template)}`,
    find_color: (args) => (args.color ? `find colour · ${args.color}` : `sample pixel · (${args.at?.x},${args.at?.y})`),
    ocr_screen: (args) => (args.query ? `read screen text · looking for ${JSON.stringify(args.query)}` : 'read screen text'),
    mouse_control: (args) => `mouse · ${mouseAction(args)}`,
    keyboard_control: (args) => `keyboard · ${keyAction(args)}`,
    clipboard_control: (args) => (args.action === 'set' ? `clipboard · wrote ${String(args.text ?? '').length} characters` : 'clipboard · read'),
    browser_launch: () => 'browser · launched',
    browser_tabs: () => 'browser · listed tabs',
    browser_read: () => 'browser · read page elements',
    browser_eval: (args) => `browser · ran JS · ${String(args.expression ?? '').replace(/\s+/g, ' ').slice(0, 60)}`,
    browser_screenshot: (args) => (args.fullPage === true ? 'browser · full-page screenshot' : 'browser · screenshot'),
    browser_command: (args) => `browser · ${args.method ?? 'command'}`,
    browser_click: (args) => `browser · click ${args.selector ?? ''}`,
    browser_fill: (args) => `browser · fill ${args.selector ?? ''}`,
    browser_wait: (args) => `browser · wait for ${args.selector ?? ''}`,
    browser_downloads: (args) => `browser · download · ${args.action ?? ''}`,
    window_list: (args) => (args.title || args.process ? `list windows · ${args.title ?? args.process}` : 'list windows'),
    window_control: (args) => `window · ${args.action} ${args.window ?? '(foreground)'}`,
    app_control: (args) => `app · ${args.action} ${args.target ?? args.process ?? ''}`.trim(),
    wait_for: (args) => `wait · ${waitLabel(args)}`,
    input_record: (args) => `recording · ${args.action}`,
    system_control: (args) => `system · ${args.action}`,
    computer_activity: () => 'read the operation list',
    fallback: (args, tool) => tool,
    kinds: { screen: 'screen', control: 'control', browser: 'browser', wait: 'wait', query: 'query', other: 'other' },
    outcomes: { ok: 'done', refused: 'refused', failed: 'failed', 'dry-run': 'rehearsed', aborted: 'aborted' },
    blocked: '(not performed)',
  },
};

/**
 * The kind of an operation.
 *
 * Kind follows what the operation *does*, not which tool carried it out: one tool
 * spans several forms of operation, and lumping them together hides exactly the
 * distinction a person wants when reading the list. Reading the pointer is an
 * observation, not an injection; replaying a recording moves the mouse and
 * keyboard for real, while starting one only listens; reading the clipboard
 * changes nothing, while writing it does.
 */
export function kindOf(tool, args) {
  switch (tool) {
    case 'screen_capture': return 'screen';
    case 'screen_info':
    case 'ocr_screen':
    case 'find_image':
    case 'find_color': return 'screen';
    // Mouse and keyboard are one category. They were two, and the filter row offered them as
    // two separate chips - which is a distinction made by the tool names rather than by
    // anything a reader wants to filter on. Somebody looking for "what did it do to the
    // machine" is looking for input in general, and the two chips were never both useful at
    // the same time.
    case 'mouse_control': return args?.action === 'position' ? 'screen' : 'control';
    case 'keyboard_control': return 'control';
    // Clipboard reads are queries and clipboard writes are control, but the two are the same
    // tool called two ways and separating them produced a chip that was almost always empty.
    // Filed with queries, which is where "what did it find out" belongs.
    case 'clipboard_control': return 'query';
    // One category for every browser tool: they all reach the same browser over the same
    // protocol, and a reader asking "what did it do in the browser" wants them together. Left
    // to the fallback they would all have landed in 其他, which says nothing.
    case 'browser_launch':
    case 'browser_tabs':
    case 'browser_read':
    case 'browser_eval':
    case 'browser_screenshot':
    case 'browser_command':
    case 'browser_click':
    case 'browser_fill':
    case 'browser_wait':
    case 'browser_downloads': return 'browser';
    // Listing windows is an observation, not an action, so it belongs with the other queries
    // rather than with the window operations. The kind column is where a reader looks to ask
    // "did this change anything", and a list of what is open does not change anything.
    case 'window_list': return 'query';
    // Everything that changes the machine but is not input of the mouse-and-keyboard kind:
    // moving or closing a window, starting and killing an application, changing a system
    // setting, and replaying a recording. They share one chip because a reader either wants to
    // see "what did it operate" or does not, and four chips for four tools is the tool list
    // again rather than a classification.
    case 'window_control':
    case 'app_control':
    case 'system_control':
    case 'input_record': return 'control';
    case 'wait_for': return 'wait';
    case 'computer_activity': return 'query';
    default: return 'other';
  }
}

/** Every kind the list can show, in the order the filter row presents them. */
export const KINDS = [
  'screen',
  'control',
  'browser',
  'wait',
  'query',
  'other',
];

function fileName(value) {
  return value === undefined || value === null || value === '' ? '' : String(value).split(/[\\/]/).pop();
}

function targetLabel(args) {
  if (args.target === 'window') return `窗口 ${args.window ?? ''}`.trim();
  if (args.target === 'region') return `区域 ${args.region?.width}x${args.region?.height}`;
  if (args.target === 'monitor') return `显示器 ${args.monitor ?? 0}`;
  if (args.target === 'primary') return '主显示器';
  return args.target ?? 'full';
}

function mouseAction(args) {
  const at = args.x !== undefined && args.x !== null ? ` (${args.x}, ${args.y})` : '';
  const from = args.fromX !== undefined && args.fromX !== null ? ` (${args.fromX},${args.fromY})→(${args.toX},${args.toY})` : '';
  const delta = args.delta !== undefined && args.delta !== null ? ` ${args.delta}` : '';
  return `${args.action}${at}${from}${delta}`;
}

function keyAction(args) {
  if (args.action === 'type') return `输入 ${String(args.text ?? '').length} 个字符`;
  if (args.action === 'hotkey') return String(args.hotkey ?? '');
  return `${args.action} ${args.key ?? ''}`.trim();
}

function waitLabel(args) {
  if (args.mode === 'sleep') return `${args.ms} ms`;
  if (args.mode === 'window') return `窗口 ${args.window ?? '(前台)'} ${args.condition ?? 'exists'}`;
  if (args.mode === 'image') return `图像 ${fileName(args.template)}`;
  return `颜色 ${args.color ?? ''}`.trim();
}

function appVerb(action) {
  return action === 'launch' ? '启动' : action === 'kill' ? '结束' : action === 'activate' ? '激活' : '查看';
}

/** The language the indicators and the activity list both use. */
export function resolveLanguage(setting) {
  if (setting === 'zh' || setting === 'en') return setting;
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? '';
    return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

export class ActivityLog {
  #sessions = new Map();
  #cfg;
  #runtime;
  #lang;
  #language;
  #notices;
  #summaries;
  #filePromises = new Map();
  #hydrations = new Map();

  constructor(runtime) {
    this.#cfg = runtime.cfg;
    this.#runtime = runtime;
    const language = resolveLanguage(runtime.cfg.indicatorLanguage);
    this.#language = language;
    this.#lang = SUMMARIES[language] ?? SUMMARIES.en;
    this.#notices = NOTICES[language] ?? NOTICES.en;
    this.#summaries = this.#lang;
  }

  /** Wording tables, so the tool that renders the list reads from the same source. */
  get text() {
    return this.#lang;
  }

  /** The resolved language, so every surface words itself the same way. */
  get language() {
    return this.#language;
  }

  get limit() {
    return this.#cfg.activityLogLimit ?? DEFAULT_LIMIT;
  }

  /** The notice line for a call, or '' when the call should stay silent. */
  notice(tool, args) {
    const phrase = this.#notices[tool];
    if (typeof phrase !== 'function') return '';
    try {
      return phrase(args ?? {}) ?? '';
    } catch {
      return '';
    }
  }

  #session(key) {
    const id = key && String(key).length > 0 ? String(key) : 'shared';
    let session = this.#sessions.get(id);
    if (!session) {
      session = { entries: [], nextIndex: 1 };
      this.#sessions.set(id, session);
    }
    return session;
  }

  /**
   * Begin recording one call; the returned handle closes the entry when it ends.
   *
   * The entry joins the list immediately, marked `running`, and is updated in place
   * when it settles. A person watching the list should be able to see that something
   * is happening right now - a capture takes two and a half seconds, and an operation
   * that never appeared until it finished made the page look idle throughout.
   */
  begin(tool, args, exec) {
    const session = this.#session(exec?.agent?.id);
    const entry = {
      index: session.nextIndex++,
      at: new Date().toISOString(),
      tool,
      kind: kindOf(tool, args),
      summary: this.#summarize(tool, args),
      args: this.#redactArgs(tool, args),
      outcome: 'running',
      elapsedMs: 0,
    };
    session.entries.push(entry);
    if (session.entries.length > this.limit) session.entries.splice(0, session.entries.length - this.limit);
    const started = Date.now();
    return {
      finish: (outcome, detail) => {
        entry.elapsedMs = Date.now() - started;
        if (outcome) entry.outcome = outcome;
        if (detail !== undefined) entry.detail = String(detail).slice(0, 400);
        // Only a settled operation reaches the file: the mirror is a record of what
        // happened, and a row still in flight has not happened yet.
        this.#append(exec?.agent?.id, entry);
      },
      entry,
    };
  }

  /** Clipboard text is recorded by length only: the log is not a secret store. */
  #redactArgs(tool, args) {
    if (!args || typeof args !== 'object') return {};
    const copy = { ...args };
    if (tool === 'clipboard_control' && typeof copy.text === 'string') copy.text = `<${copy.text.length} characters>`;
    if (tool === 'keyboard_control' && typeof copy.text === 'string' && copy.text.length > 80) copy.text = `${copy.text.slice(0, 80)}...`;
    return copy;
  }

  #summarize(tool, args) {
    const phrase = this.#summaries[tool] ?? this.#summaries.fallback;
    try {
      return phrase(args ?? {}, tool);
    } catch {
      return tool;
    }
  }

  /** Best-effort durability: the in-memory ring is authoritative for the session. */
  #append(sessionKey, entry) {
    if (this.#cfg.activityLogToFile !== true) return;
    const previous = this.#filePromises.get(sessionKey) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const dir = await this.#runtime.artifacts.dirFor(sessionKey);
        await fs.appendFile(path.join(dir, 'operations.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
      })
      .catch(() => {});
    this.#filePromises.set(sessionKey, next);
  }

  list(sessionKey, { limit = 30, kind, since } = {}) {
    return this.hydrate(sessionKey).then(() => {
      let entries = this.#session(sessionKey).entries;
      if (kind) entries = entries.filter((entry) => entry.kind === kind);
      if (since !== undefined && since !== null) entries = entries.filter((entry) => entry.index > since);
      return entries.slice(-limit);
    });
  }

  count(sessionKey) {
    return this.hydrate(sessionKey).then(() => this.#session(sessionKey).entries.length);
  }

  async clear(sessionKey) {
    await this.hydrate(sessionKey);
    const session = this.#session(sessionKey);
    const removed = session.entries.length;
    session.entries = [];
    session.nextIndex = 1;
    // Clearing has to clear: leaving the file behind would make the next read pull
    // every "cleared" operation straight back in.
    try {
      const dir = await this.#runtime.artifacts.dirFor(sessionKey);
      await fs.rm(path.join(dir, 'operations.jsonl'), { force: true });
    } catch {
      /* already absent is the state we want */
    }
    return removed;
  }

  /** Read the mirrored file, which is the durable half of the log. */
  async history(sessionKey, limit) {
    const entries = await this.#readFile(sessionKey);
    return entries.slice(-limit);
  }

  async #readFile(sessionKey) {
    try {
      const dir = await this.#runtime.artifacts.dirFor(sessionKey);
      const text = await fs.readFile(path.join(dir, 'operations.jsonl'), 'utf8');
      return text
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Pull this session's earlier operations back out of the file, once.
   *
   * The in-memory ring lives as long as one activation of the plugin, not as long
   * as the session. Without this, reloading the plugin - or toggling it in the
   * Plugin Manager - restarted the numbering at #1 and made a session with a long
   * history look empty, even though the file still held every operation.
   *
   * Records made while the read is in flight are kept: an entry that reached the
   * file first is recognised by its timestamp and tool and not counted twice.
   */
  hydrate(sessionKey) {
    const id = sessionKey && String(sessionKey).length > 0 ? String(sessionKey) : 'shared';
    let pending = this.#hydrations.get(id);
    if (pending === undefined) {
      pending = (async () => {
        const session = this.#session(id);
        const recorded = session.entries;
        const stored = await this.#readFile(id);
        const seen = new Set(stored.map((entry) => `${entry.at}\0${entry.tool}`));
        const fresh = recorded.filter((entry) => !seen.has(`${entry.at}\0${entry.tool}`));
        session.entries = [...stored, ...fresh]
          .slice(-this.limit)
          // The kind is derived data, and every record carries the tool and arguments
          // it came from. Recomputing it here is what keeps one session readable across
          // a taxonomy change; a record written before the change would otherwise keep
          // a retired kind forever and appear as an unnamed extra bucket.
          .map((entry, at) => ({ ...entry, kind: kindOf(entry.tool, entry.args), index: at + 1 }));
        session.nextIndex = session.entries.length + 1;
      })();
      this.#hydrations.set(id, pending);
    }
    return pending;
  }
}