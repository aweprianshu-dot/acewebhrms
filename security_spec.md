# ACE HRMS — Security Specification & Threat Model

## 1. Data Invariants
1. **Zero Self-Escalation**: Public signup can only create a `/roles/{uid}` document with `role == 'employee'` and `status == 'pending'`. Only an existing `super_admin` can elevate a user to `hr_manager`, `dept_manager`, `team_lead`, or `super_admin`, or claim `/system/setup` when uninitialized.
2. **Single-Use Bootstrap**: `/system/setup` can only be created once when `!exists(/databases/$(database)/documents/system/setup)` by a verified user whose `uid` matches `superAdminUid`, atomically paired with `/admins/{uid}` and `/roles/{uid}`.
3. **Strict PII & Compensation Isolation**:
   - `/salaries/{employeeId}` and `/payslips/{payslipId}` are readable ONLY by `super_admin`, `hr_manager`, or the owning employee (`uid == request.auth.uid`). Department managers, team leads, and peer employees are strictly denied.
   - `/employees/{employeeId}` (containing phone, address, emergency contact) is readable ONLY by `super_admin`, `hr_manager`, the owning employee, `dept_manager` (`departmentId` match), or `team_lead` strictly assigned via `teamLeadUid` or `reportingManagerUid`.
   - `/directory/{employeeId}` stores only non-PII org directory attributes (name, code, department, designation, joiningDate, birthMonthDay, status).
4. **Server-Authoritative Leave Governance & Balance Integrity**:
   - Client-side `create` and `update` writes on `/leaveBalances/{uid}` and `/leaveRequests/{leaveId}` are strictly denied (`allow create, update: if false;`).
   - All leave mutations execute inside verified Express endpoints (`/api/leaves/*`) using Firebase Admin SDK `runTransaction` after verifying the Firebase ID token, `email_verified`, and active `roles/{uid}` status.
   - Initial annual quotas (`casualTotal`, `sickTotal`, `paidTotal`, `emergencyTotal`) are provisioned exclusively from `settings/leavePolicy` (`POST /api/leaves/ensure-balance`), ignoring any client-supplied numbers and preserving existing balances.
   - Approval routing fields (`teamLeadUid`, `reportingManagerUid`, `teamId`, `departmentId`, `requesterRole`) are derived strictly from the server's `roles/{uid}` and `employees` records — client-supplied routing overrides are ignored.
   - Approver reads and actions via `reportingManagerUid` require an active management or HR role (`super_admin`, `hr_manager`, `dept_manager`, or `team_lead`). Plain employees never gain leave read/approval authority even if their UID appears in `reportingManagerUid`.
5. **Team-Wise Leave Isolation & Super Admin Leave Privacy**:
   - Team Leaders (`team_lead`) can read/act ONLY on their own leave records/balances and those of employees explicitly assigned to them (`teamLeadUid == request.auth.uid`), excluding Super Admin executive-private records.
   - Super Admin personal leaves and balances stamp `ownerRole == 'super_admin'` and `departmentId == '__executive_private__'`; both `get` and `list` rules on `/leaveBalances` and `/leaveRequests` exclude Super Admin records from HR, Dept Managers, Team Leads, and peer employees (unless an authorized HR/Manager/Team Lead is explicitly configured as `reportingManagerUid` in `designated_approver` mode).
   - Non-Super-Admin roles (`team_lead`, `dept_manager`, `hr_manager`) cannot approve, reject, or request changes on their own leave requests.
6. **Immutable Temporal, Audit & Terminal State Integrity**:
   - Approved leaves decrement balance inside the same Firestore transaction (`409 Conflict` blocks duplicate approvals), cancel-approved refunds exact quota once (`409 Conflict` blocks duplicate refunds), and rejected leaves never deduct balance.
   - `/auditLogs/{logId}` is append-only (`update`/`delete` denied for all roles including admins).
7. **Verified Identity & Rules-Hardened Self Check-In/Break Fallbacks**: All write operations require `request.auth.token.email_verified == true`. Direct client attendance check-in/out, break start/end, and optional holiday selection fallbacks are strictly scoped to `request.auth.uid` with field-level `hasOnly` allowlists.

## 2. Adversarial Security & Leave Integrity Test Matrix

