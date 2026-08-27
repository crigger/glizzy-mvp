/**
 * `?inspect` — capture the edits you made in DevTools so they can be applied to
 * the source.
 *
 * The point is to skip describing a change in prose. Nudge the CSS and the
 * markup in the inspector until the page looks right, press capture, and this
 * writes down exactly what differs from how the page loaded — selectors,
 * declarations, attributes, text — into .inspect/latest.md for someone to port
 * back into the SCSS and the components.
 *
 * BASELINE TIMING is the whole difficulty. A snapshot taken at DOMContentLoaded
 * is useless: this page spends the next second building the dog's path, sizing
 * the body to fit it, rebuilding again when the webfonts land, and starting a
 * three.js render loop. Every one of those would show up as an edit you didn't
 * make. So the baseline is taken after `load` plus a settle delay, and can be
 * retaken at any point. Anything the page rewrites FOREVER is filtered
 * separately, below — a settle delay can't help with those.
 *
 * Ported from vinton.land, which is where the hard-won parts of this come from:
 * node-identity matching, walking into @media, the shorthand-with-var() trap.
 * The NOISE list is the part that is genuinely per-site.
 *
 * It reads the DOM and the live stylesheets rather than tracking events, so it
 * doesn't care how an edit was made: typing in the Styles pane, editing an
 * attribute, deleting a node, or pasting markup all land the same way.
 */
