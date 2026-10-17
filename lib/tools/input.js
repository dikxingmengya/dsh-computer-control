// Input tools: mouse, keyboard, clipboard.
import { screenInfo } from '../geometry.js';
import { defineTool, intOr, json, mustInt, required, text } from '../toolkit.js';

const BUTTONS = ['left', 'right', 'middle'];
const MOUSE_ACTIONS = ['position', 'move', 'click', 'double_click', 'right_click', 'middle_click', 'down', 'up', 'drag', 'scroll'];
const KEY_ACTIONS = ['type', 'press', 'down', 'up', 'hotkey'];

/** Refuse a destructive action unless the profile opted in. */
export function requireRisky(runtime, what) {
  if (runtime.cfg.allowRisky !== true) {
    throw new Error(`${what} is a destructive action and this profile has allowRisky: false; set allowRisky: true in the computer-control config to permit it`);
  }
}

/** Run a mutating operation, or report what it would have done under dryRun. */
export async function mutate(runtime, op, args, exec, timeoutMs) {
  if (runtime.cfg.dryRun === true) {
    return { dryRun: true, wouldRun: { op, args }, note: 'dryRun is enabled, so no input was injected and no state changed.' };
  }
  return runtime.bridge.call(op, args, { timeoutMs: timeoutMs ?? runtime.cfg.helperTimeoutMs, signal: exec.signal });
}

