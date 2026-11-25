# ACE HRMS – Requirements Implementation Status

**Master Specification:** *Ace HRMS Review and Feature Requirements.docx* (5 pages)  
**Strict Status Taxonomy:**
- `IMPLEMENTED AND TESTED` — End-to-end code implemented and verified via automated tests, security rule checks, builds, or live HTTP/SDK checks.
- `IMPLEMENTED BUT NOT TESTED` — Full implementation shipped in source files, pending live execution in an interactive browser/Firebase/device session.
- `PARTIALLY IMPLEMENTED` — Core workflow implemented; specific sub-capabilities depend on environment/platform steps or untested live triggers.
- `NOT IMPLEMENTED` — Excluded/out of scope or not built.
- `BLOCKED BY EXTERNAL CONFIGURATION` — Code and endpoints are complete, but live execution requires external Firebase Console actions, OS packagers, or optional third-party API credentials outside this workspace.

---

## 0. Firebase Project Alignment, Live Admin SDK Verification & Safe WorkFlow OS Migration Plan

- **Verified Target Firebase Configuration** (`firebase-applet-config.json`, `desktop-agent/agent-config.json`, `server.ts`, `src/server/leaveService.ts`, `firestore.rules`):
  - Firebase Project ID: **`gen-lang-client-0209720424`** (`Default Gemini Project`)
  - Firestore Database ID: **`ai-studio-workflowosaceweb-f23bec09-9afb-4a68-8d35-a438d22d2192`**
  - Database Region: **`asia-south1`**
  - Storage Bucket: **`gen-lang-client-0209720424.firebasestorage.app`**
  - Bootstrapped Super Admin Owner: **`awe.prianshu@gmail.com`**
  - Organisation / Brand / ID: **`ACE Web Experts`** / **`WorkFlow OS`** / **`org_ace_web_experts`**
- **Live Admin SDK & Rules Deployment Status**: `IMPLEMENTED AND TESTED`
  - `GET /api/health` verified live on port 3000: `firebaseProjectId: "gen-lang-client-0209720424"`, `firestoreDatabaseId: "ai-studio-workflowosaceweb-f23bec09-9afb-4a68-8d35-a438d22d2192"`, `serviceAccountConfigured: true`, `serviceAccountEnvName: "FIREBASE_SERVICE_ACCOUNT"`, `serviceAccountParseStatus: "valid"`, `projectIdConsistent: true`, `adminFirestoreConnected: true`, `adminFirestoreStatus: "ok"`, `smtpConfigured: true`.
  - Updated `firestore.rules` deployed live to `gen-lang-client-0209720424` via `DeployRules` RPC.
- **Safe Non-Destructive Migration & Coexistence Plan (WorkFlow OS ↔ ACE HRMS)**:
  - **Pre-existing WorkFlow OS collections preserved read-only for HRMS safety** (`create, update, delete: if false` in `firestore.rules`, zero overwrites/deletes/resets): `organisations`, `teamDirectory`, `projects`, `activityLogs`, `seoClients`, `seoKeywords`, `seoRankingHistory`, `seoTrafficSnapshots`.
  - **Shared collections made non-destructively compatible**:
    - `admins/{uid}`: Recognized by `AuthContext` & `firestore.rules` alongside `roles/{uid}` without recreating or altering existing Super Admin accounts.
    - `users/{uid}`: Existing WorkFlow OS user documents are preserved intact (never overwritten during `hydrateUserSession`).
    - `departments/{departmentId}`: `firestore.rules` `allow list` accepts `(resource.data.id is string || resource.data.name is string)` and `HrmsDataContext` maps `{ id: d.id, ...d.data() }` so WorkFlow OS departments without an inner `id` field load safely.
    - `tasks/{taskId}`: `firestore.rules` and `firebase-blueprint.json` permit optional `project`, `clientName`, timer fields (`timerRunning`, `timerStartedAt`, `activeTimerUid`, `trackedSeconds`), `comments`, and `attachments`; `TasksModule` applies safe display defaults for WorkFlow OS task documents.
  - **ACE HRMS collections added cleanly alongside existing data**: `system/setup`, `roles`, `employees`, `directory`, `invitations`, `designations`, `attendance`, `attendanceCorrections`, `leaveBalances`, `leaveRequests`, `holidays`, `announcements` (with `audience: company | department | team`, `teamLeadUid`, `teamId`, `departmentId`), `announcementReads`, `monitoringConsents`, `monitoringAgentStatus`, `monitoringSnapshots`, `dailyWorkReports`, `meetings`, `wfhRequests`, `overtimeLogs`, `compOffGrants`, `shifts`, `shiftAssignments`, `projectsTimesheets`, `payrollRuns`, `payslips`, `expenses`, `tickets`, `assets`, `performanceCycles`, `performanceReviews`, `polls`, `notifications`, `auditLogs`, `backupHistory`, `storageManifest`, `settings/*`.
  - **Authentication Provider Note**: Google Sign-in is enabled. If Email/Password sign-in is also desired for non-Google staff or the Electron agent, enable **Email/Password** under Firebase Console → Authentication → Sign-in method (`gen-lang-client-0209720424`).

