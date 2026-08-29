# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project overview

**Glizzy Store** — a hot dog, at length. **Astro 7**, Sass, GSAP and three.js,
deployed to Netlify at `glizzy-mvp.netlify.app`. It will sell through
vinton.land's Shopify store via its own headless storefront; see **The shop**.

It was one hand-written 96KB `index.html` until 2026-08-26. That file is kept
at `assets/pre-astro-index.html` as the reference the port was checked against —
it is not built, not served, and can go once nobody wants to diff against it.

## Build

- **Install:** `npm install`
- **Dev:** `npm run dev` (port 3334) · `npm run dev:lan` to reach it from a phone
- **Build:** `npm run build` → `dist/`
- **Preview:** `npm run preview`

Build settings live in **`netlify.toml`**, not the Netlify UI, and `NODE_VERSION
= "22"` is one of them: Astro 7 needs Node ≥ 22.12 and Netlify's image defaults
to 18, which does not fail — it prints a wall of `EBADENGINE` warnings and
carries on.

`compressHTML: true` is pinned. Astro 7 defaults it to `'jsx'`, which strips
whitespace by JSX rules and deletes the space before an inline element written
on its own line. These are hand-authored HTML templates, not JSX.

**Comments in `.astro` files must be `{/* … */}`, never `<!-- … -->`.** Astro
ships HTML comments to the page.

## The CSS minifier deleted a property, and nothing said so

`.window` has `backdrop-filter: blur(14px)`. The source used to declare the
standard property *and* `-webkit-backdrop-filter` next to it, as everyone does.
The minifier reads a prefixed/unprefixed pair as one property, keeps whichever
spelling it thinks the browser targets need — and kept the `-webkit-` one, which
**Chrome no longer implements**. The built page had no blur while the source
plainly asked for one. No warning, valid stylesheet, just a missing line.

Two things follow, and both are load-bearing:

- **`vite.build.cssTarget` in `astro.config.mjs` names the browsers**
  (`chrome111`, `safari15`). That is what makes the minifier emit both
  spellings: Safari below 18 needs the prefix, Chrome needs the standard
  property. Removing it puts the bug straight back.
- **Write the unprefixed property only.** The prefixed copy is added at build
  time from those targets. Adding it back by hand recreates the pair that got
  collapsed.

This was caught by pixel-diffing the port against the old page, not by reading
the CSS. It is the only difference the diff ever found.

## Architecture

One route, `/`. `Layout.astro` is the document shell; `src/pages/index.astro`
composes the sections. Components are one per section
(`HeroSection`, `IntroCta`, `GlizzyWindow`, `GlizzyRepeat`, `FontSamples`),
plus `SiteIcon`/`GlizzyMark` for the fixed brand mark and `DebugPanel`.

`FontSamples` is a working type reference that happens to be on the homepage
because the old file had it there. If it stays it wants its own route.

### Two kinds of script, and why

**`public/js/*.js` are classic scripts** loaded by `<script is:inline src defer>`
in load order: `gsap`, `ScrollTrigger`, `Draggable`, `InertiaPlugin`, then
`glizzy-path.js` and `glizzy-windows.js`. They read the GSAP globals, so the
order is the contract. The four GSAP files are **vendored from the `gsap`
devDependency into `public/js/` and committed** — Netlify builds with
`NODE_ENV=production` and does not install devDependencies, so a build-time copy
step would find nothing.

**`src/scripts/hero-dog.js` is a real module**, imported from the Layout so Vite
bundles it. three.js came from a jsdelivr importmap before; it is an npm
dependency now and the page contacts **no third-party origin at runtime**.

`glizzy-path.js` and `glizzy-windows.js` were one `<script>` sharing a scope.
They split cleanly — nothing in the windows code referenced the path code — and
that is worth keeping true.

### The debug panel is dev-only, and the scripts know it

`DebugPanel.astro` renders under `import.meta.env.DEV` only. It has always been
`display: none` in the stylesheet — it gets unhidden from devtools when it is
wanted — so on the live site it was ~90 lines of markup nobody could ever see.

Both scripts that read it tolerate every control being absent (`wire()`,
`wire3D()`, and the `?.` on each panel button). **This is not optional
defensiveness.** Unguarded, the first null read throws partway through
evaluation — in `glizzy-path.js` that is before the initial `rebuild()`, i.e.
no dog at all on the live site. Adding a control needs no new guard; removing
one means checking nothing reads it without `?.`.

### The window sections: the slot is not the panel

`.window-wrapper` is the sticky **slot** — a full-height box that the panel is
centred inside. `.window` is the **panel**. Keeping those two jobs apart is the
whole design, and every bug this section had came from confusing them:

- The wrapper declared `min-height: 100svh - 8rem` on desktop with nothing
  binding the panel to it, so the panel shrink-wrapped and left the bottom 40%
  of the viewport as dead navy. The mobile `max-height: 50svh` was ignored the
  same way — the panel measured 65% of the viewport straight through it.
- The corner-resize handles sized the **wrapper**. Width happened to work (the
  panel is a block child and inherits it); height did not, because the panel had
  no height bound to the wrapper. Half the gesture was a silent no-op. They size
  `.window` now, and the wrapper must keep its own height or the panel loses
  what it is centred in.
