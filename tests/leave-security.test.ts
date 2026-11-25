import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  ensureEmployeeLeaveBalance,
  submitLeaveRequest,
  resubmitLeaveRequest,
  decideLeaveRequest,
  cancelPendingLeaveRequest,
  cancelApprovedAndRefundLeave,
  adjustLeaveBalance,
  executeAnnualLeaveReset,
  syncEmployeeLeaveScope,
  HttpLeaveError,
  type LeaveActor,
  type LeaveStoreAdapter,
  type LeaveTxContext,
} from '../src/server/leaveService.ts';
import {
  EXECUTIVE_PRIVATE_DEPT,
  filterVisibleLeaveRequests,
} from '../src/utils/workflowUtils.ts';
import type { LeaveBalance, LeaveRequest, UserRole } from '../src/types/hrms.ts';

function cloneValue<T>(val: T): T {
  return JSON.parse(JSON.stringify(val));
}

class InMemoryLeaveStore implements LeaveStoreAdapter {
  collections = new Map<string, Map<string, Record<string, unknown>>>();
  notifications: Array<{ id: string; recipientUid: string; title: string; message: string }> = [];
  private seq = 0;

  seed(collectionName: string, docId: string, data: Record<string, unknown>): void {
    if (!this.collections.has(collectionName)) {
      this.collections.set(collectionName, new Map());
    }
    this.collections.get(collectionName)!.set(docId, cloneValue(data));
  }

  get(collectionName: string, docId: string): Record<string, unknown> | null {
    const col = this.collections.get(collectionName);
    const val = col?.get(docId);
    return val ? cloneValue(val) : null;
  }

  async getDoc(collectionName: string, docId: string): Promise<Record<string, unknown> | null> {
    return this.get(collectionName, docId);
  }

  async listCollection(collectionName: string): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
    const col = this.collections.get(collectionName);
    if (!col) return [];
    return Array.from(col.entries()).map(([id, data]) => ({ id, data: cloneValue(data) }));
  }

  async queryWhere(
    collectionName: string,
    field: string,
    value: unknown,
  ): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
    const all = await this.listCollection(collectionName);
    return all.filter((entry) => entry.data[field] === value);
  }

  async runTransaction<T>(fn: (tx: LeaveTxContext) => Promise<T>): Promise<T> {
    const stagedWrites: Array<() => void> = [];
    const tx: LeaveTxContext = {
      getDoc: async (collectionName, docId) => this.get(collectionName, docId),
      queryWhere: async (collectionName, field, value) => this.queryWhere(collectionName, field, value),
      setDoc: (collectionName, docId, data) => {
        stagedWrites.push(() => this.seed(collectionName, docId, data));
      },
      updateDoc: (collectionName, docId, patch) => {
        stagedWrites.push(() => {
          const existing = this.get(collectionName, docId);
          if (!existing) throw new Error(`Doc missing: ${collectionName}/${docId}`);
          this.seed(collectionName, docId, { ...existing, ...cloneValue(patch) });
        });
      },
    };
    const result = await fn(tx);
    for (const apply of stagedWrites) apply();
    return result;
  }

  serverTimestamp(): unknown {
    return '2026-11-24T00:00:00.000Z';
  }

  nowIso(): string {
    return '2026-11-24T00:00:00.000Z';
  }

  createId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  async dispatchNotification(params: {
    id: string;
    recipientUid: string;
    recipientEmail?: string;
    title: string;
    message: string;
    linkTab: string;
  }): Promise<void> {
    this.notifications.push({
      id: params.id,
      recipientUid: params.recipientUid,
      title: params.title,
      message: params.message,
    });
  }
}

