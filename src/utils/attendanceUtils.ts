import type { AttendanceRecord, WorkPolicySettings } from '../types/hrms';

export const COMMON_TIMEZONES = [
  'Asia/Kolkata',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Singapore',
  'Australia/Sydney',
  'UTC',
];

export function getDefaultTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
    return zone === 'Asia/Calcutta' ? 'Asia/Kolkata' : zone;
  } catch {
    return 'Asia/Kolkata';
  }
}

export function resolveWorkPolicy(policy: WorkPolicySettings): Required<
  Pick<
    WorkPolicySettings,
    | 'workStartTime'
    | 'workEndTime'
    | 'lunchStartTime'
    | 'lunchEndTime'
    | 'graceMinutes'
    | 'breakMinutes'
    | 'halfDayThresholdMinutes'
    | 'lunchTrackingEnabled'
    | 'requireDailyWorkReportBeforeCheckout'
    | 'maxOptionalHolidays'
    | 'lateMarksThreshold'
    | 'lateMarksAction'
    | 'officeTimezone'
  >
> & { weeklyOffs: string[] } {
  const configuredTimezone = policy.officeTimezone || getDefaultTimezone();
  const workStartTime = policy.workStartTime || '09:30';
  const workEndTime = policy.workEndTime || '18:30';
  const lunchStartTime = policy.lunchStartTime || '13:30';
  const lunchEndTime = policy.lunchEndTime || '14:15';
  const lunchSpan = Math.max(0, parseHHMMToMinutes(lunchEndTime) - parseHHMMToMinutes(lunchStartTime));
  const breakMinutes =
    typeof policy.breakMinutes === 'number' && policy.breakMinutes >= 0
      ? policy.breakMinutes === 60 && !policy.lunchStartTime
        ? 45
        : policy.breakMinutes
      : lunchSpan || 45;

  return {
    workStartTime,
    workEndTime,
    lunchStartTime,
    lunchEndTime,
    graceMinutes: policy.graceMinutes ?? 15,
    breakMinutes,
    halfDayThresholdMinutes: policy.halfDayThresholdMinutes ?? 270,
    lunchTrackingEnabled: policy.lunchTrackingEnabled ?? true,
    requireDailyWorkReportBeforeCheckout: policy.requireDailyWorkReportBeforeCheckout ?? false,
    maxOptionalHolidays: policy.maxOptionalHolidays ?? 2,
    lateMarksThreshold: policy.lateMarksThreshold ?? 3,
    lateMarksAction: policy.lateMarksAction ?? 'half_day',
    officeTimezone: configuredTimezone === 'Asia/Calcutta' ? 'Asia/Kolkata' : configuredTimezone,
    weeklyOffs: policy.weeklyOffs || ['Saturday', 'Sunday'],
  };
}

export function parseHHMMToMinutes(hhmm: string): number {
  const [hStr, mStr] = (hhmm || '00:00').split(':');
  const h = Number(hStr) || 0;
  const m = Number(mStr) || 0;
  return h * 60 + m;
}

