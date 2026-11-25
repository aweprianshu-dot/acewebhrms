import type {
  ApprovalWorkflowSettings,
  EmployeeProfile,
  Holiday,
  LeaveBalance,
  LeavePolicySettings,
  LeaveRequest,
  LeaveType,
  RoleAssignment,
  UserRole,
  WorkPolicySettings,
} from '../types/hrms';
import {
  DEFAULT_WORKFLOW_RULES,
  EXECUTIVE_PRIVATE_DEPT,
  buildApprovedLeaveBalancePatch,
  buildCancelledApprovedLeaveRefundPatch,
  canUserActOnLeaveRequest,
  computeCarryForwardReset,
  isManagementRole,
  validateLeaveApplication,
} from '../utils/workflowUtils.ts';

export class HttpLeaveError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'HttpLeaveError';
    this.status = status;
  }
}

export interface LeaveActor {
  uid: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
}

export interface LeaveTxContext {
  getDoc(collectionName: string, docId: string): Promise<Record<string, unknown> | null>;
  queryWhere(collectionName: string, field: string, value: unknown): Promise<Array<{ id: string; data: Record<string, unknown> }>>;
  setDoc(collectionName: string, docId: string, data: Record<string, unknown>): void;
  updateDoc(collectionName: string, docId: string, patch: Record<string, unknown>): void;
}

