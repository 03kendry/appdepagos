// ─── Persistencia NCP sobre la tabla `pagos` ─────────────────────────────────
// Implementa la interfaz de store que consumen createNcpCheckout y
// processPayment (ncp.js). La comparten server.js y reconcile.js.

const { NCP_STATES } = require('./ncp');

function createPgStore(pool) {
  return {
    async isReferenceTaken(code) {
      const r = await pool.query('SELECT 1 FROM pagos WHERE referencia = $1 LIMIT 1', [code]);
      return r.rowCount > 0;
    },

    async saveOrder({ monto, moneda, concepto, referencia, expiraEn }) {
      const r = await pool.query(
        `INSERT INTO pagos (tipo, monto, moneda, estado, concepto, referencia, expira_en)
         VALUES ('ncp', $1, $2, $3, $4, $5, $6) RETURNING id`,
        [monto, moneda, NCP_STATES.WAITING, concepto, referencia, expiraEn]
      );
      return r.rows[0].id;
    },

    async findOrderByReference(referencia) {
      const r = await pool.query('SELECT * FROM pagos WHERE referencia = $1 LIMIT 1', [referencia]);
      return r.rows[0] || null;
    },

    async isTransactionProcessed(txId) {
      const r = await pool.query('SELECT 1 FROM pagos WHERE tx_id = $1 LIMIT 1', [txId]);
      return r.rowCount > 0;
    },

    async findWaitingOrders({ amount, currency, since }) {
      const r = await pool.query(
        `SELECT * FROM pagos
         WHERE tipo = 'ncp' AND estado = $1
           AND ABS(monto - $2) < 0.005
           AND UPPER(moneda) = $3
           AND creado_en >= $4`,
        [NCP_STATES.WAITING, amount, String(currency).toUpperCase(), since]
      );
      return r.rows;
    },

    async markPaid(id, txId) {
      await pool.query(
        `UPDATE pagos SET estado = $2, tx_id = $3 WHERE id = $1`,
        [id, NCP_STATES.FINISHED, txId]
      );
    },

    async markPendingReview(id, txId, nota) {
      await pool.query(
        `UPDATE pagos SET estado = $2, tx_id = $3, nota = $4 WHERE id = $1`,
        [id, NCP_STATES.PENDING_REVIEW, txId, nota ? String(nota).slice(0, 300) : null]
      );
    },

    async insertUnmatched({ txId, amount, currency, nota }) {
      const r = await pool.query(
        `INSERT INTO pagos (tipo, monto, moneda, estado, tx_id, concepto, nota)
         VALUES ('ncp', $1, $2, $3, $4, 'Pago PayPal sin orden asociada', $5) RETURNING id`,
        [amount, currency, NCP_STATES.PENDING_REVIEW, txId, nota ? String(nota).slice(0, 300) : null]
      );
      return r.rows[0].id;
    },

    // Marca la orden como expirada si su fecha ya pasó (expiración on-read)
    async expireIfDue(order) {
      if (
        order.estado === NCP_STATES.WAITING &&
        order.expira_en &&
        new Date(order.expira_en) < new Date()
      ) {
        await pool.query(
          `UPDATE pagos SET estado = $2 WHERE id = $1 AND estado = $3`,
          [order.id, NCP_STATES.EXPIRED, NCP_STATES.WAITING]
        );
        return { ...order, estado: NCP_STATES.EXPIRED };
      }
      return order;
    },

    // Barrido general de pendientes vencidas (lo usan el server y reconcile.js)
    async expireOldOrders() {
      const r = await pool.query(
        `UPDATE pagos SET estado = $1
         WHERE tipo = 'ncp' AND estado = $2 AND expira_en IS NOT NULL AND expira_en < NOW()
         RETURNING id`,
        [NCP_STATES.EXPIRED, NCP_STATES.WAITING]
      );
      return r.rowCount;
    },
  };
}

module.exports = { createPgStore };
