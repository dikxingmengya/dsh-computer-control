// Stopping a wait that is already running.
//
// A tool call cannot be interrupted from outside: the Host awaits the promise a tool returns,
// so a `wait_for { mode: "sleep", ms: 600000 }` sat there for ten minutes and pressing stop in
// the conversation did nothing. The same was true of the polling loops in wait_for and
// browser_wait - anything that owns its own time.
//
// A generation counter is enough. Every wait records the generation it started in, re-checks it
// while it waits, and throws when it has moved. `/computer-stop` moves it, so there is a switch
// a person can actually reach without waiting for the sleep to end. If the Host ever passes an
// abort signal through `exec`, that is honoured too - but the plugin does not depend on it,
// because a wait that only a cooperative Host can cancel is not a wait you can cancel.

let generation = 0;

/** Stop every wait that is currently running. Returns the new generation. */
export function stopAll() {
  generation += 1;
  return generation;
}

/** The current generation, recorded by a wait when it starts. */
export function currentToken() {
  return generation;
}

/** The generation after a stop, for a caller that wants to report it. */
export function generationOf() {
  return generation;
}

/** True when this wait should give up. */
function cancelled(token, exec) {
  if (token !== generation) return 'stopped by /computer-stop';
  // Not documented anywhere the plugin can see, so it is used only if it is there.
  const signal = exec?.signal ?? exec?.abortSignal;
  if (signal !== undefined && signal?.aborted === true) return 'stopped by the harness';
  return null;
}

/** Throw if a stop happened since `token` was taken. */
export function checkpoint(token, exec) {
  const reason = cancelled(token, exec);
  if (reason !== null) throw new Error(`cancelled: ${reason}`);
}

/**
 * Sleep for `ms`, in slices, giving up as soon as a stop arrives.
 *
 * Sliced rather than one timer because a single `setTimeout(600000)` cannot be reasoned with
 * once it is running: nothing in this process will ever wake it early. The slice is short
 * enough that a stop is felt in about a tenth of a second and long enough not to spin.
 */
export async function pause(ms, token, exec) {
  const deadline = Date.now() + Math.max(0, ms);
  for (;;) {
    checkpoint(token, exec);
    const left = deadline - Date.now();
    if (left <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(left, 100)));
  }
}