- `is-maximized` only nudged `max-height` on a panel that was content-height
  anyway, so pressing **+** on desktop did very nearly nothing. It sets `height`
  now.

The panel's cap is written out (`calc(100svh - 8rem)`) rather than
`max-height: 100%`: the flex item between it and the slot is auto-height, and a
percentage max-height against an auto-height parent resolves to `none`. That is
exactly how the old cap stopped meaning anything.

**`touch-action: none` belongs only on things that consume a drag** — the chrome
bar and the resize corners. It was on `.window-wrapper-inner`, which wraps the
whole panel: 65% of a phone screen, three sections running, all of it dead to
scrolling. Measured before the fix, a swipe over the panel moved the page **0px**
while the same swipe beside it moved **359px** — and it dragged nothing either,
since Draggable's trigger is only the chrome bar.

`min-height` on `section.glizzy-window` is the tuning knob for the whole
section: the window stays pinned for roughly (that value − 100svh) of scrolling.
It was 220svh — 6.6 screens for three short paragraphs — and is now 170.
Changing it also changes how much dog is drawn per screen.

**Glass panel, opaque card.** This took three goes and the third one is the
point of the design:

1. `rgba(0,0,0,0.55)` under `blur(14px)` with the copy directly on it — body
   text measured **4.19:1** over the brightest part of the dog, under the 4.5:1
   AA floor.
2. Opaque navy. Fixed the contrast (**8.69:1**) and lost the depth.
3. **Both.** The PANEL is glass — no background at all, `backdrop-filter:
   blur(6rem)`, solid `--mustard` hatch lines over it. The COPY sits on an
   opaque bone card inside it (`.window-content__inner`). Nothing readable is
   ever on the glass, so the glass is free to be as transparent and as busy as
   it likes. Card ink measures **15.28:1**.

That separation is the rule to keep: **if you put text back onto `.window`
itself, you have re-created problem 1.**

**The texture is a tiled dot screen, NOT a repeating gradient — and that is the
whole point of it.**

It was a `repeating-linear-gradient` hatch, and it banded on iOS Safari: hard
rectangles where the pattern dropped out entirely, at irregular intervals, and
different in each window. Desktop Chrome at the same DPR rendered it perfectly,
which is most of why this took so long.

Three CSS fixes were tried against that, and **none of them touched it**:

| tried | theory | outcome |
| --- | --- | --- |
| `filter: blur(1.4px)` on the hatch | sub-pixel aliasing — the panel is centred on a fractional pixel | stripe spacing sd 4.74 → 0.75 **in Chrome**. Nothing on the device. |
| a scrim under the gaps | contrast — transparent gaps show the bright dog through | evenness 1.85x → 1.08x **in Chrome**. Nothing on the device. |
| backdrop blur off / at 1rem / gone / opaque ground | tiled compositing from a 96px blur | compared on the device: **all four banded identically.** |

That last one rules out the blur, its radius and the ground, and leaves the
repeating gradient itself. The replacement is one `radial-gradient` stop tiled
by `background-size: 3px 3px` — the same screen-print texture, but a completely
different thing for the compositor to draw.

**`background` is a shorthand and resets position and size**, so
`background-position` and `background-size` must stay after it.

Two process notes, both paid for:

- **A metric improving in the engine that never showed the bug is not
  evidence.** Two confident diagnoses shipped on exactly that reasoning.
- **Inside `is:inline`, Astro ships a `<script>`'s contents verbatim.** A JSX
  `{...}` wrapper is emitted as literal text and runs nothing. That made a set
  of on-device comparison variants all render identically, and it was caught
  only by reading a computed style. Verify a dev affordance actually changes
  something before asking anyone to compare with it.

### The window sections: the slot is not the panel

`.window-wrapper` is the sticky **slot** — a full-height box that the panel is
centred inside. `.window` is the **panel**. Keeping those two jobs apart is the
whole design, and every bug this section had came from confusing them:

- The wrapper declared `min-height: 100svh - 8rem` on desktop with nothing
  binding the panel to it, so the panel shrink-wrapped and left the bottom 40%
  of the viewport as dead navy. The mobile `max-height: 50svh` was ignored the
  same way — the panel measured 65% of the viewport straight through it.
- The corner-resize handles sized the **wrapper**. Width happened to work (the
  panel is a block child and inherits it); height did not, because the panel had
  no height bound to the wrapper. Half the gesture was a silent no-op. They size
  `.window` now, and the wrapper must keep its own height or the panel loses
  what it is centred in.
- `is-maximized` only nudged `max-height` on a panel that was content-height
  anyway, so pressing **+** on desktop did very nearly nothing. It sets `height`
  now.

The panel's cap is written out (`calc(100svh - 8rem)`) rather than
`max-height: 100%`: the flex item between it and the slot is auto-height, and a
percentage max-height against an auto-height parent resolves to `none`. That is
exactly how the old cap stopped meaning anything.

**`touch-action: none` belongs only on things that consume a drag** — the chrome
bar and the resize corners. It was on `.window-wrapper-inner`, which wraps the
whole panel: 65% of a phone screen, three sections running, all of it dead to
scrolling. Measured before the fix, a swipe over the panel moved the page **0px**
while the same swipe beside it moved **359px** — and it dragged nothing either,
since Draggable's trigger is only the chrome bar.

