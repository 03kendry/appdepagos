// ─── PayPal NCP (No-Code Checkout) — lógica de negocio ──────────────────────
// Los pay links NCP se crean MANUALMENTE en el dashboard de PayPal Business
// (https://www.paypal.com/ncp/payment/<ID>); no existe API para generarlos.
// El checkout ocurre 100% del lado de PayPal y no acepta metadata ni order_id,
// por eso el matching se hace con un código de referencia que el cliente pega
// en el campo personalizado "Código de referencia" del link.
//
// Este módulo no toca la base de datos directamente: recibe un "store" con
// las operaciones de persistencia (ver ncp-store.js) para poder probarse
// con mocks. Tampoco depende de Express.

const crypto = require('crypto');
const fs = require('fs');

const REF_PREFIX = 'NXP';
// Alfabeto sin caracteres confundibles (0/O, 1/I/L)
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const REF_LENGTH = 6;
const REF_REGEX = new RegExp(`${REF_PREFIX}-[${REF_ALPHABET}]{${REF_LENGTH}}`, 'g');

// Estados de una orden NCP (columna `estado` de la tabla pagos).
// waiting y expired ya existen en el vocabulario del flujo cripto;
// pending_review es nuevo: pago recibido pero sin match automático confiable.
const NCP_STATES = {
  WAITING: 'waiting',
  PENDING_REVIEW: 'pending_review',
  FINISHED: 'finished',
  EXPIRED: 'expired',
};

// NCP ya no permite campos personalizados en los pay links, así que el código
// no viaja dentro del pago: es el comprobante que usa el vendedor para
// confirmar manualmente (o reconcile, si el comprador lo pega en la nota).
const NCP_INSTRUCTIONS = [
  'Guarda tu código de referencia: es tu comprobante.',
  'Paga en PayPal (se abre en una pestaña nueva). Si te ofrece una nota para el vendedor, incluye ahí tu código.',
  'El vendedor confirmará tu pago. Puede tardar un poco.',
];

// ─── Configuración de links ──────────────────────────────────────────────────
// PAYPAL_NCP_LINKS_CONFIG acepta JSON inline o la ruta a un archivo .json.
// Formato: [{ id, nombre, monto, moneda, url, tipo: "fijo"|"monto_abierto", activo }]

function parseNcpLinks(raw) {
  if (!raw || !String(raw).trim()) return { links: [], errors: [] };

  let text = String(raw).trim();
  if (!text.startsWith('[') && !text.startsWith('{')) {
    try {
      text = fs.readFileSync(text, 'utf8');
    } catch (err) {
      return { links: [], errors: [`No se pudo leer el archivo de links NCP: ${err.message}`] };
    }
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { links: [], errors: [`PAYPAL_NCP_LINKS_CONFIG no es JSON válido: ${err.message}`] };
  }
  if (!Array.isArray(data)) data = [data];

  const links = [];
  const errors = [];
  data.forEach((l, i) => {
    const faltan = ['id', 'nombre', 'url', 'moneda', 'tipo'].filter((k) => !l || !l[k]);
    if (faltan.length) {
      errors.push(`Link NCP #${i + 1}: faltan campos ${faltan.join(', ')}`);
      return;
    }
    if (!['fijo', 'monto_abierto'].includes(l.tipo)) {
      errors.push(`Link NCP "${l.id}": tipo inválido "${l.tipo}" (usa "fijo" o "monto_abierto")`);
      return;
    }
    if (l.tipo === 'fijo' && (typeof l.monto !== 'number' || l.monto <= 0)) {
      errors.push(`Link NCP "${l.id}": un link fijo necesita un monto numérico mayor a 0`);
      return;
    }
    if (!/^https:\/\/www\.paypal\.com\/ncp\/payment\/.+/.test(l.url)) {
      errors.push(`Link NCP "${l.id}": la URL no parece un pay link NCP (https://www.paypal.com/ncp/payment/<ID>)`);
      return;
    }
    links.push({ ...l, moneda: String(l.moneda).toUpperCase(), activo: l.activo !== false });
  });

  return { links, errors };
}

// Selección: link fijo con monto exacto primero; si no hay, link de monto abierto.
function selectNcpLink(links, monto, moneda = 'USD') {
  const mon = String(moneda).toUpperCase();
  const activos = (links || []).filter((l) => l.activo && l.moneda === mon);

  const fijo = activos.find((l) => l.tipo === 'fijo' && Math.abs(l.monto - monto) < 0.005);
  if (fijo) return fijo;

  return activos.find((l) => l.tipo === 'monto_abierto') || null;
}