(function () {
  if (!new URLSearchParams(location.search).has('inspect')) return;

  /**
   * Things this page rewrites forever. They are not edits, and they would bury
   * the ones that are.
   *
   * The list is short because there are only three animators here, but each
   * writes on SCROLL — which is what you do to reach the thing you want to
   * edit — so a settle delay cannot filter any of them:
   *
   *   glizzy-path.js  the whole dog. Rebuilds the `d` on resize and on
   *                   `document.fonts.ready`, and writes strokeDashoffset
   *                   inline on every scroll frame. Nothing in #glizzy is ever
   *                   hand-edited — it does not exist in the source, the script
   *                   builds it — so the whole subtree is filtered.
   *   hero-dog.js     the canvas. `width`/`height` are the backing store, kept
   *                   in sync by a ResizeObserver; `class` gains and loses
   *                   `mini` as the hero scrolls away; `style` carries the FLIP
   *                   transform between the two states.
   *   glizzy-windows  GSAP writes the drag transform inline on the window's
   *                   target, and animates it back to zero on section exit.
   *
   * `body` is deliberately NOT here even though glizzy-path.js sets its
   * min-height: that settles once the path is built and only moves again on a
   * resize, so filtering it would cost a real edit for no gain.
   *
   * The measure of this list: capture with no edits, after scrolling around,
   * must say "nothing changed".
   */
  var NOISE = [
    { match: '#glizzy, #glizzy *', attrs: ['*'] },
    { match: '#hero-stage', attrs: ['width', 'height', 'class', 'style'] },
    { match: '.window-wrapper-inner', attrs: ['style'] },
    // GSAP stamps `user-select`/`touch-action`/`cursor` onto the Draggable's
    // TRIGGER and its descendants when ScrollTrigger enables the drag, and
    // strips them again on the way out. Scrolling past a window section is
    // enough to produce them, so they arrived as three phantom edits on the
    // very first no-edit capture.
    { match: '.window-chrome, .window-chrome *', attrs: ['style'] },
    // The dev debug panel. `updateDebug()` rewrites its readout on every scroll
    // frame, and `applyAspectPreset()` rewrites every slider on a resize. It is
    // display:none and nobody edits it — filter the lot, text included.
    { match: '#debug-panel, #debug-panel *', attrs: ['*'] },
  ];

  /**
   * `attr` is an attribute name, or the sentinel `'#text'` for an element's own
   * text.
   *
   * vinton.land's version only ever filtered attributes, because nothing there
   * rewrites its own TEXT on a loop. Here the debug panel's `<pre id="debug">`
   * does, on every scroll frame — so it survived an `attrs: ['*']` rule and
   * still arrived as the one phantom edit in a no-edit capture.
   */
  function noisy(el, attr) {
    for (var i = 0; i < NOISE.length; i++) {
      var rule = NOISE[i];
      if (!el.matches || !el.matches(rule.match)) continue;
      if (rule.attrs.indexOf('*') !== -1 || rule.attrs.indexOf(attr) !== -1) return true;
    }
    return false;
  }

  /**
   * Is this whole ELEMENT noise, rather than just some attribute on it?
   *
   * A rule with `attrs: ['*']` says nothing about the element is ever a hand
   * edit — which also means its appearance and disappearance are not edits.
   * That mattered the moment it was missed: glizzy-path.js does not mutate the
   * dog's <path>, it REPLACES it on every rebuild, so a rebuild after the
   * baseline (a resize, a device rotation) produced an unstamped node. The
   * attribute filter never saw it, `freshOnes()` dumped its whole outerHTML,
   * and a capture of four CSS edits arrived as 139KB of markup.
   */
  function noisyNode(el) {
    for (var i = 0; i < NOISE.length; i++) {
      var rule = NOISE[i];
      if (!el.matches || !el.matches(rule.match)) continue;
      if (rule.attrs.indexOf('*') !== -1) return true;
    }
    return false;
  }

  /**
   * The SHORTEST selector that still identifies the element uniquely, rather
   * than the full chain from `body`. A full chain for anything deeply nested
   * runs to three lines of `div > p > span`, which is unreadable in a report
   * meant to be acted on — and `.block__word` says the same thing.
   */
  function pathOf(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(part + '#' + node.id);
        break;
      }
      var cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
      if (cls.length) part += '.' + cls.slice(0, 3).join('.');
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);

      var candidate = parts.join(' > ');
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch (err) { /* an odd class name; keep walking up */ }

      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  /**
   * Elements are matched between snapshots by NODE IDENTITY, not by selector.
   *
   * A path-keyed snapshot looks obvious and is wrong: delete one element and
   * every later sibling's `:nth-of-type` shifts, so untouched elements show up
   * as one removal plus one addition apiece. Stamping each node at baseline and
   * comparing stamps means a removal is a removal and nothing else moves.
   *
   * The cost is that DevTools' "Edit as HTML" REPLACES nodes, so a subtree
   * edited that way reports as removed + added rather than changed. That's
   * accurate — they really are different nodes — and it's why the report keeps
   * the attributes of added elements.
   */
  var STAMP = '__inspectId';
  var nextStamp = 1;

  function snapDom(stamping) {
    var out = {};
    var all = document.querySelectorAll('body *');
    Array.prototype.forEach.call(all, function (el) {
      if (el.closest('.inspect-capture')) return;
      if (stamping && !el[STAMP]) el[STAMP] = nextStamp++;
      var id = el[STAMP];
      if (!id) return; // added since the baseline; handled by the walk below

      var attrs = {};
      Array.prototype.forEach.call(el.attributes, function (a) {
        if (noisy(el, a.name)) return;
        attrs[a.name] = a.value;
      });
      // Own text only — a parent's textContent would repeat every child's and
      // report one word change on a dozen ancestors.
      var text = noisy(el, '#text')
        ? ''
        : Array.prototype.filter.call(el.childNodes, function (n) { return n.nodeType === 3; })
            .map(function (n) { return n.nodeValue; }).join('').trim();

      out[id] = {
        attrs: attrs,
        text: text,
        tag: el.tagName.toLowerCase(),
        sel: pathOf(el),
        parent: el.parentElement ? el.parentElement[STAMP] || null : null,
        // A wholly-noisy element vanishing is not an edit either — see noisyNode().
        noise: noisyNode(el),
      };
    });
    return out;
  }

  /** Elements with no stamp: they didn't exist when the baseline was taken. */
  function freshOnes() {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('body *'), function (el) {
      if (el.closest('.inspect-capture') || el[STAMP]) return;
      // One entry per added subtree, not one per node in it.
      if (el.parentElement && !el.parentElement[STAMP]) return;
      // Scripts that REPLACE their element rather than mutate it would
      // otherwise arrive here as a fresh node with its whole outerHTML.
      if (noisyNode(el)) return;
      var attrs = {};
      Array.prototype.forEach.call(el.attributes, function (a) { attrs[a.name] = a.value; });
      // Generous, and truncated rather than dropped past the cap. A whole
      // duplicated section is exactly the case this exists for, and 400
      // characters silently threw one away — leaving only flattened text, from
      // which the markup can't be rebuilt.
      var html = el.outerHTML;
      if (html.length > 40000) html = html.slice(0, 40000) + '\n<!-- …truncated at 40000 chars -->';

      out.push({
        kind: 'added',
        path: pathOf(el),
        attrs: attrs,
        text: el.textContent.trim().slice(0, 400),
        html: html,
      });
    });
    return out;
  }

  /**
   * A rule's OWN declarations — not `cssText`, which for a grouping rule is the
   * entire block including every child. Read off the style declaration, so
   * property and value arrive already separated instead of being recovered
   * from a string.
   */
  function declText(rule) {
    var out = [];
    var st = rule.style;
    if (!st) return '';
    var lostAValue = false;
    for (var i = 0; i < st.length; i++) {
      var prop = st[i];
      var value = st.getPropertyValue(prop);
      // A SHORTHAND CONTAINING var() SERIALIZES ITS LONGHANDS AS EMPTY.
      //
      // That's the spec, not a quirk: `border: var(--border-w-standard) solid
      // currentColor` enumerates as border-top-width, border-top-style, … and
      // every one of them reads back as ''. This loop dutifully reported
      // `border-top-width: ;` and the capture looked exactly like a property
      // being REMOVED — which is how a deliberate border ended up deleted from
      // the stylesheet instead of applied.
      //
      // `st.cssText` keeps the shorthand intact, var() and all. It's only used
      // when something came back empty, so ordinary captures keep the
      // property-per-line form that's easy to read.
      if (value === '') lostAValue = true;
      out.push(prop + ': ' + value + (st.getPropertyPriority(prop) ? ' !important' : ''));
    }
    if (lostAValue && st.cssText) return st.cssText;
    return out.join('; ');
  }

  /**
   * Did any declaration in this rule serialize as empty?
   *
   * The `lostAValue` fallback above is a heuristic and it has now failed in the
   * wild: a DevTools edit that mixed a var()-carrying `background-image` with a
   * plain `background-size` reported the image as `''` and the value was gone
   * from the capture entirely — the one value the edit was about.
   *
   * So rather than trust the heuristic, every rule also carries its raw
   * `cssText`, and the writer prints it whenever a value came through empty.
   * Uglier, and it cannot lose anything.
   */
  function anyEmpty(rule) {
    var st = rule.style;
    if (!st) return false;
    for (var i = 0; i < st.length; i++) {
      if (st.getPropertyValue(st[i]) === '') return true;
    }
    return false;
  }

  /**
   * Walks INTO grouping rules — @media, @supports, @container, @layer — instead
   * of stopping at the top level.
   *
   * Stopping there meant an edit inside a media query was reported against the
   * group, whose only name is its condition: the capture said
   * `(min-aspect-ratio: 1/1) { transform: scale(1.25) }` and left the selector
   * behind entirely, so the change couldn't be placed in the source without
   * guessing. Each style rule is now recorded under its full context.
   */
  function walkRules(rules, key, context, out) {
    Array.prototype.forEach.call(rules, function (rule, ri) {
      var at = key + '|' + ri;
      var cond = rule.conditionText || (rule.media && rule.media.mediaText) || '';

      if (rule.selectorText) {
        // Context and selector stay SEPARATE fields so the report can nest them
        // as real CSS. Pre-joined into one string, the writer had no way to tell
        // where the `@media` ended and produced `@media (…) { .sel } { … }`.
        out[at] = {
          sel: rule.selectorText,
          ctx: context,
          text: declText(rule),
          // Kept for every rule, printed only when something was lost.
          raw: anyEmpty(rule) ? (rule.style && rule.style.cssText) || '' : '',
        };
      }

      // Nested CSS means a style rule can hold rules too, so this isn't an
      // either/or with the branch above.
      if (rule.cssRules && rule.cssRules.length) {
        var inner = rule.selectorText
          ? (context ? context + ' ' + rule.selectorText : rule.selectorText)
          : (cond ? (context ? context + ' and ' + cond : '@media ' + cond) : context);
        walkRules(rule.cssRules, at, inner, out);
      }
    });
  }

  /**
   * Every style rule in every readable stylesheet. A cross-origin sheet throws
   * on `cssRules` and is skipped — there are none here, since every font is
   * self-hosted and nothing is fetched from another origin at runtime.
   */
  function snapCss() {
    var out = {};
    Array.prototype.forEach.call(document.styleSheets, function (sheet, si) {
      var rules;
      try { rules = sheet.cssRules; } catch (err) { return; }
      if (!rules) return;
      walkRules(rules, String(si), '', out);
    });
    return out;
  }

  /** Which declarations differ between two declaration lists. */
  function declDiff(before, after) {
    var decls = function (css) {
      var map = {};
      css.split(';').forEach(function (d) {
        // First colon only: a value can contain more of them (`url(data:…)`).
        var at = d.indexOf(':');
        if (at === -1) return;
        map[d.slice(0, at).trim()] = d.slice(at + 1).trim();
      });
      return map;
    };
    var a = decls(before);
    var b = decls(after);
    var changed = [];
    Object.keys(b).forEach(function (k) {
      if (a[k] !== b[k]) changed.push({ prop: k, from: a[k] === undefined ? null : a[k], to: b[k] });
    });
    Object.keys(a).forEach(function (k) {
      if (!(k in b)) changed.push({ prop: k, from: a[k], to: null });
    });
    return changed;
  }

  function diff(base, now) {
    var css = [];
    Object.keys(now.css).forEach(function (k) {
      var was = base.css[k];
      var is = now.css[k];
      if (was && was.text === is.text) return;
      if (!was) css.push({ kind: 'added', selector: is.sel, context: is.ctx, cssText: is.text, raw: is.raw });
      else css.push({ kind: 'changed', selector: is.sel, context: is.ctx, decls: declDiff(was.text, is.text), raw: is.raw });
    });
    Object.keys(base.css).forEach(function (k) {
      if (!(k in now.css)) css.push({ kind: 'removed', selector: base.css[k].sel, context: base.css[k].ctx });
    });

    var dom = [];
    now.fresh = now.fresh || [];
    Object.keys(now.dom).forEach(function (key) {
      var was = base.dom[key];
      var is = now.dom[key];
      if (!was) return; // stamped but unknown: can't happen, and guessing would lie
      var attrs = [];
      Object.keys(is.attrs).forEach(function (a) {
        if (was.attrs[a] !== is.attrs[a]) attrs.push({ name: a, from: was.attrs[a] === undefined ? null : was.attrs[a], to: is.attrs[a] });
      });
      Object.keys(was.attrs).forEach(function (a) {
        if (!(a in is.attrs)) attrs.push({ name: a, from: was.attrs[a], to: null });
      });
      var text = was.text !== is.text ? { from: was.text, to: is.text } : null;
      if (attrs.length || text) dom.push({ kind: 'changed', path: is.sel, attrs: attrs, text: text });
    });

    dom = dom.concat(now.fresh || []);
    // Removing one element removes everything under it. Reporting each
    // descendant separately buries the one edit that was actually made.
    var gone = Object.keys(base.dom).filter(function (key) { return !(key in now.dom); });
    var goneSet = {};
    gone.forEach(function (k) { goneSet[k] = true; });
    gone.forEach(function (key) {
      if (base.dom[key].noise) return;   // the other half of a replaced node
      var parent = base.dom[key].parent;
      if (parent && goneSet[parent]) return;
      dom.push({ kind: 'removed', path: base.dom[key].sel, tag: base.dom[key].tag });
    });

    return { css: css, dom: dom };
  }

  var baseline = null;

  var panel = document.createElement('div');
  panel.className = 'inspect-capture';
  panel.innerHTML =
    '<p class="inspect-capture__hint">Edit freely in DevTools, then capture. The baseline is how the page looked once its scripts settled.</p>' +
    '<div class="inspect-capture__row">' +
      '<button type="button" data-act="capture">capture</button>' +
      '<button type="button" data-act="rebase">re-baseline</button>' +
      '<span class="inspect-capture__status"></span>' +
    '</div>' +
    '<pre class="inspect-capture__out"></pre>';
  document.body.appendChild(panel);

  var statusEl = panel.querySelector('.inspect-capture__status');
  var outEl = panel.querySelector('.inspect-capture__out');

  function say(msg, bad) {
    statusEl.textContent = msg;
    statusEl.dataset.bad = bad ? '1' : '';
  }

  function rebase() {
    baseline = { dom: snapDom(true), css: snapCss() };
    outEl.textContent = '';
    say('baseline set');
  }

  function summarize(d) {
    var lines = [];
    d.css.forEach(function (c) {
      var name = c.context ? c.context + ' › ' + c.selector : c.selector;
      if (c.kind === 'changed') {
        lines.push(name);
        c.decls.forEach(function (x) {
          lines.push('  ' + x.prop + ': ' + (x.to === null ? '(removed, was ' + x.from + ')' : x.to));
        });
      } else {
        lines.push('[' + c.kind + '] ' + name);
      }
      if (c.raw) lines.push('  ⟨raw⟩ ' + c.raw);
    });
    d.dom.forEach(function (n) {
      lines.push('[' + n.kind + '] ' + n.path);
      // A changed node carries an ARRAY of {name, from, to}; an added one
      // carries the whole attribute map as an object. Same field, two shapes.
      if (Array.isArray(n.attrs)) {
        n.attrs.forEach(function (a) {
          lines.push('  @' + a.name + ' = ' + (a.to === null ? '(removed)' : a.to));
        });
      } else if (n.attrs) {
        Object.keys(n.attrs).forEach(function (k) { lines.push('  @' + k + ' = ' + n.attrs[k]); });
      }
      if (n.text) lines.push('  text: ' + JSON.stringify(typeof n.text === 'string' ? n.text : n.text.to));
    });
    return lines.length ? lines.join('\n') : 'nothing changed since the baseline';
  }

  panel.addEventListener('click', function (evt) {
    var act = evt.target.dataset && evt.target.dataset.act;
    if (act === 'rebase') { rebase(); return; }
    if (act !== 'capture') return;
    if (!baseline) { say('no baseline yet', true); return; }

    var d = diff(baseline, { dom: snapDom(false), fresh: freshOnes(), css: snapCss() });
    outEl.textContent = summarize(d);
    var n = d.css.length + d.dom.length;
    if (!n) { say('nothing changed'); return; }

    say('saving…');
    fetch('/__inspect-save', {
      method: 'POST',
      body: JSON.stringify({ url: location.href, viewport: [innerWidth, innerHeight], diff: d }),
    })
      .then(function (r) { return r.ok ? r.text() : r.text().then(function (t) { throw new Error(t); }); })
      .then(function (where) { say(n + ' change(s) → ' + where); })
      .catch(function (err) { say(String(err.message || err), true); });
  });

  /*
   * After load AND a settle delay.
   *
   * 2000ms rather than vinton.land's 1500: the path is built once on load and
   * again when `document.fonts.ready` resolves, because the webfonts change the
   * line metrics and therefore the document height the path is measured
   * against. Baselining between those two builds records the first one and
   * reports the second as an edit.
   */
  say('waiting for the page to settle…');
  window.addEventListener('load', function () { setTimeout(rebase, 2000); });
})();