`min-height` on `section.glizzy-window` is the tuning knob for the whole
section: the window stays pinned for roughly (that value − 100svh) of scrolling.
It was 220svh — 6.6 screens for three short paragraphs — and is now 170.
Changing it also changes how much dog is drawn per screen.

**Glass panel, opaque card.** This took three goes and the third one is the
point of the design:

1. `rgba(0,0,0,0.55)` under `blur(14px)` with the copy directly on it — body
   text measured **4.19:1** over the brightest part of the dog, under the 4.5:1
   AA floor.
2. Opaque navy. Fixed the contrast (**8.69:1**) and lost the depth.
3. **Both.** The PANEL is glass — no background at all, `backdrop-filter:
   blur(6rem)`, solid `--mustard` hatch lines over it. The COPY sits on an
   opaque bone card inside it (`.window-content__inner`). Nothing readable is
   ever on the glass, so the glass is free to be as transparent and as busy as
   it likes. Card ink measures **15.28:1**.

That separation is the rule to keep: **if you put text back onto `.window`
itself, you have re-created problem 1.**

**KNOWN AND UNSOLVED: the hatch bands on iOS Safari.** Hard-edged rectangles
where it drops out entirely, at irregular intervals down the panel's margins,
different in each window. Desktop Chrome at the same DPR renders it perfectly,
which is most of why this was hard.

Three fixes were tried. **None of them touched it**, and how each failed is
worth more than the list:

| tried | theory | outcome |
| --- | --- | --- |
| `filter: blur(1.4px)` on the hatch | sub-pixel aliasing — the panel is centred on a fractional pixel | stripe spacing sd 4.74 → 0.75 **in Chrome**. Nothing on the device. |
| a scrim under the hatch | contrast — transparent gaps show the bright dog through | evenness 1.85x → 1.08x **in Chrome**. Nothing on the device. |
| backdrop blur off / at 1rem / gone / opaque ground | tiled compositing from a 96px blur | compared on the device: **all four variants banded identically.** |

The third rules out the blur, its radius, and the ground. What is left is the
`repeating-linear-gradient` itself.

**Do not attempt a fourth CSS tweak.** The next thing to try is removing the
gradient: a small tiled PNG or SVG background rasterizes once, instead of being
regenerated on every composite. Until then the panel stays exactly as captured.

Two process notes, both paid for:

- **A metric improving in the engine that never showed the bug is not
  evidence.** Two confident diagnoses shipped on exactly that reasoning.
- **Inside `is:inline`, Astro ships a `<script>`'s contents verbatim.** A JSX
  `{...}` wrapper is emitted as literal text and runs nothing. That made a set
  of on-device comparison variants all render identically, and it was caught
  only by reading a computed style. Verify a dev affordance actually changes
  something before asking anyone to compare with it.

### The window sections: the slot is not the panel

`.window-wrapper` is the sticky **slot** — a full-height box that the panel is
centred inside. `.window` is the **panel**. Keeping those two jobs apart is the
whole design, and every bug this section had came from confusing them:

- The wrapper declared `min-height: 100svh - 8rem` on desktop with nothing
  binding the panel to it, so the panel shrink-wrapped and left the bottom 40%
  of the viewport as dead navy. The mobile `max-height: 50svh` was ignored the
  same way — the panel measured 65% of the viewport straight through it.
- The corner-resize handles sized the **wrapper**. Width happened to work (the
  panel is a block child and inherits it); height did not, because the panel had
  no height bound to the wrapper. Half the gesture was a silent no-op. They size
  `.window` now, and the wrapper must keep its own height or the panel loses
  what it is centred in.
- `is-maximized` only nudged `max-height` on a panel that was content-height
  anyway, so pressing **+** on desktop did very nearly nothing. It sets `height`
  now.

The panel's cap is written out (`calc(100svh - 8rem)`) rather than
`max-height: 100%`: the flex item between it and the slot is auto-height, and a
percentage max-height against an auto-height parent resolves to `none`. That is
exactly how the old cap stopped meaning anything.

**`touch-action: none` belongs only on things that consume a drag** — the chrome
bar and the resize corners. It was on `.window-wrapper-inner`, which wraps the
whole panel: 65% of a phone screen, three sections running, all of it dead to
scrolling. Measured before the fix, a swipe over the panel moved the page **0px**
while the same swipe beside it moved **359px** — and it dragged nothing either,
since Draggable's trigger is only the chrome bar.

`min-height` on `section.glizzy-window` is the tuning knob for the whole
section: the window stays pinned for roughly (that value − 100svh) of scrolling.
It was 220svh — 6.6 screens for three short paragraphs — and is now 170.
Changing it also changes how much dog is drawn per screen.

**Glass panel, opaque card.** This took three goes and the third one is the
point of the design:

1. `rgba(0,0,0,0.55)` under `blur(14px)` with the copy directly on it — body
   text measured **4.19:1** over the brightest part of the dog, under the 4.5:1
   AA floor.
2. Opaque navy. Fixed the contrast (**8.69:1**) and lost the depth.
3. **Both.** The PANEL is glass — no background at all, `backdrop-filter:
   blur(6rem)`, solid `--mustard` hatch lines over it. The COPY sits on an
   opaque bone card inside it (`.window-content__inner`). Nothing readable is
   ever on the glass, so the glass is free to be as transparent and as busy as
   it likes. Card ink measures **15.28:1**.

