/**
 * The 3D hot dog in the hero, and its pinned-mini state.
 *
 * Was an inline <script type="module"> with a jsdelivr importmap. three is an
 * npm dependency now and Vite bundles it, so nothing is fetched cross-origin.
 *
 * Wires the debug panel's "3D" tab, which is dev-only markup — every lookup
 * into it tolerates null.
 */
import * as THREE from 'three';
/*
 * The model itself lives in dog-model.js, shared with the product page's
 * canvas. Everything below is the HERO's: its lights, its lens, the spin,
 * the drag, the pin-to-corner FLIP and the debug wiring.
 */
import {
  makeAsteriskMaps,
  weldNormalsBySharedPosition,
  applyLumpiness,
  buildCapsuleGeometry,
} from './dog-model.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ───── tuning knobs (live-edited via debug panel "3D" tab) ─────
let RADIUS    = 1.0;
let LENGTH    = 5.0;
let TILT_X    = THREE.MathUtils.degToRad(15);
let TILT_Z    = THREE.MathUtils.degToRad(-25);
let SPIN      = 0.8;
let ROUGH     = 0.66;
let LUMP_AMP    = 0.10;
let LUMP_FREQ   = 0.6;
let LUMP_SEED   = 0;
let NOTCH_AMP    = 0.175;
let NOTCH_POINTS = 6;
let NOTCH_SHARP  = 13.5;     // line thickness in degrees (was: cos^k exponent)
const NOTCH_SIZE = 0.5;      // fraction of CAP HEIGHT covered by each line (apex → halfway down)
let CAP_FULL     = 1.0;      // 1 = pure hemisphere cap, < 1 = flatter/blunter pill ends
const COLOR   = 0xdc512a;

// ───── 3D value noise ─────

const heroCanvas = document.getElementById('hero-stage');
const heroScene  = new THREE.Scene();
// FOV 5° is effectively orthographic (< 2% near/far size delta even when the
// capsule rotates fully end-on). If it STILL reads as conical at this FOV, the
// hemisphere itself is the cause — a true hemisphere cap tapers from R at the
// seam to 0 at the apex over a distance of R, which the eye reads as a cone.
const heroCamera = new THREE.PerspectiveCamera(5, 1, 0.1, 400);
heroCamera.position.set(0, 0, 10);

const heroRenderer = new THREE.WebGLRenderer({ canvas: heroCanvas, antialias: true, alpha: true });
heroRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
heroRenderer.outputColorSpace = THREE.SRGBColorSpace;

// ───── lighting ─────
const ambientLight = new THREE.AmbientLight(0xffffff, 1.5);
heroScene.add(ambientLight);
const keyLight = new THREE.DirectionalLight(0xffffff, 4);
keyLight.position.set(10, -10, 10);
heroScene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xff7a4f, 0.2);
rimLight.position.set(-3, -1, -2);
heroScene.add(rimLight);

// ───── nested rotation groups ─────
const spinGroup = new THREE.Group(); heroScene.add(spinGroup);
const tiltGroup = new THREE.Group(); spinGroup.add(tiltGroup);

const material = new THREE.MeshStandardMaterial({ color: COLOR, roughness: ROUGH, metalness: 0 });
let mesh = null;

// Generate a procedural greyscale heightmap (used as a bumpMap) encoding the
// asterisk imprint at BOTH cap apexes. Bump-mapping is lighting-only — no real
// geometry exists at the imprint, so:
//   - There are no spoke-valley walls to tilt past the silhouette.
//   - Backface culling correctly hides the entire back cap and its imprint.
//   - The imprint reads as a pressed-in mark, but never punches through.
// LatheGeometry UVs are cylindrical: u wraps around the lathe axis, v runs
// along the profile from top apex (v=0) to bottom apex (v=1). The texture has
// the asterisk pattern at v<vReach (top cap region) and v>1-vReach (bottom cap).

