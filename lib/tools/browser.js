// Browser control over the Chrome DevTools Protocol.
//
// This is the structured counterpart to driving a browser as a desktop app. The desktop tools
// still work and are still the only way to touch a browser that was started without the
// debugging port; these tools talk to the page itself, which is what makes it possible to read
// the DOM instead of reading pixels, and to click an element by its accessible name instead of
// by a coordinate.
//
// One constraint is not ours to work around: Chromium opens the debugging port at launch and
// never afterwards. A browser that is already running cannot be attached to. `browser_launch`
// therefore reports what actually happened rather than pretending, because "connected" and
// "asked to launch" are different things and only one of them is useful.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { attachCapture } from '../artifacts.js';
import { PAGE_LIB, conditionCheckExpression, stateExpression, targetExpression } from '../locator.js';
import { CdpSocket, fetchJson } from '../cdp.js';
import { defineTool, intOr, json, required, textAndImage } from '../toolkit.js';
import { requireRisky } from './input.js';

// Where Chromium browsers live on Windows, most likely first.
const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function browserPath(runtime) {
  const configured = runtime.cfg.browserPath;
  if (typeof configured === 'string' && configured.length > 0) {
    if (!fs.existsSync(configured)) throw new Error(`browserPath is set to ${configured}, which does not exist`);
    return configured;
  }
  for (const candidate of BROWSER_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('no Edge or Chrome installation was found; set browserPath in the computer-control config');
}

function portOf(runtime) {
  return intOr(runtime.cfg.browserDebugPort, 9222, { min: 1, max: 65535, name: 'browserDebugPort' });
}

/**
 * The profile directory the debugged browser runs under.
 *
 * This is not optional and it is not cosmetic. Since Chromium M136 the debugging port is
 * silently ignored when the browser would use its default profile - a security change, so that
 * malware cannot attach to the browser somebody is already signed into. A launch without this
 * argument starts a browser that looks perfectly healthy and never opens the port, which is
 * exactly what happened the first time this tool was run: twelve processes, no listener.
 *
 * The consequence is worth stating plainly because it changes what the feature is. A separate
 * profile means a browser with no logged-in sessions. Driving the person's own signed-in
 * browser over CDP is no longer possible on current Chromium; that is what the desktop tools
 * are for, and they are still here.
 */
function userDataDir(runtime) {
  const configured = runtime.cfg.browserUserDataDir;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  return path.join(os.homedir(), '.dsh', 'cache', 'computer-control', 'browser-profile');
}

const base = (port) => `http://127.0.0.1:${port}`;

/** The targets the browser will let us talk to, pages first. */
async function targets(port) {
  let list;
  try {
    list = await fetchJson(`${base(port)}/json/list`);
  } catch (error) {
    // A refused connection is the ordinary state, not an exceptional one: it means the browser
    // was started without the debugging port, which is how browsers start. Reporting it as
    // `ECONNREFUSED 127.0.0.1:9222` tells the caller nothing they can act on, and the next step
    // here is not obvious - the port cannot be added to a browser that is already running.
    throw new Error(
      `nothing is answering on 127.0.0.1:${port}, so no browser is open for debugging there. `
      + 'Chromium opens that port at launch and never afterwards, so a browser that is already running cannot be '
      + 'attached to: close every window for that profile, then call browser_launch. '
      + `(${error.message})`,
    );
  }
  if (!Array.isArray(list)) throw new Error('the browser did not answer with a target list');
  const pages = list.filter((target) => target.type === 'page');
  return [...pages, ...list.filter((target) => target.type !== 'page')];
}

/** Pick the target a call means: an explicit id, an index, or the first page. */
function pick(list, args) {
  if (typeof args.target === 'string' && args.target.length > 0) {
    const found = list.find((target) => target.id === args.target) ?? list.find((target) => target.id.startsWith(args.target));
    if (found === undefined) throw new Error(`no target matches ${JSON.stringify(args.target)}; list them with browser_tabs`);
    return found;
  }
  const index = intOr(args.index, 0, { min: 0, name: 'index' });
  const found = list[index];
  if (found === undefined) throw new Error(`target ${index} does not exist; the browser reports ${list.length} target(s)`);
  return found;
}

/** Run one expression in the page and bring back its value. */
async function evaluate(port, target, expression, timeoutMs) {
  if (target.webSocketDebuggerUrl === undefined) throw new Error(`target ${target.id} does not expose a debugging socket`);
  const socket = await CdpSocket.open(target.webSocketDebuggerUrl);
  try {
    const result = await socket.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, timeoutMs);
    if (result?.exceptionDetails !== undefined) {
      const thrown = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'the page threw';
      throw new Error(`the page threw: ${String(thrown).slice(0, 600)}`);
    }
    return result?.result?.value;
  } finally {
    socket.close();
  }
}

