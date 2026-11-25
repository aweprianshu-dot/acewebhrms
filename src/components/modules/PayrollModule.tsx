import React, { useMemo, useState } from 'react';
import { doc, writeBatch, setDoc, serverTimestamp } from 'firebase/firestore';
import { Wallet, Play, Download, Edit3, Info, CheckCircle2, X, Eye, FileSpreadsheet, ArrowLeftRight } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import { apiRequest, dispatchNotification, writeAuditLog } from '../../services/hrmsApi';
import { exportToCsv, exportToXlsx, formatCurrency, generatePayslipPdf } from '../../utils/exportUtils';
import { getScheduleMetrics } from '../../utils/attendanceUtils';
import { comparePayrollRuns } from '../../utils/workflowUtils';
import type { EmployeeProfile, PayrollRun, Payslip, SalaryStructure } from '../../types/hrms';

interface DryRunResponse {
  month: string;
  currency: string;
  employeeCount: number;
  totalGross: number;
  totalDeductions: number;
  totalNet: number;
  payslips: Omit<Payslip, 'id' | 'runId' | 'status' | 'createdAt' | 'updatedAt'>[];
}

export const PayrollModule: React.FC = () => {
  const { firebaseUser, effectiveRole } = useAuth();
  const {
    employees,
    salaries,
    attendance,
    leaveRequests,
    payrollRuns,
    payslips,
    payrollConfig,
    companySettings,
    workPolicy,
  } = useHrmsData();

  const [subTab, setSubTab] = useState<'runs' | 'structures' | 'payslips'>('runs');
  const [selectedMonth, setSelectedMonth] = useState(new Date().toISOString().slice(0, 7));
  const [processing, setProcessing] = useState(false);
  const [dryRunning, setDryRunning] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<DryRunResponse | null>(null);
  const [notice, setNotice] = useState('');
  const [errMsg, setErrMsg] = useState('');

  // Salary structure edit modal
  const [editingEmp, setEditingEmp] = useState<EmployeeProfile | null>(null);
  const [salForm, setSalForm] = useState<Partial<SalaryStructure>>({});

  const monthPayslips = useMemo(
    () => payslips.filter((p) => p.month === selectedMonth),
    [payslips, selectedMonth]
  );

  // Build payroll input array shared by Dry-Run and Official Run
  const buildCalculationPayload = () => {
    const activeEmps = employees.filter((e) => e.status === 'active' || e.status === 'onboarding');
    const customAdj = payrollConfig.customRules.reduce((acc, r) => {
      return acc + (r.type === 'addition' ? r.value : -r.value);
    }, 0);

    const items = activeEmps.map((emp) => {
      const sal = salaries.find((s) => s.employeeId === emp.id);
      const empAtt = attendance.filter(
        (a) => (a.employeeId === emp.id || a.uid === emp.uid) && a.date.startsWith(selectedMonth)
      );
      const employeeShiftTarget = getScheduleMetrics({
        ...workPolicy,
        workStartTime: emp.shiftStartTime || workPolicy.workStartTime,
        workEndTime: emp.shiftEndTime || workPolicy.workEndTime,
      }).netWorkingTargetMinutes;
      const overtimeHours = empAtt.reduce((sum, a) => {
        const extraMins = Math.max(0, (a.workingMinutes || 0) - employeeShiftTarget);
        return sum + extraMins / 60;
      }, 0);

      const unpaidLeaveDays =
        leaveRequests
          .filter(
            (l) =>
              (l.employeeId === emp.id || l.uid === emp.uid) &&
              l.leaveType === 'unpaid' &&
              l.status === 'approved' &&
              l.startDate.startsWith(selectedMonth)
          )
          .reduce((sum, l) => sum + l.daysCount, 0) +
        empAtt.reduce((sum, record) => sum + Number(record.latePenaltyDays || 0), 0);

      return {
        employeeId: emp.id,
        uid: emp.uid || '',
        employeeCode: emp.employeeCode,
        employeeName: emp.fullName,
        departmentId: emp.departmentId,
        departmentName: emp.departmentName,
        designation: emp.designation,
        basicSalary: sal?.basicSalary ?? 0,
        hraAllowance: sal?.hraAllowance ?? 0,
        transportAllowance: sal?.transportAllowance ?? 0,
        specialAllowance: sal?.specialAllowance ?? 0,
        bonus: sal?.bonus ?? 0,
        incentives: sal?.incentives ?? 0,
        deductions: sal?.deductions ?? 0,
        overtimeHourlyRate: sal?.overtimeHourlyRate ?? 0,
        overtimeHours: Number(overtimeHours.toFixed(2)),
        unpaidLeaveDays,
        customRuleAdjustment: customAdj,
      };
    });

    return { activeEmps, items };
  };

  // Safe Dry-Run preview (does not write to Firestore or send notifications)
  const runDryCheck = async () => {
    setDryRunning(true);
    setNotice('');
    setErrMsg('');
    try {
      const { activeEmps, items } = buildCalculationPayload();
      if (activeEmps.length === 0) {
        setErrMsg('No active employees available to preview payroll.');
        return;
      }

      const calcResult = await apiRequest<DryRunResponse>('/api/payroll/calculate', {
        method: 'POST',
        body: JSON.stringify({
          month: selectedMonth,
          currency: payrollConfig.currency,
          workingDaysPerMonth: payrollConfig.workingDaysPerMonth,
          overtimeMultiplier: payrollConfig.overtimeMultiplier,
          unpaidLeaveDeductionEnabled: payrollConfig.unpaidLeaveDeductionEnabled,
          items,
        }),
      });
      setDryRunResult(calcResult);
      setNotice(`Dry-run completed for ${selectedMonth} (${calcResult.employeeCount} employees). No records were written.`);
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Payroll dry-run failed.');
    } finally {
      setDryRunning(false);
    }
  };

  const runPayroll = async () => {
    if (!firebaseUser) return;
    setProcessing(true);
    setNotice('');
    setErrMsg('');

    try {
      const { activeEmps, items } = buildCalculationPayload();
      if (activeEmps.length === 0) {
        setErrMsg('No active employees available to process payroll.');
        setProcessing(false);
        return;
      }

      const calcResult = await apiRequest<DryRunResponse>('/api/payroll/calculate', {
        method: 'POST',
        body: JSON.stringify({
          month: selectedMonth,
          currency: payrollConfig.currency,
          workingDaysPerMonth: payrollConfig.workingDaysPerMonth,
          overtimeMultiplier: payrollConfig.overtimeMultiplier,
          unpaidLeaveDeductionEnabled: payrollConfig.unpaidLeaveDeductionEnabled,
          items,
        }),
      });

      const runId = `run_${selectedMonth.replace('-', '_')}`;
      const batch = writeBatch(db);

      batch.set(doc(db, 'payrollRuns', runId), {
        id: runId,
        month: selectedMonth,
        currency: calcResult.currency,
        status: 'processed',
        totalGross: calcResult.totalGross,
        totalDeductions: calcResult.totalDeductions,
        totalNet: calcResult.totalNet,
        employeeCount: calcResult.employeeCount,
        processedByUid: firebaseUser.uid,
        notes: 'Processed using configured ACE HRMS payroll rules (bank transfer handled externally).',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      for (const ps of calcResult.payslips) {
        const psId = `ps_${selectedMonth.replace('-', '_')}_${ps.employeeId}`;
        batch.set(doc(db, 'payslips', psId), {
          ...ps,
          id: psId,
          runId,
          status: 'issued',
          paymentNote: 'Payslip issued per configured rules. Bank disbursement is recorded externally.',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();

      await writeAuditLog({
        actorUid: firebaseUser.uid,
        actorEmail: firebaseUser.email || '',
        actorRole: effectiveRole,
        action: 'PAYROLL_PROCESSED',
        targetCollection: 'payrollRuns',
        targetId: runId,
        summary: `Processed ${selectedMonth} payroll for ${calcResult.employeeCount} employees (Net: ${formatCurrency(calcResult.totalNet, calcResult.currency)})`,
      });

      for (const ps of calcResult.payslips) {
        if (ps.uid) {
          const emp = activeEmps.find((e) => e.id === ps.employeeId);
          await dispatchNotification({
            recipientUid: ps.uid,
            recipientEmail: emp?.email,
            title: `Payslip Ready for ${selectedMonth}`,
            message: `Your payslip for ${selectedMonth} has been issued. Net pay: ${formatCurrency(ps.netPay, ps.currency)}.`,
            type: 'payroll',
            linkTab: 'self_service',
            sendEmail: Boolean(emp?.email),
          });
        }
      }

      setDryRunResult(null);
      setNotice(`Payroll for ${selectedMonth} calculated and ${calcResult.employeeCount} payslips issued.`);
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Payroll processing failed');
    } finally {
      setProcessing(false);
    }
  };

  // Reconciliation: compare selected month's run (or dry-run preview) against immediate prior processed month
  const reconciliation = useMemo(() => {
    const sorted = [...payrollRuns].sort((a, b) => b.month.localeCompare(a.month));
    const currentExisting = sorted.find((r) => r.month === selectedMonth);
    const currentPreview: PayrollRun | null = dryRunResult
      ? {
          id: 'dry_run',
          month: dryRunResult.month,
          currency: dryRunResult.currency,
          status: 'draft',
          totalGross: dryRunResult.totalGross,
          totalDeductions: dryRunResult.totalDeductions,
          totalNet: dryRunResult.totalNet,
          employeeCount: dryRunResult.employeeCount,
          processedByUid: '',
        }
      : currentExisting || sorted[0] || null;

    if (!currentPreview) return null;
    const prevRun = sorted.find((r) => r.month < currentPreview.month) || null;
    return {
      isDryRun: Boolean(dryRunResult),
      currency: currentPreview.currency,
      diff: comparePayrollRuns(currentPreview, prevRun),
    };
  }, [payrollRuns, dryRunResult, selectedMonth]);

  const openEditSalary = (emp: EmployeeProfile) => {
    const existing = salaries.find((s) => s.employeeId === emp.id);
    setEditingEmp(emp);
    setSalForm({
      currency: existing?.currency || payrollConfig.currency,
      basicSalary: existing?.basicSalary ?? 0,
      hraAllowance: existing?.hraAllowance ?? 0,
      transportAllowance: existing?.transportAllowance ?? 0,
      specialAllowance: existing?.specialAllowance ?? 0,
      bonus: existing?.bonus ?? 0,
      incentives: existing?.incentives ?? 0,
      deductions: existing?.deductions ?? 0,
      overtimeHourlyRate: existing?.overtimeHourlyRate ?? 0,
    });
  };

  const saveSalary = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingEmp || !firebaseUser) return;
    try {
      await setDoc(
        doc(db, 'salaries', editingEmp.id),
        {
          employeeId: editingEmp.id,
          uid: editingEmp.uid || '',
          currency: payrollConfig.currency,
          basicSalary: Number(salForm.basicSalary) || 0,
          hraAllowance: Number(salForm.hraAllowance) || 0,
          transportAllowance: Number(salForm.transportAllowance) || 0,
          specialAllowance: Number(salForm.specialAllowance) || 0,
          bonus: Number(salForm.bonus) || 0,
          incentives: Number(salForm.incentives) || 0,
          deductions: Number(salForm.deductions) || 0,
          overtimeHourlyRate: Number(salForm.overtimeHourlyRate) || 0,
          effectiveFrom: new Date().toISOString().slice(0, 10),
          updatedByUid: firebaseUser.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      setEditingEmp(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `salaries/${editingEmp.id}`);
    }
  };

  const payslipExportHeaders = [
    'Employee',
    'Code',
    'Department',
    'Basic',
    'Allowances',
    'Bonuses',
    'Overtime',
    'Unpaid Ded.',
    'Other Ded.',
    'Gross',
    'Net',
  ];

  const payslipExportRows = monthPayslips.map((p) => [
    p.employeeName,
    p.employeeCode || '',
    p.departmentName || '',
    p.basicSalary,
    p.allowances,
    p.bonuses + p.incentives,
    p.overtimePay,
    p.unpaidLeaveDeduction,
    p.otherDeductions,
    p.grossPay,
    p.netPay,
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#FFFFFF]">Payroll & Compensation</h1>
          <p className="text-sm text-[#A1A1AA] mt-1">
            Currency: {payrollConfig.currency} · Working Days: {payrollConfig.workingDaysPerMonth}/mo · Overtime: {payrollConfig.overtimeMultiplier}x
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="month"
            value={selectedMonth}
            onChange={(e) => {
              setSelectedMonth(e.target.value);
              setDryRunResult(null);
            }}
            className="px-3 py-2 bg-[#151922] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-xs text-[#FFFFFF] font-mono"
          />
          <button
            type="button"
            onClick={() => void runDryCheck()}
            disabled={dryRunning || processing}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#151922] border border-[#292D36] hover:border-[#FF4634]/50 text-[#FFFFFF] text-xs font-semibold rounded-xl whitespace-nowrap disabled:opacity-60"
          >
            <Eye className="w-3.5 h-3.5 text-[#FF6A33]" />
            {dryRunning ? 'Simulating...' : 'Safe Dry-Run Check'}
          </button>
          <button
            type="button"
            onClick={runPayroll}
            disabled={processing || dryRunning}
            className="ace-btn-primary inline-flex items-center gap-1.5 px-4 py-2 disabled:opacity-60 text-xs font-semibold rounded-xl whitespace-nowrap"
          >
            <Play className="w-3.5 h-3.5" />
            {processing ? 'Processing...' : `Run Payroll (${selectedMonth})`}
          </button>
        </div>
      </div>

      {/* Honest compliance & bank transfer notice */}
      <div className="p-3.5 rounded-2xl bg-[#151922] border border-[#292D36] text-xs text-[#A1A1AA] flex items-start gap-2.5">
        <Info className="w-4 h-4 text-[#FF6A33] shrink-0 mt-0.5" />
        <span>
          Calculations follow your configured payroll rules in HR Settings (currency, working days, overtime multiplier, unpaid leave deduction, and custom rules). Statutory tax deductions are not auto-invented, and bank transfers are executed externally.
        </span>
      </div>

      {notice && (
        <div className="p-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}
      {errMsg && (
        <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
          {errMsg}
        </div>
      )}

      {/* Month-over-Month Payroll Reconciliation Card */}
      {reconciliation?.diff && (
        <section className="p-5 rounded-2xl bg-[#151922] border border-[#292D36] space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ArrowLeftRight className="w-4 h-4 text-[#FF6A33]" />
              <h2 className="font-display text-sm font-semibold text-[#FFFFFF]">
                Payroll Reconciliation ({reconciliation.diff.currentMonth}
                {reconciliation.isDryRun ? ' Dry-Run Preview' : ''})
              </h2>
            </div>
            <span className="text-xs text-[#A1A1AA]">
              Baseline: {reconciliation.diff.previousMonth || 'No prior month run'}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div className="p-3 rounded-xl bg-[#0B0D12] border border-[#292D36]">
              <div className="text-[#A1A1AA]">Gross Variance</div>
              <div className="text-base font-mono font-bold text-[#FFFFFF] mt-0.5">
                {reconciliation.diff.grossDelta >= 0 ? '+' : ''}
                {formatCurrency(reconciliation.diff.grossDelta, reconciliation.currency)}
              </div>
              <div className="text-[11px] text-[#A1A1AA] mt-0.5">
                Current: {formatCurrency(reconciliation.diff.currentGross, reconciliation.currency)}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-[#0B0D12] border border-[#292D36]">
              <div className="text-[#A1A1AA]">Net Payable Variance</div>
              <div className="text-base font-mono font-bold text-[#FFFFFF] mt-0.5">
                {reconciliation.diff.netDelta >= 0 ? '+' : ''}
                {formatCurrency(reconciliation.diff.netDelta, reconciliation.currency)}
              </div>
              <div className="text-[11px] text-[#A1A1AA] mt-0.5">
                Current: {formatCurrency(reconciliation.diff.currentNet, reconciliation.currency)}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-[#0B0D12] border border-[#292D36]">
              <div className="text-[#A1A1AA]">Headcount Variance</div>
              <div className="text-base font-mono font-bold text-[#FFFFFF] mt-0.5">
                {reconciliation.diff.headcountDelta >= 0 ? '+' : ''}
                {reconciliation.diff.headcountDelta} employee(s)
              </div>
              <div className="text-[11px] text-[#A1A1AA] mt-0.5">
                Compared vs {reconciliation.diff.previousMonth || 'zero baseline'}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Dry-Run Preview Table */}
      {dryRunResult && (
        <section className="bg-[#151922] border border-[#FF6A33]/40 rounded-2xl overflow-hidden">
          <div className="p-4 border-b border-[#292D36] flex items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-sm font-bold text-[#FFFFFF]">
                Dry-Run Preview · {dryRunResult.month} ({dryRunResult.employeeCount} employees)
              </h3>
              <p className="text-xs text-[#A1A1AA]">
                Gross: {formatCurrency(dryRunResult.totalGross, dryRunResult.currency)} · Deductions:{' '}
                {formatCurrency(dryRunResult.totalDeductions, dryRunResult.currency)} · Net:{' '}
                {formatCurrency(dryRunResult.totalNet, dryRunResult.currency)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDryRunResult(null)}
              className="text-xs text-[#A1A1AA] hover:text-[#FFFFFF]"
            >
              Dismiss Preview
            </button>
          </div>
          <div className="overflow-x-auto max-h-72">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                  <th className="px-4 py-2.5 text-left font-medium">Employee</th>
                  <th className="px-4 py-2.5 text-right font-medium">OT (h)</th>
                  <th className="px-4 py-2.5 text-right font-medium">Unpaid / Late Days</th>
                  <th className="px-4 py-2.5 text-right font-medium">Gross</th>
                  <th className="px-4 py-2.5 text-right font-medium">Deductions</th>
                  <th className="px-4 py-2.5 text-right font-medium">Est. Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#292D36]/70">
                {dryRunResult.payslips.map((ps) => (
                  <tr key={ps.employeeId}>
                    <td className="px-4 py-2 text-[#FFFFFF] font-medium">{ps.employeeName}</td>
                    <td className="px-4 py-2 text-right font-mono text-[#A1A1AA]">{ps.overtimeHours ?? 0}</td>
                    <td className="px-4 py-2 text-right font-mono text-[#A1A1AA]">{ps.unpaidLeaveDays ?? 0}</td>
                    <td className="px-4 py-2 text-right font-mono text-[#FFFFFF]">
                      {formatCurrency(ps.grossPay, ps.currency)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-rose-400">
                      {formatCurrency(ps.unpaidLeaveDeduction + ps.otherDeductions, ps.currency)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-emerald-400 font-semibold">
                      {formatCurrency(ps.netPay, ps.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-1 p-1.5 bg-[#151922] border border-[#292D36] rounded-2xl">
          {[
            { id: 'runs', label: `Payroll Runs (${payrollRuns.length})` },
            { id: 'payslips', label: `Payslips (${monthPayslips.length})` },
            { id: 'structures', label: `Salary Structures (${employees.length})` },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id as typeof subTab)}
              className={`px-3 py-1.5 text-xs font-medium rounded-xl transition-all ${
                subTab === t.id
                  ? 'bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-white'
                  : 'text-[#A1A1AA] hover:text-[#FFFFFF]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {monthPayslips.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => exportToCsv(`payroll_${selectedMonth}`, payslipExportHeaders, payslipExportRows)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#151922] border border-[#292D36] text-[#A1A1AA] hover:text-[#FFFFFF] hover:border-[#FF4634]/50 text-xs rounded-xl transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
            <button
              type="button"
              onClick={() =>
                void exportToXlsx(`payroll_${selectedMonth}`, payslipExportHeaders, payslipExportRows, `Payroll_${selectedMonth}`)
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#151922] border border-[#292D36] text-[#A1A1AA] hover:text-[#FFFFFF] hover:border-[#FF4634]/50 text-xs rounded-xl transition-colors"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
              Export XLSX
            </button>
          </div>
        )}
      </div>

      {subTab === 'runs' && (
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden">
          {payrollRuns.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#A1A1AA]">
              No payroll runs processed yet. Select a month and click Run Payroll above.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                    <th className="px-4 py-3 text-left font-medium">Month</th>
                    <th className="px-4 py-3 text-right font-medium">Employees</th>
                    <th className="px-4 py-3 text-right font-medium">Total Gross</th>
                    <th className="px-4 py-3 text-right font-medium">Deductions</th>
                    <th className="px-4 py-3 text-right font-medium">Total Net</th>
                    <th className="px-4 py-3 text-right font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#292D36]/70">
                  {[...payrollRuns].sort((a, b) => b.month.localeCompare(a.month)).map((run) => (
                    <tr key={run.id} className="hover:bg-[#1B1F28]/60">
                      <td className="px-4 py-3 font-mono text-[#FFFFFF] font-semibold">{run.month}</td>
                      <td className="px-4 py-3 text-right font-mono text-[#A1A1AA] tabular-nums">{run.employeeCount}</td>
                      <td className="px-4 py-3 text-right font-mono text-[#FFFFFF] tabular-nums">{formatCurrency(run.totalGross, run.currency)}</td>
                      <td className="px-4 py-3 text-right font-mono text-rose-400 tabular-nums">{formatCurrency(run.totalDeductions, run.currency)}</td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-400 font-semibold tabular-nums">{formatCurrency(run.totalNet, run.currency)}</td>
                      <td className="px-4 py-3 text-right capitalize text-[#FF6A33] font-medium">{run.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {subTab === 'payslips' && (
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden">
          {monthPayslips.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#A1A1AA]">
              No payslips generated for {selectedMonth}. Run payroll to generate payslips.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                    <th className="px-4 py-3 text-left font-medium">Employee</th>
                    <th className="px-4 py-3 text-right font-medium">Basic</th>
                    <th className="px-4 py-3 text-right font-medium">Allowances & Bonus</th>
                    <th className="px-4 py-3 text-right font-medium">Overtime</th>
                    <th className="px-4 py-3 text-right font-medium">Deductions</th>
                    <th className="px-4 py-3 text-right font-medium">Net Pay</th>
                    <th className="px-4 py-3 text-right font-medium">Payslip</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#292D36]/70">
                  {monthPayslips.map((ps) => (
                    <tr key={ps.id} className="hover:bg-[#1B1F28]/60">
                      <td className="px-4 py-3">
                        <div className="text-[#FFFFFF] font-medium">{ps.employeeName}</div>
                        <div className="text-[#A1A1AA]">{ps.departmentName} · {ps.employeeCode}</div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[#A1A1AA] tabular-nums">{formatCurrency(ps.basicSalary, ps.currency)}</td>
                      <td className="px-4 py-3 text-right font-mono text-[#A1A1AA] tabular-nums">
                        {formatCurrency(ps.allowances + ps.bonuses + ps.incentives, ps.currency)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[#A1A1AA] tabular-nums">{formatCurrency(ps.overtimePay, ps.currency)}</td>
                      <td className="px-4 py-3 text-right font-mono text-rose-400 tabular-nums">
                        {formatCurrency(ps.unpaidLeaveDeduction + ps.otherDeductions, ps.currency)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-400 font-semibold tabular-nums">
                        {formatCurrency(ps.netPay, ps.currency)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => generatePayslipPdf(ps, companySettings.companyName, companySettings.address)}
                          className="ace-btn-primary inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg font-medium"
                        >
                          <Download className="w-3 h-3" />
                          PDF
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {subTab === 'structures' && (
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                  <th className="px-4 py-3 text-left font-medium">Employee</th>
                  <th className="px-4 py-3 text-right font-medium">Basic</th>
                  <th className="px-4 py-3 text-right font-medium">Allowances</th>
                  <th className="px-4 py-3 text-right font-medium">Bonus / Inc.</th>
                  <th className="px-4 py-3 text-right font-medium">Deductions</th>
                  <th className="px-4 py-3 text-right font-medium">OT / hr</th>
                  <th className="px-4 py-3 text-right font-medium">Edit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#292D36]/70">
                {employees.map((emp) => {
                  const sal = salaries.find((s) => s.employeeId === emp.id);
                  const cur = sal?.currency || payrollConfig.currency;
                  return (
                    <tr key={emp.id} className="hover:bg-[#1B1F28]/60">
                      <td className="px-4 py-3">
                        <div className="text-[#FFFFFF] font-medium">{emp.fullName}</div>
                        <div className="text-[#A1A1AA]">{emp.employeeCode} · {emp.designation}</div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[#FFFFFF] tabular-nums">{formatCurrency(sal?.basicSalary ?? 0, cur)}</td>
                      <td className="px-4 py-3 text-right font-mono text-[#A1A1AA] tabular-nums">
                        {formatCurrency((sal?.hraAllowance ?? 0) + (sal?.transportAllowance ?? 0) + (sal?.specialAllowance ?? 0), cur)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[#A1A1AA] tabular-nums">
                        {formatCurrency((sal?.bonus ?? 0) + (sal?.incentives ?? 0), cur)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-rose-400 tabular-nums">{formatCurrency(sal?.deductions ?? 0, cur)}</td>
                      <td className="px-4 py-3 text-right font-mono text-[#A1A1AA] tabular-nums">{formatCurrency(sal?.overtimeHourlyRate ?? 0, cur)}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => openEditSalary(emp)}
                          className="p-1.5 text-[#A1A1AA] hover:text-[#FF6A33] rounded-lg hover:bg-[#1B1F28]"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Edit Salary Structure Modal */}
      {editingEmp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setEditingEmp(null)} />
          <form onSubmit={saveSalary} className="relative z-10 w-full max-w-lg bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wallet className="w-4 h-4 text-[#FF6A33]" />
                <h3 className="font-display text-base font-bold text-[#FFFFFF]">Salary Structure · {editingEmp.fullName}</h3>
              </div>
              <button type="button" onClick={() => setEditingEmp(null)} className="text-[#A1A1AA] hover:text-[#FFFFFF]">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                { key: 'basicSalary', label: 'Basic Salary' },
                { key: 'hraAllowance', label: 'HRA Allowance' },
                { key: 'transportAllowance', label: 'Transport Allowance' },
                { key: 'specialAllowance', label: 'Special Allowance' },
                { key: 'bonus', label: 'Bonus' },
                { key: 'incentives', label: 'Incentives' },
                { key: 'deductions', label: 'Fixed Deductions' },
                { key: 'overtimeHourlyRate', label: 'Overtime Rate / hr' },
              ].map((f) => (
                <div key={f.key}>
                  <label className="block text-[#A1A1AA] mb-1">{f.label} ({payrollConfig.currency})</label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={Number((salForm as Record<string, number>)[f.key] ?? 0)}
                    onChange={(e) => setSalForm((prev) => ({ ...prev, [f.key]: Number(e.target.value) }))}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF] font-mono"
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setEditingEmp(null)} className="px-4 py-2 border border-[#292D36] bg-[#1B1F28] rounded-xl text-[#A1A1AA] hover:text-[#FFFFFF]">Cancel</button>
              <button type="submit" className="ace-btn-primary px-4 py-2 font-semibold rounded-xl">Save Structure</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
