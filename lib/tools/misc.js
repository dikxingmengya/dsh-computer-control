// Timing, input recording/replay, and OS-level actions.
import fs from 'node:fs/promises';
import { invalidateScreenInfo, resolveSearchArea, screenInfo } from '../geometry.js';
import { currentToken, pause } from '../cancel.js';
import { mutate, requireRisky } from './input.js';
import { defineTool, intOr, json, mustInt, required, text } from '../toolkit.js';

const MOUSE_MOVE = 0x200;
const MOUSE_DOWN = { 0x201: 'left', 0x204: 'right', 0x207: 'middle' };
const MOUSE_UP = { 0x202: 'left', 0x205: 'right', 0x208: 'middle' };
const WHEEL = { 0x20a: false, 0x20e: true };
const KEY_DOWN = new Set([0x100, 0x104]);
const KEY_UP = new Set([0x101, 0x105]);
const MAX_REPLAY_EVENTS = 20000;

const SYSTEM_ACTIONS = ['volume-up', 'volume-down', 'mute', 'show-desktop', 'lock', 'monitor-off', 'screensaver', 'sleep'];
const RISKY_SYSTEM_ACTIONS = new Set(['lock', 'monitor-off', 'screensaver', 'sleep']);

function parseColor(input) {
  const raw = String(input).trim();
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(raw);
  if (rgbMatch) return { r: Number(rgbMatch[1]), g: Number(rgbMatch[2]), b: Number(rgbMatch[3]) };
  const hex = raw.replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(hex)) return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
  if (/^[0-9a-f]{3}$/i.test(hex)) return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16) };
  throw new Error(`color must look like "#RRGGBB", "RRGGBB", "#RGB", or "rgb(r,g,b)"; got ${JSON.stringify(input)}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Translate recorded low-level events into bridge operations and replay them with their timing. */
async function replay(runtime, events, exec, speed) {
  const capped = events.slice(0, MAX_REPLAY_EVENTS);
  if (runtime.cfg.dryRun === true) {
    const summary = new Map();
    for (const event of capped) {
      const key = event.kind === 'key' ? `key ${event.vk}` : `mouse ${event.msg}`;
      summary.set(key, (summary.get(key) ?? 0) + 1);
    }
    return { dryRun: true, events: capped.length, kinds: [...summary.entries()].map(([what, count]) => `${what} x${count}`) };
  }
  let previous = capped.length > 0 ? capped[0].t ?? 0 : 0;
  let performed = 0;
  // The on-screen notice is raised centrally, from the table the operation list
  // uses (see lib/activity.js).
  for (const event of capped) {
    const at = event.t ?? previous;
    const gap = Math.max(0, (at - previous) / speed);
    if (gap > 0) await sleep(Math.min(gap, 5000));
    previous = at;
    if (exec.signal?.aborted) break;
    if (event.kind === 'mouse') {
      if (event.msg === MOUSE_MOVE) {
        await runtime.bridge.call('mouse.move', { x: event.x, y: event.y, durationMs: 0 }, { timeoutMs: runtime.cfg.helperTimeoutMs });
      } else if (MOUSE_DOWN[event.msg]) {
        await runtime.bridge.call('mouse.button', { action: 'down', button: MOUSE_DOWN[event.msg] }, { timeoutMs: runtime.cfg.helperTimeoutMs });
      } else if (MOUSE_UP[event.msg]) {
        await runtime.bridge.call('mouse.button', { action: 'up', button: MOUSE_UP[event.msg] }, { timeoutMs: runtime.cfg.helperTimeoutMs });
      } else if (event.msg in WHEEL) {
        const unsigned = (event.data ?? 0) & 0xffff;
        const delta = unsigned > 0x7fff ? unsigned - 0x10000 : unsigned;
        await runtime.bridge.call('mouse.scroll', { delta, horizontal: WHEEL[event.msg] }, { timeoutMs: runtime.cfg.helperTimeoutMs });
      }
    } else if (event.kind === 'key') {
      if (KEY_DOWN.has(event.msg)) await runtime.bridge.call('key.vk', { vk: event.vk, action: 'down' }, { timeoutMs: runtime.cfg.helperTimeoutMs });
      else if (KEY_UP.has(event.msg)) await runtime.bridge.call('key.vk', { vk: event.vk, action: 'up' }, { timeoutMs: runtime.cfg.helperTimeoutMs });
    }
    performed += 1;
  }
  invalidateScreenInfo(runtime);
  return { events: capped.length, performed, truncated: events.length > capped.length, speed };
}

export function miscTools(runtime) {
  const { bridge, cfg } = runtime;

  const waitFor = defineTool({
    name: 'wait_for',
    description:
      'Block until something is true, or until a timeout expires. Modes: "sleep" pauses for `ms`; "window" waits for a window matching `window` to exist, or to take the foreground when `condition` is "foreground"; "image" polls find_image until the template appears (or disappears, with `until:"disappear"`); "color" polls a pixel or a region until the colour matches. This is how to synchronise with an application that is still loading, and it is always better than a blind fixed delay.',
    parameters: {
      mode: { type: 'string', required: true, enum: ['sleep', 'window', 'image', 'color'], description: 'What to wait for.' },
      ms: { type: 'integer', description: 'Milliseconds to pause, for mode "sleep".' },
      window: { type: 'string', description: 'Window selector (hwnd like "0x1A2B", or a case-insensitive title expression): the window to wait for in mode "window", or the area to search in modes "image" and "color".' },
      condition: { type: 'string', enum: ['exists', 'foreground'], description: 'Window condition. Defaults to "exists".' },
      template: { type: 'string', description: 'Template image path, for mode "image".' },
      threshold: { type: 'number', description: 'Match threshold for mode "image". Defaults to 0.85.' },
      until: { type: 'string', enum: ['appear', 'disappear'], description: 'Whether to wait for the condition to become true or false. Defaults to "appear".' },
      color: { type: 'string', description: 'Target colour for mode "color".' },
      at: {
        type: 'object',
        description: 'Single point to poll for mode "color"; omit it to scan a region.',
        properties: { x: { type: 'integer', required: true }, y: { type: 'integer', required: true } },
      },
      region: {
        type: 'object',
        description: 'Area to search for modes "image" and "color". Defaults to the foreground window.',
        properties: {
          x: { type: 'integer', required: true },
          y: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
        },
      },
      fullScreen: { type: 'boolean', description: 'Search the entire virtual desktop.' },
      tolerance: { type: 'integer', description: 'Per-channel colour tolerance for mode "color". Defaults to 16.' },
      timeoutMs: { type: 'integer', description: 'Give up after this long. Defaults to 10000 for a single poll cycle and 30000 overall.' },
      pollMs: { type: 'integer', description: 'Delay between polls. Defaults to 200.' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => text(value.satisfied ? `${value.mode} satisfied after ${value.elapsedMs} ms.${value.detail ? ` ${value.detail}` : ''}` : `${value.mode} was NOT satisfied within ${value.elapsedMs} ms.${value.detail ? ` ${value.detail}` : ''}`),
    },
    async execute(args, exec) {
      // The generation this call belongs to. `/computer-stop` moves it, and every loop below
      // re-checks it, so a wait can be given up without waiting for it to finish.
      const token = currentToken();
      const started = Date.now();
      const pollMs = intOr(args.pollMs, 200, { min: 20, max: 10_000, name: 'pollMs' });
      const deadline = started + intOr(args.timeoutMs, args.mode === 'sleep' ? 0 : 30_000, { min: 0, max: 3_600_000, name: 'timeoutMs' });
      if (args.mode === 'sleep') {
        const ms = mustInt(args.ms, 'ms', { min: 0, max: 3_600_000 });
        await pause(ms, token, exec);
        return { mode: 'sleep', satisfied: true, elapsedMs: Date.now() - started, detail: `slept ${ms} ms` };
      }
      if (args.mode === 'window') {
        const timeoutMs = Math.max(0, deadline - Date.now());
        const result = await bridge.call(
          'window.wait',
          { selector: args.window ?? '', timeoutMs, condition: args.condition === 'foreground' ? 'foreground' : 'exists' },
          { timeoutMs: timeoutMs + cfg.helperTimeoutMs, signal: exec.signal },
        );
        invalidateScreenInfo(runtime);
        return {
          mode: 'window',
          satisfied: result.satisfied === true,
          elapsedMs: Date.now() - started,
          detail: result.satisfied ? `window ${args.window ?? '(foreground)'} is ${args.condition === 'foreground' ? 'focused' : 'present'}` : `still not ${args.condition === 'foreground' ? 'focused' : 'present'}`,
          ...(result.foreground === undefined ? {} : { foreground: result.foreground }),
          ...(result.window === undefined ? {} : { window: result.window }),
        };
      }
      const area = await resolveSearchArea(runtime, args, 'foreground');
      const want = args.until !== 'disappear';
      if (args.mode === 'image') {
        const template = required(args.template, 'template');
        const threshold = typeof args.threshold === 'number' ? args.threshold : 0.85;
        let last;
        for (;;) {
          last = await bridge.call(
            'screen.findImage',
            { template, x: area.x, y: area.y, width: area.width, height: area.height, threshold, tolerance: 24, maxResults: 3, step: 1 },
            { timeoutMs: cfg.captureTimeoutMs, signal: exec.signal },
          );
          if (last.found === want) {
            return {
              mode: 'image',
              satisfied: true,
              elapsedMs: Date.now() - started,
              detail: last.found ? `${template} appeared at (${last.matches[0].centerX},${last.matches[0].centerY})` : `${template} is gone`,
              matches: last.matches ?? [],
            };
          }
          if (Date.now() >= deadline) {
            return { mode: 'image', satisfied: false, elapsedMs: Date.now() - started, detail: `${template} did not ${want ? 'appear' : 'disappear'} in ${area.label}` };
          }
          await pause(pollMs, token, exec);
        }
      }
      if (args.mode === 'color') {
        const target = parseColor(required(args.color, 'color'));
        const tolerance = intOr(args.tolerance, 16, { min: 0, max: 255, name: 'tolerance' });
        let last;
        for (;;) {
          let matched;
          let detail;
          if (args.at && args.at.x !== undefined && args.at.y !== undefined) {
            const pixel = await bridge.call('screen.pixel', { x: mustInt(args.at.x, 'at.x'), y: mustInt(args.at.y, 'at.y') }, { timeoutMs: cfg.helperTimeoutMs, signal: exec.signal });
            matched = Math.abs(pixel.r - target.r) <= tolerance && Math.abs(pixel.g - target.g) <= tolerance && Math.abs(pixel.b - target.b) <= tolerance;
            detail = `(${pixel.x},${pixel.y}) is ${pixel.hex}`;
            last = pixel;
          } else {
            const found = await bridge.call(
              'screen.findColor',
              { x: area.x, y: area.y, width: area.width, height: area.height, r: target.r, g: target.g, b: target.b, tolerance, step: 2, maxResults: 3 },
              { timeoutMs: cfg.captureTimeoutMs, signal: exec.signal },
            );
            matched = found.found === true;
            detail = matched ? `${found.count} matching pixel(s), first at (${found.matches[0].x},${found.matches[0].y})` : `no pixel within ${tolerance} of ${found.target}`;
            last = found;
          }
          if (matched === want) return { mode: 'color', satisfied: true, elapsedMs: Date.now() - started, detail };
          if (Date.now() >= deadline) return { mode: 'color', satisfied: false, elapsedMs: Date.now() - started, detail: `${detail} after ${Date.now() - started} ms` };
          await pause(pollMs, token, exec);
        }
      }
      throw new Error(`unknown mode ${JSON.stringify(args.mode)}; use sleep, window, image, or color`);
    },
    presentCall: (args) => ({ card: 'generic', title: `Wait for ${args.mode}`, kind: 'other' }),
    isConcurrencySafe: () => false,
  });

  const record = defineTool({
    name: 'input_record',
    description:
      'Record real mouse and keyboard activity, then replay it. "start" installs global low-level hooks and records until "stop"; every event carries a timestamp, and events injected by this plugin are excluded so a replay never records itself. "stop" returns the events, writes them to a JSON file, and leaves the path for later. "replay" re-issues a recording with its original timing, from `file` or from an inline `events` array, optionally sped up. Recording is the honest way to capture a procedure that is hard to describe: do it once by hand, then replay it.',
    parameters: {
      action: { type: 'string', required: true, enum: ['start', 'stop', 'status', 'replay'], description: 'What to do.' },
      file: { type: 'string', description: 'Path to a recording written by an earlier "stop", for "replay".' },
      events: { type: 'array', description: 'Inline events to replay, as returned by "stop".', items: { type: 'object' } },
      speed: { type: 'number', description: 'Replay speed multiplier; 2 replays twice as fast. Defaults to 1.' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => json(value, 2),
    },
    async execute(args, exec) {
      if (args.action === 'start') {
        if (cfg.dryRun === true) return { dryRun: true, wouldRun: { op: 'record.start' }, note: 'recording hooks capture real user input and are not installed under dryRun.' };
        const result = await bridge.call('record.start', {}, { timeoutMs: cfg.helperTimeoutMs });
        return { action: 'start', ...result, note: 'Perform the actions by hand, then call input_record {action:"stop"}.' };
      }
      if (args.action === 'status') {
        const result = await bridge.call('record.status', {}, { timeoutMs: cfg.helperTimeoutMs });
        return { action: 'status', ...result };
      }
      if (args.action === 'stop') {
        const result = await bridge.call('record.stop', {}, { timeoutMs: cfg.helperTimeoutMs + 10_000 });
        const events = result.events ?? [];
        const path = await runtime.artifacts.nextPath(exec.agent?.id, 'recording', 'json');
        await runtime.artifacts.writeJson(path, events);
        const counts = events.reduce((accumulator, event) => {
          const key = event.kind === 'key' ? `key ${event.vk}` : `mouse ${event.msg}`;
          accumulator[key] = (accumulator[key] ?? 0) + 1;
          return accumulator;
        }, {});
        const durationMs = events.length > 0 ? events[events.length - 1].t : 0;
        return {
          action: 'stop',
          count: events.length,
          durationMs,
          path,
          summary: Object.entries(counts).map(([what, count]) => `${what} x${count}`),
          events: events.length <= 400 ? events : events.slice(0, 400),
          eventsTruncated: events.length > 400,
          note: `Replay it with input_record {action:"replay", file:"${path}"}.`,
        };
      }
      if (args.action === 'replay') {
        let events = Array.isArray(args.events) ? args.events : null;
        let source = 'inline events';
        if (!events && args.file) {
          const raw = await fs.readFile(String(args.file), 'utf8');
          events = JSON.parse(raw);
          source = args.file;
        }
        if (!Array.isArray(events)) throw new Error('replay needs either events or a file written by an earlier stop');
        if (events.length === 0) {
          return { action: 'replay', source, events: 0, performed: 0, note: 'the recording holds no events, so nothing was replayed' };
        }
        const speed = typeof args.speed === 'number' && args.speed > 0 ? args.speed : 1;
        const result = await replay(runtime, events, exec, speed);
        return { action: 'replay', source, ...result };
      }
      throw new Error(`unknown action ${JSON.stringify(args.action)}; use start, stop, status, or replay`);
    },
    presentCall: (args) => ({ card: 'generic', title: `Input record ${args.action}`, kind: 'execute' }),
    isConcurrencySafe: () => false,
  });

  const system = defineTool({
    name: 'system_control',
    description:
      'Machine-level actions that have no window of their own: "volume-up", "volume-down", "mute" adjust the default audio output; "show-desktop" presses Win+D; "lock" locks the session; "monitor-off" blanks the display; "screensaver" starts the configured screensaver; "sleep" suspends the machine. The last four change machine state and are refused unless the profile enables allowRisky.',
    parameters: {
      action: { type: 'string', required: true, enum: SYSTEM_ACTIONS, description: 'What to do.' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => json(value, 2),
    },
    async execute(args, exec) {
      if (RISKY_SYSTEM_ACTIONS.has(args.action)) requireRisky(runtime, `the system action "${args.action}"`);
      const result = await mutate(runtime, 'sys.op', { action: args.action }, exec);
      invalidateScreenInfo(runtime);
      return { ...result, action: args.action };
    },
    presentCall: (args) => ({ card: 'generic', title: `System ${args.action}`, kind: 'execute' }),
    isConcurrencySafe: () => false,
  });

  return [waitFor, record, system];
}
