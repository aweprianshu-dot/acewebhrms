import 'dotenv/config';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import nodemailer from 'nodemailer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  RESTORABLE_COLLECTIONS,
  buildBackupBundle,
  computeRestorePreview,
  isBackupDue,
  selectBackupsToPrune,
  serializeFirestoreValue,
  validateAndVerifyBackupBundle,
  type BackupDocumentEntry,
  type StorageManifestItem,
} from './src/utils/backupUtils.ts';
import type { BackupConfigSettings, BackupFrequency } from './src/types/hrms.ts';
import {
  HttpLeaveError,
  adjustLeaveBalance,
  cancelApprovedAndRefundLeave,
  cancelPendingLeaveRequest,
  decideLeaveRequest,
  ensureEmployeeLeaveBalance,
  executeAnnualLeaveReset,
  migrateLegacyLeaveBalances,
  resubmitLeaveRequest,
  submitLeaveRequest,
  syncEmployeeLeaveScope,
  type AdjustableBucket,
  type LeaveStoreAdapter,
} from './src/server/leaveService.ts';

import {
  parseServiceAccountFromEnv,
  type ParsedServiceAccountResult,
} from './src/server/firebaseAdminConfig.ts';
import { resolveCheckoutStatus } from './src/utils/attendanceUtils.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Firebase project ID from firebase-applet-config.json
const firebaseConfigPath = path.resolve(__dirname, 'firebase-applet-config.json');
const firebaseConfig = fs.existsSync(firebaseConfigPath)
  ? JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf8'))
  : { projectId: process.env.FIREBASE_PROJECT_ID || 'gen-lang-client-0209720424' };

let serviceAccountInfo: ParsedServiceAccountResult = parseServiceAccountFromEnv(firebaseConfig.projectId);

function createAdminApp() {
  if (getApps().length > 0) return getApps()[0]!;
  serviceAccountInfo = parseServiceAccountFromEnv(firebaseConfig.projectId);
  if (serviceAccountInfo.configured && serviceAccountInfo.parseStatus !== 'valid') {
    console.warn(`[Firebase Admin] ${serviceAccountInfo.errorMessage}`);
  } else if (serviceAccountInfo.configured && serviceAccountInfo.projectIdConsistent === false) {
    console.warn(`[Firebase Admin] ${serviceAccountInfo.errorMessage}`);
  }

  if (serviceAccountInfo.serviceAccount) {
    try {
      return initializeApp({
        credential: cert(serviceAccountInfo.serviceAccount),
        projectId: firebaseConfig.projectId,
      });
    } catch (err) {
      serviceAccountInfo = {
        ...serviceAccountInfo,
        parseStatus: 'invalid_json',
        serviceAccount: null,
        errorMessage: `Credential initialization failed: ${err instanceof Error ? err.message : 'Invalid certificate'}`,
      };
      console.warn('[Firebase Admin] Failed to initialize cert() credential; falling back to default credentials.', err instanceof Error ? err.message : '');
    }
  }
  return initializeApp({ projectId: firebaseConfig.projectId });
}

const adminApp = createAdminApp();
const adminAuth = getAuth(adminApp);
const adminDb = getFirestore(adminApp, firebaseConfig.firestoreDatabaseId || '(default)');
const adminBucket = firebaseConfig.storageBucket ? getStorage(adminApp).bucket(firebaseConfig.storageBucket) : null;

interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    email?: string;
    emailVerified?: boolean;
  };
}

async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const idToken = authHeader.slice(7).trim();
  if (!idToken) {
    res.status(401).json({ error: 'Empty bearer token' });
    return;
  }

  try {
    const decoded = await adminAuth.verifyIdToken(idToken);
    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      emailVerified: decoded.email_verified,
    };
    next();
  } catch (err) {
    res.status(401).json({
      error: 'Invalid or expired authentication token',
      details: err instanceof Error ? err.message : 'Token verification failed',
    });
  }
}

function isSmtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function isPermissionDeniedError(error: unknown): boolean {
  const code = (error as { code?: number | string } | null)?.code;
  if (code === 7 || code === '7' || code === 'PERMISSION_DENIED' || code === 16 || code === 'UNAUTHENTICATED') {
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes('PERMISSION_DENIED') ||
    msg.includes('7 PERMISSION_DENIED') ||
    msg.includes('16 UNAUTHENTICATED') ||
    msg.includes('Could not load the default credentials')
  );
}

async function sendSystemEmailIfConfigured(params: {
  to: string;
  subject: string;
  title: string;
  message: string;
  actionLabel?: string;
  appUrl?: string;
}): Promise<{
  delivered: boolean;
  configured: boolean;
  messageId?: string;
  accepted?: unknown[];
  rejected?: unknown[];
  reason?: string;
}> {
  if (!isSmtpConfigured()) {
    return {
      delivered: false,
      configured: false,
      reason: 'SMTP server credentials (SMTP_HOST, SMTP_USER, SMTP_PASS) are not configured. In-app notification saved.',
    };
  }
  const cleanTo = params.to.trim();
  if (!cleanTo || !cleanTo.includes('@')) {
    return { delivered: false, configured: true, reason: 'Recipient email address missing.' };
  }
  try {
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 10000,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    const appUrl = params.appUrl || resolveCurrentAppUrl();
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM?.trim() || process.env.SMTP_USER,
      to: cleanTo,
      subject: `[ACE HRMS] ${params.subject}`,
      text: `${params.title}\n\n${params.message}\n\nOpen ACE HRMS: ${appUrl}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#0B0D12; color:#E2E8F0; padding:32px; border-radius:12px;">
          <div style="max-width:560px; margin:0 auto; background:#151922; border:1px solid #292D36; border-radius:12px; padding:28px;">
            <div style="font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:#FF6A33; font-weight:600;">ACE Web Experts · ACE HRMS</div>
            <h2 style="margin:12px 0 8px; color:#FFFFFF; font-size:20px;">${params.title.replace(/</g, '&lt;')}</h2>
            <p style="margin:0 0 20px; color:#C4C4CC; font-size:15px; line-height:1.6;">${params.message.replace(/</g, '&lt;').replace(/\n/g, '<br/>')}</p>
            <a href="${appUrl}" style="display:inline-block; background:linear-gradient(135deg,#FF4634 0%,#FF6A33 100%); color:#FFFFFF; text-decoration:none; padding:10px 18px; border-radius:8px; font-size:14px; font-weight:600;">${(params.actionLabel || 'Open ACE HRMS').replace(/</g, '&lt;')}</a>
          </div>
        </div>
      `,
    });
    const accepted = Array.isArray(info.accepted) && info.accepted.length > 0;
    return {
      delivered: accepted,
      configured: true,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
    };
  } catch (err) {
    return {
      delivered: false,
      configured: true,
      reason: err instanceof Error ? err.message : 'SMTP delivery failed',
    };
  }
}

