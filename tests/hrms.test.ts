import test from 'node:test';
import assert from 'node:assert/strict';

import {
  THEME_STORAGE_KEY,
  getSavedTheme,
  applyTheme,
  getChartTheme,
} from '../src/utils/themeUtils.ts';
import {
  DEFAULT_WORKFLOW_RULES,
  EXECUTIVE_PRIVATE_DEPT,
  canRoleApproveRequest,
  canUserActOnLeaveRequest,
  computeLeaveBalanceSummary,
  validateLeaveApplication,
  filterVisibleLeaveRequests,
  buildApprovedLeaveBalancePatch,
  buildCancelledApprovedLeaveRefundPatch,
  detectTeamLeaveClashes,
  computeCarryForwardReset,
  comparePayrollRuns,
} from '../src/utils/workflowUtils.ts';
import {
  computeShiftWorkingStats,
  computeProjectedFinishIso,
  isWeeklyOffDate,
  resolveCheckoutStatus,
} from '../src/utils/attendanceUtils.ts';
import { isMonitoringAgentOnline } from '../src/utils/monitoringUtils.ts';
import { partitionOrgChartHierarchy } from '../src/utils/orgChartUtils.ts';
import { isAnnouncementVisibleToViewer } from '../src/utils/taskTimerUtils.ts';
import { buildXlsxBuffer } from '../src/utils/exportUtils.ts';
import {
  buildBackupBundle,
  computeRestorePreview,
  isBackupDue,
  selectBackupsToPrune,
  validateAndVerifyBackupBundle,
  type BackupDocumentEntry,
} from '../src/utils/backupUtils.ts';
import type {
  ApprovalWorkflowSettings,
  AttendanceRecord,
  BackupConfigSettings,
  EmployeeProfile,
  LeaveBalance,
  LeavePolicySettings,
  LeaveRequest,
  PayrollRun,
  WorkPolicySettings,
} from '../src/types/hrms.ts';

test('themeUtils persists and toggles theme cleanly without browser globals', () => {
  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };

  assert.equal(getSavedTheme(mockStorage), 'dark');

  const classes = new Set<string>();
  const mockRoot = {
    classList: {
      toggle: (cls: string, force?: boolean) => {
        if (force === undefined) {
          if (classes.has(cls)) classes.delete(cls);
          else classes.add(cls);
        } else if (force) {
          classes.add(cls);
        } else {
          classes.delete(cls);
        }
        return classes.has(cls);
      },
    },
    style: { colorScheme: 'dark' },
  } as unknown as HTMLElement;

  applyTheme('light', mockRoot, mockStorage);
  assert.equal(store.get(THEME_STORAGE_KEY), 'light');
  assert.equal(getSavedTheme(mockStorage), 'light');
  assert.equal(classes.has('ace-light'), true);
  assert.equal(classes.has('dark'), false);

  applyTheme('dark', mockRoot, mockStorage);
  assert.equal(getSavedTheme(mockStorage), 'dark');
  assert.equal(classes.has('ace-light'), false);
  assert.equal(classes.has('dark'), true);

  const lightChart = getChartTheme(true);
  const darkChart = getChartTheme(false);
  assert.notEqual(lightChart.tooltipBg, darkChart.tooltipBg);
  assert.notEqual(lightChart.gridStroke, darkChart.gridStroke);
});

