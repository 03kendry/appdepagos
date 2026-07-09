# RUNBOOK — Activar PayPal NCP el día que existan las credenciales

> **Estado actual:** la cuenta PayPal Business del socio **aún no existe**.
> Todo el código NCP está desarrollado y probado con mocks; este documento es
> el procedimiento exacto para activarlo. No inventes ni reutilices
> credenciales de otra cuenta.

## Requisitos previos

- La cuenta **PayPal Business** del dueño creada y verificada.
- Acceso del dueño a [developer.paypal.com](https://developer.paypal.com) con **su** login.
- El servidor desplegado con HTTPS público (los webhooks de PayPal no llegan a `localhost`; en desarrollo usa ngrok).

## Paso 1 — Crear la REST App (la hace el dueño, bajo SU login)

1. developer.paypal.com → **Apps & Credentials**.
2. Crear una App en **Sandbox** y otra en **Live** (se activan por separado).
3. El dueño entrega el **Client ID** y el **Secret** de cada entorno.
4. Pegar en `.env`:
   ```
   PAYPAL_CLIENT_ID=<client id>
   PAYPAL_CLIENT_SECRET=<secret>
   PAYPAL_ENV=sandbox        # cambiar a live al pasar a producción
   ```

## Paso 2 — Registrar el webhook

1. En la misma App → **Webhooks** → Add Webhook.
2. URL: `https://<tu-dominio>/api/paypal/webhook`
3. Evento a suscribir: **`PAYMENT.CAPTURE.COMPLETED`** (con eso basta).
4. Guardar el **Webhook ID** que muestra PayPal:
   ```
   PAYPAL_WEBHOOK_ID=<webhook id>
   ```
   Sin esta variable el endpoint rechaza todos los eventos: la verificación de
   firma contra la API oficial es obligatoria y usa ese ID.

## Paso 3 — Habilitar Transaction Search

1. En la App → **Features** → marcar **Transaction Search**.
2. Esto activa `/v1/reporting/transactions`, que usa `npm run reconcile`
   (fallback si un webhook se pierde). Sin esto, reconcile devuelve 403.
3. Ojo: PayPal puede tardar unas horas en empezar a indexar transacciones
   nuevas tras habilitarlo.

## Paso 4 — Crear los pay links NCP (manual, en el dashboard Business)

1. El dueño entra a su dashboard Business → **Pay Links / No-Code Checkout**.
2. Crea un link por cada monto frecuente (`tipo: "fijo"`) y opcionalmente uno
   donde el cliente ingresa el monto (`tipo: "monto_abierto"`).
3. **CRÍTICO:** en cada link, agregar un campo personalizado llamado
   exactamente **"Código de referencia"**. Sin ese campo el matching
   automático no funciona y todos los pagos caerán a revisión manual.
4. El dueño comparte las URLs (`https://www.paypal.com/ncp/payment/<ID>`).
5. Configurar en `.env` (JSON inline o ruta a un archivo .json):
   ```
   PAYPAL_NCP_LINKS_CONFIG=[{"id":"pl-10","nombre":"Pago 10 USD","monto":10,"moneda":"USD","url":"https://www.paypal.com/ncp/payment/XXXXXXXX","tipo":"fijo","activo":true},{"id":"pl-abierto","nombre":"Monto abierto","moneda":"USD","url":"https://www.paypal.com/ncp/payment/YYYYYYYY","tipo":"monto_abierto","activo":true}]
   ```
6. Reiniciar el servidor. El log debe decir `PayPal NCP: N link(s) activo(s)`
   y la opción PayPal deja de mostrar "Próximamente".

## Paso 5 — Smoke test (sandbox, antes de tocar live)

Ejecutar en orden; todos deben pasar:

1. **Orden:** en la UI, monto que exista como link fijo → elegir PayPal →
   verificar pantalla con código `NXP-XXXXXX`, pasos 1-2-3 y botón
   "Pagar en PayPal".
2. **Pago sandbox:** abrir el link con una cuenta personal sandbox, pegar el
   código en "Código de referencia" y pagar.
3. **Webhook verificado:** en los logs del servidor debe aparecer
   `Webhook PayPal procesado: paid (orden N)`. Un payload manipulado o sin
   firma debe responder 401.
4. **Orden pagada:** la UI pasa sola de "Esperando confirmación del pago…" a
   la pantalla de éxito (polling cada 10s). En `/admin.html` la orden aparece
   `finished` con el `transaction_id`.
5. **Idempotencia:** desde el dashboard de developer.paypal.com → Webhooks →
   reenviar (resend) el mismo evento. El log debe decir `duplicate` y la orden
   no debe cambiar.
6. **Reconciliación:** `npm run reconcile -- --hours 1` debe reportar la
   transacción como ya procesada (`duplicate`) y no duplicar nada.
7. **Sin código:** repetir un pago sandbox SIN pegar el código → la orden debe
   quedar `pending_review` (nunca `finished`) y visible en `/admin.html`.

## Paso 6 — Pasar a producción

1. Repetir pasos 1-4 con la App **Live** y links del dashboard real.
2. `.env`: `PAYPAL_ENV=live`, credenciales live, webhook live, links live.
3. Repetir el smoke test con un pago real pequeño.

## Operación diaria

- `npm run reconcile` (últimas 24h) como cron diario o manual: atrapa pagos
  cuyo webhook se perdió y expira órdenes pendientes viejas.
- Revisar `pending_review` en `/admin.html`: la columna `nota` explica por qué
  cada pago cayó ahí (sin código, monto distinto, orden expirada, etc.).
- Las órdenes `waiting` expiran solas a los `NCP_ORDER_TTL_MINUTES` (60 por
  defecto).
