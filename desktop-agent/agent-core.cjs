const { randomInt } = require('node:crypto');

const MIN_CAPTURE_DELAY_MS = 5 * 60 * 1000;
const MAX_CAPTURE_DELAY_MS = 10 * 60 * 1000;

function parseIntervalMinutes(intervalPreset) {
  const raw = String(intervalPreset || '').trim();
  const match = raw.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) {
    return { minMinutes: 5, maxMinutes: 10 };
  }
  const minMinutes = Math.max(1, Math.min(60, Number(match[1])));
  const maxMinutes = Math.max(minMinutes, Math.min(120, Number(match[2])));
  return { minMinutes, maxMinutes };
}

function computeActivityPercent(idleSeconds) {
  const safeIdle = Number(idleSeconds) || 0;
  if (safeIdle <= 60) return 100;
  if (safeIdle <= 300) return 50;
  return 0;
}

function computeCaptureDelayMs(randFn = randomInt, minMinutes = 5, maxMinutes = 10) {
  const safeMin = Math.max(1, Number(minMinutes) || 5);
  const safeMax = Math.max(safeMin, Number(maxMinutes) || 10);
  const minMs = safeMin * 60 * 1000;
  const maxMs = safeMax * 60 * 1000;
  return randFn(minMs, maxMs + 1);
}

function validateApiBase(nextUrl) {
  const parsed = new URL(String(nextUrl || '').trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Use an HTTP or HTTPS server URL.');
  }
  return parsed.origin;
}