// ─── Códigos de referencia ───────────────────────────────────────────────────

function generateReferenceCode(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(REF_LENGTH);
  let code = '';
  for (let i = 0; i < REF_LENGTH; i++) {
    code += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  }
  return `${REF_PREFIX}-${code}`;
}

async function generateUniqueReferenceCode(isTaken, maxAttempts = 8) {
  for (let i = 0; i < maxAttempts; i++) {
    const code = generateReferenceCode();
    if (!(await isTaken(code))) return code;
  }
  throw new Error('No se pudo generar un código de referencia único');
}

function extractReferenceCode(text) {
  if (!text) return null;
  const match = String(text).toUpperCase().match(REF_REGEX);
  return match ? match[0] : null;
}

// ─── Crear checkout NCP (PASO 1) ─────────────────────────────────────────────
// deps: { links, isReferenceTaken(code), saveOrder(orden), ttlMinutes }

async function createNcpCheckout(order, deps) {
  const { links, isReferenceTaken, saveOrder, ttlMinutes = 60 } = deps;
  const moneda = String(order.moneda || 'USD').toUpperCase();

  const link = selectNcpLink(links, order.monto, moneda);
  if (!link) {
    const err = new Error('No hay un link de pago PayPal disponible para ese monto');
    err.code = 'NO_NCP_LINK';
    throw err;
  }

  const referenceCode = await generateUniqueReferenceCode(isReferenceTaken);
  const expiraEn = new Date(Date.now() + ttlMinutes * 60 * 1000);

  const orderId = await saveOrder({
    monto: order.monto,
    moneda: link.moneda,
    concepto: order.concepto || 'Pago',
    referencia: referenceCode,
    expiraEn,
  });

  return {
    orderId,
    referenceCode,
    url: link.url,
    amount: order.monto,
    currency: link.moneda,
    linkType: link.tipo,
    expiresAt: expiraEn.toISOString(),
    instructions: NCP_INSTRUCTIONS,
    openAmountWarning:
      link.tipo === 'monto_abierto'
        ? `Este link te pedirá el monto: ingresa exactamente ${order.monto.toFixed(2)} ${link.moneda}.`
        : null,
  };
}

// ─── Normalización de pagos entrantes ────────────────────────────────────────
// El webhook (PAYMENT.CAPTURE.COMPLETED) y la Transaction Search API entregan
// formas distintas; ambas se reducen a { txId, amount, currency, searchable }
// para compartir el matching y la idempotencia.

function normalizeCaptureEvent(event) {
  const r = (event && event.resource) || {};
  return {
    txId: r.id || null,
    amount: r.amount && r.amount.value != null ? parseFloat(r.amount.value) : null,
    currency: r.amount ? String(r.amount.currency_code || '').toUpperCase() : null,
    searchable: JSON.stringify(event || {}),
  };
}

function normalizeSearchTransaction(item) {
  const info = (item && item.transaction_info) || {};
  const amt = info.transaction_amount || {};
  return {
    txId: info.transaction_id || null,
    amount: amt.value != null ? Math.abs(parseFloat(amt.value)) : null,
    currency: String(amt.currency_code || '').toUpperCase(),
    searchable: JSON.stringify(item || {}),
  };
}

// ─── Matching (PASO 2) ───────────────────────────────────────────────────────
// (a) reference_code válido en el payload → orden pagada (si monto/moneda coinciden).
// (b) sin código → heurística monto + moneda + ventana de tiempo → pending_review;
//     NUNCA se marca pagada automáticamente sin código.
// Idempotencia por transaction_id: un tx ya registrado no se procesa dos veces.

