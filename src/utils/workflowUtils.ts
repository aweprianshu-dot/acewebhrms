import type {
  ApprovalRequestType,
  ApprovalWorkflowRule,
  ApprovalWorkflowSettings,
  Holiday,
  LeaveBalance,
  LeavePolicySettings,
  LeaveRequest,
  LeaveType,
  PayrollRun,
  UserRole,
} from '../types/hrms';

export const EXECUTIVE_PRIVATE_DEPT = '__executive_private__';

export const DEFAULT_WORKFLOW_RULES: ApprovalWorkflowRule[] = [
  {
    requestType: 'leave',
    label: 'Leave Requests',
    approverRoles: ['team_lead', 'dept_manager', 'hr_manager', 'super_admin'],
    requireHrFinalApproval: false,
    autoEscalateHours: 24,
  },
  {
    requestType: 'attendance_correction',
    label: 'Attendance Corrections',
    approverRoles: ['team_lead', 'dept_manager', 'hr_manager', 'super_admin'],
    requireHrFinalApproval: false,
    autoEscalateHours: 24,
  },
  {
    requestType: 'wfh',
    label: 'Work From Home',
    approverRoles: ['team_lead', 'dept_manager', 'hr_manager', 'super_admin'],
    requireHrFinalApproval: false,
    autoEscalateHours: 12,
  },
  {
    requestType: 'overtime',
    label: 'Overtime Requests',
    approverRoles: ['dept_manager', 'hr_manager', 'super_admin'],
    requireHrFinalApproval: true,
    autoEscalateHours: 24,
  },
  {
    requestType: 'comp_off',
    label: 'Comp-Off Earn / Use',
    approverRoles: ['dept_manager', 'hr_manager', 'super_admin'],
    requireHrFinalApproval: false,
    autoEscalateHours: 24,
  },
  {
    requestType: 'expense',
    label: 'Expense Claims',
    approverRoles: ['hr_manager', 'super_admin'],
    requireHrFinalApproval: true,
    autoEscalateHours: 48,
  },
  {
    requestType: 'timesheet',
    label: 'Timesheet Entries',
    approverRoles: ['team_lead', 'dept_manager', 'hr_manager', 'super_admin'],
    requireHrFinalApproval: false,
    autoEscalateHours: 48,
  },
];

export const ROLE_DISPLAY_NAMES: Record<UserRole, string> = {
  super_admin: 'Super Admin',
  hr_manager: 'HR Manager',
  dept_manager: 'Manager',
  team_lead: 'Team Lead',
  employee: 'Employee',
};

export function isManagementRole(role: UserRole): boolean {
  return role === 'super_admin' || role === 'hr_manager' || role === 'dept_manager' || role === 'team_lead';
}

export function isHrOrAdmin(role: UserRole): boolean {
  return role === 'super_admin' || role === 'hr_manager';
}

export function getWorkflowRule(
  settings: ApprovalWorkflowSettings | null | undefined,
  requestType: ApprovalRequestType,
): ApprovalWorkflowRule {
  const found = settings?.rules?.find((r) => r.requestType === requestType);
  if (found) return found;
  return DEFAULT_WORKFLOW_RULES.find((r) => r.requestType === requestType) || DEFAULT_WORKFLOW_RULES[0];
}

export function canRoleApproveRequest(
  role: UserRole,
  requestType: ApprovalRequestType,
  settings?: ApprovalWorkflowSettings | null,
): boolean {
  if (role === 'super_admin') return true;
  const rule = getWorkflowRule(settings, requestType);
  if (rule.requireHrFinalApproval && role !== 'hr_manager') {
    return false;
  }
  return rule.approverRoles.includes(role) || role === 'hr_manager';
}

export interface LeaveClashInfo {
  overlappingCount: number;
  overlappingRequests: LeaveRequest[];
}

