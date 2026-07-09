# SPEC — Pasarela de Pagos: Tarjetas (PayPal) + Cripto (NOWPayments)

> **Instrucción para Claude Code:** Lee este spec completo y construye el proyecto paso a paso. Al final, el servidor debe levantar sin errores y el usuario (Kendry) solo debe pegar sus credenciales en `.env` para que funcione.

## Objetivo
Pasarela de pagos standalone, **sin catálogo de productos**. Es una sola página de cobro donde el cliente:
1. Ingresa el **monto en USD** y opcionalmente un **concepto/descripción** del pago.
2. Elige el método: **💳 Tarjeta (vía PayPal)** o **🪙 Criptomonedas (vía NOWPayments)**.
3. Completa el pago y ve la confirmación en pantalla.

El dinero cae en el balance de PayPal de Kendry (pagos con tarjeta) o en su wallet cripto configurada en NOWPayments (pagos cripto).

## Stack
- **Backend:** Node.js v18+ con Express
- **Frontend:** HTML/CSS/JS vanilla servido por Express desde `/public` (sin frameworks)
- **Dependencias mínimas:** `express`, `dotenv` (usar `fetch` nativo de Node, NO axios)
- **PayPal:** Checkout vía REST API v2 (`/v2/checkout/orders`) + JS SDK en frontend
- **NOWPayments:** REST API v1 (`https://api.nowpayments.io/v1`)

## Estructura del proyecto
```
pasarela-pagos/
├── server.js
├── package.json
├── .env.example
├── .gitignore
├── README.md            (setup completo en español)
└── public/
    ├── index.html       (página única de cobro)
    ├── styles.css
    └── app.js
```

## Variables de entorno (`.env.example`)
```
# PayPal (developer.paypal.com → Apps & Credentials)
PAYPAL_CLIENT_ID=tu_client_id
PAYPAL_CLIENT_SECRET=tu_secret
PAYPAL_MODE=sandbox            # sandbox | live

# NOWPayments (nowpayments.io → panel)
NOWPAYMENTS_API_KEY=tu_api_key
NOWPAYMENTS_IPN_SECRET=tu_ipn_secret

# Servidor
PORT=3000
BASE_URL=http://localhost:3000
```
El código debe elegir la URL base de PayPal según `PAYPAL_MODE`:
- sandbox → `https://api-m.sandbox.paypal.com`
- live → `https://api-m.paypal.com`

## Flujo 1 — Pago con tarjeta (PayPal)
1. Cliente ingresa monto, elige "Tarjeta", clic en pagar.
2. Frontend usa el **PayPal JS SDK** (`https://www.paypal.com/sdk/js?client-id=...&currency=USD`) renderizando los botones, con soporte de **pago como invitado con tarjeta** (el cliente NO necesita cuenta PayPal: `enable-funding=card`).
3. `createOrder` llama al backend `POST /api/paypal/create-order` → backend obtiene token OAuth2 (`/v1/oauth2/token` con Basic auth Client ID:Secret) y crea la orden en `/v2/checkout/orders` con intent CAPTURE.
4. `onApprove` llama a `POST /api/paypal/capture-order/:orderID` → backend captura el pago.
5. Frontend muestra pantalla de confirmación con ID de transacción, monto y método.
6. El Client ID se pasa al frontend vía `GET /api/config` (NUNCA exponer el Secret al frontend).

## Flujo 2 — Pago con cripto (NOWPayments)
Criptos aceptadas: **USDT (priorizar TRC20 por fees bajos), BTC, ETH** + populares (BNB, SOL, LTC).
1. Cliente ingresa monto, elige "Cripto", selecciona la moneda.
2. Backend valida monto mínimo vía `GET /v1/min-amount` y crea el pago con `POST /v1/payment` (`price_currency: usd`, `pay_currency` elegida, `ipn_callback_url`).
3. Frontend muestra tarjeta de pago con: **dirección de depósito, monto exacto a enviar, QR generado en el navegador** (librería ligera por CDN o canvas), botones de copiar dirección y copiar monto.
4. Polling a `GET /api/crypto/status/:id` cada ~10s. Estados: waiting → confirming → confirmed → finished (manejar también partially_paid, failed, expired).
5. Webhook `POST /api/crypto/ipn`: **verificar firma obligatoriamente** — HMAC-SHA512 del body JSON con llaves ordenadas alfabéticamente usando `NOWPAYMENTS_IPN_SECRET`, comparado contra header `x-nowpayments-sig`.
6. Si expira o falla, permitir generar un nuevo pago sin recargar la página.