async function processPayment(payment, store, opts = {}) {
  const { windowMinutes = 90, now = () => new Date() } = opts;
  const { txId, amount, currency, searchable } = payment;

  if (!txId) return { action: 'ignored', reason: 'transacción sin id' };
  if (await store.isTransactionProcessed(txId)) {
    return { action: 'duplicate', txId };
  }

  const referenceCode = extractReferenceCode(searchable);

  if (referenceCode) {
    const order = await store.findOrderByReference(referenceCode);
    if (order) {
      const montoOrden = order.monto != null ? parseFloat(order.monto) : null;
      const montoCoincide =
        amount == null || montoOrden == null || Math.abs(montoOrden - amount) < 0.005;
      const monedaCoincide =
        !currency || !order.moneda || currency === String(order.moneda).toUpperCase();

      if (!montoCoincide || !monedaCoincide) {
        await store.markPendingReview(
          order.id,
          txId,
          `Pago con código pero datos distintos: pagado ${amount} ${currency}, esperado ${montoOrden} ${order.moneda}`
        );
        return { action: 'pending_review', orderId: order.id, referenceCode, txId, reason: 'monto o moneda distintos' };
      }

      if (order.estado === NCP_STATES.EXPIRED) {
        await store.markPendingReview(order.id, txId, 'Pago recibido después de expirar la orden');
        return { action: 'pending_review', orderId: order.id, referenceCode, txId, reason: 'orden expirada' };
      }

      if ([NCP_STATES.WAITING, NCP_STATES.PENDING_REVIEW].includes(order.estado)) {
        await store.markPaid(order.id, txId);
        return { action: 'paid', orderId: order.id, referenceCode, txId };
      }
      // Orden ya finalizada con otro tx: cae al flujo de no-match de abajo.
    }
  }

  // Heurística: nunca marca pagada, solo pending_review
  let candidates = [];
  if (amount != null && currency) {
    const since = new Date(now().getTime() - windowMinutes * 60 * 1000);
    candidates = await store.findWaitingOrders({ amount, currency, since });
  }

  if (candidates.length === 1) {
    await store.markPendingReview(
      candidates[0].id,
      txId,
      `Match heurístico por monto/moneda (${amount} ${currency}), sin código de referencia`
    );
    return { action: 'pending_review', orderId: candidates[0].id, txId, reason: 'match heurístico' };
  }

  const nota = referenceCode
    ? `Código ${referenceCode} sin orden asociada`
    : candidates.length > 1
      ? `Múltiples órdenes candidatas para ${amount} ${currency}`
      : 'Sin orden candidata';
  const unmatchedId = await store.insertUnmatched({ txId, amount, currency, nota });
  return { action: 'pending_review', orderId: unmatchedId ?? null, txId, reason: nota };
}

// ─── Verificación de firma del webhook (obligatoria) ─────────────────────────
// Usa la API oficial /v1/notifications/verify-webhook-signature. El body del
// evento se inserta como raw string para no alterar la firma al re-serializar.

const WEBHOOK_SIGNATURE_HEADERS = [
  'paypal-auth-algo',
  'paypal-cert-url',
  'paypal-transmission-id',
  'paypal-transmission-sig',
  'paypal-transmission-time',
];

async function verifyWebhookSignature({ headers, rawBody, webhookId, getAccessToken, paypalBase, fetchImpl = fetch }) {
  if (!webhookId) return { verified: false, reason: 'PAYPAL_WEBHOOK_ID no configurado' };
  if (!rawBody) return { verified: false, reason: 'body vacío' };

  const h = {};
  for (const name of WEBHOOK_SIGNATURE_HEADERS) {
    h[name] = headers[name];
    if (!h[name]) return { verified: false, reason: `falta el header ${name}` };
  }

  const token = await getAccessToken();
  const body =
    `{"auth_algo":${JSON.stringify(h['paypal-auth-algo'])}` +
    `,"cert_url":${JSON.stringify(h['paypal-cert-url'])}` +
    `,"transmission_id":${JSON.stringify(h['paypal-transmission-id'])}` +
    `,"transmission_sig":${JSON.stringify(h['paypal-transmission-sig'])}` +
    `,"transmission_time":${JSON.stringify(h['paypal-transmission-time'])}` +
    `,"webhook_id":${JSON.stringify(webhookId)}` +
    `,"webhook_event":${rawBody}}`;

  const res = await fetchImpl(`${paypalBase}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  if (!res.ok) return { verified: false, reason: `verify API respondió HTTP ${res.status}` };

  const data = await res.json();
  return { verified: data.verification_status === 'SUCCESS', reason: data.verification_status };
}

module.exports = {
  NCP_STATES,
  NCP_INSTRUCTIONS,
  REF_PREFIX,
  REF_ALPHABET,
  REF_LENGTH,
  parseNcpLinks,
  selectNcpLink,
  generateReferenceCode,
  generateUniqueReferenceCode,
  extractReferenceCode,
  createNcpCheckout,
  normalizeCaptureEvent,
  normalizeSearchTransaction,
  processPayment,
  verifyWebhookSignature,
};