export function formatMinutesAsClock12(hhmm: string): string {
  const mins = parseHHMMToMinutes(hhmm);
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function formatDurationMinutes(totalMins: number): string {
  const safe = Math.max(0, Math.round(totalMins));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h 00m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function formatDurationSeconds(totalSecs: number): string {
  const safe = Math.max(0, Math.floor(totalSecs));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

export function isWeeklyOffDate(dateStr: string, weeklyOffs: string[] = []): boolean {
  const date = new Date(`${dateStr}T12:00:00Z`);
  const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][date.getUTCDay()];
  if (weeklyOffs.includes(dayName)) return true;
  if (dayName === 'Saturday' && weeklyOffs.includes('Second Saturday')) {
    return Math.ceil(date.getUTCDate() / 7) === 2;
  }
  return false;
}

export function getOfficeNowParts(now: Date, timeZone: string) {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
    const year = get('year');
    const month = get('month');
    const day = get('day');
    let hour = Number(get('hour'));
    if (hour === 24) hour = 0;
    const minute = Number(get('minute'));
    const second = Number(get('second'));
    const dateStr = `${year}-${month}-${day}`;
    const minutesSinceMidnight = hour * 60 + minute;
    const secondsSinceMidnight = minutesSinceMidnight * 60 + second;

    const displayTime = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(now);

    const displayDate = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(now);

    return {
      dateStr,
      minutesSinceMidnight,
      secondsSinceMidnight,
      displayTime,
      displayDate,
    };
  } catch {
    const dateStr = now.toISOString().slice(0, 10);
    const mins = now.getHours() * 60 + now.getMinutes();
    return {
      dateStr,
      minutesSinceMidnight: mins,
      secondsSinceMidnight: mins * 60 + now.getSeconds(),
      displayTime: now.toLocaleTimeString(),
      displayDate: now.toDateString(),
    };
  }
}

export function getDateMinutesInZone(isoString: string, timeZone: string): number {
  const dt = new Date(isoString);
  if (Number.isNaN(dt.getTime())) return 0;
  return getOfficeNowParts(dt, timeZone).minutesSinceMidnight;
}

export function formatTimeInZone(isoString: string | undefined, timeZone: string): string {
  if (!isoString) return '—';
  const dt = new Date(isoString);
  if (Number.isNaN(dt.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(dt);
  } catch {
    return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}

export function getScheduleMetrics(policy: WorkPolicySettings) {
  const p = resolveWorkPolicy(policy);
  const startMins = parseHHMMToMinutes(p.workStartTime);
  const endMins = parseHHMMToMinutes(p.workEndTime);
  const lunchStartMins = parseHHMMToMinutes(p.lunchStartTime);
  let lunchEndMins = parseHHMMToMinutes(p.lunchEndTime);
  const overnight = endMins <= startMins;
  const adjustedEndMins = overnight ? endMins + 1440 : endMins;
  if (lunchEndMins < lunchStartMins) lunchEndMins += 1440;

  const totalOfficeMinutes = Math.max(0, adjustedEndMins - startMins);
  const lunchOverlapsShift = lunchEndMins > startMins && lunchStartMins < adjustedEndMins;
  const scheduledLunchMinutes = lunchOverlapsShift
    ? Math.max(0, Math.min(lunchEndMins, adjustedEndMins) - Math.max(lunchStartMins, startMins)) || p.breakMinutes
    : p.breakMinutes;
  const netWorkingTargetMinutes = Math.max(0, totalOfficeMinutes - scheduledLunchMinutes);

  return {
    ...p,
    startMins,
    endMins,
    lunchStartMins,
    lunchEndMins,
    totalOfficeMinutes,
    scheduledLunchMinutes,
    netWorkingTargetMinutes,
  };
}

/**
 * Calculates overlap (in seconds) between a shift [startMs, endMs] and the scheduled lunch window
 * on that day in officeTimezone, plus any actual tracked lunch break duration, ensuring
 * the scheduled 45-minute lunch period is never counted as working time.
 */
export function computeShiftWorkingStats(params: {
  record: AttendanceRecord | undefined;
  now: Date;
  policy: WorkPolicySettings;
}) {
  const { record, now, policy } = params;
  const sched = getScheduleMetrics(policy);

  if (!record || !record.checkInTime) {
    return {
      phase: 'not_checked_in' as const,
      elapsedTotalSeconds: 0,
      lunchDeductedSeconds: 0,
      netWorkingSeconds: 0,
      remainingWorkingSeconds: sched.netWorkingTargetMinutes * 60,
      lateMinutes: 0,
      earlyDepartureMinutes: 0,
      actualLunchMinutes: 0,
      progressPercent: 0,
    };
  }

  const checkInMs = new Date(record.checkInTime).getTime();
  const checkOutMs = record.checkOutTime ? new Date(record.checkOutTime).getTime() : now.getTime();
  const elapsedTotalSeconds = Math.max(0, Math.floor((checkOutMs - checkInMs) / 1000));

  // Determine phase
  const hasCheckedOut = Boolean(record.checkOutTime);
  const onLunch = !hasCheckedOut && Boolean(record.lunchStartTime) && !record.lunchEndTime;
  const phase = hasCheckedOut
    ? ('checked_out' as const)
    : onLunch
    ? ('on_lunch' as const)
    : record.lunchEndTime
    ? ('resumed_working' as const)
    : ('working' as const);

  // Deduct only a break that the employee actually started and ended.
  // The schedule is a planning aid, never proof that a break was taken.
  let actualLunchSeconds = 0;
  if (record.lunchStartTime) {
    const lStartMs = new Date(record.lunchStartTime).getTime();
    const lEndMs = record.lunchEndTime
      ? new Date(record.lunchEndTime).getTime()
      : hasCheckedOut
      ? checkOutMs
      : now.getTime();
    actualLunchSeconds = Math.max(0, Math.floor((lEndMs - lStartMs) / 1000));
  } else if (typeof record.actualLunchMinutes === 'number' && record.actualLunchMinutes > 0) {
    actualLunchSeconds = record.actualLunchMinutes * 60;
  }

  const lunchDeductedSeconds = Math.min(elapsedTotalSeconds, actualLunchSeconds);
  const inOfficeMins = getDateMinutesInZone(record.checkInTime, sched.officeTimezone);
  const outOfficeMins = record.checkOutTime
    ? getDateMinutesInZone(record.checkOutTime, sched.officeTimezone)
    : getOfficeNowParts(now, sched.officeTimezone).minutesSinceMidnight;

  const netWorkingSeconds = Math.max(0, elapsedTotalSeconds - lunchDeductedSeconds);
  const targetSecs = record.isNightShift ? 8 * 60 * 60 : sched.netWorkingTargetMinutes * 60;
  const expectedShiftEndMs = record.isNightShift && record.expectedShiftEndAt ? new Date(record.expectedShiftEndAt).getTime() : 0;
  const remainingWorkingSeconds = record.isNightShift && expectedShiftEndMs
    ? Math.max(0, Math.floor((expectedShiftEndMs - now.getTime()) / 1000))
    : Math.max(0, targetSecs - netWorkingSeconds);
  const progressPercent = targetSecs > 0
    ? Math.min(100, Math.round(((record.isNightShift ? elapsedTotalSeconds : netWorkingSeconds) / targetSecs) * 100))
    : 0;

  const lateMinutes =
    typeof record.lateMinutes === 'number'
      ? record.lateMinutes
      : Math.max(0, inOfficeMins - (sched.startMins + sched.graceMinutes));

  const earlyDepartureMinutes = hasCheckedOut
    ? typeof record.earlyDepartureMinutes === 'number'
      ? record.earlyDepartureMinutes
      : Math.max(0, (sched.endMins <= sched.startMins ? sched.endMins + 1440 : sched.endMins) - (sched.endMins <= sched.startMins && outOfficeMins < sched.startMins ? outOfficeMins + 1440 : outOfficeMins))
    : 0;

  return {
    phase,
    elapsedTotalSeconds,
    lunchDeductedSeconds,
    netWorkingSeconds,
    remainingWorkingSeconds,
    lateMinutes,
    earlyDepartureMinutes,
    actualLunchMinutes: Math.round(lunchDeductedSeconds / 60),
    progressPercent,
  };
}

export function computeProjectedFinishIso(params: {
  record: AttendanceRecord | undefined;
  now: Date;
  policy: WorkPolicySettings;
}): string | null {
  const { record, now, policy } = params;
  if (!record?.checkInTime) return null;
  if (record.checkOutTime) return record.checkOutTime;
  const stats = computeShiftWorkingStats({ record, now, policy });
  const finishMs = now.getTime() + stats.remainingWorkingSeconds * 1000;
  return new Date(finishMs).toISOString();
}

export function resolveCheckoutStatus(params: {
  currentStatus?: string;
  workingMinutes: number;
  halfDayThreshold: number;
  isEarlyDeparture: boolean;
}): string {
  const base = String(params.currentStatus || 'present');
  if (params.workingMinutes < params.halfDayThreshold) {
    return 'half_day';
  }
  if (params.isEarlyDeparture && base === 'present') {
    return 'early_departure';
  }
  return base;
}


