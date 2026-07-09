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
3. **Sobre el código de referencia:** el constructor de NCP **ya no permite
   agregar campos personalizados** (solo envío, impuestos y handling fee), así
   que el código `NXP-XXXXXX` **no viaja dentro del pago**. Por eso el flujo es
   **manual-first**: el pago entra como **revisión manual** y el operador lo
   confirma en `/admin.html` cruzando monto + fecha con el pago real en PayPal
   (el código es el comprobante que muestra el cliente). *Opcionalmente*, si el
   checkout le ofrece al comprador una **"nota para el vendedor"**, se le puede
   pedir que pegue ahí su código: en ese caso `npm run reconcile` lo detecta
   (lee `transaction_note`) y confirma el pago solo. No es obligatorio ni
   confiable como único camino.
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
   verificar pantalla con código `NXP-XXXXXX`, los 3 pasos y botón
   "Pagar en PayPal".
2. **Pago sandbox:** abrir el link con una cuenta personal sandbox y pagar.
3. **Webhook verificado:** en los logs del servidor debe aparecer
   `Webhook PayPal procesado: pending_review` (sin un campo que lleve el código,
   el pago cae a revisión manual, no a `paid`). Un payload manipulado o sin
   firma debe responder 401.
4. **Revisión manual (camino por defecto):** en `/admin.html` el pago aparece
   como **"Revisión manual"**. Cruzar monto + fecha con la orden y pulsar
   **✓ Confirmar** → pasa a "Completado". La UI del cliente pasa sola de
   "Esperando confirmación del pago…" a la pantalla de éxito (polling cada 10s).
5. **Rechazo:** en un pago que no corresponda, pulsar **✕ Rechazar** en
   `/admin.html` → pasa a "Expirado" y no cuenta como recaudado.
6. **Idempotencia:** desde el dashboard de developer.paypal.com → Webhooks →
   reenviar (resend) el mismo evento. El log debe decir `duplicate` y la orden
   no debe cambiar.
7. **Reconciliación:** `npm run reconcile -- --hours 1` debe reportar la
   transacción como ya procesada (`duplicate`). Si el comprador **sí** pegó el
   código en la nota para el vendedor, un pago cuyo webhook se perdió se
   confirma solo (`paid`) por este comando.

## Paso 6 — Pasar a producción

1. Repetir pasos 1-4 con la App **Live** y links del dashboard real.
2. `.env`: `PAYPAL_ENV=live`, credenciales live, webhook live, links live.
3. Repetir el smoke test con un pago real pequeño.

## Operación diaria

- **Confirmar los `pending_review` en `/admin.html`** es la tarea diaria
  principal del flujo NCP: cada fila muestra el código de referencia (columna
  **Ref.**) y, al pasar el cursor sobre el estado, la **nota** que explica por
  qué cayó ahí (sin código, monto distinto, orden expirada…). Cruzar con el
  pago real en PayPal y pulsar **✓ Confirmar** o **✕ Rechazar**.
- `npm run reconcile` (últimas 24h) como cron diario o manual: atrapa pagos
  cuyo webhook se perdió, confirma solo los que traen el código en la nota, y
  expira órdenes pendientes viejas.
- Las órdenes `waiting` expiran solas a los `NCP_ORDER_TTL_MINUTES` (60 por
  defecto).
