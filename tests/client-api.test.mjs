import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJson, productSaveConfirmed } from '../lib/client-api.mjs';

const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const payload = () => ({ id: 'P1', sku: 'coffee-1', name: 'Coffee beans', category: 'Food', baseUnit: 'pc', units: [{ name: 'pc', factor: 1 }], rate: 80, reorderLevel: 5, active: true });
const state = () => ({ products: [{ ...payload(), sku: 'COFFEE-1' }], stock: [], documents: [], demands: [], ledger: [] });
const quantityPayload = () => ({ ...payload(), warehouseQuantity: 100, warehouseExpectedQuantity: 0, warehouseRate: 80 });
const count = (status = 'Pending approval') => ({ type: 'adjustment', locationId: 'WH', status, createdBy: 'U1', productQuantitySetup: { productId: 'P1', fromQty: 0, targetQty: 100 }, lines: [{ productId: 'P1', unit: 'pc', baseUnit: 'pc', factor: 1, qty: 100, baseQty: 100, rate: 80, unitCost: 80 }] });

test('JSON requests retain exact path, options and successful response', async () => {
  let calls = 0;
  assert.deepEqual(await requestJson('/api/action', { action: 'product.save' }, async (path, options) => {
    calls++;
    assert.equal(path, '/api/action');
    assert.equal(options.method, 'POST');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), { action: 'product.save' });
    return reply({ saved: true });
  }), { saved: true });
  assert.equal(calls, 1);
});

test('lost POST response is uncertain and never retried', async () => {
  let calls = 0;
  await assert.rejects(requestJson('/api/action', {}, async () => { calls++; throw new TypeError('Failed to fetch'); }), error => error.networkError === true && error.saveUnconfirmed === true && error.status === 0 && /could not be confirmed/.test(error.message));
  assert.equal(calls, 1);
});

test('truncated body retains HTTP status and is a connection interruption', async () => {
  await assert.rejects(requestJson('/api/action', {}, async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } })), error => error.networkError === true && error.saveUnconfirmed === true && error.status === 200);
  await assert.rejects(requestJson('/api/state', undefined, async () => { throw new TypeError('Failed to fetch'); }), error => error.networkError === true && !error.saveUnconfirmed && /loading/.test(error.message));
});

test('exact server fetch failures are normalized; validation and auth statuses survive', async () => {
  for (const message of ['fetch failed', 'Failed to fetch']) {
    await assert.rejects(requestJson('/api/action', {}, async () => reply({ error: message }, 400)), error => error.networkError === true && error.status === 400 && error.saveUnconfirmed === true);
  }
  await assert.rejects(requestJson('/api/action', {}, async () => reply({ error: 'Failed to fetch' }, 401)), error => error.status === 401 && error.networkError === true);
  await assert.rejects(requestJson('/api/action', {}, async () => reply({ error: 'SKU must be unique.' }, 400)), error => error.message === 'SKU must be unique.' && error.status === 400 && !error.networkError);
});

test('fresh product fields must exactly match saved normalization', () => {
  assert.equal(productSaveConfirmed(state(), payload()), true);
  for (const [key, value] of Object.entries({ id: 'P2', sku: 'OTHER', name: 'Other', category: 'Drinks', baseUnit: 'kg', units: [{ name: 'pc', factor: 2 }], rate: 81, reorderLevel: 6, active: false })) {
    assert.equal(productSaveConfirmed(state(), { ...payload(), [key]: value }), false, key);
  }
  const draft = state(); draft.products[0].setupPending = false;
  assert.equal(productSaveConfirmed(draft, payload()), false);
  assert.equal(productSaveConfirmed(state(), { ...payload(), id: undefined }), false);
  const zero = state(); zero.products[0].rate = 0;
  assert.equal(productSaveConfirmed(zero, { ...payload(), rate: 0 }), true);
  assert.equal(productSaveConfirmed(zero, { ...payload(), rate: null }), false);
  zero.products[0].rate = null;
  assert.equal(productSaveConfirmed(zero, { ...payload(), rate: '' }), true);
});

test('unit aliases normalize before the first count and locked legacy units remain exact', () => {
  assert.equal(productSaveConfirmed(state(), { ...payload(), baseUnit: 'pieces', units: [{ name: 'pieces', factor: '1' }] }), true);
  const locked = state(); locked.products[0].baseUnit = 'pieces'; locked.products[0].units = [{ name: 'pieces', factor: 1 }]; locked.ledger = [{ productId: 'P1' }];
  assert.equal(productSaveConfirmed(locked, { ...payload(), baseUnit: 'pieces', units: [{ name: 'pieces', factor: 1 }] }), true);
  const posted = state(); posted.ledger = [{ productId: 'P1' }];
  assert.equal(productSaveConfirmed(posted, { ...payload(), baseUnit: 'pieces', units: [{ name: 'pieces', factor: 1 }] }), true);
});

