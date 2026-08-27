import puppeteer from 'puppeteer-core';
import { join } from 'node:path'; import { homedir } from 'node:os'; import { readdirSync, mkdirSync } from 'node:fs';
const base = join(homedir(), '.cache/puppeteer/chrome');
const build = readdirSync(base).sort().pop();
mkdirSync('.shots/squiggle', { recursive: true });
const browser = await puppeteer.launch({ executablePath: join(base, build, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'), headless: true });
for (const [w,h,dpr] of [[430,932,3],[1440,900,2]]) {
  const page = await browser.newPage();
  await page.setViewport({ width:w, height:h, deviceScaleFactor:dpr });
  await page.goto('http://localhost:3334/', { waitUntil:'networkidle0' });
  await page.evaluate(() => document.fonts.ready); await new Promise(r=>setTimeout(r,1500));
  const g = await page.evaluate(() => {
    const b = document.querySelector('.btn-acquire--squiggle');
    const r = b.getBoundingClientRect();
    return { box: `${Math.round(r.width)}x${Math.round(r.height)}` };
  });
  console.log(`  ${w}px button ${g.box}`);
  await page.evaluate(() => { const s=document.querySelector('.acquire-break'); s.scrollIntoView({block:'center'}); });
  await new Promise(r=>setTimeout(r,900));
  const b = await page.$('.acquire-break');
  await b.screenshot({ path: `.shots/squiggle/${w}.png` });
  await page.close();
}
await browser.close();
