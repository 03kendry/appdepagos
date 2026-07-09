/* ─────────────────────────────────────────────
   Pasarela de Pagos — app.js
   ───────────────────────────────────────────── */

let state = {
  method: 'card',           // 'card' | 'ncp' | 'crypto'
  config: null,             // { paypalClientId, paypalEnabled, ncpEnabled, currencies }
  pollInterval: null,       // setInterval para estado cripto
  ncpPollInterval: null,    // setInterval para estado NCP
  currentPayment: null,     // { paymentId, payAddress, payAmount, payCurrency }
  currentNcpOrder: null,    // { referenceCode, url, amount, currency, linkType }
};

// ── Elementos del DOM ──────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const mainView       = $('main-view');
const cryptoView     = $('crypto-view');
const successView    = $('success-view');

const amountInput    = $('amount');
const descInput      = $('description');
const formError      = $('form-error');

const methodCard     = $('method-card');
const methodNcp      = $('method-ncp');
const methodCrypto   = $('method-crypto');
const cryptoField    = $('crypto-field');
const cryptoSelect   = $('crypto-select');

const paypalContainer = $('paypal-buttons-container');
const btnCryptoPay   = $('btn-crypto-pay');
const btnNcpPay      = $('btn-ncp-pay');

const ncpView        = $('ncp-view');
const refCodeEl      = $('ref-code');
const ncpAmountEl    = $('ncp-amount');
const ncpOpenWarning = $('ncp-open-amount-warning');
const btnOpenPaypal  = $('btn-open-paypal');
const ncpStatusDot   = $('ncp-status-dot');
const ncpStatusText  = $('ncp-status-text');
const ncpReviewMsg   = $('ncp-review-msg');
const ncpExpiredMsg  = $('ncp-expired-msg');
const btnNcpRetry    = $('btn-ncp-retry');

const tCurrency      = $('t-currency');
const tAmount        = $('t-amount');
const tAddress       = $('t-address');
const statusBar      = $('status-bar');
const statusDot      = $('status-dot');
const statusText     = $('status-text');
const btnRetry       = $('btn-retry');

const receipt        = $('receipt');
const btnNewPayment  = $('btn-new-payment');

// ── Utilidades ─────────────────────────────────────────────────────────────

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function showError(msg) {
  formError.textContent = msg;
  show(formError);
}

function clearError() {
  hide(formError);
  formError.textContent = '';
}

function formatCurrency(code) {
  const map = {
    usdttrc20: 'USDT (TRC20)',
    usdterc20: 'USDT (ERC20)',
    btc: 'Bitcoin (BTC)',
    eth: 'Ethereum (ETH)',
    bnbbsc: 'BNB (BSC)',
    sol: 'Solana (SOL)',
    ltc: 'Litecoin (LTC)',
  };
  return map[code] || code.toUpperCase();
}

function getAmount() {
  const val = parseFloat(amountInput.value);
  return isNaN(val) ? 0 : val;
}

function validateAmount() {
  const amt = getAmount();
  if (amt <= 0) {
    showError('Ingresa un monto válido mayor a cero.');
    return false;
  }
  return true;
}

// ── Cargar config (PayPal client ID + criptos) ──────────────────────────────

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('No se pudo cargar la configuración');
    state.config = await res.json();
    populateCryptoSelect(state.config.currencies);
    applyMethodAvailability();
    if (state.config.paypalEnabled) loadPayPalSDK(state.config.paypalClientId);
  } catch (err) {
    showError('Error al cargar la configuración. Recarga la página.');
    console.error(err);
  }
}

// ── Disponibilidad de métodos ("Próximamente" si falta configuración) ────────

function setMethodDisabled(el, disabled) {
  el.classList.toggle('disabled', disabled);
  const sub = el.querySelector('.method-sub');
  sub.textContent = disabled ? 'Próximamente' : sub.dataset.defaultSub;
}

function isMethodEnabled(method) {
  if (!state.config) return true; // antes de cargar config, optimista; se corrige al cargar
  if (method === 'card') return state.config.paypalEnabled;
  if (method === 'ncp') return state.config.ncpEnabled;
  return true;
}

function firstEnabledMethod() {
  return ['card', 'ncp', 'crypto'].find(isMethodEnabled) || 'crypto';
}

function applyMethodAvailability() {
  setMethodDisabled(methodCard, !isMethodEnabled('card'));
  setMethodDisabled(methodNcp, !isMethodEnabled('ncp'));
  if (!isMethodEnabled(state.method)) {
    setMethod(firstEnabledMethod());
  }
}