// Generate BOTH the bump map (lighting perturbation) and a color-modulation
// map (so the valley actually reads as darker — bump maps can't darken the
// floor of a depression on their own because the floor's normal is unchanged).
// Both maps share the same depth field, so a single pass yields both.

// LatheGeometry has duplicated vertices at the lathe-closure seam (u=0 vs u=1)
// and at each pole ring. mergeVertices won't fold them because their UVs
// differ. computeVertexNormals therefore gives each duplicate a separate
// normal averaged from only its own side's faces, leaving a visible vertical
// seam after lighting. This pass averages normals across duplicate-position
// groups so the lighting reads smoothly while UVs stay intact for the bump map.


// Build the capsule from one continuous lathe profile (cap arc → straight cylinder
// → cap arc). Three.js's built-in CapsuleGeometry stitches three separate
// pieces; even after mergeVertices, the seam ring averages two very different
// surface tangents, leaving a faint shading band. A single lathe profile has
// matching tangents at the cap↔cylinder transition by construction, and lets us
// match cylinder ring density to cap-arc density so noise displacement reads
// uniformly along the whole length.

// Regenerate the asterisk bump-map canvas + texture. Called whenever the
// spoke count, sharpness, OR any geometry knob that changes the axial extent
// (RADIUS, LENGTH, CAP_FULL) is touched — vReach depends on those.
function updateBumpMap() {
  const totalAxial = LENGTH + 2 * CAP_FULL * RADIUS;
  // NOTCH_SIZE is fraction of CAP HEIGHT, so the imprint always starts at the
  // same relative spot on the cap regardless of CAP_FULL. NOTCH_SIZE=0.5 →
  // lines start at the halfway-mark of the dome.
  const capH    = CAP_FULL * RADIUS;
  const reach   = Math.min(NOTCH_SIZE * capH, capH * 0.75);
  const vReach  = reach / totalAxial;
  // darken: how dark the valley floor reads (0=no darkening, 1=black valley)
  const darken  = 0.15;
  const { bumpCanvas, colorCanvas } = makeAsteriskMaps(1024, NOTCH_POINTS, NOTCH_SHARP, vReach, darken);

  if (material.bumpMap) material.bumpMap.dispose();
  const bumpTex = new THREE.CanvasTexture(bumpCanvas);
  bumpTex.wrapS      = THREE.RepeatWrapping;
  bumpTex.wrapT      = THREE.ClampToEdgeWrapping;
  bumpTex.colorSpace = THREE.NoColorSpace;       // data, not sRGB
  bumpTex.anisotropy = heroRenderer.capabilities.getMaxAnisotropy();
  material.bumpMap = bumpTex;

  // Color-modulation map: multiplies material.color per-fragment so the
  // valley floor reads visibly darker, not just edge-shaded. Bump map only
  // perturbs normals — it can't darken a flat-bottomed depression's floor.
  if (material.map) material.map.dispose();
  const colorTex = new THREE.CanvasTexture(colorCanvas);
  colorTex.wrapS      = THREE.RepeatWrapping;
  colorTex.wrapT      = THREE.ClampToEdgeWrapping;
  colorTex.colorSpace = THREE.SRGBColorSpace;    // color, gets sRGB→linear
  colorTex.anisotropy = heroRenderer.capabilities.getMaxAnisotropy();
  material.map = colorTex;
  material.needsUpdate = true;
}

// NOTCH_AMP → bumpScale (lighting strength); cheap, no texture regen.
// Multiplier reduced (12 → 6) so wall normals perturb less aggressively, which
// tones down the specular highlight in the valley without losing depth.
function updateBumpScale() {
  material.bumpScale = NOTCH_AMP * 5;
}

function rebuildGeometry() {
  if (mesh) {
    tiltGroup.remove(mesh);
    mesh.geometry.dispose();
  }
  const geom = buildCapsuleGeometry({ RADIUS, LENGTH, CAP_FULL });
  applyLumpiness(geom, { LUMP_AMP, LUMP_FREQ, LUMP_SEED, RADIUS });
  // applyLumpiness re-runs computeVertexNormals; re-weld so the seam stays
  // shading-smooth.
  weldNormalsBySharedPosition(geom);
  updateBumpMap();
  updateBumpScale();
  mesh = new THREE.Mesh(geom, material);
  tiltGroup.add(mesh);
  fitCamera();
}

