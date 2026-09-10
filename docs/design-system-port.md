# The design-system pass, as it landed here

Written 2026-09-10, the same day vinton.land's version of this pass was done.
Its `docs/design-system-port.md` is the source document and says what it
expected to port; this one records what actually happened when it was tried
against navy, mustard, bone, and a caps display face.

**Three of its five parts did not port, and each failed for a reason specific
to this site.** That is the useful half of this document. The other half is a
bug it did predict, in a shape it did not.

---

## What was done

- `.window-content__inner h2` / `p` narrowed to the card's DIRECT children
- `.colophon__label` given the `line-height: 1` it had been borrowing
- `.prose-page__body` given `f-bricolage`, and its label an explicit 500
- `.thanks__note` opted back in to the panel-copy rule
- the copy rules applied to /about, /contact and /privacy
- `scripts/type-sweep.mjs` and `scripts/token-contrast.mjs` ported
- `min-height: 0` on the two single-panel slots that were missing it
- /404 cut back to a heading and one CTA (a separate ask, see below)

Measured result at the point the type work landed: `/`, `/colophon`, `/thanks`,
`/404` and `/shop/glizzy/` were **identical at all four widths**. Everything
that moved was on the three ProsePage routes, plus one `<label>` inside
`.contact__pot`, which is the spam honeypot and is `display: none`. /404 was
changed deliberately afterwards.

---

## Part 1 — the type scale did NOT get names, on purpose

Adam's call, 2026-09-10: bugs only, no refactor.

The survey was done anyway and is worth keeping, because the next person to
open this will re-derive it otherwise. The ladder as it stands is about twenty
flat rem values with **five near-identical micro steps** — `0.7`, `0.75`,
`0.8`, `0.85` and `0.95rem` — which is exactly the symptom vinton.land
describes: each page invented the size it needed.

Beside them are three local systems that already got it right and were arrived
at independently: `--pdp-type`, `--cart-type` and `--q-size`, each parameterising
a container rather than a page. **If the ladder is ever named, those are the
model and they must be folded in, not left beside it.**

`npm run sweep:type -- .shots/before.json` first. Everything after is measured
against it.

---

## Part 2 — the contrast conclusion INVERTS here

vinton.land's rule is: on a bright ground there is exactly one body-safe ink,
so a secondary line cannot be stepped back by fading it, and hierarchy must be
size and weight.

**Do not port that rule. It is a conclusion about a palette, not a principle.**
`npm run check:contrast` on this one:

| ink | on `--bg-top` (navy) | on `--bone` (card) |
| --- | --- | --- |
| white | 17.12 | 1.28 |
| bone / navy | 13.39 | 13.39 |
| mustard | 8.55 | 1.57 |
| dog-highlight | 7.86 | 1.70 |
| cta | 6.31 | 2.12 |
| dog-color | 4.28 | 3.13 |

Two differences follow. First, there are **two grounds**, not one, and they are
opposites: mustard is an AAA ink on the page and invisible on the card. Second,
navy on bone measures **13.39**, so far above the 4.5 floor that fading it is
fine — `opacity: 0.7` still measures 6.25, and it stays AA-safe down to 0.6.
The prose labels use 0.7 and keep it.

The script prints that opacity table itself, so the answer is a number rather
than an argument.

---

## Part 3 — the specificity trap IS here, in a worse shape

vinton.land found `.page-prose p` at (0,1,1) beating `.page-prose__lede` at
(0,1,0) — one component fighting itself, both selectors in one file.

Here the winning rule belongs to **a different component**.

`ProsePage` renders inside `WindowPanel`, and `WindowPanel` wraps its slot in
`.window-content__inner` — the bone card, which is not optional, because the
copy must never sit on the glass (see the "Glass panel, opaque card" note in
`CLAUDE.md`). So every paragraph on /about, /contact and /privacy also matched
`.window-content__inner p`, a rule in `windows.scss` about the homepage's
window panels. Both are (0,1,1), so the component's own rule only won the
properties the generic one does not declare.

Leaking into six pages of running prose: `font-weight: 500`,
`letter-spacing: .01em`, `word-spacing: .05em`, and **`text-wrap: balance`**,
which is a heading affordance. `.window-content__inner h2` likewise pinned
`line-height: 1` onto every prose label, and on `.colophon__label` too.

