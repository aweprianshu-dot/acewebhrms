# ACE HRMS – Automatic Backup & Disaster Recovery Procedure

**Project:** `gen-lang-client-0209720424`
**Firestore Database ID:** `ai-studio-workflowosaceweb-f23bec09-9afb-4a68-8d35-a438d22d2192`
**Storage Bucket:** `gen-lang-client-0209720424.firebasestorage.app`

---

## 1. Backup Architecture & Storage Strategy

ACE HRMS maintains a two-tier backup system controlled exclusively by **Super Admins** under **HR Settings → Domain, Backup & Status**:

1. **Scheduled & On-Demand Firestore Snapshots (`ace-hrms-backup-v2`)**:
   - Captures all restorable HRMS collections (`RESTORABLE_COLLECTIONS` in `src/utils/backupUtils.ts`): `settings`, `departments`, `designations`, `employees`, `directory`, `salaries`, `holidays`, `leaveBalances`, `leaveRequests`, `attendance`, `attendanceCorrections`, `shiftTemplates`, `shiftAssignments`, `reviewCycles`, `goals`, `reviews`, `announcements`, `onboarding`, `offboarding`, `jobs`, `candidates`, `roles`, `invitations`, `tasks`, `breakSessions`, `dailyWorkReports`, `meetingLogs`, `wfhRequests`, `overtimeRequests`, `compOffRequests`, `compOffBalances`, `timesheets`, `expenseClaims`, `assets`, `helpdeskTickets`, `polls`, `pollResponses`, `feedback360`, and `notificationPrefs`.
   - Computes a canonical **SHA-256 checksum** (`checksumSha256`) using deterministic JSON key ordering (`stableStringify` + Web Crypto SHA-256) so any single-byte file modification is detected before restore.
   - Server scheduler (`server.ts` -> `backupSchedulerTimer`) checks `settings/backupConfig` every 15 minutes and executes `runAdminBackupJob` whenever `isBackupDue()` returns `true` (`hourly`, `daily`, or `weekly`).
2. **Firebase Storage Backup Strategy**:
   - When Firebase Storage is attached to the server Admin SDK (`adminBucket`), backup bundles are archived under `backups/{backupId}.json` in Firebase Storage, AND all user-uploaded objects (`documents/*`, `avatars/*`, `resumes/*`, etc.) are inventoried inside `storageManifest` (path, `sizeBytes`, `contentType`, `updatedAt`).
   - Direct client reads/writes to `/backups/{allPaths=**}` and `/monitoring/{uid}/{allPaths=**}` are denied (`allow read, write: if false;`) in `storage.rules`; access is permitted strictly via authenticated Super Admin backend routes (`/api/backups/:id/download`) and Firestore `/backupHistory/{backupId}` rules (`isSuperAdmin()`).
3. **Retention & Automatic Cleanup**:
   - Controlled by `settings/backupConfig` fields `retentionDays` (1–365, default `30`) and `retentionMaxCount` (1–200, default `30`).
   - After each backup run, `selectBackupsToPrune()` deletes expired/excess backup records and their corresponding Storage `.json` archives while always preserving the newest successful snapshot.

---

## 2. Notifications & Audit Trail

- When `notifyOnSuccess` or `notifyOnFailure` is enabled in `settings/backupConfig`, every Super Admin receives an in-app notification plus SMTP email (when `SMTP_*` credentials are configured and `settings/integrations.emailEnabled` is true).
- Every policy update, backup execution, and restore operation writes an immutable entry to `auditLogs` (`BACKUP_POLICY_UPDATED`, `AUTOMATIC_BACKUP_RUN`, `BACKUP_RESTORED`).

---

## 3. Verified Restore Procedure (Step-by-Step)

1. **Authenticate as Super Admin**: Only verified accounts with active `super_admin` role can open Backup History or invoke `/api/backups/restore/*`.
2. **Select Snapshot or Upload JSON File**:
   - Choose **Preview Restore** on a `backupHistory` row, or upload a downloaded `.json` archive via **Inspect / Restore from JSON File**.
3. **Verify Integrity & Inspect Impact Diff (Non-Mutating)**:
   - Review the **SHA-256 Integrity** badge (`Checksum Verified` for v2 archives; legacy v1 files display `Legacy v1 (Unhashed)`).
   - If the checksum mismatches (`Checksum Mismatch`), restore execution is **hard-blocked** until an untampered archive is supplied.
   - Review the per-collection diff table (`Live`, `Backup`, `+Create`, `~Update`, `Unchanged`) computed without touching production Firestore.
4. **Confirm & Execute Restore**:
   - Type `RESTORE` into the authorization box and click **Confirm & Apply Restore**.
   - **Full Server Path**: When GCP IAM grants Firestore/Storage permissions to the server service account (`roles/datastore.user` + `roles/storage.objectAdmin`), `/api/backups/restore/apply` atomically batches writes across all `RESTORABLE_COLLECTIONS`.
   - **Client Super Admin Fallback (Preview/Restricted IAM)**: If the server returns `503 iamBlocked`, the UI applies a Super Admin Web Firestore batch across client-restorable configuration/core collections while honoring Firestore Security Rules (`createdAt`/`updatedAt` timestamps) and clearly reporting any server-only collections skipped.
5. **Restore Firebase Storage Files (If Bucket Files Were Purged)**:
   - Re-enable Object Versioning on `gen-lang-client-0209720424.firebasestorage.app` via `gsutil versioning set on gs://gen-lang-client-0209720424.firebasestorage.app`.
   - Cross-check missing document URLs against `storageManifest` inside the verified JSON bundle.

---

## 4. Recovery Objectives (RPO / RTO)

- **Default Daily Schedule**: RPO ≤ 24 hours (reducible to **≤ 1 hour** by setting frequency to `hourly`).
- **Typical RTO**: < 5 minutes for Firestore workspace restore (< 50,000 records) using batched writes.
- **Safety Rule**: Never run destructive tests against the live `ai-studio-workflowosaceweb-f23bec09-9afb-4a68-8d35-a438d22d2192` database; automated restore tests in `tests/hrms.test.ts` execute strictly against isolated in-memory mocks.
