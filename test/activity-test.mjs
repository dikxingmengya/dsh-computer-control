import { fileURLToPath } from 'node:url';
import os from 'node:os';
// Verifies the operation list and the notices that go with it: that every kind of
// call is recorded, that captures are recorded and announced like inputs, and
// that refusals and rehearsals are labelled rather than silently dropped.
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(os.tmpdir(), 'dsh-cc-activity-artifacts');
const plugin = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${String(detail).replace(/\n/g, '\n        ').slice(0, 900)}` : ''}`);
};

function build(config = {}) {
  const tools = new Map();
  plugin.apply({
    logger: { info: () => {}, warn: (m) => console.log(`        [warn] ${m}`), error: () => {}, debug: () => {} },
    tools: { register: (d) => { tools.set(d.name, d); return () => {}; } },
    effect: (f) => { f(); return () => {}; },
    inject: () => {},
    get: () => undefined,
    systemPrompt: { getSectionOrder: () => 3000, section: () => () => {} },
  }, { artifactDir: ARTIFACTS, indicatorLanguage: 'zh', indicatorTheme: 'light', ...config });
  return tools;
}

const exec = {
  callId: 't', rootCallId: 't', name: 't', arguments: {},
  agent: { id: 'activity-test', options: {}, session: { requestHeader: () => ({ config: {} }) } },
  signal: new AbortController().signal, deferContext: () => {}, concludeTurn: () => {},
};
const call = (tools, name, args) => tools.get(name).execute(args, { ...exec, name, arguments: args });
const render = (tools, name, args, value) => tools.get(name).output.render(args, value);

const tools = build();
check('the plugin registers all 25 tools including computer_activity', tools.size === 25 && tools.has('computer_activity'), `${tools.size}: ${[...tools.keys()].join(', ')}`);

// Every registered tool must have a summary in every language, not just a fallback.
//
// The fallback for a tool with no entry is the tool name itself, which is an English
// identifier: a tool added without its phrasing appears in the list as "browser_click" and
// nothing anywhere complains. That is exactly what happened to the ten browser tools - it
// looked like a translation bug, and it was a missing entry.
{
  const { ActivityLog } = await import('../lib/activity.js');
  for (const lang of ['zh', 'en']) {
    const log = new ActivityLog({
      cfg: { indicatorLanguage: lang, activityLogToFile: false, activityLogLimit: 10 },
      artifacts: { dirFor: async () => '.' },
    });
    const untranslated = [];
    for (const name of tools.keys()) {
      const { entry } = log.begin(name, { action: 'x' }, { agent: { id: 'phrasing-check' } });
      if (entry.summary === name) untranslated.push(name);
    }
    check(`every tool is phrased in ${lang}, not just named`, untranslated.length === 0,
      untranslated.length === 0 ? `all ${tools.size} phrased` : untranslated.join(', '));
  }
}

// ---- exercise one call of each kind -----------------------------------------
await call(tools, 'screen_info', {});
await call(tools, 'find_color', { at: { x: 5, y: 5 } });
await call(tools, 'mouse_control', { action: 'move', x: 900, y: 700 });
await call(tools, 'mouse_control', { action: 'position' });
const shot = await call(tools, 'screen_capture', { target: 'region', region: { x: 400, y: 300, width: 260, height: 160 }, maxDim: 200, attach: false });
await call(tools, 'wait_for', { mode: 'sleep', ms: 60 });
await call(tools, 'clipboard_control', { action: 'get' });
await call(tools, 'window_list', { limit: 3 });
try {
  await call(tools, 'system_control', { action: 'monitor-off' });
} catch {
  /* the risk gate is expected to refuse this without allowRisky */
}

const listStart = Date.now();
const list = await call(tools, 'computer_activity', { action: 'list' });
const listEnd = Date.now();
const byTool = new Map(list.entries.map((entry) => [entry.tool, entry]));
const firstOf = (tool) => list.entries.find((entry) => entry.tool === tool);
const moveEntry = list.entries.find((entry) => entry.tool === 'mouse_control' && entry.summary.includes('900'));

check('the capture is recorded as an operation', byTool.has('screen_capture'), `summary="${firstOf('screen_capture')?.summary}" kind=${firstOf('screen_capture')?.kind} outcome=${firstOf('screen_capture')?.outcome}`);
check('mouse input is recorded with its coordinates', /900, 700/.test(moveEntry?.summary ?? ''), `summary="${moveEntry?.summary}"`);
check('a refused action is labelled, not dropped', byTool.get('system_control')?.outcome === 'refused', `outcome=${byTool.get('system_control')?.outcome} detail=${byTool.get('system_control')?.detail}`);
check('observations are told apart from injections', byTool.get('screen_info')?.kind === 'screen' && byTool.get('window_list')?.kind === 'query' && moveEntry?.kind === 'control', `screen_info=${byTool.get('screen_info')?.kind} window_list=${byTool.get('window_list')?.kind}`);
// Earlier listings are now visible, because the log outlives a plugin reload; what
// must never appear is the listing that produced this very answer.
const selfListed = list.entries.filter((entry) => entry.tool === 'computer_activity'
  && Date.parse(entry.at) >= listStart && Date.parse(entry.at) <= listEnd);