That separation is the rule to keep: **if you put text back onto `.window`
itself, you have re-created problem 1.**

**`filter: blur(1.4px)` on the hatch is load-bearing. Do not remove it again.**

It was removed once, on the reasoning that crest.red only blurs its hatch to
anti-alias its own hairlines, and these lines are opaque so there is nothing to
alias against. That shipped visible banding, and it was reported from a phone
before anyone spotted it in a build.

The cause is that the panel is **vertically centred in its slot**, so its top
lands on a fractional pixel — measured at `14.796875`. Every hatch line is then
rasterized at a sub-pixel offset, each rounds differently down the strip, and a
2px-on-4px pattern beats against the device grid. Measured at 3x on a 390px
viewport, where the stripes should sit 18 device pixels apart:

```
without the blur   spacing sd 4.74   gaps ranging 2–14px
with it            spacing sd 0.75   gaps 17–19px
```

So the blur is not anti-aliasing the lines against each other — it is absorbing
the rounding error from a fractional origin. That is a more general reason than
the one crest.red gives, and it applies to any repeating gradient on a box that
is centred rather than snapped.

The two blurs are on **separate elements** for a reason: `backdrop-filter` on
`.window`, `filter` on `.window::before`. A `filter` on an element that also
carries a `backdrop-filter` blurs the composited result — i.e. the page behind
it, a second time.

**The chrome bar is a label and a grab handle, and nothing else.** No resize
corners, no maximize/restore buttons, no `.window-bounds` element — all removed
on 2026-08-26, and all three were causes of one bug: the window could be thrown
off the screen.

- Draggable's `bounds` measure the **target**. Target and panel must stay the
  same size, and neither the corner resize nor the maximize button respected
  that.
- The arena was a sticky box inset from the section, so its sticky range was
  shorter than the wrapper's. Measured 45% through a section: arena top at
  **-59** while the panel's was still at **133**. The arena had left, and the
  window could follow it.

The arena is computed from the live viewport on every `onPress` now, as
Draggable's own `minX/maxX/minY/maxY` with a 16px margin. Stress-tested by
throwing the window in six directions: every edge lands exactly on the margin.

**Anything added later that changes the panel's size must change the target's
too, or re-apply the bounds once it settles.** That is the rule the resize
handles and the maximize button both broke.

### Stacking: two traps, and the flex-item one is not in most people's model

The layering, low to high:

```
0    #glizzy (the dog's path)     2    #hero-stage (in front of the wordmark)
5    .window-wrapper              99   #debug-panel
200  .site-icon                   210  .cart-fab
300  .cart                        400  .inspect-capture
500  #hero-stage.mini             ← above everything
```

**`#hero-stage.mini` needs a clear run to the root, and it did not have one.**
It was already `z-index: 200` and still painted under the window panels at 5.
Raising it to 9999 changed nothing, because the number was never the problem:

- **`.hero-canvas-wrap` had `z-index: 2` while `position: static`.** Normally
  that is ignored — but it is a **flex item**, and per the flexbox spec a
  z-index other than `auto` creates a stacking context on a flex item even when
  static. The canvas was sealed in a level-2 box; 9999 inside it is still 2.
- **`main` had `z-index: 1`**, sealing the whole page under the cart and the
  site icon. `position: relative` alone does what it was there for: `#glizzy` is
  positioned at 0 and comes first in the document, so `main` still paints over
  it.

**The fix is which ELEMENT carries the z-index, not what it is.** Whatever
carries one becomes a stacking context, so it moved onto `#hero-stage` itself:
the canvas is both the thing that must sit in front of the wordmark (2) and the
thing that must clear everything when it pins (500), and putting it on the
canvas means the context it creates is its own.

Dropping the wrapper's z-index and stopping there is wrong and was tried:
`.hero__masthead` is absolutely positioned at `z-index: 0`, and a positioned
element paints above a static flex item whatever the source order — so the dog
went behind the letters.

**If you add a z-index anywhere between `#hero-stage` and `<html>`, the pinned
dog goes back under things.** Checked by hit-testing `elementsFromPoint` at the
canvas's own centre, not by eye:

```
hero, over the wordmark   canvas#hero-stage
mini over window panel    canvas.mini
mini over cart drawer     canvas.mini
content over #glizzy      div.window-content__inner
```

### The dog is sized off the document

`glizzy-path.js` builds one long SVG path against the document's natural height
and draws it with ScrollTrigger. **Adding or removing a section changes how much
dog is drawn per screen of scrolling.** It also rebuilds on `document.fonts.ready`,
because webfont swap moves the line metrics and therefore the content height.

Resize is filtered: width changes and aspect flips rebuild, height changes under
200px do not, because that is the mobile URL bar and rebuilding on it re-fires
the draw.

### One panel component, two kinds of window

`WindowPanel.astro` is the keyline, dot screen and bone card. Everything on the
page that looks like a window uses it, because they differ in how they are
POSITIONED and not in what they are made of:

- `GlizzyWindow` — sticky in a tall section, draggable, `draggable` prop set
- `IntroGlizzy` — static, in the flow, and no chrome bar at all

