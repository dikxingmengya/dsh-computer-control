// The in-page half of the browser tools: a locator engine, actionability waiting, and a
// snapshot that reaches into shadow roots.
//
// Everything here runs inside the page, so it is shipped as source text rather than imported.
// It is written as one self-installing IIFE that returns early when it is already present,
// which is what lets every call start with it without paying for a separate round trip.
//
// The selector grammar is the subset of Playwright's that covers what a model actually writes:
//
//     css=button.primary        or a bare CSS selector
//     text=Checkout             substring, case-insensitive, shortest match first
//     role=button               with an optional [name=...]
//     nth=0                     index into whatever came before it
//     a >> b                    chain: narrow the previous result
//
// Not supported, deliberately: XPath, regular expressions, and `:has-text()`. Each would need
// its own parser and each has a way of being written three different ways; the four forms above
// are unambiguous.
export const PAGE_LIB = `(() => {
  if (window.__dsh) return 'ready';

  const deepElements = (root, out) => {
    const walker = (node) => {
      for (const el of node.querySelectorAll('*')) {
        out.push(el);
        if (el.shadowRoot) walker(el.shadowRoot);
      }
    };
    if (root.documentElement) out.push(root.documentElement);
    walker(root);
    return out;
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      // el.type is never empty: an input with no type attribute reports "text". Returning it
      // directly labelled every plain field as role "text", which in the snapshot reads like a
      // paragraph of prose and gives no hint that it is the thing to type into.
      const type = (el.type || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'file') return 'file';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return tag;
  };

  const nameOf = (el) => {
    const attr = (n) => (el.getAttribute ? el.getAttribute(n) : null);
    const aria = attr('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const labelled = attr('aria-labelledby');
    if (labelled) {
      const text = labelled.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean)
        .map((n) => n.textContent.trim()).join(' ').trim();
      if (text) return text;
    }
    if (el.labels && el.labels.length) {
      const text = Array.from(el.labels).map((l) => l.textContent.trim()).join(' ').trim();
      if (text) return text;
    }
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) return text.slice(0, 120);
    return (attr('alt') || attr('title') || attr('placeholder') || '').trim().slice(0, 120);
  };

  const visible = (el) => {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity) < 0.05) return false;
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  };

  const enabled = (el) => !(el.disabled === true || el.getAttribute('aria-disabled') === 'true');

  // What is actually at this point, including inside shadow roots.
  //
  // document.elementsFromPoint does not pierce a shadow root: for a button inside one it
  // returns the host, so a hit test built on it reports "something is covering the element"
  // for every element in a component library. ShadowRoot is itself a DocumentOrShadowRoot and
  // does have elementsFromPoint, so the descent is: ask the document, and if the top element
  // owns a shadow root, ask that root instead, repeatedly. (No backticks in this comment: the
  // whole library is one template literal, and a stray backtick ends it.)
  const deepestAt = (x, y) => {
    let root = document;
    let top = null;
    for (let depth = 0; depth < 12; depth += 1) {
      const stack = root.elementsFromPoint ? root.elementsFromPoint(x, y) : [];
      if (stack.length === 0) return top;
      top = stack[0];
      if (!top.shadowRoot) return top;
      root = top.shadowRoot;
    }
    return top;
  };

  const hitTest = (el, x, y) => {
    const top = deepestAt(x, y);
    if (top === null) return false;
    return top === el || el.contains(top) || top.contains(el);
  };

  const one = (part) => {
    if (part.startsWith('text=')) {
      const needle = part.slice(5).trim().toLowerCase();
      const hits = deepElements(document, []).filter((el) => {
        if (!visible(el)) return false;
        // Text content covers buttons, links and headings. An input field has none - its name
        // comes from a placeholder or a label - so nameOf is checked as well. Without that, a
        // model that reads textbox "Email" from the snapshot and then writes text=Email gets
        // "no element matched", which reads as the field having disappeared.
        const text = (el.innerText || el.textContent || '').trim().toLowerCase();
        return text.includes(needle) || nameOf(el).toLowerCase().includes(needle);
      });
      // The shortest match is the most specific one: without this, text=Buy would return every
      // ancestor whose text happens to contain it, starting with <body>.
      hits.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      return hits.slice(0, 1);
    }
    if (part.startsWith('role=')) {
      const rest = part.slice(5);
      const match = /^([\\w-]+)(?:\\[name=("([^"]*)"|'([^']*)'|([^\\]]*))\\])?$/.exec(rest.trim());
      if (!match) throw new Error('bad role selector: ' + part);
      const role = match[1];
      const wanted = (match[3] ?? match[4] ?? match[5] ?? '').toLowerCase();
      return deepElements(document, []).filter((el) => {
        if (roleOf(el) !== role) return false;
        if (wanted && !nameOf(el).toLowerCase().includes(wanted)) return false;
        return visible(el);
      });
    }
    if (part.startsWith('nth=')) throw new Error('nth= must follow another selector');
    if (part.startsWith('xpath=')) {
      // XPath 1.0 cannot see into a shadow root - that is the specification, not a limitation of
      // this code - so this branch is deliberately the one path that does not pierce. It is
      // here because some pages are far easier to address that way; prefer a CSS selector when
      // the target might live inside a component.
      const expression = part.slice(6);
      const snapshot = document.evaluate(expression, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const hits = [];
      for (let i = 0; i < snapshot.snapshotLength; i += 1) {
        const node = snapshot.snapshotItem(i);
        if (node !== null && node.nodeType === 1) hits.push(node);
      }
      return hits;
    }
    const css = part.startsWith('css=') ? part.slice(4) : part;
    return deepElements(document, []).filter((el) => {
      try { return el.matches(css); } catch { return false; }
    });
  };

  const resolve = (selector) => {
    const parts = String(selector).split('>>').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) throw new Error('empty selector');
    let current = null;
    for (const part of parts) {
      if (part.startsWith('nth=')) {
        const index = Number(part.slice(4));
        if (!Number.isInteger(index) || index < 0) throw new Error('nth= needs a non-negative integer');
        if (current === null) throw new Error('nth= must follow another selector');
        const picked = current[index];
        current = picked === undefined ? [] : [picked];
        continue;
      }
      const found = one(part);
      current = current === null ? found : current.filter((el) => found.some((f) => f === el || el.contains(f)));
      if (current.length === 0) return [];
    }
    return current;
  };

  const describe = (el) => {
    const rect = el.getBoundingClientRect();
    return {
      role: roleOf(el), name: nameOf(el),
      x: Math.round(rect.left), y: Math.round(rect.top),
      width: Math.round(rect.width), height: Math.round(rect.height),
      visible: visible(el), enabled: enabled(el),
    };
  };

  // Playwright's actionability check, reduced to what can be observed from the page: exists,
  // visible, enabled, not moving, and actually receiving the pointer at its centre.
  const settle = (el) => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const actionable = async (el) => {
    if (!el.isConnected) return 'the element is no longer in the document';
    if (!visible(el)) return 'the element is not visible';
    if (!enabled(el)) return 'the element is disabled';
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await settle();
    const a = el.getBoundingClientRect();
    await settle();
    const b = el.getBoundingClientRect();
    if (Math.abs(a.left - b.left) > 1 || Math.abs(a.top - b.top) > 1) return 'the element is still moving';
    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;
    if (!hitTest(el, cx, cy)) return 'something else is on top of the element at its centre';
    return undefined;
  };

  const target = async (selector, timeoutMs) => {
    const deadline = Date.now() + (timeoutMs || 8000);
    let reason = 'no element matched ' + selector;
    for (;;) {
      const found = resolve(selector);
      if (found.length > 1) {
        // Ambiguity is reported rather than guessed: clicking the wrong one of two identically
        // named buttons is worse than saying so.
        return { error: 'the selector matched ' + found.length + ' elements: ' + found.slice(0, 5).map((el) => roleOf(el) + ' "' + nameOf(el) + '"').join(', ') + '. Narrow it with nth=.' };
      }
      if (found.length === 1) {
        reason = await actionable(found[0]);
        if (reason === undefined) {
          const r = found[0].getBoundingClientRect();
          return { el: found[0], x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), info: describe(found[0]) };
        }
      } else {
        reason = 'no element matched ' + selector;
      }
      if (Date.now() > deadline) return { error: reason + ' (waited ' + (timeoutMs || 8000) + ' ms)' };
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  window.__dsh = { resolve, describe, visible, enabled, actionable, target, roleOf, nameOf, deepElements };
  return 'ready';
})()`;

/**
 * Wait for a selector to reach a state, inside the page.
 *
 * `state` is "visible" (the default), "hidden", or "attached" for existence alone.
 */
export function waitExpression(selector, state, timeoutMs) {
  return `(${PAGE_LIB}) && (async () => {
    const deadline = Date.now() + ${timeoutMs};
    for (;;) {
      let found = [];
      try { found = window.__dsh.resolve(${JSON.stringify(selector)}); } catch (e) { return 'bad selector: ' + e.message; }
      const want = ${JSON.stringify(state)};
      const ok = want === 'attached' ? found.length > 0 : want === 'hidden' ? found.length === 0 : found.some((el) => window.__dsh.visible(el));
      if (ok) return { satisfied: true, matched: found.length, waitedMs: ${timeoutMs} - Math.max(0, deadline - Date.now()) };
      if (Date.now() > deadline) return { satisfied: false, matched: found.length, waitedMs: ${timeoutMs} };
      await new Promise((r) => setTimeout(r, 100));
    }
  })()`;
}

/** Resolve one selector to its centre, waiting for it to be actionable. */
export function targetExpression(selector, timeoutMs) {
  return `(${PAGE_LIB}) && window.__dsh.target(${JSON.stringify(selector)}, ${timeoutMs})`;
}