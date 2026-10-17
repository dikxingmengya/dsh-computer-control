// Client half: a page inside Settings -> Plugins that shows the operation list.
//
// It reads through `/computer-activity --json`, the same Host command a person can
// type in the composer, which itself answers from the same table as the
// `computer_activity` tool. One implementation, three callers, no drift.
//
// Hand-written plain JavaScript on purpose: the module table supplies React, so
// this file needs no build step. It is a lazy factory whose id is the package
// name, registered into `settings.plugins.tab`.
//
// Every visible string comes from the Client locale service, so the page follows
// the same language setting as the rest of the shell and re-renders when it
// changes. The browser's own language preference is deliberately not consulted:
// the shell owns that decision.
window.__ModuleLoader__.load({
  id: '@local/dsh-computer-control',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'dsh-computer-control';
    /** The page's kind in the right column's tab system; a page type names no globs. */
    const TAB_KIND = 'computer-control';

    const zh = {
      panel: '操作记录',
      title: '电脑控制 · 操作记录',
      refresh: '刷新',
      loading: '读取中…',
      empty: '本次会话还没有任何操作记录。',
      noSession: '还没有打开任何会话，所以没有可显示的操作记录。',
      failed: '读取失败',
      all: '全部',
      clearFilter: '清除',
      autoScroll: '自动滚动',
      liveAuto: '自动更新',
      liveOn: '开启自动更新',
      liveOff: '关闭自动更新',
      openInSidebar: '在右侧打开',
      showing: '{shown} / {total}',
      columnIndex: '序号',
      columnTime: '时间',
      columnKind: '类型',
      columnOperation: '操作',
      columnOutcome: '结果',
      columnTook: '耗时',
      milliseconds: '{ms} 毫秒',
      kindCapture: '截屏',
      kindScreen: '读屏',
      kindWindows: '窗口',
      kindMouse: '鼠标',
      kindKeyboard: '键盘',
      kindClipboard: '剪贴板',
      kindApp: '应用',
      kindWait: '等待',
      kindRecord: '录制',
      kindReplay: '回放',
      kindSystem: '系统',
      kindQuery: '查询',
      kindOther: '其他',
      outcomeRunning: '进行中',
      outcomeOk: '完成',
      outcomeRefused: '被拒绝',
      outcomeFailed: '失败',
      outcomeDryRun: '演练',
      outcomeAborted: '已中止',
    };

    const en = {
      panel: 'Operation log',
      title: 'Computer control - operation log',
      refresh: 'Refresh',
      loading: 'Reading...',
      empty: 'No operations recorded in this session yet.',
      noSession: 'No session is open, so there is nothing to show.',
      failed: 'Could not read the log',
      all: 'All',
      clearFilter: 'Clear',
      autoScroll: 'Auto-scroll',
      liveAuto: 'Auto-update',
      liveOn: 'Turn on live updates',
      liveOff: 'Turn off live updates',
      openInSidebar: 'Open on the right',
      showing: '{shown} / {total}',
      columnIndex: '#',
      columnTime: 'Time',
      columnKind: 'Kind',
      columnOperation: 'Operation',
      columnOutcome: 'Outcome',
      columnTook: 'Took',
      milliseconds: '{ms} ms',
      kindCapture: 'capture',
      kindScreen: 'screen',
      kindWindows: 'windows',
      kindMouse: 'mouse',
      kindKeyboard: 'keyboard',
      kindClipboard: 'clipboard',
      kindApp: 'app',
      kindWait: 'wait',
      kindRecord: 'record',
      kindReplay: 'replay',
      kindSystem: 'system',
      kindQuery: 'query',
      kindOther: 'other',
      outcomeRunning: 'running',
      outcomeOk: 'done',
      outcomeRefused: 'refused',
      outcomeFailed: 'failed',
      outcomeDryRun: 'rehearsed',
      outcomeAborted: 'aborted',
    };

    /** Which dictionary key names each operation kind and outcome. */
    // Declaration order is the filter order, and it groups related operations:
    // capture/screen, then the three that put something into the machine, then the
    // two about programs, then the two halves of recording.
    const KIND_KEYS = {
      capture: 'kindCapture', screen: 'kindScreen',
      mouse: 'kindMouse', keyboard: 'kindKeyboard', clipboard: 'kindClipboard',
      windows: 'kindWindows', app: 'kindApp',
      record: 'kindRecord', replay: 'kindReplay',
      wait: 'kindWait', system: 'kindSystem',
      query: 'kindQuery', other: 'kindOther',
    };
    // One hue per kind, used only as a translucent wash so the badge inherits the
    // host theme's text colour instead of fighting it.
    const KIND_HUE = {
      capture: 268, screen: 205, windows: 232, mouse: 152, keyboard: 176, clipboard: 40,
      app: 318, wait: 96, record: 20, replay: 348, system: 275, query: 195, other: 220,
    };
    const OUTCOME_KEYS = {
      running: 'outcomeRunning', ok: 'outcomeOk', refused: 'outcomeRefused', failed: 'outcomeFailed',
      'dry-run': 'outcomeDryRun', aborted: 'outcomeAborted',
    };
    // Three colours: an operation still in flight is amber, one that finished is left in
    // the theme's own text colour - which is what "black" has to mean in a list that must
    // also work on a dark theme - and anything that did not do what it was asked is red.
    // A refusal and an abort are failures to act, so they take the same red as an error.
    const OUTCOME_TONE = {
      running: 'active', ok: 'normal', refused: 'bad', failed: 'bad', 'dry-run': 'muted', aborted: 'bad',
    };

    const HAIRLINE = '1px solid rgba(128,128,128,0.28)';

    function clockOf(iso) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '--:--:--';
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    // A session can run past midnight - this one did - and a bare clock reading makes
    // an entry from last night indistinguishable from one a moment ago. Wide panels
    // have the room for the date; a narrow one does not, and there the clock alone is
    // still enough to order the rows.
    function stampOf(iso) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '--:--:--';
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function toneStyle(tone) {
      // Amber and red are stated as colours rather than as opacity, so they stay legible
      // on either theme's surface.
      if (tone === 'active') return { color: '#c98a00', fontWeight: 500 };
      if (tone === 'bad') return { color: '#d1453b' };
      if (tone === 'muted') return { opacity: 0.65 };
      return undefined;
    }

    return {
      // `remote` is needed alongside `remote.commands`: Cordis refuses to read the
      // parent service off the context unless the parent itself is injected.
      inject: ['slots', 'remote', 'remote.commands', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-computer-control: dictionaries');
        const t = ctx.locale.bind(NS);

        function ActivityPage(props) {
          // A Conversation View is handed its session directly. The selector is a
          // fallback for a host that renders the view without that prop.
          const { useSessions, sessionId: handedSessionId, inSidebar } = props;
          // The right-column body is not a Conversation View and may receive neither
          // prop. A hook cannot be called conditionally, so a stand-in is chosen
          // instead: the page then reports "no session" rather than throwing inside
          // a seat this plugin does not own.
          const readSelected = typeof useSessions === 'function' ? useSessions : () => undefined;
          const selectedSessionId = readSelected((state) => Object.values(state?.byId ?? {})
            .find((session) => (session.retainedBy?.mainView ?? 0) > 0)?.id);
          const sessionId = handedSessionId ?? selectedSessionId;

          const [snapshot, setSnapshot] = useState({ status: 'loading', entries: [], total: 0, error: null });
          const [kind, setKind] = useState(null);
          const inFlight = useRef(false);
          // Set when the Host offers a live bridge; undefined keeps the manual
          // arrangement, where the page reads only when the person asks.
          const [live, setLive] = useState(undefined);
          // The page lives both in the conversation column and in the right panel, so
          // its width is the container's, not the window's. Measuring the container is
          // what lets the columns drop out instead of overflowing a narrow panel.
          const containerRef = useRef(null);
          const [layout, setLayout] = useState('wide');
          const narrow = layout === 'narrow';
          const roomy = layout === 'wide';
          // Follow the tail of the list as it grows, unless the reader turned it off.
          const [autoScroll, setAutoScroll] = useState(true);
          const listRef = useRef(null);
          // Which element actually scrolls is not this page's decision: it may be the
          // list box, or a panel the host wrapped around it. So every scrollable
          // ancestor is scrolled, which is correct under either arrangement.
          const scrollToBottom = useCallback(() => {
            let node = listRef.current;
            while (node !== null && node !== undefined) {
              if (node.scrollHeight > node.clientHeight + 1) node.scrollTop = node.scrollHeight;
              node = node.parentElement;
            }
          }, []);
          // The surface this page sits on, and a muted text colour for the header, both
          // read from the DOM rather than guessed.
          //
          // The header is muted by mixing its text colour toward the surface, NOT with
          // `opacity`: opacity applies to the element and its background together, so an
          // opaque background still lets the rows show through it. That was the whole of
          // the "the header is see-through" problem.
          const [surface, setSurface] = useState(undefined);
          const [mutedText, setMutedText] = useState(undefined);
          useEffect(() => {
            if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return undefined;
            const element = containerRef.current;
            if (element === null || element === undefined) return undefined;
            const parse = (value) => {
              const match = /rgba?\(([^)]+)\)/.exec(String(value ?? ''));
              if (match === null) return null;
              const parts = match[1].split(',').map((part) => Number.parseFloat(part));
              if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return null;
              return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
            };
            const text = parse(window.getComputedStyle(element).color);
            let found;
            for (let node = element; node !== null && node !== undefined; node = node.parentElement) {
              const background = parse(window.getComputedStyle(node).backgroundColor);
              if (background !== null && background.a > 0.95) { found = background; break; }
            }
            // Nothing above paints a surface: take the polarity from the text colour, so
            // the header is still opaque and still on the right side of the theme.
            const base = found ?? (text !== null && text.r + text.g + text.b > 380
              ? { r: 27, g: 31, b: 39 }
              : { r: 255, g: 255, b: 255 });
            setSurface(`rgb(${base.r}, ${base.g}, ${base.b})`);
            if (text !== null) {
              const mix = (channel, other) => Math.round(channel * 0.62 + other * 0.38);
              setMutedText(`rgb(${mix(text.r, base.r)}, ${mix(text.g, base.g)}, ${mix(text.b, base.b)})`);
            }
            return undefined;
          }, []);
          // How tall the sticky chrome is, so the column header can stick directly
          // beneath it instead of underneath it, out of sight.
          const chromeRef = useRef(null);
          const [chromeHeight, setChromeHeight] = useState(0);
          useEffect(() => {
            const element = chromeRef.current;
            if (element === null || element === undefined || typeof ResizeObserver !== 'function') return undefined;
            const observer = new ResizeObserver((entries) => {
              const box = entries[0]?.borderBoxSize?.[0];
              const height = box?.blockSize ?? entries[0]?.contentRect?.height ?? 0;
              setChromeHeight(Math.round(height));
            });
            observer.observe(element);
            return () => observer.disconnect();
          }, []);
          useEffect(() => {
            const element = containerRef.current;
            if (element === null || element === undefined || typeof ResizeObserver !== 'function') return undefined;
            const observer = new ResizeObserver((entries) => {
              // The border box, not the content box: a content box shrinks by the width of
              // a scrollbar the moment the list grows one, so the measurement would change
              // for a reason that has nothing to do with the panel being resized.
              const border = entries[0]?.borderBoxSize?.[0];
              const width = border?.inlineSize ?? entries[0]?.contentRect?.width ?? 0;
              if (width <= 0) return;
              // Three layouts, chosen with a dead band around each boundary. With a single
              // threshold the page can chase its own tail: a wider layout needs more room,
              // the room it needs pushes the measurement back under the threshold, and the
              // page flips between the two for as long as it is left there.
              //
              // The boundaries are derived from what the columns actually measure, not
              // chosen for roundness:
              //   wide   six columns need about 600px with padding (the date column alone
              //          is ~105, and it is the widest single cell in the table)
              //   medium five columns need about 450px once the date is gone
              // A wide band stops the flicker but creates a dead zone the reader can feel:
              // leave wide below 580 and needing 660 to come back means putting the panel
              // exactly where it was does not restore what was there. Twenty pixels still
              // absorbs measurement jitter and is small enough not to be noticed.
              //
              // What caused the original flicker is fixed elsewhere anyway: the observer
              // reads the border box, which a scrollbar cannot change.
              setLayout((current) => {
                // Measured, then nudged by eye. The five fixed columns come to about 360px
                // with padding and the wrapping operation column wants some 120 more, so the
                // arithmetic minimum for six columns is near 500 - but a table squeezed to
                // its arithmetic minimum looks squeezed, so the switch happens a little
                // before then rather than at the last possible pixel.
                const toMedium = 430;
                const toWide = 555;
                const band = 20;
                if (current === 'wide') {
                  if (width >= toWide - band) return 'wide';
                  return width < toMedium - band ? 'narrow' : 'medium';
                }
                if (current === 'narrow') {
                  if (width <= toMedium + band) return 'narrow';
                  return width > toWide + band ? 'wide' : 'medium';
                }
                if (width < toMedium - band) return 'narrow';
                if (width > toWide + band) return 'wide';
                return 'medium';
              });
            });
            observer.observe(element);
            return () => observer.disconnect();
          }, []);

          // `t` reads the active locale when it is called, so re-rendering on every
          // locale change is all that is needed for the page to follow the shell.
          const [, setLocaleRevision] = useState(0);
          useEffect(() => ctx.locale.subscribe(() => setLocaleRevision((revision) => revision + 1)), []);

          const load = useCallback(async (silent) => {
            if (sessionId === undefined) {
              setSnapshot({ status: 'nosession', entries: [], total: 0, error: null });
              return;
            }
            // A background refresh must not flash "reading..." over a list the
            // person is already reading, and must not race a refresh already out.
            if (silent === true && inFlight.current) return;
            if (silent !== true) setSnapshot((previous) => ({ ...previous, status: 'loading', error: null }));
            inFlight.current = true;
            try {
              const response = await ctx.remote.commands.execute(sessionId, '/computer-activity --json --limit 300', []);
              if (response?.ok !== true) {
                throw new Error(response?.error?.message ?? 'the Host refused the command');
              }
              const result = response.value?.result;
              if (result === undefined) throw new Error('/computer-activity is not registered on the Host');
              if (result.kind === 'error') throw new Error(result.text);
              const payload = JSON.parse(result.text);
              if (payload.live !== undefined) setLive(payload.live);
              // With the bridge running the reply carries only the credentials, because the
              // stream delivers the list a moment later. Keeping the current snapshot until
              // it does means the page does not blink empty in between.
              if (payload.entries !== undefined) {
                setSnapshot({ status: 'ready', entries: payload.entries, total: payload.total ?? 0, error: null });
              } else if (payload.live !== undefined) {
                setSnapshot((previous) => ({ ...previous, status: 'ready', error: null }));
              }
            } catch (error) {
              // A failed background poll leaves the last good list in place: the
              // operations already shown did happen, and blanking them would be a lie.
              if (silent === true) return;
              setSnapshot({ status: 'error', entries: [], total: 0, error: error?.message ?? String(error) });
            } finally {
              inFlight.current = false;
            }
          }, [sessionId]);

          useEffect(() => { void load(false); }, [load]);

          // A new operation appeared, or a filter changed what is listed: follow it.
          useEffect(() => {
            if (autoScroll === true) scrollToBottom();
          }, [snapshot.entries, kind, autoScroll, scrollToBottom]);

          // Live updates. With the loopback bridge configured, the page follows it over
          // Server-Sent Events: nothing is written anywhere, and the update is push.
          // Without it the page stays quiet, because the one sanctioned channel - a
          // session command - records a row in the conversation every time it runs.
          useEffect(() => {
            if (live === undefined || typeof EventSource !== 'function') return undefined;
            const url = 'http://127.0.0.1:' + live.port + live.path
              + '?token=' + encodeURIComponent(live.token)
              + (sessionId === undefined ? '' : '&session=' + encodeURIComponent(sessionId));
            const source = new EventSource(url);
            const onActivity = (message) => {
              try {
                const payload = JSON.parse(message.data);
                if (payload.error !== undefined) return;
                setSnapshot({ status: 'ready', entries: payload.entries ?? [], total: payload.total ?? 0, error: null });
              } catch {
                /* a malformed frame is ignored: the next frame carries the whole list */
              }
            };
            source.addEventListener('activity', onActivity);
            return () => {
              source.removeEventListener('activity', onActivity);
              source.close();
            };
          }, [live, sessionId]);

          // Live updates come from the Host's own session-activity events, not from
          // polling. Every execution of a session command is written into the session
          // (`command/run` and `command/done` are appended unconditionally) and the
          // conversation renders those as rows, so a polling loop through the command
          // pasted the whole payload into the conversation every couple of seconds.
          // `api-session/activity` is on the forwarded-event allow-list, so it pushes
          // instead: nothing is written anywhere, and the update is immediate.
          useEffect(() => {
            let timer;
            const refresh = () => {
              if (typeof document !== 'undefined' && document.hidden === true) return;
              clearTimeout(timer);
              // The Host can emit a burst of these; one read after it settles is enough.
              timer = setTimeout(() => { void load(true); }, 250);
            };
            const disposers = [
              ctx.remote.$on('api-session/activity', refresh),
              ctx.remote.$on('api-session/status', refresh),
              ctx.remote.$on('api-session/added', refresh),
            ];
            return () => {
              clearTimeout(timer);
              for (const dispose of disposers) if (typeof dispose === 'function') dispose();
            };
          }, [load]);

          // Ordered by KIND_KEYS, which groups related operations, rather than by the
          // order they happen to appear in the data.
          const kinds = useMemo(() => {
            const seen = new Set(snapshot.entries.map((entry) => entry.kind));
            const order = Object.keys(KIND_KEYS);
            return order.filter((key) => seen.has(key)).concat([...seen].filter((key) => !order.includes(key)));
          }, [snapshot.entries]);

          const rows = kind === null ? snapshot.entries : snapshot.entries.filter((entry) => entry.kind === kind);

          // The row separator lives on the cells, not on the row: the table is laid out
          // with `border-collapse: separate`, where a <tr> border is not painted at all.
          const cell = { padding: '6px 10px 6px 0', verticalAlign: 'top', whiteSpace: 'nowrap', borderBottom: HAIRLINE };
          // The column header pins directly beneath the chrome, which is itself sticky and
          // opaque. The offset it needs is the chrome's measured height, and a wrong offset
          // now fails safely: the chrome sits above it in the stacking order and paints over
          // it, so a mistake hides the header instead of drawing it across a row. That is
          // the difference between the two arrangements, and the reason this one is worth
          // another attempt.
          const headerCell = {
            ...cell, fontWeight: 500,
            position: 'sticky', top: chromeHeight, zIndex: 1,
            // Fully opaque, and muted through the colour rather than through opacity.
            background: surface ?? 'rgb(255, 255, 255)',
            ...(mutedText === undefined ? {} : { color: mutedText }),
          };

          // One control vocabulary for the whole page: same height, same radius, same
          // hairline. A control that holds state (the selected filter, the live switch)
          // fills in; one that only acts stays outlined.
          const control = (extra) => ({
            font: 'inherit', fontSize: 12.5, lineHeight: '20px', cursor: 'pointer',
            height: 26, padding: '0 12px', borderRadius: 999, boxSizing: 'border-box',
            border: HAIRLINE, background: 'transparent', color: 'inherit',
            display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
            ...extra,
          });
          const CHIP_ON = { background: 'rgba(128,128,128,0.22)', borderColor: 'rgba(128,128,128,0.55)', fontWeight: 500 };
          const CONTROL_ON = { background: 'rgba(128,128,128,0.16)', borderColor: 'rgba(128,128,128,0.5)' };

          const countOf = (key) => (key === null ? snapshot.entries.length : snapshot.entries.filter((entry) => entry.kind === key).length);
          // Each filter is its own chip rather than a segment of one track. With this
          // many categories the track form does not survive wrapping - a rounded pill
          // that breaks across two lines reads as two broken shapes - while chips wrap
          // cleanly at any width. Counts are left out: the header already says how many
          // of how many are shown, and a number in every chip is mostly noise.
          const filterButton = (key, text) => h('button', {
            key: key ?? 'all',
            type: 'button',
            onClick: () => setKind(key),
            title: text,
            style: {
              font: 'inherit', fontSize: 12.5, cursor: 'pointer', height: 26, padding: '0 11px',
              borderRadius: 8, border: 'none', color: 'inherit', whiteSpace: 'nowrap',
              display: 'inline-flex', alignItems: 'center',
              background: kind === key ? 'rgba(128,128,128,0.34)' : 'rgba(128,128,128,0.09)',
              fontWeight: kind === key ? 600 : 400,
              opacity: kind === key ? 1 : 0.78,
            },
          }, text);

          // The switch. It runs the command the page already uses, so turning this, t('columnTime'), t('columnKind'), t('columnOperation'), t('columnOutcome'), t('columnTook')];

          // The switch. Turning it on runs the same command the page already uses, so it
          // costs exactly one recorded row - the row for the click that turned it on -
          // and every update after that arrives over the stream instead.
          const toggleLive = async () => {
            if (sessionId === undefined) return;
            const wanted = live === undefined ? 'on' : 'off';
            try {
              const response = await ctx.remote.commands.execute(sessionId, '/computer-activity --bridge ' + wanted + ' --json', []);
              const result = response?.value?.result;
              if (result?.kind !== 'success') return;
              const payload = JSON.parse(result.text);
              setLive(payload.live);
              setSnapshot({ status: 'ready', entries: payload.entries ?? [], total: payload.total ?? 0, error: null });
            } catch {
              /* the switch keeps showing the last known state */
            }
          };

          // The running row's elapsed time is written straight into its own text node.
          //
          // React's model is: state changes, the whole element tree is rebuilt, the new
          // tree is compared against the old one, and only the differences reach the DOM.
          // The DOM update is surgical, but the rebuild-and-compare is proportional to the
          // whole list - fifty-eight rows of six cells, twenty times a second, to move a few
          // digits. So the counter leaves state entirely: React owns the structure, one
          // timer owns one text node, and nothing re-renders while it runs.
          const elapsedRef = useRef(null);
          const runningEntry = snapshot.entries.find((entry) => entry.outcome === 'running');
          const runningStart = runningEntry === undefined ? undefined : Date.parse(runningEntry.at);
          const formatElapsed = (ms) => (narrow ? `${ms} ms` : t('milliseconds', { ms }));
          useEffect(() => {
            if (runningStart === undefined || Number.isNaN(runningStart)) return undefined;
            const write = () => {
              const node = elapsedRef.current;
              if (node !== null && node !== undefined) {
                node.textContent = formatElapsed(Math.max(0, Math.round(Date.now() - runningStart)));
              }
            };
            write();
            const timer = setInterval(write, 50);
            return () => clearInterval(timer);
          }, [runningStart, narrow]);

          // The outcome column is worth more than the index: given room for one of them,
          // the outcome is kept. The index is only useful for referring to a row, and the
          // reader can count. The duration is different on every row and always earns its
          // place, and it carries the outcome's colour when the outcome text cannot fit.
          const COLUMNS_BY_LAYOUT = {
            wide: ['columnIndex', 'columnTime', 'columnKind', 'columnOperation', 'columnOutcome', 'columnTook'],
            medium: ['columnTime', 'columnKind', 'columnOperation', 'columnOutcome', 'columnTook'],
            narrow: ['columnTime', 'columnKind', 'columnOperation', 'columnTook'],
          };
          const columns = COLUMNS_BY_LAYOUT[layout].map((name) => t(name));

          // The right column is a second seat for the same page. `openTab` names the
          // page by kind, and the type registered below supplies its body; nothing
          // is duplicated, the two seats render the same component.
          const openOnTheRight = inSidebar
            ? null
            : h('button', {
              key: 'sidebar',
              type: 'button',
              onClick: () => ctx.sidebarRight.openTab(TAB_KIND),
              title: t('openInSidebar'),
              style: control(),
            }, t('openInSidebar'));

          // Plain flow, no height, no flex, no overflow.
          //
          // The page used to be a flex column with the list scrolling inside it. That works
          // in the right panel, where the seat hands the view a definite height, and does
          // not work in the main column, where it does not: the list was then stretched by
          // its own content and never scrolled, while still declaring `overflow: auto`. An
          // overflow ancestor that never scrolls is the nearest scrollport for everything
          // inside it, so `position: sticky` on the column header had a box that never
          // moves to stick to - which is exactly why the header stayed put in one seat and
          // scrolled away in the other.
          //
          // Letting the host's own scroller do the scrolling removes the question: there is
          // no overflow of this page's anywhere, so the sticky elements stick to whatever
          // the host scrolls, in either seat, by the same mechanism.
          return h('div', { ref: containerRef, style: { padding: narrow ? '0 10px' : (roomy ? '0 16px' : '0 12px'), color: 'inherit', font: 'inherit', boxSizing: 'border-box' } }, [
            // The spinner's keyframes, rendered as an element rather than injected into the
            // document head, so unmounting this view takes them away with everything else
            // the page put on screen.
            h('style', { key: 'spin', children: '@keyframes dshcc-spin { to { transform: rotate(360deg); } }' }),
            // The title, the controls and the filters pin to the top of whatever the host
            // scrolls. Its background is the surface read from the DOM rather than a wash,
            // so rows cannot show through it and no blur is needed to hide them.
            h('div', {
              key: 'chrome',
              ref: chromeRef,
              style: {
                position: 'sticky', top: 0, zIndex: 2,
                paddingTop: narrow ? 12 : 18,
                paddingBottom: 10,
                background: surface ?? 'rgb(255, 255, 255)',
              },
            }, [
            // `center` and an explicit rowGap: with `baseline` the action buttons, once
            // they wrap onto their own line, align to a baseline in a different line box
            // and sit unevenly against the title above them.
            h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 12, rowGap: 8, flexWrap: 'wrap' } }, [
              h('h2', { key: 'title', style: { margin: 0, fontSize: 17, fontWeight: 600 } }, t('title')),
              h('span', { key: 'count', style: { opacity: 0.6, fontSize: 13 } },
                // Always the pair, and nothing but the numbers. With no filter they are
                // equal and it reads as a total; with a filter they differ and it says how
                // much of the whole is on screen. The slash was never the problem - the
                // words around it were.
                snapshot.status === 'ready' ? t('showing', { shown: rows.length, total: snapshot.total }) : ''),
              // One action group, pushed right by `marginLeft: auto` rather than by a
              // spacer span: a spacer is a flex item of its own, so when the row wraps
              // it takes the line and strands the buttons at the start of the next one.
              h('span', {
                key: 'actions',
                style: { display: 'inline-flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap', justifyContent: 'flex-end' },
              }, [
                openOnTheRight,
                // Following the tail is a preference, so it is offered as one. Refresh
                // does not consult it: asking for the latest and then being left
                // somewhere in the middle of the list is never what was meant.
                h('button', {
                  key: 'autoscroll',
                  type: 'button',
                  onClick: () => setAutoScroll((on) => !on),
                  title: t('autoScroll'),
                  style: control(autoScroll === true ? CONTROL_ON : {}),
                }, t('autoScroll')),
                // The two things that do something to the page sit together, instead of
                // one beside the title and one in the far corner.
                // One name and one state, like the auto-scroll switch beside it: the label
                // says what the control is, and whether it is filled says whether it is on.
                // A label that renames itself to the opposite action is a label the reader
                // has to parse before they can act.
                h('button', {
                  key: 'livetoggle',
                  type: 'button',
                  onClick: () => { void toggleLive(); },
                  title: live === undefined ? t('liveOn') : t('liveOff'),
                  'aria-pressed': live !== undefined,
                  style: control(live === undefined ? {} : CONTROL_ON),
                }, t('liveAuto')),
                h('button', {
                  key: 'refresh',
                  type: 'button',
                  onClick: () => {
                    // Unconditional, whatever the auto-scroll preference says.
                    void load(false).then(() => scrollToBottom());
                  },
                  title: t('refresh'),
                  style: control(),
                }, [
                  h('svg', {
                    key: 'icon',
                    width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
                    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
                    'aria-hidden': true,
                  }, [
                    h('path', { key: 'arc', d: 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1' }),
                    h('path', { key: 'head', d: 'M20.5 4.4v5h-5' }),
                  ]),
                  h('span', { key: 'label' }, t('refresh')),
                ]),
              ]),
            ]),
            // No explanatory paragraph: the title, the filters and the table already say
            // what this is, and a sentence describing the page is documentation rather than
            // interface. It had also gone stale - it still described reading only on
            // refresh, which stopped being true once the list began following itself.

            snapshot.status === 'nosession' ? h('p', { key: 'nosession', style: { opacity: 0.7 } }, t('noSession')) : null,
            snapshot.status === 'error' ? h('p', { key: 'error', style: { color: '#c0392b' } }, `${t('failed')}: ${snapshot.error}`) : null,
            snapshot.status === 'loading' ? h('p', { key: 'loading', style: { opacity: 0.7 } }, t('loading')) : null,
            snapshot.status === 'ready' && snapshot.entries.length === 0 ? h('p', { key: 'empty', style: { opacity: 0.7 } }, t('empty')) : null,

            snapshot.status === 'ready' && snapshot.entries.length > 0
              // The paragraph that used to sit here carried this separation in its own
              // margins; removing it left the buttons and the filters touching, which
              // reads as an overlap. The gap is stated here instead of coming from text
              // that happens to be present.
              ? h('div', { key: 'filters', style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, marginBottom: 14, flexWrap: 'wrap' } }, [
                h('div', {
                  key: 'chips',
                  style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 },
                }, [filterButton(null, t('all')), ...kinds.map((entry) => filterButton(entry, t(KIND_KEYS[entry] ?? 'kindOther')))]),
                // Only offered while a filter is on, so it can only mean one thing.
                kind === null ? null : h('button', {
                  key: 'clearfilter',
                  type: 'button',
                  onClick: () => setKind(null),
                  title: t('clearFilter'),
                  style: { font: 'inherit', fontSize: 12.5, cursor: 'pointer', border: 'none', background: 'transparent', color: 'inherit', opacity: 0.65, padding: '0 2px', textDecoration: 'underline' },
                }, t('clearFilter')),
              ])
              : null,
            ]),

            // No overflow, no flex, no minimum height: this is a plain block, and the
            // scrolling above it belongs to the host. Declaring `overflow` here while
            // having no height of its own is what made the column header stick to a box
            // that never moved.
            h('div', {
              key: 'list',
              ref: listRef,
              style: { padding: '0 4px 25px' },
            }, [
              snapshot.status === 'ready' && rows.length > 0
                ? h('table', { key: 'table', style: { borderCollapse: 'separate', borderSpacing: 0, fontSize: 13, width: '100%' } }, [
                  h('thead', { key: 'h' }, h('tr', null, columns.map((label, index) => h('th', {
                    key: label, style: { ...headerCell, textAlign: index === columns.length - 1 ? 'right' : 'left' },
                  }, label)))),
                h('tbody', { key: 'b' }, rows.map((entry) => h('tr', { key: entry.index }, [
                  roomy ? h('td', { key: 'i', style: { ...cell, opacity: 0.6 } }, `#${entry.index}`) : null,
                  // The date is the first thing to go: only the wide layout has room for it,
                  // and below that the clock alone still orders the rows.
                  h('td', { key: 't', style: { ...cell, opacity: 0.8, fontVariantNumeric: 'tabular-nums' } }, roomy ? stampOf(entry.at) : clockOf(entry.at)),
                  h('td', { key: 'k', style: cell }, h('span', {
                    key: 'badge',
                    style: {
                      display: 'inline-block', padding: '1px 9px', borderRadius: 999, fontSize: 12, lineHeight: '17px',
                      // A translucent wash of one hue per kind: it reads as a category
                      // without fighting the host theme's own text colour.
                      background: 'hsla(' + (KIND_HUE[entry.kind] ?? 220) + ', 62%, 50%, 0.16)',
                      border: '1px solid hsla(' + (KIND_HUE[entry.kind] ?? 220) + ', 62%, 50%, 0.34)',
                      whiteSpace: 'nowrap',
                    },
                  }, t(KIND_KEYS[entry.kind] ?? 'kindOther'))),
                  // No minimum width. Every other column is `nowrap` and therefore keeps its
                  // content width, so this cell is the one the browser has to shrink - and
                  // because its text wraps, shrinking it costs a line rather than a clipped
                  // word. It used to hold a 260px floor, which meant that as the panel
                  // narrowed this column refused to give way and the whole table overflowed
                  // until the layout gave up and switched. Compressing here first is what
                  // the narrowing is supposed to do.
                  h('td', { key: 's', style: { ...cell, whiteSpace: 'normal' } }, [
                    // A running operation carries a spinner in front of its title, so the row
                    // says "this is happening right now" without the reader having to reach
                    // the outcome column. It takes currentColor and is therefore amber along
                    // with the rest of the running row.
                    entry.outcome === 'running' ? h('svg', {
                      key: 'spin',
                      width: 12, height: 12, viewBox: '0 0 24 24',
                      'aria-hidden': true,
                      style: { marginRight: 7, verticalAlign: '-1px', animation: 'dshcc-spin 0.9s linear infinite' },
                    }, h('circle', {
                      cx: 12, cy: 12, r: 9, fill: 'none',
                      stroke: 'currentColor', strokeWidth: 2.6,
                      // An arc with rounded ends rather than a CSS border with one edge
                      // hidden: a border spinner meets its own ends at a hard diagonal and
                      // looks chipped at this size. It takes currentColor, so it is amber
                      // along with the rest of the running row.
                      strokeDasharray: '38 19', strokeLinecap: 'round',
                    })) : null,
                    h('span', { key: 'text' }, entry.summary),
                  ]),
                  narrow ? null : h('td', {
                    key: 'o',
                    style: {
                      ...cell, ...toneStyle(OUTCOME_TONE[entry.outcome]),
                      // A refusal carries its whole reason, which can be a sentence. Without
                      // wrapping, that one row decides the width of the column and pushes the
                      // whole table past the panel - which is what made the layout give up
                      // and switch while the table still had room to give.
                      whiteSpace: 'normal', maxWidth: 170,
                    },
                  },
                    `${t(OUTCOME_KEYS[entry.outcome] ?? entry.outcome)}${entry.outcome === 'ok' || entry.detail === undefined ? '' : ` - ${entry.detail}`}`),
                  h('td', {
                    key: 'e',
                    style: {
                      ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                      // A running row is not dimmed: it is the one row that is changing, and
                      // it carries the amber of the running state so the eye lands on it.
                      // Elsewhere the outcome's colour appears here only where the outcome
                      // text itself has nowhere to go.
                      ...(entry.outcome === 'running'
                        ? toneStyle('active')
                        : (narrow ? toneStyle(OUTCOME_TONE[entry.outcome]) : { opacity: 0.6 })),
                    },
                  }, entry.outcome === 'running'
                    // The same column, the same unit, the same shape as a finished row -
                    // only the number is alive, and it is alive in its own DOM node rather
                    // than through a re-render. What is rendered here is the first paint;
                    // from then on the timer above owns the text.
                    ? h('span', { key: 'live', ref: elapsedRef },
                      formatElapsed(Math.max(0, Math.round(Date.now() - Date.parse(entry.at)))))
                    : (narrow ? `${entry.elapsedMs} ms` : t('milliseconds', { ms: entry.elapsedMs }))),
                ].filter((node) => node !== null)))),
                ])
                : null,
            ]),
          ]);
        }

        // A third View beside the shipped Conversation and Trajectory entries.
        // `conversation.view` is a list slot with `replaceRisk: none`, so a fresh
        // id is added alongside the shipped ones rather than shadowing either.
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'computer-control',
          order: 40,
          label: () => t('panel'),
        }, ActivityPage));

        // The same page as a tab in the right column, so it can sit beside the
        // conversation instead of replacing it. A tab type registers in two stages,
        // both scoped to this plugin: the type, then its body under the type's id.
        // A tab body is not a Conversation View, so it hides the button that would
        // open a second copy of itself.
        const ActivityTab = (props) => h(ActivityPage, { ...props, inSidebar: true });
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: NS,
          kind: TAB_KIND,
          title: () => t('panel'),
          keepMounted: true,
        }), 'dsh-computer-control: sidebar tab type');
        ctx.effect(() => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: NS,
        }, ActivityTab), 'dsh-computer-control: sidebar tab body');
      },
    };
  },
});