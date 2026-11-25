import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Coffee,
  FileEdit,
  LogIn,
  LogOut,
  Play,
  RefreshCw,
} from 'lucide-react';
import { db } from '../../firebase';
import { apiRequest, isIamBlockedError, makeId } from '../../services/hrmsApi';
import { useAuth } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import {
  computeShiftWorkingStats,
  formatDurationMinutes,
  formatDurationSeconds,
  formatMinutesAsClock12,
  formatTimeInZone,
  getOfficeNowParts,
  getScheduleMetrics,
  isWeeklyOffDate,
  parseHHMMToMinutes,
  resolveCheckoutStatus,
} from '../../utils/attendanceUtils';

interface AttendanceCheckInWidgetProps {
  compact?: boolean;
  onRequestCorrection?: () => void;
}

export const AttendanceCheckInWidget: React.FC<AttendanceCheckInWidgetProps> = ({
  compact = false,
  onRequestCorrection,
}) => {
  const { firebaseUser, employeeProfile, roleAssignment } = useAuth();
  const { attendance, workPolicy, leaveRequests } = useHrmsData();

  const [now, setNow] = useState<Date>(() => new Date());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [serverClockReady, setServerClockReady] = useState(false);
  const [syncingClock, setSyncingClock] = useState(false);
  const [breakSessions, setBreakSessions] = useState<
    Array<{ id: string; type: string; startAt: string; endAt?: string; status: string; reviewRequired?: boolean }>
  >([]);
  const [meetingSessions, setMeetingSessions] = useState<
    Array<{ id: string; type: string; withWhom: string; purpose: string; startAt: string; endAt?: string; status: string }>
  >([]);
  const [monitoringStatus, setMonitoringStatus] = useState<{ state?: string; lastHeartbeat?: string } | null>(null);
  const serverClockRef = useRef<{ serverMs: number; perfMs: number } | null>(null);

  const syncServerClock = useCallback(async () => {
    setSyncingClock(true);
    const beforePerf = performance.now();
    try {
      const response = await fetch('/api/time', { cache: 'no-store' });
      if (!response.ok) throw new Error('Clock sync failed');
      const payload = (await response.json()) as { timestamp: string };
      const afterPerf = performance.now();
      const serverMs = new Date(payload.timestamp).getTime();
      if (Number.isFinite(serverMs)) {
        const syncedMs = serverMs + (afterPerf - beforePerf) / 2;
        serverClockRef.current = { serverMs: syncedMs, perfMs: afterPerf };
        setNow(new Date(syncedMs));
        setServerClockReady(true);
        setActionError((prev) =>
          prev && prev.includes('server clock') ? null : prev,
        );
      }
    } catch {
      setActionError('Unable to sync the server clock. Retry clock sync to enable attendance actions.');
    } finally {
      setSyncingClock(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const runSync = async () => {
      if (!active) return;
      await syncServerClock();
    };
    void runSync();
    const interval = window.setInterval(() => {
      if (active) void syncServerClock();
    }, 60000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [syncServerClock]);

  const getTrustedNow = () => {
    const base = serverClockRef.current;
    return base ? new Date(base.serverMs + (performance.now() - base.perfMs)) : new Date();
  };

  useEffect(() => {
    const timer = setInterval(() => setNow(getTrustedNow()), 1000);
    return () => clearInterval(timer);
  }, []);

  const uid = firebaseUser?.uid || '';
  const employeePolicy = {
    ...workPolicy,
    workStartTime: employeeProfile?.shiftStartTime || workPolicy.workStartTime,
    workEndTime: employeeProfile?.shiftEndTime || workPolicy.workEndTime,
    officeTimezone: employeeProfile?.timezone || workPolicy.officeTimezone,
  };
  const sched = getScheduleMetrics(employeePolicy);
  const nowParts = getOfficeNowParts(now, sched.officeTimezone);
  const today = nowParts.dateStr;
  const isWeeklyOff = isWeeklyOffDate(today, sched.weeklyOffs);

  useEffect(() => {
    if (!uid || !today) return;
    const q = query(collection(db, 'breakSessions'), where('uid', '==', uid));
    const qMeetings = query(collection(db, 'meetingLogs'), where('uid', '==', uid));
    const unsubBreaks = onSnapshot(q, (snap) =>
      setBreakSessions(
        snap.docs
          .filter((d) => d.data().date === today)
          .map((d) => ({ id: d.id, ...(d.data() as Omit<(typeof breakSessions)[number], 'id'>) })),
      ),
    );
    const unsubMeetings = onSnapshot(qMeetings, (snap) =>
      setMeetingSessions(
        snap.docs
          .filter((d) => d.data().date === today)
          .map((d) => ({ id: d.id, ...(d.data() as Omit<(typeof meetingSessions)[number], 'id'>) })),
      ),
    );
    return () => {
      unsubBreaks();
      unsubMeetings();
    };
  }, [uid, today]);

  const halfDayLeaveApproved = leaveRequests.some(
    (leave) =>
      leave.uid === uid &&
      leave.status === 'approved' &&
      leave.startDate <= today &&
      leave.endDate >= today &&
      (leave.dayPart === 'first_half' || leave.dayPart === 'second_half'),
  );
  const netTargetMinutes = halfDayLeaveApproved
    ? Math.ceil(sched.netWorkingTargetMinutes / 2)
    : sched.netWorkingTargetMinutes;

  useEffect(() => {
    if (!uid) {
      setMonitoringStatus(null);
      return;
    }
    return onSnapshot(
      doc(db, 'monitoringAgentStatus', uid),
      (snap) => setMonitoringStatus(snap.exists() ? (snap.data() as { state?: string; lastHeartbeat?: string }) : null),
      () => setMonitoringStatus(null),
    );
  }, [uid]);

  const myToday = attendance.find((a) => a.uid === uid && a.date === today);
  const activeBreak = breakSessions.find((b) => b.status === 'active');
  const activeMeeting = meetingSessions.find((m) => m.status === 'active');

  const stats = computeShiftWorkingStats({
    record: myToday,
    now,
    policy: employeePolicy,
  });
  const hasLunchSession = breakSessions.some((b) => b.type === 'Lunch');
  const breakSecondsFromSessions = breakSessions.reduce((sum, b) => {
    const start = new Date(b.startAt).getTime();
    const end = b.endAt ? new Date(b.endAt).getTime() : b.status === 'active' ? now.getTime() : start;
    return sum + (Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1000)) : 0);
  }, 0);
  const allBreakSeconds = breakSessions.length
    ? breakSecondsFromSessions + (hasLunchSession ? 0 : stats.lunchDeductedSeconds)
    : stats.lunchDeductedSeconds;
  const netWorkingSeconds = Math.max(0, stats.elapsedTotalSeconds - allBreakSeconds);
  const remainingWorkingSeconds = Math.max(0, netTargetMinutes * 60 - netWorkingSeconds);
  const progressPercent =
    netTargetMinutes > 0 ? Math.min(100, Math.round((netWorkingSeconds / (netTargetMinutes * 60)) * 100)) : 0;
  const projectedFinish =
    myToday && !myToday.checkOutTime
      ? formatTimeInZone(new Date(now.getTime() + remainingWorkingSeconds * 1000).toISOString(), sched.officeTimezone)
      : myToday?.checkOutTime
      ? 'Shift completed'
      : 'Available after check-in';
  const currentPhase = activeBreak ? 'on_break' : stats.phase;
  const monitoringHeartbeatFresh = Boolean(
    monitoringStatus?.lastHeartbeat && now.getTime() - new Date(monitoringStatus.lastHeartbeat).getTime() < 120000,
  );

  const clientCheckInFallback = async () => {
    const trustedNow = getTrustedNow();
    const parts = getOfficeNowParts(trustedNow, sched.officeTimezone);
    const date = parts.dateStr;
    const recordId = `${uid}_${date}`;
    const startMinutes = parseHHMMToMinutes(sched.workStartTime);
    const graceMinutes = Number(sched.graceMinutes ?? 15);
    const lateMinutes = Math.max(0, parts.minutesSinceMidnight - startMinutes - graceMinutes);
    const priorLateMarks = attendance.filter(
      (rec) => rec.uid === uid && rec.date < date && rec.date.slice(0, 7) === date.slice(0, 7) && rec.isLate === true,
    ).length;
    const lateMarkCount = lateMinutes > 0 ? priorLateMarks + 1 : priorLateMarks;
    const lateMarksThreshold = Math.max(1, Number(employeePolicy.lateMarksThreshold ?? 3));
    const latePenaltyReached = lateMinutes > 0 && lateMarkCount >= lateMarksThreshold;
    const lateMarksAction = employeePolicy.lateMarksAction === 'lop' ? 'lop' : 'half_day';
    const status =
      latePenaltyReached && lateMarksAction === 'half_day' ? 'half_day' : lateMinutes > 0 ? 'late' : 'present';
    const latePenaltyDays = latePenaltyReached ? 0.5 : 0;
    const notes = latePenaltyReached
      ? `Late mark threshold (${lateMarksThreshold}) reached; ${lateMarksAction === 'lop' ? '0.5 LOP day' : 'half-day'} applied.`
      : '';

    const recordRef = doc(db, 'attendance', recordId);
    await runTransaction(db, async (tx) => {
      const existingSnap = await tx.get(recordRef);
      if (existingSnap.exists()) throw new Error('You are already checked in for today.');
      if (activeBreak) throw new Error('An active break exists. End it before checking in.');
      tx.set(recordRef, {
        id: recordId,
        uid,
        employeeId: employeeProfile?.id || uid,
        employeeName: employeeProfile?.fullName || firebaseUser?.displayName || 'Employee',
        departmentId: employeeProfile?.departmentId || roleAssignment?.departmentId || 'unassigned',
        date,
        checkInTime: trustedNow.toISOString(),
        checkOutTime: '',
        lunchStartTime: '',
        lunchEndTime: '',
        actualLunchMinutes: 0,
        breakMinutes: 0,
        workingMinutes: 0,
        lateMinutes,
        latePenaltyDays,
        earlyDepartureMinutes: 0,
        officeTimezone: sched.officeTimezone,
        status,
        isLate: lateMinutes > 0,
        isEarlyDeparture: false,
        notes,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });
  };

  const clientCheckOutFallback = async () => {
    if (!myToday) throw new Error('Check in before checking out.');
    if (activeBreak) throw new Error('End your active break before checking out.');
    const trustedNow = getTrustedNow();
    const parts = getOfficeNowParts(trustedNow, sched.officeTimezone);
    const date = myToday.date || parts.dateStr;

    if (employeePolicy.requireDailyWorkReportBeforeCheckout === true) {
      const reportSnap = await getDocs(query(collection(db, 'dailyWorkReports'), where('uid', '==', uid)));
      const hasReport = reportSnap.docs.some(
        (d) =>
          d.data().date === date &&
          ['submitted', 'approved'].includes(String(d.data().reviewStatus)),
      );
      if (!hasReport) {
        throw new Error('Submit your daily work report before checking out. Your company policy requires it.');
      }
    }

    const recordRef = doc(db, 'attendance', myToday.id);
    const endMinutes = parseHHMMToMinutes(sched.workEndTime);
    const halfDayBase = Number(sched.halfDayThresholdMinutes ?? 270);
    const halfDayThreshold = halfDayLeaveApproved ? Math.ceil(halfDayBase / 2) : halfDayBase;

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(recordRef);
      if (!snap.exists()) throw new Error('Check in before checking out.');
      const data = snap.data();
      if (data.checkOutTime) throw new Error('You are already checked out.');
      const checkIn = new Date(String(data.checkInTime || ''));
      if (!Number.isFinite(checkIn.getTime()) || trustedNow <= checkIn) {
        throw new Error('Invalid check-in timestamp.');
      }
      const completed = breakSessions.filter((b) => b.endAt && b.startAt);
      const breakMinsFromSessions = completed.reduce(
        (sum, b) =>
          sum +
          Math.max(
            0,
            Math.round((new Date(String(b.endAt)).getTime() - new Date(String(b.startAt)).getTime()) / 60000),
          ),
        0,
      );
      const legacyLunch = hasLunchSession ? 0 : Number(data.actualLunchMinutes || 0);
      const elapsedMinutes = Math.max(0, Math.round((trustedNow.getTime() - checkIn.getTime()) / 60000));
      const breakMinutes = Math.min(elapsedMinutes, breakMinsFromSessions + legacyLunch);
      const workingMinutes = Math.max(0, elapsedMinutes - breakMinutes);
      const earlyDepartureMinutes = Math.max(0, endMinutes - parts.minutesSinceMidnight);
      const isEarlyDeparture = earlyDepartureMinutes > 0;
      const status = resolveCheckoutStatus({
        currentStatus: String(data.status || 'present'),
        workingMinutes,
        halfDayThreshold,
        isEarlyDeparture,
      });

      tx.update(recordRef, {
        checkOutTime: trustedNow.toISOString(),
        breakMinutes,
        workingMinutes,
        isEarlyDeparture,
        earlyDepartureMinutes,
        officeTimezone: sched.officeTimezone,
        status,
        updatedAt: serverTimestamp(),
      });
    });
  };

  const clientStartBreakFallback = async (type: 'Lunch' | 'Tea/Short' | 'Personal') => {
    if (!myToday || myToday.checkOutTime) throw new Error('Check in before starting a break.');
    if (activeBreak) throw new Error('You already have an active break.');
    if (activeMeeting) throw new Error('End your active meeting before starting a break.');
    const trustedNow = getTrustedNow();
    const parts = getOfficeNowParts(trustedNow, sched.officeTimezone);
    const id = makeId('brk');
    await setDoc(doc(db, 'breakSessions', id), {
      id,
      uid,
      employeeName: employeeProfile?.fullName || firebaseUser?.displayName || 'Employee',
      departmentId: employeeProfile?.departmentId || roleAssignment?.departmentId || 'unassigned',
      date: parts.dateStr,
      type,
      startAt: trustedNow.toISOString(),
      status: 'active',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  };

  const clientEndBreakFallback = async () => {
    if (!activeBreak) throw new Error('There is no active break.');
    const trustedNow = getTrustedNow();
    await updateDoc(doc(db, 'breakSessions', activeBreak.id), {
      endAt: trustedNow.toISOString(),
      status: 'ended',
      updatedAt: serverTimestamp(),
    });
  };

  const handleCheckIn = async () => {
    if (!firebaseUser || myToday || busy) return;
    if (!serverClockReady) {
      await syncServerClock();
      if (!serverClockRef.current) {
        setActionError('Server clock is unavailable. Retry clock sync before checking in.');
        return;
      }
    }
    setBusy(true);
    setActionError(null);
    setActionNotice(null);
    try {
      await apiRequest('/api/attendance/check-in', { method: 'POST', body: JSON.stringify({}) });
      setActionNotice('Checked in successfully.');
    } catch (err) {
      if (isIamBlockedError(err)) {
        try {
          await clientCheckInFallback();
          setActionNotice('Checked in successfully.');
          return;
        } catch (fbErr) {
          setActionError(fbErr instanceof Error ? fbErr.message : 'Unable to record check-in.');
          return;
        }
      }
      setActionError(err instanceof Error ? err.message : 'Unable to record check-in.');
    } finally {
      setBusy(false);
    }
  };

  const handleCheckOut = async () => {
    if (!firebaseUser || !myToday || myToday.checkOutTime || busy) return;
    if (activeBreak) {
      setActionError('End your active break before checking out.');
      return;
    }
    if (activeMeeting) {
      setActionError('End your active meeting before checking out.');
      return;
    }
    if (!serverClockReady) {
      await syncServerClock();
      if (!serverClockRef.current) {
        setActionError('Server clock is unavailable. Retry clock sync before checking out.');
        return;
      }
    }
    setBusy(true);
    setActionError(null);
    setActionNotice(null);
    try {
      await apiRequest('/api/attendance/check-out', { method: 'POST', body: JSON.stringify({}) });
      setActionNotice('Shift completed and check-out recorded.');
    } catch (err) {
      if (isIamBlockedError(err)) {
        try {
          await clientCheckOutFallback();
          setActionNotice('Shift completed and check-out recorded.');
          return;
        } catch (fbErr) {
          setActionError(fbErr instanceof Error ? fbErr.message : 'Unable to complete check-out.');
          return;
        }
      }
      setActionError(err instanceof Error ? err.message : 'Unable to complete check-out.');
    } finally {
      setBusy(false);
    }
  };

  const handleStartBreak = async (type: 'Lunch' | 'Tea/Short' | 'Personal') => {
    if (!firebaseUser || !myToday || myToday.checkOutTime || activeBreak || busy) return;
    if (activeMeeting) {
      setActionError('End your active meeting before starting a break.');
      return;
    }
    setBusy(true);
    setActionError(null);
    setActionNotice(null);
    try {
      await apiRequest('/api/attendance/break-start', {
        method: 'POST',
        body: JSON.stringify({ type }),
      });
      setActionNotice(`${type} break started.`);
    } catch (err) {
      if (isIamBlockedError(err)) {
        try {
          await clientStartBreakFallback(type);
          setActionNotice(`${type} break started.`);
          return;
        } catch (fbErr) {
          setActionError(fbErr instanceof Error ? fbErr.message : 'Unable to start break.');
          return;
        }
      }
      setActionError(err instanceof Error ? err.message : 'Unable to start break.');
    } finally {
      setBusy(false);
    }
  };

  const handleEndBreak = async () => {
    if (!firebaseUser || !activeBreak || busy) return;
    setBusy(true);
    setActionError(null);
    setActionNotice(null);
    try {
      await apiRequest('/api/attendance/break-end', { method: 'POST', body: JSON.stringify({}) });
      setActionNotice('Break ended and work timer resumed.');
    } catch (err) {
      if (isIamBlockedError(err)) {
        try {
          await clientEndBreakFallback();
          setActionNotice('Break ended and work timer resumed.');
          return;
        } catch (fbErr) {
          setActionError(fbErr instanceof Error ? fbErr.message : 'Unable to end break.');
          return;
        }
      }
      setActionError(err instanceof Error ? err.message : 'Unable to end break.');
    } finally {
      setBusy(false);
    }
  };

  const statusBadge = (() => {
    if (!myToday && isWeeklyOff) {
      return { label: 'Weekly Off', cls: 'bg-[#FF6A33]/10 border-[#FF6A33]/30 text-[#FF9A65]' };
    }
    if (!myToday) {
      return {
        label: 'Not Checked In',
        cls: 'bg-[#1B1F28] border-[#292D36] text-[#A1A1AA]',
      };
    }
    if (currentPhase === 'on_lunch' || currentPhase === 'on_break') {
      return {
        label: activeBreak ? `On ${activeBreak.type} Break` : 'On Lunch Break',
        cls: 'bg-amber-500/15 border-amber-500/35 text-amber-300',
      };
    }
    if (myToday.status === 'absent') {
      return {
        label: 'Absent',
        cls: 'bg-rose-500/15 border-rose-500/35 text-rose-300',
      };
    }
    if (myToday.isLate || myToday.status === 'late') {
      return {
        label: myToday.checkOutTime ? 'Late · Completed' : 'Late · Checked In',
        cls: 'bg-amber-500/15 border-amber-500/35 text-amber-300',
      };
    }
    if (myToday.status === 'early_departure' || myToday.status === 'half_day') {
      return {
        label: myToday.status === 'half_day' ? 'Half Day' : 'Early Departure',
        cls: 'bg-amber-500/15 border-amber-500/35 text-amber-300',
      };
    }
    return {
      label: myToday.checkOutTime ? 'Present · Completed' : 'Present · Working',
      cls: 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300',
    };
  })();

  const officeDurationLabel = formatDurationMinutes(sched.totalOfficeMinutes);
  const netTargetLabel = formatDurationMinutes(netTargetMinutes);
  const lunchBreakSession = breakSessions.find((b) => b.type === 'Lunch');

  return (
    <section className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 sm:p-6 shadow-lg shadow-black/25">
      {/* Top Row: Live Time + Status + Prominent Actions */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5 pb-5 border-b border-[#292D36]">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[#FF6A33]">
              <Clock className="w-3.5 h-3.5" />
              Live Office Clock
            </span>
            <span className={`px-2.5 py-0.5 rounded-lg border text-[11px] font-semibold ${statusBadge.cls}`}>
              {statusBadge.label}
            </span>
            <span className="text-[11px] font-mono text-[#A1A1AA] bg-[#1B1F28] border border-[#292D36] px-2 py-0.5 rounded-lg">
              {sched.officeTimezone}
            </span>
          </div>

          <div className="flex flex-wrap items-baseline gap-3">
            <span className="font-mono text-3xl sm:text-4xl font-bold text-[#FFFFFF] tabular-nums tracking-tight">
              {nowParts.displayTime}
            </span>
            <span className="text-sm text-[#A1A1AA] font-medium">{nowParts.displayDate}</span>
          </div>

          <p className="text-xs text-[#A1A1AA]">
            Office Schedule:{' '}
            <span className="text-[#FFFFFF] font-medium">
              {formatMinutesAsClock12(sched.workStartTime)} – {formatMinutesAsClock12(sched.workEndTime)}
            </span>{' '}
            ({officeDurationLabel}) · Lunch:{' '}
            <span className="text-[#FFFFFF] font-medium">
              {formatMinutesAsClock12(sched.lunchStartTime)} – {formatMinutesAsClock12(sched.lunchEndTime)}
            </span>{' '}
            ({sched.scheduledLunchMinutes}m) · Net Target:{' '}
            <span className="text-[#FF6A33] font-semibold">{netTargetLabel}</span>
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {!myToday && (
            <button
              type="button"
              onClick={() => void handleCheckIn()}
              disabled={busy || isWeeklyOff}
              className="ace-btn-primary px-6 py-3.5 rounded-xl text-sm font-semibold inline-flex items-center gap-2.5 disabled:opacity-60 whitespace-nowrap"
            >
              <LogIn className="w-4 h-4" />
              {isWeeklyOff ? 'Weekly Off' : busy ? 'Recording Check-In...' : 'Check In Now'}
            </button>
          )}

          {myToday && !myToday.checkOutTime && (
            <>
              {activeBreak ? (
                <button
                  type="button"
                  onClick={() => void handleEndBreak()}
                  disabled={busy}
                  className="px-4 py-3 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-60 whitespace-nowrap"
                >
                  <Play className="w-3.5 h-3.5" />
                  {busy ? 'Ending Break...' : `End ${activeBreak.type} Break`}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void handleStartBreak('Lunch')}
                    disabled={busy || Boolean(activeMeeting)}
                    className="px-3.5 py-3 rounded-xl bg-[#1B1F28] hover:bg-[#232834] border border-[#292D36] text-[#FFFFFF] text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50 whitespace-nowrap"
                  >
                    <Coffee className="w-3.5 h-3.5 text-[#FF6A33]" />
                    Lunch Break
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleStartBreak('Tea/Short')}
                    disabled={busy || Boolean(activeMeeting)}
                    className="px-3.5 py-3 rounded-xl bg-[#1B1F28] hover:bg-[#232834] border border-[#292D36] text-[#D4D4D8] text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50 whitespace-nowrap"
                  >
                    <Coffee className="w-3.5 h-3.5 text-amber-400" />
                    Short Break
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={() => void handleCheckOut()}
                disabled={busy || Boolean(activeBreak) || Boolean(activeMeeting)}
                title={
                  activeBreak
                    ? 'End your active break before checking out'
                    : activeMeeting
                    ? 'End your active meeting before checking out'
                    : 'Record shift check-out'
                }
                className="ace-btn-primary px-5 py-3 rounded-xl text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-50 whitespace-nowrap"
              >
                <LogOut className="w-4 h-4" />
                {busy ? 'Recording Check-Out...' : 'Check Out'}
              </button>
            </>
          )}

          {myToday && myToday.checkOutTime && (
            <div className="inline-flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-semibold">
              <CheckCircle2 className="w-4 h-4" />
              Shift Completed · {formatDurationMinutes(myToday.workingMinutes)} Net
            </div>
          )}

          {onRequestCorrection && (
            <button
              type="button"
              onClick={onRequestCorrection}
              className="px-3.5 py-3 rounded-xl bg-[#1B1F28] hover:bg-[#232834] border border-[#292D36] text-[#A1A1AA] hover:text-[#FFFFFF] text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
            >
              <FileEdit className="w-3.5 h-3.5" />
              Fix Missed Entry
            </button>
          )}
        </div>
      </div>

      {actionNotice && (
        <div className="mt-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{actionNotice}</span>
        </div>
      )}

      {actionError && (
        <div
          role="alert"
          className="mt-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{actionError}</span>
          </div>
          {!serverClockReady && (
            <button
              type="button"
              disabled={syncingClock}
              onClick={() => void syncServerClock()}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#151922] border border-[#292D36] text-[#FFFFFF] hover:border-[#FF4634] shrink-0"
            >
              <RefreshCw className={`w-3 h-3 ${syncingClock ? 'animate-spin' : ''}`} />
              Retry Clock Sync
            </button>
          )}
        </div>
      )}

      {/* Attendance timeline: check-in, lunch, resume and check-out */}
      <div className="mt-5 rounded-2xl border border-[#292D36] bg-[#0B0D12]/70 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <div className="text-sm font-semibold text-[#FFFFFF]">Today’s Attendance Timeline</div>
            <div className="text-[11px] text-[#A1A1AA] mt-0.5">Your office day at a glance</div>
          </div>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#FF6A33]">
            {isWeeklyOff
              ? 'Weekly off'
              : `${formatMinutesAsClock12(sched.workStartTime)} – ${formatMinutesAsClock12(sched.workEndTime)}`}
          </span>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            {
              label: 'Check In',
              time: formatTimeInZone(myToday?.checkInTime, sched.officeTimezone),
              done: Boolean(myToday?.checkInTime),
              icon: LogIn,
            },
            {
              label: 'Lunch Break',
              time: lunchBreakSession
                ? `${formatTimeInZone(lunchBreakSession.startAt, sched.officeTimezone)} – ${
                    lunchBreakSession.endAt
                      ? formatTimeInZone(lunchBreakSession.endAt, sched.officeTimezone)
                      : 'In progress'
                  }`
                : myToday?.lunchStartTime
                ? `${formatTimeInZone(myToday.lunchStartTime, sched.officeTimezone)} – ${
                    myToday.lunchEndTime
                      ? formatTimeInZone(myToday.lunchEndTime, sched.officeTimezone)
                      : 'In progress'
                  }`
                : `${formatMinutesAsClock12(sched.lunchStartTime)} – ${formatMinutesAsClock12(sched.lunchEndTime)}`,
              done: Boolean(lunchBreakSession?.endAt || myToday?.lunchEndTime),
              icon: Coffee,
            },
            {
              label: 'Resume Work',
              time: formatTimeInZone(lunchBreakSession?.endAt || myToday?.lunchEndTime, sched.officeTimezone),
              done: Boolean(lunchBreakSession?.endAt || myToday?.lunchEndTime),
              icon: Play,
            },
            {
              label: 'Check Out',
              time: formatTimeInZone(myToday?.checkOutTime, sched.officeTimezone),
              done: Boolean(myToday?.checkOutTime),
              icon: LogOut,
            },
          ].map((step, index) => {
            const Icon = step.icon;
            return (
              <div
                key={step.label}
                className={`rounded-xl border p-3 ${
                  step.done ? 'border-[#FF6A33]/40 bg-[#FF6A33]/[.07]' : 'border-[#292D36] bg-[#151922]'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`w-7 h-7 rounded-lg grid place-items-center ${
                      step.done ? 'bg-[#FF6A33]/15 text-[#FF6A33]' : 'bg-[#292D36] text-[#A1A1AA]'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-semibold text-[#FFFFFF]">{step.label}</span>
                </div>
                <div className="text-xs font-mono text-[#A1A1AA] mt-2 tabular-nums">{step.time || '—'}</div>
                <div className={`text-[10px] mt-1 ${step.done ? 'text-[#FF8B5B]' : 'text-[#777D88]'}`}>
                  {step.done ? 'Recorded' : index === 1 ? 'Scheduled' : 'Awaiting'}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Metrics Grid */}
      <div
        className={`grid gap-3 mt-5 ${
          compact ? 'grid-cols-2 sm:grid-cols-4 xl:grid-cols-6' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8'
        }`}
      >
        <div className="p-3.5 rounded-xl bg-[#1B1F28] border border-[#292D36]">
          <div className="text-sm font-medium text-[#D4D4D8]">Check-In Time</div>
          <div className="font-mono text-sm font-semibold text-[#FFFFFF] mt-1 tabular-nums">
            {formatTimeInZone(myToday?.checkInTime, sched.officeTimezone)}
          </div>
        </div>

        <div className="p-3.5 rounded-xl bg-[#1B1F28] border border-[#292D36]">
          <div className="text-[11px] text-[#A1A1AA]">Lunch Schedule</div>
          <div className="font-mono text-sm font-semibold text-[#FFFFFF] mt-1 tabular-nums">
            {formatMinutesAsClock12(sched.lunchStartTime).replace(' PM', '')}–{formatMinutesAsClock12(sched.lunchEndTime)}
          </div>
        </div>

        <div className="p-3.5 rounded-xl bg-[#1B1F28] border border-[#292D36]">
          <div className="text-sm font-medium text-[#D4D4D8]">Break Deducted</div>
          <div className="font-mono text-sm font-semibold text-[#FFFFFF] mt-1 tabular-nums">
            {`${Math.round(allBreakSeconds / 60)}m`}
          </div>
        </div>

        <div className="p-3.5 rounded-xl bg-[#1B1F28] border border-[#292D36]">
          <div className="text-[11px] text-[#A1A1AA]">Check-Out Time</div>
          <div className="font-mono text-sm font-semibold text-[#FFFFFF] mt-1 tabular-nums">
            {formatTimeInZone(myToday?.checkOutTime, sched.officeTimezone)}
          </div>
        </div>

        <div className="p-3.5 rounded-xl bg-[#1B1F28] border border-[#292D36]">
          <div className="text-[11px] text-[#A1A1AA]">Net Working Hours</div>
          <div className="font-mono text-sm font-semibold text-emerald-400 mt-1 tabular-nums">
            {myToday ? formatDurationSeconds(netWorkingSeconds) : '00h 00m 00s'}
          </div>
        </div>

        <div className="p-3.5 rounded-xl bg-[#1B1F28] border border-[#292D36]">
          <div className="text-[11px] text-[#A1A1AA]">Remaining Hours</div>
          <div className="font-mono text-sm font-semibold text-[#FF6A33] mt-1 tabular-nums">
            {formatDurationSeconds(remainingWorkingSeconds)}
          </div>
        </div>

        {!compact && (
          <>
            <div className="p-3.5 rounded-xl bg-[#1B1F28] border border-[#292D36]">
              <div className="text-[11px] text-[#A1A1AA]">Late Arrival</div>
              <div
                className={`font-mono text-sm font-semibold mt-1 tabular-nums ${
                  stats.lateMinutes > 0 ? 'text-amber-400' : 'text-emerald-400'
                }`}
              >
                {myToday ? (stats.lateMinutes > 0 ? formatDurationMinutes(stats.lateMinutes) : 'On Time') : '—'}
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-[#1B1F28] border border-[#292D36]">
              <div className="text-[11px] text-[#A1A1AA]">Early Departure</div>
              <div
                className={`font-mono text-sm font-semibold mt-1 tabular-nums ${
                  stats.earlyDepartureMinutes > 0 ? 'text-amber-400' : 'text-[#FFFFFF]'
                }`}
              >
                {myToday?.checkOutTime
                  ? stats.earlyDepartureMinutes > 0
                    ? formatDurationMinutes(stats.earlyDepartureMinutes)
                    : '0m'
                  : '—'}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="mt-4 rounded-2xl border border-[#292D36] bg-[#0B0D12]/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="text-sm font-semibold text-[#FFFFFF]">Recorded Breaks, Meetings &amp; Monitoring</div>
          <span
            className={`text-[11px] font-semibold ${
              monitoringHeartbeatFresh && monitoringStatus?.state === 'monitoring'
                ? 'text-emerald-400'
                : monitoringHeartbeatFresh && monitoringStatus?.state === 'paused'
                ? 'text-amber-300'
                : 'text-[#A1A1AA]'
            }`}
          >
            Monitoring:{' '}
            {monitoringHeartbeatFresh && monitoringStatus?.state === 'monitoring'
              ? 'ON'
              : monitoringHeartbeatFresh && monitoringStatus?.state === 'paused'
              ? 'PAUSED'
              : 'OFF / Agent not connected'}
          </span>
        </div>
        {[
          ...breakSessions.map((b) => ({
            id: b.id,
            label: `${b.type} Break`,
            startAt: b.startAt,
            endAt: b.endAt,
            status: b.status,
            detail: b.reviewRequired ? 'Auto-ended · HR review required' : '',
          })),
          ...meetingSessions.map((m) => ({
            id: m.id,
            label: `${m.type} Meeting`,
            startAt: m.startAt,
            endAt: m.endAt,
            status: m.status,
            detail: `${m.withWhom} · ${m.purpose}`,
          })),
        ]
          .sort((a, b) => a.startAt.localeCompare(b.startAt))
          .map((item) => (
            <div
              key={item.id}
              className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 border-t border-[#292D36] py-2 text-xs"
            >
              <div>
                <span className="font-semibold text-[#D4D4D8]">{item.label}</span>
                {item.detail && <span className="text-[#A1A1AA]"> · {item.detail}</span>}
              </div>
              <div className="text-[#A1A1AA]">
                {formatTimeInZone(item.startAt, sched.officeTimezone)} –{' '}
                {item.endAt ? formatTimeInZone(item.endAt, sched.officeTimezone) : 'In progress'} · {item.status}
              </div>
            </div>
          ))}
        {!breakSessions.length && !meetingSessions.length && (
          <p className="text-xs text-[#A1A1AA]">No breaks or meetings have been logged today.</p>
        )}
      </div>

      {/* Live Shift Progress Bar */}
      <div className="mt-4 pt-3 border-t border-[#292D36]/70">
        <div className="flex items-center justify-between text-[11px] text-[#A1A1AA] mb-1.5">
          <span>
            Net Shift Progress (Target {netTargetLabel}
            {halfDayLeaveApproved ? ' (half-day leave adjusted)' : ''})
            <span className="block mt-1 text-[#D4D4D8]">Projected finish time: {projectedFinish}</span>
          </span>
          <span className="font-mono font-semibold text-[#FFFFFF] tabular-nums">{progressPercent}%</span>
        </div>
        <div className="w-full h-2 rounded-full bg-[#1B1F28] border border-[#292D36] overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#FF4634] to-[#FF6A33] transition-all duration-500"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>
    </section>
  );
};
