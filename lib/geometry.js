// Geometry resolution shared by the screen, find, and OCR tools.
// Every coordinate in this plugin is a physical pixel on the virtual desktop,
// with the primary monitor's top-left at (0,0) and monitors to its left or
// above carrying negative coordinates.

const INFO_TTL_MS = 2000;

/** Screen facts, cached briefly so a multi-step action does not re-query per call. */
export async function screenInfo(runtime, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && runtime.infoCache && now - runtime.infoCache.at < INFO_TTL_MS) return runtime.infoCache.value;
  const value = await runtime.bridge.call('screen.info', {}, { timeoutMs: runtime.cfg.helperTimeoutMs });
  runtime.infoCache = { at: now, value };
  return value;
}

export function invalidateScreenInfo(runtime) {
  runtime.infoCache = undefined;
}

/** Every top-level window the helper can see. */
export async function listWindows(runtime, { visibleOnly = true } = {}) {
  const result = await runtime.bridge.call('window.list', { visibleOnly }, { timeoutMs: runtime.cfg.helperTimeoutMs });
  return result.windows ?? [];
}

/** Canonical form of a window handle: lowercase `0x` prefix, uppercase hex digits. */
export function hwndKey(value) {
  const text = String(value).trim();
  try {
    if (/^0x[0-9a-f]+$/i.test(text)) return `0x${BigInt(text).toString(16).toUpperCase()}`;
    if (/^\d+$/.test(text)) return `0x${BigInt(text).toString(16).toUpperCase()}`;
  } catch {
    /* fall through to the raw comparison below */
  }
  return text.toUpperCase();
}

/**
 * Resolve a window selector: an exact `hwnd` (`0x1A2B`), a case-insensitive
 * regular expression over the title, or nothing for the foreground window.
 */
