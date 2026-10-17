// Screen-facing tools: layout inspection, capture, template/colour search, OCR.
import { attachCapture } from '../artifacts.js';
import { clampToVirtual, invalidateScreenInfo, resolveArea, resolveSearchArea, screenInfo } from '../geometry.js';
import { defineTool, intOr, json, required, text, textAndImage } from '../toolkit.js';

const TARGETS = ['full', 'primary', 'monitor', 'region', 'window', 'foreground'];

/** Parse `#RRGGBB`, `RRGGBB`, `#RGB`, or `rgb(r,g,b)` into channel values. */
function parseColor(input) {
  const raw = String(input).trim();
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(raw);
  if (rgbMatch) return { r: Number(rgbMatch[1]), g: Number(rgbMatch[2]), b: Number(rgbMatch[3]) };
  const hex = raw.replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16) };
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
  }
  throw new Error(`color must look like "#RRGGBB", "RRGGBB", "#RGB", or "rgb(r,g,b)"; got ${JSON.stringify(input)}`);
}

function describeMapping(area, result) {
  const scale = result.scaleToScreen ?? 1;
  return [
    `image pixel = (screen pixel - (${area.x},${area.y})) / ${scale}`,
    `screen pixel = image pixel * ${scale} + (${area.x},${area.y})`,
    `so clicking the image point (ix,iy) means x=${Math.round(area.x)} + ix*${scale}, y=${Math.round(area.y)} + iy*${scale}`,
  ].join('; ');
}

