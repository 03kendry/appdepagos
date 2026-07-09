const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  parseNcpLinks,
  selectNcpLink,
  generateReferenceCode,
  generateUniqueReferenceCode,
  extractReferenceCode,
  createNcpCheckout,
  REF_ALPHABET,
} = require('../ncp');
const { createMemoryStore } = require('./helpers');

const LINKS_OK = JSON.stringify([
  { id: 'pl-10', nombre: 'Pago 10', monto: 10, moneda: 'usd', url: 'https://www.paypal.com/ncp/payment/AAA111', tipo: 'fijo' },
  { id: 'pl-25', nombre: 'Pago 25', monto: 25, moneda: 'USD', url: 'https://www.paypal.com/ncp/payment/BBB222', tipo: 'fijo', activo: true },
  { id: 'pl-abierto', nombre: 'Monto abierto', moneda: 'USD', url: 'https://www.paypal.com/ncp/payment/CCC333', tipo: 'monto_abierto' },
  { id: 'pl-inactivo', nombre: 'Pago 50', monto: 50, moneda: 'USD', url: 'https://www.paypal.com/ncp/payment/DDD444', tipo: 'fijo', activo: false },
]);

describe('parseNcpLinks', () => {
  test('parsea JSON inline válido y normaliza moneda/activo', () => {
    const { links, errors } = parseNcpLinks(LINKS_OK);
    assert.equal(errors.length, 0);
    assert.equal(links.length, 4);
    assert.equal(links[0].moneda, 'USD');
    assert.equal(links[0].activo, true);
    assert.equal(links[3].activo, false);
  });

  test('sin configuración → módulo inactivo sin errores', () => {
    assert.deepEqual(parseNcpLinks(undefined), { links: [], errors: [] });
    assert.deepEqual(parseNcpLinks(''), { links: [], errors: [] });
    assert.deepEqual(parseNcpLinks('   '), { links: [], errors: [] });
  });

  test('JSON inválido → error sin lanzar excepción', () => {
    const { links, errors } = parseNcpLinks('{esto no es json');
    assert.equal(links.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /no es JSON válido|No se pudo leer/);
  });

  test('link con campos faltantes o inválidos se descarta con error', () => {
    const { links, errors } = parseNcpLinks(
      JSON.stringify([
        { id: 'sin-url', nombre: 'X', moneda: 'USD', tipo: 'fijo', monto: 5 },
        { id: 'tipo-malo', nombre: 'X', moneda: 'USD', url: 'https://www.paypal.com/ncp/payment/X1', tipo: 'variable' },
        { id: 'fijo-sin-monto', nombre: 'X', moneda: 'USD', url: 'https://www.paypal.com/ncp/payment/X2', tipo: 'fijo' },
        { id: 'url-mala', nombre: 'X', moneda: 'USD', monto: 5, url: 'https://evil.example.com/pago', tipo: 'fijo' },
        { id: 'ok', nombre: 'OK', monto: 5, moneda: 'USD', url: 'https://www.paypal.com/ncp/payment/X3', tipo: 'fijo' },
      ])
    );
    assert.equal(links.length, 1);
    assert.equal(links[0].id, 'ok');
    assert.equal(errors.length, 4);
  });
});

describe('selectNcpLink — selección de link por monto', () => {
  const { links } = parseNcpLinks(LINKS_OK);

  test('link fijo con monto exacto tiene prioridad', () => {
    assert.equal(selectNcpLink(links, 25, 'USD').id, 'pl-25');
    assert.equal(selectNcpLink(links, 10, 'USD').id, 'pl-10');
  });

  test('tolerancia de centavos en el match exacto', () => {
    assert.equal(selectNcpLink(links, 10.004, 'USD').id, 'pl-10');
    assert.equal(selectNcpLink(links, 10.01, 'USD').id, 'pl-abierto');
  });

  test('sin match fijo → cae al link de monto abierto', () => {
    assert.equal(selectNcpLink(links, 33.33, 'USD').id, 'pl-abierto');
  });

  test('links inactivos no se seleccionan', () => {
    assert.equal(selectNcpLink(links, 50, 'USD').id, 'pl-abierto');
  });

  test('moneda distinta → null si no hay links en esa moneda', () => {
    assert.equal(selectNcpLink(links, 25, 'EUR'), null);
  });

  test('sin link abierto ni fijo exacto → null', () => {
    const soloFijos = links.filter((l) => l.tipo === 'fijo');
    assert.equal(selectNcpLink(soloFijos, 99, 'USD'), null);
  });
});