export interface LeaveStoreAdapter {
  getDoc(collectionName: string, docId: string): Promise<Record<string, unknown> | null>;
  listCollection(collectionName: string): Promise<Array<{ id: string; data: Record<string, unknown> }>>;
  queryWhere(collectionName: string, field: string, value: unknown): Promise<Array<{ id: string; data: Record<string, unknown> }>>;
  runTransaction<T>(fn: (tx: LeaveTxContext) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
  nowIso(): string;
  createId(prefix: string): string;
  dispatchNotification?(params: {
    id: string;
    recipientUid: string;
    recipientEmail?: string;
    title: string;
    message: string;
    linkTab: string;
  }): Promise<void>;
}

const DEFAULT_LEAVE_POLICY: LeavePolicySettings = {
  id: 'leavePolicy',
  casualAnnual: 12,
  sickAnnual: 10,
  paidAnnual: 15,
  emergencyAnnual: 5,
  carryForwardEnabled: true,
  maxCarryForwardPaid: 10,
  superAdminSelfApprovalMode: 'auto_audit',
};

const DEFAULT_WORK_POLICY: WorkPolicySettings = {
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
};

const BOOTSTRAP_OWNER_EMAIL = 'awe.prianshu@gmail.com';

async function loadTrustedActorContext(
  store: LeaveStoreAdapter,
  actor: LeaveActor,
): Promise<{
  role: UserRole;
  departmentId: string;
  employee: EmployeeProfile | null;
  fullName: string;
  email: string;
}> {
  if (!actor.emailVerified) {
    throw new HttpLeaveError('Verified email is required for leave operations.', 403);
  }
  const roleDoc = await store.getDoc('roles', actor.uid);
  const adminDoc = await store.getDoc('admins', actor.uid);
  const isBootstrap = actor.email === BOOTSTRAP_OWNER_EMAIL;

  let role: UserRole | null = null;
  let roleDeptId = '';

  if (roleDoc) {
    if (roleDoc.status !== 'active' && !isBootstrap) {
      throw new HttpLeaveError('Active HRMS membership is required.', 403);
    }
    role = roleDoc.role as UserRole;
    roleDeptId = String(roleDoc.departmentId || '');
  } else if (isBootstrap || adminDoc) {
    role = 'super_admin';
  }

  if (!role) {
    throw new HttpLeaveError('Active HRMS role assignment is required.', 403);
  }

  const empByUid = await store.queryWhere('employees', 'uid', actor.uid);
  let employee = (empByUid[0]?.data as unknown as EmployeeProfile | undefined) || null;
  if (!employee && actor.email) {
    const empByEmail = await store.queryWhere('employees', 'email', actor.email.toLowerCase());
    employee = (empByEmail[0]?.data as unknown as EmployeeProfile | undefined) || null;
  }

  const userDoc = await store.getDoc('users', actor.uid);
  const fullName = String(
    employee?.fullName || userDoc?.displayName || actor.displayName || actor.email || 'Team Member',
  ).slice(0, 120);

  return {
    role,
    departmentId: employee?.departmentId || roleDeptId || 'dept_exec',
    employee,
    fullName,
    email: String(employee?.email || actor.email || ''),
  };
}

async function loadPoliciesAndHolidays(store: LeaveStoreAdapter): Promise<{
  leavePolicy: LeavePolicySettings;
  workPolicy: WorkPolicySettings;
  workflowSettings: ApprovalWorkflowSettings;
  holidays: Holiday[];
}> {
  const [leavePolRaw, workPolRaw, workflowRaw, holidaysRaw] = await Promise.all([
    store.getDoc('settings', 'leavePolicy'),
    store.getDoc('settings', 'workPolicy'),
    store.getDoc('settings', 'approvalWorkflows'),
    store.listCollection('holidays'),
  ]);

  const leavePolicy: LeavePolicySettings = {
    ...DEFAULT_LEAVE_POLICY,
    ...(leavePolRaw as Partial<LeavePolicySettings> | null),
  };
  const workPolicy: WorkPolicySettings = {
    ...DEFAULT_WORK_POLICY,
    ...(workPolRaw as Partial<WorkPolicySettings> | null),
  };
  const workflowSettings: ApprovalWorkflowSettings = {
    id: 'approvalWorkflows',
    rules: Array.isArray((workflowRaw as Partial<ApprovalWorkflowSettings> | null)?.rules)
      ? ((workflowRaw as Partial<ApprovalWorkflowSettings>).rules ?? DEFAULT_WORKFLOW_RULES)
      : DEFAULT_WORKFLOW_RULES,
  };
  const holidays = holidaysRaw.map((h) => h.data as unknown as Holiday);
  return { leavePolicy, workPolicy, workflowSettings, holidays };
}

function buildPolicyBalanceRecord(params: {
  uid: string;
  employeeId: string;
  ownerRole: UserRole;
  departmentId: string;
  teamId: string;
  teamLeadUid: string;
  reportingManagerUid: string;
  policy: LeavePolicySettings;
  year: number;
}): LeaveBalance {
  const isSuper = params.ownerRole === 'super_admin';
  return {
    uid: params.uid,
    employeeId: params.employeeId,
    departmentId: isSuper ? EXECUTIVE_PRIVATE_DEPT : params.departmentId || 'dept_exec',
    teamId: isSuper ? '' : params.teamId || '',
    teamLeadUid: isSuper ? '' : params.teamLeadUid || '',
    reportingManagerUid: isSuper ? '' : params.reportingManagerUid || '',
    ownerRole: params.ownerRole,
    year: params.year,
    casualTotal: Math.max(0, Math.min(365, Number(params.policy.casualAnnual ?? 12))),
    casualUsed: 0,
    sickTotal: Math.max(0, Math.min(365, Number(params.policy.sickAnnual ?? 10))),
    sickUsed: 0,
    paidTotal: Math.max(0, Math.min(365, Number(params.policy.paidAnnual ?? 15))),
    paidUsed: 0,
    emergencyTotal: Math.max(0, Math.min(365, Number(params.policy.emergencyAnnual ?? 5))),
    emergencyUsed: 0,
    unpaidUsed: 0,
  };
}

async function resolveLeaveApproverTargets(
  store: LeaveStoreAdapter,
  params: {
    requesterUid: string;
    requesterRole: UserRole;
    teamLeadUid?: string;
    reportingManagerUid?: string;
  },
): Promise<Array<{ uid: string; email?: string }>> {
  const out: Array<{ uid: string; email?: string }> = [];
  const seen = new Set<string>([params.requesterUid]);
  const pushUid = async (targetUid?: string) => {
    if (!targetUid || seen.has(targetUid)) return;
    seen.add(targetUid);
    const empMatches = await store.queryWhere('employees', 'uid', targetUid);
    const roleDoc = await store.getDoc('roles', targetUid);
    const email = String(empMatches[0]?.data.email || roleDoc?.email || '');
    out.push({ uid: targetUid, email: email || undefined });
  };

  if (params.requesterRole === 'super_admin') {
    if (params.reportingManagerUid) {
      await pushUid(params.reportingManagerUid);
    }
    return out;
  }

  if (params.teamLeadUid) await pushUid(params.teamLeadUid);
  else if (params.reportingManagerUid) await pushUid(params.reportingManagerUid);

  if (out.length === 0) {
    const activeRoles = await store.queryWhere('roles', 'status', 'active');
    for (const r of activeRoles) {
      if (r.data.role === 'hr_manager') await pushUid(r.id);
    }
    if (out.length === 0) {
      for (const r of activeRoles) {
        if (r.data.role === 'super_admin') await pushUid(r.id);
      }
    }
  }
  return out;
}

export async function ensureEmployeeLeaveBalance(
  store: LeaveStoreAdapter,
  actor: LeaveActor,
): Promise<{ balance: LeaveBalance; created: boolean }> {
  const ctx = await loadTrustedActorContext(store, actor);
  const { leavePolicy } = await loadPoliciesAndHolidays(store);
  const year = new Date().getUTCFullYear();
  const isSuper = ctx.role === 'super_admin';

  return store.runTransaction(async (tx) => {
    const existing = await tx.getDoc('leaveBalances', actor.uid);
    if (existing) {
      const patch: Record<string, unknown> = {};
      if (!existing.ownerRole) patch.ownerRole = ctx.role;
      if (!existing.departmentId || (isSuper && existing.departmentId !== EXECUTIVE_PRIVATE_DEPT)) {
        patch.departmentId = isSuper ? EXECUTIVE_PRIVATE_DEPT : ctx.departmentId;
      }
      if (existing.teamId === undefined) patch.teamId = isSuper ? '' : ctx.employee?.teamId || '';
      if (existing.teamLeadUid === undefined) patch.teamLeadUid = isSuper ? '' : ctx.employee?.teamLeadUid || '';
      if (existing.reportingManagerUid === undefined) {
        patch.reportingManagerUid = isSuper ? '' : ctx.employee?.reportingManagerUid || '';
      }
      if (Object.keys(patch).length > 0) {
        tx.updateDoc('leaveBalances', actor.uid, { ...patch, updatedAt: store.serverTimestamp() });
      }
      return {
        balance: { ...(existing as unknown as LeaveBalance), ...patch },
        created: false,
      };
    }

    const createdBal = buildPolicyBalanceRecord({
      uid: actor.uid,
      employeeId: ctx.employee?.id || actor.uid,
      ownerRole: ctx.role,
      departmentId: ctx.departmentId,
      teamId: ctx.employee?.teamId || '',
      teamLeadUid: ctx.employee?.teamLeadUid || '',
      reportingManagerUid: ctx.employee?.reportingManagerUid || '',
      policy: leavePolicy,
      year,
    });
    tx.setDoc('leaveBalances', actor.uid, {
      ...createdBal,
      createdAt: store.serverTimestamp(),
      updatedAt: store.serverTimestamp(),
    });
    return { balance: createdBal, created: true };
  });
}

export async function migrateLegacyLeaveBalances(
  store: LeaveStoreAdapter,
  actor: LeaveActor,
): Promise<{ migratedCount: number; inspectedCount: number }> {
  const ctx = await loadTrustedActorContext(store, actor);
  if (ctx.role !== 'super_admin' && ctx.role !== 'hr_manager') {
    throw new HttpLeaveError('Only Super Admin or HR Manager can run balance metadata migration.', 403);
  }

  const [balDocs, roleDocs, empDocs] = await Promise.all([
    store.listCollection('leaveBalances'),
    store.listCollection('roles'),
    store.listCollection('employees'),
  ]);
  const roleMap = new Map(roleDocs.map((r) => [r.id, r.data as unknown as RoleAssignment]));
  const empByUid = new Map(
    empDocs
      .filter((e) => Boolean(e.data.uid))
      .map((e) => [String(e.data.uid), e.data as unknown as EmployeeProfile]),
  );

  let migratedCount = 0;
  for (const bDoc of balDocs) {
    const uid = bDoc.id;
    const roleRec = roleMap.get(uid);
    const emp = empByUid.get(uid);
    const ownerRole: UserRole = (roleRec?.role as UserRole) || (bDoc.data.ownerRole as UserRole) || 'employee';
    const isSuperTarget = ownerRole === 'super_admin';
    if (ctx.role === 'hr_manager' && isSuperTarget) continue;

    const targetDept = isSuperTarget
      ? EXECUTIVE_PRIVATE_DEPT
      : emp?.departmentId || roleRec?.departmentId || String(bDoc.data.departmentId || 'dept_exec');
    const targetTeamId = isSuperTarget ? '' : emp?.teamId || String(bDoc.data.teamId || '');
    const targetTlUid = isSuperTarget ? '' : emp?.teamLeadUid || String(bDoc.data.teamLeadUid || '');
    const targetMgrUid = isSuperTarget ? '' : emp?.reportingManagerUid || String(bDoc.data.reportingManagerUid || '');

    const needsUpdate =
      bDoc.data.ownerRole !== ownerRole ||
      bDoc.data.departmentId !== targetDept ||
      bDoc.data.teamId !== targetTeamId ||
      bDoc.data.teamLeadUid !== targetTlUid ||
      bDoc.data.reportingManagerUid !== targetMgrUid;

    if (needsUpdate) {
      await store.runTransaction(async (tx) => {
        const live = await tx.getDoc('leaveBalances', uid);
        if (!live) return;
        tx.updateDoc('leaveBalances', uid, {
          ownerRole,
          departmentId: targetDept,
          teamId: targetTeamId,
          teamLeadUid: targetTlUid,
          reportingManagerUid: targetMgrUid,
          updatedAt: store.serverTimestamp(),
        });
      });
      migratedCount += 1;
    }
  }

  return { migratedCount, inspectedCount: balDocs.length };
}

export async function syncEmployeeLeaveScope(
  store: LeaveStoreAdapter,
  actor: LeaveActor,
  targetUid: string,
): Promise<{ updated: boolean }> {
  const ctx = await loadTrustedActorContext(store, actor);
  if (ctx.role !== 'super_admin' && ctx.role !== 'hr_manager') {
    throw new HttpLeaveError('Only HR or Super Admin can synchronize employee leave scope.', 403);
  }
  if (!targetUid) throw new HttpLeaveError('Target employee UID is required.', 400);

  const [roleDoc, empMatches] = await Promise.all([
    store.getDoc('roles', targetUid),
    store.queryWhere('employees', 'uid', targetUid),
  ]);
  const ownerRole = (roleDoc?.role as UserRole) || 'employee';
  if (ctx.role === 'hr_manager' && ownerRole === 'super_admin') {
    throw new HttpLeaveError('HR cannot modify a Super Admin leave balance record.', 403);
  }
  const emp = empMatches[0]?.data as unknown as EmployeeProfile | undefined;
  const isSuperTarget = ownerRole === 'super_admin';

  const updated = await store.runTransaction(async (tx) => {
    const live = await tx.getDoc('leaveBalances', targetUid);
    if (!live) return false;
    tx.updateDoc('leaveBalances', targetUid, {
      ownerRole,
      departmentId: isSuperTarget ? EXECUTIVE_PRIVATE_DEPT : emp?.departmentId || String(live.departmentId || 'dept_exec'),
      teamId: isSuperTarget ? '' : emp?.teamId || '',
      teamLeadUid: isSuperTarget ? '' : emp?.teamLeadUid || '',
      reportingManagerUid: isSuperTarget ? '' : emp?.reportingManagerUid || '',
      updatedAt: store.serverTimestamp(),
    });
    return true;
  });

  return { updated };
}

export interface SubmitLeaveInput {
  leaveType: LeaveType;
  dayPart: 'full' | 'first_half' | 'second_half' | 'short';
  shortLeaveHours?: number;
  startDate: string;
  endDate: string;
  reason: string;
  attachmentUrl?: string;
  attachmentName?: string;
}

export async function submitLeaveRequest(
  store: LeaveStoreAdapter,
  actor: LeaveActor,
  input: SubmitLeaveInput,
): Promise<{ leaveRequest: LeaveRequest; autoApproved: boolean }> {
  const ctx = await loadTrustedActorContext(store, actor);
  const { leavePolicy, workPolicy, holidays } = await loadPoliciesAndHolidays(store);

  const reason = String(input.reason || '').trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new HttpLeaveError('Reason must be between 3 and 500 characters.', 400);
  }

