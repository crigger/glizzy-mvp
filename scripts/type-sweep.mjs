/**
 * Every text-bearing element on every public route, with its computed type.
 *
 *   npm run dev                                   # in another shell
 *   node scripts/type-sweep.mjs .shots/before.json
 *   …make the change…
 *   node scripts/type-sweep.mjs .shots/after.json --diff .shots/before.json
 *
 * WHY THIS EXISTS. Typography changes are the ones you cannot review by
 * reading. A `clamp()` moved into a custom property, a selector narrowed, a
 * utility class added to a heading — each of them either changes nothing or
 * changes a page you did not open, and the source diff looks the same either
 * way. This reads the answer off the layout engine instead.
 *
 * It is cheaper and sharper than pixel-diffing FOR THIS JOB. Two things on
 * this site are nondeterministic by construction and would light up every
 * capture: the 3D dog spins on a wall clock, and the drawn path length depends
 * on when ScrollTrigger's scrub settled (see "Checking a change" in CLAUDE.md).
 * Neither has any effect on a computed font size. For layout and colour work,
 * still shoot it.
 *
 * THE ORDINAL TRAP, and why `--diff` strips it. Each row is keyed by the
 * element's position in the document. Remove one empty `<span>` and every row
 * after it renumbers, so a raw text diff reports the whole rest of the page as
 * changed. The comparison below counts SIGNATURES instead — an element that
 * moved but did not change cancels out, and only a real difference in size,
 * weight, family, tracking, leading or colour survives.
 *
 * `prefers-reduced-motion` is emulated so an element cannot be measured
 * mid-transition.
 *
 * Ported from vinton.land, where the pass this exists for was done first; see
 * `docs/design-system-port.md`.
 */
import { writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const out = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--diff');
if (!out) {
  console.error('usage: node scripts/type-sweep.mjs <out.json> [--diff <baseline.json>] [--port n]');
  process.exit(1);
}

const port = flag('port', '3334');
const baseline = flag('diff');

/**
 * The PUBLIC routes — what the sitemap carries, plus the two noindex pages a
 * buyer still reads. `/type`, `/stereo`, `/stereo-colours` and `/email` are
 * left out on purpose: they are specimens and tuners that exist to show every
 * size at once, so they would swamp any clustering done on this output.
 *
 * The product page is discovered rather than named — there is no `/shop/`
 * index to crawl (see CLAUDE.md), so the homepage's own CTAs are the list.
 */
const ROUTES = ['/', '/about', '/contact', '/privacy', '/colophon', '/thanks', '/404'];

/**
 * Four widths, not two. The middle two are where a `clamp()` is LINEAR and a
 * mistake in its slope shows; the ends are where it is pinned to a stop and
 * two different clamps can look identical.
 */
const WIDTHS = [390, 834, 1440, 2560];

/** Newest Chrome from the puppeteer cache — no bundled download needed. */
function chromePath() {
  const base = join(homedir(), '.cache/puppeteer/chrome');
  const build = readdirSync(base).sort().pop();
  return join(base, build, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
}

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true });
const page = await browser.newPage();
const cdp = await page.target().createCDPSession();
await cdp.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
});

try {
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
  const handles = await page.evaluate(() =>
    [...document.querySelectorAll('a[href*="/shop/"]')]
      .map((a) => new URL(a.href).pathname)
      .filter((p) => p !== '/shop/'));
  ROUTES.push(...new Set(handles));
} catch {
  console.error(`No dev server on :${port} — run \`npm run dev\` first.`);
  await browser.close();
  process.exit(1);
}

const result = {};
for (const route of ROUTES) {
  for (const width of WIDTHS) {
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    await page.goto(`http://localhost:${port}${route}`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    result[`${route} @${width}`] = await page.evaluate(() => {
      const rows = [];
      // Elements whose text is never rendered as type. A <script> body and a
      // <noscript> body both count as "own text" to the walk below, and both
      // would report a face they are not drawn in.
      const NEVER_DRAWN = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE']);
      let i = 0;
      for (const el of document.querySelectorAll('body *')) {
        i++;
        if (NEVER_DRAWN.has(el.tagName)) continue;
        // Only elements with their OWN text. A wrapper inherits everything and
        // would report a change its child is responsible for.
        const text = [...el.childNodes]
          .filter((n) => n.nodeType === 3 && n.textContent.trim())
          .map((n) => n.textContent.trim()).join(' ');
        if (!text) continue;
        const cs = getComputedStyle(el);
        rows.push([
          `${i}:${el.tagName}.${el.className || ''}`.slice(0, 90),
          cs.fontSize, cs.fontWeight, cs.fontFamily.split(',')[0],
          cs.letterSpacing, cs.lineHeight, cs.color,
        ].join(' | '));
      }
      return rows;
    });
  }
}
await browser.close();

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 1));
const total = Object.values(result).flat().length;
console.log(`${out}: ${total} text elements, ${ROUTES.length} routes x ${WIDTHS.length} widths`);

if (!baseline) process.exit(0);

/** Signature counts per route+width, so a renumbered-but-unchanged row cancels. */
const before = JSON.parse(readFileSync(baseline, 'utf8'));
const tally = (rows) => {
  const m = new Map();
  for (const r of rows) {
    const k = r.replace(/^\d+:/, '');
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
};

let changed = 0;
const clean = [];
for (const key of new Set([...Object.keys(before), ...Object.keys(result)])) {
  const A = tally(before[key] ?? []);
  const B = tally(result[key] ?? []);
  const diffs = [];
  for (const sig of new Set([...A.keys(), ...B.keys()])) {
    const a = A.get(sig) ?? 0;
    const b = B.get(sig) ?? 0;
    if (a !== b) diffs.push(`    ${a} -> ${b}  ${sig}`);
  }
  if (diffs.length) {
    changed += diffs.length;
    console.log(`\n  ${key}`);
    diffs.sort().forEach((d) => console.log(d));
  } else {
    clean.push(key);
  }
}

console.log(
  changed
    ? `\n${changed} differing signature(s); ${clean.length} route/width pairs identical`
    : `\nIDENTICAL across all ${clean.length} route/width pairs`,
);
