import { fileURLToPath } from 'node:url';
// Renders the client half without a browser: a minimal React, a fake Client
// context, and a real assertion on the produced element tree. This is how the
// page's dictionaries, slot registration and command call get verified on a
// machine where nobody can open a browser on the agent's behalf.
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${String(detail).slice(0, 700)}` : ''}`);
};

// ------------------------------------------------------------------ mini React
let states = [];
let refs = [];
let hookIndex = 0;
let effects = [];
let dirty = false;
let pass = 0;
let mounted = false;
let conversationStore = null;

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
  },
  useState(initial) {
    const index = hookIndex;
    hookIndex += 1;
    // Capture this instance's array, the way a real fiber does. Writing through the
    // module-level variable instead would land a background update in whichever
    // instance happened to be rendering most recently.
    const store = states;
    if (store[index] === undefined) store[index] = typeof initial === 'function' ? initial() : initial;
    const set = (value) => {
      store[index] = typeof value === 'function' ? value(store[index]) : value;
      dirty = true;
    };
    return [store[index], set];
  },
  useRef(initial) {
    const index = hookIndex;
    hookIndex += 1;
    if (refs[index] === undefined) refs[index] = { current: initial };
    return refs[index];
  },
  // Effects are scheduled once per mount, which is what `[]` deps mean.
  // `useCallback` here returns a fresh function each pass, exactly like React when
  // its deps change; without the once-per-mount rule the load effect would re-run
  // forever.
  useEffect(effect) { hookIndex += 1; if (!mounted) effects.push(effect); },
  useCallback(fn) { hookIndex += 1; return fn; },
  useMemo(fn) { hookIndex += 1; return fn(); },
};

// The page follows session activity from the Host. Capture the subscriptions so an
// event can be delivered on demand, and tally timers to prove nothing polls.
const intervals = [];
const pendingTimers = [];
const subscriptions = new Map();
const realSetTimeout = globalThis.setTimeout;
globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
globalThis.clearInterval = () => {};
globalThis.setTimeout = (fn, ms) => { pendingTimers.push({ fn, ms }); return pendingTimers.length; };
globalThis.clearTimeout = () => {};

// Fully expand function components inside the render pass. A registered body may
// be a wrapper around the page, and calling only the outermost component would
// collect the inner one's effects after the point where effects are run - so the
// inner component would render its initial state forever.
function expand(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return node;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node.type === 'function') return expand(node.type(node.props));
  return { ...node, children: (node.children ?? []).map(expand) };
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textOf);
  if (node.type && typeof node.type === 'function') return textOf(node.type(node.props));
  return (node.children ?? []).flatMap(textOf);
}

function findByType(node, predicate) {
  if (node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findByType(child, predicate); if (hit) return hit; }
    return null;
  }
  if (predicate(node)) return node;
  if (node.type && typeof node.type === 'function') return findByType(node.type(node.props), predicate);
  for (const child of node.children ?? []) { const hit = findByType(child, predicate); if (hit) return hit; }
  return null;
}

// ------------------------------------------------------------------ fake shell
const dictionaries = {};
let locale = 'zh';
const subscribers = new Set();
let registeredTab = null;
let registeredSidebarType = null;
let registeredSidebarBody = null;
const openedTabs = [];
const executed = [];

function translate(ns) {
  return (key, params) => {
    const table = dictionaries[ns];
    if (table === undefined) throw new Error(`no dictionary registered for "${ns}"`);
    let text = table[locale]?.[key];
    if (text === undefined) text = table.en?.[key];
    if (text === undefined) throw new Error(`missing string "${ns}.${key}" for locale "${locale}"`);
    if (params) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
    return text;
  };
}

