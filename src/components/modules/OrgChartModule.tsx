import React, { useMemo } from 'react';
import { Network, UserRound } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import type { EmployeeProfile } from '../../types/hrms';
import { getOrgNodeKey, partitionOrgChartHierarchy } from '../../utils/orgChartUtils';

export const OrgChartModule: React.FC = () => {
  const { effectiveRole } = useAuth();
  const { employees } = useHrmsData();
  const allowed = ['super_admin', 'hr_manager', 'dept_manager', 'team_lead'].includes(effectiveRole || 'employee');
  const { children, roots, orphaned } = useMemo(
    () => partitionOrgChartHierarchy(employees),
    [employees],
  );

  const renderNode = (employee: EmployeeProfile, depth: number, visited: Set<string>): React.ReactNode => {
    const key = getOrgNodeKey(employee);
    if (visited.has(key)) {
      return (
        <div key={`${key}-cycle`} className="text-xs text-amber-400">
          Reporting cycle detected for {employee.fullName}
        </div>
      );
    }
    const next = new Set(visited);
    next.add(key);
    const reports = employee.uid ? children.get(employee.uid) || [] : [];
    return (
      <div key={key} className="flex flex-col items-center">
        <div
          className={`w-full max-w-[280px] rounded-xl border ${
            depth === 0 ? 'border-[#FF6A33]/60 bg-[#1B1F28]' : 'border-[#343A46] bg-[#151922]'
          } p-3 text-center`}
        >
          <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-[#FF4634]/15 text-[#FF6A33]">
            <UserRound size={18} />
          </div>
          <div className="text-sm font-semibold text-[#FFFFFF]">{employee.fullName}</div>
          <div className="text-xs text-[#A1A1AA] mt-1">{employee.designation}</div>
          <div className="text-[11px] text-[#A1A1AA] mt-1">{employee.departmentName}</div>
        </div>
        {reports.length > 0 && (
          <div className="mt-3 flex flex-wrap justify-center gap-4 border-t border-[#343A46] pt-3 w-full">
            {reports.map((child) => renderNode(child, depth + 1, next))}
          </div>
        )}
      </div>
    );
  };

  if (!allowed) {
    return (
      <div className="rounded-xl border border-[#343A46] bg-[#151922] p-5 text-sm text-[#A1A1AA]">
        The organization chart is available to Team Leads, Managers, HR, and Super Admin.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs uppercase tracking-widest text-[#FF8B5B] font-semibold">People directory</p>
        <h1 className="font-display text-2xl font-bold text-[#FFFFFF] mt-1 flex items-center gap-2">
          <Network size={22} className="text-[#FF6A33]" /> Organization Chart
        </h1>
        <p className="text-sm text-[#A1A1AA] mt-1">Reporting relationships are taken from employee profiles.</p>
      </div>
      {employees.length === 0 ? (
        <p className="text-sm text-[#A1A1AA]">No employees are available in your permitted scope.</p>
      ) : (
        <div className="rounded-2xl border border-[#343A46] bg-[#151922] p-5 overflow-x-auto">
          <div className="min-w-max flex flex-wrap justify-center gap-8">
            {roots.map((root) => renderNode(root, 0, new Set()))}
            {orphaned.map((employee) => renderNode(employee, 0, new Set()))}
          </div>
        </div>
      )}
    </div>
  );
};

