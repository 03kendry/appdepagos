// ─── Reconciliación NCP contra la Transaction Search API de PayPal ───────────
// Fallback del webhook: consulta /v1/reporting/transactions y aplica el mismo
// matching e idempotencia que el webhook (ncp.js → processPayment).
//
// Uso:  npm run reconcile            (últimas 24 horas)
//       npm run reconcile -- --hours 48
//
// Requiere credenciales de PayPal (PASO FINAL — ver RUNBOOK_NCP.md) y que
// Transaction Search esté habilitado en la REST App. Hasta entonces este
// comando termina con un mensaje claro sin hacer nada.

require('dotenv').config();
const { Pool } = require('pg');
const ncp = require('./ncp');
const { createPgStore } = require('./ncp-store');

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENV,
  PAYPAL_MODE,
  DATABASE_URL,
  NCP_MATCH_WINDOW_MINUTES,
} = process.env;

const PAYPAL_BASE =
  (PAYPAL_ENV || PAYPAL_MODE) === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

function parseHoursArg() {
  const i = process.argv.indexOf('--hours');
  if (i === -1) return 24;
  const h = parseInt(process.argv[i + 1], 10);
  return h > 0 ? h : 24;
}

// Formato de fecha que exige Transaction Search (ISO 8601 con zona horaria)
function toPayPalDate(date) {
  return date.toISOString().slice(0, 19) + '-0000';
}

async function getPayPalToken() {
  const credentials = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal OAuth error: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function main() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    console.error('❌ Reconciliación PayPal: faltan PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.');
    console.error('   Este comando se activa en el PASO FINAL, cuando existan las credenciales.');
    console.error('   Procedimiento completo: RUNBOOK_NCP.md');
    process.exit(1);
  }
  if (!DATABASE_URL) {
    console.error('❌ Reconciliación PayPal: falta DATABASE_URL.');
    process.exit(1);
  }

  const hours = parseHoursArg();
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const store = createPgStore(pool);
  const windowMinutes =
    parseInt(NCP_MATCH_WINDOW_MINUTES, 10) > 0 ? parseInt(NCP_MATCH_WINDOW_MINUTES, 10) : 90;

  console.log(`🔎 Reconciliando transacciones PayPal de las últimas ${hours}h (${PAYPAL_BASE})…`);

  try {
    const token = await getPayPalToken();
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - hours * 60 * 60 * 1000);

    const counts = { paid: 0, pending_review: 0, duplicate: 0, ignored: 0 };
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const url =
        `${PAYPAL_BASE}/v1/reporting/transactions` +
        `?start_date=${encodeURIComponent(toPayPalDate(startDate))}` +
        `&end_date=${encodeURIComponent(toPayPalDate(endDate))}` +
        `&fields=all&page_size=100&page=${page}`;

      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const body = await res.text();
        if (res.status === 403) {
          throw new Error(
            'PayPal respondió 403: Transaction Search no está habilitado en la REST App (ver RUNBOOK_NCP.md).'
          );
        }
        throw new Error(`Transaction Search HTTP ${res.status}: ${body}`);
      }

      const data = await res.json();
      totalPages = data.total_pages || 1;

      for (const item of data.transaction_details || []) {
        const info = item.transaction_info || {};
        // Solo transacciones completadas ('S') y con monto a favor (ignora fees/reembolsos)
        if (info.transaction_status !== 'S') continue;
        const value = parseFloat((info.transaction_amount || {}).value);
        if (!(value > 0)) continue;

        const result = await ncp.processPayment(ncp.normalizeSearchTransaction(item), store, {
          windowMinutes,
        });
        counts[result.action] = (counts[result.action] || 0) + 1;

        if (result.action !== 'duplicate') {
          console.log(
            `   ${info.transaction_id}: ${result.action}` +
              (result.orderId ? ` (orden ${result.orderId})` : '') +
              (result.reason ? ` — ${result.reason}` : '')
          );
        }
      }
      page++;
    }

    const expired = await store.expireOldOrders();

    console.log('✅ Reconciliación completada:');
    console.log(`   Pagadas por código: ${counts.paid}`);
    console.log(`   En revisión manual: ${counts.pending_review}`);
    console.log(`   Ya procesadas (idempotencia): ${counts.duplicate}`);
    console.log(`   Órdenes pendientes expiradas: ${expired}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('❌ Error en la reconciliación:', err.message);
  process.exit(1);
});
