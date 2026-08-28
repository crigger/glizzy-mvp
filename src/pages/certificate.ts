/**
 * The certificate design studio, dev-only: the REAL renderer out of
 * netlify/functions/cert.mjs with sample data, served locally so the paper
 * can be reworked by hand — the whole thing is contenteditable, and every
 * change (typed text OR DevTools inline styles) is auto-logged to
 * studio/cert-design.json by a MutationObserver + the dev middleware. No
 * save button to forget: the email studio ate two of Adam's passes before
 * that lesson landed.
 *
 * In a production build this endpoint prerenders to a stub; the studio only
 * exists where its logging endpoint does, on the dev server.
 */
import type { APIRoute } from 'astro';
import { pageCertificate } from '../../netlify/functions/cert.mjs';

const STUDIO = `
<script src="/js/inspect-capture.js" defer></script>
<script>
  (() => {
    const paper = document.querySelector('.paper');
    if (!paper) return;
    paper.contentEditable = 'true';
    paper.style.outline = 'none';

    const pill = document.createElement('div');
    pill.style.cssText = 'position:fixed;top:10px;right:10px;background:#000d60;color:#f7e0c5;font:12px system-ui;padding:6px 12px;border-radius:99px;opacity:0.85;z-index:9;';
    pill.textContent = 'cert studio — logging…';
    document.body.appendChild(pill);

    let timer = null;
    const log = async () => {
      const styled = [...document.querySelectorAll('[style]')]
        .filter((el) => el !== pill)
        .map((el) => ({
          el: el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
          css: el.getAttribute('style'),
        }));
      try {
        const res = await fetch('/__cert-studio-log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paperHTML: paper.outerHTML, inlineStyles: styled }),
        });
        pill.textContent = (await res.json()).ok
          ? 'cert studio — saved ' + new Date().toLocaleTimeString()
          : 'cert studio — SAVE FAILED';
      } catch (e) {
        pill.textContent = 'cert studio — SAVE FAILED';
      }
    };
    const queue = () => { clearTimeout(timer); timer = setTimeout(log, 800); };
    new MutationObserver(queue).observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style'],
    });
    document.addEventListener('input', queue);
  })();
</script>`;

export const GET: APIRoute = async () => {
  if (!import.meta.env.DEV) {
    return new Response('The certificate studio runs on the dev server only — npm run dev, then /certificate.', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
  let html: string = pageCertificate({
    issued: 'August 28, 2026',
    serial: 'GLZ-QNAE5P',
    title: 'Glizzy',
    unit: 1,
    count: 1,
  });
  html = html.replace('</body>', STUDIO + '\n</body>');
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
};
