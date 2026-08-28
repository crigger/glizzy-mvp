/**
 * The dog: one long SVG path drawn down the page on scroll.
 *
 * Was an inline <script> in index.html until the Astro port. It is a classic
 * script, not a module, because it reads the GSAP globals registered by the
 * four vendored files loaded ahead of it — load order is the contract.
 *
 * Runs the debug panel's controls too. That panel is dev-only markup, so every
 * lookup into it has to tolerate null; see wire().
 */
gsap.registerPlugin(ScrollTrigger, Draggable, InertiaPlugin);
// Prevent mobile URL-bar show/hide from re-triggering the path animation.
ScrollTrigger.config({ ignoreMobileResize: true });

// Parse a CSS color string into {r,g,b} floats in [0,1] + a p3 flag.
// Handles #rrggbb, rgb()/rgba(), and color(display-p3 r g b) — which is what
// getComputedStyle returns when the @supports block kicks in on Safari/Chrome.
function parseColor(s) {
  s = (s || '').trim();
  let m;
  if (s[0] === '#') {
    const v = parseInt(s.slice(1), 16);
    return { r: ((v >> 16) & 0xff) / 255, g: ((v >> 8) & 0xff) / 255, b: (v & 0xff) / 255, p3: false };
  }
  if ((m = s.match(/color\(display-p3\s+([\d.+-eE]+)\s+([\d.+-eE]+)\s+([\d.+-eE]+)/i))) {
    return { r: +m[1], g: +m[2], b: +m[3], p3: true };
  }
  if ((m = s.match(/rgba?\(\s*([\d.]+)\D+([\d.]+)\D+([\d.]+)/))) {
    return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, p3: false };
  }
  return { r: 0, g: 0, b: 0, p3: false };
}

// Linear interpolation between two CSS colors at t in [0, 1].
// Emits color(display-p3 ...) if either input was P3, else #rrggbb.
function lerpColor(aStr, bStr, t) {
  const a = parseColor(aStr);
  const b = parseColor(bStr);
  const r  = a.r + (b.r - a.r) * t;
  const g  = a.g + (b.g - a.g) * t;
  const bl = a.b + (b.b - a.b) * t;
  if (a.p3 || b.p3) {
    return `color(display-p3 ${r.toFixed(4)} ${g.toFixed(4)} ${bl.toFixed(4)})`;
  }
  const to8 = v => Math.max(0, Math.min(255, Math.round(v * 255)));
  return '#' + [to8(r), to8(g), to8(bl)].map(v => v.toString(16).padStart(2, '0')).join('');
}

// ---------- tuning knobs (live via debug panel) ----------
let TOP_MARGIN_VMIN     = 50;    // empty space above the top of the dog cap (in vmin)
let TOP_MARGIN_MAX_VH   = null;  // and never more than this many vh — see ASPECT_PRESETS
let DOG_HEIGHT_VMIN     = 120;   // visible top dog at load: cap + stub stroke (in vmin)
let SCROLL_TRIGGER_VMIN = 100;   // scrollY (in vmin) before draw fires
let END_STUB_VMIN       = 75;    // height of the bottom vertical stub: end cap + stroke (in vmin)
let END_MARGIN_VMIN     = 100;   // empty space below the end cap (in vmin)
let STROKE_VW           = 0.5;   // stroke as fraction of VIEWPORT WIDTH
let UTURN_RATIO         = 0.75;  // U-turn radius as multiple of stroke width (≥0.5 = no self-intersection)
let UTURN_BLEED_VW      = 0.20;  // extra horizontal overflow as fraction of vw
let BODY_VH             = 800;   // desired body min-height in svh (page extends past this if needed)

// Breakpoint defaults for stroke width — both desktop and mobile use 50vw now.
const DESKTOP_BREAK     = 768;
const STROKE_VW_DESKTOP = 0.5;
const STROKE_VW_MOBILE  = 0.5;

let currentBreakpoint = null;

// Aspect-ratio presets. Landscape (wider-than-tall) needs a tighter top margin
// and shorter stubs/margins than portrait, otherwise the dog has too much air.
//
// `topMarginMaxVh` caps the top margin against the viewport's HEIGHT, and only
// portrait sets one. The margin is measured in vmin, which in portrait is the
// WIDTH — so how long you scroll through empty navy before the dog shows up is
// set by how wide the window is, which is the wrong variable. On a 390px phone
// 200vmin lands the artwork 1.04 screens down, which is right; at 768 wide the
// same number puts it 1.69 screens down, and on a wide portrait window further
// still. The cap leaves phones exactly where they were and pulls the wide cases
// back in line. Landscape has no cap — its margin is already tuned against a
// vmin that IS the height there.
const ASPECT_PRESETS = {
  portrait:  { topMargin: 200, dogHeight: 120, trigger: 210, endStub: 75, endMargin: 100, topMarginMaxVh: 95 },
  landscape: { topMargin: 135, dogHeight: 140, trigger: 280, endStub: 50, endMargin:  50, topMarginMaxVh: null },
};
let currentAspect = null;

function applyAspectPreset(aspect) {
  const p = ASPECT_PRESETS[aspect];
  TOP_MARGIN_VMIN     = p.topMargin;
  TOP_MARGIN_MAX_VH   = p.topMarginMaxVh;
  DOG_HEIGHT_VMIN     = p.dogHeight;
  SCROLL_TRIGGER_VMIN = p.trigger;
  END_STUB_VMIN       = p.endStub;
  END_MARGIN_VMIN     = p.endMargin;
  // Sync sliders + outputs so the GUI mirrors the active preset.
  const pairs = [
    ['ctrl-topmargin',     'out-topmargin',     p.topMargin],
    ['ctrl-dogheight',     'out-dogheight',     p.dogHeight],
    ['ctrl-scrolltrigger', 'out-scrolltrigger', p.trigger],
    ['ctrl-endstub',       'out-endstub',       p.endStub],
    ['ctrl-endmargin',     'out-endmargin',     p.endMargin],
  ];
  for (const [ctrl, out, val] of pairs) {
    const slider = document.getElementById(ctrl);
    const o      = document.getElementById(out);
    if (slider) slider.value     = val;
    if (o)      o.textContent    = val;
  }
}
// ---------------------------------------------------------

const svg = document.getElementById('glizzy');
let mainPath = null;
let pathLen = 0;
let stubPathLen = 0;
let st = null;            // current ScrollTrigger
let state = {};           // last-built dimensions

function buildPath() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Auto-reset STROKE_VW when crossing the desktop/mobile breakpoint.
  const newBp = vw >= DESKTOP_BREAK ? 'desktop' : 'mobile';
  if (newBp !== currentBreakpoint) {
    STROKE_VW = newBp === 'desktop' ? STROKE_VW_DESKTOP : STROKE_VW_MOBILE;
    const slider = document.getElementById('ctrl-stroke');
    const out    = document.getElementById('out-stroke');
    if (slider) slider.value = Math.round(STROKE_VW * 100);
    if (out)    out.textContent = Math.round(STROKE_VW * 100);
    currentBreakpoint = newBp;
  }

  // Auto-swap layout preset when the viewport crosses portrait ↔ landscape.
  const newAspect = vw >= vh ? 'landscape' : 'portrait';
  if (newAspect !== currentAspect) {
    applyAspectPreset(newAspect);
    currentAspect = newAspect;
  }

  // Stroke takes up half the viewport (both desktop and mobile).
  const strokeWidth = vw * STROKE_VW;
  const naturalR    = strokeWidth * UTURN_RATIO;
  let   R           = naturalR;   // may flex a few % to land on a marker; see below
  const halfStroke  = strokeWidth / 2;
  const vmin        = Math.min(vw, vh);

  // Dimensions in vmin units
  const topMargin   = Math.min(
    (TOP_MARGIN_VMIN / 100) * vmin,
    TOP_MARGIN_MAX_VH == null ? Infinity : (TOP_MARGIN_MAX_VH / 100) * vh
  );
  const dogHeight   = (DOG_HEIGHT_VMIN     / 100) * vmin; // total top dog (cap + stroke)
  const endStubH    = (END_STUB_VMIN       / 100) * vmin; // total end stub (cap + stroke)
  const endMargin   = (END_MARGIN_VMIN     / 100) * vmin; // empty space below end cap

  // Stub Y coords. Cap occupies (stubStartY - halfStroke) → stubStartY, so for cap top at y=topMargin:
  //   stubStartY = topMargin + halfStroke
  // The "dog height" is measured from cap top to stroke end, so:
  //   stubEndY = topMargin + dogHeight
  const stubStartY = topMargin + halfStroke;
  const stubEndY   = topMargin + dogHeight;
  const stubLength = stubEndY - stubStartY;
  // End stub stroke length (excludes end cap, which auto-extends below by halfStroke)
  const endStubStrokeLen = endStubH - halfStroke;

  //
  // ───── where the dog stops, and fitting whole rows to it ────────────────
  //
  // An element marked `data-dog-end` ends the journey at its TOP. With no
  // marker the dog runs to the bottom of `main`, as it always did.
  const endMarker = document.querySelector('[data-dog-end]');
  const mainEl    = document.querySelector('main');
  const pageYOff  = window.scrollY || window.pageYOffset;
  const contentBottom = endMarker
    ? endMarker.getBoundingClientRect().top + pageYOff
    : mainEl
      ? mainEl.getBoundingClientRect().bottom + pageYOff
      : 0;
  const desiredPageH = Math.max((BODY_VH / 100) * vh, contentBottom);

  // Everything in the page height that is NOT a function of R.
  const fixedNoArc = stubEndY + endStubStrokeLen + halfStroke + endMargin;
  // pageH = fixedNoArc + 2R (top transition + closing arc) + numRows × 2R
  //       = fixedNoArc + 2R × (numRows + 1)
  const spanFor = (n, r) => fixedNoArc + 2 * r * (n + 1);

  /*
   * Rows must be ODD so the loop exits going RIGHT, which is what the closing
   * arc and the right-side end stub are drawn for. That makes the row count
   * step in TWOS, and a row is 2R — so the page height is quantised to 4R,
   * which at desktop is about 1700px. Against a marker that is brutal: the
   * nearest legal heights measured 1698px short of the target and 849px past
   * it, with nothing in between.
   *
   * So when there IS a marker, pick the closest odd row count and then solve R
   * for an exact fit. R is the U-turn radius AND the row pitch, so a few
   * percent either way just makes the turns very slightly rounder or tighter —
   * far less visible than a dog that stops a screen and a half early.
   *
   * The tolerance is a guard, not a preference: on a short page the exact-fit R
   * can be wildly off, and a dog with the wrong proportions is worse than one
   * that ends in the wrong place. Outside it, fall back to the old behaviour —
   * round DOWN to odd, so at least the marker is never crossed.
   */
  let numRows;
  if (endMarker) {
    const ideal = (desiredPageH - fixedNoArc) / (2 * naturalR) - 1;
    numRows = Math.max(1, Math.round(ideal));
    if (numRows % 2 === 0) {
      // Step to whichever odd neighbour lands closer to the marker.
      const lo = Math.max(1, numRows - 1), hi = numRows + 1;
      numRows = Math.abs(desiredPageH - spanFor(lo, naturalR))
              <= Math.abs(desiredPageH - spanFor(hi, naturalR)) ? lo : hi;
    }
    const fitR = (desiredPageH - fixedNoArc) / (2 * (numRows + 1));
    const drift = Math.abs(fitR - naturalR) / naturalR;
    if (fitR > 0 && drift <= 0.12) {
      R = fitR;
    } else {
      numRows = Math.floor((desiredPageH - fixedNoArc) / (2 * naturalR)) - 1;
      if (numRows % 2 === 0) numRows -= 1;
      if (numRows < 1) numRows = 1;
    }
  } else {
    numRows = Math.floor((desiredPageH - fixedNoArc - 2 * naturalR) / (2 * naturalR));
    if (numRows < 1) numRows = 1;
    if (numRows % 2 === 0) numRows += 1;
  }

  // Stub centerline at vw - halfStroke so the stroke hugs the right edge fully visible.
  const stubX  = vw - halfStroke;
  // Allow centerline to extend past viewport edges if U-turn radius needs more room.
  // First H length = (vw - halfStroke - R) - (leftX + R) = vw - halfStroke - 2R - leftX
  const overflow = Math.max(UTURN_BLEED_VW * vw, 2 * R + halfStroke - vw);
  const leftX  = -overflow;
  const rightX = vw + overflow;

  // Page-height math. Total page = (top dog) + 2R (top trans arc + closing arc) + (N rows × 2R)
  //                                + endStubStrokeLen + halfStroke (end cap) + endMargin
  // Solve for N to fit MAX(user's desired body height, actual rendered content). The
  // content measurement (main's bounding rect bottom in document coords) is unaffected
  // by the body min-height we set ourselves, so it reflects the true natural extent —
  // important for catching font-swap reflow, dynamic content, etc.
  // The page height these rows actually produce.
  const pageH = spanFor(numRows, R);
  /*
   * `min-height`, so this is a floor and never a ceiling: with a marker, pageH
   * is shorter than the document and this does nothing, which is the point.
   * Without one it is what holds the page open to BODY_VH on a short route.
   *
   * It used to be the reason for a stretch of empty navy under the last
   * section — pageH is quantised to whole rows and rounded UP, so it could
   * stand taller than the content and pin the body there. `main`'s 30svh
   * bottom padding was hiding that gap rather than closing it.
   */
  document.body.style.minHeight = `${pageH}px`;

  // Build path:
  //   1) Top stub (vertical down the right side)
  //   2) 90° transition arc into first horizontal
  //   3) N switchback rows (alternating H + U-turn)
  //   4) Final H going RIGHT
  //   5) 90° closing arc into vertical-down
  //   6) End stub (vertical down)
  let d = `M ${stubX} ${stubStartY} V ${stubEndY}`;
  d += ` a ${R} ${R} 0 0 1 -${R} ${R}`;
  let y = stubEndY + R;
  let goingLeft = true;

  for (let i = 0; i < numRows; i++) {
    if (goingLeft) {
      d += ` H ${leftX + R}`;
      d += ` a ${R} ${R} 0 0 0 0 ${2 * R}`;
    } else {
      d += ` H ${rightX - R}`;
      d += ` a ${R} ${R} 0 0 1 0 ${2 * R}`;
    }
    y += 2 * R;
    goingLeft = !goingLeft;
  }
  // After ODD rows, goingLeft = false (heading RIGHT). Final H ends at (vw - halfStroke - R).
  d += ` H ${vw - halfStroke - R}`;
  // Closing 90° arc: RIGHT → DOWN, ending at (vw - halfStroke, y + R) i.e. same x as top stub.
  d += ` a ${R} ${R} 0 0 1 ${R} ${R}`;
  y += R;
  // End stub vertical (the round end cap auto-extends halfStroke below this final V).
  const endStubStartY = y;
  const endStubEndY = y + endStubStrokeLen;
  d += ` V ${endStubEndY}`;

  state = { vw, vh, vmin, pageH, strokeWidth, R, stubLength, stubStartY, topMargin, leftX, rightX, numRows, endStubStrokeLen, endStubStartY, endStubEndY, breakpoint: newBp };
  return { d, strokeWidth, stubLength, pageH, vw };
}

