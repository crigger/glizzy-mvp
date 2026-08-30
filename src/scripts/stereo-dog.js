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
const TOTAL_AXIAL = P_DOG.LENGTH + 2 * P_DOG.CAP_FULL * P_DOG.RADIUS;

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
export const STEREO_DEFAULTS = {
  sep: 101,    // ON-SCREEN repeat period in CSS px. See eyeSep() below.
  dot: 2,
  planes: 33,  // > 32 means unquantised
  gain: 80,
  spin: 0,
  fill: 105,
  lift: 40,
  /*
   * room 100 because anything less is invisible. The dog's whole relief is
   * about 7px of on-screen period; at room 45 the backdrop ramped 2.3px, under
   * the resolution of the recovery and near enough the flat field it replaced.
   * At 100 the walls ramp 5.3px — the same order as the subject — while still
   * capping at `lift`, so the dog stays strictly in front.
   *
   * wall 30 spreads that ramp gently (0.07px of period per cell; steep depth
   * gradients are what make SIRDS echo) and still leaves a flat rear wall in
   * the middle. Past about 40 the walls meet and there is no back wall left.
   */
  room: 100,
  wall: 30,
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
  let grid = null, gctx = null, imgData = null, colors = [];
  let rt = null, rtBuf = null;
  let yaw = 0, lastDraw = 0, rafId = null, dirty = true, depthReady = false;
  let frames = 0, t0 = 0, fps = 0;
  let frozen = false, showDepth = false, invert = false;
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

  function fitCamera() {
    const fovY = THREE.MathUtils.degToRad(camera.fov);
    const fovX = 2 * Math.atan(Math.tan(fovY / 2) * camera.aspect);
    const margin = TOTAL_AXIAL * (P.fill / 100);
    const dist = Math.max(margin / (2 * Math.tan(fovY / 2)), margin / (2 * Math.tan(fovX / 2)));
    camera.position.z = dist;
    const half = TOTAL_AXIAL * 0.7;
    camera.near = Math.max(0.1, dist - half);
    camera.far = dist + half;
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

  function paint() {
    const px = imgData.data;
    if (showDepth) {
      const scale = Math.max((P.gain / 100) * 0.95, 1e-3);
      for (let i = 0, p = 0; i < depth.length; i++, p += 4) {
        const v = Math.round((depth[i] / scale) * 255);
        px[p] = px[p + 1] = px[p + 2] = v;
        px[p + 3] = 255;
      }
    } else {
      for (let i = 0, p = 0; i < idx.length; i++, p += 4) {
        const c = colors[idx[i]] || colors[0];
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
    const moving = P.spin > 0 && !frozen;
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
    makeSIRDS(eyeSep(), colors.length);
    paint();
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
      paint();
      dirty = false;
    },
    get canvas() { return canvas; },
    setGuides(v) { opts.guides = v; invalidate(); },
    stats() { return { fps, gW, gH, dot: dotUsed, E: eyeSep() }; },
    /* test hooks; the tuner's verification harness leans on these */
    __internals: { depthFromScene, condition, makeSIRDS, paint, eyeSep,
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
