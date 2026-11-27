import React, { useEffect, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  setDoc,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import {
  Download,
  FileUp,
  Save,
  CheckCircle2,
  CalendarOff,
  FileText,
  User,
  Star,
  Shield,
  KeyRound,
  Copy,
  Trash2,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../../firebase';
import { useAuth, type TotpEnrollmentStart } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import { makeId, uploadToStorage, writeAuditLog } from '../../services/hrmsApi';
import { AttendanceCheckInWidget } from '../attendance/AttendanceCheckInWidget';
import { COMMON_TIMEZONES, formatTimeInZone, getOfficeNowParts, resolveWorkPolicy } from '../../utils/attendanceUtils';
import { formatCurrency, generatePayslipPdf } from '../../utils/exportUtils';
import { computeLeaveBalanceSummary, filterVisibleLeaveRequests } from '../../utils/workflowUtils';
import QRCode from 'qrcode';
import type { ActiveTab, EmployeeDocument } from '../../types/hrms';

interface SelfServiceModuleProps {
  onNavigate: (tab: ActiveTab) => void;
}

export const SelfServiceModule: React.FC<SelfServiceModuleProps> = ({ onNavigate }) => {
  const {
    firebaseUser,
    employeeProfile,
    effectiveRole,
    mfaEnrolledFactors,
    reauthenticateCurrentUser,
    startTotpEnrollment,
    unenrollMfaFactor,
  } = useAuth();
  const {
    attendance,
    holidays,
    tasks,
    leaveBalances,
    leaveRequests,
    leavePolicy,
    payslips,
    documents,
    reviews,
    announcements,
    workPolicy,
    companySettings,
  } = useHrmsData();

  const uid = firebaseUser?.uid || '';
  const policy = resolveWorkPolicy({ ...workPolicy, officeTimezone: employeeProfile?.timezone || workPolicy.officeTimezone });
  const today = getOfficeNowParts(new Date(), policy.officeTimezone).dateStr;
  const todaysHoliday = holidays.find((holiday) => holiday.date === today);
  const upcomingHolidays = holidays.filter((holiday) => holiday.date >= today).sort((a,b) => a.date.localeCompare(b.date)).slice(0,4);
  const birthdayAnnouncements = announcements.filter((item) => item.category === 'birthday' || item.category === 'anniversary').slice(0,4);
  const pendingTasks = tasks.filter((task) => task.assigneeUid === uid && task.status !== 'completed').slice(0, 4);
  const myBalance = leaveBalances.find((b) => b.uid === uid);
  const myLeaveRequests = filterVisibleLeaveRequests(leaveRequests, uid, effectiveRole, employeeProfile?.departmentId)
    .filter((r) => r.uid === uid)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
  const myLeaveSummary = computeLeaveBalanceSummary(myBalance, myLeaveRequests, leavePolicy);
  const myPayslips = payslips.filter((p) => p.uid === uid).sort((a, b) => b.month.localeCompare(a.month));
  const myDocs = documents.filter((d) => d.uid === uid);
  const myReviews = reviews.filter((r) => r.uid === uid);
  const myAttendance = attendance.filter((a) => a.uid === uid).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7);

  const [phone, setPhone] = useState(employeeProfile?.phone || '');
  const [address, setAddress] = useState(employeeProfile?.address || '');
  const [emergencyName, setEmergencyName] = useState(employeeProfile?.emergencyContactName || '');
  const [emergencyPhone, setEmergencyPhone] = useState(employeeProfile?.emergencyContactPhone || '');
  const [emergencyRel, setEmergencyRel] = useState(employeeProfile?.emergencyContactRelation || '');
  const [timezone, setTimezone] = useState(employeeProfile?.timezone || policy.officeTimezone);
  const [birthdayOptOut, setBirthdayOptOut] = useState(employeeProfile?.birthdayOptOut || false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileNotice, setProfileNotice] = useState('');

  // TOTP 2FA State
  const [totpSession, setTotpSession] = useState<TotpEnrollmentStart | null>(null);
  const [totpQrDataUrl, setTotpQrDataUrl] = useState<string>('');
  const [totpCode, setTotpCode] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaMessage, setMfaMessage] = useState('');
  const [mfaError, setMfaError] = useState('');

  useEffect(() => {
    let active = true;
    if (!totpSession?.qrUri) {
      setTotpQrDataUrl('');
      return;
    }
    QRCode.toDataURL(totpSession.qrUri, { width: 192, margin: 1 })
      .then((url) => {
        if (active) setTotpQrDataUrl(url);
      })
      .catch(() => {
        if (active) setTotpQrDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [totpSession?.qrUri]);

  useEffect(() => {
    setPhone(employeeProfile?.phone || '');
    setAddress(employeeProfile?.address || '');
    setEmergencyName(employeeProfile?.emergencyContactName || '');
    setEmergencyPhone(employeeProfile?.emergencyContactPhone || '');
    setEmergencyRel(employeeProfile?.emergencyContactRelation || '');
    setTimezone(employeeProfile?.timezone || policy.officeTimezone);
    setBirthdayOptOut(employeeProfile?.birthdayOptOut || false);
  }, [employeeProfile, policy.officeTimezone]);

  const [announcementReads, setAnnouncementReads] = useState<Array<{announcementId:string;readAt?:unknown}>>([]);
  useEffect(() => {
    if (!uid) return;
    const q = query(collection(db, 'announcementReads'), where('uid', '==', uid));
    return onSnapshot(q, (snap) => setAnnouncementReads(snap.docs.map((d) => d.data() as {announcementId:string;readAt?:unknown})));
  }, [uid]);
  const acknowledgeAnnouncement = async (announcement: (typeof announcements)[number]) => {
    try {
      const id = `${announcement.id}_${uid}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
      await setDoc(doc(db, 'announcementReads', id), {
        id,
        uid,
        employeeName: employeeProfile?.fullName || firebaseUser?.displayName || 'Employee',
        departmentId: employeeProfile?.departmentId || '',
        announcementId: announcement.id,
        title: announcement.title,
        category: announcement.category,
        readAt: serverTimestamp(),
        acknowledgedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'announcementReads');
    }
  };

  const [payrollUnlocked, setPayrollUnlocked] = useState(false);
  const unlockMyPayroll = async () => {
    const password = window.prompt('Enter your ACE HRMS account password to view your payslips.');
    if (!password) return;
    try {
      const result = await reauthenticateCurrentUser(password);
      if (result.mfaRequired) {
        window.alert('Your account requires an additional MFA verification. Complete the sign-in security challenge, then try again.');
        return;
      }
      setPayrollUnlocked(true);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Password verification failed. Please try again.');
    }
  };
  const downloadMyPayslip = (payslip: (typeof myPayslips)[number]) => {
    if (!payrollUnlocked) return;
    generatePayslipPdf(payslip, companySettings.companyName, companySettings.address);
  };

  const [docTitle, setDocTitle] = useState('');
  const [docCategory, setDocCategory] = useState<EmployeeDocument['category']>('id_proof');
  const [docExpiryDate, setDocExpiryDate] = useState('');
  const [docFile, setDocFile] = useState<File | null>(null);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [docMsg, setDocMsg] = useState('');

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!employeeProfile) return;
    setSavingProfile(true);
    setProfileNotice('');
    try {
      await updateDoc(doc(db, 'employees', employeeProfile.id), {
        phone: phone.trim(),
        address: address.trim(),
        emergencyContactName: emergencyName.trim(),
        emergencyContactPhone: emergencyPhone.trim(),
        emergencyContactRelation: emergencyRel.trim(),
        timezone,
        birthdayOptOut,
        updatedAt: serverTimestamp(),
      });
      setProfileNotice('Personal contact details updated.');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `employees/${employeeProfile.id}`);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleBeginTotp = async () => {
    setMfaBusy(true);
    setMfaError('');
    setMfaMessage('');
    try {
      const started = await startTotpEnrollment();
      setTotpSession(started);
      setTotpCode('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to start 2FA enrollment.';
      if (msg.includes('operation-not-allowed') || msg.includes('unsupported')) {
        setMfaError('TOTP 2FA requires Identity Platform Multi-Factor Authentication to be enabled in Firebase Console → Authentication → Settings → Security.');
      } else if (msg.includes('requires-recent-login')) {
        setMfaError('For security, please sign out and sign back in right now before changing 2FA settings.');
      } else {
        setMfaError(msg);
      }
    } finally {
      setMfaBusy(false);
    }
  };

  const handleVerifyTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!totpSession || !totpCode.trim()) return;
    setMfaBusy(true);
    setMfaError('');
    try {
      await totpSession.verifyAndEnroll(totpCode.trim(), 'ACE Authenticator');
      setTotpSession(null);
      setTotpQrDataUrl('');
      setTotpCode('');
      setMfaMessage('Two-factor authentication (TOTP) is now active on your account.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid verification code. Check your authenticator clock.';
      setMfaError(
        msg.includes('requires-recent-login')
          ? 'Session too old for 2FA enrollment. Sign out, sign back in, and retry immediately.'
          : msg
      );
    } finally {
      setMfaBusy(false);
    }
  };

  const handleUnenrollTotp = async (factorUid: string) => {
    setMfaBusy(true);
    setMfaError('');
    try {
      await unenrollMfaFactor(factorUid);
      setMfaMessage('Authenticator 2FA factor removed.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to remove 2FA factor (recent sign-in may be required).';
      setMfaError(
        msg.includes('requires-recent-login')
          ? 'Please sign out and sign back in recently before removing an enrolled 2FA factor.'
          : msg
      );
    } finally {
      setMfaBusy(false);
    }
  };

  const handleUploadDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !docFile || !docTitle.trim()) return;
    setUploadingDoc(true);
    setDocMsg('');
    try {
      const fileUrl = await uploadToStorage(`documents/${uid}`, docFile);
      const id = makeId('doc');
      await setDoc(doc(db, 'documents', id), {
        id,
        uid,
        employeeId: employeeProfile?.id || uid,
        title: docTitle.trim(),
        category: docCategory,
        fileUrl,
        fileName: docFile.name,
        fileSize: docFile.size,
        ...(docExpiryDate ? { expiryDate: docExpiryDate } : {}),
        verified: false,
        uploadedByUid: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog({
        actorUid: uid,
        actorEmail: firebaseUser.email || '',
        actorRole: effectiveRole,
        action: 'DOCUMENT_UPLOADED',
        targetCollection: 'documents',
        targetId: id,
        summary: `Uploaded document "${docTitle.trim()}"`,
      });
      setDocTitle('');
      setDocExpiryDate('');
      setDocFile(null);
      setDocMsg('Document uploaded securely.');
    } catch (err) {
      setDocMsg(err instanceof Error ? err.message : 'Upload failed — check Firebase Storage rules.');
    } finally {
      setUploadingDoc(false);
    }
  };

  const acknowledgeReview = async (reviewId: string) => {
    try {
      await updateDoc(doc(db, 'reviews', reviewId), {
        status: 'acknowledged',
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `reviews/${reviewId}`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#FFFFFF]">
            Welcome, {employeeProfile?.fullName || firebaseUser?.displayName || 'Team Member'}
          </h1>
          <p className="text-sm text-[#A1A1AA] mt-1">
            {employeeProfile
              ? `${employeeProfile.employeeCode} · ${employeeProfile.designation} · ${employeeProfile.departmentName}`
              : 'Your employee workspace'}
          </p>
        </div>

        <button
          type="button"
          onClick={() => onNavigate('leave')}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#151922] hover:bg-[#1B1F28] border border-[#292D36] hover:border-[#FF4634]/50 text-[#FFFFFF] text-xs font-medium rounded-xl whitespace-nowrap self-start sm:self-center transition-colors"
        >
          <CalendarOff className="w-4 h-4 text-[#FF6A33]" />
          Apply Leave
        </button>
      </div>

      {/* Live Attendance Check-In / Lunch / Check-Out Portal */}
      <AttendanceCheckInWidget onRequestCorrection={() => onNavigate('attendance')} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 bg-[#151922] border border-[#292D36] rounded-2xl">
          <h2 className="text-sm font-semibold text-[#FFFFFF] mb-2">Today at ACE</h2>
          {todaysHoliday ? <p className="text-sm text-[#D4D4D8]">{todaysHoliday.name} <span className="text-[#A1A1AA]">· {todaysHoliday.type} holiday</span></p> : <p className="text-sm text-[#D4D4D8]">No company holiday scheduled for today.</p>}
        </div>
        <div className="p-4 bg-[#151922] border border-[#292D36] rounded-2xl">
          <div className="flex items-center justify-between mb-2"><h2 className="text-sm font-semibold text-[#FFFFFF]">My Pending Tasks</h2><button type="button" onClick={() => onNavigate('tasks')} className="text-xs text-[#FF6A33]">View tasks</button></div>
          {pendingTasks.length ? <ul className="space-y-2">{pendingTasks.map((task) => <li key={task.id} className="flex items-center justify-between gap-3 text-sm"><span className="text-[#D4D4D8] truncate">{task.title}</span><span className="text-xs text-[#A1A1AA] shrink-0">{task.status.replace('_', ' ')}</span></li>)}</ul> : <p className="text-sm text-[#D4D4D8]">No pending tasks assigned.</p>}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className="p-4 bg-[#151922] border border-[#292D36] rounded-2xl">
          <h2 className="text-sm font-semibold text-[#FFFFFF] mb-3">Upcoming Holidays</h2>
          {upcomingHolidays.length ? <div className="space-y-2">{upcomingHolidays.map((holiday) => <div key={holiday.id} className="flex items-center justify-between gap-3 text-sm"><span className="text-[#D4D4D8]">{holiday.name}</span><span className="text-xs text-[#A1A1AA]">{holiday.date}</span></div>)}</div> : <p className="text-sm text-[#A1A1AA]">No upcoming holidays have been added.</p>}
        </section>
        <section className="p-4 bg-[#151922] border border-[#292D36] rounded-2xl">
          <h2 className="text-sm font-semibold text-[#FFFFFF] mb-3">Birthdays & Work Anniversaries</h2>
          {birthdayAnnouncements.length ? <div className="space-y-2">{birthdayAnnouncements.map((item) => <div key={item.id}><div className="text-sm text-[#D4D4D8]">{item.title}</div><p className="text-xs text-[#A1A1AA] mt-0.5">{item.content}</p></div>)}</div> : <p className="text-sm text-[#A1A1AA]">No birthday or anniversary announcements yet.</p>}
        </section>
      </div>

      {/* Leave Balances Summary (Pending shown separately and NOT deducted) */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        {[
          { label: 'Paid Leave', rem: myLeaveSummary.paidRemaining, used: myLeaveSummary.paidUsed, pending: myLeaveSummary.paidPending, total: myLeaveSummary.paidTotal, carried: myLeaveSummary.carriedForwardDays },
          { label: 'Casual Leave', rem: myLeaveSummary.casualRemaining, used: myLeaveSummary.casualUsed, pending: myLeaveSummary.casualPending, total: myLeaveSummary.casualTotal, carried: 0 },
          { label: 'Sick Leave', rem: myLeaveSummary.sickRemaining, used: myLeaveSummary.sickUsed, pending: myLeaveSummary.sickPending, total: myLeaveSummary.sickTotal, carried: 0 },
          { label: 'Emergency', rem: myLeaveSummary.emergencyRemaining, used: myLeaveSummary.emergencyUsed, pending: myLeaveSummary.emergencyPending, total: myLeaveSummary.emergencyTotal, carried: 0 },
          { label: 'Unpaid (LWP)', rem: myLeaveSummary.unpaidUsed, used: myLeaveSummary.unpaidUsed, pending: myLeaveSummary.unpaidPending, total: null, carried: 0 },
        ].map((item) => (
          <div key={item.label} className="p-4 bg-[#151922] border border-[#292D36] rounded-2xl">
            <div className="text-sm font-medium text-[#D4D4D8]">{item.label}</div>
            <div className="font-mono text-xl font-semibold text-[#FFFFFF] tabular-nums mt-1">
              {item.total !== null ? `${item.rem}d available` : `${item.rem}d used`}
            </div>
            <div className="text-[11px] text-[#A1A1AA] mt-0.5 tabular-nums font-mono">
              {item.total !== null
                ? `${item.used}/${item.total} used · ${item.pending}d pending${item.carried ? ` (+${item.carried}d carry)` : ''}`
                : `${item.pending}d pending · Deducted per payroll`}
            </div>
          </div>
        ))}
      </div>

      {/* My Recent Leave Applications */}
      <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-base font-semibold text-[#FFFFFF]">My Recent Leave Requests</h2>
          <button
            type="button"
            onClick={() => onNavigate('leave')}
            className="text-xs text-[#FF6A33] hover:text-[#FF4634] font-medium"
          >
            Manage leaves
          </button>
        </div>
        {myLeaveRequests.length === 0 ? (
          <p className="text-xs text-[#A1A1AA]">No leave applications recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[#A1A1AA] border-b border-[#292D36]">
                  <th className="py-2 text-left font-medium">Type</th>
                  <th className="py-2 text-left font-medium">Dates</th>
                  <th className="py-2 text-right font-medium">Days</th>
                  <th className="py-2 text-left font-medium">Status</th>
                  <th className="py-2 text-left font-medium">Reviewer Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#292D36]/70">
                {myLeaveRequests.slice(0, 5).map((lr) => (
                  <tr key={lr.id}>
                    <td className="py-2 capitalize text-[#FF6A33] font-medium">{lr.leaveType}</td>
                    <td className="py-2 font-mono text-[#FFFFFF] tabular-nums">{lr.startDate} → {lr.endDate}</td>
                    <td className="py-2 text-right font-mono text-[#FFFFFF] tabular-nums">{lr.daysCount}d</td>
                    <td className="py-2 capitalize font-medium">
                      <span className={lr.status === 'approved' ? 'text-emerald-400' : lr.status === 'rejected' || lr.status === 'cancelled' ? 'text-rose-400' : 'text-amber-400'}>
                        {lr.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="py-2 text-[#A1A1AA] truncate max-w-xs">{lr.reviewComment || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Profile Update & Attendance Log */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <form onSubmit={handleSaveProfile} className="lg:col-span-6 bg-[#151922] border border-[#292D36] rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <User className="w-4 h-4 text-[#FF6A33]" />
              <h2 className="font-display text-base font-semibold text-[#FFFFFF]">Personal Information</h2>
            </div>
            <span className="text-xs text-[#A1A1AA]">Permitted self-service fields</span>
          </div>
          {!employeeProfile ? (
            <p className="text-xs text-[#A1A1AA]">
              Your user account is active. HR can link your full employee profile record under Employees.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#A1A1AA] mb-1">Phone Number</label>
                  <input
                    type="text"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-sm text-[#FFFFFF]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#A1A1AA] mb-1">Emergency Contact Name</label>
                  <input
                    type="text"
                    value={emergencyName}
                    onChange={(e) => setEmergencyName(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-sm text-[#FFFFFF]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#A1A1AA] mb-1">Emergency Phone</label>
                  <input
                    type="text"
                    value={emergencyPhone}
                    onChange={(e) => setEmergencyPhone(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-sm text-[#FFFFFF]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#A1A1AA] mb-1">Relationship</label>
                  <input
                    type="text"
                    value={emergencyRel}
                    onChange={(e) => setEmergencyRel(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-sm text-[#FFFFFF]"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-[#D4D4D8] mb-1">My Timezone</label>
                <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-sm text-[#FFFFFF]">
                  {COMMON_TIMEZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
                </select>
              </div>
              <label className="flex items-start gap-2 text-xs text-[#D4D4D8]">
                <input type="checkbox" checked={!birthdayOptOut} onChange={(e) => setBirthdayOptOut(!e.target.checked)} className="mt-0.5 accent-[#FF4634]" />
                Include my birthday in company announcements (my birth year is never displayed)
              </label>
              <div>
                <label className="block text-xs text-[#A1A1AA] mb-1">Residential Address</label>
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-sm text-[#FFFFFF]"
                />
              </div>
              {profileNotice && (
                <div className="text-xs text-emerald-400 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{profileNotice}</span>
                </div>
              )}
              <button
                type="submit"
                disabled={savingProfile}
                className="ace-btn-primary inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl"
              >
                <Save className="w-3.5 h-3.5" />
                {savingProfile ? 'Saving...' : 'Save Contact Details'}
              </button>
            </>
          )}
        </form>

        {/* Recent Attendance & Payslips */}
        <div className="lg:col-span-6 space-y-6">
          <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display text-base font-semibold text-[#FFFFFF]">My Recent Attendance</h2>
              <button
                type="button"
                onClick={() => onNavigate('attendance')}
                className="text-xs text-[#FF6A33] hover:text-[#FF4634] font-medium"
              >
                Full history
              </button>
            </div>
            {myAttendance.length === 0 ? (
              <p className="text-xs text-[#A1A1AA]">No attendance entries recorded yet. Use Check In Now above.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[#A1A1AA] border-b border-[#292D36]">
                      <th className="py-2 text-left font-medium">Date</th>
                      <th className="py-2 text-left font-medium">In</th>
                      <th className="py-2 text-left font-medium">Out</th>
                      <th className="py-2 text-right font-medium">Hours</th>
                      <th className="py-2 text-right font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#292D36]/70">
                    {myAttendance.map((rec) => (
                      <tr key={rec.id}>
                        <td className="py-2 font-mono text-[#FFFFFF] tabular-nums">{rec.date}</td>
                        <td className="py-2 font-mono text-[#A1A1AA] tabular-nums">
                          {formatTimeInZone(rec.checkInTime, rec.officeTimezone || policy.officeTimezone)}
                        </td>
                        <td className="py-2 font-mono text-[#A1A1AA] tabular-nums">
                          {formatTimeInZone(rec.checkOutTime, rec.officeTimezone || policy.officeTimezone)}
                        </td>
                        <td className="py-2 text-right font-mono text-[#FFFFFF] tabular-nums">
                          {(rec.workingMinutes / 60).toFixed(1)}h
                        </td>
                        <td className="py-2 text-right capitalize font-medium">
                          <span
                            className={
                              rec.status === 'present'
                                ? 'text-emerald-400'
                                : rec.status === 'absent'
                                ? 'text-rose-400'
                                : 'text-amber-400'
                            }
                          >
                            {rec.status.replace('_', ' ')}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5">
            <h2 className="font-display text-base font-semibold text-[#FFFFFF] mb-3">My Payslips</h2>
            {!payrollUnlocked ? (
              <div className="rounded-xl border border-[#292D36] bg-[#1B1F28] p-4">
                <p className="text-xs text-[#A1A1AA] mb-3">Payslip details and net salary stay hidden until you verify your account password.</p>
                <button type="button" onClick={() => void unlockMyPayroll()} className="ace-btn-primary inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold">
                  <KeyRound className="w-3.5 h-3.5" /> Verify Password to View
                </button>
              </div>
            ) : myPayslips.length === 0 ? (
              <p className="text-xs text-[#A1A1AA]">No payslips issued for your account yet.</p>
            ) : (
              <div className="space-y-2.5">
                {myPayslips.slice(0, 4).map((ps) => (
                  <div key={ps.id} className="flex items-center justify-between p-3 rounded-xl bg-[#1B1F28] border border-[#292D36]">
                    <div>
                      <div className="text-xs font-semibold text-[#FFFFFF] font-mono">{ps.month}</div>
                      <div className="text-xs text-[#A1A1AA] mt-0.5 tabular-nums">
                        Net Pay: <span className="text-emerald-400 font-medium">{formatCurrency(ps.netPay, ps.currency)}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void downloadMyPayslip(ps)}
                      className="ace-btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg"
                    >
                      <Download className="w-3.5 h-3.5" />
                      PDF
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Documents, Performance Reviews & Announcements */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <FileText className="w-4 h-4 text-[#FF6A33]" />
            <h2 className="font-display text-sm font-semibold text-[#FFFFFF]">My Documents</h2>
          </div>
          <form onSubmit={handleUploadDoc} className="space-y-2.5 mb-4">
            <input
              type="text"
              required
              placeholder="Document title (e.g. National ID)"
              value={docTitle}
              onChange={(e) => setDocTitle(e.target.value)}
              className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-xs text-[#FFFFFF]"
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                value={docCategory}
                onChange={(e) => setDocCategory(e.target.value as EmployeeDocument['category'])}
                className="px-2.5 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-xs text-[#FFFFFF]"
              >
                <option value="id_proof" className="bg-[#151922]">ID Proof</option>
                <option value="certificate" className="bg-[#151922]">Certificate</option>
                <option value="contract" className="bg-[#151922]">Contract</option>
                <option value="other" className="bg-[#151922]">Other</option>
              </select>
              <label className="flex items-center justify-center gap-1.5 px-2.5 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-xs text-[#A1A1AA] cursor-pointer hover:border-[#FF4634] hover:text-[#FFFFFF] truncate">
                <FileUp className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{docFile ? docFile.name : 'Choose File'}</span>
                <input
                  type="file"
                  className="hidden"
                  onChange={(e) => setDocFile(e.target.files?.[0] || null)}
                />
              </label>
            </div>
            <div>
              <label className="block text-[11px] text-[#A1A1AA] mb-1">Expiry date (optional)</label>
              <input type="date" value={docExpiryDate} onChange={(e) => setDocExpiryDate(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-xs text-[#FFFFFF]" />
            </div>
            {docMsg && <div className="text-xs text-emerald-400">{docMsg}</div>}
            <button
              type="submit"
              disabled={uploadingDoc || !docFile}
              className="ace-btn-primary w-full py-2 disabled:opacity-50 text-xs font-semibold rounded-xl"
            >
              {uploadingDoc ? 'Uploading...' : 'Upload Document'}
            </button>
          </form>
          <div className="space-y-2">
            {myDocs.length === 0 ? (
              <p className="text-xs text-[#A1A1AA]">No documents uploaded yet.</p>
            ) : (
              myDocs.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-3 text-xs py-1.5 border-b border-[#292D36]/70 last:border-0">
                  <div className="min-w-0"><a href={d.fileUrl} target="_blank" rel="noreferrer" className="text-[#FF6A33] hover:text-[#FF4634] hover:underline truncate block">{d.title}</a>{d.expiryDate&&<span className="text-[10px] text-[#A1A1AA]">Expires {d.expiryDate}</span>}</div>
                  <span className={d.verified ? 'text-emerald-400' : 'text-amber-400'}>{d.verified ? 'Verified' : 'Pending'}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <Star className="w-4 h-4 text-[#FF6A33]" />
            <h2 className="font-display text-sm font-semibold text-[#FFFFFF]">My Performance Reviews</h2>
          </div>
          {myReviews.length === 0 ? (
            <p className="text-xs text-[#A1A1AA]">No performance reviews submitted yet.</p>
          ) : (
            <div className="space-y-3">
              {myReviews.map((rev) => (
                <div key={rev.id} className="p-3 rounded-xl bg-[#1B1F28] border border-[#292D36] space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono font-semibold text-[#FFFFFF]">{rev.reviewPeriod}</span>
                    <span className="text-[#FF6A33] font-mono">Rating {rev.rating}/5</span>
                  </div>
                  <p className="text-xs text-[#A1A1AA]">{rev.feedback || rev.achievements || 'No written feedback.'}</p>
                  {rev.status === 'submitted' && (
                    <button
                      type="button"
                      onClick={() => acknowledgeReview(rev.id)}
                      className="text-xs text-emerald-400 hover:text-emerald-300 font-medium"
                    >
                      Acknowledge Review
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-sm font-semibold text-[#FFFFFF]">Latest Notices</h2>
            <button type="button" onClick={() => onNavigate('announcements')} className="text-xs text-[#FF6A33] hover:text-[#FF4634] font-medium">
              View all
            </button>
          </div>
          {announcements.length === 0 ? (
            <p className="text-xs text-[#A1A1AA]">No active company notices.</p>
          ) : (
            <div className="space-y-3">
              {announcements.slice(0, 3).map((a) => {
                const acknowledged = announcementReads.some((item) => item.announcementId === a.id);
                return <div key={a.id} className="pb-2.5 border-b border-[#292D36]/70 last:border-0">
                  <div className="text-xs font-medium text-[#FFFFFF]">{a.title}</div>
                  <p className="text-xs text-[#A1A1AA] mt-1 line-clamp-2">{a.content}</p>
                  <button type="button" disabled={acknowledged} onClick={() => void acknowledgeAnnouncement(a)} className="mt-2 text-[10px] text-[#FF9A65] disabled:text-emerald-400">{acknowledged?(a.category==='policy'?'Acknowledged':'Read'):a.category==='policy'?'Acknowledge policy':'Mark as read'}</button>
                </div>;
              })}
            </div>
          )}
        </div>
      </div>

      {/* Account Security & Two-Factor Authentication (TOTP MFA) */}
      <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-[#FF6A33]" />
            <h2 className="font-display text-sm font-semibold text-[#FFFFFF]">
              Account Security &amp; Two-Factor Authentication (TOTP)
            </h2>
          </div>
          <span
            className={`text-xs font-medium px-2.5 py-1 rounded-lg border ${
              mfaEnrolledFactors.length > 0
                ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
                : 'text-[#A1A1AA] bg-[#1B1F28] border-[#292D36]'
            }`}
          >
            {mfaEnrolledFactors.length > 0
              ? `2FA Active (${mfaEnrolledFactors.length} factor${mfaEnrolledFactors.length > 1 ? 's' : ''})`
              : '2FA Not Enrolled'}
          </span>
        </div>

        <p className="text-xs text-[#A1A1AA]">
          Protect your ACE HRMS account ({effectiveRole.replace('_', ' ')}) with a time-based one-time password (TOTP) authenticator app such as Google Authenticator or 1Password.
        </p>

        {mfaMessage && (
          <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{mfaMessage}</span>
          </div>
        )}
        {mfaError && (
          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs">
            {mfaError}
          </div>
        )}

        {mfaEnrolledFactors.length > 0 && (
          <div className="space-y-2">
            {mfaEnrolledFactors.map((factor) => (
              <div
                key={factor.uid}
                className="flex items-center justify-between gap-3 p-3 rounded-xl bg-[#1B1F28] border border-[#292D36] text-xs"
              >
                <div className="flex items-center gap-2.5">
                  <KeyRound className="w-4 h-4 text-emerald-400 shrink-0" />
                  <div>
                    <div className="text-[#FFFFFF] font-medium">{factor.displayName || 'Authenticator App'}</div>
                    <div className="text-[#A1A1AA] text-[11px] font-mono">
                      Factor ID: {factor.uid} · Method: {factor.factorId}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={mfaBusy}
                  onClick={() => void handleUnenrollTotp(factor.uid)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-rose-500/30 text-rose-400 hover:bg-rose-500/10 disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {totpSession ? (
          <form onSubmit={handleVerifyTotp} className="p-4 rounded-xl bg-[#1B1F28] border border-[#292D36] space-y-3 text-xs">
            <div className="font-semibold text-[#FFFFFF]">Step 1: Scan QR Code or copy secret key into your authenticator app</div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              {totpQrDataUrl && (
                <div className="p-2 rounded-xl bg-white border border-[#292D36] shrink-0 self-start">
                  <img
                    src={totpQrDataUrl}
                    alt="ACE HRMS TOTP Authenticator QR Code"
                    className="w-36 h-36 block"
                  />
                </div>
              )}
              <div className="flex-1 space-y-2 min-w-0">
                <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-lg bg-[#0B0D12] border border-[#292D36]">
                  <code className="font-mono text-[#FF9A65] break-all flex-1">{totpSession.secretKey}</code>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(totpSession.secretKey);
                      setMfaMessage('Authenticator secret key copied.');
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#151922] border border-[#292D36] text-[#FFFFFF] hover:border-[#FF4634]"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    Copy Key
                  </button>
                </div>
                <div className="text-[11px] text-[#A1A1AA] break-all">
                  OTPAuth URI: <span className="font-mono text-[#FFFFFF]/80">{totpSession.qrUri}</span>
                </div>
              </div>
            </div>
            <div className="pt-1">
              <label className="block text-[#A1A1AA] mb-1">Step 2: Enter 6-digit code from app</label>
              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={8}
                  required
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  placeholder="123456"
                  className="w-40 px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF] font-mono tracking-widest"
                />
                <button
                  type="submit"
                  disabled={mfaBusy}
                  className="ace-btn-primary px-4 py-2 font-semibold rounded-xl disabled:opacity-50"
                >
                  {mfaBusy ? 'Verifying...' : 'Verify & Enable 2FA'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTotpSession(null);
                    setTotpQrDataUrl('');
                    setTotpCode('');
                  }}
                  className="px-3 py-2 bg-[#0B0D12] border border-[#292D36] text-[#A1A1AA] hover:text-[#FFFFFF] rounded-xl"
                >
                  Cancel
                </button>
              </div>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={mfaBusy}
              onClick={() => void handleBeginTotp()}
              className="ace-btn-primary inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl disabled:opacity-50"
            >
              <KeyRound className="w-3.5 h-3.5" />
              {mfaBusy ? 'Initializing...' : mfaEnrolledFactors.length > 0 ? 'Add Another Authenticator' : 'Enable Authenticator 2FA'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
