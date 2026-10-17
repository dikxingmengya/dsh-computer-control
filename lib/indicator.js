// On-screen indicators, wrapped for the tools.
//
// Two things are shown to the person at the machine, never to the model:
//   * a frame outlining the rectangle a capture is about to take, which comes
//     back afterwards so the label can actually be read
//   * a badge naming the operation in progress, for every call that touches the
//     machine - including captures
//
// The wording of a badge comes from lib/activity.js, so the floating notice and
// the operation list always describe the same call the same way. The windows
// themselves live in native/overlay.cs.
//
// The one invariant here is that an indicator must never end up inside a capture:
// when the OS can exclude the windows from capture APIs
// (`SetWindowDisplayAffinity`) they simply stay on screen, and when it cannot -
// or it would make them invisible to the person too - the caller hides them
// before the shutter instead. Every entry point swallows its own failures: an
// unavailable indicator must never fail a tool call.
import { resolveLanguage } from './activity.js';

const MESSAGES = {
  zh: {
    captureFrame: (what, size) => `DeepSeek Harness 截屏 · ${what} ${size}`,
    handsOff: '请暂停操作鼠标键盘',
  },
  en: {
    captureFrame: (what, size) => `DeepSeek Harness capture · ${what} ${size}`,
    handsOff: 'please keep hands off the mouse and keyboard',
  },
};

export class Indicator {
  #runtime;
  #bridge;
  #cfg;
  #t;
  #startPromise = null;
  #status = { available: false, captureExcluded: false, reason: 'not started' };
  #badgeText = '';
  #badgeVisible = false;
  #lastBadgeAt = 0;
  #failures = 0;
  #themeCache = { at: 0, value: '' };

  constructor(runtime) {
    this.#runtime = runtime;
    this.#bridge = runtime.bridge;
    this.#cfg = runtime.cfg;
    this.#t = MESSAGES[resolveLanguage(runtime.cfg.indicatorLanguage)];
  }

  get text() {
    return this.#t;
  }

  get status() {
    return { ...this.#status };
  }

  /**
   * The palette the indicator should draw with: 'light', 'dark', or '' to let the
   * native layer follow the Windows app theme.
   *
   * The DSH choice lives in the `ui-theme` settings namespace, which the Host
   * settings service exposes; `system` defers to Windows. Re-read at most every
   * few seconds so switching theme in Settings reaches the indicator without a
   * restart, while a burst of input actions does not re-read for each one.
   */
  theme() {
    if (this.#cfg.indicatorTheme === 'light' || this.#cfg.indicatorTheme === 'dark') return this.#cfg.indicatorTheme;
    const now = Date.now();
    if (now - this.#themeCache.at > 5000) this.#themeCache = { at: now, value: this.#hostTheme() };
    return this.#themeCache.value;
  }

  #hostTheme() {
    try {
      const settings = this.#runtime.ctx.get?.('settings');
      if (!settings || typeof settings.describe !== 'function') return '';
      for (const descriptor of settings.describe({ redactSecrets: true }) ?? []) {
        const value = descriptor?.value;
        if (!value || typeof value !== 'object') continue;
        if (!String(descriptor.ns ?? '').includes('theme')) continue;
        // The dsh-client-ui-theme row carries the choice in `preference`
        // ('light' | 'dark' | 'system'); accept `theme` too in case a future
        // revision renames it.
        const preference = value.preference ?? value.theme;
        if (preference === 'light' || preference === 'dark') return preference;
        if (preference === 'system') return '';
      }
    } catch (error) {
      this.#runtime.ctx.logger?.debug?.(`computer-control: could not read the DSH theme (${error.message}); following the Windows theme instead`);
    }
    return '';
  }

  /** Start the overlay thread once; returns its status without ever throwing. */
  async ensure() {
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = (async () => {
      try {
        const started = await this.#bridge.call(
          'overlay.start',
          { claim: this.#cfg.indicatorClaimScreen !== false },
          { timeoutMs: this.#cfg.helperTimeoutMs },
        );
        this.#status = {
          available: started.available === true,
          captureExcluded: started.captureExcluded === true,
          reason: started.reason || started.excludeFailure || undefined,
        };
        // Exclusion is opt-in: the Host may report success while the window still
        // vanishes from what the monitor shows, so the safe default is to keep the
        // indicator plainly visible and take it down before each shutter.
        if (this.#status.available && this.#cfg.indicatorCaptureExcluded === true) {
          const applied = await this.#call('overlay.affinity', { exclude: true });
          this.#status.captureExcluded = applied?.captureExcluded === true;
          this.#status.reason = this.#status.captureExcluded
            ? 'capture exclusion was requested by config; if you cannot see the indicators, set indicatorCaptureExcluded: false'
            : applied?.excludeFailure || 'the system refused to exclude the indicators from captures';
        }
        if (this.#status.available) {
          this.#runtime.ctx.logger?.info?.(
            `computer-control: on-screen indicators active (capture layout: ${this.#status.captureExcluded ? 'excluded from captures, visible during the shutter' : 'kept visible, hidden before each shutter'})`,
          );
        }
      } catch (error) {
        this.#status = { available: false, captureExcluded: false, reason: error.message };
      }
      if (!this.#status.available) {
        this.#runtime.ctx.logger?.warn?.(`computer-control: on-screen indicators are unavailable (${this.#status.reason}); input and capture continue without them`);
      }
      return this.#status;
    })();
    return this.#startPromise;
  }

  async #call(op, args) {
    try {
      return await this.#bridge.call(op, args, { timeoutMs: this.#cfg.helperTimeoutMs });
    } catch (error) {
      this.#failures += 1;
      if (this.#failures <= 3) this.#runtime.ctx.logger?.warn?.(`computer-control: indicator ${op} failed: ${error.message}`);
      return undefined;
    }
  }

  /** Outline a screen rectangle. `holdMs` of 0 leaves it up until frameOff(). */
  async frameOn(area, label, holdMs = 0) {
    if (this.#cfg.captureIndicator !== true) return false;
    const status = await this.ensure();
    if (!status.available) return false;
    const result = await this.#call('overlay.region', {
      x: area.x,
      y: area.y,
      width: area.width,
      height: area.height,
      label,
      holdMs,
      theme: this.theme(),
    });
    return result?.shown === true;
  }