// Reports the interactive parts of the page with their names and boxes. Written as one
// expression because it runs in the page, where it has to be self-contained.
const SNAPSHOT_SCRIPT = `(${PAGE_LIB}) && (() => {
  const seen = new Set();
  const out = [];
  // Both helpers come from the shared library rather than being written again here. They were
  // duplicated, and the copies drifted: the snapshot labelled a plain input as role "text"
  // because it returned el.type directly, while the locator had already been corrected to say
  // textbox. One of them was fixed and the page kept showing the other one's answer.
  const names = (el) => window.__dsh.nameOf(el);
  const role = (el) => window.__dsh.roleOf(el);
  const selector = 'a[href],button,input,select,textarea,[role],[onclick],[contenteditable=""],[contenteditable="true"]';
  // deepElements reaches into shadow roots; querySelectorAll does not, and a large share of
  // modern component libraries put their buttons there.
  const deep = window.__dsh.deepElements(document, []).filter((el) => { try { return el.matches(selector); } catch { return false; } });
  const frames = window.__dsh.deepElements(document, []).filter((el) => el.tagName === 'IFRAME').map((el) => {
    const rect = el.getBoundingClientRect();
    let sameOrigin = false;
    try { sameOrigin = el.contentDocument !== null; } catch { sameOrigin = false; }
    return { src: el.getAttribute('src') || '', sameOrigin, x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
  });
  for (const el of deep) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.05) continue;
    const name = names(el);
    const key = role(el) + '|' + name + '|' + Math.round(rect.left) + ',' + Math.round(rect.top);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      role: role(el),
      name,
      x: Math.round(rect.left), y: Math.round(rect.top),
      width: Math.round(rect.width), height: Math.round(rect.height),
      disabled: el.disabled === true,
    });
    if (out.length >= 150) break;
  }
  return { title: document.title, url: location.href, count: out.length, elements: out, frames };
})()`;

