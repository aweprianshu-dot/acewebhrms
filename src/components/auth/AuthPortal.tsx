import React, { useState } from 'react';
import {
  ShieldCheck,
  Mail,
  Lock,
  User,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  LogOut,
  Building2,
  Sun,
  Moon,
  KeyRound,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { AceBrandMark } from '../common/AceBrandMark';
import { useThemeMode } from '../../utils/themeUtils';
import officeImg from '../../assets/images/ace_office_architecture_1794659775235.jpg';

type AuthView = 'login' | 'signup' | 'forgot';

export const AuthPortal: React.FC = () => {
  const {
    firebaseUser,
    needsEmailVerification,
    needsInitialSetup,
    isPendingApproval,
    isDeactivated,
    authActionMode,
    authOobCode,
    pendingMfaResolver,
    clearAuthAction,
    clearMfaChallenge,
    loginWithEmail,
    signupWithEmail,
    loginWithGoogle,
    resolveMfaChallenge,
    sendResetEmail,
    completePasswordReset,
    resendVerification,
    refreshSession,
    logout,
    initializeFirstSuperAdmin,
  } = useAuth();

  const { isLight, toggleTheme } = useThemeMode();

  const [view, setView] = useState<AuthView>('login');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Initial Super Admin Setup form state
  const [companyName, setCompanyName] = useState('ACE Web Experts');
  const [adminName, setAdminName] = useState(firebaseUser?.displayName || '');
  const [adminDesignation, setAdminDesignation] = useState('Founder & Chief Executive Officer');
  const [currency, setCurrency] = useState('USD');

  const formatAuthError = (err: unknown): string => {
    const msg = err instanceof Error ? err.message : 'Authentication error';
    if (msg.includes('auth/multi-factor-auth-required')) {
      return 'Two-factor authentication code required to finish signing in.';
    }
    if (msg.includes('auth/invalid-verification-code')) {
      return 'Invalid 6-digit authenticator code. Please try the current code from your authenticator app.';
    }
    if (msg.includes('auth/operation-not-allowed')) {
      return 'Email/Password sign-in is not yet enabled in Firebase Console (Authentication -> Sign-in method -> Email/Password). Enable it in Firebase Console or use Continue with Google below.';
    }
    if (msg.includes('auth/invalid-credential') || msg.includes('auth/wrong-password')) {
      return 'Invalid email or password. Please verify your credentials.';
    }
    if (msg.includes('auth/email-already-in-use')) {
      return 'An account with this email already exists. Please sign in instead.';
    }
    if (msg.includes('auth/weak-password')) {
      return 'Password must be at least 6 characters.';
    }
    if (msg.includes('auth/popup-closed-by-user')) {
      return 'Google sign-in window was closed before completion.';
    }
    return msg.replace('Firebase: ', '');
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await loginWithEmail(email, password);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/multi-factor-auth-required') {
        setNotice('Enter the 6-digit code from your authenticator app.');
      } else {
        setError(formatAuthError(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await resolveMfaChallenge(mfaCode.trim());
      setMfaCode('');
    } catch (err) {
      setError(formatAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (fullName.trim().length < 2) {
      setError('Please enter your full name.');
      return;
    }
    setBusy(true);
    try {
      await signupWithEmail(fullName, email, password);
      setNotice('Verification link sent to your email. Please verify your address to activate your workspace.');
    } catch (err) {
      setError(formatAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await sendResetEmail(email);
      setNotice('Password reset instructions have been sent to your email address.');
    } catch (err) {
      setError(formatAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleGoogle = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await loginWithGoogle();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/multi-factor-auth-required') {
        setNotice('Enter the 6-digit code from your authenticator app.');
      } else {
        setError(formatAuthError(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleResetConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authOobCode) return;
    setError(null);
    setBusy(true);
    try {
      await completePasswordReset(authOobCode, newPassword);
      setNotice('Your password has been updated. You may now sign in.');
      setView('login');
    } catch (err) {
      setError(formatAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSetupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await initializeFirstSuperAdmin({
        companyName,
        fullName: adminName || firebaseUser?.displayName || 'Super Admin',
        designation: adminDesignation,
        currency,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Initialization failed');
    } finally {
      setBusy(false);
    }
  };

  const themeToggleBtn = (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isLight ? 'Switch to dark theme' : 'Switch to light theme'}
      title={isLight ? 'Switch to Dark Theme' : 'Switch to Light Theme'}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[#292D36] bg-[#151922] text-xs font-medium text-[#A1A1AA] hover:text-[#FFFFFF] transition-colors"
    >
      {isLight ? <Moon className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />}
      <span>{isLight ? 'Dark' : 'Light'}</span>
    </button>
  );

  // TOTP Multi-Factor Challenge Modal / Gate
  if (pendingMfaResolver) {
    return (
      <div className="min-h-screen bg-[#0B0D12] flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-[#151922] border border-[#252B36] rounded-2xl p-8 shadow-2xl shadow-black/40">
          <div className="flex items-center justify-between mb-5">
            <div className="w-11 h-11 rounded-xl bg-[#FF4634]/15 border border-[#FF4634]/30 flex items-center justify-center text-[#FF6A33]">
              <KeyRound className="w-5 h-5" />
            </div>
            {themeToggleBtn}
          </div>
          <h1 className="text-xl font-bold text-[#F5F5F5] mb-2">Two-Factor Verification</h1>
          <p className="text-sm text-[#A1A9B8] mb-6">
            Enter the 6-digit verification code from your enrolled TOTP authenticator app.
          </p>
          {error && (
            <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          <form onSubmit={handleMfaSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-[#F5F5F5] mb-1.5">6-Digit Code</label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                className="w-full px-3.5 py-2.5 bg-[#0B0D12] border border-[#252B36] rounded-xl text-base font-mono tracking-[0.35em] text-center text-[#F5F5F5] focus:outline-none focus:border-[#FF4634]"
              />
            </div>
            <div className="flex items-center gap-3 pt-2">
              <button
                type="submit"
                disabled={busy || mfaCode.length !== 6}
                className="flex-1 py-2.5 px-4 ace-btn-primary disabled:opacity-60 text-sm font-medium rounded-xl"
              >
                {busy ? 'Verifying...' : 'Verify & Sign In'}
              </button>
              <button
                type="button"
                onClick={() => {
                  clearMfaChallenge();
                  setMfaCode('');
                  setError(null);
                }}
                className="py-2.5 px-4 border border-[#252B36] text-[#A1A9B8] hover:text-[#F5F5F5] text-sm rounded-xl"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // Password Reset URL Callback View
  if (authActionMode === 'resetPassword' && authOobCode) {
    return (
      <div className="min-h-screen bg-[#0B0D12] flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-[#151922] border border-[#252B36] rounded-2xl p-8 shadow-2xl shadow-black/40">
          <div className="flex items-center justify-between mb-4">
            <AceBrandMark size={26} showWordmark showSubtitle />
            {themeToggleBtn}
          </div>
          <h1 className="text-xl font-bold text-[#F5F5F5] mb-2">Set New Password</h1>
          <p className="text-sm text-[#A1A9B8] mb-6">Enter a strong password for your ACE HRMS account.</p>
          {error && (
            <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          <form onSubmit={handleResetConfirm} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-[#F5F5F5] mb-1.5">New Password</label>
              <input
                type="password"
                required
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Minimum 6 characters"
                className="w-full px-3.5 py-2.5 bg-[#0B0D12] border border-[#252B36] rounded-xl text-sm text-[#F5F5F5] focus:outline-none focus:border-[#FF4634]"
              />
            </div>
            <div className="flex items-center gap-3 pt-2">
              <button
                type="submit"
                disabled={busy}
                className="flex-1 py-2.5 px-4 ace-btn-primary disabled:opacity-60 text-sm font-medium rounded-xl"
              >
                {busy ? 'Updating...' : 'Confirm Password Reset'}
              </button>
              <button
                type="button"
                onClick={clearAuthAction}
                className="py-2.5 px-4 border border-[#252B36] text-[#A1A9B8] hover:text-[#F5F5F5] text-sm rounded-xl"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // Email Verification Gate
  if (needsEmailVerification && firebaseUser) {
    return (
      <div className="min-h-screen bg-[#0B0D12] flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-[#151922] border border-[#252B36] rounded-2xl p-8 shadow-2xl shadow-black/40">
          <div className="flex items-center justify-between mb-5">
            <div className="w-11 h-11 rounded-xl bg-[#FF4634]/15 border border-[#FF4634]/30 flex items-center justify-center text-[#FF6A33]">
              <Mail className="w-5 h-5" />
            </div>
            {themeToggleBtn}
          </div>
          <h1 className="text-xl font-bold text-[#F5F5F5] mb-2">Verify Your Work Email</h1>
          <p className="text-sm text-[#A1A9B8] leading-relaxed mb-6">
            A verification email was sent to <span className="text-[#F5F5F5] font-medium">{firebaseUser.email}</span>.
            Click the verification link in your inbox, then click Refresh Status below.
          </p>
          {notice && (
            <div className="mb-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs">
              {notice}
            </div>
          )}
          {error && (
            <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
              {error}
            </div>
          )}
          <div className="space-y-3">
            <button
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await refreshSession();
                } catch (err) {
                  setError(formatAuthError(err));
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 ace-btn-primary text-sm font-medium rounded-xl"
            >
              <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
              I Verified My Email — Continue
            </button>
            <button
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await resendVerification();
                  setNotice('Verification email resent.');
                } catch (err) {
                  setError(formatAuthError(err));
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
              className="w-full py-2.5 px-4 border border-[#252B36] hover:border-[#3A4354] text-[#A1A9B8] hover:text-[#F5F5F5] text-sm font-medium rounded-xl transition-colors"
            >
              Resend Verification Email
            </button>
            <button
              onClick={logout}
              className="w-full flex items-center justify-center gap-2 py-2 text-xs text-[#A1A9B8] hover:text-[#F5F5F5]"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign out and switch account
            </button>
          </div>
        </div>
      </div>
    );
  }

  // First Super Admin Secure Initial Setup
  if (needsInitialSetup && firebaseUser) {
    return (
      <div className="min-h-screen bg-[#0B0D12] flex items-center justify-center p-6">
        <div className="w-full max-w-lg bg-[#151922] border border-[#252B36] rounded-2xl p-8 shadow-2xl shadow-black/40">
          <div className="flex items-center justify-between gap-3 mb-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#FF4634] to-[#FF6A33] ace-on-accent flex items-center justify-center text-white shadow-md shadow-[#FF4634]/25">
                <Building2 className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-[#F5F5F5]">Initialize ACE HRMS</h1>
                <p className="text-xs text-[#A1A9B8]">One-time Super Admin & company workspace setup</p>
              </div>
            </div>
            {themeToggleBtn}
          </div>

          <p className="text-sm text-[#A1A9B8] leading-relaxed mb-6">
            No Super Admin exists yet. Completing this setup binds <span className="text-[#F5F5F5] font-medium">{firebaseUser.email}</span> as the initial Super Admin and provisions default departments, policies, and HR settings.
          </p>

          {error && (
            <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
              {error}
            </div>
          )}

          <form onSubmit={handleSetupSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-[#F5F5F5] mb-1.5">Company Name</label>
              <input
                type="text"
                required
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-[#0B0D12] border border-[#252B36] rounded-xl text-sm text-[#F5F5F5] focus:outline-none focus:border-[#FF4634]"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-[#F5F5F5] mb-1.5">Super Admin Full Name</label>
                <input
                  type="text"
                  required
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                  placeholder="Your full name"
                  className="w-full px-3.5 py-2.5 bg-[#0B0D12] border border-[#252B36] rounded-xl text-sm text-[#F5F5F5] focus:outline-none focus:border-[#FF4634]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#F5F5F5] mb-1.5">Designation</label>
                <input
                  type="text"
                  required
                  value={adminDesignation}
                  onChange={(e) => setAdminDesignation(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-[#0B0D12] border border-[#252B36] rounded-xl text-sm text-[#F5F5F5] focus:outline-none focus:border-[#FF4634]"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#F5F5F5] mb-1.5">Default Payroll Currency</label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-[#0B0D12] border border-[#252B36] rounded-xl text-sm text-[#F5F5F5] focus:outline-none focus:border-[#FF4634]"
              >
                <option value="USD">USD ($) — US Dollar</option>
                <option value="INR">INR (₹) — Indian Rupee</option>
                <option value="EUR">EUR (€) — Euro</option>
                <option value="GBP">GBP (£) — British Pound</option>
                <option value="AED">AED — UAE Dirham</option>
                <option value="CAD">CAD (CA$) — Canadian Dollar</option>
              </select>
            </div>
            <div className="flex items-center justify-between pt-3">
              <button
                type="button"
                onClick={logout}
                className="text-xs text-[#A1A9B8] hover:text-[#F5F5F5]"
              >
                Switch account
              </button>
              <button
                type="submit"
                disabled={busy}
                className="inline-flex items-center gap-2 py-2.5 px-5 ace-btn-primary disabled:opacity-60 text-sm font-medium rounded-xl"
              >
                <ShieldCheck className="w-4 h-4" />
                {busy ? 'Provisioning Workspace...' : 'Complete Initial Setup'}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // Pending Approval or Deactivated Account Gate
  if ((isPendingApproval || isDeactivated) && firebaseUser) {
    return (
      <div className="min-h-screen bg-[#0B0D12] flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-[#151922] border border-[#252B36] rounded-2xl p-8 shadow-2xl shadow-black/40">
          <div className="flex items-center justify-between mb-5">
            <div
              className={`w-11 h-11 rounded-xl flex items-center justify-center ${
                isDeactivated
                  ? 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
                  : 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
              }`}
            >
              <ShieldCheck className="w-5 h-5" />
            </div>
            {themeToggleBtn}
          </div>
          <h1 className="text-xl font-bold text-[#F5F5F5] mb-2">
            {isDeactivated ? 'Account Deactivated' : 'Awaiting HR Activation'}
          </h1>
          <p className="text-sm text-[#A1A9B8] leading-relaxed mb-6">
            {isDeactivated
              ? `Your ACE Web Experts account (${firebaseUser.email}) has been deactivated by HR administration.`
              : `Your account (${firebaseUser.email}) is verified and registered as a standard employee pending HR activation or an active employee invitation. Public signups never grant administrative privileges automatically.`}
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={refreshSession}
              className="flex-1 py-2.5 px-4 ace-btn-primary text-sm font-medium rounded-xl"
            >
              Check Activation Status
            </button>
            <button
              onClick={logout}
              className="py-2.5 px-4 border border-[#252B36] text-[#A1A9B8] hover:text-[#F5F5F5] text-sm rounded-xl"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Standard Login / Signup / Forgot Password Split Layout
  return (
    <div className="min-h-screen bg-[#0B0D12] text-[#F5F5F5] grid lg:grid-cols-12">
      {/* Left Architectural Showcase (stays rich dark over photo in both modes) */}
      <div className="hidden lg:flex lg:col-span-7 relative overflow-hidden border-r border-[#252B36]">
        <img
          src={officeImg}
          alt="ACE Web Experts executive workspace"
          referrerPolicy="no-referrer"
          className="absolute inset-0 w-full h-full object-cover"
        />
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(to top, rgba(11,13,18,0.96), rgba(11,13,18,0.78) 55%, rgba(11,13,18,0.45))',
          }}
        />
        <div className="relative z-10 flex flex-col justify-between p-12 w-full">
          <div className="flex items-center gap-3">
            <AceBrandMark size={34} showWordmark showSubtitle subtitleText="HRMS" forceLightWordmark />
          </div>

          <div className="max-w-xl">
            <p className="text-xs font-semibold tracking-wider text-[#FF6A33] uppercase mb-3">
              ACE Web Experts · Enterprise Workforce Platform
            </p>
            <h1 className="ace-on-accent font-display text-4xl font-bold text-white leading-tight mb-4" style={{ textWrap: 'balance' }}>
              Unified People Operations, Payroll, and Attendance Control
            </h1>
            <p className="text-base text-[#D4D4D8] ace-on-accent opacity-85 leading-relaxed mb-8">
              Role-scoped access for Super Admins, HR Managers, Managers, Team Leads, and Employees — backed by real-time Firestore security rules and verifiable audit logs.
            </p>
            <div className="grid grid-cols-3 gap-6 pt-6 border-t border-white/15">
              <div>
                <div className="ace-on-accent text-sm font-semibold text-white">Role Isolation</div>
                <div className="ace-on-accent text-xs text-white/75 mt-1">Salary & PII locked per role</div>
              </div>
              <div>
                <div className="ace-on-accent text-sm font-semibold text-white">Time & Leave</div>
                <div className="ace-on-accent text-xs text-white/75 mt-1">Policy-verified check-ins</div>
              </div>
              <div>
                <div className="ace-on-accent text-sm font-semibold text-white">Payroll & PDF</div>
                <div className="ace-on-accent text-xs text-white/75 mt-1">Configurable rules & payslips</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right Auth Form Column */}
      <div className="lg:col-span-5 flex flex-col justify-center p-6 sm:p-10 relative">
        <div className="w-full max-w-md mx-auto">
          <div className="flex items-center justify-between gap-3 mb-7">
            <div className="lg:hidden">
              <AceBrandMark size={30} showWordmark showSubtitle subtitleText="HRMS" />
            </div>
            <div className="hidden lg:block" />
            {themeToggleBtn}
          </div>

          <div className="mb-7">
            <h2 className="font-display text-2xl font-bold text-[#F5F5F5]">
              {view === 'login' && 'Sign in to ACE HRMS'}
              {view === 'signup' && 'Create Employee Account'}
              {view === 'forgot' && 'Reset Password'}
            </h2>
            <p className="text-sm text-[#A1A9B8] mt-1.5">
              {view === 'login' && 'Access your ACE Web Experts HR workspace'}
              {view === 'signup' && 'Register with your work email to claim an HR invitation'}
              {view === 'forgot' && 'Receive a secure password reset link via email'}
            </p>
          </div>

          {/* Auth Mode Switcher */}
          <div className="grid grid-cols-2 gap-1 p-1 bg-[#151922] border border-[#252B36] rounded-xl mb-6">
            <button
              type="button"
              onClick={() => {
                setView('login');
                setError(null);
                setNotice(null);
              }}
              className={`py-2 text-xs font-medium rounded-lg transition-all ${
                view === 'login'
                  ? 'ace-on-accent bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-white shadow-sm'
                  : 'text-[#A1A9B8] hover:text-[#F5F5F5]'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setView('signup');
                setError(null);
                setNotice(null);
              }}
              className={`py-2 text-xs font-medium rounded-lg transition-all ${
                view === 'signup'
                  ? 'ace-on-accent bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-white shadow-sm'
                  : 'text-[#A1A9B8] hover:text-[#F5F5F5]'
              }`}
            >
              Sign Up
            </button>
          </div>

          {error && (
            <div className="mb-5 p-3.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2.5 leading-relaxed">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {notice && (
            <div className="mb-5 p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-start gap-2.5 leading-relaxed">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{notice}</span>
            </div>
          )}

          {view === 'login' && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-[#F5F5F5] mb-1.5">Work Email</label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-[#A1A9B8] absolute left-3.5 top-3" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@acewebexperts.com"
                    className="w-full pl-10 pr-3.5 py-2.5 bg-[#151922] border border-[#252B36] rounded-xl text-sm text-[#F5F5F5] placeholder-[#A1A9B8]/60 focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-[#F5F5F5]">Password</label>
                  <button
                    type="button"
                    onClick={() => {
                      setView('forgot');
                      setError(null);
                    }}
                    className="text-xs text-[#FF6A33] hover:text-[#FF4634]"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <Lock className="w-4 h-4 text-[#A1A9B8] absolute left-3.5 top-3" />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="w-full pl-10 pr-3.5 py-2.5 bg-[#151922] border border-[#252B36] rounded-xl text-sm text-[#F5F5F5] placeholder-[#A1A9B8]/60 focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full flex items-center justify-center gap-2 py-2.5 px-4 ace-btn-primary disabled:opacity-60 text-sm font-medium rounded-xl"
              >
                <span>{busy ? 'Signing in...' : 'Sign In'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          )}

          {view === 'signup' && (
            <form onSubmit={handleSignup} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-[#F5F5F5] mb-1.5">Full Name</label>
                <div className="relative">
                  <User className="w-4 h-4 text-[#A1A9B8] absolute left-3.5 top-3" />
                  <input
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Alex Morgan"
                    className="w-full pl-10 pr-3.5 py-2.5 bg-[#151922] border border-[#252B36] rounded-xl text-sm text-[#F5F5F5] placeholder-[#A1A9B8]/60 focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-[#F5F5F5] mb-1.5">Work Email</label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-[#A1A9B8] absolute left-3.5 top-3" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@acewebexperts.com"
                    className="w-full pl-10 pr-3.5 py-2.5 bg-[#151922] border border-[#252B36] rounded-xl text-sm text-[#F5F5F5] placeholder-[#A1A9B8]/60 focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-[#F5F5F5] mb-1.5">Password</label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-[#A1A9B8] absolute left-3.5 top-3" />
                  <input
                    type="password"
                    required
                    minLength={12}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min 12 chars (Aa1!)"
                    className="w-full pl-10 pr-3.5 py-2.5 bg-[#151922] border border-[#252B36] rounded-xl text-sm text-[#F5F5F5] placeholder-[#A1A9B8]/60 focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full flex items-center justify-center gap-2 py-2.5 px-4 ace-btn-primary disabled:opacity-60 text-sm font-medium rounded-xl"
              >
                <span>{busy ? 'Creating Account...' : 'Create Account'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          )}

          {view === 'forgot' && (
            <form onSubmit={handleForgot} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-[#F5F5F5] mb-1.5">Registered Email</label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-[#A1A9B8] absolute left-3.5 top-3" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@acewebexperts.com"
                    className="w-full pl-10 pr-3.5 py-2.5 bg-[#151922] border border-[#252B36] rounded-xl text-sm text-[#F5F5F5] placeholder-[#A1A9B8]/60 focus:outline-none focus:border-[#FF4634]"
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={busy}
                className="w-full py-2.5 px-4 ace-btn-primary disabled:opacity-60 text-sm font-medium rounded-xl"
              >
                {busy ? 'Sending...' : 'Send Reset Link'}
              </button>
              <button
                type="button"
                onClick={() => setView('login')}
                className="w-full py-2 text-xs text-[#A1A9B8] hover:text-[#F5F5F5]"
              >
                Back to Sign In
              </button>
            </form>
          )}

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-[#252B36]" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-[#0B0D12] px-3 text-[#A1A9B8]">or continue with</span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleGoogle}
            disabled={busy}
            className="w-full flex items-center justify-center gap-3 py-2.5 px-4 bg-[#151922] hover:bg-[#1B1F28] border border-[#292D36] text-[#FFFFFF] text-sm font-medium rounded-xl transition-colors"
          >
            <svg className="w-4 h-4 text-[#FFFFFF]" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17ZM12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24ZM5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14ZM12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
              />
            </svg>
            <span>Continue with Google</span>
          </button>

          <p className="text-xs text-[#A1A1AA]/80 text-center mt-8">
            ACE Web Experts · Protected Workspace · {typeof window !== 'undefined' ? window.location.host : 'ACE HRMS'}
          </p>
        </div>
      </div>
    </div>
  );
};