export function screenTools(runtime) {
  const { bridge, cfg, ctx } = runtime;

  const info = defineTool({
    name: 'screen_info',
    description:
      'Report the desktop layout and current focus: every monitor with its physical bounds, work area and DPI scale, the virtual desktop rectangle, the mouse position, and the foreground window. All coordinates in this plugin are physical pixels of the virtual desktop, whose origin is the primary monitor\'s top-left; monitors placed left of or above it have negative coordinates. Call this before clicking so coordinates come from real geometry rather than assumption.',
    parameters: {},
    output: {
      schema: { type: 'object' },
      render: (_args, value) => json(value),
    },
    async execute(_args, exec) {
      const snapshot = await screenInfo(runtime, { fresh: true });
      const windows = await bridge.call('window.list', { visibleOnly: true }, { timeoutMs: cfg.helperTimeoutMs });
      return {
        dpiMode: snapshot.dpiMode,
        virtualScreen: snapshot.virtualScreen,
        monitors: snapshot.monitors,
        cursor: snapshot.cursor,
        foreground: snapshot.foreground,
        foregroundVisible: true,
        windowCount: (windows.windows ?? []).length,
        note: 'Coordinates are physical virtual-desktop pixels. On this machine the primary monitor is scaled, so a screenshot returns an image smaller than the screen rectangle; screen_capture reports the exact screen-to-image factor.',
      };
    },
    presentCall: () => ({ card: 'generic', title: 'Inspect display layout', kind: 'read' }),
  });

  const capture = defineTool({
    name: 'screen_capture',
    description:
      'Capture pixels and return the image plus the file path it was written to. Targets: "full" (the whole virtual desktop, all monitors), "primary", "monitor" (with `monitor`, a zero-based index from screen_info), "region" (with `region`), "foreground" (the topmost window), or "window" (with `window`, an hwnd like "0x1A2B" or a regular expression matched against the title). A window is captured through PrintWindow, so it is captured even when another window covers it; a minimized window must be restored first. The result states the screen-to-image mapping so a coordinate read off the image can be converted back into a click position.',
    parameters: {
      target: { type: 'string', enum: TARGETS, description: 'What to capture. Defaults to "full".' },
      monitor: { type: 'integer', description: 'Zero-based monitor index, required when target is "monitor".' },
      window: { type: 'string', description: 'Window selector (hwnd like "0x1A2B", or a case-insensitive regular expression over the title), required when target is "window".' },
      region: {
        type: 'object',
        description: 'Screen rectangle in physical pixels, required when target is "region".',
        properties: {
          x: { type: 'integer', required: true, description: 'Left edge.' },
          y: { type: 'integer', required: true, description: 'Top edge.' },
          width: { type: 'integer', required: true, description: 'Width in pixels.' },
          height: { type: 'integer', required: true, description: 'Height in pixels.' },
        },
      },
      maxDim: { type: 'integer', description: `Longest edge of the produced image; larger captures are downscaled proportionally. 0 keeps native resolution. Defaults to ${cfg.maxImageDim}.` },
      format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format. PNG is lossless and best for reading text; JPEG is smaller. Defaults to png.' },
      quality: { type: 'integer', description: `JPEG quality, 1-100. Defaults to ${cfg.jpegQuality}.` },
      attach: { type: 'boolean', description: 'Attach the image to this tool result so it can be seen. Defaults to true; the file is written either way.' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const lines = [
          `Captured ${value.target} at (${value.originX},${value.originY}) ${value.screenWidth}x${value.screenHeight} px -> image ${value.width}x${value.height} px (${Math.round(value.bytes / 1024)} KiB ${value.format}).`,
          `File: ${value.path}`,
          `Mapping: ${value.mapping}`,
        ];
        if (value.attachmentError) lines.push(`The image was not attached: ${value.attachmentError}`);
        else if (value.attachment) lines.push('The image is attached to this result.');
        return textAndImage(lines.join('\n'), value.attachment);
      },
    },
    async execute(args, exec) {
      const snapshot = await screenInfo(runtime);
      const area = clampToVirtual(await resolveArea(runtime, args), snapshot);
      const maxDim = intOr(args.maxDim, cfg.maxImageDim, { min: 0, name: 'maxDim' });
      const format = args.format === 'jpeg' ? 'jpeg' : 'png';
      const quality = intOr(args.quality, cfg.jpegQuality, { min: 1, max: 100, name: 'quality' });
      const outPath = await runtime.artifacts.nextPath(exec.agent?.id, 'capture', format);
      const spec = {
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height,
        hwnd: area.hwnd ?? '',
        maxDim,
        scale: 0,
        format,
        quality,
        out: outPath,
      };
      const options = { timeoutMs: cfg.captureTimeoutMs, signal: exec.signal };
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      // Tell the person what is about to be captured. The frame must never end up
      // inside the image, so it either stays up only because the OS excludes it
      // from capture APIs, or it is taken down before the shutter.
      const indicator = runtime.indicator;
      const wanted = cfg.captureIndicator === true || cfg.inputIndicator === true;
      const status = wanted ? await indicator.ensure() : { available: false, captureExcluded: false };
      const excluded = status.captureExcluded === true;

      let result;
      let indicatorMode = 'off';
      let badgeWasUp = false;
      try {
        if (cfg.captureIndicator === true && status.available) {
          const label = indicator.text.captureFrame(area.label, `${area.width}x${area.height}`);
          // Phase 1: outline the region and let the person read that it is about
          // to be captured.
          await indicator.frameOn(area, label, 0);
          await delay(cfg.captureIndicatorLeadMs);
          if (excluded) {
            // The OS keeps the frame out of the image, so it can stay up.
            await indicator.concealBadge();
            try {
              result = await bridge.call('screen.capture', spec, options);
            } finally {
              await delay(cfg.captureIndicatorLingerMs);
              await indicator.frameOff();
              await indicator.restoreBadge(true);
            }
            indicatorMode = 'during';
          } else {
            // Take the indicator down for the shutter, then bring it back: the
            // lingering half is free, so the label gets the time it needs to be
            // read without slowing any capture down.
            await indicator.frameOff();
            await delay(cfg.captureIndicatorSettleMs);
            badgeWasUp = await indicator.concealBadge();
            try {
              result = await bridge.call('screen.capture', spec, options);
            } finally {
              await indicator.restoreBadge(badgeWasUp);
              await indicator.frameOn(area, label, 0);
              await delay(cfg.captureIndicatorLingerMs);
              await indicator.frameOff();
            }
            indicatorMode = 'before';
          }
        } else {
          badgeWasUp = await indicator.concealBadge();
          result = await bridge.call('screen.capture', spec, options);
        }
      } finally {
        await indicator.frameOff();
        if (badgeWasUp) await indicator.restoreBadge(true);
      }
      invalidateScreenInfo(runtime);
      let attachment;
      let attachmentError;
      if (args.attach === false) attachmentError = 'attach was set to false';
      else {
        const attached = await attachCapture(ctx, exec, cfg, { path: result.path, format, width: result.width, height: result.height });
        attachment = attached.attachment;
        attachmentError = attached.skipped;
      }
      return {
        path: result.path,
        target: area.label,
        originX: result.originX,
        originY: result.originY,
        screenWidth: result.screenWidth,
        screenHeight: result.screenHeight,
        width: result.width,
        height: result.height,
        scaleToScreen: result.scaleToScreen,
        bytes: result.bytes,
        format: result.format,
        source: result.source,
        mapping: describeMapping(area, result),
        indicator: { shown: indicatorMode !== 'off', mode: indicatorMode, excludedFromCapture: excluded },
        ...(attachment ? { attachment } : {}),
        ...(attachmentError ? { attachmentError } : {}),
      };
    },
    presentCall: (args) => ({ card: 'generic', title: `Capture ${args.target ?? 'full'}`, kind: 'read' }),
  });

  const findImage = defineTool({
    name: 'find_image',
    description:
      'Locate a template image on screen and return the screen coordinates of every match, so a button can be clicked by appearance instead of by guesswork. Pass `template` as an absolute path to a PNG/JPEG crop. The search covers `region`, else `window`, else the foreground window; set `fullScreen` to search the whole desktop. Matching is grayscale, runs coarse-to-fine, and reports a score per match: 1 means every pixel matched within `tolerance`. Set `waitMs` to keep polling until the template appears.',
    parameters: {
      template: { type: 'string', required: true, description: 'Absolute path to the template image file.' },
      region: {
        type: 'object',
        description: 'Screen rectangle to search, in physical pixels. Defaults to the foreground window.',
        properties: {
          x: { type: 'integer', required: true },
          y: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
        },
      },
      window: { type: 'string', description: 'Search only this window (hwnd or title expression).' },
      fullScreen: { type: 'boolean', description: 'Search the entire virtual desktop instead of the foreground window.' },
      threshold: { type: 'number', description: 'Minimum score to report, 0-1. Defaults to 0.85; lower it for slightly changed content.' },
      tolerance: { type: 'integer', description: 'Per-pixel grayscale difference still counted as a match, 0-255. Defaults to 24.' },
      maxResults: { type: 'integer', description: 'Maximum matches to return. Defaults to 5.' },
      waitMs: { type: 'integer', description: 'Keep searching until a match appears or this many milliseconds elapse. Defaults to 0 (search once).' },
      pollMs: { type: 'integer', description: 'Delay between polls when waitMs is set. Defaults to 250.' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        if (!value.found) {
          return text(`No match for ${value.template} in ${value.region.label} after ${value.elapsedMs} ms (threshold ${value.threshold}).`);
        }
        const lines = [`Found ${value.matches.length} match(es) for ${value.template} in ${value.region.label} after ${value.elapsedMs} ms:`];
        for (const match of value.matches) {
          lines.push(`  score ${match.score} - top-left (${match.x},${match.y}), centre (${match.centerX},${match.centerY})`);
        }
        lines.push(`Click the centre with mouse_control {action:"click", x:${value.matches[0].centerX}, y:${value.matches[0].centerY}}.`);
        return text(lines.join('\n'));
      },
    },
    async execute(args, exec) {
      required(args.template, 'template');
      const area = await resolveSearchArea(runtime, args, 'foreground');
      const threshold = typeof args.threshold === 'number' ? args.threshold : 0.85;
      const tolerance = intOr(args.tolerance, 24, { min: 0, max: 255, name: 'tolerance' });
      const maxResults = intOr(args.maxResults, 5, { min: 1, max: 50, name: 'maxResults' });
      const waitMs = intOr(args.waitMs, 0, { min: 0, max: 600_000, name: 'waitMs' });
      const pollMs = intOr(args.pollMs, 250, { min: 20, max: 5000, name: 'pollMs' });
      const started = Date.now();
      let result;
      // The search reads screen pixels, so an indicator left over from a recent
      // input action must not become part of the haystack.
      const badgeWasUp = await runtime.indicator.concealBadge();
      try {
        for (;;) {
          result = await bridge.call(
            'screen.findImage',
            { template: args.template, x: area.x, y: area.y, width: area.width, height: area.height, threshold, tolerance, maxResults, step: 1 },
            { timeoutMs: cfg.captureTimeoutMs, signal: exec.signal },
          );
          if (result.found || Date.now() - started >= waitMs) break;
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      } finally {
        await runtime.indicator.restoreBadge(badgeWasUp);
      }
      return {
        found: result.found === true,
        template: args.template,
        matches: result.matches ?? [],
        templateWidth: result.templateWidth,
        templateHeight: result.templateHeight,
        region: { label: area.label, x: area.x, y: area.y, width: area.width, height: area.height },
        threshold,
        tolerance,
        elapsedMs: Date.now() - started,
      };
    },
    presentCall: (args) => ({ card: 'generic', title: `Find image ${String(args.template).split(/[\\/]/).pop()}`, kind: 'search' }),
  });

  const findColor = defineTool({
    name: 'find_color',
    description:
      'Find pixels of a given colour, or read the colour at one point. With `color` set, scans the search area and returns the first matches with their screen coordinates plus the total count. Without `color`, returns the colour at `at` (or at the region\'s top-left corner) - use that to sample a pixel before searching for it. This is the cheap way to detect a state change: wait for a status light to turn green instead of re-reading the screen.',
    parameters: {
      color: { type: 'string', description: 'Target colour: "#RRGGBB", "RRGGBB", "#RGB", or "rgb(r,g,b)". Omit to read a single pixel instead.' },
      at: {
        type: 'object',
        description: 'Point to sample when `color` is omitted.',
        properties: { x: { type: 'integer', required: true }, y: { type: 'integer', required: true } },
      },
      region: {
        type: 'object',
        description: 'Rectangle to scan. Defaults to the foreground window.',
        properties: {
          x: { type: 'integer', required: true },
          y: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
        },
      },
      window: { type: 'string', description: 'Scan only this window (hwnd or title expression).' },
      fullScreen: { type: 'boolean', description: 'Scan the entire virtual desktop.' },
      tolerance: { type: 'integer', description: 'Per-channel tolerance, 0-255. Defaults to 16.' },
      step: { type: 'integer', description: 'Sample every Nth pixel on both axes; raise it to scan faster at the cost of precision. Defaults to 1.' },
      maxResults: { type: 'integer', description: 'Maximum matches returned. Defaults to 20.' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        if (value.mode === 'pixel') return text(`Pixel (${value.x},${value.y}) is ${value.hex} (r=${value.r}, g=${value.g}, b=${value.b}).`);
        if (!value.found) return text(`No pixel within tolerance ${value.tolerance} of ${value.target} in ${value.region.label}.`);
        const lines = [`${value.count} pixel(s) match ${value.target} (tolerance ${value.tolerance}) in ${value.region.label}; first ${value.matches.length}:`];
        for (const match of value.matches) lines.push(`  (${match.x},${match.y}) ${match.hex}`);
        return text(lines.join('\n'));
      },
    },
    async execute(args, exec) {
      if (args.color === undefined || args.color === null || String(args.color).trim().length === 0) {
        const point = args.at ?? args.region;
        if (!point || point.x === undefined || point.y === undefined) {
          throw new Error('either color or at {x,y} is required');
        }
        const pixel = await bridge.call('screen.pixel', { x: Math.round(point.x), y: Math.round(point.y) }, { timeoutMs: cfg.helperTimeoutMs, signal: exec.signal });
        return { mode: 'pixel', ...pixel };
      }
      const target = parseColor(args.color);
      const area = await resolveSearchArea(runtime, args, 'foreground');
      const tolerance = intOr(args.tolerance, 16, { min: 0, max: 255, name: 'tolerance' });
      const step = intOr(args.step, 1, { min: 1, max: 500, name: 'step' });
      const maxResults = intOr(args.maxResults, 20, { min: 1, max: 500, name: 'maxResults' });
      const result = await bridge.call(
        'screen.findColor',
        { x: area.x, y: area.y, width: area.width, height: area.height, r: target.r, g: target.g, b: target.b, tolerance, step, maxResults },
        { timeoutMs: cfg.captureTimeoutMs, signal: exec.signal },
      );
      return {
        mode: 'search',
        found: result.found === true,
        count: result.count ?? 0,
        target: result.target,
        tolerance,
        matches: (result.matches ?? []).map((m) => ({ ...m, hex: `#${[m.r, m.g, m.b].map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}` })),
        region: { label: area.label, x: area.x, y: area.y, width: area.width, height: area.height },
      };
    },
    presentCall: (args) => ({ card: 'generic', title: args.color ? `Find colour ${args.color}` : 'Sample pixel', kind: 'search' }),
  });

  const ocr = defineTool({
    name: 'ocr_screen',
    description:
      'Read the text on screen with the built-in Windows OCR engine, returning the full text plus every line with its screen coordinates. Use it to find where a label or button caption is before clicking, especially when the exact wording is unknown. Pass `query` to also get the best matching lines ranked by similarity, which turns "find the Save button" into coordinates. Recognition runs at native resolution; accuracy on small or stylised text is limited, and the installed language packs decide which scripts work.',
    parameters: {
      region: {
        type: 'object',
        description: 'Rectangle to read. Defaults to the foreground window.',
        properties: {
          x: { type: 'integer', required: true },
          y: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
        },
      },
      window: { type: 'string', description: 'Read only this window (hwnd or title expression).' },
      fullScreen: { type: 'boolean', description: 'Read the entire virtual desktop.' },
      query: { type: 'string', description: 'Optional text to locate; matching lines are ranked and returned with coordinates.' },
      includeWords: { type: 'boolean', description: 'Include per-word boxes in the result. Defaults to false because it is verbose.' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        if (value.matches && value.matches.length > 0) {
          const lines = [`Best matches for ${JSON.stringify(value.query)} in ${value.region.label}:`];
          for (const match of value.matches) {
            lines.push(`  "${match.text}" at centre (${match.centerX},${match.centerY}) box ${match.width}x${match.height} score ${match.score}`);
          }
          lines.push(`Click it with mouse_control {action:"click", x:${value.matches[0].centerX}, y:${value.matches[0].centerY}}.`);
          return text(lines.join('\n'));
        }
        if (value.lines.length === 0) return text(`No text was recognised in ${value.region.label} (languages: ${value.languages.join(', ') || 'none'}).`);
        const body = value.lines.map((line) => `  [${line.centerX},${line.centerY}] ${line.text}`).join('\n');
        return text(`Recognised ${value.lines.length} line(s) in ${value.region.label} (languages: ${value.languages.join(', ')}):\n${body}`);
      },
    },
    async execute(args, exec) {
      const status = await bridge.call('ocr.status', {}, { timeoutMs: cfg.helperTimeoutMs });
      if (status.available !== true) throw new Error(`OCR is unavailable on this machine: ${status.reason}`);
      const area = await resolveSearchArea(runtime, args, 'foreground');
      const outPath = await runtime.artifacts.nextPath(exec.agent?.id, 'ocr', 'png');
      // OCR reads pixels the model will act on, so keep the input badge out of the
      // shot when this Windows build cannot exclude it from captures.
      const badgeWasUp = await runtime.indicator.concealBadge();
      let shot;
      try {
        shot = await bridge.call(
          'screen.capture',
          { x: area.x, y: area.y, width: area.width, height: area.height, hwnd: area.hwnd ?? '', maxDim: 0, scale: 0, format: 'png', quality: 90, out: outPath },
          { timeoutMs: cfg.captureTimeoutMs, signal: exec.signal },
        );
      } finally {
        await runtime.indicator.restoreBadge(badgeWasUp);
      }
      const result = await bridge.call(
        'ocr.image',
        { path: shot.path, originX: shot.originX, originY: shot.originY, scaleToScreen: shot.scaleToScreen },
        { timeoutMs: cfg.captureTimeoutMs, signal: exec.signal },
      );
      const lines = result.lines ?? [];
      const visible = args.includeWords === true ? lines : lines.map((line) => ({ text: line.text, x: line.x, y: line.y, width: line.width, height: line.height, centerX: line.centerX, centerY: line.centerY }));
      const query = args.query === undefined || args.query === null ? null : String(args.query).trim();
      let matches;
      if (query) {
        const needle = query.toLowerCase();
        matches = lines
          .map((line) => {
            const haystack = line.text.toLowerCase();
            let score = haystack === needle ? 1 : haystack.includes(needle) ? 0.9 : 0;
            if (score === 0) {
              const needleChars = new Set(needle.replace(/\s+/g, ''));
              const hayChars = new Set(haystack.replace(/\s+/g, ''));
              let shared = 0;
              for (const ch of needleChars) if (hayChars.has(ch)) shared += 1;
              score = needleChars.size === 0 ? 0 : (shared / needleChars.size) * 0.7;
            }
            return { text: line.text, centerX: line.centerX, centerY: line.centerY, width: line.width, height: line.height, score: Number(score.toFixed(3)) };
          })
          .filter((entry) => entry.score >= 0.6)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);
      }
      return {
        region: { label: area.label, x: area.x, y: area.y, width: area.width, height: area.height },
        languages: result.languages ?? [],
        text: result.text ?? '',
        lines: visible,
        lineCount: lines.length,
        ...(query ? { query, matches: matches ?? [] } : {}),
      };
    },
    presentCall: (args) => ({ card: 'generic', title: args.query ? `Find text ${JSON.stringify(args.query)}` : 'Read screen text', kind: 'search' }),
  });

  return [info, capture, findImage, findColor, ocr];
}