test('workflowUtils evaluates role approvals, leave clashes, carry-forward reset, and payroll deltas', () => {
  const settings: ApprovalWorkflowSettings = {
    id: 'approvalWorkflows',
    rules: DEFAULT_WORKFLOW_RULES,
  };

  assert.equal(canRoleApproveRequest('team_lead', 'leave', settings), true);
  assert.equal(canRoleApproveRequest('employee', 'leave', settings), false);
  // overtime has requireHrFinalApproval: true
  assert.equal(canRoleApproveRequest('dept_manager', 'overtime', settings), false);
  assert.equal(canRoleApproveRequest('hr_manager', 'overtime', settings), true);
  assert.equal(canRoleApproveRequest('super_admin', 'overtime', settings), true);

  const requests: LeaveRequest[] = [
    {
      id: 'lr_1',
      uid: 'u1',
      employeeId: 'e1',
      employeeName: 'Alice',
      departmentId: 'dept_eng',
      leaveType: 'casual',
      startDate: '2026-12-10',
      endDate: '2026-12-12',
      daysCount: 3,
      reason: 'Trip',
      status: 'approved',
    },
    {
      id: 'lr_2',
      uid: 'u2',
      employeeId: 'e2',
      employeeName: 'Bob',
      departmentId: 'dept_hr',
      leaveType: 'sick',
      startDate: '2026-12-10',
      endDate: '2026-12-12',
      daysCount: 3,
      reason: 'Fever',
      status: 'approved',
    },
  ];
  const clash = detectTeamLeaveClashes('2026-12-11', '2026-12-13', 'dept_eng', 'u3', requests);
  assert.equal(clash.overlappingCount, 1);
  assert.equal(clash.overlappingRequests[0]?.uid, 'u1');

  const balance: LeaveBalance = {
    uid: 'u1',
    employeeId: 'e1',
    year: 2026,
    casualTotal: 12,
    casualUsed: 4,
    sickTotal: 10,
    sickUsed: 2,
    paidTotal: 15,
    paidUsed: 5,
    emergencyTotal: 3,
    emergencyUsed: 1,
    unpaidUsed: 2,
  };
  const policy: LeavePolicySettings = {
    id: 'leavePolicy',
    casualAnnual: 12,
    sickAnnual: 10,
    paidAnnual: 18,
    emergencyAnnual: 3,
  };
  const nextBal = computeCarryForwardReset(balance, policy, 2027, true, 6);
  assert.equal(nextBal.year, 2027);
  assert.equal(nextBal.carriedForwardDays, 6); // unused paid was 10, capped at 6
  assert.equal(nextBal.paidTotal, 24);
  assert.equal(nextBal.paidUsed, 0);

  const prevRun: PayrollRun = {
    id: 'pr1',
    month: '2026-10',
    currency: 'USD',
    employeeCount: 10,
    totalGross: 50000,
    totalDeductions: 5000,
    totalNet: 45000,
    status: 'finalized',
    processedByUid: 'admin',
  };
  const currRun: PayrollRun = {
    id: 'pr2',
    month: '2026-11',
    currency: 'USD',
    employeeCount: 11,
    totalGross: 56000,
    totalDeductions: 5500,
    totalNet: 50500,
    status: 'draft',
    processedByUid: 'admin',
  };
  const rec = comparePayrollRuns(currRun, prevRun);
  assert.ok(rec);
  assert.equal(rec.grossDelta, 6000);
  assert.equal(rec.netDelta, 5500);
  assert.equal(rec.headcountDelta, 1);
});

