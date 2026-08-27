/**
 * Screenshot a local route at several widths, and optionally render one
 * element down to icon sizes.
 *
 * The failures in this design system are optical, not structural — an
 * invisible edge, a pattern that collapses into flat color — and none of them
 * show up in a build log. This is the check.
 *
 *   node scripts/shoot.mjs /crest
 *   node scripts/shoot.mjs /crest --widths 390,1440
 *   node scripts/shoot.mjs /crest --sel "#crest-a" --sizes 160,96,56,32
 *   node scripts/shoot.mjs / --full
 *
 * Flags:
 *   --widths a,b,c   viewport widths (default 390,834,1440)
 *   --sel <css>      capture just this element; with --sizes, re-render it small
 *   --sizes a,b,c    icon-scale widths in px for --sel
 *   --full           full-page capture rather than viewport
 *   --out <dir>      output directory (default ./.shots)
 *   --port <n>       dev server port (default 4321)
 *   --wait <ms>      extra settle time after load (default 400)
 */
import { mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const route = argv.find((a) => a.startsWith('/')) ?? '/';
const widths = String(flag('widths', '390,834,1440')).split(',').map(Number);
const sizes = flag('sizes') ? String(flag('sizes')).split(',').map(Number) : null;
const sel = flag('sel');
const outDir = resolve(flag('out', '.shots'));
const port = flag('port', '3334');
const wait = Number(flag('wait', 400));

/** Newest Chrome from the puppeteer cache — no bundled download needed. */
function chromePath() {
  const base = join(homedir(), '.cache/puppeteer/chrome');
  const build = readdirSync(base).sort().pop();
  return join(base, build, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
}

const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'index';

mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: true,
  // deviceScaleFactor 2 keeps hairlines and beads honest
  defaultViewport: { width: widths[0], height: 900, deviceScaleFactor: 2 },
});

const page = await browser.newPage();
const url = `http://localhost:${port}${route}`;
const written = [];

for (const width of widths) {
  await page.setViewport({ width, height: 900, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: 'networkidle0' });
  // Webfonts settle after load and shift layout
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, wait));

  const target = sel ? await page.$(sel) : null;
  if (sel && !target) {
    console.error(`  ! ${sel} not found at ${width}px`);
    continue;
  }

  const file = join(outDir, `${slug(route)}-${width}.png`);
  await (target ?? page).screenshot({ path: file, fullPage: !sel && has('full') });
  written.push(file);
  console.log(`  ${width.toString().padStart(5)}px  ${file}`);
}

// Icon-scale check: the recurring failure is a pattern that reads as texture at
// full size and as flat color at favicon size.
if (sel && sizes) {
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);

  for (const size of sizes) {
    await page.evaluate(
      (s, px) => {
        const el = document.querySelector(s);
        el.style.width = px + 'px';
        el.style.height = 'auto';
      },
      sel,
      size
    );
    await new Promise((r) => setTimeout(r, 120));
    const el = await page.$(sel);
    const file = join(outDir, `${slug(route)}-icon-${size}.png`);
    await el.screenshot({ path: file });
    written.push(file);
    console.log(`  icon ${size.toString().padStart(3)}px  ${file}`);
  }
}

await browser.close();
console.log(`\n${written.length} shot(s) in ${outDir}`);
