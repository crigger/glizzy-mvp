/**
 * The product page's dog: the same model as the hero, spinning on its own.
 *
 * NOT hero-dog.js. That module is the hero — it owns the pin-to-corner FLIP,
 * a ScrollTrigger, the `?debug` sliders and a hard `getElementById('hero-stage')`
 * at module scope, none of which exist here. What the two share is the MODEL,
 * which lives in dog-model.js, so the dog on this page cannot drift from the
 * one on the homepage.
 *
 * The lens is the hero's 5 degrees, deliberately. It is near-orthographic, and
 * it is the reason the dog reads as an even capsule rather than the cone a
 * normal 45-degree viewer makes of a long object — the same difference you see
 * between this and the GLB in Shopify's 3D viewer.
 *
 * It spins and nothing else — no drag. Reduced motion stops the spin, and
 * because there is no interaction to fall back on, the still photograph
 * underneath is what that reader gets.
 *
 * Bails out entirely if the canvas is absent, so importing it on a page with
 * no dog costs one failed lookup.
 */
import * as THREE from 'three';
import {
  makeAsteriskMaps,
  weldNormalsBySharedPosition,
  applyLumpiness,
  buildCapsuleGeometry,
} from './dog-model.js';

const canvas = document.getElementById('pdp-stage');
if (canvas) {
  /* The hero's values. Kept as constants: nothing here edits them live. */
  const P = { RADIUS: 1.0, LENGTH: 5.0, CAP_FULL: 1.0,
              LUMP_AMP: 0.10, LUMP_FREQ: 0.6, LUMP_SEED: 0 };
  const COLOR = 0xdc512a, ROUGH = 0.66;
  const TILT_X = THREE.MathUtils.degToRad(15);
  const TILT_Z = THREE.MathUtils.degToRad(-25);
  const SPIN = 0.8;
  const NOTCH_AMP = 0.175, NOTCH_POINTS = 6, NOTCH_SHARP = 13.5, NOTCH_SIZE = 0.5;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(5, 1, 0.1, 400);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 4);
  key.position.set(10, -10, 10);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xff7a4f, 0.2);
  rim.position.set(-3, -1, -2);
  scene.add(rim);

  const spinGroup = new THREE.Group(); scene.add(spinGroup);
  const tiltGroup = new THREE.Group(); spinGroup.add(tiltGroup);
  tiltGroup.rotation.x = TILT_X;
  tiltGroup.rotation.z = TILT_Z;

  const material = new THREE.MeshStandardMaterial({ color: COLOR, roughness: ROUGH, metalness: 0 });

  const totalAxial = P.LENGTH + 2 * P.CAP_FULL * P.RADIUS;
  const capH = P.CAP_FULL * P.RADIUS;
  const reach = Math.min(NOTCH_SIZE * capH, capH * 0.75);
  const { bumpCanvas, colorCanvas } = makeAsteriskMaps(1024, NOTCH_POINTS, NOTCH_SHARP, reach / totalAxial, 0.15);

  const bump = new THREE.CanvasTexture(bumpCanvas);
  bump.wrapS = THREE.RepeatWrapping; bump.wrapT = THREE.ClampToEdgeWrapping;
  bump.colorSpace = THREE.NoColorSpace;
  bump.anisotropy = renderer.capabilities.getMaxAnisotropy();
  material.bumpMap = bump;
  material.bumpScale = NOTCH_AMP * 5;

  const colour = new THREE.CanvasTexture(colorCanvas);
  colour.wrapS = THREE.RepeatWrapping; colour.wrapT = THREE.ClampToEdgeWrapping;
  colour.colorSpace = THREE.SRGBColorSpace;
  colour.anisotropy = renderer.capabilities.getMaxAnisotropy();
  material.map = colour;

  const geom = buildCapsuleGeometry(P);
  applyLumpiness(geom, P);
  weldNormalsBySharedPosition(geom);
  tiltGroup.add(new THREE.Mesh(geom, material));

  /*
   * Framing that does not assume a square box.
   *
   * The hero's canvas has `aspect-ratio: 1/1` so it can hard-code a square and
   * fit on the vertical FOV alone. This one sits in a frame whose shape used to
   * depend on the product photo, and passing a square buffer to a non-square
   * element is exactly how the dog came out squashed. So: real width AND
   * height, a real aspect, and a distance that satisfies whichever axis is
   * tighter — the model then letterboxes instead of distorting, whatever shape
   * the frame ends up.
   */
  function fitCamera() {
    const fovY = THREE.MathUtils.degToRad(camera.fov);
    const fovX = 2 * Math.atan(Math.tan(fovY / 2) * camera.aspect);
    const dist = Math.max(
      (totalAxial * 1.35) / (2 * Math.tan(fovY / 2)),
      (totalAxial * 1.35) / (2 * Math.tan(fovX / 2))
    );
    camera.position.z = dist;
    // Near/far snug around the model: at 5 degrees the camera is ~100 units out,
    // and a 0.1-to-400 frustum spends the depth buffer on empty space until the
    // far cap's imprint z-fights through the body.
    const half = totalAxial * 0.7;
    camera.near = Math.max(0.1, dist - half);
    camera.far = dist + half;
    camera.updateProjectionMatrix();
  }
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    fitCamera();
  }
  resize();
  new ResizeObserver(resize).observe(canvas);

  /*
   * NOT interactive. The hero's dog can be dragged; this one is a product
   * photograph that happens to turn, so it takes no pointer events at all —
   * see the `pointer-events: none` in shop.scss, which is what keeps a swipe
   * over it scrolling the page on a phone rather than being swallowed.
   */
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  let autoYaw = 0, last = 0;
  function tick(now) {
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now;
    if (!still.matches) autoYaw += SPIN * dt;
    spinGroup.rotation.y = autoYaw;
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  /*
   * Reveal only now. Everything above succeeded, so there is a dog to show; had
   * any of it thrown, the still photograph underneath stays visible instead of
   * a blank square.
   *
   * The flag goes on the FRAME because it drives two things — showing the
   * canvas and hiding the photo behind it, which has to happen because the
   * canvas is drawn with alpha and the photo would otherwise show through.
   */
  canvas.parentElement.classList.add('is-ready');
  requestAnimationFrame(tick);
}