export function detectTeamLeaveClashes(
  targetStart: string,
  targetEnd: string,
  departmentId: string,
  excludeUid: string,
  allRequests: LeaveRequest[],
  teamId?: string,
): LeaveClashInfo {
  if (!targetStart || !targetEnd || (!departmentId && !teamId)) {
    return { overlappingCount: 0, overlappingRequests: [] };
  }
  const overlapping = allRequests.filter((req) => {
    if (req.uid === excludeUid) return false;
    if (req.status !== 'approved' && req.status !== 'pending' && req.status !== 'changes_requested') return false;
    if (req.departmentId === EXECUTIVE_PRIVATE_DEPT || req.requesterRole === 'super_admin') return false;
    const sameScope = teamId && req.teamId ? req.teamId === teamId : req.departmentId === departmentId;
    return sameScope && req.startDate <= targetEnd && req.endDate >= targetStart;
  });
  return {
    overlappingCount: overlapping.length,
    overlappingRequests: overlapping,
  };
}

function roundDays(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

export interface LeaveBalanceSummary {
  paidTotal: number;
  paidUsed: number;
  paidPending: number;
  paidRemaining: number;
  casualTotal: number;
  casualUsed: number;
  casualPending: number;
  casualRemaining: number;
  sickTotal: number;
  sickUsed: number;
  sickPending: number;
  sickRemaining: number;
  emergencyTotal: number;
  emergencyUsed: number;
  emergencyPending: number;
  emergencyRemaining: number;
  unpaidUsed: number;
  unpaidPending: number;
  carriedForwardDays: number;
  annualQuotaTotal: number;
  annualQuotaUsed: number;
  annualQuotaRemaining: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  halfDayCount: number;
}

export function computeLeaveBalanceSummary(
  balance: LeaveBalance | null | undefined,
  myRequests: LeaveRequest[],
  policy: LeavePolicySettings,
): LeaveBalanceSummary {
  const paidTotal = Number(balance?.paidTotal ?? policy.paidAnnual ?? 0);
  const paidUsed = Number(balance?.paidUsed ?? 0);
  const casualTotal = Number(balance?.casualTotal ?? policy.casualAnnual ?? 0);
  const casualUsed = Number(balance?.casualUsed ?? 0);
  const sickTotal = Number(balance?.sickTotal ?? policy.sickAnnual ?? 0);
  const sickUsed = Number(balance?.sickUsed ?? 0);
  const emergencyTotal = Number(balance?.emergencyTotal ?? policy.emergencyAnnual ?? 0);
  const emergencyUsed = Number(balance?.emergencyUsed ?? 0);
  const unpaidUsed = Number(balance?.unpaidUsed ?? 0);
  const carriedForwardDays = Number(balance?.carriedForwardDays ?? 0);

  let paidPending = 0;
  let casualPending = 0;
  let sickPending = 0;
  let emergencyPending = 0;
  let unpaidPending = 0;
  let pendingCount = 0;
  let approvedCount = 0;
  let rejectedCount = 0;
  let halfDayCount = 0;

  for (const req of myRequests) {
    if (req.dayPart === 'first_half' || req.dayPart === 'second_half') {
      if (req.status === 'approved') halfDayCount += 1;
    }
    if (req.status === 'pending' || req.status === 'changes_requested') {
      pendingCount += 1;
      const d = Number(req.daysCount || 0);
      if (req.leaveType === 'paid') paidPending += d;
      else if (req.leaveType === 'casual') casualPending += d;
      else if (req.leaveType === 'sick') sickPending += d;
      else if (req.leaveType === 'emergency') emergencyPending += d;
      else if (req.leaveType === 'unpaid') unpaidPending += d;
    } else if (req.status === 'approved') {
      approvedCount += 1;
    } else if (req.status === 'rejected') {
      rejectedCount += 1;
    }
  }

  // Pending leaves are NEVER deducted from remaining balances until approved
  const paidRemaining = roundDays(paidTotal - paidUsed);
  const casualRemaining = roundDays(casualTotal - casualUsed);
  const sickRemaining = roundDays(sickTotal - sickUsed);
  const emergencyRemaining = roundDays(emergencyTotal - emergencyUsed);

  return {
    paidTotal: roundDays(paidTotal),
    paidUsed: roundDays(paidUsed),
    paidPending: roundDays(paidPending),
    paidRemaining,
    casualTotal: roundDays(casualTotal),
    casualUsed: roundDays(casualUsed),
    casualPending: roundDays(casualPending),
    casualRemaining,
    sickTotal: roundDays(sickTotal),
    sickUsed: roundDays(sickUsed),
    sickPending: roundDays(sickPending),
    sickRemaining,
    emergencyTotal: roundDays(emergencyTotal),
    emergencyUsed: roundDays(emergencyUsed),
    emergencyPending: roundDays(emergencyPending),
    emergencyRemaining,
    unpaidUsed: roundDays(unpaidUsed),
    unpaidPending: roundDays(unpaidPending),
    carriedForwardDays: roundDays(carriedForwardDays),
    annualQuotaTotal: roundDays(paidTotal + casualTotal + sickTotal + emergencyTotal),
    annualQuotaUsed: roundDays(paidUsed + casualUsed + sickUsed + emergencyUsed),
    annualQuotaRemaining: roundDays(paidRemaining + casualRemaining + sickRemaining + emergencyRemaining),
    pendingCount,
    approvedCount,
    rejectedCount,
    halfDayCount,
  };
}

export interface LeaveDaysBreakdown {
  workingDays: number;
  totalCalendarDays: number;
  excludedWeeklyOffs: number;
  excludedHolidays: number;
}

export function calculateLeaveWorkingDays(params: {
  startDate: string;
  endDate: string;
  dayPart: 'full' | 'first_half' | 'second_half' | 'short';
  shortLeaveHours?: number;
  weeklyOffs: string[];
  holidays: Holiday[];
  countryCode?: string;
  selectedOptionalHolidayIds?: string[];
}): LeaveDaysBreakdown {
  const {
    startDate,
    endDate,
    dayPart,
    shortLeaveHours = 1,
    weeklyOffs,
    holidays,
    countryCode = 'IN',
    selectedOptionalHolidayIds = [],
  } = params;

  const s = new Date(startDate);
  const e = new Date(endDate);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) {
    return { workingDays: 0, totalCalendarDays: 0, excludedWeeklyOffs: 0, excludedHolidays: 0 };
  }
  if (dayPart === 'short') {
    if (startDate !== endDate) {
      return { workingDays: 0, totalCalendarDays: 0, excludedWeeklyOffs: 0, excludedHolidays: 0 };
    }
    return {
      workingDays: roundDays(Math.min(2, Math.max(1, shortLeaveHours)) / 8),
      totalCalendarDays: 1,
      excludedWeeklyOffs: 0,
      excludedHolidays: 0,
    };
  }
  if (dayPart === 'first_half' || dayPart === 'second_half') {
    if (startDate !== endDate) {
      return { workingDays: 0, totalCalendarDays: 0, excludedWeeklyOffs: 0, excludedHolidays: 0 };
    }
    return { workingDays: 0.5, totalCalendarDays: 1, excludedWeeklyOffs: 0, excludedHolidays: 0 };
  }

  let workingDays = 0;
  let totalCalendarDays = 0;
  let excludedWeeklyOffs = 0;
  let excludedHolidays = 0;
  const cursor = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()));
  const end = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate()));

  while (cursor <= end) {
    totalCalendarDays += 1;
    const dateKey = cursor.toISOString().slice(0, 10);
    const weekday = cursor.getUTCDay();
    const isSecondSaturday = weekday === 6 && Math.floor((cursor.getUTCDate() - 1) / 7) === 1;
    const isWeeklyOff =
      (weekday === 0 && weeklyOffs.includes('Sunday')) ||
      (weekday === 6 &&
        (weeklyOffs.includes('Saturday') || (isSecondSaturday && weeklyOffs.includes('Second Saturday'))));
    const isHoliday = holidays.some(
      (h) =>
        h.date === dateKey &&
        (!h.countryCode || h.countryCode === countryCode) &&
        (h.type !== 'optional' || selectedOptionalHolidayIds.includes(h.id)),
    );

    if (isWeeklyOff) excludedWeeklyOffs += 1;
    else if (isHoliday) excludedHolidays += 1;
    else workingDays += 1;

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return { workingDays, totalCalendarDays, excludedWeeklyOffs, excludedHolidays };
}

