/**
 * Export the 3D dog as a GLB, for Shopify product media.
 *
 * The model is procedural — it exists only once hero-dog.js has run — so this
 * drives the dev server, calls the dev-only `window.glizzy3D.exportGLB()` hook,
 * and writes the bytes out.
 *
 *   npm run dev                       (in another terminal)
 *   node scripts/export-dog-glb.mjs
 *   node scripts/export-dog-glb.mjs --length 0.12 --out media/glizzy.glb
 *
 * Flags:
 *   --length <m>   real-world length in METRES, default 0.15. This is what AR
 *                  uses to place the object in a room, so it is worth getting
 *                  right rather than leaving at a guess.
 *   --out <path>   default .shots/glizzy-dog.glb
 *   --port <n>     dev server port, default 3334
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const lengthMetres = parseFloat(flag('length', '0.15'));
const out  = resolve(flag('out', '.shots/glizzy-dog.glb'));
const port = flag('port', '3334');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));

await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.glizzy3D && window.glizzy3D.exportGLB', { timeout: 15000 });

const result = await page.evaluate((m) => window.glizzy3D.exportGLB({ lengthMetres: m }), lengthMetres);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(result.base64, 'base64'));

console.log(`wrote ${out}`);
console.log(`  ${(result.bytes / 1024).toFixed(0)}KB · ${Math.round(result.triangles)} triangles · ${result.lengthMetres}m long`);
await browser.close();
