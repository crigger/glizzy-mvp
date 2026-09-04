/**
 * The dog as a random-dot stereogram, as a reusable engine.
 *
 * Same reasoning as dog-model.js: /stereo (the tuner) and GlizzyStereo (the
 * homepage band) both need this, and two copies of a SIRDS implementation
 * would drift the moment either is touched. So the whole thing lives here and
 * the callers only supply a canvas and the knobs they care about.
 *
 * Depth comes from the dog's own depth buffer. That is the point of doing this
 * against geometry rather than a photograph: a camera has no depth channel and
 * has to infer it, a three.js scene already knows it exactly, for about 2ms.
 *
 * Algorithm is Thimbleby/Inglis/Witten SIRDS, carried over from dork-works'
 * poster generator, with two changes that matter for a picture that MOVES:
 *
 *   1. the dot texture is a stable hash of (x, y), never Math.random() per
 *      frame. Re-rolling the dots every frame boils the image into something
 *      no eye can hold long enough to fuse.
 *   2. depth stays continuous rather than quantised into planes. Slicing a
 *      curved body into flat shells reads as nested rings — as hollow.
 *
 * Geometry only: no lights, no textures, no bump map, because depth does not
 * care about shading. One consequence — the asterisk end-cap imprint is a bump
 * map, not geometry, so it cannot appear here. The lumpiness can, because
 * applyLumpiness displaces real vertices.
 */
import * as THREE from 'three';
import {
  weldNormalsBySharedPosition,
  applyLumpiness,
  buildCapsuleGeometry,
} from './dog-model.js';

const MU = 1 / 3;

/* pdp-dog.js's values. Change them THERE, not here, or the stereogram stops
   being a picture of the real dog. */
const P_DOG = { RADIUS: 1.0, LENGTH: 5.0, CAP_FULL: 1.0, LUMP_AMP: 0.1, LUMP_FREQ: 0.6, LUMP_SEED: 0 };
const TILT_X = THREE.MathUtils.degToRad(15);
const TILT_Z = THREE.MathUtils.degToRad(-25);

/* The real tokens from styles/_globals/vars.scss, in the order /stereo-colours
   enumerates them. --bg-bottom is omitted: at #000d48 against --bg-top's
   #000d60 it is 24 apart in blue alone, which in a dot field is the same
   colour twice and quietly raises the coincidental-match rate. */
const BRAND_HEX = ['#dc512a', '#ff945a', '#ffa300', '#f7e0c5', '#30a2ff', '#000d60'];
const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BRAND = BRAND_HEX.map(hex2rgb);

/**
 * Defaults are a configuration a person actually fused on a phone, not a
 * guess. `planes: 33` is the "smooth" end — continuous depth. `blur: 0`
 * because GPU depth is exact and has no noise to hide.
 */
/**
 * Per-device settings, chosen by fusing them on the hardware in question.
 *
 * `sep` — the on-screen repeat — is the one that must NOT be a percentage of
 * the frame. Fusing depends on the physical span between repeats against the
 * eyes' geometry, and a fraction of the width walks straight off a cliff at the
 * wide end: the 38% that gives 154px on a 402px phone would ask for 711px on a
 * 1871px desktop, about 190mm, three times any human's eye separation. It could
 * not fuse at all. So the table stays.
 *
 * WHAT THE TWO VALUES HAVE IN COMMON, now that the phone one is right. 154px
 * across a 402px-wide phone is ~27mm of glass; 218px across a 1871px desktop is
 * ~58mm. Not the same fraction (38% vs 11.7%) and not the same size — but a
 * phone is held at about 30cm and a monitor sat at about 60cm, and at those
 * distances the two subtend 5.2 and 5.5 DEGREES. The same angle, within 6%.
 *
 * That is the number fusing actually depends on, and it is why the old 68px was
 * wrong rather than merely small: 12mm at 30cm is 2.3 degrees, less than half
 * of what the same eyes were being asked for on the desktop. It was tuned by
 * fusing it, so it did fuse — it was just the hard end of the range, and 154
 * was reported as better on the device without any of this being worked out
 * first.
 *
 * It is still a table and not a formula, because the browser cannot know the
 * viewing distance and both distances above are assumptions. But a new device
 * now has a starting point instead of a search: pick `sep` so it spans ~5.3
 * degrees at the distance that device is actually held.
 *
 * The rest are here because they turned out to be device-dependent too. A
 * phone wants more `blur` — at a short period the depth gradients are steeper
 * per cell, and softening them stops the silhouette breaking up — and a deeper,
 * narrower `room`. NOTE that the blur reasoning was written against `sep: 68`
 * and the period has since more than doubled, which flattens exactly the
 * gradients it exists to soften. It is left at 6 because nobody has compared
 * them on a phone at 154; it is the first thing to try turning down.
 *
 * Everything else (relief, lift, fill, spin) holds across devices.
 *
 * Exported so the homepage and the colour sheet cannot disagree.
 */
export const presetForViewport = (w) =>
  w < 700
    ? { sep: 154, blur: 6, room: 55, wall: 14 }
    : { sep: 218, blur: 0, room: 30, wall: 18 };

