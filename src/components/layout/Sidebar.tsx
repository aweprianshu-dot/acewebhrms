import React from 'react';
import {
  LayoutDashboard,
  UserCheck,
  Users,
  Clock,
  ListTodo,
  CalendarOff,
  Wallet,
  Briefcase,
  ClipboardCheck,
  UserMinus,
  Award,
  Target,
  Megaphone,
  Bell,
  BarChart3,
  Settings,
  CalendarDays,
  Workflow,
  Camera,
  Network,
  X,
} from 'lucide-react';
import { AceBrandMark } from '../common/AceBrandMark';
import type { ActiveTab, UserRole } from '../../types/hrms';

type NavSection =
  | 'MAIN'
  | 'PEOPLE'
  | 'OPERATIONS'
  | 'PERFORMANCE'
  | 'COMMUNICATION'
  | 'REPORTS AND SETTINGS'
  | 'WORK'
  | 'ADVANCED'
  | 'MONITORING'
  | 'PEOPLE_INSIGHTS';

interface NavItem {
  id: ActiveTab;
  label: string;
  section: NavSection;
  icon: React.ComponentType<{ className?: string }>;
  roles: UserRole[];
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'HR Dashboard', section: 'MAIN', icon: LayoutDashboard, roles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead'] },
  { id: 'self_service', label: 'My Portal', section: 'MAIN', icon: UserCheck, roles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead', 'employee'] },

  { id: 'employees', label: 'Employees', section: 'PEOPLE', icon: Users, roles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead'] },
  { id: 'attendance', label: 'Attendance', section: 'PEOPLE', icon: Clock, roles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead', 'employee'] },
  { id: 'work_hub', label: 'Work Hub', section: 'WORK', icon: CalendarDays, roles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead', 'employee'] },
  { id: 'advanced_operations', label: 'Advanced Operations', section: 'ADVANCED', icon: Workflow, roles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead', 'employee'] },
  { id: 'monitoring', label: 'Screen Monitoring', section: 'MONITORING', icon: Camera, roles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead'] },
  { id: 'org_chart', label: 'Organization Chart', section: 'PEOPLE_INSIGHTS', icon: Network, roles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead'] },
  { id: 'tasks', label: 'Task Management', section: 'PEOPLE', icon: ListTodo, roles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead', 'employee'] },
  { id: 'leave', label: 'Leave Management', section: 'PEOPLE', icon: CalendarOff, roles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead', 'employee'] },

  { id: 'payroll', label: 'Payroll', section: 'OPERATIONS', icon: Wallet, roles: ['super_admin', 'hr_manager'] },
  { id: 'recruitment', label: 'Recruitment', section: 'OPERATIONS', icon: Briefcase, roles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead'] },
  { id: 'onboarding', label: 'Onboarding', section: 'OPERATIONS', icon: ClipboardCheck, roles: ['super_admin', 'hr_manager', 'employee'] },
  { id: 'offboarding', label: 'Offboarding', section: 'OPERATIONS', icon: UserMinus, roles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead', 'employee'] },

  { id: 'performance', label: 'Performance', section: 'PERFORMANCE', icon: Award, roles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead', 'employee'] },
  { id: 'goals', label: 'Goals and OKRs', section: 'PERFORMANCE', icon: Target, roles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead', 'employee'] },

  { id: 'announcements', label: 'Announcements', section: 'COMMUNICATION', icon: Megaphone, roles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead', 'employee'] },
  { id: 'notifications', label: 'Notifications', section: 'COMMUNICATION', icon: Bell, roles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead', 'employee'] },

  { id: 'reports', label: 'Reports', section: 'REPORTS AND SETTINGS', icon: BarChart3, roles: ['super_admin', 'hr_manager', 'dept_manager', 'team_lead'] },
  { id: 'settings', label: 'HR Settings', section: 'REPORTS AND SETTINGS', icon: Settings, roles: ['super_admin', 'hr_manager'] },
];

const SECTIONS: NavSection[] = [
  'MAIN',
  'PEOPLE',
  'WORK',
  'ADVANCED',
  'MONITORING',
  'PEOPLE_INSIGHTS',
  'OPERATIONS',
  'PERFORMANCE',
  'COMMUNICATION',
  'REPORTS AND SETTINGS',
];

interface SidebarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  role: UserRole;
  companyName: string;
  domain?: string;
  unreadNotifications?: number;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onSelectTab,
  role,
  companyName,
  domain,
  unreadNotifications = 0,
  mobileOpen,
  onCloseMobile,
}) => {
  const visibleItems = NAV_ITEMS.filter((item) => item.roles.includes(role));

  const content = (
    <div className="flex flex-col h-full bg-[#151922] border-r border-[#292D36] w-64 select-none">
      <div className="h-16 px-4 flex items-center justify-between border-b border-[#292D36] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <AceBrandMark size={26} showWordmark showSubtitle subtitleText="HRMS" />
        </div>
        <button
          type="button"
          onClick={onCloseMobile}
          className="lg:hidden p-1.5 text-[#A1A1AA] hover:text-[#FFFFFF] rounded-lg hover:bg-[#1B1F28] transition-colors"
          aria-label="Close navigation"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5" aria-label="Main navigation">
        {SECTIONS.map((section) => {
          const sectionItems = visibleItems.filter((item) => item.section === section);
          if (sectionItems.length === 0) return null;
          return (
            <div key={section}>
              <div className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-wider text-[#A1A1AA]/70">
                {section}
              </div>
              <div className="space-y-1">
                {sectionItems.map((item) => {
                  const Icon = item.icon;
                  const active = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        onSelectTab(item.id);
                        onCloseMobile();
                      }}
                      className={`w-full flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-all whitespace-nowrap ${
                        active
                          ? 'ace-on-accent bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-[#FFFFFF] shadow-md shadow-[#FF4634]/25'
                          : 'text-[#A1A1AA] hover:text-[#FFFFFF] hover:bg-[#1B1F28]'
                      }`}
                    >
                      <span className="flex items-center gap-3 min-w-0">
                        <Icon
                          className={`w-4 h-4 shrink-0 transition-colors ${
                            active ? 'text-[#FFFFFF]' : 'text-[#A1A1AA]'
                          }`}
                        />
                        <span className="truncate">{item.label}</span>
                      </span>
                      {item.id === 'notifications' && unreadNotifications > 0 && (
                        <span
                          className={`px-1.5 py-0.5 rounded-md text-[10px] font-mono font-semibold tabular-nums ${
                            active
                              ? 'bg-[#FFFFFF]/20 text-[#FFFFFF]'
                              : 'bg-[#FF4634]/20 text-[#FF6A33]'
                          }`}
                        >
                          {unreadNotifications > 99 ? '99+' : unreadNotifications}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="p-4 border-t border-[#292D36] bg-[#0B0D12]/60 text-xs">
        <div className="font-medium text-[#FFFFFF] truncate">{companyName || 'ACE Web Experts'}</div>
        <div className="text-[#A1A1AA] truncate mt-0.5">
          {domain || (typeof window !== 'undefined' ? window.location.host : 'ACE HRMS')}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block shrink-0">{content}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-black/75 backdrop-blur-xs" onClick={onCloseMobile} />
          <div className="relative z-10 h-full">{content}</div>
        </div>
      )}
    </>
  );
};