  const optSelections = await store.queryWhere('optionalHolidaySelections', 'uid', actor.uid);
  const selectedOptionalIds = optSelections.map((s) => String(s.data.holidayId || '')).filter(Boolean);

  const isSuper = ctx.role === 'super_admin';
  let designatedApproverUid = '';
  if (
    isSuper &&
    leavePolicy.superAdminSelfApprovalMode === 'designated_approver' &&
    leavePolicy.superAdminApproverUid &&
    leavePolicy.superAdminApproverUid !== actor.uid
  ) {
    const approverRole = await store.getDoc('roles', leavePolicy.superAdminApproverUid);
    if (
      approverRole &&
      approverRole.status === 'active' &&
      ['hr_manager', 'dept_manager', 'team_lead', 'super_admin'].includes(String(approverRole.role))
    ) {
      designatedApproverUid = leavePolicy.superAdminApproverUid;
    }
  }
  const autoApproveSuperAdmin = isSuper && !designatedApproverUid;
  const year = Number(String(input.startDate).slice(0, 4)) || new Date().getUTCFullYear();
  const leaveId = store.createId('lv');

  const result = await store.runTransaction(async (tx) => {
    const balRaw = await tx.getDoc('leaveBalances', actor.uid);
    const liveBal: LeaveBalance = balRaw
      ? (balRaw as unknown as LeaveBalance)
      : buildPolicyBalanceRecord({
          uid: actor.uid,
          employeeId: ctx.employee?.id || actor.uid,
          ownerRole: ctx.role,
          departmentId: ctx.departmentId,
          teamId: ctx.employee?.teamId || '',
          teamLeadUid: ctx.employee?.teamLeadUid || '',
          reportingManagerUid: ctx.employee?.reportingManagerUid || '',
          policy: leavePolicy,
          year,
        });

    const validation = validateLeaveApplication({
      leaveType: input.leaveType,
      dayPart: input.dayPart,
      shortLeaveHours: input.shortLeaveHours,
      startDate: input.startDate,
      endDate: input.endDate,
      balance: liveBal,
      policy: leavePolicy,
      weeklyOffs: workPolicy.weeklyOffs || ['Saturday', 'Sunday'],
      holidays,
      countryCode: ctx.employee?.countryCode || 'IN',
      selectedOptionalHolidayIds: selectedOptionalIds,
    });

    if (!validation.valid) {
      throw new HttpLeaveError(validation.error || 'Leave validation failed.', 400);
    }

    const daysCount = validation.breakdown.workingDays;
    const attachmentUrl = input.attachmentUrl ? String(input.attachmentUrl).slice(0, 1500) : '';
    const attachmentName = input.attachmentName ? String(input.attachmentName).slice(0, 200) : '';

    // Server resolves ALL identity, department, team, and approver fields from trusted Firestore profile
    const leaveRecord: LeaveRequest & { createdAt?: unknown; updatedAt?: unknown } = {
      id: leaveId,
      uid: actor.uid,
      employeeId: ctx.employee?.id || actor.uid,
      employeeName: ctx.fullName,
      departmentId: isSuper ? EXECUTIVE_PRIVATE_DEPT : ctx.departmentId,
      ...(isSuper
        ? {}
        : {
            teamId: ctx.employee?.teamId || '',
            teamName: ctx.employee?.teamName || '',
            teamLeadUid: ctx.employee?.teamLeadUid || '',
          }),
      reportingManagerUid: isSuper ? designatedApproverUid : ctx.employee?.reportingManagerUid || '',
      requesterRole: ctx.role,
      leaveType: input.leaveType,
      startDate: input.startDate,
      endDate: input.endDate,
      daysCount,
      dayPart: input.dayPart,
      ...(input.dayPart === 'short' ? { shortLeaveHours: Math.min(2, Math.max(1, Number(input.shortLeaveHours || 1))) } : {}),
      reason,
      ...(attachmentUrl ? { attachmentUrl, attachmentName } : {}),
      status: autoApproveSuperAdmin ? 'approved' : 'pending',
      ...(autoApproveSuperAdmin
        ? {
            reviewedByUid: actor.uid,
            reviewerName: `${ctx.fullName} (Auto-Audit)`,
            reviewComment: 'Auto-approved with full audit trail per Super Admin Leave Governance Policy.',
          }
        : {}),
      createdAt: store.serverTimestamp(),
      updatedAt: store.serverTimestamp(),
    };

    if (!balRaw) {
      const initialBal: Record<string, unknown> = {
        ...liveBal,
        ...(autoApproveSuperAdmin ? buildApprovedLeaveBalancePatch(liveBal, leaveRecord) : {}),
        createdAt: store.serverTimestamp(),
        updatedAt: store.serverTimestamp(),
      };
      tx.setDoc('leaveBalances', actor.uid, initialBal);
    } else if (autoApproveSuperAdmin) {
      const patch = buildApprovedLeaveBalancePatch(liveBal, leaveRecord);
      if (Object.keys(patch).length > 0) {
        tx.updateDoc('leaveBalances', actor.uid, { ...patch, updatedAt: store.serverTimestamp() });
      }
    }

    tx.setDoc('leaveRequests', leaveId, leaveRecord as unknown as Record<string, unknown>);

    const auditId = store.createId('audit');
    tx.setDoc('auditLogs', auditId, {
      id: auditId,
      actorUid: actor.uid,
      actorEmail: ctx.email,
      actorRole: ctx.role,
      action: autoApproveSuperAdmin ? 'SUPER_ADMIN_SELF_LEAVE_AUTO_AUDITED' : 'LEAVE_APPLIED',
      targetCollection: 'leaveRequests',
      targetId: leaveId,
      summary: `${autoApproveSuperAdmin ? 'Auto-audited' : 'Submitted'} ${daysCount}d ${input.leaveType} leave (${input.startDate} to ${input.endDate})`,
      createdAt: store.serverTimestamp(),
    });

    return { leaveRequest: leaveRecord, autoApproved: autoApproveSuperAdmin };
  });

