import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import {
  AlertTriangle,
  Ban,
  CalendarOff,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Edit3,
  ExternalLink,
  MessageSquare,
  Paperclip,
  Plus,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  X,
} from 'lucide-react';
import { db } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import { apiRequest, isIamBlockedError, uploadToStorage } from '../../services/hrmsApi';
import { exportToCsv, exportToXlsx } from '../../utils/exportUtils';
import {
  EXECUTIVE_PRIVATE_DEPT,
  canUserActOnLeaveRequest,
  computeCarryForwardReset,
  computeLeaveBalanceSummary,
  detectTeamLeaveClashes,
  filterVisibleLeaveRequests,
  isManagementRole,
  validateLeaveApplication,
} from '../../utils/workflowUtils';
import type { LeaveRequest, LeaveType } from '../../types/hrms';

type BalanceBucketField = 'paidTotal' | 'paidUsed' | 'casualTotal' | 'casualUsed' | 'sickTotal' | 'sickUsed' | 'emergencyTotal' | 'emergencyUsed' | 'unpaidUsed';

const DAY_PART_LABELS: Record<'full' | 'first_half' | 'second_half' | 'short', string> = {
  full: 'Full Day',
  first_half: 'Half Day (1st Half)',
  second_half: 'Half Day (2nd Half)',
  short: 'Short Permission',
};

const LEAVE_TYPE_STYLES: Record<LeaveType, string> = {
  paid: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  casual: 'text-sky-400 bg-sky-500/10 border-sky-500/30',
  sick: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  emergency: 'text-rose-400 bg-rose-500/10 border-rose-500/30',
  unpaid: 'text-zinc-300 bg-zinc-500/15 border-zinc-500/35',
  short: 'text-violet-400 bg-violet-500/10 border-violet-500/30',
};

