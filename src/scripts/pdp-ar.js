/**
 * Reveal the AR link only where it can actually open a viewer, and aim it at
 * the right one per platform. The link itself is static markup — see the PDP.
 *
 * iOS is feature-detected, not sniffed: `relList.supports('ar')` is true
 * exactly where AR Quick Look will intercept the anchor. Android has no such
 * probe, so it is the one UA check, and the href becomes a Scene Viewer
 * intent — which needs the ABSOLUTE https url of the GLB, hence built here
 * rather than in the markup. Everything else keeps the link hidden.
 */
const ar = document.getElementById('pdp-ar');
if (ar) {
  const a = document.createElement('a');
  if (a.relList && a.relList.supports && a.relList.supports('ar')) {
    // iOS: the rel="ar" + usdz href in the markup is already correct.
    ar.hidden = false;
  } else if (/android/i.test(navigator.userAgent) && ar.dataset.glb) {
    const glb = new URL(ar.dataset.glb, location.href).href;
    const fallback = encodeURIComponent(location.href);
    ar.removeAttribute('rel');
    ar.href =
      'intent://arvr.google.com/scene-viewer/1.0' +
      `?file=${encodeURIComponent(glb)}&mode=ar_preferred` +
      '#Intent;scheme=https;package=com.google.ar.core;' +
      `action=android.intent.action.VIEW;S.browser_fallback_url=${fallback};end;`;
    ar.hidden = false;
  }
}