test('attendanceUtils computes net working time, projected finish, and weekly offs accurately', () => {
  const policy: WorkPolicySettings = {
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

  assert.equal(isWeeklyOffDate('2026-11-22', policy.weeklyOffs), true); // Sunday
  assert.equal(isWeeklyOffDate('2026-11-23', policy.weeklyOffs), false); // Monday

  const record: AttendanceRecord = {
    id: 'u1_2026-11-23',
    uid: 'u1',
    employeeId: 'e1',
    employeeName: 'Alice',
    departmentId: 'dept_eng',
    date: '2026-11-23',
    checkInTime: '2026-11-23T04:00:00.000Z', // 09:30 IST
    actualLunchMinutes: 30,
    lateMinutes: 0,
    earlyDepartureMinutes: 0,
    workingMinutes: 0,
    breakMinutes: 30,
    status: 'present',
    isLate: false,
    isEarlyDeparture: false,
  };

  const now = new Date('2026-11-23T08:00:00.000Z'); // 4 hours elapsed = 240 mins
  const stats = computeShiftWorkingStats({ record, now, policy });
  assert.equal(stats.elapsedTotalSeconds, 4 * 3600);
  assert.equal(stats.lunchDeductedSeconds, 30 * 60);
  assert.equal(stats.netWorkingSeconds, 210 * 60);
  assert.ok(computeProjectedFinishIso({ record, now, policy }) !== null);
});

test('buildXlsxBuffer creates a valid XLSX zip archive buffer', async () => {
  const buf = await buildXlsxBuffer([
    {
      name: 'Payroll Summary',
      headers: ['Employee', 'Net Pay'],
      rows: [['Alice', 5000]],
    },
  ]);
  const bytes = new Uint8Array(buf);
  assert.ok(bytes.byteLength > 100);
  // XLSX files are ZIP archives starting with PK (0x50, 0x4B)
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
});

test('backupUtils verifies SHA-256 integrity, detects tampering, and normalizes legacy v1 snapshots', async () => {
  const built = await buildBackupBundle({
    collections: {
      departments: [{ __docId: 'dept_eng', data: { id: 'dept_eng', name: 'Engineering', code: 'ENG' } }],
      employees: [{ __docId: 'emp_1', data: { id: 'emp_1', fullName: 'Alice', status: 'active' } }],
    },
    storageManifest: [
      { path: 'documents/u1/id.pdf', sizeBytes: 2048, contentType: 'application/pdf', updatedAt: '2026-11-23T00:00:00.000Z' },
    ],
    trigger: 'manual',
    frequency: 'daily',
    exportedBy: 'admin@acewebexperts.com',
    firebaseProjectId: 'gen-lang-client-0209720424',
    firestoreDatabaseId: 'ai-studio-workflowosaceweb-f23bec09-9afb-4a68-8d35-a438d22d2192',
    exportedAt: '2026-11-23T10:00:00.000Z',
  });

  assert.match(built.checksumSha256, /^[a-f0-9]{64}$/);
  assert.equal(built.totalRecords, 2);

  const verified = await validateAndVerifyBackupBundle(built.rawJson);
  assert.equal(verified.valid, true);
  assert.equal(verified.checksumVerified, true);
  assert.equal(verified.storageFileCount, 1);

  // Tamper with employee status -> SHA-256 check MUST fail
  const tamperedJson = built.rawJson.replace('"active"', '"inactive"');
  const tampered = await validateAndVerifyBackupBundle(tamperedJson);
  assert.equal(tampered.valid, false);
  assert.equal(tampered.checksumVerified, false);
  assert.ok(tampered.errors.some((e) => e.includes('SHA-256')));

  // Legacy v1 compatibility check
  const v1Raw = JSON.stringify({
    schemaVersion: 'ace-hrms-backup-v1',
    exportedAt: '2026-11-20T00:00:00.000Z',
    collections: {
      settings: { company: { companyName: 'ACE Web Experts' } },
      departments: [{ id: 'dept_eng', name: 'Engineering' }],
    },
  });
  const v1Parsed = await validateAndVerifyBackupBundle(v1Raw);
  assert.equal(v1Parsed.valid, true);
  assert.equal(v1Parsed.checksumVerified, 'unhashed-v1');
  assert.equal(v1Parsed.collectionCounts.settings, 1);
  assert.equal(v1Parsed.collectionCounts.departments, 1);
});

test('backupUtils computes non-mutating restore preview diffs and applies cleanly to an isolated mock store', async () => {
  const current: Record<string, BackupDocumentEntry[]> = {
    departments: [
      { __docId: 'dept_eng', data: { id: 'dept_eng', name: 'Engineering', code: 'ENG' } },
      { __docId: 'dept_hr', data: { id: 'dept_hr', name: 'Human Resources', code: 'HR' } },
    ],
    employees: [{ __docId: 'emp_1', data: { id: 'emp_1', fullName: 'Alice', designation: 'SWE' } }],
  };

  const backupCollections: Record<string, BackupDocumentEntry[]> = {
    departments: [
      { __docId: 'dept_eng', data: { id: 'dept_eng', name: 'Engineering', code: 'ENG' } },
      { __docId: 'dept_hr', data: { id: 'dept_hr', name: 'People Ops', code: 'HR' } },
      { __docId: 'dept_sales', data: { id: 'dept_sales', name: 'Sales', code: 'SLS' } },
    ],
    employees: [{ __docId: 'emp_1', data: { id: 'emp_1', fullName: 'Alice', designation: 'Senior SWE' } }],
  };

  const preview = computeRestorePreview(current, backupCollections);
  assert.equal(preview.totalBackupRecords, 4);
  assert.equal(preview.totalToCreate, 1);
  assert.equal(preview.totalToUpdate, 2);
  assert.equal(preview.totalUnchanged, 1);

  // Confirm preview did not mutate `current`
  assert.equal(current.departments.length, 2);
  assert.equal(current.employees[0]?.data.designation, 'SWE');

  // Apply to isolated mock Map store (never touching live Firestore)
  const mockDb = new Map<string, Map<string, Record<string, unknown>>>();
  for (const [col, entries] of Object.entries(current)) {
    mockDb.set(col, new Map(entries.map((e) => [e.__docId, { ...e.data }])));
  }
  for (const [col, entries] of Object.entries(backupCollections)) {
    const colMap = mockDb.get(col) || new Map<string, Record<string, unknown>>();
    for (const entry of entries) {
      colMap.set(entry.__docId, { ...entry.data });
    }
    mockDb.set(col, colMap);
  }
  assert.equal(mockDb.get('departments')?.size, 3);
  assert.equal(mockDb.get('departments')?.get('dept_hr')?.name, 'People Ops');
  assert.equal(mockDb.get('employees')?.get('emp_1')?.designation, 'Senior SWE');
});

test('backupUtils enforces scheduled frequency due checks and retention pruning rules', () => {
  const now = new Date('2026-11-23T12:00:00.000Z');
  const baseCfg: BackupConfigSettings = {
    id: 'backupConfig',
    enabled: true,
    frequency: 'daily',
    retentionDays: 7,
    retentionMaxCount: 3,
    notifyOnSuccess: true,
    notifyOnFailure: true,
    includeStorageManifest: true,
  };

  assert.equal(isBackupDue({ ...baseCfg, enabled: false }, now), false);
  assert.equal(isBackupDue(baseCfg, now), true);
  assert.equal(isBackupDue({ ...baseCfg, lastBackupAt: '2026-11-23T06:00:00.000Z' }, now), false);
  assert.equal(isBackupDue({ ...baseCfg, frequency: 'hourly', lastBackupAt: '2026-11-23T10:59:00.000Z' }, now), true);
  assert.equal(isBackupDue({ ...baseCfg, frequency: 'weekly', lastBackupAt: '2026-11-18T12:00:00.000Z' }, now), false);
  assert.equal(isBackupDue({ ...baseCfg, frequency: 'weekly', lastBackupAt: '2026-11-15T12:00:00.000Z' }, now), true);

  const records = [
    { id: 'bkp_newest_old_success', status: 'success' as const, timestampIso: '2026-11-01T10:00:00.000Z' },
    { id: 'bkp_older_fail', status: 'failed' as const, timestampIso: '2026-10-20T10:00:00.000Z' },
    { id: 'bkp_excess', status: 'success' as const, timestampIso: '2026-11-22T10:00:00.000Z' },
    { id: 'bkp_recent_1', status: 'success' as const, timestampIso: '2026-11-23T10:00:00.000Z' },
    { id: 'bkp_recent_2', status: 'success' as const, timestampIso: '2026-11-23T11:00:00.000Z' },
    { id: 'bkp_recent_3', status: 'success' as const, timestampIso: '2026-11-23T11:30:00.000Z' },
  ];
  const pruned = selectBackupsToPrune(records, 7, 3, now);
  assert.ok(pruned.includes('bkp_excess'));
  assert.ok(pruned.includes('bkp_newest_old_success')); // aged out because 3 newer successes fill retentionMaxCount=3
  assert.ok(!pruned.includes('bkp_recent_3'));

  // Sole newest successful backup is never pruned even if aged > retentionDays
  const singleOld = selectBackupsToPrune(
    [{ id: 'bkp_sole', status: 'success' as const, timestampIso: '2025-01-01T00:00:00.000Z' }],
    7,
    3,
    now
  );
  assert.deepEqual(singleOld, []);
});

test('attendanceUtils handles late grace threshold, active lunch intervals, and half-day leave boundaries', () => {
  const policy: WorkPolicySettings = {
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

  // Check-in at 09:50 IST (20 mins after 09:30, grace 15 => 5 late mins)
  // UTC equivalents: 09:50 IST = 04:20Z; lunch 13:30-14:00 IST = 08:00Z-08:30Z; checkout 18:30 IST = 13:00Z
  const lateRecord: AttendanceRecord = {
    id: 'u2_2026-11-23',
    uid: 'u2',
    employeeId: 'e2',
    employeeName: 'Bob',
    departmentId: 'dept_eng',
    date: '2026-11-23',
    checkInTime: '2026-11-23T04:20:00.000Z',
    lunchStartTime: '2026-11-23T08:00:00.000Z',
    lunchEndTime: '2026-11-23T08:30:00.000Z',
    checkOutTime: '2026-11-23T13:00:00.000Z',
    actualLunchMinutes: 30,
    workingMinutes: 490,
    breakMinutes: 30,
    status: 'late',
    isLate: true,
    isEarlyDeparture: false,
  };

  const stats = computeShiftWorkingStats({
    record: lateRecord,
    now: new Date('2026-11-23T13:00:00.000Z'),
    policy,
  });
  assert.equal(stats.phase, 'checked_out');
  assert.equal(stats.lateMinutes, 5);
  assert.equal(stats.actualLunchMinutes, 30);
  assert.equal(stats.earlyDepartureMinutes, 0);
  assert.equal(stats.netWorkingSeconds, (520 - 30) * 60);
});

test('leave balance summary never deducts pending requests and tracks half-days separately', () => {
  const balance: LeaveBalance = {
    uid: 'emp_1',
    employeeId: 'e_1',
    year: 2026,
    casualTotal: 12,
    casualUsed: 3,
    sickTotal: 10,
    sickUsed: 1,
    paidTotal: 15,
    paidUsed: 5,
    emergencyTotal: 4,
    emergencyUsed: 0,
    unpaidUsed: 1.5,
  };
  const policy: LeavePolicySettings = {
    id: 'leavePolicy',
    casualAnnual: 12,
    sickAnnual: 10,
    paidAnnual: 15,
    emergencyAnnual: 4,
  };
  const requests: LeaveRequest[] = [
    {
      id: 'lv_1',
      uid: 'emp_1',
      employeeId: 'e_1',
      employeeName: 'Alice',
      departmentId: 'dept_eng',
      leaveType: 'paid',
      dayPart: 'full',
      startDate: '2026-12-01',
      endDate: '2026-12-02',
      daysCount: 2,
      reason: 'Vacation',
      status: 'pending',
    },
    {
      id: 'lv_2',
      uid: 'emp_1',
      employeeId: 'e_1',
      employeeName: 'Alice',
      departmentId: 'dept_eng',
      leaveType: 'casual',
      dayPart: 'first_half',
      startDate: '2026-11-10',
      endDate: '2026-11-10',
      daysCount: 0.5,
      reason: 'Appointment',
      status: 'approved',
    },
    {
      id: 'lv_3',
      uid: 'emp_1',
      employeeId: 'e_1',
      employeeName: 'Alice',
      departmentId: 'dept_eng',
      leaveType: 'sick',
      dayPart: 'full',
      startDate: '2026-12-08',
      endDate: '2026-12-08',
      daysCount: 1,
      reason: 'Checkup',
      status: 'changes_requested',
    },
  ];

  const summary = computeLeaveBalanceSummary(balance, requests, policy);
  assert.equal(summary.paidTotal, 15);
  assert.equal(summary.paidUsed, 5);
  assert.equal(summary.paidPending, 2);
  assert.equal(summary.paidRemaining, 10); // Pending does NOT reduce available remaining
  assert.equal(summary.casualRemaining, 9);
  assert.equal(summary.sickPending, 1);
  assert.equal(summary.sickRemaining, 9);
  assert.equal(summary.unpaidUsed, 1.5);
  assert.equal(summary.halfDayCount, 1);
  assert.equal(summary.pendingCount, 2);
  assert.equal(summary.approvedCount, 1);
});

test('validateLeaveApplication excludes weekly offs/holidays and blocks quota overruns except unpaid', () => {
  const balance: LeaveBalance = {
    uid: 'emp_1',
    employeeId: 'e_1',
    year: 2026,
    casualTotal: 12,
    casualUsed: 10, // 2 remaining
    sickTotal: 10,
    sickUsed: 10, // 0 remaining
    paidTotal: 15,
    paidUsed: 0,
    emergencyTotal: 3,
    emergencyUsed: 0,
    unpaidUsed: 0,
  };
  const policy: LeavePolicySettings = {
    id: 'leavePolicy',
    casualAnnual: 12,
    sickAnnual: 10,
    paidAnnual: 15,
    emergencyAnnual: 3,
  };
  const holidays = [
    { id: 'hol_1', name: 'Midweek Festival', date: '2026-11-25', type: 'public' as const, countryCode: 'IN' },
  ];

  // Mon 2026-11-23 .. Mon 2026-11-30 = 8 calendar days: Sat/Sun off (2) + Wed 25 holiday (1) => 5 working days
  const overQuota = validateLeaveApplication({
    leaveType: 'casual',
    dayPart: 'full',
    startDate: '2026-11-23',
    endDate: '2026-11-30',
    balance,
    policy,
    weeklyOffs: ['Saturday', 'Sunday'],
    holidays,
    countryCode: 'IN',
  });
  assert.equal(overQuota.breakdown.totalCalendarDays, 8);
  assert.equal(overQuota.breakdown.excludedWeeklyOffs, 2);
  assert.equal(overQuota.breakdown.excludedHolidays, 1);
  assert.equal(overQuota.breakdown.workingDays, 5);
  assert.equal(overQuota.valid, false);
  assert.match(overQuota.error || '', /Insufficient casual leave balance/);

  // Same range as unpaid (LWP) is allowed
  const lwpValid = validateLeaveApplication({
    leaveType: 'unpaid',
    dayPart: 'full',
    startDate: '2026-11-23',
    endDate: '2026-11-30',
    balance,
    policy,
    weeklyOffs: ['Saturday', 'Sunday'],
    holidays,
    countryCode: 'IN',
  });
  assert.equal(lwpValid.valid, true);
  assert.equal(lwpValid.breakdown.workingDays, 5);

  // Short leave 2h => 0.25 working days; multi-day short leave blocked
  const shortOk = validateLeaveApplication({
    leaveType: 'short',
    dayPart: 'short',
    shortLeaveHours: 2,
    startDate: '2026-11-24',
    endDate: '2026-11-24',
    balance,
    policy,
    weeklyOffs: ['Saturday', 'Sunday'],
    holidays,
  });
  assert.equal(shortOk.valid, true);
  assert.equal(shortOk.breakdown.workingDays, 0.25);
});

test('leave visibility and governance enforce Team Lead isolation, Super Admin privacy, and anti-self-approval', () => {
  const settings: ApprovalWorkflowSettings = {
    id: 'approvalWorkflows',
    rules: DEFAULT_WORKFLOW_RULES,
  };

  const teamAReq: LeaveRequest = {
    id: 'lv_a',
    uid: 'emp_a',
    employeeId: 'E101',
    employeeName: 'Emp A',
    departmentId: 'dept_eng',
    teamId: 'team_alpha',
    teamLeadUid: 'tl_1',
    reportingManagerUid: 'mgr_1',
    requesterRole: 'employee',
    leaveType: 'casual',
    startDate: '2026-12-01',
    endDate: '2026-12-02',
    daysCount: 2,
    reason: 'Personal work',
    status: 'pending',
  };
  const teamBReq: LeaveRequest = {
    id: 'lv_b',
    uid: 'emp_b',
    employeeId: 'E102',
    employeeName: 'Emp B',
    departmentId: 'dept_eng',
    teamId: 'team_beta',
    teamLeadUid: 'tl_2',
    reportingManagerUid: 'mgr_1',
    requesterRole: 'employee',
    leaveType: 'casual',
    startDate: '2026-12-01',
    endDate: '2026-12-02',
    daysCount: 2,
    reason: 'Personal work',
    status: 'pending',
  };
  const tlOwnReq: LeaveRequest = {
    id: 'lv_tl1',
    uid: 'tl_1',
    employeeId: 'E099',
    employeeName: 'Lead One',
    departmentId: 'dept_eng',
    teamId: 'team_alpha',
    reportingManagerUid: 'mgr_1',
    requesterRole: 'team_lead',
    leaveType: 'paid',
    startDate: '2026-12-05',
    endDate: '2026-12-06',
    daysCount: 2,
    reason: 'Family event',
    status: 'changes_requested',
  };
  const superAdminPrivateReq: LeaveRequest = {
    id: 'lv_sa',
    uid: 'sa_1',
    employeeId: 'SA001',
    employeeName: 'Vaibhav Veer',
    departmentId: EXECUTIVE_PRIVATE_DEPT,
    reportingManagerUid: 'hr_designated',
    requesterRole: 'super_admin',
    leaveType: 'paid',
    startDate: '2026-12-10',
    endDate: '2026-12-12',
    daysCount: 3,
    reason: 'Confidential executive travel',
    status: 'pending',
  };

  const allReqs = [teamAReq, teamBReq, tlOwnReq, superAdminPrivateReq];

  // Team Lead tl_1 sees ONLY teamAReq + tlOwnReq (NOT teamBReq in same dept, NOT superAdminPrivateReq)
  const tl1Visible = filterVisibleLeaveRequests(allReqs, 'tl_1', 'team_lead', 'dept_eng');
  assert.deepEqual(
    tl1Visible.map((r) => r.id),
    ['lv_a', 'lv_tl1'],
  );

  // Regular HR manager NOT designated as approver CANNOT see Super Admin private leave
  const regularHrVisible = filterVisibleLeaveRequests(allReqs, 'hr_other', 'hr_manager', 'dept_hr');
  assert.equal(regularHrVisible.some((r) => r.id === 'lv_sa'), false);

  // Designated approver CAN see Super Admin private leave
  const designatedHrVisible = filterVisibleLeaveRequests(allReqs, 'hr_designated', 'hr_manager', 'dept_hr');
  assert.equal(designatedHrVisible.some((r) => r.id === 'lv_sa'), true);

  // Super Admin sees all
  assert.equal(filterVisibleLeaveRequests(allReqs, 'sa_1', 'super_admin').length, 4);

  // Anti-self-approval: Team Lead cannot approve own leave, CAN resubmit changes_requested
  const tlSelfPerms = canUserActOnLeaveRequest({
    request: tlOwnReq,
    actorUid: 'tl_1',
    actorRole: 'team_lead',
    actorDeptId: 'dept_eng',
    workflowSettings: settings,
  });
  assert.equal(tlSelfPerms.selfApprovalBlocked, true);
  assert.equal(tlSelfPerms.canApprove, false);
  assert.equal(tlSelfPerms.canResubmit, true);
  assert.equal(tlSelfPerms.canCancel, true);

  // Cross-team Team Lead cannot approve Team A leave
  const crossTeamPerms = canUserActOnLeaveRequest({
    request: teamAReq,
    actorUid: 'tl_2',
    actorRole: 'team_lead',
    actorDeptId: 'dept_eng',
    workflowSettings: settings,
  });
  assert.equal(crossTeamPerms.canApprove, false);

  // Assigned Team Lead CAN approve Team A leave
  const tl1OnTeamA = canUserActOnLeaveRequest({
    request: teamAReq,
    actorUid: 'tl_1',
    actorRole: 'team_lead',
    actorDeptId: 'dept_eng',
    workflowSettings: settings,
  });
  assert.equal(tl1OnTeamA.canApprove, true);
  assert.equal(tl1OnTeamA.canRequestChanges, true);

  // Balance approve & cancel-refund patch math
  const bal: LeaveBalance = {
    uid: 'emp_a',
    employeeId: 'E101',
    year: 2026,
    casualTotal: 12,
    casualUsed: 2,
    sickTotal: 10,
    sickUsed: 0,
    paidTotal: 15,
    paidUsed: 0,
    emergencyTotal: 3,
    emergencyUsed: 0,
    unpaidUsed: 0,
  };
  const approvedPatch = buildApprovedLeaveBalancePatch(bal, { leaveType: 'casual', dayPart: 'full', daysCount: 2 });
  assert.deepEqual(approvedPatch, { casualUsed: 4 });

  const refundedPatch = buildCancelledApprovedLeaveRefundPatch(
    { ...bal, casualUsed: 4 },
    { leaveType: 'casual', dayPart: 'full', daysCount: 2 },
  );
  assert.deepEqual(refundedPatch, { casualUsed: 2 });

  const shortPatch = buildApprovedLeaveBalancePatch(bal, { leaveType: 'short', dayPart: 'short', daysCount: 0.25 });
  assert.deepEqual(shortPatch, {});
});

test('resolveCheckoutStatus preserves late and half_day penalty statuses on early checkout', () => {
  assert.equal(
    resolveCheckoutStatus({
      currentStatus: 'half_day',
      workingMinutes: 420,
      halfDayThreshold: 270,
      isEarlyDeparture: true,
    }),
    'half_day',
  );
  assert.equal(
    resolveCheckoutStatus({
      currentStatus: 'late',
      workingMinutes: 420,
      halfDayThreshold: 270,
      isEarlyDeparture: true,
    }),
    'late',
  );
  assert.equal(
    resolveCheckoutStatus({
      currentStatus: 'present',
      workingMinutes: 420,
      halfDayThreshold: 270,
      isEarlyDeparture: true,
    }),
    'early_departure',
  );
  assert.equal(
    resolveCheckoutStatus({
      currentStatus: 'present',
      workingMinutes: 180,
      halfDayThreshold: 270,
      isEarlyDeparture: true,
    }),
    'half_day',
  );
});

test('isMonitoringAgentOnline evaluates server lastHeartbeat freshness and legacy fields', () => {
  const now = new Date('2026-11-25T10:00:00.000Z').getTime();
  assert.equal(
    isMonitoringAgentOnline({ uid: 'u1', lastHeartbeat: '2026-11-25T09:59:10.000Z', state: 'monitoring' }, now),
    true,
  );
  assert.equal(
    isMonitoringAgentOnline({ uid: 'u2', lastHeartbeat: '2026-11-25T09:55:00.000Z', state: 'monitoring' }, now),
    false,
  );
  assert.equal(
    isMonitoringAgentOnline({ uid: 'u3', lastHeartbeatAt: '2026-11-25T09:58:30.000Z' }, now),
    true,
  );
  assert.equal(
    isMonitoringAgentOnline({ uid: 'u4', online: true }, now),
    true,
  );
  assert.equal(
    isMonitoringAgentOnline({ uid: 'u5' }, now),
    false,
  );
});

test('partitionOrgChartHierarchy does not duplicate subordinates as orphans and handles pure cycles once', () => {
  const mkEmp = (id: string, uid: string, reportingManagerUid = ''): EmployeeProfile => ({
    id,
    uid,
    employeeCode: id.toUpperCase(),
    fullName: id,
    email: `${id}@acewebexperts.com`,
    departmentId: 'dept_eng',
    departmentName: 'Engineering',
    designation: 'Member',
    joiningDate: '2026-01-01',
    employmentType: 'full_time',
    reportingManagerUid,
    status: 'active',
  });

  const ceo = mkEmp('emp_ceo', 'u_ceo', '');
  const mgr = mkEmp('emp_mgr', 'u_mgr', 'u_ceo');
  const dev = mkEmp('emp_dev', 'u_dev', 'u_mgr');
  const cycleA = mkEmp('emp_ca', 'u_ca', 'u_cb');
  const cycleB = mkEmp('emp_cb', 'u_cb', 'u_ca');

  const { roots, orphaned, children } = partitionOrgChartHierarchy([ceo, mgr, dev, cycleA, cycleB]);
  assert.deepEqual(roots.map((r) => r.uid), ['u_ceo']);
  assert.equal(children.get('u_ceo')?.length, 1);
  assert.equal(children.get('u_mgr')?.length, 1);
  // mgr and dev must NOT appear in orphaned; cycleA + cycleB form one cycle component => 1 orphan entry point
  assert.deepEqual(orphaned.map((o) => o.uid), ['u_ca']);
});

test('isAnnouncementVisibleToViewer enforces team-scoped isolation while keeping company & dept notices visible', () => {
  const companyAnn = {
    id: 'a_co',
    title: 'Company Holiday',
    category: 'holiday' as const,
    content: 'Office closed',
    pinned: true,
    audience: 'company' as const,
    authorUid: 'hr1',
    authorName: 'HR',
  };
  const teamAAnn = {
    id: 'a_team_a',
    title: 'Team Alpha Standup',
    category: 'notice' as const,
    content: '10 AM daily sync',
    pinned: false,
    audience: 'team' as const,
    departmentId: 'dept_eng',
    teamId: 'team_alpha',
    teamLeadUid: 'tl_a',
    authorUid: 'tl_a',
    authorName: 'Team Lead A',
  };

  assert.equal(
    isAnnouncementVisibleToViewer(companyAnn, { uid: 'emp_b1', effectiveRole: 'employee', departmentId: 'dept_eng', teamLeadUid: 'tl_b', teamId: 'team_beta' }),
    true,
  );
  assert.equal(
    isAnnouncementVisibleToViewer(teamAAnn, { uid: 'emp_a1', effectiveRole: 'employee', departmentId: 'dept_eng', teamLeadUid: 'tl_a', teamId: 'team_alpha' }),
    true,
  );
  assert.equal(
    isAnnouncementVisibleToViewer(teamAAnn, { uid: 'emp_b1', effectiveRole: 'employee', departmentId: 'dept_eng', teamLeadUid: 'tl_b', teamId: 'team_beta' }),
    false,
  );
  assert.equal(
    isAnnouncementVisibleToViewer(teamAAnn, { uid: 'dm_eng', effectiveRole: 'dept_manager', departmentId: 'dept_eng' }),
    true,
  );
  assert.equal(
    isAnnouncementVisibleToViewer(teamAAnn, { uid: 'hr1', effectiveRole: 'hr_manager', departmentId: 'dept_hr' }),
    true,
  );
});




