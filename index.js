// DeepSeek Harness plugin: drive the local Windows desktop.
//
// Registers tools for screen inspection and capture, template and colour
// search, OCR, mouse and keyboard injection, window and application control,
// clipboard access, timed waits, input recording/replay, system actions, and the
// operation list of everything the session has done. All of it is backed by one
// resident PowerShell helper process that compiles a C# P/Invoke layer once and
// then answers JSON requests (see native/agent.ps1).
import { ActivityLog } from './lib/activity.js';
import { Artifacts } from './lib/artifacts.js';
import { NativeBridge } from './lib/bridge.js';
import { activityCommandDefinition } from './lib/command.js';
import { normalizeConfig } from './lib/config.js';
import { Indicator } from './lib/indicator.js';
import { LiveBridge } from './lib/live-bridge.js';
import { activityTools } from './lib/tools/activity.js';
import { browserTools } from './lib/tools/browser.js';
import { inputTools } from './lib/tools/input.js';
import { miscTools } from './lib/tools/misc.js';
import { screenTools } from './lib/tools/screen.js';
import { windowTools } from './lib/tools/window.js';

export const name = 'computer-control';

/** The tool registry is mandatory; every other service is optional and probed lazily. */
export const inject = ['tools'];

/** Which configurable group each tool belongs to. */
const GROUP_OF = {
  screen_info: 'core',
  screen_capture: 'core',
  mouse_control: 'core',
  keyboard_control: 'core',
  clipboard_control: 'core',
  window_list: 'core',
  window_control: 'core',
  app_control: 'core',
  wait_for: 'core',
  computer_activity: 'core',
  find_image: 'find',
  find_color: 'find',
  ocr_screen: 'ocr',
  input_record: 'record',
  system_control: 'system',
  // The browser tools are their own group, so a profile that does not want a debugging
  // endpoint opened can switch all four off with one setting instead of four.
  browser_launch: 'browser',
  browser_tabs: 'browser',
  browser_read: 'browser',
  browser_eval: 'browser',
  browser_screenshot: 'browser',
  browser_command: 'browser',
  browser_click: 'browser',
  browser_fill: 'browser',
  browser_wait: 'browser',
  browser_downloads: 'browser',
};

/**
 * Wrap one tool so every call is announced on screen and written to the session's
 * operation list. Doing it in one place is what keeps the two surfaces honest:
 * a capture is announced and recorded exactly like a click, with no per-tool
 * code to forget.
 */
function instrument(definition, runtime) {
  const run = definition.execute;
  return {
    ...definition,
    async execute(args, exec) {
      const notice = runtime.activity.notice(definition.name, args);
      if (notice.length > 0) await runtime.indicator.badge(notice);
      const entry = runtime.activity.begin(definition.name, args, exec);
      // Tell a live reader at once, so a long operation shows as running instead of
      // appearing only after it is over.
      runtime.live.notify(exec?.agent?.id);
      try {
        const value = await run(args, exec);
        if (value !== null && typeof value === 'object' && value.dryRun === true) entry.finish('dry-run');
        else entry.finish('ok');
        runtime.live.notify(exec?.agent?.id);
        return value;
      } catch (error) {
        const message = error?.message ?? String(error);
        const outcome = /allowRisky/.test(message) ? 'refused'
          : error?.name === 'AbortError' || error?.code === 'ABORTED' ? 'aborted'
            : 'failed';
        entry.finish(outcome, message);
        runtime.live.notify(exec?.agent?.id);
        throw error;
      }
    },
  };
}