  if (store.dispatchNotification) {
    await store.dispatchNotification({
      id: store.createId('notif'),
      recipientUid: actor.uid,
      recipientEmail: ctx.email || undefined,
      title: result.autoApproved ? 'Personal Leave Recorded (Auto-Audited)' : 'Leave Application Submitted',
      message: result.autoApproved
        ? `Your private ${input.leaveType} leave (${input.startDate} to ${input.endDate}, ${result.leaveRequest.daysCount}d) was recorded and logged to the audit trail.`
        : `Your ${input.leaveType} leave (${input.startDate} to ${input.endDate}, ${result.leaveRequest.daysCount}d) was submitted for approval.`,
      linkTab: 'leave',
    });

    if (!result.autoApproved) {
      const targets = await resolveLeaveApproverTargets(store, {
        requesterUid: actor.uid,
        requesterRole: ctx.role,
        teamLeadUid: isSuper ? '' : ctx.employee?.teamLeadUid,
        reportingManagerUid: isSuper ? designatedApproverUid : ctx.employee?.reportingManagerUid,
      });
      for (const target of targets) {
        await store.dispatchNotification({
          id: store.createId('notif'),
          recipientUid: target.uid,
          recipientEmail: target.email,
          title: isSuper ? 'Executive Leave Approval Request' : 'Team Leave Request Pending Approval',
          message: `${ctx.fullName} requested ${result.leaveRequest.daysCount}d ${input.leaveType} leave (${input.startDate} to ${input.endDate}).`,
          linkTab: 'leave',
        });
      }
    }
  }

  return result;
}

