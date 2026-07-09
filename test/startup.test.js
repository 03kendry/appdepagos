// Arranque del servidor sin variables de PayPal/NCP: debe arrancar con
// warnings (PayPal deshabilitado) y NUNCA caerse por eso. Sin ADMIN_PASSWORD
// válida sí debe fallar (PASO 0 de la auditoría).

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Las variables PayPal van como string vacío para que dotenv (que no pisa
// variables ya presentes en el entorno) no las rellene desde el .env local.
const ENV_BASE = {
  ...process.env,
  NOWPAYMENTS_API_KEY: 'test_api_key_0123456789',
  NOWPAYMENTS_IPN_SECRET: 'test_ipn_secret_0123456789',
  DATABASE_URL: 'postgres://test:test@127.0.0.1:9/testdb',
  ADMIN_PASSWORD: 'clave_admin_de_prueba_larga',
  PAYPAL_CLIENT_ID: '',
  PAYPAL_CLIENT_SECRET: '',
  PAYPAL_WEBHOOK_ID: '',
  PAYPAL_NCP_LINKS_CONFIG: '',
  PORT: '0',
};

function runServer(env, { waitFor, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env });
    let output = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };

    const timer = setTimeout(() => finish({ output, exitCode: null, timedOut: true }), timeoutMs);

    const onData = (d) => {
      output += d.toString();
      if (waitFor && output.includes(waitFor)) finish({ output, exitCode: null, timedOut: false });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => finish({ output, exitCode: code, timedOut: false }));
    child.on('error', reject);
  });
}

describe('arranque del servidor', () => {
  test('sin variables PayPal/NCP: arranca con warnings y PayPal deshabilitado', async () => {
    // 'PayPal NCP:' es la última línea del log de arranque
    const r = await runServer(ENV_BASE, { waitFor: 'PayPal NCP:' });

    assert.equal(r.timedOut, false, `el servidor no arrancó:\n${r.output}`);
    assert.ok(r.output.includes('Servidor corriendo'), r.output);
    assert.match(r.output, /PayPal sin credenciales/);
    assert.match(r.output, /PAYPAL_NCP_LINKS_CONFIG/);
    assert.match(r.output, /PAYPAL_WEBHOOK_ID/);
    assert.match(r.output, /NCP: inactivo/);
    assert.ok(!r.output.includes('❌'), `no debería haber errores fatales:\n${r.output}`);
  });

  test('con PAYPAL_NCP_LINKS_CONFIG válida: NCP activo sin credenciales REST', async () => {
    const env = {
      ...ENV_BASE,
      PAYPAL_NCP_LINKS_CONFIG: JSON.stringify([
        {
          id: 'pl-test',
          nombre: 'Pago prueba',
          monto: 10,
          moneda: 'USD',
          url: 'https://www.paypal.com/ncp/payment/TEST123',
          tipo: 'fijo',
        },
      ]),
    };
    const r = await runServer(env, { waitFor: 'PayPal NCP:' });

    assert.equal(r.timedOut, false, `el servidor no arrancó:\n${r.output}`);
    assert.match(r.output, /NCP: 1 link\(s\) activo\(s\)/);
  });

  test('sin ADMIN_PASSWORD válida: NO arranca (fix de la auditoría)', async () => {
    const env = { ...ENV_BASE, ADMIN_PASSWORD: 'corta' };
    const r = await runServer(env, { waitFor: null });

    assert.equal(r.exitCode, 1);
    assert.match(r.output, /ADMIN_PASSWORD/);
    assert.match(r.output, /16 caracteres/);
    assert.ok(!r.output.includes('Servidor corriendo'));
  });
});
