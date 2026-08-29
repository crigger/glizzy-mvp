/**
 * Shared engine for the certificate design studio (dev-only). The routes —
 * /certificate and /certificate-[state] — are thin wrappers over this. The
 * site's output is static, so query strings never reach a prerendered route
 * even on the dev server; each state is its own PATH instead.
 *
 * The paper is contenteditable and every change (typed text OR DevTools
 * inline styles) is auto-logged to studio/cert-design.json, tagged with the
 * state it was made on. Rule-level Styles-panel edits touch no DOM and reach
 * only the ?inspect capture — port from BOTH logs.
 */
import { pageCertificate, pageHub, page404, page503 } from '../../netlify/functions/cert.mjs';

const SAMPLE = {
  issued: 'August 28, 2026',
  serial: 'GLZ-QNAE5P',
  title: 'Glizzy',
  photo: '/og.jpg', // stand-in; the real one is the order's glizzy.photo metafield
};

export const STATES: Record<string, () => string> = {
  cert: () => pageCertificate({ ...SAMPLE, unit: 1, count: 1 }),
  plain: () => pageCertificate({ ...SAMPLE, unit: 1, count: 1, photo: null }),
  multi: () => pageCertificate({ ...SAMPLE, serial: 'GLZ-3SDM9H', unit: 2, count: 3 }),
  hub: () =>
    pageHub({
      issued: SAMPLE.issued,
      units: [{ title: 'Glizzy' }, { title: 'Glizzy' }, { title: 'Glizzy' }],
      serials: ['GLZ-QNAE5P', 'GLZ-3SDM9H', 'GLZ-7WFK2T'],
      id: '1004-sampletoken',
    }),
  '404': () => page404(),
  '503': () => page503(),
};

const studio = (state: string) => `
<script src="/js/inspect-capture.js" defer></script>
<script>
  (() => {
    const paper = document.querySelector('.paper');
    if (!paper) return;
    paper.contentEditable = 'true';
    paper.style.outline = 'none';

    const bar = document.createElement('nav');
    bar.className = 'inspect-capture';
    bar.style.cssText = 'position:fixed;bottom:10px;left:10px;display:flex;gap:2px;background:#000d60;padding:4px;border-radius:99px;z-index:9;opacity:0.9;';
    for (const s of ${JSON.stringify(Object.keys(STATES))}) {
      const a = document.createElement('a');
      a.href = s === 'cert' ? '/certificate' : '/certificate-' + s;
      a.textContent = s;
      a.style.cssText = 'font:12px system-ui;color:#f7e0c5;text-decoration:none;padding:4px 10px;border-radius:99px;'
        + (s === ${JSON.stringify(state)} ? 'background:#ffa300;color:#000d60;font-weight:600;' : '');
      bar.appendChild(a);
    }
    document.body.appendChild(bar);

    const pill = document.createElement('div');
    // classed 'inspect-capture' so ?inspect ignores it — it rewrites its own
    // text on every save and was arriving in captures as a phantom edit
    pill.className = 'inspect-capture';
    pill.style.cssText = 'position:fixed;top:10px;right:10px;background:#000d60;color:#f7e0c5;font:12px system-ui;padding:6px 12px;border-radius:99px;opacity:0.85;z-index:9;';
    pill.textContent = 'cert studio · ${state} — logging…';
    document.body.appendChild(pill);

    let timer = null;
    const log = async () => {
      const styled = [...document.querySelectorAll('[style]')]
        .filter((el) => el !== pill && !bar.contains(el))
        .map((el) => ({
          el: el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
          css: el.getAttribute('style'),
        }));
      try {
        const res = await fetch('/__cert-studio-log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state: ${JSON.stringify(state)}, paperHTML: paper.outerHTML, inlineStyles: styled }),
        });
        pill.textContent = (await res.json()).ok
          ? 'cert studio · ${state} — saved ' + new Date().toLocaleTimeString()
          : 'cert studio · ${state} — SAVE FAILED';
      } catch (e) {
        pill.textContent = 'cert studio · ${state} — SAVE FAILED';
      }
    };
    const queue = () => { clearTimeout(timer); timer = setTimeout(log, 800); };
    // The pill and the ?inspect panel rewrite themselves; observing them fed
    // the logger its own status updates in a loop. Only real page mutations
    // queue a save.
    const ours = (n) => { const el = n.nodeType === 1 ? n : n.parentElement; return !!(el && el.closest('.inspect-capture')); };
    new MutationObserver((muts) => { if (muts.some((m) => !ours(m.target))) queue(); }).observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style'],
    });
    document.addEventListener('input', queue);
  })();
</script>`;

export function renderStudio(state: string): Response {
  if (!import.meta.env.DEV) {
    return new Response('The certificate studio runs on the dev server only — npm run dev, then /certificate.', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
  const render = STATES[state] ?? STATES.cert;
  let html = render();
  html = html.replace('</body>', studio(state in STATES ? state : 'cert') + '\n</body>');
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
