/**
 * ACE HRMS Security Rules Static & Policy Verification Suite
 * Validates server-authoritative leave controls, Super Admin privacy, and Dirty Dozen invariants.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
const blueprintPath = path.resolve(process.cwd(), 'firebase-blueprint.json');

const rulesContent = fs.readFileSync(rulesPath, 'utf8');
const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf8'));

// 1. Verify every collection in firebase-blueprint.json has an explicit match block
const collectionPaths = Object.keys(blueprint.firestore || {});
for (const colPath of collectionPaths) {
  const collectionName = colPath.split('/')[1];
  assert.ok(
    rulesContent.includes(`match /${collectionName}/`),
    `Missing match block for collection /${collectionName} in firestore.rules`,
  );
}

// 1b. Verify RoleAssignment blueprint includes team_lead
const roleEnum = blueprint.entities?.RoleAssignment?.properties?.role?.enum || [];
assert.ok(roleEnum.includes('team_lead'), 'RoleAssignment role enum in firebase-blueprint.json must include team_lead');

// 2. Verify Global Safety Net default-deny exists
assert.ok(
  rulesContent.includes('match /{document=**}') && rulesContent.includes('allow read, write: if false;'),
  'Global default-deny safety net missing',
);

// 3. Verify core security invariants are enforced in rules
const requiredGuards = [
  "rules_version = '2';",
  'request.auth.token.email_verified == true',
  'isValidId(',
  'request.time',
  'affectedKeys().hasOnly(',
  "incoming().role == 'employee'",
  '!exists(/databases/$(database)/documents/system/setup)',
  "existing().status == 'pending'",
  'allow update, delete: if false;',
];

for (const guard of requiredGuards) {
  assert.ok(rulesContent.includes(guard), `Missing required security guard: ${guard}`);
}

// 4. Verify no blanket allow read/write: if isSignedIn(); or if true;
assert.ok(!/allow\s+(read|write|list|get)\s*:\s*if\s+true\s*;/.test(rulesContent), 'Open public rule detected!');
assert.ok(!/allow\s+(read|list)\s*:\s*if\s+isSignedIn\(\)\s*;/.test(rulesContent), 'Blanket isSignedIn() read detected!');

// 5. Verify Super Admin isolation on backupHistory and backupConfig
assert.ok(rulesContent.includes("settingId == 'backupConfig' ? isSuperAdmin()"), 'backupConfig Super Admin guard missing');
assert.ok(
  rulesContent.includes('match /backupHistory/{backupId}') && rulesContent.includes('isValidBackupRecord(incoming())'),
  'backupHistory strict validation missing',
);

// 6. Verify Leave Governance Server-Authoritative Lock, Super Admin Privacy, and Role-Verified Approvers
const leaveBalancesBlockMatch = rulesContent.match(/match \/leaveBalances\/\{uid\}\s*\{([\s\S]*?)\n\s{4}\}/);
assert.ok(leaveBalancesBlockMatch, 'Missing match /leaveBalances/{uid} block');
const leaveBalancesBlock = leaveBalancesBlockMatch[1];

assert.ok(
  leaveBalancesBlock.includes('allow create, update: if false;'),
  'leaveBalances must deny all client-side create/update mutations (server-authoritative only)',
);
assert.ok(
  leaveBalancesBlock.includes("(isHR() && ('ownerRole' in resource.data) && resource.data.ownerRole != 'super_admin' && resource.data.departmentId != '__executive_private__')"),
  'HR leaveBalances get rule must require ownerRole and exclude super_admin / __executive_private__',
);
assert.ok(
  leaveBalancesBlock.includes("(isHR() && resource.data.ownerRole in ['employee', 'team_lead', 'dept_manager', 'hr_manager'])"),
  'HR leaveBalances list rule must constrain ownerRole to non-super_admin workforce roles',
);
assert.ok(
  !leaveBalancesBlock.includes('resource.data.reportingManagerUid == request.auth.uid'),
  'leaveBalances must not expose arbitrary reportingManagerUid access bypass',
);

const leaveRequestsBlockMatch = rulesContent.match(/match \/leaveRequests\/\{leaveId\}\s*\{([\s\S]*?)\n\s{4}\}/);
assert.ok(leaveRequestsBlockMatch, 'Missing match /leaveRequests/{leaveId} block');
const leaveRequestsBlock = leaveRequestsBlockMatch[1];

assert.ok(
  leaveRequestsBlock.includes('allow create, update: if false;'),
  'leaveRequests must deny all client-side create/update mutations (server-authoritative only)',
);
assert.ok(
  leaveRequestsBlock.includes('((isHR() || isDeptManager() || isTeamLead()) && resource.data.reportingManagerUid == request.auth.uid && resource.data.uid != request.auth.uid)'),
  'leaveRequests get rule must require active HR/Dept Manager/Team Lead role for reportingManagerUid access',
);
assert.ok(
  leaveRequestsBlock.includes('((isHR() || isDeptManager() || isTeamLead()) && resource.data.reportingManagerUid == request.auth.uid)'),
  'leaveRequests list rule must require active HR/Dept Manager/Team Lead role for reportingManagerUid access',
);
assert.ok(
  !leaveRequestsBlock.includes('(isVerified() && resource.data.reportingManagerUid == request.auth.uid)'),
  'Plain verified employee must NOT gain leaveRequests read access merely by reportingManagerUid match',
);
assert.ok(
  leaveRequestsBlock.includes("resource.data.departmentId != '__executive_private__'"),
  'Super Admin __executive_private__ isolation missing on leaveRequests',
);
assert.ok(
  leaveRequestsBlock.includes('(isTeamLead() && resource.data.teamLeadUid == request.auth.uid'),
  'Team Lead leaveRequests isolation missing',
);
assert.ok(
  rulesContent.includes('data.paidTotal <= 365') && rulesContent.includes('data.casualTotal <= 365'),
  'Upper-bound quota checks (<= 365) missing on isValidLeaveBalance',
);

// 7. Verify Team Lead isolation on employees & hardened self-service attendance check-in/out & break session fallbacks
assert.ok(
  rulesContent.includes('(isTeamLead() && (resource.data.teamLeadUid == request.auth.uid || resource.data.reportingManagerUid == request.auth.uid))'),
  'Team Lead isolation missing on employees',
);
assert.ok(
  rulesContent.includes("attendanceId == (request.auth.uid + '_' + incoming().date)"),
  'Self attendance check-in doc ID guard missing',
);
assert.ok(
  rulesContent.includes("incoming().diff(existing()).affectedKeys().hasOnly(['checkOutTime', 'breakMinutes', 'workingMinutes', 'isEarlyDeparture', 'earlyDepartureMinutes', 'officeTimezone', 'status', 'updatedAt'])"),
  'Self attendance check-out field allowlist missing',
);
assert.ok(
  rulesContent.includes("incoming().diff(resource.data).affectedKeys().hasOnly(['endAt', 'status', 'updatedAt'])"),
  'Self breakSessions end allowlist missing',
);

// 8. Verify Team Lead announcement scoping, Tasks timer/comment/attachment allowlist, and confirmed owner email
assert.ok(
  rulesContent.includes("request.auth.token.email == 'awe.prianshu@gmail.com'"),
  'Bootstrapped owner email must match awe.prianshu@gmail.com',
);
assert.ok(
  rulesContent.includes('canReadAnnouncement(resource.data)') &&
    rulesContent.includes("incoming().audience == 'team'") &&
    rulesContent.includes('isTeamLead()'),
  'Team-scoped announcements rules for Team Leads missing',
);
assert.ok(
  rulesContent.includes("'timerRunning'") &&
    rulesContent.includes("'comments'") &&
    rulesContent.includes("'attachments'") &&
    rulesContent.includes("'project'"),
  'Tasks rules must allow project, timer, comments, and attachments fields',
);

console.log(`Security verification passed: ${collectionPaths.length} collections audited against hardened leave, announcement, task & access invariants.`);
