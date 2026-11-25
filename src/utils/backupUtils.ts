import type { BackupConfigSettings, BackupFrequency, BackupRecord } from '../types/hrms';

export const RESTORABLE_COLLECTIONS = [
  'settings',
  'departments',
  'designations',
  'employees',
  'directory',
  'salaries',
  'holidays',
  'leaveBalances',
  'leaveRequests',
  'attendance',
  'attendanceCorrections',
  'shiftTemplates',
  'shiftAssignments',
  'reviewCycles',
  'goals',
  'reviews',
  'announcements',
  'onboarding',
  'offboarding',
  'jobs',
  'candidates',
  'roles',
  'invitations',
  'tasks',
  'breakSessions',
  'dailyWorkReports',
  'meetingLogs',
  'wfhRequests',
  'overtimeRequests',
  'compOffRequests',
  'compOffBalances',
  'timesheets',
  'expenseClaims',
  'assets',
  'helpdeskTickets',
  'polls',
  'pollResponses',
  'feedback360',
  'notificationPrefs',
] as const;

export interface StorageManifestItem {
  path: string;
  sizeBytes: number;
  contentType: string;
  updatedAt: string;
}

export interface BackupDocumentEntry {
  __docId: string;
  data: Record<string, unknown>;
}

export interface BackupPayloadBody {
  schemaVersion: 'ace-hrms-backup-v2';
  exportedAt: string;
  exportedBy: string;
  trigger: 'scheduled' | 'manual';
  frequency: BackupFrequency;
  firebaseProjectId: string;
  firestoreDatabaseId: string;
  collections: Record<string, BackupDocumentEntry[]>;
  storageManifest: StorageManifestItem[];
}

export interface BackupBundle extends BackupPayloadBody {
  checksumSha256: string;
}

export interface BackupValidationResult {
  valid: boolean;
  schemaVersion: string;
  exportedAt: string;
  checksumVerified: boolean | 'unhashed-v1';
  expectedChecksum: string;
  computedChecksum: string;
  collectionCounts: Record<string, number>;
  totalRecords: number;
  storageFileCount: number;
  normalizedCollections: Record<string, BackupDocumentEntry[]>;
  errors: string[];
  warnings: string[];
}

export interface CollectionRestoreDiff {
  collection: string;
  currentCount: number;
  backupCount: number;
  toCreate: number;
  toUpdate: number;
  unchanged: number;
  sampleIds: string[];
}

export interface RestorePreviewSummary {
  totalCurrentRecords: number;
  totalBackupRecords: number;
  totalToCreate: number;
  totalToUpdate: number;
  totalUnchanged: number;
  collections: CollectionRestoreDiff[];
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export async function computeSha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto SHA-256 digest API is unavailable in this runtime.');
  }
  const encoded = new TextEncoder().encode(text);
  const hashBuffer = await subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function serializeFirestoreValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'object') {
    const maybeTs = val as { toDate?: () => Date; _seconds?: number; seconds?: number };
    if (typeof maybeTs.toDate === 'function') {
      try {
        return maybeTs.toDate().toISOString();
      } catch {
        return String(val);
      }
    }
    if (typeof maybeTs._seconds === 'number') {
      return new Date(maybeTs._seconds * 1000).toISOString();
    }
    if (typeof maybeTs.seconds === 'number') {
      return new Date(maybeTs.seconds * 1000).toISOString();
    }
    if (Array.isArray(val)) {
      return val.map((item) => serializeFirestoreValue(item));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) out[k] = serializeFirestoreValue(v);
    }
    return out;
  }
  return val;
}

export async function buildBackupBundle(params: {
  collections: Record<string, BackupDocumentEntry[]>;
  storageManifest?: StorageManifestItem[];
  trigger: 'scheduled' | 'manual';
  frequency: BackupFrequency;
  exportedBy: string;
  firebaseProjectId: string;
  firestoreDatabaseId: string;
  exportedAt?: string;
}): Promise<{
  bundle: BackupBundle;
  rawJson: string;
  checksumSha256: string;
  collectionCounts: Record<string, number>;
  totalRecords: number;
  sizeBytes: number;
}> {
  const body: BackupPayloadBody = {
    schemaVersion: 'ace-hrms-backup-v2',
    exportedAt: params.exportedAt || new Date().toISOString(),
    exportedBy: params.exportedBy,
    trigger: params.trigger,
    frequency: params.frequency,
    firebaseProjectId: params.firebaseProjectId,
    firestoreDatabaseId: params.firestoreDatabaseId,
    collections: params.collections,
    storageManifest: params.storageManifest || [],
  };
  const checksumSha256 = await computeSha256Hex(stableStringify(body));
  const bundle: BackupBundle = { ...body, checksumSha256 };
  const rawJson = JSON.stringify(bundle, null, 2);

  const collectionCounts: Record<string, number> = {};
  let totalRecords = 0;
  for (const [name, entries] of Object.entries(params.collections)) {
    collectionCounts[name] = entries.length;
    totalRecords += entries.length;
  }

  return {
    bundle,
    rawJson,
    checksumSha256,
    collectionCounts,
    totalRecords,
    sizeBytes: new TextEncoder().encode(rawJson).byteLength,
  };
}