Two rules that are easy to break:

- **`draggable` is what adds `js-drag-handle`**, and that class carries
  `cursor: grab` and `touch-action: none` as well as being what
  glizzy-windows.js keys off. A static panel must never have it: the bar would
  claim to be draggable and would swallow a swipe over a strip nothing can drag.
- **A panel with no `title` gets `.window--untitled`, which turns the keyline
  navy.** The gold keyline exists to be continuous with the gold BAR — that is
  crest.red's trick, bar and border the same colour so they read as one drawn
  box. With no bar there is nothing to continue and a gold rectangle shouts over
  its own contents. Written `.window.window--untitled` so it cannot lose a
  specificity tie to `.window`.

### One gutter

`--page-gutter` (24px, 56px from 768) is set once in `vars.scss` and applied
once, on `main`. **Sections contribute no horizontal padding.**

It used to be assembled per section — `main` gave 24 and each section added its
own, 48 for most and 32 for the window ones — which put the pitch panel at 72px
and the window panels at 56px at desktop, 16px out of line. They only agreed on
mobile because both horizontal values happened to be 0 there.

### Arrows: only Bricolage has one

Checked by parsing the cmap tables of the originals in `assets/fonts/`:

```
             ↓ U+2193   ⌄ U+2304   ▾ U+25BE   ⇩ U+21E9   ˇ U+02C7
Sequoia Sans     —          —          —          —          —
BN Magnolia      —          —          —          —          —
Bricolage       yes         —          —          —         yes
```

Sequoia is 162 glyphs and Magnolia 203 — Latin, punctuation, digits, nothing
else. **Anything else renders in whatever the OS supplies**, which differs per
platform and matches nothing on the page. So every arrow here is Bricolage's
`↓`: the hero scroll hint and the process step markers.

If a mark is needed in Sequoia or Magnolia context, draw it — `WindowMark.astro`
is the precedent. There is nothing in those faces to match.

### The squiggle Acquire button

vinton.land's squiggle underline with the stroke fattened until the line is a
band you can put a word on. `src/lib/squiggle.ts` generates it with vinton.land's
control offsets byte-identical, so the two sites share a wave rather than two
curves that merely look alike.

Four things here were got wrong first, and each is a trap worth naming:

- **A period is 16 units, not 8.** One repeat is a `c` AND its `s` reflection.
  Getting it wrong makes the path exactly twice its viewBox, which
  `preserveAspectRatio="none"` hides by stretching — the only symptom is the
  tail spilling a whole button-width to the right. vinton.land's 8 periods in a
  128-wide box is the check.
- **Eight periods is a headline count.** At button width it reads as a row of
  lozenges. Three.
- **`<svg>` is a REPLACED element.** With `height: auto` it takes its intrinsic
  ratio rather than stretching to an inset box — measured 302x151 where 302x202
  was wanted. The explicit `width`/`height` on `.btn-acquire__wave` are
  load-bearing; `inset` alone positions but does not size.
- **`vector-effect: non-scaling-stroke` was needed and then was not.** With the
  SVG box hugging the label, box and viewBox had very different aspects and the
  stroke stretched into ellipses. With the 4rem overhang the box is close enough
  to the viewBox's 2:1 that the stretch is near-uniform, so the stroke can scale
  and `em` behaves.

**`--wave-grow` is a multiplier on the weight, not the weight.**
`stroke-width: calc(var(--wave-weight) * var(--wave-grow))`, because tweening
`stroke-width` directly would freeze it at whatever pixel value it resolved to
on load and silently stop tracking the label's `em`. It defaults to 1, so with
no JS the wave is simply full weight.

#### Why the draw looks the way it does

`acquire-squiggle.js` plays at `top 50%` and reverses whenever the button leaves
the viewport, so returning to it plays the draw again.

**The "flash" was never the easing**, and three rounds were spent on easing
before that was established. Per-frame capture showed a perfectly smooth ramp
(0 → 1.3 → 2.5 → 3.6px). The real causes, in order of discovery:

1. `stroke-linecap: round` renders a ZERO-LENGTH dash as a full dot — 23,631
   mustard pixels sat beside the button at 0% progress. Butt caps fix it and
   cost the round ends. The path is simply not painted at zero instead.
2. The overhang puts the path's start **64px clear of the pill**, so the first
   mark landed in empty space — and at full weight that mark is a 12px dot. A
   dot appearing out of nowhere is a blip whatever curve it is eased on.

The fix is that **thickness tracks length off the same eased number**: 1px when
it is a tick, 12px only once a long line is carrying it. `MIN_WEIGHT` sets the
opening tick. One tween drives both; separate tweens with separate durations is
how it ended up a hairline for half a second in one attempt and a fat dot in
another.

The reveal is `dasharray: d, len` with no offset rather than the usual
offset-the-whole-length trick, because `d` is then directly the drawn length —
which is the number the weight is scaled against.

**The undrawn state is set from JS, never from CSS.** A dash offset in the
stylesheet would leave an invisible link if the script failed to load.

### `?inspect` — capturing DevTools edits

Load any route with `?inspect` in `npm run dev` and a panel appears bottom-right.
Nudge CSS and markup in the inspector until the page looks right, press
**capture**, and the diff lands in `.inspect/latest.md` (gitignored, with a
timestamped copy beside it) as pasteable CSS and a list of markup changes. It is
how visual changes arrive here — read that file before asking anyone to describe
one in prose.