export interface LeaveApplicationValidation {
  valid: boolean;
  error?: string;
  breakdown: LeaveDaysBreakdown;
  availableQuotaBefore: number | null;
  remainingQuotaAfter: number | null;
}

export function validateLeaveApplication(params: {
  leaveType: LeaveType;
  dayPart: 'full' | 'first_half' | 'second_half' | 'short';
  shortLeaveHours?: number;
  startDate: string;
  endDate: string;
  balance: LeaveBalance | null | undefined;
  policy: LeavePolicySettings;
  weeklyOffs: string[];
  holidays: Holiday[];
  countryCode?: string;
  selectedOptionalHolidayIds?: string[];
}): LeaveApplicationValidation {
  const breakdown = calculateLeaveWorkingDays({
    startDate: params.startDate,
    endDate: params.endDate,
    dayPart: params.dayPart,
    shortLeaveHours: params.shortLeaveHours,
    weeklyOffs: params.weeklyOffs,
    holidays: params.holidays,
    countryCode: params.countryCode,
    selectedOptionalHolidayIds: params.selectedOptionalHolidayIds,
  });

  if (params.dayPart === 'short' && params.startDate !== params.endDate) {
    return {
      valid: false,
      error: 'Short leave permission must be for a single date.',
      breakdown,
      availableQuotaBefore: null,
      remainingQuotaAfter: null,
    };
  }
  if ((params.dayPart === 'first_half' || params.dayPart === 'second_half') && params.startDate !== params.endDate) {
    return {
      valid: false,
      error: 'Half-day leave must start and end on the same date.',
      breakdown,
      availableQuotaBefore: null,
      remainingQuotaAfter: null,
    };
  }
  if (breakdown.workingDays <= 0) {
    return {
      valid: false,
      error:
        params.endDate < params.startDate
          ? 'End date must be on or after start date.'
          : 'Selected range falls entirely on weekly offs or company holidays (0 working days).',
      breakdown,
      availableQuotaBefore: null,
      remainingQuotaAfter: null,
    };
  }

  const bal = params.balance;
  let available: number | null = null;
  if (params.leaveType === 'paid') {
    available = roundDays((bal?.paidTotal ?? params.policy.paidAnnual) - (bal?.paidUsed ?? 0));
  } else if (params.leaveType === 'casual') {
    available = roundDays((bal?.casualTotal ?? params.policy.casualAnnual) - (bal?.casualUsed ?? 0));
  } else if (params.leaveType === 'sick') {
    available = roundDays((bal?.sickTotal ?? params.policy.sickAnnual) - (bal?.sickUsed ?? 0));
  } else if (params.leaveType === 'emergency') {
    available = roundDays((bal?.emergencyTotal ?? params.policy.emergencyAnnual) - (bal?.emergencyUsed ?? 0));
  }

  if (available !== null && breakdown.workingDays > available) {
    return {
      valid: false,
      error: `Insufficient ${params.leaveType} leave balance (${available}d available, ${breakdown.workingDays}d requested). Adjust dates or select Unpaid Leave (LWP).`,
      breakdown,
      availableQuotaBefore: available,
      remainingQuotaAfter: 0,
    };
  }

  return {
    valid: true,
    breakdown,
    availableQuotaBefore: available,
    remainingQuotaAfter: available !== null ? roundDays(available - breakdown.workingDays) : null,
  };
}