function normalizeV1Collections(cols: Record<string, unknown>): Record<string, BackupDocumentEntry[]> {
  const out: Record<string, BackupDocumentEntry[]> = {};
  for (const [name, val] of Object.entries(cols)) {
    if (name === 'settings' && val && typeof val === 'object' && !Array.isArray(val)) {
      out.settings = Object.entries(val as Record<string, unknown>)
        .filter(([, docVal]) => docVal && typeof docVal === 'object')
        .map(([docId, docVal]) => ({
          __docId: docId,
          data: { id: docId, ...(docVal as Record<string, unknown>) },
        }));
      continue;
    }
    if (Array.isArray(val)) {
      out[name] = val
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item, idx) => ({
          __docId: String(item.__docId || item.id || item.uid || `row_${idx}`),
          data: item,
        }));
    }
  }
  return out;
}

export async function validateAndVerifyBackupBundle(rawJson: string): Promise<BackupValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawJson) as Record<string, unknown>;
  } catch (err) {
    return {
      valid: false,
      schemaVersion: 'unknown',
      exportedAt: 'Unknown',
      checksumVerified: false,
      expectedChecksum: '',
      computedChecksum: '',
      collectionCounts: {},
      totalRecords: 0,
      storageFileCount: 0,
      normalizedCollections: {},
      errors: [err instanceof Error ? err.message : 'Invalid JSON backup payload.'],
      warnings: [],
    };
  }

  const schemaVersion = String(parsed.schemaVersion || '');
  const exportedAt = String(parsed.exportedAt || 'Unknown');

  if (schemaVersion !== 'ace-hrms-backup-v2' && schemaVersion !== 'ace-hrms-backup-v1') {
    errors.push(`Unsupported schemaVersion: "${schemaVersion || 'missing'}".`);
  }

  const rawCols = parsed.collections;
  if (!rawCols || typeof rawCols !== 'object' || Array.isArray(rawCols)) {
    errors.push('Missing or invalid collections object in backup payload.');
  }

  let normalizedCollections: Record<string, BackupDocumentEntry[]> = {};
  if (rawCols && typeof rawCols === 'object' && !Array.isArray(rawCols)) {
    if (schemaVersion === 'ace-hrms-backup-v2') {
      for (const [colName, entries] of Object.entries(rawCols as Record<string, unknown>)) {
        if (!Array.isArray(entries)) {
          errors.push(`Collection "${colName}" must be an array in v2 format.`);
          continue;
        }
        normalizedCollections[colName] = entries.map((entry, idx) => {
          const e = entry as Record<string, unknown>;
          if (e && typeof e.__docId === 'string' && e.data && typeof e.data === 'object') {
            return { __docId: e.__docId, data: e.data as Record<string, unknown> };
          }
          return {
            __docId: String((e as Record<string, unknown>)?.id || (e as Record<string, unknown>)?.uid || `doc_${idx}`),
            data: (e || {}) as Record<string, unknown>,
          };
        });
      }
    } else {
      normalizedCollections = normalizeV1Collections(rawCols as Record<string, unknown>);
      warnings.push('Legacy v1 backup detected (unhashed). Converting collections for preview.');
    }
  }

  let checksumVerified: boolean | 'unhashed-v1' = 'unhashed-v1';
  const expectedChecksum = String(parsed.checksumSha256 || '');
  let computedChecksum = '';

  if (schemaVersion === 'ace-hrms-backup-v2') {
    if (!expectedChecksum || !/^[a-f0-9]{64}$/i.test(expectedChecksum)) {
      errors.push('Missing or malformed SHA-256 checksum on v2 backup.');
      checksumVerified = false;
    } else {
      const bodyToHash: BackupPayloadBody = {
        schemaVersion: 'ace-hrms-backup-v2',
        exportedAt: String(parsed.exportedAt || ''),
        exportedBy: String(parsed.exportedBy || ''),
        trigger: (parsed.trigger as 'scheduled' | 'manual') || 'manual',
        frequency: (parsed.frequency as BackupFrequency) || 'daily',
        firebaseProjectId: String(parsed.firebaseProjectId || ''),
        firestoreDatabaseId: String(parsed.firestoreDatabaseId || ''),
        collections: (parsed.collections || {}) as Record<string, BackupDocumentEntry[]>,
        storageManifest: Array.isArray(parsed.storageManifest) ? (parsed.storageManifest as StorageManifestItem[]) : [],
      };
      computedChecksum = await computeSha256Hex(stableStringify(bodyToHash));
      checksumVerified = computedChecksum.toLowerCase() === expectedChecksum.toLowerCase();
      if (!checksumVerified) {
        errors.push(`SHA-256 integrity verification failed (expected ${expectedChecksum.slice(0, 12)}..., got ${computedChecksum.slice(0, 12)}...).`);
      }
    }
  }

  const collectionCounts: Record<string, number> = {};
  let totalRecords = 0;
  for (const [col, list] of Object.entries(normalizedCollections)) {
    collectionCounts[col] = list.length;
    totalRecords += list.length;
  }

  const storageFileCount = Array.isArray(parsed.storageManifest) ? parsed.storageManifest.length : 0;

  return {
    valid: errors.length === 0,
    schemaVersion,
    exportedAt,
    checksumVerified,
    expectedChecksum,
    computedChecksum,
    collectionCounts,
    totalRecords,
    storageFileCount,
    normalizedCollections,
    errors,
    warnings,
  };
}