export async function resubmitLeaveRequest(
  store: LeaveStoreAdapter,
  actor: LeaveActor,
  leaveId: string,
  input: SubmitLeaveInput,
): Promise<{ leaveRequest: LeaveRequest }> {
  const ctx = await loadTrustedActorContext(store, actor);
  const { leavePolicy, workPolicy, holidays } = await loadPoliciesAndHolidays(store);

  const reason = String(input.reason || '').trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new HttpLeaveError('Reason must be between 3 and 500 characters.', 400);
  }
  const optSelections = await store.queryWhere('optionalHolidaySelections', 'uid', actor.uid);
  const selectedOptionalIds = optSelections.map((s) => String(s.data.holidayId || '')).filter(Boolean);

  const updatedReq = await store.runTransaction(async (tx) => {
    const reqRaw = await tx.getDoc('leaveRequests', leaveId);
    if (!reqRaw) throw new HttpLeaveError('Leave request not found.', 404);
    const liveReq = reqRaw as unknown as LeaveRequest;
    if (liveReq.uid !== actor.uid) {
      throw new HttpLeaveError('Only the leave owner can resubmit this request.', 403);
    }
    if (liveReq.status !== 'changes_requested') {
      throw new HttpLeaveError(`Cannot resubmit a leave in "${liveReq.status}" status.`, 409);
    }

    const balRaw = await tx.getDoc('leaveBalances', actor.uid);
    const validation = validateLeaveApplication({
      leaveType: input.leaveType,
      dayPart: input.dayPart,
      shortLeaveHours: input.shortLeaveHours,
      startDate: input.startDate,
      endDate: input.endDate,
      balance: balRaw ? (balRaw as unknown as LeaveBalance) : null,
      policy: leavePolicy,
      weeklyOffs: workPolicy.weeklyOffs || ['Saturday', 'Sunday'],
      holidays,
      countryCode: ctx.employee?.countryCode || 'IN',
      selectedOptionalHolidayIds: selectedOptionalIds,
    });
    if (!validation.valid) {
      throw new HttpLeaveError(validation.error || 'Leave validation failed.', 400);
    }

    const daysCount = validation.breakdown.workingDays;
    const attachmentUrl = input.attachmentUrl ? String(input.attachmentUrl).slice(0, 1500) : liveReq.attachmentUrl;
    const attachmentName = input.attachmentName ? String(input.attachmentName).slice(0, 200) : liveReq.attachmentName;
    const resubmittedAt = store.nowIso();

    const patch: Record<string, unknown> = {
      leaveType: input.leaveType,
      startDate: input.startDate,
      endDate: input.endDate,
      daysCount,
      dayPart: input.dayPart,
      ...(input.dayPart === 'short' ? { shortLeaveHours: Math.min(2, Math.max(1, Number(input.shortLeaveHours || 1))) } : {}),
      reason,
      ...(attachmentUrl ? { attachmentUrl, attachmentName } : {}),
      status: 'pending',
      resubmittedAt,
      updatedAt: store.serverTimestamp(),
    };
    tx.updateDoc('leaveRequests', leaveId, patch);

    const auditId = store.createId('audit');
    tx.setDoc('auditLogs', auditId, {
      id: auditId,
      actorUid: actor.uid,
      actorEmail: ctx.email,
      actorRole: ctx.role,
      action: 'LEAVE_RESUBMITTED',
      targetCollection: 'leaveRequests',
      targetId: leaveId,
      summary: `Resubmitted ${daysCount}d ${input.leaveType} leave (${input.startDate} to ${input.endDate}) after requested changes`,
      createdAt: store.serverTimestamp(),
    });

    return { ...liveReq, ...patch } as LeaveRequest;
  });

  if (store.dispatchNotification) {
    const targets = await resolveLeaveApproverTargets(store, {
      requesterUid: actor.uid,
      requesterRole: ctx.role,
      teamLeadUid: updatedReq.teamLeadUid,
      reportingManagerUid: updatedReq.reportingManagerUid,
    });
    for (const target of targets) {
      await store.dispatchNotification({
        id: store.createId('notif'),
        recipientUid: target.uid,
        recipientEmail: target.email,
        title: 'Leave Request Resubmitted',
        message: `${ctx.fullName} updated and resubmitted their ${updatedReq.leaveType} leave (${updatedReq.startDate} to ${updatedReq.endDate}, ${updatedReq.daysCount}d).`,
        linkTab: 'leave',
      });
    }
  }

  return { leaveRequest: updatedReq };
}

