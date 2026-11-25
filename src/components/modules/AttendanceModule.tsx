import React, { useMemo, useState } from 'react';
import {
  doc,
  setDoc,
  deleteDoc,
  writeBatch,
  serverTimestamp,
} from 'firebase/firestore';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Calendar,
  FileEdit,
  Plus,
  Check,
  X,
  Download,
  Trash2,
  BarChart3,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import { dispatchNotification, makeId, writeAuditLog } from '../../services/hrmsApi';
import { AttendanceCheckInWidget } from '../attendance/AttendanceCheckInWidget';
import {
  COMMON_TIMEZONES,
  formatDurationMinutes,
  formatMinutesAsClock12,
  formatTimeInZone,
  getOfficeNowParts,
  getScheduleMetrics,
  isWeeklyOffDate,
} from '../../utils/attendanceUtils';
import { exportToCsv, exportToXlsx, generateReportPdf } from '../../utils/exportUtils';
import { getChartTheme, useThemeMode } from '../../utils/themeUtils';
import { canRoleApproveRequest } from '../../utils/workflowUtils';
import type { AttendanceRecord, AttendanceStatus, Holiday } from '../../types/hrms';

interface TooltipEntry {
  name?: string;
  value?: number | string;
  color?: string;
}

const AttendanceChartTooltip: React.FC<{
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
  suffix?: string;
}> = ({ active, payload, label, suffix = '' }) => {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-[#0B0D12] border border-[#292D36] rounded-xl px-3.5 py-2.5 shadow-2xl shadow-black/70 text-xs min-w-[140px]">
      {label && (
        <div className="font-medium text-[#FFFFFF] pb-1.5 mb-1.5 border-b border-[#292D36]">{label}</div>
      )}
      <div className="space-y-1">
        {payload.map((p, idx) => (
          <div key={`${p.name}-${idx}`} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-2 text-[#A1A1AA]">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color || '#FF4634' }} />
              <span>{p.name}</span>
            </span>
            <span className="font-mono font-semibold text-[#FFFFFF] tabular-nums">
              {p.value}
              {suffix}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export const AttendanceModule: React.FC = () => {
  const { firebaseUser, employeeProfile, effectiveRole } = useAuth();
  const {
    attendance,
    attendanceCorrections,
    holidays,
    employees,
    departments,
    directory,
    workPolicy,
    approvalWorkflows,
    shiftTemplates,
    shiftAssignments,
  } = useHrmsData();
  const { isLight } = useThemeMode();
  const chartTheme = useMemo(() => getChartTheme(isLight), [isLight]);

  const isHR = effectiveRole === 'super_admin' || effectiveRole === 'hr_manager';
  const canApprove = canRoleApproveRequest(effectiveRole, 'attendance_correction', approvalWorkflows);
  const uid = firebaseUser?.uid || '';

  const sched = getScheduleMetrics(workPolicy);
  const today = getOfficeNowParts(new Date(), sched.officeTimezone).dateStr;

  const [subTab, setSubTab] = useState<'logs' | 'calendar' | 'analytics' | 'corrections' | 'shifts' | 'holidays'>('logs');
  const [selectedMonth, setSelectedMonth] = useState(today.slice(0, 7));
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  // Correction modal
  const [showCorrModal, setShowCorrModal] = useState(false);
  const [corrDate, setCorrDate] = useState(today);
  const [corrIn, setCorrIn] = useState(sched.workStartTime);
  const [corrOut, setCorrOut] = useState(sched.workEndTime);
  const [corrBreak, setCorrBreak] = useState(sched.scheduledLunchMinutes);
  const [corrReason, setCorrReason] = useState('');
  const [corrError, setCorrError] = useState('');

  // Manual HR mark modal
  const [showMarkModal, setShowMarkModal] = useState(false);
  const [markEmpId, setMarkEmpId] = useState('');
  const [markDate, setMarkDate] = useState(today);
  const [markStatus, setMarkStatus] = useState<AttendanceStatus>('present');
  const [markNotes, setMarkNotes] = useState('');

  // Shift template & assignment states
  const [shiftName, setShiftName] = useState('');
  const [shiftStart, setShiftStart] = useState('09:30');
  const [shiftEnd, setShiftEnd] = useState('18:30');
  const [shiftGrace, setShiftGrace] = useState(15);
  const [shiftBreak, setShiftBreak] = useState(45);
  const [shiftTimezone, setShiftTimezone] = useState(sched.officeTimezone);
  const [assignEmpId, setAssignEmpId] = useState('');
  const [assignTemplateId, setAssignTemplateId] = useState('');
  const [assignFrom, setAssignFrom] = useState(today);
  const [shiftNotice, setShiftNotice] = useState('');

  // Holiday form & filter
  const [holName, setHolName] = useState('');
  const [holDate, setHolDate] = useState(today);
  const [holType, setHolType] = useState<Holiday['type']>('public');
  const [holCountry, setHolCountry] = useState('IN');
  const [holLocation, setHolLocation] = useState('');
  const [holDesc, setHolDesc] = useState('');
  const [holCountryFilter, setHolCountryFilter] = useState('all');

  const myMonthlyCorrectionsCount = useMemo(() => {
    const curYear = Number(today.slice(0, 4));
    const curMonth = Number(today.slice(5, 7));
    return attendanceCorrections.filter((c) => {
      if (c.uid !== uid) return false;
      const created =
        c.createdAt && typeof (c.createdAt as { toDate?: () => Date }).toDate === 'function'
          ? (c.createdAt as { toDate: () => Date }).toDate()
          : new Date(c.date);
      return created.getFullYear() === curYear && created.getMonth() + 1 === curMonth;
    }).length;
  }, [attendanceCorrections, uid, today]);

  const filteredLogs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return attendance
      .filter((a) => {
        const matchesMonth = !selectedMonth || a.date.startsWith(selectedMonth);
        const matchesQ = !q || a.employeeName.toLowerCase().includes(q) || a.date.includes(q);
        const matchesStatus = statusFilter === 'all' || a.status === statusFilter;
        return matchesMonth && matchesQ && matchesStatus;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [attendance, selectedMonth, search, statusFilter]);

  const calendarDays = useMemo(() => {
    const [yr, mo] = selectedMonth.split('-').map(Number);
    const totalDays = new Date(yr, mo, 0).getDate();
    const firstWeekday = new Date(yr, mo - 1, 1).getDay();
    const cells: { day: number | null; dateStr: string }[] = [];
    for (let i = 0; i < firstWeekday; i++) cells.push({ day: null, dateStr: '' });
    for (let d = 1; d <= totalDays; d++) {
      const dateStr = `${selectedMonth}-${String(d).padStart(2, '0')}`;
      cells.push({ day: d, dateStr });
    }
    return cells;
  }, [selectedMonth]);

  // Live Attendance Analytics for selectedMonth
  const analyticsData = useMemo(() => {
    const monthLogs = attendance.filter((a) => a.date.startsWith(selectedMonth));
    const activeRosterCount = directory.filter((d) => d.status === 'active').length;

    const byDate: Record<
      string,
      {
        rawDate: string;
        date: string;
        present: number;
        absent: number;
        lateCount: number;
        lateMinutesTotal: number;
        totalWorkingHours: number;
        loggedCount: number;
      }
    > = {};

    monthLogs.forEach((rec) => {
      if (!byDate[rec.date]) {
        byDate[rec.date] = {
          rawDate: rec.date,
          date: rec.date.slice(5),
          present: 0,
          absent: 0,
          lateCount: 0,
          lateMinutesTotal: 0,
          totalWorkingHours: 0,
          loggedCount: 0,
        };
      }
      const bucket = byDate[rec.date];
      if (['present', 'late', 'half_day', 'early_departure'].includes(rec.status)) {
        bucket.present += 1;
        bucket.loggedCount += 1;
        bucket.totalWorkingHours += (rec.workingMinutes || 0) / 60;
      } else if (rec.status === 'absent') {
        bucket.absent += 1;
      }
      if (rec.isLate || rec.status === 'late') {
        bucket.lateCount += 1;
        bucket.lateMinutesTotal += rec.lateMinutes || 0;
      }
    });

    const dailySeries = Object.values(byDate)
      .sort((a, b) => a.rawDate.localeCompare(b.rawDate))
      .map((d) => ({
        ...d,
        inferredAbsent: d.absent > 0 ? d.absent : Math.max(0, activeRosterCount - d.present),
        avgHours: d.loggedCount > 0 ? Number((d.totalWorkingHours / d.loggedCount).toFixed(2)) : 0,
      }));

    const deptStats = departments
      .map((dept) => {
        const deptRecs = monthLogs.filter((r) => r.departmentId === dept.id);
        const presentCount = deptRecs.filter((r) =>
          ['present', 'late', 'half_day', 'early_departure'].includes(r.status)
        ).length;
        const lateCount = deptRecs.filter((r) => r.isLate || r.status === 'late').length;
        const avgHours =
          presentCount > 0
            ? Number(
                (
                  deptRecs.reduce((sum, r) => sum + (r.workingMinutes || 0), 0) /
                  60 /
                  presentCount
                ).toFixed(2)
              )
            : 0;
        return {
          department: dept.code || dept.name,
          fullName: dept.name,
          presentCount,
          lateCount,
          avgHours,
        };
      })
      .filter((d) => d.presentCount > 0 || d.lateCount > 0);

    const totalPresentLogs = monthLogs.filter((r) =>
      ['present', 'late', 'half_day', 'early_departure'].includes(r.status)
    ).length;
    const totalLateLogs = monthLogs.filter((r) => r.isLate || r.status === 'late').length;
    const avgNetHours =
      totalPresentLogs > 0
        ? Number(
            (monthLogs.reduce((s, r) => s + (r.workingMinutes || 0), 0) / 60 / totalPresentLogs).toFixed(2)
          )
        : 0;

    return {
      dailySeries,
      deptStats,
      totalRecords: monthLogs.length,
      totalPresentLogs,
      totalLateLogs,
      avgNetHours,
      targetHours: Number((sched.netWorkingTargetMinutes / 60).toFixed(2)),
    };
  }, [attendance, selectedMonth, directory, departments, sched.netWorkingTargetMinutes]);

  const submitCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;
    setCorrError('');
    if (myMonthlyCorrectionsCount >= 3) {
      setCorrError('You have reached the monthly limit of 3 attendance correction requests. Contact HR for manual adjustment.');
      return;
    }
    if (corrReason.trim().length < 10) {
      setCorrError('Please provide a clear reason (at least 10 characters).');
      return;
    }
    const id = makeId('corr');
    const attId = `${uid}_${corrDate}`;
    try {
      await setDoc(doc(db, 'attendanceCorrections', id), {
        id,
        attendanceId: attId,
        uid,
        employeeId: employeeProfile?.id || uid,
        employeeName: employeeProfile?.fullName || firebaseUser.displayName || 'Employee',
        departmentId: employeeProfile?.departmentId || 'dept_exec',
        date: corrDate,
        requestedCheckIn: `${corrDate}T${corrIn}:00`,
        requestedCheckOut: `${corrDate}T${corrOut}:00`,
        requestedBreakMinutes: Number(corrBreak) || 0,
        reason: corrReason.trim(),
        status: 'pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const submitEmail = employeeProfile?.email || firebaseUser.email || undefined;
      await dispatchNotification({
        recipientUid: uid,
        recipientEmail: submitEmail,
        title: 'Attendance Correction Submitted',
        message: `Your attendance correction request for ${corrDate} (${corrIn} – ${corrOut}) is awaiting manager/HR review.`,
        type: 'attendance',
        linkTab: 'attendance',
        sendEmail: Boolean(submitEmail),
      });

      setShowCorrModal(false);
      setCorrReason('');
      setCorrError('');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `attendanceCorrections/${id}`);
    }
  };

  const reviewCorrection = async (corrId: string, decision: 'approved' | 'rejected') => {
    if (!firebaseUser || !canApprove) return;
    const corr = attendanceCorrections.find((c) => c.id === corrId);
    if (!corr) return;

    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'attendanceCorrections', corrId), {
        status: decision,
        reviewedByUid: firebaseUser.uid,
        reviewNotes: decision === 'approved' ? 'Approved by manager/HR' : 'Declined',
        updatedAt: serverTimestamp(),
      });

      if (decision === 'approved') {
        const targetId = corr.attendanceId || `${corr.uid}_${corr.date}`;
        const inDt = new Date(corr.requestedCheckIn);
        const outDt = corr.requestedCheckOut ? new Date(corr.requestedCheckOut) : inDt;
        const rawMins = Math.max(0, Math.round((outDt.getTime() - inDt.getTime()) / 60000));
        const usedBreak = corr.requestedBreakMinutes ?? sched.scheduledLunchMinutes;
        const workingMinutes = Math.max(0, rawMins - usedBreak);

        const existingRec = attendance.find((a) => a.id === targetId);
        if (existingRec) {
          batch.update(doc(db, 'attendance', targetId), {
            checkInTime: corr.requestedCheckIn,
            checkOutTime: corr.requestedCheckOut || '',
            correctionId: corrId,
            breakMinutes: usedBreak,
            actualLunchMinutes: usedBreak,
            workingMinutes,
            officeTimezone: sched.officeTimezone,
            status: workingMinutes < sched.halfDayThresholdMinutes ? 'half_day' : 'present',
            updatedAt: serverTimestamp(),
          });
        } else {
          batch.set(doc(db, 'attendance', targetId), {
            id: targetId,
            uid: corr.uid,
            employeeId: corr.employeeId,
            employeeName: corr.employeeName,
            departmentId: corr.departmentId,
            date: corr.date,
            correctionId: corrId,
            checkInTime: corr.requestedCheckIn,
            checkOutTime: corr.requestedCheckOut || '',
            breakMinutes: usedBreak,
            actualLunchMinutes: usedBreak,
            workingMinutes,
            lateMinutes: 0,
            earlyDepartureMinutes: 0,
            officeTimezone: sched.officeTimezone,
            status: 'present',
            isLate: false,
            isEarlyDeparture: false,
            notes: 'Approved via correction request',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      }
      await batch.commit();
      await writeAuditLog({
        actorUid: firebaseUser.uid,
        actorEmail: firebaseUser.email || '',
        actorRole: effectiveRole,
        action: `ATTENDANCE_CORRECTION_${decision.toUpperCase()}`,
        targetCollection: 'attendance',
        targetId: corr.attendanceId || `${corr.uid}_${corr.date}`,
        summary: `${decision === 'approved' ? 'Approved' : 'Rejected'} attendance correction for ${corr.employeeName} on ${corr.date}; reason: ${corr.reason}`,
      });

      const corrEmp = employees.find((e) => e.uid === corr.uid || e.id === corr.employeeId);
      await dispatchNotification({
        recipientUid: corr.uid,
        recipientEmail: corrEmp?.email,
        title: `Attendance Correction ${decision === 'approved' ? 'Approved' : 'Rejected'}`,
        message: `Your attendance correction for ${corr.date} has been ${decision}.`,
        type: 'attendance',
        linkTab: 'attendance',
        sendEmail: Boolean(corrEmp?.email),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `attendanceCorrections/${corrId}`);
    }
  };

  const handleMarkAttendance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isHR) return;
    const emp = employees.find((x) => x.id === markEmpId) || employees[0];
    if (!emp) return;
    const empUid = emp.uid || emp.id;
    const id = `${empUid}_${markDate}`;
    const isNonWork = markStatus === 'absent' || markStatus === 'holiday' || markStatus === 'weekly_off';

    try {
      await setDoc(doc(db, 'attendance', id), {
        id,
        uid: empUid,
        employeeId: emp.id,
        employeeName: emp.fullName,
        departmentId: emp.departmentId,
        date: markDate,
        checkInTime: isNonWork ? '' : `${markDate}T${sched.workStartTime}:00`,
        checkOutTime: isNonWork ? '' : `${markDate}T${sched.workEndTime}:00`,
        breakMinutes: sched.scheduledLunchMinutes,
        actualLunchMinutes: isNonWork ? 0 : sched.scheduledLunchMinutes,
        workingMinutes:
          markStatus === 'present' || markStatus === 'late' || markStatus === 'early_departure'
            ? sched.netWorkingTargetMinutes
            : markStatus === 'half_day'
            ? Math.round(sched.netWorkingTargetMinutes / 2)
            : 0,
        lateMinutes: markStatus === 'late' ? 15 : 0,
        earlyDepartureMinutes: markStatus === 'early_departure' ? 30 : 0,
        officeTimezone: sched.officeTimezone,
        status: markStatus,
        isLate: markStatus === 'late',
        isEarlyDeparture: markStatus === 'early_departure',
        notes: markNotes.trim(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setShowMarkModal(false);
      setMarkNotes('');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `attendance/${id}`);
    }
  };

  const handleAddHoliday = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isHR || !holName.trim()) return;
    const id = makeId('hol');
    try {
      await setDoc(doc(db, 'holidays', id), {
        id,
        name: holName.trim(),
        date: holDate,
        type: holType,
        countryCode: holCountry.trim().toUpperCase() || 'IN',
        location: holLocation.trim(),
        description: holDesc.trim(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog({
        actorUid: uid,
        actorEmail: firebaseUser?.email || '',
        actorRole: effectiveRole,
        action: 'HOLIDAY_ADDED',
        targetCollection: 'holidays',
        targetId: id,
        summary: `Added holiday ${holName.trim()} on ${holDate}`,
      });
      setHolName('');
      setHolDesc('');
      setHolLocation('');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `holidays/${id}`);
    }
  };

  const deleteHoliday = async (id: string) => {
    if (!isHR) return;
    try {
      await deleteDoc(doc(db, 'holidays', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `holidays/${id}`);
    }
  };

  const handleCreateShiftTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isHR || !shiftName.trim()) return;
    setShiftNotice('');
    const id = makeId('shf');
    try {
      await setDoc(doc(db, 'shiftTemplates', id), {
        id,
        name: shiftName.trim(),
        startTime: shiftStart,
        endTime: shiftEnd,
        graceMinutes: Number(shiftGrace) || 15,
        breakMinutes: Number(shiftBreak) || 45,
        timezone: shiftTimezone,
        weeklyOffs: workPolicy.weeklyOffs || ['Saturday', 'Sunday'],
        isDefault: shiftTemplates.length === 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setShiftName('');
      setShiftNotice('Shift template saved.');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `shiftTemplates/${id}`);
    }
  };

  const handleAssignShift = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isHR) return;
    setShiftNotice('');
    const emp = employees.find((x) => x.id === assignEmpId) || employees[0];
    const tpl = shiftTemplates.find((x) => x.id === assignTemplateId) || shiftTemplates[0];
    if (!emp || !tpl) {
      setShiftNotice('Create a shift template and select an employee first.');
      return;
    }
    const id = makeId('shas');
    try {
      await setDoc(doc(db, 'shiftAssignments', id), {
        id,
        uid: emp.uid || emp.id,
        employeeId: emp.id,
        employeeName: emp.fullName,
        departmentId: emp.departmentId,
        shiftTemplateId: tpl.id,
        shiftName: tpl.name,
        startTime: tpl.startTime,
        endTime: tpl.endTime,
        effectiveFrom: assignFrom,
        assignedByUid: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setShiftNotice(`Assigned ${tpl.name} (${tpl.startTime} – ${tpl.endTime}) to ${emp.fullName}.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `shiftAssignments/${id}`);
    }
  };

  const handleDeleteShiftTemplate = async (id: string) => {
    if (!isHR) return;
    try {
      await deleteDoc(doc(db, 'shiftTemplates', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `shiftTemplates/${id}`);
    }
  };

  const handleExportCsv = () => {
    exportToCsv(
      `attendance_${selectedMonth}`,
      ['Date', 'Employee', 'Check In', 'Check Out', 'Lunch (m)', 'Net Worked (h)', 'Late (m)', 'Early Out (m)', 'Status'],
      filteredLogs.map((r) => [
        r.date,
        r.employeeName,
        r.checkInTime ? formatTimeInZone(r.checkInTime, r.officeTimezone || sched.officeTimezone) : '-',
        r.checkOutTime ? formatTimeInZone(r.checkOutTime, r.officeTimezone || sched.officeTimezone) : '-',
        r.actualLunchMinutes || r.breakMinutes,
        (r.workingMinutes / 60).toFixed(2),
        r.lateMinutes ?? (r.isLate ? 1 : 0),
        r.earlyDepartureMinutes ?? 0,
        r.status,
      ])
    );
  };

  const handleExportXlsx = async () => {
    await exportToXlsx(
      `attendance_${selectedMonth}`,
      ['Date', 'Employee', 'Check In', 'Check Out', 'Lunch (m)', 'Net Worked (h)', 'Late (m)', 'Early Out (m)', 'Status'],
      filteredLogs.map((r) => [
        r.date,
        r.employeeName,
        r.checkInTime ? formatTimeInZone(r.checkInTime, r.officeTimezone || sched.officeTimezone) : '-',
        r.checkOutTime ? formatTimeInZone(r.checkOutTime, r.officeTimezone || sched.officeTimezone) : '-',
        r.actualLunchMinutes || r.breakMinutes,
        Number((r.workingMinutes / 60).toFixed(2)),
        r.lateMinutes ?? (r.isLate ? 1 : 0),
        r.earlyDepartureMinutes ?? 0,
        r.status,
      ]),
      'Attendance Logs'
    );
  };

  const handleExportPdf = () => {
    generateReportPdf(
      'Attendance Report',
      `Period: ${selectedMonth}`,
      ['Date', 'Employee', 'Status', 'Worked Hours', 'Late', 'Early Out'],
      filteredLogs.map((r) => [
        r.date,
        r.employeeName,
        r.status,
        (r.workingMinutes / 60).toFixed(2),
        r.isLate ? 'Yes' : 'No',
        r.isEarlyDeparture ? 'Yes' : 'No',
      ])
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#FFFFFF]">Attendance & Time Tracking</h1>
          <p className="text-sm text-[#A1A1AA] mt-1">
            Office Hours: {formatMinutesAsClock12(sched.workStartTime)} – {formatMinutesAsClock12(sched.workEndTime)} · Lunch {formatMinutesAsClock12(sched.lunchStartTime)} – {formatMinutesAsClock12(sched.lunchEndTime)} ({sched.scheduledLunchMinutes}m) · Net {formatDurationMinutes(sched.netWorkingTargetMinutes)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowCorrModal(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#151922] hover:bg-[#1B1F28] border border-[#292D36] hover:border-[#FF4634]/50 text-[#FFFFFF] text-xs font-medium rounded-xl whitespace-nowrap transition-colors"
          >
            <FileEdit className="w-3.5 h-3.5 text-[#FF6A33]" />
            Request Correction
          </button>
          {isHR && (
            <button
              type="button"
              onClick={() => {
                setMarkEmpId(employees[0]?.id || '');
                setShowMarkModal(true);
              }}
              className="ace-btn-primary inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              Mark Entry
            </button>
          )}
        </div>
      </div>

      {/* Prominent Live Attendance Check-In / Lunch / Check-Out Console */}
      <AttendanceCheckInWidget onRequestCorrection={() => setShowCorrModal(true)} />

      {/* Sub-navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 p-1.5 bg-[#151922] border border-[#292D36] rounded-2xl">
          {[
            { id: 'logs', label: 'Daily Logs' },
            { id: 'analytics', label: 'Attendance Analytics' },
            { id: 'calendar', label: 'Monthly Calendar' },
            { id: 'corrections', label: `Corrections (${attendanceCorrections.filter((c) => c.status === 'pending').length})` },
            { id: 'shifts', label: `Shifts & Rosters (${shiftTemplates.length})` },
            { id: 'holidays', label: `Holidays (${holidays.length})` },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id as typeof subTab)}
              className={`px-3 py-1.5 text-xs font-medium rounded-xl transition-all whitespace-nowrap ${
                subTab === t.id
                  ? 'bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-white'
                  : 'text-[#A1A1AA] hover:text-[#FFFFFF]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="month"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="px-3 py-1.5 bg-[#151922] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-xs text-[#FFFFFF] font-mono"
          />
          <button
            type="button"
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#151922] border border-[#292D36] text-[#A1A1AA] hover:text-[#FFFFFF] hover:border-[#FF4634]/50 text-xs rounded-xl transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            CSV
          </button>
          <button
            type="button"
            onClick={() => void handleExportXlsx()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#151922] border border-[#292D36] text-[#A1A1AA] hover:text-[#FFFFFF] hover:border-[#FF4634]/50 text-xs rounded-xl transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            XLSX
          </button>
          <button
            type="button"
            onClick={handleExportPdf}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#151922] border border-[#292D36] text-[#A1A1AA] hover:text-[#FFFFFF] hover:border-[#FF4634]/50 text-xs rounded-xl transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            PDF
          </button>
        </div>
      </div>

      {subTab === 'logs' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-[#151922] border border-[#292D36] rounded-2xl p-4">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by employee name or date..."
              className="px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-xs text-[#FFFFFF]"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-xs text-[#FFFFFF]"
            >
              <option value="all" className="bg-[#151922]">All Attendance Statuses</option>
              <option value="present" className="bg-[#151922]">Present</option>
              <option value="late" className="bg-[#151922]">Late</option>
              <option value="half_day" className="bg-[#151922]">Half Day</option>
              <option value="early_departure" className="bg-[#151922]">Early Departure</option>
              <option value="absent" className="bg-[#151922]">Absent</option>
              <option value="weekly_off" className="bg-[#151922]">Weekly Off</option>
              <option value="holiday" className="bg-[#151922]">Holiday</option>
            </select>
          </div>

          <div className="bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden">
            {filteredLogs.length === 0 ? (
              <div className="p-8 text-center text-sm text-[#A1A1AA]">
                No attendance logs found for {selectedMonth}.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                      <th className="px-4 py-3 text-left font-medium">Date</th>
                      <th className="px-4 py-3 text-left font-medium">Employee</th>
                      <th className="px-4 py-3 text-left font-medium">Check In</th>
                      <th className="px-4 py-3 text-right font-medium">Lunch Break</th>
                      <th className="px-4 py-3 text-left font-medium">Check Out</th>
                      <th className="px-4 py-3 text-right font-medium">Net Worked</th>
                      <th className="px-4 py-3 text-right font-medium">Late / Early</th>
                      <th className="px-4 py-3 text-right font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#292D36]/70">
                    {filteredLogs.map((r: AttendanceRecord) => {
                      const tz = r.officeTimezone || sched.officeTimezone;
                      const lunchMins = r.actualLunchMinutes && r.actualLunchMinutes > 0 ? r.actualLunchMinutes : r.breakMinutes;
                      const lateInfo = r.lateMinutes && r.lateMinutes > 0 ? `${r.lateMinutes}m late` : r.isLate ? 'Late' : '';
                      const earlyInfo =
                        r.earlyDepartureMinutes && r.earlyDepartureMinutes > 0
                          ? `${r.earlyDepartureMinutes}m early`
                          : r.isEarlyDeparture
                          ? 'Early'
                          : '';

                      return (
                        <tr key={r.id} className="hover:bg-[#1B1F28]/60">
                          <td className="px-4 py-3 font-mono text-[#FFFFFF] tabular-nums">{r.date}</td>
                          <td className="px-4 py-3 text-[#FFFFFF] font-medium">{r.employeeName}</td>
                          <td className="px-4 py-3 font-mono text-[#A1A1AA] tabular-nums">
                            {formatTimeInZone(r.checkInTime, tz)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-[#A1A1AA] tabular-nums">{lunchMins}m</td>
                          <td className="px-4 py-3 font-mono text-[#A1A1AA] tabular-nums">
                            {formatTimeInZone(r.checkOutTime, tz)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-[#FFFFFF] tabular-nums">
                            {formatDurationMinutes(r.workingMinutes)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums">
                            {lateInfo || earlyInfo ? (
                              <span className="text-amber-400">
                                {[lateInfo, earlyInfo].filter(Boolean).join(' · ')}
                              </span>
                            ) : (
                              <span className="text-[#A1A1AA]/60">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right capitalize font-medium">
                            <span
                              className={
                                r.status === 'present'
                                  ? 'text-emerald-400'
                                  : r.status === 'late' || r.status === 'half_day' || r.status === 'early_departure'
                                  ? 'text-amber-400'
                                  : r.status === 'absent'
                                  ? 'text-rose-400'
                                  : 'text-[#FF6A33]'
                              }
                            >
                              {r.status.replace('_', ' ')}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {subTab === 'analytics' && (
        <div className="space-y-6">
          {/* Analytics Summary Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 rounded-2xl bg-[#151922] border border-[#292D36]">
              <div className="text-xs text-[#A1A1AA]">Present Shifts ({selectedMonth})</div>
              <div className="font-mono text-2xl font-bold text-emerald-400 mt-1 tabular-nums">
                {analyticsData.totalPresentLogs}
              </div>
            </div>
            <div className="p-4 rounded-2xl bg-[#151922] border border-[#292D36]">
              <div className="text-xs text-[#A1A1AA]">Late Arrivals ({selectedMonth})</div>
              <div className="font-mono text-2xl font-bold text-amber-400 mt-1 tabular-nums">
                {analyticsData.totalLateLogs}
              </div>
            </div>
            <div className="p-4 rounded-2xl bg-[#151922] border border-[#292D36]">
              <div className="text-xs text-[#A1A1AA]">Avg Net Working Hours</div>
              <div className="font-mono text-2xl font-bold text-[#FFFFFF] mt-1 tabular-nums">
                {analyticsData.avgNetHours}h
              </div>
            </div>
            <div className="p-4 rounded-2xl bg-[#151922] border border-[#292D36]">
              <div className="text-xs text-[#A1A1AA]">Net Shift Target</div>
              <div className="font-mono text-2xl font-bold text-[#FF6A33] mt-1 tabular-nums">
                {analyticsData.targetHours}h
              </div>
            </div>
          </div>

          {analyticsData.totalRecords === 0 ? (
            <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-10 text-center">
              <BarChart3 className="w-8 h-8 text-[#FF6A33] mx-auto mb-3" />
              <p className="text-sm font-semibold text-[#FFFFFF]">No attendance analytics for {selectedMonth}</p>
              <p className="text-xs text-[#A1A1AA] mt-1">
                Employee check-ins and checkout entries will automatically populate daily trend, late arrival, department, and working hours charts.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Daily Attendance Trend */}
              <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 min-w-0">
                <h3 className="font-display text-sm font-semibold text-[#FFFFFF] mb-1">Daily Attendance Trend</h3>
                <p className="text-xs text-[#A1A1AA] mb-4">Present vs Late daily check-in volume</p>
                <div className="h-60 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={analyticsData.dailySeries} margin={{ top: 6, right: 12, left: -16, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} vertical={false} />
                      <XAxis dataKey="date" stroke={chartTheme.axisStroke} fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis stroke={chartTheme.axisStroke} fontSize={11} allowDecimals={false} tickLine={false} axisLine={false} />
                      <Tooltip content={<AttendanceChartTooltip />} />
                      <Line type="monotone" dataKey="present" name="Present" stroke="#FF6A33" strokeWidth={2.5} dot={{ r: 3, fill: '#FF6A33' }} />
                      <Line type="monotone" dataKey="lateCount" name="Late Arrivals" stroke="#FF6A33" strokeWidth={2} dot={{ r: 3, fill: '#FF6A33' }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Present vs Absent Chart */}
              <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 min-w-0">
                <h3 className="font-display text-sm font-semibold text-[#FFFFFF] mb-1">Present vs Absent</h3>
                <p className="text-xs text-[#A1A1AA] mb-4">Daily attendance turnout compared against active workforce</p>
                <div className="h-60 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analyticsData.dailySeries} margin={{ top: 6, right: 12, left: -16, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} vertical={false} />
                      <XAxis dataKey="date" stroke={chartTheme.axisStroke} fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis stroke={chartTheme.axisStroke} fontSize={11} allowDecimals={false} tickLine={false} axisLine={false} />
                      <Tooltip content={<AttendanceChartTooltip />} cursor={{ fill: chartTheme.cursorFill }} />
                      <Bar dataKey="present" name="Present" fill="#FF6A33" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="inferredAbsent" name="Absent" fill="#FF4634" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Late Arrival Analytics */}
              <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                  <h3 className="font-display text-sm font-semibold text-[#FFFFFF]">Late Arrival Analytics</h3>
                </div>
                <p className="text-xs text-[#A1A1AA] mb-4">Daily late arrival minutes & late check-in count</p>
                <div className="h-60 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analyticsData.dailySeries} margin={{ top: 6, right: 12, left: -16, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} vertical={false} />
                      <XAxis dataKey="date" stroke={chartTheme.axisStroke} fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis stroke={chartTheme.axisStroke} fontSize={11} allowDecimals={false} tickLine={false} axisLine={false} />
                      <Tooltip content={<AttendanceChartTooltip />} cursor={{ fill: chartTheme.cursorFill }} />
                      <Bar dataKey="lateMinutesTotal" name="Total Late Minutes" fill="#FF9A65" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="lateCount" name="Late Staff" fill="#FF4634" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Working Hours Analysis & Department Breakdown */}
              <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <Clock className="w-4 h-4 text-[#FF6A33]" />
                  <h3 className="font-display text-sm font-semibold text-[#FFFFFF]">Department Attendance & Working Hours</h3>
                </div>
                <p className="text-xs text-[#A1A1AA] mb-4">
                  Average net hours (excluding lunch) vs {analyticsData.targetHours}h daily target
                </p>
                <div className="h-60 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={
                        analyticsData.deptStats.length > 0
                          ? analyticsData.deptStats.map((d) => ({ label: d.department, avgHours: d.avgHours }))
                          : analyticsData.dailySeries.map((d) => ({ label: d.date, avgHours: d.avgHours }))
                      }
                      margin={{ top: 6, right: 12, left: -16, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} vertical={false} />
                      <XAxis
                        dataKey="label"
                        stroke={chartTheme.axisStroke}
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis stroke={chartTheme.axisStroke} fontSize={11} tickLine={false} axisLine={false} />
                      <Tooltip content={<AttendanceChartTooltip suffix="h" />} cursor={{ fill: chartTheme.cursorFill }} />
                      <Bar dataKey="avgHours" name="Avg Net Hours" fill="#FF4634" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {subTab === 'calendar' && (
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <Calendar className="w-4 h-4 text-[#FF6A33]" />
            <h2 className="font-display text-base font-semibold text-[#FFFFFF]">Monthly Attendance Grid · {selectedMonth}</h2>
          </div>
          <div className="grid grid-cols-7 gap-2 text-center text-xs text-[#A1A1AA] mb-2">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
              <div key={d} className="py-1 font-medium">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-2">
            {calendarDays.map((cell, i) => {
              if (!cell.day) return <div key={`empty-${i}`} className="h-20 rounded-xl bg-[#0B0D12]/40" />;
              const dayRecords = attendance.filter((a) => a.date === cell.dateStr);
              const holiday = holidays.find((h) => h.date === cell.dateStr);
              const isOff = isWeeklyOffDate(cell.dateStr, sched.weeklyOffs);

              return (
                <div
                  key={cell.dateStr}
                  className={`h-20 p-2 rounded-xl border text-left flex flex-col justify-between ${
                    holiday
                      ? 'bg-[#FF4634]/15 border-[#FF4634]/40'
                      : isOff
                      ? 'bg-[#0B0D12]/60 border-[#292D36]/60'
                      : 'bg-[#0B0D12] border-[#292D36]'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono text-[#FFFFFF] tabular-nums">{cell.day}</span>
                    {isOff && <span className="text-[10px] text-[#A1A1AA]">Off</span>}
                  </div>
                  {holiday ? (
                    <div className="text-[10px] text-[#FF6A33] font-medium truncate">{holiday.name}</div>
                  ) : dayRecords.length > 0 ? (
                    <div className="text-[11px] font-mono text-emerald-400 tabular-nums">
                      {dayRecords.length} logged
                    </div>
                  ) : (
                    <div className="text-[10px] text-[#A1A1AA]/40">—</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {subTab === 'corrections' && (
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden">
          {attendanceCorrections.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#A1A1AA]">No attendance correction requests submitted.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                    <th className="px-4 py-3 text-left font-medium">Employee</th>
                    <th className="px-4 py-3 text-left font-medium">Date</th>
                    <th className="px-4 py-3 text-left font-medium">Requested Times</th>
                    <th className="px-4 py-3 text-left font-medium">Reason</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    {canApprove && <th className="px-4 py-3 text-right font-medium">Action</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#292D36]/70">
                  {attendanceCorrections.map((c) => (
                    <tr key={c.id} className="hover:bg-[#1B1F28]/60">
                      <td className="px-4 py-3 text-[#FFFFFF] font-medium">{c.employeeName}</td>
                      <td className="px-4 py-3 font-mono text-[#A1A1AA]">{c.date}</td>
                      <td className="px-4 py-3 font-mono text-[#A1A1AA]">
                        {c.requestedCheckIn.slice(11, 16)} – {c.requestedCheckOut ? c.requestedCheckOut.slice(11, 16) : '-'}
                      </td>
                      <td className="px-4 py-3 text-[#A1A1AA] max-w-xs truncate">{c.reason}</td>
                      <td className="px-4 py-3 capitalize font-medium">
                        <span className={c.status === 'approved' ? 'text-emerald-400' : c.status === 'rejected' ? 'text-rose-400' : 'text-amber-400'}>
                          {c.status}
                        </span>
                      </td>
                      {canApprove && (
                        <td className="px-4 py-3 text-right">
                          {c.status === 'pending' && (
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => reviewCorrection(c.id, 'approved')}
                                className="p-1.5 rounded-lg bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30"
                                title="Approve"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => reviewCorrection(c.id, 'rejected')}
                                className="p-1.5 rounded-lg bg-rose-600/20 text-rose-400 hover:bg-rose-600/30"
                                title="Reject"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {subTab === 'shifts' && (
        <div className="space-y-6">
          {shiftNotice && (
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs">
              {shiftNotice}
            </div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {isHR && (
              <div className="lg:col-span-4 space-y-4">
                <form onSubmit={handleCreateShiftTemplate} className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 space-y-3">
                  <h3 className="font-display text-sm font-semibold text-[#FFFFFF]">Create Shift Template</h3>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Morning Shift / UK Overlap"
                    value={shiftName}
                    onChange={(e) => setShiftName(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-xs text-[#FFFFFF]"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11px] text-[#A1A1AA] mb-1">Start</label>
                      <input type="time" value={shiftStart} onChange={(e) => setShiftStart(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-xs text-[#FFFFFF]" />
                    </div>
                    <div>
                      <label className="block text-[11px] text-[#A1A1AA] mb-1">End</label>
                      <input type="time" value={shiftEnd} onChange={(e) => setShiftEnd(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-xs text-[#FFFFFF]" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11px] text-[#A1A1AA] mb-1">Grace (min)</label>
                      <input type="number" min={0} max={120} value={shiftGrace} onChange={(e) => setShiftGrace(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-xs text-[#FFFFFF]" />
                    </div>
                    <div>
                      <label className="block text-[11px] text-[#A1A1AA] mb-1">Break (min)</label>
                      <input type="number" min={0} max={180} value={shiftBreak} onChange={(e) => setShiftBreak(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-xs text-[#FFFFFF]" />
                    </div>
                  </div>
                  <select value={shiftTimezone} onChange={(e) => setShiftTimezone(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-xs text-[#FFFFFF]">
                    {COMMON_TIMEZONES.map((tz) => (
                      <option key={tz} value={tz} className="bg-[#151922]">{tz}</option>
                    ))}
                  </select>
                  <button type="submit" className="ace-btn-primary w-full py-2 text-xs font-semibold rounded-xl">
                    Save Shift Template
                  </button>
                </form>

                <form onSubmit={handleAssignShift} className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 space-y-3">
                  <h3 className="font-display text-sm font-semibold text-[#FFFFFF]">Assign Employee to Roster</h3>
                  <select value={assignEmpId} onChange={(e) => setAssignEmpId(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-xs text-[#FFFFFF]">
                    <option value="">Select Employee</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id} className="bg-[#151922]">{emp.fullName} ({emp.departmentName})</option>
                    ))}
                  </select>
                  <select value={assignTemplateId} onChange={(e) => setAssignTemplateId(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-xs text-[#FFFFFF]">
                    <option value="">Select Shift Template</option>
                    {shiftTemplates.map((tpl) => (
                      <option key={tpl.id} value={tpl.id} className="bg-[#151922]">{tpl.name} ({tpl.startTime}–{tpl.endTime})</option>
                    ))}
                  </select>
                  <input type="date" value={assignFrom} onChange={(e) => setAssignFrom(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-xs text-[#FFFFFF]" />
                  <button type="submit" className="ace-btn-primary w-full py-2 text-xs font-semibold rounded-xl">
                    Assign Roster Shift
                  </button>
                </form>
              </div>
            )}

            <div className={`${isHR ? 'lg:col-span-8' : 'lg:col-span-12'} space-y-6`}>
              <div className="bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden">
                <div className="px-4 py-3 border-b border-[#292D36] text-xs font-semibold text-[#FFFFFF]">
                  Shift Templates
                </div>
                {shiftTemplates.length === 0 ? (
                  <div className="p-6 text-xs text-[#A1A1AA]">
                    No custom shift templates configured yet. Default office schedule applies ({formatMinutesAsClock12(sched.workStartTime)} – {formatMinutesAsClock12(sched.workEndTime)}).
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                          <th className="px-4 py-2.5 text-left font-medium">Shift</th>
                          <th className="px-4 py-2.5 text-left font-medium">Hours</th>
                          <th className="px-4 py-2.5 text-left font-medium">Timezone</th>
                          <th className="px-4 py-2.5 text-right font-medium">Grace / Break</th>
                          {isHR && <th className="px-4 py-2.5 text-right font-medium">Remove</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#292D36]/70">
                        {shiftTemplates.map((tpl) => (
                          <tr key={tpl.id}>
                            <td className="px-4 py-2.5 font-medium text-[#FFFFFF]">{tpl.name}</td>
                            <td className="px-4 py-2.5 font-mono text-[#FF6A33]">{tpl.startTime} – {tpl.endTime}</td>
                            <td className="px-4 py-2.5 font-mono text-[#A1A1AA]">{tpl.timezone}</td>
                            <td className="px-4 py-2.5 text-right font-mono text-[#A1A1AA]">{tpl.graceMinutes}m / {tpl.breakMinutes}m</td>
                            {isHR && (
                              <td className="px-4 py-2.5 text-right">
                                <button type="button" onClick={() => handleDeleteShiftTemplate(tpl.id)} className="text-[#A1A1AA] hover:text-rose-400">
                                  <Trash2 className="w-4 h-4 inline" />
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden">
                <div className="px-4 py-3 border-b border-[#292D36] text-xs font-semibold text-[#FFFFFF]">
                  Team Shift Roster
                </div>
                {shiftAssignments.length === 0 ? (
                  <div className="p-6 text-xs text-[#A1A1AA]">No individual shift assignments recorded.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                          <th className="px-4 py-2.5 text-left font-medium">Employee</th>
                          <th className="px-4 py-2.5 text-left font-medium">Shift</th>
                          <th className="px-4 py-2.5 text-left font-medium">Schedule</th>
                          <th className="px-4 py-2.5 text-left font-medium">Effective From</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#292D36]/70">
                        {shiftAssignments.map((sa) => (
                          <tr key={sa.id}>
                            <td className="px-4 py-2.5 font-medium text-[#FFFFFF]">{sa.employeeName}</td>
                            <td className="px-4 py-2.5 text-[#FF6A33] font-medium">{sa.shiftName}</td>
                            <td className="px-4 py-2.5 font-mono text-[#A1A1AA]">{sa.startTime} – {sa.endTime}</td>
                            <td className="px-4 py-2.5 font-mono text-[#A1A1AA]">{sa.effectiveFrom}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {subTab === 'holidays' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {isHR && (
            <form onSubmit={handleAddHoliday} className="lg:col-span-4 bg-[#151922] border border-[#292D36] rounded-2xl p-5 space-y-3 h-fit">
              <h3 className="font-display text-sm font-semibold text-[#FFFFFF]">Add Company Holiday</h3>
              <input
                type="text"
                required
                placeholder="Holiday Name"
                value={holName}
                onChange={(e) => setHolName(e.target.value)}
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-xs text-[#FFFFFF]"
              />
              <input
                type="date"
                required
                value={holDate}
                onChange={(e) => setHolDate(e.target.value)}
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-xs text-[#FFFFFF]"
              />
              <select
                value={holType}
                onChange={(e) => setHolType(e.target.value as Holiday['type'])}
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-xs text-[#FFFFFF]"
              >
                <option value="public" className="bg-[#151922]">Public Holiday</option>
                <option value="company" className="bg-[#151922]">Company Holiday</option>
                <option value="optional" className="bg-[#151922]">Optional Holiday</option>
              </select>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  maxLength={3}
                  placeholder="Country (e.g. IN)"
                  value={holCountry}
                  onChange={(e) => setHolCountry(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-xs text-[#FFFFFF]"
                />
                <input
                  type="text"
                  placeholder="Location / Office"
                  value={holLocation}
                  onChange={(e) => setHolLocation(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-xs text-[#FFFFFF]"
                />
              </div>
              <input
                type="text"
                placeholder="Description (optional)"
                value={holDesc}
                onChange={(e) => setHolDesc(e.target.value)}
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-xs text-[#FFFFFF]"
              />
              <button type="submit" className="ace-btn-primary w-full py-2 text-xs font-semibold rounded-xl">
                Save Holiday
              </button>
            </form>
          )}
          <div className={`${isHR ? 'lg:col-span-8' : 'lg:col-span-12'} bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden`}>
            <div className="px-4 py-3 border-b border-[#292D36] flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-[#FFFFFF]">Holiday Schedule</span>
              <select
                value={holCountryFilter}
                onChange={(e) => setHolCountryFilter(e.target.value)}
                className="px-2.5 py-1 bg-[#0B0D12] border border-[#292D36] rounded-lg text-xs text-[#FFFFFF]"
              >
                <option value="all">All Countries</option>
                {Array.from(new Set(holidays.map((h) => h.countryCode).filter(Boolean))).map((code) => (
                  <option key={code} value={code}>{code}</option>
                ))}
              </select>
            </div>
            {holidays.length === 0 ? (
              <div className="p-8 text-center text-sm text-[#A1A1AA]">No holidays scheduled yet.</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                    <th className="px-4 py-3 text-left font-medium">Date</th>
                    <th className="px-4 py-3 text-left font-medium">Holiday</th>
                    <th className="px-4 py-3 text-left font-medium">Type</th>
                    <th className="px-4 py-3 text-left font-medium">Country / Location</th>
                    {isHR && <th className="px-4 py-3 text-right font-medium">Remove</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#292D36]/70">
                  {[...holidays]
                    .filter((h) => holCountryFilter === 'all' || h.countryCode === holCountryFilter)
                    .sort((a, b) => a.date.localeCompare(b.date))
                    .map((h) => (
                    <tr key={h.id}>
                      <td className="px-4 py-3 font-mono text-[#A1A1AA]">{h.date}</td>
                      <td className="px-4 py-3 text-[#FFFFFF] font-medium">{h.name}</td>
                      <td className="px-4 py-3 capitalize text-[#FF6A33] font-medium">{h.type}</td>
                      <td className="px-4 py-3 text-[#A1A1AA]">{[h.countryCode, h.location].filter(Boolean).join(' · ') || 'All locations'}</td>
                      {isHR && (
                        <td className="px-4 py-3 text-right">
                          <button type="button" onClick={() => deleteHoliday(h.id)} className="text-[#A1A1AA] hover:text-rose-400">
                            <Trash2 className="w-4 h-4 inline" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Correction Request Modal */}
      {showCorrModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setShowCorrModal(false)} />
          <form onSubmit={submitCorrection} className="relative z-10 w-full max-w-md bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-display text-base font-bold text-[#FFFFFF]">Request Attendance Correction</h3>
              <span className="font-mono text-[11px] px-2 py-0.5 rounded-lg bg-[#1B1F28] border border-[#292D36] text-[#FF6A33]">
                {myMonthlyCorrectionsCount} / 3 this month
              </span>
            </div>
            <div>
              <label className="block text-[#A1A1AA] mb-1">Date</label>
              <input type="date" required value={corrDate} onChange={(e) => setCorrDate(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-[#A1A1AA] mb-1">Check In</label>
                <input type="time" required value={corrIn} onChange={(e) => setCorrIn(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Check Out</label>
                <input type="time" required value={corrOut} onChange={(e) => setCorrOut(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Lunch (min)</label>
                <input type="number" min={0} value={corrBreak} onChange={(e) => setCorrBreak(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-[#D4D4D8] mb-1">Reason (required, at least 10 characters)</label>
              <textarea required minLength={10} rows={3} value={corrReason} onChange={(e) => setCorrReason(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
            </div>
            {corrError && (
              <div role="alert" className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
                {corrError}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowCorrModal(false)} className="px-4 py-2 border border-[#292D36] bg-[#1B1F28] rounded-xl text-[#A1A1AA] hover:text-[#FFFFFF]">Cancel</button>
              <button type="submit" disabled={myMonthlyCorrectionsCount >= 3} className="ace-btn-primary px-4 py-2 font-semibold rounded-xl disabled:opacity-50">Submit Request</button>
            </div>
          </form>
        </div>
      )}

      {/* HR Manual Mark Attendance Modal */}
      {showMarkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setShowMarkModal(false)} />
          <form onSubmit={handleMarkAttendance} className="relative z-10 w-full max-w-md bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs">
            <h3 className="font-display text-base font-bold text-[#FFFFFF]">Mark Employee Attendance</h3>
            <div>
              <label className="block text-[#A1A1AA] mb-1">Employee</label>
              <select value={markEmpId} onChange={(e) => setMarkEmpId(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]">
                {employees.map((e) => (
                  <option key={e.id} value={e.id} className="bg-[#151922]">{e.fullName} ({e.employeeCode})</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[#A1A1AA] mb-1">Date</label>
                <input type="date" required value={markDate} onChange={(e) => setMarkDate(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]" />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Status</label>
                <select value={markStatus} onChange={(e) => setMarkStatus(e.target.value as AttendanceStatus)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]">
                  <option value="present" className="bg-[#151922]">Full Day Present</option>
                  <option value="half_day" className="bg-[#151922]">Half Day</option>
                  <option value="late" className="bg-[#151922]">Late Arrival</option>
                  <option value="early_departure" className="bg-[#151922]">Early Departure</option>
                  <option value="absent" className="bg-[#151922]">Absent</option>
                  <option value="weekly_off" className="bg-[#151922]">Weekly Off</option>
                  <option value="holiday" className="bg-[#151922]">Holiday</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-[#A1A1AA] mb-1">Notes</label>
              <input type="text" value={markNotes} onChange={(e) => setMarkNotes(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]" />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowMarkModal(false)} className="px-4 py-2 border border-[#292D36] bg-[#1B1F28] rounded-xl text-[#A1A1AA] hover:text-[#FFFFFF]">Cancel</button>
              <button type="submit" className="ace-btn-primary px-4 py-2 font-semibold rounded-xl">Save Entry</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