function populateCryptoSelect(currencies) {
  cryptoSelect.innerHTML = '';
  if (!currencies || currencies.length === 0) {
    cryptoSelect.innerHTML = '<option value="">No hay criptos disponibles</option>';
    return;
  }
  currencies.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = formatCurrency(c);
    cryptoSelect.appendChild(opt);
  });
}

// ── PayPal SDK ─────────────────────────────────────────────────────────────

function loadPayPalSDK(clientId) {
  if (!clientId || clientId === 'tu_client_id') return;

  const script = document.createElement('script');
  script.src = `https://www.paypal.com/sdk/js?client-id=${clientId}&currency=USD&enable-funding=card&disable-funding=credit`;
  script.onload = () => {
    if (state.method === 'card') renderPayPalButtons();
  };
  script.onerror = () => {
    console.error('No se pudo cargar el SDK de PayPal');
  };
  document.head.appendChild(script);
}

function renderPayPalButtons() {
  paypalContainer.innerHTML = '';

  if (!window.paypal) return;

  window.paypal.Buttons({
    style: {
      layout: 'vertical',
      color: 'black',
      shape: 'rect',
      label: 'pay',
      height: 48,
    },
    createOrder: async () => {
      clearError();
      if (!validateAmount()) throw new Error('Monto inválido');

      const res = await fetch('/api/paypal/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: getAmount().toFixed(2),
          description: descInput.value.trim() || 'Pago',
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        showError(err.error || 'Error al iniciar el pago');
        throw new Error(err.error);
      }

      const data = await res.json();
      return data.id;
    },
    onApprove: async (data) => {
      const res = await fetch(`/api/paypal/capture-order/${data.orderID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        const err = await res.json();
        showError(err.error || 'Error al confirmar el pago');
        return;
      }

      const capture = await res.json();
      showSuccess({
        id: capture.transactionId,
        amount: `$${parseFloat(capture.amount).toFixed(2)} USD`,
        method: 'Tarjeta vía PayPal',
        concepto: descInput.value.trim() || '—',
      });
    },
    onError: (err) => {
      console.error('PayPal error:', err);
      showError('Ocurrió un error con PayPal. Intenta de nuevo.');
    },
    onCancel: () => {
      clearError();
    },
  }).render('#paypal-buttons-container');
}

// ── Selector de método ─────────────────────────────────────────────────────

function updateAmountField() {
  const prefix = document.querySelector('.input-prefix');
  if (state.method === 'crypto') {
    const selected = cryptoSelect.value;
    const label = selected ? formatCurrency(selected) : 'cripto';
    amountInput.placeholder = `USD → ${label}`;
  } else {
    amountInput.placeholder = '0.00';
  }
}

function setMethod(method) {
  if (!isMethodEnabled(method)) return;
  state.method = method;

  methodCard.classList.toggle('active', method === 'card');
  methodNcp.classList.toggle('active', method === 'ncp');
  methodCrypto.classList.toggle('active', method === 'crypto');

  hide(cryptoField);
  hide(btnCryptoPay);
  hide(btnNcpPay);
  paypalContainer.innerHTML = '';
  hide(paypalContainer);

  if (method === 'card') {
    show(paypalContainer);
    if (window.paypal) renderPayPalButtons();
  } else if (method === 'ncp') {
    show(btnNcpPay);
  } else {
    show(cryptoField);
    show(btnCryptoPay);
  }
  updateAmountField();
  clearError();
}

methodCard.addEventListener('click', () => setMethod('card'));
methodNcp.addEventListener('click', () => setMethod('ncp'));
methodCrypto.addEventListener('click', () => setMethod('crypto'));
cryptoSelect.addEventListener('change', updateAmountField);

// ── Flujo cripto ───────────────────────────────────────────────────────────

btnCryptoPay.addEventListener('click', async () => {
  clearError();
  if (!validateAmount()) return;

  const currency = cryptoSelect.value;
  if (!currency) {
    showError('Selecciona una criptomoneda');
    return;
  }

  btnCryptoPay.disabled = true;
  btnCryptoPay.textContent = 'Creando pago…';

  try {
    // Verificar monto mínimo
    const minRes = await fetch(`/api/crypto/min-amount/${currency}`);
    if (minRes.ok) {
      const { minAmount } = await minRes.json();
      if (minAmount && getAmount() < minAmount) {
        showError(`El monto mínimo para ${formatCurrency(currency)} es $${minAmount} USD`);
        return;
      }
    }

    const res = await fetch('/api/crypto/create-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: getAmount().toFixed(2),
        currency,
        description: descInput.value.trim() || 'Pago',
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      showError(err.error || 'Error al crear el pago');
      return;
    }

    const payment = await res.json();
    state.currentPayment = payment;

    showCryptoTicket(payment);
    startPolling(payment.paymentId);
  } catch (err) {
    showError('Error de red. Intenta de nuevo.');
    console.error(err);
  } finally {
    btnCryptoPay.disabled = false;
    btnCryptoPay.textContent = 'Continuar con Cripto →';
  }
});

function showCryptoTicket(payment) {
  hide(mainView);
  show(cryptoView);
  hide(btnRetry);

  tCurrency.textContent = formatCurrency(payment.payCurrency);
  tAmount.textContent = `${payment.payAmount} ${payment.payCurrency.toUpperCase()}`;
  tAddress.textContent = payment.payAddress;

  // Generar QR
  const qrContainer = $('qr-canvas');
  qrContainer.innerHTML = '';
  try {
    new QRCode(qrContainer, {
      text: payment.payAddress,
      width: 160,
      height: 160,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch (e) {
    console.warn('QR no disponible:', e);
  }

  // Copiar dirección
  $('copy-address').addEventListener('click', () => copyText(payment.payAddress, 'copy-address', 'Dirección copiada'));
  // Copiar monto
  $('copy-amount').addEventListener('click', () => copyText(String(payment.payAmount), 'copy-amount', 'Monto copiado'));

  setStatus('waiting');
}

function copyText(text, btnId, label) {
  navigator.clipboard.writeText(text).then(() => {
    const btn = $(btnId);
    const prev = btn.innerHTML;
    btn.classList.add('copied');
    btn.textContent = '✓ ' + label;
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = prev;
    }, 2000);
  });
}

// ── Polling de estado cripto ───────────────────────────────────────────────

const STATUS_LABELS = {
  waiting:       'Esperando pago…',
  confirming:    'Confirmando transacción…',
  confirmed:     'Confirmado, procesando…',
  sending:       'Enviando fondos…',
  partially_paid:'Pago parcial recibido',
  finished:      '¡Pago completado!',
  failed:        'El pago falló',
  refunded:      'Pago reembolsado',
  expired:       'Pago expirado',
};

function setStatus(status) {
  const dot = statusDot;
  dot.className = 'status-dot';

  if (['waiting', 'partially_paid'].includes(status)) {
    dot.classList.add('waiting');
  } else if (['confirming', 'confirmed', 'sending'].includes(status)) {
    dot.classList.add('confirming');
  } else if (status === 'finished') {
    dot.classList.add('finished');
  } else {
    dot.classList.add('failed');
  }

  statusText.textContent = STATUS_LABELS[status] || status;
}

function startPolling(paymentId) {
  stopPolling();

  state.pollInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/crypto/status/${paymentId}`);
      if (!res.ok) return;

      const data = await res.json();
      setStatus(data.status);

      if (data.status === 'finished') {
        stopPolling();
        setTimeout(() => {
          showSuccess({
            id: String(paymentId),
            amount: `${data.payAmount} ${(data.payCurrency || '').toUpperCase()}`,
            method: `Cripto — ${formatCurrency(data.payCurrency || '')}`,
            concepto: descInput.value.trim() || '—',
          });
        }, 1500);
      }

      if (['failed', 'expired', 'refunded'].includes(data.status)) {
        stopPolling();
        show(btnRetry);
      }
    } catch (err) {
      console.error('Error en polling:', err);
    }
  }, 10000);
}