export async function decideLeaveRequest(
  store: LeaveStoreAdapter,
  actor: LeaveActor,
  leaveId: string,
  decision: 'approved' | 'rejected' | 'changes_requested',
  rawComment?: string,
): Promise<{ leaveRequest: LeaveRequest; balance?: LeaveBalance }> {
  const ctx = await loadTrustedActorContext(store, actor);
  if (!isManagementRole(ctx.role)) {
    throw new HttpLeaveError('Employees do not have leave approval authority.', 403);
  }

  const comment = String(rawComment || '').trim();
  if ((decision === 'rejected' || decision === 'changes_requested') && comment.length < 3) {
    throw new HttpLeaveError('Please provide a clear review comment (at least 3 characters).', 400);
  }

  const { leavePolicy, workflowSettings } = await loadPoliciesAndHolidays(store);

  const txResult = await store.runTransaction(async (tx) => {
    const reqRaw = await tx.getDoc('leaveRequests', leaveId);
    if (!reqRaw) throw new HttpLeaveError('Leave request not found.', 404);
    const liveReq = reqRaw as unknown as LeaveRequest;

    if (liveReq.status !== 'pending' && liveReq.status !== 'changes_requested') {
      throw new HttpLeaveError(`Leave request is already ${liveReq.status}; duplicate action prevented.`, 409);
    }

    const perms = canUserActOnLeaveRequest({
      request: liveReq,
      actorUid: actor.uid,
      actorRole: ctx.role,
      actorDeptId: ctx.departmentId,
      workflowSettings,
      leavePolicy,
    });
    if (!perms.canApprove) {
      throw new HttpLeaveError(perms.reason || 'You do not have authority over this leave request.', 403);
    }

    let updatedBal: LeaveBalance | undefined;
    if (decision === 'approved') {
      const balRaw = await tx.getDoc('leaveBalances', liveReq.uid);
      const liveBal: LeaveBalance = balRaw
        ? (balRaw as unknown as LeaveBalance)
        : buildPolicyBalanceRecord({
            uid: liveReq.uid,
            employeeId: liveReq.employeeId,
            ownerRole: liveReq.requesterRole || 'employee',
            departmentId: liveReq.departmentId,
            teamId: liveReq.teamId || '',
            teamLeadUid: liveReq.teamLeadUid || '',
            reportingManagerUid: liveReq.reportingManagerUid || '',
            policy: leavePolicy,
            year: Number(String(liveReq.startDate).slice(0, 4)) || new Date().getUTCFullYear(),
          });

      if (liveReq.dayPart !== 'short' && liveReq.leaveType !== 'short' && liveReq.leaveType !== 'unpaid') {
        const totals: Record<'casual' | 'sick' | 'paid' | 'emergency', [number, number]> = {
          casual: [liveBal.casualTotal, liveBal.casualUsed],
          sick: [liveBal.sickTotal, liveBal.sickUsed],
          paid: [liveBal.paidTotal, liveBal.paidUsed],
          emergency: [liveBal.emergencyTotal, liveBal.emergencyUsed],
        };
        const [totalAmt, usedAmt] = totals[liveReq.leaveType];
        const remaining = Math.round((totalAmt - usedAmt) * 100) / 100;
        if (liveReq.daysCount > remaining) {
          throw new HttpLeaveError(
            `Insufficient ${liveReq.leaveType} balance (${remaining}d remaining vs ${liveReq.daysCount}d requested).`,
            409,
          );
        }
      }

      const balPatch = buildApprovedLeaveBalancePatch(liveBal, liveReq);
      updatedBal = { ...liveBal, ...balPatch };
      if (!balRaw) {
        tx.setDoc('leaveBalances', liveReq.uid, {
          ...updatedBal,
          createdAt: store.serverTimestamp(),
          updatedAt: store.serverTimestamp(),
        });
      } else if (Object.keys(balPatch).length > 0) {
        tx.updateDoc('leaveBalances', liveReq.uid, {
          ...balPatch,
          updatedAt: store.serverTimestamp(),
        });
      }
    }

    const reqPatch: Record<string, unknown> = {
      status: decision,
      reviewedByUid: actor.uid,
      reviewerName: ctx.fullName,
      reviewComment: decision === 'approved' ? comment || 'Approved' : comment,
      updatedAt: store.serverTimestamp(),
    };
    tx.updateDoc('leaveRequests', leaveId, reqPatch);

    const auditId = store.createId('audit');
    tx.setDoc('auditLogs', auditId, {
      id: auditId,
      actorUid: actor.uid,
      actorEmail: ctx.email,
      actorRole: ctx.role,
      action:
        decision === 'approved'
          ? 'LEAVE_APPROVED'
          : decision === 'rejected'
          ? 'LEAVE_REJECTED'
          : 'LEAVE_CHANGES_REQUESTED',
      targetCollection: 'leaveRequests',
      targetId: leaveId,
      summary: `${decision.replace('_', ' ')} ${liveReq.daysCount}d ${liveReq.leaveType} leave for ${liveReq.employeeName}`,
      createdAt: store.serverTimestamp(),
    });

    return { leaveRequest: { ...liveReq, ...reqPatch } as LeaveRequest, balance: updatedBal };
  });

  if (store.dispatchNotification) {
    const empMatches = await store.queryWhere('employees', 'uid', txResult.leaveRequest.uid);
    const recipientEmail = String(empMatches[0]?.data.email || '');
    await store.dispatchNotification({
      id: store.createId('notif'),
      recipientUid: txResult.leaveRequest.uid,
      recipientEmail: recipientEmail || undefined,
      title:
        decision === 'approved'
          ? 'Leave Request Approved'
          : decision === 'rejected'
          ? 'Leave Request Rejected'
          : 'Leave Request Needs Changes',
      message:
        decision === 'approved'
          ? `Your ${txResult.leaveRequest.leaveType} leave (${txResult.leaveRequest.startDate} to ${txResult.leaveRequest.endDate}, ${txResult.leaveRequest.daysCount}d) was approved by ${ctx.fullName}.`
          : decision === 'rejected'
          ? `Your ${txResult.leaveRequest.leaveType} leave (${txResult.leaveRequest.startDate} to ${txResult.leaveRequest.endDate}) was rejected. Comment: ${comment}`
          : `${ctx.fullName} requested changes to your ${txResult.leaveRequest.leaveType} leave (${txResult.leaveRequest.startDate} to ${txResult.leaveRequest.endDate}): ${comment}`,
      linkTab: 'leave',
    });
  }

  return txResult;
}

export async function cancelPendingLeaveRequest(
  store: LeaveStoreAdapter,
  actor: LeaveActor,
  leaveId: string,
): Promise<{ leaveRequest: LeaveRequest }> {
  const ctx = await loadTrustedActorContext(store, actor);

  return store.runTransaction(async (tx) => {
    const reqRaw = await tx.getDoc('leaveRequests', leaveId);
    if (!reqRaw) throw new HttpLeaveError('Leave request not found.', 404);
    const liveReq = reqRaw as unknown as LeaveRequest;
    if (liveReq.uid !== actor.uid) {
      throw new HttpLeaveError('Only the leave requester can cancel a pending application.', 403);
    }
    if (liveReq.status !== 'pending' && liveReq.status !== 'changes_requested') {
      throw new HttpLeaveError(`Cannot cancel leave in "${liveReq.status}" status.`, 409);
    }

    const patch: Record<string, unknown> = {
      status: 'cancelled',
      cancelledByUid: actor.uid,
      updatedAt: store.serverTimestamp(),
    };
    tx.updateDoc('leaveRequests', leaveId, patch);

    const auditId = store.createId('audit');
    tx.setDoc('auditLogs', auditId, {
      id: auditId,
      actorUid: actor.uid,
      actorEmail: ctx.email,
      actorRole: ctx.role,
      action: 'LEAVE_CANCELLED',
      targetCollection: 'leaveRequests',
      targetId: leaveId,
      summary: `Cancelled ${liveReq.status} ${liveReq.leaveType} leave (${liveReq.startDate} to ${liveReq.endDate})`,
      createdAt: store.serverTimestamp(),
    });

    return { leaveRequest: { ...liveReq, ...patch } as LeaveRequest };
  });
}

