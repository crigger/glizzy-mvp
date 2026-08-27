/** Catalogue snapshot from the Shopify Storefront API at `astro build`. */

/**
 * Pinned rather than floating: Shopify retires a version roughly a year after
 * release, and a build that silently follows `unstable` would break on their
 * schedule instead of ours. The queries below were validated against this one.
 */
const API_VERSION = '2026-07';

/**
 * Which sub-brand's products this site sells, as Shopify's Vendor field spells
 * it. One Shopify store backs three sites; Vendor is what says which is which,
 * and it is also what makes Shopify's sales-by-vendor reports split them.
 *
 * Compared case-insensitively below, but keep it matching the admin exactly
 * anyway: it is quoted back in the error when nothing matches, and a message
 * naming a vendor that isn't the one you typed is a bad hour.
 */
const BRAND = 'glizzy-store';

/** One product today; the ceiling is room to grow, not a cap. */
const PRODUCT_LIMIT = 20;
const VARIANT_LIMIT = 20;

export type ShopMoney = {
  amount: string;
  currencyCode: string;
};

export type ShopVariant = {
  id: string;
  title: string;
  availableForSale: boolean;
  /** One entry per product option, e.g. `{ name: 'Size', value: 'M' }`. */
  selectedOptions: { name: string; value: string }[];
  price: ShopMoney;
  /** Shopify's SKU. Often blank — structured data omits it rather than send ''. */
  sku: string;
  /**
   * The variant's own image, WITH its dimensions.
   *
   * They can't be borrowed from `featuredImage` any more: the variant shots are
   * square 2000x2000 while the featured image is still the 4:5 original, so
   * reusing the featured size hands the browser the wrong aspect to reserve and
   * the page jumps when the real image decodes.
   */
  image: { url: string; altText: string | null; width: number; height: number } | null;
};

export type ShopProduct = {
  id: string;
  handle: string;
  title: string;
  /** Plain text. Line breaks are LOST here — use `descriptionHtml` to render. */
  description: string;
  /** Shopify's Vendor field — which sub-brand this belongs to. See BRAND. */
  vendor: string;
  /**
   * The description as Shopify's editor stored it.
   *
   * This is what gets rendered. `description` flattens the rich text and drops
   * the breaks WITH the whitespace around them, so a paragraph break arrives as
   * `finish.Very sticky` — two sentences welded together. The HTML keeps them.
   */
  descriptionHtml: string;
  featuredImage: { url: string; altText: string | null; width: number; height: number } | null;
  /** Option names with their values, in Shopify's own order. */
  options: { name: string; optionValues: { name: string }[] }[];
  variants: ShopVariant[];
};

const PRODUCTS_QUERY = `
query GlizzyProducts($products: Int!, $variants: Int!) {
  products(first: $products) {
    nodes {
      id handle title vendor description descriptionHtml
      featuredImage { url altText width height }
      options { name optionValues { name } }
      variants(first: $variants) {
        nodes {
          id title availableForSale sku
          selectedOptions { name value }
          price { amount currencyCode }
          image { url altText width height }
        }
      }
    }
  }
}`;

/**
 * Loud on purpose.
 *
 * A shop that quietly disappears from a deploy is a worse failure than a build
 * that stops: Netlify keeps the last good deploy serving either way, so the
 * cost of stopping is nothing and the cost of shipping a storeless page is a
 * day of no sales nobody notices. Every throw below is that decision.
 */
function fail(message: string): never {
  throw new Error(`[shopify] ${message}`);
}

type Credentials = { domain: string; token: string };

/**
 * Absent credentials are the ONE case that doesn't stop a build, and only
 * outside production: a contributor with a fresh clone and no `.env` should
 * still get a working `npm run dev` with the shop section simply not there.
 * In a production build the same absence is a misconfigured deploy, and it
 * throws with the rest.
 */