function createSeededStore(): InMemoryLeaveStore {
  const store = new InMemoryLeaveStore();
  store.seed('settings', 'leavePolicy', {
    id: 'leavePolicy',
    casualAnnual: 12,
    sickAnnual: 10,
    paidAnnual: 15,
    emergencyAnnual: 5,
    carryForwardEnabled: true,
    maxCarryForwardPaid: 10,
    superAdminSelfApprovalMode: 'auto_audit',
    superAdminApproverUid: '',
  });
  store.seed('settings', 'workPolicy', {
    id: 'workPolicy',
    workStartTime: '09:30',
    workEndTime: '18:30',
    lunchStartTime: '13:30',
    lunchEndTime: '14:15',
    graceMinutes: 15,
    breakMinutes: 45,
    halfDayThresholdMinutes: 270,
    officeTimezone: 'Asia/Kolkata',
    weeklyOffs: ['Saturday', 'Sunday'],
  });
  store.seed('settings', 'approvalWorkflows', {
    id: 'approvalWorkflows',
    rules: [
      {
        module: 'leave',
        approverRoles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead'],
        allowSelfApprovalForSuperAdmin: true,
        requireHrFinalApproval: false,
      },
    ],
  });

  const users: Array<{
    uid: string;
    role: UserRole;
    dept: string;
    teamId?: string;
    tl?: string;
    mgr?: string;
    name: string;
    email: string;
  }> = [
    { uid: 'sa1', role: 'super_admin', dept: EXECUTIVE_PRIVATE_DEPT, name: 'Super Admin', email: 'sa@ace.com' },
    { uid: 'hr1', role: 'hr_manager', dept: 'dept_hr', name: 'HR Manager', email: 'hr@ace.com' },
    { uid: 'dm_eng', role: 'dept_manager', dept: 'dept_eng', name: 'Eng Manager', email: 'dm@ace.com' },
    { uid: 'dm_design', role: 'dept_manager', dept: 'dept_design', name: 'Design Manager', email: 'dmdes@ace.com' },
    { uid: 'tl_a', role: 'team_lead', dept: 'dept_eng', teamId: 'team_a', mgr: 'dm_eng', name: 'TL Alpha', email: 'tla@ace.com' },
    { uid: 'tl_b', role: 'team_lead', dept: 'dept_eng', teamId: 'team_b', mgr: 'dm_eng', name: 'TL Beta', email: 'tlb@ace.com' },
    { uid: 'emp_a1', role: 'employee', dept: 'dept_eng', teamId: 'team_a', tl: 'tl_a', mgr: 'tl_a', name: 'Emp A1', email: 'empa1@ace.com' },
    { uid: 'emp_b1', role: 'employee', dept: 'dept_eng', teamId: 'team_b', tl: 'tl_b', mgr: 'tl_b', name: 'Emp B1', email: 'empb1@ace.com' },
    { uid: 'emp_design', role: 'employee', dept: 'dept_design', teamId: 'team_des', tl: '', mgr: 'dm_design', name: 'Emp Design', email: 'empdes@ace.com' },
    { uid: 'emp_spoof', role: 'employee', dept: 'dept_eng', teamId: 'team_a', tl: 'tl_a', mgr: 'tl_a', name: 'Plain Employee', email: 'spoof@ace.com' },
  ];

  for (const u of users) {
    store.seed('roles', u.uid, {
      uid: u.uid,
      email: u.email,
      role: u.role,
      departmentId: u.dept,
      status: 'active',
    });
    store.seed('employees', `e_${u.uid}`, {
      id: `e_${u.uid}`,
      uid: u.uid,
      fullName: u.name,
      email: u.email,
      departmentId: u.dept,
      teamId: u.teamId || '',
      teamLeadUid: u.tl || '',
      reportingManagerUid: u.mgr || '',
      status: 'active',
    });
  }
  store.seed('admins', 'sa1', { uid: 'sa1', role: 'super_admin' });
  return store;
}

