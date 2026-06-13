# Pasarela de Pagos — PayPal + Cripto

Pasarela standalone para cobrar en USD vía tarjeta (PayPal) o criptomonedas (NOWPayments). Sin catálogo de productos: solo ingresas el monto, eliges el método y cobras.

---

## Requisitos

- Node.js v18 o superior
- Cuenta PayPal Business (o Sandbox para pruebas)
- Cuenta NOWPayments

---

## Instalación

```bash
npm install
cp .env.example .env
# edita .env con tus credenciales
npm start
```

Abre `http://localhost:3000` en tu navegador.

---

## Configurar PayPal

1. Ve a [developer.paypal.com](https://developer.paypal.com) e inicia sesión con tu cuenta Business.
2. En **Apps & Credentials**, haz clic en **Create App**.
3. Dale un nombre, selecciona tipo **Merchant** y crea la app.
4. Copia el **Client ID** y el **Secret** y pégalos en `.env`:
   ```
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   ```
5. Para pruebas usa `PAYPAL_MODE=sandbox`. Para producción usa `PAYPAL_MODE=live`.

### Probar en Sandbox

- PayPal crea dos cuentas de prueba automáticamente (Personal y Business) en la sección **Sandbox → Accounts**.
- Usa las tarjetas de prueba de PayPal: en el checkout ingresa el correo y contraseña de la cuenta Personal de sandbox, o usa las tarjetas de crédito de prueba que aparecen en **Sandbox → Test Accounts → [cuenta] → Funding**.
- Tarjeta de prueba rápida: `4111 1111 1111 1111`, cualquier fecha futura, cualquier CVV.

---

## Configurar NOWPayments

1. Crea una cuenta en [nowpayments.io](https://nowpayments.io).
2. Ve a **Settings** y configura tu **payout wallet** (por ejemplo tu dirección de Binance o cualquier wallet externa).
3. Genera una **API Key** en la sección API.
4. Genera un **IPN Secret** en la sección IPN (lo usas para verificar los webhooks).
5. Pega ambas en `.env`:
   ```
   NOWPAYMENTS_API_KEY=...
   NOWPAYMENTS_IPN_SECRET=...
   ```

### Sandbox de NOWPayments

NOWPayments ofrece un entorno de pruebas en `sandbox.nowpayments.io`. Para usarlo:
- Regístrate en [sandbox.nowpayments.io](https://sandbox.nowpayments.io) con las mismas credenciales.
- Cambia la URL base en `server.js` de `api.nowpayments.io` a `api.sandbox.nowpayments.io` mientras pruebas.
- Los pagos cripto en sandbox no mueven dinero real.

---

## Configurar el webhook (IPN) con ngrok

Para que NOWPayments pueda enviarte notificaciones en desarrollo necesitas exponer tu servidor local:

1. Instala [ngrok](https://ngrok.com) y autentícate.
2. En una terminal aparte ejecuta:
   ```bash
   ngrok http 3000
   ```
3. Copia la URL HTTPS que te da ngrok (ej: `https://abc123.ngrok.io`).
4. Actualiza tu `.env`:
   ```
   BASE_URL=https://abc123.ngrok.io
   ```
5. Reinicia el servidor. NOWPayments enviará los webhooks a `BASE_URL/api/crypto/ipn`.

---

## Producción

1. Despliega en [Railway](https://railway.app), [Render](https://render.com) o un VPS con HTTPS.
2. Configura las variables de entorno directamente en la plataforma (nunca subas el `.env` al repositorio).
3. Cambia:
   ```
   PAYPAL_MODE=live
   BASE_URL=https://tu-dominio.com
   ```
4. Asegúrate de que el dominio tenga HTTPS activo (PayPal lo requiere en producción).

---

## Estructura del proyecto

```
pasarela-pagos/
├── server.js          ← Backend (Express, todos los endpoints)
├── package.json
├── .env.example       ← Plantilla de variables de entorno
├── .gitignore
├── README.md
└── public/
    ├── index.html     ← Página única de cobro
    ├── styles.css     ← Diseño oscuro fintech
    └── app.js         ← Lógica frontend
```

---

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/config` | Client ID de PayPal + lista de criptos |
| POST | `/api/paypal/create-order` | Crear orden PayPal |
| POST | `/api/paypal/capture-order/:orderID` | Capturar pago PayPal |
| GET | `/api/crypto/min-amount/:currency` | Monto mínimo de la cripto |
| POST | `/api/crypto/create-payment` | Crear pago NOWPayments |
| GET | `/api/crypto/status/:id` | Estado del pago cripto |
| POST | `/api/crypto/ipn` | Webhook IPN de NOWPayments |
