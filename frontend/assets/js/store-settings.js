/* Shared, read-only storefront details. Changes are saved to Supabase only via
   the authenticated + allowlisted demo-payment-kit/admin-store-settings API.
   No admin credentials or secret keys are used on the storefront. */
(function () {
  'use strict';
  var defaults = {
    storeName: 'Shanmuki Organics',
    storeEmail: 'shanmukioilmill@gmail.com',
    storePhone: '+91 866 775 8694',
    address: 'Dharapuram Road, Erode, Tamil Nadu - 638 004',
    currency: 'INR', taxRate: 5, freeShipMin: 999,
    enableCod: true, enableOnline: true
  };
  var current = Object.assign({}, defaults);
  var previous = {
    name: ['Shanmuga Organics', 'Shanmuki Organics'],
    phone: ['+91 638 004 0001', '+91 638 004 0002', '+91 866 775 8694'],
    email: ['info@shanmugaorganics.com', 'hello@shanmugaorganics.in', 'shanmukioilmill@gmail.com'],
    addr1: ['Dharapuram Road, Erode'],
    addr2: ['Tamil Nadu - 638 004']
  };
  function phoneHref(phone) { return String(phone || '').replace(/[^+0-9]/g, ''); }
  function addressParts(address) {
    var parts = String(address || '').split(',').map(function (v) { return v.trim(); }).filter(Boolean);
    return { first: parts.slice(0, 2).join(', '), second: parts.slice(2).join(', ') };
  }
  function normalize(remote) {
    if (!remote || typeof remote !== 'object') return null;
    var next = {};
    ['storeName', 'storeEmail', 'storePhone', 'address'].forEach(function (k) {
      if (typeof remote[k] === 'string' && remote[k].trim()) next[k] = remote[k].trim();
    });
    if (Number.isInteger(Number(remote.freeShipMin)) && Number(remote.freeShipMin) >= 0)
      next.freeShipMin = Number(remote.freeShipMin);
    if (Number.isFinite(Number(remote.taxRate)) && Number(remote.taxRate) >= 0)
      next.taxRate = Number(remote.taxRate);
    if (remote.currency === 'INR' || remote.currency === 'USD') next.currency = remote.currency;
    if (typeof remote.enableCod === 'boolean') next.enableCod = remote.enableCod;
    if (typeof remote.enableOnline === 'boolean') next.enableOnline = remote.enableOnline;
    return next;
  }
  function apply(cfg) {
    current = Object.assign({}, current, cfg);
    var sh = window.SITE && window.SITE.shop;
    if (sh) {
      var a = addressParts(current.address);
      sh.name = current.storeName;
      sh.addr1 = a.first;
      sh.addr2 = a.second;
      sh.address = current.address;
      sh.phone = current.storePhone;
      sh.phoneHref = phoneHref(current.storePhone);
      sh.email = current.storeEmail;
      sh.whatsapp = current.storePhone;
      sh.freeShipOver = current.freeShipMin;
      sh.taxRate = current.taxRate;
      sh.enableCod = current.enableCod;
      sh.enableOnline = current.enableOnline;
    }
  }
  function replaceKnown(value, olds, next) {
    var updated = String(value);
    olds.forEach(function (old) { updated = updated.split(old).join(next); });
    return updated;
  }
  function syncDocument() {
    var root = document.body;
    if (!root) return;
    var parts = addressParts(current.address);
    // Only replace legacy store contact strings, never arbitrary user data.
    var substitutions = [
      [previous.name, current.storeName],
      [previous.phone, current.storePhone],
      [previous.email, current.storeEmail],
      [previous.addr1, parts.first],
      [previous.addr2, parts.second]
    ];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var p = node.parentElement;
        if (!p || p.closest('script,style,noscript,textarea,input,select,[contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      var t = node.nodeValue;
      var next = t;
      substitutions.forEach(function (s) { next = replaceKnown(next, s[0], s[1]); });
      // Keep static shipping-policy labels consistent with the admin threshold.
      if (/free (?:shipping|delivery|above)|இலவச|order below|order ₹999 and above/i.test(next)) {
        next = next.replace(/₹999/g, '₹' + current.freeShipMin);
      }
      if (t !== next) node.nodeValue = next;
    }
    Array.prototype.forEach.call(root.querySelectorAll('a[href]'), function (a) {
      var href = a.getAttribute('href') || '';
      if (/^tel:\+?91638004000[12]$/.test(href)) a.setAttribute('href', 'tel:' + phoneHref(current.storePhone));
      if (/^mailto:(info@shanmugaorganics\.com|hello@shanmugaorganics\.in)$/i.test(href))
        a.setAttribute('href', 'mailto:' + current.storeEmail);
      if (/^https:\/\/wa\.me\/91638004000[12]$/.test(href))
        a.setAttribute('href', 'https://wa.me/' + phoneHref(current.storePhone).replace(/\D/g, ''));
      if (/^https:\/\/www\.google\.com\/maps\/search\//.test(href) && /Dharapuram/i.test(href))
        a.setAttribute('href', 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(current.address));
      if (a.hasAttribute('data-store-link')) {
        var link = a.getAttribute('data-store-link');
        if (link === 'email') a.setAttribute('href', 'mailto:' + current.storeEmail);
        if (link === 'phone') a.setAttribute('href', 'tel:' + phoneHref(current.storePhone));
      }
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-store-field]'), function (el) {
      var field = el.getAttribute('data-store-field');
      var values = { name: current.storeName, email: current.storeEmail, phone: current.storePhone,
        address: current.address, addr1: parts.first, addr2: parts.second,
        freeShipMin: current.freeShipMin };
      if (Object.prototype.hasOwnProperty.call(values, field)) el.textContent = values[field];
    });
    Array.prototype.forEach.call(document.querySelectorAll('meta[name="description"], img[alt]'), function (el) {
      var attr = el.tagName.toLowerCase() === 'meta' ? 'content' : 'alt';
      var original = el.getAttribute(attr) || '';
      var updated = original;
      substitutions.forEach(function (item) { updated = replaceKnown(updated, item[0], item[1]); });
      if (updated !== original) el.setAttribute(attr, updated);
    });
    document.title = replaceKnown(document.title, previous.name, current.storeName);
  }
  apply(current);
  var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 2500) : null;
  var ready = fetch('/api/store-settings', {
    method: 'GET', credentials: 'omit', cache: 'no-store',
    ...(ctrl ? { signal: ctrl.signal } : {})
  }).then(function (res) { return res.ok ? res.json() : null; })
    .then(function (result) {
      var cfg = normalize(result && result.settings);
      if (cfg) apply(cfg);
      return current;
    }).catch(function () { return current; }).then(function (value) {
      if (timer) clearTimeout(timer);
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', syncDocument, { once: true });
      } else syncDocument();
      return value;
    });
  window.StorefrontSettings = { ready: ready, get: function () { return Object.assign({}, current); }, sync: syncDocument };
})();
