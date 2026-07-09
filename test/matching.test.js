// Matching de pagos entrantes (webhook y reconciliación) e idempotencia.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  processPayment,
  normalizeCaptureEvent,
  normalizeSearchTransaction,
} = require('../ncp');
const { createMemoryStore } = require('./helpers');

const captureConRef = require('./fixtures/capture-completed.json'); // NXP-A7F3K2, 25 USD
const captureSinRef = require('./fixtures/capture-no-reference.json'); // sin código, 40 USD
const searchFixture = require('./fixtures/transaction-search.json'); // NXP-B8G4M3, 12 USD

const hace = (min) => new Date(Date.now() - min * 60 * 1000);

function ordenWaiting(over = {}) {
  return {
    id: 1,
    tipo: 'ncp',
    monto: 25,
    moneda: 'USD',
    estado: 'waiting',
    referencia: 'NXP-A7F3K2',
    creado_en: hace(10),
    expira_en: new Date(Date.now() + 50 * 60 * 1000),
    ...over,
  };
}

describe('matching por código de referencia', () => {
  test('payload con código válido y monto correcto → orden pagada', async () => {
    const store = createMemoryStore([ordenWaiting()]);
    const r = await processPayment(normalizeCaptureEvent(captureConRef), store);

    assert.equal(r.action, 'paid');
    assert.equal(r.orderId, 1);
    assert.equal(r.referenceCode, 'NXP-A7F3K2');
    assert.equal(store.orders[0].estado, 'finished');
    assert.equal(store.orders[0].tx_id, '42311647XV020574X');
  });

  test('código válido pero monto distinto → pending_review, nunca pagada', async () => {
    const store = createMemoryStore([ordenWaiting({ monto: 30 })]);
    const r = await processPayment(normalizeCaptureEvent(captureConRef), store);

    assert.equal(r.action, 'pending_review');
    assert.equal(store.orders[0].estado, 'pending_review');
    assert.match(store.orders[0].nota, /datos distintos/);
  });

  test('código válido sobre orden expirada → pending_review', async () => {
    const store = createMemoryStore([ordenWaiting({ estado: 'expired' })]);
    const r = await processPayment(normalizeCaptureEvent(captureConRef), store);

    assert.equal(r.action, 'pending_review');
    assert.equal(store.orders[0].estado, 'pending_review');
  });

  test('código sin orden asociada → fila pending_review sin match', async () => {
    const store = createMemoryStore([]);
    const r = await processPayment(normalizeCaptureEvent(captureConRef), store);

    assert.equal(r.action, 'pending_review');
    assert.equal(store.orders.length, 1);
    assert.equal(store.orders[0].estado, 'pending_review');
  });
});

describe('matching heurístico (sin código)', () => {
  test('una sola candidata por monto+moneda+ventana → pending_review, NUNCA pagada', async () => {
    const store = createMemoryStore([
      ordenWaiting({ id: 7, monto: 40, referencia: 'NXP-WCCCCC', creado_en: hace(20) }),
    ]);
    const r = await processPayment(normalizeCaptureEvent(captureSinRef), store);

    assert.equal(r.action, 'pending_review');
    assert.equal(r.orderId, 7);
    assert.equal(store.orders[0].estado, 'pending_review');
    assert.notEqual(store.orders[0].estado, 'finished');
  });

  test('candidata fuera de la ventana de tiempo → no hay match', async () => {
    const store = createMemoryStore([
      ordenWaiting({ id: 7, monto: 40, referencia: 'NXP-WAAAAA', creado_en: hace(300) }),
    ]);
    const r = await processPayment(normalizeCaptureEvent(captureSinRef), store, { windowMinutes: 90 });

    assert.equal(r.action, 'pending_review');
    assert.notEqual(r.orderId, 7);
    assert.equal(store.orders.find((o) => o.id === 7).estado, 'waiting');
  });

  test('múltiples candidatas → ninguna se toca, fila sin match', async () => {
    const store = createMemoryStore([
      ordenWaiting({ id: 7, monto: 40, referencia: 'NXP-WAAAAA', creado_en: hace(20) }),
      ordenWaiting({ id: 8, monto: 40, referencia: 'NXP-WBBBBB', creado_en: hace(15) }),
    ]);
    const r = await processPayment(normalizeCaptureEvent(captureSinRef), store);

    assert.equal(r.action, 'pending_review');
    assert.equal(store.orders.find((o) => o.id === 7).estado, 'waiting');
    assert.equal(store.orders.find((o) => o.id === 8).estado, 'waiting');
    assert.equal(store.orders.length, 3); // se insertó la fila sin match
  });
});

describe('idempotencia por transaction_id', () => {
  test('el mismo evento de webhook dos veces → duplicate, sin cambios', async () => {
    const store = createMemoryStore([ordenWaiting()]);

    const r1 = await processPayment(normalizeCaptureEvent(captureConRef), store);
    assert.equal(r1.action, 'paid');

    const r2 = await processPayment(normalizeCaptureEvent(captureConRef), store);
    assert.equal(r2.action, 'duplicate');
    assert.equal(store.orders.length, 1);
    assert.equal(store.orders[0].estado, 'finished');
  });

  test('webhook y reconciliación comparten idempotencia (mismo tx_id)', async () => {
    const store = createMemoryStore([
      ordenWaiting({ id: 3, monto: 12, referencia: 'NXP-B8G4M3' }),
    ]);

    const desdeSearch = normalizeSearchTransaction(searchFixture.transaction_details[0]);
    const r1 = await processPayment(desdeSearch, store);
    assert.equal(r1.action, 'paid');
    assert.equal(store.orders[0].tx_id, '8MC585209K746392H');

    // La misma transacción vuelve a aparecer en la siguiente reconciliación
    const r2 = await processPayment(desdeSearch, store);
    assert.equal(r2.action, 'duplicate');
  });

  test('transacción sin id se ignora', async () => {
    const store = createMemoryStore([]);
    const r = await processPayment({ txId: null, amount: 10, currency: 'USD', searchable: '{}' }, store);
    assert.equal(r.action, 'ignored');
    assert.equal(store.orders.length, 0);
  });
});

describe('normalizadores', () => {
  test('normalizeCaptureEvent extrae tx, monto y moneda del webhook', () => {
    const n = normalizeCaptureEvent(captureConRef);
    assert.equal(n.txId, '42311647XV020574X');
    assert.equal(n.amount, 25);
    assert.equal(n.currency, 'USD');
    assert.ok(n.searchable.includes('NXP-A7F3K2'));
  });

  test('normalizeSearchTransaction extrae lo mismo de Transaction Search', () => {
    const n = normalizeSearchTransaction(searchFixture.transaction_details[0]);
    assert.equal(n.txId, '8MC585209K746392H');
    assert.equal(n.amount, 12);
    assert.equal(n.currency, 'USD');
    assert.ok(n.searchable.includes('NXP-B8G4M3'));
  });
});
