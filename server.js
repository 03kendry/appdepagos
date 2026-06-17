require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_MODE,
  NOWPAYMENTS_API_KEY,
  NOWPAYMENTS_IPN_SECRET,
  DATABASE_URL,
  PORT = 3000,
  BASE_URL = 'http://localhost:3000',
} = process.env;

const PAYPAL_BASE =
  PAYPAL_MODE === 'live'
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
  console.log('✅ Tabla pagos lista');
}

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
      paypalClientId: PAYPAL_CLIENT_ID,
      currencies,
    });
  } catch (err) {
    console.error('Error en /api/config:', err.message);
    res.status(500).json({ error: 'Error al cargar configuración' });
  }
});

// ─── Ruta: historial de pagos ────────────────────────────────────────────────

app.get('/api/pagos', async (req, res) => {
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

// ─── PayPal: crear orden ─────────────────────────────────────────────────────

app.post('/api/paypal/create-order', async (req, res) => {
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

// ─── Inicio ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en http://localhost:${PORT}`);
  console.log(`   Modo PayPal: ${PAYPAL_MODE || 'sandbox'}`);
});