function credentials(): Credentials | null {
  const domain = import.meta.env.PUBLIC_SHOPIFY_STORE_DOMAIN;
  const token = import.meta.env.PUBLIC_SHOPIFY_STOREFRONT_TOKEN;

  if (!domain || !token) {
    if (import.meta.env.PROD) {
      fail(
        'PUBLIC_SHOPIFY_STORE_DOMAIN and PUBLIC_SHOPIFY_STOREFRONT_TOKEN are both required ' +
          'for a production build. Set them in Netlify, or in .env locally.'
      );
    }
    console.warn(
      '[shopify] no credentials in .env — building without the shop. ' +
        'Set PUBLIC_SHOPIFY_STORE_DOMAIN and PUBLIC_SHOPIFY_STOREFRONT_TOKEN to include it.'
    );
    return null;
  }

  return { domain, token };
}

/**
 * Fetch every product published to the Headless channel.
 *
 * Returns `null` ONLY when credentials are absent outside production — see
 * `credentials()`. Any other problem throws.
 */
export async function fetchShopifyProducts(): Promise<ShopProduct[] | null> {
  const creds = credentials();
  if (!creds) return null;

  const signal = AbortSignal.timeout(15_000);
  let res: Response;

  try {
    res = await fetch(`https://${creds.domain}/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': creds.token,
      },
      body: JSON.stringify({
        query: PRODUCTS_QUERY,
        variables: { products: PRODUCT_LIMIT, variants: VARIANT_LIMIT },
      }),
      signal,
    });
  } catch (err) {
    fail(`could not reach ${creds.domain}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 401/403 here is almost always the private token in a PUBLIC_ variable, or a
  // token minted for a different store — worth saying so rather than dumping a status.
  if (res.status === 401 || res.status === 403) {
    fail(
      `${creds.domain} rejected the access token (${res.status}). Check that it's the Headless ` +
        "channel's PUBLIC token and that it belongs to this store."
    );
  }
  if (!res.ok) fail(`${creds.domain} returned HTTP ${res.status}`);

  const json = (await res.json()) as {
    errors?: { message?: string }[];
    data?: { products?: { nodes?: unknown[] } };
  };

  // GraphQL reports its own failures inside a 200, so the status above proves nothing.
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    fail(`query rejected: ${json.errors.map((e) => e?.message ?? '?').join('; ')}`);
  }

  const nodes = json.data?.products?.nodes;
  if (!Array.isArray(nodes)) fail('response had no products list');

  // An EMPTY list is the trap worth naming: a product that exists in admin but
  // isn't published to the Headless channel comes back as no products at all,
  // with no error anywhere. It reads exactly like an empty store.
  if (nodes.length === 0) {
    fail(
      `${creds.domain} returned no products. If the store has products, they are probably not ` +
        'published to the Headless sales channel (Products → the product → Publishing).'
    );
  }

  const all = nodes.map(normalizeProduct);

  /*
   * The SECOND line of defence, not the boundary.
   *
   * The boundary is the Headless storefront: this token should only ever see
   * products published to the glizzy-store storefront, and if that is set up
   * right this filter never removes anything. It exists because it wasn't —
   * on the day this site was wired up the glizzy-store token returned all
   * three brands' products, and a build that quietly put vinton.land's sticker
   * on sale here would have looked exactly like one that worked.
   *
   * Loud rather than silent, for the same reason the studio strip in
   * vinton.land's config announces itself: a build that drops things without
   * saying so is indistinguishable from one that had nothing to drop. If this
   * ever prints, fix it in the admin (product → Publishing) rather than here.
   */
  const mine = all.filter((p) => p.vendor.trim().toLowerCase() === BRAND);
  const foreign = all.filter((p) => !mine.includes(p));

  if (foreign.length > 0) {
    console.warn(
      `[shopify] ${foreign.length} product(s) reached this storefront from another brand and ` +
        `were left out: ${foreign.map((p) => `${p.handle} (vendor: ${p.vendor || 'none'})`).join(', ')}. ` +
        `Unpublish them from the glizzy-store Headless storefront — the sales channel is meant to ` +
        `be the boundary, and this filter is only a backstop.`
    );
  }

  if (mine.length === 0) {
    fail(
      `${creds.domain} returned ${all.length} product(s), none with vendor "${BRAND}". Either the ` +
        `vendor field is wrong in the admin, or nothing of ours is published to this storefront.`
    );
  }

  return mine;
}

function normalizeProduct(raw: unknown): ShopProduct {
  const p = raw as Record<string, any>;

  const handle = typeof p.handle === 'string' ? p.handle : '';
  if (!handle) fail('a product came back without a handle, so it has no URL to live at');

  const variants = Array.isArray(p.variants?.nodes) ? p.variants.nodes.map(normalizeVariant) : [];
  if (variants.length === 0) fail(`product "${handle}" has no variants, so nothing can be bought`);

  return {
    id: String(p.id ?? ''),
    handle,
    title: typeof p.title === 'string' ? p.title : handle,
    vendor: typeof p.vendor === 'string' ? p.vendor : '',
    description: typeof p.description === 'string' ? p.description : '',
    descriptionHtml: cleanDescription(p.descriptionHtml),
    featuredImage: normalizeImage(p.featuredImage),
    options: Array.isArray(p.options)
      ? p.options.map((o: any) => ({
          name: String(o?.name ?? ''),
          optionValues: Array.isArray(o?.optionValues)
            ? o.optionValues.map((v: any) => ({ name: String(v?.name ?? '') }))
            : [],
        }))
      : [],
    variants,
  };
}

/**
 * Shopify's rich-text editor pastes `<meta charset="utf-8">` into the body of a
 * description when copy arrives from elsewhere. `descriptionHtml` is rendered
 * verbatim (the plain-text field welds paragraphs together), so that tag would
 * otherwise land in the middle of the page. Only `<meta>` is removed — every
 * other tag is the author's.
 */
function cleanDescription(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/<meta\b[^>]*>/gi, '');
}