function fitCamera() {
  const totalLength = LENGTH + 2 * CAP_FULL * RADIUS;
  const fov = THREE.MathUtils.degToRad(heroCamera.fov);
  const padding = 1.35;
  const dist = (totalLength * padding) / (2 * Math.tan(fov / 2));
  heroCamera.position.z = dist;
  // Wrap near/far tight around the model. At very narrow FOV the camera sits
  // ~100+ units away, and a near=0.1/far=400 frustum wastes the depth buffer's
  // precision on empty space — the back cap's imprint then Z-fights through
  // the body. A snug window keeps all 24 bits of depth precision on the dog.
  const halfExtent = totalLength * 0.7;
  heroCamera.near = Math.max(0.1, dist - halfExtent);
  heroCamera.far  = dist + halfExtent;
  heroCamera.updateProjectionMatrix();
}

function heroResize() {
  const cssSize = heroCanvas.clientWidth; // square canvas
  if (!cssSize) return;
  heroRenderer.setSize(cssSize, cssSize, false);
  heroCamera.aspect = 1;
  heroCamera.updateProjectionMatrix();
  fitCamera();
}

rebuildGeometry();
heroResize();
window.addEventListener('resize', heroResize);

// ───── pointer drag (tilt) ─────
let dragging = false, lastDX = 0, lastDY = 0;
let userPitch = 0, userYaw = 0;
// Angular velocity carried over after the user releases the drag — decays
// exponentially in the animation loop for a natural "flick to spin" feel.
let vYaw = 0, vPitch = 0;
let lastMoveT = 0;
const DRAG_GAIN  = 0.008;
const FLING_DECAY = 2.5;   // higher = momentum dies faster (half-life ≈ ln2/k s)
const FLING_MIN   = 0.001; // rad/s below which we just snap velocity to 0

heroCanvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastDX = e.clientX; lastDY = e.clientY;
  lastMoveT = performance.now();
  vYaw = 0; vPitch = 0;   // grabbing kills any in-flight momentum
  heroCanvas.setPointerCapture(e.pointerId);
});
heroCanvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const now = performance.now();
  const dt  = Math.max(0.001, (now - lastMoveT) / 1000);
  const dx  = e.clientX - lastDX;
  const dy  = e.clientY - lastDY;
  lastDX = e.clientX; lastDY = e.clientY;
  lastMoveT = now;
  const dYaw   = dx * DRAG_GAIN;
  const dPitch = dy * DRAG_GAIN;
  userYaw   += dYaw;
  userPitch += dPitch;
  // Smoothed instantaneous velocity for momentum on release.
  const alpha = 0.6;
  vYaw   = vYaw   * (1 - alpha) + (dYaw   / dt) * alpha;
  vPitch = vPitch * (1 - alpha) + (dPitch / dt) * alpha;
});
function endHeroDrag(e) {
  if (!dragging) return;
  dragging = false;
  // If the pointer was held still before release, don't fling — zero velocity.
  if (performance.now() - lastMoveT > 80) { vYaw = 0; vPitch = 0; }
  try { heroCanvas.releasePointerCapture(e.pointerId); } catch {}
}
heroCanvas.addEventListener('pointerup',     endHeroDrag);
heroCanvas.addEventListener('pointercancel', endHeroDrag);
heroCanvas.addEventListener('pointerleave',  endHeroDrag);

document.getElementById('reset-drag')?.addEventListener('click', () => {
  userYaw = 0; userPitch = 0;
  vYaw = 0; vPitch = 0;
});

