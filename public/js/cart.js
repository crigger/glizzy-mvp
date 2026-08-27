/**
 * The cart.
 *
 * A plain IIFE like the rest of public/js — no build step touches this file, so
 * its configuration is read off the drawer element rather than from env vars.
 *
 * The rule the whole thing is built on: SHOPIFY owns the cart. Every mutation
 * returns the cart, and the drawer re-renders from that response. Nothing is
 * counted or totalled locally, so the number on the button is always the number
 * checkout will charge for.
 */
(function () {
  'use strict';

  var root = document.getElementById('cart');
  if (!root) return;

  var DOMAIN = root.dataset.domain;
  var TOKEN = root.dataset.token;
  var API = 'https://' + DOMAIN + '/api/' + root.dataset.apiVersion + '/graphql.json';

  /**
   * The stored cart ID includes a secret `?key=` parameter and the WHOLE string
   * is the credential — truncate it and every mutation fails with "cart does
   * not exist". It lives in localStorage and nowhere else: never in a URL,
   * never rendered into the page, never logged.
   */
  var STORAGE_KEY = 'glizzy.cart.id';

  var els = {
    fab: document.getElementById('cart-open'),
    count: document.getElementById('cart-count'),
    close: document.getElementById('cart-close'),
    scrim: document.getElementById('cart-scrim'),
    lines: document.getElementById('cart-lines'),
    empty: document.getElementById('cart-empty'),
    foot: document.getElementById('cart-foot'),
    subtotal: document.getElementById('cart-subtotal'),
    checkout: document.getElementById('cart-checkout'),
    note: document.getElementById('cart-note'),
  };

  /**
   * The drawer's live region.
   *
   * It was in the markup on both sibling sites and nothing ever wrote to it —
   * the only code that could was the stepper, and the stepper swallowed its
   * errors. See the catch in `stepper()`.
   */
  function cartSay(message) {
    if (els.note) els.note.textContent = message || '';
  }

  var lastFocused = null;
  var busy = false;

  /* --- the API ----------------------------------------------------------- */

  var CART_FIELDS =
    'id checkoutUrl totalQuantity ' +
    'cost { subtotalAmount { amount currencyCode } } ' +
    'lines(first: 50) { nodes { ' +
    '  id quantity ' +
    '  cost { totalAmount { amount currencyCode } } ' +
    '  attributes { key value } ' +
    '  merchandise { ... on ProductVariant { ' +
    '    id title image { url altText } product { title } ' +
    '  } } ' +
    '} }';

  /**
   * The line-item attribute the ode travels in.
   *
   * A plain key, NOT a `_`-prefixed one: Shopify hides underscore-prefixed
   * attributes from the order screen, and this is a note whose entire purpose
   * is to be read by whoever packs the box.
   */
  var ODE_KEY = 'Note';

  /**
   * `attributes` is omitted rather than sent empty when there is no ode. An
   * empty array still makes Shopify treat the line as distinct, which would
   * quietly stop identical plain items from stacking into one line.
   */
  function lineInput(variantId, quantity, attributes) {
    var line = { merchandiseId: variantId, quantity: quantity };
    if (attributes && attributes.length) line.attributes = attributes;
    return line;
  }

  function gql(query, variables) {
    return fetch(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': TOKEN,
      },
      body: JSON.stringify({ query: query, variables: variables || {} }),
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (json) {
        if (json.errors && json.errors.length) throw new Error(json.errors[0].message);
        return json.data;
      });
  }

  function storedId() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      // Private browsing, or storage switched off. The cart still works for
      // this page view; it just won't survive a reload.
      return null;
    }
  }

  function remember(id) {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch (e) {
      /* nothing to do — see storedId() */
    }
  }

  function forget() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      /* as above */
    }
  }

  /* --- reading the cart --------------------------------------------------- */

  /**
   * Carts expire. Shopify answers a dead ID with `cart: null` rather than an
   * error, so this returns null too and every caller treats that as "start
   * again" — quietly, because a shopper cannot act on "your cart from March
   * has been garbage collected".
   */
  function fetchCart() {
    var id = storedId();
    if (!id) return Promise.resolve(null);

    return gql('query Cart($id: ID!) { cart(id: $id) { ' + CART_FIELDS + ' } }', { id: id })
      .then(function (data) {
        if (!data || !data.cart) {
          forget();
          return null;
        }
        return data.cart;
      })
      .catch(function () {
        forget();
        return null;
      });
  }

  /* --- changing the cart -------------------------------------------------- */

  /**
   * Did the thing we asked for actually happen?
   *
   * Shopify does not fail an impossible cart change. Adding a sold-out variant
   * returns `userErrors: []` and a cart — with the line at `quantity: 0` — and
   * puts the news in `warnings`, as `MERCHANDISE_OUT_OF_STOCK`. Checking only
   * `userErrors` read that as a success: the button went back to "Add to cart"
   * and the drawer opened empty.
   *
   * But the warnings describe the CART, not this request, so treating any
   * warning as a failure was wrong in the other direction — one stale line
   * nobody touched could report "sold out" over a perfectly good add. That
   * shipped, and told people in-stock variants were gone.
   *
   * So the test is the OUTCOME: find what we asked for in the cart that came
   * back. A warning only supplies the wording once the outcome says it failed.
   */
  function assertApplied(result, check) {
    var cart = result && result.cart;
    if (cart && check(cart)) return;

    var warnings = (result && result.warnings) || [];
    var stock = null;
    for (var i = 0; i < warnings.length; i++) {
      var code = warnings[i].code;
      if (code === 'MERCHANDISE_OUT_OF_STOCK' || code === 'MERCHANDISE_NOT_ENOUGH_STOCK') {
        stock = warnings[i];
        break;
      }
    }
    var err = new Error(
      (stock && stock.message) || (warnings[0] && warnings[0].message) || "That didn't go through."
    );
    // Only a STOCK warning earns the sold-out wording; anything else is a
    // generic failure and shouldn't tell someone an item is gone.
    if (stock) err.soldOut = true;
    throw err;
  }

  /** Is this variant in the cart, with something more than nothing of it? */
  function holds(variantId) {
    return function (cart) {
      var lines = (cart.lines && cart.lines.nodes) || [];
      for (var i = 0; i < lines.length; i++) {
        var m = lines[i].merchandise;
        if (m && m.id === variantId && lines[i].quantity > 0) return true;
      }
      return false;
    };
  }

  function createCart(variantId, quantity, attributes) {
    return gql(
      'mutation Create($lines: [CartLineInput!]!) {' +
        '  cartCreate(input: { lines: $lines }) {' +
        '    cart { ' + CART_FIELDS + ' }' +
        '    userErrors { field message }' +
        '    warnings { code message }' +
        '  }' +
        '}',
      { lines: [lineInput(variantId, quantity, attributes)] }
    ).then(function (data) {
      var result = data.cartCreate;
      if (result.userErrors && result.userErrors.length) throw new Error(result.userErrors[0].message);
      assertApplied(result, holds(variantId));
      remember(result.cart.id);
      return result.cart;
    });
  }

  function addLine(variantId, quantity, attributes) {
    var id = storedId();
    if (!id) return createCart(variantId, quantity, attributes);

    return gql(
      'mutation Add($cartId: ID!, $lines: [CartLineInput!]!) {' +
        '  cartLinesAdd(cartId: $cartId, lines: $lines) {' +
        '    cart { ' + CART_FIELDS + ' }' +
        '    userErrors { field message }' +
        '    warnings { code message }' +
        '  }' +
        '}',
      { cartId: id, lines: [lineInput(variantId, quantity, attributes)] }
    )
      .then(function (data) {
        var result = data.cartLinesAdd;
        if (result && result.userErrors && result.userErrors.length) {
          throw new Error(result.userErrors[0].message);
        }
        // Only checked when the cart came back at all — a null cart is the dead
        // cart case below, which is a retry rather than a refusal.
        if (result && result.cart) assertApplied(result, holds(variantId));
        var cart = result && result.cart;
        // A dead cart comes back as a null cart rather than an error — the one
        // case that must not surface as a failure. Start a fresh one and add
        // the same line to it, so the shopper's click still did what it looked
        // like it did.
        if (!cart) {
          forget();
          return createCart(variantId, quantity, attributes);
        }
        return cart;
      })
      .catch(function (err) {
        // A sold-out result must NOT fall into the dead-cart retry below: retrying
        // only asks Shopify the same question again and leaves a stray cart.
        if (err && err.soldOut) throw err;
        forget();
        return createCart(variantId, quantity, attributes);
      });
  }

  function setQuantity(lineId, quantity) {
    var id = storedId();
    if (!id) return Promise.resolve(null);

    if (quantity <= 0) {
      return gql(
        'mutation Rm($cartId: ID!, $lineIds: [ID!]!) {' +
          '  cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {' +
          '    cart { ' + CART_FIELDS + ' }' +
          '  }' +
          '}',
        { cartId: id, lineIds: [lineId] }
      ).then(function (data) {
        var result = data.cartLinesRemove;
        if (result && result.userErrors && result.userErrors.length) {
          throw new Error(result.userErrors[0].message);
        }
        return result && result.cart;
      });
    }

    return gql(
      'mutation Upd($cartId: ID!, $lines: [CartLineUpdateInput!]!) {' +
        '  cartLinesUpdate(cartId: $cartId, lines: $lines) {' +
        '    cart { ' + CART_FIELDS + ' }' +
        '    userErrors { field message }' +
        '    warnings { code message }' +
        '  }' +
        '}',
      { cartId: id, lines: [{ id: lineId, quantity: quantity }] }
    ).then(function (data) {
      var result = data.cartLinesUpdate;
      if (result && result.userErrors && result.userErrors.length) {
        throw new Error(result.userErrors[0].message);
      }
      // Same rule as the add: the line has to actually be at the number we
      // asked for. A cart-level warning about some other line is not this
      // request failing.
      assertApplied(result, function (cart) {
        var lines = (cart.lines && cart.lines.nodes) || [];
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].id === lineId) return lines[i].quantity === quantity;
        }
        return false;
      });
      return result && result.cart;
    });
  }

  /* --- drawing it --------------------------------------------------------- */

  /**
   * Same rule as `formatPrice` in fetchShopifyProducts.ts: whole amounts drop
   * the cents. Both exist because one runs at build and one in the browser, and
   * they have to agree — a `$4.00` subtotal under a `$2` product page is the
   * kind of mismatch that reads as a bug in the price, not the formatting.
   */
  function money(amount, currency) {
    var n = Number(amount);
    if (!isFinite(n)) return '';
    var whole = n % 1 === 0;
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency || 'USD',
        minimumFractionDigits: whole ? 0 : 2,
        maximumFractionDigits: whole ? 0 : 2,
      }).format(n);
    } catch (e) {
      return '$' + (whole ? String(n) : n.toFixed(2));
    }
  }

  function render(cart) {
    var quantity = cart ? cart.totalQuantity : 0;

    els.fab.hidden = quantity === 0;
    els.count.textContent = String(quantity);

    els.lines.textContent = '';

    if (!cart || quantity === 0) {
      els.empty.hidden = false;
      els.foot.hidden = true;
      return;
    }

    els.empty.hidden = true;
    els.foot.hidden = false;
    els.subtotal.textContent = money(
      cart.cost.subtotalAmount.amount,
      cart.cost.subtotalAmount.currencyCode
    );
    els.checkout.href = cart.checkoutUrl;

    cart.lines.nodes.forEach(function (line) {
      els.lines.appendChild(lineElement(line));
    });
  }

  /**
   * Built with DOM calls rather than an HTML string: product and variant titles
   * come from an API and go straight onto the page, and `textContent` can't be
   * talked into being markup.
   */
  function attributeValue(line, key) {
    var list = (line && line.attributes) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key && list[i].value) return list[i].value;
    }
    return '';
  }

  function lineElement(line) {
    var li = document.createElement('li');
    li.className = 'cart__line';

    var figure = document.createElement('div');
    if (line.merchandise.image) {
      var img = document.createElement('img');
      img.src = line.merchandise.image.url;
      img.alt = '';
      img.loading = 'lazy';
      figure.appendChild(img);
    }
    li.appendChild(figure);

    var middle = document.createElement('div');

    var name = document.createElement('p');
    name.className = 'cart__line-name';
    name.textContent = line.merchandise.product.title;
    middle.appendChild(name);

    /*
     * A product with no options gets ONE variant that Shopify titles
     * "Default Title". Vinton's products all have real colorways so this line
     * was always worth printing there; here it would put the words "Default
     * Title" under the name of a sticker that has no choices to make.
     */
    if (line.merchandise.title && line.merchandise.title !== 'Default Title') {
      var variant = document.createElement('p');
      variant.className = 'cart__line-variant';
      variant.textContent = line.merchandise.title;
      middle.appendChild(variant);
    }

    var qty = document.createElement('div');
    qty.className = 'cart__qty';
    qty.appendChild(stepper('−', 'Remove one', line.id, line.quantity - 1));

    var count = document.createElement('span');
    count.textContent = String(line.quantity);
    qty.appendChild(count);

    /*
     * The ode, echoed back. Printed from the cart's OWN attributes rather than
     * from the textarea, so what the drawer shows is what Shopify actually
     * stored — including a line added in an earlier session, which the form on
     * this page knows nothing about.
     */
    var ode = attributeValue(line, ODE_KEY);
    if (ode) {
      var odeEl = document.createElement('p');
      odeEl.className = 'cart__line-ode';
      odeEl.textContent = ode;
      middle.appendChild(odeEl);
    }

    qty.appendChild(stepper('+', 'Add one', line.id, line.quantity + 1));
    middle.appendChild(qty);

    li.appendChild(middle);

    var price = document.createElement('span');
    price.className = 'cart__line-price';
    price.textContent = money(line.cost.totalAmount.amount, line.cost.totalAmount.currencyCode);
    li.appendChild(price);

    return li;
  }

  function stepper(glyph, label, lineId, next) {
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = glyph;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', function () {
      if (busy) return;
      busy = true;
      cartSay('');
      setQuantity(lineId, next)
        .then(render)
        .catch(function (err) {
          /*
           * Shopify does not refuse an impossible quantity. It caps the line at
           * what it can supply, returns `userErrors: []`, and puts the reason in
           * `warnings` — which `assertApplied` turns into this error.
           *
           * This used to be an empty catch, and on a product with ONE in stock
           * pressing + did nothing whatsoever: no movement, no message, no way
           * to tell a refusal from a dead button. Both sibling sites sell
           * things they hold plenty of, so it never showed there. The first
           * product this shop opened with is a single ceramic hot dog.
           *
           * Re-read the cart rather than trusting the screen: the number in the
           * drawer is now ahead of what Shopify actually holds, and render()
           * draws from the response, not from local state.
           */
          return fetchCart()
            .then(render)
            .then(function () {
              cartSay((err && err.message) || "That didn't go through.");
            });
        })
        .then(function () {
          busy = false;
        });
    });
    return button;
  }

  /* --- opening and closing ------------------------------------------------ */

  function open() {
    cartSay('');
    lastFocused = document.activeElement;
    root.hidden = false;
    els.close.focus();
    document.addEventListener('keydown', onKeydown);
  }

  function close() {
    root.hidden = true;
    document.removeEventListener('keydown', onKeydown);
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  function onKeydown(event) {
    if (event.key === 'Escape') close();
  }

  els.fab.addEventListener('click', open);
  els.close.addEventListener('click', close);
  els.scrim.addEventListener('click', close);

  /* --- the public bit ----------------------------------------------------- */

  /**
   * What other scripts on the page use to put something in the cart — today
   * that's the homepage card's own Add to cart button.
   *
   * Published rather than duplicated: a second copy of "create or add, recover
   * from a dead cart, re-render the drawer" would be a second thing to keep
   * right, and the two would drift the first time either changed.
   */
  window.GlizzyCart = {
    add: function (variantId, quantity, attributes) {
      return addLine(variantId, quantity || 1, attributes).then(function (cart) {
        render(cart);
        open();
        return cart;
      });
    },
    open: open,
  };

  /* --- the add button on a product page ----------------------------------- */


  var addButton = document.getElementById('pdp-add');
  var note = document.getElementById('pdp-note');
  var art = document.getElementById('pdp-art');
  var priceEl = document.getElementById('pdp-price');

  function say(message) {
    if (note) note.textContent = message;
  }

  if (addButton) {
    // The picker: each radio carries its variant's price, image and stock, so
    // choosing one is a swap of what's already on the page — no second fetch,
    // and no matrix to solve because these products have a single option.
    Array.prototype.forEach.call(document.querySelectorAll('input[name="variant"]'), function (input) {
      input.addEventListener('change', function () {
        var available = input.dataset.available === 'true';
        addButton.dataset.variantId = input.value;
        addButton.disabled = !available;
        addButton.textContent = available ? 'Add to cart' : 'Sold out';
        if (priceEl) priceEl.textContent = input.dataset.price;
        // srcset FIRST — see the same note in shop-card.js.
        if (art && input.dataset.image) {
          if (input.dataset.srcset) art.srcset = input.dataset.srcset;
          art.src = input.dataset.image;
        }
        say('');
      });
    });

    /**
     * `?variant=` from the homepage card. The page is static HTML built for the
     * first available variant, so this re-checks the radio the visitor already
     * chose and lets the change handler above do the rest — one code path for
     * "I picked it here" and "I picked it on the way in".
     *
     * The short numeric form is what travels in the URL, so match on the tail
     * of the gid rather than the whole thing.
     */
    var wanted = new URLSearchParams(location.search).get('variant');
    if (wanted) {
      var match = document.querySelector('input[name="variant"][value$="/' + wanted + '"]');
      if (match && !match.disabled && !match.checked) {
        match.checked = true;
        match.dispatchEvent(new Event('change'));
      }
    }

    /* --- the ode --------------------------------------------------------- */

    var ODE_MAX = 100;
    var ODE_LINES = 3;
    var odeOpt = document.getElementById('ode-opt');
    var odeText = document.getElementById('ode-text');
    var odeCount = document.getElementById('ode-count');

    /**
     * The rule, in one place.
     *
     * Returns the cleaned string plus what it had to take away, so the caller
     * can say so — silently eating half of someone's pasted poem is the worst
     * version of this.
     */
    function cleanOde(raw) {
      var text = String(raw)
        // A paste from a word processor brings CRLF, and a lone CR from very
        // old sources; both must become the one newline the count is based on.
        .replace(/\r\n?/g, '\n')
        // Tabs, non-breaking and other exotic spaces become ordinary spaces.
        // NOT collapsed — someone double-spacing after a full stop meant it.
        .replace(/[^\S\n]/g, ' ')
        // Every other control character goes. \n is spared by the ranges.
        .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '');

      var lines = text.split('\n');
      var lostLines = lines.length > ODE_LINES;
      if (lostLines) lines = lines.slice(0, ODE_LINES);
      text = lines.join('\n');

      var lostChars = text.length > ODE_MAX;
      if (lostChars) text = text.slice(0, ODE_MAX);

      return { text: text, lostLines: lostLines, lostChars: lostChars };
    }

    /*
     * Enforced on `input`, not on `paste`.
     *
     * A paste handler only catches pasting. This also has to hold for a drag
     * and drop into the box, an autofill, an IME commit, a middle-click paste
     * on Linux, and undo — every one of which fires `input` and none of which
     * fires `paste`. One listener on the event they all share is both shorter
     * and harder to get wrong.
     */
    function enforceOde() {
      if (!odeText) return;
      var before = odeText.value;
      var caret = odeText.selectionStart;
      var result = cleanOde(before);

      if (result.text !== before) {
        odeText.value = result.text;
        // Everything this removes is at or after the caret, so clamping is
        // enough to keep the cursor where the typist left it; without it the
        // caret jumps to the end on every keystroke once the box is full.
        var pos = Math.min(caret, result.text.length);
        odeText.setSelectionRange(pos, pos);
      }

      var left = ODE_MAX - result.text.length;
      if (odeCount) {
        odeCount.textContent = left + ' left';
        odeCount.classList.toggle('is-full', left === 0);
      }
      if (result.lostLines) say('Three lines is the limit — the rest was trimmed.');
      else if (result.lostChars) say('That is the full 100 characters.');
    }

    if (odeText) {
      odeText.addEventListener('input', enforceOde);
      /*
       * Enter is blocked at the limit rather than cleaned up afterwards. The
       * sanitiser would drop the fourth line a moment later anyway, but the
       * caret would have visibly jumped down and back first.
       */
      odeText.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return;
        if (odeText.value.split('\n').length >= ODE_LINES) event.preventDefault();
      });
      enforceOde();
    }

    // Opening the box puts the cursor in it; closing it forgets what was
    // there, so an unchecked ode is never quietly attached to an order.
    if (odeOpt && odeText) {
      odeOpt.addEventListener('change', function () {
        if (odeOpt.checked) odeText.focus();
        else { odeText.value = ''; enforceOde(); say(''); }
      });
    }

    /** The attribute list for this add, or null when there is no ode. */
    function odeAttributes() {
      if (!odeOpt || !odeOpt.checked || !odeText) return null;
      var value = cleanOde(odeText.value).text.trim();
      return value ? [{ key: ODE_KEY, value: value }] : null;
    }

    addButton.addEventListener('click', function () {
      if (busy || addButton.disabled) return;
      busy = true;
      addButton.textContent = 'Adding…';
      say('');

      addLine(addButton.dataset.variantId, 1, odeAttributes())
        .then(function (cart) {
          render(cart);
          addButton.textContent = 'Add to cart';
          open();
        })
        .catch(function (err) {
          if (err && err.soldOut) {
            // Mark the VARIANT, not just this click: the radio is how you
            // would pick it again, and it is no longer pickable.
            var chosen = document.querySelector('input[name="variant"]:checked');
            if (chosen) {
              chosen.dataset.available = 'false';
            }
            addButton.textContent = 'Sold out';
            addButton.disabled = true;
            say('That one just sold out.');
            return;
          }
          addButton.textContent = 'Add to cart';
          say("That didn't go through. Try again in a moment.");
        })
        .then(function () {
          busy = false;
        });
    });
  }

  /* --- on load ------------------------------------------------------------ */

  // Restore whatever Shopify still has. A dead ID renders an empty cart and no
  // opener, which is exactly what a returning visitor should see.
  fetchCart().then(render).catch(function () {
    render(null);
  });
})();