const PROMPT_SECTION = [
  'This machine can be driven directly. Coordinates are physical pixels of the virtual desktop:',
  "the primary monitor's top-left is (0,0), and monitors to its left or above it have negative coordinates.",
  'Call screen_info before the first click so the layout, the DPI scale and the focused window are known facts.',
  'Call screen_capture to see the screen; its result states the mapping between screen pixels and image pixels,',
  'so convert any coordinate read off the image before passing it to mouse_control.',
  'Clicks and keystrokes go to the focused window: focus the target with window_control, and confirm with screen_info,',
  'before typing. Prefer find_image or ocr_screen over guessing a coordinate, and prefer wait_for over a fixed sleep.',
  'Every capture and every input action is shown on screen to the person at the machine, and recorded:',
  'call computer_activity to review what this session has already done before repeating a step or reporting results.',
].join(' ');

/**
 * Register every configured tool group and the optional prompt section.
 * @param ctx - the plugin's Cordis context.
 * @param rawConfig - the loader row's `config`, normalized and validated here.
 */
export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig);
  const bridge = new NativeBridge({ logger: ctx.logger });
  const runtime = {
    ctx,
    cfg,
    bridge,
    artifacts: new Artifacts(cfg.artifactDir),
    indicator: null,
    activity: null,
    infoCache: undefined,
  };
  runtime.indicator = new Indicator(runtime);
  runtime.activity = new ActivityLog(runtime);
  runtime.live = new LiveBridge(runtime);

  // The helper is a child process; it must not outlive the plugin.
  ctx.effect(() => () => {
    runtime.indicator.dispose();
    runtime.live.stop();
    bridge.dispose();
  });

  // Off unless configured: see lib/live-bridge.js.
  void runtime.live.start();

  const definitions = [
    ...screenTools(runtime),
    ...inputTools(runtime),
    ...windowTools(runtime),
    ...browserTools(runtime),
    ...miscTools(runtime),
    ...activityTools(runtime),
  ];
  const registered = [];
  const skipped = [];
  for (const definition of definitions) {
    const group = GROUP_OF[definition.name] ?? 'core';
    if (cfg.groups[group] === false) {
      skipped.push(`${definition.name} (group "${group}" is disabled)`);
      continue;
    }
    if (cfg.disabledTools.includes(definition.name)) {
      skipped.push(`${definition.name} (named in disabledTools)`);
      continue;
    }
    ctx.tools.register(instrument(definition, runtime));
    registered.push(definition.name);
  }

  ctx.logger?.info?.(
    `computer-control: ${registered.length} tool(s) registered (${registered.join(', ')}); dryRun=${cfg.dryRun} allowRisky=${cfg.allowRisky} attachImages=${cfg.attachImages} artifacts=${cfg.artifactDir}`,
  );
  if (skipped.length > 0) ctx.logger?.info?.(`computer-control: skipped ${skipped.join('; ')}`);

  if (cfg.promptSection !== false) {
    ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.section({
        name: 'tool:computer-control',
        order: scope.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
        text: PROMPT_SECTION,
      });
    });
  }

  // The Settings page reaches the operation list through this command, because a
  // Client can only call back into the Host through a registered entry point. A
  // person can type the same command in the composer, and it answers from the same
  // table as the `computer_activity` tool.
  const commands = ctx.get('commands');
  if (commands?.register) {
    ctx.effect(() => commands.register(activityCommandDefinition(runtime)));
  } else {
    ctx.logger?.debug?.('computer-control: no command registry; /computer-activity is unavailable to the UI');
  }

  // The Host reserves one exclusive `computerUse` provider slot. Claiming it is
  // deliberate and off by default: a shipped experimental provider would
  // otherwise be locked out of its own slot.
  if (cfg.registerComputerUseSeam === true) {
    ctx.inject(['computerUse'], (scope) => {
      scope.effect(() => {
        let release;
        let disposed = false;
        const reserved = scope.computerUse
          .register('computer-control')
          .then((disposer) => {
            release = disposer;
            if (disposed) return disposer();
            return undefined;
          })
          .catch((error) => {
            ctx.logger?.warn?.(`computer-control: could not reserve the computerUse provider slot: ${error.message}`);
          });
        return async () => {
          disposed = true;
          await reserved;
          if (release !== undefined) await release();
        };
      });
    });
  }
}