function normalizeVariant(raw: unknown): ShopVariant {
  const v = raw as Record<string, any>;

  return {
    id: String(v.id ?? ''),
    title: typeof v.title === 'string' ? v.title : '',
    // Absent means unavailable: the safe default is a button that won't sell
    // something we can't ship, not one that will.
    availableForSale: v.availableForSale === true,
    sku: typeof v.sku === 'string' ? v.sku : '',
    selectedOptions: Array.isArray(v.selectedOptions)
      ? v.selectedOptions.map((o: any) => ({ name: String(o?.name ?? ''), value: String(o?.value ?? '') }))
      : [],
    price: {
      amount: String(v.price?.amount ?? '0'),
      currencyCode: String(v.price?.currencyCode ?? 'USD'),
    },
    image: normalizeImage(v.image),
  };
}

function normalizeImage(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null;
  const img = raw as Record<string, any>;
  if (typeof img.url !== 'string') return null;

  return {
    url: img.url,
    altText: typeof img.altText === 'string' ? img.altText : null,
    width: Number(img.width ?? 0),
    height: Number(img.height ?? 0),
  };
}

/**
 * A Shopify CDN image at a sensible size.
 *
 * The originals are 1600x2000 PNGs and were being served whole into a 320px
 * slot — five times the pixels anyone can see, and a `drop-shadow` over that
 * raster has to blur a surface just as large. On a phone GPU that surface gets
 * tiled, and the tile seams show up as hard straight edges in the shadow.
 *
 * `width` is Shopify's own transform, so the resizing happens on their CDN and
 * costs the build nothing. Any non-Shopify URL is handed back untouched.
 */
export function cdnImage(url: string, width: number): string {
  if (!url) return url;

  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('shopify.com')) return url;
    parsed.searchParams.set('width', String(width));
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * The widths every product image is offered at; `sizes` picks between them.
 *
 * Vinton stops this list at 960 because a `drop-shadow` over a 2-megapixel
 * raster tiles on a phone GPU and shows its seams. Nothing here casts a shadow
 * over the artwork, so that cap would only buy a soft picture.
 *
 * The list runs to 2000 because that is what product artwork should be uploaded
 * at. The first glizzy photo is not — see `cdnSrcset`, which is what stops this
 * list lying about an image that small.
 *
 * `cdnSrcset` drops any entry wider than the file itself, so a smaller image
 * uploaded later still advertises only the widths it actually has.
 */
export const IMAGE_WIDTHS = [320, 480, 640, 960, 1280, 1600, 2000];