// An entry joins the list when it starts rather than when it ends, so a listing does
// include itself - marked as still running. That is the point of the running state: a
// capture that takes two and a half seconds should be visible while it is happening.
check('a listing shows its own call, still in flight', selfListed.length === 1 && selfListed[0].outcome === 'running', selfListed.length === 0 ? 'the listing did not include itself' : `#${selfListed[0].index} ${selfListed[0].summary} = ${selfListed[0].outcome}`);
check('indices are strictly increasing', list.entries.every((entry, i) => i === 0 || entry.index > list.entries[i - 1].index), list.entries.map((e) => e.index).join(','));

// ---- filters and rendering ---------------------------------------------------
const inputs = await call(tools, 'computer_activity', { action: 'list', kind: 'control' });
check('kind filter works', inputs.entries.every((entry) => entry.kind === 'control') && inputs.entries.length > 0, `${inputs.entries.length} control operation(s)`);

const since = await call(tools, 'computer_activity', { action: 'list', since: list.entries[2].index });
check('since filter reads incrementally', since.entries.every((entry) => entry.index > list.entries[2].index), `${since.entries.length} operation(s) after #${list.entries[2].index}`);

const text = render(tools, 'computer_activity', {}, list)[0].text;
check('the rendered list is readable', text.includes('operation(s)') && text.includes('截屏') && text.includes('完成'), text.split('\n').slice(0, 5).join('\n'));

// ---- dry run labelling -------------------------------------------------------
// Its own artifact directory, so this instance's log is its own: the point here is
// the dry-run label, and hydration is covered separately below.
const dryTools = build({ dryRun: true, artifactDir: `${ARTIFACTS}-dry` });
await call(dryTools, 'mouse_control', { action: 'click', x: 100, y: 100 });
const dryList = await call(dryTools, 'computer_activity', { action: 'list' });
const dryEntry = dryList.entries.find((entry) => entry.tool === 'mouse_control');
check('a rehearsed call is labelled dry-run', dryEntry?.outcome === 'dry-run', `outcome=${dryEntry?.outcome}`);

// ---- hydration: a fresh activation still sees the session's history ----------
// The fix for "the list looked empty after the plugin reloaded": the in-memory ring
// lives as long as one activation, the file lives as long as the session.
const reloaded = build({ artifactDir: ARTIFACTS });
const afterReload = await call(reloaded, 'computer_activity', { action: 'list', limit: 100 });
check(
  'a freshly activated plugin still sees the earlier operations',
  afterReload.total > 0 && afterReload.entries.some((entry) => entry.tool === 'screen_capture'),
  `a brand-new plugin instance read back ${afterReload.total} operation(s) from the session's file, including the capture`,
);
check(
  'hydration renumbers from 1 without gaps or repeats',
  afterReload.entries.every((entry, i) => entry.index === i + 1),
  afterReload.entries.map((entry) => entry.index).join(','),
);
await call(reloaded, 'screen_info', {});
const grown = await call(reloaded, 'computer_activity', { action: 'list', limit: 1 });
check('new operations continue that same numbering', (grown.entries[0]?.index ?? 0) > afterReload.total, `the new call landed as #${grown.entries[0]?.index}, after the ${afterReload.total} that were already there`);

// ---- durability --------------------------------------------------------------
await new Promise((resolve) => setTimeout(resolve, 600));
const history = await call(tools, 'computer_activity', { action: 'history' });
check('the on-disk mirror holds the same operations', history.entries.length > 0, `${history.entries.length} row(s) read back from operations.jsonl`);
const cleared = await call(tools, 'computer_activity', { action: 'clear' });
const afterClear = await call(tools, 'computer_activity', { action: 'list' });
check('clear empties the session list', cleared.cleared > 0 && afterClear.total <= 1, `cleared=${cleared.cleared}, remaining=${afterClear.total} (the clear is recorded like every other call)`);

// ---- the notice wording, tested directly ------------------------------------
const { ActivityLog } = await import(pathToFileURL(path.join(ROOT, 'lib', 'activity.js')).href);
const log = new ActivityLog({
  cfg: { indicatorLanguage: 'zh', activityLogLimit: 50, activityLogToFile: false },
  artifacts: {},
  ctx: { logger: {} },
});
check('a capture is announced on screen', /正在截屏 · 区域 260x160/.test(log.notice('screen_capture', { target: 'region', region: { width: 260, height: 160 } })), `notice="${log.notice('screen_capture', { target: 'region', region: { width: 260, height: 160 } })}"`);
check('a click is announced with its coordinates', log.notice('mouse_control', { action: 'click', x: 100, y: 200 }) === '正在控制鼠标 · click (100, 200)', `notice="${log.notice('mouse_control', { action: 'click', x: 100, y: 200 })}"`);
check('typing is announced by length, not content', log.notice('keyboard_control', { action: 'type', text: 'secret' }) === '正在控制键盘 · 输入 6 个字符', `notice="${log.notice('keyboard_control', { action: 'type', text: 'secret' })}"`);
check('reading the layout stays silent', log.notice('screen_info', {}) === '' && log.notice('mouse_control', { action: 'position' }) === '', 'screen_info and mouse position raise no notice');
check('a window move is announced', /正在操作窗口 · minimize/.test(log.notice('window_control', { action: 'minimize', window: '0x1A' })), `notice="${log.notice('window_control', { action: 'minimize', window: '0x1A' })}"`);

const files = await fs.readdir(path.join(ARTIFACTS, 'activity-test')).catch(() => []);
check('the operations file was written', files.includes('operations.jsonl'), files.join(', ') || '(no files)');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n=========== ${results.length - failed} passed, ${failed} failed ===========`);
process.exit(failed === 0 ? 0 : 1);