export const STEREO_DEFAULTS = {
  sep: 101,    // ON-SCREEN repeat period in CSS px. See eyeSep() below.
  dot: 2,
  planes: 33,  // > 32 means unquantised
  gain: 30,
  spin: 100,
  /*
   * 135, not 105. Once the framing actually fitted the dog's real silhouette
   * instead of a generous overestimate, `fill: 105` meant what it says — the
   * subject filling ~95% of its binding axis — and that was far bigger than the
   * page ever wanted. The old number only looked right because the fit was
   * loose by about a third. This is the margin that reproduces the size the
   * page had, now that the number means what it claims.
   */
  fill: 200,
  lift: 80,
  /*
   * Back on, gently, at a value picked by eye rather than argued for.
   *
   * It was off for a while: the case for it — that a flat backdrop gives the
   * eye nothing to lock onto — is backwards, since a large region at ONE
   * constant period is the easiest thing in a stereogram to converge on. At
   * room 100 it ramped the outer third and removed that stable period. At 30
   * with a narrow wall it is a hint of recession at the very edge rather than a
   * gradient across the field, which is a different thing and reads better in
   * place. Past wall ~40 the walls meet and there is no back wall at all.
   */
  room: 30,
  wall: 18,
  /*
   * The wiggle view's parallax, peak to peak, in ON-SCREEN px — the same units
   * as `sep`, and for the same reason: what the eye gets is a physical
   * distance, not a fraction of a frame.
   *
   * It is deliberately NOT the stereogram's own disparity. That comes to about
   * 5 cells at these settings, because `gain` puts the dog in the top fifth of
   * the depth range and MU flattens it further; 5 cells is plenty to see in
   * depth and very nearly nothing to see MOVE. Fusing and motion have
   * different thresholds, so the wiggle gets its own amplitude.
   *
   * 17, halved from 34, and picked on /stereo by watching it rather than
   * argued for. A wide sweep reads as the whole picture being dragged about; a
   * short one reads as the ground rocking behind a dog that is standing still,
   * which is the illusion this view is for. The dog is found in the boundary
   * between what moves and what does not, and that boundary is no less sharp
   * for the motion being small.
   */
  wig: 17,
  /*
   * ms per full back-and-forth of the ground. A PERIOD, not a flip rate: the
   * wiggle was a two-slide flip first, and a two-slide flip of a random-dot
   * field is about the weakest motion stimulus there is. Dots only match
   * between frames within a few dot-widths (Dmax); a 30px jump is far past
   * that, so what the eye got was flicker with a dog-shaped difference in its
   * texture, and it could barely be seen. The ground now slides CONTINUOUSLY
   * — a couple of px per frame, well inside Dmax — and the dog is the part
   * that does not.
   *
   * 300, down from 900 — the tuner's floor, and the fastest this can honestly
   * go. Halving the travel does NOT pay for cutting the period to a third: the
   * ground's peak speed is pi * wig / wigMs, so it went from ~119px/s to
   * ~178px/s, and at the 24fps cap that is ~7px per frame against ~5 before.
   * At dot 2 that is still under four dot-widths, which is inside Dmax and so
   * the field still reads as one sheet SLIDING rather than as flicker. Faster
   * or wider than this and the two multiply, the step leaves Dmax, and the
   * whole illusion collapses back into the two-slide flip this replaced.
   */
  wigMs: 300,
  /* 1 = two-tone: the palette's darkest and lightest only, one light dot in
     four. Applies to EVERY view — it started as a wiggle-only aid, and it was
     the setting that made the wiggle legible, so the stereogram wears the
     same field rather than changing clothes between views. See paint(). */
  tone: 0,
  blur: 0,
  n: 5,
};

/* Dithers the integer separation; kills "pizza-cutter" depth banding. */
function dfrac(x, y) {
  let h = (x * 2654435761 + y * 40503) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/* The STATIONARY dot texture. Same (x, y) always yields the same index. */
function tex(x, y, n) {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h >>> 8) % n;
}