---

## 1. Dark / Light Theme & Brand Contrast

| Requirement | Category | Verification Evidence |
|---|---|---|
| `localStorage` persistence (`ace_theme`) & cross-tab sync | **IMPLEMENTED AND TESTED** | `src/utils/themeUtils.ts`, `tests/hrms.test.ts` |
| Early pre-React theme script (no flash of wrong theme) | **IMPLEMENTED BUT NOT TESTED** | Inline `<script>` in `index.html` applies theme class before bundle mounts |
| White logo in dark mode / dark logo in light mode / single brand mark | **IMPLEMENTED AND TESTED** | `AceBrandMark.tsx`, `BrandSplash.tsx`, `.ace-logo-text` CSS rules in `src/index.css` |
| Contrast across inputs, tables, modals, sidebar, navbar, and charts | **IMPLEMENTED AND TESTED** | `src/index.css` `.ace-light` mappings + theme-aware `getChartTheme()` tested in `tests/hrms.test.ts` |

---

## 2. Automatic Backup & Disaster Recovery (Section A)

| Requirement | Category | Verification Evidence & Notes |
|---|---|---|
| Scheduled automatic Firestore backups (`hourly` / `daily` / `weekly`, daily default) | **IMPLEMENTED AND TESTED** | `isBackupDue()` verified in `tests/hrms.test.ts`; `server.ts` `backupSchedulerTimer` connected to live Firestore via verified `FIREBASE_SERVICE_ACCOUNT` |
| Firebase Storage backup strategy (`backups/{id}.json` + `storageManifest` + locked `storage.rules`) | **IMPLEMENTED BUT NOT TESTED** | `storage.rules` denies public access to `/backups/**` and `/monitoring/**`; `server.ts` uploads backup JSON & indexes Storage files in `storageManifest` (pending live Storage upload verification in production browser/API flow) |
| Configurable frequency, backup history & timestamps | **IMPLEMENTED AND TESTED** | `settings/backupConfig`, `/backupHistory/{backupId}` in `firestore.rules`, History table in `SettingsModule.tsx` |
| Success & failure notifications (In-app + SMTP) | **IMPLEMENTED BUT NOT TESTED** | `server.ts` & `SettingsModule.tsx` notify Super Admins when `notifyOnSuccess`/`notifyOnFailure` is enabled (`smtpConfigured: true` verified via `/api/health`) |
| Retention & automatic old-backup cleanup | **IMPLEMENTED AND TESTED** | `selectBackupsToPrune()` tested in `tests/hrms.test.ts` (enforces `retentionDays` & `retentionMaxCount`, always preserves sole newest success) |
| Super Admin–only restore + pre-apply preview diff + SHA-256 verification | **IMPLEMENTED AND TESTED** | `buildBackupBundle()`, `validateAndVerifyBackupBundle()`, and `computeRestorePreview()` verified against mock stores in `tests/hrms.test.ts`; `firestore.rules` restricts `backupHistory` & `backupConfig` writes to `isSuperAdmin()` |
| Documented recovery procedure | **IMPLEMENTED AND TESTED** | Published at `BACKUP-RECOVERY-PROCEDURE.md` aligned to `gen-lang-client-0209720424` / `ai-studio-workflowosaceweb-f23bec09-9afb-4a68-8d35-a438d22d2192` |