export function isSuperAdminPrivateLeave(req: Pick<LeaveRequest, 'departmentId' | 'requesterRole'>): boolean {
  return req.departmentId === EXECUTIVE_PRIVATE_DEPT || req.requesterRole === 'super_admin';
}

export function filterVisibleLeaveRequests(
  requests: LeaveRequest[],
  viewerUid: string,
  viewerRole: UserRole,
  viewerDeptId?: string,
): LeaveRequest[] {
  if (!viewerUid) return [];
  if (viewerRole === 'super_admin') return requests;

  const isMgrRole = isManagementRole(viewerRole);

  return requests.filter((req) => {
    if (req.uid === viewerUid) return true;
    if (!isMgrRole) return false;
    // Strict Super Admin personal leave privacy unless explicitly designated as approver
    if (isSuperAdminPrivateLeave(req)) {
      return req.reportingManagerUid === viewerUid;
    }
    if (viewerRole === 'hr_manager') return true;
    if (viewerRole === 'team_lead') {
      return req.teamLeadUid === viewerUid || req.reportingManagerUid === viewerUid;
    }
    if (viewerRole === 'dept_manager') {
      return (
        req.reportingManagerUid === viewerUid ||
        (Boolean(viewerDeptId) && req.departmentId === viewerDeptId)
      );
    }
    return false;
  });
}