export function computeRestorePreview(
  currentCollections: Record<string, BackupDocumentEntry[]>,
  backupCollections: Record<string, BackupDocumentEntry[]>,
): RestorePreviewSummary {
  const allCollectionNames = Array.from(
    new Set([...Object.keys(backupCollections), ...Object.keys(currentCollections)])
  ).sort();

  const collections: CollectionRestoreDiff[] = [];
  let totalCurrentRecords = 0;
  let totalBackupRecords = 0;
  let totalToCreate = 0;
  let totalToUpdate = 0;
  let totalUnchanged = 0;

  for (const col of allCollectionNames) {
    const currList = currentCollections[col] || [];
    const bkpList = backupCollections[col] || [];
    const currMap = new Map<string, string>();
    for (const item of currList) {
      currMap.set(item.__docId, stableStringify(serializeFirestoreValue(item.data)));
    }

    let toCreate = 0;
    let toUpdate = 0;
    let unchanged = 0;
    const sampleIds: string[] = [];

    for (const item of bkpList) {
      const existingCanonical = currMap.get(item.__docId);
      const nextCanonical = stableStringify(serializeFirestoreValue(item.data));
      if (existingCanonical === undefined) {
        toCreate += 1;
        if (sampleIds.length < 5) sampleIds.push(`+${item.__docId}`);
      } else if (existingCanonical !== nextCanonical) {
        toUpdate += 1;
        if (sampleIds.length < 5) sampleIds.push(`~${item.__docId}`);
      } else {
        unchanged += 1;
      }
    }

    totalCurrentRecords += currList.length;
    totalBackupRecords += bkpList.length;
    totalToCreate += toCreate;
    totalToUpdate += toUpdate;
    totalUnchanged += unchanged;

    collections.push({
      collection: col,
      currentCount: currList.length,
      backupCount: bkpList.length,
      toCreate,
      toUpdate,
      unchanged,
      sampleIds,
    });
  }

  return {
    totalCurrentRecords,
    totalBackupRecords,
    totalToCreate,
    totalToUpdate,
    totalUnchanged,
    collections,
  };
}

export function isBackupDue(config: BackupConfigSettings | null | undefined, now = new Date()): boolean {
  if (!config || !config.enabled) return false;
  if (!config.lastBackupAt) return true;
  const lastMs = new Date(config.lastBackupAt).getTime();
  if (!Number.isFinite(lastMs)) return true;

  const intervalMs =
    config.frequency === 'hourly'
      ? 60 * 60 * 1000
      : config.frequency === 'weekly'
      ? 7 * 24 * 60 * 60 * 1000
      : 24 * 60 * 60 * 1000;

  return now.getTime() - lastMs >= intervalMs;
}

export function selectBackupsToPrune(
  records: Array<Pick<BackupRecord, 'id' | 'status'> & { timestampIso?: string }>,
  retentionDays: number,
  retentionMaxCount: number,
  now = new Date(),
): string[] {
  const safeDays = Math.max(1, retentionDays);
  const safeMax = Math.max(1, retentionMaxCount);
  const cutoffMs = now.getTime() - safeDays * 86400000;

  // Expect records sorted newest-first; enforce deterministic newest-first ordering
  const sorted = [...records].sort((a, b) => {
    const aMs = a.timestampIso ? new Date(a.timestampIso).getTime() : 0;
    const bMs = b.timestampIso ? new Date(b.timestampIso).getTime() : 0;
    return bMs - aMs;
  });

  const toDelete: string[] = [];
  let kept = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const item = sorted[i]!;
    const itemMs = item.timestampIso ? new Date(item.timestampIso).getTime() : now.getTime();
    const expiredByAge = Number.isFinite(itemMs) && itemMs < cutoffMs;
    const overMaxCount = kept >= safeMax;

    // Never prune the single newest successful backup solely by age
    const isSoleNewestSuccess = i === 0 && item.status === 'success';

    if ((expiredByAge || overMaxCount) && !isSoleNewestSuccess) {
      toDelete.push(item.id);
    } else {
      kept += 1;
    }
  }
  return toDelete;
}