export function browserTools(runtime) {
  const launch = defineTool({
    name: 'browser_launch',
    description:
      'Start a Chromium browser with the DevTools protocol open, so the other browser_ tools can drive it. It runs under its own profile directory - profile in the reply - which means none of your signed-in sessions; current Chromium refuses to open the debugging port on the profile you actually use. A browser started without this tool cannot be attached to afterwards. Without `port` the configured browserDebugPort is used. Reports whether an endpoint actually answered, rather than whether a process was started.',
    parameters: {
      port: { type: 'integer', description: 'Debugging port. Defaults to browserDebugPort (usually 9222).' },
      url: { type: 'string', description: 'Page to open. Defaults to the browser\'s own start page.' },
      headless: { type: 'boolean', description: 'Run without a window. Use this for automated checks that must not put a window, a dialog or a sound on the machine. Defaults to false, because the point of driving a real browser is usually that a person can watch it.' },
    },
    // The value is the whole answer here, so it is rendered as JSON. Without an output.render
    // the tool still executes and still returns a value; it simply presents nothing, which
    // reads exactly like a tool that did nothing at all.
    output: { render: (_args, value) => json(value, 2) },
    execute: async (args) => {
      const port = intOr(args.port, portOf(runtime), { min: 1, max: 65535, name: 'port' });
      // Anything already listening there means somebody is already driving this port.
      const before = await fetchJson(`${base(port)}/json/version`).catch(() => undefined);
      if (before !== undefined) {
        return {
          port,
          alreadyRunning: true,
          browser: before.Browser ?? 'unknown',
          note: 'a debugging endpoint was already answering on this port, so nothing was launched',
        };
      }

      const exe = browserPath(runtime);
      const profile = userDataDir(runtime);
      try { fs.mkdirSync(profile, { recursive: true }); } catch (error) {
        throw new Error(`could not create the browser profile directory ${profile}: ${error.message}`);
      }
      // The profile argument is what makes the port open at all on current Chromium - see the
      // note on `userDataDir`. Without it this call returns twelve healthy processes and no
      // listener.
      const argv = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
        // Edge greets a fresh profile with a "sync your browsing data on all your devices"
        // dialog. It is modal, it covers the page, and it makes every selector on that page
        // unclickable - which is how it announced itself: a download link that "did not exist".
        // Sync is also not something a driven browser should be doing behind the reader's back.
        '--disable-sync',
        '--disable-features=msEdgeSyncPromoBubble,EdgeSyncPromo,msSyncPromo',
      ];
      // Headless is for automation, not for the desktop tools: the useful thing about driving a
      // real browser is that a person can watch it. A test suite has the opposite need - it must
      // not put a window, a dialog or a sound on the machine it is running on.
      if (args.headless === true) argv.push('--headless=new', '--disable-gpu', '--mute-audio');
      if (typeof args.url === 'string' && args.url.length > 0) argv.push(args.url);

      // Detached on purpose: the browser must outlive the call that started it.
      const child = spawn(exe, argv, { detached: true, stdio: 'ignore' });
      child.unref();

      // Chromium answers within a few seconds when the port really opened, and never when it
      // dropped the flag or handed the request to an instance that was already running.
      let version;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        version = await fetchJson(`${base(port)}/json/version`, 1000).catch(() => undefined);
        if (version !== undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (version === undefined) {
        throw new Error(
          `no debugging endpoint answered on port ${port} after launching ${path.basename(exe)} with profile ${profile}. `
          + 'This means the request was handed to a browser that was already running with that same profile, and the '
          + 'existing instance does not have the port. Close every window using that profile and try again, or set '
          + 'browserUserDataDir to a directory no browser is using - a fresh one always opens the port.',
        );
      }
      return {
        port,
        launched: true,
        browser: version.Browser ?? 'unknown',
        path: exe,
        profile,
        // Said every time, because it changes what the caller can expect from the session.
        note: 'this browser runs under its own profile directory, not the one you normally use, so it has none of '
          + 'your signed-in sessions. To act on a signed-in browser, use the desktop tools instead - window_control, '
          + 'keyboard_control and screen_capture drive whatever is open.',
      };
    },
  });

  const tabs = defineTool({
    name: 'browser_tabs',
    description:
      'List the browser\'s debugging targets: open pages first, then service workers and other contexts. Each entry carries an id and a webSocketDebuggerUrl, and the index shown here is what browser_eval and browser_read accept as `index`.',
    parameters: {},
    // The value is the whole answer here, so it is rendered as JSON. Without an output.render
    // the tool still executes and still returns a value; it simply presents nothing, which
    // reads exactly like a tool that did nothing at all.
    output: { render: (_args, value) => json(value, 2) },
    execute: async () => {
      const port = portOf(runtime);
      const list = await targets(port);
      return {
        port,
        count: list.length,
        tabs: list.map((target, index) => ({
          index,
          type: target.type,
          id: target.id,
          title: target.title,
          url: target.url,
        })),
      };
    },
  });

  const evaluateTool = defineTool({
    name: 'browser_eval',
    description:
      'Run JavaScript in an open page and return its value. This is the general-purpose control: read the DOM, click something, fill a field, wait for something. The expression runs in the page, so it has document, window and fetch but not Node. Statements and expressions both work, and several statements separated by semicolons are fine. Top-level await is NOT available - to wait, return a promise instead, which is awaited for you, as in fetch(url).then(r => r.json()). Values must be JSON-serialisable.',
    parameters: {
      expression: { type: 'string', required: true, description: 'JavaScript to run in the page. Returning a promise is awaited; top-level await is not available.' },
      index: { type: 'integer', description: 'Which target from browser_tabs. Defaults to 0, the first page.' },
      target: { type: 'string', description: 'Target id (or a prefix) instead of an index.' },
    },
    // The value is the whole answer here, so it is rendered as JSON. Without an output.render
    // the tool still executes and still returns a value; it simply presents nothing, which
    // reads exactly like a tool that did nothing at all.
    output: { render: (_args, value) => json(value, 2) },
    execute: async (args, exec) => {
      // `required` extracts the argument; `text` builds a content block and returns an array.
      // Using the latter here sent `[{type:'text',...}]` as the CDP expression, and the browser
      // answered "Invalid parameters" - a message that names the symptom and points nowhere
      // near the cause.
      const expression = required(args.expression, 'expression');
      const port = portOf(runtime);
      const list = await targets(port);
      const target = pick(list, args);
      const value = await evaluate(port, target, expression, runtime.cfg.helperTimeoutMs);
      return { target: { id: target.id, title: target.title, url: target.url }, value };
    },
  });

  const read = defineTool({
    name: 'browser_read',
    description:
      'Read the interactive parts of the page as structured data: for every visible button, link, input, select and role-tagged element, its role, its accessible name and its box in CSS pixels. Shadow roots are searched too, which plain DOM queries do not do. Also lists the frames on the page with their boxes and whether their contents are reachable. This is what makes a browser clickable without a screenshot: find the element by name here, then act on it with browser_click or browser_fill.',
    parameters: {
      index: { type: 'integer', description: 'Which target from browser_tabs. Defaults to 0, the first page.' },
      target: { type: 'string', description: 'Target id (or a prefix) instead of an index.' },
    },
    // The value is the whole answer here, so it is rendered as JSON. Without an output.render
    // the tool still executes and still returns a value; it simply presents nothing, which
    // reads exactly like a tool that did nothing at all.
    output: { render: (_args, value) => json(value, 2) },
    execute: async (args) => {
      const port = portOf(runtime);
      const list = await targets(port);
      const target = pick(list, args);
      const value = await evaluate(port, target, SNAPSHOT_SCRIPT, runtime.cfg.helperTimeoutMs);
      return { target: { id: target.id }, ...value };
    },
  });

  const screenshot = defineTool({
    name: 'browser_screenshot',
    description:
      'Capture the visible page as an image and attach it, so it can be looked at rather than described. This is a picture of the page itself, not of the screen: it ignores window position, DPI scaling and anything covering the browser, which is what makes it useful for checking what a page actually rendered. Use `fullPage` to capture the whole document rather than the viewport.',
    parameters: {
      format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format. Defaults to png.' },
      quality: { type: 'integer', description: 'JPEG quality 1-100, for format "jpeg". Defaults to 85.' },
      fullPage: { type: 'boolean', description: 'Capture the whole document rather than the viewport.' },
      index: { type: 'integer', description: 'Which target from browser_tabs. Defaults to 0, the first page.' },
      target: { type: 'string', description: 'Target id (or a prefix) instead of an index.' },
    },
    output: { render: (_args, value) => textAndImage(value.caption, value.attachment) },
    execute: async (args, exec) => {
      const port = portOf(runtime);
      const list = await targets(port);
      const target = pick(list, args);
      const at = new URL(target.webSocketDebuggerUrl);
      const socket = await CdpSocket.open(target.webSocketDebuggerUrl);
      let shot;
      try {
        shot = await socket.send('Page.captureScreenshot', {
          format: args.format === 'jpeg' ? 'jpeg' : 'png',
          ...(args.format === 'jpeg' ? { quality: intOr(args.quality, 85, { min: 1, max: 100, name: 'quality' }) } : {}),
          captureBeyondViewport: args.fullPage === true,
          fromSurface: true,
        }, runtime.cfg.helperTimeoutMs);
      } finally {
        socket.close();
      }
      if (typeof shot?.data !== 'string') throw new Error('the browser did not return image data');
      const bytes = Buffer.from(shot.data, 'base64');
      // Read the size out of the PNG/JPEG itself rather than from window.innerWidth: the image
      // is in device pixels, which is not the number the page reports.
      let width = 0;
      let height = 0;
      if (bytes.length > 24 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        width = bytes.readUInt32BE(16);
        height = bytes.readUInt32BE(20);
      }
      const format = args.format === 'jpeg' ? 'jpeg' : 'png';
      const filePath = await runtime.artifacts.nextPath(exec?.agent?.id, 'browser', format);
      // `fs` here is the callback API, so the promise form has to be asked for explicitly.
      await fs.promises.writeFile(filePath, bytes);
      const attached = await attachCapture(runtime.ctx, exec, runtime.cfg, { path: filePath, format, width, height });
      return {
        path: filePath,
        target: { id: target.id, title: target.title, url: target.url },
        port: Number(at.port),
        bytes: bytes.length,
        width,
        height,
        caption: `Captured the page at ${width}x${height} px (${Math.round(bytes.length / 1024)} KiB ${format}).`,
        ...(attached.attachment === undefined ? { attachmentSkipped: attached.skipped } : { attachment: attached.attachment }),
      };
    },
  });

  // The domains this tool will forward. Everything the protocol offers outside them - Browser,
  // Storage, Security, SystemInfo - either does not apply to one page or reaches past the page
  // into the machine, and this tool is for driving a page.
  const ALLOWED_DOMAINS = new Set(['Page', 'Runtime', 'DOM', 'Input', 'Emulation', 'Network', 'Target', 'Log', 'Performance', 'Accessibility', 'CSS', 'Overlay', 'Browser']);
  // Methods that take something away rather than do something. They are reachable, because a
  // caller driving a browser may need them, but only on a profile that opted into risky actions.
  const DESTRUCTIVE = new Set(['Target.closeTarget', 'Target.closeBrowserContext', 'Target.disposeBrowserContext', 'Browser.close', 'Browser.crash', 'Browser.crashGpuProcess', 'Page.close', 'Network.clearBrowserCookies', 'Network.clearBrowserCache', 'Network.clearBrowserAuthCache', 'Storage.clearDataForOrigin', 'Runtime.discardConsoleEntries']);

  const command = defineTool({
    name: 'browser_command',
    description:
      'Send one Chrome DevTools Protocol command to a page and return its result. This is the escape hatch that makes the rest possible: Page.captureScreenshot, Input.dispatchMouseEvent (which produces TRUSTED events, unlike el.click()), DOM.setFileInputFiles (file uploads, impossible from page JS), Target.createTarget (new tabs), Network interception. The method name must belong to a page-oriented domain; methods that close tabs or clear browser state need allowRisky. See the CDP documentation for method names and parameters.',
    parameters: {
      method: { type: 'string', required: true, description: 'CDP method, e.g. "Input.dispatchMouseEvent" or "Page.navigate".' },
      params: { type: 'object', description: 'Parameters for the method, as the protocol defines them.' },
      index: { type: 'integer', description: 'Which target from browser_tabs. Defaults to 0, the first page.' },
      target: { type: 'string', description: 'Target id (or a prefix) instead of an index.' },
    },
    output: { render: (_args, value) => json(value, 2) },
    execute: async (args) => {
      const method = required(args.method, 'method');
      const domain = String(method).split('.')[0];
      if (!ALLOWED_DOMAINS.has(domain)) {
        throw new Error(`${method} is outside the domains this tool forwards (${[...ALLOWED_DOMAINS].join(', ')}); it either does not act on a page or reaches past it into the machine`);
      }
      if (DESTRUCTIVE.has(method)) requireRisky(runtime, `${method}`);
      const params = args.params !== null && typeof args.params === 'object' ? args.params : {};
      const port = portOf(runtime);
      const list = await targets(port);
      const target = pick(list, args);
      if (target.webSocketDebuggerUrl === undefined) throw new Error(`target ${target.id} does not expose a debugging socket`);
      const socket = await CdpSocket.open(target.webSocketDebuggerUrl);
      try {
        const result = await socket.send(method, params, runtime.cfg.helperTimeoutMs);
        return { method, target: { id: target.id, url: target.url }, result };
      } finally {
        socket.close();
      }
    },
  });

  // ---------------------------------------------------------------- acting on a page
  //
  // These exist because `browser_eval` can already click - but only the way a script does: it
  // waits for nothing, it produces untrusted events, and it cannot tell whether the element it
  // clicked was the thing actually under the pointer. Each tool here does what Playwright does
  // before an action - wait for the element to exist, be visible, be enabled, stop moving, and
  // receive the pointer at its centre - and only then dispatches a real input event.

  const TARGET = {
    index: { type: 'integer', description: 'Which target from browser_tabs. Defaults to 0, the first page.' },
    target: { type: 'string', description: 'Target id (or a prefix) instead of an index.' },
  };
  const SELECTOR = {
    type: 'string',
    required: true,
    description: 'What to act on. Forms: a CSS selector, "text=Checkout" (substring), "role=button[name=Checkout]", "nth=0" to pick one of several, and ">>" to chain. Shadow roots are searched too.',
  };

  /** Resolve the target and let the page wait for the element to become actionable. */
  async function aim(port, list, args) {
    const target = pick(list, args);
    const timeout = intOr(args.timeout, 8000, { min: 100, max: 120000, name: 'timeout' });
    const found = await evaluate(port, target, targetExpression(required(args.selector, 'selector'), timeout), timeout + 5000);
    if (found === undefined || found === null) throw new Error('the page returned nothing while resolving the selector');
    if (found.error !== undefined) throw new Error(found.error);
    return { target, x: found.x, y: found.y, info: found.info };
  }

  async function act(target, fn) {
    if (target.webSocketDebuggerUrl === undefined) throw new Error(`target ${target.id} does not expose a debugging socket`);
    const socket = await CdpSocket.open(target.webSocketDebuggerUrl);
    try { return await fn(socket); } finally { socket.close(); }
  }

  const click = defineTool({
    name: 'browser_click',
    description:
      'Click an element on the page, waiting for it to be ready first. This is what "click the login button" should use instead of browser_eval: it waits for the element to exist, be visible, be enabled, stop moving, and actually be the thing under the pointer at its centre, then sends a real (trusted) mouse event. If the selector matches more than one element it says so rather than picking one.',
    parameters: {
      selector: SELECTOR,
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Defaults to left.' },
      clickCount: { type: 'integer', description: '1 for a click, 2 for a double click. Defaults to 1.' },
      timeout: { type: 'integer', description: 'How long to wait for the element to become actionable, in milliseconds. Defaults to 8000.' },
      ...TARGET,
    },
    output: { render: (_args, value) => json(value, 2) },
    execute: async (args) => {
      const port = portOf(runtime);
      const list = await targets(port);
      const aimed = await aim(port, list, args);
      const button = args.button === 'right' || args.button === 'middle' ? args.button : 'left';
      const clickCount = intOr(args.clickCount, 1, { min: 1, max: 3, name: 'clickCount' });
      await act(aimed.target, async (socket) => {
        await socket.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: aimed.x, y: aimed.y, button: 'none' });
        await socket.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: aimed.x, y: aimed.y, button, clickCount });
        await socket.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: aimed.x, y: aimed.y, button, clickCount });
      });
      return { clicked: aimed.info, at: { x: aimed.x, y: aimed.y }, button, clickCount, target: { id: aimed.target.id, url: aimed.target.url } };
    },
  });

  const fill = defineTool({
    name: 'browser_fill',
    description:
      'Type into a field on the page, waiting for it to be ready first. Clicks the element to focus it, selects whatever is already there, then inserts the text as a real input event so frameworks notice it. Use this rather than setting .value in browser_eval: assigning value fires no events, so most frameworks keep showing the old text and submit nothing.',
    parameters: {
      selector: SELECTOR,
      text: { type: 'string', required: true, description: 'Text to enter. Replaces the current contents.' },
      submit: { type: 'boolean', description: 'Press Enter after typing.' },
      timeout: { type: 'integer', description: 'How long to wait for the element to become actionable, in milliseconds. Defaults to 8000.' },
      ...TARGET,
    },
    output: { render: (_args, value) => json(value, 2) },
    execute: async (args) => {
      const value = required(args.text, 'text');
      const port = portOf(runtime);
      const list = await targets(port);
      const aimed = await aim(port, list, args);
      await act(aimed.target, async (socket) => {
        await socket.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: aimed.x, y: aimed.y, button: 'left', clickCount: 1 });
        await socket.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: aimed.x, y: aimed.y, button: 'left', clickCount: 1 });
        // Select the current contents so the insert replaces rather than appends. Done in the
        // page because selecting a field is not an input event the protocol exposes.
        await evaluate(port, aimed.target, `(() => {
          const active = document.activeElement;
          if (active && typeof active.select === 'function') { active.select(); return 'selected'; }
          document.execCommand('selectAll');
          return 'selected';
        })()`, 5000);
        await socket.send('Input.insertText', { text: value });
        if (args.submit === true) {
          await socket.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
          await socket.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        }
      });
      return { filled: aimed.info, characters: value.length, submitted: args.submit === true, target: { id: aimed.target.id, url: aimed.target.url } };
    },
  });

  const waitFor = defineTool({
    name: 'browser_wait',
    description:
      'Wait until something on the page is true, then return. Use this instead of a fixed delay after navigating or clicking: it checks every 100 ms and stops as soon as the condition holds. Two ways to say what to wait for: `selector` with a `state` ("visible" the default, "hidden", "attached"), or `condition`, a JavaScript expression that must become truthy - the second is for things that are not elements, such as a cookie, a global, or a page state. Waiting for somebody to finish logging in is a condition, not a selector: the class a site uses once authenticated cannot be known in advance.',
    parameters: {
      selector: { type: 'string', description: 'What to wait for. Forms: a CSS selector, text=..., role=..., nth=..., and >> to chain. Omit when using condition.' },
      condition: { type: 'string', description: 'A JavaScript expression that must become truthy, such as document.cookie.includes("session"). Mutually exclusive with selector.' },
      state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'], description: 'What to wait for. visible (default) and hidden are about visibility; attached and detached are about existence in the document.' },
      timeout: { type: 'integer', description: 'How long to wait, in milliseconds. Defaults to 10000.' },
      ...TARGET,
    },
    output: { render: (_args, value) => json(value, 2) },
    execute: async (args) => {
      const port = portOf(runtime);
      const timeout = intOr(args.timeout, 10000, { min: 100, max: 300000, name: 'timeout' });
      const state = ['hidden', 'attached', 'detached'].includes(args.state) ? args.state : 'visible';
      const useCondition = args.condition !== undefined && args.condition !== null && String(args.condition).length > 0;
      if (useCondition && args.selector !== undefined && args.selector !== null && String(args.selector).length > 0) {
        throw new Error('give either selector or condition, not both: they would be two different waits');
      }
      const described = useCondition
        ? { condition: String(args.condition) }
        : { selector: required(args.selector, 'selector'), state };

      // Polled from here rather than from inside the page. A wait can last minutes, a page can
      // navigate in the middle of one, and a single long-lived evaluate dies with the document
      // it started in - which is how the first version failed, with "Inspected target navigated
      // or closed". Each attempt is a short call, a failed one just means the document changed,
      // and the target is looked up again before the next attempt.
      const startedAt = Date.now();
      const deadline = startedAt + timeout;
      let lastError = null;
      let attempts = 0;
      for (;;) {
        attempts += 1;
        try {
          const list = await targets(port);
          const target = pick(list, args);
          const expression = useCondition
            ? conditionCheckExpression(described.condition)
            : stateExpression(described.selector, state);
          const outcome = await evaluate(port, target, expression, 6000);
          if (outcome !== undefined && outcome !== null && outcome.ok === true) {
            return { satisfied: true, attempts, waitedMs: Date.now() - startedAt, ...described, matched: outcome.matched ?? null, error: null, target: { id: target.id, url: target.url } };
          }
          if (outcome !== undefined && outcome !== null && outcome.error !== undefined) lastError = outcome.error;
        } catch (error) {
          // A navigation between two attempts is expected, not a failure of the wait.
          lastError = error?.message ?? String(error);
        }
        if (Date.now() >= deadline) {
          return { satisfied: false, attempts, waitedMs: Date.now() - startedAt, ...described, matched: null, error: lastError, target: null };
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    },
  });

  // Downloads happen outside any page: the browser writes the file and reports progress on the
  // browser-level endpoint, not the page's.
  //
  // The subscription has to outlive a single call. A download starts between two tool calls -
  // configure, then the click, then wait - and protocol events only reach a client that is
  // connected when they happen. Opening a socket per call lost every event in that gap, which
  // is exactly what the first version did: zero events, zero files. So one browser-level socket
  // is opened on `configure` and kept, buffering everything it hears until `wait` reads it.
  const downloadDir = (() => {
    const configured = runtime.cfg.browserDownloadDir;
    if (typeof configured === 'string' && configured.length > 0) return configured;
    return path.join(os.homedir(), '.dsh', 'cache', 'computer-control', 'browser-downloads');
  })();

  /** The browser-level socket, which is where download control and events live. */
  async function browserSocket(port) {
    const version = await fetchJson(`${base(port)}/json/version`);
    if (typeof version.webSocketDebuggerUrl !== 'string') {
      throw new Error('this browser does not expose a browser-level debugging socket, so downloads cannot be configured');
    }
    return CdpSocket.open(version.webSocketDebuggerUrl);
  }

  /** Open (once) the download listener and point the browser at the directory. */
  async function ensureDownloadListener(port) {
    const existing = runtime.browserDownloads;
    if (existing !== undefined && existing.port === port && existing.socket.closed !== true) return existing;
    if (existing !== undefined) { try { existing.socket.close(); } catch { /* already gone */ } }
    const socket = await browserSocket(port);
    const state = { port, socket, directory: downloadDir, events: [], completed: [], names: new Map(), since: new Date().toISOString() };
    socket.on('Browser.downloadWillBegin', (p) => {
      state.names.set(p.guid, p.suggestedFilename ?? '');
      state.events.push({ phase: 'begin', guid: p.guid, filename: p.suggestedFilename ?? '', url: p.url ?? '' });
    });
    socket.on('Browser.downloadProgress', (p) => {
      state.events.push({ phase: 'progress', guid: p.guid, state: p.state ?? '', received: p.receivedBytes ?? 0, total: p.totalBytes ?? 0 });
      if (p.state === 'completed' || p.state === 'canceled') {
        state.completed.push({ guid: p.guid, filename: state.names.get(p.guid) ?? '', state: p.state, received: p.receivedBytes ?? 0 });
      }
    });
    await socket.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: downloadDir,
      eventsEnabled: true,
    }, runtime.cfg.helperTimeoutMs);
    runtime.browserDownloads = state;
    return state;
  }

  const downloads = defineTool({
    name: 'browser_downloads',
    description:
      'Handle file downloads. Action "configure" points downloads at a known directory and starts listening - call it BEFORE whatever triggers the download, because the browser decides where a download goes when it starts and events only reach a listener that is already connected. Action "wait" then waits for one to finish and reports it. Use `expect` to wait for a particular filename; without it, the first completed download ends the wait.',
    parameters: {
      action: { type: 'string', enum: ['configure', 'wait'], required: true, description: 'configure, or wait.' },
      expect: { type: 'string', description: 'For "wait": a substring of the filename to wait for.' },
      timeout: { type: 'integer', description: 'For "wait": how long to wait, in milliseconds. Defaults to 15000.' },
    },
    output: { render: (_args, value) => json(value, 2) },
    execute: async (args) => {
      const action = required(args.action, 'action');
      const port = portOf(runtime);
      try { await fs.promises.mkdir(downloadDir, { recursive: true }); } catch (error) {
        throw new Error(`could not create the download directory ${downloadDir}: ${error.message}`);
      }
      const state = await ensureDownloadListener(port);
      if (action === 'configure') {
        return { action, directory: downloadDir, port, listening: true, alreadySeen: state.completed.length };
      }

      const timeout = intOr(args.timeout, 15000, { min: 500, max: 300000, name: 'timeout' });
      const expect = typeof args.expect === 'string' && args.expect.length > 0 ? args.expect : undefined;
      const deadline = Date.now() + timeout;
      for (;;) {
        const hit = state.completed.find((entry) => entry.state === 'completed'
          && (expect === undefined || entry.filename.includes(expect)));
        if (hit !== undefined || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      let files = [];
      try { files = await fs.promises.readdir(downloadDir); } catch { /* created above */ }
      return {
        action,
        directory: downloadDir,
        expect: expect ?? null,
        listeningSince: state.since,
        completed: state.completed,
        files,
        events: state.events,
        note: 'with allowAndName the file on disk is named by its download guid; `completed` maps each guid to the name the site suggested.',
      };
    },
  });

  return [launch, tabs, read, evaluateTool, screenshot, command, click, fill, waitFor, downloads];
}