**The fix is the child combinator, and the reason it is the right narrowing was
checked before the change, not after.** Every element the rule is FOR is a
direct child of the card. Every element it was reaching by accident is nested
one level down inside its own component's wrapper. That is a real distinction
and `>` is exactly its shape:

```
DIRECT   the homepage's GlizzyWindow and IntroGlizzy copy
nested   .prose-page__body, .interlude__line, .contact__title,
         .colophon__label, .thanks__note, .notfound__text
```

`.thanks__note` is named back into the rule, because it genuinely IS panel copy
that happens to sit inside a page wrapper. `.notfound__text` was too, until /404
was cut back and the element stopped existing.

**The general form, and the thing to check for next time:** a descendant rule
under a SHARED wrapper reaches every component that nests inside it. A wrapper
that everything renders into — a card, a slot, a shell — should style its own
children, not its subtree.

---

## Part 4 — the copy pass

Rules 1, 2, 3, 4 and 6 applied to /about, /contact and /privacy. Seven em
dashes in shipped prose, plus two in `<meta>` descriptions, are gone. British
spellings: none shipped. The one `centred` is in a CSS comment, which the
source document explicitly exempts — the boundary is whether it ships.

**What was NOT changed, and both are deliberate:**

- The `title="X — Glizzy Store"` separator and the colophon's `{' — '}` between
  a name and a role. Those are furniture, the same exemption vinton.land gives
  its list marker.
- `/privacy`'s **"One more thing happens, and it is the reason this page
  exists."** Rule 6 says drop the meta-commentary and this is its exact shape.
  It stays, because rule 1 outranks rule 6 and this sentence sits immediately
  before the page's one surprising disclosure — that the contact form
  subscribes you to a mailing list. Cutting a signpost in front of that is not
  a saving worth making. Flagged rather than taken.

Rule 5 — shared facts in the same words — turned up a real disagreement rather
than just a stylistic one. `SiteNote`, which is on every route, said **"No
cookies"**; /privacy said **"no cookies set for tracking"**. One of those is
a weaker claim than the other and there is no way to tell from the source which
is true. **It was measured**: loading `/`, `/about`, `/privacy` and the product
page sets zero cookies and writes nothing to local or session storage. So the
site note was right and /privacy was hedging below the truth. Both pages now
use the site note's words, and /privacy keeps its extra specificity.

The other shared fact, `shop.vinton.land` being the same store under a
different name, now reads identically on /about, /privacy and `llms.txt`.

**The product copy's synonym ladder is the opposite rule and is untouched.**
The homepage and the PDP were not read for this pass.

---

## Part 5 — icons: nothing to do

Already solved here, earlier and differently — `qlmanage` + `sips`, because
headless Chrome hangs when the display sleeps. vinton.land's `export:icon`
must not be ported over it. The two rules that do apply are already written
down in `CLAUDE.md`: bump the `?v=` cache-buster, and bump `sw.js`'s `VERSION`,
because the service worker precaches every icon URL cache-first and a
same-URL replacement otherwise never reaches an installed PWA.

---

## The one that was not in the source document

**Sequoia Sans is a unicase face, and that is why `body` is `system-ui`.**

The sweep's first finding was that 71 elements across five routes render in the
visitor's OS UI font: every paragraph, label, list item, `<strong>` and link on
/about, /contact and /privacy, the credits on /colophon, the note on /thanks,
and the five GlizzyWindow paragraphs on the homepage. `.f-*` is opt-in and
those elements carry no class.

The obvious fix — put the site's text face on `body` — was tried, and it is
wrong. Sequoia has no lowercase. Nothing in the stack transforms case, so the
homepage's window copy simply came out in all caps, in a display weight, and it
was caught by eye rather than by the measurement:

> **A sweep that reports "font-family changed, size and colour identical" has
> told you nothing about whether the page still looks right.** A face swap is
> the entire visual change. It was reported as a 288-signature diff in which
> "only font-family moved", which was true, and which read as reassuring.
> Shoot the page.

Magnolia is a display face too. **Bricolage is the only face here that can hold
a paragraph**, which is what `/404` had already worked out for
`.notfound__text`. So there is no site-wide default worth setting, `.f-*`
really is opt-in, and the fix is per-surface: the prose kit now carries
`f-bricolage` explicitly.