function rebuild() {
  const { d, strokeWidth, stubLength, pageH, vw } = buildPath();

  // Size the SVG to match the page
  svg.setAttribute('viewBox', `0 0 ${vw} ${pageH}`);
  svg.setAttribute('width',  vw);
  svg.setAttribute('height', pageH);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.height = `${pageH}px`;

  // Rebuild the SVG contents.
  svg.innerHTML = '';
  const ns = 'http://www.w3.org/2000/svg';

  const dogColor     = getComputedStyle(document.documentElement).getPropertyValue('--dog-color').trim()     || '#dc512a';
  const highlightCol = getComputedStyle(document.documentElement).getPropertyValue('--dog-highlight').trim() || '#f4a685';

  // Stack N stroked paths with interpolated width AND color from outer→inner.
  // Each successive path covers the previous one with a narrower, lighter ring,
  // creating a smooth banded gradient without any raster filter cost.
  // The interpolation parameter `t` is passed through a smoothstep ease so the
  // bands cluster near the outer edge and the inner highlight, with a smoother,
  // faster transition through the middle — same trick as easing a CSS linear
  // gradient (https://css-tricks.com/easing-linear-gradients/) but applied to
  // the stop *positions* instead of the color stops directly.
  const STEPS = 48;
  const allPaths = [];
  for (let i = 0; i < STEPS; i++) {
    const t      = i / (STEPS - 1);                     // 0 at outer, 1 at center
    const eased  = t * t * (3 - 2 * t);                 // smoothstep ease-in-out
    const w      = strokeWidth * (1 - eased * 0.92);    // 100% → 8% of stroke
    const stroke = lerpColor(dogColor, highlightCol, eased);

    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('stroke', stroke);
    p.setAttribute('stroke-width', w);
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    p.setAttribute('fill', 'none');
    svg.appendChild(p);
    allPaths.push(p);
  }
  const main = allPaths[0];        // outer-most reference for length/debug

  mainPath = main; // primary reference for path length / debug
  pathLen = main.getTotalLength();
  stubPathLen = stubLength;

  // Initial dasharray/offset on every stacked path so the whole gradient draws together.
  for (const p of allPaths) {
    p.style.strokeDasharray  = pathLen;
    p.style.strokeDashoffset = pathLen - stubPathLen;
  }

  // ScrollTrigger: fire after the user has scrolled `SCROLL_TRIGGER_VMIN` of vmin.
  // End is anchored to the PATH's end (not body bottom), so the animation completes at a
  // scroll position reachable in BOTH URL-bar-visible AND URL-bar-hidden states on mobile.
  //
  // `state.vh` — the innerHeight the path was BUILT against — not the live
  // value. The path geometry, the svh-sized sections and this mapping all
  // agree at build time; on iOS Safari the URL bar then collapses mid-scroll
  // and innerHeight grows ~100px, so any refresh re-evaluating this function
  // against the live value shifted the scrub away from the geometry the rest
  // of the page was laid out on. ~100px of scroll is several hundred px of
  // ARC (the path zigzags, so arc outruns scroll ~3x) — enough that the drawn
  // front missed the pinned windows it crosses everywhere the viewport is
  // honest: the installed PWA, desktop, Android.
  //
  // Reachability, since the built vh is the SMALLER bar-visible one and a
  // smaller vh pushes `end` further down: end must stay under docH minus the
  // live innerHeight. On iOS the live value only ever grows past the built
  // one, and body min-height quantises UP past endStubEndY (see buildPath),
  // so the clearance holds — measured 660px at 430x663 and 663px at 430x932.
  if (st) st.kill();
  const tween = gsap.fromTo(allPaths,
    { strokeDashoffset: pathLen - stubPathLen },
    {
      strokeDashoffset: 0,
      ease: 'none',
      scrollTrigger: {
        start: () => (SCROLL_TRIGGER_VMIN / 100) * Math.min(window.innerWidth, window.innerHeight),
        end:   () => state.endStubEndY - state.vh,
        scrub: 0.5,
        invalidateOnRefresh: true,
      }
    }
  );
  st = tween.scrollTrigger;

  updateDebug();
}