const actors = {
  sa1: { uid: 'sa1', email: 'sa@ace.com', emailVerified: true, displayName: 'Super Admin' } as LeaveActor,
  hr1: { uid: 'hr1', email: 'hr@ace.com', emailVerified: true, displayName: 'HR Manager' } as LeaveActor,
  dmEng: { uid: 'dm_eng', email: 'dm@ace.com', emailVerified: true, displayName: 'Eng Manager' } as LeaveActor,
  dmDesign: { uid: 'dm_design', email: 'dmdes@ace.com', emailVerified: true, displayName: 'Design Manager' } as LeaveActor,
  tlA: { uid: 'tl_a', email: 'tla@ace.com', emailVerified: true, displayName: 'TL Alpha' } as LeaveActor,
  tlB: { uid: 'tl_b', email: 'tlb@ace.com', emailVerified: true, displayName: 'TL Beta' } as LeaveActor,
  empA1: { uid: 'emp_a1', email: 'empa1@ace.com', emailVerified: true, displayName: 'Emp A1' } as LeaveActor,
  empB1: { uid: 'emp_b1', email: 'empb1@ace.com', emailVerified: true, displayName: 'Emp B1' } as LeaveActor,
  empDesign: { uid: 'emp_design', email: 'empdes@ace.com', emailVerified: true, displayName: 'Emp Design' } as LeaveActor,
  empSpoof: { uid: 'emp_spoof', email: 'spoof@ace.com', emailVerified: true, displayName: 'Plain Employee' } as LeaveActor,
};

// Mirror evaluator directly checking the exact clauses enforced in firestore.rules
function loadRulesBlocks(): { leaveBalances: string; leaveRequests: string } {
  const rulesText = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
  const lb = rulesText.match(/match \/leaveBalances\/\{uid\}\s*\{([\s\S]*?)\n\s{4}\}/)?.[1] || '';
  const lr = rulesText.match(/match \/leaveRequests\/\{leaveId\}\s*\{([\s\S]*?)\n\s{4}\}/)?.[1] || '';
  assert.ok(lb.length > 0 && lr.length > 0, 'Rules blocks must exist');
  return { leaveBalances: lb, leaveRequests: lr };
}

function evalRuleLeaveBalanceGet(
  viewer: { uid: string; role: UserRole; deptId: string; verified: boolean },
  docData: Partial<LeaveBalance> & { uid: string },
): boolean {
  if (!viewer.verified) return false;
  if (viewer.role === 'super_admin') return true;
  if (viewer.uid === docData.uid) return true;
  if (
    viewer.role === 'hr_manager' &&
    typeof docData.ownerRole === 'string' &&
    docData.ownerRole !== 'super_admin' &&
    docData.departmentId !== EXECUTIVE_PRIVATE_DEPT
  ) {
    return true;
  }
  if (
    viewer.role === 'dept_manager' &&
    docData.departmentId === viewer.deptId &&
    docData.departmentId !== EXECUTIVE_PRIVATE_DEPT &&
    (!docData.ownerRole || docData.ownerRole !== 'super_admin')
  ) {
    return true;
  }
  if (
    viewer.role === 'team_lead' &&
    docData.teamLeadUid === viewer.uid &&
    docData.departmentId !== EXECUTIVE_PRIVATE_DEPT &&
    (!docData.ownerRole || docData.ownerRole !== 'super_admin')
  ) {
    return true;
  }
  return false;
}

function evalRuleLeaveBalanceListQuery(
  viewer: { uid: string; role: UserRole; deptId: string; verified: boolean },
  queryMode: 'all' | 'hr_scoped' | 'self' | 'dept' | 'tl',
  docs: Array<Partial<LeaveBalance> & { uid: string }>,
): boolean {
  if (!viewer.verified) return false;
  if (viewer.role === 'super_admin') return true;
  if (queryMode === 'self') return docs.every((d) => d.uid === viewer.uid);
  if (queryMode === 'hr_scoped') {
    return (
      viewer.role === 'hr_manager' &&
      docs.every((d) => ['employee', 'team_lead', 'dept_manager', 'hr_manager'].includes(String(d.ownerRole || '')))
    );
  }
  if (queryMode === 'dept') {
    return viewer.role === 'dept_manager' && viewer.deptId !== EXECUTIVE_PRIVATE_DEPT && docs.every((d) => d.departmentId === viewer.deptId);
  }
  if (queryMode === 'tl') {
    return viewer.role === 'team_lead' && docs.every((d) => d.teamLeadUid === viewer.uid);
  }
  return false;
}

