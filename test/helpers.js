// Store en memoria con la misma interfaz que ncp-store.js (createPgStore),
// para probar la lógica de ncp.js sin base de datos.

function createMemoryStore(initialOrders = []) {
  let nextId = 1000;
  const orders = initialOrders.map((o) => ({ tx_id: null, nota: null, tipo: 'ncp', ...o }));
  const byId = (id) => orders.find((o) => o.id === id);

  return {
    orders,

    async isReferenceTaken(code) {
      return orders.some((o) => o.referencia === code);
    },

    async saveOrder({ monto, moneda, concepto, referencia, expiraEn }) {
      const id = nextId++;
      orders.push({
        id,
        tipo: 'ncp',
        monto,
        moneda,
        estado: 'waiting',
        concepto,
        referencia,
        expira_en: expiraEn,
        creado_en: new Date(),
        tx_id: null,
        nota: null,
      });
      return id;
    },

    async findOrderByReference(referencia) {
      return orders.find((o) => o.referencia === referencia) || null;
    },

    async isTransactionProcessed(txId) {
      return orders.some((o) => o.tx_id === txId);
    },

    async findWaitingOrders({ amount, currency, since }) {
      return orders.filter(
        (o) =>
          o.tipo === 'ncp' &&
          o.estado === 'waiting' &&
          Math.abs(parseFloat(o.monto) - amount) < 0.005 &&
          String(o.moneda).toUpperCase() === String(currency).toUpperCase() &&
          new Date(o.creado_en) >= since
      );
    },

    async markPaid(id, txId) {
      const o = byId(id);
      o.estado = 'finished';
      o.tx_id = txId;
    },

    async markPendingReview(id, txId, nota) {
      const o = byId(id);
      o.estado = 'pending_review';
      o.tx_id = txId;
      o.nota = nota || null;
    },

    async insertUnmatched({ txId, amount, currency, nota }) {
      const id = nextId++;
      orders.push({
        id,
        tipo: 'ncp',
        monto: amount,
        moneda: currency,
        estado: 'pending_review',
        tx_id: txId,
        concepto: 'Pago PayPal sin orden asociada',
        nota: nota || null,
        creado_en: new Date(),
      });
      return id;
    },
  };
}

module.exports = { createMemoryStore };