export async function cancelApprovedAndRefundLeave(
  store: LeaveStoreAdapter,
  actor: LeaveActor,
  leaveId: string,
  rawReason: string,
): Promise<{ leaveRequest: LeaveRequest; balance?: LeaveBalance }> {
  const ctx = await loadTrustedActorContext(store, actor);
  if (!isManagementRole(ctx.role)) {
    throw new HttpLeaveError('You do not have authority to cancel approved leaves.', 403);
  }
  const cancelledReason = String(rawReason || '').trim();
  if (cancelledReason.length < 3 || cancelledReason.length > 500) {
    throw new HttpLeaveError('Please specify a clear cancellation reason (at least 3 characters).', 400);
  }
  const { leavePolicy, workflowSettings } = await loadPoliciesAndHolidays(store);

  const txResult = await store.runTransaction(async (tx) => {
    const reqRaw = await tx.getDoc('leaveRequests', leaveId);
    if (!reqRaw) throw new HttpLeaveError('Leave request not found.', 404);
    const liveReq = reqRaw as unknown as LeaveRequest;
    if (liveReq.status !== 'approved') {
      throw new HttpLeaveError(`Cannot refund leave in "${liveReq.status}" status; duplicate refund prevented.`, 409);
    }

    const perms = canUserActOnLeaveRequest({
      request: liveReq,
      actorUid: actor.uid,
      actorRole: ctx.role,
      actorDeptId: ctx.departmentId,
      workflowSettings,
      leavePolicy,
    });
    if (!perms.canCancelApproved) {
      throw new HttpLeaveError('You do not have authority to cancel and refund this approved leave.', 403);
    }

    const reqPatch: Record<string, unknown> = {
      status: 'cancelled',
      cancelledByUid: actor.uid,
      cancelledReason,
      updatedAt: store.serverTimestamp(),
    };
    tx.updateDoc('leaveRequests', leaveId, reqPatch);

    let updatedBal: LeaveBalance | undefined;
    const balRaw = await tx.getDoc('leaveBalances', liveReq.uid);
    if (balRaw) {
      const liveBal = balRaw as unknown as LeaveBalance;
      const refundPatch = buildCancelledApprovedLeaveRefundPatch(liveBal, liveReq);
      updatedBal = { ...liveBal, ...refundPatch };
      if (Object.keys(refundPatch).length > 0) {
        tx.updateDoc('leaveBalances', liveReq.uid, {
          ...refundPatch,
          updatedAt: store.serverTimestamp(),
        });
      }
    }

    const auditId = store.createId('audit');
    tx.setDoc('auditLogs', auditId, {
      id: auditId,
      actorUid: actor.uid,
      actorEmail: ctx.email,
      actorRole: ctx.role,
      action: 'LEAVE_APPROVED_CANCELLED_REFUNDED',
      targetCollection: 'leaveRequests',
      targetId: leaveId,
      summary: `Cancelled approved ${liveReq.daysCount}d ${liveReq.leaveType} leave for ${liveReq.employeeName} and refunded quota. Reason: ${cancelledReason}`,
      createdAt: store.serverTimestamp(),
    });

    return { leaveRequest: { ...liveReq, ...reqPatch } as LeaveRequest, balance: updatedBal };
  });

  if (store.dispatchNotification) {
    const empMatches = await store.queryWhere('employees', 'uid', txResult.leaveRequest.uid);
    const recipientEmail = String(empMatches[0]?.data.email || '');
    await store.dispatchNotification({
      id: store.createId('notif'),
      recipientUid: txResult.leaveRequest.uid,
      recipientEmail: recipientEmail || undefined,
      title: 'Approved Leave Cancelled & Balance Refunded',
      message: `Your approved ${txResult.leaveRequest.leaveType} leave (${txResult.leaveRequest.startDate} to ${txResult.leaveRequest.endDate}, ${txResult.leaveRequest.daysCount}d) was cancelled and your balance refunded. Reason: ${cancelledReason}`,
      linkTab: 'leave',
    });
  }

  return txResult;
}

export type AdjustableBucket =
  | 'paidTotal'
  | 'casualTotal'
  | 'sickTotal'
  | 'emergencyTotal'
  | 'paidUsed'
  | 'casualUsed'
  | 'sickUsed'
  | 'emergencyUsed'
  | 'unpaidUsed';

