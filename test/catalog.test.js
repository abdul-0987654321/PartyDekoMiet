'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { normaliseProduct, plainText } = require('../src/catalog/shopify');
const { search } = require('../src/catalog/search');

const SHOP = 'https://partydekomiet.ch';

const raw = (over = {}) => ({
  id: 111, handle: 'einhorn-set-rosa', title: 'Einhorn Set Rosa',
  body_html: '<p>Zauberhafte <b>Einhorn</b>-Deko</p><p>mit Ballons</p>',
  product_type: 'Kindergeburtstag', tags: 'einhorn, rosa, maedchen',
  variants: [{ id: 1, price: '89.00', available: true }],
  images: [{ src: 'https://cdn.shopify.com/a.jpg' }],
  ...over,
});

describe('normalising a Shopify product', () => {
  test('reads the fields the bot needs', () => {
    const p = normaliseProduct(raw(), SHOP);
    assert.strictEqual(p.id, '111');
    assert.strictEqual(p.handle, 'einhorn-set-rosa');
    assert.strictEqual(p.price, 89);
    assert.strictEqual(p.priceLabel, 'CHF 89.-');
    assert.strictEqual(p.url, `${SHOP}/products/einhorn-set-rosa`);
    assert.strictEqual(p.image, 'https://cdn.shopify.com/a.jpg');
    assert.deepStrictEqual(p.tags, ['einhorn', 'rosa', 'maedchen']);
  });

  test('takes the cheapest variant', () => {
    const p = normaliseProduct(raw({ variants: [
      { price: '120.00', available: true }, { price: '89.00', available: true },
    ] }), SHOP);
    assert.strictEqual(p.price, 89);
  });

  test('survives a product with no price, image or tags', () => {
    const p = normaliseProduct({ id: 9, handle: 'x', title: 'X' }, SHOP);
    assert.strictEqual(p.price, null);
    assert.strictEqual(p.priceLabel, null);
    assert.strictEqual(p.image, null);
    assert.deepStrictEqual(p.tags, []);
    assert.strictEqual(p.available, false);
  });

  test('accepts tags as an array as well as a string', () => {
    assert.deepStrictEqual(normaliseProduct(raw({ tags: ['a', 'b'] }), SHOP).tags, ['a', 'b']);
  });

  test('strips HTML out of the description', () => {
    assert.strictEqual(plainText('<p>Hallo <b>Welt</b></p><p>Zweite</p>'), 'Hallo Welt Zweite');
    assert.strictEqual(plainText('Caf&amp;eacute; &quot;x&quot;').includes('<'), false);
  });
});

describe('searching the catalog', () => {
  const products = [
    normaliseProduct(raw(), SHOP),
    normaliseProduct(raw({ id: 2, handle: 'prinzessin-set', title: 'Prinzessin Set', tags: 'prinzessin, rosa, krone' }), SHOP),
    normaliseProduct(raw({ id: 3, handle: 'dino-set', title: 'Dino Set Gruen', tags: 'dino, gruen, junge' }), SHOP),
    normaliseProduct(raw({ id: 4, handle: 'mermaid', title: 'Meerjungfrau Deko', tags: 'meerjungfrau, blau' }), SHOP),
  ];
  const titles = (q) => search(products, q).map((p) => p.title);

  test('finds by theme word', () => {
    assert.strictEqual(titles({ query: 'einhorn' })[0], 'Einhorn Set Rosa');
  });

  test('ignores filler words around the theme', () => {
    assert.strictEqual(titles({ query: 'hallo ich suche deko für einen einhorn geburtstag' })[0], 'Einhorn Set Rosa');
  });

  test('maps English to the German product name', () => {
    assert.strictEqual(titles({ query: 'do you have a unicorn set?' })[0], 'Einhorn Set Rosa');
    assert.strictEqual(titles({ query: 'mermaid' })[0], 'Meerjungfrau Deko');
  });

  test('treats pink and rosa as the same colour', () => {
    const hits = titles({ query: 'pink' });
    assert.ok(hits.includes('Einhorn Set Rosa') || hits.includes('Prinzessin Set'));
  });

  test('uses the separate theme and color arguments', () => {
    assert.strictEqual(titles({ query: 'geburtstag', theme: 'dino', color: 'gruen' })[0], 'Dino Set Gruen');
  });

  test('returns nothing invented for a theme that does not exist', () => {
    assert.deepStrictEqual(titles({ query: 'traktor bauernhof' }), []);
  });

  test('falls back to available products when the query carries no signal', () => {
    assert.ok(titles({ query: 'hallo' }).length > 0);
  });

  test('respects the limit', () => {
    assert.ok(search(products, { query: 'set', limit: 2 }).length <= 2);
  });

  test('ranks unavailable products below available ones', () => {
    const withSold = [
      ...products,
      normaliseProduct(raw({ id: 5, handle: 'einhorn-gold', title: 'Einhorn Gold', variants: [{ price: '99', available: false }] }), SHOP),
    ];
    const hits = search(withSold, { query: 'einhorn' }).map((p) => p.title);
    assert.ok(hits.indexOf('Einhorn Set Rosa') < hits.indexOf('Einhorn Gold'));
  });
});
