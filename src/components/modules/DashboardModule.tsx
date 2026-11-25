import React, { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Award,
  Briefcase,
  Cake,
  CalendarDays,
  CalendarOff,
  CheckCircle2,
  Clock,
  Coffee,
  Filter,
  Inbox,
  Lock,
  Megaphone,
  Percent,
  Pin,
  RefreshCw,
  RotateCcw,
  TrendingUp,
  UserCheck,
  UserX,
  Users,
  Wallet,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import { AttendanceCheckInWidget } from '../attendance/AttendanceCheckInWidget';
import {
  computeProjectedFinishIso,
  formatDurationMinutes,
  formatMinutesAsClock12,
  formatTimeInZone,
  getOfficeNowParts,
  getScheduleMetrics,
} from '../../utils/attendanceUtils';
import { getChartTheme, useThemeMode } from '../../utils/themeUtils';
import { filterVisibleLeaveRequests, isManagementRole, ROLE_DISPLAY_NAMES } from '../../utils/workflowUtils';
import { isAnnouncementCurrentlyActive, isAnnouncementVisibleToViewer } from '../../utils/taskTimerUtils';
import type { ActiveTab } from '../../types/hrms';

interface DashboardModuleProps {
  onNavigate: (tab: ActiveTab) => void;
}

type DatePreset = 'this_month' | 'last_30' | 'last_90' | 'ytd' | 'custom_month';
type LeaveChartMode = 'by_type' | 'by_month';

// Strictly non-blue palette colors
const DONUT_COLORS = [
  '#FF4634',
  '#FF6A33',
  '#FF9A65',
  '#FF8B5B',
  '#FF9A65',
  '#FF9A65',
  '#D94832',
];

const STAGE_LABELS: Record<string, string> = {
  applied: 'Applied',
  screening: 'Screening',
  interview: 'Interview',
  offer: 'Offer',
  selected: 'Selected',
};

const STAGE_COLORS: Record<string, string> = {
  applied: '#A1A1AA',
  screening: '#FF8B5B',
  interview: '#FF9A65',
  offer: '#FF6A33',
  selected: '#FF6A33',
};

interface TooltipPayloadEntry {
  name?: string;
  value?: number | string;
  color?: string;
  dataKey?: string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
  valueFormatter?: (val: number, name: string) => string;
}

const AceChartTooltip: React.FC<CustomTooltipProps> = ({
  active,
  payload,
  label,
  valueFormatter,
}) => {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-[#0B0D12] border border-[#292D36] rounded-xl px-3.5 py-2.5 shadow-2xl shadow-black/70 text-xs min-w-[150px]">
      {label && (
        <div className="font-medium text-[#FFFFFF] pb-1.5 mb-1.5 border-b border-[#292D36]">
          {label}
        </div>
      )}
      <div className="space-y-1">
        {payload.map((entry, index) => {
          const numVal = typeof entry.value === 'number' ? entry.value : Number(entry.value ?? 0);
          const name = entry.name || String(entry.dataKey || '');
          const formatted = valueFormatter ? valueFormatter(numVal, name) : numVal.toLocaleString();
          return (
            <div key={`${name}-${index}`} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-2 text-[#A1A1AA]">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: entry.color || '#FF4634' }}
                />
                <span>{name}</span>
              </span>
              <span className="font-mono font-semibold text-[#FFFFFF] tabular-nums">{formatted}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const ChartEmptyState: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}> = ({ icon: Icon, title, description, actionLabel, onAction }) => (
  <div className="h-64 flex flex-col items-center justify-center text-center px-5 border border-dashed border-[#292D36] rounded-xl bg-[#0B0D12]/40">
    <div className="w-10 h-10 rounded-xl bg-[#1B1F28] border border-[#292D36] flex items-center justify-center text-[#FF6A33] mb-3">
      <Icon className="w-5 h-5" />
    </div>
    <p className="text-sm font-medium text-[#FFFFFF]">{title}</p>
    <p className="text-xs text-[#A1A1AA] mt-1 max-w-xs leading-relaxed">{description}</p>
    {actionLabel && onAction && (
      <button
        type="button"
        onClick={onAction}
        className="mt-3.5 px-3.5 py-1.5 rounded-lg border border-[#292D36] bg-[#1B1F28] hover:border-[#FF4634]/50 text-xs font-medium text-[#FF6A33] hover:text-[#FFFFFF] transition-colors"
      >
        {actionLabel}
      </button>
    )}
  </div>
);

function getDateWindow(preset: DatePreset, customMonth: string, today: string) {
  const now = new Date(`${today}T00:00:00`);
  const year = now.getFullYear();
  const monthIdx = now.getMonth();

  if (preset === 'this_month') {
    const start = `${today.slice(0, 7)}-01`;
    const lastDay = new Date(year, monthIdx + 1, 0).toISOString().slice(0, 10);
    return { start, end: lastDay, label: `Month (${today.slice(0, 7)})` };
  }

  if (preset === 'last_30') {
    const d = new Date(now);
    d.setDate(d.getDate() - 29);
    return { start: d.toISOString().slice(0, 10), end: today, label: 'Last 30 Days' };
  }

  if (preset === 'last_90') {
    const d = new Date(now);
    d.setDate(d.getDate() - 89);
    return { start: d.toISOString().slice(0, 10), end: today, label: 'Last 90 Days' };
  }

  if (preset === 'ytd') {
    return { start: `${year}-01-01`, end: today, label: `Year to Date (${year})` };
  }

  const targetMonth = customMonth && /^\d{4}-\d{2}$/.test(customMonth) ? customMonth : today.slice(0, 7);
  const [yy, mm] = targetMonth.split('-').map(Number);
  const endOfMonth = new Date(yy, mm, 0).toISOString().slice(0, 10);
  return { start: `${targetMonth}-01`, end: endOfMonth, label: `Month (${targetMonth})` };
}

export const DashboardModule: React.FC<DashboardModuleProps> = ({ onNavigate }) => {
  const { firebaseUser, roleAssignment, employeeProfile, effectiveRole } = useAuth();
  const { isLight } = useThemeMode();
  const chartTheme = useMemo(() => getChartTheme(isLight), [isLight]);
  const {
    directory,
    attendance,
    attendanceCorrections,
    leaveRequests,
    breakSessions,
    departments,
    announcements,
    jobs,
    candidates,
    payrollRuns,
    offboardingCases,
    payrollConfig,
    workPolicy,
    dataLoading,
    dataError,
    retrySync,
  } = useHrmsData();

  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);

  const sched = getScheduleMetrics(workPolicy);
  const nowParts = getOfficeNowParts(now, sched.officeTimezone);
  const today = nowParts.dateStr;
  const defaultMonth = today.slice(0, 7);

  const [datePreset, setDatePreset] = useState<DatePreset>('this_month');
  const [selectedMonth, setSelectedMonth] = useState<string>(defaultMonth);
  const [departmentFilter, setDepartmentFilter] = useState<string>('all');
  const [leaveChartMode, setLeaveChartMode] = useState<LeaveChartMode>('by_type');

  const dateWindow = useMemo(
    () => getDateWindow(datePreset, selectedMonth, today),
    [datePreset, selectedMonth, today]
  );

  const currencySymbol = payrollConfig.currencySymbol || '$';
  const formatCurrency = (amount: number) => {
    if (!Number.isFinite(amount)) return `${currencySymbol}0`;
    return `${currencySymbol}${Math.round(amount).toLocaleString()}`;
  };

  const selectedDeptName = useMemo(() => {
    if (departmentFilter === 'all') return 'All Departments';
    return departments.find((d) => d.id === departmentFilter)?.name || 'Selected Department';
  }, [departmentFilter, departments]);

  // Scoped datasets based on selected department filter
  const filteredDirectory = useMemo(() => {
    if (departmentFilter === 'all') return directory;
    return directory.filter((d) => d.departmentId === departmentFilter);
  }, [directory, departmentFilter]);

  const filteredAttendance = useMemo(() => {
    return attendance.filter((a) => {
      if (departmentFilter !== 'all' && a.departmentId !== departmentFilter) return false;
      return a.date >= dateWindow.start && a.date <= dateWindow.end;
    });
  }, [attendance, departmentFilter, dateWindow]);

  const filteredLeaves = useMemo(() => {
    const visible = filterVisibleLeaveRequests(
      leaveRequests,
      firebaseUser?.uid || '',
      effectiveRole,
      employeeProfile?.departmentId
    );
    return visible.filter((l) => {
      if (departmentFilter !== 'all' && l.departmentId !== departmentFilter) return false;
      return true;
    });
  }, [leaveRequests, departmentFilter, firebaseUser?.uid, effectiveRole, employeeProfile?.departmentId]);

  const filteredCorrections = useMemo(() => {
    if (departmentFilter === 'all') return attendanceCorrections;
    return attendanceCorrections.filter((c) => c.departmentId === departmentFilter);
  }, [attendanceCorrections, departmentFilter]);

  const filteredOffboarding = useMemo(() => {
    if (departmentFilter === 'all') return offboardingCases;
    return offboardingCases.filter((o) => o.departmentId === departmentFilter);
  }, [offboardingCases, departmentFilter]);

  // 1. 8 Required KPI Metrics (Strictly Live Data)
  const metrics = useMemo(() => {
    const totalEmployees = filteredDirectory.length;
    const activeEmployees = filteredDirectory.filter((d) => d.status === 'active').length;
    const activeRate = totalEmployees > 0 ? Math.round((activeEmployees / totalEmployees) * 100) : 0;

    const approvedTodayLeaves = filteredLeaves.filter(
      (l) => l.status === 'approved' && l.startDate <= today && l.endDate >= today
    );
    const onLeaveToday = new Set(approvedTodayLeaves.map((l) => l.employeeId)).size;

    const todayAttendance = attendance.filter((a) => {
      if (a.date !== today) return false;
      if (departmentFilter !== 'all' && a.departmentId !== departmentFilter) return false;
      return true;
    });

    const presentToday = todayAttendance.filter((a) =>
      ['present', 'late', 'half_day', 'early_departure'].includes(a.status)
    ).length;
    const lateToday = todayAttendance.filter((a) => a.isLate || a.status === 'late').length;

    const explicitAbsentToday = todayAttendance.filter((a) => a.status === 'absent').length;
    const absentToday = Math.max(explicitAbsentToday, Math.max(0, activeEmployees - presentToday - onLeaveToday));

    const attendanceRate =
      activeEmployees > 0 ? Math.min(100, Number(((presentToday / activeEmployees) * 100).toFixed(1))) : 0;

    const pendingLeaves = filteredLeaves.filter((l) => l.status === 'pending').length;
    const pendingCorrections = filteredCorrections.filter((c) => c.status === 'pending').length;
    const pendingOffboarding = filteredOffboarding.filter((o) => o.approvalStatus === 'pending').length;

    return {
      totalEmployees,
      activeEmployees,
      activeRate,
      presentToday,
      absentToday,
      lateToday,
      onLeaveToday,
      pendingLeaves,
      pendingOther: pendingCorrections + pendingOffboarding,
      attendanceRate,
    };
  }, [
    filteredDirectory,
    filteredLeaves,
    filteredCorrections,
    filteredOffboarding,
    attendance,
    departmentFilter,
    today,
  ]);

  // 2. Daily & Monthly Attendance Trend + Present vs Absent + Late Analytics
  const attendanceTrendSeries = useMemo(() => {
    const byDate: Record<
      string,
      {
        rawDate: string;
        date: string;
        onTime: number;
        late: number;
        halfOrEarly: number;
        present: number;
        explicitAbsent: number;
        lateMinutes: number;
        totalWorkingHours: number;
      }
    > = {};

    filteredAttendance.forEach((rec) => {
      if (!byDate[rec.date]) {
        byDate[rec.date] = {
          rawDate: rec.date,
          date: rec.date.slice(5),
          onTime: 0,
          late: 0,
          halfOrEarly: 0,
          present: 0,
          explicitAbsent: 0,
          lateMinutes: 0,
          totalWorkingHours: 0,
        };
      }
      const b = byDate[rec.date];
      if (rec.status === 'absent') {
        b.explicitAbsent += 1;
      } else if (rec.status === 'late' || rec.isLate) {
        b.late += 1;
        b.present += 1;
        b.lateMinutes += rec.lateMinutes || 0;
        b.totalWorkingHours += (rec.workingMinutes || 0) / 60;
      } else if (rec.status === 'half_day' || rec.status === 'early_departure') {
        b.halfOrEarly += 1;
        b.present += 1;
        b.totalWorkingHours += (rec.workingMinutes || 0) / 60;
      } else if (rec.status === 'present') {
        b.onTime += 1;
        b.present += 1;
        b.totalWorkingHours += (rec.workingMinutes || 0) / 60;
      }
    });

    return Object.values(byDate)
      .sort((a, b) => a.rawDate.localeCompare(b.rawDate))
      .map((d) => ({
        ...d,
        absent: d.explicitAbsent > 0 ? d.explicitAbsent : Math.max(0, metrics.activeEmployees - d.present),
        avgHours: d.present > 0 ? Number((d.totalWorkingHours / d.present).toFixed(2)) : 0,
      }));
  }, [filteredAttendance, metrics.activeEmployees]);

  // 3. Department-wise Employee Distribution & Attendance
  const deptDistribution = useMemo(() => {
    const counts: Record<string, { id: string; name: string; count: number }> = {};
    directory.forEach((d) => {
      const id = d.departmentId || 'unassigned';
      const name = d.departmentName || 'Unassigned';
      if (!counts[id]) {
        counts[id] = { id, name, count: 0 };
      }
      counts[id].count += 1;
    });
    return Object.values(counts).sort((a, b) => b.count - a.count);
  }, [directory]);

  const deptAttendanceSeries = useMemo(() => {
    return departments
      .map((dept) => {
        const subset = attendance.filter(
          (a) =>
            a.departmentId === dept.id &&
            a.date >= dateWindow.start &&
            a.date <= dateWindow.end
        );
        const present = subset.filter((a) =>
          ['present', 'late', 'half_day', 'early_departure'].includes(a.status)
        ).length;
        const late = subset.filter((a) => a.isLate || a.status === 'late').length;
        const avgHours =
          present > 0
            ? Number((subset.reduce((s, r) => s + (r.workingMinutes || 0), 0) / 60 / present).toFixed(2))
            : 0;
        return {
          department: dept.code || dept.name,
          present,
          late,
          avgHours,
        };
      })
      .filter((d) => d.present > 0 || d.late > 0);
  }, [departments, attendance, dateWindow]);

  // 4. Leave Analytics (Bar Chart — By Type or Monthly)
  const leaveAnalytics = useMemo(() => {
    const inWindow = filteredLeaves.filter(
      (l) => l.endDate >= dateWindow.start && l.startDate <= dateWindow.end
    );

    const types: Array<{ key: 'casual' | 'sick' | 'paid' | 'emergency' | 'unpaid'; label: string }> = [
      { key: 'casual', label: 'Casual' },
      { key: 'sick', label: 'Sick' },
      { key: 'paid', label: 'Paid' },
      { key: 'emergency', label: 'Emergency' },
      { key: 'unpaid', label: 'Unpaid' },
    ];

    const byType = types.map((t) => {
      const subset = inWindow.filter((l) => l.leaveType === t.key);
      return {
        label: t.label,
        approved: subset.filter((l) => l.status === 'approved').length,
        pending: subset.filter((l) => l.status === 'pending').length,
        rejected: subset.filter((l) => l.status === 'rejected').length,
      };
    });

    const hasTypeData = inWindow.length > 0;

    const monthMap: Record<string, { month: string; approved: number; pending: number; totalDays: number }> = {};
    filteredLeaves.forEach((l) => {
      const m = (l.startDate || '').slice(0, 7);
      if (!m) return;
      if (!monthMap[m]) {
        monthMap[m] = { month: m, approved: 0, pending: 0, totalDays: 0 };
      }
      if (l.status === 'approved') {
        monthMap[m].approved += 1;
        monthMap[m].totalDays += Number(l.daysCount || 0);
      } else if (l.status === 'pending') {
        monthMap[m].pending += 1;
      }
    });

    const byMonth = Object.values(monthMap)
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-8);

    return { byType, byMonth, hasTypeData, totalFilteredCount: inWindow.length };
  }, [filteredLeaves, dateWindow]);

  // 5. Recruitment Funnel
  const recruitmentFunnel = useMemo(() => {
    const jobDeptMap = new Map<string, string>();
    jobs.forEach((j) => jobDeptMap.set(j.id, j.departmentId));

    const scopedJobs =
      departmentFilter === 'all' ? jobs : jobs.filter((j) => j.departmentId === departmentFilter);
    const openPositions = scopedJobs
      .filter((j) => j.status === 'open')
      .reduce((acc, j) => acc + Number(j.openings || 0), 0);

    const scopedCandidates =
      departmentFilter === 'all'
        ? candidates
        : candidates.filter((c) => jobDeptMap.get(c.jobId) === departmentFilter);

    const stages: Array<'applied' | 'screening' | 'interview' | 'offer' | 'selected'> = [
      'applied',
      'screening',
      'interview',
      'offer',
      'selected',
    ];

    const series = stages.map((stage) => ({
      stage: STAGE_LABELS[stage],
      key: stage,
      count: scopedCandidates.filter((c) => c.stage === stage).length,
      fill: STAGE_COLORS[stage],
    }));

    const rejectedCount = scopedCandidates.filter((c) => c.stage === 'rejected').length;

    return {
      series,
      totalCandidates: scopedCandidates.length,
      openRoles: scopedJobs.filter((j) => j.status === 'open').length,
      openPositions,
      rejectedCount,
    };
  }, [jobs, candidates, departmentFilter]);

  // 6. Monthly Payroll Overview
  const payrollOverview = useMemo(() => {
    const sorted = [...payrollRuns]
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-12)
      .map((run) => ({
        month: run.month,
        gross: Number(run.totalGross || 0),
        net: Number(run.totalNet || 0),
        deductions: Number(run.totalDeductions || 0),
        employees: Number(run.employeeCount || 0),
        status: run.status,
      }));
    const latestRun = sorted.length > 0 ? sorted[sorted.length - 1] : null;
    return { series: sorted, latestRun };
  }, [payrollRuns]);

  // 7. Employee Growth Analytics (Area Chart)
  const employeeGrowthSeries = useMemo(() => {
    const monthJoiners: Record<string, number> = {};
    filteredDirectory.forEach((d) => {
      if (!d.joiningDate || d.joiningDate.length < 7) return;
      const month = d.joiningDate.slice(0, 7);
      monthJoiners[month] = (monthJoiners[month] || 0) + 1;
    });

    const sortedMonths = Object.keys(monthJoiners).sort((a, b) => a.localeCompare(b));
    let cumulative = 0;
    const series = sortedMonths.map((month) => {
      const joined = monthJoiners[month];
      cumulative += joined;
      return {
        month,
        newJoiners: joined,
        totalHeadcount: cumulative,
      };
    });
    return series.slice(-12);
  }, [filteredDirectory]);

  // 8. Birthdays & Work Anniversaries (30d, filtered by department)
  const upcomingEvents = useMemo(() => {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const birthdays: { name: string; dept: string; date: string; diffDays: number }[] = [];
    const anniversaries: { name: string; dept: string; years: number; date: string; diffDays: number }[] = [];

    filteredDirectory.forEach((d) => {
      if (d.birthMonthDay && d.birthMonthDay.length === 5) {
        const [mm, dd] = d.birthMonthDay.split('-').map(Number);
        if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
          const candidate = new Date(now.getFullYear(), mm - 1, dd);
          if (candidate < startOfToday) {
            candidate.setFullYear(now.getFullYear() + 1);
          }
          const diffDays = Math.round((candidate.getTime() - startOfToday.getTime()) / 86400000);
          if (diffDays >= 0 && diffDays <= 30) {
            birthdays.push({ name: d.fullName, dept: d.departmentName, date: d.birthMonthDay, diffDays });
          }
        }
      }
      if (d.joiningDate && d.joiningDate.length === 10) {
        const [yy, mm, dd] = d.joiningDate.split('-').map(Number);
        const candidate = new Date(now.getFullYear(), mm - 1, dd);
        if (candidate < startOfToday) {
          candidate.setFullYear(now.getFullYear() + 1);
        }
        const years = candidate.getFullYear() - yy;
        if (years > 0) {
          const diffDays = Math.round((candidate.getTime() - startOfToday.getTime()) / 86400000);
          if (diffDays >= 0 && diffDays <= 30) {
            anniversaries.push({
              name: d.fullName,
              dept: d.departmentName,
              years,
              date: d.joiningDate.slice(5),
              diffDays,
            });
          }
        }
      }
    });

    birthdays.sort((a, b) => a.diffDays - b.diffDays);
    anniversaries.sort((a, b) => a.diffDays - b.diffDays);

    return { birthdays, anniversaries };
  }, [filteredDirectory, now]);

  // 9. Pending Approvals Feed
  const pendingItems = useMemo(() => {
    const items: { id: string; kind: string; title: string; subtitle: string; tab: ActiveTab }[] = [];
    filteredLeaves
      .filter((l) => l.status === 'pending')
      .slice(0, 4)
      .forEach((l) => {
        items.push({
          id: `lv-${l.id}`,
          kind: 'Leave',
          title: l.employeeName,
          subtitle: `${l.leaveType} · ${l.startDate} (${l.daysCount}d)`,
          tab: 'leave',
        });
      });
    filteredCorrections
      .filter((c) => c.status === 'pending')
      .slice(0, 3)
      .forEach((c) => {
        items.push({
          id: `corr-${c.id}`,
          kind: 'Correction',
          title: c.employeeName,
          subtitle: `Attendance fix · ${c.date}`,
          tab: 'attendance',
        });
      });
    filteredOffboarding
      .filter((o) => o.approvalStatus === 'pending')
      .slice(0, 2)
      .forEach((o) => {
        items.push({
          id: `off-${o.id}`,
          kind: 'Exit',
          title: o.employeeName,
          subtitle: `Resignation notice · LWD ${o.lastWorkingDay}`,
          tab: 'offboarding',
        });
      });
    return items.slice(0, 6);
  }, [filteredLeaves, filteredCorrections, filteredOffboarding]);

  const viewerDeptId = roleAssignment?.departmentId || employeeProfile?.departmentId || '';

  const sortedAnnouncements = useMemo(() => {
    return [...announcements]
      .filter((a) =>
        isAnnouncementCurrentlyActive(a, today) &&
        isAnnouncementVisibleToViewer(a, {
          uid: firebaseUser?.uid || '',
          effectiveRole,
          departmentId: viewerDeptId,
          teamLeadUid: employeeProfile?.teamLeadUid,
          reportingManagerUid: employeeProfile?.reportingManagerUid,
        }),
      )
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
      .slice(0, 4);
  }, [
    announcements,
    today,
    firebaseUser?.uid,
    effectiveRole,
    viewerDeptId,
    employeeProfile?.teamLeadUid,
    employeeProfile?.reportingManagerUid,
  ]);

  const hasActiveFilters = datePreset !== 'this_month' || departmentFilter !== 'all';

  const resetFilters = () => {
    setDatePreset('this_month');
    setSelectedMonth(defaultMonth);
    setDepartmentFilter('all');
  };

  // Office Timeline Progress & Employee-specific projected finish time
  const curMins = nowParts.minutesSinceMidnight;
  const officeSpan = Math.max(1, sched.endMins - sched.startMins);
  const timelinePercent = Math.min(100, Math.max(0, Math.round(((curMins - sched.startMins) / officeSpan) * 100)));
  const lunchStartPercent = Math.min(100, Math.max(0, ((sched.lunchStartMins - sched.startMins) / officeSpan) * 100));
  const lunchWidthPercent = Math.min(100 - lunchStartPercent, Math.max(2, ((sched.lunchEndMins - sched.lunchStartMins) / officeSpan) * 100));

  const myUid = firebaseUser?.uid || '';
  const myTodayRecord = attendance.find((entry) => entry.uid === myUid && entry.date === today);
  const myShiftPolicy = useMemo(
    () => ({
      ...workPolicy,
      workStartTime: employeeProfile?.shiftStartTime || workPolicy.workStartTime,
      workEndTime: employeeProfile?.shiftEndTime || workPolicy.workEndTime,
      officeTimezone: employeeProfile?.timezone || workPolicy.officeTimezone,
    }),
    [workPolicy, employeeProfile?.shiftStartTime, employeeProfile?.shiftEndTime, employeeProfile?.timezone]
  );
  const projectedFinishIso = useMemo(
    () => computeProjectedFinishIso({ record: myTodayRecord, now, policy: myShiftPolicy }),
    [myTodayRecord, now, myShiftPolicy]
  );
  const projectedFinishLabel = myTodayRecord?.checkOutTime
    ? `Completed (${formatTimeInZone(myTodayRecord.checkOutTime, myShiftPolicy.officeTimezone || sched.officeTimezone)})`
    : projectedFinishIso
    ? formatTimeInZone(projectedFinishIso, myShiftPolicy.officeTimezone || sched.officeTimezone)
    : `${formatMinutesAsClock12(myShiftPolicy.workEndTime || sched.workEndTime)} (scheduled)`;

  const teamToday = filteredDirectory
    .filter((person) => person.status === 'active')
    .map((person) => {
      const record = attendance.find((entry) => entry.uid === person.uid && entry.date === today);
      const hasLiveBreak = breakSessions.some(
        (b) => b.uid === person.uid && b.date === today && b.status === 'active'
      );
      const onBreak =
        hasLiveBreak || Boolean(record?.lunchStartTime && !record?.lunchEndTime && !record?.checkOutTime);
      const onLeave = leaveRequests.some(
        (leave) =>
          leave.uid === person.uid &&
          leave.status === 'approved' &&
          leave.startDate <= today &&
          leave.endDate >= today
      );
      const late = Boolean(record?.isLate || record?.status === 'late');
      const status = onLeave
        ? 'On leave'
        : onBreak
        ? 'On break'
        : record?.checkOutTime
        ? 'Checked out'
        : record?.checkInTime
        ? late
          ? 'Late'
          : 'Present'
        : curMins > sched.startMins + sched.graceMinutes
        ? 'Not checked in'
        : 'Not in yet';
      return { id: person.id, name: person.fullName, dept: person.departmentName, status };
    });
  const teamStatusCounts = {
    present: teamToday.filter((p) => p.status === 'Present').length,
    onLeave: teamToday.filter((p) => p.status === 'On leave').length,
    onBreak: teamToday.filter((p) => p.status === 'On break').length,
    late: teamToday.filter((p) => p.status === 'Late' || p.status === 'Not checked in').length,
  };

  const timelinePhase =
    curMins < sched.startMins
      ? 'Pre-Shift'
      : curMins >= sched.lunchStartMins && curMins < sched.lunchEndMins
      ? 'Lunch Break'
      : curMins >= sched.endMins
      ? 'After Office Hours'
      : curMins >= sched.lunchEndMins
      ? 'Afternoon Session'
      : 'Morning Session';

  const kpiCards = [
    {
      label: 'Total Employees',
      value: metrics.totalEmployees.toLocaleString(),
      icon: Users,
      sub: departmentFilter === 'all' ? `${departments.length} departments` : selectedDeptName,
      tab: 'employees' as ActiveTab,
      accent: 'text-[#FF6A33] bg-[#FF4634]/10 border-[#FF4634]/20',
    },
    {
      label: 'Active Employees',
      value: metrics.activeEmployees.toLocaleString(),
      icon: UserCheck,
      sub: `${metrics.activeRate}% of scoped roster`,
      tab: 'employees' as ActiveTab,
      accent: 'text-[#FF6A33] bg-[#FF4634]/10 border-[#FF4634]/20',
    },
    {
      label: 'Present Today',
      value: metrics.presentToday.toLocaleString(),
      icon: CheckCircle2,
      sub: `Checked in on ${today}`,
      tab: 'attendance' as ActiveTab,
      accent: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    },
    {
      label: 'Absent Today',
      value: metrics.absentToday.toLocaleString(),
      icon: UserX,
      sub: 'Excluding approved leave',
      tab: 'attendance' as ActiveTab,
      accent: 'text-rose-400 bg-rose-500/10 border-rose-500/20',
    },
    {
      label: 'Late Arrivals',
      value: metrics.lateToday.toLocaleString(),
      icon: AlertCircle,
      sub: `After ${sched.graceMinutes}m grace cutoff`,
      tab: 'attendance' as ActiveTab,
      accent: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
    },
    {
      label: 'On Leave Today',
      value: metrics.onLeaveToday.toLocaleString(),
      icon: CalendarOff,
      sub: `Approved for ${today}`,
      tab: 'leave' as ActiveTab,
      accent: 'text-[#FF6A33] bg-[#FF4634]/10 border-[#FF4634]/20',
    },
    {
      label: 'Pending Leave Requests',
      value: metrics.pendingLeaves.toLocaleString(),
      icon: Clock,
      sub: `${metrics.pendingOther} other pending approval(s)`,
      tab: 'leave' as ActiveTab,
      accent: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
    },
    {
      label: 'Attendance Percentage',
      value: `${metrics.attendanceRate}%`,
      icon: Percent,
      sub: `${metrics.presentToday} of ${metrics.activeEmployees} active`,
      tab: 'attendance' as ActiveTab,
      accent: 'text-[#FF6A33] bg-[#FF4634]/10 border-[#FF4634]/20',
    },
  ];

  // Loading Skeleton View
  if (dataLoading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading workforce dashboard">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="space-y-2">
            <div className="h-7 w-56 rounded-lg bg-[#151922] border border-[#292D36]" />
            <div className="h-4 w-80 rounded-lg bg-[#151922] border border-[#292D36]" />
          </div>
          <div className="flex gap-2.5">
            <div className="h-9 w-36 rounded-xl bg-[#151922] border border-[#292D36]" />
            <div className="h-9 w-32 rounded-xl bg-[#151922] border border-[#292D36]" />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-32 rounded-2xl bg-[#151922] border border-[#292D36] p-5 flex flex-col justify-between"
            >
              <div className="h-3.5 w-24 rounded bg-[#292D36]/60" />
              <div className="h-7 w-16 rounded bg-[#292D36]/80" />
              <div className="h-3 w-28 rounded bg-[#292D36]/50" />
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-8 h-80 rounded-2xl bg-[#151922] border border-[#292D36]" />
          <div className="lg:col-span-4 h-80 rounded-2xl bg-[#151922] border border-[#292D36]" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Error Recovery Banner */}
      {dataError && (
        <div
          role="alert"
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-200"
        >
          <div className="flex items-start gap-3 text-xs">
            <AlertTriangle className="w-4 h-4 text-[#FF4634] shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-[#FFFFFF]">Real-time sync warning</div>
              <p className="text-[#A1A1AA] mt-0.5">{dataError}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={retrySync}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#151922] border border-[#292D36] hover:border-[#FF4634]/50 text-xs font-medium text-[#FFFFFF] shrink-0 self-start sm:self-center"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Retry Sync
          </button>
        </div>
      )}

      {/* 1. Workforce Overview Header + Filters + Actions */}
      <section className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 sm:p-6 shadow-lg shadow-black/20">
        <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-wider font-semibold text-[#FF6A33]">
              {ROLE_DISPLAY_NAMES[effectiveRole]} Workspace
            </div>
            <h1 className="font-display text-2xl font-bold text-[#FFFFFF] tracking-tight mt-0.5">
              Workforce Overview
            </h1>
            <p className="text-sm text-[#A1A1AA] mt-1">
              ACE Web Experts · {selectedDeptName} · {dateWindow.label}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {(effectiveRole === 'super_admin' || effectiveRole === 'hr_manager') ? (
              <button
                type="button"
                onClick={() => onNavigate('employees')}
                className="ace-btn-primary px-4 py-2 rounded-xl text-xs font-semibold whitespace-nowrap inline-flex items-center gap-2"
              >
                <Users className="w-3.5 h-3.5" />
                Manage Employees
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate('work_hub')}
                className="ace-btn-primary px-4 py-2 rounded-xl text-xs font-semibold whitespace-nowrap inline-flex items-center gap-2"
              >
                <Users className="w-3.5 h-3.5" />
                Team Work Hub
              </button>
            )}
            <button
              type="button"
              onClick={() => onNavigate('reports')}
              className="px-4 py-2 bg-[#1B1F28] hover:bg-[#222733] border border-[#292D36] hover:border-[#FF4634]/40 text-[#FFFFFF] text-xs font-medium rounded-xl transition-colors whitespace-nowrap"
            >
              Export Reports
            </button>
          </div>
        </div>

        {/* Interactive Date & Department Filters */}
        <div className="mt-5 pt-4 border-t border-[#292D36] flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#A1A1AA] mr-1">
              <Filter className="w-3.5 h-3.5 text-[#FF6A33]" />
              Filters
            </span>

            <div className="inline-flex items-center gap-1.5 bg-[#0B0D12] border border-[#292D36] rounded-xl px-2.5 py-1.5">
              <CalendarDays className="w-3.5 h-3.5 text-[#A1A1AA]" />
              <select
                aria-label="Date range filter"
                value={datePreset}
                onChange={(e) => setDatePreset(e.target.value as DatePreset)}
                className="bg-transparent text-xs font-medium text-[#FFFFFF] focus:outline-none cursor-pointer"
              >
                <option value="this_month" className="bg-[#151922]">This Month</option>
                <option value="last_30" className="bg-[#151922]">Last 30 Days</option>
                <option value="last_90" className="bg-[#151922]">Last 90 Days</option>
                <option value="ytd" className="bg-[#151922]">Year to Date</option>
                <option value="custom_month" className="bg-[#151922]">Specific Month</option>
              </select>
            </div>

            {datePreset === 'custom_month' && (
              <input
                type="month"
                aria-label="Select month"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value || defaultMonth)}
                className="bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] rounded-xl px-3 py-1.5 text-xs font-mono text-[#FFFFFF] focus:outline-none"
              />
            )}

            <select
              aria-label="Department filter"
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
              className="bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] rounded-xl px-3 py-1.5 text-xs font-medium text-[#FFFFFF] focus:outline-none cursor-pointer"
            >
              <option value="all" className="bg-[#151922]">All Departments</option>
              {departments.map((dept) => (
                <option key={dept.id} value={dept.id} className="bg-[#151922]">
                  {dept.name}
                </option>
              ))}
            </select>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[#292D36] bg-[#0B0D12] hover:border-[#FF4634]/50 text-xs text-[#A1A1AA] hover:text-[#FFFFFF] transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                Reset
              </button>
            )}
          </div>

          <div className="text-xs text-[#A1A1AA] font-mono tabular-nums">
            {dateWindow.start} to {dateWindow.end}
          </div>
        </div>
      </section>

      {/* 2. 8 Modern KPI Cards */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpiCards.map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.label}
              type="button"
              onClick={() => onNavigate(card.tab)}
              className="group text-left p-5 bg-[#151922] border border-[#292D36] hover:border-[#FF4634]/50 rounded-2xl transition-all shadow-md shadow-black/15 flex flex-col justify-between"
            >
              <div className="flex items-center justify-between gap-2 mb-3">
                <span className="text-xs font-medium text-[#A1A1AA] group-hover:text-[#FFFFFF] transition-colors">
                  {card.label}
                </span>
                <span className={`w-8 h-8 rounded-xl border flex items-center justify-center shrink-0 ${card.accent}`}>
                  <Icon className="w-4 h-4" />
                </span>
              </div>
              <div className="font-mono text-2xl font-bold text-[#FFFFFF] tabular-nums tracking-tight">
                {card.value}
              </div>
              <div className="text-[11px] text-[#A1A1AA] mt-1.5 truncate">{card.sub}</div>
            </button>
          );
        })}
      </section>

      {/* 3. My Attendance Live Check-In / Out Widget */}
      <AttendanceCheckInWidget compact onRequestCorrection={() => onNavigate('attendance')} />

      {/* 4. Today's Office Timeline & Pending Approvals */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Today's Office Timeline */}
        <div className="lg:col-span-7 bg-[#151922] border border-[#292D36] rounded-2xl p-5 sm:p-6 shadow-md shadow-black/15">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <div>
              <h2 className="font-display text-base font-semibold text-[#FFFFFF]">
                Today&apos;s Office Timeline
              </h2>
              <p className="text-sm text-[#D4D4D8] mt-1">
                {formatDurationMinutes(sched.totalOfficeMinutes)} office span · {formatDurationMinutes(sched.netWorkingTargetMinutes)} net work ({sched.officeTimezone})
              </p>
            </div>
            <span className="px-2.5 py-1 rounded-lg bg-[#1B1F28] border border-[#292D36] text-xs font-semibold text-[#FF6A33]">
              {timelinePhase}
            </span>
          </div>

          <div className="flex items-center justify-between text-sm text-[#D4D4D8] mt-5 mb-2">
            <span>Shift progress</span>
            <span className="font-semibold font-mono text-xs sm:text-sm">Projected finish time: {projectedFinishLabel}</span>
          </div>
          {/* Visual Timeline Track */}
          <div className="mt-2 mb-4">
            <div className="relative h-5 rounded-full bg-[#1B1F28] border border-[#292D36] overflow-visible">
              {/* Elapsed progress bar */}
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#FF4634] to-[#FF6A33]"
                style={{ width: `${timelinePercent}%` }}
              />
              {/* Scheduled Lunch Window Marker */}
              <div
                className="absolute top-0 bottom-0 bg-amber-500/40 border-x border-amber-400/70"
                style={{ left: `${lunchStartPercent}%`, width: `${lunchWidthPercent}%` }}
                title={`Lunch Break: ${formatMinutesAsClock12(sched.lunchStartTime)} – ${formatMinutesAsClock12(sched.lunchEndTime)}`}
              />
              {/* Live Time Pin */}
              <div
                className="absolute -top-1.5 w-6 h-6 -ml-3 rounded-full bg-[#151922] border-2 border-[#FF4634] flex items-center justify-center shadow-lg"
                style={{ left: `${timelinePercent}%` }}
                title={nowParts.displayTime}
              >
                <span className="w-2 h-2 rounded-full bg-[#FF6A33]" />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 mt-5 text-xs">
            <div className="p-3 rounded-xl bg-[#1B1F28] border border-[#292D36]">
              <div className="text-[#A1A1AA]">Office Start</div>
              <div className="font-mono font-semibold text-[#FFFFFF] mt-1">
                {formatMinutesAsClock12(sched.workStartTime)}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-[#1B1F28] border border-amber-500/30">
              <div className="text-amber-300 flex items-center gap-1.5">
                <Coffee className="w-3.5 h-3.5" />
                Lunch ({sched.scheduledLunchMinutes}m)
              </div>
              <div className="font-mono font-semibold text-[#FFFFFF] mt-1">
                {formatMinutesAsClock12(sched.lunchStartTime)} – {formatMinutesAsClock12(sched.lunchEndTime)}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-[#1B1F28] border border-[#292D36]">
              <div className="text-[#A1A1AA]">Office End</div>
              <div className="font-mono font-semibold text-[#FFFFFF] mt-1">
                {formatMinutesAsClock12(sched.workEndTime)}
              </div>
            </div>
          </div>
        </div>

        {/* Pending Approvals */}
        <div className="lg:col-span-5 bg-[#151922] border border-[#292D36] rounded-2xl p-5 sm:p-6 shadow-md shadow-black/15">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-display text-base font-semibold text-[#FFFFFF]">
                Pending Approvals
              </h2>
              <p className="text-sm text-[#D4D4D8] mt-1">
                {metrics.pendingLeaves + metrics.pendingOther} awaiting review
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('leave')}
              className="text-xs font-medium text-[#FF6A33] hover:text-[#FF4634]"
            >
              Review queue
            </button>
          </div>

          {pendingItems.length === 0 ? (
            <div className="py-10 flex flex-col items-center justify-center text-center border border-dashed border-[#292D36] rounded-xl bg-[#0B0D12]/40">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 mb-2" />
              <p className="text-xs text-[#A1A1AA]">All leave, attendance, and exit approvals are clear.</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {pendingItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onNavigate(item.tab)}
                  className="w-full flex items-center justify-between gap-3 p-3 rounded-xl bg-[#1B1F28] border border-[#292D36] hover:border-[#FF4634]/50 text-left transition-colors"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-[#FFFFFF] truncate">{item.title}</div>
                    <div className="text-[11px] text-[#A1A1AA] truncate mt-0.5">{item.subtitle}</div>
                  </div>
                  <span className="px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] font-semibold shrink-0">
                    {item.kind}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {isManagementRole(effectiveRole) && (
        <section className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-display text-base font-semibold text-[#FFFFFF]">Team Today</h2>
              <p className="text-sm text-[#D4D4D8] mt-1">
                Live presence, leave and active break status · {selectedDeptName}
              </p>
            </div>
            <Users className="w-5 h-5 text-[#FF6A33]" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            {[
              ['Present', teamStatusCounts.present],
              ['On leave', teamStatusCounts.onLeave],
              ['On break', teamStatusCounts.onBreak],
              ['Late / missing', teamStatusCounts.late],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl bg-[#1B1F28] border border-[#292D36] p-3">
                <div className="text-sm text-[#D4D4D8]">{label}</div>
                <div className="text-xl font-semibold text-white mt-1 font-mono tabular-nums">{value}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-2">
            {teamToday.slice(0, 18).map((person) => (
              <div key={person.id} className="flex items-center justify-between gap-3 text-sm border-b border-[#292D36]/70 py-2">
                <span className="text-[#F4F4F5] truncate">{person.name}</span>
                <span className="text-[#D4D4D8] text-xs font-medium shrink-0">{person.status}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 5. Primary Charts Row: Monthly Attendance Trend (Line) + Department Distribution (Donut) */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Monthly Attendance Trend - Line Chart */}
        <div className="lg:col-span-8 bg-[#151922] border border-[#292D36] rounded-2xl p-5 sm:p-6 shadow-md shadow-black/15 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-5">
            <div>
              <h2 className="font-display text-base font-semibold text-[#FFFFFF]">
                Monthly Attendance Trend
              </h2>
              <p className="text-sm text-[#D4D4D8] mt-1">
                Daily check-in consistency across {dateWindow.label}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-[11px] text-[#A1A1AA]">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#FF6A33]" />
                On Time
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#FF6A33]" />
                Late
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#FF9A65]" />
                Half / Early
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#FF4634]" />
                Total Present
              </span>
            </div>
          </div>

          {attendanceTrendSeries.length === 0 ? (
            <ChartEmptyState
              icon={Activity}
              title="No attendance logs in selected range"
              description={`No check-in records found for ${selectedDeptName} between ${dateWindow.start} and ${dateWindow.end}.`}
              actionLabel="Open Attendance Module"
              onAction={() => onNavigate('attendance')}
            />
          ) : (
            <div className="h-64 w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={attendanceTrendSeries} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} vertical={false} />
                  <XAxis dataKey="date" stroke={chartTheme.axisStroke} fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke={chartTheme.axisStroke} fontSize={11} allowDecimals={false} tickLine={false} axisLine={false} />
                  <Tooltip content={<AceChartTooltip />} />
                  <Line
                    type="monotone"
                    dataKey="present"
                    name="Total Present"
                    stroke="#FF4634"
                    strokeWidth={2.5}
                    dot={{ r: 3, fill: '#FF4634', strokeWidth: 0 }}
                    activeDot={{ r: 5, fill: '#FF4634', stroke: '#FFFFFF', strokeWidth: 1.5 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="onTime"
                    name="On Time"
                    stroke="#FF6A33"
                    strokeWidth={2}
                    dot={{ r: 2.5, fill: '#FF6A33', strokeWidth: 0 }}
                    activeDot={{ r: 4 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="late"
                    name="Late"
                    stroke="#FF6A33"
                    strokeWidth={2}
                    dot={{ r: 2.5, fill: '#FF6A33', strokeWidth: 0 }}
                    activeDot={{ r: 4 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="halfOrEarly"
                    name="Half / Early"
                    stroke="#FF9A65"
                    strokeWidth={1.75}
                    strokeDasharray="4 3"
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Department-wise Employee Distribution - Donut Chart */}
        <div className="lg:col-span-4 bg-[#151922] border border-[#292D36] rounded-2xl p-5 sm:p-6 shadow-md shadow-black/15 min-w-0 flex flex-col">
          <div className="flex items-start justify-between gap-2 mb-3">
            <div>
              <h2 className="font-display text-base font-semibold text-[#FFFFFF]">
                Department Distribution
              </h2>
              <p className="text-sm text-[#D4D4D8] mt-1">
                Click a department to filter dashboard
              </p>
            </div>
            {departmentFilter !== 'all' && (
              <button
                type="button"
                onClick={() => setDepartmentFilter('all')}
                className="text-[11px] font-medium text-[#FF6A33] hover:text-[#FF4634] shrink-0"
              >
                Show All
              </button>
            )}
          </div>

          {deptDistribution.length === 0 ? (
            <ChartEmptyState
              icon={Users}
              title="No employee directory records"
              description="Add employees or onboard team members to visualize department headcount."
              actionLabel="Add Employees"
              onAction={() => onNavigate('employees')}
            />
          ) : (
            <div className="flex-1 flex flex-col justify-between">
              <div className="relative h-48 w-full min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={deptDistribution}
                      dataKey="count"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={52}
                      outerRadius={78}
                      paddingAngle={3}
                      stroke="#151922"
                      strokeWidth={2}
                      onClick={(_, idx) => {
                        const target = deptDistribution[idx];
                        if (target && target.id) {
                          setDepartmentFilter((prev) => (prev === target.id ? 'all' : target.id));
                        }
                      }}
                      className="cursor-pointer outline-none"
                    >
                      {deptDistribution.map((entry, idx) => {
                        const isDimmed = departmentFilter !== 'all' && departmentFilter !== entry.id;
                        return (
                          <Cell
                            key={entry.id}
                            fill={DONUT_COLORS[idx % DONUT_COLORS.length]}
                            fillOpacity={isDimmed ? 0.28 : 1}
                          />
                        );
                      })}
                    </Pie>
                    <Tooltip
                      content={
                        <AceChartTooltip
                          valueFormatter={(val) => `${val} member${val === 1 ? '' : 's'}`}
                        />
                      }
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="font-mono text-xl font-bold text-[#FFFFFF] tabular-nums">
                    {filteredDirectory.length}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-[#A1A1AA]">
                    {departmentFilter === 'all' ? 'Total' : 'Filtered'}
                  </span>
                </div>
              </div>

              <div className="space-y-1.5 mt-3 max-h-32 overflow-y-auto pr-1">
                {deptDistribution.map((d, idx) => {
                  const isSelected = departmentFilter === d.id;
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() =>
                        setDepartmentFilter((prev) => (prev === d.id ? 'all' : d.id))
                      }
                      className={`w-full flex items-center justify-between text-xs px-2.5 py-1.5 rounded-lg transition-colors ${
                        isSelected
                          ? 'bg-[#FF4634]/15 border border-[#FF4634]/40 text-[#FFFFFF]'
                          : 'hover:bg-[#0B0D12]/60 text-[#A1A1AA]'
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0 truncate">
                        <span
                          className="w-2.5 h-2.5 rounded-sm shrink-0"
                          style={{ backgroundColor: DONUT_COLORS[idx % DONUT_COLORS.length] }}
                        />
                        <span className="truncate">{d.name}</span>
                      </span>
                      <span className="font-mono font-semibold text-[#FFFFFF] tabular-nums ml-2">
                        {d.count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 6. Attendance Analytics Row: Present vs Absent + Late Arrival & Working Hours */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 sm:p-6 shadow-md shadow-black/15 min-w-0">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-display text-base font-semibold text-[#FFFFFF]">
                Present vs Absent & Late Arrivals
              </h2>
              <p className="text-sm text-[#D4D4D8] mt-1">
                Daily headcount turnout and late arrival tracking · {dateWindow.label}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('attendance')}
              className="text-xs font-medium text-[#FF6A33] hover:text-[#FF4634]"
            >
              Full analytics
            </button>
          </div>
          {attendanceTrendSeries.length === 0 ? (
            <ChartEmptyState
              icon={Activity}
              title="No attendance turnout recorded"
              description="Check-ins and marked logs will populate Present, Absent, and Late Arrival charts."
              actionLabel="View Attendance"
              onAction={() => onNavigate('attendance')}
            />
          ) : (
            <div className="h-64 w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={attendanceTrendSeries} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} vertical={false} />
                  <XAxis dataKey="date" stroke={chartTheme.axisStroke} fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke={chartTheme.axisStroke} fontSize={11} allowDecimals={false} tickLine={false} axisLine={false} />
                  <Tooltip content={<AceChartTooltip />} cursor={{ fill: chartTheme.cursorFill }} />
                  <Bar dataKey="present" name="Present" fill="#FF6A33" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="absent" name="Absent" fill="#FF4634" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="late" name="Late" fill="#FF9A65" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 sm:p-6 shadow-md shadow-black/15 min-w-0">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-display text-base font-semibold text-[#FFFFFF]">
                Department Attendance & Working Hours
              </h2>
              <p className="text-sm text-[#D4D4D8] mt-1">
                Average net hours worked (excluding lunch) vs {formatDurationMinutes(sched.netWorkingTargetMinutes)} target
              </p>
            </div>
          </div>
          {deptAttendanceSeries.length === 0 && attendanceTrendSeries.length === 0 ? (
            <ChartEmptyState
              icon={Clock}
              title="No working hours logged yet"
              description="Checked-out shifts will plot average department net working hours here."
              actionLabel="Open Attendance"
              onAction={() => onNavigate('attendance')}
            />
          ) : (
            <div className="h-64 w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={
                    deptAttendanceSeries.length > 0
                      ? deptAttendanceSeries.map((d) => ({ label: d.department, avgHours: d.avgHours }))
                      : attendanceTrendSeries.map((d) => ({ label: d.date, avgHours: d.avgHours }))
                  }
                  margin={{ top: 8, right: 12, left: -16, bottom: 0 }}
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
                  <Tooltip
                    content={<AceChartTooltip valueFormatter={(val) => `${val} hrs`} />}
                    cursor={{ fill: chartTheme.cursorFill }}
                  />
                  <Bar dataKey="avgHours" name="Avg Net Hours" fill="#FF4634" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </section>

      {/* 7. Secondary Analytics Row: Leave Analytics (Bar) + Recruitment Funnel */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Leave Analytics - Bar Chart */}
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 sm:p-6 shadow-md shadow-black/15 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
            <div>
              <h2 className="font-display text-base font-semibold text-[#FFFFFF]">
                Leave Analytics
              </h2>
              <p className="text-sm text-[#D4D4D8] mt-1">
                {leaveChartMode === 'by_type'
                  ? `Requests by category · ${dateWindow.label}`
                  : 'Monthly approved & pending leave volume'}
              </p>
            </div>
            <div className="inline-flex p-1 bg-[#0B0D12] border border-[#292D36] rounded-xl self-start">
              <button
                type="button"
                onClick={() => setLeaveChartMode('by_type')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${
                  leaveChartMode === 'by_type'
                    ? 'bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-white'
                    : 'text-[#A1A1AA] hover:text-[#FFFFFF]'
                }`}
              >
                By Type
              </button>
              <button
                type="button"
                onClick={() => setLeaveChartMode('by_month')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${
                  leaveChartMode === 'by_month'
                    ? 'bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-white'
                    : 'text-[#A1A1AA] hover:text-[#FFFFFF]'
                }`}
              >
                Monthly
              </button>
            </div>
          </div>

          {leaveChartMode === 'by_type' ? (
            !leaveAnalytics.hasTypeData ? (
              <ChartEmptyState
                icon={CalendarOff}
                title="No leave requests in selected range"
                description={`No leave applications overlap ${dateWindow.start} – ${dateWindow.end} for ${selectedDeptName}.`}
                actionLabel="Manage Leaves"
                onAction={() => onNavigate('leave')}
              />
            ) : (
              <div className="h-64 w-full min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={leaveAnalytics.byType} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} vertical={false} />
                    <XAxis dataKey="label" stroke={chartTheme.axisStroke} fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke={chartTheme.axisStroke} fontSize={11} allowDecimals={false} tickLine={false} axisLine={false} />
                    <Tooltip content={<AceChartTooltip />} cursor={{ fill: chartTheme.cursorFill }} />
                    <Bar dataKey="approved" name="Approved" stackId="leave" fill="#FF6A33" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="pending" name="Pending" stackId="leave" fill="#FF9A65" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="rejected" name="Rejected" stackId="leave" fill="#FF4634" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )
          ) : leaveAnalytics.byMonth.length === 0 ? (
            <ChartEmptyState
              icon={CalendarOff}
              title="No leave history recorded"
              description="Submitted employee leave requests will appear chronologically here."
              actionLabel="View Leave Portal"
              onAction={() => onNavigate('leave')}
            />
          ) : (
            <div className="h-64 w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={leaveAnalytics.byMonth} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} vertical={false} />
                  <XAxis dataKey="month" stroke={chartTheme.axisStroke} fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke={chartTheme.axisStroke} fontSize={11} allowDecimals={false} tickLine={false} axisLine={false} />
                  <Tooltip content={<AceChartTooltip />} cursor={{ fill: chartTheme.cursorFill }} />
                  <Bar dataKey="approved" name="Approved Requests" fill="#FF4634" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="pending" name="Pending Requests" fill="#FF6A33" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Recruitment Funnel */}
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 sm:p-6 shadow-md shadow-black/15 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-5">
            <div>
              <h2 className="font-display text-base font-semibold text-[#FFFFFF]">
                Recruitment Funnel
              </h2>
              <p className="text-sm text-[#D4D4D8] mt-1">
                {recruitmentFunnel.openRoles} open roles · {recruitmentFunnel.openPositions} positions · {recruitmentFunnel.rejectedCount} archived
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('recruitment')}
              className="text-xs font-medium text-[#FF6A33] hover:text-[#FF4634] self-start sm:self-center"
            >
              Pipeline
            </button>
          </div>

          {recruitmentFunnel.totalCandidates === 0 ? (
            <ChartEmptyState
              icon={Briefcase}
              title="No active candidates in pipeline"
              description={
                departmentFilter === 'all'
                  ? 'Post job openings and track applicants across screening, interviews, and offers.'
                  : `No applicants currently linked to ${selectedDeptName} openings.`
              }
              actionLabel="Open Recruitment"
              onAction={() => onNavigate('recruitment')}
            />
          ) : (
            <div className="h-64 w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={recruitmentFunnel.series}
                  layout="vertical"
                  margin={{ top: 4, right: 20, left: 12, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#292D36" horizontal={false} />
                  <XAxis type="number" stroke={chartTheme.axisStroke} fontSize={11} allowDecimals={false} tickLine={false} axisLine={false} />
                  <YAxis
                    type="category"
                    dataKey="stage"
                    stroke={chartTheme.tooltipText}
                    fontSize={12}
                    width={76}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    content={
                      <AceChartTooltip
                        valueFormatter={(val) => `${val} candidate${val === 1 ? '' : 's'}`}
                      />
                    }
                    cursor={{ fill: chartTheme.cursorFill }}
                  />
                  <Bar dataKey="count" name="Candidates" radius={[0, 6, 6, 0]} barSize={22}>
                    {recruitmentFunnel.series.map((entry) => (
                      <Cell key={entry.key} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </section>

      {/* 8. Financial & Growth Row: Monthly Payroll Overview + Employee Growth Analytics */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Monthly Payroll Overview */}
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 sm:p-6 shadow-md shadow-black/15 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-5">
            <div>
              <h2 className="font-display text-base font-semibold text-[#FFFFFF]">
                Monthly Payroll Overview
              </h2>
              <p className="text-sm text-[#D4D4D8] mt-1">
                {payrollOverview.latestRun
                  ? `Latest cycle (${payrollOverview.latestRun.month}): Net ${formatCurrency(
                      payrollOverview.latestRun.net
                    )} across ${payrollOverview.latestRun.employees} staff`
                  : `Gross, net, and deductions (${payrollConfig.currency})`}
              </p>
            </div>
            {(effectiveRole === 'super_admin' || effectiveRole === 'hr_manager') && (
              <button
                type="button"
                onClick={() => onNavigate('payroll')}
                className="text-xs font-medium text-[#FF6A33] hover:text-[#FF4634] self-start sm:self-center"
              >
                Payroll Runs
              </button>
            )}
          </div>

          {(effectiveRole === 'dept_manager' || effectiveRole === 'team_lead') ? (
            <ChartEmptyState
              icon={Lock}
              title="Payroll access restricted by role"
              description="Company-wide payroll run financials are restricted to HR Managers and Super Admins per Firestore security policy."
            />
          ) : payrollOverview.series.length === 0 ? (
            <ChartEmptyState
              icon={Wallet}
              title="No payroll runs processed yet"
              description="Generate a monthly payroll cycle to track gross disbursement, net payouts, and deductions."
              actionLabel="Run Payroll"
              onAction={() => onNavigate('payroll')}
            />
          ) : (
            <div className="h-64 w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={payrollOverview.series} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} vertical={false} />
                  <XAxis dataKey="month" stroke={chartTheme.axisStroke} fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis
                    stroke={chartTheme.axisStroke}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) =>
                      v >= 1000 ? `${currencySymbol}${Math.round(v / 1000)}k` : `${currencySymbol}${v}`
                    }
                  />
                  <Tooltip
                    content={<AceChartTooltip valueFormatter={(val) => formatCurrency(val)} />}
                    cursor={{ fill: chartTheme.cursorFill }}
                  />
                  <Bar dataKey="gross" name="Gross Pay" fill="#FF6A33" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="net" name="Net Pay" fill="#FF4634" radius={[4, 4, 0, 0]} />
                  <Line
                    type="monotone"
                    dataKey="deductions"
                    name="Deductions"
                    stroke="#FF9A65"
                    strokeWidth={2}
                    dot={{ r: 3, fill: '#FF9A65' }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Employee Growth Analytics */}
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 sm:p-6 shadow-md shadow-black/15 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-5">
            <div>
              <h2 className="font-display text-base font-semibold text-[#FFFFFF]">
                Employee Growth Analytics
              </h2>
              <p className="text-sm text-[#D4D4D8] mt-1">
                Cumulative headcount & monthly joiners · {selectedDeptName}
              </p>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-[#A1A1AA]">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#FF4634]" />
                Headcount
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#FF6A33]" />
                New Joiners
              </span>
            </div>
          </div>

          {employeeGrowthSeries.length === 0 ? (
            <ChartEmptyState
              icon={TrendingUp}
              title="No joining dates recorded"
              description="Employee joining dates will plot organizational headcount growth over time."
              actionLabel="View Directory"
              onAction={() => onNavigate('employees')}
            />
          ) : (
            <div className="h-64 w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={employeeGrowthSeries} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="aceGrowthFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#FF4634" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#FF4634" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} vertical={false} />
                  <XAxis dataKey="month" stroke={chartTheme.axisStroke} fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke={chartTheme.axisStroke} fontSize={11} allowDecimals={false} tickLine={false} axisLine={false} />
                  <Tooltip content={<AceChartTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="totalHeadcount"
                    name="Cumulative Headcount"
                    stroke="#FF4634"
                    strokeWidth={2.5}
                    fill="url(#aceGrowthFill)"
                  />
                  <Area
                    type="monotone"
                    dataKey="newJoiners"
                    name="New Joiners"
                    stroke="#FF6A33"
                    strokeWidth={2}
                    fill="transparent"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </section>

      {/* 9. Bottom Row: Upcoming Birthdays, Work Anniversaries & Recent Announcements */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Upcoming Birthdays */}
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 sm:p-6 shadow-md shadow-black/15">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-display text-sm font-semibold text-[#FFFFFF]">
                Upcoming Birthdays
              </h2>
              <p className="text-[11px] text-[#A1A1AA] mt-0.5">Next 30 days</p>
            </div>
            <span className="w-8 h-8 rounded-xl bg-[#FF4634]/10 border border-[#FF4634]/20 flex items-center justify-center text-[#FF6A33]">
              <Cake className="w-4 h-4" />
            </span>
          </div>

          {upcomingEvents.birthdays.length === 0 ? (
            <div className="py-8 flex flex-col items-center justify-center text-center border border-dashed border-[#292D36] rounded-xl bg-[#0B0D12]/40">
              <Inbox className="w-5 h-5 text-[#A1A1AA]/60 mb-2" />
              <p className="text-xs text-[#A1A1AA]">No upcoming birthdays in the next 30 days.</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {upcomingEvents.birthdays.slice(0, 5).map((b) => (
                <div
                  key={`${b.name}-${b.date}`}
                  className="flex items-center justify-between text-xs py-2 px-3 rounded-xl bg-[#1B1F28] border border-[#292D36]"
                >
                  <div className="min-w-0 pr-2">
                    <div className="text-[#FFFFFF] font-medium truncate">{b.name}</div>
                    <div className="text-[#A1A1AA] text-[11px] truncate">{b.dept}</div>
                  </div>
                  <span className="font-mono text-[#FF6A33] font-semibold tabular-nums shrink-0">
                    {b.date}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Work Anniversaries */}
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 sm:p-6 shadow-md shadow-black/15">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-display text-sm font-semibold text-[#FFFFFF]">
                Work Anniversaries
              </h2>
              <p className="text-[11px] text-[#A1A1AA] mt-0.5">Next 30 days</p>
            </div>
            <span className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <Award className="w-4 h-4" />
            </span>
          </div>

          {upcomingEvents.anniversaries.length === 0 ? (
            <div className="py-8 flex flex-col items-center justify-center text-center border border-dashed border-[#292D36] rounded-xl bg-[#0B0D12]/40">
              <Inbox className="w-5 h-5 text-[#A1A1AA]/60 mb-2" />
              <p className="text-xs text-[#A1A1AA]">No work anniversaries in the next 30 days.</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {upcomingEvents.anniversaries.slice(0, 5).map((a) => (
                <div
                  key={`${a.name}-${a.date}`}
                  className="flex items-center justify-between text-xs py-2 px-3 rounded-xl bg-[#1B1F28] border border-[#292D36]"
                >
                  <div className="min-w-0 pr-2">
                    <div className="text-[#FFFFFF] font-medium truncate">{a.name}</div>
                    <div className="text-[#A1A1AA] text-[11px] truncate">
                      {a.dept} · {a.years} yr{a.years > 1 ? 's' : ''}
                    </div>
                  </div>
                  <span className="font-mono text-emerald-400 font-semibold tabular-nums shrink-0">
                    {a.date}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Announcements */}
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 sm:p-6 shadow-md shadow-black/15">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-xl bg-[#FF4634]/10 border border-[#FF4634]/20 flex items-center justify-center text-[#FF6A33]">
                <Megaphone className="w-4 h-4" />
              </span>
              <div>
                <h2 className="font-display text-sm font-semibold text-[#FFFFFF]">
                  Recent Announcements
                </h2>
                <p className="text-[11px] text-[#A1A1AA] mt-0.5">Company updates</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('announcements')}
              className="text-xs font-medium text-[#FF6A33] hover:text-[#FF4634]"
            >
              View all
            </button>
          </div>

          {sortedAnnouncements.length === 0 ? (
            <div className="py-8 flex flex-col items-center justify-center text-center border border-dashed border-[#292D36] rounded-xl bg-[#0B0D12]/40">
              <Megaphone className="w-5 h-5 text-[#A1A1AA]/60 mb-2" />
              <p className="text-xs text-[#A1A1AA]">No company announcements published yet.</p>
              <button
                type="button"
                onClick={() => onNavigate('announcements')}
                className="mt-2.5 text-xs font-medium text-[#FF6A33] hover:text-[#FF4634]"
              >
                Publish Announcement
              </button>
            </div>
          ) : (
            <div className="space-y-2.5">
              {sortedAnnouncements.map((ann) => (
                <button
                  key={ann.id}
                  type="button"
                  onClick={() => onNavigate('announcements')}
                  className="w-full text-left py-2.5 px-3 rounded-xl bg-[#1B1F28] border border-[#292D36] hover:border-[#FF4634]/40 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-[#FFFFFF] truncate">{ann.title}</span>
                    {ann.pinned && (
                      <Pin className="w-3 h-3 text-[#FF6A33] shrink-0" aria-label="Pinned" />
                    )}
                  </div>
                  <div className="text-[11px] text-[#A1A1AA] mt-1 capitalize truncate">
                    {ann.category} · {ann.authorName}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