export async function findWindow(runtime, selector) {
  if (selector === undefined || selector === null || String(selector).trim().length === 0) {
    return runtime.bridge.call('window.foreground', {}, { timeoutMs: runtime.cfg.helperTimeoutMs });
  }
  const wanted = String(selector).trim();
  const windows = await listWindows(runtime, { visibleOnly: true });
  if (/^(0x[0-9a-f]+|\d+)$/i.test(wanted)) {
    const key = hwndKey(wanted);
    const hit = windows.find((w) => hwndKey(w.hwnd) === key);
    if (hit) return hit;
    throw new Error(`no open window has handle ${wanted} (${windows.length} windows are visible); it may have closed - list them with window_list`);
  }
  let pattern;
  try {
    pattern = new RegExp(wanted, 'i');
  } catch {
    pattern = new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
  const matches = windows.filter((w) => pattern.test(w.title ?? '') || pattern.test(w.process ?? ''));
  if (matches.length === 0) throw new Error(`no open window matches "${wanted}" (${windows.length} windows are visible)`);
  return matches[0];
}

/** The area a capture or a search should cover. */
export async function resolveArea(runtime, args) {
  const target = args.target ?? args.area ?? 'full';
  const info = await screenInfo(runtime);
  const vs = info.virtualScreen;
  if (target === 'full' || target === 'screen' || target === 'desktop') {
    return { x: vs.x, y: vs.y, width: vs.width, height: vs.height, label: `virtual desktop ${vs.width}x${vs.height} at (${vs.x},${vs.y})` };
  }
  if (target === 'primary') {
    const monitor = info.monitors.find((m) => m.primary) ?? info.monitors[0];
    if (!monitor) throw new Error('no monitor was reported by the system');
    return { x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height, label: `primary monitor (${monitor.device})` };
  }
  if (target === 'monitor') {
    const index = args.monitor ?? 0;
    if (!Number.isInteger(index) || index < 0) throw new Error(`monitor must be a non-negative integer, got ${JSON.stringify(args.monitor)}`);
    const monitor = info.monitors[index];
    if (!monitor) throw new Error(`monitor ${index} does not exist; this machine reports ${info.monitors.length} monitor(s): ${info.monitors.map((m) => `${m.index}=${m.width}x${m.height}@${m.x},${m.y}`).join(', ')}`);
    return { x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height, label: `monitor ${index} (${monitor.device})` };
  }
  if (target === 'region') {
    const region = args.region;
    if (!region || typeof region !== 'object') throw new Error('region is required when target is "region"');
    const x = Math.round(region.x ?? 0);
    const y = Math.round(region.y ?? 0);
    const width = Math.round(region.width ?? region.w ?? 0);
    const height = Math.round(region.height ?? region.h ?? 0);
    if (width <= 0 || height <= 0) throw new Error(`region needs a positive width and height, got ${width}x${height}`);
    return { x, y, width, height, label: `region ${width}x${height} at (${x},${y})` };
  }
  if (target === 'foreground' || target === 'window') {
    const win = target === 'foreground'
      ? await runtime.bridge.call('window.foreground', {}, { timeoutMs: runtime.cfg.helperTimeoutMs })
      : await findWindow(runtime, args.window);
    if (!win || !win.hwnd) throw new Error(target === 'foreground' ? 'no window currently has the foreground' : 'the window selector did not resolve to a window');
    if (win.width <= 0 || win.height <= 0) throw new Error(`window "${win.title}" reports an empty rectangle (${win.width}x${win.height})`);
    if (win.minimized === true) {
      throw new Error(`window "${win.title}" (${win.hwnd}) is minimized, so it has no on-screen rectangle; run window_control {action:"restore", window:"${win.hwnd}"} first, then capture`);
    }
    return { x: win.x, y: win.y, width: win.width, height: win.height, hwnd: win.hwnd, label: `window "${win.title}" (${win.hwnd})`, window: win };
  }
  throw new Error(`unknown target "${target}"; use full, primary, monitor, region, window, or foreground`);
}

/**
 * The area a find or OCR search should cover: an explicit region, a named
 * window, or the whole virtual desktop. Defaults to the foreground window
 * because searching 2560x1600 for a button is both slower and noisier.
 */
export async function resolveSearchArea(runtime, args, fallback = 'foreground') {
  if (args.region && typeof args.region === 'object') {
    const x = Math.round(args.region.x ?? 0);
    const y = Math.round(args.region.y ?? 0);
    const width = Math.round(args.region.width ?? args.region.w ?? 0);
    const height = Math.round(args.region.height ?? args.region.h ?? 0);
    if (width <= 0 || height <= 0) throw new Error(`region needs a positive width and height, got ${width}x${height}`);
    return { x, y, width, height, label: `region ${width}x${height} at (${x},${y})` };
  }
  if (args.window !== undefined && args.window !== null && String(args.window).length > 0) {
    const win = await findWindow(runtime, args.window);
    if (!win || win.width <= 0 || win.height <= 0 || win.minimized === true) {
      throw new Error(`window "${args.window}" is minimized or has no on-screen rectangle, so it cannot be searched`);
    }
    return { x: win.x, y: win.y, width: win.width, height: win.height, hwnd: win.hwnd, label: `window "${win.title}"`, window: win };
  }
  if (args.fullScreen === true || fallback === 'full') {
    return resolveArea(runtime, { target: 'full' });
  }
  const fg = await runtime.bridge.call('window.foreground', {}, { timeoutMs: runtime.cfg.helperTimeoutMs });
  if (fg && fg.hwnd && fg.width > 0 && fg.height > 0) {
    return { x: fg.x, y: fg.y, width: fg.width, height: fg.height, hwnd: fg.hwnd, label: `foreground window "${fg.title}"`, window: fg };
  }
  return resolveArea(runtime, { target: 'full' });
}

/** Clamp an area to the virtual desktop so a bad rectangle cannot make BitBlt fail. */
export function clampToVirtual(area, info) {
  const vs = info.virtualScreen;
  const left = Math.max(area.x, vs.x);
  const top = Math.max(area.y, vs.y);
  const right = Math.min(area.x + area.width, vs.x + vs.width);
  const bottom = Math.min(area.y + area.height, vs.y + vs.height);
  if (right <= left || bottom <= top) {
    throw new Error(`the requested area (${area.x},${area.y} ${area.width}x${area.height}) lies outside the virtual desktop ${vs.width}x${vs.height} at (${vs.x},${vs.y})`);
  }
  return { ...area, x: left, y: top, width: right - left, height: bottom - top };
}