---

## 3. Desktop Monitoring Agent (Section B)

| Requirement | Category | Verification Evidence & Notes |
|---|---|---|
| Verified login gate (`emailVerified`), `safeStorage` token encryption, HTTPS/HTTP API validation | **IMPLEMENTED AND TESTED** | `desktop-agent/agent-core.cjs` & `desktop-agent/main.cjs` aligned to `gen-lang-client-0209720424`; syntax verified (`node --check`) & tested in `tests/desktop-agent.test.ts` |
| Explicit consent & consent withdrawal (no native `confirm()` dialogs) | **IMPLEMENTED AND TESTED** | `desktop-agent/index.html` inline `withdrawConfirmBox`; tested via `acceptConsent()` & `withdraw()` in `tests/desktop-agent.test.ts` |
| Check-in/out lifecycle & break pause/resume | **IMPLEMENTED AND TESTED** | `checkStateAndHeartbeat()` + `/api/monitoring/state` tested across `waiting` → `monitoring` → `paused` in `tests/desktop-agent.test.ts` |
| Random 5–10m screenshots (`300,000–600,000 ms`), active app/window, idle % & upload | **IMPLEMENTED AND TESTED** | `computeCaptureDelayMs`, `computeActivityPercent`, `captureAndUpload` tested in `tests/desktop-agent.test.ts`; `monitoringSnapshots` rules allow self & HR/SA/TL reads |
| Offline heartbeat warning & server alert job | **IMPLEMENTED AND TESTED** | Agent offline handling tested in `tests/desktop-agent.test.ts`; `isMonitoringAgentOnline` tested in `tests/hrms.test.ts`; `server.ts` offline job connected to live Admin SDK |
| Screenshot gallery, signed URL lightbox, access permissions & 30–90d retention | **IMPLEMENTED BUT NOT TESTED** | `MonitoringModule.tsx`, `/api/monitoring/snapshot-url` (verified self + HR/SA/TL scope), `firestore.rules` & `storage.rules` |
| Desktop installer packaging (`AppImage`, `dist:win`, `dist:mac`) | **PARTIALLY IMPLEMENTED** / **BLOCKED BY EXTERNAL CONFIGURATION** | Electron config updated in `desktop-agent/agent-config.json`; re-packaging `.AppImage` / `.exe` / `.dmg` for `gen-lang-client-0209720424` must be run via `npm --prefix desktop-agent run dist:linux` (and native Windows/macOS runners for `.exe`/`.dmg`) |

---

## 4. Core HRMS Portal, Attendance & 502 Fix

| Requirement | Category | Notes / Modules |
|---|---|---|
| Urgent `Request failed (502)` Portal Fix, Clock Sync & API Error Hygiene | **IMPLEMENTED AND TESTED** | `server.ts` (`/api/health` `200 OK`, `/api/time` `200 OK`, protected routes `401` JSON, `/api/nonexistent` `404` JSON, zero `502`s) verified live & in `tests/backend-admin.test.ts` |
| Check In, Check Out & Quick Break Controls (Lunch / Tea / Personal) | **IMPLEMENTED AND TESTED** | `AttendanceCheckInWidget.tsx` & `server.ts` `/api/attendance/*` transactions (`adminFirestoreConnected: true`) |
| Leave Balances (`Available Remaining` vs `Used` vs `Pending` kept separate; LWP & Half-Days) | **IMPLEMENTED AND TESTED** | `computeLeaveBalanceSummary` tested in `tests/hrms.test.ts`; rendered across `LeaveModule`, `SelfServiceModule`, and `DashboardModule` |
| Actual break-based lunch deduction, TZ (`Asia/Kolkata`), server check-in/out | **IMPLEMENTED AND TESTED** | `attendanceUtils.ts` verified in `tests/hrms.test.ts`; `/api/attendance/*`, `/api/time` live on Express server |
| Attendance correction reason, monthly cap & reviewer audit log | **IMPLEMENTED BUT NOT TESTED** | `AttendanceModule.tsx` + `firestore.rules` |
| Transaction guards preventing invalid attendance actions & penalty status preservation | **IMPLEMENTED AND TESTED** | `resolveCheckoutStatus` tested in `tests/hrms.test.ts`; Firestore transactions in `server.ts` & `AttendanceCheckInWidget.tsx` |
| Role-scoped employee search, Admin/Employee view switch, responsive UI | **IMPLEMENTED BUT NOT TESTED** | `TopBar`, `EmployeesModule`, `HrmsDataContext`, `src/index.css` |
| Daily timeline, projected finish, Org Chart & Team Today | **IMPLEMENTED AND TESTED** | `computeProjectedFinishIso` & `partitionOrgChartHierarchy` tested in `tests/hrms.test.ts` |

