export type UserRole = 'super_admin' | 'hr_manager' | 'dept_manager' | 'team_lead' | 'employee';
export type AccountStatus = 'active' | 'inactive' | 'pending';
export type EmployeeStatus = 'active' | 'inactive' | 'onboarding' | 'offboarding';
export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'intern';

export interface SystemSetup {
  initialized: boolean;
  superAdminUid: string;
  companyName: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface RoleAssignment {
  uid: string;
  email: string;
  role: UserRole;
  departmentId?: string;
  teamId?: string;
  teamLeadUid?: string;
  inviteId?: string;
  status: AccountStatus;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface UserAccount {
  uid: string;
  displayName: string;
  email: string;
  photoURL?: string;
  employeeId?: string;
  emailVerified: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface DirectoryEntry {
  id: string;
  uid?: string;
  employeeCode: string;
  fullName: string;
  avatarUrl?: string;
  departmentId: string;
  departmentName: string;
  designation: string;
  joiningDate: string;
  birthMonthDay?: string;
  status: EmployeeStatus;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface EmployeeProfile {
  id: string;
  uid?: string;
  employeeCode: string;
  fullName: string;
  avatarUrl?: string;
  email: string;
  phone?: string;
  address?: string;
  departmentId: string;
  departmentName: string;
  designation: string;
  joiningDate: string;
  birthDate?: string;
  birthdayOptOut?: boolean;
  probationEndDate?: string;
  probationStatus?: 'in_probation' | 'confirmed' | 'extended';
  employmentType: EmploymentType;
  reportingManagerUid?: string;
  reportingManagerName?: string;
  teamId?: string;
  teamName?: string;
  teamLeadUid?: string;
  teamLeadName?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelation?: string;
  timezone?: string;
  countryCode?: string;
  shiftStartTime?: string;
  shiftEndTime?: string;
  status: EmployeeStatus;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface SalaryStructure {
  employeeId: string;
  uid?: string;
  currency: string;
  basicSalary: number;
  hraAllowance: number;
  transportAllowance: number;
  specialAllowance: number;
  bonus: number;
  incentives: number;
  deductions: number;
  overtimeHourlyRate: number;
  effectiveFrom?: string;
  updatedByUid?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Invitation {
  id: string;
  email: string;
  fullName: string;
  role: Exclude<UserRole, 'super_admin'>;
  departmentId: string;
  departmentName: string;
  designation: string;
  employeeId?: string;
  invitedByUid: string;
  status: 'pending' | 'accepted' | 'revoked';
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Department {
  id: string;
  name: string;
  code: string;
  headUid?: string;
  headName?: string;
  description?: string;
  countryCode?: string;
  location?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Designation {
  id: string;
  title: string;
  departmentId?: string;
  level?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type AttendanceStatus =
  | 'present'
  | 'late'
  | 'half_day'
  | 'early_departure'
  | 'absent'
  | 'weekly_off'
  | 'holiday';

export interface AttendanceRecord {
  id: string;
  uid: string;
  employeeId: string;
  employeeName: string;
  departmentId: string;
  date: string;
  checkInTime?: string;
  checkOutTime?: string;
  lunchStartTime?: string;
  lunchEndTime?: string;
  actualLunchMinutes?: number;
  breakMinutes: number;
  workingMinutes: number;
  lateMinutes?: number;
  latePenaltyDays?: number;
  earlyDepartureMinutes?: number;
  officeTimezone?: string;
  correctionId?: string;
  status: AttendanceStatus;
  isLate: boolean;
  isEarlyDeparture: boolean;
  notes?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface AttendanceCorrection {
  id: string;
  attendanceId?: string;
  uid: string;
  employeeId: string;
  employeeName: string;
  departmentId: string;
  date: string;
  requestedCheckIn: string;
  requestedCheckOut?: string;
  requestedBreakMinutes?: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewedByUid?: string;
  reviewNotes?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ShiftTemplate {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  breakMinutes: number;
  timezone: string;
  weeklyOffs: string[];
  isDefault?: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ShiftAssignment {
  id: string;
  uid: string;
  employeeId: string;
  employeeName: string;
  departmentId: string;
  shiftTemplateId: string;
  shiftName: string;
  startTime: string;
  endTime: string;
  effectiveFrom: string;
  effectiveTo?: string;
  assignedByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Holiday {
  id: string;
  name: string;
  date: string;
  type: 'public' | 'company' | 'optional';
  description?: string;
  countryCode?: string;
  location?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface LeaveBalance {
  uid: string;
  employeeId?: string;
  departmentId?: string;
  teamId?: string;
  teamLeadUid?: string;
  reportingManagerUid?: string;
  ownerRole?: UserRole;
  year: number;
  casualTotal: number;
  casualUsed: number;
  sickTotal: number;
  sickUsed: number;
  paidTotal: number;
  paidUsed: number;
  emergencyTotal: number;
  emergencyUsed: number;
  unpaidUsed: number;
  carriedForwardDays?: number;
  lastResetYear?: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type LeaveType = 'casual' | 'sick' | 'paid' | 'unpaid' | 'emergency' | 'short';

export interface LeaveRequest {
  id: string;
  uid: string;
  employeeId: string;
  employeeName: string;
  departmentId: string;
  teamId?: string;
  teamName?: string;
  teamLeadUid?: string;
  reportingManagerUid?: string;
  requesterRole?: UserRole;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  daysCount: number;
  dayPart?: 'full' | 'first_half' | 'second_half' | 'short';
  shortLeaveHours?: number;
  reason: string;
  attachmentUrl?: string;
  attachmentName?: string;
  status: 'pending' | 'changes_requested' | 'approved' | 'rejected' | 'cancelled';
  reviewedByUid?: string;
  reviewerName?: string;
  reviewComment?: string;
  resubmittedAt?: string;
  cancelledByUid?: string;
  cancelledReason?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface LeaveResetLog {
  id: string;
  year: number;
  executedByUid: string;
  executedByEmail: string;
  employeesUpdated: number;
  maxCarryForwardPaid: number;
  casualResetTo: number;
  sickResetTo: number;
  paidResetTo: number;
  emergencyResetTo: number;
  summary: string;
  createdAt?: unknown;
}

export interface PayrollRun {
  id: string;
  month: string;
  currency: string;
  status: 'draft' | 'processed' | 'finalized';
  totalGross: number;
  totalDeductions: number;
  totalNet: number;
  employeeCount: number;
  processedByUid: string;
  notes?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Payslip {
  id: string;
  runId: string;
  month: string;
  uid?: string;
  employeeId: string;
  employeeCode?: string;
  employeeName: string;
  departmentId?: string;
  departmentName?: string;
  designation?: string;
  currency: string;
  basicSalary: number;
  allowances: number;
  bonuses: number;
  incentives: number;
  overtimePay: number;
  overtimeHours?: number;
  unpaidLeaveDays?: number;
  unpaidLeaveDeduction: number;
  otherDeductions: number;
  grossPay: number;
  netPay: number;
  status: 'generated' | 'issued';
  paymentNote?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface JobOpening {
  id: string;
  title: string;
  departmentId: string;
  departmentName: string;
  location?: string;
  employmentType: EmploymentType;
  openings: number;
  description?: string;
  requirements?: string;
  status: 'open' | 'paused' | 'closed';
  createdByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type CandidateStage = 'applied' | 'screening' | 'interview' | 'offer' | 'selected' | 'rejected';

export interface Candidate {
  id: string;
  jobId: string;
  jobTitle: string;
  fullName: string;
  email: string;
  phone?: string;
  resumeUrl?: string;
  resumeName?: string;
  stage: CandidateStage;
  interviewDate?: string;
  interviewerUid?: string;
  interviewerName?: string;
  interviewFeedback?: string;
  rating?: number;
  notes?: string;
  createdByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface TrainingChecklistItem {
  title: string;
  completed: boolean;
}

export interface OnboardingCase {
  id: string;
  uid?: string;
  employeeId: string;
  employeeName: string;
  email: string;
  departmentId: string;
  departmentName: string;
  designation: string;
  offerLetterUrl?: string;
  offerLetterStatus: 'pending' | 'sent' | 'signed';
  policyAcknowledged: boolean;
  documentsVerified: boolean;
  accountCreated: boolean;
  trainingChecklist: TrainingChecklistItem[];
  progressPercent: number;
  status: 'in_progress' | 'completed';
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface OffboardingCase {
  id: string;
  uid: string;
  employeeId: string;
  employeeName: string;
  departmentId: string;
  resignationDate: string;
  lastWorkingDay: string;
  noticePeriodDays: number;
  reason: string;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  approvedByUid?: string;
  exitInterviewCompleted: boolean;
  exitInterviewNotes?: string;
  assetsReturned: boolean;
  documentsCleared: boolean;
  finalSettlementAmount: number;
  finalSettlementStatus: 'pending' | 'calculated' | 'settled';
  accountDeactivated: boolean;
  status: 'initiated' | 'in_progress' | 'completed';
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface PerformanceGoal {
  id: string;
  uid: string;
  employeeId: string;
  employeeName: string;
  departmentId: string;
  title: string;
  description?: string;
  targetDate: string;
  progress: number;
  status: 'not_started' | 'in_progress' | 'completed';
  createdByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ReviewCycle {
  id: string;
  name: string;
  period: string;
  startDate: string;
  endDate: string;
  status: 'active' | 'closed' | 'upcoming';
  kpis: { name: string; weight: number }[];
  createdByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface PerformanceReview {
  id: string;
  uid: string;
  employeeId: string;
  employeeName: string;
  departmentId: string;
  reviewerUid: string;
  reviewerName: string;
  reviewPeriod: string;
  cycleId?: string;
  kpiScores?: { name: string; weight: number; score: number }[];
  weightedScore?: number;
  rating: number;
  productivityScore: number;
  achievements?: string;
  feedback?: string;
  status: 'draft' | 'submitted' | 'acknowledged';
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type AnnouncementAudience = 'company' | 'department' | 'team';

export interface Announcement {
  id: string;
  title: string;
  category: 'notice' | 'holiday' | 'birthday' | 'anniversary' | 'event' | 'policy';
  content: string;
  pinned: boolean;
  audience?: AnnouncementAudience;
  departmentId?: string;
  teamId?: string;
  teamName?: string;
  teamLeadUid?: string;
  publishDate?: string;
  expiryDate?: string;
  authorUid: string;
  authorName: string;
  authorRole?: UserRole;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface EmployeeDocument {
  id: string;
  uid: string;
  employeeId: string;
  title: string;
  category: 'id_proof' | 'contract' | 'offer_letter' | 'certificate' | 'policy' | 'other';
  fileUrl: string;
  fileName: string;
  fileSize: number;
  expiryDate?: string;
  verified: boolean;
  verifiedByUid?: string;
  uploadedByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface TaskComment {
  id: string;
  authorUid: string;
  authorName: string;
  text: string;
  createdAt: string;
}

export interface TaskAttachment {
  id: string;
  name: string;
  url: string;
  size: number;
  uploadedByUid: string;
  uploadedAt: string;
}

export interface TaskItem {
  id: string;
  title: string;
  description: string;
  project?: string;
  clientName?: string;
  assigneeUid: string;
  assigneeName: string;
  assigneeEmployeeId: string;
  departmentId: string;
  assignedByUid: string;
  assignedByName: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'todo' | 'in_progress' | 'review' | 'completed';
  dueDate: string;
  completionNote?: string;
  completedAt?: unknown;
  timerRunning?: boolean;
  timerStartedAt?: string | null;
  activeTimerUid?: string;
  trackedSeconds?: number;
  comments?: TaskComment[];
  attachments?: TaskAttachment[];
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface NotificationItem {
  id: string;
  recipientUid: string;
  title: string;
  message: string;
  type: 'leave' | 'attendance' | 'payroll' | 'announcement' | 'document' | 'performance' | 'task' | 'system';
  linkTab?: string;
  taskId?: string;
  read: boolean;
  emailSent: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface NotificationPref {
  uid: string;
  emailLeaveUpdates: boolean;
  emailPayroll: boolean;
  emailAnnouncements: boolean;
  emailPerformance: boolean;
  pushEnabled: boolean;
  fcmToken?: string;
  updatedAt?: unknown;
}

export interface BreakSession {
  id: string;
  uid: string;
  employeeName: string;
  departmentId?: string;
  date: string;
  type: 'Lunch' | 'Tea/Short' | 'Personal';
  startAt: string;
  endAt?: string;
  status: 'active' | 'ended';
  autoEnded?: boolean;
  needsReview?: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface CompanySettings {
  id: 'company';
  companyName: string;
  domain: string;
  contactEmail: string;
  address: string;
  defaultCurrency: string;
  updatedByUid?: string;
  updatedAt?: unknown;
}

export interface WorkPolicySettings {
  id: 'workPolicy';
  workStartTime: string;
  workEndTime: string;
  lunchStartTime?: string;
  lunchEndTime?: string;
  graceMinutes: number;
  breakMinutes: number;
  halfDayThresholdMinutes: number;
  lunchTrackingEnabled?: boolean;
  requireDailyWorkReportBeforeCheckout?: boolean;
  maxOptionalHolidays?: number;
  lateMarksThreshold?: number;
  lateMarksAction?: 'half_day' | 'lop';
  officeTimezone?: string;
  weeklyOffs: string[];
  updatedByUid?: string;
  updatedAt?: unknown;
}

export interface CustomPayrollRule {
  name: string;
  type: 'addition' | 'deduction';
  value: number;
}

export interface PayrollConfigSettings {
  id: 'payrollConfig';
  currency: string;
  currencySymbol: string;
  workingDaysPerMonth: number;
  overtimeMultiplier: number;
  unpaidLeaveDeductionEnabled: boolean;
  customRules: CustomPayrollRule[];
  updatedByUid?: string;
  updatedAt?: unknown;
}

export interface LeavePolicySettings {
  id: 'leavePolicy';
  casualAnnual: number;
  sickAnnual: number;
  paidAnnual: number;
  emergencyAnnual: number;
  carryForwardEnabled?: boolean;
  maxCarryForwardPaid?: number;
  lastResetYear?: number;
  superAdminSelfApprovalMode?: 'auto_audit' | 'designated_approver';
  superAdminApproverUid?: string;
  updatedByUid?: string;
  updatedAt?: unknown;
}

export type ApprovalRequestType =
  | 'leave'
  | 'attendance_correction'
  | 'wfh'
  | 'overtime'
  | 'comp_off'
  | 'expense'
  | 'timesheet';

export interface ApprovalWorkflowRule {
  requestType: ApprovalRequestType;
  label: string;
  approverRoles: UserRole[];
  requireHrFinalApproval: boolean;
  autoEscalateHours: number;
}

export interface ApprovalWorkflowSettings {
  id: 'approvalWorkflows';
  rules: ApprovalWorkflowRule[];
  updatedByUid?: string;
  updatedAt?: unknown;
}

export interface IntegrationSettings {
  id: 'integrations';
  slackEnabled: boolean;
  slackChannelName: string;
  whatsappEnabled: boolean;
  whatsappSenderLabel: string;
  emailEnabled: boolean;
  smsWebhookEnabled: boolean;
  updatedByUid?: string;
  updatedAt?: unknown;
}

export type BackupFrequency = 'hourly' | 'daily' | 'weekly';

export interface BackupConfigSettings {
  id: 'backupConfig';
  enabled: boolean;
  frequency: BackupFrequency;
  retentionDays: number;
  retentionMaxCount: number;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  includeStorageManifest: boolean;
  lastBackupAt?: string;
  lastBackupStatus?: 'success' | 'failed';
  lastBackupId?: string;
  updatedByUid?: string;
  updatedAt?: unknown;
}

export type MonitoringMode = 'full' | 'basic';
export type ScreenshotIntervalPreset = '5-10' | '10-15' | '15-20' | '20-30';

export interface MonitoringPolicySettings {
  id: 'monitoringPolicy';
  monitoringMode: MonitoringMode;
  screenshotIntervalMinutes: ScreenshotIntervalPreset;
  monitoringRetentionDays: number;
  monitoringDisabledUids: string[];
  updatedByUid?: string;
  updatedAt?: unknown;
}

export interface BackupRecord {
  id: string;
  trigger: 'scheduled' | 'manual';
  frequency: BackupFrequency;
  status: 'success' | 'failed';
  checksumSha256: string;
  storagePath: string;
  storageFileCount: number;
  totalRecords: number;
  sizeBytes: number;
  collectionCounts: Record<string, number>;
  snapshotJson?: string;
  errorMessage?: string;
  createdByUid: string;
  createdByEmail: string;
  createdAt?: unknown;
}

export interface AuditLog {
  id: string;
  actorUid: string;
  actorEmail: string;
  actorRole: string;
  action: string;
  targetCollection: string;
  targetId: string;
  summary: string;
  createdAt?: unknown;
}

export type ActiveTab =
  | 'dashboard'
  | 'self_service'
  | 'employees'
  | 'attendance'
  | 'tasks'
  | 'leave'
  | 'payroll'
  | 'recruitment'
  | 'onboarding'
  | 'offboarding'
  | 'performance'
  | 'goals'
  | 'announcements'
  | 'notifications'
  | 'reports'
  | 'settings'
  | 'work_hub'
  | 'advanced_operations'
  | 'monitoring'
  | 'org_chart';
