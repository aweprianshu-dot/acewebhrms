import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, LogOut, Menu, Search, Users, X, Sun, Moon, ArrowLeftRight } from 'lucide-react';
import type { ActiveTab, DirectoryEntry, UserRole } from '../../types/hrms';
import { AceBrandMark } from '../common/AceBrandMark';
import { useThemeMode } from '../../utils/themeUtils';

const TAB_TITLES: Record<ActiveTab, string> = {
  dashboard: 'HR Analytics Dashboard',
  self_service: 'My Portal',
  employees: 'Employees',
  attendance: 'Attendance & Time Tracking',
  tasks: 'Task Management',
  leave: 'Leave Management',
  payroll: 'Payroll & Compensation',
  recruitment: 'Recruitment & Hiring Pipeline',
  onboarding: 'Employee Onboarding',
  offboarding: 'Offboarding & Exit Clearance',
  performance: 'Performance Management',
  goals: 'Goals and OKRs',
  announcements: 'Company Announcements',
  notifications: 'Notifications Center',
  reports: 'HR Reports & Analytics',
  settings: 'HR Settings',
  work_hub: 'Work Hub',
  advanced_operations: 'Advanced Operations',
  monitoring: 'Screen Monitoring',
  org_chart: 'Organization Chart',
};

const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: 'Super Admin',
  hr_manager: 'HR Manager',
  dept_manager: 'Manager',
  team_lead: 'Team Lead',
  employee: 'Employee',
};

