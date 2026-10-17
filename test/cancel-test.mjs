// A wait must be interruptible, and nothing else here would notice if it stopped being so.
//
// The bug this covers: `wait_for { mode: "sleep", ms: 600000 }` could not be interrupted at all.
// The sleep was a single timer, the Host awaits the promise a tool returns, and pressing stop in
// the conversation did nothing - the turn stayed stuck for the whole ten minutes. Every check
// below is about time this process has to be able to give back.

import { currentToken, pause, stopAll } from '../lib/cancel.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n          ${detail}` : ''}`);
};

// A stop must reach a sleep that is already running, not only the next one.
{
  const token = currentToken();
  const started = Date.now();
  const running = pause(10000, token, {});
  setTimeout(() => stopAll(), 120);
  let message = null;
  try { await running; } catch (error) { message = error.message; }
  const elapsed = Date.now() - started;
  check('a long sleep gives up when /computer-stop arrives',
    /cancelled/.test(message ?? '') && elapsed < 1500,
    `after ${elapsed} ms: ${message}`);
}

// A sleep nobody interrupts must still finish, and take about as long as it was asked for.
{
  const token = currentToken();
  const started = Date.now();
  await pause(400, token, {});
  const elapsed = Date.now() - started;
  check('an undisturbed sleep still completes', elapsed >= 380 && elapsed < 1500, `after ${elapsed} ms`);
}

// A token from before a stop is dead; the one after it works. This is what stops a stale
// checkpoint from failing every future call.
{
  const stale = currentToken();
  stopAll();
  const fresh = currentToken();
  let staleThrew = false;
  try { await pause(1000, stale, {}); } catch { staleThrew = true; }
  let freshSurvived = true;
  try { await pause(150, fresh, {}); } catch { freshSurvived = false; }
  check('a stop invalidates earlier waits but not later ones', staleThrew && freshSurvived,
    `stale threw=${staleThrew} fresh completed=${freshSurvived}`);
}

// If the Host does pass an abort signal, it is honoured too - but nothing depends on it.
{
  const token = currentToken();
  const controller = new AbortController();
  const started = Date.now();
  const running = pause(10000, token, { signal: controller.signal });
  setTimeout(() => controller.abort(), 120);
  let message = null;
  try { await running; } catch (error) { message = error.message; }
  check('an aborted exec signal is honoured as well',
    /cancelled/.test(message ?? '') && Date.now() - started < 1500,
    `after ${Date.now() - started} ms: ${message}`);
}

const passed = results.filter((entry) => entry.ok).length;
const failed = results.length - passed;
console.log(`\n=========== ${passed} passed, ${failed} failed ===========`);
process.exit(failed === 0 ? 0 : 1);
