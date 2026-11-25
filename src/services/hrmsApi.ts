import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { auth, db, storage, handleFirestoreError, OperationType } from '../firebase';
import type { NotificationItem, UserRole } from '../types/hrms';

export function makeId(prefix = 'id'): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now()}_${rand}`;
}

export class ApiError extends Error {
  status: number;
  iamBlocked?: boolean;
  endpoint?: string;
  constructor(message: string, status: number, iamBlocked?: boolean, endpoint?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.iamBlocked = iamBlocked;
    this.endpoint = endpoint;
  }
}

export function isIamBlockedError(err: unknown): boolean {
  return err instanceof ApiError && (Boolean(err.iamBlocked) || err.status === 503);
}

export async function apiRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const maxAttempts = method === 'GET' ? 2 : 1;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const token = await auth.currentUser?.getIdToken();
      const res = await fetch(url, {
        ...options,
        signal: options.signal || controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.headers || {}),
        },
      });
      clearTimeout(timeoutId);

      const rawText = await res.text().catch(() => '');
      let data: Record<string, unknown> = {};
      if (rawText) {
        try {
          data = JSON.parse(rawText) as Record<string, unknown>;
        } catch {
          data = {};
        }
      }

      if (!res.ok) {
        if (attempt < maxAttempts && (res.status === 502 || res.status === 503 || res.status === 504)) {
          await new Promise((r) => setTimeout(r, 350));
          continue;
        }
        const message =
          (typeof data.error === 'string' && data.error) ||
          (typeof data.reason === 'string' && data.reason) ||
          (typeof data.message === 'string' && data.message) ||
          `Server request to ${url} failed (${res.status}${res.statusText ? ` ${res.statusText}` : ''})`;
        throw new ApiError(message, res.status, Boolean(data.iamBlocked), url);
      }

      return data as T;
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      if (err instanceof ApiError) throw err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 350));
        continue;
      }
      const msg =
        err instanceof Error && err.name === 'AbortError'
          ? `Request to ${url} timed out after 15s`
          : err instanceof Error
          ? err.message
          : `Network error calling ${url}`;
      throw new ApiError(msg, 0, false, url);
    }
  }

  throw lastError instanceof Error ? lastError : new ApiError(`Request failed for ${url}`, 500, false, url);
}

export async function writeAuditLog(params: {
  actorUid: string;
  actorEmail: string;
  actorRole: UserRole | string;
  action: string;
  targetCollection: string;
  targetId: string;
  summary: string;
}): Promise<void> {
  const id = makeId('audit');
  const path = `auditLogs/${id}`;
  try {
    await setDoc(doc(db, 'auditLogs', id), {
      id,
      actorUid: params.actorUid,
      actorEmail: params.actorEmail,
      actorRole: params.actorRole,
      action: params.action,
      targetCollection: params.targetCollection,
      targetId: params.targetId,
      summary: params.summary.slice(0, 500),
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export interface EmailSendResult {
  delivered: boolean;
  configured?: boolean;
  messageId?: string;
  reason?: string;
}

let cachedSmtpConfigured: boolean | null = null;

export async function getEmailProviderStatus(forceRefresh = false): Promise<boolean> {
  if (cachedSmtpConfigured !== null && !forceRefresh) {
    return cachedSmtpConfigured;
  }
  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      const data = await res.json();
      cachedSmtpConfigured = Boolean(data.smtpConfigured);
      return cachedSmtpConfigured;
    }
  } catch {
    // Default false when health probe cannot determine provider
  }
  return false;
}

export async function dispatchNotification(params: {
  recipientUid: string;
  recipientEmail?: string;
  title: string;
  message: string;
  type: NotificationItem['type'];
  linkTab?: string;
  taskId?: string;
  sendEmail?: boolean;
}): Promise<EmailSendResult> {
  let emailDelivered = false;
  let emailResult: EmailSendResult = {
    delivered: false,
    configured: false,
    reason: 'Email provider not configured; in-app notification created.',
  };

  if (params.sendEmail && params.recipientEmail) {
    const smtpReady = await getEmailProviderStatus();
    if (smtpReady) {
      try {
        emailResult = await apiRequest<EmailSendResult>('/api/notifications/send-email', {
          method: 'POST',
          body: JSON.stringify({
            to: params.recipientEmail,
            subject: params.title,
            title: params.title,
            message: params.message,
          }),
        });
        emailDelivered = Boolean(emailResult.delivered);
      } catch (err) {
        emailResult = {
          delivered: false,
          configured: true,
          reason: err instanceof Error ? err.message : 'Email request failed',
        };
      }
    }
  }

  const id = makeId('notif');
  const path = `notifications/${id}`;
  try {
    await setDoc(doc(db, 'notifications', id), {
      id,
      recipientUid: params.recipientUid,
      title: params.title.slice(0, 160),
      message: params.message.slice(0, 1000),
      type: params.type,
      ...(params.linkTab ? { linkTab: params.linkTab } : {}),
      ...(params.taskId ? { taskId: params.taskId } : {}),
      read: false,
      emailSent: emailDelivered,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }

  return emailResult;
}

export async function uploadToStorage(folder: string, file: File): Promise<string> {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storageRef = ref(storage, `${folder}/${Date.now()}_${safeName}`);
  await uploadBytes(storageRef, file);
  return getDownloadURL(storageRef);
}
