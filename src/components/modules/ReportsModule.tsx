import React, { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Download, FileSpreadsheet } from 'lucide-react';
import { db } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import { exportToCsv, exportToXlsx, formatCurrency, generateReportPdf } from '../../utils/exportUtils';
import { getChartTheme, useThemeMode } from '../../utils/themeUtils';
import { filterVisibleLeaveRequests, isManagementRole } from '../../utils/workflowUtils';

type ReportKind =
  | 'employee'
  | 'attendance'
  | 'leave'
  | 'payroll'
  | 'recruitment'
  | 'department'
  | 'performance'
  | 'joining_exit'
  | 'monitoring';

interface SnapshotSummary {
  id: string;
  employeeName: string;
  departmentId: string;
  date: string;
  activeApp: string;
  activityPercent: number;
  idleSeconds: number;
}

export const ReportsModule: React.FC = () => {
  const { firebaseUser, effectiveRole, employeeProfile, roleAssignment } = useAuth();
  const {
    employees,
    directory,
    attendance,
    leaveRequests,
    payslips,
    candidates,
    departments,
    reviews,
    offboardingCases,
    payrollConfig,
  } = useHrmsData();
  const { isLight } = useThemeMode();
  const chartTheme = getChartTheme(isLight);

  const canSeePayroll = effectiveRole === 'super_admin' || effectiveRole === 'hr_manager';
  const canSeeMonitoring = isManagementRole(effectiveRole);
  const deptId = roleAssignment?.departmentId || employeeProfile?.departmentId || '';

  const [reportType, setReportType] = useState<ReportKind>('employee');
  const [fromDate, setFromDate] = useState(new Date().toISOString().slice(0, 7) + '-01');
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));
  const [deptFilter, setDeptFilter] = useState('all');
  const [monitoringSnaps, setMonitoringSnaps] = useState<SnapshotSummary[]>([]);

  useEffect(() => {
    if (!canSeeMonitoring) return;
    const isDeptScoped = effectiveRole === 'dept_manager' || effectiveRole === 'team_lead';
    const q = isDeptScoped
      ? query(collection(db, 'monitoringSnapshots'), where('departmentId', '==', deptId || '__unassigned_scope__'))
      : collection(db, 'monitoringSnapshots');
    return onSnapshot(
      q,
      (snap) => setMonitoringSnaps(snap.docs.map((d) => ({ id: d.id, ...d.data() } as SnapshotSummary))),
      () => {}
    );
  }, [canSeeMonitoring, effectiveRole, deptId]);

  const reportData = useMemo(() => {
    const matchDept = (dId?: string) => deptFilter === 'all' || dId === deptFilter;

    switch (reportType) {
      case 'employee': {
        const list = employees.filter((e) => matchDept(e.departmentId));
        return {
          title: 'Employee Roster Report',
          columns: ['Code', 'Name', 'Department', 'Designation', 'Type', 'Joined', 'Status'],
          rows: list.map((e) => [e.employeeCode, e.fullName, e.departmentName, e.designation, e.employmentType, e.joiningDate, e.status]),
          chart: departments.map((d) => ({
            name: d.code,
            value: list.filter((e) => e.departmentId === d.id).length,
          })),
        };
      }
      case 'attendance': {
        const list = attendance.filter((a) => a.date >= fromDate && a.date <= toDate && matchDept(a.departmentId));
        return {
          title: 'Attendance Summary Report',
          columns: ['Date', 'Employee', 'Net Worked Hours', 'Lunch / Break (m)', 'Late', 'Status'],
          rows: list.map((a) => [
            a.date,
            a.employeeName,
            (a.workingMinutes / 60).toFixed(2),
            a.actualLunchMinutes ?? a.breakMinutes,
            a.isLate ? 'Yes' : 'No',
            a.status,
          ]),
          chart: ['present', 'late', 'half_day', 'absent'].map((st) => ({
            name: st.replace('_', ' '),
            value: list.filter((a) => a.status === st).length,
          })),
        };
      }
      case 'leave': {
        const visibleLeaves = filterVisibleLeaveRequests(leaveRequests, firebaseUser?.uid || '', effectiveRole, deptId);
        const list = visibleLeaves.filter((l) => l.startDate >= fromDate && l.startDate <= toDate && matchDept(l.departmentId));
        return {
          title: 'Leave Utilization Report',
          columns: ['Employee', 'Type', 'Start', 'End', 'Days', 'Status'],
          rows: list.map((l) => [l.employeeName, l.leaveType, l.startDate, l.endDate, l.daysCount, l.status]),
          chart: ['casual', 'sick', 'paid', 'emergency', 'unpaid', 'short'].map((tp) => ({
            name: tp,
            value: list.filter((l) => l.leaveType === tp).reduce((s, x) => s + x.daysCount, 0),
          })),
        };
      }
      case 'payroll': {
        const list = canSeePayroll ? payslips.filter((p) => matchDept(p.departmentId)) : [];
        return {
          title: 'Payroll Disbursement Report',
          columns: ['Month', 'Employee', 'Department', 'Gross Pay', 'Deductions', 'Net Pay'],
          rows: list.map((p) => [
            p.month,
            p.employeeName,
            p.departmentName || '-',
            formatCurrency(p.grossPay, p.currency),
            formatCurrency(p.unpaidLeaveDeduction + p.otherDeductions, p.currency),
            formatCurrency(p.netPay, p.currency),
          ]),
          chart: list.slice(0, 10).map((p) => ({ name: p.employeeName.split(' ')[0], value: p.netPay })),
        };
      }
      case 'recruitment': {
        return {
          title: 'Recruitment Funnel Report',
          columns: ['Candidate', 'Job Title', 'Email', 'Stage', 'Interview Date', 'Rating'],
          rows: candidates.map((c) => [c.fullName, c.jobTitle, c.email, c.stage, c.interviewDate || '-', c.rating ?? 0]),
          chart: ['applied', 'screening', 'interview', 'offer', 'selected', 'rejected'].map((st) => ({
            name: st,
            value: candidates.filter((c) => c.stage === st).length,
          })),
        };
      }
      case 'department': {
        const visibleLeaves = filterVisibleLeaveRequests(leaveRequests, firebaseUser?.uid || '', effectiveRole, deptId);
        return {
          title: 'Department Headcount & Activity Report',
          columns: ['Code', 'Department', 'Head', 'Active Employees', 'Pending Leaves'],
          rows: departments.map((d) => [
            d.code,
            d.name,
            d.headName || '-',
            directory.filter((e) => e.departmentId === d.id && e.status === 'active').length,
            visibleLeaves.filter((l) => l.departmentId === d.id && l.status === 'pending').length,
          ]),
          chart: departments.map((d) => ({
            name: d.code,
            value: directory.filter((e) => e.departmentId === d.id).length,
          })),
        };
      }
      case 'performance': {
        const list = reviews.filter((r) => matchDept(r.departmentId));
        return {
          title: 'Performance Evaluation Report',
          columns: ['Period', 'Employee', 'Reviewer', 'Rating', 'Weighted / Prod %', 'Status'],
          rows: list.map((r) => [
            r.reviewPeriod,
            r.employeeName,
            r.reviewerName,
            r.rating,
            r.weightedScore ?? r.productivityScore,
            r.status,
          ]),
          chart: list.slice(0, 10).map((r) => ({
            name: r.employeeName.split(' ')[0],
            value: r.weightedScore ?? r.productivityScore,
          })),
        };
      }
      case 'joining_exit': {
        const joined = directory.filter((d) => d.joiningDate >= fromDate && d.joiningDate <= toDate && matchDept(d.departmentId));
        const exited = offboardingCases.filter((o) => o.resignationDate >= fromDate && o.resignationDate <= toDate && matchDept(o.departmentId));
        return {
          title: 'Joining & Exit Movement Report',
          columns: ['Event', 'Employee', 'Date', 'Details / Status'],
          rows: [
            ...joined.map((j) => ['Joining', j.fullName, j.joiningDate, `${j.designation} (${j.departmentName})`]),
            ...exited.map((x) => ['Exit', x.employeeName, x.lastWorkingDay, `${x.status} (${x.approvalStatus})`]),
          ],
          chart: [
            { name: 'Joinings', value: joined.length },
            { name: 'Exits', value: exited.length },
          ],
        };
      }
      case 'monitoring': {
        const list = monitoringSnaps.filter((s) => s.date >= fromDate && s.date <= toDate && matchDept(s.departmentId));
        const byEmp = new Map<string, { name: string; samples: number; activitySum: number; idleSeconds: number }>();
        list.forEach((s) => {
          const prev = byEmp.get(s.employeeName) || { name: s.employeeName, samples: 0, activitySum: 0, idleSeconds: 0 };
          prev.samples += 1;
          prev.activitySum += Number(s.activityPercent || 0);
          prev.idleSeconds += Number(s.idleSeconds || 0);
          byEmp.set(s.employeeName, prev);
        });
        const aggregated = [...byEmp.values()];
        return {
          title: 'Monitoring & Working Hours Report',
          columns: ['Employee', 'Samples Captured', 'Avg Activity %', 'Sampled Idle (min)', 'Logged Net Hours'],
          rows: aggregated.map((emp) => {
            const workedHours = attendance
              .filter((a) => a.employeeName === emp.name && a.date >= fromDate && a.date <= toDate)
              .reduce((sum, a) => sum + (a.workingMinutes || 0) / 60, 0);
            return [
              emp.name,
              emp.samples,
              Math.round(emp.activitySum / Math.max(1, emp.samples)),
              Math.floor(emp.idleSeconds / 60),
              workedHours.toFixed(2),
            ];
          }),
          chart: aggregated.slice(0, 10).map((emp) => ({
            name: emp.name.split(' ')[0],
            value: Math.round(emp.activitySum / Math.max(1, emp.samples)),
          })),
        };
      }
    }
  }, [
    reportType,
    fromDate,
    toDate,
    deptFilter,
    employees,
    directory,
    attendance,
    leaveRequests,
    payslips,
    candidates,
    departments,
    reviews,
    offboardingCases,
    monitoringSnaps,
    canSeePayroll,
    firebaseUser?.uid,
    effectiveRole,
    deptId,
  ]);

  const reportTabs: { id: ReportKind; label: string }[] = [
    { id: 'employee', label: 'Employees' },
    { id: 'attendance', label: 'Attendance' },
    { id: 'leave', label: 'Leaves' },
    ...(canSeePayroll ? [{ id: 'payroll' as ReportKind, label: `Payroll (${payrollConfig.currency})` }] : []),
    ...(canSeeMonitoring ? [{ id: 'monitoring' as ReportKind, label: 'Monitoring & Hours' }] : []),
    { id: 'recruitment', label: 'Recruitment' },
    { id: 'department', label: 'Departments' },
    { id: 'performance', label: 'Performance' },
    { id: 'joining_exit', label: 'Joining & Exit' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#FFFFFF]">Reports & Analytics</h1>
          <p className="text-sm text-[#A1A1AA] mt-1">
            Filter workforce records and export real-time CSV, Excel (.xlsx), or formatted PDF reports
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => exportToCsv(`ace_${reportType}_report`, reportData.columns, reportData.rows)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#151922] border border-[#292D36] text-[#FFFFFF] hover:border-[#FF4634]/40 text-xs font-medium rounded-xl transition-colors"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-[#FF6A33]" />
            Export CSV
          </button>
          <button
            type="button"
            onClick={() =>
              void exportToXlsx(`ace_${reportType}_report`, reportData.columns, reportData.rows, reportData.title)
            }
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#151922] border border-[#292D36] text-[#FFFFFF] hover:border-[#FF4634]/40 text-xs font-medium rounded-xl transition-colors"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
            Export XLSX
          </button>
          <button
            type="button"
            onClick={() =>
              generateReportPdf(
                reportData.title,
                `Range: ${fromDate} to ${toDate}`,
                reportData.columns,
                reportData.rows
              )
            }
            className="ace-btn-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl"
          >
            <Download className="w-3.5 h-3.5" />
            Download PDF
          </button>
        </div>
      </div>

      {/* Report Selector */}
      <div className="flex flex-wrap gap-1.5 p-1.5 bg-[#151922] border border-[#292D36] rounded-2xl">
        {reportTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setReportType(t.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-xl whitespace-nowrap transition-colors ${
              reportType === t.id
                ? 'bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-white'
                : 'text-[#A1A1AA] hover:text-[#FFFFFF]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Date & Department Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-[#151922] border border-[#292D36] rounded-2xl p-4 text-xs">
        <div>
          <label className="block text-[#A1A1AA] mb-1">From Date</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-lg text-[#FFFFFF] font-mono"
          />
        </div>
        <div>
          <label className="block text-[#A1A1AA] mb-1">To Date</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-lg text-[#FFFFFF] font-mono"
          />
        </div>
        <div>
          <label className="block text-[#A1A1AA] mb-1">Department</label>
          <select
            value={deptFilter}
            onChange={(e) => setDeptFilter(e.target.value)}
            className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-lg text-[#FFFFFF]"
          >
            <option value="all">All Departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Visual Chart */}
      <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5">
        <h2 className="font-display text-base font-semibold text-[#FFFFFF] mb-4">{reportData.title} — Visualization</h2>
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={reportData.chart}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} />
              <XAxis dataKey="name" stroke={chartTheme.axisStroke} tick={{ fill: chartTheme.tickFill, fontSize: 12 }} />
              <YAxis stroke={chartTheme.axisStroke} tick={{ fill: chartTheme.tickFill, fontSize: 12 }} allowDecimals={false} />
              <Tooltip
                cursor={{ fill: chartTheme.cursorFill }}
                contentStyle={{
                  backgroundColor: chartTheme.tooltipBg,
                  borderColor: chartTheme.tooltipBorder,
                  borderRadius: '12px',
                  color: chartTheme.tooltipText,
                }}
              />
              <Bar dataKey="value" fill="#FF4634" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Data Table */}
      <div className="bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden">
        {reportData.rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#A1A1AA]">No records match the selected filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                  {reportData.columns.map((c) => (
                    <th key={c} className="px-4 py-3 text-left font-medium">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#292D36]/70">
                {reportData.rows.map((row, rIdx) => (
                  <tr key={rIdx} className="hover:bg-[#1B1F28]/60 transition-colors">
                    {row.map((cell, cIdx) => (
                      <td key={cIdx} className="px-4 py-3 text-[#FFFFFF] font-mono tabular-nums">
                        {String(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
