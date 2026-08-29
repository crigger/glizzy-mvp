/**
 * orders/create webhook → writes the certificate URL onto the order, so it
 * shows in the admin (pinned metafield `glizzy.cert_url`) from the moment
 * the order exists — Adam wants the link visible while he's photographing
 * and numbering the dog, long before the buyer ever opens it.
 *
 * The webhook payload already carries everything the URL needs: the order
 * number and the order's own status token (`token`), the same one
 * `order_status_url` embeds — so no API read is required, only the one
 * metafield write. Non-glizzy orders are skipped without a write.
 *
 * SETUP (both, or this no-ops loudly in the function log):
 *   SHOPIFY_WEBHOOK_SECRET  Settings → Notifications → Webhooks — the
 *                           signing secret shown under the webhook list.
 *   The webhook itself      Order creation → https://glizzy.store/hooks/order-created
 *
 * The HMAC check is not optional: this endpoint is public, and without it
 * anyone could write metafields onto orders by POSTing here.
 */
import crypto from 'node:crypto';
import { adminGraphql, credentials } from '../shopify-admin.mjs';

export const config = { path: '/hooks/order-created' };

const BRAND = 'glizzy-store';

const SET_CERT_URL = `
mutation SetCertUrl($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    userErrors { field message }
  }
}`;

export default async function orderCreated(request) {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[order-created] SHOPIFY_WEBHOOK_SECRET not set — webhook ignored');
    return new Response('not configured', { status: 500 });
  }

  const raw = await request.text();
  const given = request.headers.get('x-shopify-hmac-sha256') ?? '';
  const computed = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('base64');
  const a = Buffer.from(given);
  const b = Buffer.from(computed);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.error('[order-created] HMAC mismatch — dropped');
    return new Response('unauthorized', { status: 401 });
  }

  let order;
  try {
    order = JSON.parse(raw);
  } catch {
    return new Response('bad payload', { status: 400 });
  }

  const isGlizzy = (order.line_items ?? []).some(
    (line) => (line.vendor ?? '').trim().toLowerCase() === BRAND
  );
  if (!isGlizzy || !order.token || !order.order_number || !order.admin_graphql_api_id) {
    console.log(`[order-created] skipped order ${order.order_number ?? '?'} (not glizzy, or fields missing)`);
    return new Response('skipped', { status: 200 });
  }

  const certUrl = `https://glizzy.store/cert/${order.order_number}-${order.token}`;
  const creds = credentials();
  if (!creds) {
    console.error('[order-created] admin credentials not set — cert_url not written');
    return new Response('not configured', { status: 500 });
  }

  try {
    const data = await adminGraphql(
      SET_CERT_URL,
      {
        metafields: [
          {
            ownerId: order.admin_graphql_api_id,
            namespace: 'glizzy',
            key: 'cert_url',
            type: 'url',
            value: certUrl,
          },
        ],
      },
      creds
    );
    const errs = data?.metafieldsSet?.userErrors ?? [];
    if (errs.length) {
      console.error(`[order-created] cert_url refused: ${JSON.stringify(errs).slice(0, 200)}`);
      return new Response('metafield refused', { status: 200 });
    }
    console.log(`[order-created] cert_url written for order ${order.order_number}`);
    return new Response('ok', { status: 200 });
  } catch (error) {
    console.error(`[order-created] cert_url write failed: ${error.message}`);
    // 200 anyway: Shopify retries failed webhooks and disables flappy ones,
    // and a missed cert_url is recoverable by hand — a disabled webhook is not.
    return new Response('write failed', { status: 200 });
  }
}