export interface LeaveActionPermissions {
  canApprove: boolean;
  canReject: boolean;
  canRequestChanges: boolean;
  canCancel: boolean;
  canResubmit: boolean;
  canCancelApproved: boolean;
  selfApprovalBlocked: boolean;
  reason?: string;
}

export function canUserActOnLeaveRequest(params: {
  request: LeaveRequest;
  actorUid: string;
  actorRole: UserRole;
  actorDeptId?: string;
  workflowSettings?: ApprovalWorkflowSettings | null;
  leavePolicy?: LeavePolicySettings | null;
}): LeaveActionPermissions {
  const { request, actorUid, actorRole, actorDeptId, workflowSettings, leavePolicy } = params;
  const isOwner = request.uid === actorUid;
  const isReviewableState = request.status === 'pending' || request.status === 'changes_requested';

  const canCancel = isOwner && isReviewableState;
  const canResubmit = isOwner && request.status === 'changes_requested';

  const privateExecutive = isSuperAdminPrivateLeave(request);
  const roleCanApprove = canRoleApproveRequest(actorRole, 'leave', workflowSettings);

  let selfApprovalBlocked = false;
  let inAuthorityScope = false;

  if (actorRole === 'super_admin') {
    if (isOwner) {
      const mode = leavePolicy?.superAdminSelfApprovalMode || 'auto_audit';
      if (mode === 'designated_approver' && leavePolicy?.superAdminApproverUid && leavePolicy.superAdminApproverUid !== actorUid) {
        selfApprovalBlocked = true;
      } else {
        inAuthorityScope = true;
      }
    } else {
      inAuthorityScope = true;
    }
  } else {
    if (isOwner) {
      selfApprovalBlocked = isManagementRole(actorRole);
      inAuthorityScope = false;
    } else if (privateExecutive) {
      // Only designated reporting manager / approver may act on a Super Admin personal leave
      inAuthorityScope = request.reportingManagerUid === actorUid && roleCanApprove;
    } else if (actorRole === 'hr_manager') {
      inAuthorityScope = roleCanApprove;
    } else if (actorRole === 'team_lead') {
      inAuthorityScope =
        roleCanApprove &&
        (request.teamLeadUid === actorUid || request.reportingManagerUid === actorUid);
    } else if (actorRole === 'dept_manager') {
      inAuthorityScope =
        roleCanApprove &&
        (request.reportingManagerUid === actorUid ||
          (Boolean(actorDeptId) && request.departmentId === actorDeptId));
    }
  }

  const canDecide = isReviewableState && inAuthorityScope;
  const canCancelApproved =
    request.status === 'approved' &&
    (actorRole === 'super_admin' ||
      (!privateExecutive &&
        ((actorRole === 'hr_manager' && !isOwner) ||
          ((actorRole === 'team_lead' || actorRole === 'dept_manager') &&
            !isOwner &&
            (request.teamLeadUid === actorUid || request.reportingManagerUid === actorUid)))));

  return {
    canApprove: canDecide,
    canReject: canDecide,
    canRequestChanges: canDecide,
    canCancel,
    canResubmit,
    canCancelApproved,
    selfApprovalBlocked,
    reason: selfApprovalBlocked
      ? 'Self-approval is disabled for your role; routed to reporting manager or HR.'
      : undefined,
  };
}

