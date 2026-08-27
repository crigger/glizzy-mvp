/**
 * High-resolution stills of the 3D dog, for product media.
 *
 * Renders the LIVE hero scene through `window.glizzy3D.renderFrame()` — the
 * same geometry, lights and 5-degree lens the site uses — so these match what
 * a visitor sees rather than being a re-lit copy.
 *
 *   npm run dev                                   (in another terminal)
 *   node scripts/render-dog.mjs                   one still at the start pose
 *   node scripts/render-dog.mjs --frames 60       a full turn, 60 PNGs
 *   node scripts/render-dog.mjs --size 3000 --bg  3000px, on the site's navy
 *
 * Flags:
 *   --size <px>    square edge, default 2048
 *   --frames <n>   render a seamless 360-degree loop instead of one still
 *   --bg           composite on the site navy instead of transparent
 *   --out <dir>    default .shots/dog
 *   --port <n>     dev server port, default 3334
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has  = (n) => argv.includes(`--${n}`);

const size   = parseInt(flag('size', '2048'), 10);
const frames = parseInt(flag('frames', '0'), 10);
const outDir = resolve(flag('out', '.shots/dog'));
const port   = flag('port', '3334');
const transparent = !has('bg');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.setViewport({ width: 1200, height: 1200 });
await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.glizzy3D && window.glizzy3D.renderFrame', { timeout: 15000 });

mkdirSync(outDir, { recursive: true });
const shoot = async (yaw, name) => {
  const url = await page.evaluate((o) => window.glizzy3D.renderFrame(o), { size, yaw, transparent });
  const file = resolve(outDir, name);
  writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  return file;
};

if (frames > 0) {
  // `i / frames`, never `i / (frames - 1)` — the last frame must NOT repeat the
  // first, or the loop stutters for one frame every turn.
  for (let i = 0; i < frames; i++) {
    const f = await shoot(i / frames, `spin-${String(i).padStart(4, '0')}.png`);
    if (i === 0 || i === frames - 1) console.log('  ' + f);
  }
  console.log(`${frames} frames at ${size}px in ${outDir}`);
} else {
  console.log('wrote ' + await shoot(0, `glizzy-${size}.png`));
}
await browser.close();
