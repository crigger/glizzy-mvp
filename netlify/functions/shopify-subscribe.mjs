/*
 * PORTED FROM vinton.land verbatim below this banner — the three sites share
 * one Shopify store and one form shape, so this is the same contract: fix a
 * bug here and it wants fixing in the siblings. See that repo's CLAUDE.md
 * for the full story (client-credentials exchange, 24h tokens, org rules).
 */
/**
 * Turns a verified contact-form submission into a subscribed Shopify customer.
 *
 * WHY A FUNCTION AND NOT THE BROWSER: this needs the Shopify ADMIN API, whose
 * token can create and read every customer in the store. That token cannot go
 * anywhere near the client — the Storefront token the shop already uses is
 * public by design, but this one is not, and Astro would inline it into the
 * bundle if it were ever named `PUBLIC_*`. Running here keeps it server-side
 * and keeps the browser posting to nothing but this site's own origin, which
 * is the property the rest of the site is built around.
 *
 * WHEN IT RUNS: Netlify fires `formSubmitted` after it has accepted and
 * verified a submission — so the message is already saved before this executes.
 * The return value is ignored by the platform and nothing here can reject a
 * submission: if Shopify is down, or the token is missing, or the email is
 * malformed, the message is still safely in Netlify and only the subscription
 * is lost. That ordering is deliberate. A contact form whose messages can be
 * dropped by a CRM outage is worse than one that occasionally misses a signup.
 *
 * SETUP (all three, or this no-ops and says so in the function log):
 *   PUBLIC_SHOPIFY_STORE_DOMAIN    Already set for the shop; reused here.
 *   SHOPIFY_CLIENT_ID              Dev Dashboard → app → App settings → Credentials
 *   SHOPIFY_CLIENT_SECRET          Same screen. Secret. Never PUBLIC_.
 *
 * There is no admin token to paste: this app lives in the Dev Dashboard, which
 * issues a client id/secret rather than a `shpat_` token, and the token those
 * buy expires in 24 hours. `../shopify-admin.mjs` does that exchange.
 */
import { adminGraphql, credentials } from '../shopify-admin.mjs';

/** Where Shopify records the subscription as having come from. Shows on the
 *  customer's consent record, so a "why am I getting this?" reply is answerable. */
/*
 * The tag every submitter gets, naming WHICH SITE's form they came through —
 * three storefronts share this one customer list, and the tag is the only
 * thing distinguishing a glizzy person from a vinton person in the admin.
 *
 * Derived from Netlify's own runtime URL rather than written per site, which
 * is what lets this file stay verbatim-identical across the three repos. The
 * first ported copies hardcoded "vinton.land contact form" and mislabelled
 * every glizzy and mmmornings signup until this.
 */
const SITE_HOST = (() => {
  try { return new URL(process.env.URL).host; } catch { return 'unknown-site'; }
})();
const CONSENT_SOURCE = `${SITE_HOST} contact form`;

/*
 * tagsAdd, NEVER customerUpdate(tags): update REPLACES the whole tag list,
 * which would strip Shopify's own tags ("Login with Shop", "Shop") off a
 * customer for the crime of writing in. tagsAdd is additive and ignores
 * duplicates, so it is safe to fire on every path.
 */
const ADD_TAGS = `
  mutation TagCustomer($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

const CREATE_CUSTOMER = `
  mutation SubscribeCustomer($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer {
        id
        defaultEmailAddress { emailAddress marketingState marketingOptInLevel }
      }
      userErrors { field message }
    }
  }
`;

const FIND_CUSTOMER = `
  query FindCustomerByEmail($query: String!) {
    customers(first: 1, query: $query) {
      nodes {
        id
        defaultEmailAddress { emailAddress marketingState }
      }
    }
  }
`;

const UPDATE_CONSENT = `
  mutation ResubscribeCustomer($input: CustomerEmailMarketingConsentUpdateInput!) {
    customerEmailMarketingConsentUpdate(input: $input) {
      customer {
        id
        defaultEmailAddress { emailAddress marketingState marketingOptInLevel }
      }
      userErrors { field message }
    }
  }
