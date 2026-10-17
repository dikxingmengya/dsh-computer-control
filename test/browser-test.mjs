import { fileURLToPath } from 'node:url';
// Browser-side unit tests.
//
// The last three rounds of browser_wait bugs all shipped with every existing suite green,
// because none of those suites had ever opened a browser. Each check here corresponds to
// something that actually went wrong, not to something that seemed worth covering.
//
// It launches a real browser on a throwaway profile and a port of its own, serves its pages
// from a local HTTP server, and closes that browser when it is done - never the user's.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { browserTools } from '../lib/tools/browser.js';
import { CdpSocket, fetchJson } from '../lib/cdp.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n          ${detail}` : ''}`);
};

const PORT = 9382;
const PROFILE = path.join(os.tmpdir(), 'dsh-browser-test-profile');
const DOWNLOADS = path.join(os.tmpdir(), 'dsh-browser-test-downloads');
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.rmSync(DOWNLOADS, { recursive: true, force: true });

// A local server, because a data: URL cannot be navigated to at top level and about:blank
// cannot be navigated away from in a way that proves anything.
const server = http.createServer((req, res) => {
  if (req.url === '/file') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="report.txt"',
    });
    res.end('downloaded\n');
    return;
  }
  const which = req.url === '/two' ? 'two' : 'one';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>${which}</title><body><p>${which}</p><a id=dl href="/file" download>Download report</a></body>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const runtime = {
  cfg: {
    browserDebugPort: PORT,
    browserPath: '',
    browserUserDataDir: PROFILE,
    browserDownloadDir: DOWNLOADS,
    helperTimeoutMs: 20000,
    attachImages: 'never',
  },
  ctx: { get: () => undefined },
  artifacts: { nextPath: async () => path.join(os.tmpdir(), 'shot.png') },
};
const tools = Object.fromEntries(browserTools(runtime).map((tool) => [tool.name, tool]));
const run = (name, args) => tools[name].execute(targetOf(name, args), { agent: { id: 'browser-test' } });
const targetOf = (name, args) => (PAGE !== null && args.target === undefined && name !== 'browser_launch' && name !== 'browser_tabs' ? { target: PAGE, ...args } : args);

// Every call names its target. An index is only valid for the list it came from, and a page
// can be added between two calls - which is exactly how this suite first failed: a click that
// should have reported two matching buttons reported none, because it was looking at another
// page. The id does not move.
let PAGE = null;