/** Validate a screen point against the virtual desktop. */
async function checkPoint(runtime, x, y, label) {
  const info = await screenInfo(runtime);
  const vs = info.virtualScreen;
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${label} needs finite x and y, got (${x},${y})`);
  if (x < vs.x || y < vs.y || x >= vs.x + vs.width || y >= vs.y + vs.height) {
    throw new Error(`${label} (${x},${y}) is outside the virtual desktop, which spans x ${vs.x}..${vs.x + vs.width - 1} and y ${vs.y}..${vs.y + vs.height - 1}`);
  }
  return { x, y };
}

export function inputTools(runtime) {
  const { cfg } = runtime;

  const mouse = defineTool({
    name: 'mouse_control',
    description:
      'Drive the mouse. Coordinates are physical virtual-desktop pixels; read them from screen_capture (which states the screen-to-image mapping), find_image, or ocr_screen rather than guessing. Actions: "position" reports the current cursor; "move" glides to (x,y); "click", "double_click", "right_click", "middle_click" move then click; "down"/"up" hold or release a button for custom drags; "drag" presses at (fromX,fromY), moves to (toX,toY) and releases; "scroll" turns the wheel by `delta` (positive scrolls up, one notch is 120). Every call reports where the cursor actually ended up.',
    parameters: {
      action: { type: 'string', required: true, enum: MOUSE_ACTIONS, description: 'What to do.' },
      x: { type: 'integer', description: 'Target x. Required for move, click, double_click, right_click, middle_click.' },
      y: { type: 'integer', description: 'Target y. Required for move, click, double_click, right_click, middle_click.' },
      fromX: { type: 'integer', description: 'Drag start x.' },
      fromY: { type: 'integer', description: 'Drag start y.' },
      toX: { type: 'integer', description: 'Drag end x.' },
      toY: { type: 'integer', description: 'Drag end y.' },
      button: { type: 'string', enum: BUTTONS, description: 'Mouse button for click, down, up and drag. Defaults to left.' },
      count: { type: 'integer', description: 'Click count for "click". Defaults to 1; use 2 or the double_click action for a double click.' },
      delta: { type: 'integer', description: 'Wheel delta for "scroll", in multiples of 120. Negative scrolls down.' },
      horizontal: { type: 'boolean', description: 'Scroll sideways instead of vertically.' },
      durationMs: { type: 'integer', description: 'Glide time for move and drag, in milliseconds. Defaults to 0 (instant) for move and 300 for drag.' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => json(value, 2),
    },
    async execute(args, exec) {
      // The on-screen notice for every mouse action is raised centrally, from the
      // same table the operation list uses (see lib/activity.js).
      switch (args.action) {
        case 'position':
          return runtime.bridge.call('mouse.position', {}, { timeoutMs: cfg.helperTimeoutMs, signal: exec.signal });
        case 'move': {
          const point = await checkPoint(runtime, mustInt(args.x, 'x'), mustInt(args.y, 'y'), 'move target');
          return mutate(runtime, 'mouse.move', { ...point, durationMs: intOr(args.durationMs, 0, { min: 0, max: 10_000, name: 'durationMs' }) }, exec);
        }
        case 'click':
        case 'double_click':
        case 'right_click':
        case 'middle_click': {
          const point = await checkPoint(runtime, mustInt(args.x, 'x'), mustInt(args.y, 'y'), 'click target');
          const button = args.action === 'right_click' ? 'right' : args.action === 'middle_click' ? 'middle' : args.button ?? 'left';
          if (!BUTTONS.includes(button)) throw new Error(`button must be one of ${BUTTONS.join(', ')}, got ${JSON.stringify(args.button)}`);
          const count = args.action === 'double_click' ? 2 : intOr(args.count, 1, { min: 1, max: 10, name: 'count' });
          return mutate(runtime, 'mouse.click', { ...point, button, count }, exec);
        }
        case 'down':
        case 'up': {
          const button = args.button ?? 'left';
          if (!BUTTONS.includes(button)) throw new Error(`button must be one of ${BUTTONS.join(', ')}, got ${JSON.stringify(args.button)}`);
          return mutate(runtime, 'mouse.button', { action: args.action, button }, exec);
        }
        case 'drag': {
          const from = await checkPoint(runtime, mustInt(args.fromX, 'fromX'), mustInt(args.fromY, 'fromY'), 'drag start');
          const to = await checkPoint(runtime, mustInt(args.toX, 'toX'), mustInt(args.toY, 'toY'), 'drag end');
          const button = args.button ?? 'left';
          if (!BUTTONS.includes(button)) throw new Error(`button must be one of ${BUTTONS.join(', ')}, got ${JSON.stringify(args.button)}`);
          return mutate(
            runtime,
            'mouse.drag',
            { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, button, durationMs: intOr(args.durationMs, 300, { min: 0, max: 10_000, name: 'durationMs' }) },
            exec,
            Math.max(cfg.helperTimeoutMs, 20_000),
          );
        }
        case 'scroll': {
          const delta = mustInt(args.delta, 'delta', { min: -12_000, max: 12_000 });
          return mutate(runtime, 'mouse.scroll', { delta, horizontal: args.horizontal === true }, exec);
        }
        default:
          throw new Error(`unknown action ${JSON.stringify(args.action)}; use one of ${MOUSE_ACTIONS.join(', ')}`);
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `Mouse ${args.action}`, kind: 'execute', rawInput: args }),
    isConcurrencySafe: () => false,
  });

  const keyboard = defineTool({
    name: 'keyboard_control',
    description:
      'Send keystrokes to whatever window currently has focus. Actions: "type" enters literal text (including CJK and emoji, independent of the keyboard layout); "press" taps one named key, optionally repeated; "down"/"up" hold or release a key for chords that must span other calls; "hotkey" presses a chord such as "ctrl+shift+esc", "lwin+d" or "alt+f4". Key names include a-z, 0-9, f1-f24, enter, esc, tab, space, backspace, delete, insert, home, end, pageup, pagedown, the four arrows, ctrl/shift/alt/lwin, numpad0-9, and volumeup/volumedown/mute. Verify focus with screen_info or window_control first: keystrokes go to the foreground window, not to a named one, and every result reports which window received them. The application consumes injected input asynchronously, so confirm the outcome with wait_for or a fresh screen_capture instead of assuming the screen has already caught up.',
    parameters: {
      action: { type: 'string', required: true, enum: KEY_ACTIONS, description: 'What to do.' },
      text: { type: 'string', description: 'Text to enter when action is "type". Newlines become Enter and tabs become Tab.' },
      key: { type: 'string', description: 'Key name for press, down and up.' },
      hotkey: { type: 'string', description: 'Chord for the "hotkey" action, for example "ctrl+alt+delete". Modifiers come first.' },
      repeat: { type: 'integer', description: 'Repeat count for "press". Defaults to 1.' },
      delayMs: { type: 'integer', description: `Delay between characters when typing, in milliseconds. Defaults to ${cfg.typingDelayMs}; raise it for slow applications.` },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => json(value, 2),
    },
    async execute(args, exec) {
      // Keystrokes go to whatever holds the foreground, so sample it immediately
      // before injecting and report it: a caller that aimed at the wrong window
      // then sees that in the result instead of inferring it from the aftermath.
      const foregroundNow = async () => {
        try {
          const window = await runtime.bridge.call('window.foreground', {}, { timeoutMs: cfg.helperTimeoutMs, signal: exec.signal });
          return { hwnd: window.hwnd, title: window.title, process: window.process };
        } catch {
          return undefined;
        }
      };
      // The on-screen notice is raised centrally, from the same table the
      // operation list uses (see lib/activity.js).
      const invoke = async (op, opArgs, timeoutMs) => {
        const before = await foregroundNow();
        const result = await mutate(runtime, op, opArgs, exec, timeoutMs);
        return { ...result, ...(before ? { foreground: before } : {}) };
      };
      switch (args.action) {
        case 'type': {
          const value = required(args.text, 'text');
          const delayMs = intOr(args.delayMs, cfg.typingDelayMs, { min: 0, max: 5000, name: 'delayMs' });
          return invoke('key.type', { text: value, delayMs }, Math.max(cfg.helperTimeoutMs, 30_000));
        }
        case 'press':
          return invoke('key.press', { key: required(args.key, 'key'), action: 'press', repeat: intOr(args.repeat, 1, { min: 1, max: 500, name: 'repeat' }) });
        case 'down':
        case 'up':
          return invoke('key.press', { key: required(args.key, 'key'), action: args.action, repeat: 1 });
        case 'hotkey':
          return invoke('key.hotkey', { hotkey: required(args.hotkey, 'hotkey') });
        default:
          throw new Error(`unknown action ${JSON.stringify(args.action)}; use one of ${KEY_ACTIONS.join(', ')}`);
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.action === 'type' ? `Type ${String(args.text ?? '').slice(0, 60)}` : `Keyboard ${args.action} ${args.key ?? args.hotkey ?? ''}`.trim(),
      kind: 'execute',
    }),
    isConcurrencySafe: () => false,
  });

  const clipboard = defineTool({
    name: 'clipboard_control',
    description:
      'Read or replace the clipboard text. The reliable way to enter anything long, non-ASCII or multi-line into an application is clipboard_control {action:"set"} followed by keyboard_control {action:"hotkey", hotkey:"ctrl+v"} - it is far faster and less error-prone than typing character by character.',
    parameters: {
      action: { type: 'string', required: true, enum: ['get', 'set'], description: 'Read the clipboard, or replace it.' },
      text: { type: 'string', description: 'Replacement text when action is "set".' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => (value.action === 'get' ? text(value.text.length > 0 ? value.text : '(the clipboard holds no text)') : text(`Clipboard set to ${value.length} character(s).`)),
    },
    async execute(args, exec) {
      if (args.action === 'set') {
        const result = await mutate(runtime, 'clip.set', { text: String(args.text ?? '') }, exec);
        if (result.dryRun) return { action: 'set', dryRun: true, wouldRun: result.wouldRun };
        return { action: 'set', length: result.length ?? String(args.text ?? '').length };
      }
      const result = await runtime.bridge.call('clip.get', {}, { timeoutMs: cfg.helperTimeoutMs, signal: exec.signal });
      return { action: 'get', text: result.text ?? '' };
    },
    presentCall: (args) => ({ card: 'generic', title: args.action === 'set' ? 'Set clipboard' : 'Read clipboard', kind: args.action === 'set' ? 'edit' : 'read' }),
  });

  return [mouse, keyboard, clipboard];
}
