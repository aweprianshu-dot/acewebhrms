import React, { useEffect, useState } from 'react';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp } from 'firebase/firestore';
import {
  Building2,
  Save,
  Plus,
  Trash2,
  Shield,
  Globe,
  CheckCircle2,
  Mail,
  Clock,
  Workflow,
  Webhook,
  Download,
  Upload,
  Database,
  AlertTriangle,
  History,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import { ApiError, apiRequest, dispatchNotification, makeId, writeAuditLog } from '../../services/hrmsApi';
import {
  COMMON_TIMEZONES,
  formatDurationMinutes,
  formatMinutesAsClock12,
  parseHHMMToMinutes,
  resolveWorkPolicy,
} from '../../utils/attendanceUtils';
import {
  RESTORABLE_COLLECTIONS,
  buildBackupBundle,
  computeRestorePreview,
  selectBackupsToPrune,
  serializeFirestoreValue,
  validateAndVerifyBackupBundle,
  type BackupDocumentEntry,
  type BackupValidationResult,
  type RestorePreviewSummary,
} from '../../utils/backupUtils';
import { DEFAULT_WORKFLOW_RULES } from '../../utils/workflowUtils';
import type { ApprovalWorkflowRule, BackupFrequency, BackupRecord, CustomPayrollRule, UserRole } from '../../types/hrms';

const CLIENT_RESTORABLE_COLLECTIONS = new Set<string>([
  'settings',
  'departments',
  'designations',
  'employees',
  'directory',
  'salaries',
  'holidays',
  'attendance',
  'payslips',
  'onboarding',
  'offboarding',
  'breakSessions',
  'shiftTemplates',
  'shiftAssignments',
  'reviewCycles',
  'assets',
  'polls',
  'compOffBalances',
  'notificationPrefs',
]);

export const SettingsModule: React.FC = () => {
  const { firebaseUser, effectiveRole } = useAuth();
  const {
    companySettings,
    workPolicy,
    payrollConfig,
    leavePolicy,
    approvalWorkflows,
    integrationSettings,
    backupConfig,
    backupHistory,
    departments,
    designations,
    employees,
    roles,
    invitations,
    auditLogs,
  } = useHrmsData();

  const isSuperAdmin = effectiveRole === 'super_admin';
  const uid = firebaseUser?.uid || '';

  const [subTab, setSubTab] = useState<
    'company' | 'org' | 'roles' | 'policies' | 'workflows' | 'payroll' | 'integrations' | 'deployment' | 'audit'
  >('company');
  const [savedNotice, setSavedNotice] = useState('');

  // Company state
  const [compName, setCompName] = useState(companySettings.companyName);
  const [compDomain, setCompDomain] = useState(companySettings.domain);
  const [compEmail, setCompEmail] = useState(companySettings.contactEmail);
  const [compAddr, setCompAddr] = useState(companySettings.address);

  // Org CRUD
  const [deptName, setDeptName] = useState('');
  const [deptCode, setDeptCode] = useState('');
  const [desTitle, setDesTitle] = useState('');
  const [desLevel, setDesLevel] = useState('Mid-Senior');

  // Work, Office Timing, Lunch & Leave Policies
  const resolvedPolicy = resolveWorkPolicy(workPolicy);
  const [startT, setStartT] = useState(resolvedPolicy.workStartTime);
  const [endT, setEndT] = useState(resolvedPolicy.workEndTime);
  const [lunchStartT, setLunchStartT] = useState(resolvedPolicy.lunchStartTime);
  const [lunchEndT, setLunchEndT] = useState(resolvedPolicy.lunchEndTime);
  const [lunchTrackingEnabled, setLunchTrackingEnabled] = useState(resolvedPolicy.lunchTrackingEnabled);
  const [requireDailyWorkReportBeforeCheckout, setRequireDailyWorkReportBeforeCheckout] = useState(resolvedPolicy.requireDailyWorkReportBeforeCheckout || false);
  const [maxOptionalHolidays, setMaxOptionalHolidays] = useState(resolvedPolicy.maxOptionalHolidays ?? 2);
  const [lateMarksThreshold, setLateMarksThreshold] = useState(resolvedPolicy.lateMarksThreshold ?? 3);
  const [lateMarksAction, setLateMarksAction] = useState<'half_day'|'lop'>(resolvedPolicy.lateMarksAction || 'half_day');
  const [officeTimezone, setOfficeTimezone] = useState(resolvedPolicy.officeTimezone);
  const [graceM, setGraceM] = useState(resolvedPolicy.graceMinutes);
  const [breakM, setBreakM] = useState(resolvedPolicy.breakMinutes);
  const [halfM, setHalfM] = useState(resolvedPolicy.halfDayThresholdMinutes);
  const [weeklyOffs, setWeeklyOffs] = useState<string[]>(resolvedPolicy.weeklyOffs);

  const [casualAnn, setCasualAnn] = useState(leavePolicy.casualAnnual);
  const [sickAnn, setSickAnn] = useState(leavePolicy.sickAnnual);
  const [paidAnn, setPaidAnn] = useState(leavePolicy.paidAnnual);
  const [emergAnn, setEmergAnn] = useState(leavePolicy.emergencyAnnual);
  const [carryForwardEnabled, setCarryForwardEnabled] = useState(Boolean(leavePolicy.carryForwardEnabled));
  const [maxCarryForwardPaid, setMaxCarryForwardPaid] = useState(leavePolicy.maxCarryForwardPaid ?? 5);
  const [superAdminSelfApprovalMode, setSuperAdminSelfApprovalMode] = useState<'auto_audit' | 'designated_approver'>(
    leavePolicy.superAdminSelfApprovalMode || 'auto_audit'
  );
  const [superAdminApproverUid, setSuperAdminApproverUid] = useState(leavePolicy.superAdminApproverUid || '');

  // Approval workflows & integrations
  const [workflowRules, setWorkflowRules] = useState<ApprovalWorkflowRule[]>(
    approvalWorkflows?.rules?.length ? approvalWorkflows.rules : DEFAULT_WORKFLOW_RULES
  );
  const [slackEnabled, setSlackEnabled] = useState(Boolean(integrationSettings?.slackEnabled));
  const [slackChannelName, setSlackChannelName] = useState(integrationSettings?.slackChannelName || '#hr-alerts');
  const [whatsappEnabled, setWhatsappEnabled] = useState(Boolean(integrationSettings?.whatsappEnabled));
  const [whatsappSenderLabel, setWhatsappSenderLabel] = useState(integrationSettings?.whatsappSenderLabel || 'ACE HRMS');
  const [emailEnabled, setEmailEnabled] = useState(integrationSettings?.emailEnabled ?? true);
  const [smsWebhookEnabled, setSmsWebhookEnabled] = useState(Boolean(integrationSettings?.smsWebhookEnabled));
  const [integrationStatus, setIntegrationStatus] = useState<{
    smtpConfigured: boolean;
    slackConfigured: boolean;
    whatsappConfigured: boolean;
  } | null>(null);
  const [slackTestMsg, setSlackTestMsg] = useState('ACE HRMS test alert from Settings.');
  const [whatsappTo, setWhatsappTo] = useState('');
  const [whatsappTestMsg, setWhatsappTestMsg] = useState('ACE HRMS test alert.');
  const [testEmailTo, setTestEmailTo] = useState(firebaseUser?.email || '');
  const [sendingTestEmail, setSendingTestEmail] = useState(false);
  const [integrationFeedback, setIntegrationFeedback] = useState('');

  // Automatic Backup & Super Admin Restore State
  const [bkpEnabled, setBkpEnabled] = useState(backupConfig.enabled);
  const [bkpFrequency, setBkpFrequency] = useState<BackupFrequency>(backupConfig.frequency);
  const [bkpRetentionDays, setBkpRetentionDays] = useState(backupConfig.retentionDays);
  const [bkpRetentionMaxCount, setBkpRetentionMaxCount] = useState(backupConfig.retentionMaxCount);
  const [bkpNotifySuccess, setBkpNotifySuccess] = useState(backupConfig.notifyOnSuccess);
  const [bkpNotifyFailure, setBkpNotifyFailure] = useState(backupConfig.notifyOnFailure);
  const [bkpIncludeStorage, setBkpIncludeStorage] = useState(backupConfig.includeStorageManifest);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupStatusMsg, setBackupStatusMsg] = useState('');
  const [backupErrorMsg, setBackupErrorMsg] = useState('');

  const [restoreSourceLabel, setRestoreSourceLabel] = useState('');
  const [restoreBackupId, setRestoreBackupId] = useState<string | undefined>(undefined);
  const [restoreRawJson, setRestoreRawJson] = useState('');
  const [restoreValidation, setRestoreValidation] = useState<BackupValidationResult | null>(null);
  const [restorePreview, setRestorePreview] = useState<RestorePreviewSummary | null>(null);
  const [restoreConfirmText, setRestoreConfirmText] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(false);

  // Payroll Config
  const [currency, setCurrency] = useState(payrollConfig.currency);
  const [workDaysMo, setWorkDaysMo] = useState(payrollConfig.workingDaysPerMonth);
  const [otMult, setOtMult] = useState(payrollConfig.overtimeMultiplier);
  const [unpaidDed, setUnpaidDed] = useState(payrollConfig.unpaidLeaveDeductionEnabled);
  const [customRules, setCustomRules] = useState<CustomPayrollRule[]>(payrollConfig.customRules);
  const [ruleName, setRuleName] = useState('');
  const [ruleType, setRuleType] = useState<'addition' | 'deduction'>('addition');
  const [ruleVal, setRuleVal] = useState(0);

  // Deployment info
  const [deployInfo, setDeployInfo] = useState<{
    customDomain: string | null;
    appUrl: string;
    smtpConfigured: boolean;
    firebaseProjectId: string;
    firestoreDatabaseId: string;
  } | null>(null);

  useEffect(() => {
    setCompName(companySettings.companyName);
    setCompDomain(companySettings.domain);
    setCompEmail(companySettings.contactEmail);
    setCompAddr(companySettings.address);
  }, [companySettings]);

  useEffect(() => {
    const r = resolveWorkPolicy(workPolicy);
    setStartT(r.workStartTime);
    setEndT(r.workEndTime);
    setLunchStartT(r.lunchStartTime);
    setLunchEndT(r.lunchEndTime);
    setLunchTrackingEnabled(r.lunchTrackingEnabled);
    setRequireDailyWorkReportBeforeCheckout(r.requireDailyWorkReportBeforeCheckout || false);
    setMaxOptionalHolidays(r.maxOptionalHolidays ?? 2);
    setLateMarksThreshold(r.lateMarksThreshold ?? 3);
    setLateMarksAction(r.lateMarksAction || 'half_day');
    setOfficeTimezone(r.officeTimezone);
    setGraceM(r.graceMinutes);
    setBreakM(r.breakMinutes);
    setHalfM(r.halfDayThresholdMinutes);
    setWeeklyOffs(r.weeklyOffs);
  }, [workPolicy]);

  useEffect(() => {
    setCasualAnn(leavePolicy.casualAnnual);
    setSickAnn(leavePolicy.sickAnnual);
    setPaidAnn(leavePolicy.paidAnnual);
    setEmergAnn(leavePolicy.emergencyAnnual);
    setCarryForwardEnabled(Boolean(leavePolicy.carryForwardEnabled));
    setMaxCarryForwardPaid(leavePolicy.maxCarryForwardPaid ?? 5);
    setSuperAdminSelfApprovalMode(leavePolicy.superAdminSelfApprovalMode || 'auto_audit');
    setSuperAdminApproverUid(leavePolicy.superAdminApproverUid || '');
  }, [leavePolicy]);

  useEffect(() => {
    if (approvalWorkflows?.rules?.length) {
      setWorkflowRules(approvalWorkflows.rules);
    }
  }, [approvalWorkflows]);

  useEffect(() => {
    setSlackEnabled(Boolean(integrationSettings?.slackEnabled));
    setSlackChannelName(integrationSettings?.slackChannelName || '#hr-alerts');
    setWhatsappEnabled(Boolean(integrationSettings?.whatsappEnabled));
    setWhatsappSenderLabel(integrationSettings?.whatsappSenderLabel || 'ACE HRMS');
    setEmailEnabled(integrationSettings?.emailEnabled ?? true);
    setSmsWebhookEnabled(Boolean(integrationSettings?.smsWebhookEnabled));
  }, [integrationSettings]);

  useEffect(() => {
    setBkpEnabled(Boolean(backupConfig?.enabled));
    setBkpFrequency(backupConfig?.frequency || 'daily');
    setBkpRetentionDays(backupConfig?.retentionDays ?? 30);
    setBkpRetentionMaxCount(backupConfig?.retentionMaxCount ?? 30);
    setBkpNotifySuccess(Boolean(backupConfig?.notifyOnSuccess));
    setBkpNotifyFailure(Boolean(backupConfig?.notifyOnFailure));
    setBkpIncludeStorage(Boolean(backupConfig?.includeStorageManifest));
  }, [backupConfig]);

  useEffect(() => {
    if (!testEmailTo && firebaseUser?.email) {
      setTestEmailTo(firebaseUser.email);
    }
  }, [firebaseUser?.email, testEmailTo]);

  useEffect(() => {
    setCurrency(payrollConfig.currency);
    setWorkDaysMo(payrollConfig.workingDaysPerMonth);
    setOtMult(payrollConfig.overtimeMultiplier);
    setUnpaidDed(payrollConfig.unpaidLeaveDeductionEnabled);
    setCustomRules(payrollConfig.customRules);
  }, [payrollConfig]);

  useEffect(() => {
    apiRequest<{
      customDomain: string | null;
      appUrl: string;
      smtpConfigured: boolean;
      firebaseProjectId: string;
      firestoreDatabaseId: string;
    }>('/api/system/deployment-info')
      .then(setDeployInfo)
      .catch(() => {});

    apiRequest<{
      smtpConfigured: boolean;
      slackConfigured: boolean;
      whatsappConfigured: boolean;
    }>('/api/integrations/status')
      .then(setIntegrationStatus)
      .catch(() => {});
  }, []);

  // Auto-recompute breakMinutes whenever lunchStartT or lunchEndT change
  const handleLunchTimeChange = (nextStart: string, nextEnd: string) => {
    setLunchStartT(nextStart);
    setLunchEndT(nextEnd);
    const diff = parseHHMMToMinutes(nextEnd) - parseHHMMToMinutes(nextStart);
    if (diff >= 0) {
      setBreakM(diff);
    }
  };

  const totalOfficeMins = Math.max(0, parseHHMMToMinutes(endT) - parseHHMMToMinutes(startT));
  const computedLunchMins = Math.max(0, parseHHMMToMinutes(lunchEndT) - parseHHMMToMinutes(lunchStartT)) || Number(breakM) || 0;
  const netWorkingMins = Math.max(0, totalOfficeMins - computedLunchMins);

  const removeDepartment = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'departments', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `departments/${id}`);
    }
  };

  const removeDesignation = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'designations', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `designations/${id}`);
    }
  };

  const flash = (msg: string) => {
    setSavedNotice(msg);
    setTimeout(() => setSavedNotice(''), 4000);
  };

  const saveCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await setDoc(doc(db, 'settings', 'company'), {
        id: 'company',
        companyName: compName.trim(),
        domain: compDomain.trim(),
        contactEmail: compEmail.trim(),
        address: compAddr.trim(),
        defaultCurrency: currency,
        updatedByUid: uid,
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog({
        actorUid: uid,
        actorEmail: firebaseUser?.email || '',
        actorRole: effectiveRole,
        action: 'COMPANY_SETTINGS_UPDATED',
        targetCollection: 'settings',
        targetId: 'company',
        summary: `Updated company profile (${compName.trim()})`,
      });
      flash('Company profile saved.');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'settings/company');
    }
  };

  const addDepartment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deptName.trim() || !deptCode.trim()) return;
    const id = makeId('dept');
    try {
      await setDoc(doc(db, 'departments', id), {
        id,
        name: deptName.trim(),
        code: deptCode.trim().toUpperCase(),
        headUid: '',
        headName: '',
        description: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setDeptName('');
      setDeptCode('');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `departments/${id}`);
    }
  };

  const addDesignation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!desTitle.trim()) return;
    const id = makeId('desig');
    try {
      await setDoc(doc(db, 'designations', id), {
        id,
        title: desTitle.trim(),
        departmentId: '',
        level: desLevel.trim(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setDesTitle('');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `designations/${id}`);
    }
  };

  const updateUserRole = async (targetUid: string, role: UserRole, status: 'active' | 'inactive' | 'pending') => {
    try {
      await updateDoc(doc(db, 'roles', targetUid), {
        role,
        status,
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog({
        actorUid: uid,
        actorEmail: firebaseUser?.email || '',
        actorRole: effectiveRole,
        action: 'ROLE_UPDATED',
        targetCollection: 'roles',
        targetId: targetUid,
        summary: `Set user ${targetUid} role to ${role} (${status})`,
      });
      flash('User role & activation status updated.');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `roles/${targetUid}`);
    }
  };

  const savePolicies = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await setDoc(doc(db, 'settings', 'workPolicy'), {
        id: 'workPolicy',
        workStartTime: startT,
        workEndTime: endT,
        lunchStartTime: lunchStartT,
        lunchEndTime: lunchEndT,
        lunchTrackingEnabled,
        requireDailyWorkReportBeforeCheckout,
        maxOptionalHolidays: Number(maxOptionalHolidays),
        lateMarksThreshold: Number(lateMarksThreshold),
        lateMarksAction,
        officeTimezone,
        graceMinutes: Number(graceM),
        breakMinutes: Number(breakM),
        halfDayThresholdMinutes: Number(halfM),
        weeklyOffs,
        updatedByUid: uid,
        updatedAt: serverTimestamp(),
      });
      const nextApproverUid =
        isSuperAdmin
          ? superAdminSelfApprovalMode === 'designated_approver'
            ? superAdminApproverUid
            : ''
          : leavePolicy.superAdminApproverUid || '';
      const nextMode = isSuperAdmin
        ? superAdminSelfApprovalMode
        : leavePolicy.superAdminSelfApprovalMode || 'auto_audit';

      await setDoc(doc(db, 'settings', 'leavePolicy'), {
        id: 'leavePolicy',
        casualAnnual: Number(casualAnn),
        sickAnnual: Number(sickAnn),
        paidAnnual: Number(paidAnn),
        emergencyAnnual: Number(emergAnn),
        carryForwardEnabled,
        maxCarryForwardPaid: Math.max(0, Math.min(90, Number(maxCarryForwardPaid) || 0)),
        ...(leavePolicy.lastResetYear ? { lastResetYear: leavePolicy.lastResetYear } : {}),
        superAdminSelfApprovalMode: nextMode,
        superAdminApproverUid: nextApproverUid,
        updatedByUid: uid,
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog({
        actorUid: uid,
        actorEmail: firebaseUser?.email || '',
        actorRole: effectiveRole,
        action: 'WORK_POLICY_UPDATED',
        targetCollection: 'settings',
        targetId: 'workPolicy',
        summary: `Updated office hours (${startT}-${endT}), lunch (${lunchStartT}-${lunchEndT}), TZ (${officeTimezone}), carry-forward (${carryForwardEnabled}), Super Admin leave mode (${nextMode})`,
      });
      if (isSuperAdmin && nextMode === 'designated_approver' && nextApproverUid && nextApproverUid !== uid) {
        const approverEmp = employees.find((emp) => emp.uid === nextApproverUid);
        await dispatchNotification({
          recipientUid: nextApproverUid,
          recipientEmail: approverEmp?.email,
          title: 'Designated as Super Admin Leave Approver',
          message: `${firebaseUser?.displayName || 'Super Admin'} configured you as their designated personal leave approver.`,
          type: 'system',
          linkTab: 'leave',
          sendEmail: Boolean(approverEmp?.email),
        });
      }
      flash('Office timings, lunch schedule, weekly offs, and leave policies updated.');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'settings/workPolicy');
    }
  };

  const toggleWorkflowApprover = (requestType: ApprovalWorkflowRule['requestType'], role: UserRole) => {
    setWorkflowRules((prev) =>
      prev.map((rule) => {
        if (rule.requestType !== requestType) return rule;
        const exists = rule.approverRoles.includes(role);
        const nextRoles = exists
          ? rule.approverRoles.filter((r) => r !== role)
          : [...rule.approverRoles, role];
        return { ...rule, approverRoles: nextRoles.length > 0 ? nextRoles : ['super_admin'] };
      })
    );
  };

  const saveApprovalWorkflows = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await setDoc(doc(db, 'settings', 'approvalWorkflows'), {
        id: 'approvalWorkflows',
        rules: workflowRules.slice(0, 20),
        updatedByUid: uid,
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog({
        actorUid: uid,
        actorEmail: firebaseUser?.email || '',
        actorRole: effectiveRole,
        action: 'APPROVAL_WORKFLOWS_UPDATED',
        targetCollection: 'settings',
        targetId: 'approvalWorkflows',
        summary: `Updated ${workflowRules.length} approval workflow rules`,
      });
      flash('Approval workflow engine rules saved.');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'settings/approvalWorkflows');
    }
  };

  const saveIntegrations = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await setDoc(doc(db, 'settings', 'integrations'), {
        id: 'integrations',
        slackEnabled,
        slackChannelName: slackChannelName.trim() || '#hr-alerts',
        whatsappEnabled,
        whatsappSenderLabel: whatsappSenderLabel.trim() || 'ACE HRMS',
        emailEnabled,
        smsWebhookEnabled,
        updatedByUid: uid,
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog({
        actorUid: uid,
        actorEmail: firebaseUser?.email || '',
        actorRole: effectiveRole,
        action: 'INTEGRATION_SETTINGS_UPDATED',
        targetCollection: 'settings',
        targetId: 'integrations',
        summary: `Updated integration settings (Slack: ${slackEnabled}, WhatsApp: ${whatsappEnabled}, Email: ${emailEnabled})`,
      });
      flash('Integration preferences saved.');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'settings/integrations');
    }
  };

  const triggerSlackTest = async () => {
    setIntegrationFeedback('');
    try {
      const res = await apiRequest<{ sent: boolean; configured: boolean; reason?: string }>('/api/integrations/slack/notify', {
        method: 'POST',
        body: JSON.stringify({ channel: slackChannelName, message: slackTestMsg }),
      });
      setIntegrationFeedback(
        res.sent
          ? `Slack notification delivered to ${slackChannelName}.`
          : res.reason || 'SLACK_WEBHOOK_URL is not configured on the server.'
      );
    } catch (err) {
      setIntegrationFeedback(err instanceof Error ? err.message : 'Slack test failed.');
    }
  };

  const triggerWhatsappTest = async () => {
    setIntegrationFeedback('');
    try {
      const res = await apiRequest<{ sent: boolean; configured: boolean; reason?: string }>('/api/integrations/whatsapp/notify', {
        method: 'POST',
        body: JSON.stringify({ to: whatsappTo.trim(), message: whatsappTestMsg }),
      });
      setIntegrationFeedback(
        res.sent
          ? `WhatsApp message queued for ${whatsappTo}.`
          : res.reason || 'WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID not configured on the server.'
      );
    } catch (err) {
      setIntegrationFeedback(err instanceof Error ? err.message : 'WhatsApp test failed.');
    }
  };

  const triggerEmailTest = async () => {
    if (!testEmailTo.trim()) return;
    setSendingTestEmail(true);
    setIntegrationFeedback('');
    try {
      const res = await apiRequest<{ delivered: boolean; configured?: boolean; reason?: string; messageId?: string }>(
        '/api/notifications/send-email',
        {
          method: 'POST',
          body: JSON.stringify({
            to: testEmailTo.trim(),
            subject: 'ACE HRMS SMTP Test Notification',
            title: 'SMTP Delivery Verification',
            message: `This is a live test email from ${companySettings.companyName || 'ACE HRMS'} verifying outbound notification delivery.`,
          }),
        }
      );
      setIntegrationFeedback(
        res.delivered
          ? `SMTP test email sent to ${testEmailTo.trim()} (Message ID: ${res.messageId || 'accepted'}).`
          : res.reason || 'SMTP_HOST / SMTP_USER / SMTP_PASS are not configured on the server.'
      );
    } catch (err) {
      setIntegrationFeedback(err instanceof Error ? err.message : 'SMTP test email failed.');
    } finally {
      setSendingTestEmail(false);
    }
  };

  const triggerJsonDownload = (fileName: string, rawJson: string) => {
    const blob = new Blob([rawJson], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const readCurrentCollectionsViaClient = async (): Promise<Record<string, BackupDocumentEntry[]>> => {
    const result: Record<string, BackupDocumentEntry[]> = {};
    for (const colName of RESTORABLE_COLLECTIONS) {
      try {
        const snap = await getDocs(collection(db, colName));
        result[colName] = snap.docs.map((d) => ({
          __docId: d.id,
          data: serializeFirestoreValue(d.data()) as Record<string, unknown>,
        }));
      } catch {
        result[colName] = [];
      }
    }
    return result;
  };

  const saveBackupConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin) return;
    try {
      await setDoc(
        doc(db, 'settings', 'backupConfig'),
        {
          id: 'backupConfig',
          enabled: bkpEnabled,
          frequency: bkpFrequency,
          retentionDays: Math.max(1, Math.min(365, Number(bkpRetentionDays) || 30)),
          retentionMaxCount: Math.max(1, Math.min(200, Number(bkpRetentionMaxCount) || 30)),
          notifyOnSuccess: bkpNotifySuccess,
          notifyOnFailure: bkpNotifyFailure,
          includeStorageManifest: bkpIncludeStorage,
          ...(backupConfig.lastBackupAt ? { lastBackupAt: backupConfig.lastBackupAt } : {}),
          ...(backupConfig.lastBackupStatus ? { lastBackupStatus: backupConfig.lastBackupStatus } : {}),
          ...(backupConfig.lastBackupId ? { lastBackupId: backupConfig.lastBackupId } : {}),
          updatedByUid: uid,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      await writeAuditLog({
        actorUid: uid,
        actorEmail: firebaseUser?.email || '',
        actorRole: effectiveRole,
        action: 'BACKUP_POLICY_UPDATED',
        targetCollection: 'settings',
        targetId: 'backupConfig',
        summary: `Updated automatic backup policy (${bkpEnabled ? bkpFrequency : 'disabled'}, retain ${bkpRetentionDays}d / ${bkpRetentionMaxCount} max)`,
      });
      flash('Automatic backup schedule & retention policy saved.');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'settings/backupConfig');
    }
  };

  const handleRunBackupNow = async () => {
    if (!isSuperAdmin) return;
    setBackupBusy(true);
    setBackupStatusMsg('');
    setBackupErrorMsg('');
    try {
      const res = await apiRequest<{
        success: boolean;
        backupId: string;
        checksumSha256: string;
        totalRecords: number;
        storageFileCount: number;
        sizeBytes: number;
      }>('/api/backups/run', { method: 'POST', body: JSON.stringify({}) });

      setBackupStatusMsg(
        `Server backup ${res.backupId} completed: ${res.totalRecords} Firestore records, ${res.storageFileCount} Storage items, SHA-256 ${res.checksumSha256.slice(0, 12)}…`
      );
      flash('Server backup snapshot completed & recorded.');
    } catch (err) {
      const isIamBlocked = err instanceof ApiError && (err.iamBlocked || err.status === 503);
      if (!isIamBlocked) {
        setBackupErrorMsg(err instanceof Error ? err.message : 'Backup execution failed.');
        setBackupBusy(false);
        return;
      }

      // Super Admin authenticated Web Firestore fallback when server Admin SDK lacks GCP IAM role in preview
      try {
        const exportedAt = new Date().toISOString();
        const backupId = makeId('bkp');
        const collections = await readCurrentCollectionsViaClient();
        const storageManifest = collections.documents
          ? collections.documents.map((entry) => ({
              path: String(entry.data.fileUrl || entry.data.fileName || entry.__docId),
              sizeBytes: Number(entry.data.fileSize || 0),
              contentType: 'document-reference',
              updatedAt: String(entry.data.updatedAt || exportedAt),
            }))
          : [];

        const built = await buildBackupBundle({
          collections,
          storageManifest: bkpIncludeStorage ? storageManifest : [],
          trigger: 'manual',
          frequency: bkpFrequency,
          exportedBy: firebaseUser?.email || uid,
          firebaseProjectId: deployInfo?.firebaseProjectId || 'gen-lang-client-0209720424',
          firestoreDatabaseId: deployInfo?.firestoreDatabaseId || 'ai-studio-workflowosaceweb-f23bec09-9afb-4a68-8d35-a438d22d2192',
          exportedAt,
        });

        await setDoc(doc(db, 'backupHistory', backupId), {
          id: backupId,
          trigger: 'manual',
          frequency: bkpFrequency,
          status: 'success',
          checksumSha256: built.checksumSha256,
          storagePath: 'firestore-inline',
          storageFileCount: bkpIncludeStorage ? storageManifest.length : 0,
          totalRecords: built.totalRecords,
          sizeBytes: built.sizeBytes,
          collectionCounts: built.collectionCounts,
          ...(built.rawJson.length <= 700_000 ? { snapshotJson: built.rawJson } : {}),
          createdByUid: uid,
          createdByEmail: firebaseUser?.email || uid,
          createdAt: serverTimestamp(),
        });

        await setDoc(
          doc(db, 'settings', 'backupConfig'),
          {
            id: 'backupConfig',
            enabled: bkpEnabled,
            frequency: bkpFrequency,
            retentionDays: Math.max(1, Number(bkpRetentionDays) || 30),
            retentionMaxCount: Math.max(1, Number(bkpRetentionMaxCount) || 30),
            notifyOnSuccess: bkpNotifySuccess,
            notifyOnFailure: bkpNotifyFailure,
            includeStorageManifest: bkpIncludeStorage,
            lastBackupAt: exportedAt,
            lastBackupStatus: 'success',
            lastBackupId: backupId,
            updatedByUid: uid,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );

        // Enforce retention cleanup on existing backupHistory
        const normalizedHistory = [
          { id: backupId, status: 'success' as const, timestampIso: exportedAt },
          ...backupHistory.map((item) => ({
            id: item.id,
            status: item.status,
            timestampIso: String(
              serializeFirestoreValue(item.createdAt) || new Date().toISOString()
            ),
          })),
        ];
        const pruneIds = selectBackupsToPrune(
          normalizedHistory,
          bkpRetentionDays,
          bkpRetentionMaxCount
        );
        for (const pruneId of pruneIds) {
          if (pruneId !== backupId) {
            await deleteDoc(doc(db, 'backupHistory', pruneId)).catch(() => {});
          }
        }

        triggerJsonDownload(`ace-hrms-backup-${exportedAt.slice(0, 10)}-${backupId}.json`, built.rawJson);

        await writeAuditLog({
          actorUid: uid,
          actorEmail: firebaseUser?.email || '',
          actorRole: effectiveRole,
          action: 'AUTOMATIC_BACKUP_RUN',
          targetCollection: 'backupHistory',
          targetId: backupId,
          summary: `Verified backup ${backupId} recorded (${built.totalRecords} records, SHA-256 ${built.checksumSha256.slice(0, 12)}…)`,
        });

        if (bkpNotifySuccess && firebaseUser?.email) {
          await dispatchNotification({
            recipientUid: uid,
            recipientEmail: firebaseUser.email,
            title: 'ACE HRMS Backup Completed',
            message: `Backup ${backupId} succeeded with ${built.totalRecords} records (SHA-256 ${built.checksumSha256.slice(0, 12)}). Archive downloaded locally; upload to Firebase Storage/server requires GCP IAM role.`,
            type: 'system',
            linkTab: 'settings',
            sendEmail: Boolean(emailEnabled && firebaseUser.email),
          });
        }

        setBackupStatusMsg(
          `Verified backup ${backupId} recorded (${built.totalRecords} records, SHA-256 ${built.checksumSha256.slice(0, 12)}…) & JSON downloaded. Note: server Admin SDK IAM is blocked in preview, so Super Admin browser credentials captured this snapshot.`
        );
        flash('Verified JSON backup saved & downloaded.');
      } catch (fallbackErr) {
        setBackupErrorMsg(fallbackErr instanceof Error ? fallbackErr.message : 'Client backup fallback failed.');
      }
    } finally {
      setBackupBusy(false);
    }
  };

  const handleDownloadBackupRecord = async (rec: BackupRecord) => {
    setBackupErrorMsg('');
    try {
      if (rec.snapshotJson) {
        triggerJsonDownload(`ace-hrms-backup-${rec.id}.json`, rec.snapshotJson);
        return;
      }
      const res = await apiRequest<{ rawJson: string }>(`/api/backups/${rec.id}/download`);
      triggerJsonDownload(`ace-hrms-backup-${rec.id}.json`, res.rawJson);
    } catch (err) {
      setBackupErrorMsg(err instanceof Error ? err.message : 'Unable to download archived backup.');
    }
  };

  const handleDeleteBackupRecord = async (recId: string) => {
    setBackupErrorMsg('');
    try {
      await apiRequest(`/api/backups/${recId}`, { method: 'DELETE' });
      flash('Backup record deleted.');
    } catch (err) {
      if (err instanceof ApiError && (err.iamBlocked || err.status === 503)) {
        try {
          await deleteDoc(doc(db, 'backupHistory', recId));
          flash('Backup record deleted from Firestore history.');
          return;
        } catch (delErr) {
          handleFirestoreError(delErr, OperationType.DELETE, `backupHistory/${recId}`);
        }
      } else {
        setBackupErrorMsg(err instanceof Error ? err.message : 'Failed to delete backup record.');
      }
    }
  };

  const previewRestorePayload = async (params: { label: string; backupId?: string; rawJson?: string }) => {
    setRestoreBusy(true);
    setBackupErrorMsg('');
    setRestoreConfirmText('');
    setRestoreSourceLabel(params.label);
    setRestoreBackupId(params.backupId);
    try {
      const res = await apiRequest<{ validation: BackupValidationResult; preview: RestorePreviewSummary }>(
        '/api/backups/restore/preview',
        {
          method: 'POST',
          body: JSON.stringify({ backupId: params.backupId, rawJson: params.rawJson }),
        }
      );
      setRestoreRawJson(params.rawJson || '');
      setRestoreValidation(res.validation);
      setRestorePreview(res.preview);
    } catch (err) {
      const isIamBlocked = err instanceof ApiError && (err.iamBlocked || err.status === 503);
      if (!isIamBlocked || !params.rawJson) {
        setBackupErrorMsg(err instanceof Error ? err.message : 'Unable to generate restore preview.');
        setRestoreBusy(false);
        return;
      }
      try {
        const validation = await validateAndVerifyBackupBundle(params.rawJson);
        const current = await readCurrentCollectionsViaClient();
        const preview = computeRestorePreview(current, validation.normalizedCollections);
        setRestoreRawJson(params.rawJson);
        setRestoreValidation(validation);
        setRestorePreview(preview);
      } catch (clientErr) {
        setBackupErrorMsg(clientErr instanceof Error ? clientErr.message : 'Restore validation failed.');
      }
    } finally {
      setRestoreBusy(false);
    }
  };

  const handleInspectHistoryRecord = async (rec: BackupRecord) => {
    if (rec.snapshotJson) {
      await previewRestorePayload({ label: `History: ${rec.id}`, backupId: rec.id, rawJson: rec.snapshotJson });
      return;
    }
    await previewRestorePayload({ label: `History: ${rec.id}`, backupId: rec.id });
  };

  const handleInspectRestoreFile = async (file: File) => {
    const rawJson = await file.text();
    await previewRestorePayload({ label: `Uploaded file: ${file.name}`, rawJson });
  };

  const handleApplyRestore = async () => {
    if (!isSuperAdmin || !restoreValidation?.valid || restoreConfirmText !== 'RESTORE') return;
    setRestoreBusy(true);
    setBackupErrorMsg('');
    setBackupStatusMsg('');
    try {
      const res = await apiRequest<{ success: boolean; restoredDocs: number }>('/api/backups/restore/apply', {
        method: 'POST',
        body: JSON.stringify({
          backupId: restoreBackupId,
          rawJson: restoreRawJson || undefined,
          confirmPhrase: restoreConfirmText,
        }),
      });
      setBackupStatusMsg(`Restore completed cleanly on server: ${res.restoredDocs} document(s) restored.`);
      setRestoreConfirmText('');
      flash(`Restored ${res.restoredDocs} document(s) from verified backup.`);
    } catch (err) {
      const isIamBlocked = err instanceof ApiError && (err.iamBlocked || err.status === 503);
      if (!isIamBlocked) {
        setBackupErrorMsg(err instanceof Error ? err.message : 'Restore operation failed.');
        setRestoreBusy(false);
        return;
      }

      // Client Super Admin batch restore fallback strictly obeying Firestore security rules
      try {
        let restoredDocs = 0;
        let skippedProtectedCols = 0;
        let batch = writeBatch(db);
        let opsInBatch = 0;

        for (const [colName, entries] of Object.entries(restoreValidation.normalizedCollections)) {
          if (!CLIENT_RESTORABLE_COLLECTIONS.has(colName)) {
            if (entries.length > 0) skippedProtectedCols += 1;
            continue;
          }
          for (const entry of entries) {
            const docId = String(entry.__docId || '').replace(/\//g, '_');
            if (!docId || colName === 'settings' && docId === 'backupConfig') continue;
            const ref = doc(db, colName, docId);
            const existingSnap = await getDoc(ref);
            const payload = { ...entry.data } as Record<string, unknown>;
            delete payload.createdAt;
            delete payload.updatedAt;
            delete payload.restoredAt;
            if (colName === 'settings') {
              payload.id = docId;
              payload.updatedByUid = uid;
              payload.updatedAt = serverTimestamp();
            } else if (colName === 'notificationPrefs') {
              payload.uid = docId;
              payload.updatedAt = serverTimestamp();
            } else if (existingSnap.exists()) {
              const existingCreatedAt = existingSnap.data()?.createdAt;
              if (existingCreatedAt !== undefined) payload.createdAt = existingCreatedAt;
              payload.updatedAt = serverTimestamp();
            } else {
              payload.createdAt = serverTimestamp();
              payload.updatedAt = serverTimestamp();
            }
            batch.set(ref, payload);
            opsInBatch += 1;
            restoredDocs += 1;
            if (opsInBatch >= 400) {
              await batch.commit();
              batch = writeBatch(db);
              opsInBatch = 0;
            }
          }
        }
        if (opsInBatch > 0) await batch.commit();

        await writeAuditLog({
          actorUid: uid,
          actorEmail: firebaseUser?.email || '',
          actorRole: effectiveRole,
          action: 'BACKUP_RESTORED',
          targetCollection: 'backupHistory',
          targetId: restoreBackupId || 'uploaded_file',
          summary: `Restored ${restoredDocs} document(s) via Super Admin Web SDK fallback (${restoreSourceLabel})`,
        });

        setRestoreConfirmText('');
        setBackupStatusMsg(
          `Restored ${restoredDocs} document(s) via Super Admin Web SDK (${skippedProtectedCols} server-only workflow collection(s) skipped while server Admin IAM is unavailable).`
        );
        flash(`Restored ${restoredDocs} document(s).`);
      } catch (clientErr) {
        setBackupErrorMsg(clientErr instanceof Error ? clientErr.message : 'Client restore fallback failed.');
      }
    } finally {
      setRestoreBusy(false);
    }
  };

  const savePayrollConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    const symMap: Record<string, string> = { USD: '$', INR: '₹', EUR: '€', GBP: '£', AED: 'AED ', CAD: 'CA$' };
    try {
      await setDoc(doc(db, 'settings', 'payrollConfig'), {
        id: 'payrollConfig',
        currency,
        currencySymbol: symMap[currency] || '$',
        workingDaysPerMonth: Number(workDaysMo),
        overtimeMultiplier: Number(otMult),
        unpaidLeaveDeductionEnabled: unpaidDed,
        customRules,
        updatedByUid: uid,
        updatedAt: serverTimestamp(),
      });
      flash('Payroll calculation rules saved.');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'settings/payrollConfig');
    }
  };

  const toggleDayOff = (day: string) => {
    setWeeklyOffs((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-[#FFFFFF]">HR Settings & Governance</h1>
        <p className="text-sm text-[#A1A1AA] mt-1">
          Configure company identity, departments, roles, office timings, payroll rules, domain readiness, and audit logs
        </p>
      </div>

      {savedNotice && (
        <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{savedNotice}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 p-1.5 bg-[#151922] border border-[#292D36] rounded-2xl">
        {[
          { id: 'company', label: 'Company' },
          { id: 'org', label: 'Departments & Titles' },
          { id: 'roles', label: `Roles & Invites (${roles.length})` },
          { id: 'policies', label: 'Office Timings & Leave Policies' },
          { id: 'workflows', label: 'Approval Workflows' },
          { id: 'payroll', label: 'Payroll Rules' },
          { id: 'integrations', label: 'Slack & WhatsApp' },
          { id: 'deployment', label: 'Domain, Backup & Status' },
          { id: 'audit', label: `Audit Logs (${auditLogs.length})` },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSubTab(t.id as typeof subTab)}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-xl whitespace-nowrap transition-all ${
              subTab === t.id
                ? 'bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-white shadow-sm'
                : 'text-[#A1A1AA] hover:text-[#FFFFFF]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === 'company' && (
        <form onSubmit={saveCompany} className="max-w-xl bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs">
          <div className="flex items-center gap-2 text-[#FFFFFF] font-semibold text-sm">
            <Building2 className="w-4 h-4 text-[#FF6A33]" />
            <span>Company Profile</span>
          </div>
          <div>
            <label className="block text-[#A1A1AA] mb-1">Company Name</label>
            <input type="text" required value={compName} onChange={(e) => setCompName(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
          </div>
          <div>
            <label className="block text-[#A1A1AA] mb-1">Custom Domain (Optional)</label>
            <input
              type="text"
              value={compDomain}
              onChange={(e) => setCompDomain(e.target.value)}
              placeholder={`Optional — active URL is ${typeof window !== 'undefined' ? window.location.host : ''}`}
              className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF] font-mono"
            />
          </div>
          <div>
            <label className="block text-[#A1A1AA] mb-1">HR Contact Email</label>
            <input type="email" required value={compEmail} onChange={(e) => setCompEmail(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
          </div>
          <div>
            <label className="block text-[#A1A1AA] mb-1">Office Address</label>
            <input type="text" value={compAddr} onChange={(e) => setCompAddr(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
          </div>
          <button type="submit" className="ace-btn-primary inline-flex items-center gap-2 px-4 py-2 font-semibold rounded-xl">
            <Save className="w-3.5 h-3.5" />
            Save Company Profile
          </button>
        </form>
      )}

      {subTab === 'org' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 text-xs">
          <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 space-y-4">
            <h2 className="font-display text-base font-semibold text-[#FFFFFF]">Departments</h2>
            <form onSubmit={addDepartment} className="flex gap-2">
              <input type="text" required placeholder="Department Name" value={deptName} onChange={(e) => setDeptName(e.target.value)} className="flex-1 px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
              <input type="text" required placeholder="Code" value={deptCode} onChange={(e) => setDeptCode(e.target.value)} className="w-24 px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF] font-mono uppercase" />
              <button type="submit" className="ace-btn-primary px-3 py-2 rounded-xl">
                <Plus className="w-4 h-4" />
              </button>
            </form>
            <div className="divide-y divide-[#292D36]/70">
              {departments.map((d) => (
                <div key={d.id} className="py-2.5 flex items-center justify-between">
                  <div>
                    <span className="text-[#FFFFFF] font-medium">{d.name}</span>
                    <span className="ml-2 font-mono text-[#A1A1AA]">{d.code}</span>
                  </div>
                  {isSuperAdmin && (
                    <button type="button" onClick={() => removeDepartment(d.id)} className="text-[#A1A1AA] hover:text-rose-400">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 space-y-4">
            <h2 className="font-display text-base font-semibold text-[#FFFFFF]">Designations</h2>
            <form onSubmit={addDesignation} className="flex gap-2">
              <input type="text" required placeholder="Designation Title" value={desTitle} onChange={(e) => setDesTitle(e.target.value)} className="flex-1 px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
              <input type="text" placeholder="Level" value={desLevel} onChange={(e) => setDesLevel(e.target.value)} className="w-28 px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
              <button type="submit" className="ace-btn-primary px-3 py-2 rounded-xl">
                <Plus className="w-4 h-4" />
              </button>
            </form>
            <div className="divide-y divide-[#292D36]/70">
              {designations.map((d) => (
                <div key={d.id} className="py-2.5 flex items-center justify-between">
                  <div>
                    <span className="text-[#FFFFFF] font-medium">{d.title}</span>
                    <span className="ml-2 text-[#A1A1AA]">{d.level}</span>
                  </div>
                  {isSuperAdmin && (
                    <button type="button" onClick={() => removeDesignation(d.id)} className="text-[#A1A1AA] hover:text-rose-400">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {subTab === 'roles' && (
        <div className="space-y-6">
          <div className="bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#292D36] flex items-center gap-2 text-sm font-semibold text-[#FFFFFF]">
              <Shield className="w-4 h-4 text-[#FF6A33]" />
              <span>User Roles & Account Activation</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                    <th className="px-4 py-3 text-left font-medium">User Email</th>
                    <th className="px-4 py-3 text-left font-medium">Role</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#292D36]/70">
                  {roles.map((r) => (
                    <tr key={r.uid}>
                      <td className="px-4 py-3 text-[#FFFFFF] font-medium">{r.email}</td>
                      <td className="px-4 py-3">
                        <select
                          disabled={!isSuperAdmin && r.role === 'super_admin'}
                          value={r.role}
                          onChange={(e) => updateUserRole(r.uid, e.target.value as UserRole, r.status)}
                          className="px-2.5 py-1.5 bg-[#0B0D12] border border-[#292D36] rounded-lg text-[#FFFFFF]"
                        >
                          {isSuperAdmin && <option value="super_admin" className="bg-[#151922]">Super Admin</option>}
                          <option value="hr_manager" className="bg-[#151922]">HR Manager</option>
                          <option value="dept_manager" className="bg-[#151922]">Department Manager</option>
                          <option value="team_lead" className="bg-[#151922]">Team Lead</option>
                          <option value="employee" className="bg-[#151922]">Employee</option>
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <select
                          disabled={!isSuperAdmin && r.role === 'super_admin'}
                          value={r.status}
                          onChange={(e) => updateUserRole(r.uid, r.role, e.target.value as 'active' | 'inactive' | 'pending')}
                          className="px-2.5 py-1.5 bg-[#0B0D12] border border-[#292D36] rounded-lg text-[#FFFFFF]"
                        >
                          <option value="active" className="bg-[#151922]">Active</option>
                          <option value="pending" className="bg-[#151922]">Pending</option>
                          <option value="inactive" className="bg-[#151922]">Inactive</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#292D36] text-sm font-semibold text-[#FFFFFF]">
              Issued Employee Invitations ({invitations.length})
            </div>
            {invitations.length === 0 ? (
              <div className="p-6 text-xs text-[#A1A1AA]">No employee invitations issued yet.</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                    <th className="px-4 py-3 text-left font-medium">Name</th>
                    <th className="px-4 py-3 text-left font-medium">Email</th>
                    <th className="px-4 py-3 text-left font-medium">Role</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#292D36]/70">
                  {invitations.map((inv) => (
                    <tr key={inv.id}>
                      <td className="px-4 py-3 text-[#FFFFFF]">{inv.fullName}</td>
                      <td className="px-4 py-3 text-[#A1A1AA]">{inv.email}</td>
                      <td className="px-4 py-3 capitalize text-[#FF6A33] font-medium">{inv.role.replace('_', ' ')}</td>
                      <td className="px-4 py-3 capitalize text-[#A1A1AA]">{inv.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {subTab === 'policies' && (
        <form onSubmit={savePolicies} className="bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-6 text-xs">
          {/* Live Computed Schedule Summary */}
          <div className="p-4 rounded-2xl bg-[#1B1F28] border border-[#292D36] flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[#FF4634]/15 border border-[#FF4634]/35 flex items-center justify-center text-[#FF6A33]">
                <Clock className="w-4 h-4" />
              </div>
              <div>
                <div className="text-sm font-semibold text-[#FFFFFF]">Configured Office Schedule</div>
                <div className="text-xs text-[#A1A1AA] mt-0.5">
                  Office: {formatMinutesAsClock12(startT)} – {formatMinutesAsClock12(endT)} · Lunch: {formatMinutesAsClock12(lunchStartT)} – {formatMinutesAsClock12(lunchEndT)}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="px-3 py-2 rounded-xl bg-[#0B0D12] border border-[#292D36]">
                <div className="text-[11px] text-[#A1A1AA]">Total Office</div>
                <div className="font-mono font-semibold text-[#FFFFFF] mt-0.5">{formatDurationMinutes(totalOfficeMins)}</div>
              </div>
              <div className="px-3 py-2 rounded-xl bg-[#0B0D12] border border-[#292D36]">
                <div className="text-[11px] text-[#A1A1AA]">Lunch Break</div>
                <div className="font-mono font-semibold text-amber-400 mt-0.5">{formatDurationMinutes(computedLunchMins)}</div>
              </div>
              <div className="px-3 py-2 rounded-xl bg-[#0B0D12] border border-[#292D36]">
                <div className="text-[11px] text-[#A1A1AA]">Net Working</div>
                <div className="font-mono font-semibold text-[#FF6A33] mt-0.5">{formatDurationMinutes(netWorkingMins)}</div>
              </div>
            </div>
          </div>

          <div>
            <h2 className="font-display text-base font-semibold text-[#FFFFFF] mb-3">Office Timings & Lunch Schedule</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-[#A1A1AA] mb-1">Office Start Time</label>
                <input type="time" value={startT} onChange={(e) => setStartT(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Office End Time</label>
                <input type="time" value={endT} onChange={(e) => setEndT(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Lunch Start Time</label>
                <input type="time" value={lunchStartT} onChange={(e) => handleLunchTimeChange(e.target.value, lunchEndT)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Lunch End Time</label>
                <input type="time" value={lunchEndT} onChange={(e) => handleLunchTimeChange(lunchStartT, e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Lunch Break (min)</label>
                <input type="number" min={0} value={breakM} onChange={(e) => setBreakM(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF] font-mono" />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Late Grace (min)</label>
                <input type="number" min={0} value={graceM} onChange={(e) => setGraceM(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF] font-mono" />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Half-Day Threshold (min)</label>
                <input type="number" min={0} value={halfM} onChange={(e) => setHalfM(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF] font-mono" />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Office Timezone</label>
                <select value={officeTimezone} onChange={(e) => setOfficeTimezone(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]">
                  {COMMON_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz} className="bg-[#151922]">{tz}</option>
                  ))}
                  {!COMMON_TIMEZONES.includes(officeTimezone) && (
                    <option value={officeTimezone} className="bg-[#151922]">{officeTimezone}</option>
                  )}
                </select>
              </div>
            </div>

            <label className="mt-4 flex items-center gap-2.5 text-[#FFFFFF] cursor-pointer">
              <input
                type="checkbox"
                checked={lunchTrackingEnabled}
                onChange={(e) => setLunchTrackingEnabled(e.target.checked)}
                className="accent-[#FF4634]"
              />
              <span>Legacy lunch tracking for migrated attendance records (new breaks use Work Hub)</span>
            </label>

            <div className="mt-4 grid sm:grid-cols-2 gap-3 max-w-xl">
              <div><label className="block text-xs text-[#A1A1AA] mb-1">Late marks before penalty</label><input type="number" min="1" max="20" value={lateMarksThreshold} onChange={(e) => setLateMarksThreshold(Number(e.target.value))} className="w-full rounded-xl bg-[#0B0D12] border border-[#343A46] p-2 text-sm text-white"/></div>
              <div><label className="block text-xs text-[#A1A1AA] mb-1">Late-mark penalty</label><select value={lateMarksAction} onChange={(e) => setLateMarksAction(e.target.value as 'half_day'|'lop')} className="w-full rounded-xl bg-[#0B0D12] border border-[#343A46] p-2 text-sm text-white"><option value="half_day">Half Day</option><option value="lop">LOP (0.5 day)</option></select></div>
            </div>
            <div className="mt-4 max-w-xs">
              <label className="block text-xs text-[#A1A1AA] mb-1">Optional holidays allowed per employee / year</label>
              <input type="number" min="0" max="10" value={maxOptionalHolidays} onChange={(e) => setMaxOptionalHolidays(Number(e.target.value))} className="w-full rounded-xl bg-[#0B0D12] border border-[#343A46] p-2 text-sm text-white"/>
            </div>
            <label className="mt-4 flex items-center gap-2.5 text-[#FFFFFF] cursor-pointer">
              <input type="checkbox" checked={requireDailyWorkReportBeforeCheckout} onChange={(e) => setRequireDailyWorkReportBeforeCheckout(e.target.checked)} className="accent-[#FF4634]" />
              <span>Require an approved/submitted daily work report before employee check-out</span>
            </label>

            <div className="mt-4">
              <div className="text-[#A1A1AA] mb-2">Weekly Off Days (Saturday and Sunday are selected by default)</div>
              <div className="flex flex-wrap gap-2">
                {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day) => (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleDayOff(day)}
                    className={`px-3 py-1.5 rounded-xl border transition-all ${
                      weeklyOffs.includes(day)
                        ? 'bg-gradient-to-r from-[#FF4634] to-[#FF6A33] border-[#FF4634] text-white font-medium'
                        : 'bg-[#0B0D12] border-[#292D36] text-[#A1A1AA] hover:text-[#FFFFFF]'
                    }`}
                  >
                    {day === 'Saturday' ? 'Every Saturday' : day}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-[#292D36]">
            <h2 className="font-display text-base font-semibold text-[#FFFFFF] mb-3">Annual Leave Policies</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div><label className="block text-[#A1A1AA] mb-1">Casual Leave / yr</label><input type="number" value={casualAnn} onChange={(e) => setCasualAnn(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF] font-mono" /></div>
              <div><label className="block text-[#A1A1AA] mb-1">Sick Leave / yr</label><input type="number" value={sickAnn} onChange={(e) => setSickAnn(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF] font-mono" /></div>
              <div><label className="block text-[#A1A1AA] mb-1">Paid Leave / yr</label><input type="number" value={paidAnn} onChange={(e) => setPaidAnn(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF] font-mono" /></div>
              <div><label className="block text-[#A1A1AA] mb-1">Emergency / yr</label><input type="number" value={emergAnn} onChange={(e) => setEmergAnn(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF] font-mono" /></div>
            </div>
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 items-center max-w-2xl">
              <label className="flex items-center gap-2.5 text-[#FFFFFF] cursor-pointer">
                <input
                  type="checkbox"
                  checked={carryForwardEnabled}
                  onChange={(e) => setCarryForwardEnabled(e.target.checked)}
                  className="accent-[#FF4634]"
                />
                <span>Enable Paid Leave Carry-Forward on Year-End Reset</span>
              </label>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Max Paid Leave Carry-Forward (days)</label>
                <input
                  type="number"
                  min={0}
                  max={90}
                  disabled={!carryForwardEnabled}
                  value={maxCarryForwardPaid}
                  onChange={(e) => setMaxCarryForwardPaid(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono disabled:opacity-50"
                />
              </div>
            </div>

            {isSuperAdmin && (
              <div className="mt-5 p-4 rounded-xl bg-[#1B1F28] border border-[#292D36] space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-[#FFFFFF]">
                  <Shield className="w-4 h-4 text-[#FF6A33]" />
                  <span>Super Admin Personal Leave Governance &amp; Privacy</span>
                </div>
                <p className="text-[11px] text-[#A1A1AA]">
                  Super Admin personal leave records are strictly private and never appear to employees, Team Leaders, Managers, or HR (unless an approver is explicitly designated below).
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[#A1A1AA] mb-1">Personal Leave Approval Mode</label>
                    <select
                      value={superAdminSelfApprovalMode}
                      onChange={(e) => setSuperAdminSelfApprovalMode(e.target.value as 'auto_audit' | 'designated_approver')}
                      className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]"
                    >
                      <option value="auto_audit">Auto-approve with full audit trail</option>
                      <option value="designated_approver">Route to designated approver</option>
                    </select>
                  </div>
                  {superAdminSelfApprovalMode === 'designated_approver' && (
                    <div>
                      <label className="block text-[#A1A1AA] mb-1">Designated Approver (Co-Admin / HR)</label>
                      <select
                        value={superAdminApproverUid}
                        onChange={(e) => setSuperAdminApproverUid(e.target.value)}
                        className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]"
                      >
                        <option value="">Select approver...</option>
                        {employees
                          .filter((emp) => {
                            if (!emp.uid || emp.uid === uid) return false;
                            const roleRec = roles.find((r) => r.uid === emp.uid);
                            return (
                              roleRec?.status === 'active' &&
                              (roleRec?.role === 'super_admin' ||
                                roleRec?.role === 'hr_manager' ||
                                roleRec?.role === 'dept_manager' ||
                                roleRec?.role === 'team_lead')
                            );
                          })
                          .map((emp) => (
                            <option key={emp.uid} value={emp.uid}>
                              {emp.fullName} ({emp.designation})
                            </option>
                          ))}
                      </select>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <button type="submit" className="ace-btn-primary inline-flex items-center gap-2 px-5 py-2.5 font-semibold rounded-xl">
            <Save className="w-3.5 h-3.5" />
            Save Policies & Office Schedule
          </button>
        </form>
      )}

      {subTab === 'workflows' && (
        <form onSubmit={saveApprovalWorkflows} className="bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-5 text-xs">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[#FFFFFF] font-semibold text-sm">
              <Workflow className="w-4 h-4 text-[#FF6A33]" />
              <span>Configurable Approval Workflow Engine</span>
            </div>
            <button
              type="button"
              onClick={() => setWorkflowRules(DEFAULT_WORKFLOW_RULES)}
              className="px-3 py-1.5 rounded-lg border border-[#292D36] bg-[#1B1F28] text-[#A1A1AA] hover:text-[#FFFFFF]"
            >
              Reset Defaults
            </button>
          </div>
          <p className="text-[#A1A1AA]">
            Control which roles can approve each HR request category, whether HR final sign-off is required, and escalation SLA hours.
          </p>
          <div className="space-y-3">
            {workflowRules.map((rule) => (
              <div key={rule.requestType} className="p-4 rounded-xl bg-[#1B1F28] border border-[#292D36] flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-semibold text-[#FFFFFF]">{rule.label}</div>
                  <div className="text-[11px] text-[#A1A1AA] font-mono mt-0.5">{rule.requestType}</div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {(['team_lead', 'dept_manager', 'hr_manager', 'super_admin'] as UserRole[]).map((role) => (
                    <label key={role} className="inline-flex items-center gap-1.5 text-[#FFFFFF] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={rule.approverRoles.includes(role)}
                        onChange={() => toggleWorkflowApprover(rule.requestType, role)}
                        className="accent-[#FF4634]"
                      />
                      <span className="capitalize">{role.replace('_', ' ')}</span>
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <label className="inline-flex items-center gap-1.5 text-[#A1A1AA] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rule.requireHrFinalApproval}
                      onChange={(e) =>
                        setWorkflowRules((prev) =>
                          prev.map((r) => (r.requestType === rule.requestType ? { ...r, requireHrFinalApproval: e.target.checked } : r))
                        )
                      }
                      className="accent-[#FF4634]"
                    />
                    <span>HR Final Approval</span>
                  </label>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[#A1A1AA]">Escalate (h)</span>
                    <input
                      type="number"
                      min={1}
                      max={168}
                      value={rule.autoEscalateHours}
                      onChange={(e) =>
                        setWorkflowRules((prev) =>
                          prev.map((r) => (r.requestType === rule.requestType ? { ...r, autoEscalateHours: Number(e.target.value) || 24 } : r))
                        )
                      }
                      className="w-16 px-2 py-1 bg-[#0B0D12] border border-[#292D36] rounded-lg text-[#FFFFFF] font-mono"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
          <button type="submit" className="ace-btn-primary inline-flex items-center gap-2 px-5 py-2.5 font-semibold rounded-xl">
            <Save className="w-3.5 h-3.5" />
            Save Workflow Rules
          </button>
        </form>
      )}

      {subTab === 'payroll' && (
        <form onSubmit={savePayrollConfig} className="max-w-2xl bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-5 text-xs">
          <h2 className="font-display text-base font-semibold text-[#FFFFFF]">Configurable Payroll Rules</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-[#A1A1AA] mb-1">Currency</label>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]">
                <option value="USD" className="bg-[#151922]">USD ($)</option>
                <option value="INR" className="bg-[#151922]">INR (₹)</option>
                <option value="EUR" className="bg-[#151922]">EUR (€)</option>
                <option value="GBP" className="bg-[#151922]">GBP (£)</option>
                <option value="AED" className="bg-[#151922]">AED</option>
                <option value="CAD" className="bg-[#151922]">CAD (CA$)</option>
              </select>
            </div>
            <div>
              <label className="block text-[#A1A1AA] mb-1">Working Days / Month</label>
              <input type="number" min={1} max={31} value={workDaysMo} onChange={(e) => setWorkDaysMo(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF] font-mono" />
            </div>
            <div>
              <label className="block text-[#A1A1AA] mb-1">Overtime Multiplier</label>
              <input type="number" min={1} max={4} step="0.1" value={otMult} onChange={(e) => setOtMult(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF] font-mono" />
            </div>
          </div>

          <label className="flex items-center gap-2 text-[#FFFFFF] cursor-pointer">
            <input type="checkbox" checked={unpaidDed} onChange={(e) => setUnpaidDed(e.target.checked)} className="accent-[#FF4634]" />
            <span>Automatically deduct approved Unpaid Leave days based on monthly working days</span>
          </label>

          <div className="pt-3 border-t border-[#292D36] space-y-3">
            <div className="font-medium text-[#FFFFFF]">Custom Organization Rules (Additions / Deductions)</div>
            <div className="flex flex-wrap gap-2">
              <input type="text" placeholder="Rule Name (e.g. Internet Stipend)" value={ruleName} onChange={(e) => setRuleName(e.target.value)} className="flex-1 min-w-[160px] px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
              <select value={ruleType} onChange={(e) => setRuleType(e.target.value as 'addition' | 'deduction')} className="px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]">
                <option value="addition" className="bg-[#151922]">Addition (+)</option>
                <option value="deduction" className="bg-[#151922]">Deduction (-)</option>
              </select>
              <input type="number" min={0} value={ruleVal} onChange={(e) => setRuleVal(Number(e.target.value))} className="w-24 px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono" />
              <button
                type="button"
                onClick={() => {
                  if (!ruleName.trim()) return;
                  setCustomRules((prev) => [...prev, { name: ruleName.trim(), type: ruleType, value: Number(ruleVal) }]);
                  setRuleName('');
                  setRuleVal(0);
                }}
                className="px-3 py-2 bg-[#1B1F28] hover:bg-[#292D36] border border-[#292D36] text-[#FFFFFF] rounded-xl"
              >
                Add Rule
              </button>
            </div>
            {customRules.map((r, i) => (
              <div key={i} className="flex items-center justify-between p-2.5 bg-[#0B0D12] border border-[#292D36] rounded-xl">
                <span className="text-[#FFFFFF]">{r.name} ({r.type === 'addition' ? '+' : '-'}{r.value} {currency})</span>
                <button type="button" onClick={() => setCustomRules((prev) => prev.filter((_, idx) => idx !== i))} className="text-[#A1A1AA] hover:text-rose-400">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          <button type="submit" className="ace-btn-primary inline-flex items-center gap-2 px-4 py-2 font-semibold rounded-xl">
            <Save className="w-3.5 h-3.5" />
            Save Payroll Rules
          </button>
        </form>
      )}

      {subTab === 'integrations' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 text-xs">
          <form onSubmit={saveIntegrations} className="bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-2 text-[#FFFFFF] font-semibold text-sm">
              <Webhook className="w-4 h-4 text-[#FF6A33]" />
              <span>Notification Channels &amp; Webhook Hooks</span>
            </div>
            <div className="space-y-3">
              <div className="p-3 rounded-xl bg-[#0B0D12] border border-[#292D36] flex items-center justify-between">
                <span className="text-[#A1A1AA]">Server Slack Webhook (SLACK_WEBHOOK_URL)</span>
                <span className={integrationStatus?.slackConfigured ? 'text-emerald-400 font-medium' : 'text-amber-400 font-medium'}>
                  {integrationStatus?.slackConfigured ? 'Configured' : 'Not Configured'}
                </span>
              </div>
              <div className="p-3 rounded-xl bg-[#0B0D12] border border-[#292D36] flex items-center justify-between">
                <span className="text-[#A1A1AA]">Server WhatsApp Cloud API (WHATSAPP_TOKEN)</span>
                <span className={integrationStatus?.whatsappConfigured ? 'text-emerald-400 font-medium' : 'text-amber-400 font-medium'}>
                  {integrationStatus?.whatsappConfigured ? 'Configured' : 'Not Configured'}
                </span>
              </div>
            </div>

            <label className="flex items-center gap-2.5 text-[#FFFFFF] cursor-pointer">
              <input type="checkbox" checked={slackEnabled} onChange={(e) => setSlackEnabled(e.target.checked)} className="accent-[#FF4634]" />
              <span>Enable Slack HR Alerts</span>
            </label>
            <div>
              <label className="block text-[#A1A1AA] mb-1">Slack Channel Label</label>
              <input type="text" value={slackChannelName} onChange={(e) => setSlackChannelName(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono" />
            </div>

            <label className="flex items-center gap-2.5 text-[#FFFFFF] cursor-pointer">
              <input type="checkbox" checked={whatsappEnabled} onChange={(e) => setWhatsappEnabled(e.target.checked)} className="accent-[#FF4634]" />
              <span>Enable WhatsApp Escalations</span>
            </label>
            <div>
              <label className="block text-[#A1A1AA] mb-1">WhatsApp Sender Label</label>
              <input type="text" value={whatsappSenderLabel} onChange={(e) => setWhatsappSenderLabel(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]" />
            </div>

            <label className="flex items-center gap-2.5 text-[#FFFFFF] cursor-pointer">
              <input type="checkbox" checked={emailEnabled} onChange={(e) => setEmailEnabled(e.target.checked)} className="accent-[#FF4634]" />
              <span>Enable SMTP Email Dispatch</span>
            </label>
            <label className="flex items-center gap-2.5 text-[#FFFFFF] cursor-pointer">
              <input type="checkbox" checked={smsWebhookEnabled} onChange={(e) => setSmsWebhookEnabled(e.target.checked)} className="accent-[#FF4634]" />
              <span>Enable SMS / External Webhook Relay</span>
            </label>

            <button type="submit" className="ace-btn-primary inline-flex items-center gap-2 px-4 py-2 font-semibold rounded-xl">
              <Save className="w-3.5 h-3.5" />
              Save Integration Preferences
            </button>
          </form>

          <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4">
            <h2 className="font-display text-sm font-semibold text-[#FFFFFF]">Test Live Dispatch</h2>
            {integrationFeedback && (
              <div className="p-3 rounded-xl bg-[#1B1F28] border border-[#292D36] text-[#FFFFFF]">
                {integrationFeedback}
              </div>
            )}
            <div className="space-y-2 p-4 rounded-xl bg-[#1B1F28] border border-[#292D36]">
              <div className="font-semibold text-[#FFFFFF]">SMTP Email Delivery Test</div>
              <input
                type="email"
                value={testEmailTo}
                onChange={(e) => setTestEmailTo(e.target.value)}
                placeholder="recipient@company.com"
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]"
              />
              <button
                type="button"
                disabled={sendingTestEmail || !testEmailTo.trim()}
                onClick={() => void triggerEmailTest()}
                className="px-3.5 py-2 rounded-xl bg-[#0B0D12] border border-[#292D36] text-[#FFFFFF] hover:border-[#FF4634] disabled:opacity-50"
              >
                {sendingTestEmail ? 'Sending…' : 'Send Test Email'}
              </button>
            </div>
            <div className="space-y-2 p-4 rounded-xl bg-[#1B1F28] border border-[#292D36]">
              <div className="font-semibold text-[#FFFFFF]">Slack Webhook Test</div>
              <input type="text" value={slackTestMsg} onChange={(e) => setSlackTestMsg(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]" />
              <button type="button" onClick={() => void triggerSlackTest()} className="px-3.5 py-2 rounded-xl bg-[#0B0D12] border border-[#292D36] text-[#FFFFFF] hover:border-[#FF4634]">
                Send Slack Test
              </button>
            </div>
            <div className="space-y-2 p-4 rounded-xl bg-[#1B1F28] border border-[#292D36]">
              <div className="font-semibold text-[#FFFFFF]">WhatsApp Cloud API Test</div>
              <input type="text" value={whatsappTo} onChange={(e) => setWhatsappTo(e.target.value)} placeholder="Recipient E.164 phone (e.g. 9198XXXXXXXX)" className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono" />
              <input type="text" value={whatsappTestMsg} onChange={(e) => setWhatsappTestMsg(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]" />
              <button type="button" onClick={() => void triggerWhatsappTest()} className="px-3.5 py-2 rounded-xl bg-[#0B0D12] border border-[#292D36] text-[#FFFFFF] hover:border-[#FF4634]">
                Send WhatsApp Test
              </button>
            </div>
          </div>
        </div>
      )}

      {subTab === 'deployment' && (
        <div className="space-y-6 max-w-4xl">
          <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-5 text-xs">
            <div className="flex items-center gap-2 text-[#FFFFFF] font-semibold text-sm">
              <Globe className="w-4 h-4 text-[#FF6A33]" />
              <span>Application URL, Custom Domain & Email Status</span>
            </div>
            <div className="space-y-3">
              <div className="p-3.5 rounded-xl bg-[#0B0D12] border border-[#292D36] flex items-center justify-between gap-4">
                <span className="text-[#A1A1AA]">Active Application URL</span>
                <span className="font-mono text-[#FFFFFF] truncate">
                  {deployInfo?.appUrl || (typeof window !== 'undefined' ? window.location.origin : '')}
                </span>
              </div>
              <div className="p-3.5 rounded-xl bg-[#0B0D12] border border-[#292D36] flex items-center justify-between gap-4">
                <span className="text-[#A1A1AA]">Custom Domain (Optional)</span>
                <span className="font-mono text-[#FFFFFF] truncate">
                  {deployInfo?.customDomain || companySettings.domain || 'Not set (using active URL)'}
                </span>
              </div>
              <div className="p-3.5 rounded-xl bg-[#0B0D12] border border-[#292D36] flex items-center justify-between gap-4">
                <span className="text-[#A1A1AA]">Firebase Project</span>
                <span className="font-mono text-[#FFFFFF]">{deployInfo?.firebaseProjectId || 'gen-lang-client-0209720424'}</span>
              </div>
              <div className="p-3.5 rounded-xl bg-[#0B0D12] border border-[#292D36] flex items-center justify-between gap-4">
                <span className="text-[#A1A1AA]">Firestore Database ID</span>
                <span className="font-mono text-[#FFFFFF]">{deployInfo?.firestoreDatabaseId || 'ai-studio-workflowosaceweb-f23bec09-9afb-4a68-8d35-a438d22d2192'}</span>
              </div>
              <div className="p-3.5 rounded-xl bg-[#0B0D12] border border-[#292D36] flex items-center justify-between gap-4">
                <span className="text-[#A1A1AA] flex items-center gap-1.5"><Mail className="w-3.5 h-3.5" /> SMTP Email Provider (Optional)</span>
                <span className={deployInfo?.smtpConfigured ? 'text-emerald-400 font-medium' : 'text-[#A1A1AA] font-medium'}>
                  {deployInfo?.smtpConfigured ? 'Configured & Active' : 'Not Configured (In-app notifications active)'}
                </span>
              </div>
            </div>
            <div className="text-[#A1A1AA] leading-relaxed space-y-1.5">
              <p className="text-[#FFFFFF] font-medium">Production Readiness Notes:</p>
              <p>1. In development and staging, ACE HRMS automatically uses your current application URL and Firebase real-time in-app/popup notifications without requiring SMTP or custom domain setup.</p>
              <p>2. When ready for production, you can optionally set <code className="text-[#FF6A33]">CUSTOM_DOMAIN</code> and <code className="text-[#FF6A33]">SMTP_HOST / SMTP_USER / SMTP_PASS</code> environment variables and authorize the custom domain in Firebase Authentication.</p>
            </div>
          </div>

          {isSuperAdmin && (
            <div className="space-y-6 text-xs">
              {/* Automatic Backup Policy Card */}
              <form onSubmit={saveBackupConfig} className="bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-[#FFFFFF] font-semibold text-sm">
                    <Database className="w-4 h-4 text-[#FF6A33]" />
                    <span>Automatic Firestore &amp; Storage Backup Schedule</span>
                  </div>
                  {backupConfig.lastBackupAt && (
                    <span className="text-[11px] font-mono text-[#A1A1AA] tabular-nums">
                      Last Run: {new Date(backupConfig.lastBackupAt).toLocaleString()} ({backupConfig.lastBackupStatus || 'recorded'})
                    </span>
                  )}
                </div>

                <p className="text-[#A1A1AA]">
                  Configure scheduled automatic snapshots across all HRMS Firestore collections with Storage object manifest, SHA-256 integrity checksums, retention pruning, and Super Admin notifications. Recovery procedure is documented in <code className="text-[#FF6A33]">BACKUP-RECOVERY-PROCEDURE.md</code>.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[#A1A1AA] mb-1">Backup Frequency</label>
                    <select
                      value={bkpFrequency}
                      onChange={(e) => setBkpFrequency(e.target.value as BackupFrequency)}
                      className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]"
                    >
                      <option value="hourly" className="bg-[#151922]">Hourly (Every 1 hour)</option>
                      <option value="daily" className="bg-[#151922]">Daily (Every 24 hours)</option>
                      <option value="weekly" className="bg-[#151922]">Weekly (Every 7 days)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[#A1A1AA] mb-1">Retention Window (Days)</label>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={bkpRetentionDays}
                      onChange={(e) => setBkpRetentionDays(Number(e.target.value))}
                      className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-[#A1A1AA] mb-1">Max Stored Backups</label>
                    <input
                      type="number"
                      min={1}
                      max={200}
                      value={bkpRetentionMaxCount}
                      onChange={(e) => setBkpRetentionMaxCount(Number(e.target.value))}
                      className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono tabular-nums"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <label className="flex items-center gap-2.5 text-[#FFFFFF] cursor-pointer">
                    <input type="checkbox" checked={bkpEnabled} onChange={(e) => setBkpEnabled(e.target.checked)} className="accent-[#FF4634]" />
                    <span>Enable scheduled automatic backups</span>
                  </label>
                  <label className="flex items-center gap-2.5 text-[#FFFFFF] cursor-pointer">
                    <input type="checkbox" checked={bkpIncludeStorage} onChange={(e) => setBkpIncludeStorage(e.target.checked)} className="accent-[#FF4634]" />
                    <span>Include Firebase Storage file manifest</span>
                  </label>
                  <label className="flex items-center gap-2.5 text-[#FFFFFF] cursor-pointer">
                    <input type="checkbox" checked={bkpNotifySuccess} onChange={(e) => setBkpNotifySuccess(e.target.checked)} className="accent-[#FF4634]" />
                    <span>Notify Super Admins when backup succeeds</span>
                  </label>
                  <label className="flex items-center gap-2.5 text-[#FFFFFF] cursor-pointer">
                    <input type="checkbox" checked={bkpNotifyFailure} onChange={(e) => setBkpNotifyFailure(e.target.checked)} className="accent-[#FF4634]" />
                    <span>Alert Super Admins if backup fails</span>
                  </label>
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-2">
                  <button type="submit" className="ace-btn-primary inline-flex items-center gap-2 px-4 py-2 font-semibold rounded-xl">
                    <Save className="w-3.5 h-3.5" />
                    Save Backup Policy
                  </button>
                  <button
                    type="button"
                    disabled={backupBusy}
                    onClick={() => void handleRunBackupNow()}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-[#292D36] bg-[#1B1F28] text-[#FFFFFF] hover:border-[#FF4634] disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${backupBusy ? 'animate-spin' : ''}`} />
                    {backupBusy ? 'Running Snapshot…' : 'Run Verified Backup Now'}
                  </button>
                  <label className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-[#292D36] bg-[#1B1F28] text-[#FFFFFF] cursor-pointer hover:border-[#FF4634]">
                    <Upload className="w-3.5 h-3.5" />
                    <span>Inspect / Restore from JSON File</span>
                    <input
                      type="file"
                      accept="application/json,.json"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void handleInspectRestoreFile(f);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>

                {backupStatusMsg && (
                  <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{backupStatusMsg}</span>
                  </div>
                )}
                {backupErrorMsg && (
                  <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{backupErrorMsg}</span>
                  </div>
                )}
              </form>

              {/* Backup History & Retention Table */}
              <div className="bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden">
                <div className="px-5 py-3.5 border-b border-[#292D36] flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-semibold text-[#FFFFFF]">
                    <History className="w-4 h-4 text-[#FF6A33]" />
                    <span>Backup History ({backupHistory.length})</span>
                  </div>
                  <span className="text-[11px] text-[#A1A1AA]">
                    Secured via Super Admin–only Firestore &amp; Storage rules
                  </span>
                </div>
                {backupHistory.length === 0 ? (
                  <div className="p-6 text-[#A1A1AA]">
                    No backup snapshots recorded yet. Run a verified backup above to inspect history and test restore preview.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                          <th className="px-4 py-3 text-left font-medium">Timestamp</th>
                          <th className="px-4 py-3 text-left font-medium">Trigger</th>
                          <th className="px-4 py-3 text-left font-medium">Status</th>
                          <th className="px-4 py-3 text-right font-medium">Records</th>
                          <th className="px-4 py-3 text-right font-medium">Size</th>
                          <th className="px-4 py-3 text-left font-medium">SHA-256 Checksum</th>
                          <th className="px-4 py-3 text-right font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#292D36]/70">
                        {[...backupHistory]
                          .sort((a, b) =>
                            String(serializeFirestoreValue(b.createdAt) || '').localeCompare(
                              String(serializeFirestoreValue(a.createdAt) || '')
                            )
                          )
                          .map((rec) => {
                            const ts = serializeFirestoreValue(rec.createdAt);
                            return (
                              <tr key={rec.id}>
                                <td className="px-4 py-3 font-mono text-[#FFFFFF] tabular-nums whitespace-nowrap">
                                  {typeof ts === 'string' ? new Date(ts).toLocaleString() : rec.id}
                                </td>
                                <td className="px-4 py-3 capitalize text-[#A1A1AA]">
                                  {rec.trigger} · {rec.frequency}
                                </td>
                                <td className="px-4 py-3 capitalize">
                                  <span className={rec.status === 'success' ? 'text-emerald-400 font-medium' : 'text-rose-400 font-medium'}>
                                    {rec.status}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-right font-mono text-[#FFFFFF] tabular-nums">
                                  {rec.totalRecords}
                                  {rec.storageFileCount > 0 ? ` (+${rec.storageFileCount} files)` : ''}
                                </td>
                                <td className="px-4 py-3 text-right font-mono text-[#A1A1AA] tabular-nums">
                                  {(rec.sizeBytes / 1024).toFixed(1)} KB
                                </td>
                                <td className="px-4 py-3 font-mono text-[#A1A1AA]">
                                  {rec.checksumSha256 ? `${rec.checksumSha256.slice(0, 14)}…` : '—'}
                                </td>
                                <td className="px-4 py-3 text-right whitespace-nowrap">
                                  <div className="inline-flex items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => void handleDownloadBackupRecord(rec)}
                                      className="px-2.5 py-1 rounded-lg bg-[#1B1F28] border border-[#292D36] text-[#FFFFFF] hover:border-[#FF4634]"
                                    >
                                      <Download className="w-3 h-3 inline mr-1" />
                                      JSON
                                    </button>
                                    <button
                                      type="button"
                                      disabled={restoreBusy || rec.status !== 'success'}
                                      onClick={() => void handleInspectHistoryRecord(rec)}
                                      className="px-2.5 py-1 rounded-lg bg-[#1B1F28] border border-[#292D36] text-[#FF6A33] hover:border-[#FF4634] disabled:opacity-40"
                                    >
                                      <RotateCcw className="w-3 h-3 inline mr-1" />
                                      Preview Restore
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void handleDeleteBackupRecord(rec.id)}
                                      className="p-1 text-[#A1A1AA] hover:text-rose-400"
                                      aria-label={`Delete backup ${rec.id}`}
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Restore Integrity Check, Diff Preview & Super Admin Confirmation */}
              {restoreValidation && (
                <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-semibold text-[#FFFFFF]">
                      <ShieldCheck className={`w-4 h-4 ${restoreValidation.valid ? 'text-emerald-400' : 'text-rose-400'}`} />
                      <span>Restore Verification &amp; Impact Preview: {restoreSourceLabel}</span>
                    </div>
                    <span className="font-mono text-[11px] text-[#A1A1AA]">
                      {restoreValidation.schemaVersion} · Exported {restoreValidation.exportedAt}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="p-3 rounded-xl bg-[#0B0D12] border border-[#292D36]">
                      <div className="text-[11px] text-[#A1A1AA]">SHA-256 Integrity</div>
                      <div className={`font-semibold mt-0.5 ${restoreValidation.checksumVerified === true ? 'text-emerald-400' : restoreValidation.checksumVerified === 'unhashed-v1' ? 'text-amber-400' : 'text-rose-400'}`}>
                        {restoreValidation.checksumVerified === true
                          ? 'Checksum Verified'
                          : restoreValidation.checksumVerified === 'unhashed-v1'
                          ? 'Legacy v1 (Unhashed)'
                          : 'Checksum Mismatch'}
                      </div>
                    </div>
                    <div className="p-3 rounded-xl bg-[#0B0D12] border border-[#292D36]">
                      <div className="text-[11px] text-[#A1A1AA]">Backup Records</div>
                      <div className="font-mono font-semibold text-[#FFFFFF] tabular-nums mt-0.5">
                        {restorePreview?.totalBackupRecords ?? restoreValidation.totalRecords}
                      </div>
                    </div>
                    <div className="p-3 rounded-xl bg-[#0B0D12] border border-[#292D36]">
                      <div className="text-[11px] text-[#A1A1AA]">To Create / Update</div>
                      <div className="font-mono font-semibold text-[#FF6A33] tabular-nums mt-0.5">
                        +{restorePreview?.totalToCreate ?? 0} / ~{restorePreview?.totalToUpdate ?? 0}
                      </div>
                    </div>
                    <div className="p-3 rounded-xl bg-[#0B0D12] border border-[#292D36]">
                      <div className="text-[11px] text-[#A1A1AA]">Storage Manifest</div>
                      <div className="font-mono font-semibold text-[#FFFFFF] tabular-nums mt-0.5">
                        {restoreValidation.storageFileCount} files
                      </div>
                    </div>
                  </div>

                  {restoreValidation.errors.length > 0 && (
                    <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 space-y-1">
                      <div className="font-semibold">Validation Errors (Restore Blocked):</div>
                      <ul className="list-disc pl-5">
                        {restoreValidation.errors.map((err) => <li key={err}>{err}</li>)}
                      </ul>
                    </div>
                  )}

                  {restoreValidation.warnings.length > 0 && (
                    <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300">
                      {restoreValidation.warnings.join(' ')}
                    </div>
                  )}

                  {restorePreview && (
                    <div className="overflow-x-auto max-h-64 overflow-y-auto border border-[#292D36] rounded-xl">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                            <th className="px-3 py-2 text-left font-medium">Collection</th>
                            <th className="px-3 py-2 text-right font-medium">Live</th>
                            <th className="px-3 py-2 text-right font-medium">Backup</th>
                            <th className="px-3 py-2 text-right font-medium">Create</th>
                            <th className="px-3 py-2 text-right font-medium">Update</th>
                            <th className="px-3 py-2 text-right font-medium">Unchanged</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#292D36]/70">
                          {restorePreview.collections
                            .filter((c) => c.backupCount > 0 || c.currentCount > 0)
                            .map((c) => (
                              <tr key={c.collection}>
                                <td className="px-3 py-2 font-mono text-[#FFFFFF]">{c.collection}</td>
                                <td className="px-3 py-2 text-right font-mono text-[#A1A1AA] tabular-nums">{c.currentCount}</td>
                                <td className="px-3 py-2 text-right font-mono text-[#FFFFFF] tabular-nums">{c.backupCount}</td>
                                <td className="px-3 py-2 text-right font-mono text-emerald-400 tabular-nums">+{c.toCreate}</td>
                                <td className="px-3 py-2 text-right font-mono text-amber-400 tabular-nums">~{c.toUpdate}</td>
                                <td className="px-3 py-2 text-right font-mono text-[#A1A1AA] tabular-nums">{c.unchanged}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {restoreValidation.valid && (
                    <div className="p-4 rounded-xl bg-[#1B1F28] border border-[#292D36] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="space-y-1 flex-1">
                        <div className="font-semibold text-[#FFFFFF]">Super Admin Restore Authorization</div>
                        <div className="text-[#A1A1AA]">
                          Type <code className="font-mono text-[#FF6A33]">RESTORE</code> to apply these changes to Firestore. Always inspect the diff counts above before confirming.
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          value={restoreConfirmText}
                          onChange={(e) => setRestoreConfirmText(e.target.value)}
                          placeholder="Type RESTORE"
                          className="w-36 px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono uppercase"
                        />
                        <button
                          type="button"
                          disabled={restoreBusy || restoreConfirmText !== 'RESTORE'}
                          onClick={() => void handleApplyRestore()}
                          className="ace-btn-primary px-4 py-2 font-semibold rounded-xl disabled:opacity-40"
                        >
                          {restoreBusy ? 'Restoring…' : 'Confirm & Apply Restore'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {subTab === 'audit' && (
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden">
          {auditLogs.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#A1A1AA]">No audit log entries recorded yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                    <th className="px-4 py-3 text-left font-medium">Actor</th>
                    <th className="px-4 py-3 text-left font-medium">Role</th>
                    <th className="px-4 py-3 text-left font-medium">Action</th>
                    <th className="px-4 py-3 text-left font-medium">Summary</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#292D36]/70">
                  {auditLogs.map((log) => (
                    <tr key={log.id}>
                      <td className="px-4 py-3 text-[#FFFFFF]">{log.actorEmail}</td>
                      <td className="px-4 py-3 capitalize text-[#FF6A33] font-medium">{log.actorRole.replace('_', ' ')}</td>
                      <td className="px-4 py-3 font-mono text-[#A1A1AA]">{log.action}</td>
                      <td className="px-4 py-3 text-[#A1A1AA]">{log.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