export const LeaveModule: React.FC = () => {
  const { firebaseUser, employeeProfile, effectiveRole } = useAuth();
  const {
    leaveRequests,
    leaveBalances,
    employees,
    departments,
    roles,
    leavePolicy,
    holidays,
    workPolicy,
    approvalWorkflows,
  } = useHrmsData();

  const uid = firebaseUser?.uid || '';
  const isSuperAdmin = effectiveRole === 'super_admin';
  const isHR = isSuperAdmin || effectiveRole === 'hr_manager';
  const isManagerial = isManagementRole(effectiveRole);
  const deptId = employeeProfile?.departmentId || '';

  const [optionalHolidaySelections, setOptionalHolidaySelections] = useState<Array<{ holidayId: string; year: string }>>([]);
  useEffect(() => {
    if (!uid) return;
    const q = query(collection(db, 'optionalHolidaySelections'), where('uid', '==', uid));
    return onSnapshot(
      q,
      (snap) => setOptionalHolidaySelections(snap.docs.map((d) => d.data() as { holidayId: string; year: string })),
      () => {},
    );
  }, [uid]);

  const [subTab, setSubTab] = useState<'my' | 'team' | 'calendar'>('my');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [payCategoryFilter, setPayCategoryFilter] = useState<'all' | 'paid_quota' | 'unpaid'>('all');
  const [deptFilter, setDeptFilter] = useState('all');
  const [teamFilter, setTeamFilter] = useState('all');
  const [employeeSearch, setEmployeeSearch] = useState('');

  // Calendar state
  const [calendarMonth, setCalendarMonth] = useState(new Date().toISOString().slice(0, 7));
  const [calendarScope, setCalendarScope] = useState<'personal' | 'team' | 'company'>(
    isHR ? 'company' : isManagerial ? 'team' : 'personal',
  );
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(new Date().toISOString().slice(0, 10));

  // Apply / Edit & Resubmit modal state
  const [showApply, setShowApply] = useState(false);
  const [editingRequest, setEditingRequest] = useState<LeaveRequest | null>(null);
  const [leaveType, setLeaveType] = useState<LeaveType>('casual');
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [dayPart, setDayPart] = useState<'full' | 'first_half' | 'second_half' | 'short'>('full');
  const [shortLeaveHours, setShortLeaveHours] = useState(1);
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [existingAttachmentUrl, setExistingAttachmentUrl] = useState('');
  const [existingAttachmentName, setExistingAttachmentName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const [bannerSuccess, setBannerSuccess] = useState('');
  const [bannerError, setBannerError] = useState('');

  // Review / Reject / Request Changes modal state
  const [reviewModalReq, setReviewModalReq] = useState<LeaveRequest | null>(null);
  const [reviewModalDecision, setReviewModalDecision] = useState<'rejected' | 'changes_requested'>('rejected');
  const [reviewCommentInput, setReviewCommentInput] = useState('');
  const [reviewSubmitting, setReviewSubmitting] = useState(false);

  // Cancel approved modal state
  const [cancelApprovedReq, setCancelApprovedReq] = useState<LeaveRequest | null>(null);
  const [cancelApprovedReason, setCancelApprovedReason] = useState('');
  const [cancellingApproved, setCancellingApproved] = useState(false);

  // Super Admin Manual Balance Adjustment modal
  const [adjustModalUid, setAdjustModalUid] = useState('');
  const [adjustBucket, setAdjustBucket] = useState<BalanceBucketField>('paidTotal');
  const [adjustMode, setAdjustMode] = useState<'delta' | 'set'>('delta');
  const [adjustValue, setAdjustValue] = useState<number>(1);
  const [adjustReason, setAdjustReason] = useState('');
  const [adjustSubmitting, setAdjustSubmitting] = useState(false);

  // Annual Reset modal state
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetYear, setResetYear] = useState(new Date().getFullYear());
  const [carryEnabled, setCarryEnabled] = useState(leavePolicy.carryForwardEnabled ?? true);
  const [maxCarryPaid, setMaxCarryPaid] = useState(leavePolicy.maxCarryForwardPaid ?? 10);
  const [resetting, setResetting] = useState(false);

  const selectedOptionalIds = useMemo(
    () => optionalHolidaySelections.map((s) => s.holidayId),
    [optionalHolidaySelections],
  );

  // Visibility-enforced requests (belt-and-suspenders over Firestore rules)
  const visibleRequests = useMemo(
    () => filterVisibleLeaveRequests(leaveRequests, uid, effectiveRole, deptId),
    [leaveRequests, uid, effectiveRole, deptId],
  );

  const myRequests = useMemo(
    () => [...visibleRequests.filter((r) => r.uid === uid)].sort((a, b) => b.startDate.localeCompare(a.startDate)),
    [visibleRequests, uid],
  );

  const myBalance = leaveBalances.find((b) => b.uid === uid);
  const mySummary = useMemo(
    () => computeLeaveBalanceSummary(myBalance, myRequests, leavePolicy),
    [myBalance, myRequests, leavePolicy],
  );

  const ensureCalledRef = useRef(false);
  const [migratingBalances, setMigratingBalances] = useState(false);

  useEffect(() => {
    if (!uid || myBalance || ensureCalledRef.current) return;
    ensureCalledRef.current = true;
    void apiRequest('/api/leaves/ensure-balance', {
      method: 'POST',
      body: JSON.stringify({}),
    }).catch(() => {});
  }, [uid, myBalance]);

  const legacyBalanceCount = useMemo(
    () =>
      leaveBalances.filter(
        (b) =>
          !b.ownerRole ||
          !b.departmentId ||
          b.teamId === undefined ||
          b.teamLeadUid === undefined ||
          b.reportingManagerUid === undefined,
      ).length,
    [leaveBalances],
  );

  // Team / Scoped employees for Team Hub & Manual Balance Adjustment
  const scopedEmployees = useMemo(() => {
    return employees.filter((e) => {
      if (isSuperAdmin) return true;
      if (effectiveRole === 'hr_manager') {
        const roleRec = roles.find((r) => r.uid === e.uid);
        return roleRec?.role !== 'super_admin';
      }
      if (effectiveRole === 'team_lead') {
        return e.uid === uid || e.teamLeadUid === uid || e.reportingManagerUid === uid;
      }
      if (effectiveRole === 'dept_manager') {
        return e.uid === uid || e.reportingManagerUid === uid || (Boolean(deptId) && e.departmentId === deptId);
      }
      return e.uid === uid;
    });
  }, [employees, roles, isSuperAdmin, effectiveRole, uid, deptId]);

  const distinctTeams = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of scopedEmployees) {
      if (e.teamId && e.teamName) map.set(e.teamId, e.teamName);
      else if (e.teamName) map.set(e.teamName, e.teamName);
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [scopedEmployees]);

  // Apply modal real-time validation & breakdown
  const applyValidation = useMemo(
    () =>
      validateLeaveApplication({
        leaveType,
        dayPart,
        shortLeaveHours,
        startDate,
        endDate,
        balance: myBalance,
        policy: leavePolicy,
        weeklyOffs: workPolicy.weeklyOffs,
        holidays,
        countryCode: employeeProfile?.countryCode || 'IN',
        selectedOptionalHolidayIds: selectedOptionalIds,
      }),
    [
      leaveType,
      dayPart,
      shortLeaveHours,
      startDate,
      endDate,
      myBalance,
      leavePolicy,
      workPolicy.weeklyOffs,
      holidays,
      employeeProfile?.countryCode,
      selectedOptionalIds,
    ],
  );

  const applyClashInfo = useMemo(
    () =>
      isSuperAdmin
        ? { overlappingCount: 0, overlappingRequests: [] }
        : detectTeamLeaveClashes(
            startDate,
            endDate,
            deptId,
            uid,
            visibleRequests,
            employeeProfile?.teamId,
          ),
    [isSuperAdmin, startDate, endDate, deptId, uid, visibleRequests, employeeProfile?.teamId],
  );

  const todayStr = new Date().toISOString().slice(0, 10);

  // Scoped requests for Team / Company Hub (excludes employee's own requests for non-super-admin or keeps filtered clearly)
  const teamHubRequests = useMemo(() => {
    const search = employeeSearch.trim().toLowerCase();
    return [...visibleRequests]
      .filter((r) => {
        if (!isSuperAdmin && effectiveRole !== 'hr_manager' && r.uid === uid) {
          // Team Lead / Dept Manager see their own leaves under My Leaves (and cannot self-approve)
          return false;
        }
        if (statusFilter !== 'all' && r.status !== statusFilter) return false;
        if (typeFilter !== 'all' && r.leaveType !== typeFilter) return false;
        if (payCategoryFilter === 'unpaid' && r.leaveType !== 'unpaid') return false;
        if (payCategoryFilter === 'paid_quota' && r.leaveType === 'unpaid') return false;
        if (deptFilter !== 'all' && r.departmentId !== deptFilter) return false;
        if (teamFilter !== 'all' && (r.teamId || r.teamName) !== teamFilter) return false;
        if (search && !r.employeeName.toLowerCase().includes(search) && !r.employeeId.toLowerCase().includes(search)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const pendingScore = (s: LeaveRequest['status']) => (s === 'pending' ? 0 : s === 'changes_requested' ? 1 : 2);
        const diff = pendingScore(a.status) - pendingScore(b.status);
        return diff !== 0 ? diff : b.startDate.localeCompare(a.startDate);
      });
  }, [
    visibleRequests,
    isSuperAdmin,
    effectiveRole,
    uid,
    statusFilter,
    typeFilter,
    payCategoryFilter,
    deptFilter,
    teamFilter,
    employeeSearch,
  ]);

  const pendingActionableCount = useMemo(
    () =>
      visibleRequests.filter((r) => {
        const perms = canUserActOnLeaveRequest({
          request: r,
          actorUid: uid,
          actorRole: effectiveRole,
          actorDeptId: deptId,
          workflowSettings: approvalWorkflows,
          leavePolicy,
        });
        return perms.canApprove;
      }).length,
    [visibleRequests, uid, effectiveRole, deptId, approvalWorkflows, leavePolicy],
  );

  const teamMetrics = useMemo(() => {
    const teamPool = visibleRequests.filter((r) => (isHR ? true : r.uid !== uid));
    const todayAbsent = teamPool.filter(
      (r) => r.status === 'approved' && r.startDate <= todayStr && r.endDate >= todayStr,
    ).length;
    const upcomingScheduled = teamPool.filter(
      (r) => (r.status === 'approved' || r.status === 'pending') && r.startDate > todayStr,
    ).length;
    const unpaidDays = teamPool
      .filter((r) => r.status === 'approved' && r.leaveType === 'unpaid')
      .reduce((acc, r) => acc + Number(r.daysCount || 0), 0);
    const paidDays = teamPool
      .filter((r) => r.status === 'approved' && r.leaveType !== 'unpaid' && r.leaveType !== 'short')
      .reduce((acc, r) => acc + Number(r.daysCount || 0), 0);
    return { todayAbsent, upcomingScheduled, unpaidDays, paidDays };
  }, [visibleRequests, isHR, uid, todayStr]);

  const resetPreview = useMemo(() => {
    return leaveBalances.map((bal) => {
      const emp = employees.find((e) => e.uid === bal.uid || e.id === bal.employeeId);
      const nextBal = computeCarryForwardReset(bal, leavePolicy, resetYear, carryEnabled, maxCarryPaid);
      return {
        name: emp?.fullName || bal.uid,
        previousUnusedPaid: Math.max(0, (bal.paidTotal || 0) - (bal.paidUsed || 0)),
        carriedForward: nextBal.carriedForwardDays || 0,
        newPaidTotal: nextBal.paidTotal,
        nextBal,
      };
    });
  }, [leaveBalances, employees, leavePolicy, resetYear, carryEnabled, maxCarryPaid]);

  const flashSuccess = (msg: string) => {
    setBannerError('');
    setBannerSuccess(msg);
    setTimeout(() => setBannerSuccess(''), 5000);
  };

  const flashError = (msg: string) => {
    setBannerSuccess('');
    setBannerError(msg);
  };

  const openApplyModal = () => {
    setEditingRequest(null);
    setLeaveType('casual');
    const todayIso = new Date().toISOString().slice(0, 10);
    setStartDate(todayIso);
    setEndDate(todayIso);
    setDayPart('full');
    setShortLeaveHours(1);
    setReason('');
    setAttachmentFile(null);
    setExistingAttachmentUrl('');
    setExistingAttachmentName('');
    setErrMsg('');
    setShowApply(true);
  };

  const openEditModal = (req: LeaveRequest) => {
    setEditingRequest(req);
    setLeaveType(req.leaveType);
    setStartDate(req.startDate);
    setEndDate(req.endDate);
    setDayPart(req.dayPart || (req.leaveType === 'short' ? 'short' : 'full'));
    setShortLeaveHours(req.shortLeaveHours || 1);
    setReason(req.reason);
    setAttachmentFile(null);
    setExistingAttachmentUrl(req.attachmentUrl || '');
    setExistingAttachmentName(req.attachmentName || '');
    setErrMsg('');
    setShowApply(true);
  };

  const formatLeaveActionError = (err: unknown, fallback: string): string => {
    if (isIamBlockedError(err)) {
      return 'Server Admin SDK lacks Cloud Firestore IAM permission (roles/datastore.user on gen-lang-client-0209720424). Grant IAM permission to execute leave transactions.';
    }
    return err instanceof Error ? err.message : fallback;
  };

  const handleMigrateLegacyBalances = async () => {
    if (!isHR) return;
    setMigratingBalances(true);
    try {
      const res = await apiRequest<{ migratedCount: number; inspectedCount: number }>('/api/leaves/migrate-balances', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      flashSuccess(`Synchronized privacy & team scope metadata on ${res.migratedCount} of ${res.inspectedCount} leave balance record(s).`);
    } catch (err) {
      flashError(formatLeaveActionError(err, 'Unable to synchronize legacy balance metadata.'));
    } finally {
      setMigratingBalances(false);
    }
  };

  const handleSubmitLeave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;
    if (!applyValidation.valid) {
      setErrMsg(applyValidation.error || 'Please check leave dates and available balance.');
      return;
    }
    if (reason.trim().length < 3) {
      setErrMsg('Please enter a reason (at least 3 characters).');
      return;
    }

    setSubmitting(true);
    setErrMsg('');

    try {
      let attachmentUrl = existingAttachmentUrl;
      let attachmentName = existingAttachmentName;
      if (attachmentFile) {
        attachmentUrl = await uploadToStorage(`leave_attachments/${uid}`, attachmentFile);
        attachmentName = attachmentFile.name.slice(0, 200);
      }

      const payload = {
        leaveType,
        dayPart,
        ...(dayPart === 'short' ? { shortLeaveHours } : {}),
        startDate,
        endDate,
        reason: reason.trim(),
        ...(attachmentUrl ? { attachmentUrl, attachmentName } : {}),
      };

      if (editingRequest) {
        await apiRequest(`/api/leaves/${encodeURIComponent(editingRequest.id)}/resubmit`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setShowApply(false);
        setEditingRequest(null);
        flashSuccess('Leave request updated and resubmitted for approval.');
        return;
      }

      const res = await apiRequest<{ autoApproved: boolean }>('/api/leaves/apply', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      setShowApply(false);
      setReason('');
      setAttachmentFile(null);
      setDayPart('full');
      setShortLeaveHours(1);
      flashSuccess(
        res.autoApproved
          ? 'Super Admin leave auto-approved with audit trail and balance updated.'
          : 'Leave application submitted and approver notified.',
      );
    } catch (err) {
      setErrMsg(formatLeaveActionError(err, 'Unable to submit leave request.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleApproveLeave = async (req: LeaveRequest) => {
    if (!firebaseUser) return;
    const perms = canUserActOnLeaveRequest({
      request: req,
      actorUid: uid,
      actorRole: effectiveRole,
      actorDeptId: deptId,
      workflowSettings: approvalWorkflows,
      leavePolicy,
    });
    if (!perms.canApprove) {
      flashError(perms.reason || 'You do not have permission to approve this leave request.');
      return;
    }

    try {
      await apiRequest(`/api/leaves/${encodeURIComponent(req.id)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ comment: 'Approved' }),
      });
      flashSuccess(`Approved ${req.employeeName}'s ${req.leaveType} leave (${req.daysCount}d) and updated balance.`);
    } catch (err) {
      flashError(formatLeaveActionError(err, 'Approval transaction failed.'));
    }
  };

  const openReviewModal = (req: LeaveRequest, decision: 'rejected' | 'changes_requested') => {
    setReviewModalReq(req);
    setReviewModalDecision(decision);
    setReviewCommentInput('');
  };

  const handleSubmitReviewDecision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !reviewModalReq) return;
    if (reviewCommentInput.trim().length < 3) {
      flashError('Please provide a clear review comment (at least 3 characters).');
      return;
    }

    setReviewSubmitting(true);
    try {
      const endpoint =
        reviewModalDecision === 'rejected'
          ? `/api/leaves/${encodeURIComponent(reviewModalReq.id)}/reject`
          : `/api/leaves/${encodeURIComponent(reviewModalReq.id)}/request-changes`;
      await apiRequest(endpoint, {
        method: 'POST',
        body: JSON.stringify({ comment: reviewCommentInput.trim() }),
      });

      flashSuccess(
        reviewModalDecision === 'rejected'
          ? `Rejected ${reviewModalReq.employeeName}'s leave request.`
          : `Sent leave request back to ${reviewModalReq.employeeName} for changes.`,
      );
      setReviewModalReq(null);
      setReviewCommentInput('');
    } catch (err) {
      flashError(formatLeaveActionError(err, 'Unable to update leave status.'));
    } finally {
      setReviewSubmitting(false);
    }
  };

  const handleCancelPending = async (req: LeaveRequest) => {
    if (!firebaseUser) return;
    try {
      await apiRequest(`/api/leaves/${encodeURIComponent(req.id)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      flashSuccess('Leave request cancelled.');
    } catch (err) {
      flashError(formatLeaveActionError(err, 'Unable to cancel leave request.'));
    }
  };

  const handleConfirmCancelApproved = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !cancelApprovedReq) return;
    if (cancelApprovedReason.trim().length < 3) {
      flashError('Please specify a reason before cancelling an approved leave.');
      return;
    }

    setCancellingApproved(true);
    try {
      await apiRequest(`/api/leaves/${encodeURIComponent(cancelApprovedReq.id)}/cancel-approved`, {
        method: 'POST',
        body: JSON.stringify({ reason: cancelApprovedReason.trim() }),
      });
      flashSuccess(`Approved leave cancelled and ${cancelApprovedReq.daysCount} day(s) refunded.`);
      setCancelApprovedReq(null);
      setCancelApprovedReason('');
    } catch (err) {
      flashError(formatLeaveActionError(err, 'Unable to cancel approved leave.'));
    } finally {
      setCancellingApproved(false);
    }
  };

  const handleManualBalanceAdjust = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !isSuperAdmin || !adjustModalUid) return;
    if (adjustReason.trim().length < 5) {
      flashError('Please enter a detailed adjustment reason (min 5 characters).');
      return;
    }

    setAdjustSubmitting(true);
    try {
      const targetEmp = employees.find((emp) => emp.uid === adjustModalUid);
      const res = await apiRequest<{ previousValue: number; newValue: number }>('/api/leaves/adjust-balance', {
        method: 'POST',
        body: JSON.stringify({
          targetUid: adjustModalUid,
          bucket: adjustBucket,
          mode: adjustMode === 'set' ? 'set' : 'add',
          value: Number(adjustValue),
          reason: adjustReason.trim(),
        }),
      });

      flashSuccess(
        `Updated ${targetEmp?.fullName || adjustModalUid}'s ${adjustBucket} from ${res.previousValue} to ${res.newValue}.`,
      );
      setAdjustModalUid('');
      setAdjustReason('');
    } catch (err) {
      flashError(formatLeaveActionError(err, 'Manual balance adjustment failed.'));
    } finally {
      setAdjustSubmitting(false);
    }
  };

  const handleExecuteAnnualReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isHR || !firebaseUser) return;
    setResetting(true);
    try {
      const res = await apiRequest<{ resetCount: number }>('/api/leaves/annual-reset', {
        method: 'POST',
        body: JSON.stringify({
          targetYear: Number(resetYear),
          carryForwardEnabled: carryEnabled,
          maxCarryForwardPaid: Number(maxCarryPaid),
        }),
      });
      setShowResetModal(false);
      flashSuccess(`Annual reset for ${resetYear} completed across ${res.resetCount} balance records.`);
    } catch (err) {
      flashError(formatLeaveActionError(err, 'Unable to execute annual leave reset.'));
    } finally {
      setResetting(false);
    }
  };

  // Monthly visual calendar cells computation
  const calendarModel = useMemo(() => {
    const [yearStr, monthStr] = calendarMonth.split('-');
    const yearNum = Number(yearStr) || new Date().getFullYear();
    const monthNum = (Number(monthStr) || 1) - 1;
    const firstDay = new Date(Date.UTC(yearNum, monthNum, 1));
    const daysInMonth = new Date(Date.UTC(yearNum, monthNum + 1, 0)).getUTCDate();
    const startWeekday = firstDay.getUTCDay();

    const scopedList = visibleRequests.filter((r) => {
      if (r.status !== 'approved' && r.status !== 'pending' && r.status !== 'changes_requested') return false;
      if (calendarScope === 'personal') return r.uid === uid;
      if (calendarScope === 'team') {
        if (isSuperAdmin) return true;
        return r.uid === uid || r.teamLeadUid === uid || r.reportingManagerUid === uid || (Boolean(deptId) && r.departmentId === deptId);
      }
      return true;
    });

    const cells: Array<{ dateKey: string | null; dayNum: number | null; items: LeaveRequest[] }> = [];
    for (let i = 0; i < startWeekday; i += 1) {
      cells.push({ dateKey: null, dayNum: null, items: [] });
    }
    for (let d = 1; d <= daysInMonth; d += 1) {
      const dd = String(d).padStart(2, '0');
      const mm = String(monthNum + 1).padStart(2, '0');
      const dateKey = `${yearNum}-${mm}-${dd}`;
      const items = scopedList.filter((r) => r.startDate <= dateKey && r.endDate >= dateKey);
      cells.push({ dateKey, dayNum: d, items });
    }
    return { cells, scopedList, monthLabel: firstDay.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
  }, [calendarMonth, calendarScope, visibleRequests, uid, isSuperAdmin, deptId]);

  const shiftMonth = (delta: number) => {
    const [y, m] = calendarMonth.split('-').map(Number);
    const dt = new Date(Date.UTC(y || 2026, (m || 1) - 1 + delta, 1));
    setCalendarMonth(dt.toISOString().slice(0, 7));
  };

  const selectedDayItems = useMemo(() => {
    const cell = calendarModel.cells.find((c) => c.dateKey === selectedCalendarDate);
    return cell?.items || [];
  }, [calendarModel, selectedCalendarDate]);

  const canViewRequestReason = (req: LeaveRequest): boolean => {
    if (req.uid === uid || isHR) return true;
    const perms = canUserActOnLeaveRequest({
      request: req,
      actorUid: uid,
      actorRole: effectiveRole,
      actorDeptId: deptId,
      workflowSettings: approvalWorkflows,
      leavePolicy,
    });
    return perms.canApprove || req.teamLeadUid === uid || req.reportingManagerUid === uid;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#FFFFFF]">Leave Management</h1>
          <p className="text-sm text-[#A1A1AA] mt-1">
            Personal quotas, half-day &amp; short permissions, team-isolated approvals, and visual leave calendar
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() =>
              exportToCsv(
                'leave_requests',
                ['Employee', 'Team/Dept', 'Type', 'Duration', 'Start', 'End', 'Days', 'Status'],
                visibleRequests.map((l) => [
                  l.employeeName,
                  l.teamName || l.departmentId,
                  l.leaveType,
                  l.dayPart || 'full',
                  l.startDate,
                  l.endDate,
                  l.daysCount,
                  l.status,
                ]),
              )
            }
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#151922] border border-[#292D36] text-[#A1A1AA] hover:text-[#FFFFFF] hover:border-[#FF4634]/50 text-xs rounded-xl transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            CSV
          </button>
          <button
            type="button"
            onClick={() =>
              void exportToXlsx(
                'leave_requests',
                ['Employee', 'Team/Dept', 'Type', 'Duration', 'Start', 'End', 'Days', 'Status'],
                visibleRequests.map((l) => [
                  l.employeeName,
                  l.teamName || l.departmentId,
                  l.leaveType,
                  l.dayPart || 'full',
                  l.startDate,
                  l.endDate,
                  l.daysCount,
                  l.status,
                ]),
                'Leave Requests',
              )
            }
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#151922] border border-[#292D36] text-[#A1A1AA] hover:text-[#FFFFFF] hover:border-[#FF4634]/50 text-xs rounded-xl transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            XLSX
          </button>
          {isHR && legacyBalanceCount > 0 && (
            <button
              type="button"
              disabled={migratingBalances}
              onClick={() => void handleMigrateLegacyBalances()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#151922] border border-amber-500/40 text-amber-300 hover:border-amber-400 text-xs font-medium rounded-xl transition-colors disabled:opacity-50"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              {migratingBalances ? 'Syncing...' : `Sync Privacy Scope (${legacyBalanceCount})`}
            </button>
          )}
          {isHR && (
            <button
              type="button"
              onClick={() => setShowResetModal(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#151922] border border-[#292D36] text-[#FF6A33] hover:border-[#FF4634]/50 text-xs font-medium rounded-xl transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Annual Reset
            </button>
          )}
          <button
            type="button"
            onClick={openApplyModal}
            className="ace-btn-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            Apply for Leave
          </button>
        </div>
      </div>

      {/* Role Isolation & Privacy Info Strip */}
      <div className="p-3.5 rounded-2xl bg-[#151922] border border-[#292D36] flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2 text-[#D4D4D8]">
          <ShieldCheck className="w-4 h-4 text-[#FF6A33] shrink-0" />
          <span>
            {isSuperAdmin
              ? `Super Admin Governance: Personal leaves are strictly private (${leavePolicy.superAdminSelfApprovalMode === 'designated_approver' ? 'routed to designated approver' : 'auto-approved with audit log'}) and hidden from HR, Managers, Team Leads, and Employees.`
              : effectiveRole === 'team_lead'
              ? 'Team-Wise Scope Active: You only see your personal leaves and employees directly assigned to your team.'
              : effectiveRole === 'hr_manager'
              ? 'HR Leave View: Showing workforce leaves and balances (executive private leaves remain isolated).'
              : 'Private Leave Workspace: Your leave applications, balances, and review notes are private to you and your approver.'}
          </span>
        </div>
        <span className="text-[11px] font-mono text-[#A1A1AA] tabular-nums">
          Pending leaves are NOT deducted until approved
        </span>
      </div>

      {bannerSuccess && (
        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs">
          {bannerSuccess}
        </div>
      )}
      {bannerError && (
        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
          {bannerError}
        </div>
      )}

      {/* Personal Leave Summary Row */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3.5">
        <div className="p-4 bg-[#151922] border border-[#292D36] rounded-2xl">
          <div className="text-[11px] text-[#A1A1AA]">Annual Paid Allocation</div>
          <div className="font-mono text-xl font-bold text-[#FFFFFF] tabular-nums mt-1">
            {mySummary.paidTotal}d
          </div>
          <div className="text-[11px] text-[#A1A1AA] mt-1 font-mono">
            {mySummary.carriedForwardDays > 0 ? `Includes +${mySummary.carriedForwardDays}d carry` : 'Base annual paid'}
          </div>
        </div>

        <div className="p-4 bg-[#151922] border border-emerald-500/30 rounded-2xl">
          <div className="text-[11px] text-emerald-300">Available Paid Remaining</div>
          <div className="font-mono text-xl font-bold text-emerald-400 tabular-nums mt-1">
            {mySummary.paidRemaining}d
          </div>
          <div className="text-[11px] text-[#A1A1AA] mt-1 font-mono">
            {mySummary.paidUsed}d used · {mySummary.paidPending}d pending
          </div>
        </div>

        <div className="p-4 bg-[#151922] border border-[#292D36] rounded-2xl">
          <div className="text-[11px] text-[#A1A1AA]">Casual Leave</div>
          <div className="font-mono text-xl font-bold text-[#FFFFFF] tabular-nums mt-1">
            {mySummary.casualRemaining}d
            <span className="text-xs font-normal text-[#A1A1AA]"> / {mySummary.casualTotal}d</span>
          </div>
          <div className="text-[11px] text-[#A1A1AA] mt-1 font-mono">
            {mySummary.casualUsed}d used · {mySummary.casualPending}d pending
          </div>
        </div>

        <div className="p-4 bg-[#151922] border border-[#292D36] rounded-2xl">
          <div className="text-[11px] text-[#A1A1AA]">Sick Leave</div>
          <div className="font-mono text-xl font-bold text-[#FFFFFF] tabular-nums mt-1">
            {mySummary.sickRemaining}d
            <span className="text-xs font-normal text-[#A1A1AA]"> / {mySummary.sickTotal}d</span>
          </div>
          <div className="text-[11px] text-[#A1A1AA] mt-1 font-mono">
            {mySummary.sickUsed}d used · {mySummary.sickPending}d pending
          </div>
        </div>

        <div className="p-4 bg-[#151922] border border-[#292D36] rounded-2xl">
          <div className="text-[11px] text-[#A1A1AA]">Emergency Leave</div>
          <div className="font-mono text-xl font-bold text-[#FFFFFF] tabular-nums mt-1">
            {mySummary.emergencyRemaining}d
            <span className="text-xs font-normal text-[#A1A1AA]"> / {mySummary.emergencyTotal}d</span>
          </div>
          <div className="text-[11px] text-[#A1A1AA] mt-1 font-mono">
            {mySummary.emergencyUsed}d used · {mySummary.emergencyPending}d pending
          </div>
        </div>

        <div className="p-4 bg-[#151922] border border-[#292D36] rounded-2xl">
          <div className="text-[11px] text-[#A1A1AA]">Unpaid (LWP) &amp; Half-Day</div>
          <div className="font-mono text-xl font-bold text-[#FF6A33] tabular-nums mt-1">
            {mySummary.unpaidUsed}d
            <span className="text-xs font-normal text-[#A1A1AA]"> LWP</span>
          </div>
          <div className="text-[11px] text-[#A1A1AA] mt-1 font-mono">
            {mySummary.halfDayCount} half-day · {mySummary.pendingCount} pending
          </div>
        </div>
      </div>

      {/* View Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1.5 bg-[#151922] border border-[#292D36] rounded-2xl">
          <button
            type="button"
            onClick={() => setSubTab('my')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-xl transition-all ${
              subTab === 'my'
                ? 'bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-white'
                : 'text-[#A1A1AA] hover:text-[#FFFFFF]'
            }`}
          >
            My Leave History ({myRequests.length})
          </button>
          {isManagerial && (
            <button
              type="button"
              onClick={() => setSubTab('team')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-xl transition-all inline-flex items-center gap-1.5 ${
                subTab === 'team'
                  ? 'bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-white'
                  : 'text-[#A1A1AA] hover:text-[#FFFFFF]'
              }`}
            >
              <Users className="w-3.5 h-3.5" />
              <span>{isSuperAdmin ? 'Company Leave Governance' : effectiveRole === 'team_lead' ? 'My Team Leave Hub' : 'Leave Approvals & Balances'}</span>
              {pendingActionableCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-md bg-black/30 text-[10px] font-mono tabular-nums">
                  {pendingActionableCount}
                </span>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => setSubTab('calendar')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-xl transition-all ${
              subTab === 'calendar'
                ? 'bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-white'
                : 'text-[#A1A1AA] hover:text-[#FFFFFF]'
            }`}
          >
            Monthly Leave Calendar
          </button>
        </div>
      </div>

      {/* TAB 1: MY PERSONAL LEAVE HISTORY */}
      {subTab === 'my' && (
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[#292D36] flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-[#FFFFFF]">My Private Leave Applications</h2>
            <span className="text-[11px] text-[#A1A1AA] font-mono">
              Total Quota Used: {mySummary.annualQuotaUsed}d / {mySummary.annualQuotaTotal}d
            </span>
          </div>
          {myRequests.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#A1A1AA]">
              You have not submitted any leave applications yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                    <th className="px-4 py-3 text-left font-medium">Type &amp; Duration</th>
                    <th className="px-4 py-3 text-left font-medium">Dates</th>
                    <th className="px-4 py-3 text-right font-medium">Days</th>
                    <th className="px-4 py-3 text-left font-medium">Reason &amp; Attachment</th>
                    <th className="px-4 py-3 text-left font-medium">Status &amp; Review Note</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#292D36]/70">
                  {myRequests.map((l) => {
                    const perms = canUserActOnLeaveRequest({
                      request: l,
                      actorUid: uid,
                      actorRole: effectiveRole,
                      actorDeptId: deptId,
                      workflowSettings: approvalWorkflows,
                      leavePolicy,
                    });
                    return (
                      <tr key={l.id} className="hover:bg-[#1B1F28]/60">
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded-md border text-[11px] font-medium capitalize ${LEAVE_TYPE_STYLES[l.leaveType]}`}>
                            {l.leaveType}
                          </span>
                          <div className="text-[11px] text-[#A1A1AA] mt-1">
                            {DAY_PART_LABELS[l.dayPart || (l.leaveType === 'short' ? 'short' : 'full')]}
                            {l.dayPart === 'short' && l.shortLeaveHours ? ` (${l.shortLeaveHours}h)` : ''}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-[#D4D4D8] tabular-nums whitespace-nowrap">
                          {l.startDate} → {l.endDate}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-[#FFFFFF] font-semibold tabular-nums">
                          {l.daysCount}d
                        </td>
                        <td className="px-4 py-3 text-[#A1A1AA] max-w-xs">
                          <div className="line-clamp-2">{l.reason}</div>
                          {l.attachmentUrl && (
                            <a
                              href={l.attachmentUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-[11px] text-[#FF6A33] hover:underline mt-1"
                            >
                              <Paperclip className="w-3 h-3" />
                              {l.attachmentName || 'Supporting Document'}
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`capitalize font-semibold ${
                              l.status === 'approved'
                                ? 'text-emerald-400'
                                : l.status === 'rejected' || l.status === 'cancelled'
                                ? 'text-rose-400'
                                : l.status === 'changes_requested'
                                ? 'text-[#FF6A33]'
                                : 'text-amber-400'
                            }`}
                          >
                            {l.status.replace('_', ' ')}
                          </span>
                          {l.reviewComment && (
                            <div className="text-[11px] text-[#A1A1AA] mt-0.5">
                              {l.reviewerName ? `${l.reviewerName}: ` : ''}
                              {l.reviewComment}
                            </div>
                          )}
                          {perms.selfApprovalBlocked && (l.status === 'pending' || l.status === 'changes_requested') && (
                            <div className="text-[10px] text-amber-300 mt-0.5">
                              Awaiting higher approver (self-approval disabled)
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            {perms.canResubmit && (
                              <button
                                type="button"
                                onClick={() => openEditModal(l)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#FF4634]/15 border border-[#FF4634]/35 text-[#FF9A65] hover:bg-[#FF4634]/25"
                                title="Edit & Resubmit"
                              >
                                <Edit3 className="w-3 h-3" />
                                Edit &amp; Resubmit
                              </button>
                            )}
                            {perms.canCancel && (
                              <button
                                type="button"
                                onClick={() => void handleCancelPending(l)}
                                className="p-1.5 rounded-lg bg-[#1B1F28] text-[#A1A1AA] hover:text-rose-400"
                                title="Cancel Leave Request"
                              >
                                <Ban className="w-3.5 h-3.5" />
                              </button>
                            )}
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
      )}

      {/* TAB 2: TEAM LEADER / HR / SUPER ADMIN APPROVAL & BALANCES HUB */}
      {subTab === 'team' && isManagerial && (
        <div className="space-y-5">
          {/* Team Summary KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3.5">
            <div className="p-4 bg-[#151922] border border-[#292D36] rounded-2xl">
              <div className="text-[11px] text-[#A1A1AA]">Scoped Employees</div>
              <div className="font-mono text-xl font-bold text-[#FFFFFF] tabular-nums mt-1">
                {scopedEmployees.length}
              </div>
              <div className="text-[11px] text-[#A1A1AA] mt-0.5">
                {effectiveRole === 'team_lead' ? 'Assigned to your team' : 'In your governance scope'}
              </div>
            </div>
            <div className="p-4 bg-[#151922] border border-[#292D36] rounded-2xl">
              <div className="text-[11px] text-[#A1A1AA]">Pending Your Action</div>
              <div className="font-mono text-xl font-bold text-amber-400 tabular-nums mt-1">
                {pendingActionableCount}
              </div>
              <div className="text-[11px] text-[#A1A1AA] mt-0.5">Requests awaiting review</div>
            </div>
            <div className="p-4 bg-[#151922] border border-[#292D36] rounded-2xl">
              <div className="text-[11px] text-[#A1A1AA]">Absent / On Leave Today</div>
              <div className="font-mono text-xl font-bold text-rose-400 tabular-nums mt-1">
                {teamMetrics.todayAbsent}
              </div>
              <div className="text-[11px] text-[#A1A1AA] mt-0.5 font-mono">{todayStr}</div>
            </div>
            <div className="p-4 bg-[#151922] border border-[#292D36] rounded-2xl">
              <div className="text-[11px] text-[#A1A1AA]">Upcoming Team Leaves</div>
              <div className="font-mono text-xl font-bold text-[#FFFFFF] tabular-nums mt-1">
                {teamMetrics.upcomingScheduled}
              </div>
              <div className="text-[11px] text-[#A1A1AA] mt-0.5">Approved or pending</div>
            </div>
            <div className="p-4 bg-[#151922] border border-[#292D36] rounded-2xl">
              <div className="text-[11px] text-[#A1A1AA]">Paid vs Unpaid Split</div>
              <div className="font-mono text-xl font-bold text-[#FFFFFF] tabular-nums mt-1">
                {teamMetrics.paidDays}d <span className="text-xs text-[#A1A1AA] font-normal">/ {teamMetrics.unpaidDays}d LWP</span>
              </div>
              <div className="text-[11px] text-[#A1A1AA] mt-0.5">Approved days</div>
            </div>
          </div>

          {/* Filters Bar */}
          <div className="p-4 bg-[#151922] border border-[#292D36] rounded-2xl grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2.5 text-xs">
            <input
              type="text"
              placeholder="Search employee or code..."
              value={employeeSearch}
              onChange={(e) => setEmployeeSearch(e.target.value)}
              className="px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]"
            >
              <option value="all">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="changes_requested">Changes Requested</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <select
              value={payCategoryFilter}
              onChange={(e) => setPayCategoryFilter(e.target.value as 'all' | 'paid_quota' | 'unpaid')}
              className="px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]"
            >
              <option value="all">Paid &amp; Unpaid</option>
              <option value="paid_quota">Paid Quota Only</option>
              <option value="unpaid">Unpaid (LWP) Only</option>
            </select>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]"
            >
              <option value="all">All Leave Types</option>
              <option value="paid">Paid Leave</option>
              <option value="casual">Casual Leave</option>
              <option value="sick">Sick Leave</option>
              <option value="emergency">Emergency Leave</option>
              <option value="unpaid">Unpaid Leave</option>
              <option value="short">Short Permission</option>
            </select>
            {isHR && (
              <select
                value={deptFilter}
                onChange={(e) => setDeptFilter(e.target.value)}
                className="px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]"
              >
                <option value="all">All Departments</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
            <select
              value={teamFilter}
              onChange={(e) => setTeamFilter(e.target.value)}
              className="px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]"
            >
              <option value="all">All Teams</option>
              {distinctTeams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          {/* Approval Queue & History Table */}
          <div className="bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#292D36] flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-[#FFFFFF]">
                {effectiveRole === 'team_lead' ? 'Assigned Team Leave Requests' : 'Leave Approval Queue & Records'}
              </h2>
              <span className="text-[11px] text-[#A1A1AA] font-mono">{teamHubRequests.length} records</span>
            </div>
            {teamHubRequests.length === 0 ? (
              <div className="p-8 text-center text-sm text-[#A1A1AA]">
                No leave requests match the current filters in your scope.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                      <th className="px-4 py-3 text-left font-medium">Employee &amp; Team</th>
                      <th className="px-4 py-3 text-left font-medium">Type</th>
                      <th className="px-4 py-3 text-left font-medium">Dates</th>
                      <th className="px-4 py-3 text-right font-medium">Days</th>
                      <th className="px-4 py-3 text-left font-medium">Reason</th>
                      <th className="px-4 py-3 text-left font-medium">Status</th>
                      <th className="px-4 py-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#292D36]/70">
                    {teamHubRequests.map((l) => {
                      const perms = canUserActOnLeaveRequest({
                        request: l,
                        actorUid: uid,
                        actorRole: effectiveRole,
                        actorDeptId: deptId,
                        workflowSettings: approvalWorkflows,
                        leavePolicy,
                      });
                      const clash =
                        l.status === 'pending' || l.status === 'changes_requested'
                          ? detectTeamLeaveClashes(l.startDate, l.endDate, l.departmentId, l.uid, visibleRequests, l.teamId)
                          : { overlappingCount: 0, overlappingRequests: [] };
                      return (
                        <tr key={l.id} className="hover:bg-[#1B1F28]/60">
                          <td className="px-4 py-3">
                            <div className="font-medium text-[#FFFFFF]">{l.employeeName}</div>
                            <div className="text-[11px] text-[#A1A1AA]">
                              {l.teamName || (l.departmentId === EXECUTIVE_PRIVATE_DEPT ? 'Private Executive' : l.departmentId)}
                            </div>
                            {clash.overlappingCount > 0 && (
                              <div className="inline-flex items-center gap-1 text-[10px] text-amber-400 mt-0.5">
                                <AlertTriangle className="w-3 h-3" />
                                {clash.overlappingCount} overlap{clash.overlappingCount === 1 ? '' : 's'}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-block px-2 py-0.5 rounded-md border text-[11px] font-medium capitalize ${LEAVE_TYPE_STYLES[l.leaveType]}`}>
                              {l.leaveType}
                            </span>
                            <div className="text-[10px] text-[#A1A1AA] mt-0.5">
                              {DAY_PART_LABELS[l.dayPart || 'full']}
                            </div>
                          </td>
                          <td className="px-4 py-3 font-mono text-[#D4D4D8] tabular-nums whitespace-nowrap">
                            {l.startDate} → {l.endDate}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-[#FFFFFF] tabular-nums font-semibold">
                            {l.daysCount}d
                          </td>
                          <td className="px-4 py-3 text-[#A1A1AA] max-w-xs">
                            <div className="line-clamp-2">{canViewRequestReason(l) ? l.reason : 'Private'}</div>
                            {l.attachmentUrl && (
                              <a
                                href={l.attachmentUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] text-[#FF6A33] hover:underline mt-0.5"
                              >
                                <Paperclip className="w-3 h-3" />
                                Attachment
                              </a>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`capitalize font-semibold ${
                                l.status === 'approved'
                                  ? 'text-emerald-400'
                                  : l.status === 'rejected' || l.status === 'cancelled'
                                  ? 'text-rose-400'
                                  : l.status === 'changes_requested'
                                  ? 'text-[#FF6A33]'
                                  : 'text-amber-400'
                              }`}
                            >
                              {l.status.replace('_', ' ')}
                            </span>
                            {l.reviewComment && (
                              <div className="text-[10px] text-[#A1A1AA] mt-0.5 max-w-[180px] truncate" title={l.reviewComment}>
                                {l.reviewComment}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              {perms.canApprove && (
                                <button
                                  type="button"
                                  onClick={() => void handleApproveLeave(l)}
                                  className="p-1.5 rounded-lg bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30"
                                  title="Approve (Atomic Balance Update)"
                                >
                                  <Check className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {perms.canRequestChanges && (
                                <button
                                  type="button"
                                  onClick={() => openReviewModal(l, 'changes_requested')}
                                  className="p-1.5 rounded-lg bg-amber-600/20 text-amber-300 hover:bg-amber-600/30"
                                  title="Request Changes"
                                >
                                  <MessageSquare className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {perms.canReject && (
                                <button
                                  type="button"
                                  onClick={() => openReviewModal(l, 'rejected')}
                                  className="p-1.5 rounded-lg bg-rose-600/20 text-rose-400 hover:bg-rose-600/30"
                                  title="Reject Leave"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {perms.canCancelApproved && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setCancelApprovedReq(l);
                                    setCancelApprovedReason('');
                                  }}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-rose-500/30 text-rose-300 hover:bg-rose-500/15 text-[11px]"
                                  title="Cancel Approved Leave & Refund Quota"
                                >
                                  <Ban className="w-3 h-3" />
                                  Refund
                                </button>
                              )}
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

          {/* Scoped Team Leave Balances Table */}
          <div className="bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#292D36] flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-[#FFFFFF]">
                {effectiveRole === 'team_lead' ? 'Team Members Leave Balances' : 'Employee Leave Balances'}
              </h2>
              {isSuperAdmin && (
                <span className="text-[11px] text-[#FF6A33]">Super Admin Manual Balance Controls Enabled</span>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                    <th className="px-4 py-3 text-left font-medium">Employee</th>
                    <th className="px-4 py-3 text-left font-medium">Team</th>
                    <th className="px-4 py-3 text-right font-medium">Paid Rem</th>
                    <th className="px-4 py-3 text-right font-medium">Casual Rem</th>
                    <th className="px-4 py-3 text-right font-medium">Sick Rem</th>
                    <th className="px-4 py-3 text-right font-medium">Emergency Rem</th>
                    <th className="px-4 py-3 text-right font-medium">Unpaid Used</th>
                    <th className="px-4 py-3 text-right font-medium">Pending</th>
                    {isSuperAdmin && <th className="px-4 py-3 text-right font-medium">Admin</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#292D36]/70">
                  {scopedEmployees.map((emp) => {
                    const empUid = emp.uid || emp.id;
                    const bal = leaveBalances.find((b) => b.uid === empUid);
                    const empReqs = visibleRequests.filter((r) => r.uid === empUid);
                    const sum = computeLeaveBalanceSummary(bal, empReqs, leavePolicy);
                    const pendingTotal =
                      sum.paidPending + sum.casualPending + sum.sickPending + sum.emergencyPending + sum.unpaidPending;
                    return (
                      <tr key={emp.id} className="hover:bg-[#1B1F28]/60">
                        <td className="px-4 py-2.5 text-[#FFFFFF] font-medium">
                          {emp.fullName}
                          <span className="ml-1.5 text-[10px] font-mono text-[#A1A1AA]">{emp.employeeCode}</span>
                        </td>
                        <td className="px-4 py-2.5 text-[#A1A1AA]">{emp.teamName || emp.departmentName}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-emerald-400 tabular-nums">
                          {sum.paidRemaining}/{sum.paidTotal}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-[#FFFFFF] tabular-nums">
                          {sum.casualRemaining}/{sum.casualTotal}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-[#FFFFFF] tabular-nums">
                          {sum.sickRemaining}/{sum.sickTotal}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-[#FFFFFF] tabular-nums">
                          {sum.emergencyRemaining}/{sum.emergencyTotal}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-[#FF6A33] tabular-nums">{sum.unpaidUsed}d</td>
                        <td className="px-4 py-2.5 text-right font-mono text-amber-400 tabular-nums">{pendingTotal}d</td>
                        {isSuperAdmin && (
                          <td className="px-4 py-2.5 text-right">
                            {emp.uid ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setAdjustModalUid(emp.uid || '');
                                  setAdjustBucket('paidTotal');
                                  setAdjustMode('delta');
                                  setAdjustValue(1);
                                  setAdjustReason('');
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#1B1F28] border border-[#292D36] hover:border-[#FF4634]/50 text-[#D4D4D8] hover:text-[#FFFFFF]"
                              >
                                <SlidersHorizontal className="w-3 h-3 text-[#FF6A33]" />
                                Adjust
                              </button>
                            ) : (
                              <span className="text-[10px] text-[#A1A1AA]">Unlinked UID</span>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: VISUAL MONTHLY LEAVE CALENDAR */}
      {subTab === 'calendar' && (
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <CalendarOff className="w-4 h-4 text-[#FF6A33]" />
              <h2 className="font-display text-base font-semibold text-[#FFFFFF]">
                {calendarModel.monthLabel} — Leave Schedule
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <div className="flex items-center gap-1 bg-[#0B0D12] border border-[#292D36] rounded-xl p-1">
                <button
                  type="button"
                  onClick={() => setCalendarScope('personal')}
                  className={`px-2.5 py-1 rounded-lg ${calendarScope === 'personal' ? 'bg-[#FF4634] text-white' : 'text-[#A1A1AA]'}`}
                >
                  Personal
                </button>
                {isManagerial && (
                  <button
                    type="button"
                    onClick={() => setCalendarScope('team')}
                    className={`px-2.5 py-1 rounded-lg ${calendarScope === 'team' ? 'bg-[#FF4634] text-white' : 'text-[#A1A1AA]'}`}
                  >
                    {effectiveRole === 'team_lead' ? 'My Team' : 'Team / Dept'}
                  </button>
                )}
                {isHR && (
                  <button
                    type="button"
                    onClick={() => setCalendarScope('company')}
                    className={`px-2.5 py-1 rounded-lg ${calendarScope === 'company' ? 'bg-[#FF4634] text-white' : 'text-[#A1A1AA]'}`}
                  >
                    Global Company
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => shiftMonth(-1)}
                className="p-1.5 rounded-lg bg-[#0B0D12] border border-[#292D36] text-[#A1A1AA] hover:text-[#FFFFFF]"
                title="Previous Month"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <input
                type="month"
                value={calendarMonth}
                onChange={(e) => setCalendarMonth(e.target.value)}
                className="px-2.5 py-1.5 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono"
              />
              <button
                type="button"
                onClick={() => shiftMonth(1)}
                className="p-1.5 rounded-lg bg-[#0B0D12] border border-[#292D36] text-[#A1A1AA] hover:text-[#FFFFFF]"
                title="Next Month"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Color Legend */}
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            {(['paid', 'casual', 'sick', 'emergency', 'unpaid', 'short'] as LeaveType[]).map((tp) => (
              <span key={tp} className={`px-2 py-0.5 rounded-md border capitalize ${LEAVE_TYPE_STYLES[tp]}`}>
                {tp === 'unpaid' ? 'Unpaid (LWP)' : tp === 'short' ? 'Short Permission' : tp}
              </span>
            ))}
            <span className="px-2 py-0.5 rounded-md border border-dashed border-amber-400/50 text-amber-300">
              Dashed = Pending
            </span>
          </div>

          {/* 7-column Grid */}
          <div className="grid grid-cols-7 gap-1.5 text-xs">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
              <div key={d} className="text-center py-1.5 text-[11px] font-semibold text-[#A1A1AA]">
                {d}
              </div>
            ))}
            {calendarModel.cells.map((cell, idx) => {
              if (!cell.dateKey) {
                return <div key={`empty_${idx}`} className="min-h-[82px] rounded-xl bg-[#0B0D12]/40 border border-[#292D36]/40" />;
              }
              const isSelected = cell.dateKey === selectedCalendarDate;
              const isToday = cell.dateKey === todayStr;
              return (
                <button
                  key={cell.dateKey}
                  type="button"
                  onClick={() => setSelectedCalendarDate(cell.dateKey!)}
                  className={`min-h-[86px] p-1.5 rounded-xl border text-left flex flex-col gap-1 transition-colors ${
                    isSelected
                      ? 'bg-[#1B1F28] border-[#FF4634]'
                      : isToday
                      ? 'bg-[#1B1F28]/70 border-[#FF6A33]/40'
                      : 'bg-[#0B0D12] border-[#292D36] hover:border-[#343A46]'
                  }`}
                >
                  <div className="flex items-center justify-between w-full">
                    <span className={`font-mono text-[11px] font-semibold ${isToday ? 'text-[#FF6A33]' : 'text-[#D4D4D8]'}`}>
                      {cell.dayNum}
                    </span>
                    {cell.items.length > 0 && (
                      <span className="text-[10px] font-mono text-[#A1A1AA]">{cell.items.length}</span>
                    )}
                  </div>
                  <div className="space-y-0.5 w-full overflow-hidden">
                    {cell.items.slice(0, 2).map((item) => (
                      <div
                        key={item.id}
                        className={`px-1 py-0.5 rounded text-[10px] truncate border ${
                          item.status !== 'approved' ? 'border-dashed opacity-85 ' : ''
                        }${LEAVE_TYPE_STYLES[item.leaveType]}`}
                        title={`${item.employeeName} · ${item.leaveType} (${item.status})`}
                      >
                        {item.employeeName.split(' ')[0]} · {item.dayPart === 'first_half' || item.dayPart === 'second_half' ? '½' : item.leaveType}
                      </div>
                    ))}
                    {cell.items.length > 2 && (
                      <div className="text-[10px] text-[#A1A1AA] font-mono">+{cell.items.length - 2} more</div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Selected Day Details (Never exposes private reason to unauthorized peers) */}
          <div className="p-4 rounded-xl bg-[#1B1F28] border border-[#292D36] space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[#FFFFFF] font-mono">{selectedCalendarDate}</span>
              <span className="text-[#A1A1AA]">{selectedDayItems.length} scheduled leave(s)</span>
            </div>
            {selectedDayItems.length === 0 ? (
              <p className="text-[#A1A1AA]">No approved or pending leaves on this date.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {selectedDayItems.map((item) => (
                  <div key={item.id} className="p-3 rounded-xl bg-[#0B0D12] border border-[#292D36]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-[#FFFFFF]">{item.employeeName}</span>
                      <span className={item.status === 'approved' ? 'text-emerald-400 capitalize' : 'text-amber-400 capitalize'}>
                        {item.status.replace('_', ' ')}
                      </span>
                    </div>
                    <div className="text-[11px] text-[#FF6A33] capitalize mt-0.5">
                      {item.leaveType} · {DAY_PART_LABELS[item.dayPart || 'full']} ({item.daysCount}d)
                    </div>
                    {canViewRequestReason(item) && (
                      <div className="text-[11px] text-[#A1A1AA] mt-1 line-clamp-2">{item.reason}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL: APPLY / EDIT & RESUBMIT LEAVE */}
      {showApply && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setShowApply(false)} />
          <form
            onSubmit={handleSubmitLeave}
            className="relative z-10 w-full max-w-lg bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs max-h-[92vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#FFFFFF]">
                {editingRequest ? 'Edit & Resubmit Leave Request' : 'Apply for Leave'}
              </h3>
              <button type="button" onClick={() => setShowApply(false)} className="text-[#A1A1AA] hover:text-[#FFFFFF]">
                <X className="w-4 h-4" />
              </button>
            </div>

            {editingRequest?.reviewComment && (
              <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[11px]">
                Approver Feedback: {editingRequest.reviewComment}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[#A1A1AA] mb-1">Leave Type</label>
                <select
                  value={leaveType}
                  onChange={(e) => {
                    const nextType = e.target.value as LeaveType;
                    setLeaveType(nextType);
                    setDayPart(nextType === 'short' ? 'short' : dayPart === 'short' ? 'full' : dayPart);
                  }}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]"
                >
                  <option value="casual">Casual Leave</option>
                  <option value="sick">Sick Leave</option>
                  <option value="paid">Paid Leave</option>
                  <option value="emergency">Emergency Leave</option>
                  <option value="unpaid">Unpaid Leave (LWP)</option>
                  <option value="short">Short Leave / Permission</option>
                </select>
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Leave Duration</label>
                <select
                  value={dayPart}
                  onChange={(e) => {
                    const next = e.target.value as typeof dayPart;
                    setDayPart(next);
                    if (next !== 'full') setEndDate(startDate);
                  }}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]"
                >
                  <option value="full">Full Day</option>
                  <option value="first_half">Half Day — First Half</option>
                  <option value="second_half">Half Day — Second Half</option>
                  <option value="short">Short Permission (1–2 hours)</option>
                </select>
              </div>
            </div>

            {dayPart === 'short' && (
              <div>
                <label className="block text-[#A1A1AA] mb-1">Permission Hours</label>
                <select
                  value={shortLeaveHours}
                  onChange={(e) => setShortLeaveHours(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]"
                >
                  <option value={1}>1 hour (0.13d)</option>
                  <option value={2}>2 hours (0.25d)</option>
                </select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[#A1A1AA] mb-1">Start Date</label>
                <input
                  type="date"
                  required
                  value={startDate}
                  onChange={(e) => {
                    const v = e.target.value;
                    setStartDate(v);
                    if (dayPart !== 'full' || endDate < v) setEndDate(v);
                  }}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF] font-mono"
                />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">End Date</label>
                <input
                  type="date"
                  required
                  disabled={dayPart !== 'full'}
                  value={dayPart !== 'full' ? startDate : endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF] font-mono disabled:opacity-60"
                />
              </div>
            </div>

            {/* Live Pre-Submit Balance & Working Days Breakdown */}
            <div className="p-3.5 rounded-xl bg-[#0B0D12] border border-[#292D36] space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[#A1A1AA] inline-flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5 text-[#FF6A33]" />
                  Requested Working Duration
                </span>
                <span className="font-mono font-semibold text-[#FFFFFF] tabular-nums">
                  {dayPart === 'short' ? `${shortLeaveHours}h (${applyValidation.breakdown.workingDays}d)` : `${applyValidation.breakdown.workingDays} working day(s)`}
                </span>
              </div>
              {(applyValidation.breakdown.excludedWeeklyOffs > 0 || applyValidation.breakdown.excludedHolidays > 0) && (
                <div className="text-[11px] text-[#A1A1AA] font-mono">
                  Excluded automatically: {applyValidation.breakdown.excludedWeeklyOffs} weekly off(s), {applyValidation.breakdown.excludedHolidays} holiday(s)
                </div>
              )}
              {applyValidation.availableQuotaBefore !== null && (
                <div className="flex items-center justify-between pt-1 border-t border-[#292D36] text-[11px] font-mono">
                  <span className="text-[#A1A1AA]">
                    Available {leaveType} balance: <strong className="text-[#FFFFFF]">{applyValidation.availableQuotaBefore}d</strong>
                  </span>
                  <span className={applyValidation.valid ? 'text-emerald-400' : 'text-rose-400'}>
                    Remaining if approved: {applyValidation.remainingQuotaAfter}d
                  </span>
                </div>
              )}
            </div>

            {!applyValidation.valid && applyValidation.error && (
              <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-[11px]">
                {applyValidation.error}
              </div>
            )}

            {applyClashInfo.overlappingCount > 0 && (
              <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[11px] flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  Team Overlap Notice: {applyClashInfo.overlappingCount} teammate(s) already have leave scheduled during these dates (
                  {applyClashInfo.overlappingRequests.slice(0, 2).map((r) => r.employeeName).join(', ')}).
                </span>
              </div>
            )}

            <div>
              <label className="block text-[#A1A1AA] mb-1">Reason</label>
              <textarea
                required
                minLength={3}
                rows={3}
                placeholder="State reason for leave..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]"
              />
            </div>

            <div>
              <label className="block text-[#A1A1AA] mb-1">Supporting Document (Optional, e.g. Medical Note)</label>
              <label className="flex items-center justify-between px-3 py-2 bg-[#0B0D12] border border-[#292D36] hover:border-[#FF4634]/50 rounded-xl cursor-pointer text-[#A1A1AA] hover:text-[#FFFFFF]">
                <span className="inline-flex items-center gap-1.5 truncate">
                  <Paperclip className="w-3.5 h-3.5 text-[#FF6A33]" />
                  {attachmentFile ? attachmentFile.name : existingAttachmentName || 'Attach PDF, PNG, or JPG'}
                </span>
                <span className="text-[11px] text-[#FF6A33] shrink-0">Browse</span>
                <input
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg,.webp"
                  className="hidden"
                  onChange={(e) => setAttachmentFile(e.target.files?.[0] || null)}
                />
              </label>
            </div>

            {errMsg && <div className="text-rose-400">{errMsg}</div>}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowApply(false)}
                className="px-4 py-2 border border-[#292D36] bg-[#1B1F28] rounded-xl text-[#A1A1AA] hover:text-[#FFFFFF]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !applyValidation.valid}
                className="ace-btn-primary px-4 py-2 font-semibold rounded-xl disabled:opacity-50"
              >
                {submitting ? 'Submitting...' : editingRequest ? 'Resubmit Leave' : 'Submit Application'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: REJECT OR REQUEST CHANGES WITH MANDATORY COMMENT */}
      {reviewModalReq && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setReviewModalReq(null)} />
          <form
            onSubmit={handleSubmitReviewDecision}
            className="relative z-10 w-full max-w-md bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs"
          >
            <h3 className="font-display text-base font-bold text-[#FFFFFF]">
              {reviewModalDecision === 'rejected' ? 'Reject Leave Request' : 'Request Changes on Leave'}
            </h3>
            <p className="text-[#A1A1AA]">
              {reviewModalReq.employeeName} · {reviewModalReq.leaveType} ({reviewModalReq.startDate} → {reviewModalReq.endDate},{' '}
              {reviewModalReq.daysCount}d)
            </p>
            <div>
              <label className="block text-[#A1A1AA] mb-1">
                {reviewModalDecision === 'rejected' ? 'Rejection Reason (Required)' : 'Requested Changes / Note (Required)'}
              </label>
              <textarea
                required
                minLength={3}
                rows={3}
                value={reviewCommentInput}
                onChange={(e) => setReviewCommentInput(e.target.value)}
                placeholder={
                  reviewModalDecision === 'rejected'
                    ? 'Explain why this leave cannot be approved...'
                    : 'Specify what dates, type, or document needs adjustment...'
                }
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReviewModalReq(null)}
                className="px-4 py-2 border border-[#292D36] bg-[#1B1F28] rounded-xl text-[#A1A1AA] hover:text-[#FFFFFF]"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={reviewSubmitting}
                className="ace-btn-primary px-4 py-2 font-semibold rounded-xl disabled:opacity-50"
              >
                {reviewSubmitting
                  ? 'Saving...'
                  : reviewModalDecision === 'rejected'
                  ? 'Confirm Rejection'
                  : 'Send for Changes'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: CANCEL APPROVED LEAVE & REFUND BALANCE */}
      {cancelApprovedReq && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setCancelApprovedReq(null)} />
          <form
            onSubmit={handleConfirmCancelApproved}
            className="relative z-10 w-full max-w-md bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs"
          >
            <h3 className="font-display text-base font-bold text-[#FFFFFF]">Cancel Approved Leave &amp; Refund Quota</h3>
            <p className="text-[#A1A1AA]">
              This will atomically cancel {cancelApprovedReq.employeeName}&apos;s approved {cancelApprovedReq.leaveType} leave (
              {cancelApprovedReq.daysCount}d) and refund {cancelApprovedReq.daysCount} day(s) back to their balance.
            </p>
            <div>
              <label className="block text-[#A1A1AA] mb-1">Cancellation Reason (Required)</label>
              <textarea
                required
                minLength={3}
                rows={3}
                value={cancelApprovedReason}
                onChange={(e) => setCancelApprovedReason(e.target.value)}
                placeholder="Reason for cancelling approved leave..."
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCancelApprovedReq(null)}
                className="px-4 py-2 border border-[#292D36] bg-[#1B1F28] rounded-xl text-[#A1A1AA] hover:text-[#FFFFFF]"
              >
                Keep Approved
              </button>
              <button
                type="submit"
                disabled={cancellingApproved}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white font-semibold rounded-xl disabled:opacity-50"
              >
                {cancellingApproved ? 'Refunding...' : 'Cancel & Refund Days'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: SUPER ADMIN MANUAL BALANCE ADJUSTMENT */}
      {adjustModalUid && isSuperAdmin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setAdjustModalUid('')} />
          <form
            onSubmit={handleManualBalanceAdjust}
            className="relative z-10 w-full max-w-md bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs"
          >
            <h3 className="font-display text-base font-bold text-[#FFFFFF]">Manual Leave Balance Adjustment</h3>
            <p className="text-[#A1A1AA]">
              Employee: <strong className="text-[#FFFFFF]">{employees.find((e) => e.uid === adjustModalUid)?.fullName || adjustModalUid}</strong>
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[#A1A1AA] mb-1">Balance Bucket</label>
                <select
                  value={adjustBucket}
                  onChange={(e) => setAdjustBucket(e.target.value as BalanceBucketField)}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]"
                >
                  <option value="paidTotal">Paid Quota Total</option>
                  <option value="paidUsed">Paid Used</option>
                  <option value="casualTotal">Casual Quota Total</option>
                  <option value="casualUsed">Casual Used</option>
                  <option value="sickTotal">Sick Quota Total</option>
                  <option value="sickUsed">Sick Used</option>
                  <option value="emergencyTotal">Emergency Quota Total</option>
                  <option value="emergencyUsed">Emergency Used</option>
                  <option value="unpaidUsed">Unpaid Used</option>
                </select>
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Operation</label>
                <select
                  value={adjustMode}
                  onChange={(e) => setAdjustMode(e.target.value as 'delta' | 'set')}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]"
                >
                  <option value="delta">Add / Subtract (+/-)</option>
                  <option value="set">Set Exact Value</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-[#A1A1AA] mb-1">
                {adjustMode === 'delta' ? 'Adjustment Delta (e.g. +2 or -1.5)' : 'New Exact Balance (days)'}
              </label>
              <input
                type="number"
                step="0.5"
                required
                value={adjustValue}
                onChange={(e) => setAdjustValue(Number(e.target.value))}
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono"
              />
            </div>
            <div>
              <label className="block text-[#A1A1AA] mb-1">Audit Reason (Mandatory)</label>
              <textarea
                required
                minLength={5}
                rows={3}
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                placeholder="Provide reason for manual quota/usage adjustment..."
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAdjustModalUid('')}
                className="px-4 py-2 border border-[#292D36] bg-[#1B1F28] rounded-xl text-[#A1A1AA] hover:text-[#FFFFFF]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={adjustSubmitting}
                className="ace-btn-primary px-4 py-2 font-semibold rounded-xl disabled:opacity-50"
              >
                {adjustSubmitting ? 'Applying...' : 'Apply & Log Audit'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: ANNUAL LEAVE RESET & CARRY-FORWARD */}
      {showResetModal && isHR && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setShowResetModal(false)} />
          <form
            onSubmit={handleExecuteAnnualReset}
            className="relative z-10 w-full max-w-lg bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs max-h-[90vh] overflow-y-auto"
          >
            <h3 className="font-display text-base font-bold text-[#FFFFFF]">Annual Leave Reset &amp; Carry-Forward</h3>
            <p className="text-[#A1A1AA]">
              Resets Casual ({leavePolicy.casualAnnual}), Sick ({leavePolicy.sickAnnual}), Paid ({leavePolicy.paidAnnual}), and Emergency ({leavePolicy.emergencyAnnual}) quotas and carries forward unused Paid Leave.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[#A1A1AA] mb-1">Target Leave Year</label>
                <input
                  type="number"
                  min={2024}
                  max={2035}
                  value={resetYear}
                  onChange={(e) => setResetYear(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono"
                />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Max Paid Carry-Forward Days</label>
                <input
                  type="number"
                  min={0}
                  max={30}
                  disabled={!carryEnabled}
                  value={maxCarryPaid}
                  onChange={(e) => setMaxCarryPaid(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono disabled:opacity-50"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-[#D4D4D8]">
              <input type="checkbox" checked={carryEnabled} onChange={(e) => setCarryEnabled(e.target.checked)} />
              Enable unused Paid Leave carry-forward into {resetYear}
            </label>
            <div className="border border-[#292D36] rounded-xl overflow-hidden max-h-48 overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="bg-[#1B1F28] text-[#A1A1AA]">
                    <th className="px-3 py-2 text-left">Employee</th>
                    <th className="px-3 py-2 text-right">Unused Paid</th>
                    <th className="px-3 py-2 text-right">Carry</th>
                    <th className="px-3 py-2 text-right">New Paid Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#292D36]/60">
                  {resetPreview.map((row) => (
                    <tr key={row.nextBal.uid}>
                      <td className="px-3 py-1.5 text-[#FFFFFF]">{row.name}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-[#A1A1AA]">{row.previousUnusedPaid}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-emerald-400">+{row.carriedForward}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-[#FF6A33] font-semibold">{row.newPaidTotal}</td>
                    </tr>
                  ))}
                  {resetPreview.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-4 text-center text-[#A1A1AA]">
                        No existing leave balance documents to reset.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowResetModal(false)}
                className="px-4 py-2 border border-[#292D36] bg-[#1B1F28] rounded-xl text-[#A1A1AA] hover:text-[#FFFFFF]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={resetting || resetPreview.length === 0}
                className="ace-btn-primary px-4 py-2 font-semibold rounded-xl disabled:opacity-50"
              >
                {resetting ? 'Executing Reset...' : `Run ${resetYear} Reset`}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