function stopPolling() {
  if (state.pollInterval) {
    clearInterval(state.pollInterval);
    state.pollInterval = null;
  }
}

btnRetry.addEventListener('click', () => {
  hide(cryptoView);
  show(mainView);
  stopPolling();
  clearError();
});

// ── Flujo PayPal NCP ───────────────────────────────────────────────────────

btnNcpPay.addEventListener('click', async () => {
  clearError();
  if (!validateAmount()) return;

  btnNcpPay.disabled = true;
  btnNcpPay.textContent = 'Creando orden…';

  try {
    const res = await fetch('/api/ncp/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: getAmount().toFixed(2),
        description: descInput.value.trim() || 'Pago',
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      showError(err.error || 'Error al crear la orden');
      return;
    }

    const order = await res.json();
    state.currentNcpOrder = order;

    showNcpView(order);
    startNcpPolling(order.referenceCode);
  } catch (err) {
    showError('Error de red. Intenta de nuevo.');
    console.error(err);
  } finally {
    btnNcpPay.disabled = false;
    btnNcpPay.textContent = 'Continuar con PayPal →';
  }
});

function showNcpView(order) {
  hide(mainView);
  show(ncpView);
  hide(btnNcpRetry);
  hide(ncpReviewMsg);
  hide(ncpExpiredMsg);

  refCodeEl.textContent = order.referenceCode;
  ncpAmountEl.textContent = `$${order.amount.toFixed(2)} ${order.currency}`;
  btnOpenPaypal.href = order.url;

  if (order.openAmountWarning) {
    ncpOpenWarning.textContent = `⚠ ${order.openAmountWarning}`;
    show(ncpOpenWarning);
  } else {
    hide(ncpOpenWarning);
  }

  setNcpStatus('waiting');
}

