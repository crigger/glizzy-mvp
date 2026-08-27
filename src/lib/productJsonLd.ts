/**
 * Structured data for a product — the same entity wherever it's mentioned.
 *
 * The homepage features the product and the product page sells it, so both
 * describe it. They share one `@id` (the product page's URL), which is what
 * makes them one thing said twice rather than two competing products: Google
 * supports product markup on a listing page as well as the page itself, and the
 * `@id` is what ties the mentions together.
 *
 * Nothing here is invented. Every field comes from the Shopify catalogue or
 * from a policy actually set — free shipping, US only, and no returns. There
 * is no `aggregateRating` or `review` because there are no reviews; that is a
 * field Google would happily display and it is not ours to make up.
 */
import type { ShopProduct, ShopVariant } from './fetchShopifyProducts';

/**
 * Shopify hands back `"3.0"`. Money is written with two decimals, and while
 * schema.org would accept either, a price that reads `3.0` is the kind of thing
 * that turns up in a rich result looking like a mistake.
 */
const money = (amount: string) => {
  const n = Number(amount);
  return Number.isFinite(n) ? n.toFixed(2) : amount;
};

/** `gid://shopify/ProductVariant/123` → `123`, the form `?variant=` carries. */
const variantParam = (id: string) => id.split('/').pop() ?? '';

const origin = (site: URL | undefined) => (site ? new URL('/', site).href : 'https://glizzy-mvp.netlify.app/');

export const productUrl = (product: ShopProduct, site: URL | undefined) =>
  `${origin(site)}shop/${product.handle}/`;

export const organizationId = (site: URL | undefined) => `${origin(site)}#organization`;

/** The seller, once, for `WebSite.publisher` and every `Offer.seller` to point at. */
export function organizationNode(site: URL | undefined) {
  const base = origin(site);
  return {
    '@type': 'Organization',
    '@id': organizationId(site),
    name: 'Mill Mountain Mornings',
    url: base,
    logo: {
      '@type': 'ImageObject',
      url: `${base}favicon-512.png`,
      width: 512,
      height: 512,
    },
  };
}

/**
 * One offer per variant, because they are separately buyable and separately
 * sellable-out — an `AggregateOffer` would hide which variant is gone.
 */
function offerNode(product: ShopProduct, variant: ShopVariant, site: URL | undefined) {
  return {
    '@type': 'Offer',
    name: variant.title,
    url: `${productUrl(product, site)}?variant=${variantParam(variant.id)}`,
    price: money(variant.price.amount),
    priceCurrency: variant.price.currencyCode,
    availability: variant.availableForSale
      ? 'https://schema.org/InStock'
      : 'https://schema.org/OutOfStock',
    itemCondition: 'https://schema.org/NewCondition',
    seller: { '@id': organizationId(site) },
    // Decided, not assumed: shipping is free and the store doesn't ship
    // internationally.
    shippingDetails: {
      '@type': 'OfferShippingDetails',
      shippingRate: { '@type': 'MonetaryAmount', value: '0', currency: variant.price.currencyCode },
      shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'US' },
    },
    /**
     * Verified against BOTH of Shopify's answers on 2026-08-23, because they can
     * disagree: the structured return rules read "No returns · Cancel within 15
     * minutes", and the written policy at /policies/refund-policy reads "No
     * refunds or returns." (The Shop app was advertising 30-day returns anyway —
     * that is Shopify's own doing and matches neither setting.)
     */
    hasMerchantReturnPolicy: {
      '@type': 'MerchantReturnPolicy',
      applicableCountry: 'US',
      returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted',
    },
    ...(variant.sku ? { sku: variant.sku } : {}),
  };
}

export function productNode(product: ShopProduct, site: URL | undefined) {
  const url = productUrl(product, site);
  // Featured first, then each variant's own shot — deduped, because a variant
  // with no image of its own falls back to the featured one upstream.
  const images = [
    product.featuredImage?.url,
    ...product.variants.map((v) => v.image?.url),
  ].filter((u): u is string => Boolean(u));

  return {
    '@type': 'Product',
    '@id': url,
    name: product.title,
    description: product.description,
    url,
    image: [...new Set(images)],
    brand: { '@type': 'Brand', name: 'Mill Mountain Mornings' },
    offers: product.variants.map((v) => offerNode(product, v, site)),
  };
}

/**
 * Home → Shop → product.
 *
 * Vinton's copy of this had two rungs and said so in a comment, because it had
 * no /shop index. This site does, and the trail has to match the one a visitor
 * can actually walk — a breadcrumb naming a page that isn't there is worse
 * than a short breadcrumb.
 */
export function breadcrumbNode(product: ShopProduct, site: URL | undefined) {
  const base = origin(site);
  /*
   * Home -> product, with no "Shop" level: that route was deleted with the
   * single-product catalogue, and a breadcrumb naming a 404 is worse than a
   * short breadcrumb. Put the middle step back when the index returns.
   *
   * The site name was "Mill Mountain Mornings" — copied in from the sibling
   * repo and shipped on every product page of THIS one.
   */
  return {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Glizzy Store', item: base },
      { '@type': 'ListItem', position: 2, name: product.title, item: productUrl(product, site) },
    ],
  };
}