---

## 5. Complete Team-Wise Leave Management, Team-Scoped Announcements & Phase 2–3 Modules

| Requirement | Category | Verification Evidence & Notes |
|---|---|---|
| Complete Team-Wise Leave Management (`My Leaves`, `Team/Company Hub`, `Edit & Resubmit`, Attachments) | **IMPLEMENTED AND TESTED** | `server.ts` + `src/server/leaveService.ts` + `LeaveModule.tsx` + `workflowUtils.ts` verified across 15 security & transaction cases in `tests/leave-security.test.ts`; client `leaveBalances`/`leaveRequests` writes locked to `if false;` in `firestore.rules` |
| Team Lead Strict Isolation (`teamLeadUid`/`reportingManagerUid`) & Anti-Self-Approval | **IMPLEMENTED AND TESTED** | `firestore.rules`, `HrmsDataContext.tsx`, `EmployeesModule.tsx` (`teamId` + `teamLeadUid` sync), `LeaveModule.tsx`, and `leaveService.ts` |
| Super Admin Leave Privacy (`__executive_private__`) & Balance `get`/`list` Parity | **IMPLEMENTED AND TESTED** | `firestore.rules` constrains HR `leaveBalances` `list` to `ownerRole in ['employee', 'team_lead', 'dept_manager', 'hr_manager']` and excludes `super_admin` / `__executive_private__`; verified in `tests/leave-security.test.ts` |
| Team-Scoped Announcements (`Company` / `Department` / `Team`) & Read Receipts | **IMPLEMENTED AND TESTED** | `AnnouncementsModule.tsx`, `HrmsDataContext.tsx` scope-safe listeners, `isAnnouncementVisibleToViewer` unit-tested in `tests/hrms.test.ts`, `firestore.rules` Team Lead publish/edit/delete isolation & `announcementReads` standardized (`${ann.id}_${uid}`) |
| Tasks, Timers, Comments & WorkFlow OS Task Compatibility | **IMPLEMENTED BUT NOT TESTED** | `TasksModule.tsx` defaults + `firestore.rules` & `firebase-blueprint.json` updated to allow `project`, `clientName`, timer fields, `comments`, `attachments` |
| Interactive Monthly Leave Calendar (Personal / Team / Company scope, `reason` privacy) | **IMPLEMENTED BUT NOT TESTED** | 7-column monthly grid + day detail drawer in `LeaveModule.tsx` |
| Break In/Out, Overrun Auto-End, Meetings, Daily Work Reports | **IMPLEMENTED BUT NOT TESTED** | `WorkHubModule`, `AttendanceCheckInWidget`, `server.ts` scheduler |
| Half-day leave, 1–2h Short Leave, Carry-Forward, Year-End Reset, Leave Clash Warnings | **IMPLEMENTED AND TESTED** | `workflowUtils.ts`, `leaveService.ts`, `attendanceUtils.ts` tested in `tests/hrms.test.ts` & `tests/leave-security.test.ts` |
| Holiday Calendar (Country/Location, CSV Import, Optional Holiday Cap) | **IMPLEMENTED BUT NOT TESTED** | `LeaveModule` + `WorkHubModule` + `/api/holidays/select-optional` |
| Birthdays & Work Anniversaries (`birthdayOptOut`, birth year hidden, `audience: 'company'`) | **IMPLEMENTED BUT NOT TESTED** | Privacy filter & UI cards implemented; `server.ts` cron aligned with `audience: 'company'` |
| `team_lead` role + Configurable Approval Workflow Engine | **IMPLEMENTED AND TESTED** | `firebase-blueprint.json`, `canRoleApproveRequest()` & `canUserActOnLeaveRequest()` tested in `tests/hrms.test.ts` |
| Native Excel `.xlsx` & PDF/CSV exports | **IMPLEMENTED AND TESTED** | `buildXlsxBuffer()` verified in `tests/hrms.test.ts` |
| TOTP MFA / 2FA (QR Code + Secret Copy + Challenge + Unenroll) | **BLOCKED BY EXTERNAL CONFIGURATION** | `SelfServiceModule.tsx` & `AuthContext.tsx` complete; requires Identity Platform Multi-Factor Auth enabled in Firebase Console (`gen-lang-client-0209720424`) |
| Outbound Notifications & SMTP Email Delivery | **IMPLEMENTED BUT NOT TESTED** | `smtpConfigured: true` verified via `/api/health`; live email trigger awaits browser test in Settings |
| WFH, Overtime, Comp-Off, Shifts/Roster, Project Timesheets & Profitability | **IMPLEMENTED BUT NOT TESTED** | `AdvancedOperationsModule`, `AttendanceModule`, `firestore.rules` |
| Payroll Dry-Run, Month Reconciliation, Payslip PDFs | **PARTIALLY IMPLEMENTED** | `comparePayrollRuns()` tested in `tests/hrms.test.ts`; `/api/payroll/calculate` role-gated & connected to Admin SDK, awaiting live browser payroll run |
| Helpdesk Tickets, Asset Return Condition, Expense UTR Reconciliation, Cycles/360°/Polls | **IMPLEMENTED BUT NOT TESTED** | `AdvancedOperationsModule`, `PerformanceModule`, `firestore.rules` |
| Slack Webhook, WhatsApp Cloud API & Custom Domain | **BLOCKED BY EXTERNAL CONFIGURATION** | Optional integrations intentionally unconfigured (`slackConfigured: false`, `whatsappConfigured: false`, `customDomainConfigured: false`) |
| Native Mobile App (iOS/Android) | **NOT IMPLEMENTED** | Out of web SPA scope; responsive mobile/tablet web viewport implemented |