function updateDebug() {
  const dbg = document.getElementById('debug');
  if (!dbg) return;
  const docH = document.documentElement.scrollHeight;
  const maxScroll = docH - window.innerHeight;
  const offset = parseFloat(mainPath?.style.strokeDashoffset || 0);
  const drawn = pathLen - offset;
  const pct = pathLen ? (drawn / pathLen * 100).toFixed(1) : '0.0';
  const mode = state.breakpoint === 'desktop' ? 'desktop' : 'mobile';
  const hLen = (state.rightX - state.leftX) - 2 * state.R;
  const triggerPx = (SCROLL_TRIGGER_VMIN / 100) * (state.vmin || 0);
  const bgTop  = document.getElementById('ctrl-bgtop')?.value     || '';
  const bgBot  = document.getElementById('ctrl-bgbottom')?.value  || '';
  const dCol   = document.getElementById('ctrl-dogcolor')?.value  || '';
  const dHi    = document.getElementById('ctrl-doghi')?.value     || '';
  const s3     = window.glizzy3D?.getStats?.();
  const block3D = s3 ?
`
---
3D: RADIUS=${s3.RADIUS} LENGTH=${s3.LENGTH} TILT_X=${s3.TILT_X_deg}° TILT_Z=${s3.TILT_Z_deg}°
SPIN=${s3.SPIN.toFixed(2)} ROUGH=${s3.ROUGH.toFixed(2)}
LUMP_AMP=${s3.LUMP_AMP.toFixed(3)} LUMP_FREQ=${s3.LUMP_FREQ.toFixed(1)} LUMP_SEED=${s3.LUMP_SEED}
NOTCH_AMP=${s3.NOTCH_AMP.toFixed(3)} NOTCH_POINTS=${s3.NOTCH_POINTS} NOTCH_SHARP=${s3.NOTCH_SHARP} CAP_FULL=${s3.CAP_FULL.toFixed(2)}
key=(${s3.keyX.toFixed(1)}, ${s3.keyY.toFixed(1)}, ${s3.keyZ.toFixed(1)}) @ ${s3.keyI.toFixed(2)}
ambient=${s3.ambI.toFixed(2)}  rim=${s3.rimI.toFixed(2)}` : '';
  dbg.textContent =
`viewport     ${state.vw} x ${state.vh}   vmin=${state.vmin?.toFixed(0)}  (${mode})
docHeight    ${docH}  (maxScroll=${maxScroll})
scrollY      ${window.scrollY}  (trigger=${triggerPx.toFixed(0)})
stroke       ${state.strokeWidth?.toFixed(0)}   R=${state.R?.toFixed(0)}
top margin   ${state.topMargin?.toFixed(0)}  stub y: ${state.stubStartY?.toFixed(0)}
centerline   x: ${state.leftX?.toFixed(0)} → ${state.rightX?.toFixed(0)}  H-length: ${hLen.toFixed(0)}
top stub     ${state.stubLength?.toFixed(0)}px  end stub: ${state.endStubStrokeLen?.toFixed(0)}px
rows         ${state.numRows}  path: ${pathLen.toFixed(0)}
stub pathlen ${stubPathLen.toFixed(0)} (${pathLen ? (stubPathLen/pathLen*100).toFixed(1) : 0}% of path)
dashoffset   ${offset.toFixed(0)}  →  drawn ${drawn.toFixed(0)} (${pct}%)
TOP_MARGIN=${TOP_MARGIN_VMIN}vmin  DOG_HEIGHT=${DOG_HEIGHT_VMIN}vmin  TRIGGER=${SCROLL_TRIGGER_VMIN}vmin
END_STUB=${END_STUB_VMIN}vmin  END_MARGIN=${END_MARGIN_VMIN}vmin
STROKE_VW=${STROKE_VW.toFixed(3)}  UTURN_RATIO=${UTURN_RATIO}  BODY_VH=${BODY_VH}
---
colors: bg-top=${bgTop} bg-bot=${bgBot} dog=${dCol} highlight=${dHi}${block3D}`;
}

