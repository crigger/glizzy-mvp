// ───── Glizzy-window sections: draggable windows with bounds + reset ──────
// Per section: GSAP Draggable on .window-wrapper-inner, bounded by the sticky
// .window-bounds-inner. ScrollTrigger watches the section so we can disable +
// reset the drag position when it leaves view, and re-enable on enter.
// The chrome bar is the whole interface: a label you can grab. There is nothing
// to press and nothing to resize.
//
// Two things used to let the window be thrown off the screen, and both are
// fixed here:
//
//   1. Draggable's `bounds` measure the TARGET element, so the target and the
//      visible panel have to stay the same size. Neither the corner resize
//      handles nor the maximize button respected that. Both are gone; anything
//      added later that resizes the panel has to re-apply the bounds.
//   2. The arena was a sticky element inset from the section, which meant it
//      stopped sticking BEFORE the panel did — 45% through a section its top
//      had scrolled to -59 while the panel's was still at 133, and the window
//      could follow it off the top. The arena is now computed from the live
//      viewport on every press, which cannot drift out of step with anything.
//
// NOT DRAGGABLE ON A PHONE. Below 768 the Draggable is never enabled: there is
// no cursor to signal "grab me", the panel already fills most of the screen so
// there is nowhere to drag it to, and the `touch-action: none` the handle needs
// would stop a swipe on the chrome bar from scrolling the page. windows.scss
// withholds the affordances at the same breakpoint.
/*
 * The one breakpoint, shared with windows.scss and with DESKTOP_BREAK in
 * glizzy-path.js. A live MediaQueryList rather than a one-shot innerWidth read,
 * so rotating a tablet or dragging a window across 768 is handled rather than
 * leaving a half-live Draggable behind.
 */
const canDrag = window.matchMedia('(min-width: 768px)');

document.querySelectorAll('.js-glizzy-window').forEach((section) => {
  const target  = section.querySelector('.window-wrapper-inner');
  const wrapper = section.querySelector('.window-wrapper');

  const handle  = section.querySelector('.js-drag-handle');
  if (!target) return;

  /*
   * The arena, as Draggable's own x/y limits rather than a rectangle in some
   * element's coordinate space.
   *
   * Measured fresh on each press from where the target actually is: subtract
   * the translation already applied to get its untranslated position, then work
   * out how far x and y may travel before an edge leaves the viewport.
   */
  const MARGIN = 16;
  function arena() {
    const r  = target.getBoundingClientRect();
    const x0 = drag ? drag.x : 0;
    const y0 = drag ? drag.y : 0;
    const restLeft = r.left - x0;
    const restTop  = r.top  - y0;

    const minX = MARGIN - restLeft;
    const maxX = (window.innerWidth  - MARGIN - r.width)  - restLeft;
    const minY = MARGIN - restTop;
    const maxY = (window.innerHeight - MARGIN - r.height) - restTop;

    // A panel taller or wider than the viewport has no room to travel; pin it
    // rather than handing Draggable an inverted range.
    return {
      minX: Math.min(minX, maxX), maxX: Math.max(minX, maxX),
      minY: Math.min(minY, maxY), maxY: Math.max(minY, maxY),
    };
  }

  let drag;
  [drag] = Draggable.create(target, {
    trigger: handle,            // drag only via the chrome bar (so + / − buttons still click)
    onPress() { this.applyBounds(arena()); },
    type: 'x,y',
    inertia: true,              // throw on release with momentum decay (InertiaPlugin)
    throwResistance: 1000,      // lower = drifts farther after release
    edgeResistance: 0.78,       // rubber-band resistance near the bounds while dragging
    allowEventDefault: true,
  });
  drag.disable();

  function reset() {
    // Long, gentle return — matches the reset duration crest uses, so the
    // drag→reset transition reads as gradual rather than snappy.
    gsap.to(target, { x: 0, y: 0, duration: 1.8, ease: 'power1.inOut', overwrite: 'auto' });
  }

  /*
   * On screen AND wide enough — both, every time. The ScrollTrigger below used
   * to call `enable()` directly; routing it through here is what keeps the
   * viewport check from being bypassed by a scroll.
   */
  let onScreen = false;
  function sync() {
    if (onScreen && canDrag.matches) drag.enable();
    else drag.disable();
  }

  ScrollTrigger.create({
    trigger: section,
    start: 'top bottom',
    end:   'bottom top',
    onEnter:     () => { onScreen = true;  sync(); },
    onEnterBack: () => { onScreen = true;  sync(); },
    onLeave:     () => { onScreen = false; sync(); reset(); },
    onLeaveBack: () => { onScreen = false; sync(); reset(); },
  });

  // Crossing the breakpoint mid-session: take the drag away, and put the panel
  // back where it belongs rather than leaving it wherever it was dropped.
  canDrag.addEventListener('change', () => {
    sync();
    if (!canDrag.matches) reset();
  });

});