describe('códigos de referencia', () => {
  test('formato NXP-XXXXXX con alfabeto sin caracteres confundibles', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateReferenceCode();
      assert.match(code, new RegExp(`^NXP-[${REF_ALPHABET}]{6}$`));
      assert.doesNotMatch(code, /[0O1IL]/);
    }
  });

  test('unicidad: reintenta cuando el código ya existe', async () => {
    let calls = 0;
    const isTaken = async () => ++calls <= 2; // los dos primeros intentos "chocan"
    const code = await generateUniqueReferenceCode(isTaken);
    assert.match(code, /^NXP-/);
    assert.equal(calls, 3);
  });

  test('unicidad: lanza error si se agotan los intentos', async () => {
    await assert.rejects(generateUniqueReferenceCode(async () => true, 3), /único/);
  });

  test('no genera duplicados en una muestra', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(generateReferenceCode());
    assert.equal(seen.size, 200);
  });

  test('extractReferenceCode encuentra el código en texto arbitrario', () => {
    assert.equal(extractReferenceCode('nota del cliente: nxp-a7f3k2 gracias'), 'NXP-A7F3K2');
    assert.equal(extractReferenceCode('{"custom_id":"NXP-B8G4M3"}'), 'NXP-B8G4M3');
    assert.equal(extractReferenceCode('sin código aquí'), null);
    assert.equal(extractReferenceCode(null), null);
    // 0, O, 1, I, L no pertenecen al alfabeto
    assert.equal(extractReferenceCode('NXP-A7F3K0'), null);
  });
});

describe('createNcpCheckout', () => {
  const { links } = parseNcpLinks(LINKS_OK);

  test('crea la orden con código único, expiración y guarda en el store', async () => {
    const store = createMemoryStore();
    const r = await createNcpCheckout(
      { monto: 25, moneda: 'USD', concepto: 'Diseño web' },
      { links, isReferenceTaken: store.isReferenceTaken, saveOrder: store.saveOrder, ttlMinutes: 30 }
    );

    assert.match(r.referenceCode, /^NXP-/);
    assert.equal(r.url, 'https://www.paypal.com/ncp/payment/BBB222');
    assert.equal(r.linkType, 'fijo');
    assert.equal(r.openAmountWarning, null);
    assert.equal(r.instructions.length, 3);

    const orden = await store.findOrderByReference(r.referenceCode);
    assert.ok(orden);
    assert.equal(orden.estado, 'waiting');
    assert.equal(orden.monto, 25);
    assert.ok(new Date(orden.expira_en) > new Date());
  });

  test('link de monto abierto incluye advertencia de monto exacto', async () => {
    const store = createMemoryStore();
    const r = await createNcpCheckout(
      { monto: 33.33, moneda: 'USD', concepto: 'Pago' },
      { links, isReferenceTaken: store.isReferenceTaken, saveOrder: store.saveOrder }
    );
    assert.equal(r.linkType, 'monto_abierto');
    assert.match(r.openAmountWarning, /33\.33 USD/);
  });

  test('sin link disponible → error NO_NCP_LINK', async () => {
    const store = createMemoryStore();
    const soloFijos = links.filter((l) => l.tipo === 'fijo');
    await assert.rejects(
      createNcpCheckout(
        { monto: 99, moneda: 'USD' },
        { links: soloFijos, isReferenceTaken: store.isReferenceTaken, saveOrder: store.saveOrder }
      ),
      (err) => err.code === 'NO_NCP_LINK'
    );
  });
});