async function createSystemNotificationIfMissing(params: {
  id: string;
  recipientUid: string;
  recipientEmail?: string;
  title: string;
  message: string;
  type: 'attendance' | 'document' | 'system' | 'leave' | 'payroll' | 'announcement' | 'performance' | 'task';
  linkTab: string;
  emailEnabled?: boolean;
}): Promise<void> {
  const noticeRef = adminDb.collection('notifications').doc(params.id);
  const existing = await noticeRef.get();
  if (existing.exists) return;

  let emailSent = false;
  if (params.emailEnabled !== false && params.recipientEmail) {
    const emailRes = await sendSystemEmailIfConfigured({
      to: params.recipientEmail,
      subject: params.title,
      title: params.title,
      message: params.message,
    });
    emailSent = emailRes.delivered;
  }

  await noticeRef.set({
    id: params.id,
    recipientUid: params.recipientUid,
    title: params.title.slice(0, 160),
    message: params.message.slice(0, 1000),
    type: params.type,
    linkTab: params.linkTab,
    read: false,
    emailSent,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function resolveSuperAdminRecipients(): Promise<Array<{ uid: string; email: string }>> {
  const rolesSnap = await adminDb.collection('roles').where('status', '==', 'active').get();
  return rolesSnap.docs
    .filter((d) => String(d.data().role) === 'super_admin' && d.data().email)
    .map((d) => ({ uid: d.id, email: String(d.data().email) }));
}

async function readCurrentCollectionsFromAdmin(): Promise<Record<string, BackupDocumentEntry[]>> {
  const out: Record<string, BackupDocumentEntry[]> = {};
  for (const colName of RESTORABLE_COLLECTIONS) {
    const snap = await adminDb.collection(colName).get();
    out[colName] = snap.docs.map((d) => ({
      __docId: d.id,
      data: serializeFirestoreValue(d.data()) as Record<string, unknown>,
    }));
  }
  return out;
}

async function runAdminBackupJob(params: {
  trigger: 'scheduled' | 'manual';
  actorUid: string;
  actorEmail: string;
  config?: Partial<BackupConfigSettings>;
}): Promise<{
  backupId: string;
  checksumSha256: string;
  totalRecords: number;
  storageFileCount: number;
  sizeBytes: number;
  storagePath: string;
  prunedIds: string[];
}> {
  const cfgSnap = await adminDb.collection('settings').doc('backupConfig').get().catch(() => null);
  const storedCfg = (cfgSnap?.data() || {}) as Partial<BackupConfigSettings>;
  const frequency: BackupFrequency = (params.config?.frequency || storedCfg.frequency || 'daily') as BackupFrequency;
  const retentionDays = Math.max(1, Number(params.config?.retentionDays ?? storedCfg.retentionDays ?? 30));
  const retentionMaxCount = Math.max(1, Number(params.config?.retentionMaxCount ?? storedCfg.retentionMaxCount ?? 30));
  const notifyOnSuccess = params.config?.notifyOnSuccess ?? storedCfg.notifyOnSuccess ?? true;
  const notifyOnFailure = params.config?.notifyOnFailure ?? storedCfg.notifyOnFailure ?? true;
  const includeStorageManifest = params.config?.includeStorageManifest ?? storedCfg.includeStorageManifest ?? true;

  const backupId = `bkp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const superAdmins = await resolveSuperAdminRecipients().catch(() => []);
  const intSnap = await adminDb.collection('settings').doc('integrations').get().catch(() => null);
  const emailEnabled = intSnap?.exists ? intSnap.data()?.emailEnabled !== false : true;

  try {
    const collections = await readCurrentCollectionsFromAdmin();
    let storageManifest: StorageManifestItem[] = [];
    if (includeStorageManifest && adminBucket) {
      try {
        const [files] = await adminBucket.getFiles({ maxResults: 1000 });
        storageManifest = files
          .filter((f) => !f.name.startsWith('backups/'))
          .map((f) => ({
            path: f.name,
            sizeBytes: Number(f.metadata?.size || 0),
            contentType: String(f.metadata?.contentType || 'application/octet-stream'),
            updatedAt: String(f.metadata?.updated || f.metadata?.timeCreated || ''),
          }));
      } catch {
        storageManifest = [];
      }
    }

    const built = await buildBackupBundle({
      collections,
      storageManifest,
      trigger: params.trigger,
      frequency,
      exportedBy: params.actorEmail,
      firebaseProjectId: firebaseConfig.projectId,
      firestoreDatabaseId: firebaseConfig.firestoreDatabaseId || '(default)',
    });

    let storagePath = 'firestore-inline';
    if (adminBucket) {
      try {
        const remotePath = `backups/${backupId}.json`;
        await adminBucket.file(remotePath).save(Buffer.from(built.rawJson, 'utf8'), {
          resumable: false,
          contentType: 'application/json',
          metadata: { metadata: { checksumSha256: built.checksumSha256, trigger: params.trigger } },
        });
        storagePath = remotePath;
      } catch {
        storagePath = 'firestore-inline';
      }
    }

    const nowIso = built.bundle.exportedAt;
    await adminDb.collection('backupHistory').doc(backupId).set({
      id: backupId,
      trigger: params.trigger,
      frequency,
      status: 'success',
      checksumSha256: built.checksumSha256,
      storagePath,
      storageFileCount: storageManifest.length,
      totalRecords: built.totalRecords,
      sizeBytes: built.sizeBytes,
      collectionCounts: built.collectionCounts,
      ...(built.sizeBytes <= 700_000 ? { snapshotJson: built.rawJson } : {}),
      createdByUid: params.actorUid,
      createdByEmail: params.actorEmail,
      createdAt: FieldValue.serverTimestamp(),
    });

    await adminDb.collection('settings').doc('backupConfig').set(
      {
        id: 'backupConfig',
        enabled: storedCfg.enabled ?? true,
        frequency,
        retentionDays,
        retentionMaxCount,
        notifyOnSuccess,
        notifyOnFailure,
        includeStorageManifest,
        lastBackupAt: nowIso,
        lastBackupStatus: 'success',
        lastBackupId: backupId,
        updatedByUid: params.actorUid,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const historySnap = await adminDb.collection('backupHistory').get();
    const pruneInput = historySnap.docs.map((d) => {
      const data = d.data();
      const createdAt = serializeFirestoreValue(data.createdAt);
      return {
        id: d.id,
        status: (data.status as 'success' | 'failed') || 'success',
        timestampIso: typeof createdAt === 'string' ? createdAt : nowIso,
      };
    });
    const prunedIds = selectBackupsToPrune(pruneInput, retentionDays, retentionMaxCount);
    for (const delId of prunedIds) {
      const targetDoc = historySnap.docs.find((d) => d.id === delId)?.data();
      if (adminBucket && targetDoc?.storagePath && String(targetDoc.storagePath).startsWith('backups/')) {
        await adminBucket.file(String(targetDoc.storagePath)).delete({ ignoreNotFound: true }).catch(() => {});
      }
      await adminDb.collection('backupHistory').doc(delId).delete();
    }

    if (notifyOnSuccess) {
      for (const admin of superAdmins) {
        await createSystemNotificationIfMissing({
          id: `backup_ok_${backupId}_${admin.uid}`.slice(0, 128),
          recipientUid: admin.uid,
          recipientEmail: admin.email,
          title: `Backup completed (${params.trigger})`,
          message: `ACE HRMS backup ${backupId} succeeded with ${built.totalRecords} Firestore record(s) and ${storageManifest.length} Storage file manifest entries. SHA-256: ${built.checksumSha256.slice(0, 16)}...`,
          type: 'system',
          linkTab: 'settings',
          emailEnabled,
        });
      }
    }

    return {
      backupId,
      checksumSha256: built.checksumSha256,
      totalRecords: built.totalRecords,
      storageFileCount: storageManifest.length,
      sizeBytes: built.sizeBytes,
      storagePath,
      prunedIds,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!isPermissionDeniedError(err)) {
      await adminDb.collection('backupHistory').doc(backupId).set({
        id: backupId,
        trigger: params.trigger,
        frequency,
        status: 'failed',
        checksumSha256: '',
        storagePath: 'none',
        storageFileCount: 0,
        totalRecords: 0,
        sizeBytes: 0,
        collectionCounts: {},
        errorMessage: errMsg.slice(0, 500),
        createdByUid: params.actorUid,
        createdByEmail: params.actorEmail,
        createdAt: FieldValue.serverTimestamp(),
      }).catch(() => {});

      if (notifyOnFailure) {
        for (const admin of superAdmins) {
          await createSystemNotificationIfMissing({
            id: `backup_err_${backupId}_${admin.uid}`.slice(0, 128),
            recipientUid: admin.uid,
            recipientEmail: admin.email,
            title: `Backup failed (${params.trigger})`,
            message: `ACE HRMS backup ${backupId} failed: ${errMsg.slice(0, 400)}`,
            type: 'system',
            linkTab: 'settings',
            emailEnabled,
          }).catch(() => {});
        }
      }
    }
    throw err;
  }
}

const lastSchedulerErrorLog = new Map<string, number>();
function logSchedulerError(jobName: string, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  const isPermDenied = msg.includes('PERMISSION_DENIED') || msg.includes('7 PERMISSION_DENIED');
  if (isPermDenied) {
    const key = `${jobName}:perm`;
    const last = lastSchedulerErrorLog.get(key) || 0;
    if (Date.now() - last < 60 * 60 * 1000) return;
    lastSchedulerErrorLog.set(key, Date.now());
    console.warn(`[${jobName}] Firestore Admin SDK lacks IAM permissions in this environment (throttled 1h): ${msg}`);
    return;
  }
  console.error(`${jobName} error:`, error);
}

function resolveCurrentAppUrl(req?: Request): string {
  const customDomain = process.env.CUSTOM_DOMAIN?.trim();
  if (customDomain) {
    return /^https?:\/\//i.test(customDomain) ? customDomain : `https://${customDomain}`;
  }
  const envUrl = process.env.APP_URL?.trim();
  if (envUrl && envUrl !== 'MY_APP_URL') {
    return envUrl.replace(/\/$/, '');
  }
  if (req) {
    const protoHeader = req.headers['x-forwarded-proto'];
    const proto = (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader)?.split(',')[0]?.trim() || req.protocol || 'http';
    const hostHeader = req.headers['x-forwarded-host'] || req.get('host');
    const host = (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader)?.split(',')[0]?.trim();
    if (host) {
      return `${proto}://${host}`;
    }
  }
  return `http://localhost:${Number(process.env.PORT) || 3000}`;
}

const sendEmailSchema = z.object({
  to: z.string().email().max(254),
  subject: z.string().min(2).max(200),
  title: z.string().min(2).max(160),
  message: z.string().min(2).max(4000),
  actionLabel: z.string().max(80).optional(),
});

const payrollInputSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  currency: z.string().min(3).max(6),
  workingDaysPerMonth: z.number().min(1).max(31),
  overtimeMultiplier: z.number().min(1).max(5),
  unpaidLeaveDeductionEnabled: z.boolean(),
  items: z.array(z.object({
    employeeId: z.string().min(1).max(128),
    uid: z.string().max(128).optional().default(''),
    employeeCode: z.string().max(32),
    employeeName: z.string().max(120),
    departmentId: z.string().max(128),
    departmentName: z.string().max(120),
    designation: z.string().max(120),
    basicSalary: z.number().min(0),
    hraAllowance: z.number().min(0),
    transportAllowance: z.number().min(0),
    specialAllowance: z.number().min(0),
    bonus: z.number().min(0),
    incentives: z.number().min(0),
    deductions: z.number().min(0),
    overtimeHourlyRate: z.number().min(0),
    overtimeHours: z.number().min(0),
    unpaidLeaveDays: z.number().min(0),
    customRuleAdjustment: z.number().optional().default(0),
  })),
});


function dateInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function timeInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}
function minutesOfDay(value: string | undefined, fallback: number): number {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return fallback;
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}
async function loadActiveEmployee(uid: string, email?: string) {
  const roleSnap = await adminDb.collection('roles').doc(uid).get();
  const isBootstrapOwner = email === 'awe.prianshu@gmail.com';
  const roleData = roleSnap.data();
  if (!isBootstrapOwner && (!roleSnap.exists || roleData?.status !== 'active')) {
    throw new Error('Active HRMS membership required.');
  }
  let employeeSnap = await adminDb.collection('employees').where('uid', '==', uid).limit(1).get();
  if (employeeSnap.empty && email) employeeSnap = await adminDb.collection('employees').where('email', '==', email).limit(1).get();
  const employee = employeeSnap.empty ? null : employeeSnap.docs[0]!.data();
  const userSnap = await adminDb.collection('users').doc(uid).get();
  const user = userSnap.data() || {};
  const settingsSnap = await adminDb.collection('settings').doc('workPolicy').get();
  const policy: Record<string, any> = settingsSnap.data() || {};
  const timezone = employee?.timezone || policy.officeTimezone || 'Asia/Kolkata';
  return {
    role: (roleData?.role as string) || (isBootstrapOwner ? 'super_admin' : 'employee'),
    employeeId: employee?.id || employeeSnap.docs[0]?.id || uid,
    employeeName: employee?.fullName || user.displayName || 'Employee',
    departmentId: employee?.departmentId || roleData?.departmentId || (isBootstrapOwner ? '__executive_private__' : 'unassigned'),
    timezone,
    countryCode: employee?.countryCode || 'IN',
    policy: { ...policy, workStartTime: employee?.shiftStartTime || policy.workStartTime, workEndTime: employee?.shiftEndTime || policy.workEndTime } as Record<string, any>,
  };
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '8mb' }));

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Math.max(20, Number(process.env.RATE_LIMIT_MAX || 120)),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many API requests from this client. Please retry shortly.' },
  });
  const notifyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Notification dispatch rate limit exceeded.' },
  });
  app.use('/api/', apiLimiter);

  // Security headers compatible with iframe preview and future custom domain deployments
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.get('/api/time', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ timestamp: new Date().toISOString(), timezone: 'UTC' });
  });


  app.post('/api/attendance/break-start', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user?.emailVerified) { res.status(403).json({ error: 'Verified email required.' }); return; }
      const type = z.enum(['Lunch', 'Tea/Short', 'Personal']).safeParse(req.body?.type);
      if (!type.success) { res.status(400).json({ error: 'Choose a valid break type.' }); return; }
      const uid = req.user.uid;
      const employee = await loadActiveEmployee(uid, req.user.email);
      const now = new Date();
      const date = dateInTimezone(now, employee.timezone);
      const attendanceRef = adminDb.collection('attendance').doc(`${uid}_${date}`);
      const id = `brk_${uid}_${now.getTime()}`;
      const breakRef = adminDb.collection('breakSessions').doc(id);
      await adminDb.runTransaction(async (tx) => {
        const [attendanceSnap, activeBreaks, activeMeetings] = await Promise.all([
          tx.get(attendanceRef),
          tx.get(adminDb.collection('breakSessions').where('uid', '==', uid)),
          tx.get(adminDb.collection('meetingLogs').where('uid', '==', uid).where('date', '==', date).where('status', '==', 'active')),
        ]);
        if (!attendanceSnap.exists || attendanceSnap.data()?.checkOutTime) throw new Error('Check in before starting a break.');
        if (activeBreaks.docs.some((d) => d.data().date === date && d.data().status === 'active')) throw new Error('You already have an active break.');
        if (!activeMeetings.empty) throw new Error('End your meeting before starting a break.');
        tx.create(breakRef, {
          id, uid, employeeName: employee.employeeName, departmentId: employee.departmentId,
          date, type: type.data, startAt: now.toISOString(), status: 'active',
          createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        });
      });
      res.json({ success: true, id, startAt: now.toISOString(), date });
    } catch (error) {
      const iamBlocked = isPermissionDeniedError(error);
      res.status(iamBlocked ? 503 : 400).json({ error: error instanceof Error ? error.message : 'Unable to start break.', iamBlocked });
    }
  });

  app.post('/api/attendance/break-end', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user?.emailVerified) { res.status(403).json({ error: 'Verified email required.' }); return; }
      const uid = req.user.uid;
      const employee = await loadActiveEmployee(uid, req.user.email);
      const now = new Date();
      const date = dateInTimezone(now, employee.timezone);
      const activeQuery = adminDb.collection('breakSessions').where('uid', '==', uid);
      const allBreaks = await activeQuery.get();
      const activeDocs = allBreaks.docs.filter((d) => d.data().date === date && d.data().status === 'active');
      const snap = { docs: activeDocs, empty: activeDocs.length === 0, size: activeDocs.length };
      if (snap.empty) throw new Error('There is no active break.');
      if (snap.size > 1) throw new Error('Multiple active breaks found. Contact HR before continuing.');
      const ref = snap.docs[0]!.ref;
      await ref.update({ endAt: now.toISOString(), status: 'ended', updatedAt: FieldValue.serverTimestamp() });
      res.json({ success: true, endAt: now.toISOString(), elapsedMinutes: Math.max(0, Math.round((now.getTime() - new Date(String(snap.docs[0]!.data().startAt)).getTime()) / 60000)) });
    } catch (error) {
      const iamBlocked = isPermissionDeniedError(error);
      res.status(iamBlocked ? 503 : 400).json({ error: error instanceof Error ? error.message : 'Unable to end break.', iamBlocked });
    }
  });

  app.post('/api/attendance/check-in', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user?.emailVerified) { res.status(403).json({ error: 'Verified email required.' }); return; }
      const uid = req.user.uid;
      const employee = await loadActiveEmployee(uid, req.user.email);
      const now = new Date();
      const date = dateInTimezone(now, employee.timezone);
      const recordId = `${uid}_${date}`;
      const startMinutes = minutesOfDay(employee.policy.workStartTime, 570);
      const graceMinutes = Number(employee.policy.graceMinutes ?? 15);
      const currentMinutes = Number(timeInTimezone(now, employee.timezone).slice(0,2)) * 60 + Number(timeInTimezone(now, employee.timezone).slice(3,5));
      const lateMinutes = Math.max(0, currentMinutes - startMinutes - graceMinutes);
      const historySnap = lateMinutes > 0 ? await adminDb.collection('attendance').where('uid','==',uid).get() : null;
      const priorLateMarks = historySnap?.docs.filter((d) => {
        const record = d.data();
        return record.date < date && String(record.date).slice(0,7) === date.slice(0,7) && record.isLate === true;
      }).length || 0;
      const lateMarkCount = lateMinutes > 0 ? priorLateMarks + 1 : priorLateMarks;
      const lateMarksThreshold = Math.max(1, Number(employee.policy.lateMarksThreshold ?? 3));
      const latePenaltyReached = lateMinutes > 0 && lateMarkCount >= lateMarksThreshold;
      const lateMarksAction = employee.policy.lateMarksAction === 'lop' ? 'lop' : 'half_day';
      const attendanceStatus = latePenaltyReached && lateMarksAction === 'half_day' ? 'half_day' : lateMinutes > 0 ? 'late' : 'present';
      const latePenaltyDays = latePenaltyReached ? 0.5 : 0;
      const attendanceNotes = latePenaltyReached ? `Late mark threshold (${lateMarksThreshold}) reached; ${lateMarksAction === 'lop' ? '0.5 LOP day' : 'half-day'} applied.` : '';
      const recordRef = adminDb.collection('attendance').doc(recordId);
      await adminDb.runTransaction(async (tx) => {
        const [existing, activeBreaks] = await Promise.all([
          tx.get(recordRef),
          tx.get(adminDb.collection('breakSessions').where('uid', '==', uid)),
        ]);
        if (existing.exists) throw new Error('You are already checked in for today.');
        if (activeBreaks.docs.some((d) => d.data().date === date && d.data().status === 'active')) throw new Error('An active break exists. End it before checking in.');
        tx.create(recordRef, {
          id: recordId, uid, employeeId: employee.employeeId, employeeName: employee.employeeName,
          departmentId: employee.departmentId, date, checkInTime: now.toISOString(), checkOutTime: '',
          lunchStartTime: '', lunchEndTime: '', actualLunchMinutes: 0, breakMinutes: 0, workingMinutes: 0,
          lateMinutes, latePenaltyDays, earlyDepartureMinutes: 0, officeTimezone: employee.timezone,
          status: attendanceStatus, isLate: lateMinutes > 0, isEarlyDeparture: false,
          notes: attendanceNotes, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        });
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, recordId, checkInTime: now.toISOString(), date, timezone: employee.timezone, lateMinutes, lateMarkCount, latePenaltyDays, status: attendanceStatus });
    } catch (error) {
      const iamBlocked = isPermissionDeniedError(error);
      res.status(iamBlocked ? 503 : 400).json({ error: error instanceof Error ? error.message : 'Unable to check in.', iamBlocked });
    }
  });

  app.post('/api/attendance/check-out', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user?.emailVerified) { res.status(403).json({ error: 'Verified email required.' }); return; }
      const uid = req.user.uid;
      const employee = await loadActiveEmployee(uid, req.user.email);
      const now = new Date();
      const date = dateInTimezone(now, employee.timezone);
      const recordRef = adminDb.collection('attendance').doc(`${uid}_${date}`);
      const startMinutes = minutesOfDay(employee.policy.workStartTime, 570);
      const endMinutes = minutesOfDay(employee.policy.workEndTime, 1110);
      const halfDayThresholdBase = Number(employee.policy.halfDayThresholdMinutes ?? 270);
      const result = await adminDb.runTransaction(async (tx) => {
        const recordSnap = await tx.get(recordRef);
        if (!recordSnap.exists) throw new Error('Check in before checking out.');
        const record = recordSnap.data()!;
        if (record.uid !== uid) throw new Error('You can only check out your own attendance.');
        if (record.checkOutTime) throw new Error('You are already checked out.');
        const breaksQuery = adminDb.collection('breakSessions').where('uid', '==', uid);
        const approvedLeaveQuery = adminDb.collection('leaveRequests').where('uid', '==', uid);
        const reportsQuery = adminDb.collection('dailyWorkReports').where('uid', '==', uid);
        const [breakSnap, leaveSnap, reportSnap] = await Promise.all([tx.get(breaksQuery), tx.get(approvedLeaveQuery), tx.get(reportsQuery)]);
        const breakRows = breakSnap.docs.map((d) => d.data()).filter((b) => b.date === date);
        const hasApprovedHalfDay = leaveSnap.docs.some((leaveDoc) => {
          const leave = leaveDoc.data();
          return leave.status === 'approved' && leave.startDate <= date && leave.endDate >= date && ['first_half', 'second_half'].includes(leave.dayPart);
        });
        if (employee.policy.requireDailyWorkReportBeforeCheckout === true
          && !reportSnap.docs.some((reportDoc) => reportDoc.data().date === date && ['submitted', 'approved'].includes(String(reportDoc.data().reviewStatus)))) {
          throw new Error('Submit your daily work report before checking out. Your company policy requires it.');
        }
        const halfDayThreshold = hasApprovedHalfDay ? Math.ceil(halfDayThresholdBase / 2) : halfDayThresholdBase;
        if (breakRows.some((b) => b.status === 'active')) throw new Error('End your active break before checking out.');
        const checkIn = new Date(String(record.checkInTime || ''));
        if (!Number.isFinite(checkIn.getTime()) || now <= checkIn) throw new Error('Invalid check-in timestamp.');
        const completed = breakRows.filter((b) => b.endAt && b.startAt);
        const hasLunchSession = completed.some((b) => b.type === 'Lunch');
        const breakMinutesFromSessions = completed.reduce((sum, b) => sum + Math.max(0, Math.round((new Date(String(b.endAt)).getTime() - new Date(String(b.startAt)).getTime()) / 60000)), 0);
        const legacyLunch = hasLunchSession ? 0 : Number(record.actualLunchMinutes || 0);
        const elapsedMinutes = Math.max(0, Math.round((now.getTime() - checkIn.getTime()) / 60000));
        const breakMinutes = Math.min(elapsedMinutes, breakMinutesFromSessions + legacyLunch);
        const workingMinutes = Math.max(0, elapsedMinutes - breakMinutes);
        const localTime = timeInTimezone(now, employee.timezone);
        const outMinutes = Number(localTime.slice(0,2)) * 60 + Number(localTime.slice(3,5));
        const earlyDepartureMinutes = Math.max(0, endMinutes - outMinutes);
        const isEarlyDeparture = earlyDepartureMinutes > 0;
        const status = resolveCheckoutStatus({
          currentStatus: String(record.status || 'present'),
          workingMinutes,
          halfDayThreshold,
          isEarlyDeparture,
        });
        tx.update(recordRef, {
          checkOutTime: now.toISOString(), breakMinutes, workingMinutes, isEarlyDeparture,
          earlyDepartureMinutes, officeTimezone: employee.timezone, status,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return { checkOutTime: now.toISOString(), breakMinutes, workingMinutes, earlyDepartureMinutes, status, timezone: employee.timezone };
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, ...result });
    } catch (error) {
      const iamBlocked = isPermissionDeniedError(error);
      res.status(iamBlocked ? 503 : 400).json({ error: error instanceof Error ? error.message : 'Unable to check out.', iamBlocked });
    }
  });



  app.post('/api/holidays/select-optional', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user?.emailVerified) { res.status(403).json({ error: 'Verified email required.' }); return; }
      const uid = req.user.uid;
      const employee = await loadActiveEmployee(uid, req.user.email);
      const holidayId = String(req.body?.holidayId || '');
      if (!holidayId) { res.status(400).json({ error: 'Holiday ID is required.' }); return; }
      const holidayRef = adminDb.collection('holidays').doc(holidayId);
      const holidaySnap = await holidayRef.get();
      if (!holidaySnap.exists || holidaySnap.data()?.type !== 'optional') { res.status(404).json({ error: 'Optional holiday not found.' }); return; }
      const holiday = holidaySnap.data()!;
      if (holiday.countryCode && holiday.countryCode !== employee.countryCode) { res.status(403).json({ error: 'This optional holiday belongs to a different employee country/location.' }); return; }
      const year = String(holiday.date || '').slice(0,4);
      const policySnap = await adminDb.collection('settings').doc('workPolicy').get();
      const maxSelections = Math.max(0, Math.min(10, Number(policySnap.data()?.maxOptionalHolidays ?? 2)));
      const selectionId = `${uid}_${holidayId}`.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,128);
      const selectionRef = adminDb.collection('optionalHolidaySelections').doc(selectionId);
      const selectedCount = await adminDb.runTransaction(async (transaction) => {
        const [existingSelection, selectionsSnap] = await Promise.all([
          transaction.get(selectionRef),
          transaction.get(adminDb.collection('optionalHolidaySelections').where('uid','==',uid)),
        ]);
        if (existingSelection.exists) return selectionsSnap.docs.filter((d) => String(d.data().year) === year).length;
        const selectedThisYear = selectionsSnap.docs.filter((d) => String(d.data().year) === year);
        if (selectedThisYear.length >= maxSelections) throw new Error(`You can select up to ${maxSelections} optional holiday(s) in ${year}.`);
        transaction.create(selectionRef, {
          id: selectionId, uid, employeeName: employee.employeeName,
          departmentId: employee.departmentId, holidayId, holidayName: holiday.name,
          date: holiday.date, year, selectedAt: FieldValue.serverTimestamp(),
        });
        return selectedThisYear.length + 1;
      });
      res.json({ success: true, selected: true, selectedCount, maxSelections });
    } catch (error) {
      const iamBlocked = isPermissionDeniedError(error);
      res.status(iamBlocked ? 503 : 400).json({ error: error instanceof Error ? error.message : 'Unable to select optional holiday.', iamBlocked });
    }
  });

  app.post('/api/monitoring/consent', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user?.emailVerified) { res.status(403).json({ error: 'Verified email required.' }); return; }
      if (req.body?.accepted !== true || req.body?.disclosureAccepted !== true) { res.status(400).json({ error: 'Explicit monitoring consent is required.' }); return; }
      const employee = await loadActiveEmployee(req.user.uid, req.user.email);
      const consentRef = adminDb.collection('monitoringConsents').doc(req.user.uid);
      await consentRef.set({
        uid: req.user.uid, employeeName: employee.employeeName, departmentId: employee.departmentId,
        email: req.user.email || '', accepted: true, policyVersion: String(req.body.policyVersion || '2026-11-21'),
        disclosureAccepted: true, consentedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      const auditId = `monitoring_consent_${req.user.uid}_${Date.now()}`.slice(0,128);
      await adminDb.collection('auditLogs').doc(auditId).set({
        id: auditId, actorUid: req.user.uid, actorEmail: req.user.email || '', actorRole: employee.role,
        action: 'MONITORING_CONSENT_ACCEPTED', targetCollection: 'monitoringConsents', targetId: req.user.uid,
        summary: `Employee accepted monitoring policy ${String(req.body.policyVersion || '2026-11-21')}`,
        createdAt: FieldValue.serverTimestamp(),
      });
      res.json({ success: true, consented: true });
    } catch (error) {
      const iamBlocked = isPermissionDeniedError(error);
      res.status(iamBlocked ? 503 : 400).json({ error: error instanceof Error ? error.message : 'Unable to save consent.', iamBlocked });
    }
  });


  app.post('/api/monitoring/consent/revoke', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user?.emailVerified) { res.status(403).json({ error: 'Verified email required.' }); return; }
      const employee = await loadActiveEmployee(req.user.uid, req.user.email);
      await adminDb.collection('monitoringConsents').doc(req.user.uid).set({
        uid: req.user.uid, employeeName: employee.employeeName, departmentId: employee.departmentId,
        accepted: false, revokedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      const auditId = `monitoring_consent_revoked_${req.user.uid}_${Date.now()}`.slice(0,128);
      await adminDb.collection('auditLogs').doc(auditId).set({
        id: auditId, actorUid: req.user.uid, actorEmail: req.user.email || '', actorRole: employee.role,
        action: 'MONITORING_CONSENT_REVOKED', targetCollection: 'monitoringConsents', targetId: req.user.uid,
        summary: 'Employee withdrew desktop monitoring consent.',
        createdAt: FieldValue.serverTimestamp(),
      });
      res.json({ success: true, consented: false });
    } catch (error) {
      const iamBlocked = isPermissionDeniedError(error);
      res.status(iamBlocked ? 503 : 400).json({ error: error instanceof Error ? error.message : 'Unable to withdraw consent.', iamBlocked });
    }
  });

  app.get('/api/monitoring/state', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user?.emailVerified) { res.status(403).json({ error: 'Verified email required.' }); return; }
      const uid = req.user.uid;
      const employee = await loadActiveEmployee(uid, req.user.email);
      const date = dateInTimezone(new Date(), employee.timezone);
      const [consentSnap, attendanceSnap, breakSnap, meetingSnap] = await Promise.all([
        adminDb.collection('monitoringConsents').doc(uid).get(),
        adminDb.collection('attendance').doc(`${uid}_${date}`).get(),
        adminDb.collection('breakSessions').where('uid','==',uid).get(),
        adminDb.collection('meetingLogs').where('uid','==',uid).get(),
      ]);
      const attendance = attendanceSnap.data();
      const breaks = breakSnap.docs.map((d) => d.data()).filter((b) => b.date === date);
      const meetings = meetingSnap.docs.map((d) => d.data()).filter((m) => m.date === date);
      const consent = consentSnap.data();
      const hasConsent = consent?.accepted === true;
      const checkedIn = Boolean(attendance?.checkInTime) && !attendance?.checkOutTime;
      const onBreak = breaks.some((b) => b.status === 'active');
      const meeting = meetings.some((m) => m.status === 'active');
      const monitoringAllowed = hasConsent && checkedIn && !onBreak;
      let message = 'Monitoring is waiting for check-in.';
      let state = 'waiting';
      if (!hasConsent) { message = 'Employee monitoring consent is required.'; state = 'consent_required'; }
      else if (!checkedIn) { message = 'Monitoring is OFF outside checked-in working hours.'; state = 'waiting'; }
      else if (onBreak) { message = 'Monitoring paused during the recorded break.'; state = 'paused'; }
      else { message = 'Monitoring ON during recorded working hours.'; state = 'monitoring'; }
      res.setHeader('Cache-Control','no-store');
      res.json({ monitoringAllowed, state, message, date, timezone: employee.timezone, meeting, detail: onBreak ? 'Break is active.' : meeting ? 'Meeting is logged; monitoring remains active.' : '' });
    } catch (error) {
      const iamBlocked = isPermissionDeniedError(error);
      res.status(iamBlocked ? 503 : 400).json({ error: error instanceof Error ? error.message : 'Unable to read monitoring state.', iamBlocked });
    }
  });

  app.post('/api/monitoring/heartbeat', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user?.emailVerified) { res.status(403).json({ error: 'Verified email required.' }); return; }
      const uid = req.user.uid;
      const employee = await loadActiveEmployee(uid, req.user.email);
      const state = await adminDb.collection('monitoringConsents').doc(uid).get();
      if (state.data()?.accepted !== true) { res.status(403).json({ error: 'Monitoring consent required.' }); return; }
      const date = dateInTimezone(new Date(), employee.timezone);
      const now = new Date();
      const id = uid;
      await adminDb.collection('monitoringAgentStatus').doc(id).set({
        uid, employeeName: employee.employeeName, departmentId: employee.departmentId,
        date, lastHeartbeat: now.toISOString(), agentVersion: String(req.body?.agentVersion || ''),
        state: String(req.body?.state || 'unknown'), updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      res.json({ success: true, lastHeartbeat: now.toISOString() });
    } catch (error) {
      const iamBlocked = isPermissionDeniedError(error);
      res.status(iamBlocked ? 503 : 400).json({ error: error instanceof Error ? error.message : 'Unable to save monitoring heartbeat.', iamBlocked });
    }
  });

  app.post('/api/monitoring/snapshot', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user?.emailVerified) { res.status(403).json({ error: 'Verified email required.' }); return; }
      if (!adminBucket) { res.status(503).json({ error: 'Firebase Storage bucket is not configured for the monitoring agent.' }); return; }
      const uid = req.user.uid;
      const employee = await loadActiveEmployee(uid, req.user.email);
      const consentSnap = await adminDb.collection('monitoringConsents').doc(uid).get();
      if (consentSnap.data()?.accepted !== true) { res.status(403).json({ error: 'Monitoring consent required.' }); return; }
      const now = new Date();
      const date = dateInTimezone(now, employee.timezone);
      const attendanceSnap = await adminDb.collection('attendance').doc(`${uid}_${date}`).get();
      if (!attendanceSnap.exists || !attendanceSnap.data()?.checkInTime || attendanceSnap.data()?.checkOutTime) {
        res.status(409).json({ error: 'Monitoring is only allowed during checked-in working hours.' }); return;
      }
      const breakSnap = await adminDb.collection('breakSessions').where('uid','==',uid).get();
      if (breakSnap.docs.some((d) => d.data().date === date && d.data().status === 'active')) {
        res.status(409).json({ error: 'Monitoring pauses during recorded breaks.' }); return;
      }
      const encoded = String(req.body?.screenshotBase64 || '');
      if (!encoded || encoded.length > 7_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        res.status(400).json({ error: 'Invalid or oversized screenshot payload.' }); return;
      }
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length > 5 * 1024 * 1024) { res.status(413).json({ error: 'Screenshot exceeds the 5 MB limit.' }); return; }
      const snapshotId = `shot_${uid}_${now.getTime()}`.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,128);
      const storagePath = `monitoring/${uid}/${date}/${snapshotId}.png`;
      const file = adminBucket.file(storagePath);
      await file.save(bytes, { resumable: false, contentType: 'image/png', metadata: { metadata: { employeeUid: uid, snapshotId } } });
      await adminDb.collection('monitoringSnapshots').doc(snapshotId).set({
        id: snapshotId, uid, employeeName: employee.employeeName, departmentId: employee.departmentId,
        date, capturedAt: now.toISOString(), timestampMs: now.getTime(), storagePath,
        activeApp: String(req.body?.activeApp || 'Unknown').slice(0,160),
        windowTitle: String(req.body?.windowTitle || '').slice(0,300),
        idleSeconds: Math.max(0, Math.min(86400, Number(req.body?.idleSeconds || 0))),
        activityPercent: Math.max(0, Math.min(100, Number(req.body?.activityPercent || 0))),
        createdAt: FieldValue.serverTimestamp(),
      });
      res.json({ success: true, snapshotId, capturedAt: now.toISOString() });
    } catch (error) {
      const iamBlocked = isPermissionDeniedError(error);
      res.status(iamBlocked ? 503 : 400).json({ error: error instanceof Error ? error.message : 'Unable to save screenshot.', iamBlocked });
    }
  });

  app.post('/api/monitoring/snapshot-url', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user?.emailVerified) { res.status(403).json({ error: 'Verified email required.' }); return; }
      const snapshotId = String(req.body?.snapshotId || '');
      const snapshotSnap = await adminDb.collection('monitoringSnapshots').doc(snapshotId).get();
      if (!snapshotSnap.exists) { res.status(404).json({ error: 'Snapshot not found.' }); return; }
      const snapshot = snapshotSnap.data()!;
      const roleSnap = await adminDb.collection('roles').doc(req.user.uid).get();
      const role = roleSnap.data();
      const isManager = ['super_admin', 'hr_manager'].includes(String(role?.role))
        || (['dept_manager', 'team_lead'].includes(String(role?.role)) && role?.departmentId === snapshot.departmentId)
        || snapshot.uid === req.user.uid;
      if (!role || role.status !== 'active' || !isManager) { res.status(403).json({ error: 'You are not allowed to view this employee screenshot.' }); return; }
      if (!adminBucket) { res.status(503).json({ error: 'Firebase Storage bucket is not configured.' }); return; }
      const [url] = await adminBucket.file(String(snapshot.storagePath)).getSignedUrl({ action: 'read', expires: Date.now() + 60 * 60 * 1000 });
      const auditId = `screenshot_view_${req.user.uid}_${Date.now()}`.slice(0,128);
      await adminDb.collection('auditLogs').doc(auditId).set({
        id: auditId, actorUid: req.user.uid, actorEmail: req.user.email || '', actorRole: String(role.role),
        action: 'SCREENSHOT_VIEWED', targetCollection: 'monitoringSnapshots', targetId: snapshotId,
        summary: `Viewed screenshot for ${String(snapshot.employeeName || snapshot.uid)} captured ${String(snapshot.capturedAt || '')}`,
        createdAt: FieldValue.serverTimestamp(),
      });
      res.json({ url });
    } catch (error) {
      const iamBlocked = isPermissionDeniedError(error);
      res.status(iamBlocked ? 503 : 400).json({ error: error instanceof Error ? error.message : 'Unable to create screenshot URL.', iamBlocked });
    }
  });

  app.get('/api/health', async (req, res) => {
    let adminFirestoreConnected = false;
    let adminFirestoreStatus: 'ok' | 'permission_denied' | 'unauthenticated' | 'timeout' | 'error' = 'error';
    let adminFirestoreErrorCode: string | null = null;
    try {
      await Promise.race([
        adminDb.collection('settings').doc('company').get(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('HEALTH_PROBE_TIMEOUT')), 4000)),
      ]);
      adminFirestoreConnected = true;
      adminFirestoreStatus = 'ok';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const rawCode = (err as { code?: number | string } | null)?.code;
      adminFirestoreErrorCode = rawCode !== undefined ? String(rawCode) : msg === 'HEALTH_PROBE_TIMEOUT' ? 'TIMEOUT' : 'UNKNOWN';
      if (rawCode === 16 || msg.includes('16 UNAUTHENTICATED') || msg.includes('Could not load the default credentials')) {
        adminFirestoreStatus = 'unauthenticated';
      } else if (isPermissionDeniedError(err)) {
        adminFirestoreStatus = 'permission_denied';
      } else if (msg === 'HEALTH_PROBE_TIMEOUT') {
        adminFirestoreStatus = 'timeout';
      } else {
        adminFirestoreStatus = 'error';
      }
    }

    const slackUrl = process.env.SLACK_WEBHOOK_URL?.trim() || '';
    const waToken = process.env.WHATSAPP_TOKEN?.trim() || '';
    const waPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || '';

    res.json({
      status: 'ok',
      product: 'ACE HRMS',
      company: 'ACE Web Experts',
      activeUrl: resolveCurrentAppUrl(req),
      customDomain: process.env.CUSTOM_DOMAIN?.trim() || null,
      smtpConfigured: isSmtpConfigured(),
      firebaseProjectId: firebaseConfig.projectId,
      firestoreDatabaseId: firebaseConfig.firestoreDatabaseId || '(default)',
      serviceAccountConfigured: serviceAccountInfo.configured,
      serviceAccountEnvName: serviceAccountInfo.envName,
      serviceAccountParseStatus: serviceAccountInfo.parseStatus,
      serviceAccountProjectId: serviceAccountInfo.serviceAccountProjectId,
      projectIdConsistent: serviceAccountInfo.projectIdConsistent,
      serviceAccountClientEmailMasked: serviceAccountInfo.maskedClientEmail,
      adminFirestoreConnected,
      adminFirestoreStatus,
      adminFirestoreErrorCode,
      optionalIntegrations: {
        customDomainConfigured: Boolean(process.env.CUSTOM_DOMAIN?.trim()),
        slackConfigured: slackUrl.startsWith('https://hooks.slack.com/'),
        whatsappConfigured: Boolean(waToken && waPhoneId),
      },
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/system/deployment-info', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({
      company: 'ACE Web Experts',
      product: 'ACE HRMS',
      customDomain: process.env.CUSTOM_DOMAIN?.trim() || null,
      appUrl: resolveCurrentAppUrl(req),
      smtpConfigured: isSmtpConfigured(),
      smtpFrom: process.env.SMTP_FROM?.trim() || process.env.SMTP_USER?.trim() || '',
      firebaseProjectId: firebaseConfig.projectId,
      firestoreDatabaseId: firebaseConfig.firestoreDatabaseId || '(default)',
    });
  });

  // Server-Authoritative Leave Governance & Balance APIs
  const adminLeaveStore: LeaveStoreAdapter = {
    async getDoc(collectionName, docId) {
      const snap = await adminDb.collection(collectionName).doc(docId).get();
      return snap.exists ? (snap.data() as Record<string, unknown>) : null;
    },
    async listCollection(collectionName) {
      const snap = await adminDb.collection(collectionName).get();
      return snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
    },
    async queryWhere(collectionName, field, value) {
      const snap = await adminDb.collection(collectionName).where(field, '==', value).get();
      return snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
    },
    async runTransaction(fn) {
      return adminDb.runTransaction(async (tx) => {
        const ctxAdapter = {
          async getDoc(collectionName: string, docId: string) {
            const snap = await tx.get(adminDb.collection(collectionName).doc(docId));
            return snap.exists ? (snap.data() as Record<string, unknown>) : null;
          },
          async queryWhere(collectionName: string, field: string, value: unknown) {
            const snap = await tx.get(adminDb.collection(collectionName).where(field, '==', value));
            return snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
          },
          setDoc(collectionName: string, docId: string, data: Record<string, unknown>) {
            tx.set(adminDb.collection(collectionName).doc(docId), data);
          },
          updateDoc(collectionName: string, docId: string, patch: Record<string, unknown>) {
            tx.update(adminDb.collection(collectionName).doc(docId), patch);
          },
        };
        return fn(ctxAdapter);
      });
    },
    serverTimestamp: () => FieldValue.serverTimestamp(),
    nowIso: () => new Date().toISOString(),
    createId: (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    async dispatchNotification(params) {
      try {
        const intSnap = await adminDb.collection('settings').doc('integrations').get().catch(() => null);
        const emailEnabled = intSnap?.exists ? intSnap.data()?.emailEnabled !== false : true;
        await createSystemNotificationIfMissing({
          id: params.id,
          recipientUid: params.recipientUid,
          recipientEmail: params.recipientEmail,
          title: params.title,
          message: params.message,
          type: 'leave',
          linkTab: params.linkTab,
          emailEnabled,
        });
      } catch {
        // Non-fatal if SMTP/notification dispatch encounters transient error
      }
    },
  };

  function handleLeaveApiError(res: Response, err: unknown, fallback: string) {
    if (err instanceof HttpLeaveError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (isPermissionDeniedError(err)) {
      res.status(503).json({
        error: 'Firebase Admin SDK lacks GCP IAM Firestore permissions in this environment.',
        iamBlocked: true,
      });
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : fallback });
  }

  const leaveApplySchema = z.object({
    leaveType: z.enum(['casual', 'sick', 'paid', 'unpaid', 'emergency', 'short']),
    dayPart: z.enum(['full', 'first_half', 'second_half', 'short']).default('full'),
    shortLeaveHours: z.number().min(1).max(2).optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reason: z.string().min(3).max(500),
    attachmentUrl: z.string().max(1500).optional(),
    attachmentName: z.string().max(200).optional(),
  });

  // Resolve legacy role documents whose Firestore document ID differs only by UID casing.
  // The caller must present a valid Firebase ID token and a verified email.
  app.post('/api/auth/resolve-role', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      if (!user.email || user.emailVerified !== true) {
        res.status(403).json({ error: 'A verified Firebase email is required to resolve the HRMS role.' });
        return;
      }

      const rolesRef = adminDb.collection('roles');
      const canonicalRef = rolesRef.doc(user.uid);
      const canonicalSnap = await canonicalRef.get();
      if (canonicalSnap.exists) {
        res.json({ success: true, migrated: false, role: canonicalSnap.data() });
        return;
      }

      const email = user.email.trim();
      const emailLower = email.toLowerCase();
      const [exactSnap, lowerSnap] = await Promise.all([
        rolesRef.where('email', '==', email).get(),
        emailLower === email ? Promise.resolve(null) : rolesRef.where('email', '==', emailLower).get(),
      ]);

      const candidates = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
      for (const snap of [exactSnap, lowerSnap]) {
        snap?.docs.forEach((candidate) => candidates.set(candidate.id, candidate));
      }

      const allowedRoles = new Set(['employee', 'team_lead', 'dept_manager', 'hr_manager', 'super_admin']);
      const validCandidates = Array.from(candidates.values()).filter((candidate) => {
        const data = candidate.data();
        return candidate.id !== user.uid &&
          typeof data.uid === 'string' && data.uid === candidate.id &&
          typeof data.email === 'string' && data.email.toLowerCase() === emailLower &&
          allowedRoles.has(data.role) &&
          ['active', 'pending', 'inactive'].includes(data.status);
      });

      if (validCandidates.length === 0) {
        res.json({ success: true, migrated: false, role: null, reason: 'No matching legacy role document.' });
        return;
      }

      const activeCandidates = validCandidates.filter((candidate) => candidate.data().status === 'active');
      const selected = activeCandidates.length === 1
        ? activeCandidates[0]
        : activeCandidates.length > 1
          ? null
          : validCandidates.length === 1
            ? validCandidates[0]
            : null;

      if (!selected) {
        res.status(409).json({ error: 'Multiple legacy role records match this account. Manual HR review is required.' });
        return;
      }

      const legacyData = selected.data();
      await adminDb.runTransaction(async (transaction) => {
        const currentCanonical = await transaction.get(canonicalRef);
        if (currentCanonical.exists) return;
        const currentLegacy = await transaction.get(selected.ref);
        if (!currentLegacy.exists) throw new Error('Legacy role record changed during migration.');
        const latest = currentLegacy.data()!;
        if (
          latest.uid !== selected.id ||
          typeof latest.email !== 'string' ||
          latest.email.toLowerCase() !== emailLower ||
          latest.role !== legacyData.role ||
          latest.status !== legacyData.status
        ) {
          throw new Error('Legacy role record no longer matches the authenticated account.');
        }
        transaction.create(canonicalRef, {
          ...latest,
          uid: user.uid,
          email,
          legacyRoleDocId: selected.id,
          createdAt: latest.createdAt || FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });

      const migratedSnap = await canonicalRef.get();
      res.json({ success: true, migrated: migratedSnap.exists, role: migratedSnap.data() || null });
    } catch (error) {
      console.error('[Auth role resolution] Failed:', error instanceof Error ? error.message : 'Unknown error');
      res.status(500).json({
        error: 'Unable to resolve the HRMS role record.',
        details: error instanceof Error ? error.message : 'Unknown server error',
      });
    }
  });

  app.post('/api/leaves/ensure-balance', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const result = await ensureEmployeeLeaveBalance(adminLeaveStore, req.user!);
      res.json({ success: true, ...result });
    } catch (err) {
      handleLeaveApiError(res, err, 'Unable to initialize leave balance.');
    }
  });

  app.post('/api/leaves/migrate-balances', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const result = await migrateLegacyLeaveBalances(adminLeaveStore, req.user!);
      res.json({ success: true, ...result });
    } catch (err) {
      handleLeaveApiError(res, err, 'Unable to migrate legacy leave balances.');
    }
  });

  app.post('/api/leaves/sync-employee-scope', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const body = z.object({ targetUid: z.string().min(1).max(128) }).safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'Valid targetUid is required.' });
        return;
      }
      const result = await syncEmployeeLeaveScope(adminLeaveStore, req.user!, body.data.targetUid);
      res.json({ success: true, ...result });
    } catch (err) {
      handleLeaveApiError(res, err, 'Unable to sync employee leave scope.');
    }
  });

  app.post('/api/leaves/apply', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const parsed = leaveApplySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid leave application payload.', details: parsed.error.flatten() });
        return;
      }
      const result = await submitLeaveRequest(adminLeaveStore, req.user!, parsed.data);
      res.json({ success: true, ...result });
    } catch (err) {
      handleLeaveApiError(res, err, 'Unable to submit leave application.');
    }
  });

  app.post('/api/leaves/:id/resubmit', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const parsed = leaveApplySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid leave resubmission payload.', details: parsed.error.flatten() });
        return;
      }
      const result = await resubmitLeaveRequest(adminLeaveStore, req.user!, String(req.params.id), parsed.data);
      res.json({ success: true, ...result });
    } catch (err) {
      handleLeaveApiError(res, err, 'Unable to resubmit leave request.');
    }
  });

  app.post('/api/leaves/:id/approve', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const comment = typeof req.body?.comment === 'string' ? req.body.comment : undefined;
      const result = await decideLeaveRequest(adminLeaveStore, req.user!, String(req.params.id), 'approved', comment);
      res.json({ success: true, ...result });
    } catch (err) {
      handleLeaveApiError(res, err, 'Unable to approve leave request.');
    }
  });

  app.post('/api/leaves/:id/reject', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const body = z.object({ comment: z.string().min(3).max(500) }).safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'Rejection reason must be between 3 and 500 characters.' });
        return;
      }
      const result = await decideLeaveRequest(adminLeaveStore, req.user!, String(req.params.id), 'rejected', body.data.comment);
      res.json({ success: true, ...result });
    } catch (err) {
      handleLeaveApiError(res, err, 'Unable to reject leave request.');
    }
  });

  app.post('/api/leaves/:id/request-changes', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const body = z.object({ comment: z.string().min(3).max(500) }).safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'Change request note must be between 3 and 500 characters.' });
        return;
      }
      const result = await decideLeaveRequest(adminLeaveStore, req.user!, String(req.params.id), 'changes_requested', body.data.comment);
      res.json({ success: true, ...result });
    } catch (err) {
      handleLeaveApiError(res, err, 'Unable to request leave changes.');
    }
  });

  app.post('/api/leaves/:id/cancel', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const result = await cancelPendingLeaveRequest(adminLeaveStore, req.user!, String(req.params.id));
      res.json({ success: true, ...result });
    } catch (err) {
      handleLeaveApiError(res, err, 'Unable to cancel leave request.');
    }
  });

  const cancelApprovedHandler = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const body = z.object({ reason: z.string().min(3).max(500) }).safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'Cancellation reason must be between 3 and 500 characters.' });
        return;
      }
      const result = await cancelApprovedAndRefundLeave(adminLeaveStore, req.user!, String(req.params.id), body.data.reason);
      res.json({ success: true, ...result });
    } catch (err) {
      handleLeaveApiError(res, err, 'Unable to cancel approved leave.');
    }
  };
  app.post('/api/leaves/:id/cancel-approved', requireAuth, cancelApprovedHandler);
  app.post('/api/leaves/:id/refund', requireAuth, cancelApprovedHandler);

  app.post('/api/leaves/adjust-balance', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const body = z.object({
        targetUid: z.string().min(1).max(128),
        bucket: z.enum(['paidTotal', 'casualTotal', 'sickTotal', 'emergencyTotal', 'paidUsed', 'casualUsed', 'sickUsed', 'emergencyUsed', 'unpaidUsed']),
        mode: z.enum(['add', 'set']),
        value: z.number().finite().min(-365).max(365),
        reason: z.string().min(5).max(400),
      }).safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'Invalid balance adjustment payload.', details: body.error.flatten() });
        return;
      }
      const result = await adjustLeaveBalance(adminLeaveStore, req.user!, {
        targetUid: body.data.targetUid,
        bucket: body.data.bucket as AdjustableBucket,
        mode: body.data.mode,
        value: body.data.value,
        reason: body.data.reason,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      handleLeaveApiError(res, err, 'Unable to adjust leave balance.');
    }
  });

  app.post('/api/leaves/annual-reset', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const body = z.object({
        targetYear: z.number().int().min(2020).max(2100),
        carryForwardEnabled: z.boolean(),
        maxCarryForwardPaid: z.number().min(0).max(60),
      }).safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'Invalid annual reset payload.', details: body.error.flatten() });
        return;
      }
      const result = await executeAnnualLeaveReset(adminLeaveStore, req.user!, body.data);
      res.json({ success: true, ...result });
    } catch (err) {
      handleLeaveApiError(res, err, 'Unable to execute annual leave reset.');
    }
  });

  // Authoritative payroll calculation endpoint
  app.post('/api/payroll/calculate', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.user?.emailVerified) {
      res.status(403).json({ error: 'Verified email required for payroll operations' });
      return;
    }

    try {
      const roleSnap = await adminDb.collection('roles').doc(req.user.uid).get();
      const roleData = roleSnap.data();
      const isBootstrapOwner = req.user.email === 'awe.prianshu@gmail.com';
      if (
        !isBootstrapOwner &&
        (!roleSnap.exists || roleData?.status !== 'active' || !['super_admin', 'hr_manager'].includes(String(roleData?.role)))
      ) {
        res.status(403).json({ error: 'HR Manager or Super Admin role required for payroll calculation.' });
        return;
      }
    } catch (err) {
      if (isPermissionDeniedError(err)) {
        res.status(503).json({
          error: 'Firebase Admin SDK lacks GCP IAM Firestore permissions in this environment.',
          iamBlocked: true,
        });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unable to verify payroll authority.' });
      return;
    }

    const parsed = payrollInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid payroll payload', details: parsed.error.flatten() });
      return;
    }

    const { month, currency, workingDaysPerMonth, overtimeMultiplier, unpaidLeaveDeductionEnabled, items } = parsed.data;

    let totalGross = 0;
    let totalDeductions = 0;
    let totalNet = 0;

    const computed = items.map((item) => {
      const allowances = Number((item.hraAllowance + item.transportAllowance + item.specialAllowance).toFixed(2));
      const overtimePay = Number((item.overtimeHours * item.overtimeHourlyRate * overtimeMultiplier).toFixed(2));
      const grossBase = item.basicSalary + allowances + item.bonus + item.incentives + overtimePay;
      const dailyRate = workingDaysPerMonth > 0 ? (item.basicSalary + allowances) / workingDaysPerMonth : 0;
      const unpaidLeaveDeduction = unpaidLeaveDeductionEnabled
        ? Number((item.unpaidLeaveDays * dailyRate).toFixed(2))
        : 0;
      const customAdj = Number((item.customRuleAdjustment || 0).toFixed(2));
      const otherDeductions = Number((item.deductions + (customAdj < 0 ? Math.abs(customAdj) : 0)).toFixed(2));
      const positiveAdj = customAdj > 0 ? customAdj : 0;

      const grossPay = Number((grossBase + positiveAdj).toFixed(2));
      const itemTotalDeductions = Number((unpaidLeaveDeduction + otherDeductions).toFixed(2));
      const netPay = Number(Math.max(0, grossPay - itemTotalDeductions).toFixed(2));

      totalGross += grossPay;
      totalDeductions += itemTotalDeductions;
      totalNet += netPay;

      return {
        employeeId: item.employeeId,
        uid: item.uid,
        employeeCode: item.employeeCode,
        employeeName: item.employeeName,
        departmentId: item.departmentId,
        departmentName: item.departmentName,
        designation: item.designation,
        month,
        currency,
        basicSalary: item.basicSalary,
        allowances,
        bonuses: item.bonus,
        incentives: item.incentives,
        overtimeHours: item.overtimeHours,
        overtimePay,
        unpaidLeaveDays: item.unpaidLeaveDays,
        unpaidLeaveDeduction,
        otherDeductions,
        grossPay,
        netPay,
      };
    });

    res.json({
      month,
      currency,
      employeeCount: computed.length,
      totalGross: Number(totalGross.toFixed(2)),
      totalDeductions: Number(totalDeductions.toFixed(2)),
      totalNet: Number(totalNet.toFixed(2)),
      payslips: computed,
    });
  });

  app.get('/api/integrations/status', requireAuth, (_req: AuthenticatedRequest, res) => {
    const slackUrl = process.env.SLACK_WEBHOOK_URL?.trim() || '';
    const waToken = process.env.WHATSAPP_TOKEN?.trim() || '';
    const waPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || '';
    res.json({
      smtpConfigured: isSmtpConfigured(),
      slackConfigured: slackUrl.startsWith('https://hooks.slack.com/'),
      whatsappConfigured: Boolean(waToken && waPhoneId),
    });
  });

  app.post('/api/integrations/slack/notify', requireAuth, notifyLimiter, async (req: AuthenticatedRequest, res) => {
    if (!req.user?.emailVerified) {
      res.status(403).json({ sent: false, error: 'Verified email required' });
      return;
    }
    const roleSnap = await adminDb.collection('roles').doc(req.user.uid).get().catch(() => null);
    const roleData = roleSnap?.data();
    if (roleSnap?.exists && (roleData?.status !== 'active' || !['super_admin', 'hr_manager', 'dept_manager', 'team_lead'].includes(String(roleData?.role)))) {
      res.status(403).json({ sent: false, error: 'Manager or HR role required to dispatch Slack alerts.' });
      return;
    }
    const parsed = z.object({
      channel: z.string().max(80).optional().default('#hr-alerts'),
      message: z.string().min(2).max(2000),
    }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ sent: false, error: 'Invalid Slack payload' });
      return;
    }
    const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim() || '';
    if (!webhookUrl.startsWith('https://hooks.slack.com/')) {
      res.json({
        sent: false,
        configured: false,
        reason: 'SLACK_WEBHOOK_URL is not configured on the server.',
      });
      return;
    }
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `[ACE HRMS · ${parsed.data.channel}] ${parsed.data.message}` }),
      });
      res.json({
        sent: response.ok,
        configured: true,
        status: response.status,
        reason: response.ok ? undefined : `Slack webhook returned HTTP ${response.status}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Slack request failed';
      res.status(503).json({
        sent: false,
        configured: true,
        error: msg,
        reason: msg,
      });
    }
  });

  app.post('/api/integrations/whatsapp/notify', requireAuth, notifyLimiter, async (req: AuthenticatedRequest, res) => {
    if (!req.user?.emailVerified) {
      res.status(403).json({ sent: false, error: 'Verified email required' });
      return;
    }
    const roleSnap = await adminDb.collection('roles').doc(req.user.uid).get().catch(() => null);
    const roleData = roleSnap?.data();
    if (roleSnap?.exists && (roleData?.status !== 'active' || !['super_admin', 'hr_manager', 'dept_manager', 'team_lead'].includes(String(roleData?.role)))) {
      res.status(403).json({ sent: false, error: 'Manager or HR role required to dispatch WhatsApp alerts.' });
      return;
    }
    const parsed = z.object({
      to: z.string().min(8).max(20),
      message: z.string().min(2).max(1500),
    }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ sent: false, error: 'Valid E.164 phone number and message are required.' });
      return;
    }
    const token = process.env.WHATSAPP_TOKEN?.trim() || '';
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || '';
    if (!token || !phoneId) {
      res.json({
        sent: false,
        configured: false,
        reason: 'WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are not configured on the server.',
      });
      return;
    }
    const toDigits = parsed.data.to.replace(/[^0-9]/g, '');
    try {
      const response = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(phoneId)}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: toDigits,
          type: 'text',
          text: { body: `[ACE HRMS] ${parsed.data.message}` },
        }),
      });
      res.json({
        sent: response.ok,
        configured: true,
        status: response.status,
        reason: response.ok ? undefined : `WhatsApp Cloud API returned HTTP ${response.status}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'WhatsApp Cloud API request failed';
      res.status(503).json({
        sent: false,
        configured: true,
        error: msg,
        reason: msg,
      });
    }
  });

  // Real SMTP email dispatch (never fakes delivery)
  app.post('/api/notifications/send-email', requireAuth, notifyLimiter, async (req: AuthenticatedRequest, res) => {
    if (!req.user?.emailVerified) {
      res.status(403).json({ delivered: false, error: 'Verified email required' });
      return;
    }

    const parsed = sendEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ delivered: false, error: 'Invalid email request', details: parsed.error.flatten() });
      return;
    }

    const result = await sendSystemEmailIfConfigured({
      ...parsed.data,
      appUrl: resolveCurrentAppUrl(req),
    });
    if (!result.configured || result.delivered) {
      res.json(result);
    } else {
      res.status(503).json({
        ...result,
        error: result.reason || 'SMTP email delivery failed',
      });
    }
  });

  // Super Admin Automatic Backup & Restore APIs
  async function verifySuperAdminCaller(req: AuthenticatedRequest, res: Response): Promise<boolean> {
    if (!req.user?.emailVerified) {
      res.status(403).json({ error: 'Verified email required.' });
      return false;
    }
    try {
      const roleSnap = await adminDb.collection('roles').doc(req.user.uid).get();
      const roleData = roleSnap.data();
      const isBootstrapOwner = req.user.email === 'awe.prianshu@gmail.com';
      if (!isBootstrapOwner && (!roleSnap.exists || roleData?.role !== 'super_admin' || roleData?.status !== 'active')) {
        res.status(403).json({ error: 'Super Admin role required for backup and restore operations.' });
        return false;
      }
      return true;
    } catch (err) {
      if (isPermissionDeniedError(err)) {
        res.status(503).json({
          error: 'Firebase Admin SDK lacks GCP IAM Firestore permissions in this environment.',
          iamBlocked: true,
        });
        return false;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unable to verify Super Admin role.' });
      return false;
    }
  }

  app.get('/api/backups/list', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!(await verifySuperAdminCaller(req, res))) return;
    try {
      const snap = await adminDb.collection('backupHistory').get();
      const items = snap.docs
        .map((d) => {
          const data = serializeFirestoreValue(d.data()) as Record<string, unknown>;
          delete data.snapshotJson;
          return data;
        })
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      res.json({ backups: items });
    } catch (err) {
      res.status(isPermissionDeniedError(err) ? 503 : 500).json({
        error: err instanceof Error ? err.message : 'Unable to list backups.',
        iamBlocked: isPermissionDeniedError(err),
      });
    }
  });

  app.post('/api/backups/run', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!(await verifySuperAdminCaller(req, res))) return;
    try {
      const result = await runAdminBackupJob({
        trigger: 'manual',
        actorUid: req.user!.uid,
        actorEmail: req.user!.email || req.user!.uid,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(isPermissionDeniedError(err) ? 503 : 500).json({
        error: err instanceof Error ? err.message : 'Backup execution failed.',
        iamBlocked: isPermissionDeniedError(err),
      });
    }
  });

  app.get('/api/backups/:id/download', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!(await verifySuperAdminCaller(req, res))) return;
    try {
      const docSnap = await adminDb.collection('backupHistory').doc(String(req.params.id)).get();
      if (!docSnap.exists) {
        res.status(404).json({ error: 'Backup record not found.' });
        return;
      }
      const data = docSnap.data()!;
      if (typeof data.snapshotJson === 'string' && data.snapshotJson.length > 0) {
        res.json({ rawJson: data.snapshotJson });
        return;
      }
      if (adminBucket && data.storagePath && String(data.storagePath).startsWith('backups/')) {
        const [buf] = await adminBucket.file(String(data.storagePath)).download();
        res.json({ rawJson: buf.toString('utf8') });
        return;
      }
      res.status(404).json({ error: 'Backup payload archive is unavailable.' });
    } catch (err) {
      res.status(isPermissionDeniedError(err) ? 503 : 500).json({
        error: err instanceof Error ? err.message : 'Unable to download backup.',
        iamBlocked: isPermissionDeniedError(err),
      });
    }
  });

  async function resolveBackupRawJson(body: { backupId?: string; rawJson?: string }): Promise<string> {
    if (body.rawJson && body.rawJson.trim()) return body.rawJson;
    if (body.backupId) {
      const docSnap = await adminDb.collection('backupHistory').doc(body.backupId).get();
      if (!docSnap.exists) throw new Error('Backup record not found.');
      const data = docSnap.data()!;
      if (typeof data.snapshotJson === 'string' && data.snapshotJson.length > 0) return data.snapshotJson;
      if (adminBucket && data.storagePath && String(data.storagePath).startsWith('backups/')) {
        const [buf] = await adminBucket.file(String(data.storagePath)).download();
        return buf.toString('utf8');
      }
      throw new Error('Stored backup archive payload not found.');
    }
    throw new Error('Provide backupId or rawJson payload.');
  }

  app.post('/api/backups/restore/preview', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!(await verifySuperAdminCaller(req, res))) return;
    try {
      const body = z.object({ backupId: z.string().optional(), rawJson: z.string().optional() }).parse(req.body);
      const rawJson = await resolveBackupRawJson(body);
      const validation = await validateAndVerifyBackupBundle(rawJson);
      const currentCollections = await readCurrentCollectionsFromAdmin();
      const preview = computeRestorePreview(currentCollections, validation.normalizedCollections);
      res.json({ validation, preview });
    } catch (err) {
      res.status(isPermissionDeniedError(err) ? 503 : 400).json({
        error: err instanceof Error ? err.message : 'Unable to preview restore.',
        iamBlocked: isPermissionDeniedError(err),
      });
    }
  });

  app.post('/api/backups/restore/apply', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!(await verifySuperAdminCaller(req, res))) return;
    try {
      const body = z.object({
        backupId: z.string().optional(),
        rawJson: z.string().optional(),
        confirmPhrase: z.string(),
      }).parse(req.body);

      if (body.confirmPhrase !== 'RESTORE') {
        res.status(400).json({ error: 'Confirmation phrase "RESTORE" is required.' });
        return;
      }

      const rawJson = await resolveBackupRawJson(body);
      const validation = await validateAndVerifyBackupBundle(rawJson);
      if (!validation.valid) {
        res.status(400).json({ error: validation.errors.join(' ') || 'Backup validation failed.' });
        return;
      }

      const allowedSet = new Set<string>(RESTORABLE_COLLECTIONS);
      let restoredDocs = 0;
      let batch = adminDb.batch();
      let opsInBatch = 0;

      for (const [colName, entries] of Object.entries(validation.normalizedCollections)) {
        if (!allowedSet.has(colName)) continue;
        for (const entry of entries) {
          const docId = String(entry.__docId || '').replace(/\//g, '_');
          if (!docId) continue;
          const docRef = adminDb.collection(colName).doc(docId);
          batch.set(docRef, { ...entry.data, restoredAt: FieldValue.serverTimestamp() }, { merge: true });
          opsInBatch += 1;
          restoredDocs += 1;
          if (opsInBatch >= 450) {
            await batch.commit();
            batch = adminDb.batch();
            opsInBatch = 0;
          }
        }
      }
      if (opsInBatch > 0) await batch.commit();

      const auditId = `backup_restore_${Date.now()}`.slice(0, 128);
      await adminDb.collection('auditLogs').doc(auditId).set({
        id: auditId,
        actorUid: req.user!.uid,
        actorEmail: req.user!.email || '',
        actorRole: 'super_admin',
        action: 'BACKUP_RESTORED',
        targetCollection: 'backupHistory',
        targetId: body.backupId || 'uploaded_file',
        summary: `Restored ${restoredDocs} document(s) from verified backup (${validation.exportedAt}).`,
        createdAt: FieldValue.serverTimestamp(),
      });

      res.json({ success: true, restoredDocs });
    } catch (err) {
      res.status(isPermissionDeniedError(err) ? 503 : 400).json({
        error: err instanceof Error ? err.message : 'Backup restore failed.',
        iamBlocked: isPermissionDeniedError(err),
      });
    }
  });

  app.delete('/api/backups/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!(await verifySuperAdminCaller(req, res))) return;
    try {
      const ref = adminDb.collection('backupHistory').doc(String(req.params.id));
      const snap = await ref.get();
      if (!snap.exists) {
        res.status(404).json({ error: 'Backup record not found.' });
        return;
      }
      const data = snap.data()!;
      if (adminBucket && data.storagePath && String(data.storagePath).startsWith('backups/')) {
        await adminBucket.file(String(data.storagePath)).delete({ ignoreNotFound: true }).catch(() => {});
      }
      await ref.delete();
      res.json({ success: true });
    } catch (err) {
      res.status(isPermissionDeniedError(err) ? 503 : 500).json({
        error: err instanceof Error ? err.message : 'Unable to delete backup.',
        iamBlocked: isPermissionDeniedError(err),
      });
    }
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api')) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error.' });
      return;
    }
    next(err);
  });

  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(__dirname, 'dist');

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }



  // Alert managers when an employee is checked in but the consented desktop agent stops heartbeating.
  const monitoringOfflineTimer = setInterval(async () => {
    try {
      const [employeesSnap, intSnap] = await Promise.all([
        adminDb.collection('employees').where('status','==','active').get(),
        adminDb.collection('settings').doc('integrations').get(),
      ]);
      const emailEnabled = intSnap.exists ? intSnap.data()?.emailEnabled !== false : true;
      const now = new Date();
      for (const employeeDoc of employeesSnap.docs) {
        const employee = employeeDoc.data();
        const uid = String(employee.uid || '');
        if (!uid) continue;
        const timezone = employee.timezone || 'Asia/Kolkata';
        const date = dateInTimezone(now, timezone);
        const attendanceSnap = await adminDb.collection('attendance').doc(`${uid}_${date}`).get();
        const attendance = attendanceSnap.data();
        if (!attendance?.checkInTime || attendance?.checkOutTime) continue;
        const breakSnap = await adminDb.collection('breakSessions').where('uid','==',uid).get();
        if (breakSnap.docs.some((d) => d.data().date === date && d.data().status === 'active')) continue;
        const consentSnap = await adminDb.collection('monitoringConsents').doc(uid).get();
        if (consentSnap.data()?.accepted !== true) continue;
        const statusSnap = await adminDb.collection('monitoringAgentStatus').doc(uid).get();
        const lastSeen = statusSnap.data()?.lastHeartbeat ? new Date(String(statusSnap.data()!.lastHeartbeat)).getTime() : 0;
        if (lastSeen && now.getTime() - lastSeen < 120000) continue;
        const rolesSnap = await adminDb.collection('roles').where('status','==','active').get();
        const managers = rolesSnap.docs.filter((d) => {
          const role = d.data();
          const roleName = String(role.role);
          return ['super_admin', 'hr_manager', 'dept_manager', 'team_lead'].includes(roleName)
            && (!['dept_manager', 'team_lead'].includes(roleName) || role.departmentId === employee.departmentId);
        });
        for (const managerDoc of managers) {
          const noticeId = `monitoring_agent_offline_${uid}_${date}_${managerDoc.id}`.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,128);
          await createSystemNotificationIfMissing({
            id: noticeId,
            recipientUid: managerDoc.id,
            recipientEmail: String(managerDoc.data().email || ''),
            title: 'Desktop monitoring agent offline',
            message: `${employee.fullName || 'An employee'} is checked in but the desktop monitoring agent has not sent a heartbeat for more than 2 minutes.`,
            type: 'attendance',
            linkTab: 'monitoring',
            emailEnabled,
          });
        }
      }
    } catch (error) { logSchedulerError('Monitoring offline alert job', error); }
  }, 2 * 60 * 1000);
  monitoringOfflineTimer.unref?.();



  // Probation review reminders for employees whose review date is within 14 days or overdue.
  const probationReminderTimer = setInterval(async () => {
    try {
      const cutoffDate = dateInTimezone(new Date(Date.now()+14*86400000),'UTC');
      const todayDate = dateInTimezone(new Date(),'UTC');
      const [employeesSnap, hrSnap, intSnap] = await Promise.all([
        adminDb.collection('employees').where('probationEndDate','<=',cutoffDate).get(),
        adminDb.collection('roles').where('status','==','active').get(),
        adminDb.collection('settings').doc('integrations').get(),
      ]);
      const emailEnabled = intSnap.exists ? intSnap.data()?.emailEnabled !== false : true;
      const roleEmailMap = new Map(hrSnap.docs.map((d) => [d.id, String(d.data().email || '')]));
      const hrTargets = hrSnap.docs.filter((d) => ['super_admin','hr_manager'].includes(String(d.data().role)));
      for (const employeeDoc of employeesSnap.docs) {
        const employee = employeeDoc.data();
        if (employee.status !== 'active' || employee.probationStatus === 'confirmed' || !employee.uid) continue;
        const days = Math.floor((new Date(`${String(employee.probationEndDate)}T00:00:00Z`).getTime()-new Date(`${todayDate}T00:00:00Z`).getTime())/86400000);
        const title = days < 0 ? 'Probation review overdue' : 'Probation review approaching';
        const message = days < 0
          ? `${employee.fullName || 'An employee'} passed the probation end date ${employee.probationEndDate}. Please record a confirmation or extension decision.`
          : `${employee.fullName || 'An employee'} has a probation review due in ${days} day(s), on ${employee.probationEndDate}.`;
        for (const targetUid of [String(employee.uid), ...hrTargets.map((d) => d.id)]) {
          const noticeId = `probation_${employeeDoc.id}_${targetUid}`.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,128);
          const targetEmail = targetUid === String(employee.uid)
            ? String(employee.email || roleEmailMap.get(targetUid) || '')
            : String(roleEmailMap.get(targetUid) || '');
          await createSystemNotificationIfMissing({
            id: noticeId,
            recipientUid: targetUid,
            recipientEmail: targetEmail,
            title,
            message,
            type: 'system',
            linkTab: targetUid === String(employee.uid) ? 'self_service' : 'employees',
            emailEnabled,
          });
        }
      }
    } catch (error) { logSchedulerError('Probation reminder job', error); }
  }, 12 * 60 * 60 * 1000);
  probationReminderTimer.unref?.();

  // Employee document expiry reminders (30 days before expiry and on/after expiry).
  const documentExpiryTimer = setInterval(async () => {
    try {
      const [documentsSnap, rolesSnap, intSnap] = await Promise.all([
        adminDb.collection('documents').where('expiryDate','<=',dateInTimezone(new Date(Date.now()+30*86400000),'UTC')).get(),
        adminDb.collection('roles').where('status','==','active').get(),
        adminDb.collection('settings').doc('integrations').get(),
      ]);
      const emailEnabled = intSnap.exists ? intSnap.data()?.emailEnabled !== false : true;
      const roleEmailMap = new Map(rolesSnap.docs.map((d) => [d.id, String(d.data().email || '')]));
      const hrRoles = rolesSnap.docs.filter((d) => ['super_admin','hr_manager'].includes(String(d.data().role)));
      for (const documentDoc of documentsSnap.docs) {
        const documentData = documentDoc.data();
        if (!documentData.uid || !documentData.expiryDate) continue;
        const todayUtc = dateInTimezone(new Date(),'UTC');
        const days = Math.floor((new Date(`${String(documentData.expiryDate)}T00:00:00Z`).getTime()-new Date(`${todayUtc}T00:00:00Z`).getTime())/86400000);
        const kind = days < 0 ? 'expired' : 'expiring';
        const message = days < 0
          ? `Your ${documentData.title || 'employee document'} expired on ${documentData.expiryDate}. Please upload a renewed document.`
          : `Your ${documentData.title || 'employee document'} expires in ${days} day(s), on ${documentData.expiryDate}. Please arrange a renewal.`;
        const targets = [String(documentData.uid), ...hrRoles.map((d) => d.id)];
        for (const targetUid of targets) {
          const noticeId = `document_${kind}_${documentDoc.id}_${targetUid}`.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,128);
          await createSystemNotificationIfMissing({
            id: noticeId,
            recipientUid: targetUid,
            recipientEmail: String(roleEmailMap.get(targetUid) || ''),
            title: kind === 'expired' ? 'Employee document expired' : 'Employee document expiring soon',
            message,
            type: 'document',
            linkTab: targetUid === String(documentData.uid) ? 'self_service' : 'employees',
            emailEnabled,
          });
        }
      }
    } catch (error) { logSchedulerError('Document expiry reminder job', error); }
  }, 12 * 60 * 60 * 1000);
  documentExpiryTimer.unref?.();

  // Delete screenshots after the configured 30–90 day retention window.
  const monitoringRetentionDays = Math.max(30, Math.min(90, Number(process.env.MONITORING_RETENTION_DAYS || 60)));
  const monitoringRetentionTimer = setInterval(async () => {
    try {
      const cutoff = Timestamp.fromDate(new Date(Date.now() - monitoringRetentionDays * 86400000));
      const expired = await adminDb.collection('monitoringSnapshots').where('createdAt','<',cutoff).limit(300).get();
      for (const snapshotDoc of expired.docs) {
        const storagePath = snapshotDoc.data().storagePath;
        if (adminBucket && storagePath) await adminBucket.file(String(storagePath)).delete({ ignoreNotFound: true });
        await snapshotDoc.ref.delete();
      }
    } catch (error) { logSchedulerError('Monitoring retention cleanup', error); }
  }, 24 * 60 * 60 * 1000);
  monitoringRetentionTimer.unref?.();

  // Daily birthday and work-anniversary cards. The employee's configured timezone determines the local date.
  const announcementTimer = setInterval(async () => {
    try {
      const employeesSnap = await adminDb.collection('employees').where('status', '==', 'active').get();
      for (const employeeDoc of employeesSnap.docs) {
        const employee = employeeDoc.data();
        const timezone = employee.timezone || 'Asia/Kolkata';
        const localDate = dateInTimezone(new Date(), timezone);
        const monthDay = localDate.slice(5);
        const birthDay = typeof employee.birthDate === 'string' ? employee.birthDate.slice(5, 10) : '';
        const joiningDay = typeof employee.joiningDate === 'string' ? employee.joiningDate.slice(5, 10) : '';
        const years = employee.joiningDate ? Number(localDate.slice(0,4)) - Number(String(employee.joiningDate).slice(0,4)) : 0;
        let category: 'birthday' | 'anniversary' | null = null;
        let title = '';
        let content = '';
        if (birthDay === monthDay && employee.birthdayOptOut !== true) {
          category = 'birthday';
          title = `Happy Birthday, ${employee.fullName || 'Team Member'}!`;
          content = `Wishing ${employee.fullName || 'our colleague'} a wonderful birthday from everyone at ACE Web Experts.`;
        } else if (joiningDay === monthDay && years > 0) {
          category = 'anniversary';
          title = `${years} year${years === 1 ? '' : 's'} at ACE Web Experts`;
          content = `Congratulations to ${employee.fullName || 'our colleague'} on completing ${years} year${years === 1 ? '' : 's'} with ACE Web Experts.`;
        }
        if (!category) continue;
        const announcementId = `auto_${category}_${employee.id || employeeDoc.id}_${localDate}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
        await adminDb.collection('announcements').doc(announcementId).set({
          id: announcementId, title, category, content, pinned: false, audience: 'company',
          authorUid: 'system', authorName: 'ACE HRMS',
          createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      const monthKey = dateInTimezone(new Date(), 'Asia/Kolkata').slice(0,7);
      const monthlyBirthdays = employeesSnap.docs.map((d) => d.data())
        .filter((employee) => employee.birthdayOptOut !== true && typeof employee.birthDate === 'string' && employee.birthDate.slice(5,7) === monthKey.slice(5,7))
        .map((employee) => ({ name: String(employee.fullName || 'Team Member'), date: String(employee.birthDate).slice(5,10) }))
        .sort((a,b) => a.date.localeCompare(b.date));
      if (monthlyBirthdays.length) {
        const monthlyId = `upcoming_birthdays_${monthKey}`.slice(0,128);
        const content = monthlyBirthdays.map((item) => `${item.date.slice(3,5)}/${item.date.slice(0,2)} – ${item.name}`).join(' · ');
        await adminDb.collection('announcements').doc(monthlyId).set({
          id: monthlyId, title: 'Upcoming birthdays this month', category: 'birthday',
          content, pinned: false, audience: 'company', authorUid: 'system', authorName: 'ACE HRMS',
          createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    } catch (error) {
      logSchedulerError('Birthday/anniversary announcement job', error);
    }
  }, 60 * 60 * 1000);
  announcementTimer.unref?.();


  // Daily report reminders and TL escalation, evaluated in each employee's local timezone.
  const reportReminderTimer = setInterval(async () => {
    try {
      const [employeesSnap, workPolicySnap, intSnap, rolesSnap] = await Promise.all([
        adminDb.collection('employees').where('status', '==', 'active').get(),
        adminDb.collection('settings').doc('workPolicy').get(),
        adminDb.collection('settings').doc('integrations').get(),
        adminDb.collection('roles').where('status','==','active').get(),
      ]);
      const emailEnabled = intSnap.exists ? intSnap.data()?.emailEnabled !== false : true;
      const defaultShiftEnd = String(workPolicySnap.data()?.workEndTime || '18:30');
      for (const employeeDoc of employeesSnap.docs) {
        const employee = employeeDoc.data();
        const uid = String(employee.uid || '');
        if (!uid) continue;
        const timezone = employee.timezone || 'Asia/Kolkata';
        const now = new Date();
        const date = dateInTimezone(now, timezone);
        const localTime = timeInTimezone(now, timezone);
        const localMinutes = Number(localTime.slice(0,2))*60 + Number(localTime.slice(3,5));
        const shiftEnd = String(employee.shiftEndTime || defaultShiftEnd).split(':');
        const shiftEndMinutes = Number(shiftEnd[0])*60 + Number(shiftEnd[1]);
        if (localMinutes < shiftEndMinutes - 90) continue;
        const attendanceSnap = await adminDb.collection('attendance').doc(`${uid}_${date}`).get();
        if (!attendanceSnap.exists) continue;
        const reportSnap = await adminDb.collection('dailyWorkReports').where('uid','==',uid).get();
        if (reportSnap.docs.some((reportDoc) => reportDoc.data().date === date)) continue;
        const employeeNoticeId = `daily_report_reminder_${uid}_${date}`.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,128);
        await createSystemNotificationIfMissing({
          id: employeeNoticeId,
          recipientUid: uid,
          recipientEmail: String(employee.email || ''),
          title: 'Daily work report pending',
          message: 'Please submit your daily work report before checking out.',
          type: 'system',
          linkTab: 'work_hub',
          emailEnabled,
        });
        if (localMinutes >= shiftEndMinutes) {
          for (const managerDoc of rolesSnap.docs) {
            const managerData = managerDoc.data();
            if (!['team_lead', 'dept_manager', 'hr_manager', 'super_admin'].includes(String(managerData.role))) continue;
            if (['dept_manager', 'team_lead'].includes(String(managerData.role)) && managerData.departmentId !== employee.departmentId) continue;
            const noticeId = `daily_report_escalation_${uid}_${date}_${managerDoc.id}`.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,128);
            await createSystemNotificationIfMissing({
              id: noticeId,
              recipientUid: managerDoc.id,
              recipientEmail: String(managerData.email || ''),
              title: 'Employee daily report overdue',
              message: `${employee.fullName || 'An employee'} has checked in today but has not submitted a daily work report.`,
              type: 'system',
              linkTab: 'work_hub',
              emailEnabled,
            });
          }
        }
      }
    } catch (error) {
      logSchedulerError('Daily report reminder job', error);
    }
  }, 15 * 60 * 1000);
  reportReminderTimer.unref?.();

  // Safety net: close forgotten breaks after their configured allowance and flag them for HR review.
  const breakAutoEndTimer = setInterval(async () => {
    try {
      const [snap, intSnap, managerSnap] = await Promise.all([
        adminDb.collection('breakSessions').where('status', '==', 'active').get(),
        adminDb.collection('settings').doc('integrations').get(),
        adminDb.collection('roles').where('status', '==', 'active').get(),
      ]);
      const emailEnabled = intSnap.exists ? intSnap.data()?.emailEnabled !== false : true;
      const now = new Date();
      for (const row of snap.docs) {
        const data = row.data();
        const allowance = data.type === 'Lunch' ? 45 : data.type === 'Tea/Short' ? 15 : 30;
        const startedAt = new Date(String(data.startAt || ''));
        if (!Number.isFinite(startedAt.getTime()) || now.getTime() - startedAt.getTime() < allowance * 60000) continue;
        await row.ref.update({
          endAt: new Date(startedAt.getTime() + allowance * 60000).toISOString(),
          status: 'auto_ended',
          reviewRequired: true,
          autoEndedAt: now.toISOString(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        const targets = managerSnap.docs.filter((managerDoc) => {
          const managerData = managerDoc.data();
          return ['team_lead', 'dept_manager', 'hr_manager', 'super_admin'].includes(managerData.role)
            && (!['dept_manager', 'team_lead'].includes(managerData.role) || managerData.departmentId === data.departmentId);
        });
        for (const managerDoc of targets) {
          const notificationId = `break_overrun_${row.id}_${managerDoc.id}`.slice(0, 120);
          await createSystemNotificationIfMissing({
            id: notificationId,
            recipientUid: managerDoc.id,
            recipientEmail: String(managerDoc.data().email || ''),
            title: 'Break auto-ended – review required',
            message: `${data.employeeName || 'An employee'} exceeded the ${allowance}-minute ${data.type || 'break'} allowance. Please review the attendance entry.`,
            type: 'attendance',
            linkTab: 'work_hub',
            emailEnabled,
          });
        }
      }
    } catch (error) {
      logSchedulerError('Break auto-end scheduler', error);
    }
  }, 5 * 60 * 1000);
  breakAutoEndTimer.unref?.();

  // Scheduled Automatic Backup Job (checks settings/backupConfig every 15 minutes)
  const backupSchedulerTimer = setInterval(async () => {
    try {
      const cfgSnap = await adminDb.collection('settings').doc('backupConfig').get();
      if (!cfgSnap.exists) return;
      const cfg = cfgSnap.data() as BackupConfigSettings;
      if (!isBackupDue(cfg, new Date())) return;
      await runAdminBackupJob({
        trigger: 'scheduled',
        actorUid: 'system',
        actorEmail: 'scheduler@ace-hrms.local',
        config: cfg,
      });
    } catch (error) {
      logSchedulerError('Scheduled backup job', error);
    }
  }, 15 * 60 * 1000);
  backupSchedulerTimer.unref?.();

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`ACE HRMS server running on http://0.0.0.0:${port} (${isProd ? 'production' : 'development'})`);
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection in ACE HRMS server:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in ACE HRMS server:', err);
});

startServer().catch((err) => {
  console.error('Failed to start ACE HRMS server:', err);
  process.exit(1);
});
