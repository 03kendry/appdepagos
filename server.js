require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const ncp = require('./ncp');
const { createPgStore } = require('./ncp-store');

const app = express();
// rawBody se necesita para verificar la firma del webhook de PayPal sin
// que la re-serialización del JSON altere el payload firmado
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);
app.use(express.static(path.join(__dirname, 'public')));

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENV,
  PAYPAL_MODE,
  PAYPAL_WEBHOOK_ID,
  PAYPAL_NCP_LINKS_CONFIG,
  NCP_ORDER_TTL_MINUTES,
  NCP_MATCH_WINDOW_MINUTES,
  NOWPAYMENTS_API_KEY,
  NOWPAYMENTS_IPN_SECRET,
  DATABASE_URL,
  ADMIN_PASSWORD,
  PORT = 3000,
  BASE_URL = 'http://localhost:3000',
} = process.env;

// ─── Validación de entorno ───────────────────────────────────────────────────
// Obligatorias: sin ellas el servidor NO arranca.
// Las variables de PayPal (REST y NCP) son OPCIONALES por ahora: si faltan se
// avisa por consola y el método PayPal queda deshabilitado, pero NOWPayments
// sigue funcionando solo. Ver RUNBOOK_NCP.md para activarlas.

const REQUIRED_ENV = {
  NOWPAYMENTS_API_KEY,
  DATABASE_URL,
  ADMIN_PASSWORD,
};

const envErrors = [];
for (const [name, value] of Object.entries(REQUIRED_ENV)) {
  if (!value) {
    envErrors.push(`${name} no está definida`);
  } else if (value.length < 16) {
    envErrors.push(`${name} debe tener mínimo 16 caracteres`);
  }
}

if (envErrors.length > 0) {
  console.error('❌ Configuración inválida. Corrige tu .env (ver .env.example):');
  for (const e of envErrors) console.error(`   - ${e}`);
  process.exit(1);
}

const paypalEnabled = Boolean(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET);
if (!paypalEnabled) {
  console.warn(
    '⚠ PayPal sin credenciales (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET): el método PayPal queda deshabilitado. El servidor arranca igual.'
  );
}

const { links: ncpLinks, errors: ncpConfigErrors } = ncp.parseNcpLinks(PAYPAL_NCP_LINKS_CONFIG);
ncpConfigErrors.forEach((e) => console.warn(`⚠ ${e}`));
const ncpEnabled = ncpLinks.some((l) => l.activo);
if (!ncpEnabled) {
  console.warn(
    '⚠ PAYPAL_NCP_LINKS_CONFIG vacía o inválida: el checkout PayPal NCP queda inactivo ("Próximamente" en la UI).'
  );
}

if (!PAYPAL_WEBHOOK_ID) {
  console.warn(
    '⚠ PAYPAL_WEBHOOK_ID no definido: el webhook de PayPal rechazará todos los eventos (la verificación de firma es obligatoria).'
  );
}

const NCP_TTL_MINUTES = parseInt(NCP_ORDER_TTL_MINUTES, 10) > 0 ? parseInt(NCP_ORDER_TTL_MINUTES, 10) : 60;
const NCP_WINDOW_MINUTES = parseInt(NCP_MATCH_WINDOW_MINUTES, 10) > 0 ? parseInt(NCP_MATCH_WINDOW_MINUTES, 10) : 90;

const PAYPAL_ENVIRONMENT = PAYPAL_ENV || PAYPAL_MODE || 'sandbox';
const PAYPAL_BASE =
  PAYPAL_ENVIRONMENT === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

