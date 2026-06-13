require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_MODE,
  NOWPAYMENTS_API_KEY,
  NOWPAYMENTS_IPN_SECRET,
  PORT = 3000,
  BASE_URL = 'http://localhost:3000',
} = process.env;

const PAYPAL_BASE =
  PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

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
    // Obtener lista de criptos disponibles de NOWPayments
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
      const msg =
        err.message || 'Error al crear el pago cripto';
      return res.status(500).json({ error: msg });
    }

    const payment = await paymentRes.json();
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

app.post('/api/crypto/ipn', (req, res) => {
  try {
    const signature = req.headers['x-nowpayments-sig'];
    if (!signature) {
      console.warn('IPN recibido sin firma');
      return res.status(400).json({ error: 'Firma requerida' });
    }

    // Ordenar las llaves del body alfabéticamente y recalcular firma
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

    const { payment_id, payment_status, price_amount, price_currency } =
      req.body;
    console.log(
      `IPN verificado: pago ${payment_id} → ${payment_status} (${price_amount} ${price_currency})`
    );

    // Aquí puedes guardar en DB, enviar email, etc.
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
