/**
 * vinton.land's serpentine, as a generator.
 *
 * One `c`/`s` pair repeated: the first curve dips, the smooth reflection lifts.
 * The control offsets are vinton.land's exactly (`c2 -4 6 -4 8 0 s6 4 8 0`) so
 * the two sites share a wave rather than two curves that merely look alike.
 *
 * Two things ARE parameterised, because a button is not a headline:
 *
 *   periods  vinton.land packs 8 across a display line. At button width that
 *            reads as a row of lozenges, not a wave — 3 is about right.
 *   band     the viewBox height the wave is centred in. The amplitude is fixed
 *            at ±4 user units by the curve itself, so the only way to make a
 *            FAT stroke fit around it is to give the box more headroom.
 */
export function squigglePath(periods = 8, band = 10) {
  const mid = band / 2;
  return `M0 ${mid} ${'c2 -4 6 -4 8 0 s6 4 8 0 '.repeat(periods)}`.trim();
}

/*
 * 16 units per period, NOT 8. One repeat is a `c` AND its `s` reflection — a
 * dip and a lift — and each of those advances 8. Getting this wrong makes the
 * path exactly twice its box, which `preserveAspectRatio="none"` then hides by
 * stretching, so the only symptom is the tail spilling a whole button-width
 * out to the right. vinton.land's 8 periods filling a 128-wide box is the
 * check: 8 x 16 = 128.
 */
export function squiggleViewBox(periods = 8, band = 10) {
  return `0 0 ${periods * 16} ${band}`;
}

/** vinton.land's underline, unchanged: eight periods in a 10-unit band. */
export const SQUIGGLE_D = squigglePath(8, 10);
