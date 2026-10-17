// Window and application tools.
import { findWindow, hwndKey, invalidateScreenInfo, listWindows } from '../geometry.js';
import { mutate, requireRisky } from './input.js';
import { defineTool, intOr, json, mustInt, required, text } from '../toolkit.js';

function summarizeWindow(win) {
  const state = win.minimized ? 'minimized' : win.maximized ? 'maximized' : 'normal';
  // A modal dialog blocks its owner, so it has to be impossible to mistake one for
  // an ordinary window in the text the model actually reads.
  const dialog = win.dialog === true ? ' DIALOG(blocks its owner)' : '';
  return `${win.hwnd} ${state}${dialog}${win.foreground ? ' focused' : ''} ${win.width}x${win.height} at (${win.x},${win.y}) ${win.process} - ${win.title || '(untitled)'}`;
}

export function windowTools(runtime) {
  const { bridge, cfg } = runtime;

  const list = defineTool({
    name: 'window_list',
    description:
      'List top-level windows in z-order, front to back, with each hwnd, title, owning process, rectangle and state. Use it to find the exact hwnd or title to act on, and to confirm whether a window opened, closed, is minimized, or is already focused. `title`, `process` and `class` are case-insensitive regular expressions.',
    parameters: {
      title: { type: 'string', description: 'Keep only windows whose title matches this regular expression.' },
      process: { type: 'string', description: 'Keep only windows whose executable name matches this regular expression, for example "chrome".' },
      class: { type: 'string', description: 'Keep only windows whose window class matches this regular expression.' },
      visibleOnly: { type: 'boolean', description: 'Skip hidden windows. Defaults to true.' },
      limit: { type: 'integer', description: 'Maximum rows returned. Defaults to 40.' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        if (value.windows.length === 0) return text(`No window matched (${value.total} window(s) were scanned).`);
        const lines = [`${value.windows.length} of ${value.total} window(s), front to back:`];
        for (const win of value.windows) lines.push(`  ${summarizeWindow(win)}`);
        return text(lines.join('\n'));
      },
    },
    async execute(args, exec) {
      const all = await listWindows(runtime, { visibleOnly: args.visibleOnly !== false });
      const compile = (source) => {
        if (source === undefined || source === null || String(source).length === 0) return null;
        try {
          return new RegExp(String(source), 'i');
        } catch (error) {
          throw new Error(`invalid regular expression ${JSON.stringify(source)}: ${error.message}`);
        }
      };
      const title = compile(args.title);
      const process = compile(args.process);
      const klass = compile(args.class);
      const filtered = all.filter((win) => {
        if (title && !title.test(win.title ?? '')) return false;
        if (process && !process.test(win.process ?? '')) return false;
        if (klass && !klass.test(win.class ?? '')) return false;
        return true;
      });
      const limit = intOr(args.limit, 40, { min: 1, max: 500, name: 'limit' });
      return { total: all.length, windows: filtered.slice(0, limit), truncated: filtered.length > limit };
    },
    presentCall: (args) => ({ card: 'generic', title: args.title ? `List windows matching ${args.title}` : 'List windows', kind: 'read' }),
  });

  const control = defineTool({
    name: 'window_control',
    description:
      'Act on one window. Select it with `window` (an hwnd like "0x1A2B" or a case-insensitive title expression); omit it to mean the foreground window. Actions: "focus" brings it to the foreground (reporting whether it actually took focus), "minimize", "maximize", "restore", "show", "move" (with x/y/width/height, any of which defaults to the current value), "topmost" (with `topmost` true or false), "wait" (block until a condition holds, useful right after launching something), and "close" (asks the window to close, the same as clicking its X). Focus must usually be confirmed before typing, because keystrokes go to whatever is focused.',
    parameters: {
      action: { type: 'string', required: true, enum: ['focus', 'minimize', 'maximize', 'restore', 'show', 'move', 'topmost', 'wait', 'close'], description: 'What to do.' },
      window: { type: 'string', description: 'Window selector. Defaults to the foreground window.' },
      x: { type: 'integer', description: 'New left edge for "move".' },
      y: { type: 'integer', description: 'New top edge for "move".' },
      width: { type: 'integer', description: 'New width for "move".' },
      height: { type: 'integer', description: 'New height for "move".' },
      topmost: { type: 'boolean', description: 'Whether the window should stay above others, for the "topmost" action.' },
      condition: { type: 'string', enum: ['exists', 'foreground'], description: 'Wait condition. "exists" (default) waits for the window to appear; "foreground" waits for it to gain focus.' },
      timeoutMs: { type: 'integer', description: 'Wait timeout in milliseconds. Defaults to 10000.' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => json(value, 2),
    },
    async execute(args, exec) {
      if (args.action === 'wait') {
        const timeoutMs = intOr(args.timeoutMs, 10_000, { min: 0, max: 600_000, name: 'timeoutMs' });
        const result = await bridge.call(
          'window.wait',
          { selector: args.window ?? '', timeoutMs, condition: args.condition === 'foreground' ? 'foreground' : 'exists' },
          { timeoutMs: timeoutMs + cfg.helperTimeoutMs, signal: exec.signal },
        );
        return { action: 'wait', ...result };
      }
      const win = await findWindow(runtime, args.window);
      if (!win || !win.hwnd) throw new Error('the window selector resolved to nothing; list windows with window_list');
      if (args.action === 'close') requireRisky(runtime, 'closing a window');
      if (args.action === 'move') {
        if (win.minimized === true) throw new Error(`window ${win.hwnd} is minimized and has no usable rectangle; restore it first`);
        const result = await mutate(
          runtime,
          'window.op',
          {
            action: 'move',
            selector: win.hwnd,
            x: args.x === undefined ? win.x : mustInt(args.x, 'x'),
            y: args.y === undefined ? win.y : mustInt(args.y, 'y'),
            width: args.width === undefined ? win.width : mustInt(args.width, 'width', { min: 1 }),
            height: args.height === undefined ? win.height : mustInt(args.height, 'height', { min: 1 }),
          },
          exec,
        );
        invalidateScreenInfo(runtime);
        return { action: 'move', ...result };
      }
      if (args.action === 'topmost') {
        const result = await mutate(runtime, 'window.op', { action: 'topmost', selector: win.hwnd, topmost: args.topmost === true }, exec);
        return { action: 'topmost', ...result };
      }
      const result = await mutate(runtime, 'window.op', { action: args.action, selector: win.hwnd }, exec);
      invalidateScreenInfo(runtime);
      if (args.action === 'focus' && result.focused !== true) {
        return {
          action: 'focus',
          ...result,
          warning: `the window did not take the foreground (Windows refused the activation); the foreground is still ${result.foregroundHwnd}. Clicking inside it with mouse_control, or focusing it manually, will make it eligible.`,
        };
      }
      return { action: args.action, ...result };
    },
    presentCall: (args) => ({ card: 'generic', title: `Window ${args.action} ${args.window ?? '(foreground)'}`, kind: 'execute' }),
    isConcurrencySafe: () => false,
  });

  const app = defineTool({
    name: 'app_control',
    description:
      'Start and inspect desktop applications. Actions: "launch" runs a program, opens a document, or opens a URL through the shell (give `target`, plus `arguments` and `workdir`); "list" reports every process that owns a visible window, which is how to find what is running; "activate" brings an already-running application to the front by process name or pid; "kill" terminates it. Launching returns immediately, so follow it with wait_for {mode:"window"} or window_control {action:"wait"} before interacting.',
    parameters: {
      action: { type: 'string', required: true, enum: ['launch', 'list', 'activate', 'kill'], description: 'What to do.' },
      target: { type: 'string', description: 'Executable, document, folder or URL to open, for "launch".' },
      arguments: { type: 'string', description: 'Command-line arguments for "launch", as one string.' },
      workdir: { type: 'string', description: 'Working directory for "launch".' },
      filter: { type: 'string', description: 'Case-insensitive regular expression over process name or window title, for "list".' },
      process: { type: 'string', description: 'Process name to activate or kill, for example "notepad".' },
      pid: { type: 'integer', description: 'Process id to activate or kill.' },
      waitMs: { type: 'integer', description: 'After launching, wait this long for a window belonging to the new process to appear. Defaults to 0.' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => json(value, 2),
    },
    async execute(args, exec) {
      if (args.action === 'launch') {
        const target = required(args.target, 'target');
        if (runtime.cfg.dryRun === true) return { dryRun: true, wouldRun: { op: 'app.launch', target } };
        // An application can already own windows (Notepad keeps every untitled
        // document inside one process), so only a window that did not exist before
        // this launch can be the one it just opened.
        const before = new Set((await listWindows(runtime, { visibleOnly: true })).map((w) => hwndKey(w.hwnd)));
        const launched = await bridge.call(
          'app.launch',
          { target, arguments: args.arguments ?? '', workdir: args.workdir ?? '' },
          { timeoutMs: cfg.helperTimeoutMs + 15_000, signal: exec.signal },
        );
        const waitMs = intOr(args.waitMs, 0, { min: 0, max: 120_000, name: 'waitMs' });
        if (waitMs <= 0) return { action: 'launch', ...launched, hint: 'The process was started. Wait for its window with wait_for {mode:"window", window:"<title fragment>"} before clicking.' };
        const wanted = String(launched.name ?? '').toLowerCase().replace(/\.exe$/, '');
        const deadline = Date.now() + waitMs;
        let window;
        let newWindows = [];
        while (Date.now() < deadline) {
          const windows = await listWindows(runtime, { visibleOnly: true });
          newWindows = windows.filter((w) => !before.has(hwndKey(w.hwnd)));
          const named = newWindows.find((w) => {
            if (wanted.length === 0) return true;
            const name = String(w.process ?? '').toLowerCase().replace(/\.exe$/, '');
            return name === wanted || name.startsWith(wanted);
          });
          // A packaged app (Calculator, Photos, Settings) runs inside a host process,
          // so its window carries no name match at all. Falling back to the single new
          // window keeps those launchable without guessing when several appeared.
          window = named ?? (newWindows.length === 1 ? newWindows[0] : undefined);
          if (window) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        invalidateScreenInfo(runtime);
        if (window) {
          const matchedByProcess = wanted.length > 0 && String(window.process ?? '').toLowerCase().replace(/\.exe$/, '').startsWith(wanted);
          return {
            action: 'launch',
            ...launched,
            // Report the pid that owns the window, because that is the one that stays
            // useful: a packaged app's launched process is only a launcher and exits
            // immediately, so handing back its pid made the obvious next call -
            // activate with the pid launch just returned - fail with "no window".
            ...(window.pid === undefined || window.pid === launched.pid
              ? {}
              : { pid: window.pid, launcherPid: launched.pid }),
            window,
            ...(matchedByProcess ? {} : { windowMatchedBy: 'the only window that appeared after the launch; the app runs in a host process' }),
          };
        }
        return {
          action: 'launch',
          ...launched,
          windowMissing: `no window could be attributed to ${launched.name ?? target} within ${waitMs} ms`,
          ...(newWindows.length > 1 ? { candidates: newWindows.map((w) => `${w.hwnd} ${w.process} ${w.title}`) } : {}),
        };
      }
      if (args.action === 'list') {
        const result = await bridge.call('app.list', { filter: args.filter ?? '' }, { timeoutMs: cfg.helperTimeoutMs + 10_000, signal: exec.signal });
        return { action: 'list', ...result };
      }
      if (args.action === 'kill') {
        requireRisky(runtime, 'terminating a process');
        if (runtime.cfg.dryRun === true) return { dryRun: true, wouldRun: { op: 'app.kill', pid: args.pid, name: args.process } };
        const result = await bridge.call(
          'app.kill',
          { pid: intOr(args.pid, 0, { min: 0, name: 'pid' }), name: args.process ?? '' },
          { timeoutMs: cfg.helperTimeoutMs + 10_000, signal: exec.signal },
        );
        invalidateScreenInfo(runtime);
        return { action: 'kill', ...result };
      }
      if (args.action === 'activate') {
        const windows = await listWindows(runtime, { visibleOnly: true });
        const wanted = args.process ? String(args.process).toLowerCase() : null;
        const wantedPid = args.pid === undefined ? null : mustInt(args.pid, 'pid');
        const hit = windows.find((w) => {
          if (wantedPid !== null && w.pid === wantedPid) return true;
          if (wanted === null) return false;
          const name = String(w.process ?? '').toLowerCase().replace(/\.exe$/, '');
          return name === wanted.replace(/\.exe$/, '') || name.startsWith(wanted);
        });
        if (!hit) throw new Error(`no visible window belongs to ${wantedPid !== null ? `pid ${wantedPid}` : JSON.stringify(args.process)}; run app_control {action:"list"} to see what is running`);
        const result = await mutate(runtime, 'window.op', { action: 'focus', selector: hit.hwnd }, exec);
        invalidateScreenInfo(runtime);
        return { action: 'activate', ...result };
      }
      throw new Error(`unknown action ${JSON.stringify(args.action)}; use launch, list, activate, or kill`);
    },
    presentCall: (args) => ({ card: 'generic', title: `App ${args.action} ${args.target ?? args.process ?? ''}`.trim(), kind: 'execute' }),
    isConcurrencySafe: () => false,
  });

  return [list, control, app];
}
