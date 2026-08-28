/*
 * PORTED FROM vinton.land verbatim below this banner — the three sites share
 * one Shopify store and one form shape, so this is the same contract: fix a
 * bug here and it wants fixing in the siblings. See that repo's CLAUDE.md
 * for the full story (client-credentials exchange, 24h tokens, org rules).
 */
/**
 * Shopify Admin API access for the Netlify functions.
 *
 * WHY THIS ISN'T JUST A TOKEN IN AN ENV VAR: the shop's app ("Vintonland Form
 * Connector") lives in the Dev Dashboard, and Dev Dashboard apps do not issue a
 * copyable `shpat_` token at all. You get a client ID and secret and exchange
 * them for an access token that **expires after 24 hours**. A token pasted into
 * Netlify would work for a day and then fail silently forever — which, given
 * this runs behind a form that deliberately never surfaces errors to the
 * visitor, is the worst possible failure mode. So the exchange happens here, on
 * demand.
 *
 * The client credentials grant only works when the app and the store are in the
 * SAME Shopify organization. Ours are (org "Vintonland").
 *
 * Lives outside `netlify/functions/` on purpose: everything inside that
 * directory is a candidate to be deployed AS a function, and this is a library.
 * The bundler follows the relative import and inlines it.
 *
 * Env (set in Netlify → Site configuration → Environment variables):
 *   PUBLIC_SHOPIFY_STORE_DOMAIN   e.g. vintonland.myshopify.com — already set
 *   SHOPIFY_CLIENT_ID             Dev Dashboard → app → App settings → Credentials
 *   SHOPIFY_CLIENT_SECRET         same screen. Secret. Never PUBLIC_.
 */

/** Pinned to the app version's `api_version`, and to fetchShopifyProducts.ts.
 *  Shopify retires a version about a year after release; move all three at once. */
export const API_VERSION = '2026-07';

/**
 * Cached across invocations that share a warm container, and only there —
 * module state on a serverless platform is a performance detail, never a
 * guarantee. A cold start just fetches a new token, which is one extra request.
 *
 * The 60s margin means a token is never handed out so close to expiry that the
 * request it was fetched for outlives it.
 */
let cachedToken = null;
let cachedUntil = 0;

export function credentials() {
  const domain = process.env.PUBLIC_SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!domain || !clientId || !clientSecret) return null;
  return { domain, clientId, clientSecret };
}

export async function getAdminToken(creds, { force = false } = {}) {
  if (!force && cachedToken && Date.now() < cachedUntil) return cachedToken;

  const response = await fetch(`https://${creds.domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
  });

  if (!response.ok) {
    // The body is Shopify's own error text; it names the cause (bad secret,
    // app not installed, app and store in different orgs) and contains no
    // credential of ours, so it is safe and useful to log.
    throw new Error(
      `token exchange ${response.status}: ${(await response.text()).slice(0, 200)}`
    );
  }

  const { access_token: token, expires_in: expiresIn } = await response.json();
  if (!token) throw new Error('token exchange returned no access_token');

  cachedToken = token;
  cachedUntil = Date.now() + Math.max(0, (Number(expiresIn) || 0) - 60) * 1000;
  return token;
}

/**
 * One Admin GraphQL call, with the token fetched (or reused) for you.
 *
 * GraphQL answers 200 with an `errors` array for things REST would 4xx, so
 * checking the HTTP status alone would read a schema error as success.
 *
 * A 401 is retried ONCE with a freshly-minted token: a cached token can be
 * revoked out from under us — by rotating the secret, or by reinstalling the
 * app — and the retry turns a day of silent failures into one slow request.
 */
export async function adminGraphql(query, variables, creds, { retryOn401 = true } = {}) {
  const token = await getAdminToken(creds);

  const response = await fetch(
    `https://${creds.domain}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (response.status === 401 && retryOn401) {
    await getAdminToken(creds, { force: true });
    return adminGraphql(query, variables, creds, { retryOn401: false });
  }
  if (!response.ok) {
    throw new Error(`Shopify HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const body = await response.json();
  if (body.errors?.length) {
    throw new Error(`Shopify GraphQL: ${JSON.stringify(body.errors).slice(0, 300)}`);
  }
  return body.data;
}