Ported from vinton.land, which is where the hard parts come from: elements are
matched by **node identity** rather than selector path (deleting one element
shifts every later sibling's `:nth-of-type`, so path-keying reports untouched
elements as removed + added), rules inside `@media` are walked into and reported
with their selector plus context, and a shorthand containing `var()` serializes
its longhands as empty — which once read as a property being *deleted*.

**The NOISE list is the per-site part, and the measure of it is: capture with no
edits, after scrolling the whole page, must say "nothing changed".** Getting
there took four entries, and three of them were not obvious:

- `#glizzy` and everything in it — the dog does not exist in the source, so
  nothing in it is ever a hand edit. `strokeDashoffset` is rewritten on every
  scroll frame.
- `#hero-stage` — `width`/`height` are the canvas backing store, `class` gains
  and loses `mini` as the hero scrolls away, `style` carries the FLIP transform.
- `.window-chrome` **and its descendants** — GSAP stamps
  `user-select`/`touch-action`/`cursor` onto a Draggable's trigger when
  ScrollTrigger enables the drag, and strips them on the way out. Scrolling past
  a window section was enough to produce three phantom edits.
- `#debug-panel` and everything in it — `updateDebug()` rewrites its readout on
  every scroll frame.

That last one needed a change to the tool itself: vinton.land's filter only ever
ran on **attributes**, because nothing there rewrites its own **text**. `noisy()`
takes a `'#text'` sentinel here, and `snapDom` blanks the text of a noisy
element. Without it `pre#debug` survived an `attrs: ['*']` rule.

**A shorthand carrying `var()` serializes its longhands as empty**, and the
inherited `lostAValue` heuristic did not reliably catch it — a capture reported
`background-image: ''` and lost the only value the edit was about. Every rule
now also carries its raw `style.cssText`, printed under **as written** whenever
any longhand came through empty. It is uglier and it cannot lose a value.

**`attrs: ['*']` means the ELEMENT is noise, not just its attributes.** The
filter originally ran only on nodes that existed at baseline, and
`glizzy-path.js` does not mutate the dog's `<path>` — it **replaces** it on
every rebuild. A resize between baseline and capture therefore produced an
unstamped node, `freshOnes()` dumped its entire `outerHTML`, and a capture of
four CSS edits arrived as 139KB of markup. A wholly-noisy element can no longer
be reported as added or removed. Test it the way it broke: baseline, resize to
force a rebuild, capture with nothing edited, expect "nothing changed".

Two other things worth knowing:

- **The baseline is taken 2000ms after `load`**, not vinton.land's 1500. The path
  is built once on load and again when `document.fonts.ready` resolves, because
  the webfonts change the line metrics and therefore the document height the path
  is measured against. Baselining between the two records the first and reports
  the second as an edit.
- **The script is stripped from `dist` after the build** (`stripDevAssets` in
  `astro.config.mjs`). No built page references it, but `public/` ships verbatim,
  so without the strip a dev tool sits on the live site.

### The service worker

`public/sw.js`: network-first for navigations, cache-first with write-through
for everything else. **Bump `VERSION` whenever the shell changes** — v8 is the
Astro port, and v7 is still out there holding the old hand-written page.

The hashed assets (the stylesheet, the bundled 3D module) are deliberately NOT
in `PRECACHE`: their URLs change whenever they do, so a hard-coded list goes
stale on every deploy. Cache-first cannot serve a stale one, because a stale one
has a different name.

### Fonts

Four faces, all self-hosted, all `woff2` in `public/fonts/`: Sequoia Sans (four
static weights), BN Magnolia, Bricolage Grotesque (variable). Assigned by `.f-*`
utility classes — there is no mapping from heading level to face.

The `.otf`/`.ttf` originals live in **`assets/fonts/`, outside `public/`**, so
they are kept but never shipped. 700KB of them used to be in the deploy.

## Checking a change

`scripts/shoot.mjs` (from vinton.land) screenshots a local route at several
widths: `node scripts/shoot.mjs / --widths 390,1440`.

Two things here are nondeterministic and will always differ between captures:
the **3D canvas spins on a wall clock**, and the drawn path length depends on
when ScrollTrigger's scrub settled. Hide `#hero-stage` and let the page sit for
~2s after each scroll before comparing.

## The shop

Sells through **vinton.land's Shopify store** via a **third headless storefront**
("glizzy-store") with its own public token. That storefront is the boundary:
this site's token can only see what is published to it.

`fetchShopifyProducts.ts`, `productJsonLd.ts`, `cart.js` and `shop-card.js` came
from `~/Sites/mmmornings-com` and are near-verbatim. `shop.scss` is **not** a
port — most of that sheet describes a masthead and a marquee this site does not
have. This one is rebuilt from what was already here: the window panel, the blue
pill, Magnolia for display, mustard on navy.

Route: `/shop/[handle]` — and only that one. It takes `scripts={false}`, which
drops the dog AND the four-screen `body.has-dog` height it assumes; without that
a shop page opens onto three empty screens. (The PDP has its own dog, a separate
lighter module — see "The dog on the product page" below.)

