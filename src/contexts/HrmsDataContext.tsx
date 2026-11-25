import React, { createContext, useContext, useEffect, useState } from 'react';
import { collection, onSnapshot, query, where, doc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { useAuth } from './AuthContext';
import type {
  Announcement,
  ApprovalWorkflowSettings,
  AttendanceCorrection,
  AttendanceRecord,
  AuditLog,
  BackupConfigSettings,
  BackupRecord,
  BreakSession,
  Candidate,
  CompanySettings,
  Department,
  Designation,
  DirectoryEntry,
  EmployeeDocument,
  EmployeeProfile,
  Holiday,
  IntegrationSettings,
  Invitation,
  JobOpening,
  LeaveBalance,
  LeavePolicySettings,
  LeaveRequest,
  MonitoringPolicySettings,
  NotificationItem,
  NotificationPref,
  OffboardingCase,
  OnboardingCase,
  PayrollConfigSettings,
  PayrollRun,
  Payslip,
  PerformanceGoal,
  PerformanceReview,
  ReviewCycle,
  RoleAssignment,
  SalaryStructure,
  ShiftAssignment,
  ShiftTemplate,
  TaskItem,
  WorkPolicySettings,
} from '../types/hrms';
import { DEFAULT_WORKFLOW_RULES } from '../utils/workflowUtils';
import { isAnnouncementVisibleToViewer } from '../utils/taskTimerUtils';

interface HrmsDataContextValue {
  directory: DirectoryEntry[];
  employees: EmployeeProfile[];
  salaries: SalaryStructure[];
  departments: Department[];
  designations: Designation[];
  attendance: AttendanceRecord[];
  attendanceCorrections: AttendanceCorrection[];
  holidays: Holiday[];
  leaveBalances: LeaveBalance[];
  leaveRequests: LeaveRequest[];
  payrollRuns: PayrollRun[];
  payslips: Payslip[];
  jobs: JobOpening[];
  tasks: TaskItem[];
  candidates: Candidate[];
  onboardingCases: OnboardingCase[];
  offboardingCases: OffboardingCase[];
  goals: PerformanceGoal[];
  reviews: PerformanceReview[];
  announcements: Announcement[];
  documents: EmployeeDocument[];
  notifications: NotificationItem[];
  notificationPref: NotificationPref | null;
  roles: RoleAssignment[];
  invitations: Invitation[];
  auditLogs: AuditLog[];
  companySettings: CompanySettings;
  workPolicy: WorkPolicySettings;
  payrollConfig: PayrollConfigSettings;
  leavePolicy: LeavePolicySettings;
  approvalWorkflows: ApprovalWorkflowSettings;
  integrationSettings: IntegrationSettings;
  backupConfig: BackupConfigSettings;
  monitoringPolicy: MonitoringPolicySettings;
  backupHistory: BackupRecord[];
  breakSessions: BreakSession[];
  shiftTemplates: ShiftTemplate[];
  shiftAssignments: ShiftAssignment[];
  reviewCycles: ReviewCycle[];
  dataLoading: boolean;
  dataError: string | null;
  retrySync: () => void;
}

const defaultCompany: CompanySettings = {
  id: 'company',
  companyName: 'ACE Web Experts',
  domain: typeof window !== 'undefined' ? window.location.host : '',
  contactEmail: 'hr@acewebexperts.com',
  address: 'ACE Web Experts HQ',
  defaultCurrency: 'USD',
};

const defaultWorkPolicy: WorkPolicySettings = {
  id: 'workPolicy',
  workStartTime: '09:30',
  workEndTime: '18:30',
  lunchStartTime: '13:30',
  lunchEndTime: '14:15',
  graceMinutes: 15,
  breakMinutes: 45,
  halfDayThresholdMinutes: 270,
  lunchTrackingEnabled: true,
  requireDailyWorkReportBeforeCheckout: false,
  maxOptionalHolidays: 2,
  lateMarksThreshold: 3,
  lateMarksAction: 'half_day',
  officeTimezone: typeof Intl !== 'undefined' ? (Intl.DateTimeFormat().resolvedOptions().timeZone === 'Asia/Calcutta' ? 'Asia/Kolkata' : Intl.DateTimeFormat().resolvedOptions().timeZone) || 'Asia/Kolkata' : 'Asia/Kolkata',
  weeklyOffs: ['Saturday', 'Sunday'],
};

const defaultPayrollConfig: PayrollConfigSettings = {
  id: 'payrollConfig',
  currency: 'USD',
  currencySymbol: '$',
  workingDaysPerMonth: 22,
  overtimeMultiplier: 1.5,
  unpaidLeaveDeductionEnabled: true,
  customRules: [],
};

const defaultLeavePolicy: LeavePolicySettings = {
  id: 'leavePolicy',
  casualAnnual: 12,
  sickAnnual: 10,
  paidAnnual: 15,
  emergencyAnnual: 5,
  carryForwardEnabled: true,
  maxCarryForwardPaid: 10,
};

const defaultWorkflowSettings: ApprovalWorkflowSettings = {
  id: 'approvalWorkflows',
  rules: DEFAULT_WORKFLOW_RULES,
};

const defaultIntegrationSettings: IntegrationSettings = {
  id: 'integrations',
  slackEnabled: false,
  slackChannelName: '#hr-alerts',
  whatsappEnabled: false,
  whatsappSenderLabel: 'ACE HRMS Alerts',
  emailEnabled: true,
  smsWebhookEnabled: false,
};

const defaultBackupConfig: BackupConfigSettings = {
  id: 'backupConfig',
  enabled: true,
  frequency: 'daily',
  retentionDays: 30,
  retentionMaxCount: 30,
  notifyOnSuccess: true,
  notifyOnFailure: true,
  includeStorageManifest: true,
};

const defaultMonitoringPolicy: MonitoringPolicySettings = {
  id: 'monitoringPolicy',
  monitoringMode: 'full',
  screenshotIntervalMinutes: '5-10',
  monitoringRetentionDays: 30,
  monitoringDisabledUids: [],
};

const HrmsDataContext = createContext<HrmsDataContextValue | null>(null);

export function useHrmsData(): HrmsDataContextValue {
  const ctx = useContext(HrmsDataContext);
  if (!ctx) throw new Error('useHrmsData must be used inside HrmsDataProvider');
  return ctx;
}

export const HrmsDataProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const {
    firebaseUser,
    roleAssignment,
    employeeProfile,
    effectiveRole,
    needsEmailVerification,
    needsInitialSetup,
    isPendingApproval,
    isDeactivated,
  } = useAuth();

  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [employees, setEmployees] = useState<EmployeeProfile[]>([]);
  const [salaries, setSalaries] = useState<SalaryStructure[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [designations, setDesignations] = useState<Designation[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [attendanceCorrections, setAttendanceCorrections] = useState<AttendanceCorrection[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [leaveBalances, setLeaveBalances] = useState<LeaveBalance[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>([]);
  const [payrollRuns, setPayrollRuns] = useState<PayrollRun[]>([]);
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [jobs, setJobs] = useState<JobOpening[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [onboardingCases, setOnboardingCases] = useState<OnboardingCase[]>([]);
  const [offboardingCases, setOffboardingCases] = useState<OffboardingCase[]>([]);
  const [goals, setGoals] = useState<PerformanceGoal[]>([]);
  const [reviews, setReviews] = useState<PerformanceReview[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [documents, setDocuments] = useState<EmployeeDocument[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notificationPref, setNotificationPref] = useState<NotificationPref | null>(null);
  const [roles, setRoles] = useState<RoleAssignment[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);

  const [companySettings, setCompanySettings] = useState<CompanySettings>(defaultCompany);
  const [workPolicy, setWorkPolicy] = useState<WorkPolicySettings>(defaultWorkPolicy);
  const [payrollConfig, setPayrollConfig] = useState<PayrollConfigSettings>(defaultPayrollConfig);
  const [leavePolicy, setLeavePolicy] = useState<LeavePolicySettings>(defaultLeavePolicy);
  const [approvalWorkflows, setApprovalWorkflows] = useState<ApprovalWorkflowSettings>(defaultWorkflowSettings);
  const [integrationSettings, setIntegrationSettings] = useState<IntegrationSettings>(defaultIntegrationSettings);
  const [backupConfig, setBackupConfig] = useState<BackupConfigSettings>(defaultBackupConfig);
  const [monitoringPolicy, setMonitoringPolicy] = useState<MonitoringPolicySettings>(defaultMonitoringPolicy);
  const [backupHistory, setBackupHistory] = useState<BackupRecord[]>([]);
  const [breakSessions, setBreakSessions] = useState<BreakSession[]>([]);
  const [shiftTemplates, setShiftTemplates] = useState<ShiftTemplate[]>([]);
  const [shiftAssignments, setShiftAssignments] = useState<ShiftAssignment[]>([]);
  const [reviewCycles, setReviewCycles] = useState<ReviewCycle[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);
  const [syncVersion, setSyncVersion] = useState(0);

  const retrySync = () => setSyncVersion((v) => v + 1);

  useEffect(() => {
    const canSubscribe =
      Boolean(firebaseUser) &&
      !needsEmailVerification &&
      !needsInitialSetup &&
      !isPendingApproval &&
      !isDeactivated;

    if (!canSubscribe || !firebaseUser) {
      setDataLoading(false);
      setDataError(null);
      return;
    }

    setDataLoading(true);
    setDataError(null);
    const uid = firebaseUser.uid;
    const isAdminOrHR = effectiveRole === 'super_admin' || effectiveRole === 'hr_manager';
    const isDeptMgr = effectiveRole === 'dept_manager' || effectiveRole === 'team_lead';
    const deptId = roleAssignment?.departmentId || employeeProfile?.departmentId || '';
    const myTeamLeadUid = employeeProfile?.teamLeadUid || roleAssignment?.teamLeadUid || '';
    const myTeamId = employeeProfile?.teamId || roleAssignment?.teamId || '';
    const myReportingMgrUid = employeeProfile?.reportingManagerUid || '';

    const unsubs: (() => void)[] = [];
    let resolvedInitial = false;
    const safetyTimer = setTimeout(() => {
      resolvedInitial = true;
      setDataLoading(false);
    }, 1500);

    const markReady = () => {
      if (!resolvedInitial) {
        resolvedInitial = true;
        clearTimeout(safetyTimer);
        setDataLoading(false);
      }
    };

    const reportListenerError = (err: unknown, op: OperationType, path: string) => {
      const msg = err instanceof Error ? err.message : String(err);
      setDataError(`Unable to sync ${path}: ${msg}`);
      markReady();
      try {
        handleFirestoreError(err, op, path);
      } catch {
        // Logged via handleFirestoreError; surface state via dataError instead of crashing background listener
      }
    };

    const listenMergedCols = <T,>(
      path: string,
      queries: Array<{ key: string; ref: ReturnType<typeof collection> | ReturnType<typeof query> }>,
      setter: React.Dispatch<React.SetStateAction<T[]>>,
      getKey: (item: T, docId: string) => string,
      filterFn?: (item: T) => boolean,
    ) => {
      const buckets = new Map<string, Map<string, T>>();
      const emit = () => {
        const merged = new Map<string, T>();
        for (const bucket of buckets.values()) {
          for (const [k, v] of bucket.entries()) {
            if (!filterFn || filterFn(v)) {
              merged.set(k, v);
            }
          }
        }
        setter(Array.from(merged.values()));
      };
      for (const qItem of queries) {
        const unsub = onSnapshot(
          qItem.ref,
          (snap) => {
            const nextBucket = new Map<string, T>();
            for (const d of snap.docs) {
              const data = { id: d.id, ...(d.data() as Record<string, unknown>) } as T;
              nextBucket.set(getKey(data, d.id), data);
            }
            buckets.set(qItem.key, nextBucket);
            emit();
          },
          (err) => reportListenerError(err, OperationType.LIST, path)
        );
        unsubs.push(unsub);
      }
    };

    const listenCol = <T,>(
      path: string,
      qRef: ReturnType<typeof collection> | ReturnType<typeof query>,
      setter: React.Dispatch<React.SetStateAction<T[]>>,
      markOnFirst?: boolean
    ) => {
      const unsub = onSnapshot(
        qRef,
        (snap) => {
          setter(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) } as T)));
          if (markOnFirst) markReady();
        },
        (err) => reportListenerError(err, OperationType.LIST, path)
      );
      unsubs.push(unsub);
    };

    // Shared active-member collections
    listenCol<DirectoryEntry>(
      'directory',
      isAdminOrHR ? collection(db, 'directory') : deptId
        ? query(collection(db, 'directory'), where('departmentId', '==', deptId))
        : query(collection(db, 'directory'), where('uid', '==', uid)),
      setDirectory, true
    );
    listenCol<Department>('departments', collection(db, 'departments'), setDepartments);
    listenCol<Designation>('designations', collection(db, 'designations'), setDesignations);
    listenCol<Holiday>('holidays', collection(db, 'holidays'), setHolidays);
    if (isAdminOrHR) {
      listenCol<Announcement>('announcements', collection(db, 'announcements'), setAnnouncements);
    } else {
      const annQueries: Array<{ key: string; ref: ReturnType<typeof collection> | ReturnType<typeof query> }> = [
        { key: 'company', ref: query(collection(db, 'announcements'), where('audience', '==', 'company')) },
        { key: 'authored', ref: query(collection(db, 'announcements'), where('authorUid', '==', uid)) },
      ];
      if (deptId) {
        annQueries.push({
          key: 'dept',
          ref: query(collection(db, 'announcements'), where('audience', '==', 'department'), where('departmentId', '==', deptId)),
        });
      }
      if (effectiveRole === 'dept_manager' && deptId) {
        annQueries.push({
          key: 'dept_teams',
          ref: query(collection(db, 'announcements'), where('audience', '==', 'team'), where('departmentId', '==', deptId)),
        });
      }
      if (effectiveRole === 'team_lead') {
        annQueries.push({
          key: 'lead_team',
          ref: query(collection(db, 'announcements'), where('teamLeadUid', '==', uid)),
        });
      }
      if (myTeamLeadUid && myTeamLeadUid !== uid) {
        annQueries.push({
          key: 'my_tl',
          ref: query(collection(db, 'announcements'), where('teamLeadUid', '==', myTeamLeadUid)),
        });
      }
      if (myTeamId) {
        annQueries.push({
          key: 'my_team',
          ref: query(collection(db, 'announcements'), where('teamId', '==', myTeamId)),
        });
      }
      listenMergedCols<Announcement>(
        'announcements',
        annQueries,
        setAnnouncements,
        (item, docId) => item.id || docId,
        (ann) =>
          isAnnouncementVisibleToViewer(ann, {
            uid,
            effectiveRole,
            departmentId: deptId,
            teamLeadUid: myTeamLeadUid,
            reportingManagerUid: myReportingMgrUid,
            teamId: myTeamId,
          }),
      );
    }
    listenCol<JobOpening>('jobs', collection(db, 'jobs'), setJobs);
    if (isAdminOrHR) {
      listenCol<TaskItem>('tasks', collection(db, 'tasks'), setTasks);
    } else if (isDeptMgr) {
      listenMergedCols<TaskItem>(
        'tasks',
        [
          { key: 'self', ref: query(collection(db, 'tasks'), where('assigneeUid', '==', uid)) },
          ...(deptId ? [{ key: 'dept', ref: query(collection(db, 'tasks'), where('departmentId', '==', deptId)) }] : []),
        ],
        setTasks,
        (item, docId) => item.id || docId,
      );
    } else {
      listenCol<TaskItem>('tasks', query(collection(db, 'tasks'), where('assigneeUid', '==', uid)), setTasks);
    }

    // Settings (document-level listeners so backupConfig remains strictly isolated to Super Admin)
    const listenSettingDoc = <T,>(settingId: string, onValue: (data: T) => void) => {
      const unsub = onSnapshot(
        doc(db, 'settings', settingId),
        (snap) => {
          if (snap.exists()) onValue(snap.data() as T);
        },
        (err) => reportListenerError(err, OperationType.GET, `settings/${settingId}`)
      );
      unsubs.push(unsub);
    };

    listenSettingDoc<CompanySettings>('company', (data) =>
      setCompanySettings({ ...defaultCompany, ...data })
    );
    listenSettingDoc<WorkPolicySettings>('workPolicy', (savedPolicy) => {
      const savedOffs = savedPolicy.weeklyOffs || [];
      const normalizedOffs = savedOffs.includes('Second Saturday')
        ? ['Saturday', 'Sunday']
        : (savedOffs.length ? savedOffs : defaultWorkPolicy.weeklyOffs);
      setWorkPolicy({ ...defaultWorkPolicy, ...savedPolicy, weeklyOffs: normalizedOffs });
    });
    listenSettingDoc<PayrollConfigSettings>('payrollConfig', (data) =>
      setPayrollConfig({ ...defaultPayrollConfig, ...data })
    );
    listenSettingDoc<LeavePolicySettings>('leavePolicy', (data) =>
      setLeavePolicy({ ...defaultLeavePolicy, ...data })
    );
    listenSettingDoc<ApprovalWorkflowSettings>('approvalWorkflows', (data) =>
      setApprovalWorkflows({ ...defaultWorkflowSettings, ...data })
    );
    listenSettingDoc<IntegrationSettings>('integrations', (data) =>
      setIntegrationSettings({ ...defaultIntegrationSettings, ...data })
    );
    listenSettingDoc<MonitoringPolicySettings>('monitoringPolicy', (data) =>
      setMonitoringPolicy({ ...defaultMonitoringPolicy, ...data })
    );
    if (effectiveRole === 'super_admin') {
      listenSettingDoc<BackupConfigSettings>('backupConfig', (data) =>
        setBackupConfig({ ...defaultBackupConfig, ...data })
      );
    } else {
      setBackupConfig(defaultBackupConfig);
    }

    listenCol<ShiftTemplate>('shiftTemplates', collection(db, 'shiftTemplates'), setShiftTemplates);
    listenCol<ShiftAssignment>(
      'shiftAssignments',
      isAdminOrHR
        ? collection(db, 'shiftAssignments')
        : isDeptMgr && deptId
        ? query(collection(db, 'shiftAssignments'), where('departmentId', '==', deptId))
        : query(collection(db, 'shiftAssignments'), where('uid', '==', uid)),
      setShiftAssignments
    );
    listenCol<ReviewCycle>('reviewCycles', collection(db, 'reviewCycles'), setReviewCycles);
    listenCol<BreakSession>(
      'breakSessions',
      isAdminOrHR
        ? collection(db, 'breakSessions')
        : isDeptMgr && deptId
        ? query(collection(db, 'breakSessions'), where('departmentId', '==', deptId))
        : query(collection(db, 'breakSessions'), where('uid', '==', uid)),
      setBreakSessions
    );

    // Role-scoped collections (Team Lead strictly isolated to teamLeadUid / reportingManagerUid / self)
    if (isAdminOrHR) {
      listenCol<EmployeeProfile>('employees', collection(db, 'employees'), setEmployees);
    } else if (effectiveRole === 'team_lead') {
      listenMergedCols<EmployeeProfile>(
        'employees',
        [
          { key: 'self', ref: query(collection(db, 'employees'), where('uid', '==', uid)) },
          { key: 'tl', ref: query(collection(db, 'employees'), where('teamLeadUid', '==', uid)) },
          { key: 'mgr', ref: query(collection(db, 'employees'), where('reportingManagerUid', '==', uid)) },
        ],
        setEmployees,
        (item, docId) => item.id || docId,
      );
    } else if (effectiveRole === 'dept_manager' && deptId) {
      listenCol<EmployeeProfile>(
        'employees',
        query(collection(db, 'employees'), where('departmentId', '==', deptId)),
        setEmployees,
      );
    } else {
      listenCol<EmployeeProfile>(
        'employees',
        query(collection(db, 'employees'), where('uid', '==', uid)),
        setEmployees,
      );
    }

    listenCol<SalaryStructure>(
      'salaries',
      isAdminOrHR ? collection(db, 'salaries') : query(collection(db, 'salaries'), where('uid', '==', uid)),
      setSalaries
    );

    listenCol<AttendanceRecord>(
      'attendance',
      isAdminOrHR
        ? collection(db, 'attendance')
        : isDeptMgr && deptId
        ? query(collection(db, 'attendance'), where('departmentId', '==', deptId))
        : query(collection(db, 'attendance'), where('uid', '==', uid)),
      setAttendance
    );

    listenCol<AttendanceCorrection>(
      'attendanceCorrections',
      isAdminOrHR
        ? collection(db, 'attendanceCorrections')
        : isDeptMgr && deptId
        ? query(collection(db, 'attendanceCorrections'), where('departmentId', '==', deptId))
        : query(collection(db, 'attendanceCorrections'), where('uid', '==', uid)),
      setAttendanceCorrections
    );

    if (effectiveRole === 'super_admin') {
      listenCol<LeaveBalance>('leaveBalances', collection(db, 'leaveBalances'), setLeaveBalances);
    } else if (effectiveRole === 'hr_manager') {
      listenCol<LeaveBalance>(
        'leaveBalances',
        query(
          collection(db, 'leaveBalances'),
          where('ownerRole', 'in', ['employee', 'team_lead', 'dept_manager', 'hr_manager']),
        ),
        setLeaveBalances,
      );
    } else if (effectiveRole === 'team_lead') {
      listenMergedCols<LeaveBalance>(
        'leaveBalances',
        [
          { key: 'self', ref: query(collection(db, 'leaveBalances'), where('uid', '==', uid)) },
          { key: 'tl', ref: query(collection(db, 'leaveBalances'), where('teamLeadUid', '==', uid)) },
        ],
        setLeaveBalances,
        (item, docId) => item.uid || docId,
        (item) => item.uid === uid || (item.ownerRole !== 'super_admin' && item.departmentId !== '__executive_private__'),
      );
    } else if (effectiveRole === 'dept_manager' && deptId) {
      listenMergedCols<LeaveBalance>(
        'leaveBalances',
        [
          { key: 'self', ref: query(collection(db, 'leaveBalances'), where('uid', '==', uid)) },
          { key: 'dept', ref: query(collection(db, 'leaveBalances'), where('departmentId', '==', deptId)) },
        ],
        setLeaveBalances,
        (item, docId) => item.uid || docId,
        (item) => item.uid === uid || (item.ownerRole !== 'super_admin' && item.departmentId !== '__executive_private__'),
      );
    } else {
      listenCol<LeaveBalance>(
        'leaveBalances',
        query(collection(db, 'leaveBalances'), where('uid', '==', uid)),
        setLeaveBalances,
      );
    }

    if (effectiveRole === 'super_admin') {
      listenCol<LeaveRequest>('leaveRequests', collection(db, 'leaveRequests'), setLeaveRequests);
    } else if (effectiveRole === 'hr_manager') {
      listenMergedCols<LeaveRequest>(
        'leaveRequests',
        [
          { key: 'public', ref: query(collection(db, 'leaveRequests'), where('departmentId', '!=', '__executive_private__')) },
          { key: 'self', ref: query(collection(db, 'leaveRequests'), where('uid', '==', uid)) },
          { key: 'mgr', ref: query(collection(db, 'leaveRequests'), where('reportingManagerUid', '==', uid)) },
        ],
        setLeaveRequests,
        (item, docId) => item.id || docId,
        (item) =>
          item.uid === uid ||
          item.reportingManagerUid === uid ||
          (item.requesterRole !== 'super_admin' && item.departmentId !== '__executive_private__'),
      );
    } else if (effectiveRole === 'team_lead') {
      listenMergedCols<LeaveRequest>(
        'leaveRequests',
        [
          { key: 'self', ref: query(collection(db, 'leaveRequests'), where('uid', '==', uid)) },
          { key: 'tl', ref: query(collection(db, 'leaveRequests'), where('teamLeadUid', '==', uid)) },
          { key: 'mgr', ref: query(collection(db, 'leaveRequests'), where('reportingManagerUid', '==', uid)) },
        ],
        setLeaveRequests,
        (item, docId) => item.id || docId,
        (item) =>
          item.uid === uid ||
          item.reportingManagerUid === uid ||
          (item.requesterRole !== 'super_admin' && item.departmentId !== '__executive_private__'),
      );
    } else if (effectiveRole === 'dept_manager') {
      listenMergedCols<LeaveRequest>(
        'leaveRequests',
        [
          { key: 'self', ref: query(collection(db, 'leaveRequests'), where('uid', '==', uid)) },
          { key: 'mgr', ref: query(collection(db, 'leaveRequests'), where('reportingManagerUid', '==', uid)) },
          ...(deptId
            ? [{ key: 'dept', ref: query(collection(db, 'leaveRequests'), where('departmentId', '==', deptId)) }]
            : []),
        ],
        setLeaveRequests,
        (item, docId) => item.id || docId,
        (item) =>
          item.uid === uid ||
          item.reportingManagerUid === uid ||
          (item.requesterRole !== 'super_admin' && item.departmentId !== '__executive_private__'),
      );
    } else {
      listenCol<LeaveRequest>(
        'leaveRequests',
        query(collection(db, 'leaveRequests'), where('uid', '==', uid)),
        setLeaveRequests,
      );
    }

    if (isAdminOrHR) {
      listenCol<PayrollRun>('payrollRuns', collection(db, 'payrollRuns'), setPayrollRuns);
      listenCol<RoleAssignment>('roles', collection(db, 'roles'), setRoles);
      listenCol<Invitation>('invitations', collection(db, 'invitations'), setInvitations);
      listenCol<AuditLog>('auditLogs', collection(db, 'auditLogs'), setAuditLogs);
    } else {
      setPayrollRuns([]);
      setRoles([]);
      setInvitations([]);
      setAuditLogs([]);
    }

    if (effectiveRole === 'super_admin') {
      listenCol<BackupRecord>('backupHistory', collection(db, 'backupHistory'), setBackupHistory);
    } else {
      setBackupHistory([]);
    }

    listenCol<Payslip>(
      'payslips',
      isAdminOrHR ? collection(db, 'payslips') : query(collection(db, 'payslips'), where('uid', '==', uid)),
      setPayslips
    );

    if (isAdminOrHR || isDeptMgr) {
      listenCol<Candidate>('candidates', collection(db, 'candidates'), setCandidates);
    } else {
      setCandidates([]);
    }

    listenCol<OnboardingCase>(
      'onboarding',
      isAdminOrHR ? collection(db, 'onboarding') : query(collection(db, 'onboarding'), where('uid', '==', uid)),
      setOnboardingCases
    );

    listenCol<OffboardingCase>(
      'offboarding',
      isAdminOrHR
        ? collection(db, 'offboarding')
        : isDeptMgr && deptId
        ? query(collection(db, 'offboarding'), where('departmentId', '==', deptId))
        : query(collection(db, 'offboarding'), where('uid', '==', uid)),
      setOffboardingCases
    );

    listenCol<PerformanceGoal>(
      'goals',
      isAdminOrHR
        ? collection(db, 'goals')
        : isDeptMgr && deptId
        ? query(collection(db, 'goals'), where('departmentId', '==', deptId))
        : query(collection(db, 'goals'), where('uid', '==', uid)),
      setGoals
    );

    listenCol<PerformanceReview>(
      'reviews',
      isAdminOrHR
        ? collection(db, 'reviews')
        : isDeptMgr && deptId
        ? query(collection(db, 'reviews'), where('departmentId', '==', deptId))
        : query(collection(db, 'reviews'), where('uid', '==', uid)),
      setReviews
    );

    listenCol<EmployeeDocument>(
      'documents',
      isAdminOrHR ? collection(db, 'documents') : query(collection(db, 'documents'), where('uid', '==', uid)),
      setDocuments
    );

    listenCol<NotificationItem>(
      'notifications',
      query(collection(db, 'notifications'), where('recipientUid', '==', uid)),
      setNotifications
    );

    unsubs.push(
      onSnapshot(
        doc(db, 'notificationPrefs', uid),
        (snap) => {
          setNotificationPref(snap.exists() ? (snap.data() as NotificationPref) : null);
        },
        (err) => reportListenerError(err, OperationType.GET, `notificationPrefs/${uid}`)
      )
    );

    return () => {
      clearTimeout(safetyTimer);
      unsubs.forEach((u) => u());
    };
  }, [
    firebaseUser,
    effectiveRole,
    roleAssignment?.departmentId,
    employeeProfile?.departmentId,
    needsEmailVerification,
    needsInitialSetup,
    isPendingApproval,
    isDeactivated,
    syncVersion,
  ]);

  return (
    <HrmsDataContext.Provider
      value={{
        directory,
        employees,
        salaries,
        departments,
        designations,
        attendance,
        attendanceCorrections,
        holidays,
        leaveBalances,
        leaveRequests,
        payrollRuns,
        payslips,
        jobs,
        tasks,
        candidates,
        onboardingCases,
        offboardingCases,
        goals,
        reviews,
        announcements,
        documents,
        notifications,
        notificationPref,
        roles,
        invitations,
        auditLogs,
        companySettings,
        workPolicy,
        payrollConfig,
        leavePolicy,
        approvalWorkflows,
        integrationSettings,
        backupConfig,
        monitoringPolicy,
        backupHistory,
        breakSessions,
        shiftTemplates,
        shiftAssignments,
        reviewCycles,
        dataLoading,
        dataError,
        retrySync,
      }}
    >
      {children}
    </HrmsDataContext.Provider>
  );
};