const ctx = {
  effect: (fn) => { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
  locale: {
    register: (ns, dicts) => { dictionaries[ns] = dicts; return () => {}; },
    bind: translate,
    subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
    // The canonical read, and the one the page uses to size a column by language. Without
    // it here the fake context would be missing a method the real service has, and the
    // render would fail for a reason that has nothing to do with the code under test.
    getLocale: () => ({ active: locale, locales: [], revision: 1 }),
  },
  slots: {
    inject: (_slot, callback) => { callback(); return () => {}; },
    register: (options, component) => {
      if (options.name === 'sidebar.right.pane.tab') registeredSidebarBody = { options, component };
      else registeredTab = { options, component };
      return () => {};
    },
  },
  sidebarRightTabs: {
    register: (definition) => { registeredSidebarType = definition; return () => {}; },
  },
  sidebarRight: {
    openTab: (kind) => { openedTabs.push(kind); },
  },
  remote: {
    $on: (event, handler) => { subscriptions.set(event, handler); return () => subscriptions.delete(event); },
    commands: {
      execute: async (sessionId, line) => {
        executed.push({ sessionId, line });
        // Later reads return one more operation, so a live update is observable as
        // a change in the rendered tree rather than only as a second request.
        const extra = executed.length > 1
          ? [{ index: 4, at: new Date(2026, 9, 16, 20, 45, 3).toISOString(), tool: 'mouse_control', kind: 'input', summary: '鼠标 · click (1000, 298)', outcome: 'ok', elapsedMs: 40 }]
          : [];
        const entries = [
          { index: 1, at: new Date(2026, 9, 16, 20, 44, 38).toISOString(), tool: 'screen_info', kind: 'screen', summary: '查看屏幕信息', outcome: 'ok', elapsedMs: 2209 },
          { index: 2, at: new Date(2026, 9, 16, 20, 44, 52).toISOString(), tool: 'screen_capture', kind: 'capture', summary: '截屏 · 区域 620x380', outcome: 'ok', elapsedMs: 2495 },
          { index: 3, at: new Date(2026, 9, 16, 20, 44, 59).toISOString(), tool: 'system_control', kind: 'system', summary: '系统 · lock', outcome: 'refused', detail: 'allowRisky: false', elapsedMs: 3 },
          ...extra,
        ];
        return { ok: true, value: { result: { kind: 'success', text: JSON.stringify({ total: entries.length, entries }) } } };
      },
    },
  },
};

// ------------------------------------------------------------------ load module
const source = await fs.promises.readFile(path.join(ROOT, 'client.js'), 'utf8');
let factory;
globalThis.window = { __ModuleLoader__: { load: ({ id, factory: f }) => { factory = f; globalThis.__loadedId = id; } } };
// eslint-disable-next-line no-new-func
new Function('window', source)(globalThis.window);
check('the module registers a lazy factory under the package name', typeof factory === 'function' && globalThis.__loadedId === '@local/dsh-computer-control', `id=${globalThis.__loadedId}`);

const module = factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require("${name}")`);
});
check('the factory declares the services it needs', Array.isArray(module.inject) && module.inject.includes('locale') && module.inject.includes('slot' + 's'), module.inject.join(', '));

// Cordis refuses to read a service off the context unless it is injected, and it
// is the *parent* service that has to be named: declaring `remote.commands` alone
// still makes `ctx.remote` throw. A plain object context cannot catch that, so the
// same rule is enforced here - this is the check that would have caught the real
// "cannot get property remote without inject" failure before it reached a browser.
const INJECTABLE = ['remote', 'locale', 'slots', 'sidebarRight', 'sidebarRightTabs'];
const guard = (target, inject) => new Proxy(target, {
  get(object, property) {
    if (INJECTABLE.includes(property) && !(inject ?? []).includes(property)) {
      throw new Error(`cannot get property "${property}" without inject`);
    }
    return object[property];
  },
});

module.apply(guard(ctx, module.inject));
check('it injects every service it reads', INJECTABLE.every((name) => (module.inject ?? []).includes(name)), `inject=[${module.inject?.join(', ')}]`);

// A guard that never fires proves nothing, so make it fire on purpose: with the
// parent service undeclared, reading `ctx.remote` must raise the exact error the
// browser showed.
let guardError = null;
try {
  void guard(ctx, ['slots', 'remote.commands', 'locale']).remote;
} catch (error) {
  guardError = error.message;
}
check('the inject guard actually fires', guardError === 'cannot get property "remote" without inject', guardError ?? 'the guard let an undeclared service through');

// ------------------------------------------------------------------ dictionaries
const dict = dictionaries['dsh-computer-control'];
check('both dictionaries are registered with the locale service', dict !== undefined && dict.zh !== undefined && dict.en !== undefined, Object.keys(dict ?? {}).join(', '));

const zhKeys = Object.keys(dict.zh).sort();
const enKeys = Object.keys(dict.en).sort();
const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));
check('the two dictionaries have exactly the same keys', missingInEn.length === 0 && missingInZh.length === 0, `missing in en: [${missingInEn}]; missing in zh: [${missingInZh}]`);

const blank = [...zhKeys, ...enKeys].filter((k) => String(dict.zh[k] ?? dict.en[k] ?? '').trim().length === 0);
check('no string is empty', blank.length === 0, blank.join(', ') || 'all strings carry text');

const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const mismatched = zhKeys.filter((k) => placeholders(dict.zh[k]) !== placeholders(dict.en[k]));
check('the two languages use the same placeholders', mismatched.length === 0, mismatched.map((k) => `${k}: zh{${placeholders(dict.zh[k])}} en{${placeholders(dict.en[k])}}`).join('; ') || 'placeholders agree');

// ------------------------------------------------------------------ slot
check('it registers a third Conversation View', registeredTab?.options?.name === 'conversation.view', JSON.stringify(registeredTab?.options));
check('the view carries its own id, not a shipped one', registeredTab?.options?.id === 'computer-control', `id=${registeredTab?.options?.id}`);
check('the view supplies a label, which is what the tab shows', typeof registeredTab?.options?.label === 'function' && registeredTab.options.label() === '操作记录', `label()="${registeredTab?.options?.label?.()}"`);

// ------------------------------------------------------------------ render
// The props deliberately disagree: the handed session must win over the selector,
// so a wrong selector can never point the page at another session's operations.
async function render(sessionId) {
  // Each mounted instance owns its state; restoring it keeps the conversation view
  // alive across the other seats rendered in between.
  if (conversationStore !== null) {
    states = conversationStore.states;
    refs = conversationStore.refs;
  }
  for (pass = 0; pass < 8; pass += 1) {
    hookIndex = 0;
    effects = [];
    dirty = false;
    const tree = expand(registeredTab.component({
      ...(sessionId === undefined ? {} : { sessionId }),
      useSessions: (selector) => selector({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }),
    }));
    if (!mounted) {
      for (const effect of effects) effect();
      mounted = true;
    }
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    if (!dirty) {
      conversationStore = { states, refs };
      return tree;
    }
  }
  throw new Error('the page never settled');
}

locale = 'zh';
const zhTree = await render('handed-session');
// Captured now, before the other seats mount: they register their own handlers over
// the same event names, and the view's own handler is the one under test.
const conversationActivity = subscriptions.get('api-session/activity');
const beforeConversationTimers = pendingTimers.length;
const zhText = textOf(zhTree).join(' | ');
check('the page renders the operation list in Chinese', executed.length > 0 && zhText.includes('电脑控制 · 操作记录') && zhText.includes('截屏 · 区域 620x380'), zhText.slice(0, 460));
check('it asks the Host for the structured form', executed.at(-1)?.line === '/computer-activity --json --limit 300', executed.at(-1)?.line);
check('the handed session wins over the selector', executed.at(-1)?.sessionId === 'handed-session', `the view was handed "handed-session", the selector would have said "s1"; the Host was asked for "${executed.at(-1)?.sessionId}"`);
check('outcomes are rendered through the dictionary', zhText.includes('被拒绝'), zhText.slice(0, 460));
check('the duration uses the interpolated string', /2495 ms/.test(zhText), zhText.match(/[\d]+ ms/g)?.join(', ') ?? 'not found');

// The column labels are no longer a <thead>: they are a plain row inside the element
// that pins, because a table header cannot share an element with the title and filters,
// and two pinned elements would need an offset to keep them apart. They are found by the
// role they carry instead, which is also how a screen reader finds them.
const headerRow = findByType(zhTree, (node) => node.props?.role === 'row');
check('the table has six columns with localized headers', textOf(headerRow).join(',') === '序号,时间,类型,操作,结果,耗时', textOf(headerRow).join(','));


// ------------------------------------------------------------------ right column
check('it registers a right-column tab type', registeredSidebarType?.kind === 'computer-control' && registeredSidebarType?.id === 'dsh-computer-control', JSON.stringify({ id: registeredSidebarType?.id, kind: registeredSidebarType?.kind }));
check('the type declares a title and no globs, because it is a page', typeof registeredSidebarType?.title === 'function' && registeredSidebarType.title() === '操作记录' && registeredSidebarType.patterns === undefined, `title()="${registeredSidebarType?.title?.()}" patterns=${JSON.stringify(registeredSidebarType?.patterns)}`);
check('the body registers under the type id, not a shipped one', registeredSidebarBody?.options?.name === 'sidebar.right.pane.tab' && registeredSidebarBody?.options?.key === 'dsh-computer-control', JSON.stringify(registeredSidebarBody?.options));

const openButton = findByType(zhTree, (node) => node.type === 'button' && textOf(node).join('') === '在右侧打开');
check('the view offers a control that opens the page on the right', openButton !== null, openButton ? 'found the "在右侧打开" button' : 'no such button in the conversation view');
openButton?.props?.onClick?.();
check('pressing it opens this page kind in the right column', openedTabs.at(-1) === 'computer-control', `sidebarRight.openTab called with ${JSON.stringify(openedTabs)}`);

// A second seat is a second component instance with its own state; `render` above
// deliberately keeps one instance alive to test updates, so mounting is separate.
async function renderInstance(component, props) {
  states = [];
  refs = [];
  mounted = false;
  for (pass = 0; pass < 8; pass += 1) {
    hookIndex = 0;
    effects = [];
    dirty = false;
    const tree = expand(component(props));
    if (!mounted) {
      for (const effect of effects) effect();
      mounted = true;
    }
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    if (!dirty) return tree;
  }
  throw new Error('the instance never settled');
}

// The tab body is the same page, minus the control that would open a second copy.
// It is rendered with the props a right-column body actually carries - no
// Conversation View props - to prove the page survives a seat it does not own.
const tabTree = await renderInstance(registeredSidebarBody.component, { sessionId: 'handed-session' });
check('the right-column body renders the same list', textOf(tabTree).join(' | ').includes('电脑控制 · 操作记录'), textOf(tabTree).join(' | ').slice(0, 160));
check('the right-column body hides its own open-on-the-right control', findByType(tabTree, (node) => node.type === 'button' && textOf(node).join('') === '在右侧打开') === null, 'no nested copy button inside the tab');

// A body with no session information at all must degrade, not throw.
const bareTree = await renderInstance(registeredSidebarBody.component, {});
check('a body with no session props degrades instead of crashing', textOf(bareTree).join(' | ').includes('还没有打开任何会话'), textOf(bareTree).join(' | ').slice(0, 140));

// ------------------------------------------------------------------ live updates
// Captured here: the seats rendered above registered their own subscriptions over
// the same event names, and this view's own handler is the one under test.
// No polling: every execution of a session command is written into the session and
// rendered as a row, so a polling loop would paste the payload into the conversation.
check('the page does not poll', intervals.length === 0, intervals.length === 0 ? 'no interval was installed' : `${intervals.length} interval(s): ${intervals.map((i) => `${i.ms} ms`).join(', ')}`);
check('it subscribes to session activity instead', conversationActivity !== undefined, `subscribed to: ${[...subscriptions.keys()].join(', ')}`);

const beforeEvent = executed.length;
conversationActivity({ sessionId: 'handed-session' });
// The handler coalesces a burst behind a short timer before reading.
const armed = pendingTimers.slice(beforeConversationTimers);
check('an activity event schedules one read, not one per event', armed.length === 1 && executed.length === beforeEvent, `${armed.length} timer(s) armed; Host calls still ${executed.length}`);
for (const timer of armed) timer.fn();
await new Promise((resolve) => realSetTimeout(resolve, 0));
const polledTree = await render('handed-session');
const polledText = textOf(polledTree).join(' | ');
check('the event asks the Host again', executed.length > beforeEvent, `Host calls: ${beforeEvent} -> ${executed.length}`);
// One number, not a pair: with no filter set nothing is hidden, so "4 / 4" was the
// same figure printed twice.
check('the new operation appears without pressing anything', polledText.includes('鼠标 · click (1000, 298)') && polledText.includes('4 / 4'), polledText.slice(0, 300));
check('a background refresh never flashes the loading state', !polledText.includes('读取中…'), polledText.includes('读取中…') ? 'the list blanked to "reading..."' : 'the list stayed on screen throughout');

// Switching the shell language must re-render the page, not just the next mount.
locale = 'en';
const enTree = await render('handed-session');
const enText = textOf(enTree).join(' | ');
check('the page follows the shell language without a reload', enText.includes('Computer control - operation log') && enText.includes('refused') && /2495 ms/.test(enText), enText.slice(0, 400));
const enHeader = findByType(enTree, (node) => node.props?.role === 'row');
check('the headers follow the language too', textOf(enHeader).join(',') === '#,Time,Kind,Operation,Outcome,Took', textOf(enHeader).join(','));

check('the page obeys the locale service rather than the browser', !source.includes('navigator.language'), source.includes('navigator.language') ? 'client.js still reads navigator.language' : 'no navigator.language in client.js');
check('every visible string goes through the translator', !/['"][A-Za-z][^'"]*[\u4e00-\u9fff]/.test(source.replace(/^\s*(\/\/.*|\*.*)$/gm, '')), 'no bare Chinese literal outside comments');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n=========== ${results.length - failed} passed, ${failed} failed ===========`);
process.exit(failed === 0 ? 0 : 1);