## Endpoints del backend
| Método | Ruta | Función |
|---|---|---|
| GET | `/api/config` | Client ID de PayPal + lista de criptos disponibles |
| POST | `/api/paypal/create-order` | Crear orden PayPal (body: amount, description) |
| POST | `/api/paypal/capture-order/:orderID` | Capturar pago PayPal |
| GET | `/api/crypto/min-amount/:currency` | Monto mínimo de la cripto |
| POST | `/api/crypto/create-payment` | Crear pago NOWPayments (body: amount, currency, description) |
| GET | `/api/crypto/status/:id` | Estado del pago cripto |
| POST | `/api/crypto/ipn` | Webhook NOWPayments con verificación de firma |

## Frontend — Diseño (gustos de Kendry)
- **Visualmente pulido y profesional**, nada genérico ni con pinta de template gratis.
- Tema oscuro tipo fintech con identidad propia (evitar el típico negro + verde ácido).
- Tipografías: Space Grotesk (títulos) + Inter (texto) + JetBrains Mono (montos, direcciones, IDs).
- Elemento distintivo: la tarjeta de pago cripto estilo **recibo/ticket** con la dirección, monto y QR.
- Selector de método de pago como dos tarjetas grandes (💳 Tarjeta / 🪙 Cripto) con transición suave.
- Indicador de estado en vivo con animación sutil para el flujo cripto.
- Pantalla de éxito clara: check animado, ID de transacción, monto, método.
- **Responsive** (se usará desde el celular) y todos los textos en **español**.

## Manejo de errores
- Validar monto > 0 y mínimos antes de crear pagos.
- Mensajes claros en español: credenciales inválidas, monto muy bajo, pago expirado, error de red.
- try/catch en todas las llamadas a APIs externas; loguear errores en el servidor sin exponer secretos.

## README debe incluir
1. **PayPal:** crear cuenta Business, entrar a developer.paypal.com → Apps & Credentials → Create App → copiar Client ID y Secret. Explicar Sandbox vs Live y cómo probar con las cuentas/tarjetas de prueba del sandbox.
2. **NOWPayments:** crear cuenta en nowpayments.io, configurar la wallet de payout (ej. dirección de Binance), generar API key e IPN secret. Mencionar el sandbox de NOWPayments para pruebas sin dinero real.
3. `npm install` y `npm start`.
4. Cómo exponer el webhook en desarrollo con ngrok y configurar `ipn_callback_url`.
5. Producción: desplegar en Railway/Render/VPS con HTTPS, cambiar `PAYPAL_MODE=live` y `BASE_URL`.

## Criterios de aceptación
- [ ] `npm start` levanta el servidor sin errores con un `.env` válido.
- [ ] Pago con tarjeta funciona end-to-end en PayPal Sandbox (invitado con tarjeta de prueba).
- [ ] Pago cripto genera dirección + QR y el estado se actualiza por polling.
- [ ] El webhook IPN rechaza peticiones con firma inválida.
- [ ] El Secret de PayPal y las llaves de NOWPayments nunca llegan al frontend.
- [ ] La página se ve bien en celular y en desktop.

---

## PayPal NCP (No-Code Checkout)

Tercer método de pago: pay links hosteados por PayPal. El servidor arranca y la
UI se ve completa **sin credenciales de PayPal** (el método aparece
"Próximamente"); todo lo que depende de credenciales se activa siguiendo
`RUNBOOK_NCP.md`.

### Limitaciones de NCP (dictan todo el diseño)

- **Los links se crean MANUALMENTE** en el dashboard de PayPal Business
  (`https://www.paypal.com/ncp/payment/<ID>`). **No hay API para crearlos**;
  el código nunca intenta generarlos.
- El checkout es **100% del lado de PayPal**: no acepta metadata ni `order_id`
  por query param (solo `locale.x` / `country.x`). No hay forma directa de
  correlacionar el pago con la orden local.
- **Sin monto dinámico real**: cada link tiene monto fijo, salvo que se
  configure como "el cliente ingresa el monto" (`tipo: "monto_abierto"`).
- La **confirmación es asíncrona**: llega por webhook
  (`PAYMENT.CAPTURE.COMPLETED`) o por reconciliación con la Transaction
  Search API — nunca de forma síncrona en el checkout.
- La correlación se resuelve con un **código de referencia** (`NXP-XXXXXX`)
  que el cliente pega en el campo personalizado "Código de referencia" del
  link **antes de pagar**. Si no lo hace, el pago cae a revisión manual.

### Configuración

- `PAYPAL_NCP_LINKS_CONFIG`: JSON inline o ruta a `.json` con los links:
  `{ id, nombre, monto, moneda, url, tipo: "fijo"|"monto_abierto", activo }`.
  Si falta, el módulo NCP queda inactivo sin romper nada.