// Wire up sliders
function wire(id, outId, parse, setter) {
  const el  = document.getElementById(id);
  const out = document.getElementById(outId);
  // The debug panel is dev-only markup. In a production build every one of
  // these is null, and an unguarded `out.textContent` here would throw before
  // the initial rebuild() below ever runs — i.e. no dog at all on the live
  // site. Absent controls are the normal case, not the exception.
  if (!el || !out) return;
  out.textContent = el.value;
  el.addEventListener('input', () => {
    setter(parse(el.value));
    out.textContent = el.value;
    rebuild();
    // Refresh all ScrollTriggers so start/end functions re-evaluate with new values.
    ScrollTrigger.refresh();
  });
}
wire('ctrl-topmargin',     'out-topmargin',     parseFloat, v => TOP_MARGIN_VMIN     = v);
wire('ctrl-dogheight',     'out-dogheight',     parseFloat, v => DOG_HEIGHT_VMIN     = v);
wire('ctrl-scrolltrigger', 'out-scrolltrigger', parseFloat, v => SCROLL_TRIGGER_VMIN = v);
wire('ctrl-endstub',       'out-endstub',       parseFloat, v => END_STUB_VMIN       = v);
wire('ctrl-endmargin',     'out-endmargin',     parseFloat, v => END_MARGIN_VMIN     = v);
wire('ctrl-stroke',        'out-stroke',        parseFloat, v => STROKE_VW           = v / 100);
wire('ctrl-uturn',         'out-uturn',         parseFloat, v => UTURN_RATIO         = v);
wire('ctrl-bleed',         'out-bleed',         parseFloat, v => UTURN_BLEED_VW      = v / 100);
wire('ctrl-body',          'out-body',          parseFloat, v => BODY_VH             = v);

