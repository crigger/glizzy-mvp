import '@shopify/ui-extensions/preact';
import {render} from 'preact';

export default async () => {
  render(<CertBlock />, document.body);
};

/*
 * The certificate block for the customer account order page (and the
 * order-status page reached from the email). The `glizzy.cert_url` order
 * metafield is written by the glizzy.store orders/create webhook the moment
 * an order exists, and ONLY for orders holding a glizzy-store line — so its
 * presence is both the data and the brand gate: mmmornings and Vintonland
 * orders render nothing at all. Copy matches the shipping email's block.
 */
function CertBlock() {
  const entry = shopify.appMetafields.value.find(
    (e) =>
      e.target.type === 'order' &&
      e.metafield.namespace === 'glizzy' &&
      e.metafield.key === 'cert_url'
  );
  if (!entry || !entry.metafield.value) return null;

  return (
    <s-stack direction="block" gap="base">
      <s-heading>Certificate of Authenticity</s-heading>
      <s-text>
        Every Glizzy leaves the kiln with papers. On file at the Old Vinton
        Glizzy Provenance office.
      </s-text>
      <s-button href={entry.metafield.value}>View certificate</s-button>
    </s-stack>
  );
}