export async function adjustLeaveBalance(
  store: LeaveStoreAdapter,
  actor: LeaveActor,
  input: {
    targetUid: string;
    bucket: AdjustableBucket;
    mode: 'add' | 'set';
    value: number;
    reason: string;
  },
): Promise<{ previousValue: number; newValue: number; balance: LeaveBalance }> {
  const ctx = await loadTrustedActorContext(store, actor);
  if (ctx.role !== 'super_admin') {
    throw new HttpLeaveError('Only Super Admin can manually adjust leave balances.', 403);
  }
  const reason = String(input.reason || '').trim();
  if (reason.length < 5 || reason.length > 400) {
    throw new HttpLeaveError('Please enter a detailed adjustment reason (min 5 characters).', 400);
  }
  const numericVal = Number(input.value);
  if (!Number.isFinite(numericVal) || Math.abs(numericVal) > 365) {
    throw new HttpLeaveError('Adjustment value must be a valid finite number within 0–365.', 400);
  }

  const { leavePolicy } = await loadPoliciesAndHolidays(store);
  const [targetRoleDoc, empMatches] = await Promise.all([
    store.getDoc('roles', input.targetUid),
    store.queryWhere('employees', 'uid', input.targetUid),
  ]);
  const targetEmp = empMatches[0]?.data as unknown as EmployeeProfile | undefined;
  const targetOwnerRole = (targetRoleDoc?.role as UserRole) || 'employee';

  const result = await store.runTransaction(async (tx) => {
    const existingRaw = await tx.getDoc('leaveBalances', input.targetUid);
    const liveBal: LeaveBalance = existingRaw
      ? (existingRaw as unknown as LeaveBalance)
      : buildPolicyBalanceRecord({
          uid: input.targetUid,
          employeeId: targetEmp?.id || input.targetUid,
          ownerRole: targetOwnerRole,
          departmentId: targetEmp?.departmentId || String(targetRoleDoc?.departmentId || 'dept_exec'),
          teamId: targetEmp?.teamId || '',
          teamLeadUid: targetEmp?.teamLeadUid || '',
          reportingManagerUid: targetEmp?.reportingManagerUid || '',
          policy: leavePolicy,
          year: new Date().getUTCFullYear(),
        });

    const prevVal = Number(liveBal[input.bucket] || 0);
    const computed = input.mode === 'set' ? numericVal : prevVal + numericVal;
    const nextVal = Math.min(365, Math.max(0, Math.round(computed * 100) / 100));
    const nextBal: LeaveBalance = { ...liveBal, [input.bucket]: nextVal };

    if (existingRaw) {
      tx.updateDoc('leaveBalances', input.targetUid, {
        [input.bucket]: nextVal,
        updatedAt: store.serverTimestamp(),
      });
    } else {
      tx.setDoc('leaveBalances', input.targetUid, {
        ...nextBal,
        createdAt: store.serverTimestamp(),
        updatedAt: store.serverTimestamp(),
      });
    }

    const auditId = store.createId('audit');
    tx.setDoc('auditLogs', auditId, {
      id: auditId,
      actorUid: actor.uid,
      actorEmail: ctx.email,
      actorRole: ctx.role,
      action: 'LEAVE_BALANCE_MANUAL_ADJUST',
      targetCollection: 'leaveBalances',
      targetId: input.targetUid,
      summary: `Adjusted ${input.bucket} for ${targetEmp?.fullName || input.targetUid} from ${prevVal} to ${nextVal}. Reason: ${reason}`,
      createdAt: store.serverTimestamp(),
    });

    return { previousValue: prevVal, newValue: nextVal, balance: nextBal };
  });

  if (store.dispatchNotification) {
    await store.dispatchNotification({
      id: store.createId('notif'),
      recipientUid: input.targetUid,
      recipientEmail: targetEmp?.email,
      title: 'Leave Balance Adjusted by Super Admin',
      message: `Your ${input.bucket} leave balance was updated from ${result.previousValue} to ${result.newValue} day(s). Reason: ${reason}`,
      linkTab: 'leave',
    });
  }

  return result;
}

export async function executeAnnualLeaveReset(
  store: LeaveStoreAdapter,
  actor: LeaveActor,
  input: {
    targetYear: number;
    carryForwardEnabled: boolean;
    maxCarryForwardPaid: number;
  },
): Promise<{ resetCount: number; logId: string }> {
  const ctx = await loadTrustedActorContext(store, actor);
  if (ctx.role !== 'super_admin' && ctx.role !== 'hr_manager') {
    throw new HttpLeaveError('Only HR or Super Admin can execute the annual leave reset.', 403);
  }
  const targetYear = Math.round(Number(input.targetYear));
  if (!Number.isFinite(targetYear) || targetYear < 2020 || targetYear > 2100) {
    throw new HttpLeaveError('Invalid reset year.', 400);
  }
  const maxCarryPaid = Math.max(0, Math.min(60, Number(input.maxCarryForwardPaid || 0)));

  const { leavePolicy } = await loadPoliciesAndHolidays(store);
  const allBalances = await store.listCollection('leaveBalances');
  const eligible = allBalances.filter((b) => {
    const ownerRole = String(b.data.ownerRole || '');
    if (ctx.role === 'hr_manager' && (ownerRole === 'super_admin' || b.data.departmentId === EXECUTIVE_PRIVATE_DEPT)) {
      return false;
    }
    return true;
  });

  const logId = store.createId('lvrst');
  await store.runTransaction(async (tx) => {
    for (const row of eligible) {
      const liveRaw = await tx.getDoc('leaveBalances', row.id);
      if (!liveRaw) continue;
      const nextBal = computeCarryForwardReset(
        liveRaw as unknown as LeaveBalance,
        leavePolicy,
        targetYear,
        input.carryForwardEnabled,
        maxCarryPaid,
      );
      tx.setDoc('leaveBalances', row.id, {
        ...nextBal,
        updatedAt: store.serverTimestamp(),
      });
    }

    tx.setDoc('leaveResetLogs', logId, {
      id: logId,
      year: targetYear,
      executedByUid: actor.uid,
      executedByEmail: ctx.email,
      employeesUpdated: eligible.length,
      maxCarryForwardPaid: input.carryForwardEnabled ? maxCarryPaid : 0,
      casualResetTo: leavePolicy.casualAnnual,
      sickResetTo: leavePolicy.sickAnnual,
      paidResetTo: leavePolicy.paidAnnual,
      emergencyResetTo: leavePolicy.emergencyAnnual,
      summary: `Reset ${eligible.length} leave balances for ${targetYear} (carry-forward ${input.carryForwardEnabled ? `up to ${maxCarryPaid} paid days` : 'disabled'}).`,
      createdAt: store.serverTimestamp(),
    });

    tx.setDoc('settings', 'leavePolicy', {
      ...leavePolicy,
      id: 'leavePolicy',
      carryForwardEnabled: input.carryForwardEnabled,
      maxCarryForwardPaid: maxCarryPaid,
      lastResetYear: targetYear,
      updatedByUid: actor.uid,
      updatedAt: store.serverTimestamp(),
    });

    const auditId = store.createId('audit');
    tx.setDoc('auditLogs', auditId, {
      id: auditId,
      actorUid: actor.uid,
      actorEmail: ctx.email,
      actorRole: ctx.role,
      action: 'LEAVE_ANNUAL_RESET',
      targetCollection: 'leaveResetLogs',
      targetId: logId,
      summary: `Executed ${targetYear} annual leave reset across ${eligible.length} employee balances`,
      createdAt: store.serverTimestamp(),
    });
  });

  return { resetCount: eligible.length, logId };
}