test('a dropped response is confirmed only when the requested product and quantity committed', async () => {
  for (const committed of [false, true]) {
    const fresh = state(); fresh.products[0].active = false; fresh.products[0].setupPending = true;
    let calls = 0;
    await assert.rejects(requestJson('/api/action', { action: 'product.save', payload: quantityPayload() }, async () => {
      calls++;
      if (committed) { fresh.products[0] = state().products[0]; fresh.stock.push({ productId: 'P1', locationId: 'WH', qty: 100, avgCost: 80 }); }
      throw new TypeError('Failed to fetch');
    }), error => error.networkError === true);
    assert.equal(calls, 1);
    assert.equal(productSaveConfirmed(fresh, quantityPayload(), { id: 'U1' }), committed);
  }
});

test('warehouse confirmation rejects wrong balance, opening cost or branch balance', () => {
  for (const stock of [
    { productId: 'P1', locationId: 'WH', qty: 99, avgCost: 80 },
    { productId: 'P1', locationId: 'WH', qty: 100, avgCost: 79 },
    { productId: 'P1', locationId: 'B1', qty: 100, avgCost: 80 },
  ]) { const fresh = state(); fresh.stock = [stock]; assert.equal(productSaveConfirmed(fresh, quantityPayload(), { id: 'U1' }), false); }
});

test('pending count requires matching actor, target, baseline, product and unit/cost line', () => {
  const fresh = state(); fresh.documents = [count()];
  assert.equal(productSaveConfirmed(fresh, quantityPayload(), { id: 'U1' }), true);
  assert.equal(productSaveConfirmed(fresh, quantityPayload()), false);
  assert.equal(productSaveConfirmed(fresh, quantityPayload(), { id: 'U2' }), false);
  for (const change of [
    doc => { doc.productQuantitySetup.fromQty = 5; },
    doc => { doc.productQuantitySetup.targetQty = 101; },
    doc => { doc.productQuantitySetup.productId = 'P2'; },
    doc => { doc.lines[0].unit = 'box'; },
    doc => { doc.lines[0].rate = 79; },
    doc => { doc.lines[0].unitCost = 79; },
    doc => { doc.lines[0].baseQty = 101; },
    doc => { doc.status = 'Rejected'; },
  ]) { const other = state(); const doc = count(); change(doc); other.documents = [doc]; assert.equal(productSaveConfirmed(other, quantityPayload(), { id: 'U1' }), false); }
  fresh.stock = [{ productId: 'P1', locationId: 'WH', qty: 3, avgCost: 80 }];
  assert.equal(productSaveConfirmed(fresh, quantityPayload(), { id: 'U1' }), false);
});

test('a completed count document cannot hide the wrong opening cost', () => {
  const fresh = state();
  fresh.stock = [{ productId: 'P1', locationId: 'WH', qty: 100, avgCost: 79 }];
  const doc = count('Completed'); doc.lines[0].unitCost = 79;
  fresh.documents = [doc];
  assert.equal(productSaveConfirmed(fresh, quantityPayload(), { id: 'U1' }), false);
});

test('a replay conflict after a committed save confirms only the exact fresh result', async () => {
  let calls = 0;
  const fresh = state();
  // The original request committed before its response was lost; a browser replay
  // can then receive a revision conflict without the application retrying a POST.
  fresh.stock = [{ productId: 'P1', locationId: 'WH', qty: 100, avgCost: 80 }];
  await assert.rejects(requestJson('/api/action', { action: 'product.save', payload: quantityPayload() }, async () => {
    calls++;
    return reply({ error: 'This record changed. Reload and try again.' }, 409);
  }), error => error.status === 409 && !error.networkError && error.message === 'This record changed. Reload and try again.');
  assert.equal(calls, 1);
  assert.equal(productSaveConfirmed(fresh, quantityPayload(), { id: 'U1' }), true);
  assert.equal(productSaveConfirmed(fresh, { ...quantityPayload(), warehouseQuantity: 101 }, { id: 'U1' }), false);
  assert.equal(productSaveConfirmed(fresh, { ...quantityPayload(), rate: 81 }, { id: 'U1' }), false);
});
