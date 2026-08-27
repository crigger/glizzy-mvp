/**
 * Draws each squiggle button in when it reaches the middle of the screen,
 * using the GSAP the page already loads for the dog.
 *
 * EVERY squiggle button on the page, each with its own timeline and its own
 * ScrollTrigger — there are four now (one "Acquire", three "Fine"), and they
 * are scrolled past at different moments, so they cannot share a state. This
 * used to be a `querySelector`, which silently animated the first one and left
 * the rest sitting at full weight.
 *
 * A real animation, not a scrub: it plays at its own pace on a slow in-out
 * ease. And it UNDOES itself — the line reverses whenever the button leaves the
 * viewport, so coming back to it plays the draw again rather than arriving at a
 * button that has already happened.
 *
 * Drawn from the LEFT, with the weight tied to how much is drawn.
 *
 * The thing that read as a flash was never the easing. The overhang puts the
 * path's start 64px clear of the pill, so the first mark landed in empty space
 * beside the button — and at full weight that mark is a 12px dot. A dot
 * appearing out of nowhere is a blip whatever curve you ease it on.
 *
 * So thickness now tracks length off the SAME eased progress: thin while the
 * line is short, thick once it is long. The first mark is a hairline tick
 * rather than a blob, and by the time the stroke is heavy there is a long line
 * carrying it.
 *
 * THE UNDRAWN STATE IS SET FROM JS, NEVER FROM CSS. If this file fails to load,
 * or GSAP is missing, the button must still be a fully drawn, clickable button —
 * a dash offset baked into the stylesheet would leave an invisible link.
 */
(function () {
  if (typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') return;

  // Anyone who asked for less motion gets the finished buttons, immediately.
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var paths = document.querySelectorAll('.btn-acquire__wave path');
  if (!paths.length) return;
  Array.prototype.forEach.call(paths, setup);

  function setup(path) {
    /*
     * Length in USER units, which is what stroke-dasharray uses too, so the two
     * agree however `preserveAspectRatio="none"` stretches the box. The viewBox
     * is fixed, so a resize cannot invalidate it — unlike the dog's path, which
     * is rebuilt against the document height.
     */
    var len = path.getTotalLength();

    /*
     * `dasharray: d, len` with no offset shows the first d units and hides the
     * rest — a left-to-right reveal. Written this way rather than the usual
     * offset-the-whole-length trick because it makes d directly the drawn length,
     * which is what the weight below is scaled against.
     */
    function reveal(d) {
      path.style.strokeDasharray = d + ' ' + len;
      path.style.strokeDashoffset = 0;
    }
    reveal(0);

    /*
     * `stroke-linecap: round` renders a ZERO-LENGTH dash as a full dot, so with
     * the whole path offset away a mustard blob still sat beside the button
     * before anything had been drawn — measured 23,631 mustard pixels at 0%.
     * Butt caps would fix it and cost the round ends, which are the whole look.
     *
     * So the path is simply not painted at zero. A dot on the first frame is
     * right anyway: that is the pen touching down. This has to run on the TWEEN
     * rather than on the ScrollTrigger, because the tween now has a life of its
     * own — it keeps animating after the trigger has fired, and it reverses.
     */
    function gate() {
      path.style.visibility = draw.progress() > 0 ? 'visible' : 'hidden';
    }

    // One eased number drives both the length and the weight, so they cannot
    // drift out of step with each other.
    var run = { p: 0 };
    var MIN_WEIGHT = 0.08;   // a hairline at the moment the pen lands

    var wave = path.closest('.btn-acquire__wave');

    var draw = gsap.timeline({ paused: true, onUpdate: gate, onReverseComplete: gate })
      .to(run, {
        p: 1,
        duration: 1.8,
        ease: 'power2.inOut',
        onUpdate: function () {
          reveal(len * run.p);
          wave.style.setProperty('--wave-grow', MIN_WEIGHT + (1 - MIN_WEIGHT) * run.p);
        },
      });
    gate();

    ScrollTrigger.create({
      trigger: path.closest('.acquire-break'),
      // Fires when the button's top reaches the middle of the screen; `end` is
      // where it has left the top entirely, which is what "out of viewport"
      // means on the way down.
      start: 'top 50%',
      end: 'bottom top',
      onEnter: function () { draw.play(); },
      onLeave: function () { draw.reverse(); },
      onEnterBack: function () { draw.play(); },
      onLeaveBack: function () { draw.reverse(); },
    });
  }
})();
