import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MIN_CAPTURE_DELAY_MS,
  MAX_CAPTURE_DELAY_MS,
  computeActivityPercent,
  computeCaptureDelayMs,
  validateApiBase,
  createAgentController,
} = require('../desktop-agent/agent-core.cjs');

test('desktop agent validates server URLs, capture random intervals, and idle activity scoring', () => {
  assert.equal(validateApiBase('https://hrms.acewebexperts.com/dashboard'), 'https://hrms.acewebexperts.com');
  assert.throws(() => validateApiBase('ftp://invalid.local'), /HTTP or HTTPS/);

  assert.equal(computeActivityPercent(0), 100);
  assert.equal(computeActivityPercent(60), 100);
  assert.equal(computeActivityPercent(180), 50);
  assert.equal(computeActivityPercent(301), 0);

  for (let i = 0; i < 25; i += 1) {
    const ms = computeCaptureDelayMs();
    assert.ok(ms >= MIN_CAPTURE_DELAY_MS && ms <= MAX_CAPTURE_DELAY_MS);
  }
});

test('desktop agent rejects unverified emails and unavailable OS secureStorage', async () => {
  const unverifiedCtrl = createAgentController({
    firebaseApiKey: 'test-key',
    readAuthBytes: () => null,
    writeAuthBytes: () => {},
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ emailVerified: false, refreshToken: 'rt', idToken: 'it', expiresIn: '3600' }),
        { status: 200 }
      ),
    captureScreenshot: async () => Buffer.from('png'),
    getActiveWindow: async () => ({ owner: { name: 'Code' }, title: 'main.cjs' }),
    getIdleSeconds: () => 5,
  });

  const res = await unverifiedCtrl.login({ email: 'dev@acewebexperts.com', password: 'secret' });
  assert.equal(res.success, false);
  assert.match(String(res.error), /Verify your work email/);

  const noSafeStorageCtrl = createAgentController({
    firebaseApiKey: 'test-key',
    readAuthBytes: () => null,
    writeAuthBytes: () => {},
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ emailVerified: true, refreshToken: 'rt', idToken: 'it', expiresIn: '3600' }),
        { status: 200 }
      ),
    captureScreenshot: async () => Buffer.from('png'),
    getActiveWindow: async () => null,
    getIdleSeconds: () => 0,
  });

  const storageRes = await noSafeStorageCtrl.login({ email: 'dev@acewebexperts.com', password: 'secret' });
  assert.equal(storageRes.success, false);
  assert.match(String(storageRes.error), /OS secure storage is unavailable/);
});

test('desktop agent runs complete consent -> check-in wait -> active capture -> break pause -> offline -> withdraw lifecycle', async () => {
  let savedBuf: Buffer | null = null;
  const statuses: Array<{ message: string; state: string; detail: string }> = [];
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];

  let currentServerState: Record<string, unknown> = {
    monitoringAllowed: false,
    state: 'waiting',
    message: 'Waiting for attendance check-in.',
    detail: 'Not checked in yet.',
  };
  let failNetwork = false;

  const ctrl = createAgentController({
    firebaseApiKey: 'test-key',
    readAuthBytes: () => savedBuf,
    writeAuthBytes: (buf: Buffer) => {
      savedBuf = buf;
    },
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
    fetchImpl: async (url: string, opts?: RequestInit) => {
      const parsedBody = opts?.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
      calls.push({ url, body: parsedBody });

      if (failNetwork) {
        throw new Error('ECONNREFUSED');
      }
      if (url.includes('signInWithPassword')) {
        return new Response(
          JSON.stringify({ emailVerified: true, refreshToken: 'rt_1', idToken: 'id_1', expiresIn: '3600' }),
          { status: 200 }
        );
      }
      if (url.endsWith('/api/monitoring/consent')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.endsWith('/api/monitoring/consent/revoke')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.endsWith('/api/monitoring/state')) {
        return new Response(JSON.stringify(currentServerState), { status: 200 });
      }
      if (url.endsWith('/api/monitoring/heartbeat')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith('/api/monitoring/snapshot')) {
        return new Response(JSON.stringify({ id: 'snap_123' }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    },
    captureScreenshot: async () => Buffer.from('fake-png-bytes'),
    getActiveWindow: async () => ({ owner: { name: 'VS Code' }, title: 'server.ts - ACE HRMS' }),
    getIdleSeconds: () => 25,
    onStatusUpdate: (s: { message: string; state: string; detail: string }) => statuses.push(s),
    setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => {},
    setTimeoutFn: () => 2 as unknown as ReturnType<typeof setTimeout>,
    clearTimeoutFn: () => {},
  });

  await ctrl.setApiBase('https://hrms.acewebexperts.com');
  const loginRes = await ctrl.login({ email: 'alice@acewebexperts.com', password: 'Password@123' });
  assert.equal(loginRes.success, true);

  const deniedConsent = await ctrl.acceptConsent(false);
  assert.equal(deniedConsent.success, false);

  const consentRes = await ctrl.acceptConsent(true);
  assert.equal(consentRes.success, true);
  assert.ok(savedBuf !== null);

  // 1. Before check-in: waiting state, capture NOT scheduled
  ctrl.start({ skipImmediatePoll: true });
  await ctrl.checkStateAndHeartbeat();
  assert.equal(ctrl.getStatus().captureScheduled, false);
  assert.equal(ctrl.getStatus().state, 'waiting');

  // 2. Checked in (active working hours): schedules capture + uploads screenshot metadata
  currentServerState = {
    monitoringAllowed: true,
    state: 'monitoring',
    meeting: false,
    message: 'Monitoring ON',
  };
  await ctrl.checkStateAndHeartbeat();
  assert.equal(ctrl.getStatus().captureScheduled, true);

  const snapResult = await ctrl.captureAndUpload();
  assert.equal(snapResult.captured, true);
  assert.equal(snapResult.snapshotBody.activeApp, 'VS Code');
  assert.equal(snapResult.snapshotBody.windowTitle, 'server.ts - ACE HRMS');
  assert.equal(snapResult.snapshotBody.idleSeconds, 25);
  assert.equal(snapResult.snapshotBody.activityPercent, 100);
  assert.equal(snapResult.snapshotBody.screenshotBase64, Buffer.from('fake-png-bytes').toString('base64'));

  // 3. Employee starts Lunch break -> server returns monitoringAllowed: false, paused
  currentServerState = {
    monitoringAllowed: false,
    state: 'paused',
    message: 'Break in progress — monitoring paused.',
  };
  await ctrl.checkStateAndHeartbeat();
  assert.equal(ctrl.getStatus().captureScheduled, false);
  assert.equal(ctrl.getStatus().state, 'paused');

  // 4. Network drops -> agent surfaces warning status cleanly without throwing
  failNetwork = true;
  const offlineRes = await ctrl.checkStateAndHeartbeat();
  assert.equal(offlineRes.ok, false);
  assert.equal(statuses.at(-1)?.state, 'warning');
  failNetwork = false;

  // 5. Withdraw consent & sign out
  const withdrawRes = await ctrl.withdraw();
  assert.equal(withdrawRes.success, true);
  assert.equal(ctrl.getStatus().authenticated, false);
  assert.equal(ctrl.getStatus().consentAccepted, false);
  assert.ok(calls.some((c) => c.url.endsWith('/api/monitoring/consent/revoke')));
});
