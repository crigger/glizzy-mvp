/**
 * The product card: option chips where a product has options, and an Add to
 * cart that goes straight into the drawer without a trip to the product page.
 *
 * Everything the card needs is already in the markup — each radio carries its
 * variant's image, price, stock and product-page link — so choosing one is a
 * swap of what's on screen, not a fetch.
 *
 * The cart itself belongs to cart.js; this file calls `window.GlizzyCart.add`
 * rather than talking to Shopify. Looked up at CLICK time, not at load: both
 * scripts are deferred and this one appears first in the document, so the API
 * doesn't exist yet while this is running.
 *
 * Without JavaScript the radios still check, the card shows the first available
 * variant at its real price, and the `<noscript>` link goes to the product
 * page — which is also why the button keeps a `data-href`.
 *
 * Vinton's copy of this also opened on the chip matching the active colour
 * scheme. There are no schemes here and no product with more than one option
 * yet, so that went rather than sitting inert waiting to confuse someone.
 */
(function () {
  'use strict';

  var cards = document.querySelectorAll('.shop-card');
  if (!cards.length) return;

  Array.prototype.forEach.call(cards, function (card) {
    var art = card.querySelector('[data-shop-card-art]');
    // The art and the title both link to the product page; both follow the chip.
    var links = card.querySelectorAll('[data-shop-card-link]');
    var price = card.querySelector('[data-shop-card-price]');
    var add = card.querySelector('[data-shop-card-add]');
    var note = card.querySelector('[data-shop-card-note]');
    var inputs = card.querySelectorAll('input[type="radio"]');

    var busy = false;

    function say(message) {
      if (note) note.textContent = message || '';
    }

    Array.prototype.forEach.call(inputs, function (input) {
      input.addEventListener('change', function () {
        if (!input.checked) return;

        // srcset FIRST: setting `src` while a stale srcset is still on the
        // element lets the browser keep serving the previous variant's candidate.
        if (art && input.dataset.image) {
          if (input.dataset.srcset) art.srcset = input.dataset.srcset;
          art.src = input.dataset.image;
        }
        if (price && input.dataset.price) price.textContent = input.dataset.price;

        if (input.dataset.href) {
          Array.prototype.forEach.call(links, function (link) {
            link.href = input.dataset.href;
          });
        }

        if (add) {
          var available = input.dataset.available === 'true';
          add.dataset.variantId = input.value;
          add.dataset.href = input.dataset.href || add.dataset.href;
          add.disabled = !available;
          add.textContent = available ? 'Add to cart' : 'Sold out';
        }

        say('');
      });
    });

    if (!add) return;

    add.addEventListener('click', function () {
      var cart = window.GlizzyCart;

      // No cart script on the page at all — send them where they can still buy
      // it rather than leaving a button that does nothing.
      //
      // Reachable one way in practice: a page rendering ShopCards whose Layout
      // was not given `cart`. The fallback is good, but silently turning Add to
      // cart into a link is the kind of downgrade nobody notices, so it says so.
      if (!cart) {
        console.warn(
          '[shop] no cart on this page — Add to cart is falling back to the product page. ' +
            'Pass `cart` to Layout.astro on any page that renders a ShopCard.'
        );
        window.location.href = add.dataset.href;
        return;
      }

      if (busy || add.disabled) return;
      busy = true;

      var label = add.textContent;
      add.textContent = 'Adding…';
      say('');

      cart
        .add(add.dataset.variantId, 1)
        .then(function () {
          add.textContent = label;
        })
        .catch(function (err) {
          /**
           * Sold out is not "try again" — trying again cannot work.
           *
           * Shopify only reports it as a WARNING on the add (see assertInStock
           * in cart.js), so before 2026-08-24 this fell through as a success:
           * the label went back to "Add to cart" and the drawer opened empty.
           * The card is built at deploy time, so its idea of what is in stock
           * is as old as the last build — this click is the first moment the
           * truth is available, and it should be spent saying so.
           */
          if (err && err.soldOut) {
            var chosen = card.querySelector('input[type="radio"]:checked');
            if (chosen) {
              chosen.dataset.available = 'false';
            }
            add.textContent = 'Sold out';
            add.disabled = true;
            say('That one just sold out.');
            return;
          }
          add.textContent = label;
          say("That didn't go through. Try again in a moment.");
        })
        .then(function () {
          busy = false;
        });
    });
  });
})();