Three consequences to keep:

- **Anything added later that carries running text needs a face named on it.**
  Nothing above will supply one and nothing will warn you.
- **Bricolage is instanced to `font-weight: 400 500`.** A UA bold — an `<h2>`,
  a `<strong>` — asks for 700, lands off the end of the axis, and the browser
  may synthesize it. That is the same faux-bold that smeared Magnolia on
  /thanks for weeks. The prose label and `<strong>` both declare 500.
- **/colophon, /thanks and the PDP still have elements in the OS font**, and
  they were left that way on purpose: this pass was scoped to bugs, and
  changing a face is a visual decision rather than a bug fix. `npm run
  sweep:type` names them.

---

## Two things found on the way out

**Every `section` is nearly a screen tall.** `base.scss` sets
`min-height: calc(100svh - 96px - 24px)` on the bare element, which is right
for the homepage and wrong for a one-panel route. `.thanks__slot` and
`.colophon__slot` already reset it; `.notfound__slot` and `.prose-page__slot`
did not. /404's panel was 684px around a 316px card. Both carry `min-height: 0`
now, and the healthy slack to check for is 61px — the chrome bar plus the
card's inset.

**`astro dev` is a daemon and `pkill` does not stop it.** The next
`npm run dev` reattaches and prints a normal banner, so a stale scoped
`<style>` survives every restart you think you did. `.notfound__slot`'s fix was
served stale for four rebuilds while `ProsePage.astro`'s edit from the same
minute came through. `npx astro dev stop`. **When an edit does not take, build
it and grep `dist/` before touching the CSS again** — if the built output is
right, the CSS is not the problem.

**/colophon took vinton.land's markup edits** (2026-09-10). Every credit was
three possible lines — name, then a ` by `-or-` — `-punctuated attribution,
then a faded note — and the punctuation had to differ by kind, so the template
carried three branches. Stacked as a flex column it needs none of them:
position says which line is which, `by` absorbs the notes that were really
attributions ("Vinton, Virginia"), and the two that were really links became
links (Shopify, Netlify). The author moved from FIRST, in the small `by` slot
under an empty name, to LAST, in the name slot, under "Created by".

The `note` field went with it, and the reason DOES NOT port: over there it was
faded on a ground with one body-safe ink and `opacity` walked it under AA. Here
it measured 6.25. It went because a credit list wants one shape.

The list also gained `f-bricolage`, so /colophon is out of the OS font — the
same fix as the prose kit, and the same reason. Remaining OS-font text after
this pass, all of it deliberate: the five GlizzyWindow paragraphs on `/`,
`.thanks__note`, four elements on the PDP, and two hidden honeypot labels.

While in there, /404 lost its copy line, its three-link list and its quiet
mustard Back pill for a heading and one blue `.shop-button` home (Adam's call,
2026-09-10). The header comment used to say "the links are the point"; in front
of it, four choices on a dead end read as a site map. `.shop-button` with no
modifier is the primary CTA and `--quiet` is the secondary treatment, which is
wrong as the only action on a page.

## The tools

```sh
npm run dev                                        # another shell
npm run sweep:type -- .shots/before.json
# …make the change…
npm run sweep:type -- .shots/after.json --diff .shots/before.json
npm run check:contrast
```

`type-sweep.mjs` reads computed size, weight, family, tracking, leading and
colour off every element with its own text, on every public route, at
390 / 834 / 1440 / 2560, and diffs by **signature count** rather than by line —
so removing one empty `<span>` does not report the rest of the document as
changed.

Four widths, not two: the middle two are where a `clamp()` is linear and a
mistake in its slope shows; the ends are where it is pinned and two different
clamps can look identical.

It beats pixel-diffing **for this job specifically**, and here that is not a
style preference: two things on this site are nondeterministic by construction
and would light up every capture — the 3D dog spins on a wall clock, and the
drawn path length depends on when ScrollTrigger's scrub settled. Neither has
any effect on a computed font size.

**It is not a substitute for looking.** See the unicase note above. For
anything that changes a face, a colour or a layout, `scripts/shoot.mjs` as
well.

The public routes only. `/type`, `/stereo`, `/stereo-colours` and `/email` are
excluded on purpose: they exist to show every size at once and would swamp any
clustering done on the output.