// ─── Base de datos ───────────────────────────────────────────────────────────

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDB() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pagos (
      id          SERIAL PRIMARY KEY,
      tipo        VARCHAR(10)  NOT NULL,
      monto       NUMERIC(12,2),
      moneda      VARCHAR(20),
      estado      VARCHAR(30),
      tx_id       VARCHAR(200),
      concepto    VARCHAR(200),
      creado_en   TIMESTAMP DEFAULT NOW()
    )
  `);
  // Columnas NCP: código de referencia, expiración y nota de revisión
  await pool.query(`ALTER TABLE pagos ADD COLUMN IF NOT EXISTS referencia VARCHAR(24)`);
  await pool.query(`ALTER TABLE pagos ADD COLUMN IF NOT EXISTS expira_en TIMESTAMP`);
  await pool.query(`ALTER TABLE pagos ADD COLUMN IF NOT EXISTS nota VARCHAR(300)`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS pagos_referencia_unica ON pagos (referencia) WHERE referencia IS NOT NULL`
  );
  console.log('✅ Tabla pagos lista');
}

const ncpStore = createPgStore(pool);

async function guardarPago({ tipo, monto, moneda, estado, tx_id, concepto }) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO pagos (tipo, monto, moneda, estado, tx_id, concepto)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tipo, monto, moneda, estado, tx_id, concepto]
    );
  } catch (err) {
    console.error('Error guardando pago en DB:', err.message);
  }
}

initDB().catch((err) => console.error('Error iniciando DB:', err.message));

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getPayPalToken() {
  const credentials = Buffer.from(
    `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PayPal OAuth error: ${err}`);
  }

  const data = await res.json();
  return data.access_token;
}

// ─── Ruta: config pública ────────────────────────────────────────────────────

app.get('/api/config', async (req, res) => {
  try {
    const cryptoRes = await fetch(
      'https://api.nowpayments.io/v1/currencies?fixed_rate=false',
      { headers: { 'x-api-key': NOWPAYMENTS_API_KEY } }
    );

    const FALLBACK_CURRENCIES = ['usdttrc20', 'btc', 'eth', 'bnbbsc', 'sol', 'ltc'];
    let currencies = FALLBACK_CURRENCIES;

    if (cryptoRes.ok) {
      const data = await cryptoRes.json();
      const priority = ['usdttrc20', 'btc', 'eth', 'bnbbsc', 'sol', 'ltc'];
      const all = data.currencies || [];
      if (all.length > 0) {
        const prioritized = priority.filter((c) => all.includes(c));
        const rest = all
          .filter((c) => !priority.includes(c))
          .sort()
          .slice(0, 20);
        currencies = [...prioritized, ...rest];
      }
    }

    res.json({
      paypalClientId: paypalEnabled ? PAYPAL_CLIENT_ID : null,
      paypalEnabled,
      ncpEnabled,
      currencies,
    });
  } catch (err) {
    console.error('Error en /api/config:', err.message);
    res.status(500).json({ error: 'Error al cargar configuración' });
  }
});

// ─── Admin: login ────────────────────────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const token = crypto
    .createHmac('sha256', ADMIN_PASSWORD)
    .update('admin-token')
    .digest('hex');
  res.json({ token });
});

function checkAdmin(req, res, next) {
  const auth = req.headers['x-admin-token'];
  const expected = crypto
    .createHmac('sha256', ADMIN_PASSWORD)
    .update('admin-token')
    .digest('hex');
  if (!auth || auth !== expected) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// ─── Ruta: historial de pagos ────────────────────────────────────────────────

app.get('/api/pagos', checkAdmin, async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const result = await pool.query(
      'SELECT * FROM pagos ORDER BY creado_en DESC LIMIT 100'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error obteniendo pagos:', err.message);
    res.status(500).json({ error: 'Error al obtener pagos' });
  }
});

// ─── Admin: confirmar/rechazar un pago manualmente ───────────────────────────
// Núcleo del flujo NCP manual-first: como los pay links no llevan el código de
// referencia en el pago (PayPal ya no permite campos personalizados), la
// mayoría de los pagos NCP entran en pending_review y un operador los resuelve
// aquí tras cruzar monto/fecha con el pago real en PayPal.