### There is no `/shop/` index, and adding a second product means restoring it

The index was **deleted on 2026-08-27**. With one product it was a page holding
a single card, sitting between every CTA and the thing being sold — so the
homepage's five CTAs point straight at the product page and the PDP's "← Shop"
crumb is gone. Nothing linked to `/shop/` afterwards, which is what made it
worth deleting rather than leaving orphaned.

**If a second product is ever added, four things have to come back**, and the
build will tell you about the first one:

1. `buyHref()` in `fetchShopifyProducts.ts` returns the FIRST product's page
   whenever there is more than one, and `console.warn`s while doing it. That
   warning is the tripwire — heed it, or every CTA quietly sends everyone to
   whichever product Shopify happened to list first.
2. `src/pages/shop/index.astro` has to be **rebuilt, not recovered.** It was
   deleted while this whole repo was still uncommitted, so it is in no history
   anywhere — that was a mistake, and the reason it is written down here rather
   than left to be discovered. Rebuilding it is small: `Layout` with
   `scripts={false}` and `cart`, `fetchShopifyProducts()`, and a grid of
   `<ShopCard product={p} headingLevel="h2" />`.
3. `components/shop/ShopCard.astro` is still in the tree and currently
   **referenced by nothing**. It is kept deliberately, for exactly this. Do not
   let a dead-code sweep take it without reading this paragraph.
4. `breadcrumbNode()` in `productJsonLd.ts` lost its middle "Shop" step, because
   a breadcrumb naming a 404 is worse than a short breadcrumb. Put it back.

While in there: that breadcrumb named the site **"Mill Mountain Mornings"** —
copied in from the sibling repo and shipped on every product page of this one
until it was caught on 2026-08-27. It says "Glizzy Store" now. The other files
ported from `mmmornings-com` are worth the same suspicion.

### Three things that will look like bugs

- **`cart.js`'s class names are its contract.** It builds every drawer line with
  DOM calls: `.cart__line`, `.cart__line-name`, `.cart__line-variant`,
  `.cart__qty`, `.cart__line-price`, plus two unnamed `<div>`s addressed
  positionally. Renaming one in `shop.scss` does not error — it silently empties
  the drawer.
- **`[hidden]` needs the `!important` in base.scss.** The UA sheet's
  `[hidden] { display: none }` loses to any author rule that sets `display`, and
  the cart opener carries `.shop-button`. Without it the cart button sits over
  the shop reading "0" with the attribute correctly set the whole time.
- **A product with no options gets one variant titled `Default Title`.**
  Rendered naively that is a swatch group of one and a cart line reading
  "Default Title". Suppressed in `hasRealOptions()` and in `cart.js`. The first
  glizzy has no options, so this path is the live one here, not the edge case.

### Stock of one

The first product is a single ceramic hot dog, quantity **1**, and that turned
up a real bug inherited from mmmornings.

Shopify does not refuse an impossible quantity. It caps the line at what it can
supply, returns `userErrors: []`, and puts the reason in `warnings` as
`MERCHANDISE_NOT_ENOUGH_STOCK`. `assertApplied()` already turned that into a
thrown error — but the stepper's handler was `.catch(function () {})`, so
pressing **+** on a one-of-one item did nothing at all and explained nothing.
Both sibling sites sell things they hold plenty of, so it never showed there.

Fixed: the catch now re-reads the cart (the number on screen is ahead of what
Shopify holds) and writes the reason into `#cart-note`, the drawer's live region
— which existed on both sibling sites and had never been written to.
**This fix has not been carried back to mmmornings-com.**

### Adding a product

1. Create it in Shopify. **Set Vendor to `glizzy-store`** — the build filters out
   anything else and says loudly that it did.
2. Publish it to the **glizzy-store Headless** storefront, and to that one only.
3. Upload artwork at **2000px**. `IMAGE_WIDTHS` runs to 2000 and `cdnSrcset`
   drops any entry wider than the file, so a small upload silently gets a small
   srcset — the first glizzy photo is a 769px iPhone HEIC and is capped at 640.
   Shopify converts HEIC to JPEG on delivery, so it renders; it is just soft.

### Still to wire

- **The vendor filter is firing.** The build currently prints that it left out
  `vinton-badge-sticker` and `holographic-sticker`: all three brands' products
  are published to the glizzy-store storefront. The backstop is holding, but
  the boundary is not set. Fix it in the admin (product → Publishing), not here.
- **No Netlify build hook and no webhooks yet**, so the catalogue is frozen at
  whatever the last deploy fetched — wrong prices against a live checkout, and
  new products that never appear. Needs one build hook plus three Shopify
  webhooks (product create/update/delete) under Settings → Notifications.
  Consequence to know going in: every product edit on the store then rebuilds
  all three sites, because webhooks cannot filter by storefront.

Checkout is branded once per store and lands on `shop.vinton.land` whatever site
you arrived from — multiple checkout profiles are Shopify Plus only. The drawer
says so, in `CartDrawer.astro`, rather than letting the domain change surprise
someone about to type a card number.

## The certificate of authenticity

