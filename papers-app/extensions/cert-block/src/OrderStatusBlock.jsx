import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useState, useEffect} from 'preact/hooks';

export default async () => {
  render(<CertBlock />, document.body);
};

const API_VERSION = '2026-07';

/*
 * The certificate block for the customer account order page. The
 * `glizzy.cert_url` order metafield is written by the glizzy.store
 * orders/create webhook the moment an order exists, and ONLY for orders
 * holding a glizzy-store line — so its presence is both the data and the
 * brand gate: mmmornings and Vintonland orders render nothing at all.
 *
 * HOW IT READS, learned the hard way (2026-08-29, each verified live):
 *  - The Customer Account API is fetch('shopify://customer-account/api/…')
 *    with automatic auth. shopify.query() is the STOREFRONT API — its
 *    QueryRoot has no `order`. appMetafields delivered nothing here.
 *  - THREE grants are all required, each with its own failure mode:
 *    the app scope `customer_read_orders` (else ACCESS_DENIED on `order`),
 *    the metafield definition's "Customer Account API access: Read" (else
 *    the field is null), and the scope needs release + INSTALL-GRANT update.
 *  - shopify.order.value.id can be undefined at mount; poll until it lands.
 */
function CertBlock() {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    let done = false;
    const tryQuery = async () => {
      const id = shopify.order?.value?.id;
      if (!id || done) return;
      done = true;
      try {
        const res = await fetch(`shopify://customer-account/api/${API_VERSION}/graphql.json`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            query: `query CertUrl($id: ID!) {
              order(id: $id) {
                metafield(namespace: "glizzy", key: "cert_url") { value }
              }
            }`,
            variables: {id},
          }),
        });
        const body = await res.json();
        const value = body?.data?.order?.metafield?.value;
        if (value) setUrl(value);
      } catch {
        // no certificate, no block — never break the order page
      }
    };
    tryQuery();
    const iv = setInterval(() => { tryQuery(); if (done) clearInterval(iv); }, 500);
    const stop = setTimeout(() => clearInterval(iv), 20000);
    return () => { clearInterval(iv); clearTimeout(stop); };
  }, []);

  if (!url) return null;

  return (
    <s-stack direction="block" gap="base">
      <s-heading>Certificate of Authenticity</s-heading>
      <s-text>
        Every Glizzy leaves the kiln with papers. On file at the Old Vinton
        Glizzy Provenance office.
      </s-text>
      <s-button href={url}>View certificate</s-button>
    </s-stack>
  );
}