export function getLeaveBalanceFieldForType(
  leaveType: LeaveType,
  dayPart?: LeaveRequest['dayPart'],
): 'casualUsed' | 'sickUsed' | 'paidUsed' | 'emergencyUsed' | 'unpaidUsed' | null {
  if (leaveType === 'short' || dayPart === 'short') return null;
  if (leaveType === 'casual') return 'casualUsed';
  if (leaveType === 'sick') return 'sickUsed';
  if (leaveType === 'paid') return 'paidUsed';
  if (leaveType === 'emergency') return 'emergencyUsed';
  if (leaveType === 'unpaid') return 'unpaidUsed';
  return null;
}

export function buildApprovedLeaveBalancePatch(
  balance: LeaveBalance,
  request: Pick<LeaveRequest, 'leaveType' | 'dayPart' | 'daysCount'>,
): Partial<LeaveBalance> {
  const field = getLeaveBalanceFieldForType(request.leaveType, request.dayPart);
  if (!field) return {};
  const nextVal = roundDays(Number(balance[field] || 0) + Number(request.daysCount || 0));
  return { [field]: nextVal };
}

export function buildCancelledApprovedLeaveRefundPatch(
  balance: LeaveBalance,
  request: Pick<LeaveRequest, 'leaveType' | 'dayPart' | 'daysCount'>,
): Partial<LeaveBalance> {
  const field = getLeaveBalanceFieldForType(request.leaveType, request.dayPart);
  if (!field) return {};
  const nextVal = roundDays(Math.max(0, Number(balance[field] || 0) - Number(request.daysCount || 0)));
  return { [field]: nextVal };
}

export function computeCarryForwardReset(
  balance: LeaveBalance,
  policy: LeavePolicySettings,
  targetYear: number,
  carryForwardEnabled: boolean,
  maxCarryForwardPaid: number,
): LeaveBalance {
  const unusedPaid = Math.max(0, Number(balance.paidTotal || 0) - Number(balance.paidUsed || 0));
  const carryDays = carryForwardEnabled ? Math.min(unusedPaid, Math.max(0, maxCarryForwardPaid)) : 0;
  return {
    ...balance,
    year: targetYear,
    casualTotal: policy.casualAnnual,
    casualUsed: 0,
    sickTotal: policy.sickAnnual,
    sickUsed: 0,
    paidTotal: policy.paidAnnual + carryDays,
    paidUsed: 0,
    emergencyTotal: policy.emergencyAnnual,
    emergencyUsed: 0,
    unpaidUsed: 0,
    carriedForwardDays: carryDays,
    lastResetYear: targetYear,
  };
}

export interface PayrollReconciliationRow {
  currentMonth: string;
  previousMonth: string | null;
  currentGross: number;
  previousGross: number;
  grossDelta: number;
  currentNet: number;
  previousNet: number;
  netDelta: number;
  headcountDelta: number;
}

export function comparePayrollRuns(
  current: PayrollRun | null | undefined,
  previous: PayrollRun | null | undefined,
): PayrollReconciliationRow | null {
  if (!current) return null;
  const prevGross = previous?.totalGross ?? 0;
  const prevNet = previous?.totalNet ?? 0;
  const prevCount = previous?.employeeCount ?? 0;
  return {
    currentMonth: current.month,
    previousMonth: previous?.month ?? null,
    currentGross: current.totalGross,
    previousGross: prevGross,
    grossDelta: Number((current.totalGross - prevGross).toFixed(2)),
    currentNet: current.totalNet,
    previousNet: prevNet,
    netDelta: Number((current.totalNet - prevNet).toFixed(2)),
    headcountDelta: current.employeeCount - prevCount,
  };
}
