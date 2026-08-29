/**
 * The digital certificate of authenticity: `glizzy.store/cert/<order>-<token>`.
 *
 * Every order confirmation email carries a link here (the Order confirmation
 * notification template in the Shopify admin builds it — see CLAUDE.md). The
 * URL is its own credential: the token half is the same unguessable token
 * Shopify puts in the buyer's order-status URL, so only someone holding the
 * confirmation email can mint their certificate. Nothing here is stored and
 * nothing is written — the function looks the order up, checks the token,
 * and renders. Shopify remains the only database.
 *
 * WHY A FUNCTION AND NOT A ROUTE: orders happen after the build, and a
 * rebuild-per-order is a webhook, a build minute, and a failure mode per
 * sale. This needs the ADMIN API anyway (order lookup wants `read_orders`,
 * which the browser must never hold), so it was always going to be
 * server-side. `../shopify-admin.mjs` does the client-credentials exchange;
 * same contract as shopify-subscribe.mjs, same env, same org rules.
 *
 * WHAT THE PAGE CONTAINS: no personal data, deliberately. A certificate is
 * for showing people — it gets printed, shared, framed. Order number, date,
 * the piece, its serial if it has one. Never a name, never an address.
 *
 * THE SERIAL: read from the ORDER metafield `glizzy.serial` (single line
 * text, set by hand in the admin on the order after the piece is picked).
 * Absent is fine and expected for v1 — the certificate says the number is
 * still being assigned rather than inventing one.
 */
import crypto from 'node:crypto';
import { adminGraphql, credentials, getAdminToken } from '../shopify-admin.mjs';

export const config = { path: ['/cert/:id', '/cert/:id/:unit'] };

/** Which vendor this site certifies. Same boundary as the build's catalogue
 *  filter: an order with none of our line items gets no certificate here. */
const BRAND = 'glizzy-store';

const ORDER_QUERY = `
query CertOrder($q: String!) {
  orders(first: 1, query: $q) {
    nodes {
      id
      name
      createdAt
      cancelledAt
      statusPageUrl
      serial: metafield(namespace: "glizzy", key: "serial") { value }
      photo: metafield(namespace: "glizzy", key: "photo") {
        reference { ... on MediaImage { image { url } } }
      }
      lineItems(first: 20) {
        nodes { title quantity vendor customAttributes { key value } }
      }
    }
  }
}`;

/*
 * Serials are RANDOM, one per dog, minted the first time the order's
 * certificate is rendered and frozen into the `glizzy.serial` order
 * metafield as a comma-separated list — one entry per unit, in line order.
 * Random on purpose: a sequential number is a guessable pattern and leaks
 * the sales count; six characters from a 30-symbol alphabet (no 0/O/1/I/L/U)
 * is unguessable and unambiguous read aloud or written on clay. The
 * metafield is hand-editable and always wins: overwrite an entry to match a
 * number written on the piece itself.
 */
const SERIAL_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function mintSerial() {
  let tail = '';
  const bytes = crypto.randomBytes(6);
  for (const b of bytes) tail += SERIAL_ALPHABET[b % SERIAL_ALPHABET.length];
  return `GLZ-${tail}`;
}

const FREEZE_MUTATION = `
mutation CertFreezeSerial($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    userErrors { field message }
  }
}`;

/** The token that proves possession: the path segment Shopify puts after
 *  /orders/ in the buyer's own status-page URL. */
function tokenFromStatusPageUrl(statusPageUrl) {
  try {
    const segments = new URL(statusPageUrl).pathname.split('/');
    const at = segments.indexOf('orders');
    return at !== -1 ? segments[at + 1] || null : null;
  } catch {
    return null;
  }
}

/** Constant-time-ish compare; the tokens are high-entropy so this is belt and
 *  braces, but it costs three lines. */