/**
 * A `srcset` across `IMAGE_WIDTHS` for one Shopify image.
 *
 * `intrinsic` is the source file's own width, and entries wider than it are
 * dropped. Shopify's CDN will not upscale — ask for 960 from a 769px original
 * and you get 769 back — so without this the srcset advertises a 960w candidate
 * that is really 769px, and the browser picks it believing it has more detail
 * than it does. Vinton's artwork is 1600-2000px so it never hit this; the first
 * glizzy photo is a 769px iPhone HEIC, and it hits it on every candidate above
 * 640. Re-upload the artwork at 2000px and the whole list comes back on its
 * own — nothing here needs changing.
 *
 * The widest kept entry is the first one at or above the source, so an image
 * between two steps still offers something big enough to fill the slot.
 */
export function cdnSrcset(url: string, intrinsic?: number): string {
  if (!url) return '';

  let widths = IMAGE_WIDTHS;
  if (intrinsic && intrinsic > 0) {
    widths = IMAGE_WIDTHS.filter((w) => w <= intrinsic);
    const nextUp = IMAGE_WIDTHS.find((w) => w > intrinsic);
    if (widths.length === 0) widths = nextUp ? [nextUp] : [IMAGE_WIDTHS[0]];
  }

  return widths.map((w) => `${cdnImage(url, w)} ${w}w`).join(', ');
}

/**
 * Does this product actually have options a shopper chooses between?
 *
 * Shopify gives a product with no options ONE option named `Title` holding the
 * single value `Default Title`. Rendered naively that becomes a swatch group of
 * one and a legend reading "Title" — a decision the shopper doesn't have. The
 * Vinton sticker has three real colorways so this path never came up there.
 */
export function hasRealOptions(product: ShopProduct): boolean {
  if (product.options.length !== 1) return product.options.length > 0;
  const only = product.options[0];
  return !(only.name === 'Title' && only.optionValues.length === 1);
}

/**
 * Money as it should read on the page: `$24`, not `24.0 USD` — and not `$24.00`
 * either. Whole amounts lose the cents; anything with real cents keeps both
 * digits, so `$2.50` never renders as `$2.5`.
 */
export function formatPrice(money: ShopMoney): string {
  const amount = Number(money.amount);
  if (!Number.isFinite(amount)) return '';

  const whole = Number.isInteger(amount);

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: money.currencyCode || 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount);
}

/**
 * Where a "buy" call to action should point.
 *
 * There is ONE product and therefore no shop index — `/shop/` was deleted,
 * because with a single item it was a page holding a single card that every
 * CTA had to be clicked through. So this returns the product page itself.
 *
 * ───── IF A SECOND PRODUCT IS EVER ADDED ─────
 *
 * Bring `src/pages/shop/index.astro` back (it is in the git history, and
 * `components/shop/ShopCard.astro` is still here waiting for it), point this
 * at `/shop/` again for the multi-product case, and restore the "Shop" level
 * in `breadcrumbNode()` in productJsonLd.ts. The build WARNS below if there is
 * more than one product, so this cannot be forgotten silently — a CTA would
 * otherwise send everyone to whichever product happened to be first.
 *
 * MEMOISED on the promise, not the value. `fetchShopifyProducts()` does no
 * caching of its own, and every CTA on the homepage asks for this — without it
 * a build would make five identical Storefront round trips, and they would race
 * rather than share.
 */
let buyHrefPromise: Promise<string> | null = null;

export function buyHref(): Promise<string> {
  buyHrefPromise ??= (async () => {
    const products = await fetchShopifyProducts();
    // No catalogue at all — a dev build with no credentials. Home is the only
    // page guaranteed to exist; `/shop/` no longer does.
    if (!products || products.length === 0) return '/';
    if (products.length > 1) {
      console.warn(
        `[buyHref] ${products.length} products in the catalogue, but the shop index ` +
          'route was deleted when there was only one. Every CTA is now pointing at ' +
          `"${products[0].handle}". See the note in fetchShopifyProducts.ts.`
      );
    }
    return `/shop/${products[0].handle}/`;
  })();
  return buyHrefPromise;
}