- `PAYPAL_WEBHOOK_ID`: obligatorio para procesar webhooks (la verificación de
  firma con la API oficial es innegociable; sin él, el endpoint rechaza todo).
- `NCP_ORDER_TTL_MINUTES` (default 60): expiración de órdenes pendientes.
- `NCP_MATCH_WINDOW_MINUTES` (default 90): ventana del matching heurístico.

### Estados de una orden NCP (columna `estado` de `pagos`, tipo `ncp`)

| Estado | Significado |
|---|---|
| `waiting` | Orden creada, esperando confirmación de PayPal |
| `pending_review` | Pago recibido pero sin match automático confiable → revisión manual |
| `finished` | Pago confirmado (código de referencia + monto + moneda coinciden) |
| `expired` | La orden superó su TTL sin confirmación |

Reglas de matching (webhook y reconciliación comparten lógica e idempotencia
por `transaction_id`):
1. Payload con código `NXP-XXXXXX` válido + monto y moneda correctos → `finished`.
2. Código válido pero monto/moneda distintos, u orden expirada → `pending_review`.
3. Sin código: heurística monto + moneda + ventana de tiempo con **exactamente
   una** candidata → `pending_review`. **Nunca se marca pagada sin código.**
4. Sin match: se inserta una fila `pending_review` con el pago huérfano.

### Endpoints nuevos

| Método | Ruta | Función |
|---|---|---|
| POST | `/api/ncp/create-order` | Selecciona link, genera código de referencia, crea orden `waiting` |
| GET | `/api/ncp/status/:reference` | Estado de la orden (polling del frontend; expira on-read) |
| POST | `/api/paypal/webhook` | `PAYMENT.CAPTURE.COMPLETED` con verificación de firma obligatoria |

Reconciliación fallback: `npm run reconcile [-- --hours N]` consulta
`/v1/reporting/transactions` (Transaction Search) con el mismo matching.

### Diagrama de secuencia del flujo completo

```
Cliente          Frontend                Backend               PayPal
  │                 │                       │                     │
  │ monto+concepto  │                       │                     │
  │ elige "PayPal"  │                       │                     │
  │────────────────►│                       │                     │
  │                 │ POST /api/ncp/create-order                  │
  │                 │──────────────────────►│                     │
  │                 │                       │ selecciona link     │
  │                 │                       │ (fijo exacto →      │
  │                 │                       │  monto_abierto)     │
  │                 │                       │ genera NXP-XXXXXX   │
  │                 │                       │ INSERT orden waiting│
  │                 │ {url, referenceCode,  │                     │
  │                 │  instructions}        │                     │
  │                 │◄──────────────────────│                     │
  │  pantalla NCP:  │                       │                     │
  │  código GRANDE + copiar                 │                     │
  │  pasos 1-2-3 + advertencia monto exacto │                     │
  │◄────────────────│                       │                     │
  │ 1. copia código │                       │                     │
  │ 2. "Pagar en PayPal" (pestaña nueva)    │                     │
  │────────────────────────────────────────────────────────────► │
  │ 3. pega código en "Código de referencia" y paga               │
  │                 │ polling GET /api/ncp/status/:ref cada 10s   │
  │                 │──────────────────────►│                     │
  │                 │   {status: waiting}   │                     │
  │                 │                       │  webhook PAYMENT.   │
  │                 │                       │  CAPTURE.COMPLETED  │
  │                 │                       │◄────────────────────│
  │                 │                       │ verifica FIRMA      │
  │                 │                       │ (API oficial)       │
  │                 │                       │ matching por código │
  │                 │                       │ → estado finished   │
  │                 │ {status: finished}    │                     │
  │                 │◄──────────────────────│                     │
  │ pantalla de éxito (check animado, tx, monto, método)          │
  │◄────────────────│                       │                     │
  │                 │                       │                     │
  │  [fallback]     │                       │  npm run reconcile  │
  │                 │                       │  Transaction Search │
  │                 │                       │─────────────────────►
  │                 │                       │  mismo matching     │
  │  [sin código]   │                       │  → pending_review   │
  │  [TTL vencido]  │                       │  → expired          │
```

### Criterios de aceptación NCP

- [ ] El servidor arranca sin ninguna variable de PayPal (warning + método "Próximamente").
- [ ] Con `PAYPAL_NCP_LINKS_CONFIG` válida, el flujo UI completo funciona hasta "Esperando confirmación".
- [ ] El webhook rechaza payloads sin firma verificada (nunca procesa sin verificar).
- [ ] Un pago sin código de referencia jamás se marca pagado automáticamente.
- [ ] El mismo `transaction_id` nunca se procesa dos veces (webhook y reconciliación).
- [ ] `npm test` pasa sin base de datos ni credenciales.
