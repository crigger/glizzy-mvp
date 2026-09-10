/**
 * WCAG contrast ratios between every pair of glizzy colour tokens, plus the
 * grounds that actually exist on the page and what each one allows.
 *
 *   node scripts/token-contrast.mjs
 *
 * WHY. There are two grounds here and they are opposites: the page is navy and
 * the card inside every window is bone. A token that is the only readable ink
 * on one of them is invisible on the other, and the answer is not guessable —
 * mustard reads at 8.9 on navy and 1.7 on bone.
 *
 * THE ONE THAT CATCHES PEOPLE: on the bone card there is exactly ONE
 * body-safe ink. So a secondary line cannot be stepped back by fading it —
 * `opacity` on the only readable ink walks it toward the ground and out of AA.
 * Hierarchy on the card is SIZE AND WEIGHT. The last block below prints what
 * each opacity actually costs, so that is a number rather than an opinion.
 *
 * Reads the sRGB fallbacks out of vars.scss, not the P3 overrides: WCAG is
 * defined on sRGB, and the two are the same colour to within rounding. Ported
 * from vinton.land's version, which parsed `$name: #hex` SCSS variables —
 * these are custom properties, so the pattern differs.
 */
import { readFileSync } from 'node:fs';

const vars = readFileSync(new URL('../src/styles/_globals/vars.scss', import.meta.url), 'utf8');

const tokens = { white: '#ffffff' };
for (const m of vars.matchAll(/^\s*--([a-z-]+):\s*(#[0-9a-f]{6});/gim)) tokens[m[1]] = m[2];

const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map((v) => srgbToLin(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};
/** What `opacity: n` on `ink` actually paints, over `ground`. */
const blend = (ink, ground, n) => {
  const [a, b] = [rgb(ink), rgb(ground)];
  return '#' + a.map((v, i) => Math.round(v * n + b[i] * (1 - n))
    .toString(16).padStart(2, '0')).join('');
};

const names = Object.keys(tokens);
const pad = (s, n) => String(s).padEnd(n);

console.log('\nWCAG contrast ratios — glizzy tokens (sRGB fallbacks)\n');
console.log(pad('', 16) + names.map((n) => pad(n.slice(0, 13), 14)).join(''));
for (const a of names) {
  const row = names.map((b) => pad(a === b ? '—' : ratio(tokens[a], tokens[b]).toFixed(2), 14));
  console.log(pad(a, 16) + row.join(''));
}

console.log(`
  < 3.0   not safe for text of any size
  >= 3.0  large text only (>=24px, or >=18.66px bold)
  >= 4.5  AA for body text
  >= 7.0  AAA for body text
`);

/** The two grounds that exist. Everything readable sits on one of them. */
const GROUNDS = [['--bg-top (the page)', 'bg-top'], ['--bone (the card)', 'bone']];
for (const [label, g] of GROUNDS) {
  console.log(`Inks on ${label}:`);
  const rows = names.filter((n) => n !== g)
    .map((n) => [n, ratio(tokens[n], tokens[g])])
    .sort((a, b) => b[1] - a[1]);
  for (const [n, r] of rows) {
    const verdict = r >= 7 ? 'AAA body' : r >= 4.5 ? 'AA body' : r >= 3 ? 'large text only' : 'NOT for text';
    console.log(`  ${pad(n, 16)}${pad(r.toFixed(2), 8)}${verdict}`);
  }
  console.log();
}

console.log('What opacity costs the only body-safe ink on the bone card:');
for (const n of [1, 0.9, 0.8, 0.7, 0.6, 0.5]) {
  const r = ratio(blend(tokens['bg-top'], tokens.bone, n), tokens.bone);
  console.log(`  opacity ${n.toFixed(2)}   ${pad(r.toFixed(2), 8)}${r >= 4.5 ? 'AA body' : r >= 3 ? 'large text only' : 'NOT for text'}`);
}
console.log();
