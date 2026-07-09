// Verificación de firma del webhook de PayPal (mockeada, sin red).

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { verifyWebhookSignature } = require('../ncp');

const HEADERS_OK = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270',
  'paypal-transmission-id': '69cd13f0-d67a-11e5-baa3-778b53f4ae55',
  'paypal-transmission-sig': 'lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A=',
  'paypal-transmission-time': '2026-07-08T15:20:02Z',
};

const RAW_BODY = '{"id":"WH-TEST","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"TX1"}}';

function mockFetch(status, calls = []) {
  return async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      json: async () => ({ verification_status: status }),
    };
  };
}

const baseArgs = {
  headers: HEADERS_OK,
  rawBody: RAW_BODY,
  webhookId: 'WH-ID-123',
  getAccessToken: async () => 'token-mock',
  paypalBase: 'https://api-m.sandbox.paypal.com',
};

describe('verifyWebhookSignature', () => {
  test('SUCCESS de la API oficial → verificado', async () => {
    const calls = [];
    const r = await verifyWebhookSignature({ ...baseArgs, fetchImpl: mockFetch('SUCCESS', calls) });

    assert.equal(r.verified, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/notifications\/verify-webhook-signature$/);
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer token-mock');
    // El evento va como raw string, sin re-serializar (no altera la firma)
    assert.ok(calls[0].opts.body.includes(`"webhook_event":${RAW_BODY}`));
    assert.ok(calls[0].opts.body.includes('"webhook_id":"WH-ID-123"'));
  });

  test('FAILURE de la API oficial → rechazado', async () => {
    const r = await verifyWebhookSignature({ ...baseArgs, fetchImpl: mockFetch('FAILURE') });
    assert.equal(r.verified, false);
  });

  test('falta un header de firma → rechazado sin llamar a la API', async () => {
    const calls = [];
    const headers = { ...HEADERS_OK };
    delete headers['paypal-transmission-sig'];

    const r = await verifyWebhookSignature({ ...baseArgs, headers, fetchImpl: mockFetch('SUCCESS', calls) });
    assert.equal(r.verified, false);
    assert.match(r.reason, /paypal-transmission-sig/);
    assert.equal(calls.length, 0);
  });

  test('sin PAYPAL_WEBHOOK_ID → rechazado sin llamar a la API', async () => {
    const calls = [];
    const r = await verifyWebhookSignature({ ...baseArgs, webhookId: '', fetchImpl: mockFetch('SUCCESS', calls) });
    assert.equal(r.verified, false);
    assert.equal(calls.length, 0);
  });

  test('body vacío → rechazado', async () => {
    const r = await verifyWebhookSignature({ ...baseArgs, rawBody: '', fetchImpl: mockFetch('SUCCESS') });
    assert.equal(r.verified, false);
  });

  test('la API de verificación responde error HTTP → rechazado', async () => {
    const fetchErr = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const r = await verifyWebhookSignature({ ...baseArgs, fetchImpl: fetchErr });
    assert.equal(r.verified, false);
    assert.match(r.reason, /HTTP 500/);
  });
});