// Collapsible debug panel (collapsed on load — see <div class="collapsed"> on the panel)
document.getElementById('debug-head')?.addEventListener('click', () => {
  const panel = document.getElementById('debug-panel');
  panel.classList.toggle('collapsed');
  const chev = panel.querySelector('.chev');
  chev.textContent = panel.classList.contains('collapsed') ? '+' : '−';
});

// Tabbed panel switcher
document.querySelectorAll('#debug-panel .tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('#debug-panel .tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('#debug-panel .tab-content').forEach(c => c.classList.toggle('hidden', c.dataset.tab !== target));
  });
});

// iOS Safari blocks navigator.clipboard.writeText over plain HTTP. Use the
// execCommand fallback (works without HTTPS) and only try the modern API
// when it's actually available.
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  // iOS Safari refuses to copy from elements that are display:none, visibility:hidden,
  // or opacity:0. Position it off-screen instead. Also needs contentEditable+focus+
  // setSelectionRange OR a Range/Selection — we set both, since iOS versions differ.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.readOnly = true;
  ta.contentEditable = 'true';
  ta.style.position = 'absolute';
  ta.style.left = '-9999px';
  ta.style.top = (window.pageYOffset || document.documentElement.scrollTop) + 'px';
  ta.style.fontSize = '16px';   // prevents iOS zoom-on-focus
  document.body.appendChild(ta);
  ta.focus();
  const range = document.createRange();
  range.selectNodeContents(ta);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  ta.setSelectionRange(0, 999999);
  try { document.execCommand('copy'); } catch {}
  sel.removeAllRanges();
  document.body.removeChild(ta);
}
document.getElementById('copy-stats')?.addEventListener('click', () => {
  const btn = document.getElementById('copy-stats');
  copyText(document.getElementById('debug').textContent);
  const old = btn.textContent;
  btn.textContent = 'copied!';
  setTimeout(() => { btn.textContent = old; }, 1000);
});

// Initial build (run after GSAP is loaded; both scripts above run synchronously before this)
rebuild();
window.addEventListener('scroll', updateDebug, { passive: true });

// Font-swap reflow: when our woff2 files finish loading the line metrics shift,
// content height changes. Rebuild + refresh ScrollTrigger so the path covers
// the new natural content extent.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    rebuild();
    ScrollTrigger.refresh();
  });
}

// Rebuild on resize, but ignore mobile URL-bar height changes — only width changes
// (or sufficiently large height changes) trigger a rebuild.
let resizeTimer;
let lastBuildVW = window.innerWidth;
let lastBuildVH = window.innerHeight;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const widthChanged  = Math.abs(w - lastBuildVW) > 4;
    const heightJumped  = Math.abs(h - lastBuildVH) > 200; // bigger than URL bar height
    const aspectFlipped = (w >= h) !== (lastBuildVW >= lastBuildVH);
    if (widthChanged || heightJumped || aspectFlipped) {
      lastBuildVW = w;
      lastBuildVH = h;
      rebuild();
    }
  }, 200);
});