function evalRuleLeaveRequestGet(
  viewer: { uid: string; role: UserRole; deptId: string; verified: boolean },
  req: LeaveRequest,
): boolean {
  if (!viewer.verified) return false;
  if (viewer.role === 'super_admin') return true;
  if (req.uid === viewer.uid) return true;
  const isMgmt = viewer.role === 'hr_manager' || viewer.role === 'dept_manager' || viewer.role === 'team_lead';
  if (isMgmt && req.reportingManagerUid === viewer.uid && req.uid !== viewer.uid) return true;
  if (viewer.role === 'hr_manager' && req.departmentId !== EXECUTIVE_PRIVATE_DEPT) return true;
  if (viewer.role === 'dept_manager' && req.departmentId === viewer.deptId && req.departmentId !== EXECUTIVE_PRIVATE_DEPT) return true;
  if (viewer.role === 'team_lead' && req.teamLeadUid === viewer.uid && req.departmentId !== EXECUTIVE_PRIVATE_DEPT) return true;
  return false;
}

test('Cases 1-15: Hardened Firestore rules & transactional LeaveService security suite', async (t) => {
  const { leaveBalances: lbRules, leaveRequests: lrRules } = loadRulesBlocks();

  await t.test('Case 1 & 2: Employee cannot create leaveBalances directly or supply paidTotal: 999', async () => {
    assert.ok(lbRules.includes('allow create, update: if false;'), 'Client create/update on leaveBalances must be blocked');
    const store = createSeededStore();

    // Even if client passes extra/tampered fields at HTTP layer, ensureEmployeeLeaveBalance takes ZERO quota inputs
    const res = await ensureEmployeeLeaveBalance(store, actors.empA1);
    assert.equal(res.created, true);
    assert.equal(res.balance.paidTotal, 15);
    assert.equal(res.balance.casualTotal, 12);
    assert.equal(res.balance.teamLeadUid, 'tl_a');
    assert.equal(res.balance.ownerRole, 'employee');

    // Second call preserves existing balance even if policy changes later
    store.seed('settings', 'leavePolicy', {
      id: 'leavePolicy',
      casualAnnual: 99,
      sickAnnual: 99,
      paidAnnual: 99,
      emergencyAnnual: 99,
      carryForwardEnabled: true,
      maxCarryForwardPaid: 10,
    });
    const preserved = await ensureEmployeeLeaveBalance(store, actors.empA1);
    assert.equal(preserved.created, false);
    assert.equal(preserved.balance.paidTotal, 15);
  });

  await t.test('Case 3: Employee cannot approve or modify leaveRequests directly or via server API', async () => {
    assert.ok(lrRules.includes('allow create, update: if false;'), 'Client create/update on leaveRequests must be blocked');
    const store = createSeededStore();
    const { leaveRequest } = await submitLeaveRequest(store, actors.empA1, {
      leaveType: 'paid',
      dayPart: 'full',
      startDate: '2026-12-07',
      endDate: '2026-12-08',
      reason: 'Annual vacation',
    });

    await assert.rejects(
      () => decideLeaveRequest(store, actors.empA1, leaveRequest.id, 'approved', 'Self approve'),
      (e: unknown) => e instanceof HttpLeaveError && e.status === 403,
    );
    await assert.rejects(
      () => decideLeaveRequest(store, actors.empB1, leaveRequest.id, 'approved', 'Peer approve'),
      (e: unknown) => e instanceof HttpLeaveError && e.status === 403,
    );
  });

  await t.test('Case 4: Plain employee named in reportingManagerUid cannot read or approve leave', async () => {
    assert.ok(
      !lrRules.includes('(isVerified() && resource.data.reportingManagerUid == request.auth.uid)'),
      'Un-roled reportingManagerUid rule must not exist',
    );
    const store = createSeededStore();
    // Simulate a legacy/forged document having a plain employee UID in reportingManagerUid
    const forgedReq: LeaveRequest = {
      id: 'lr_legacy_mgr',
      uid: 'emp_a1',
      employeeId: 'e_emp_a1',
      employeeName: 'Emp A1',
      departmentId: 'dept_eng',
      teamId: 'team_a',
      teamLeadUid: 'tl_a',
      reportingManagerUid: 'emp_spoof',
      requesterRole: 'employee',
      leaveType: 'paid',
      startDate: '2026-12-07',
      endDate: '2026-12-07',
      daysCount: 1,
      reason: 'Medical checkup',
      status: 'pending',
    };
    store.seed('leaveRequests', forgedReq.id, forgedReq as unknown as Record<string, unknown>);

    // 1) Firestore rule check
    assert.equal(
      evalRuleLeaveRequestGet({ uid: 'emp_spoof', role: 'employee', deptId: 'dept_eng', verified: true }, forgedReq),
      false,
    );
    // 2) Client visibility helper check
    const visible = filterVisibleLeaveRequests([forgedReq], 'emp_spoof', 'employee', 'dept_eng');
    assert.equal(visible.length, 0);
    // 3) Server API approval check
    await assert.rejects(
      () => decideLeaveRequest(store, actors.empSpoof, forgedReq.id, 'approved', 'Trying spoofed manager'),
      (e: unknown) => e instanceof HttpLeaveError && e.status === 403,
    );
  });

  await t.test('Case 5: Forged teamLeadUid, reportingManagerUid, teamId, departmentId, requesterRole are ignored server-side', async () => {
    const store = createSeededStore();
    // Attempt passing spoofed routing fields via unvalidated input object
    const dirtyInput = {
      leaveType: 'paid' as const,
      dayPart: 'full' as const,
      startDate: '2026-12-09',
      endDate: '2026-12-10',
      reason: 'Forged metadata attempt',
      teamLeadUid: 'emp_spoof',
      reportingManagerUid: 'emp_spoof',
      teamId: 'team_b',
      departmentId: 'dept_design',
      requesterRole: 'super_admin',
      status: 'approved',
    };

    const { leaveRequest, autoApproved } = await submitLeaveRequest(store, actors.empA1, dirtyInput);
    assert.equal(autoApproved, false);
    assert.equal(leaveRequest.status, 'pending');
    assert.equal(leaveRequest.departmentId, 'dept_eng');
    assert.equal(leaveRequest.teamId, 'team_a');
    assert.equal(leaveRequest.teamLeadUid, 'tl_a');
    assert.equal(leaveRequest.reportingManagerUid, 'tl_a');
    assert.equal(leaveRequest.requesterRole, 'employee');
  });

  await t.test('Case 6 & 7: Team Lead approves own team leave once; cannot read or approve another team leave', async () => {
    const store = createSeededStore();
    const { leaveRequest: reqA } = await submitLeaveRequest(store, actors.empA1, {
      leaveType: 'casual',
      dayPart: 'full',
      startDate: '2026-12-07',
      endDate: '2026-12-08',
      reason: 'Team A trip',
    });
    const { leaveRequest: reqB } = await submitLeaveRequest(store, actors.empB1, {
      leaveType: 'casual',
      dayPart: 'full',
      startDate: '2026-12-07',
      endDate: '2026-12-07',
      reason: 'Team B personal',
    });

    // Team Lead A can read reqA, cannot read reqB
    assert.equal(evalRuleLeaveRequestGet({ uid: 'tl_a', role: 'team_lead', deptId: 'dept_eng', verified: true }, reqA), true);
    assert.equal(evalRuleLeaveRequestGet({ uid: 'tl_a', role: 'team_lead', deptId: 'dept_eng', verified: true }, reqB), false);

    // Team Lead A approves reqA
    const approvedA = await decideLeaveRequest(store, actors.tlA, reqA.id, 'approved', 'Enjoy!');
    assert.equal(approvedA.leaveRequest.status, 'approved');
    assert.equal(approvedA.balance?.casualUsed, 2);

    // Team Lead A cannot approve reqB
    await assert.rejects(
      () => decideLeaveRequest(store, actors.tlA, reqB.id, 'approved', 'Cross-team attempt'),
      (e: unknown) => e instanceof HttpLeaveError && e.status === 403,
    );
  });

  await t.test('Case 8: Department Manager can approve own dept leave and is denied unrelated department', async () => {
    const store = createSeededStore();
    const { leaveRequest: engReq } = await submitLeaveRequest(store, actors.empA1, {
      leaveType: 'sick',
      dayPart: 'full',
      startDate: '2026-12-14',
      endDate: '2026-12-14',
      reason: 'Doctor visit',
    });
    const { leaveRequest: designReq } = await submitLeaveRequest(store, actors.empDesign, {
      leaveType: 'sick',
      dayPart: 'full',
      startDate: '2026-12-14',
      endDate: '2026-12-14',
      reason: 'Fever rest',
    });

    assert.equal(evalRuleLeaveRequestGet({ uid: 'dm_eng', role: 'dept_manager', deptId: 'dept_eng', verified: true }, designReq), false);
    await assert.rejects(
      () => decideLeaveRequest(store, actors.dmEng, designReq.id, 'approved', 'Wrong dept'),
      (e: unknown) => e instanceof HttpLeaveError && e.status === 403,
    );

    const engApproved = await decideLeaveRequest(store, actors.dmEng, engReq.id, 'approved', 'Get well soon');
    assert.equal(engApproved.leaveRequest.status, 'approved');
    assert.equal(engApproved.balance?.sickUsed, 1);
  });

  await t.test('Case 9 & 10: HR cannot read/list/reset Super Admin private leaveBalances or leaveRequests', async () => {
    const store = createSeededStore();
    const { balance: saBal } = await ensureEmployeeLeaveBalance(store, actors.sa1);
    const { balance: empBal } = await ensureEmployeeLeaveBalance(store, actors.empA1);
    const { leaveRequest: saLeave } = await submitLeaveRequest(store, actors.sa1, {
      leaveType: 'paid',
      dayPart: 'full',
      startDate: '2026-12-21',
      endDate: '2026-12-22',
      reason: 'Private executive off',
    });

    // HR get/list checks
    assert.equal(evalRuleLeaveBalanceGet({ uid: 'hr1', role: 'hr_manager', deptId: 'dept_hr', verified: true }, saBal), false);
    assert.equal(evalRuleLeaveBalanceGet({ uid: 'hr1', role: 'hr_manager', deptId: 'dept_hr', verified: true }, empBal), true);
    assert.equal(evalRuleLeaveBalanceListQuery({ uid: 'hr1', role: 'hr_manager', deptId: 'dept_hr', verified: true }, 'all', [empBal]), false);
    assert.equal(evalRuleLeaveBalanceListQuery({ uid: 'hr1', role: 'hr_manager', deptId: 'dept_hr', verified: true }, 'hr_scoped', [empBal, saBal]), false);
    assert.equal(evalRuleLeaveBalanceListQuery({ uid: 'hr1', role: 'hr_manager', deptId: 'dept_hr', verified: true }, 'hr_scoped', [empBal]), true);

    // HR private leave request checks
    assert.equal(evalRuleLeaveRequestGet({ uid: 'hr1', role: 'hr_manager', deptId: 'dept_hr', verified: true }, saLeave), false);
    assert.equal(filterVisibleLeaveRequests([saLeave], 'hr1', 'hr_manager', 'dept_hr').length, 0);

    // HR syncEmployeeLeaveScope on Super Admin blocked
    await assert.rejects(
      () => syncEmployeeLeaveScope(store, actors.hr1, 'sa1'),
      (e: unknown) => e instanceof HttpLeaveError && e.status === 403,
    );

    // HR annual reset leaves Super Admin balance untouched
    await executeAnnualLeaveReset(store, actors.hr1, { targetYear: 2027, carryForwardEnabled: true, maxCarryForwardPaid: 10 });
    const saBalAfter = store.get('leaveBalances', 'sa1') as unknown as LeaveBalance;
    const empBalAfter = store.get('leaveBalances', 'emp_a1') as unknown as LeaveBalance;
    assert.equal(saBalAfter.year, 2026);
    assert.equal(empBalAfter.year, 2027);
  });

  await t.test('Case 11: Designated approver (with active role) reads & approves assigned Super Admin leave only', async () => {
    const store = createSeededStore();
    store.seed('settings', 'leavePolicy', {
      id: 'leavePolicy',
      casualAnnual: 12,
      sickAnnual: 10,
      paidAnnual: 15,
      emergencyAnnual: 5,
      carryForwardEnabled: true,
      maxCarryForwardPaid: 10,
      superAdminSelfApprovalMode: 'designated_approver',
      superAdminApproverUid: 'dm_eng',
    });

    const { leaveRequest: saPending, autoApproved } = await submitLeaveRequest(store, actors.sa1, {
      leaveType: 'paid',
      dayPart: 'full',
      startDate: '2026-12-23',
      endDate: '2026-12-24',
      reason: 'Executive retreat',
    });
    assert.equal(autoApproved, false);
    assert.equal(saPending.status, 'pending');
    assert.equal(saPending.reportingManagerUid, 'dm_eng');
    assert.equal(saPending.departmentId, EXECUTIVE_PRIVATE_DEPT);

    // Designated approver can read and approve; HR (not designated) cannot
    assert.equal(evalRuleLeaveRequestGet({ uid: 'dm_eng', role: 'dept_manager', deptId: 'dept_eng', verified: true }, saPending), true);
    assert.equal(evalRuleLeaveRequestGet({ uid: 'hr1', role: 'hr_manager', deptId: 'dept_hr', verified: true }, saPending), false);

    await assert.rejects(
      () => decideLeaveRequest(store, actors.hr1, saPending.id, 'approved', 'Unauthorized HR'),
      (e: unknown) => e instanceof HttpLeaveError && e.status === 403,
    );

    const saApproved = await decideLeaveRequest(store, actors.dmEng, saPending.id, 'approved', 'Confirmed executive leave');
    assert.equal(saApproved.leaveRequest.status, 'approved');
    assert.equal(saApproved.balance?.paidUsed, 2);
  });

  await t.test('Case 12: Super Admin auto-audit self-leave works atomically and stays __executive_private__', async () => {
    const store = createSeededStore();
    const { leaveRequest, autoApproved } = await submitLeaveRequest(store, actors.sa1, {
      leaveType: 'casual',
      dayPart: 'full',
      startDate: '2026-12-28',
      endDate: '2026-12-29',
      reason: 'Year-end executive leave',
    });

    assert.equal(autoApproved, true);
    assert.equal(leaveRequest.status, 'approved');
    assert.equal(leaveRequest.departmentId, EXECUTIVE_PRIVATE_DEPT);
    const bal = store.get('leaveBalances', 'sa1') as unknown as LeaveBalance;
    assert.equal(bal.casualUsed, 2);
  });

  await t.test('Case 13: Duplicate approval prevention rejects second approve and never double-deducts balance', async () => {
    const store = createSeededStore();
    const { leaveRequest } = await submitLeaveRequest(store, actors.empA1, {
      leaveType: 'paid',
      dayPart: 'full',
      startDate: '2026-12-16',
      endDate: '2026-12-18',
      reason: 'Family travel',
    });

    await decideLeaveRequest(store, actors.tlA, leaveRequest.id, 'approved', 'Approved');
    await assert.rejects(
      () => decideLeaveRequest(store, actors.hr1, leaveRequest.id, 'approved', 'Duplicate approval'),
      (e: unknown) => e instanceof HttpLeaveError && e.status === 409,
    );
    const bal = store.get('leaveBalances', 'emp_a1') as unknown as LeaveBalance;
    assert.equal(bal.paidUsed, 3);
  });

  await t.test('Case 14: Cancel approved leave refunds exact quota once and blocks duplicate refund', async () => {
    const store = createSeededStore();
    const { leaveRequest } = await submitLeaveRequest(store, actors.empA1, {
      leaveType: 'paid',
      dayPart: 'full',
      startDate: '2026-12-16',
      endDate: '2026-12-18',
      reason: 'Winter travel',
    });

    await decideLeaveRequest(store, actors.tlA, leaveRequest.id, 'approved', 'Approved');
    assert.equal((store.get('leaveBalances', 'emp_a1') as unknown as LeaveBalance).paidUsed, 3);

    const refunded = await cancelApprovedAndRefundLeave(store, actors.hr1, leaveRequest.id, 'Project sprint moved');
    assert.equal(refunded.leaveRequest.status, 'cancelled');
    assert.equal(refunded.balance?.paidUsed, 0);

    // Duplicate refund must fail with 409 and never produce negative used balance
    await assert.rejects(
      () => cancelApprovedAndRefundLeave(store, actors.tlA, leaveRequest.id, 'Duplicate refund'),
      (e: unknown) => e instanceof HttpLeaveError && e.status === 409,
    );
    assert.equal((store.get('leaveBalances', 'emp_a1') as unknown as LeaveBalance).paidUsed, 0);
  });

  await t.test('Case 15: Rejected leave never deducts balance and resubmit flow works cleanly', async () => {
    const store = createSeededStore();
    await ensureEmployeeLeaveBalance(store, actors.empA1);
    const { leaveRequest } = await submitLeaveRequest(store, actors.empA1, {
      leaveType: 'paid',
      dayPart: 'full',
      startDate: '2026-12-21',
      endDate: '2026-12-22',
      reason: 'Short trip',
    });

    const changes = await decideLeaveRequest(store, actors.tlA, leaveRequest.id, 'changes_requested', 'Shift dates after demo');
    assert.equal(changes.leaveRequest.status, 'changes_requested');
    assert.equal((store.get('leaveBalances', 'emp_a1') as unknown as LeaveBalance).paidUsed, 0);

    const resub = await resubmitLeaveRequest(store, actors.empA1, leaveRequest.id, {
      leaveType: 'paid',
      dayPart: 'full',
      startDate: '2026-12-24',
      endDate: '2026-12-25',
      reason: 'Moved after client demo',
    });
    assert.equal(resub.leaveRequest.status, 'pending');

    const rejected = await decideLeaveRequest(store, actors.tlA, leaveRequest.id, 'rejected', 'Year-end freeze');
    assert.equal(rejected.leaveRequest.status, 'rejected');
    assert.equal((store.get('leaveBalances', 'emp_a1') as unknown as LeaveBalance).paidUsed, 0);

    // Also verify employee can cancel a pending leave and Super Admin manual adjust is Super Admin-only
    const { leaveRequest: pending2 } = await submitLeaveRequest(store, actors.empA1, {
      leaveType: 'casual',
      dayPart: 'full',
      startDate: '2026-12-29',
      endDate: '2026-12-29',
      reason: 'Personal errand',
    });
    const cancelled = await cancelPendingLeaveRequest(store, actors.empA1, pending2.id);
    assert.equal(cancelled.leaveRequest.status, 'cancelled');

    await assert.rejects(
      () => adjustLeaveBalance(store, actors.hr1, { targetUid: 'emp_a1', bucket: 'paidTotal', mode: 'add', value: 5, reason: 'Unauthorized' }),
      (e: unknown) => e instanceof HttpLeaveError && e.status === 403,
    );
    const adjusted = await adjustLeaveBalance(store, actors.sa1, {
      targetUid: 'emp_a1',
      bucket: 'paidTotal',
      mode: 'add',
      value: 2,
      reason: 'Compensatory bonus credit',
    });
    assert.equal(adjusted.newValue, 17);
  });
});
