import React, { useState } from 'react';
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { CheckSquare, Square, FileUp, CheckCircle2 } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import { uploadToStorage, writeAuditLog } from '../../services/hrmsApi';
import type { OnboardingCase } from '../../types/hrms';

export const OnboardingModule: React.FC = () => {
  const { firebaseUser, effectiveRole } = useAuth();
  const { onboardingCases } = useHrmsData();

  const isHR = effectiveRole === 'super_admin' || effectiveRole === 'hr_manager';
  const [newTaskTitle, setNewTaskTitle] = useState<Record<string, string>>({});

  const computeProgress = (c: OnboardingCase, nextChecklist = c.trainingChecklist, overrides?: Partial<OnboardingCase>) => {
    const merged = { ...c, ...overrides };
    const totalChecks = 4 + nextChecklist.length;
    const completedChecks =
      (merged.offerLetterStatus === 'signed' ? 1 : 0) +
      (merged.policyAcknowledged ? 1 : 0) +
      (merged.documentsVerified ? 1 : 0) +
      (merged.accountCreated ? 1 : 0) +
      nextChecklist.filter((i) => i.completed).length;
    const progressPercent = totalChecks > 0 ? Math.round((completedChecks / totalChecks) * 100) : 0;
    const status = progressPercent === 100 ? 'completed' : 'in_progress';
    return { progressPercent, status };
  };

  const toggleItem = async (c: OnboardingCase, idx: number) => {
    const nextChecklist = c.trainingChecklist.map((item, i) =>
      i === idx ? { ...item, completed: !item.completed } : item
    );
    const { progressPercent, status } = computeProgress(c, nextChecklist);
    try {
      await updateDoc(doc(db, 'onboarding', c.id), {
        trainingChecklist: nextChecklist,
        progressPercent,
        ...(isHR ? { status } : {}),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `onboarding/${c.id}`);
    }
  };

  const toggleField = async (
    c: OnboardingCase,
    field: 'policyAcknowledged' | 'documentsVerified' | 'accountCreated',
    value: boolean
  ) => {
    const { progressPercent, status } = computeProgress(c, c.trainingChecklist, { [field]: value });
    try {
      await updateDoc(doc(db, 'onboarding', c.id), {
        [field]: value,
        progressPercent,
        ...(isHR ? { status } : {}),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `onboarding/${c.id}`);
    }
  };

  const updateOfferStatus = async (c: OnboardingCase, offerLetterStatus: OnboardingCase['offerLetterStatus']) => {
    if (!isHR) return;
    const { progressPercent, status } = computeProgress(c, c.trainingChecklist, { offerLetterStatus });
    try {
      await updateDoc(doc(db, 'onboarding', c.id), {
        offerLetterStatus,
        progressPercent,
        status,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `onboarding/${c.id}`);
    }
  };

  const uploadOfferLetter = async (c: OnboardingCase, file: File) => {
    if (!isHR) return;
    try {
      const url = await uploadToStorage(`offer_letters/${c.employeeId}`, file);
      await updateDoc(doc(db, 'onboarding', c.id), {
        offerLetterUrl: url,
        offerLetterStatus: 'sent',
        updatedAt: serverTimestamp(),
      });
      if (firebaseUser) {
        await writeAuditLog({
          actorUid: firebaseUser.uid,
          actorEmail: firebaseUser.email || '',
          actorRole: effectiveRole,
          action: 'OFFER_LETTER_UPLOADED',
          targetCollection: 'onboarding',
          targetId: c.id,
          summary: `Uploaded offer letter for ${c.employeeName}`,
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `onboarding/${c.id}`);
    }
  };

  const addChecklistItem = async (c: OnboardingCase) => {
    const title = (newTaskTitle[c.id] || '').trim();
    if (!isHR || !title) return;
    const nextChecklist = [...c.trainingChecklist, { title, completed: false }];
    const { progressPercent, status } = computeProgress(c, nextChecklist);
    try {
      await updateDoc(doc(db, 'onboarding', c.id), {
        trainingChecklist: nextChecklist,
        progressPercent,
        status,
        updatedAt: serverTimestamp(),
      });
      setNewTaskTitle((prev) => ({ ...prev, [c.id]: '' }));
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `onboarding/${c.id}`);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-[#FFFFFF]">Employee Onboarding</h1>
        <p className="text-sm text-[#A1A1AA] mt-1">
          Offer letters, document verification, company policy acknowledgement, and training progress
        </p>
      </div>

      {onboardingCases.length === 0 ? (
        <div className="p-10 text-center bg-[#151922] border border-[#292D36] rounded-2xl text-sm text-[#A1A1AA]">
          No active onboarding workflows. New employees added in Employees automatically generate an onboarding checklist.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {onboardingCases.map((c) => (
            <div key={c.id} className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-display text-base font-semibold text-[#FFFFFF]">{c.employeeName}</h2>
                  <div className="text-xs text-[#A1A1AA] mt-0.5">
                    {c.designation} · {c.departmentName} · {c.email}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm font-semibold text-[#FF6A33] tabular-nums">{c.progressPercent}%</div>
                  <div className="text-[11px] capitalize text-[#A1A1AA]">{c.status.replace('_', ' ')}</div>
                </div>
              </div>

              <div className="w-full h-1.5 bg-[#1B1F28] rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-[#FF4634] to-[#FF6A33] transition-all" style={{ width: `${c.progressPercent}%` }} />
              </div>

              {/* Core Onboarding Milestones */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                <div className="p-3 rounded-xl bg-[#1B1F28] border border-[#292D36] flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[#FFFFFF] font-medium">Offer Letter</div>
                    {c.offerLetterUrl && (
                      <a href={c.offerLetterUrl} target="_blank" rel="noreferrer" className="text-[#FF6A33] hover:underline text-[11px]">
                        View File
                      </a>
                    )}
                  </div>
                  {isHR ? (
                    <div className="flex items-center gap-1.5">
                      <select
                        value={c.offerLetterStatus}
                        onChange={(e) => updateOfferStatus(c, e.target.value as OnboardingCase['offerLetterStatus'])}
                        className="px-2 py-1 bg-[#0B0D12] border border-[#292D36] rounded-lg text-[11px] text-[#FFFFFF]"
                      >
                        <option value="pending" className="bg-[#151922]">Pending</option>
                        <option value="sent" className="bg-[#151922]">Sent</option>
                        <option value="signed" className="bg-[#151922]">Signed</option>
                      </select>
                      <label className="p-1.5 border border-[#292D36] rounded-lg cursor-pointer text-[#A1A1AA] hover:text-[#FFFFFF]" title="Upload Offer Letter">
                        <FileUp className="w-3.5 h-3.5" />
                        <input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && uploadOfferLetter(c, e.target.files[0])} />
                      </label>
                    </div>
                  ) : (
                    <span className="capitalize text-[#FF6A33]">{c.offerLetterStatus}</span>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => toggleField(c, 'policyAcknowledged', !c.policyAcknowledged)}
                  className="p-3 rounded-xl bg-[#1B1F28] border border-[#292D36] flex items-center justify-between text-left"
                >
                  <span className="text-[#FFFFFF] font-medium">Policy Acknowledged</span>
                  <CheckCircle2 className={`w-4 h-4 ${c.policyAcknowledged ? 'text-emerald-400' : 'text-[#A1A1AA]/50'}`} />
                </button>

                <button
                  type="button"
                  disabled={!isHR}
                  onClick={() => isHR && toggleField(c, 'documentsVerified', !c.documentsVerified)}
                  className="p-3 rounded-xl bg-[#1B1F28] border border-[#292D36] flex items-center justify-between text-left disabled:opacity-75"
                >
                  <span className="text-[#FFFFFF] font-medium">Documents Verified</span>
                  <CheckCircle2 className={`w-4 h-4 ${c.documentsVerified ? 'text-emerald-400' : 'text-[#A1A1AA]/50'}`} />
                </button>

                <button
                  type="button"
                  disabled={!isHR}
                  onClick={() => isHR && toggleField(c, 'accountCreated', !c.accountCreated)}
                  className="p-3 rounded-xl bg-[#1B1F28] border border-[#292D36] flex items-center justify-between text-left disabled:opacity-75"
                >
                  <span className="text-[#FFFFFF] font-medium">Account Activated</span>
                  <CheckCircle2 className={`w-4 h-4 ${c.accountCreated ? 'text-emerald-400' : 'text-[#A1A1AA]/50'}`} />
                </button>
              </div>

              {/* Training Checklist */}
              <div className="space-y-2 pt-2 border-t border-[#292D36]">
                <div className="text-xs font-medium text-[#A1A1AA]">Training & Induction Checklist</div>
                {c.trainingChecklist.map((item, idx) => (
                  <button
                    key={`${c.id}-item-${idx}`}
                    type="button"
                    onClick={() => toggleItem(c, idx)}
                    className="w-full flex items-center gap-2.5 text-left text-xs py-1 text-[#A1A1AA] hover:text-[#FFFFFF]"
                  >
                    {item.completed ? (
                      <CheckSquare className="w-4 h-4 text-emerald-400 shrink-0" />
                    ) : (
                      <Square className="w-4 h-4 text-[#A1A1AA]/60 shrink-0" />
                    )}
                    <span className={item.completed ? 'line-through text-[#A1A1AA]/60' : 'text-[#FFFFFF]'}>{item.title}</span>
                  </button>
                ))}
                {isHR && (
                  <div className="flex items-center gap-2 pt-1">
                    <input
                      type="text"
                      placeholder="Add training task..."
                      value={newTaskTitle[c.id] || ''}
                      onChange={(e) => setNewTaskTitle((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      className="flex-1 px-2.5 py-1.5 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-lg text-xs text-[#FFFFFF]"
                    />
                    <button
                      type="button"
                      onClick={() => addChecklistItem(c)}
                      className="px-3 py-1.5 bg-[#1B1F28] hover:bg-[#292D36] border border-[#292D36] text-xs text-[#FFFFFF] rounded-lg"
                    >
                      Add
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