export function createStereoDog(canvas, options = {}) {
  const opts = {
    maxWidth: Infinity,
    maxCells: 240000,
    colorMode: 'brand',
    /* explicit palette (hex strings or rgb triples); overrides colorMode and n */
    palette: null,
    guides: false,
    cover: false,
    maxFps: 0,
    maxDpr: 2,
    onFrame: null,
    pauseWhenOffscreen: true,
    measure: null,
    ...options,
  };
  const P = { ...STEREO_DEFAULTS, ...(options.params || {}) };

  const vctx = canvas.getContext('2d');
  let gW = 0, gH = 0, dotUsed = P.dot;
  let depth = null, rawSrc = null, raw = null, tmp = null, idx = null, sameBuf = null;
  let wigPlane = null, wigSlide = null, planeReady = false, wigT0 = 0;
  let grid = null, gctx = null, imgData = null, colors = [];
  let rt = null, rtBuf = null;
  let yaw = 0, lastDraw = 0, rafId = null, dirty = true, depthReady = false;
  let frames = 0, t0 = 0, fps = 0;
  let frozen = false, showDepth = false, invert = false;
  let view = 'sirds';   // 'sirds' | 'wiggle'
  let running = false, onScreen = true, destroyed = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(5, 1, 0.1, 400);
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setClearColor(0x000000, 1);

  const spinGroup = new THREE.Group();
  scene.add(spinGroup);
  const tiltGroup = new THREE.Group();
  spinGroup.add(tiltGroup);
  tiltGroup.rotation.x = TILT_X;
  tiltGroup.rotation.z = TILT_Z;

  const geom = buildCapsuleGeometry(P_DOG);
  applyLumpiness(geom, P_DOG);
  weldNormalsBySharedPosition(geom);
  tiltGroup.add(new THREE.Mesh(geom, new THREE.MeshBasicMaterial()));

  /*
   * The dog's real half-extents, swept over a full turn.
   *
   * Framing used to fit TOTAL_AXIAL — the 7-unit LENGTH — into whichever axis
   * was tighter. But the dog is tilted 25 degrees, so it is only about 3 units
   * wide on screen, and fitting its length into a narrow frame's width wasted
   * both axes: on a 402x780 phone the dog covered 56% of the width and 45% of
   * the height, filling neither.
   *
   * So: take the geometry's own bounding box (post-lumpiness, so the displaced
   * vertices count), push its corners through the tilt and every yaw the spin
   * will reach, and keep the worst case on each axis. Sweeping rather than
   * measuring the current pose matters because the dog turns — a frame that
   * fits it head-on clips it side-on, and a fit that changed as it rotated
   * would pump the image in and out.
   */
  tiltGroup.updateMatrix();
  let HALF_W = 0, HALF_H = 0, HALF_D = 0;
  {
    /*
     * Real vertices, not bounding-box corners. A box around a rounded capsule
     * has corners that stick out well past any actual surface, and fitting
     * those left about 20% of the frame unused on top of whatever `fill` asks
     * for — the dog reached 81% of its binding axis when it should have been
     * near 95%.
     */
    /*
     * One pass, no sweep, and exact — because the spin is about Y.
     *
     * Rotating a tilted vertex (x, y, z) by yaw leaves y untouched, so the
     * vertical extent is simply max |y|. And it carries x into
     * x·cos + z·sin, whose maximum over a full turn is the vertex's radius
     * from the Y axis: sqrt(x² + z²). So the widest the dog can ever get,
     * at any angle it will ever reach, is the largest such radius — no
     * sampling of yaw angles required, and no chance of stepping over the
     * true maximum between samples. Depth sweeps the same radius.
     *
     * Sampling 24 yaws over every vertex cost 23-60ms at startup; this is one
     * pass and correct rather than approximate.
     */
    const pos = geom.attributes.position;
    const v = new THREE.Vector3();
    let maxRadiusSq = 0;
    for (let vi = 0; vi < pos.count; vi++) {
      v.fromBufferAttribute(pos, vi).applyMatrix4(tiltGroup.matrix);
      const ay = v.y < 0 ? -v.y : v.y;
      if (ay > HALF_H) HALF_H = ay;
      const rSq = v.x * v.x + v.z * v.z;
      if (rSq > maxRadiusSq) maxRadiusSq = rSq;
    }
    HALF_W = HALF_D = Math.sqrt(maxRadiusSq);
  }

  /*
   * Linear view-space depth, not gl_FragCoord.z. The hardware depth buffer is
   * heavily non-linear — it spends its precision near the near plane — and a
   * stereogram needs depth proportional to real distance or the dog comes out
   * with a squashed nose and a flat back. 1 = nearest, matching SIRDS; the
   * cleared background stays 0, the far backplane.
   */
  const depthMat = new THREE.ShaderMaterial({
    uniforms: { uNear: { value: 0 }, uFar: { value: 1 } },
    vertexShader: `
      varying float vZ;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vZ;
      uniform float uNear;
      uniform float uFar;
      void main() {
        float t = clamp((vZ - uNear) / (uFar - uNear), 0.0, 1.0);
        gl_FragColor = vec4(vec3(1.0 - t), 1.0);
      }`,
  });
  scene.overrideMaterial = depthMat;

  /* E is the algorithm's eye separation in cells; the on-screen repeat is
     E/2 * dot. Confusing the two by a factor of 2 makes the image fuse on the
     second harmonic and ghost. */
  const eyeSep = () => Math.max(12, Math.round((2 * P.sep) / dotUsed));

  function buildColors() {
    if (opts.palette && opts.palette.length) {
      colors = opts.palette.map((c) => (typeof c === 'string' ? hex2rgb(c) : [c[0], c[1], c[2]]));
      P.n = colors.length;
      return;
    }
    colors = [];
    if (opts.colorMode === 'grey') {
      for (let i = 0; i < P.n; i++) {
        const v = Math.round(24 + (216 * i) / (P.n - 1));
        colors.push([v, v, v]);
      }
    } else {
      for (let i = 0; i < P.n; i++) colors.push(BRAND[i % BRAND.length]);
    }
  }

  /* `contain`: back off until BOTH axes hold the swept silhouette, so whichever
     axis is tighter is the one that fills. `fill` is the margin on top — 100
     touches the edges, 105 leaves a little air. */
  function fitCamera() {
    const fovY = THREE.MathUtils.degToRad(camera.fov);
    const fovX = 2 * Math.atan(Math.tan(fovY / 2) * camera.aspect);
    const k = P.fill / 100;
    const dist = Math.max(
      (HALF_H * k) / Math.tan(fovY / 2),
      (HALF_W * k) / Math.tan(fovX / 2)
    );
    camera.position.z = dist;
    /* near/far snug around the swept depth, not a guess: the frustum is what
       the depth shader normalises against, and spending it on empty space
       throws away the precision the relief is carved out of. */
    camera.near = Math.max(0.1, dist - HALF_D * 1.15);
    camera.far = dist + HALF_D * 1.15;
    camera.updateProjectionMatrix();
    depthMat.uniforms.uNear.value = camera.near;
    depthMat.uniforms.uFar.value = camera.far;
  }

  function layout() {
    if (destroyed) return;
    const box = opts.measure ? opts.measure() : canvas.parentElement.getBoundingClientRect();
    const availW = Math.min(box.width, opts.maxWidth);
    const availH = box.height;
    if (availW < 8 || availH < 8) return;

    /* Full-bleed on a desktop is a lot of cells. Coarsen the dot rather than
       drop the frame rate — the on-screen repeat is held at P.sep either way,
       so fusing is unaffected and the dots merely get chunkier. */
    dotUsed = P.dot;
    while ((availW / dotUsed) * (availH / dotUsed) > opts.maxCells && dotUsed < 8) dotUsed++;

    /*
     * `cover` rounds UP so the grid is at least as large as its box and the
     * surplus (under one dot) is clipped by the frame. Flooring leaves a strip
     * of background on two edges — letterboxing. The canvas is NEVER stretched
     * to fit: a stereogram only survives uniform scaling, and squeezing it in x
     * changes the on-screen period, which is the one number fusing depends on.
     */
    const grow = opts.cover ? Math.ceil : Math.floor;
    gW = Math.max(32, grow(availW / dotUsed));
    gH = Math.max(32, grow(availH / dotUsed));

    const dispW = gW * dotUsed, dispH = gH * dotUsed;
    const dpr = Math.min(window.devicePixelRatio || 1, opts.maxDpr);
    canvas.style.width = dispW + 'px';
    canvas.style.height = dispH + 'px';
    canvas.width = Math.round(dispW * dpr);
    canvas.height = Math.round(dispH * dpr);
    vctx.imageSmoothingEnabled = false;

    grid = document.createElement('canvas');
    grid.width = gW;
    grid.height = gH;
    gctx = grid.getContext('2d');
    imgData = gctx.createImageData(gW, gH);

    depth = new Float32Array(gW * gH);
    /* rawSrc holds the GPU's depth untouched; raw is scratch that conditioning
       is free to destroy. Keeping them separate is what lets the conditioning
       re-run — a changed slider, a changed palette — without another GPU pass,
       and it is why tuning works while frozen. */
    rawSrc = new Float32Array(gW * gH);
    raw = new Float32Array(gW * gH);
    tmp = new Float32Array(gW * gH);
    idx = new Uint8Array(gW * gH);
    wigPlane = new Float32Array(gW * gH);
    wigSlide = new Uint8Array(gW * gH);
    planeReady = false;
    sameBuf = new Int32Array(gW);

    if (rt) rt.dispose();
    rt = new THREE.WebGLRenderTarget(gW, gH, { depthBuffer: true });
    rtBuf = new Uint8Array(gW * gH * 4);
    renderer.setSize(gW, gH, false);
    camera.aspect = gW / gH;
    fitCamera();
    dirty = true;
    depthReady = false;
  }

  /* readRenderTargetPixels hands back rows bottom-up, so the copy flips y. */
  function depthFromScene() {
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(rt, 0, 0, gW, gH, rtBuf);
    renderer.setRenderTarget(null);
    for (let y = 0; y < gH; y++) {
      const src = (gH - 1 - y) * gW, dst = y * gW;
      for (let x = 0; x < gW; x++) rawSrc[dst + x] = rtBuf[(src + x) * 4] / 255;
    }
  }

  function boxBlur(src, r) {
    if (r <= 0) return;
    for (let y = 0; y < gH; y++) {
      const row = y * gW;
      let sum = 0, cnt = Math.min(r + 1, gW);
      for (let x = 0; x <= r && x < gW; x++) sum += src[row + x];
      for (let x = 0; x < gW; x++) {
        tmp[row + x] = sum / cnt;
        const add = x + r + 1, sub = x - r;
        if (add < gW) { sum += src[row + add]; cnt++; }
        if (sub >= 0) { sum -= src[row + sub]; cnt--; }
      }
    }
    for (let x = 0; x < gW; x++) {
      let sum = 0, cnt = Math.min(r + 1, gH);
      for (let y = 0; y <= r && y < gH; y++) sum += tmp[y * gW + x];
      for (let y = 0; y < gH; y++) {
        src[y * gW + x] = sum / cnt;
        const add = y + r + 1, sub = y - r;
        if (add < gH) { sum += tmp[add * gW + x]; cnt++; }
        if (sub >= 0) { sum -= tmp[sub * gW + x]; cnt--; }
      }
    }
  }

  /*
   * Only the DOG votes on the normalisation range. The backplane sits a long
   * way behind it, so stretching across the whole frame spends most of the
   * range on empty gap and flattens the dog into a cutout — it reads as a hole
   * in a wall rather than a sausage. Histogram the foreground alone, then set
   * the background down at a fixed `lift` below it.
   */
  function condition() {
    const HB = 256, hist = new Int32Array(HB);
    let fg = 0;
    for (let i = 0; i < rawSrc.length; i++) {
      if (rawSrc[i] <= 0.002) continue;
      const b = (rawSrc[i] * (HB - 1)) | 0;
      hist[b > HB - 1 ? HB - 1 : b]++;
      fg++;
    }
    const cut = Math.max(1, Math.round(fg * 0.005));
    let lo = 0, hi = 1, acc = 0;
    for (let b = 0; b < HB; b++) { acc += hist[b]; if (acc >= cut) { lo = b / (HB - 1); break; } }
    acc = 0;
    for (let b = HB - 1; b >= 0; b--) { acc += hist[b]; if (acc >= cut) { hi = b / (HB - 1); break; } }
    const span = Math.max(hi - lo, 1e-3);

    /*
     * The backdrop is a recessed box — walls near at the frame edge, falling
     * back to a flat rear wall — carried over from the dork-works poster.
     *
     * It is computed here rather than modelled, and that is the point: the
     * normalisation above histograms FOREGROUND pixels only, so room geometry
     * would join the dog's range and squash it back into the flat cutout this
     * code already had to be fixed for once. Background is a separate branch,
     * so the room lives there and the dog keeps the whole of [lift, 1].
     *
     * Scaling by `lift` is what guarantees the subject still pops: the walls
     * can come no further forward than the plane the dog's own depth starts at,
     * so the dog is always in front of the room, never tangled in it.
     *
     * Why bother, when a flat field already works: a constant-depth background
     * has a constant repeat, so it gives the eye nothing to lock onto and the
     * subject has to be found cold. A receding wall is a ramp of periods —
     * fuse anywhere on it and the dog pops out against something. That matters
     * more here than it did for the poster, because here the dog SPINS, and a
     * static scaffold is the thing that stays fused while it turns.
     */
    const lift = P.lift / 100;
    const room = P.room / 100;
    const wall = Math.max(P.wall / 100, 1e-3);
    for (let y = 0; y < gH; y++) {
      const v = y / (gH - 1);
      const row = y * gW;
      for (let x = 0; x < gW; x++) {
        const i = row + x;
        if (rawSrc[i] <= 0.002) {
          if (room <= 0) { raw[i] = 0; continue; }
          const u = x / (gW - 1);
          const edge = Math.min(u, 1 - u, v, 1 - v);
          raw[i] = edge < wall ? room * lift * (1 - edge / wall) : 0;
          continue;
        }
        let z = (rawSrc[i] - lo) / span;
        z = z < 0 ? 0 : z > 1 ? 1 : z;
        raw[i] = lift + (1 - lift) * z;
      }
    }

    /* Blur AFTER the remap, so it softens the silhouette rather than bleeding
       background into the dog before it has been measured. */
    boxBlur(raw, P.blur);

    const planes = P.planes, gain = P.gain / 100, smooth = planes > 32;
    for (let i = 0; i < raw.length; i++) {
      let z = invert ? 1 - raw[i] : raw[i];
      if (!smooth) z = Math.min(planes - 1, Math.floor(z * planes)) / (planes - 1);
      depth[i] = z * gain * 0.95;
    }
  }

  function makeSIRDS(E, n) {
    const s = sameBuf;
    for (let y = 0; y < gH; y++) {
      for (let x = 0; x < gW; x++) s[x] = x;
      const row = y * gW;
      for (let x = 0; x < gW; x++) {
        const z = depth[row + x];
        const sepf = ((1 - MU * z) * E) / (2 - MU * z);
        const sep = Math.floor(sepf + dfrac(x, y));
        let left = x - (sep >> 1), right = left + sep;
        if (left >= 0 && right < gW) {
          let visible = true, t = 1, zt;
          do {
            zt = z + (2 * (2 - MU * z) * t) / (MU * E);
            const zl = x - t >= 0 ? depth[row + x - t] : 0;
            const zr = x + t < gW ? depth[row + x + t] : 0;
            visible = zl < zt && zr < zt;
            t++;
          } while (visible && zt < 1 && x - t >= 0 && x + t < gW);
          if (visible) {
            let l = s[left];
            while (l !== left && l !== right) {
              if (l < right) { left = l; l = s[left]; }
              else { s[left] = right; left = right; right = l; l = s[left]; }
            }
            s[left] = right;
          }
        }
      }
      for (let x = gW - 1; x >= 0; x--) {
        idx[row + x] = s[x] === x ? tex(x, y, n) : idx[row + s[x]];
      }
    }
  }

  /*
   * THE WIGGLE — the stereogram's depth shown as MOTION PARALLAX instead of
   * binocular parallax: the ground sweeps sideways and back, the dog does not,
   * and the eye reads the figure out of the boundary between the two.
   *
   * THE TEXTURE IS THE STEREOGRAM ITSELF. Each frame samples the SIRDS's own
   * dot field (`idx`) at x offset by the cell's share of the current sweep —
   * not a fresh hash. At rest the wiggle frame is therefore bit-for-bit the
   * still frame, and the sweep is that exact picture with its ground sliding
   * and its dog staying put. This matters for the seams: a SIRDS carries a
   * horizontal grain — every dot is copied to the right at the repeat period,
   * and where depth changes two neighbours land on one target and come out the
   * same tone — and a hashed field has none. Built from a hash, switching views
   * changed the weave; built from `idx`, it is one field in three states.
   *
   * No single frame contains the dog any more than the still does. What
   * carries it is the motion: the ground translates as one rigid sheet, the
   * dog does not, and the eye reads the figure out of the boundary. Julesz's
   * kinematogram — no frame contains the figure, the sequence does.
   *
   * It asks nothing of the viewer: no fusing, no glasses, no several seconds of
   * staring. It is the answer to "what am I supposed to be seeing", for anyone
   * who cannot free-view, and for everyone else a way to check what they found.
   *
   * THE DOG HOLDS STILL AND THE ROOM SWIMS BEHIND IT — the arrangement kudzu's
   * wigglegrams settled on, where every frame is aligned on a focal point so the
   * subject does not skate about its own frame.
   *
   * What that needs is a RIGID GROUND. The background is pinned flat: no room,
   * no walls, one plane at one parallax, so all of it slides together. The
   * recessed box ramps the depth up towards the frame edge, so with it the walls
   * slid at one speed and the rear wall at another, and a motion field carrying
   * two speeds does not segment into figure and ground — it churns, with the dog
   * one more thing churning inside it. Losing the room here costs nothing: it
   * exists to give the eye a ramp of periods to FUSE against, and nothing fuses
   * in this view.
   *
   * BASE makes the silhouette a STEP rather than a slope. Every foreground cell
   * is pushed to at least BASE of the amplitude regardless of its own depth, so
   * the outline is a hard discontinuity in the motion field even where `blur`
   * has smeared the depth across it — and `blur` runs at 6 on a phone, which is
   * most of a silhouette. The dog's own relief lives in the [BASE, 1] remainder:
   * enough for the near flank to travel visibly less than the ends, not enough
   * for the body to look like it is coming apart while the room goes past.
   *
   * The mask is `rawSrc > 0.002` — the GPU's depth before conditioning, the same
   * test condition() uses to decide what is foreground. Thresholding the
   * CONDITIONED depth instead would break the moment `lift` moved, since the
   * room's walls are scaled by it.
   *
   * Split in two so the per-frame part is cheap: makePlane() turns depth into a
   * per-cell share of the sweep and runs only when the depth changes (a
   * re-pose, a slider); makeSlide() scales that by the sweep's current phase and
   * hashes a frame, and runs every frame. On a still dog the whole per-frame
   * cost is one multiply and one hash per cell — cheaper than the SIRDS pass.
   */
  function makePlane() {
    /* The dog's own relief gets the top quarter of the travel; the step from
       room to dog gets the other three. Lower, and the body pulls apart into
       bands moving at different speeds while it is supposed to be the still
       thing; higher, and it is a flat cutout again. */
    const BASE = 0.75;
    let fgLo = Infinity, fgHi = -Infinity, sum = 0, fg = 0;
    for (let i = 0; i < depth.length; i++) {
      if (rawSrc[i] > 0.002) {
        const v = depth[i];
        if (v < fgLo) fgLo = v;
        if (v > fgHi) fgHi = v;
        sum += v; fg++;
      }
    }
    if (!fg) { fgLo = 0; fgHi = 1; }
    const fgSpan = Math.max(fgHi - fgLo, 1e-6);
    /* The dog's mean depth is the plane that holds still. Ground is at 0. */
    const anchor = fg ? BASE + ((1 - BASE) * (sum / fg - fgLo)) / fgSpan : BASE;
    for (let i = 0; i < depth.length; i++) {
      const plane = rawSrc[i] > 0.002 ? BASE + ((1 - BASE) * (depth[i] - fgLo)) / fgSpan : 0;
      wigPlane[i] = plane - anchor;
    }
  }

  /* `phase` is -1..1: the sweep's current position. `wig` is the peak-to-peak
     travel in on-screen px, so half of it in cells is the amplitude each way.
     Shifts are ROUNDED, not dithered: the ground has one plane, so it lands on
     one integer and translates as a solid sheet, which is the whole point.
     Dithering the sub-cell part would have cells jumping at different moments
     and the sheet would shimmer instead of slide.

     Samples wrap within the row. What slides in at one edge is the far end of
     the same row of dots, which is as random as anything else in it — a seam
     in a random field is not a seam anyone can see. `idx` must be current:
     the caller runs makeSIRDS() whenever the pose or a parameter changes. */
  function makeSlide(phase) {
    const amp = ((P.wig / dotUsed) * 0.5) * phase;
    for (let y = 0; y < gH; y++) {
      const row = y * gW;
      for (let x = 0; x < gW; x++) {
        const i = row + x;
        let sx = (x - Math.round(amp * wigPlane[i])) % gW;
        if (sx < 0) sx += gW;
        wigSlide[i] = idx[row + sx];
      }
    }
  }

  function paint() {
    const px = imgData.data;
    if (showDepth) {
      const scale = Math.max((P.gain / 100) * 0.95, 1e-3);
      for (let i = 0, p = 0; i < depth.length; i++, p += 4) {
        const v = Math.round((depth[i] / scale) * 255);
        px[p] = px[p + 1] = px[p + 2] = v;
        px[p + 3] = 255;
      }
    } else if (P.tone) {
      /*
       * Two-tone: the palette's darkest and lightest, one light dot in four
       * on a dark field. Motion detection runs on LUMINANCE. Four brand
       * colours spend most of the field's contrast on hue — mustard and cta
       * blue are near each other in brightness — and a moving sheet of
       * hue-contrast is much harder to see move than the same sheet in
       * black and white. Sparse rather than half-and-half because a sparse
       * dot is a thing the eye can follow; a 50% field is a texture.
       *
       * On the STEREOGRAM this is a trade, and an honest one. Two dots only
       * "match" when they share an index, so the coincidental-match rate is
       * what the colour count buys: 1 in 4 with four colours, and at 25/75
       * two-tone it is 0.25² + 0.75² — 62%. That is the whole reason
       * /stereo-colours exists. It still fuses, on a noisier signal; it was
       * taken because the wiggle became legible in this field and it is one
       * picture, not one that changes clothes between views. The index
       * structure is untouched either way — linked cells share an index and
       * so share a tone — so nothing about the depth encoding moves.
       */
      const src = view === 'wiggle' ? wigSlide : idx;
      const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
      let dark = colors[0], light = colors[0];
      for (const c of colors) { if (lum(c) < lum(dark)) dark = c; if (lum(c) > lum(light)) light = c; }
      for (let i = 0, p = 0; i < src.length; i++, p += 4) {
        const c = src[i] === 0 ? light : dark;
        px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = 255;
      }
    } else {
      const src = view === 'wiggle' ? wigSlide : idx;
      for (let i = 0, p = 0; i < src.length; i++, p += 4) {
        const c = colors[src[i]] || colors[0];
        px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = 255;
      }
    }
    gctx.putImageData(imgData, 0, 0);
    vctx.imageSmoothingEnabled = false;
    vctx.drawImage(grid, 0, 0, gW, gH, 0, 0, canvas.width, canvas.height);

    if (opts.guides && !showDepth) {
      /* One REPEAT PERIOD apart, which is E/2 * dot, not E * dot. */
      const s = canvas.width / (gW * dotUsed);
      const sepPx = P.sep * s, cx = canvas.width / 2, y = 14 * s, r = 5 * s;
      vctx.fillStyle = '#000';
      vctx.beginPath(); vctx.arc(cx - sepPx / 2, y, r, 0, 7); vctx.fill();
      vctx.beginPath(); vctx.arc(cx + sepPx / 2, y, r, 0, 7); vctx.fill();
      vctx.fillStyle = '#fff';
      vctx.beginPath(); vctx.arc(cx - sepPx / 2, y, r * 0.55, 0, 7); vctx.fill();
      vctx.beginPath(); vctx.arc(cx + sepPx / 2, y, r * 0.55, 0, 7); vctx.fill();
    }
  }

  /*
   * A still stereogram is a still image, so it should cost nothing.
   *
   * The loop used to re-run SIRDS and repaint every frame even with the spin
   * off, which is ~9ms of main thread burnt to redraw pixels that had not
   * changed. Now the loop only runs while something is actually moving: it
   * draws once when marked dirty, then cancels itself. Any change — a slider,
   * a toggle, a resize — calls invalidate() to wake it back up.
   *
   * `maxFps` throttles the spin. Nothing about a rotating dog needs 60fps, and
   * this shares a main thread with the hero's dog and ScrollTrigger.
   */
  function frame(now) {
    if (!running || destroyed) return;
    const spinning = P.spin > 0 && !frozen;
    /* The wiggle keeps the loop alive on its own: the pose is not moving, the
       VIEW is, and it has two slides to alternate. */
    const moving = spinning || view === 'wiggle';
    if (!moving && !dirty) { stop(); return; }
    rafId = requestAnimationFrame(frame);
    if (!depth) return;

    if (opts.maxFps && lastDraw && now - lastDraw < 1000 / opts.maxFps - 0.5) return;
    const dt = lastDraw ? Math.min((now - lastDraw) / 1000, 0.05) : 0;
    lastDraw = now;

    if (!frozen) {
      yaw += (P.spin / 100) * 0.8 * dt;
      spinGroup.rotation.y = yaw;
      depthFromScene();
      depthReady = true;
    }
    /* Outside the frozen branch on purpose: freezing holds the POSE, it does
       not mean the conditioning sliders stop working. */
    if (depthReady) condition();
    if (view === 'wiggle') {
      /* Plane and stereogram only change when the depth does, and in this
         view the dog is normally still — so the steady per-frame work is
         makeSlide() alone, one lookup per cell. */
      if (spinning || dirty || !planeReady) {
        makePlane();
        makeSIRDS(eyeSep(), colors.length);
        planeReady = true;
      }
      if (!wigT0) wigT0 = now;
      makeSlide(Math.sin(((now - wigT0) / P.wigMs) * Math.PI * 2));
      paint();
    } else {
      makeSIRDS(eyeSep(), colors.length);
      paint();
    }
    if (opts.onFrame) opts.onFrame();
    dirty = false;
    frames++;
    if (!t0) t0 = now;
    if (now - t0 > 500) { fps = Math.round((frames * 1000) / (now - t0)); frames = 0; t0 = now; }
  }

  function start() {
    if (running || destroyed || !onScreen) return;
    running = true;
    lastDraw = 0;
    t0 = 0;
    rafId = requestAnimationFrame(frame);
  }

  /* Something changed: draw at least one more frame. */
  function invalidate() { dirty = true; start(); }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  /* A stereogram nobody is looking at is pure waste, and this can share a page
     with the hero's dog. Stop the loop whenever it scrolls away or the tab
     goes to the background. */
  let io = null;
  if (opts.pauseWhenOffscreen && 'IntersectionObserver' in window) {
    io = new IntersectionObserver(
      (entries) => {
        onScreen = entries[0].isIntersecting;
        if (onScreen) start(); else stop();
      },
      { rootMargin: '100px' }
    );
    io.observe(canvas);
  }
  const onVis = () => { if (document.hidden) stop(); else start(); };
  document.addEventListener('visibilitychange', onVis);

  let rid = null;
  const onResize = () => { clearTimeout(rid); rid = setTimeout(() => { layout(); invalidate(); }, 150); };
  window.addEventListener('resize', onResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);

  buildColors();
  layout();

  return {
    params: P,
    setParam(k, v) {
      P[k] = v;
      if (k === 'dot' || k === 'fill') layout();
      if (k === 'n') buildColors();
      invalidate();
    },
    layout() { layout(); invalidate(); },
    start,
    stop,
    get spinning() { return P.spin > 0; },
    setSpin(v) { P.spin = v; invalidate(); },
    get view() { return view; },
    /* 'sirds' | 'wiggle'. Switching restarts the sweep from centre, so the
       view always opens on the un-shifted frame rather than mid-swing. */
    setView(v) {
      view = v === 'wiggle' ? 'wiggle' : 'sirds';
      wigT0 = 0;
      invalidate();
    },
    get frozen() { return frozen; },
    setFrozen(v) { frozen = v; invalidate(); },
    setShowDepth(v) { showDepth = v; invalidate(); },
    setInvert(v) { invert = v; invalidate(); },
    setColorMode(m) { opts.colorMode = m; buildColors(); invalidate(); },
    /*
     * Paint the SAME dot field through an arbitrary palette.
     *
     * makeSIRDS emits colour INDICES, not colours — the pattern depends only on
     * how many there are, never on which. So every N-colour variant shares one
     * dot field and differs by a lookup table, which is what makes a sheet of
     * every combination cheap: one SIRDS per N, then a repaint each.
     */
    setPalette(arr) { colors = arr.map((c) => [c[0], c[1], c[2]]); P.n = arr.length; dirty = true; },
    /* Synchronous single frame, for callers driving this themselves rather than
       through the rAF loop. The pose does not change between variants, so the
       depth pass is computed once and reused. */
    renderNow(recomputeDepth) {
      if (!depth) return;
      if (recomputeDepth || !depthReady) { depthFromScene(); depthReady = true; }
      condition();
      makeSIRDS(eyeSep(), colors.length);
      if (view === 'wiggle') { makePlane(); planeReady = true; makeSlide(0); }
      paint();
      dirty = false;
    },
    get canvas() { return canvas; },
    setGuides(v) { opts.guides = v; invalidate(); },
    stats() { return { fps, gW, gH, dot: dotUsed, E: eyeSep() }; },
    /* test hooks; the tuner's verification harness leans on these */
    __internals: { depthFromScene, condition, makeSIRDS, makePlane, makeSlide, paint, eyeSep,
      get wigPlane() { return wigPlane; }, get wigSlide() { return wigSlide; },
      get depth() { return depth; }, get idx() { return idx; }, get raw() { return raw; },
      get gW() { return gW; }, get gH() { return gH; }, MU },
    destroy() {
      destroyed = true;
      stop();
      if (io) io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', onResize);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', onResize);
      if (rt) rt.dispose();
      geom.dispose();
      depthMat.dispose();
      renderer.dispose();
    },
  };
}