// ───── animation loop ─────
let lastTime = performance.now();
let autoYaw  = 0;
function animate(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  autoYaw += SPIN * dt;
  // Carry drag momentum: apply current velocity to user yaw/pitch, then decay
  // exponentially so the flick coasts and settles instead of snapping to stop.
  if (!dragging && (vYaw !== 0 || vPitch !== 0)) {
    userYaw   += vYaw   * dt;
    userPitch += vPitch * dt;
    const decay = Math.exp(-FLING_DECAY * dt);
    vYaw   *= decay;
    vPitch *= decay;
    if (Math.abs(vYaw)   < FLING_MIN) vYaw   = 0;
    if (Math.abs(vPitch) < FLING_MIN) vPitch = 0;
  }
  spinGroup.rotation.y = autoYaw + userYaw;
  tiltGroup.rotation.x = TILT_X + userPitch;
  tiltGroup.rotation.z = TILT_Z;
  heroRenderer.render(heroScene, heroCamera);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

// ───── 3D slider wiring ─────
function wire3D(id, outId, parse, fmt, set) {
  const el  = document.getElementById(id);
  const out = document.getElementById(outId);
  // Dev-only panel: in a production build these are null every time, and an
  // unguarded read here throws partway through module evaluation — after the
  // dog is on screen but before the mini-pin observer at the bottom is wired.
  if (!el || !out) return;
  out.textContent = fmt(parse(el.value));
  el.addEventListener('input', () => {
    const v = parse(el.value);
    set(v);
    out.textContent = fmt(v);
  });
}
wire3D('ctrl-radius',     'out-radius',     parseFloat, v => v.toFixed(2), v => { RADIUS    = v; rebuildGeometry(); });
wire3D('ctrl-length',     'out-length',     parseFloat, v => v.toFixed(1), v => { LENGTH    = v; rebuildGeometry(); });
wire3D('ctrl-tiltx',      'out-tiltx',      parseFloat, v => v.toFixed(0), v => { TILT_X    = THREE.MathUtils.degToRad(v); });
wire3D('ctrl-tiltz',      'out-tiltz',      parseFloat, v => v.toFixed(0), v => { TILT_Z    = THREE.MathUtils.degToRad(v); });
wire3D('ctrl-speed',      'out-speed',      parseFloat, v => v.toFixed(2), v => { SPIN      = v; });
wire3D('ctrl-rough',      'out-rough',      parseFloat, v => v.toFixed(2), v => { ROUGH     = v; material.roughness = v; });
wire3D('ctrl-lump',       'out-lump',       parseFloat, v => v.toFixed(3), v => { LUMP_AMP     = v; rebuildGeometry(); });
wire3D('ctrl-lumpfreq',   'out-lumpfreq',   parseFloat, v => v.toFixed(1), v => { LUMP_FREQ    = v; rebuildGeometry(); });
wire3D('ctrl-notch',      'out-notch',      parseFloat, v => v.toFixed(3), v => { NOTCH_AMP    = v;     updateBumpScale(); });
wire3D('ctrl-notchpts',   'out-notchpts',   parseFloat, v => v.toFixed(0), v => { NOTCH_POINTS = v | 0; updateBumpMap();  });
wire3D('ctrl-notchsharp', 'out-notchsharp', parseFloat, v => v.toFixed(1), v => { NOTCH_SHARP  = v;     updateBumpMap();  });
wire3D('ctrl-capfull',    'out-capfull',    parseFloat, v => v.toFixed(2), v => { CAP_FULL     = v; rebuildGeometry(); });
wire3D('ctrl-keyx',       'out-keyx',       parseFloat, v => v.toFixed(1), v => { keyLight.position.x = v; });
wire3D('ctrl-keyy',       'out-keyy',       parseFloat, v => v.toFixed(1), v => { keyLight.position.y = v; });
wire3D('ctrl-keyz',       'out-keyz',       parseFloat, v => v.toFixed(1), v => { keyLight.position.z = v; });
wire3D('ctrl-keyi',       'out-keyi',       parseFloat, v => v.toFixed(1), v => { keyLight.intensity  = v; });
wire3D('ctrl-amb',        'out-amb',        parseFloat, v => v.toFixed(2), v => { ambientLight.intensity = v; });
wire3D('ctrl-rimi',       'out-rimi',       parseFloat, v => v.toFixed(2), v => { rimLight.intensity = v; });

// ───── Colour pickers ─────────────────────────────────────────────────────
// All four update the CSS variables (used by the page background + SVG dog
// stroke gradient). Dog color also updates the 3D material; dog highlight +
// dog color both trigger an SVG rebuild so the stacked-stroke gradient is
// regenerated with the new colors.
function setRootVar(name, value) {
  document.documentElement.style.setProperty(name, value);
}
document.getElementById('ctrl-bgtop')?.addEventListener('input', (e) => {
  setRootVar('--bg-top', e.target.value);
});
document.getElementById('ctrl-bgbottom')?.addEventListener('input', (e) => {
  setRootVar('--bg-bottom', e.target.value);
});
document.getElementById('ctrl-dogcolor')?.addEventListener('input', (e) => {
  setRootVar('--dog-color', e.target.value);
  material.color.set(e.target.value);
  if (typeof rebuild === 'function') rebuild();   // SVG re-renders with new stroke color
});
document.getElementById('ctrl-doghi')?.addEventListener('input', (e) => {
  setRootVar('--dog-highlight', e.target.value);
  if (typeof rebuild === 'function') rebuild();
});

// Expose 3D state to the classic-script side so updateDebug can include it.
window.glizzy3D = {
  getStats() {
    return {
      RADIUS, LENGTH,
      TILT_X_deg: Math.round(THREE.MathUtils.radToDeg(TILT_X)),
      TILT_Z_deg: Math.round(THREE.MathUtils.radToDeg(TILT_Z)),
      SPIN, ROUGH: material.roughness,
      LUMP_AMP, LUMP_FREQ, LUMP_SEED,
      NOTCH_AMP, NOTCH_POINTS, NOTCH_SHARP, CAP_FULL,
      keyX: keyLight.position.x,
      keyY: keyLight.position.y,
      keyZ: keyLight.position.z,
      keyI: keyLight.intensity,
      ambI: ambientLight.intensity,
      rimI: rimLight.intensity,
    };
  }
};

/*
 * ───── GLB export, dev only ────────────────────────────────────────────────
 *
 * Shopify takes `.glb` for product media (and derives the USDZ it uses for AR
 * from it), but this dog only exists at runtime — it is built procedurally
 * every load. This lifts the live mesh out into a file.
 *
 * Three things have to be fixed on the way out, because a GLB is not a three.js
 * scene:
 *
 *   1. glTF HAS NO bumpMap. The exporter drops it silently, which would ship a
 *      smooth sausage with no asterisk imprint on the caps. The bump canvas is
 *      converted to a real normal map here (Sobel over the height field).
 *   2. glTF is in METRES. The model is 7 units long in scene space, which would
 *      arrive in AR as a seven-metre hot dog. Scaled to `lengthMetres`.
 *   3. The scene's mesh carries the hero's tilt and spin from its parent
 *      groups. Product media wants the object itself, so this exports a clean
 *      clone at identity — the viewer supplies the rotation.
 *
 * Called by scripts/export-dog-glb.mjs. Dev-only, so none of it — including
 * GLTFExporter — reaches the production bundle.
 */
if (import.meta.env.DEV) {
  /*
   * A single high-resolution frame, for product photography.
   *
   * Renders the LIVE scene — same geometry, same lights, same 5-degree lens —
   * so what comes out is the dog as the site draws it, not a re-lit copy.
   *
   * `yaw` is the spin in turns: 0 is the pose the page loads on.
   *
   * `toDataURL` immediately after `render()` works without
   * `preserveDrawingBuffer` because nothing has yielded to the compositor yet,
   * so the back buffer is still intact. Yield first — await anything — and it
   * comes back empty.
   */
  window.glizzy3D.renderFrame = ({ size = 2048, yaw = 0, transparent = true } = {}) => {
    const prevW = heroCanvas.width, prevH = heroCanvas.height;
    const prevRatio = heroRenderer.getPixelRatio();
    const prevYaw = spinGroup.rotation.y;

    heroRenderer.setPixelRatio(1);
    heroRenderer.setSize(size, size, false);
    heroCamera.aspect = 1;
    heroCamera.updateProjectionMatrix();
    fitCamera();
    heroRenderer.setClearAlpha(transparent ? 0 : 1);
    spinGroup.rotation.y = yaw * Math.PI * 2;
    heroRenderer.render(heroScene, heroCamera);
    const url = heroCanvas.toDataURL('image/png');

    // Put the page back the way it was — this runs against the live hero.
    spinGroup.rotation.y = prevYaw;
    heroRenderer.setPixelRatio(prevRatio);
    heroRenderer.setSize(prevW, prevH, false);
    heroResize();
    return url;
  };

  window.glizzy3D.exportGLB = async ({ lengthMetres = 0.15 } = {}) => {
    const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');

    /* Height field -> tangent-space normal map. */
    function normalMapFrom(canvas, strength) {
      const w = canvas.width, h = canvas.height;
      const src = canvas.getContext('2d').getImageData(0, 0, w, h).data;
      const out = document.createElement('canvas');
      out.width = w; out.height = h;
      const img = out.getContext('2d').createImageData(w, h);
      const at = (x, y) => {
        const xx = (x + w) % w;                          // wraps, like the texture
        const yy = Math.max(0, Math.min(h - 1, y));      // clamps, like the texture
        return src[(yy * w + xx) * 4] / 255;
      };
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
                   - (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
          const dy = (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
                   - (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
          let nx = dx * strength, ny = dy * strength, nz = 1;
          const len = Math.hypot(nx, ny, nz);
          nx /= len; ny /= len; nz /= len;
          const i = (y * w + x) * 4;
          img.data[i]     = (nx * 0.5 + 0.5) * 255;
          img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
          img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
          img.data[i + 3] = 255;
        }
      }
      out.getContext('2d').putImageData(img, 0, 0);
      return out;
    }

    const totalAxial = LENGTH + 2 * CAP_FULL * RADIUS;
    const scale = lengthMetres / totalAxial;

    const geom = mesh.geometry.clone();
    geom.scale(scale, scale, scale);
    /*
     * Lay it down. The capsule is built along Y, so it exports standing on
     * end — a viewer frames that as a vertical sausage, and AR stands it up on
     * the floor. Baked into the geometry rather than set as a node rotation so
     * the orientation survives any importer that flattens transforms.
     */
    geom.rotateZ(Math.PI / 2);
    geom.name = 'Glizzy';

    const exportMat = new THREE.MeshStandardMaterial({
      color: material.color.clone(),
      roughness: material.roughness,
      metalness: material.metalness,
      map: material.map,
    });
    if (material.bumpMap?.image) {
      const nrm = new THREE.CanvasTexture(normalMapFrom(material.bumpMap.image, material.bumpScale * 6));
      nrm.wrapS = THREE.RepeatWrapping;
      nrm.wrapT = THREE.ClampToEdgeWrapping;
      nrm.colorSpace = THREE.NoColorSpace;
      exportMat.normalMap = nrm;
    }

    const out = new THREE.Mesh(geom, exportMat);
    out.name = 'Glizzy';

    const buffer = await new GLTFExporter().parseAsync(out, { binary: true });
    const bytes = new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    geom.dispose();
    return {
      base64: btoa(bin),
      bytes: bytes.length,
      lengthMetres,
      triangles: geom.index ? geom.index.count / 3 : geom.attributes.position.count / 3,
    };
  };
}

document.getElementById('reroll-lump')?.addEventListener('click', () => {
  LUMP_SEED = (LUMP_SEED + 1 + Math.floor(Math.random() * 100)) | 0;
  rebuildGeometry();
});

// ───── Hero ↔ pinned-mini state ─────────────────────────────────────────────
// When no hero canvas wrap is in view, the canvas FLIPs to a fixed 148px box
// pinned at the top-right corner. When a wrap scrolls back in, it FLIPs back to
// fill THAT wrap. FLIP technique: snap the new state, measure the delta,
// transform the element back to its old visual position, then animate the
// transform to identity so it smoothly morphs between states.
//
// There are TWO wraps — the hero opening the page and its reprise closing it —
// and ONE canvas, which moves between them. That is the whole point of the
// closing hero: the dog you have been dragging around in the corner for four
// screens swells back to full size when you reach the bottom, and the existing
// FLIP already animates any rect to any other rect, so arriving from the corner
// costs nothing extra.
//
// The canvas is MOVED with appendChild rather than duplicated. A second canvas
// would mean a second WebGL context, a second dog to keep in sync, and a
// duplicate id; moving the element keeps its context, its geometry and its
// drag listeners intact.
const heroWraps = Array.from(document.querySelectorAll('.hero-canvas-wrap'));
let canvasIsMini    = false;
let canvasFlipping  = false;
const FLIP_DURATION = 480;

/** `wrap` is the wrap to fill, or null to pin to the corner. */
function flipCanvas(wrap) {
  const makeMini = wrap === null;
  // Nothing to do when already mini, or already filling this exact wrap.
  if (canvasFlipping) return;
  if (makeMini ? canvasIsMini : (!canvasIsMini && heroCanvas.parentElement === wrap)) return;
  canvasFlipping = true;
  const startRect = heroCanvas.getBoundingClientRect();
  if (makeMini) {
    heroCanvas.classList.add('mini');
  } else {
    heroCanvas.classList.remove('mini');
    // Re-home it BEFORE measuring the end rect, so the delta is measured
    // against where it is actually going.
    if (heroCanvas.parentElement !== wrap) wrap.appendChild(heroCanvas);
  }
  canvasIsMini = makeMini;
  const endRect = heroCanvas.getBoundingClientRect();
  const dx = startRect.left   - endRect.left;
  const dy = startRect.top    - endRect.top;
  const sx = startRect.width  / endRect.width;
  const sy = startRect.height / endRect.height;
  heroCanvas.style.transformOrigin = 'top left';
  heroCanvas.style.transform       = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
  heroCanvas.style.transition      = 'none';
  // Force reflow so the inverted transform applies before the next paint.
  void heroCanvas.offsetHeight;
  heroCanvas.style.transition = `transform ${FLIP_DURATION}ms cubic-bezier(0.4, 0, 0.2, 1)`;
  heroCanvas.style.transform  = '';
  setTimeout(() => {
    heroCanvas.style.transition      = '';
    heroCanvas.style.transformOrigin = '';
    heroResize();        // re-render at the new logical size
    canvasFlipping = false;
  }, FLIP_DURATION + 20);
}

// Observer watches every wrap. Mini only when NONE of them is in view; as soon
// as one is, the canvas goes to it.
//
// Tracked in a Set rather than acted on per-entry, because a single callback
// can carry "the opening one left" and "the closing one arrived" together, and
// reacting to them one at a time would flip twice — the second flip landing
// while the first is still running, which `canvasFlipping` would drop on the
// floor.
const wrapsInView = new Set();
const heroObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) wrapsInView.add(entry.target);
    else                      wrapsInView.delete(entry.target);
  }
  // Document order, so if both are somehow visible the top one wins.
  flipCanvas(heroWraps.find((w) => wrapsInView.has(w)) ?? null);
}, { threshold: 0 });
heroWraps.forEach((w) => heroObserver.observe(w));

// Keep the canvas's internal render size in sync if the wrap resizes (e.g.
// on window resize) — the existing window resize listener calls heroResize
// already, but ResizeObserver catches CSS-only changes too.
new ResizeObserver(() => { if (!canvasFlipping) heroResize(); })
  .observe(heroCanvas);