$('copy-ref').addEventListener('click', () => {
  if (!state.currentNcpOrder) return;
  copyText(state.currentNcpOrder.referenceCode, 'copy-ref', 'Código copiado');
});

const NCP_STATUS_LABELS = {
  waiting:        'Esperando confirmación del pago…',
  pending_review: 'Pago recibido — en revisión manual',
  finished:       '¡Pago confirmado!',
  expired:        'La orden expiró',
};

function setNcpStatus(status) {
  ncpStatusDot.className = 'status-dot';
  if (status === 'waiting') {
    ncpStatusDot.classList.add('waiting');
  } else if (status === 'pending_review') {
    ncpStatusDot.classList.add('confirming');
  } else if (status === 'finished') {
    ncpStatusDot.classList.add('finished');
  } else {
    ncpStatusDot.classList.add('failed');
  }
  ncpStatusText.textContent = NCP_STATUS_LABELS[status] || status;
}

function startNcpPolling(referenceCode) {
  stopNcpPolling();

  state.ncpPollInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/ncp/status/${referenceCode}`);
      if (!res.ok) return;

      const data = await res.json();
      setNcpStatus(data.status);

      if (data.status === 'pending_review') {
        show(ncpReviewMsg);
      }

      if (data.status === 'finished') {
        stopNcpPolling();
        setTimeout(() => {
          showSuccess({
            id: data.txId || referenceCode,
            amount: `$${parseFloat(data.amount).toFixed(2)} ${data.currency}`,
            method: 'PayPal — Link de pago',
            concepto: descInput.value.trim() || '—',
          });
        }, 1200);
      }

      if (data.status === 'expired') {
        stopNcpPolling();
        show(ncpExpiredMsg);
        show(btnNcpRetry);
      }
    } catch (err) {
      console.error('Error en polling NCP:', err);
    }
  }, 10000);
}

function stopNcpPolling() {
  if (state.ncpPollInterval) {
    clearInterval(state.ncpPollInterval);
    state.ncpPollInterval = null;
  }
}

btnNcpRetry.addEventListener('click', () => {
  hide(ncpView);
  show(mainView);
  stopNcpPolling();
  clearError();
});

// ── Pantalla de éxito ──────────────────────────────────────────────────────

function showSuccess({ id, amount, method, concepto }) {
  stopPolling();
  stopNcpPolling();
  hide(mainView);
  hide(cryptoView);
  hide(ncpView);
  show(successView);

  receipt.innerHTML = `
    <div class="receipt-row">
      <span class="label">ID de transacción</span>
      <span class="value">${id}</span>
    </div>
    <div class="receipt-row">
      <span class="label">Monto</span>
      <span class="value">${amount}</span>
    </div>
    <div class="receipt-row">
      <span class="label">Método</span>
      <span class="value">${method}</span>
    </div>
    <div class="receipt-row">
      <span class="label">Concepto</span>
      <span class="value">${concepto}</span>
    </div>
  `;
}

btnNewPayment.addEventListener('click', () => {
  hide(successView);
  hide(cryptoView);
  hide(ncpView);
  stopNcpPolling();
  amountInput.value = '';
  descInput.value = '';
  clearError();
  setMethod(firstEnabledMethod());
  show(mainView);
});

// ── Init ───────────────────────────────────────────────────────────────────

loadConfig();
setMethod('card');
