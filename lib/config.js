// Plugin configuration: defaults, validation, and the settings the tools read.
import os from 'node:os';
import path from 'node:path';

const ATTACH_MODES = ['auto', 'always', 'never'];

/** Default artifact root: the harness cache when DSH_HOME is known, else the
 *  conventional ~/.dsh cache, else the OS temp directory. The host process does
 *  not always carry DSH_HOME (only shell children do), so it cannot be the only
 *  source: without the fallback, captures would silently land in Temp. */
function defaultArtifactDir() {
  const home = process.env.DSH_HOME;
  if (home && home.trim().length > 0) return path.join(home, 'cache', 'computer-control');
  const userHome = os.homedir();
  if (userHome && userHome.trim().length > 0) return path.join(userHome, '.dsh', 'cache', 'computer-control');
  return path.join(os.tmpdir(), 'dsh-cache', 'computer-control');
}

function bool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`expected a boolean, got ${JSON.stringify(value)}`);
}

function positiveInt(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function nonNegativeInt(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Normalize the loader row's `config` into the shape the tools consume.
 * Unknown keys are ignored so a newer patch cannot break an older plugin.
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const attach = source.attachImages ?? 'auto';
  if (!ATTACH_MODES.includes(attach)) {
    throw new Error(`attachImages must be one of ${ATTACH_MODES.join(', ')}, got ${JSON.stringify(attach)}`);
  }
  const groups = source.groups && typeof source.groups === 'object' ? source.groups : {};
  const disabled = Array.isArray(source.disabledTools) ? source.disabledTools.map(String) : [];
  return {
    /** Report what a mutating action would do without injecting any input. */
    dryRun: bool(source.dryRun, false),
    /** Allow destructive actions: closing windows, killing processes, locking, sleeping, blanking the display. */
    allowRisky: bool(source.allowRisky, false),
    /** Whether a capture also reaches the model as an image block. */
    attachImages: attach,
    /** Longest edge of an attached capture; 0 keeps native resolution. */
    maxImageDim: nonNegativeInt(source.maxImageDim, 1568, 'maxImageDim'),
    /** JPEG quality when a capture asks for jpeg. */
    jpegQuality: positiveInt(source.jpegQuality, 85, 'jpegQuality'),
    /** Where captures and recordings are written. */
    artifactDir: typeof source.artifactDir === 'string' && source.artifactDir.trim().length > 0 ? source.artifactDir : defaultArtifactDir(),
    /** Per-key typing delay; nonzero looks human but is slower. */
    typingDelayMs: nonNegativeInt(source.typingDelayMs, 0, 'typingDelayMs'),
    /** Bound on one helper request that does not capture the screen. */
    helperTimeoutMs: positiveInt(source.helperTimeoutMs, 20_000, 'helperTimeoutMs'),
    /** Bound on one screen capture. */
    captureTimeoutMs: positiveInt(source.captureTimeoutMs, 60_000, 'captureTimeoutMs'),
    /** Tool groups to register; everything is on unless a group is set false. */
    groups: {
      core: groups.core !== false,
      find: groups.find !== false,
      ocr: groups.ocr !== false,
      record: groups.record !== false,
      system: groups.system !== false,
    },
    /** Individual tool names to skip. */
    disabledTools: disabled,
    /** Add the coordinate-convention section to the system prompt. */
    promptSection: bool(source.promptSection, true),
    /** Reserve the Host's exclusive `computerUse` provider slot for this plugin. */
    registerComputerUseSeam: bool(source.registerComputerUseSeam, false),
    /** Outline the rectangle a capture is about to take. */
    captureIndicator: bool(source.captureIndicator, true),
    /**
     * Ask Windows to hide the indicators from capture APIs so they can stay on
     * screen through the shutter. Off by default: on some display pipelines that
     * succeeds while also removing the window from what the monitor shows, which
     * would hide the warning from the person it is for.
     */
    indicatorCaptureExcluded: bool(source.indicatorCaptureExcluded, false),
    /** How long the frame is visible before the shutter, in milliseconds. */
    captureIndicatorLeadMs: nonNegativeInt(source.captureIndicatorLeadMs, 700, 'captureIndicatorLeadMs'),
    /**
     * How long the frame comes back for after the shutter, in milliseconds. This
     * is the readable half of the signal: it costs no time, because it happens
     * after the capture, so it can be generous.
     */
    captureIndicatorLingerMs: nonNegativeInt(source.captureIndicatorLingerMs, 1600, 'captureIndicatorLingerMs'),
    /** How long to wait after hiding the frame before capturing, when it cannot stay. */
    captureIndicatorSettleMs: nonNegativeInt(source.captureIndicatorSettleMs, 90, 'captureIndicatorSettleMs'),
    /** Show a floating badge naming the operation in progress. */
    inputIndicator: bool(source.inputIndicator, true),
    /**
     * How long the badge stays after the last operation, in milliseconds. It has
     * to be long enough to read the line, not merely to notice it.
     */
    inputIndicatorHoldMs: positiveInt(source.inputIndicatorHoldMs, 3500, 'inputIndicatorHoldMs'),
    /** How many operations the per-session list keeps. */
    activityLogLimit: positiveInt(source.activityLogLimit, 300, 'activityLogLimit'),
    /**
     * Live updates for the Settings page. 'off' (the default) keeps the sanctioned
     * arrangement: the page reads once and only when asked. 'local' additionally
     * runs a loopback-only stream, which is the only way to push without writing a
     * command row into the session. See lib/live-bridge.js for the security posture.
     */
    liveBridge: (() => {
      const value = source.liveBridge ?? 'off';
      if (!['off', 'local'].includes(value)) {
        throw new Error(`liveBridge must be off or local, got ${JSON.stringify(value)}`);
      }
      return value;
    })(),
    /** Port for the live bridge; 0 takes a free one. Always bound to 127.0.0.1. */
    liveBridgePort: nonNegativeInt(source.liveBridgePort, 0, 'liveBridgePort'),
    /** Fixed token for the live bridge; empty generates a random one per activation. */
    liveBridgeToken: String(source.liveBridgeToken ?? ''),
    /**
     * Loopback port for the Chrome DevTools protocol, which is what the browser_ tools drive.
     * Chromium opens this port only at launch, so a browser that is already running cannot be
     * attached to - browser_launch reports that rather than pretending otherwise.
     */
    browserDebugPort: positiveInt(source.browserDebugPort, 9222, 'browserDebugPort'),
    /** Browser executable for browser_launch; empty probes the usual Edge and Chrome paths. */
    browserPath: String(source.browserPath ?? ''),
    /**
     * Profile directory for the debugged browser. Empty means a dedicated one under the cache,
     * because current Chromium refuses to open the debugging port on the default profile.
     */
    browserUserDataDir: String(source.browserUserDataDir ?? ''),
    /** Where browser_downloads writes files. Empty means a directory under the cache. */
    browserDownloadDir: String(source.browserDownloadDir ?? ''),
    /** Mirror the operation list to operations.jsonl, so a restart keeps it. */
    activityLogToFile: bool(source.activityLogToFile, true),
    /**
     * Claim the machine's single set of on-screen indicators. Leave true: two
     * owners would draw two badges on the same spot. Only diagnostics turn it off.
     */
    indicatorClaimScreen: bool(source.indicatorClaimScreen, true),
    /** Language of the on-screen indicator text. */
    indicatorLanguage: (() => {
      const value = source.indicatorLanguage ?? 'auto';
      if (!['auto', 'zh', 'en'].includes(value)) {
        throw new Error(`indicatorLanguage must be auto, zh, or en, got ${JSON.stringify(value)}`);
      }
      return value;
    })(),
    /**
     * Palette of the on-screen indicators. `auto` follows the DSH theme, whose
     * `system` choice in turn follows the Windows app theme.
     */
    indicatorTheme: (() => {
      const value = source.indicatorTheme ?? 'auto';
      if (!['auto', 'light', 'dark'].includes(value)) {
        throw new Error(`indicatorTheme must be auto, light, or dark, got ${JSON.stringify(value)}`);
      }
      return value;
    })(),
  };
}