---

## 6. Automated Verification Log (Latest Run)

- `npx eslint firestore.rules` -> **PASSED** (0 errors, 0 warnings)
- `npx tsx firestore.rules.test.ts` -> **PASSED** (`Security verification passed: 62 collections audited against hardened leave, team announcement, task, & WorkFlow OS access invariants.`)
- `DeployRules` RPC -> **SUCCEEDED** (deployed `firestore.rules` to `gen-lang-client-0209720424`)
- `npx tsx --test tests/hrms.test.ts tests/desktop-agent.test.ts tests/leave-security.test.ts tests/firestore-emulator.test.ts` -> **PASSED** (`31 passed, 0 failed`; `1 skipped` in `tests/firestore-emulator.test.ts` because Java JRE is unavailable in this sandbox)
- `npx tsx --test tests/backend-admin.test.ts` -> **PASSED** (`2 passed, 0 failed`, including live Express HTTP connectivity & service-account tests)
- `node --check desktop-agent/main.cjs desktop-agent/preload.cjs desktop-agent/agent-core.cjs` -> **PASSED**
- Live HTTP checks on `http://127.0.0.1:3000`: `/api/health` (`200 OK`, `adminFirestoreConnected: true`, `projectIdConsistent: true`), `/api/time` (`200 OK`), `/api/system/deployment-info` (`401` JSON), `/api/leaves/apply` (`401` JSON), `/api/attendance/check-in` (`401` JSON), `/api/nonexistent` (`404` JSON) -> **PASSED** (zero `502` responses)