interface TopBarProps {
  activeTab: ActiveTab;
  userName: string;
  userEmail: string;
  role: UserRole;
  unreadCount: number;
  directory: DirectoryEntry[];
  onSelectEmployee: (entry: DirectoryEntry) => void;
  onOpenNotifications: () => void;
  onOpenMobileMenu: () => void;
  onLogout: () => void;
  onSwitchView: () => void;
  employeeView: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  userName,
  userEmail,
  role,
  unreadCount,
  directory,
  onSelectEmployee,
  onOpenNotifications,
  onOpenMobileMenu,
  onLogout,
  onSwitchView,
  employeeView,
}) => {
  const { isLight, toggleTheme } = useThemeMode();
  const displayRole: UserRole = employeeView ? 'employee' : role;
  const canSearch = !employeeView && role !== 'employee';
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return directory
      .filter(
        (d) =>
          d.fullName.toLowerCase().includes(q) ||
          d.employeeCode.toLowerCase().includes(q) ||
          d.departmentName.toLowerCase().includes(q) ||
          d.designation.toLowerCase().includes(q)
      )
      .slice(0, 7);
  }, [directory, searchQuery]);

  const initials =
    userName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || '')
      .join('') || 'AE';

  return (
    <header className="h-16 bg-[#151922]/95 backdrop-blur border-b border-[#292D36] px-4 sm:px-6 flex items-center justify-between gap-3 shrink-0 sticky top-0 z-30">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          className="lg:hidden p-2 text-[#A1A1AA] hover:text-[#FFFFFF] rounded-xl border border-[#292D36] bg-[#1B1F28] transition-colors"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-[#A1A1AA]">
            <span className="hidden sm:flex items-center">
              <AceBrandMark size={20} showWordmark={false} />
            </span>
            <span aria-hidden="true" className="text-[#292D36] hidden sm:inline">/</span>
            <span className="text-[#FFFFFF] font-semibold truncate">{TAB_TITLES[activeTab]}</span>
          </div>
        </div>
      </div>

      {/* Employee directory search is only available to management roles */}
      {canSearch && (
        <div ref={searchBoxRef} className="relative flex-1 max-w-sm hidden md:block">
          <Search className="w-3.5 h-3.5 text-[#A1A1AA] absolute left-3 top-2.5 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onFocus={() => setSearchOpen(true)}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchOpen(true);
            }}
            placeholder={
              role === 'dept_manager' || role === 'team_lead' ? 'Search your team…' : 'Search employees…'
            }
            aria-label="Global employee search"
            className="w-full pl-9 pr-8 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] rounded-xl text-xs text-[#FFFFFF] placeholder-[#A1A1AA]/70 focus:outline-none transition-colors"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-2 text-[#A1A1AA] hover:text-[#FFFFFF]"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}

          {searchOpen && searchQuery.trim().length > 0 && (
            <div className="absolute left-0 right-0 mt-2 bg-[#151922] border border-[#292D36] rounded-xl shadow-2xl shadow-black/70 overflow-hidden z-50">
              {searchResults.length === 0 ? (
                <div className="p-4 text-center text-xs text-[#A1A1AA]">
                  No team members matching &ldquo;{searchQuery.trim()}&rdquo;.
                </div>
              ) : (
                <div className="divide-y divide-[#292D36]/80 max-h-72 overflow-y-auto">
                  {searchResults.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => {
                        onSelectEmployee(entry);
                        setSearchOpen(false);
                        setSearchQuery('');
                      }}
                      className="w-full flex items-center justify-between gap-3 px-3.5 py-2.5 text-left hover:bg-[#1B1F28] transition-colors"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-7 h-7 rounded-lg bg-[#FF4634]/15 border border-[#FF4634]/30 text-[#FF6A33] flex items-center justify-center text-xs font-semibold shrink-0">
                          {entry.fullName.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-[#FFFFFF] truncate">{entry.fullName}</div>
                          <div className="text-[11px] text-[#A1A1AA] truncate">
                            {entry.designation} · {entry.departmentName}
                          </div>
                        </div>
                      </div>
                      <span className="font-mono text-[11px] text-[#A1A1AA] shrink-0">
                        {entry.employeeCode}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="px-3.5 py-2 bg-[#0B0D12]/80 border-t border-[#292D36] flex items-center justify-between text-[11px] text-[#A1A1AA]">
                <span className="inline-flex items-center gap-1">
                  <Users className="w-3 h-3 text-[#FF6A33]" />
                  {directory.length} directory records
                </span>
                <span>Select to open</span>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={isLight ? 'Switch to dark theme' : 'Switch to light theme'}
          title={isLight ? 'Switch to Dark Theme' : 'Switch to Light Theme'}
          className="p-2.5 rounded-xl border border-[#292D36] bg-[#1B1F28] text-[#A1A1AA] hover:text-white transition-colors"
        >
          {isLight ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
        </button>
        {role !== 'employee' && (
          <button
            type="button"
            onClick={onSwitchView}
            className="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#292D36] bg-[#1B1F28] text-xs text-[#D4D4D8] hover:text-white transition-colors"
          >
            <ArrowLeftRight className="w-3.5 h-3.5" />
            {employeeView ? 'Management View' : 'Employee View'}
          </button>
        )}
        <button
          type="button"
          onClick={onOpenNotifications}
          className="relative p-2.5 rounded-xl border border-[#292D36] bg-[#1B1F28] hover:border-[#FF4634]/50 text-[#A1A1AA] hover:text-[#FFFFFF] transition-colors"
          aria-label="Notifications"
        >
          <Bell className="w-4 h-4" />
          {unreadCount > 0 && (
            <span className="ace-on-accent absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-[#FFFFFF] text-[10px] font-semibold flex items-center justify-center tabular-nums shadow-sm shadow-[#FF4634]/40">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>

        <div className="hidden sm:flex items-center gap-3 pl-3 border-l border-[#292D36]">
          <div className="w-8 h-8 rounded-xl bg-[#1B1F28] border border-[#292D36] flex items-center justify-center text-xs font-semibold text-[#FF6A33] shrink-0">
            {initials}
          </div>
          <div className="text-right leading-tight">
            <div className="text-xs font-semibold text-[#FFFFFF] whitespace-nowrap">{userName}</div>
            <div className="text-[11px] text-[#A1A1AA] whitespace-nowrap">
              {ROLE_LABELS[displayRole]} · {userEmail}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onLogout}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#292D36] bg-[#1B1F28] hover:border-[#FF4634]/50 text-xs font-medium text-[#A1A1AA] hover:text-[#FFFFFF] transition-colors whitespace-nowrap shrink-0"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Sign Out</span>
        </button>
      </div>
    </header>
  );
};