`glizzy.store/cert/<order_number>-<token>` — a per-order digital certificate,
rendered live by `netlify/functions/cert.mjs`. The link is built by the
**Shipping confirmation notification template** in the Shopify admin (Settings
→ Notifications) — it surfaces to the buyer when the dog SHIPS, not at order
time (Adam's call, 2026-08-29); the Order confirmation deliberately does not
carry it. The template has `order_status_url` in scope; the `<token>` half is
the unguessable token from that URL, so the link itself is the credential —
only someone holding the buyer's own email can open it.

**Fulfillment trap:** the quick "Mark as fulfilled" flow leaves "Send a
notification to the customer" UNCHECKED by default — fulfilling that way
sends nothing, and adding tracking afterwards sends the *Shipping update*
template, a different template that does NOT carry the certificate. Check
the notify box when fulfilling, or the buyer never gets the link.

The function looks the order up over the Admin API (the Form Connector app's client-credentials
exchange in `netlify/shopify-admin.mjs`, which needs **`read_orders`** granted
AND the app version released), verifies the token against the order's own
`statusPageUrl`, confirms a `glizzy-store` line item, and renders.

Three properties to preserve:

- **No PII on the certificate.** It's built to be printed and shared; order
  number, date, piece, serial — never a name or address.
- **Single-origin, no script.** The page uses the site's own `/fonts` files
  and loads nothing from anyone; the footer's privacy line covers it too.
- **Shopify is the only database, and serials are RANDOM, one per dog.**
  `GLZ-` + six characters from a 30-symbol alphabet (no 0/O/1/I/L/U) —
  random on purpose: sequential numbers are a guessable pattern and leak the
  sales count (Adam's call, 2026-08-28). Minted on first render and FROZEN
  into the ORDER metafield `glizzy.serial` as a comma-separated list, one
  entry per unit in line order; a line with quantity 3 is three units, three
  serials, three papers. The stored list always wins entry-for-entry — edit
  it by hand to match a number written on the clay. Multi-dog orders get a
  hub page at `/cert/<id>` linking each dog's own paper at `/cert/<id>/<n>`
  (n is 1-based; the order token in the id is still the only credential).
  The freeze needs `write_orders`, and `read_all_orders` keeps orders older
  than 60 days summonable — both granted on app version 5.

The copy is in the site's voice and coins NEW rungs of the synonym ladder
("earthenware frankfurter", "clay companion") — never reuse a name the site
already uses. The kiln facts on it are the real ones (cone 06, 1,828°F).

Two more order metafields round out the system (all three are pinned, so they
show on every order page in the admin):

- **`glizzy.photo`** (Image File): Adam attaches a photograph of the actual
  dog to the order; the certificate renders it as the framed `.plate` above
  the lede. No photo, no plate — the layout degrades cleanly.
- **`glizzy.cert_url`** (URL): written automatically the moment an order is
  created, by `netlify/functions/order-created.mjs` — the **orders/create
  webhook** (Settings → Notifications → Webhooks → Order creation →
  `https://glizzy.store/hooks/order-created`, API 2026-07). The payload
  already carries `order_number` and `token`, so the function just verifies
  the `X-Shopify-Hmac-Sha256` signature (`SHOPIFY_WEBHOOK_SECRET` in Netlify —
  the signing secret shown under the admin's webhook list), skips non-glizzy
  orders by line-item vendor, and writes the metafield. It returns 200 even
  when the write fails: a missed cert_url is recoverable by hand, a webhook
  Shopify disables for flapping is not.

The buyer also sees the certificate on their ACCOUNT order page
(account.vinton.land) via **`papers-app/`** — "Glizzy Papers", an
extension-only app (deliberately separate from the Form Connector so its
released scopes are never touched) with one customer-account UI extension
targeting `customer-account.order-status.block.render`, placed on the Order
status page in the checkout & accounts editor. It shows from ORDER TIME
(Adam's call — unlike the email, which waits for shipping). The
`glizzy.cert_url` metafield's presence is the brand gate. Four traps, each
verified live on 2026-08-29 and each hiding the next:

- The extension reads the metafield by POSTing GraphQL to
  `shopify://customer-account/api/<version>/graphql.json` (auth automatic).
  `shopify.query()` is the STOREFRONT API — no `order` on its QueryRoot —
  and the declared-metafields channel (`[[extensions.metafields]]` +
  `shopify.appMetafields`) never delivered this merchant metafield at all.
- The app needs the `customer_read_orders` scope — and a scope is version +
  release + INSTALL-GRANT update, same saga as the Form Connector.
- The metafield definition needs "Customer Account API access: Read"
  (Settings → Custom data — it defaults to No access; so does Storefront).
- Editing a pinned metafield on an admin ORDER page is only saved by the
  page's "Unsaved changes → Save" bar. The filled-in field after blur is
  LOCAL STATE — navigate away and it's silently gone. Verify against a
  fresh page load, never against the field you just typed in.

Driving the webhooks admin page, learned 2026-08-29: the Add-webhook modal is
the new `s-internal-*` web components — every control is in shadow DOM, so
the a11y tree can't see them AND programmatically setting `select.value` +
dispatching `change` LOOKS right but never reaches the component's state (the
first attempt saved as "Cart creation", the default, while the modal showed
"Order creation"). What works: focus the shadow `<select>` via JS, then send
REAL keystrokes (type the option's label — native typeahead selects it with
trusted events). Verify by re-reading the saved row's text after a reload,
never by trusting the modal.