`;

/**
 * "Ada Lovelace" -> first "Ada", last "Lovelace". "Cher" -> first "Cher".
 *
 * Everything after the first space is the surname, which keeps "van der Berg"
 * together. It gets some names wrong, and that is accepted: this is one free
 * text box, not a name parser, and Shopify shows both fields for editing.
 */
function splitName(full) {
  const clean = String(full ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) return { firstName: undefined, lastName: undefined };
  const gap = clean.indexOf(' ');
  if (gap === -1) return { firstName: clean, lastName: undefined };
  return { firstName: clean.slice(0, gap), lastName: clean.slice(gap + 1) };
}

/** Cheap sanity check, not validation. The browser already enforced
 *  `type="email"`; this only stops an obviously junk value costing an API call. */
function looksLikeEmail(value) {
  return typeof value === 'string' && /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value.trim());
}

export default {
  async formSubmitted(event) {
    const data = event?.data ?? {};

    // The submitted `form-name` is the only thing distinguishing this form from
    // any future one. It is not guaranteed to survive into `event.data`, so a
    // missing value is treated as "the only form we have" rather than a reason
    // to bail — but a value that names a DIFFERENT form is respected.
    const formName = data['form-name'];
    if (formName && formName !== 'contact') {
      console.log(`[shopify-subscribe] ignoring submission from form "${formName}"`);
      return;
    }

    const creds = credentials();
    if (!creds) {
      // Not an error. The form works without Shopify, and this is what a
      // half-configured site should say instead of throwing on every message.
      console.warn(
        '[shopify-subscribe] skipped — set PUBLIC_SHOPIFY_STORE_DOMAIN, ' +
          'SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in the Netlify site environment.'
      );
      return;
    }

    const email = String(data.email ?? '').trim().toLowerCase();
    if (!looksLikeEmail(email)) {
      console.warn('[shopify-subscribe] no usable email on the submission; nothing to do.');
      return;
    }

    const consent = {
      marketingState: 'SUBSCRIBED',
      marketingOptInLevel: 'SINGLE_OPT_IN',
      consentUpdatedAt: new Date().toISOString(),
    };

    try {
      const { firstName, lastName } = splitName(data.name);
      const created = await adminGraphql(
        CREATE_CUSTOMER,
        {
          input: {
            email,
            firstName,
            lastName,
            emailMarketingConsent: consent,
            tags: [CONSENT_SOURCE],
            // The message on the customer record, so the person who replies has
            // the thing they're replying to. Truncated well inside Shopify's
            // limit; Netlify keeps the untruncated original either way.
            note: String(data.message ?? '').slice(0, 4000) || undefined,
          },
        },
        creds
      );

      const customer = created?.customerCreate?.customer;
      const errors = created?.customerCreate?.userErrors ?? [];

      if (customer) {
        console.log(`[shopify-subscribe] created ${customer.id} — SUBSCRIBED`);
        return;
      }
      // No customer AND no error means the response wasn't the shape we expect.
      // Reaching into it anyway threw a `Cannot read properties of undefined`
      // that said nothing about the real problem; this at least names it.
      if (!errors.length) {
        console.error(`[shopify-subscribe] unexpected customerCreate response: ${JSON.stringify(created).slice(0, 300)}`);
        return;
      }

      // An address already on file is the ordinary case, not a failure: someone
      // who bought a sticker and later writes in. Anything else is a real error.
      const alreadyExists = errors.some((e) => /taken|already/i.test(e.message ?? ''));
      if (!alreadyExists) {
        console.error(`[shopify-subscribe] customerCreate refused: ${JSON.stringify(errors)}`);
        return;
      }

      const found = await adminGraphql(
        FIND_CUSTOMER,
        // Quoted, so an address with a `-` or a space can't be read as query syntax.
        { query: `email:"${email.replace(/"/g, '')}"` },
        creds
      );
      const existing = found?.customers?.nodes?.[0];
      if (!existing) {
        console.error(`[shopify-subscribe] Shopify says ${email} exists but it is not findable.`);
        return;
      }

      // Don't rewrite consent for someone who already said yes — it would move
      // their consent date forward and overwrite the real one.
      // Whatever happens to consent below, this site's tag is earned by the
      // submission itself. Additive and idempotent — see ADD_TAGS.
      await adminGraphql(ADD_TAGS, { id: existing.id, tags: [CONSENT_SOURCE] }, creds);

      if (existing.defaultEmailAddress?.marketingState === 'SUBSCRIBED') {
        console.log(`[shopify-subscribe] ${existing.id} already SUBSCRIBED — left alone (tagged).`);
        return;
      }

      const updated = await adminGraphql(
        UPDATE_CONSENT,
        { input: { customerId: existing.id, emailMarketingConsent: consent } },
        creds
      );

      const updateErrors = updated?.customerEmailMarketingConsentUpdate?.userErrors ?? [];
      if (updateErrors.length) {
        console.error(`[shopify-subscribe] consent update refused: ${JSON.stringify(updateErrors)}`);
        return;
      }
      console.log(`[shopify-subscribe] ${existing.id} re-subscribed.`);
    } catch (error) {
      // Swallowed on purpose. The submission is already saved; throwing here
      // would only fill the function log with stack traces and retry nothing.
      console.error(`[shopify-subscribe] ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};
