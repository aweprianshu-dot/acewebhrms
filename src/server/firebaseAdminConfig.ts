import fs from 'node:fs';
import type { ServiceAccount } from 'firebase-admin/app';

export interface ParsedServiceAccountResult {
  envName: 'FIREBASE_SERVICE_ACCOUNT' | 'FIREBASE_SERVICE_ACCOUNT_JSON' | null;
  configured: boolean;
  parseStatus: 'not_configured' | 'valid' | 'invalid_json' | 'missing_fields';
  serviceAccount: (ServiceAccount & { project_id?: string; client_email?: string; private_key?: string }) | null;
  serviceAccountProjectId: string | null;
  projectIdConsistent: boolean | null;
  maskedClientEmail: string | null;
  errorMessage?: string;
}

function maskEmail(email: string | undefined): string | null {
  if (!email || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  const prefix = local.slice(0, Math.min(4, local.length));
  return `${prefix}***@${domain}`;
}

function tryJsonParseServiceAccount(raw: string): Record<string, unknown> | null {
  const candidates: string[] = [raw.trim()];

  // Strip surrounding single or double quotes if pasted with quotes into .env
  const first = candidates[0];
  if (
    (first.startsWith('"') && first.endsWith('"')) ||
    (first.startsWith("'") && first.endsWith("'"))
  ) {
    candidates.push(first.slice(1, -1).trim());
  }

  // Handle base64-encoded JSON if provided
  if (!first.startsWith('{') && /^[A-Za-z0-9+/=_-]+$/.test(first) && first.length > 40) {
    try {
      const decoded = Buffer.from(first, 'base64').toString('utf8').trim();
      if (decoded.startsWith('{')) candidates.push(decoded);
    } catch {
      // Ignore invalid base64
    }
  }

  // Handle file path to JSON credentials if readable on disk
  if (!first.startsWith('{') && first.endsWith('.json') && fs.existsSync(first)) {
    try {
      const fileContent = fs.readFileSync(first, 'utf8').trim();
      if (fileContent.startsWith('{')) candidates.push(fileContent);
    } catch {
      // Ignore unreadable path
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === 'string') {
        // Double-JSON-encoded string
        const inner = JSON.parse(parsed);
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
          return inner as Record<string, unknown>;
        }
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try escaping raw multiline breaks inside private_key if pasted unescaped
      try {
        const sanitized = candidate.replace(/\r?\n/g, '\\n');
        const parsed = JSON.parse(sanitized);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Continue to next candidate
      }
    }
  }

  return null;
}

export function parseServiceAccountFromEnv(
  expectedProjectId: string,
  env: Record<string, string | undefined> = process.env,
): ParsedServiceAccountResult {
  const saPrimary = env.FIREBASE_SERVICE_ACCOUNT?.trim();
  const saLegacy = env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  const envName = saPrimary
    ? 'FIREBASE_SERVICE_ACCOUNT'
    : saLegacy
    ? 'FIREBASE_SERVICE_ACCOUNT_JSON'
    : null;
  const raw = saPrimary || saLegacy || '';

  if (!raw) {
    return {
      envName: null,
      configured: false,
      parseStatus: 'not_configured',
      serviceAccount: null,
      serviceAccountProjectId: null,
      projectIdConsistent: null,
      maskedClientEmail: null,
    };
  }

  const parsed = tryJsonParseServiceAccount(raw);
  if (!parsed) {
    return {
      envName,
      configured: true,
      parseStatus: 'invalid_json',
      serviceAccount: null,
      serviceAccountProjectId: null,
      projectIdConsistent: null,
      maskedClientEmail: null,
      errorMessage: `${envName} is set but could not be parsed as valid service account JSON.`,
    };
  }

  const projectId = typeof parsed.project_id === 'string'
    ? parsed.project_id.trim()
    : typeof parsed.projectId === 'string'
    ? parsed.projectId.trim()
    : '';
  const clientEmail = typeof parsed.client_email === 'string'
    ? parsed.client_email.trim()
    : typeof parsed.clientEmail === 'string'
    ? parsed.clientEmail.trim()
    : '';
  const rawKey = typeof parsed.private_key === 'string'
    ? parsed.private_key
    : typeof parsed.privateKey === 'string'
    ? parsed.privateKey
    : '';
  const privateKey = rawKey.replace(/\\n/g, '\n').trim();

  if (!projectId || !clientEmail || !privateKey || !privateKey.includes('PRIVATE KEY')) {
    return {
      envName,
      configured: true,
      parseStatus: 'missing_fields',
      serviceAccount: null,
      serviceAccountProjectId: projectId || null,
      projectIdConsistent: projectId ? projectId === expectedProjectId : null,
      maskedClientEmail: maskEmail(clientEmail),
      errorMessage: `${envName} is missing required fields (project_id, client_email, or PEM private_key).`,
    };
  }

  const normalized = {
    ...parsed,
    project_id: projectId,
    projectId,
    client_email: clientEmail,
    clientEmail,
    private_key: privateKey,
    privateKey,
  } as ServiceAccount & { project_id: string; client_email: string; private_key: string };

  const projectIdConsistent = projectId === expectedProjectId;
  return {
    envName,
    configured: true,
    parseStatus: 'valid',
    serviceAccount: normalized,
    serviceAccountProjectId: projectId,
    projectIdConsistent,
    maskedClientEmail: maskEmail(clientEmail),
    ...(projectIdConsistent
      ? {}
      : {
          errorMessage: `Project ID mismatch: ${envName} specifies "${projectId}", but firebase-applet-config.json expects "${expectedProjectId}".`,
        }),
  };
}
