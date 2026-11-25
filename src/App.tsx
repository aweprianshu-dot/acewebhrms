import React, { useEffect, useRef, useState } from 'react';
import { X, Bell } from 'lucide-react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { HrmsDataProvider, useHrmsData } from './contexts/HrmsDataContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { BrandSplash } from './components/common/BrandSplash';
import { AuthPortal } from './components/auth/AuthPortal';
import { Sidebar } from './components/layout/Sidebar';
import { TopBar } from './components/layout/TopBar';
import { NotificationsPanel } from './components/modules/NotificationsPanel';
import { DashboardModule } from './components/modules/DashboardModule';
import { SelfServiceModule } from './components/modules/SelfServiceModule';
import { EmployeesModule } from './components/modules/EmployeesModule';
import { AttendanceModule } from './components/modules/AttendanceModule';
import { TasksModule } from './components/modules/TasksModule';
import { LeaveModule } from './components/modules/LeaveModule';
import { PayrollModule } from './components/modules/PayrollModule';
import { RecruitmentModule } from './components/modules/RecruitmentModule';
import { OnboardingModule } from './components/modules/OnboardingModule';
import { OffboardingModule } from './components/modules/OffboardingModule';
import { PerformanceModule } from './components/modules/PerformanceModule';
import { AnnouncementsModule } from './components/modules/AnnouncementsModule';
import { ReportsModule } from './components/modules/ReportsModule';
import { SettingsModule } from './components/modules/SettingsModule';
import { WorkHubModule } from './components/modules/WorkHubModule';
import { AdvancedOperationsModule } from './components/modules/AdvancedOperationsModule';
import { MonitoringModule } from './components/modules/MonitoringModule';
import { OrgChartModule } from './components/modules/OrgChartModule';
import type { ActiveTab, DirectoryEntry, NotificationItem } from './types/hrms';

