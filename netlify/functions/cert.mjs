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
      lineItems(first: 20) {
        nodes { title quantity vendor }
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
  const units = [];
  for (const line of lines) {
    const qty = Math.max(1, Number(line.quantity) || 1);
    for (let i = 0; i < qty; i++) units.push({ title: line.title });
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
        unit: n,
        count: units.length,
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
        unit: 1,
        count: 1,
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
 * The shell every state renders in. Same origin end to end: the fonts are the
 * site's own /fonts files, there is no script, and nothing loads from anyone
 * else — the certificate keeps the promise in the site's footer.
 */
function shell(title, body) {
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
  --bg: #000d60; --paper: #f7e0c5; --ink: #1a0e04;
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
.paper {
  background: var(--paper); max-width: 640px; width: 100%;
  padding: 40px 28px; border: 3px solid var(--dog); outline: 2px solid var(--mustard); outline-offset: 5px;
  text-align: center;
}
h1 { font-family: 'BN Magnolia', 'Sequoia Sans', sans-serif; font-weight: normal; font-size: clamp(2rem, 8vw, 3.1rem); line-height: 1.05; color: var(--dog); }
.kicker { font-family: 'Sequoia Sans', sans-serif; letter-spacing: 0.28em; text-transform: uppercase; font-size: 0.72rem; color: var(--faint); margin-bottom: 14px; }
.rule { border: 0; border-top: 2px solid var(--mustard); margin: 22px auto; width: 120px; }
p { line-height: 1.55; }
.lede { font-size: 1.05rem; margin: 0 auto; max-width: 46ch; }
.piece { font-size: 1.35rem; margin: 18px 0 4px; }
.meta { display: flex; justify-content: center; gap: 28px; flex-wrap: wrap; margin: 26px 0 6px; }
.meta div { min-width: 130px; }
.meta dt { font-family: 'Sequoia Sans', sans-serif; letter-spacing: 0.22em; text-transform: uppercase; font-size: 0.62rem; color: var(--faint); }
.meta dd { font-size: 1.05rem; margin-top: 4px; font-variant-numeric: tabular-nums; }
.fine { font-size: 0.8rem; color: var(--faint); max-width: 52ch; margin: 18px auto 0; }
.sig { margin-top: 26px; font-size: 0.85rem; color: var(--faint); }
.sig strong { font-family: 'Sequoia Sans', sans-serif; display: block; color: var(--ink); font-size: 1rem; letter-spacing: 0.04em; }
a { color: var(--dog); }
@media print {
  body { background: #fff; padding: 0; display: block; }
  .paper { max-width: none; border-color: #000; outline-color: #666; }
  .no-print { display: none; }
}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function pageCertificate({ issued, serial, title, unit, count }) {
  // The synonym ladder continues here and coins NEW rungs — nothing the site
  // already says. See glizzy voice notes before adding another.
  const paperOf =
    count > 1
      ? `<div><dt>Paper</dt><dd>${unit} of ${count}</dd></div>`
      : '';

  return shell(
    `Certificate ${serial} — Glizzy`,
    `<main class="paper">
  <p class="kicker">Glizzy Store · Bureau of Provenance</p>
  <h1>Certificate of Authenticity</h1>
  <hr class="rule">
  <p class="lede">This document certifies that the earthenware frankfurter described below is a genuine Glizzy: hand-formed from real American ground &mdash; kaolin out of the Georgia belt, ball clay out of West Tennessee, talc out of Montana &mdash; and fired to 1,828&deg;F (cone 06), a temperature no impostor sausage survives.</p>
  <p class="piece">${escapeHtml(title)}</p>
  <dl class="meta">
    <div><dt>Specimen no.</dt><dd>${escapeHtml(serial)}</dd></div>
    <div><dt>Issued</dt><dd>${escapeHtml(issued)}</dd></div>
    ${paperOf}
  </dl>
  <p class="fine">Authenticity is permanent. The mineral log above is real, the kiln does not negotiate, and this record can be re-summoned from its link forever. No blockchain was consulted.</p>
  <p class="sig">Witnessed at temperature by<br><strong>The Kiln</strong>Glizzy Store, glizzy.store</p>
  <p class="fine no-print"><a href="https://glizzy.store/">Return to the bun</a> &middot; print this if you care</p>
</main>`
  );
}

/*
 * An order holding several dogs gets a hub: each clay associate has its own
 * serial and its own paper, because framing one certificate for three
 * different sausages would be an insult to at least two of them.
 */
function pageHub({ issued, units, serials, id }) {
  const rows = units
    .map(
      (u, i) => `<p class="piece"><a href="/cert/${escapeHtml(id)}/${i + 1}">${escapeHtml(
        serials[i]
      )}</a> &mdash; ${escapeHtml(u.title)}</p>`
    )
    .join('\n');

  return shell(
    `Certificates — Glizzy`,
    `<main class="paper">
  <p class="kicker">Glizzy Store · Bureau of Provenance</p>
  <h1>Certificates of Authenticity</h1>
  <hr class="rule">
  <p class="lede">This order (${escapeHtml(issued)}) contains ${units.length} separately numbered clay associates. Each carries its own paper &mdash; open a specimen number below.</p>
  ${rows}
  <p class="fine">Authenticity is permanent, and it is per dog.</p>
  <p class="fine no-print"><a href="https://glizzy.store/">Return to the bun</a></p>
</main>`
  );
}

function page404() {
  return shell(
    'No such dog on file — Glizzy',
    `<main class="paper">
  <p class="kicker">Glizzy Store · Bureau of Provenance</p>
  <h1>No such dog on file</h1>
  <hr class="rule">
  <p class="lede">The bureau has checked its records twice and found no clay companion matching this link. Certificates are issued by the order confirmation email &mdash; follow the link from yours exactly, crumbs and all.</p>
  <p class="fine no-print"><a href="https://glizzy.store/">Return to the bun</a></p>
</main>`
  );
}

function page503() {
  return shell(
    'The bureau is closed — Glizzy',
    `<main class="paper">
  <p class="kicker">Glizzy Store · Bureau of Provenance</p>
  <h1>The bureau is briefly closed</h1>
  <hr class="rule">
  <p class="lede">The filing cabinet did not answer. Your certificate exists and is not going anywhere &mdash; try the same link again in a minute.</p>
</main>`
  );
}
