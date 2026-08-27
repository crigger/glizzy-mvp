/**
 * The dog, as pure geometry and texture — no scene, no canvas, no DOM beyond
 * the offscreen canvases the maps are drawn into.
 *
 * Lifted verbatim out of hero-dog.js so the product page can build the same
 * dog without dragging in the hero's machinery: the mini-pin FLIP, the
 * ScrollTrigger, the debug panel and a hard dependency on `#hero-stage`.
 * hero-dog.js and pdp-dog.js both import from here, so there is one model and
 * it cannot drift between the two.
 *
 * The only change on the way out: the two functions that read hero-dog.js's
 * live tunables now take them as an argument instead, because those values are
 * mutable there (the `?debug` sliders write to them) and this module has no
 * business owning them.
 */
import * as THREE from 'three';

// ───── 3D value noise ─────
function hash3(xi, yi, zi) {
  let h = Math.imul(xi | 0, 374761393) ^ Math.imul(yi | 0, 668265263) ^ Math.imul(zi | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const n000 = hash3(xi,     yi,     zi);
  const n100 = hash3(xi + 1, yi,     zi);
  const n010 = hash3(xi,     yi + 1, zi);
  const n110 = hash3(xi + 1, yi + 1, zi);
  const n001 = hash3(xi,     yi,     zi + 1);
  const n101 = hash3(xi + 1, yi,     zi + 1);
  const n011 = hash3(xi,     yi + 1, zi + 1);
  const n111 = hash3(xi + 1, yi + 1, zi + 1);
  const nx00 = n000 + (n100 - n000) * u;
  const nx10 = n010 + (n110 - n010) * u;
  const nx01 = n001 + (n101 - n001) * u;
  const nx11 = n011 + (n111 - n011) * u;
  const nxy0 = nx00 + (nx10 - nx00) * v;
  const nxy1 = nx01 + (nx11 - nx01) * v;
  return nxy0 + (nxy1 - nxy0) * w;
}

function fractal3(x, y, z, octaves = 4) {
  let v = 0, amp = 1, total = 0, freq = 1;
  for (let i = 0; i < octaves; i++) {
    v += noise3(x * freq, y * freq, z * freq) * amp;
    total += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return v / total;
}

// ───── the asterisk end-cap imprint ─────
function spokeHash(idx) {
  // Cheap 1-D hash → [0, 1). Different per spoke index.
  let h = Math.imul(idx | 0, 374761393) ^ 0x9E3779B9;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function makeAsteriskMaps(size, spokes, lineDeg, vReach, darken) {
  const bumpCanvas  = document.createElement('canvas');
  const colorCanvas = document.createElement('canvas');
  bumpCanvas.width  = colorCanvas.width  = size;
  bumpCanvas.height = colorCanvas.height = size;
  const bumpCtx  = bumpCanvas.getContext('2d');
  const colorCtx = colorCanvas.getContext('2d');
  const bumpData  = bumpCtx.createImageData(size, size);
  const colorData = colorCtx.createImageData(size, size);
  const halfAngular  = (lineDeg * Math.PI / 180) / 2;
  const segmentAngle = (2 * Math.PI) / Math.max(1, spokes);
  const TAPER        = 0.65;    // 0 = constant angular (sharp point at apex);
                               // 1 = constant physical (extruded look).
                               // Blend gives a thicker apex with some narrowing.
  const minSinT      = 0.18;   // floor on radius so apex doesn't blow up
  const vEdgeFrac    = 0.52;   // long bottom taper for soft pressed-in feel
  const BULGE        = 0.20;   // how far the BETWEEN-spoke areas push OUTWARD.
                               // Casings pinch along the twists and plump out
                               // between them — signed depth: spokes positive
                               // (depression), between-spokes negative (bulge).
  // Precompute per-spoke depth multipliers so each line presses differently.
  const spokeDepthMul = new Array(Math.max(1, spokes));
  for (let s = 0; s < spokeDepthMul.length; s++) {
    spokeDepthMul[s] = 0.55 + 0.55 * spokeHash(s); // 0.55 .. 1.10
  }
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = px / (size - 1);
      const v = py / (size - 1);
      let distFromApex = -1;
      let onTop = false;
      if (v < vReach)          { distFromApex = v;     onTop = true;  }
      else if (v > 1 - vReach) { distFromApex = 1 - v; onTop = false; }
      let depth = 0;
      if (distFromApex >= 0) {
        const tV = distFromApex / vReach;
        // sin(t) for the quarter-ellipse profile at this v.
        const cosT = Math.max(-1, Math.min(1, 1 - tV));
        const sinT = Math.max(minSinT, Math.sqrt(Math.max(0, 1 - cosT * cosT)));
        // Blend constant-angular and constant-physical widths so the apex
        // end thickens (less taper) but doesn't merge into a band.
        const halfAngFlat = halfAngular;
        const halfAngFull = halfAngular / sinT;
        let halfAng = halfAngFlat * (1 - TAPER) + halfAngFull * TAPER;
        // Per-pixel width jitter so each line's thickness wobbles along its length.
        const wAng = u * 2 * Math.PI;
        const wNoise = fractal3(
          Math.cos(wAng) * 5.5,
          Math.sin(wAng) * 5.5,
          v * 50 + (onTop ? 0 : 99),
          3
        ) * 2 - 1;
        halfAng *= 1 + wNoise * 0.25;
        // Clamp so spokes never bleed into each other (60% of the gap is max).
        halfAng = Math.min(Math.max(halfAng, halfAngular * 0.25), segmentAngle * 0.30);

        // Smooth bell-curve cross-section (smoothstep falloff over the entire
        // half-width) — gives rounded walls instead of near-vertical sides, so
        // the wall highlights don't read as a raised ridge.
        let angular;
        let spokeIdx = 0;
        if (spokes < 2) {
          angular = 1;
        } else {
          const theta   = u * 2 * Math.PI;
          // spokeIdx for per-spoke depth lookup (which spoke we're closest to).
          spokeIdx = Math.round(theta / segmentAngle) % spokes;
          if (spokeIdx < 0) spokeIdx += spokes;
          const wrapped = ((theta % segmentAngle) + segmentAngle) % segmentAngle;
          const distFromSpoke = Math.min(wrapped, segmentAngle - wrapped);
          if (distFromSpoke >= halfAng) {
            angular = 0;
          } else {
            const t = distFromSpoke / halfAng;
            angular = 1 - (t * t * (3 - 2 * t));    // bowl-shaped, no sharp walls
          }
        }
        // v-direction falloff (long soft tail at the bottom; flat near apex).
        let fall;
        if (tV < 1 - vEdgeFrac) {
          fall = 1;
        } else {
          const tt = (tV - (1 - vEdgeFrac)) / vEdgeFrac;
          fall = 1 - (tt * tt * (3 - 2 * tt));
        }
        // Signed depth: bulge OUT (-BULGE) between spokes, depress IN at
        // spoke centers. Whole thing tapers to 0 at the asterisk edge so the
        // cap blends back into the surrounding surface without a visible ring.
        depth = (-BULGE + angular * (1 + BULGE) * spokeDepthMul[spokeIdx]) * fall;
        // Organic imperfection along the line: jitter + low-freq breathing.
        if (depth > 0) {
          const a = u * 2 * Math.PI;
          const nHi = fractal3(
            Math.cos(a) * 8,
            Math.sin(a) * 8,
            v * 90 + (onTop ? 0 : 53),
            4
          ) * 2 - 1;
          const nLo = fractal3(
            Math.cos(a) * 1.6,
            Math.sin(a) * 1.6,
            v * 12 + (onTop ? 13 : 71),
            2
          ) * 2 - 1;
          depth *= 1 + nHi * 0.55 + nLo * 0.35;     // up to ±90%
          if (depth < 0) depth = 0;
          else if (depth > 1) depth = 1;
        }
      }
      const idx = (py * size + px) * 4;
      // Signed depth → bump grey: mid-gray (128) is neutral, dark = depression,
      // bright = bulge. Three.js bump shader only uses local gradients so the
      // absolute level outside the asterisk (still 128) produces no bump effect
      // on the body.
      const bumpRaw = 128 - depth * 127;
      const bumpGrey = bumpRaw < 0 ? 0 : (bumpRaw > 255 ? 255 : Math.round(bumpRaw));
      bumpData.data[idx]     = bumpGrey;
      bumpData.data[idx + 1] = bumpGrey;
      bumpData.data[idx + 2] = bumpGrey;
      bumpData.data[idx + 3] = 255;
      // Color modulation: only the DEPRESSED part (depth > 0) darkens the
      // diffuse color. Between-spoke bulges keep full color — they read as
      // raised, not shadowed. G and B darken faster than R so the spoke
      // shadow shifts toward a saturated deep red/brown.
      const depression = depth > 0 ? (depth > 1 ? 1 : depth) : 0;
      const rMul = 1 - depression * darken;
      const gMul = 1 - depression * (darken * 1.3);
      const bMul = 1 - depression * (darken * 1.6);
      colorData.data[idx]     = Math.round(Math.max(0, rMul) * 255);
      colorData.data[idx + 1] = Math.round(Math.max(0, gMul) * 255);
      colorData.data[idx + 2] = Math.round(Math.max(0, bMul) * 255);
      colorData.data[idx + 3] = 255;
    }
  }
  bumpCtx.putImageData(bumpData, 0, 0);
  colorCtx.putImageData(colorData, 0, 0);
  return { bumpCanvas, colorCanvas };
}

// ───── geometry ─────
export function weldNormalsBySharedPosition(geom) {
  const pos = geom.attributes.position;
  const norm = geom.attributes.normal;
  const TOL = 1e-5;
  const round = (v) => Math.round(v / TOL) * TOL;
  const groups = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${round(pos.getX(i))},${round(pos.getY(i))},${round(pos.getZ(i))}`;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(i);
  }
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    let nx = 0, ny = 0, nz = 0;
    for (const i of arr) {
      nx += norm.getX(i); ny += norm.getY(i); nz += norm.getZ(i);
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const i of arr) norm.setXYZ(i, nx, ny, nz);
  }
  norm.needsUpdate = true;
}

export function applyLumpiness(geom, { LUMP_AMP, LUMP_FREQ, LUMP_SEED, RADIUS }) {
  if (LUMP_AMP <= 0) return;
  const pos  = geom.attributes.position;
  const norm = geom.attributes.normal;
  const amp  = LUMP_AMP * RADIUS;
  const off  = LUMP_SEED * 100;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = fractal3(
      (x + off)         * LUMP_FREQ,
      (y + off * 1.7)   * LUMP_FREQ,
      (z + off * 2.3)   * LUMP_FREQ,
      4
    ) * 2 - 1;
    // INWARD ONLY: the base capsule (R cylinder + hemisphere caps) is the
    // outer envelope. The body never bulges past R, so the cap's seam ring
    // (= R) ties for widest with any undisplaced body ring — the cap is never
    // narrower than the widest point on the dog.
    const d = Math.min(0, n) * amp;
    pos.setXYZ(i,
      x + norm.getX(i) * d,
      y + norm.getY(i) * d,
      z + norm.getZ(i) * d
    );
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();
}

export function buildCapsuleGeometry({ RADIUS, LENGTH, CAP_FULL }) {
  const halfL      = LENGTH / 2;
  const capSegs    = 24;
  const radialSegs = 64;
  // Match cylinder ring spacing to cap-arc spacing so inward lumps sample
  // uniformly along the whole body — safe now that lumps only push inward.
  const arcStep    = (RADIUS * Math.PI / 2) / capSegs;
  const cylRings   = Math.max(2, Math.round(LENGTH / arcStep));
  // Quarter-ellipse cap: radial axis = RADIUS, axial axis = capH. capH < RADIUS
  // yields a blunter "pill" shape that doesn't taper to a sharp point.
  const capH       = CAP_FULL * RADIUS;
  const profile    = [];
  // Top cap: apex → top seam
  for (let i = 0; i <= capSegs; i++) {
    const t = (i / capSegs) * Math.PI / 2;
    profile.push(new THREE.Vector2(RADIUS * Math.sin(t), halfL + capH * Math.cos(t)));
  }
  // Cylinder interior (skip both seams — already in cap arrays)
  for (let i = 1; i < cylRings; i++) {
    profile.push(new THREE.Vector2(RADIUS, halfL - (i / cylRings) * LENGTH));
  }
  // Bottom cap: bottom seam → apex
  for (let i = 0; i <= capSegs; i++) {
    const t = Math.PI / 2 + (i / capSegs) * Math.PI / 2;
    profile.push(new THREE.Vector2(RADIUS * Math.sin(t), -halfL + capH * Math.cos(t)));
  }
  const g = new THREE.LatheGeometry(profile, radialSegs);
  // LatheGeometry assigns v from profile-point INDEX (so caps with dense
  // profile rings get a disproportionately large v range). Override v to be
  // axial-position-proportional instead, so vReach in the bump map directly
  // corresponds to axial distance from the apex and the imprint lands where
  // we expect it.
  const pos = g.attributes.position;
  const uvs = g.attributes.uv;
  const yApexTop = halfL + capH;
  const yRange   = 2 * (halfL + capH);
  for (let i = 0; i < pos.count; i++) {
    uvs.setXY(i, uvs.getX(i), (yApexTop - pos.getY(i)) / yRange);
  }
  uvs.needsUpdate = true;
  g.computeVertexNormals();
  weldNormalsBySharedPosition(g);
  return g;
}