  async frameOff() {
    if (this.#startPromise === null) return;
    await this.#call('overlay.region.hide', {});
  }

  /** Show or refresh the input badge. Failures are swallowed. */
  async badge(message) {
    if (this.#cfg.inputIndicator !== true) return false;
    const status = await this.ensure();
    if (!status.available) return false;
    // The first badge of a burst carries the hands-off request; the refreshes that
    // follow stay short so a long automation run is not covered by a wall of text.
    const now = Date.now();
    const opening = now - this.#lastBadgeAt > this.#cfg.inputIndicatorHoldMs;
    this.#lastBadgeAt = now;
    this.#badgeText = message;
    const text = opening ? `${message} · ${this.#t.handsOff}` : message;
    const result = await this.#call('overlay.badge', { text, holdMs: this.#cfg.inputIndicatorHoldMs, theme: this.theme() });
    this.#badgeVisible = result?.shown === true;
    return this.#badgeVisible;
  }

  async badgeOff() {
    if (this.#startPromise === null) return;
    this.#badgeVisible = false;
    await this.#call('overlay.badge.hide', {});
  }

  /**
   * Hide the badge for a capture when the OS cannot exclude it from captures.
   * Returns whether it was up, so the caller can put it back afterwards.
   */
  async concealBadge() {
    const status = await this.ensure();
    if (!status.available || status.captureExcluded) return false;
    if (!this.#badgeVisible) return false;
    await this.#call('overlay.badge.hide', {});
    return true;
  }

  /** Put the badge back after a capture that had to conceal it. */
  async restoreBadge(wasUp) {
    if (wasUp && this.#badgeText.length > 0) await this.badge(this.#badgeText);
  }

  /** Best-effort teardown, called when the plugin unloads. */
  dispose() {
    try {
      this.#bridge.call('overlay.stop', {}, { timeoutMs: 2000 })?.catch?.(() => {});
    } catch {
      /* the helper may already be gone */
    }
  }
}

/** A one-line description of an area for the capture frame label. */
export function describeArea(area, result) {
  const size = result ? `${result.screenWidth}x${result.screenHeight}` : `${area.width}x${area.height}`;
  return `${size}`;
}