function tokensMatch(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export default async function cert(request, context) {
  const id = context?.params?.id ?? '';

  // <digits>-<token>. The order number is digits only BEFORE it goes anywhere
  // near a search query; the token charset is Shopify's url-safe token.
  const match = /^(\d{1,10})-([A-Za-z0-9_-]{16,128})$/.exec(id);
  if (!match) return notFound();
  const [, orderNumber, token] = match;

  const creds = credentials();
  if (!creds) {
    console.error('[cert] SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET not set');
    return new Response(page503(), {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  let order;
  try {
    let data;
    try {
      data = await adminGraphql(ORDER_QUERY, { q: `name:#${orderNumber}` }, creds);
    } catch (error) {
      // A warm container can hold a token minted BEFORE a scope release for up
      // to 24h, and a scope failure is a 200-with-errors, so the 401 retry in
      // adminGraphql never fires. Mint fresh once; if it is genuinely not
      // granted, the retry fails the same way and the 503 below is honest.
      if (!/ACCESS_DENIED/.test(error.message)) throw error;
      await getAdminToken(creds, { force: true });
      data = await adminGraphql(ORDER_QUERY, { q: `name:#${orderNumber}` }, creds);
    }
    order = data?.orders?.nodes?.[0] ?? null;
  } catch (error) {
    // Includes "scope not granted" — which check-shopify-admin.mjs exists to
    // catch loudly before this ever does quietly.
    console.error(`[cert] order lookup failed: ${error.message}`);
    return new Response(page503(), {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  if (!order || order.cancelledAt) return notFound();

  const expected = tokenFromStatusPageUrl(order.statusPageUrl);
  if (!expected || !tokensMatch(token, expected)) return notFound();

  const lines = (order.lineItems?.nodes ?? []).filter(
    (line) => (line.vendor ?? '').trim().toLowerCase() === BRAND
  );
  if (lines.length === 0) return notFound();

  // One unit per physical dog: a line with quantity 3 is three units, three
  // serials, three papers.
  //
  // The ode: the buyer's PDP note travels as the line-item attribute `Note`
  // (ODE_KEY in cart.js — the two strings are a contract), so it is per LINE
  // and every unit of that line carries it onto its paper. It is buyer-typed
  // text on a page built to be shared, so the no-PII rule leans on the
  // 100-char three-line field and whoever typed it.
  const units = [];
  for (const line of lines) {
    const qty = Math.max(1, Number(line.quantity) || 1);
    const note =
      (line.customAttributes ?? []).find((a) => a.key === 'Note')?.value?.trim() || null;
    for (let i = 0; i < qty; i++) units.push({ title: line.title, note });
  }

  /*
   * The serials. The stored list always wins entry-for-entry — a previous
   * render froze it, or a hand wrote it to match the clay. Anything missing
   * (first render, or the order somehow grew) is minted now and the full
   * list frozen back. If the freeze fails the page still renders; the same
   * dogs just get re-minted serials until a freeze sticks, which is why the
   * freeze failure is loud in the log.
   */
  const stored = (order.serial?.value ?? '').split(/[,\s]+/).filter(Boolean);
  const serials = units.map((_, i) => stored[i] || mintSerial());
  if (serials.some((v, i) => v !== stored[i])) {
    try {
      const frozen = await adminGraphql(
        FREEZE_MUTATION,
        { metafields: [{ ownerId: order.id, namespace: 'glizzy', key: 'serial', type: 'single_line_text_field', value: serials.join(', ') }] },
        creds
      );
      const errs = frozen?.metafieldsSet?.userErrors ?? [];
      if (errs.length) console.error(`[cert] serial freeze refused: ${JSON.stringify(errs).slice(0, 200)}`);
    } catch (error) {
      console.error(`[cert] serial freeze failed: ${error.message}`);
    }
  }

  /* The portrait of the actual dog: the ORDER metafield glizzy.photo (file
   * reference, set by hand in the admin — upload the piece's photo before or
   * after fulfilling). Absent is fine; the paper simply has no plate. */
  const photo = order.photo?.reference?.image?.url ?? null;

  const issued = new Date(order.createdAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  });

  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    // The bearer token is in the URL; nothing shared should cache it.
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex',
    // Readable cross-origin: the URL itself is the credential, so a page
    // that already holds it gains nothing new — and it lets the admin-side
    // tooling verify a certificate without the token ever leaving the page.
    'Access-Control-Allow-Origin': '*',
  };

  // /cert/<id>/<n> — one dog's paper. n is 1-based and only reachable by
  // someone already holding the order link, so it carries no secret itself.
  const unitParam = context?.params?.unit;
  if (unitParam !== undefined) {
    const n = Number(unitParam);
    if (!Number.isInteger(n) || n < 1 || n > units.length) return notFound();
    return new Response(
      pageCertificate({
        issued,
        serial: serials[n - 1],
        title: units[n - 1].title,
        photo,
        note: units[n - 1].note,
      }),
      { status: 200, headers }
    );
  }

  if (units.length === 1) {
    return new Response(
      pageCertificate({
        issued,
        serial: serials[0],
        title: units[0].title,
        photo,
        note: units[0].note,
      }),
      { status: 200, headers }
    );
  }

  return new Response(
    pageHub({ issued, units, serials, id }),
    { status: 200, headers }
  );
}

function notFound() {
  return new Response(page404(), {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

/*
 * The Glizzy mark, verbatim from GlizzyMark.astro (same artwork as
 * public/icon-2c.svg, WITH the measured ground ring — see that component for
 * the numbers), except the ground circle is filled with this shell's --bg.
 * Inlined rather than read from the component at runtime because Netlify's
 * function bundle carries only what is imported — a fs.readFile of src/ would
 * work in dev and 404 in production.
 */
const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-11.735 -11.79 96.82 96.82" aria-hidden="true"><circle cx="36.675" cy="36.62" r="48.41" fill="var(--bg)"/><path fill="currentColor" d="m61.98 62.1.12-.12c.14-.14.25-.29.34-.46.14-.1.29-.22.45-.38.82-.93 1.31-1.32 1.76-1.76.46-.43.93-.86 1.65-1.89 1.41-2.08 1.25-2.18 2.43-4.37.58-1.1.75-1.71.96-2.3.11-.29.18-.6.31-.97.11-.37.29-.8.48-1.39.4-1.17.61-1.76.81-2.34.21-.58.38-1.18.65-2.4.11-.61.24-1.06.37-1.44.12-.37.24-.67.37-.97.12-.3.26-.6.36-.99s.18-.86.23-1.49c.06-1.26.08-1.9.07-2.53 0-.32 0-.63-.01-1.03-.02-.39-.05-.87-.08-1.5-.04-.63-.11-1.1-.15-1.49s-.09-.71-.14-1.02c-.11-.62-.2-1.25-.46-2.49-.12-.62-.27-1.07-.4-1.45-.14-.37-.25-.67-.39-.95-.14-.29-.28-.57-.43-.94-.08-.18-.15-.38-.24-.61s-.19-.48-.3-.78q-.165-.435-.3-.78c-.1-.22-.2-.42-.29-.59-.18-.35-.34-.62-.51-.89-.16-.27-.35-.53-.54-.86-.2-.33-.41-.75-.71-1.29-.58-1.1-.76-1.71-.94-2.33-.17-.63-.39-1.24-1.1-2.29-.76-1.01-1.21-1.46-1.69-1.88-.24-.21-.47-.42-.75-.7-.29-.27-.62-.6-1.05-1.05-1.75-1.77-1.68-1.86-3.6-3.46-.97-.79-1.54-1.08-2.08-1.4-.27-.16-.55-.3-.89-.49s-.73-.44-1.27-.75-.96-.53-1.31-.69c-.36-.15-.66-.25-.96-.35-.59-.21-1.19-.38-2.32-.89-1.14-.45-1.64-.89-2.16-1.3-.26-.21-.52-.41-.87-.62-.35-.19-.79-.37-1.4-.55-.61-.17-1.08-.25-1.46-.33-.39-.08-.7-.12-1.01-.15-.63-.07-1.25-.16-2.5-.31C40.42.01 39.94 0 39.55 0s-.71 0-1.02.03-.63.06-1.02.07c-.39 0-.86.03-1.48.04-2.49.07-2.48.24-4.94.55-1.23.17-1.86.15-2.52.1-.33-.03-.65-.03-1.05 0-.4.04-.87.09-1.48.28-.6.19-1.06.32-1.43.45-.37.14-.67.25-.96.35-.6.21-1.18.46-2.34.96-1.14.54-1.72.81-2.27 1.12-.28.15-.56.3-.91.49-.34.2-.74.45-1.29.78-.54.33-.92.61-1.25.82-.33.22-.59.39-.84.59-.5.38-1.03.73-1.99 1.55-.24.2-.45.39-.62.57s-.31.35-.42.52c-.24.32-.4.61-.56.9-.16.28-.3.59-.52.91-.21.34-.52.68-.92 1.15-.41.46-.74.79-1.03 1.05-.28.27-.52.48-.76.68-.24.21-.49.41-.75.7s-.56.65-.93 1.17c-.69 1.05-.98 1.61-1.23 2.19-.13.29-.26.57-.43.92s-.36.78-.65 1.33-.46.99-.63 1.34c-.15.36-.29.64-.39.93-.11.29-.22.58-.36.95-.15.36-.3.8-.49 1.39-.75 2.37-.94 2.32-1.45 4.77-.24 1.23-.25 1.86-.3 2.48-.03.31-.03.62-.05 1.01-.01.39-.06.85-.08 1.47S.13 35.7.1 36.08c-.02.39-.04.7-.07 1.01-.06.62-.08 1.25 0 2.5.06.62.11 1.09.14 1.48.04.39.08.7.11 1.01.04.31.06.63.13 1.01.07.39.16.85.28 1.46.3 1.22.41 1.84.57 2.45.07.31.15.61.25.99.11.38.27.82.48 1.42s.43 1.02.59 1.38c.17.36.31.64.47.91.32.54.6 1.11 1.22 2.2 1.24 2.19 1.62 1.95 3.05 3.97.38.49.65.87.9 1.16.26.29.46.52.67.75.4.47.85.9 1.69 1.8.88.86 1.34 1.28 1.83 1.66.48.38.96.78 1.93 1.53 1.97 1.48 1.85 1.65 3.98 2.93 1.07.63 1.63.9 2.17 1.2.27.15.55.28.9.45.35.16.77.38 1.35.6.58.23 1.01.4 1.37.55.36.14.65.24.95.35.58.23 1.17.41 2.37.75.61.14 1.05.27 1.43.39.37.12.67.21.97.31s.6.21.98.3.85.17 1.47.25c1.25.12 1.87.21 2.5.26.31.03.63.06 1.02.08s.87.02 1.5.01c.63 0 1.1-.1 1.49-.19.39-.1.69-.21.99-.35.6-.27 1.19-.5 2.41-.7 2.42-.44 2.53.02 4.94-.67.6-.18 1.04-.35 1.39-.53.35-.17.62-.34.89-.5s.53-.35.87-.53c.34-.2.76-.38 1.31-.66.56-.27.98-.45 1.32-.63s.62-.32.89-.46c.55-.27 1.08-.6 2.13-1.24 1.03-.69 1.56-1 2.07-1.35.26-.17.52-.34.84-.56.31-.23.67-.53 1.15-.92.32-.27.53-.55.66-.83.45-.26.87-.59 1.25-.94.02-.02.05-.04.08-.06ZM43.66 44.08c.31 1.23.59 2.44.83 3.62.2 1.26.43 2.48.67 3.66.2.57.41 1.15.61 1.72s.41 1.15.61 1.72q.3.855.63 1.8c.19.52.33 1.08.43 1.68q.03.42.24.96l.26 1.04c.03.33.06.69.1 1.08.08.32.09.57.02.76-.13.37-.22.6-.26.66-.13.15-.25.23-.36.26-.09.08-.26.09-.5.04-.09.08-.27.15-.54.22-.41.16-.88.34-1.4.53l-1.56.57c-.52.19-1.05.35-1.58.49q-.795.21-1.5.12c-.56-.06-1.11-.18-1.66-.37-.5-.73-.58-1.92-.73-2.73-.21-1.2-.45-2.36-.77-3.53-.87-3.2-1.77-6.39-2.58-9.6-.24-.95-.46-1.91-.68-2.88-.02.01-.03.02-.05.04-.43.42-.89.9-1.36 1.44-.36.5-.83 1-1.42 1.5-.51.42-1.12.98-1.83 1.67q-1.005.975-2.07 2.13l-2.13 2.07c-.63.69-1.22 1.31-1.78 1.84-.79.85-1.4 1.56-1.84 2.14l-1.07 1.04c-.35.19-.68.2-.99.04-.27-.04-.64-.26-1.1-.66v-.12c-.46-.4-.88-.87-1.26-1.42-.38-.47-.8-.95-1.27-1.42-.19-.2-.42-.4-.69-.59-.23-.24-.54-.48-.92-.71-.11-.2-.25-.37-.4-.53-.12-.04-.21-.14-.29-.3-.34-.43-.53-.83-.57-1.18-.11-.2-.07-.47.13-.82.2-.27.57-.64 1.12-1.09.47-.54 1.11-1.23 1.9-2.08.43-.5.97-1.06 1.6-1.67l3.85-3.74c.67-.58 1.26-1.07 1.77-1.49.36-.42.81-.9 1.36-1.44l1.78-1.73c.09-.09.2-.18.29-.28q-1.38-.345-2.73-.72c-3.19-.9-6.35-1.89-9.53-2.84-1.17-.35-2.32-.62-3.51-.86-.81-.17-2-.28-2.71-.8-.17-.55-.28-1.11-.33-1.67-.04-.47.02-.97.17-1.5s.33-1.05.53-1.57.41-1.03.61-1.54c.2-.52.39-.98.56-1.39.08-.27.15-.44.24-.53-.05-.24-.03-.41.06-.5.03-.11.12-.22.27-.35.07-.04.29-.12.67-.24.19-.06.44-.05.76.04.39.05.75.1 1.08.13l1.03.29c.36.16.67.25.95.27.6.11 1.15.27 1.67.47.62.23 1.21.46 1.78.68s1.13.43 1.7.65 1.13.43 1.7.65c1.18.28 2.39.53 3.64.77q1.77.42 3.6.93c.16.02.34.04.51.06-.11-.39-.24-.8-.38-1.23-.25-.56-.45-1.22-.59-1.98-.11-.65-.28-1.46-.53-2.42-.23-.91-.5-1.86-.81-2.86l-.73-2.88c-.28-.89-.52-1.71-.71-2.46-.34-1.11-.65-1.99-.93-2.66l-.37-1.44c.01-.4.16-.69.46-.88.17-.21.55-.42 1.12-.62l.1.06q.855-.3 1.86-.39c.6-.1 1.22-.22 1.86-.39.27-.07.55-.17.86-.3.32-.08.68-.23 1.08-.44.23 0 .45-.03.66-.08.09-.08.23-.11.4-.1.55-.08.98-.05 1.3.1.23 0 .44.17.64.52.13.31.26.81.39 1.52.23.68.51 1.57.85 2.68.22.63.43 1.37.65 2.22l1.32 5.2c.16.87.3 1.63.41 2.28.19.52.38 1.15.57 1.9l.55 2.15c.88-.85 1.75-1.67 2.63-2.44.98-.81 1.93-1.61 2.84-2.41.4-.46.79-.92 1.19-1.39.4-.46.79-.92 1.19-1.39.4-.46.81-.94 1.25-1.44.36-.42.77-.83 1.24-1.21.24-.15.47-.38.71-.69l.77-.75c.27-.19.57-.4.88-.63.24-.23.45-.36.65-.4.39-.07.62-.11.7-.11.19.04.33.1.41.18.12.04.21.18.29.41.12.04.27.16.46.36.35.28.73.59 1.15.95s.85.71 1.27 1.07.83.73 1.21 1.13.67.81.86 1.24q.345.765.51 1.62c-.38.8-1.37 1.46-2 2-.93.78-1.82 1.57-2.68 2.43-2.34 2.35-4.65 4.72-7.03 7.03-.54.52-1.08 1.04-1.64 1.55l2.22.63c.74.21 1.37.42 1.88.62.65.13 1.41.28 2.27.47l5.17 1.46c.85.24 1.58.48 2.2.71 1.1.37 1.98.67 2.66.92.7.14 1.21.28 1.51.43.34.21.51.43.5.66.14.32.16.76.06 1.3 0 .17-.03.31-.11.4-.06.21-.09.43-.1.66-.23.39-.38.75-.47 1.07-.14.3-.25.59-.33.85-.18.64-.33 1.25-.44 1.85-.07.67-.22 1.28-.44 1.85l.06.1c-.22.57-.44.93-.65 1.1-.2.29-.49.43-.89.43l-1.43-.4c-.66-.3-1.54-.64-2.63-1-.74-.21-1.56-.47-2.44-.78l-2.86-.81c-.99-.34-1.94-.63-2.84-.89-.95-.27-1.76-.47-2.41-.59-.76-.16-1.41-.37-1.96-.64-.43-.16-.83-.3-1.22-.42.02.18.04.35.05.51Z"/></svg>`;

/*
 * The shell every state renders in. Same origin end to end: the fonts are the
 * site's own /fonts files, there is no script, and nothing loads from anyone
 * else — the certificate keeps the promise in the site's footer.
 */
function shell(title, body, barTitle = 'Office of Provenance') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
@font-face { font-family: 'Sequoia Sans'; src: url('/fonts/SequoiaSans-Regular.woff2') format('woff2'); font-weight: 400; font-display: swap; }
@font-face { font-family: 'Sequoia Sans'; src: url('/fonts/SequoiaSans-Light.woff2') format('woff2'); font-weight: 300; font-display: swap; }
@font-face { font-family: 'BN Magnolia'; src: url('/fonts/BNMagnolia.woff2') format('woff2'); font-display: swap; }
@font-face { font-family: 'Bricolage Grotesque'; src: url('/fonts/BricolageGrotesque-VF.woff2') format('woff2-variations'); font-weight: 400 500; font-display: swap; }
:root {
  --bg: #000d60; --bg-bottom: #000d48; --paper: #f7e0c5; --ink: #1a0e04;
  --mustard: #ffa300; --dog: #dc512a; --faint: rgba(26, 14, 4, 0.55);
}
@media (color-gamut: p3) {
  :root { --bg: color(display-p3 0 0.04 0.27); --paper: color(display-p3 0.96 0.88 0.78); --mustard: color(display-p3 1 0.64 0.12); }
}
* { box-sizing: border-box; margin: 0; }
body {
  background: var(--bg); color: var(--ink);
  font-family: 'Bricolage Grotesque', 'Helvetica Neue', Arial, sans-serif;
  min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
}

/*
 * The standard window treatment, ported from the site's windows.scss: the
 * mustard chrome bar and the mustard keyline are the same colour so they
 * read as one drawn box (crest.red's trick), a dot screen over glass behind,
 * and the readable surface is an opaque bone card — nothing readable is
 * ever on the glass. Keep in step with WindowPanel.astro / windows.scss.
 */
.window {
  position: relative;
  max-width: 640px; width: 100%;
  color: var(--bg-bottom);
  border: 2px solid var(--mustard);
  border-radius: 8px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
  overflow: hidden;
  display: flex; flex-direction: column;
}
.window::before {
  content: '';
  position: absolute; inset: 0;
  background: radial-gradient(var(--mustard), 30%, transparent 0);
  background-position: 50%;
  background-size: 3px 3px;
  backdrop-filter: blur(5rem);
  -webkit-backdrop-filter: blur(5rem);
  pointer-events: none;
  z-index: 0;
}
.window-chrome {
  position: relative; z-index: 1;
  display: flex; align-items: center;
  padding: 7px 12px;
  background: var(--mustard);
  color: var(--bg);
  user-select: none;
}
.window-title {
  font: 11px/1 ui-monospace, SFMono-Regular, monospace;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-weight: 600;
}
.window-content { padding: 1rem; position: relative; z-index: 1; }

/*
 * The site's corner mark, fixed top-right like every other route — the way
 * home. Same artwork and sizing as SiteIcon/GlizzyMark on the site (56px box,
 * 16px inset); the ground circle is refilled with this page's --bg since the
 * shell has no --bg-top.
 */
.site-icon {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + 16px);
  right: calc(env(safe-area-inset-right, 0px) + 16px);
  width: 56px; height: 56px;
  color: var(--dog);
  display: block;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.site-icon svg { width: 100%; height: 100%; display: block; }
.site-icon:focus-visible { outline: 2px solid var(--mustard); outline-offset: 3px; border-radius: 50%; }
/* below ~784px the centred window slides under the mark's corner — clear it */
@media (max-width: 800px) { body { padding-top: 84px; } }

/* the paper is the window's bone card */
.paper {
  background: var(--paper); color: var(--ink);
  padding: 40px 28px; border-radius: 4px; text-align: center;
}
/* the floor is 1.6rem, not 2 — at 2 a 375px screen broke "Authenticity"
 * mid-word (Adam, 2026-08-29) */
h1 { font-family: 'Sequoia Sans', sans-serif; font-weight: normal; font-size: clamp(1.6rem, 7.6vw, 2.5rem); line-height: 1; color: var(--bg); max-width: 10em; margin: 0 auto; }
.kicker { font-family: 'Sequoia Sans', sans-serif; letter-spacing: 0.28em; text-transform: uppercase; font-size: 1rem; color: var(--bg); }
/* Adam's studio passes, 2026-08-29 (second pass walked the big script line
 * back down): the brand name stays kicker-sized in Magnolia, the office line
 * is Bricolage at kicker size, the two lines sit tight together. */
.kicker--brand { margin-bottom: -0.5em; }
.brand-script { font-family: 'BN Magnolia', 'Sequoia Sans', sans-serif; letter-spacing: 0.15em; }
.kicker--office { font-family: 'Bricolage Grotesque', 'Helvetica Neue', Arial, sans-serif; margin-bottom: 1rem; font-weight: 500; letter-spacing: 0.2em; }
.h1-of { font-stretch: normal; font-weight: 300; }
/* the terse 404/503 headlines wrap tighter (Adam, 2026-08-29) */
.h1--narrow { max-width: 7em; }
.rule { border: 0; border-top: 2px solid var(--mustard); margin: 22px auto; width: 120px; }
/* the plate is a fixed 4:3 frame (Adam, 2026-08-29) — the photo crops to it
 * rather than the frame stretching to the photo, so a square glizzy2048-style
 * shot can never push past the frame into the lede */
.plate { margin: 0 auto 22px; max-width: 26rem; aspect-ratio: 4 / 3; }
.plate img { display: block; width: 100%; height: 100%; object-fit: cover; border: 2px solid var(--mustard); border-radius: 8px; }
p { line-height: 1.55; }
.lede { font-size: 1.05rem; margin: 0 auto; max-width: 46ch; }
/* the certificate's own lede tightens up under the plate (Adam, 2026-08-29) */
.lede--cert { font-size: 1rem; font-weight: 500; line-height: 1.35; letter-spacing: 0.01em; word-spacing: 0.05em; text-wrap: balance; max-width: 26rem; }
/* the cert's fine print is one short uppercase line — the hub and 404 keep
 * the base .fine */
.fine--cert { max-width: 26rem; letter-spacing: 0.1em; word-spacing: 0.05em; text-wrap: balance; font-size: 0.75rem; font-weight: 500; line-height: 1.35; text-transform: uppercase; }
.piece { font-size: 1.35rem; margin: 18px 0 4px; }
.meta { display: flex; justify-content: center; gap: 28px; flex-wrap: wrap; margin: 26px 0 6px; }
.meta div { min-width: 130px; }
.meta dt { font-family: 'Sequoia Sans', sans-serif; letter-spacing: 0.22em; text-transform: uppercase; font-size: 0.62rem; }
.meta dd { font-size: 1.05rem; margin-top: 4px; font-variant-numeric: tabular-nums; }
/* the order's note, filed on the paper as typed: monospace in a --bg-keyline
 * box (Adam, 2026-08-29). pre-wrap because notes arrive with their own line
 * breaks. */
.note {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem; line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: break-word;
  outline: 2px solid var(--bg); border-radius: 4px;
  padding: 12px 16px; margin: 26px auto 0; max-width: 26rem;
}
.fine { margin: 3rem auto 0; }
.fine + .fine { margin-top: 0.75rem; }
a { color: var(--bg); }
@media print {
  body { background: #fff; padding: 0; display: block; }
  .window { max-width: none; box-shadow: none; border-color: #000; border-radius: 0; }
  .window::before { display: none; }
  .window-chrome { background: #fff; color: #000; border-bottom: 2px solid #000; }
  .no-print { display: none; }
}
</style>
</head>
<body>
<a class="site-icon no-print" href="https://glizzy.store/" aria-label="Glizzy Store — home">${MARK_SVG}</a>
<div class="window">
  <div class="window-chrome"><span class="window-title">${escapeHtml(barTitle)}</span></div>
  <div class="window-content">
${body}
  </div>
</div>
</body>
</html>`;
}

/* Exported for src/pages/certificate.ts — the dev-only design studio renders
 * THIS function with sample data, so the studio can never drift from what
 * buyers actually receive. */
export function pageCertificate({ issued, serial, title, photo = null, note = null }) {
  // The synonym ladder continues here and coins NEW rungs — nothing the site
  // already says. See glizzy voice notes before adding another.
  // No "Paper n of m" row on multi-dog papers (Adam, 2026-08-29) — the
  // specimen number already tells the dogs apart, and the hub does the
  // counting.
  return shell(
    `Certificate ${serial} — Glizzy`,
    // Adam's copy + studio passes, 2026-08-28/29 (ported from the studio log,
    // verbatim): the Harambe-era dating is his coinage, do not "fix" it.
    // it is ALWAYS "office", never "bureau" — Adam killed Bureau of
    // Provenance everywhere on 2026-08-29 — and his second pass CUT the
    // kiln signature and the long fine print — the paper ends on one line.
    `<main class="paper">
  <p class="kicker kicker--brand">Old Vinton <span class="brand-script">Glizzy</span></p>
  <p class="kicker kicker--office">Provenance Office</p>
  <h1><span class="h1-of">Certificate of</span> Authenticity</h1>
  <hr class="rule">
  ${photo ? `<figure class="plate"><img src="${escapeHtml(photo)}" alt="The certified specimen"></figure>` : ''}
  <p class="lede lede--cert">Be it known that the earthenware frankfurter ${photo ? 'pictured above' : 'described'} is a genuine Old Vinton Glizzy, hand-formed from real American ground in the era of our great Earth after Harambe.</p>
  <dl class="meta">
    <div><dt>Specimen no.</dt><dd>${escapeHtml(serial)}</dd></div>
    <div><dt>Issued</dt><dd>${escapeHtml(issued)}</dd></div>
  </dl>
  ${note ? `<p class="note">${escapeHtml(note)}</p>` : ''}
  <p class="fine fine--cert">Authenticity is permanent.</p>
</main>`,
    `Certificate · ${serial}`
  );
}

/*
 * An order holding several dogs gets a hub: each clay associate has its own
 * serial and its own paper, because framing one certificate for three
 * different sausages would be an insult to at least two of them.
 */
export function pageHub({ issued, units, serials, id }) {
  const rows = units
    .map(
      (u, i) => `<p class="piece"><a href="/cert/${escapeHtml(id)}/${i + 1}">${escapeHtml(
        serials[i]
      )}</a></p>`
    )
    .join('\n');

  return shell(
    `Certificates — Glizzy`,
    `<main class="paper">
  <p class="kicker kicker--brand">Old Vinton <span class="brand-script">Glizzy</span></p>
  <p class="kicker kicker--office">Provenance Office</p>
  <h1><span class="h1-of">Certificates of</span> Authenticity</h1>
  <hr class="rule">
  <p class="lede lede--cert">This order (${escapeHtml(issued)}) contains ${units.length} separately numbered clay associates. Each carries its own paper &mdash; open a specimen number below.</p>
  ${rows}
  <p class="fine fine--cert">Authenticity is permanent, and it is per dog.</p>
  <p class="fine fine--cert no-print"><a href="https://glizzy.store/">Return to Glizzy Store</a></p>
</main>`
  );
}

export function page404() {
  return shell(
    'No such dog on file — Glizzy',
    `<main class="paper">
  <p class="kicker kicker--brand">Old Vinton <span class="brand-script">Glizzy</span></p>
  <p class="kicker kicker--office">Provenance Office</p>
  <h1 class="h1--narrow">No such dog on file</h1>
  <hr class="rule">
  <p class="lede lede--cert">No clay companion matching this link. Certificates are issued by the shipping confirmation email.</p>
  <p class="fine fine--cert no-print"><a href="https://glizzy.store/">Return to Glizzy Store</a></p>
</main>`,
    'No such dog'
  );
}

export function page503() {
  return shell(
    'The office is closed — Glizzy',
    `<main class="paper">
  <p class="kicker kicker--brand">Old Vinton <span class="brand-script">Glizzy</span></p>
  <p class="kicker kicker--office">Provenance Office</p>
  <h1 class="h1--narrow">The office is briefly closed</h1>
  <hr class="rule">
  <p class="lede lede--cert">The filing cabinet did not answer. Your certificate exists and is not going anywhere &mdash; try the same link again in a minute.</p>
</main>`
  );
}
