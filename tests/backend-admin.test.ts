import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { parseServiceAccountFromEnv } from '../src/server/firebaseAdminConfig.ts';

const EXPECTED_PROJECT_ID = 'gen-lang-client-0209720424';

function makeDummySaJson(projectId: string, extraEscape = false): string {
  const key = extraEscape
    ? '-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg==\\n-----END PRIVATE KEY-----\\n'
    : '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg==\n-----END PRIVATE KEY-----\n';
  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'key123',
    private_key: key,
    client_email: `firebase-adminsdk-test@${projectId}.iam.gserviceaccount.com`,
    client_id: '1234567890',
  });
}

function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

test('parseServiceAccountFromEnv handles FIREBASE_SERVICE_ACCOUNT, legacy JSON, base64, quotes, and invalid payloads', () => {
  // 1. Unset -> ADC mode
  const unset = parseServiceAccountFromEnv(EXPECTED_PROJECT_ID, {});
  assert.equal(unset.configured, false);
  assert.equal(unset.parseStatus, 'not_configured');
  assert.equal(unset.serviceAccount, null);

  // 2. Primary FIREBASE_SERVICE_ACCOUNT takes precedence over legacy
  const primaryJson = makeDummySaJson(EXPECTED_PROJECT_ID, true);
  const legacyJson = makeDummySaJson('gen-lang-client-0620341080');
  const primary = parseServiceAccountFromEnv(EXPECTED_PROJECT_ID, {
    FIREBASE_SERVICE_ACCOUNT: primaryJson,
    FIREBASE_SERVICE_ACCOUNT_JSON: legacyJson,
  });
  assert.equal(primary.configured, true);
  assert.equal(primary.envName, 'FIREBASE_SERVICE_ACCOUNT');
  assert.equal(primary.parseStatus, 'valid');
  assert.equal(primary.serviceAccountProjectId, EXPECTED_PROJECT_ID);
  assert.equal(primary.projectIdConsistent, true);
  assert.ok(primary.serviceAccount?.private_key?.includes('\n-----END PRIVATE KEY-----'));

  // 3. Base64-encoded service account JSON
  const b64 = Buffer.from(makeDummySaJson(EXPECTED_PROJECT_ID), 'utf8').toString('base64');
  const fromB64 = parseServiceAccountFromEnv(EXPECTED_PROJECT_ID, { FIREBASE_SERVICE_ACCOUNT: b64 });
  assert.equal(fromB64.parseStatus, 'valid');
  assert.equal(fromB64.projectIdConsistent, true);

  // 4. Quotes-wrapped JSON
  const wrapped = `'${makeDummySaJson(EXPECTED_PROJECT_ID)}'`;
  const fromWrapped = parseServiceAccountFromEnv(EXPECTED_PROJECT_ID, { FIREBASE_SERVICE_ACCOUNT: wrapped });
  assert.equal(fromWrapped.parseStatus, 'valid');

  // 5. Project ID mismatch detection
  const mismatched = parseServiceAccountFromEnv(EXPECTED_PROJECT_ID, {
    FIREBASE_SERVICE_ACCOUNT_JSON: makeDummySaJson('gen-lang-client-0620341080'),
  });
  assert.equal(mismatched.parseStatus, 'valid');
  assert.equal(mismatched.serviceAccountProjectId, 'gen-lang-client-0620341080');
  assert.equal(mismatched.projectIdConsistent, false);
  assert.match(String(mismatched.errorMessage), /Project ID mismatch/);

  // 6. Malformed JSON never throws
  const invalidJson = parseServiceAccountFromEnv(EXPECTED_PROJECT_ID, {
    FIREBASE_SERVICE_ACCOUNT: '{broken_json:',
  });
  assert.equal(invalidJson.configured, true);
  assert.equal(invalidJson.parseStatus, 'invalid_json');
  assert.equal(invalidJson.serviceAccount, null);

  // 7. Missing required PEM/email fields never throws
  const missingFields = parseServiceAccountFromEnv(EXPECTED_PROJECT_ID, {
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: EXPECTED_PROJECT_ID }),
  });
  assert.equal(missingFields.parseStatus, 'missing_fields');
  assert.equal(missingFields.serviceAccount, null);
});

test('Live Express backend API connectivity, optional integrations, and attendance/dashboard endpoints (zero 502s)', async (t) => {
  const up = await isPortOpen('127.0.0.1', 3000);
  if (!up) {
    t.skip('Local server on port 3000 is not running during standalone unit test run.');
    return;
  }

  const healthRes = await fetch('http://127.0.0.1:3000/api/health');
  assert.equal(healthRes.status, 200);
  const health = (await healthRes.json()) as Record<string, unknown>;
  assert.equal(health.status, 'ok');
  assert.equal(health.firebaseProjectId, EXPECTED_PROJECT_ID);
  assert.equal(health.firestoreDatabaseId, 'ai-studio-workflowosaceweb-f23bec09-9afb-4a68-8d35-a438d22d2192');
  assert.equal(typeof health.serviceAccountConfigured, 'boolean');
  assert.equal(typeof health.adminFirestoreConnected, 'boolean');

  const timeRes = await fetch('http://127.0.0.1:3000/api/time');
  assert.equal(timeRes.status, 200);
  const timeData = (await timeRes.json()) as { timestamp?: string };
  assert.ok(Boolean(timeData.timestamp));

  // Verify dashboard, leave, and attendance API endpoints return clean JSON auth errors (401), never 502
  const protectedRoutes: Array<{ method: 'GET' | 'POST'; path: string }> = [
    { method: 'GET', path: '/api/system/deployment-info' },
    { method: 'GET', path: '/api/integrations/status' },
    { method: 'GET', path: '/api/monitoring/state' },
    { method: 'POST', path: '/api/leaves/ensure-balance' },
    { method: 'POST', path: '/api/leaves/apply' },
    { method: 'POST', path: '/api/attendance/check-in' },
    { method: 'POST', path: '/api/attendance/check-out' },
    { method: 'POST', path: '/api/attendance/break-start' },
    { method: 'POST', path: '/api/attendance/break-end' },
    { method: 'POST', path: '/api/holidays/select-optional' },
  ];

  for (const route of protectedRoutes) {
    const res = await fetch(`http://127.0.0.1:3000${route.path}`, {
      method: route.method,
      headers: { 'Content-Type': 'application/json' },
      ...(route.method === 'POST' ? { body: JSON.stringify({}) } : {}),
    });
    assert.notEqual(res.status, 502, `Route ${route.path} returned 502 Bad Gateway`);
    assert.equal(res.status, 401, `Expected 401 for unauthenticated ${route.path}`);
    const json = (await res.json()) as { error?: string };
    assert.ok(typeof json.error === 'string' && json.error.length > 0);
  }

  // Non-existent API route cleanly returns 404 JSON
  const missingRes = await fetch('http://127.0.0.1:3000/api/nonexistent');
  assert.equal(missingRes.status, 404);
});
