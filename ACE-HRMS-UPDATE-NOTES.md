# ACE HRMS – Audit & Implementation Update Notes

## Summary of Changes Completed

1. **Confirmed Firebase Project Alignment & Non-Destructive WorkFlow OS Compatibility**
   - Aligned `firebase-applet-config.json`, `desktop-agent/agent-config.json`, `server.ts`, `AuthContext.tsx`, and `firestore.rules` with confirmed target project `gen-lang-client-0209720424` (`Default Gemini Project`), Firestore database `ai-studio-workflowosaceweb-f23bec09-9afb-4a68-8d35-a438d22d2192` (`asia-south1`), organisation `org_ace_web_experts` (`ACE Web Experts` / `WorkFlow OS`), and Super Admin `awe.prianshu@gmail.com`.
   - Preserved all existing WorkFlow OS collections (`activityLogs`, `admins`, `departments`, `organisations`, `projects`, `seoClients`, `seoKeywords`, `seoRankingHistory`, `seoTrafficSnapshots`, `tasks`, `teamDirectory`, `users`) without deleting, resetting, or overwriting existing records.

2. **Persistent Dark & Light Theme + Brand Logo**
   - Added pre-React inline script in `index.html` reading `localStorage.ace_theme` to prevent dark/light flash on load.
   - Created `src/utils/themeUtils.ts` (`getSavedTheme`, `applyTheme`, `useThemeMode`, `getChartTheme`) and expanded `src/index.css` light-mode contrast rules across forms, modals, tables, cards, sidebar, and Recharts.
   - Updated `AceBrandMark`, `BrandSplash`, `Sidebar`, `TopBar`, and `AuthPortal` with adaptive contrast and single-brand rendering.

3. **Part 1 & Part 2 Completeness**
   - Completed all 16 Part 1 requirements (clear leave balances, actual break-based deduction, employee timezone support, server-authoritative check-in/out, correction reason & monthly cap, invalid action prevention, role-scoped search, daily timeline, projected finish time, Team Today widget).
   - Replaced all browser `window.alert`, `window.confirm`, `window.prompt`, and `window.open` calls across `src/` with inline React modals and confirmations (verified 0 occurrences in `src/`).
   - Completed Work Hub (Breaks, Daily Work Reports inline review modal, Meetings), Holidays (country/location filters, CSV import, optional cap), and Monitoring (inline signed-URL lightbox modal, active agent heartbeats, productivity trend AreaChart).

4. **Phases 1–3 Features**
   - Added `team_lead` role across `firestore.rules`, `firebase-blueprint.json`, `server.ts`, and all UI modules.
   - Implemented configurable `approvalWorkflows` (`SettingsModule` + `workflowUtils.ts`), leave clash warnings (`detectTeamLeaveClashes`), and year-end leave carry-forward reset (`computeCarryForwardReset`).
   - Added native `.xlsx` workbook exports powered by `exceljs` across Reports, Payroll, Monitoring, Performance, Announcements, Employees, and Advanced Operations.
   - Added Firebase Auth TOTP 2FA enrollment/unenrollment (`SelfServiceModule`) and challenge resolution (`AuthPortal`), server `express-rate-limit` middleware, and JSON workspace backup + dry-run restore validation (`SettingsModule`).
   - Implemented Shift Templates & Roster Assignments (`AttendanceModule`), Payroll Dry-Run & Reconciliation (`PayrollModule`), Review Cycles with Weighted KPIs & Anonymized 360° Analytics (`PerformanceModule`), Client/Project Timesheet Profitability, Expense UTR Reconciliation, Asset Return Condition Inspection, Helpdesk SLA/Assignee/Comments, Poll Participation Analytics (`AdvancedOperationsModule`), Policy Read-Rate tracking (`AnnouncementsModule`), and Slack/WhatsApp webhook routes (`server.ts` + `SettingsModule`).
   - Throttled repeated Firebase Admin SDK `7 PERMISSION_DENIED` scheduler errors in `server.ts` to once per hour.

## Automated Verification Performed

- **Firestore Security Rules & Blueprint**: `npx eslint firestore.rules` and `node --experimental-strip-types firestore.rules.test.ts` passed (53 collections audited).
- **Unit Tests (`tests/hrms.test.ts`)**: `node --experimental-strip-types --test tests/hrms.test.ts` passed 4/4 suites (`themeUtils`, `workflowUtils`, `attendanceUtils`, `ExcelJS` XLSX buffer generation).
- **Desktop Agent Syntax Check**: `node --check desktop-agent/main.cjs desktop-agent/preload.cjs` exited 0.
- **TypeScript & Vite Build**: `npm run lint` (`tsc --noEmit`) and `npm run build` (`vite build`) verified clean.
- **Dev Server Check**: Verified HTTP 200 on `/`, `/api/health`, and `/api/time`.

## External Configuration Still Required by Operator

- **Firebase Project & Auth Providers**: Codebase is aligned to `gen-lang-client-0209720424` / `ai-studio-workflowosaceweb-f23bec09-9afb-4a68-8d35-a438d22d2192`. Enable Email/Password in Firebase Console → Authentication → Sign-in method if password login is desired alongside Google Sign-in.
- **Admin SDK IAM**: Grant `roles/datastore.user` and `roles/storage.objectAdmin` (and `roles/firebaseauth.viewer`) to `ais-sandbox@ais-asia-southeast1-1ef4e7b9f4.iam.gserviceaccount.com` on `gen-lang-client-0209720424`, or provide `FIREBASE_SERVICE_ACCOUNT` / `FIREBASE_SERVICE_ACCOUNT_JSON`.
- **Identity Platform MFA**: Enable TOTP MFA in Firebase Console if 2FA enrollment is required in production.
- **Optional Messaging Credentials**: Configure `SMTP_*`, `SLACK_WEBHOOK_URL`, and `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` in deployment `.env` when ready.
- **Desktop Agent Packaging**: Run `npm install && npm run dist:win` / `dist:mac` / `dist:linux` inside `desktop-agent/` on a machine with target OS build tools to generate signed installers.