const WorkspaceShell: React.FC = () => {
  const {
    firebaseUser,
    employeeProfile,
    effectiveRole,
    loading,
    needsEmailVerification,
    needsInitialSetup,
    isPendingApproval,
    isDeactivated,
    logout,
  } = useAuth();
  const { directory, notifications, notificationPref, companySettings, dataLoading } = useHrmsData();

  const [splashDone, setSplashDone] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>(
    effectiveRole === 'employee' ? 'self_service' : 'dashboard'
  );
  const [selectedEmpId, setSelectedEmpId] = useState<string | null>(null);
  const [employeeView, setEmployeeView] = useState(effectiveRole === 'employee');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [toast, setToast] = useState<NotificationItem | null>(null);
  const seenNotifIds = useRef<Set<string>>(new Set());
  const seededNotifs = useRef(false);

  // Branded opening splash timer (~900ms minimum so logo & animated indicator render smoothly)
  useEffect(() => {
    const timer = setTimeout(() => setSplashDone(true), 900);
    return () => clearTimeout(timer);
  }, []);

  // Security: end an authenticated session after 30 minutes without user activity.
  useEffect(() => {
    if (!firebaseUser) return;
    let timer: ReturnType<typeof setTimeout>;
    const resetIdleTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { void logout(); }, 30 * 60 * 1000);
    };
    const events: (keyof WindowEventMap)[] = ['pointerdown','keydown','mousemove','touchstart','scroll'];
    events.forEach((eventName) => window.addEventListener(eventName, resetIdleTimer, { passive: true }));
    resetIdleTimer();
    return () => {
      clearTimeout(timer);
      events.forEach((eventName) => window.removeEventListener(eventName, resetIdleTimer));
    };
  }, [firebaseUser, logout]);

  // Adjust default landing tab when role resolves
  useEffect(() => {
    if (effectiveRole === 'employee') { setEmployeeView(true); setActiveTab('self_service'); }
  }, [effectiveRole]);

  // Real-time popup notification toast for newly arrived unread items
  useEffect(() => {
    if (dataLoading) return;
    if (!seededNotifs.current) {
      notifications.forEach((n) => seenNotifIds.current.add(n.id));
      seededNotifs.current = true;
      return;
    }
    const fresh = notifications.find((n) => !n.read && !seenNotifIds.current.has(n.id));
    notifications.forEach((n) => seenNotifIds.current.add(n.id));
    if (fresh && (notificationPref?.pushEnabled ?? true)) {
      setToast(fresh);
      const timer = setTimeout(() => setToast(null), 6500);
      return () => clearTimeout(timer);
    }
  }, [notifications, dataLoading, notificationPref?.pushEnabled]);

  if (loading || !splashDone) {
    return <BrandSplash message="Loading ACE Web Experts HRMS..." />;
  }

  if (
    !firebaseUser ||
    needsEmailVerification ||
    needsInitialSetup ||
    isPendingApproval ||
    isDeactivated
  ) {
    return <AuthPortal />;
  }

  const unreadCount = notifications.filter((n) => !n.read).length;
  const userName = employeeProfile?.fullName || firebaseUser.displayName || 'Team Member';

  const handleGlobalEmployeeSelect = (entry: DirectoryEntry) => {
    if (effectiveRole === 'employee') {
      setActiveTab('self_service');
      return;
    }
    setSelectedEmpId(entry.id);
    setActiveTab('employees');
  };

  const renderModule = () => {
    const viewRole = employeeView ? 'employee' : effectiveRole;
    switch (activeTab) {
      case 'dashboard':
        return viewRole === 'employee' ? (
          <SelfServiceModule onNavigate={setActiveTab} />
        ) : (
          <DashboardModule onNavigate={setActiveTab} />
        );
      case 'self_service':
        return <SelfServiceModule onNavigate={setActiveTab} />;
      case 'employees':
        return viewRole === 'employee' ? (
          <SelfServiceModule onNavigate={setActiveTab} />
        ) : (
          <EmployeesModule
            initialSelectedEmployeeId={selectedEmpId}
            onClearSelectedEmployee={() => setSelectedEmpId(null)}
          />
        );
      case 'attendance':
        return <AttendanceModule />;
      case 'tasks':
        return <TasksModule />;
      case 'leave':
        return <LeaveModule />;
      case 'payroll':
        return viewRole === 'super_admin' || viewRole === 'hr_manager' ? (
          <PayrollModule />
        ) : (
          <SelfServiceModule onNavigate={setActiveTab} />
        );
      case 'recruitment':
        return <RecruitmentModule />;
      case 'onboarding':
        return <OnboardingModule />;
      case 'offboarding':
        return <OffboardingModule />;
      case 'performance':
        return <PerformanceModule initialSubTab="reviews" />;
      case 'goals':
        return <PerformanceModule initialSubTab="goals" />;
      case 'announcements':
        return <AnnouncementsModule />;
      case 'notifications':
        return (
          <NotificationsPanel
            open
            mode="page"
            onClose={() => {}}
            onNavigateTab={setActiveTab}
          />
        );
      case 'reports':
        return viewRole === 'employee' ? <SelfServiceModule onNavigate={setActiveTab} /> : <ReportsModule />;
      case 'work_hub':
        return <WorkHubModule />;
      case 'advanced_operations':
        return <AdvancedOperationsModule />;
      case 'monitoring':
        return viewRole === 'employee' ? <SelfServiceModule onNavigate={setActiveTab} /> : <MonitoringModule />;
      case 'org_chart':
        return viewRole === 'employee' ? <SelfServiceModule onNavigate={setActiveTab} /> : <OrgChartModule />;
      case 'settings':
        return viewRole === 'super_admin' || viewRole === 'hr_manager' ? (
          <SettingsModule />
        ) : (
          <SelfServiceModule onNavigate={setActiveTab} />
        );
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0D12] text-[#FFFFFF] flex">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        role={employeeView ? 'employee' : effectiveRole}
        companyName={companySettings.companyName}
        domain={companySettings.domain}
        unreadNotifications={unreadCount}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          activeTab={activeTab}
          userName={userName}
          userEmail={firebaseUser.email || ''}
          role={effectiveRole}
          unreadCount={unreadCount}
          directory={directory}
          onSelectEmployee={handleGlobalEmployeeSelect}
          onOpenNotifications={() => setNotifOpen(true)}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
          onLogout={logout}
          employeeView={employeeView}
          onSwitchView={() => {
            const next = !employeeView;
            setEmployeeView(next);
            setActiveTab(next ? 'self_service' : 'dashboard');
          }}
        />

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto">
          {renderModule()}
        </main>
      </div>

      <NotificationsPanel
        open={notifOpen}
        mode="drawer"
        onClose={() => setNotifOpen(false)}
        onNavigateTab={setActiveTab}
      />

      {/* Real-time Popup Notification Toast */}
      {toast && (
        <div className="fixed bottom-5 right-5 z-50 max-w-sm w-full bg-[#151922] border border-[#FF4634]/40 rounded-2xl p-4 shadow-2xl shadow-black/60 flex items-start gap-3">
          <Bell className="w-4 h-4 text-[#FF6A33] shrink-0 mt-0.5" />
          <button
            type="button"
            onClick={() => {
              const target = toast;
              setToast(null);
              if (!target.read) {
                updateDoc(doc(db, 'notifications', target.id), {
                  read: true,
                  updatedAt: serverTimestamp(),
                }).catch(() => {});
              }
              if (target.linkTab) {
                setActiveTab(target.linkTab as ActiveTab);
              }
            }}
            className="flex-1 min-w-0 text-left"
          >
            <div className="text-xs font-semibold text-[#FFFFFF] truncate">{toast.title}</div>
            <div className="text-xs text-[#A1A1AA] mt-0.5 line-clamp-2">{toast.message}</div>
          </button>
          <button type="button" onClick={() => setToast(null)} className="text-[#A1A1AA] hover:text-[#FFFFFF]" aria-label="Dismiss notification">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
};

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <HrmsDataProvider>
          <WorkspaceShell />
        </HrmsDataProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
