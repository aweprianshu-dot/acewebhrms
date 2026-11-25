import React, { useState } from 'react';
import { doc, setDoc, updateDoc, writeBatch, serverTimestamp } from 'firebase/firestore';
import { UserMinus, CheckCircle2, Power, X } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import { dispatchNotification, makeId, writeAuditLog } from '../../services/hrmsApi';
import { formatCurrency } from '../../utils/exportUtils';
import type { OffboardingCase } from '../../types/hrms';

export const OffboardingModule: React.FC = () => {
  const { firebaseUser, employeeProfile, effectiveRole } = useAuth();
  const { offboardingCases, employees, payrollConfig } = useHrmsData();

  const isHR = effectiveRole === 'super_admin' || effectiveRole === 'hr_manager';
  const uid = firebaseUser?.uid || '';

  const [showResignModal, setShowResignModal] = useState(false);
  const [resignationDate, setResignationDate] = useState(new Date().toISOString().slice(0, 10));
  const [noticeDays, setNoticeDays] = useState(30);
  const [reason, setReason] = useState('');

  const [editingExit, setEditingExit] = useState<OffboardingCase | null>(null);
  const [exitNotes, setExitNotes] = useState('');
  const [settlementAmt, setSettlementAmt] = useState(0);
  const [settlementStatus, setSettlementStatus] = useState<OffboardingCase['finalSettlementStatus']>('pending');

  const submitResignation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;
    const id = makeId('off');
    const lwd = new Date(resignationDate);
    lwd.setDate(lwd.getDate() + Number(noticeDays));
    const lastWorkingDay = lwd.toISOString().slice(0, 10);

    try {
      await setDoc(doc(db, 'offboarding', id), {
        id,
        uid,
        employeeId: employeeProfile?.id || uid,
        employeeName: employeeProfile?.fullName || firebaseUser.displayName || 'Employee',
        departmentId: employeeProfile?.departmentId || 'dept_exec',
        resignationDate,
        lastWorkingDay,
        noticePeriodDays: Number(noticeDays),
        reason: reason.trim(),
        approvalStatus: 'pending',
        exitInterviewCompleted: false,
        exitInterviewNotes: '',
        assetsReturned: false,
        documentsCleared: false,
        finalSettlementAmount: 0,
        finalSettlementStatus: 'pending',
        accountDeactivated: false,
        status: 'initiated',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setShowResignModal(false);
      setReason('');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `offboarding/${id}`);
    }
  };

  const approveResignation = async (c: OffboardingCase, decision: 'approved' | 'rejected') => {
    if (!isHR || !firebaseUser) return;
    try {
      await updateDoc(doc(db, 'offboarding', c.id), {
        approvalStatus: decision,
        approvedByUid: firebaseUser.uid,
        status: decision === 'approved' ? 'in_progress' : 'completed',
        updatedAt: serverTimestamp(),
      });
      const emp = employees.find((e) => e.id === c.employeeId || e.uid === c.uid);
      await dispatchNotification({
        recipientUid: c.uid,
        recipientEmail: emp?.email,
        title: `Resignation ${decision === 'approved' ? 'Accepted' : 'Declined'}`,
        message: `Your resignation notice (LWD: ${c.lastWorkingDay}) was ${decision}.`,
        type: 'system',
        linkTab: 'offboarding',
        sendEmail: Boolean(emp?.email),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `offboarding/${c.id}`);
    }
  };

  const toggleClearance = async (
    c: OffboardingCase,
    field: 'exitInterviewCompleted' | 'assetsReturned' | 'documentsCleared',
    value: boolean
  ) => {
    if (!isHR) return;
    try {
      await updateDoc(doc(db, 'offboarding', c.id), {
        [field]: value,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `offboarding/${c.id}`);
    }
  };

  const saveExitDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingExit || !isHR) return;
    try {
      await updateDoc(doc(db, 'offboarding', editingExit.id), {
        exitInterviewCompleted: true,
        exitInterviewNotes: exitNotes.trim(),
        finalSettlementAmount: Number(settlementAmt) || 0,
        finalSettlementStatus: settlementStatus,
        updatedAt: serverTimestamp(),
      });
      setEditingExit(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `offboarding/${editingExit.id}`);
    }
  };

  const finalizeAndDeactivate = async (c: OffboardingCase) => {
    if (!isHR || !firebaseUser) return;
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'offboarding', c.id), {
        accountDeactivated: true,
        status: 'completed',
        updatedAt: serverTimestamp(),
      });
      if (c.employeeId && c.employeeId !== c.uid) {
        batch.update(doc(db, 'employees', c.employeeId), {
          status: 'inactive',
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(db, 'directory', c.employeeId), {
          status: 'inactive',
          updatedAt: serverTimestamp(),
        });
      }
      if (c.uid) {
        batch.update(doc(db, 'roles', c.uid), {
          status: 'inactive',
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
      await writeAuditLog({
        actorUid: firebaseUser.uid,
        actorEmail: firebaseUser.email || '',
        actorRole: effectiveRole,
        action: 'EMPLOYEE_OFFBOARDED',
        targetCollection: 'offboarding',
        targetId: c.id,
        summary: `Completed offboarding and deactivated ${c.employeeName}`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `offboarding/${c.id}`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Offboarding & Exits</h1>
          <p className="text-sm text-[#A1A1AA] mt-1">
            Resignations, notice periods, exit interviews, asset returns, and final settlements
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowResignModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-rose-600/90 hover:bg-rose-600 text-white text-xs font-semibold rounded-xl whitespace-nowrap transition-colors"
        >
          <UserMinus className="w-4 h-4" />
          Submit Resignation
        </button>
      </div>

      {offboardingCases.length === 0 ? (
        <div className="p-10 text-center bg-[#151922] border border-[#292D36] rounded-2xl text-sm text-[#A1A1AA]">
          No resignation or offboarding records found.
        </div>
      ) : (
        <div className="space-y-4">
          {offboardingCases.map((c) => {
            const daysLeft = Math.max(
              0,
              Math.ceil((new Date(c.lastWorkingDay).getTime() - Date.now()) / 86400000)
            );
            return (
              <div key={c.id} className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="font-display text-base font-semibold text-white">{c.employeeName}</h2>
                      <span
                        className={`text-xs font-medium capitalize ${
                          c.approvalStatus === 'approved'
                            ? 'text-emerald-400'
                            : c.approvalStatus === 'rejected'
                              ? 'text-rose-400'
                              : 'text-amber-400'
                        }`}
                      >
                        · {c.approvalStatus}
                      </span>
                    </div>
                    <p className="text-xs text-[#A1A1AA] mt-1">
                      Submitted: {c.resignationDate} · LWD:{' '}
                      <span className="font-mono text-white">{c.lastWorkingDay}</span> · Notice: {daysLeft}d remaining
                    </p>
                  </div>

                  {isHR && c.approvalStatus === 'pending' && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => approveResignation(c, 'approved')}
                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition-colors"
                      >
                        Approve Resignation
                      </button>
                      <button
                        type="button"
                        onClick={() => approveResignation(c, 'rejected')}
                        className="px-3 py-1.5 bg-[#1B1F28] border border-[#292D36] text-[#A1A1AA] hover:text-rose-400 hover:border-rose-500/40 text-xs rounded-lg transition-colors"
                      >
                        Decline
                      </button>
                    </div>
                  )}
                </div>

                <p className="text-xs text-[#D4D4D8] bg-[#1B1F28] border border-[#292D36] rounded-xl p-3">
                  Reason: {c.reason}
                </p>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <button
                    type="button"
                    disabled={!isHR}
                    onClick={() => isHR && toggleClearance(c, 'assetsReturned', !c.assetsReturned)}
                    className="p-3 rounded-xl bg-[#1B1F28] border border-[#292D36] hover:border-[#FF4634]/40 flex items-center justify-between transition-colors disabled:cursor-default"
                  >
                    <span className="text-[#D4D4D8]">Assets Returned</span>
                    <CheckCircle2 className={`w-4 h-4 ${c.assetsReturned ? 'text-emerald-400' : 'text-zinc-600'}`} />
                  </button>
                  <button
                    type="button"
                    disabled={!isHR}
                    onClick={() => isHR && toggleClearance(c, 'documentsCleared', !c.documentsCleared)}
                    className="p-3 rounded-xl bg-[#1B1F28] border border-[#292D36] hover:border-[#FF4634]/40 flex items-center justify-between transition-colors disabled:cursor-default"
                  >
                    <span className="text-[#D4D4D8]">Docs Cleared</span>
                    <CheckCircle2 className={`w-4 h-4 ${c.documentsCleared ? 'text-emerald-400' : 'text-zinc-600'}`} />
                  </button>
                  <div className="p-3 rounded-xl bg-[#1B1F28] border border-[#292D36]">
                    <div className="text-[#A1A1AA]">Exit Interview</div>
                    <div className="text-white font-medium mt-0.5">
                      {c.exitInterviewCompleted ? 'Completed' : 'Pending'}
                    </div>
                  </div>
                  <div className="p-3 rounded-xl bg-[#1B1F28] border border-[#292D36]">
                    <div className="text-[#A1A1AA]">Final Settlement</div>
                    <div className="font-mono text-emerald-400 mt-0.5 tabular-nums">
                      {formatCurrency(c.finalSettlementAmount, payrollConfig.currency)} · {c.finalSettlementStatus}
                    </div>
                  </div>
                </div>

                {isHR && (
                  <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2 border-t border-[#292D36]">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingExit(c);
                        setExitNotes(c.exitInterviewNotes || '');
                        setSettlementAmt(c.finalSettlementAmount);
                        setSettlementStatus(c.finalSettlementStatus);
                      }}
                      className="px-3.5 py-1.5 bg-[#1B1F28] border border-[#292D36] text-white hover:border-[#FF4634]/40 text-xs font-medium rounded-lg transition-colors"
                    >
                      Update Exit Interview & Settlement
                    </button>
                    {!c.accountDeactivated && c.approvalStatus === 'approved' && (
                      <button
                        type="button"
                        onClick={() => finalizeAndDeactivate(c)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-lg transition-colors"
                      >
                        <Power className="w-3.5 h-3.5" />
                        Complete Exit & Deactivate Account
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Resignation Modal */}
      {showResignModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75 backdrop-blur-sm" onClick={() => setShowResignModal(false)} />
          <form onSubmit={submitResignation} className="relative z-10 w-full max-w-md bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-white">Submit Resignation</h3>
              <button type="button" onClick={() => setShowResignModal(false)} className="text-[#A1A1AA] hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[#A1A1AA] mb-1">Resignation Date</label>
                <input
                  type="date"
                  required
                  value={resignationDate}
                  onChange={(e) => setResignationDate(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-lg text-white"
                />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Notice Period (Days)</label>
                <input
                  type="number"
                  min={0}
                  value={noticeDays}
                  onChange={(e) => setNoticeDays(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-lg text-white font-mono"
                />
              </div>
            </div>
            <div>
              <label className="block text-[#A1A1AA] mb-1">Reason for Leaving</label>
              <textarea
                required
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-lg text-white"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowResignModal(false)}
                className="px-4 py-2 bg-[#1B1F28] border border-[#292D36] rounded-lg text-[#A1A1AA] hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white font-semibold rounded-lg"
              >
                Submit Resignation
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Exit Interview & Settlement Modal */}
      {editingExit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75 backdrop-blur-sm" onClick={() => setEditingExit(null)} />
          <form onSubmit={saveExitDetails} className="relative z-10 w-full max-w-md bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-white">Exit Settlement · {editingExit.employeeName}</h3>
              <button type="button" onClick={() => setEditingExit(null)} className="text-[#A1A1AA] hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div>
              <label className="block text-[#A1A1AA] mb-1">Exit Interview Notes</label>
              <textarea
                rows={3}
                value={exitNotes}
                onChange={(e) => setExitNotes(e.target.value)}
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-lg text-white"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[#A1A1AA] mb-1">Settlement Amount ({payrollConfig.currency})</label>
                <input
                  type="number"
                  step="0.01"
                  value={settlementAmt}
                  onChange={(e) => setSettlementAmt(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-lg text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Settlement Status</label>
                <select
                  value={settlementStatus}
                  onChange={(e) => setSettlementStatus(e.target.value as OffboardingCase['finalSettlementStatus'])}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-lg text-white"
                >
                  <option value="pending">Pending</option>
                  <option value="calculated">Calculated</option>
                  <option value="settled">Settled</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setEditingExit(null)}
                className="px-4 py-2 bg-[#1B1F28] border border-[#292D36] rounded-lg text-[#A1A1AA] hover:text-white"
              >
                Cancel
              </button>
              <button type="submit" className="ace-btn-primary px-4 py-2 font-semibold rounded-lg">
                Save Settlement
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