app.post('/api/admin/pagos/:id/confirmar', checkAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    const { accion } = req.body;
    if (!['confirmar', 'rechazar'].includes(accion)) {
      return res.status(400).json({ error: 'Acción inválida (usa "confirmar" o "rechazar")' });
    }

    const row =
      accion === 'confirmar'
        ? await ncpStore.adminConfirm(id)
        : await ncpStore.adminReject(id);

    if (!row) return res.status(404).json({ error: 'Pago no encontrado' });

    console.log(`Admin ${accion === 'confirmar' ? 'confirmó' : 'rechazó'} el pago ${id} → ${row.estado}`);
    res.json({ id: row.id, estado: row.estado });
  } catch (err) {
    console.error('Error en admin confirmar:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─── PayPal: crear orden ─────────────────────────────────────────────────────

app.post('/api/paypal/create-order', async (req, res) => {
  if (!paypalEnabled) {
    return res.status(503).json({ error: 'PayPal no está configurado todavía' });
  }
  try {
    const { amount, description } = req.body;

    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }

    const token = await getPayPalToken();

    const orderRes = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            amount: {
              currency_code: 'USD',
              value: parseFloat(amount).toFixed(2),
            },
            description: description || 'Pago',
          },
        ],
      }),
    });

    if (!orderRes.ok) {
      const err = await orderRes.text();
      console.error('Error creando orden PayPal:', err);
      return res.status(500).json({ error: 'Error al crear orden de pago' });
    }

    const order = await orderRes.json();
    res.json({ id: order.id });
  } catch (err) {
    console.error('Error en create-order:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─── PayPal: capturar orden ──────────────────────────────────────────────────

app.post('/api/paypal/capture-order/:orderID', async (req, res) => {
  if (!paypalEnabled) {
    return res.status(503).json({ error: 'PayPal no está configurado todavía' });
  }
  try {
    const { orderID } = req.params;
    const token = await getPayPalToken();

    const captureRes = await fetch(
      `${PAYPAL_BASE}/v2/checkout/orders/${orderID}/capture`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!captureRes.ok) {
      const err = await captureRes.text();
      console.error('Error capturando orden PayPal:', err);
      return res.status(500).json({ error: 'Error al capturar el pago' });
    }

    const capture = await captureRes.json();
    const captureUnit = capture.purchase_units?.[0]?.payments?.captures?.[0];

    // Guardar en DB
    await guardarPago({
      tipo: 'paypal',
      monto: captureUnit?.amount?.value,
      moneda: captureUnit?.amount?.currency_code || 'USD',
      estado: capture.status,
      tx_id: captureUnit?.id || capture.id,
      concepto: capture.purchase_units?.[0]?.description || 'Pago',
    });

    res.json({
      transactionId: captureUnit?.id || capture.id,
      amount: captureUnit?.amount?.value,
      currency: captureUnit?.amount?.currency_code,
      status: capture.status,
    });
  } catch (err) {
    console.error('Error en capture-order:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─── PayPal NCP: crear orden de checkout ─────────────────────────────────────
// Los pay links se crean a mano en el dashboard de PayPal; aquí solo se elige
// el link adecuado y se genera el código de referencia (ver ncp.js).

app.post('/api/ncp/create-order', async (req, res) => {
  if (!ncpEnabled) {
    return res.status(503).json({ error: 'El pago con PayPal estará disponible próximamente' });
  }
  try {
    const { amount, description } = req.body;

    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }
    const monto = Math.round(parseFloat(amount) * 100) / 100;

    const checkout = await ncp.createNcpCheckout(
      { monto, moneda: 'USD', concepto: description || 'Pago' },
      {
        links: ncpLinks,
        isReferenceTaken: ncpStore.isReferenceTaken,
        saveOrder: ncpStore.saveOrder,
        ttlMinutes: NCP_TTL_MINUTES,
      }
    );

    res.json(checkout);
  } catch (err) {
    if (err.code === 'NO_NCP_LINK') {
      return res.status(400).json({ error: err.message });
    }
    console.error('Error en ncp/create-order:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─── PayPal NCP: estado de la orden (polling del frontend) ───────────────────

app.get('/api/ncp/status/:reference', async (req, res) => {
  try {
    const reference = ncp.extractReferenceCode(req.params.reference);
    if (!reference) {
      return res.status(400).json({ error: 'Código de referencia inválido' });
    }

    let order = await ncpStore.findOrderByReference(reference);
    if (!order) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    order = await ncpStore.expireIfDue(order);

    res.json({
      status: order.estado,
      referenceCode: reference,
      txId: order.tx_id || null,
      amount: order.monto != null ? parseFloat(order.monto) : null,
      currency: order.moneda,
      expiresAt: order.expira_en || null,
    });
  } catch (err) {
    console.error('Error en ncp/status:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─── PayPal: webhook (PAYMENT.CAPTURE.COMPLETED) ─────────────────────────────
// Verificación de firma OBLIGATORIA contra la API oficial de PayPal; nunca se
// procesa un payload sin verificar. Idempotente por transaction_id.

app.post('/api/paypal/webhook', async (req, res) => {
  if (!paypalEnabled || !PAYPAL_WEBHOOK_ID) {
    console.warn('Webhook PayPal recibido pero las credenciales/PAYPAL_WEBHOOK_ID no están configuradas');
    return res.status(503).json({ error: 'Webhook PayPal no configurado' });
  }
  try {
    const { verified, reason } = await ncp.verifyWebhookSignature({
      headers: req.headers,
      rawBody: req.rawBody,
      webhookId: PAYPAL_WEBHOOK_ID,
      getAccessToken: getPayPalToken,
      paypalBase: PAYPAL_BASE,
    });

    if (!verified) {
      console.warn('Webhook PayPal con firma inválida:', reason);
      return res.status(401).json({ error: 'Firma inválida' });
    }

    if (req.body.event_type !== 'PAYMENT.CAPTURE.COMPLETED') {
      return res.json({ received: true, ignored: req.body.event_type });
    }

    const result = await ncp.processPayment(ncp.normalizeCaptureEvent(req.body), ncpStore, {
      windowMinutes: NCP_WINDOW_MINUTES,
    });

    console.log(
      `Webhook PayPal procesado: ${result.action}` +
        (result.orderId ? ` (orden ${result.orderId})` : '') +
        (result.reason ? ` — ${result.reason}` : '')
    );
    res.json({ received: true, action: result.action });
  } catch (err) {
    console.error('Error en webhook PayPal:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─── Cripto: monto mínimo ────────────────────────────────────────────────────

app.get('/api/crypto/min-amount/:currency', async (req, res) => {
  try {
    const { currency } = req.params;

    const minRes = await fetch(
      `https://api.nowpayments.io/v1/min-amount?currency_from=usd&currency_to=${currency}&fiat_equivalent=usd`,
      { headers: { 'x-api-key': NOWPAYMENTS_API_KEY } }
    );

    if (!minRes.ok) {
      return res.status(500).json({ error: 'Error al obtener monto mínimo' });
    }

    const data = await minRes.json();
    res.json({ minAmount: data.min_amount });
  } catch (err) {
    console.error('Error en min-amount:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─── Cripto: crear pago ──────────────────────────────────────────────────────

app.post('/api/crypto/create-payment', async (req, res) => {
  try {
    const { amount, currency, description } = req.body;

    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }
    if (!currency) {
      return res.status(400).json({ error: 'Selecciona una criptomoneda' });
    }

    const paymentRes = await fetch('https://api.nowpayments.io/v1/payment', {
      method: 'POST',
      headers: {
        'x-api-key': NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        price_amount: parseFloat(amount),
        price_currency: 'usd',
        pay_currency: currency,
        order_description: description || 'Pago',
        ipn_callback_url: `${BASE_URL}/api/crypto/ipn`,
      }),
    });

    if (!paymentRes.ok) {
      const err = await paymentRes.json();
      console.error('Error creando pago cripto:', err);
      return res.status(500).json({ error: err.message || 'Error al crear el pago cripto' });
    }

    const payment = await paymentRes.json();

    // Guardar pago pendiente en DB
    await guardarPago({
      tipo: 'crypto',
      monto: parseFloat(amount),
      moneda: currency,
      estado: payment.payment_status,
      tx_id: String(payment.payment_id),
      concepto: description || 'Pago',
    });

    res.json({
      paymentId: payment.payment_id,
      payAddress: payment.pay_address,
      payAmount: payment.pay_amount,
      payCurrency: payment.pay_currency,
      status: payment.payment_status,
      expiresAt: payment.expiration_estimate_date,
    });
  } catch (err) {
    console.error('Error en create-payment:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─── Cripto: estado del pago ─────────────────────────────────────────────────

app.get('/api/crypto/status/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const statusRes = await fetch(
      `https://api.nowpayments.io/v1/payment/${id}`,
      { headers: { 'x-api-key': NOWPAYMENTS_API_KEY } }
    );

    if (!statusRes.ok) {
      return res.status(500).json({ error: 'Error al obtener estado del pago' });
    }

    const data = await statusRes.json();

    // Actualizar estado en DB si el pago finalizó
    if (data.payment_status === 'finished' && pool) {
      await pool.query(
        `UPDATE pagos SET estado = $1 WHERE tx_id = $2`,
        ['finished', String(id)]
      );
    }

    res.json({
      status: data.payment_status,
      paymentId: data.payment_id,
      payAmount: data.pay_amount,
      actuallyPaid: data.actually_paid,
      payCurrency: data.pay_currency,
      outcomeAmount: data.outcome_amount,
    });
  } catch (err) {
    console.error('Error en status:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─── Cripto: webhook IPN ─────────────────────────────────────────────────────

app.post('/api/crypto/ipn', async (req, res) => {
  try {
    const signature = req.headers['x-nowpayments-sig'];
    if (!signature) {
      console.warn('IPN recibido sin firma');
      return res.status(400).json({ error: 'Firma requerida' });
    }

    const sorted = JSON.stringify(
      Object.keys(req.body)
        .sort()
        .reduce((acc, key) => {
          acc[key] = req.body[key];
          return acc;
        }, {})
    );

    const expectedSig = crypto
      .createHmac('sha512', NOWPAYMENTS_IPN_SECRET)
      .update(sorted)
      .digest('hex');

    if (signature !== expectedSig) {
      console.warn('IPN firma inválida');
      return res.status(401).json({ error: 'Firma inválida' });
    }

    const { payment_id, payment_status, price_amount, price_currency } = req.body;
    console.log(`IPN verificado: pago ${payment_id} → ${payment_status} (${price_amount} ${price_currency})`);

    // Actualizar estado en DB
    if (pool) {
      await pool.query(
        `UPDATE pagos SET estado = $1 WHERE tx_id = $2`,
        [payment_status, String(payment_id)]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error en IPN:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─── Expiración periódica de órdenes NCP pendientes ──────────────────────────

if (ncpEnabled) {
  setInterval(async () => {
    try {
      const n = await ncpStore.expireOldOrders();
      if (n > 0) console.log(`⏱ ${n} orden(es) NCP expiradas`);
    } catch (err) {
      console.error('Error expirando órdenes NCP:', err.message);
    }
  }, 5 * 60 * 1000).unref();
}

// ─── Inicio ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en http://localhost:${PORT}`);
  console.log(`   Modo PayPal: ${PAYPAL_ENVIRONMENT} (${paypalEnabled ? 'credenciales OK' : 'deshabilitado'})`);
  console.log(`   PayPal NCP: ${ncpEnabled ? `${ncpLinks.filter((l) => l.activo).length} link(s) activo(s)` : 'inactivo — Próximamente'}`);
});