let exitCode = 0;
try {
  // Headless: a test must not put a window, a dialog or a sound on the machine it runs on.
  // The first version launched a visible Edge, which greeted it with a modal "sync your browsing
  // data" bubble; the bubble covered the page, and the symptom was a download link that "did not
  // exist". A test that changes the state of the desktop to test a browser is the wrong shape.
  await run('browser_launch', { headless: true });
  await run('browser_command', { method: 'Page.navigate', params: { url: `${origin}/one` } });
  await run('browser_wait', { selector: 'title', state: 'attached', timeout: 15000 });
  const pinPage = async () => {
    const tabs = await run('browser_tabs', {});
    const page = tabs.tabs.find((entry) => entry.type === 'page');
    if (page === undefined) throw new Error('no page target to test against');
    PAGE = page.id;
    return page;
  };
  await pinPage();

  // The page these checks run against. Built with createElement rather than innerHTML so no
  // quoting can break it halfway.
  await run('browser_eval', {
    expression: [
      'document.body.textContent = "";',
      // Created here rather than left in the served page: the line above clears document.body,
      // so everything the server sent is gone by this point.
      'const dl = document.createElement("a"); dl.id = "dl"; dl.href = "/file"; dl.download = "report.txt"; dl.textContent = "Download report"; document.body.appendChild(dl);',
      'const b = document.createElement("button"); b.id = "buy"; b.textContent = "Checkout"; document.body.appendChild(b);',
      'const i = document.createElement("input"); i.id = "email"; i.placeholder = "Email address"; document.body.appendChild(i);',
      'const s = document.createElement("select"); s.id = "pick"; const o = document.createElement("option"); o.textContent = "One"; s.appendChild(o); document.body.appendChild(s);',
      'const a = document.createElement("a"); a.href = "#help"; a.textContent = "Help"; document.body.appendChild(a);',
      'const gone = document.createElement("button"); gone.id = "gone"; gone.textContent = "Invisible"; gone.style.display = "none"; document.body.appendChild(gone);',
      'const host = document.createElement("div"); document.body.appendChild(host);',
      'const root = host.attachShadow({ mode: "open" });',
      'const sb = document.createElement("button"); sb.id = "shadow"; sb.textContent = "Shadow Buy"; root.appendChild(sb);',
      'window.__events = 0; window.__clicked = null; window.__shadowClicked = null;',
      'i.addEventListener("input", () => { window.__events++; });',
      'b.addEventListener("click", (e) => { window.__clicked = e.isTrusted; });',
      'sb.addEventListener("click", (e) => { window.__shadowClicked = e.isTrusted; });',
      '"ok"',
    ].join(' '),
  });

  // ---- roles ---------------------------------------------------------------
  // A plain input reported role "text" because el.type returns "text" when unset, which reads
  // like a paragraph in the snapshot instead of somewhere to type.
  const read = await run('browser_read', {});
  const byName = Object.fromEntries(read.elements.map((e) => [e.name, e.role]));
  check('a plain input is role textbox, not text',
    byName['Email address'] === 'textbox', `got ${JSON.stringify(byName['Email address'])}`);
  check('a select is role combobox', byName.One === 'combobox', `got ${JSON.stringify(byName.One)}`);
  check('an anchor is role link', byName.Help === 'link', `got ${JSON.stringify(byName.Help)}`);
  check('a button inside a shadow root is listed',
    read.elements.some((e) => e.name === 'Shadow Buy'), JSON.stringify(read.elements.map((e) => e.name)));

  // ---- text= matching ------------------------------------------------------
  // text= only looked at text content, so a field whose name is its placeholder was invisible
  // to it: the snapshot said textbox "Email address" and text=Email address found nothing.
  await run('browser_fill', { selector: 'text=Email address', text: 'a@b.c' });
  const filled = await run('browser_eval', { expression: 'document.getElementById("email").value' });
  check('text= matches a placeholder, not only text content', filled.value === 'a@b.c', `value ${JSON.stringify(filled.value)}`);

  await run('browser_click', { selector: 'text=Checkout' });
  const clicked = await run('browser_eval', { expression: 'String(window.__clicked)' });
  check('a click dispatched from here is trusted', clicked.value === 'true', `isTrusted ${clicked.value}`);

  await run('browser_fill', { selector: '#email', text: 'x@y.z' });
  const events = await run('browser_eval', { expression: 'String(window.__events)' });
  check('fill fires a real input event', Number(events.value) >= 1, `${events.value} event(s)`);

  // ---- shadow roots --------------------------------------------------------
  // document.elementsFromPoint does not pierce a shadow root, so an actionability check built
  // on it reported "something is covering" for every button inside a component.
  await run('browser_click', { selector: 'text=Shadow Buy' });
  const shadowClicked = await run('browser_eval', { expression: 'String(window.__shadowClicked)' });
  check('a click reaches a button inside a shadow root', shadowClicked.value === 'true', `isTrusted ${shadowClicked.value}`);

  // ---- actionability -------------------------------------------------------
  let refusal = null;
  try { await run('browser_click', { selector: '#gone', timeout: 600 }); } catch (error) { refusal = error.message; }
  check('an invisible element is refused, not clicked', /not visible/.test(refusal ?? ''), refusal ?? 'no error');

  let ambiguous = null;
  try { await run('browser_click', { selector: 'button', timeout: 600 }); } catch (error) { ambiguous = error.message; }
  check('an ambiguous selector is refused, not guessed', /matched \d+ elements/.test(ambiguous ?? ''), ambiguous ?? 'no error');

  // ---- xpath ---------------------------------------------------------------
  const xpath = await run('browser_click', { selector: 'xpath=//button[@id="buy"]' });
  check('xpath= resolves', xpath.clicked.name === 'Checkout', JSON.stringify(xpath.clicked.name));

  // ---- wait: condition -----------------------------------------------------
  await run('browser_eval', { expression: 'setTimeout(() => { window.__ready = true; }, 600); "ok"' });
  const appeared = await run('browser_wait', { condition: 'window.__ready === true', timeout: 6000 });
  check('a condition that becomes true is waited for',
    appeared.satisfied === true && appeared.attempts > 1,
    `satisfied=${appeared.satisfied} attempts=${appeared.attempts} waited=${appeared.waitedMs}ms`);

  const timedOut = await run('browser_wait', { condition: 'false', timeout: 700 });
  check('a condition that never holds reports not satisfied',
    timedOut.satisfied === false, `satisfied=${timedOut.satisfied} waited=${timedOut.waitedMs}ms`);

  // ---- wait: selector states ----------------------------------------------
  // hidden used to mean "matched nothing", which made a wrong selector report success in a
  // millisecond. hidden now means not visible; detached means not in the document.
  const hiddenPresent = await run('browser_wait', { selector: '#gone', state: 'hidden', timeout: 800 });
  check('hidden is satisfied by an element that exists but is not visible',
    hiddenPresent.satisfied === true && hiddenPresent.matched === 1,
    `satisfied=${hiddenPresent.satisfied} matched=${hiddenPresent.matched}`);

  const visibleGone = await run('browser_wait', { selector: '#gone', state: 'visible', timeout: 700 });
  check('visible is not satisfied by an invisible element', visibleGone.satisfied === false, `satisfied=${visibleGone.satisfied}`);

  const attachedAbsent = await run('browser_wait', { selector: '#nope', state: 'attached', timeout: 700 });
  check('attached is not satisfied by an absent element', attachedAbsent.satisfied === false, `satisfied=${attachedAbsent.satisfied}`);

  const detachedAbsent = await run('browser_wait', { selector: '#nope', state: 'detached', timeout: 700 });
  check('detached is satisfied by an absent element', detachedAbsent.satisfied === true, `satisfied=${detachedAbsent.satisfied}`);

  let both = null;
  try { await run('browser_wait', { selector: '#buy', condition: 'true', timeout: 500 }); } catch (error) { both = error.message; }
  check('asking for a selector and a condition is refused', /either selector or condition/.test(both ?? ''), both ?? 'no error');

  // ---- downloads -----------------------------------------------------------
  // Events only reach a client that is connected when they happen, so the listener has to be
  // established before the click and has to outlive the call that established it.
  const configured = await run('browser_downloads', { action: 'configure' });
  check('downloads can be pointed at a directory', configured.directory === DOWNLOADS, configured.directory);

  await run('browser_click', { selector: '#dl' });
  const download = await run('browser_downloads', { action: 'wait', expect: 'report', timeout: 15000 });
  const completed = download.completed.filter((entry) => entry.state === 'completed');
  check('a download is reported as completed with the name the site gave it',
    completed.length === 1 && completed[0].filename === 'report.txt',
    JSON.stringify(download.completed));
  check('the file is on disk under the name of its download',
    download.files.includes(completed[0]?.guid),
    JSON.stringify(download.files));
  check('the download events were captured', download.events.length >= 2, `${download.events.length} event(s)`);

  // ---- wait across a navigation -------------------------------------------
  // The whole poll loop used to run inside the page, so a navigation killed it with
  // "Inspected target navigated or closed". This is a real document change, not a hash jump.
  await run('browser_eval', { expression: `setTimeout(() => { location.href = "${origin}/two"; }, 400); "ok"` });
  const navigated = await run('browser_wait', { condition: "location.pathname === '/two'", timeout: 8000 });
  check('a wait survives the page navigating underneath it',
    navigated.satisfied === true, `satisfied=${navigated.satisfied} attempts=${navigated.attempts} error=${navigated.error}`);

  // ---- frames --------------------------------------------------------------
  const framed = await run('browser_read', {});
  check('the read reports a frames list', Array.isArray(framed.frames), JSON.stringify(framed.frames));
} catch (error) {
  console.log(`  FAIL  the suite threw: ${error?.message ?? error}`);
  results.push({ name: 'suite completed', ok: false });
  exitCode = 1;
} finally {
  server.close();
  // Close only the browser this suite started, through its own debugging socket.
  try {
    const version = await fetchJson(`http://127.0.0.1:${PORT}/json/version`);
    if (typeof version.webSocketDebuggerUrl === 'string') {
      const socket = await CdpSocket.open(version.webSocketDebuggerUrl);
      await socket.send('Browser.close', {}, 3000).catch(() => {});
      socket.close();
    }
  } catch { /* the browser is already gone, which is the outcome this is after */ }
  // A browser that has only just been asked to close still holds files in its profile. Tidying
  // up must not turn a passing suite into a failing one.
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* left for the OS */ }
  try { fs.rmSync(DOWNLOADS, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* left for the OS */ }
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n=========== ${passed} passed, ${failed} failed ===========`);
process.exit(failed === 0 && exitCode === 0 ? 0 : 1);