### Core Access & Rules Invariants
1. **Self-Admin Role Escalation**: Employee attempts `create` on `/roles/attackerUid` with `{ role: "super_admin", status: "active" }`. -> `PERMISSION_DENIED`.
2. **Duplicate System Setup Hijack**: Attacker attempts `create` on `/system/setup` after company is already initialized. -> `PERMISSION_DENIED`.
3. **Ghost Field Shadow Write**: HR attempts `update` on `/employees/emp1` injecting `{ isSecretAdmin: true }`. -> `PERMISSION_DENIED` (`hasOnly` rejection).
4. **Unverified Email Spoofing**: Unverified user (`email_verified: false`) attempts authenticated action. -> Denied (`403` / `PERMISSION_DENIED`).
5. **Cross-Employee Salary Snooping**: Employee A attempts `get` or `list` on `/salaries/empB`. -> `PERMISSION_DENIED`.
6. **Department Manager Payroll Access**: Dept Manager attempts `get` on `/payslips/emp1_2026_11`. -> `PERMISSION_DENIED`.
7. **Client Timestamp Forgery**: Employee attempts `create` on `/attendance/uid_2026-11-14` with forged `createdAt`. -> `PERMISSION_DENIED`.
8. **ID Poisoning Attack**: Attacker attempts `create` with oversized or special-character IDs. -> `PERMISSION_DENIED`.
9. **Audit Log Tampering**: User or admin attempts `delete` or `update` on `/auditLogs/log1`. -> `PERMISSION_DENIED`.
10. **Cross-User Notification Read/Write**: User A attempts `read` or `update` on `/notifications/notifB`. -> `PERMISSION_DENIED`.

### 15 Leave Security & Data-Integrity Cases
1. **Direct Client Leave Balance Creation Blocked**: Employee writes `/leaveBalances/{uid}` directly -> `PERMISSION_DENIED` (`allow create, update: if false`).
2. **Forged Quota (`paidTotal: 999`) Ignored**: Server `ensureEmployeeLeaveBalance` ignores client quota payloads and applies `settings/leavePolicy` (`paidAnnual`), preserving any existing balance.
3. **Employee Leave Approval Blocked**: Plain employee tries approving own or teammate leave directly or via `POST /api/leaves/:id/approve` -> `PERMISSION_DENIED` / `403 Forbidden`.
4. **Un-roled `reportingManagerUid` Bypass Closed**: Plain employee whose UID appears in `reportingManagerUid` is denied on `firestore.rules` (`get`/`list`), client filtering, and server approval (`403`).
5. **Forged Team/Approver Metadata Rejected**: Server ignores client-submitted `teamLeadUid`, `reportingManagerUid`, `teamId`, `departmentId`, and `requesterRole` and resolves strictly from `roles`/`employees`.
6. **Team Lead Own-Team Approval**: Team Lead reads and approves assigned team leave; balance decrements once atomically.
7. **Team Lead Cross-Team Isolation**: Team Lead A is denied reading or approving Team B leaves (`PERMISSION_DENIED` / `403`).
8. **Department Manager Scope Isolation**: Dept Manager approves own department leave (`dept_eng`) and is denied unrelated department (`dept_design`) leaves (`403`).
9. **HR Privacy on Super Admin Balance**: HR cannot `get` or unscoped-`list` Super Admin's `/leaveBalances/{saUid}`, cannot sync Super Admin scope (`403`), and HR annual reset excludes Super Admin balances.
10. **HR Privacy on Super Admin Leave Requests**: HR cannot read or approve unassigned Super Admin `__executive_private__` leaves (`PERMISSION_DENIED` / `403`).
11. **Designated Approver Scoping**: Active HR/Manager configured as `superAdminApproverUid` in `designated_approver` mode reads and approves only the assigned executive leave; unauthorized peers/HR remain denied.
12. **Super Admin Auto-Audit Private Leave**: Super Admin self-leave in `auto_audit` mode atomically creates an approved `__executive_private__` record, deducts balance once, and writes an audit log.
13. **Duplicate Approval Prevention**: Second approval call on an already-approved leave returns `409 Conflict` and never double-deducts quota.
14. **Cancel Approved Leave Atomic Refund**: Cancelling an approved leave refunds exact deducted quota once inside `runTransaction`; duplicate refund returns `409 Conflict`.
15. **Rejected Leave & Resubmit Invariant**: Rejecting a leave records the review reason with zero balance deduction; `changes_requested` enables employee resubmit back to `pending`.
