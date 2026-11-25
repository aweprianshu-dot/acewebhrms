import React, { useEffect, useMemo, useState } from 'react';
import {
  doc,
  updateDoc,
  writeBatch,
  serverTimestamp,
} from 'firebase/firestore';
import {
  Search,
  UserPlus,
  Edit3,
  Eye,
  X,
  Power,
  Mail,
  Shield,
  Wallet,
  Upload,
  Download,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import { makeId, uploadToStorage, writeAuditLog, apiRequest, getEmailProviderStatus } from '../../services/hrmsApi';
import { exportToCsv, exportToXlsx, formatCurrency } from '../../utils/exportUtils';
import type { EmployeeProfile, EmployeeStatus, EmploymentType, UserRole } from '../../types/hrms';

interface EmployeesModuleProps {
  initialSelectedEmployeeId?: string | null;
  onClearSelectedEmployee?: () => void;
}

export const EmployeesModule: React.FC<EmployeesModuleProps> = ({
  initialSelectedEmployeeId,
  onClearSelectedEmployee,
}) => {
  const { firebaseUser, effectiveRole } = useAuth();
  const { employees, roles, salaries, departments, designations, payrollConfig } = useHrmsData();

  const canManage = effectiveRole === 'super_admin' || effectiveRole === 'hr_manager';

  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('all');
  const [teamFilter, setTeamFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const pageSize = 10;

  const [showModal, setShowModal] = useState(false);
  const [editingEmp, setEditingEmp] = useState<EmployeeProfile | null>(null);
  const [viewingEmp, setViewingEmp] = useState<EmployeeProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  // Form state
  const [employeeCode, setEmployeeCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [designation, setDesignation] = useState('');
  const [joiningDate, setJoiningDate] = useState(new Date().toISOString().slice(0, 10));
  const [birthDate, setBirthDate] = useState('');
  const [probationEndDate, setProbationEndDate] = useState('');
  const [probationStatus, setProbationStatus] = useState<EmployeeProfile['probationStatus']>('in_probation');
  const [countryCode, setCountryCode] = useState('IN');
  const [shiftStartTime, setShiftStartTime] = useState('09:30');
  const [shiftEndTime, setShiftEndTime] = useState('18:30');
  const [employmentType, setEmploymentType] = useState<EmploymentType>('full_time');
  const [reportingManagerName, setReportingManagerName] = useState('');
  const [reportingManagerUid, setReportingManagerUid] = useState('');
  const [teamId, setTeamId] = useState('');
  const [teamName, setTeamName] = useState('');
  const [teamLeadUid, setTeamLeadUid] = useState('');
  const [teamLeadName, setTeamLeadName] = useState('');
  const [emergencyContactName, setEmergencyContactName] = useState('');
  const [emergencyContactPhone, setEmergencyContactPhone] = useState('');
  const [emergencyContactRelation, setEmergencyContactRelation] = useState('');
  const [inviteRole, setInviteRole] = useState<Exclude<UserRole, 'super_admin'>>('employee');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [avatarUploading, setAvatarUploading] = useState(false);

  // Salary fields
  const [basicSalary, setBasicSalary] = useState(4000);
  const [hraAllowance, setHraAllowance] = useState(800);
  const [transportAllowance, setTransportAllowance] = useState(200);
  const [specialAllowance, setSpecialAllowance] = useState(400);
  const [bonus, setBonus] = useState(0);
  const [incentives, setIncentives] = useState(0);
  const [deductions, setDeductions] = useState(0);
  const [overtimeHourlyRate, setOvertimeHourlyRate] = useState(25);

  useEffect(() => {
    if (!initialSelectedEmployeeId) return;
    const match = employees.find((e) => e.id === initialSelectedEmployeeId || e.uid === initialSelectedEmployeeId);
    if (match) {
      setViewingEmp(match);
      onClearSelectedEmployee?.();
    }
  }, [initialSelectedEmployeeId, employees, onClearSelectedEmployee]);

  const teamOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const emp of employees) {
      if (emp.teamId && emp.teamName) map.set(emp.teamId, emp.teamName);
      else if (emp.teamName) map.set(emp.teamName, emp.teamName);
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [employees]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees.filter((emp) => {
      const matchesQ =
        !q ||
        emp.fullName.toLowerCase().includes(q) ||
        emp.employeeCode.toLowerCase().includes(q) ||
        emp.email.toLowerCase().includes(q) ||
        emp.designation.toLowerCase().includes(q) ||
        (emp.teamName || '').toLowerCase().includes(q);
      const matchesDept = deptFilter === 'all' || emp.departmentId === deptFilter;
      const matchesTeam = teamFilter === 'all' || emp.teamId === teamFilter || emp.teamName === teamFilter;
      const matchesStatus = statusFilter === 'all' || emp.status === statusFilter;
      return matchesQ && matchesDept && matchesTeam && matchesStatus;
    });
  }, [employees, search, deptFilter, teamFilter, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  const openCreate = () => {
    setEditingEmp(null);
    setEmployeeCode(`ACE-${String(employees.length + 1).padStart(3, '0')}`);
    setFullName('');
    setEmail('');
    setPhone('');
    setAddress('');
    setDepartmentId(departments[0]?.id || 'dept_eng');
    setDesignation(designations[0]?.title || 'Software Engineer');
    setJoiningDate(new Date().toISOString().slice(0, 10));
    setBirthDate('');
    setProbationEndDate('');
    setProbationStatus('in_probation');
    setCountryCode('IN');
    setShiftStartTime('09:30');
    setShiftEndTime('18:30');
    setEmploymentType('full_time');
    setReportingManagerUid('');
    setReportingManagerName('');
    setTeamId('');
    setTeamName('');
    setTeamLeadUid('');
    setTeamLeadName('');
    setEmergencyContactName('');
    setEmergencyContactPhone('');
    setEmergencyContactRelation('');
    setInviteRole('employee');
    setAvatarUrl('');
    setBasicSalary(4000);
    setHraAllowance(800);
    setTransportAllowance(200);
    setSpecialAllowance(400);
    setBonus(0);
    setIncentives(0);
    setDeductions(0);
    setOvertimeHourlyRate(25);
    setStatusMsg('');
    setShowModal(true);
  };

  const openEdit = (emp: EmployeeProfile) => {
    const sal = salaries.find((s) => s.employeeId === emp.id);
    setEditingEmp(emp);
    setEmployeeCode(emp.employeeCode);
    setFullName(emp.fullName);
    setEmail(emp.email);
    setPhone(emp.phone || '');
    setAddress(emp.address || '');
    setDepartmentId(emp.departmentId);
    setDesignation(emp.designation);
    setJoiningDate(emp.joiningDate);
    setBirthDate(emp.birthDate || '');
    setProbationEndDate(emp.probationEndDate || '');
    setProbationStatus(emp.probationStatus || 'in_probation');
    setCountryCode(emp.countryCode || 'IN');
    setShiftStartTime(emp.shiftStartTime || '09:30');
    setShiftEndTime(emp.shiftEndTime || '18:30');
    setEmploymentType(emp.employmentType);
    setReportingManagerName(emp.reportingManagerName || '');
    setReportingManagerUid(emp.reportingManagerUid || '');
    setTeamId(emp.teamId || '');
    setTeamName(emp.teamName || '');
    setTeamLeadUid(emp.teamLeadUid || '');
    setTeamLeadName(emp.teamLeadName || '');
    setEmergencyContactName(emp.emergencyContactName || '');
    setEmergencyContactPhone(emp.emergencyContactPhone || '');
    setEmergencyContactRelation(emp.emergencyContactRelation || '');
    setAvatarUrl(emp.avatarUrl || '');
    if (sal) {
      setBasicSalary(sal.basicSalary);
      setHraAllowance(sal.hraAllowance);
      setTransportAllowance(sal.transportAllowance);
      setSpecialAllowance(sal.specialAllowance);
      setBonus(sal.bonus);
      setIncentives(sal.incentives);
      setDeductions(sal.deductions);
      setOvertimeHourlyRate(sal.overtimeHourlyRate);
    }
    setStatusMsg('');
    setShowModal(true);
  };

  const handleAvatarUpload = async (file: File) => {
    setAvatarUploading(true);
    try {
      const url = await uploadToStorage('avatars', file);
      setAvatarUrl(url);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Avatar upload failed');
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleSaveEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !canManage) return;
    setSaving(true);
    setStatusMsg('');

    const deptObj = departments.find((d) => d.id === departmentId);
    const deptName = deptObj?.name || 'General';
    const birthMonthDay = birthDate && birthDate.length === 10 ? birthDate.slice(5) : '';

    const cleanTeamName = teamName.trim();
    const resolvedTeamId = cleanTeamName
      ? (teamId.trim() || `team_${cleanTeamName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`.slice(0, 64))
      : '';

    try {
      if (editingEmp) {
        const batch = writeBatch(db);
        batch.update(doc(db, 'employees', editingEmp.id), {
          fullName: fullName.trim(),
          avatarUrl,
          email: email.trim().toLowerCase(),
          phone: phone.trim(),
          address: address.trim(),
          departmentId,
          departmentName: deptName,
          designation: designation.trim(),
          joiningDate,
          birthDate,
          ...(probationEndDate ? { probationEndDate } : {}),
          probationStatus,
          countryCode: countryCode.trim().toUpperCase(),
          shiftStartTime,
          shiftEndTime,
          employmentType,
          reportingManagerUid,
          reportingManagerName: reportingManagerName.trim(),
          teamId: resolvedTeamId,
          teamName: cleanTeamName,
          teamLeadUid,
          teamLeadName: teamLeadName.trim(),
          emergencyContactName: emergencyContactName.trim(),
          emergencyContactPhone: emergencyContactPhone.trim(),
          emergencyContactRelation: emergencyContactRelation.trim(),
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(db, 'directory', editingEmp.id), {
          fullName: fullName.trim(),
          avatarUrl,
          departmentId,
          departmentName: deptName,
          designation: designation.trim(),
          joiningDate,
          birthMonthDay,
          updatedAt: serverTimestamp(),
        });
        batch.set(
          doc(db, 'salaries', editingEmp.id),
          {
            employeeId: editingEmp.id,
            uid: editingEmp.uid || '',
            currency: payrollConfig.currency,
            basicSalary: Number(basicSalary) || 0,
            hraAllowance: Number(hraAllowance) || 0,
            transportAllowance: Number(transportAllowance) || 0,
            specialAllowance: Number(specialAllowance) || 0,
            bonus: Number(bonus) || 0,
            incentives: Number(incentives) || 0,
            deductions: Number(deductions) || 0,
            overtimeHourlyRate: Number(overtimeHourlyRate) || 0,
            effectiveFrom: joiningDate,
            updatedByUid: firebaseUser.uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
        await batch.commit();
        if (editingEmp.uid) {
          const targetRole = roles.find((r) => r.uid === editingEmp.uid);
          if (
            targetRole &&
            (targetRole.departmentId !== departmentId ||
              (targetRole.teamId || '') !== resolvedTeamId ||
              (targetRole.teamLeadUid || '') !== teamLeadUid) &&
            (effectiveRole === 'super_admin' || targetRole.role !== 'super_admin')
          ) {
            await updateDoc(doc(db, 'roles', editingEmp.uid), {
              departmentId,
              teamId: resolvedTeamId,
              teamLeadUid,
              updatedAt: serverTimestamp(),
            }).catch(() => {});
          }
          await apiRequest('/api/leaves/sync-employee-scope', {
            method: 'POST',
            body: JSON.stringify({ targetUid: editingEmp.uid }),
          }).catch(() => {});
        }
        await writeAuditLog({
          actorUid: firebaseUser.uid,
          actorEmail: firebaseUser.email || '',
          actorRole: effectiveRole,
          action: 'EMPLOYEE_UPDATED',
          targetCollection: 'employees',
          targetId: editingEmp.id,
          summary: `Updated employee ${fullName.trim()} (${editingEmp.employeeCode})`,
        });
        setShowModal(false);
      } else {
        const empId = makeId('emp');
        const inviteId = makeId('inv');
        const onbId = makeId('onb');
        const cleanEmail = email.trim().toLowerCase();

        const batch = writeBatch(db);
        batch.set(doc(db, 'employees', empId), {
          id: empId,
          uid: '',
          employeeCode: employeeCode.trim(),
          fullName: fullName.trim(),
          avatarUrl,
          email: cleanEmail,
          phone: phone.trim(),
          address: address.trim(),
          departmentId,
          departmentName: deptName,
          designation: designation.trim(),
          joiningDate,
          birthDate,
          ...(probationEndDate ? { probationEndDate } : {}),
          probationStatus,
          countryCode: countryCode.trim().toUpperCase(),
          shiftStartTime,
          shiftEndTime,
          employmentType,
          reportingManagerUid,
          reportingManagerName: reportingManagerName.trim(),
          teamId: resolvedTeamId,
          teamName: cleanTeamName,
          teamLeadUid,
          teamLeadName: teamLeadName.trim(),
          emergencyContactName: emergencyContactName.trim(),
          emergencyContactPhone: emergencyContactPhone.trim(),
          emergencyContactRelation: emergencyContactRelation.trim(),
          status: 'onboarding',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        batch.set(doc(db, 'directory', empId), {
          id: empId,
          uid: '',
          employeeCode: employeeCode.trim(),
          fullName: fullName.trim(),
          avatarUrl,
          departmentId,
          departmentName: deptName,
          designation: designation.trim(),
          joiningDate,
          birthMonthDay,
          status: 'onboarding',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        batch.set(doc(db, 'salaries', empId), {
          employeeId: empId,
          uid: '',
          currency: payrollConfig.currency,
          basicSalary: Number(basicSalary) || 0,
          hraAllowance: Number(hraAllowance) || 0,
          transportAllowance: Number(transportAllowance) || 0,
          specialAllowance: Number(specialAllowance) || 0,
          bonus: Number(bonus) || 0,
          incentives: Number(incentives) || 0,
          deductions: Number(deductions) || 0,
          overtimeHourlyRate: Number(overtimeHourlyRate) || 0,
          effectiveFrom: joiningDate,
          updatedByUid: firebaseUser.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        batch.set(doc(db, 'invitations', inviteId), {
          id: inviteId,
          email: cleanEmail,
          fullName: fullName.trim(),
          role: inviteRole,
          departmentId,
          departmentName: deptName,
          designation: designation.trim(),
          employeeId: empId,
          invitedByUid: firebaseUser.uid,
          status: 'pending',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        batch.set(doc(db, 'onboarding', onbId), {
          id: onbId,
          uid: '',
          employeeId: empId,
          employeeName: fullName.trim(),
          email: cleanEmail,
          departmentId,
          departmentName: deptName,
          designation: designation.trim(),
          offerLetterUrl: '',
          offerLetterStatus: 'pending',
          policyAcknowledged: false,
          documentsVerified: false,
          accountCreated: false,
          trainingChecklist: [
            { title: 'Security & Confidentiality Briefing', completed: false },
            { title: 'ACE Web Experts Engineering & Workspace Setup', completed: false },
            { title: 'HR Policy & Leave Guidelines Review', completed: false },
          ],
          progressPercent: 0,
          status: 'in_progress',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        await batch.commit();

        await writeAuditLog({
          actorUid: firebaseUser.uid,
          actorEmail: firebaseUser.email || '',
          actorRole: effectiveRole,
          action: 'EMPLOYEE_CREATED',
          targetCollection: 'employees',
          targetId: empId,
          summary: `Created employee ${fullName.trim()} (${employeeCode.trim()}) with ${inviteRole} invitation`,
        });

        // Attempt real email invitation notification only if SMTP provider is configured
        try {
          const smtpReady = await getEmailProviderStatus();
          if (smtpReady) {
            await apiRequest('/api/notifications/send-email', {
              method: 'POST',
              body: JSON.stringify({
                to: cleanEmail,
                subject: `Invitation to Join ACE HRMS (${deptName})`,
                title: `Welcome to ACE Web Experts, ${fullName.trim()}`,
                message: `You have been invited to ACE HRMS as ${designation.trim()} in ${deptName}.\nSign up or sign in using ${cleanEmail} to activate your workspace automatically.`,
                actionLabel: 'Activate Account',
              }),
            });
          }
        } catch {
          // Non-fatal if SMTP delivery fails
        }

        setShowModal(false);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'employees');
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (emp: EmployeeProfile) => {
    if (!canManage || !firebaseUser) return;
    const nextStatus: EmployeeStatus = emp.status === 'inactive' ? 'active' : 'inactive';
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'employees', emp.id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, 'directory', emp.id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
      if (emp.uid) {
        batch.update(doc(db, 'roles', emp.uid), {
          status: nextStatus === 'inactive' ? 'inactive' : 'active',
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
      await writeAuditLog({
        actorUid: firebaseUser.uid,
        actorEmail: firebaseUser.email || '',
        actorRole: effectiveRole,
        action: nextStatus === 'inactive' ? 'EMPLOYEE_DEACTIVATED' : 'EMPLOYEE_ACTIVATED',
        targetCollection: 'employees',
        targetId: emp.id,
        summary: `${nextStatus === 'inactive' ? 'Deactivated' : 'Activated'} ${emp.fullName}`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `employees/${emp.id}`);
    }
  };

  const viewingSalary = viewingEmp ? salaries.find((s) => s.employeeId === viewingEmp.id) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#FFFFFF]">Employees</h1>
          <p className="text-sm text-[#A1A1AA] mt-1">
            {employees.length} authorized records · Private compensation and PII enforced by role
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                exportToCsv(
                  'ace-employees-roster.csv',
                  ['EmployeeCode', 'FullName', 'Email', 'Department', 'Designation', 'JoiningDate', 'Country', 'Shift', 'Status'],
                  filtered.map((emp) => [
                    emp.employeeCode,
                    emp.fullName,
                    emp.email,
                    emp.departmentName,
                    emp.designation,
                    emp.joiningDate,
                    emp.countryCode || 'IN',
                    `${emp.shiftStartTime || '09:30'}-${emp.shiftEndTime || '18:30'}`,
                    emp.status,
                  ]),
                )
              }
              className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium rounded-xl border border-[#292D36] bg-[#151922] text-[#A1A1AA] hover:text-[#FFFFFF]"
            >
              <Download className="w-3.5 h-3.5" />
              CSV
            </button>
            <button
              type="button"
              onClick={() =>
                void exportToXlsx(
                  'ace-employees-roster.xlsx',
                  ['EmployeeCode', 'FullName', 'Email', 'Department', 'Designation', 'JoiningDate', 'Country', 'Shift', 'Status'],
                  filtered.map((emp) => [
                    emp.employeeCode,
                    emp.fullName,
                    emp.email,
                    emp.departmentName,
                    emp.designation,
                    emp.joiningDate,
                    emp.countryCode || 'IN',
                    `${emp.shiftStartTime || '09:30'}-${emp.shiftEndTime || '18:30'}`,
                    emp.status,
                  ]),
                  'Employees',
                )
              }
              className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium rounded-xl border border-[#292D36] bg-[#151922] text-[#A1A1AA] hover:text-[#FFFFFF]"
            >
              <Download className="w-3.5 h-3.5" />
              XLSX
            </button>
            <button
              type="button"
              onClick={openCreate}
              className="ace-btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-xl whitespace-nowrap"
            >
              <UserPlus className="w-4 h-4" />
              Add & Invite Employee
            </button>
          </div>
        )}
      </div>

      {/* Filters Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 bg-[#151922] border border-[#292D36] rounded-2xl p-4">
        <div className="sm:col-span-5 relative">
          <Search className="w-4 h-4 text-[#A1A1AA] absolute left-3 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search by name, ID, email, team, or designation..."
            className="w-full pl-9 pr-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-xs text-[#FFFFFF] placeholder-[#A1A1AA]/60 focus:outline-none focus:border-[#FF4634]"
          />
        </div>
        <div className="sm:col-span-3">
          <select
            value={deptFilter}
            onChange={(e) => {
              setDeptFilter(e.target.value);
              setPage(1);
            }}
            className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-xs text-[#FFFFFF]"
          >
            <option value="all" className="bg-[#151922]">All Departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id} className="bg-[#151922]">{d.name}</option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <select
            value={teamFilter}
            onChange={(e) => {
              setTeamFilter(e.target.value);
              setPage(1);
            }}
            className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-xs text-[#FFFFFF]"
          >
            <option value="all" className="bg-[#151922]">All Teams</option>
            {teamOptions.map((t) => (
              <option key={t.id} value={t.id} className="bg-[#151922]">{t.name}</option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-xs text-[#FFFFFF]"
          >
            <option value="all" className="bg-[#151922]">All Statuses</option>
            <option value="active" className="bg-[#151922]">Active</option>
            <option value="onboarding" className="bg-[#151922]">Onboarding</option>
            <option value="offboarding" className="bg-[#151922]">Offboarding</option>
            <option value="inactive" className="bg-[#151922]">Inactive</option>
          </select>
        </div>
      </div>

      {/* Employees Data Table */}
      <div className="bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden">
        {paged.length === 0 ? (
          <div className="p-10 text-center text-sm text-[#A1A1AA]">
            No matching employees found. {canManage && 'Use "Add & Invite Employee" to create your first team record.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                  <th className="px-4 py-3 text-left font-medium">Employee</th>
                  <th className="px-4 py-3 text-left font-medium">ID</th>
                  <th className="px-4 py-3 text-left font-medium">Department / Team</th>
                  <th className="px-4 py-3 text-left font-medium">Designation</th>
                  <th className="px-4 py-3 text-left font-medium">Joined</th>
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#292D36]/70">
                {paged.map((emp) => (
                  <tr key={emp.id} className="hover:bg-[#1B1F28]/60 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {emp.avatarUrl ? (
                          <img
                            src={emp.avatarUrl}
                            alt={emp.fullName}
                            referrerPolicy="no-referrer"
                            className="w-8 h-8 rounded-full object-cover border border-[#292D36]"
                          />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-[#FF4634]/15 border border-[#FF4634]/35 text-[#FF6A33] flex items-center justify-center font-semibold">
                            {emp.fullName.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div>
                          <div className="text-[#FFFFFF] font-medium">{emp.fullName}</div>
                          <div className="text-[#A1A1AA]">{emp.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-[#FFFFFF]/90 tabular-nums">{emp.employeeCode}</td>
                    <td className="px-4 py-3 text-[#FFFFFF]/90">
                      <div>{emp.departmentName}</div>
                      {(emp.teamName || emp.teamLeadName) && (
                        <div className="text-[11px] text-[#A1A1AA]">
                          {emp.teamName || 'Team'}{emp.teamLeadName ? ` · Lead: ${emp.teamLeadName}` : ''}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[#FFFFFF]/90">{emp.designation}</td>
                    <td className="px-4 py-3 font-mono text-[#A1A1AA] tabular-nums">{emp.joiningDate}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`capitalize font-medium ${
                          emp.status === 'active'
                            ? 'text-emerald-400'
                            : emp.status === 'inactive'
                            ? 'text-rose-400'
                            : 'text-amber-400'
                        }`}
                      >
                        {emp.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setViewingEmp(emp)}
                          className="p-1.5 text-[#A1A1AA] hover:text-[#FFFFFF] rounded-lg hover:bg-[#1B1F28]"
                          title="View profile"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        {canManage && (
                          <>
                            <button
                              type="button"
                              onClick={() => openEdit(emp)}
                              className="p-1.5 text-[#A1A1AA] hover:text-[#FF6A33] rounded-lg hover:bg-[#1B1F28]"
                              title="Edit employee"
                            >
                              <Edit3 className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleStatus(emp)}
                              className="p-1.5 text-[#A1A1AA] hover:text-amber-400 rounded-lg hover:bg-[#1B1F28]"
                              title={emp.status === 'inactive' ? 'Activate employee' : 'Deactivate employee'}
                            >
                              <Power className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-[#292D36] flex items-center justify-between text-xs text-[#A1A1AA]">
            <span>
              Page {page} of {totalPages} ({filtered.length} records)
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
                className="px-3 py-1 border border-[#292D36] bg-[#1B1F28] rounded-lg disabled:opacity-40 hover:text-[#FFFFFF]"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={page === totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1 border border-[#292D36] bg-[#1B1F28] rounded-lg disabled:opacity-40 hover:text-[#FFFFFF]"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* View Employee Profile Drawer */}
      {viewingEmp && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="fixed inset-0 bg-black/70" onClick={() => setViewingEmp(null)} />
          <div className="relative z-10 w-full max-w-lg bg-[#151922] border-l border-[#292D36] h-full overflow-y-auto p-6 space-y-6">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-display text-xl font-bold text-[#FFFFFF]">{viewingEmp.fullName}</h2>
                <p className="text-xs text-[#A1A1AA] mt-1">
                  {viewingEmp.employeeCode} · {viewingEmp.designation} · {viewingEmp.departmentName}
                </p>
              </div>
              <button type="button" onClick={() => setViewingEmp(null)} className="p-1.5 text-[#A1A1AA] hover:text-[#FFFFFF]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs bg-[#1B1F28] border border-[#292D36] rounded-2xl p-4">
              <h3 className="font-semibold text-[#FFFFFF]">Employment & Contact Details</h3>
              <div className="grid grid-cols-2 gap-y-2.5 gap-x-4">
                <div><span className="text-[#A1A1AA] block">Email</span><span className="text-[#FFFFFF]">{viewingEmp.email}</span></div>
                <div><span className="text-[#A1A1AA] block">Phone</span><span className="text-[#FFFFFF]">{viewingEmp.phone || '-'}</span></div>
                <div><span className="text-[#A1A1AA] block">Employment Type</span><span className="text-[#FFFFFF] capitalize">{viewingEmp.employmentType.replace('_', ' ')}</span></div>
                <div><span className="text-[#A1A1AA] block">Joining Date</span><span className="text-[#FFFFFF] font-mono">{viewingEmp.joiningDate}</span></div>
                <div><span className="text-[#A1A1AA] block">Probation</span><span className="text-[#FFFFFF]">{viewingEmp.probationEndDate || 'Not set'} · {(viewingEmp.probationStatus || 'in_probation').replace('_',' ')}</span></div>
                <div><span className="text-[#A1A1AA] block">Reporting Manager</span><span className="text-[#FFFFFF]">{viewingEmp.reportingManagerName || '-'}</span></div>
                <div><span className="text-[#A1A1AA] block">Assigned Team</span><span className="text-[#FFFFFF]">{viewingEmp.teamName || '-'}</span></div>
                <div><span className="text-[#A1A1AA] block">Team Lead</span><span className="text-[#FFFFFF]">{viewingEmp.teamLeadName || '-'}</span></div>
                <div><span className="text-[#A1A1AA] block">Status</span><span className="text-[#FFFFFF] capitalize">{viewingEmp.status}</span></div>
                <div className="col-span-2"><span className="text-[#A1A1AA] block">Address</span><span className="text-[#FFFFFF]">{viewingEmp.address || '-'}</span></div>
                <div className="col-span-2">
                  <span className="text-[#A1A1AA] block">Emergency Contact</span>
                  <span className="text-[#FFFFFF]">
                    {viewingEmp.emergencyContactName ? `${viewingEmp.emergencyContactName} (${viewingEmp.emergencyContactRelation || 'Contact'}) · ${viewingEmp.emergencyContactPhone}` : '-'}
                  </span>
                </div>
              </div>
            </div>

            {/* Private Salary Section (Only visible to Super Admin / HR / Self) */}
            {canManage || viewingEmp.uid === firebaseUser?.uid ? (
              <div className="space-y-3 text-xs bg-[#1B1F28] border border-[#292D36] rounded-2xl p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-semibold text-[#FFFFFF]">
                    <Wallet className="w-4 h-4 text-[#FF6A33]" />
                    <span>Private Salary Structure</span>
                  </div>
                  <span className="text-[#A1A1AA]">Restricted Access</span>
                </div>
                {!viewingSalary ? (
                  <p className="text-[#A1A1AA]">No salary structure configured yet.</p>
                ) : (
                  <div className="grid grid-cols-2 gap-2.5 tabular-nums">
                    <div><span className="text-[#A1A1AA] block">Basic Salary</span><span className="font-mono text-[#FFFFFF]">{formatCurrency(viewingSalary.basicSalary, viewingSalary.currency)}</span></div>
                    <div><span className="text-[#A1A1AA] block">HRA Allowance</span><span className="font-mono text-[#FFFFFF]">{formatCurrency(viewingSalary.hraAllowance, viewingSalary.currency)}</span></div>
                    <div><span className="text-[#A1A1AA] block">Transport</span><span className="font-mono text-[#FFFFFF]">{formatCurrency(viewingSalary.transportAllowance, viewingSalary.currency)}</span></div>
                    <div><span className="text-[#A1A1AA] block">Special Allowance</span><span className="font-mono text-[#FFFFFF]">{formatCurrency(viewingSalary.specialAllowance, viewingSalary.currency)}</span></div>
                    <div><span className="text-[#A1A1AA] block">Bonus & Incentives</span><span className="font-mono text-[#FFFFFF]">{formatCurrency(viewingSalary.bonus + viewingSalary.incentives, viewingSalary.currency)}</span></div>
                    <div><span className="text-[#A1A1AA] block">Deductions</span><span className="font-mono text-rose-400">- {formatCurrency(viewingSalary.deductions, viewingSalary.currency)}</span></div>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-4 rounded-2xl bg-[#1B1F28] border border-[#292D36] text-xs text-[#A1A1AA] flex items-center gap-2">
                <Shield className="w-4 h-4 text-[#A1A1AA]" />
                <span>Salary records are restricted to HR Administration and the employee.</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create / Edit Employee Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setShowModal(false)} />
          <div className="relative z-10 w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-[#151922] border border-[#292D36] rounded-2xl p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-display text-lg font-bold text-[#FFFFFF]">
                {editingEmp ? `Edit Employee · ${editingEmp.employeeCode}` : 'Add & Invite New Employee'}
              </h2>
              <button type="button" onClick={() => setShowModal(false)} className="text-[#A1A1AA] hover:text-[#FFFFFF]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveEmployee} className="space-y-5 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Employee ID</label>
                  <input
                    type="text"
                    required
                    disabled={Boolean(editingEmp)}
                    value={employeeCode}
                    onChange={(e) => setEmployeeCode(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono disabled:opacity-60 focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Full Name</label>
                  <input
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Work Email</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Department</label>
                  <select
                    value={departmentId}
                    onChange={(e) => setDepartmentId(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] focus:outline-none focus:border-[#FF4634]"
                  >
                    {departments.map((d) => (
                      <option key={d.id} value={d.id} className="bg-[#151922]">{d.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Designation</label>
                  <input
                    type="text"
                    required
                    value={designation}
                    onChange={(e) => setDesignation(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Employee Country Code</label>
                  <input value={countryCode} maxLength={3} onChange={(e) => setCountryCode(e.target.value.toUpperCase())} placeholder="IN" className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]" />
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Employee Shift Start</label>
                  <input type="time" value={shiftStartTime} onChange={(e) => setShiftStartTime(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]" />
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Employee Shift End</label>
                  <input type="time" value={shiftEndTime} onChange={(e) => setShiftEndTime(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]" />
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Probation End Date</label>
                  <input type="date" value={probationEndDate} onChange={(e) => setProbationEndDate(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] focus:outline-none focus:border-[#FF4634]" />
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Probation Status</label>
                  <select value={probationStatus || 'in_probation'} onChange={(e) => setProbationStatus(e.target.value as EmployeeProfile['probationStatus'])} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]">
                    <option value="in_probation">In Probation</option><option value="confirmed">Confirmed</option><option value="extended">Extended</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Employment Type</label>
                  <select
                    value={employmentType}
                    onChange={(e) => setEmploymentType(e.target.value as EmploymentType)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] focus:outline-none focus:border-[#FF4634]"
                  >
                    <option value="full_time" className="bg-[#151922]">Full Time</option>
                    <option value="part_time" className="bg-[#151922]">Part Time</option>
                    <option value="contract" className="bg-[#151922]">Contract</option>
                    <option value="intern" className="bg-[#151922]">Intern</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Joining Date</label>
                  <input
                    type="date"
                    required
                    value={joiningDate}
                    onChange={(e) => setJoiningDate(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Birth Date</label>
                  <input
                    type="date"
                    value={birthDate}
                    onChange={(e) => setBirthDate(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Phone</label>
                  <input
                    type="text"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Reporting Manager</label>
                  <select
                    value={reportingManagerUid}
                    onChange={(e) => {
                      const manager = employees.find((item) => item.uid === e.target.value);
                      setReportingManagerUid(e.target.value);
                      setReportingManagerName(manager?.fullName || '');
                    }}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] focus:outline-none focus:border-[#FF4634]"
                  >
                    <option value="">No reporting manager</option>
                    {employees.filter((item) => item.uid && item.uid !== editingEmp?.uid).map((item) => <option key={item.id} value={item.uid}>{item.fullName} · {item.designation}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Team Name</label>
                  <input
                    type="text"
                    value={teamName}
                    onChange={(e) => {
                      setTeamName(e.target.value);
                      if (!e.target.value.trim()) setTeamId('');
                    }}
                    placeholder="e.g. Frontend Core"
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Team Leader (Leave Approver)</label>
                  <select
                    value={teamLeadUid}
                    onChange={(e) => {
                      const lead = employees.find((item) => item.uid === e.target.value);
                      setTeamLeadUid(e.target.value);
                      setTeamLeadName(lead?.fullName || '');
                    }}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] focus:outline-none focus:border-[#FF4634]"
                  >
                    <option value="">No assigned team lead</option>
                    {employees.filter((item) => item.uid && item.uid !== editingEmp?.uid).map((item) => (
                      <option key={item.id} value={item.uid}>{item.fullName} · {item.designation}</option>
                    ))}
                  </select>
                </div>
                {!editingEmp && (
                  <div>
                    <label className="block text-[#A1A1AA] mb-1">Invited System Role</label>
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as Exclude<UserRole, 'super_admin'>)}
                      className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] focus:outline-none focus:border-[#FF4634]"
                    >
                      <option value="employee" className="bg-[#151922]">Employee</option>
                      <option value="team_lead" className="bg-[#151922]">Team Lead</option>
                      <option value="dept_manager" className="bg-[#151922]">Department Manager</option>
                      <option value="hr_manager" className="bg-[#151922]">HR Manager</option>
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Profile Picture</label>
                  <label className="flex items-center justify-center gap-1.5 px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#A1A1AA] cursor-pointer hover:border-[#FF4634] hover:text-[#FFFFFF]">
                    <Upload className="w-3.5 h-3.5" />
                    <span>{avatarUploading ? 'Uploading...' : avatarUrl ? 'Uploaded' : 'Upload Photo'}</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => e.target.files?.[0] && handleAvatarUpload(e.target.files[0])}
                    />
                  </label>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-3">
                  <label className="block text-[#A1A1AA] mb-1">Residential Address</label>
                  <input
                    type="text"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Emergency Contact</label>
                  <input
                    type="text"
                    value={emergencyContactName}
                    onChange={(e) => setEmergencyContactName(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Emergency Phone</label>
                  <input
                    type="text"
                    value={emergencyContactPhone}
                    onChange={(e) => setEmergencyContactPhone(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Relationship</label>
                  <input
                    type="text"
                    value={emergencyContactRelation}
                    onChange={(e) => setEmergencyContactRelation(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
              </div>

              {/* Salary Structure */}
              <div className="pt-3 border-t border-[#292D36]">
                <h3 className="font-semibold text-[#FFFFFF] mb-3">
                  Private Salary Structure ({payrollConfig.currency})
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: 'Basic Salary', val: basicSalary, set: setBasicSalary },
                    { label: 'HRA Allowance', val: hraAllowance, set: setHraAllowance },
                    { label: 'Transport Allowance', val: transportAllowance, set: setTransportAllowance },
                    { label: 'Special Allowance', val: specialAllowance, set: setSpecialAllowance },
                    { label: 'Bonus', val: bonus, set: setBonus },
                    { label: 'Incentives', val: incentives, set: setIncentives },
                    { label: 'Fixed Deductions', val: deductions, set: setDeductions },
                    { label: 'Overtime Rate / hr', val: overtimeHourlyRate, set: setOvertimeHourlyRate },
                  ].map((f) => (
                    <div key={f.label}>
                      <label className="block text-[#A1A1AA] mb-1">{f.label}</label>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={f.val}
                        onChange={(e) => f.set(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono focus:outline-none focus:border-[#FF4634]"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {statusMsg && <div className="text-rose-400 text-xs">{statusMsg}</div>}

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#292D36]">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 border border-[#292D36] bg-[#1B1F28] text-[#A1A1AA] hover:text-[#FFFFFF] rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="ace-btn-primary inline-flex items-center gap-2 px-5 py-2 font-semibold rounded-xl"
                >
                  {!editingEmp && <Mail className="w-3.5 h-3.5" />}
                  {saving ? 'Saving...' : editingEmp ? 'Save Employee' : 'Create & Issue Invitation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
