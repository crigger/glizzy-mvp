/**
 * Fail the build if an HTML comment made it into the output.
 *
 * `.astro` comments must be written `{/* … *␘/}`, which the compiler removes;
 * an `<!-- … -->` is passed through to the page verbatim. The two look almost
 * identical in a diff and nothing warns about the difference, so on 2026-08-29
 * a commented-out line of the contact form had been shipping to every visitor
 * for who knows how long.
 *
 * Scope is HTML only, on purpose:
 *   - `dist/js/*` is minified at build time, and what survives there is either
 *     `//` inside a URL or a licence banner that has to stay.
 *   - The three.js bundle carries GLSL comments inside template literals; they
 *     are shader source, not commentary, and a minifier is right to keep them.
 *
 * Run by `npm run build` (postbuild). To check by hand:
 *   node scripts/check-no-comments.mjs
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;

/** Conditional comments target IE and are markup, not commentary. */
const ALLOWED = /^<!--\[if\b/;

async function* htmlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.name.endsWith('.html')) yield path;
  }
}

const offenders = [];
for await (const file of htmlFiles(DIST)) {
  const html = await readFile(file, 'utf8');
  for (const match of html.matchAll(/<!--[\s\S]*?-->/g)) {
    if (ALLOWED.test(match[0])) continue;
    const line = html.slice(0, match.index).split('\n').length;
    offenders.push({
      file: relative(DIST, file),
      line,
      text: match[0].replace(/\s+/g, ' ').slice(0, 90),
    });
  }
}

if (offenders.length) {
  console.error(`\n✗ ${offenders.length} HTML comment(s) shipped to dist:\n`);
  for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.text}`);
  console.error('\n  In .astro files, write comments as {/* … */} — an HTML');
  console.error('  comment is passed straight through to the page.\n');
  process.exit(1);
}

console.log('✓ no HTML comments in dist');
