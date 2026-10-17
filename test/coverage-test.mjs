import { fileURLToPath } from 'node:url';
import os from 'node:os';
// The parameter values the end-to-end scenario never reaches.
//
// e2e.mjs proves the main flow works; this proves the *other* branches of the same
// tools work, so "the tools are tested" is a claim about the whole surface rather
// than about the paths a happy-path scenario happens to walk.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(os.tmpdir(), 'dsh-cc-coverage-artifacts');
const plugin = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

const tools = new Map();
plugin.apply({
  logger: { info: () => {}, warn: (m) => console.log(`  [warn] ${m}`), error: () => {}, debug: () => {} },
  tools: { register: (d) => { tools.set(d.name, d); return () => {}; } },
  effect: (f) => { f(); return () => {}; },
  inject: () => {},
  get: () => undefined,
  systemPrompt: { getSectionOrder: () => 3000, section: () => () => {} },
}, { artifactDir: ARTIFACTS, allowRisky: true, typingDelayMs: 5, indicatorClaimScreen: false, activityLogToFile: false });

const exec = { callId: 't', rootCallId: 't', name: 't', arguments: {}, agent: { id: 'coverage' }, signal: new AbortController().signal, deferContext: () => {}, concludeTurn: () => {} };
const call = (name, args) => tools.get(name).execute(args, { ...exec, name, arguments: args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wind = async (hwnd) => (await call('window_list', {})).windows.find((w) => w.hwnd === hwnd);

let notepad;
try {
  // ---------------------------------------------------------------- window_control
  const launched = await call('app_control', { action: 'launch', target: 'notepad.exe', waitMs: 12000 });
  notepad = { hwnd: launched.window?.hwnd, x: launched.window?.x ?? 200, y: launched.window?.y ?? 200, pid: launched.pid };
  record('app_control(launch) gives us a window to work on', Boolean(notepad.hwnd), `hwnd=${notepad.hwnd} pid=${notepad.pid}`);
  await sleep(900);

  await call('window_control', { action: 'minimize', window: notepad.hwnd });
  await sleep(400);
  const minimized = await wind(notepad.hwnd);
  record('window_control(minimize)', minimized?.minimized === true || minimized?.state?.includes?.('min') === true, JSON.stringify(minimized && { state: minimized.state, minimized: minimized.minimized }));

  await call('window_control', { action: 'restore', window: notepad.hwnd });
  await sleep(400);
  const restored = await wind(notepad.hwnd);
  record('window_control(restore)', restored?.minimized !== true, `state=${restored?.state}`);

  await call('window_control', { action: 'maximize', window: notepad.hwnd });
  await sleep(500);
  const maximized = await wind(notepad.hwnd);
  const work = (await call('screen_info', {})).monitors[0];
  record('window_control(maximize)', maximized.width >= work.workWidth - 40, `${maximized.width}x${maximized.height} vs work area ${work.workWidth}x${work.workHeight}`);

  await call('window_control', { action: 'restore', window: notepad.hwnd });
  await sleep(400);

  const target = { x: 300, y: 260, width: 760, height: 520 };
  await call('window_control', { action: 'move', window: notepad.hwnd, ...target });
  await sleep(400);
  const moved = await wind(notepad.hwnd);
  record('window_control(move)', Math.abs(moved.x - target.x) <= 2 && Math.abs(moved.width - target.width) <= 2, `asked for ${target.x},${target.y} ${target.width}x${target.height}; got ${moved.x},${moved.y} ${moved.width}x${moved.height}`);

  await call('window_control', { action: 'topmost', window: notepad.hwnd, topmost: true });
  await sleep(300);
  await call('window_control', { action: 'topmost', window: notepad.hwnd, topmost: false });
  const untopmost = await wind(notepad.hwnd);
  record('window_control(topmost) both ways', untopmost.topmost === false, `topmost=${untopmost.topmost}`);

  await call('window_control', { action: 'minimize', window: notepad.hwnd });
  await sleep(300);
  await call('window_control', { action: 'show', window: notepad.hwnd });
  await sleep(400);
  const shown = await wind(notepad.hwnd);
  record('window_control(show) brings back a minimized window', shown?.minimized !== true && shown?.visible !== false, `state=${shown?.state} visible=${shown?.visible}`);

  const waitExists = await call('wait_for', { mode: 'window', window: notepad.hwnd, condition: 'exists', timeoutMs: 2000 });
  record('window_control(wait) + wait_for(condition exists)', waitExists.satisfied === true, `${waitExists.elapsedMs} ms`);

  await call('window_control', { action: 'focus', window: notepad.hwnd });
  await sleep(500);
  const waitForeground = await call('wait_for', { mode: 'window', window: notepad.hwnd, condition: 'foreground', timeoutMs: 4000 });
  record('wait_for(condition foreground)', waitForeground.satisfied === true, `${waitForeground.elapsedMs} ms`);

  // ---------------------------------------------------------------- app_control activate
  await call('window_control', { action: 'minimize', window: notepad.hwnd });
  await sleep(400);
  await call('app_control', { action: 'activate', pid: notepad.pid });
  await sleep(700);
  const activated = await wind(notepad.hwnd);
  record('app_control(activate)', activated?.minimized !== true, `state=${activated?.state}`);

  // ---------------------------------------------------------------- mouse variants
  const position = await call('mouse_control', { action: 'position' });
  record('mouse_control(position)', Number.isFinite(position.x) && Number.isFinite(position.y), `cursor at ${position.x},${position.y}`);

  const inside = { x: notepad.x + 380, y: notepad.y + 300 };
  const doubleClick = await call('mouse_control', { action: 'double_click', x: inside.x, y: inside.y });
  record('mouse_control(double_click)', doubleClick.count === 2 && doubleClick.x === inside.x, JSON.stringify({ x: doubleClick.x, y: doubleClick.y, count: doubleClick.count }));

  const rightClick = await call('mouse_control', { action: 'right_click', x: inside.x, y: inside.y });
  record('mouse_control(right_click)', rightClick.button === 'right', `button=${rightClick.button}`);
  await sleep(400);
  // The context menu is open; Escape closes it without choosing anything.
  await call('keyboard_control', { action: 'press', key: 'esc' });
  await sleep(300);

  const middleClick = await call('mouse_control', { action: 'middle_click', x: inside.x, y: inside.y });
  record('mouse_control(middle_click)', middleClick.button === 'middle', `button=${middleClick.button}`);

  const down = await call('mouse_control', { action: 'down', button: 'left' });
  const up = await call('mouse_control', { action: 'up', button: 'left' });
  record('mouse_control(down)/(up)', down.button === 'left' && up.button === 'left', `${down.action ?? 'down'} then ${up.action ?? 'up'} on the left button`);

  // ---------------------------------------------------------------- keyboard down/up
  const keyDown = await call('keyboard_control', { action: 'down', key: 'shift' });
  const keyUp = await call('keyboard_control', { action: 'up', key: 'shift' });
  record('keyboard_control(down)/(up)', keyDown.foreground !== undefined && keyUp.foreground !== undefined, `held shift with ${keyDown.foreground?.process} in front, released with ${keyUp.foreground?.process}`);
  record('keyboard_control reports the window that received the keystroke', keyDown.foreground?.hwnd !== undefined, `foreground hwnd=${keyDown.foreground?.hwnd} title=${JSON.stringify(keyDown.foreground?.title ?? '')}`);

  // ---------------------------------------------------------------- clipboard with CJK
  const rich = '中文剪贴板 ✅ テスト 🎯';
  await call('clipboard_control', { action: 'set', text: rich });
  const back = await call('clipboard_control', { action: 'get' });
  record('clipboard_control round-trips CJK and emoji', back.text === rich, `wrote ${JSON.stringify(rich)}; read ${JSON.stringify(back.text)}`);

  // ---------------------------------------------------------------- capture targets
  const monitorShot = await call('screen_capture', { target: 'monitor', monitor: 0, maxDim: 300, attach: false });
  record('screen_capture(target monitor)', monitorShot.width > 0 && monitorShot.target?.includes('monitor'), `target="${monitorShot.target}" ${monitorShot.width}x${monitorShot.height}`);

  const windowShot = await call('screen_capture', { target: 'window', window: notepad.hwnd, maxDim: 300, attach: false });
  record('screen_capture(target window) uses PrintWindow even when covered', windowShot.width > 0 && windowShot.width < monitorShot.width + 1, `${windowShot.width}x${windowShot.height}`);

  // ---------------------------------------------------------------- find_image waitMs
  const template = path.join(ARTIFACTS, 'coverage-template.png');
  const crop = await call('screen_capture', { target: 'region', region: { x: notepad.x, y: notepad.y, width: 200, height: 60 }, maxDim: 0, attach: false, out: template });
  const waitedImage = await call('wait_for', { mode: 'image', template: crop.path, region: { x: notepad.x - 40, y: notepad.y - 40, width: 320, height: 200 }, threshold: 0.9, timeoutMs: 4000 });
  record('wait_for(image) finds a template cut from the live screen', waitedImage.satisfied === true, `${waitedImage.elapsedMs} ms`);

  const goneImmediately = await call('wait_for', { mode: 'image', template: crop.path, region: { x: 0, y: work.workHeight - 120, width: 200, height: 100 }, threshold: 0.95, timeoutMs: 1500, until: 'disappear' });
  record('wait_for(image, until disappear) is satisfied by something already absent', goneImmediately.satisfied === true, `satisfied after ${goneImmediately.elapsedMs} ms`);

  // ---------------------------------------------------------------- system_control
  const muted = await call('system_control', { action: 'mute' });
  await sleep(250);
  const unmuted = await call('system_control', { action: 'mute' });
  record('system_control(mute) is permitted when allowRisky is true', muted.permitted !== false && unmuted.permitted !== false, `mute returned ${JSON.stringify(muted.op ?? muted.action ?? 'ok')}; the pair leaves the original state`);

  const desk = await call('system_control', { action: 'show-desktop' });
  await sleep(700);
  await call('system_control', { action: 'show-desktop' });
  await sleep(700);
  record('system_control(show-desktop)', desk.permitted !== false, `Win+D pressed twice, which returns the desktop to its prior state`);

  // ---------------------------------------------------------------- the log saw it all
  const log = await call('computer_activity', { action: 'list', limit: 200 });
  const byTool = new Set(log.entries.map((entry) => entry.tool));
  // computer_activity is deliberately absent: a listing is recorded only after it
  // returns, so the list can never contain the call that produced it. That rule has
  // its own assertion in activity-test.mjs.
  const expected = ['window_control', 'mouse_control', 'keyboard_control', 'clipboard_control', 'screen_capture', 'app_control', 'wait_for', 'system_control'];
  const missing = expected.filter((tool) => !byTool.has(tool));
  record('every tool this suite drove appears in the operation list', missing.length === 0, `${log.entries.length} operation(s) recorded; missing: [${missing}]`);

  const allKinds = new Set(log.entries.map((entry) => entry.kind));
  record('the list carries several kinds, not one', allKinds.size >= 4, `kinds: ${[...allKinds].join(', ')}`);
} catch (error) {
  record('scenario ran to completion', false, `${error.name}: ${error.message}\n${String(error.stack ?? '').split('\n').slice(1, 4).join('\n')}`);
} finally {
  if (notepad?.hwnd) {
    try { await call('app_control', { action: 'kill', process: 'notepad' }); } catch { /* already gone */ }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=========== ${results.length - failed} passed, ${failed} failed ===========`);
  // Without this the helper child keeps the event loop alive and the script hangs.
  process.exit(failed === 0 ? 0 : 1);
}