function createAgentController(deps) {
  const {
    firebaseApiKey,
    readAuthBytes,
    writeAuthBytes,
    isEncryptionAvailable,
    encryptString,
    decryptString,
    fetchImpl,
    captureScreenshot,
    getActiveWindow,
    getIdleSeconds,
    onStatusUpdate,
    nowMs = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    randIntFn = randomInt,
    agentVersion = '1.0.0',
  } = deps;

  let apiBase = 'http://localhost:3000';
  let refreshToken = '';
  let idToken = '';
  let tokenExpiresAt = 0;
  let consentAccepted = false;
  let running = false;
  let stateTimer = null;
  let captureTimer = null;
  let lastState = null;

  function publish(message, state = 'ready', detail = '') {
    if (typeof onStatusUpdate === 'function') {
      onStatusUpdate({ message, state, detail });
    }
  }

  function saveAuth() {
    if (!isEncryptionAvailable()) {
      throw new Error('OS secure storage is unavailable. Agent sign-in cannot be saved safely.');
    }
    const payload = JSON.stringify({ refreshToken, apiBase, consentAccepted });
    writeAuthBytes(encryptString(payload));
  }

  function loadAuth() {
    try {
      const bytes = readAuthBytes();
      if (!bytes) return;
      const payload = isEncryptionAvailable() ? decryptString(bytes) : bytes.toString('utf8');
      const data = JSON.parse(payload);
      refreshToken = data.refreshToken || '';
      apiBase = data.apiBase || apiBase;
      consentAccepted = data.consentAccepted === true;
    } catch {
      // Ignore unreadable or first-run auth file
    }
  }

  async function refreshIdToken(force = false) {
    if (!refreshToken) throw new Error('Sign in to the monitoring agent again.');
    if (!force && idToken && nowMs() < tokenExpiresAt - 120000) return idToken;
    const response = await fetchImpl(`https://securetoken.googleapis.com/v1/token?key=${firebaseApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Session refresh failed.');
    idToken = data.id_token;
    refreshToken = data.refresh_token || refreshToken;
    tokenExpiresAt = nowMs() + Number(data.expires_in || 3600) * 1000;
    saveAuth();
    return idToken;
  }

  async function api(pathname, options = {}) {
    const token = await refreshIdToken();
    const response = await fetchImpl(`${apiBase.replace(/\/$/, '')}${pathname}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Server request failed (${response.status})`);
    return data;
  }

  async function setApiBase(nextUrl) {
    apiBase = validateApiBase(nextUrl);
    saveAuth();
    return { success: true, apiBase };
  }

  async function login({ email, password }) {
    try {
      const response = await fetchImpl(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, returnSecureToken: true }),
        }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Sign-in failed.');
      if (!data.emailVerified) throw new Error('Verify your work email before enabling monitoring.');
      refreshToken = data.refreshToken;
      idToken = data.idToken;
      tokenExpiresAt = nowMs() + Number(data.expiresIn || 3600) * 1000;
      saveAuth();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async function acceptConsent(accepted) {
    try {
      if (!accepted) throw new Error('Consent is required before monitoring can start.');
      await api('/api/monitoring/consent', {
        method: 'POST',
        body: JSON.stringify({ accepted: true, policyVersion: '2026-11-21', disclosureAccepted: true }),
      });
      consentAccepted = true;
      saveAuth();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  function resolvePolicyTiming(stateObj) {
    if (Number.isFinite(Number(stateObj?.captureMinMinutes)) && Number.isFinite(Number(stateObj?.captureMaxMinutes))) {
      return {
        minMinutes: Math.max(1, Number(stateObj.captureMinMinutes)),
        maxMinutes: Math.max(Number(stateObj.captureMinMinutes), Number(stateObj.captureMaxMinutes)),
      };
    }
    return parseIntervalMinutes(stateObj?.screenshotIntervalMinutes);
  }

  async function captureAndUpload() {
    if (!running || !consentAccepted) return { captured: false, reason: 'stopped' };
    const state = await api('/api/monitoring/state');
    lastState = state;
    if (!state.monitoringAllowed) {
      publish(state.message || 'Monitoring paused.', state.state || 'paused', state.detail || '');
      return { captured: false, reason: state.state || 'paused' };
    }

    const mode = state.monitoringMode === 'basic' ? 'basic' : 'full';
    let activeWindow = null;
    try {
      activeWindow = await getActiveWindow();
    } catch {
      activeWindow = null;
    }
    const idleSeconds = Number(getIdleSeconds()) || 0;
    const activityPercent = computeActivityPercent(idleSeconds);
    let screenshotBase64 = '';
    if (mode === 'full') {
      const screenshot = await captureScreenshot();
      screenshotBase64 = Buffer.isBuffer(screenshot) ? screenshot.toString('base64') : String(screenshot);
    }

    const snapshotBody = {
      mode,
      ...(screenshotBase64 ? { screenshotBase64 } : {}),
      activeApp: activeWindow?.owner?.name || 'Unknown',
      windowTitle: activeWindow?.title || '',
      idleSeconds,
      activityPercent,
      capturedAt: new Date(nowMs()).toISOString(),
    };
    const res = await api('/api/monitoring/snapshot', {
      method: 'POST',
      body: JSON.stringify(snapshotBody),
    });
    const { minMinutes, maxMinutes } = resolvePolicyTiming(state);
    publish(
      mode === 'basic' ? 'Monitoring ON · activity sampled (basic mode).' : 'Monitoring ON · screenshot captured.',
      'monitoring',
      `${state.meeting ? 'Meeting in progress · ' : ''}Next sample in ${minMinutes}–${maxMinutes} minutes. Idle: ${idleSeconds}s.`
    );
    return { captured: true, mode, snapshotBody, response: res };
  }

  function scheduleCapture() {
    clearTimeoutFn(captureTimer);
    captureTimer = null;
    if (!running) return null;
    const { minMinutes, maxMinutes } = resolvePolicyTiming(lastState);
    const delayMs = computeCaptureDelayMs(randIntFn, minMinutes, maxMinutes);
    captureTimer = setTimeoutFn(async () => {
      try {
        await captureAndUpload();
      } catch (error) {
        publish(error.message || 'Monitoring capture failed.', 'warning');
      }
      scheduleCapture();
    }, delayMs);
    return delayMs;
  }

  async function checkStateAndHeartbeat() {
    if (!running) return null;
    try {
      const state = await api('/api/monitoring/state');
      lastState = state;
      await api('/api/monitoring/heartbeat', {
        method: 'POST',
        body: JSON.stringify({
          agentVersion,
          state: state.state,
          mode: state.monitoringMode || 'full',
        }),
      });
      if (state.monitoringAllowed) {
        const { minMinutes, maxMinutes } = resolvePolicyTiming(state);
        const modeLabel = state.monitoringMode === 'basic' ? 'Basic activity mode' : 'Full screenshot mode';
        publish(
          'Monitoring ON',
          'monitoring',
          state.meeting
            ? `Meeting is logged; monitoring remains active (${modeLabel}, ${minMinutes}–${maxMinutes}m).`
            : `Working hours active (${modeLabel}, ${minMinutes}–${maxMinutes}m). Breaks pause monitoring.`
        );
        if (!captureTimer) scheduleCapture();
      } else {
        clearTimeoutFn(captureTimer);
        captureTimer = null;
        publish(state.message || 'Monitoring paused.', state.state || 'paused', state.detail || '');
      }
      return { ok: true, state };
    } catch (error) {
      publish(error.message || 'Agent is offline.', 'warning');
      return { ok: false, error: error.message };
    }
  }

  function start({ skipImmediatePoll = false } = {}) {
    if (!refreshToken || !consentAccepted) {
      throw new Error('Sign in and accept the monitoring policy first.');
    }
    if (running) return;
    running = true;
    if (!skipImmediatePoll) {
      void checkStateAndHeartbeat();
    }
    stateTimer = setIntervalFn(() => {
      void checkStateAndHeartbeat();
    }, 30000);
  }

  function stop() {
    running = false;
    clearIntervalFn(stateTimer);
    clearTimeoutFn(captureTimer);
    stateTimer = null;
    captureTimer = null;
    publish('Monitoring OFF. Agent is stopped.', 'paused');
  }

  async function withdraw() {
    try {
      stop();
      if (refreshToken) {
        await api('/api/monitoring/consent/revoke', { method: 'POST', body: JSON.stringify({}) });
      }
      consentAccepted = false;
      refreshToken = '';
      idToken = '';
      tokenExpiresAt = 0;
      lastState = null;
      saveAuth();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  function getStatus() {
    const { minMinutes, maxMinutes } = resolvePolicyTiming(lastState);
    return {
      state: running ? (lastState?.state || 'starting') : 'paused',
      message: running ? 'Agent is running.' : 'Agent is stopped.',
      detail: lastState?.detail || '',
      monitoringMode: lastState?.monitoringMode || 'full',
      captureIntervalMinutes: `${minMinutes}-${maxMinutes}`,
      authenticated: Boolean(refreshToken),
      consentAccepted,
      captureScheduled: Boolean(captureTimer),
      apiBase,
    };
  }

  return {
    loadAuth,
    saveAuth,
    setApiBase,
    login,
    acceptConsent,
    start,
    stop,
    withdraw,
    captureAndUpload,
    checkStateAndHeartbeat,
    scheduleCapture,
    getStatus,
  };
}

module.exports = {
  MIN_CAPTURE_DELAY_MS,
  MAX_CAPTURE_DELAY_MS,
  parseIntervalMinutes,
  computeActivityPercent,
  computeCaptureDelayMs,
  validateApiBase,
  createAgentController,
};
