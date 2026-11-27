import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  User,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signOut,
  sendPasswordResetEmail,
  sendEmailVerification,
  updateProfile,
  applyActionCode,
  confirmPasswordReset,
  EmailAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  multiFactor,
  getMultiFactorResolver,
  TotpMultiFactorGenerator,
  type MultiFactorError,
  type MultiFactorResolver,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs,
  writeBatch,
  serverTimestamp,
} from 'firebase/firestore';
import { auth, db, googleProvider, handleFirestoreError, OperationType } from '../firebase';
import type {
  EmployeeProfile,
  Invitation,
  RoleAssignment,
  SystemSetup,
  UserAccount,
  UserRole,
} from '../types/hrms';
import { apiRequest, dispatchNotification, makeId, writeAuditLog } from '../services/hrmsApi';

export interface TotpEnrollmentStart {
  secretKey: string;
  qrUri: string;
  verifyAndEnroll: (code: string, displayName?: string) => Promise<void>;
}

interface AuthContextValue {
  firebaseUser: User | null;
  userAccount: UserAccount | null;
  roleAssignment: RoleAssignment | null;
  employeeProfile: EmployeeProfile | null;
  systemSetup: SystemSetup | null;
  effectiveRole: UserRole;
  loading: boolean;
  needsEmailVerification: boolean;
  needsInitialSetup: boolean;
  isPendingApproval: boolean;
  isDeactivated: boolean;
  pendingInvite: Invitation | null;
  authActionMode: 'resetPassword' | 'verifyEmail' | null;
  authOobCode: string | null;
  mfaEnrolledFactors: { uid: string; displayName?: string | null; factorId: string }[];
  pendingMfaResolver: MultiFactorResolver | null;
  clearAuthAction: () => void;
  clearMfaChallenge: () => void;
  loginWithEmail: (email: string, password: string) => Promise<void>;
  signupWithEmail: (fullName: string, email: string, password: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  resolveMfaChallenge: (code: string) => Promise<void>;
  startTotpEnrollment: () => Promise<TotpEnrollmentStart>;
  unenrollMfaFactor: (factorUid: string) => Promise<void>;
  sendResetEmail: (email: string) => Promise<void>;
  completePasswordReset: (oobCode: string, newPassword: string) => Promise<void>;
  resendVerification: () => Promise<void>;
  reauthenticateCurrentUser: (password?: string) => Promise<{ mfaRequired: boolean }>;
  refreshSession: () => Promise<void>;
  logout: () => Promise<void>;
  initializeFirstSuperAdmin: (params: {
    companyName: string;
    fullName: string;
    designation: string;
    currency: string;
  }) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [userAccount, setUserAccount] = useState<UserAccount | null>(null);
  const [roleAssignment, setRoleAssignment] = useState<RoleAssignment | null>(null);
  const [employeeProfile, setEmployeeProfile] = useState<EmployeeProfile | null>(null);
  const [systemSetup, setSystemSetup] = useState<SystemSetup | null>(null);
  const [pendingInvite, setPendingInvite] = useState<Invitation | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsInitialSetup, setNeedsInitialSetup] = useState(false);

  const [authActionMode, setAuthActionMode] = useState<'resetPassword' | 'verifyEmail' | null>(null);
  const [authOobCode, setAuthOobCode] = useState<string | null>(null);
  const [pendingMfaResolver, setPendingMfaResolver] = useState<MultiFactorResolver | null>(null);
  const [mfaEnrolledFactors, setMfaEnrolledFactors] = useState<{ uid: string; displayName?: string | null; factorId: string }[]>([]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('mode');
    const oobCode = params.get('oobCode');
    if (oobCode && mode === 'resetPassword') {
      setAuthActionMode('resetPassword');
      setAuthOobCode(oobCode);
    } else if (oobCode && mode === 'verifyEmail') {
      setAuthActionMode('verifyEmail');
      setAuthOobCode(oobCode);
      applyActionCode(auth, oobCode)
        .then(() => auth.currentUser?.reload())
        .catch(() => {});
    }
  }, []);

  const clearAuthAction = useCallback(() => {
    setAuthActionMode(null);
    setAuthOobCode(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('mode');
    url.searchParams.delete('oobCode');
    url.searchParams.delete('apiKey');
    window.history.replaceState({}, '', url.toString());
  }, []);

  const hydrateUserSession = useCallback(async (user: User | null) => {
    if (!user) {
      setUserAccount(null);
      setRoleAssignment(null);
      setEmployeeProfile(null);
      setSystemSetup(null);
      setPendingInvite(null);
      setNeedsInitialSetup(false);
      setLoading(false);
      return;
    }

    if (!user.emailVerified) {
      setUserAccount(null);
      setRoleAssignment(null);
      setEmployeeProfile(null);
      setNeedsInitialSetup(false);
      setLoading(false);
      return;
    }

    try {
      // 1. Check /system/setup, /admins/{uid}, and pre-existing /organisations/org_ace_web_experts
      const setupRef = doc(db, 'system', 'setup');
      const [setupSnap, adminSnap, orgSnap] = await Promise.all([
        getDoc(setupRef),
        getDoc(doc(db, 'admins', user.uid)).catch(() => null),
        getDoc(doc(db, 'organisations', 'org_ace_web_experts')).catch(() => null),
      ]);
      const setupData = setupSnap.exists() ? (setupSnap.data() as SystemSetup) : null;
      const orgExists = Boolean(orgSnap?.exists());
      const emailLower = (user.email || '').toLowerCase();
      const isExistingAdminOrOwner = Boolean(adminSnap?.exists()) || emailLower === 'awe.prianshu@gmail.com';
      setSystemSetup(setupData);

      // 2. Check /roles/{uid}
      const roleRef = doc(db, 'roles', user.uid);
      const roleSnap = await getDoc(roleRef);
      // Recover legacy role records whose document ID casing differs from Firebase Auth UID.
      // The rules only allow querying the signed-in user's exact email and migrating an active employee role.
      const legacyRolesSnap = !roleSnap.exists() && user.email
        ? await getDocs(query(collection(db, 'roles'), where('email', '==', user.email)))
        : null;
      const legacyRoleDoc = legacyRolesSnap?.docs.find((candidate) =>
        candidate.id !== user.uid &&
        candidate.data().email === user.email &&
        candidate.data().role === 'employee' &&
        candidate.data().status === 'active'
      );

      if (!roleSnap.exists()) {
        if (isExistingAdminOrOwner) {
          // Non-destructive hydration for existing WorkFlow OS Super Admin (awe.prianshu@gmail.com / existing /admins/{uid})
          if (!adminSnap?.exists()) {
            await setDoc(doc(db, 'admins', user.uid), {
              uid: user.uid,
              email: user.email || 'awe.prianshu@gmail.com',
              createdAt: serverTimestamp(),
            });
          }
          await setDoc(roleRef, {
            uid: user.uid,
            email: user.email || '',
            role: 'super_admin',
            departmentId: 'dept_exec',
            status: 'active',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          const existingUserSnap = await getDoc(doc(db, 'users', user.uid)).catch(() => null);
          if (!existingUserSnap?.exists()) {
            await setDoc(doc(db, 'users', user.uid), {
              uid: user.uid,
              displayName: user.displayName || 'Super Admin',
              email: user.email || '',
              photoURL: user.photoURL || '',
              employeeId: '',
              emailVerified: true,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          }
          if (!setupData) {
            const orgName = String(orgSnap?.data()?.name || 'ACE Web Experts');
            await setDoc(setupRef, {
              initialized: true,
              superAdminUid: user.uid,
              companyName: orgName,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            setSystemSetup({
              initialized: true,
              superAdminUid: user.uid,
              companyName: orgName,
            });
            // Seed only missing core settings & departments (never overwrite existing WorkFlow OS data)
            const [compSnap, wpSnap, paySnap, lpSnap, existingDepts] = await Promise.all([
              getDoc(doc(db, 'settings', 'company')).catch(() => null),
              getDoc(doc(db, 'settings', 'workPolicy')).catch(() => null),
              getDoc(doc(db, 'settings', 'payrollConfig')).catch(() => null),
              getDoc(doc(db, 'settings', 'leavePolicy')).catch(() => null),
              getDocs(collection(db, 'departments')).catch(() => null),
            ]);
            const seedBatch = writeBatch(db);
            let hasWrites = false;
            if (!compSnap?.exists()) {
              hasWrites = true;
              seedBatch.set(doc(db, 'settings', 'company'), {
                id: 'company',
                companyName: orgName,
                domain: typeof window !== 'undefined' ? window.location.host : '',
                contactEmail: user.email || '',
                address: 'ACE Web Experts HQ',
                defaultCurrency: 'USD',
                updatedByUid: user.uid,
                updatedAt: serverTimestamp(),
              });
            }
            if (!wpSnap?.exists()) {
              hasWrites = true;
              seedBatch.set(doc(db, 'settings', 'workPolicy'), {
                id: 'workPolicy',
                workStartTime: '09:30',
                workEndTime: '18:30',
                lunchStartTime: '13:30',
                lunchEndTime: '14:15',
                graceMinutes: 15,
                breakMinutes: 45,
                halfDayThresholdMinutes: 270,
                lunchTrackingEnabled: true,
                officeTimezone: 'Asia/Kolkata',
                weeklyOffs: ['Saturday', 'Sunday'],
                updatedByUid: user.uid,
                updatedAt: serverTimestamp(),
              });
            }
            if (!paySnap?.exists()) {
              hasWrites = true;
              seedBatch.set(doc(db, 'settings', 'payrollConfig'), {
                id: 'payrollConfig',
                currency: 'USD',
                currencySymbol: '$',
                workingDaysPerMonth: 22,
                overtimeMultiplier: 1.5,
                unpaidLeaveDeductionEnabled: true,
                customRules: [],
                updatedByUid: user.uid,
                updatedAt: serverTimestamp(),
              });
            }
            if (!lpSnap?.exists()) {
              hasWrites = true;
              seedBatch.set(doc(db, 'settings', 'leavePolicy'), {
                id: 'leavePolicy',
                casualAnnual: 12,
                sickAnnual: 10,
                paidAnnual: 15,
                emergencyAnnual: 5,
                updatedByUid: user.uid,
                updatedAt: serverTimestamp(),
              });
            }
            if (existingDepts && existingDepts.empty) {
              hasWrites = true;
              seedBatch.set(doc(db, 'departments', 'dept_exec'), {
                id: 'dept_exec',
                name: 'Executive & Leadership',
                code: 'EXEC',
                description: 'Executive governance and company strategy',
                headUid: user.uid,
                headName: user.displayName || 'Super Admin',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });
            }
            if (hasWrites) {
              await seedBatch.commit().catch(() => {});
            }
          }
          const refreshedRoleSnap = await getDoc(roleRef);
          setRoleAssignment(refreshedRoleSnap.exists() ? (refreshedRoleSnap.data() as RoleAssignment) : null);
        } else if (legacyRoleDoc) {
          // Migrate only an already-active employee record with the same verified email.
          // Keep the legacy document untouched for audit/rollback.
          const legacyData = legacyRoleDoc.data();
          await setDoc(roleRef, {
            ...legacyData,
            uid: user.uid,
            email: user.email || '',
            role: 'employee',
            status: 'active',
            legacyRoleDocId: legacyRoleDoc.id,
            createdAt: legacyData.createdAt || serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          const migratedRoleSnap = await getDoc(roleRef);
          setRoleAssignment(migratedRoleSnap.exists() ? (migratedRoleSnap.data() as RoleAssignment) : null);
        } else if (!setupData && !orgExists) {
          // Truly uninitialized workspace with no existing WorkFlow OS org or admin
          setNeedsInitialSetup(true);
          setRoleAssignment(null);
          setLoading(false);
          return;
        } else {
          // Check for pending invitation matching verified email
          const invQuery = query(
            collection(db, 'invitations'),
            where('email', '==', user.email || ''),
            where('status', '==', 'pending')
          );
          const invSnap = await getDocs(invQuery);
          let matchedInvite: Invitation | null = invSnap.docs[0]?.data() as Invitation | undefined ?? null;
          if (!matchedInvite && emailLower && emailLower !== user.email) {
            const invLowerQuery = query(
              collection(db, 'invitations'),
              where('email', '==', emailLower),
              where('status', '==', 'pending')
            );
            const invLowerSnap = await getDocs(invLowerQuery);
            matchedInvite = invLowerSnap.docs[0]?.data() as Invitation | undefined ?? null;
          }

          if (matchedInvite) {
            setPendingInvite(matchedInvite);
            const existingUserSnap = await getDoc(doc(db, 'users', user.uid)).catch(() => null);
            const batch = writeBatch(db);
            batch.set(roleRef, {
              uid: user.uid,
              email: user.email || '',
              role: matchedInvite.role,
              departmentId: matchedInvite.departmentId,
              inviteId: matchedInvite.id,
              status: 'active',
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            batch.update(doc(db, 'invitations', matchedInvite.id), {
              status: 'accepted',
              updatedAt: serverTimestamp(),
            });
            if (!existingUserSnap?.exists()) {
              batch.set(doc(db, 'users', user.uid), {
                uid: user.uid,
                displayName: user.displayName || matchedInvite.fullName,
                email: user.email || '',
                photoURL: user.photoURL || '',
                employeeId: matchedInvite.employeeId || '',
                emailVerified: true,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });
            }
            await batch.commit();

            // Link pre-created employee / directory / onboarding if present
            if (matchedInvite.employeeId) {
              try {
                const empRef = doc(db, 'employees', matchedInvite.employeeId);
                const empSnap = await getDoc(empRef);
                if (empSnap.exists() && !empSnap.data().uid) {
                  await updateDoc(empRef, { uid: user.uid, updatedAt: serverTimestamp() });
                }
                const dirRef = doc(db, 'directory', matchedInvite.employeeId);
                const dirSnap = await getDoc(dirRef);
                if (dirSnap.exists() && !dirSnap.data().uid) {
                  await updateDoc(dirRef, { uid: user.uid, updatedAt: serverTimestamp() });
                }
                const onbSnap = await getDocs(
                  query(collection(db, 'onboarding'), where('email', '==', user.email || ''))
                );
                for (const onbDoc of onbSnap.docs) {
                  if (!onbDoc.data().uid) {
                    await updateDoc(onbDoc.ref, {
                      uid: user.uid,
                      accountCreated: true,
                      updatedAt: serverTimestamp(),
                    });
                  }
                }
              } catch {
                // Linked by HR later if already assigned
              }
            }

            try {
              await apiRequest('/api/leaves/ensure-balance', {
                method: 'POST',
                body: JSON.stringify({}),
              });
            } catch {
              // Non-fatal during first login if backend IAM is pending
            }

            const refreshedRoleSnap = await getDoc(roleRef);
            setRoleAssignment(refreshedRoleSnap.exists() ? (refreshedRoleSnap.data() as RoleAssignment) : null);

            await dispatchNotification({
              recipientUid: user.uid,
              recipientEmail: user.email || matchedInvite.email,
              title: 'Welcome to ACE HRMS',
              message: `Your workspace account is now active (${matchedInvite.designation} · ${matchedInvite.departmentName}).`,
              type: 'system',
              linkTab: 'self_service',
              sendEmail: Boolean(user.email || matchedInvite.email),
            });
          } else {
            // Public signup NEVER creates an admin -> always employee + pending HR approval
            const existingUserSnap = await getDoc(doc(db, 'users', user.uid)).catch(() => null);
            if (!existingUserSnap?.exists()) {
              await setDoc(doc(db, 'users', user.uid), {
                uid: user.uid,
                displayName: user.displayName || user.email?.split('@')[0] || 'Employee',
                email: user.email || '',
                photoURL: user.photoURL || '',
                employeeId: '',
                emailVerified: true,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });
            }
            await setDoc(roleRef, {
              uid: user.uid,
              email: user.email || '',
              role: 'employee',
              departmentId: '',
              status: 'pending',
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            const refreshedRoleSnap = await getDoc(roleRef);
            setRoleAssignment(refreshedRoleSnap.exists() ? (refreshedRoleSnap.data() as RoleAssignment) : null);
          }
        }
      } else {
        setRoleAssignment(roleSnap.data() as RoleAssignment);
      }

      // 3. Load /users/{uid}
      const userSnap = await getDoc(doc(db, 'users', user.uid));
      if (userSnap.exists()) {
        setUserAccount(userSnap.data() as UserAccount);
      }

      // 4. Load matching /employees record
      const empByUid = await getDocs(query(collection(db, 'employees'), where('uid', '==', user.uid)));
      if (!empByUid.empty) {
        setEmployeeProfile(empByUid.docs[0].data() as EmployeeProfile);
      } else if (user.email) {
        const empByEmail = await getDocs(query(collection(db, 'employees'), where('email', '==', user.email)));
        if (!empByEmail.empty) {
          setEmployeeProfile(empByEmail.docs[0].data() as EmployeeProfile);
        } else {
          setEmployeeProfile(null);
        }
      }

      setNeedsInitialSetup(false);
    } catch (err) {
      console.error('Session hydration error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      setLoading(true);
      hydrateUserSession(user);
    });
    return () => unsubscribe();
  }, [hydrateUserSession]);

  useEffect(() => {
    if (!firebaseUser) {
      setMfaEnrolledFactors([]);
      return;
    }
    try {
      const enrolled = multiFactor(firebaseUser).enrolledFactors.map((f) => ({
        uid: f.uid,
        displayName: f.displayName,
        factorId: f.factorId,
      }));
      setMfaEnrolledFactors(enrolled);
    } catch {
      setMfaEnrolledFactors([]);
    }
  }, [firebaseUser]);

  const clearMfaChallenge = useCallback(() => {
    setPendingMfaResolver(null);
  }, []);

  const loginWithEmail = async (email: string, password: string) => {
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      setPendingMfaResolver(null);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/multi-factor-auth-required') {
        const resolver = getMultiFactorResolver(auth, err as MultiFactorError);
        setPendingMfaResolver(resolver);
      }
      throw err;
    }
  };

  const signupWithEmail = async (fullName: string, email: string, password: string) => {
    if (password.length < 12 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      throw new Error('Password must be at least 12 characters and include uppercase, lowercase, a number and a special character.');
    }
    const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
    await updateProfile(cred.user, { displayName: fullName.trim() });
    await sendEmailVerification(cred.user);
    setFirebaseUser(auth.currentUser);
  };

  const loginWithGoogle = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
      setPendingMfaResolver(null);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/multi-factor-auth-required') {
        const resolver = getMultiFactorResolver(auth, err as MultiFactorError);
        setPendingMfaResolver(resolver);
      }
      throw err;
    }
  };

  const resolveMfaChallenge = async (code: string) => {
    if (!pendingMfaResolver) throw new Error('No active two-factor challenge');
    const totpHint =
      pendingMfaResolver.hints.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID) ||
      pendingMfaResolver.hints[0];
    if (!totpHint) throw new Error('No supported TOTP factor found on account');
    const assertion = TotpMultiFactorGenerator.assertionForSignIn(totpHint.uid, code.trim());
    await pendingMfaResolver.resolveSignIn(assertion);
    setPendingMfaResolver(null);
    if (auth.currentUser) {
      await auth.currentUser.reload();
      await auth.currentUser.getIdToken(true);
    }
  };

  const startTotpEnrollment = async (): Promise<TotpEnrollmentStart> => {
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in required to configure 2FA');
    const session = await multiFactor(user).getSession();
    const totpSecret = await TotpMultiFactorGenerator.generateSecret(session);
    const qrUri = totpSecret.generateQrCodeUrl(user.email || 'user@acewebexperts.com', 'ACE HRMS');
    return {
      secretKey: totpSecret.secretKey,
      qrUri,
      verifyAndEnroll: async (code: string, displayName = 'Authenticator App') => {
        const assertion = TotpMultiFactorGenerator.assertionForEnrollment(totpSecret, code.trim());
        await multiFactor(user).enroll(assertion, displayName);
        await user.reload();
        setMfaEnrolledFactors(
          multiFactor(user).enrolledFactors.map((f) => ({
            uid: f.uid,
            displayName: f.displayName,
            factorId: f.factorId,
          })),
        );
      },
    };
  };

  const unenrollMfaFactor = async (factorUid: string) => {
    const user = auth.currentUser;
    if (!user) throw new Error('No active user');
    await multiFactor(user).unenroll(factorUid);
    await user.reload();
    setMfaEnrolledFactors(
      multiFactor(user).enrolledFactors.map((f) => ({
        uid: f.uid,
        displayName: f.displayName,
        factorId: f.factorId,
      })),
    );
  };

  const sendResetEmail = async (email: string) => {
    await sendPasswordResetEmail(auth, email.trim());
  };

  const completePasswordReset = async (oobCode: string, newPassword: string) => {
    await confirmPasswordReset(auth, oobCode, newPassword);
    clearAuthAction();
  };

  const resendVerification = async () => {
    if (!auth.currentUser) throw new Error('No active user');
    await sendEmailVerification(auth.currentUser);
  };

  const reauthenticateCurrentUser = async (password?: string): Promise<{ mfaRequired: boolean }> => {
    const user = auth.currentUser;
    if (!user) throw new Error('Active authenticated session required.');
    try {
      const hasPasswordProvider = user.providerData.some((p) => p.providerId === 'password');
      if (password && hasPasswordProvider && user.email) {
        const cred = EmailAuthProvider.credential(user.email, password);
        await reauthenticateWithCredential(user, cred);
      } else {
        await reauthenticateWithPopup(user, googleProvider);
      }
      await user.reload();
      await user.getIdToken(true);
      return { mfaRequired: false };
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/multi-factor-auth-required') {
        const resolver = getMultiFactorResolver(auth, err as MultiFactorError);
        setPendingMfaResolver(resolver);
        return { mfaRequired: true };
      }
      throw err;
    }
  };

  const refreshSession = async () => {
    if (!auth.currentUser) return;
    await auth.currentUser.reload();
    await auth.currentUser.getIdToken(true);
    setFirebaseUser(auth.currentUser);
    setLoading(true);
    await hydrateUserSession(auth.currentUser);
  };

  const logout = async () => {
    await signOut(auth);
  };

  const initializeFirstSuperAdmin = async ({
    companyName,
    fullName,
    designation,
    currency,
  }: {
    companyName: string;
    fullName: string;
    designation: string;
    currency: string;
  }) => {
    const user = auth.currentUser;
    if (!user || !user.emailVerified) {
      throw new Error('Verified authenticated account required');
    }

    const empId = 'emp_admin_001';
    const deptId = 'dept_exec';
    const today = new Date().toISOString().slice(0, 10);

    try {
      // Atomic bootstrap batch
      const setupBatch = writeBatch(db);
      setupBatch.set(doc(db, 'system', 'setup'), {
        initialized: true,
        superAdminUid: user.uid,
        companyName: companyName.trim() || 'ACE Web Experts',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setupBatch.set(doc(db, 'admins', user.uid), {
        uid: user.uid,
        email: user.email || '',
        createdAt: serverTimestamp(),
      });
      setupBatch.set(doc(db, 'roles', user.uid), {
        uid: user.uid,
        email: user.email || '',
        role: 'super_admin',
        departmentId: deptId,
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setupBatch.set(doc(db, 'users', user.uid), {
        uid: user.uid,
        displayName: fullName.trim() || user.displayName || 'Super Admin',
        email: user.email || '',
        photoURL: user.photoURL || '',
        employeeId: empId,
        emailVerified: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await setupBatch.commit();

      // Provision initial ACE Web Experts structure
      const orgBatch = writeBatch(db);
      const departments = [
        { id: 'dept_exec', name: 'Executive & Leadership', code: 'EXEC', description: 'Executive governance and company strategy' },
        { id: 'dept_eng', name: 'Engineering', code: 'ENG', description: 'Full-stack web and software engineering' },
        { id: 'dept_design', name: 'Design & UX', code: 'DSN', description: 'Product design, UI systems, and research' },
        { id: 'dept_hr', name: 'Human Resources', code: 'HR', description: 'People operations, talent, and payroll' },
        { id: 'dept_ops', name: 'Operations & Growth', code: 'OPS', description: 'Delivery operations and client success' },
      ];
      for (const d of departments) {
        orgBatch.set(doc(db, 'departments', d.id), {
          ...d,
          headUid: d.id === deptId ? user.uid : '',
          headName: d.id === deptId ? fullName.trim() : '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      const designations = [
        { id: 'desig_ceo', title: designation.trim() || 'Chief Executive Officer', departmentId: 'dept_exec', level: 'Executive' },
        { id: 'desig_hr_mgr', title: 'HR Manager', departmentId: 'dept_hr', level: 'Manager' },
        { id: 'desig_eng_lead', title: 'Engineering Manager', departmentId: 'dept_eng', level: 'Manager' },
        { id: 'desig_swe', title: 'Software Engineer', departmentId: 'dept_eng', level: 'Mid-Senior' },
        { id: 'desig_ux', title: 'Product Designer', departmentId: 'dept_design', level: 'Mid-Senior' },
      ];
      for (const des of designations) {
        orgBatch.set(doc(db, 'designations', des.id), {
          ...des,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      orgBatch.set(doc(db, 'settings', 'company'), {
        id: 'company',
        companyName: companyName.trim() || 'ACE Web Experts',
        domain: typeof window !== 'undefined' ? window.location.host : '',
        contactEmail: user.email || '',
        address: 'ACE Web Experts HQ',
        defaultCurrency: currency || 'USD',
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });
      orgBatch.set(doc(db, 'settings', 'workPolicy'), {
        id: 'workPolicy',
        workStartTime: '09:30',
        workEndTime: '18:30',
        lunchStartTime: '13:30',
        lunchEndTime: '14:15',
        graceMinutes: 15,
        breakMinutes: 45,
        halfDayThresholdMinutes: 270,
        lunchTrackingEnabled: true,
        officeTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
        weeklyOffs: ['Saturday', 'Sunday'],
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });
      const currencyMap: Record<string, string> = { USD: '$', INR: '₹', EUR: '€', GBP: '£', AED: 'AED ', CAD: 'CA$' };
      orgBatch.set(doc(db, 'settings', 'payrollConfig'), {
        id: 'payrollConfig',
        currency: currency || 'USD',
        currencySymbol: currencyMap[currency] || '$',
        workingDaysPerMonth: 22,
        overtimeMultiplier: 1.5,
        unpaidLeaveDeductionEnabled: true,
        customRules: [],
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });
      orgBatch.set(doc(db, 'settings', 'leavePolicy'), {
        id: 'leavePolicy',
        casualAnnual: 12,
        sickAnnual: 10,
        paidAnnual: 15,
        emergencyAnnual: 5,
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });

      orgBatch.set(doc(db, 'employees', empId), {
        id: empId,
        uid: user.uid,
        employeeCode: 'ACE-001',
        fullName: fullName.trim() || user.displayName || 'Super Admin',
        avatarUrl: user.photoURL || '',
        email: user.email || '',
        phone: '',
        address: '',
        departmentId: deptId,
        departmentName: 'Executive & Leadership',
        designation: designation.trim() || 'Chief Executive Officer',
        joiningDate: today,
        birthDate: '',
        employmentType: 'full_time',
        reportingManagerUid: '',
        reportingManagerName: '',
        emergencyContactName: '',
        emergencyContactPhone: '',
        emergencyContactRelation: '',
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      orgBatch.set(doc(db, 'directory', empId), {
        id: empId,
        uid: user.uid,
        employeeCode: 'ACE-001',
        fullName: fullName.trim() || user.displayName || 'Super Admin',
        avatarUrl: user.photoURL || '',
        departmentId: deptId,
        departmentName: 'Executive & Leadership',
        designation: designation.trim() || 'Chief Executive Officer',
        joiningDate: today,
        birthMonthDay: '',
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      const annId = makeId('ann');
      orgBatch.set(doc(db, 'announcements', annId), {
        id: annId,
        title: `Welcome to ${companyName.trim() || 'ACE Web Experts'} HRMS`,
        category: 'notice',
        content: 'ACE HRMS is now live for ACE Web Experts. Employees can check in daily, apply for leave, access payslips, and stay up to date with company notices.',
        pinned: true,
        audience: 'company',
        authorUid: user.uid,
        authorName: fullName.trim() || 'Super Admin',
        authorRole: 'super_admin',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await orgBatch.commit();

      try {
        await apiRequest('/api/leaves/ensure-balance', {
          method: 'POST',
          body: JSON.stringify({}),
        });
      } catch {
        // Non-fatal if backend IAM is pending configuration
      }

      await writeAuditLog({
        actorUid: user.uid,
        actorEmail: user.email || '',
        actorRole: 'super_admin',
        action: 'SYSTEM_INITIALIZED',
        targetCollection: 'system',
        targetId: 'setup',
        summary: `Initialized ACE HRMS for ${companyName.trim()} with Super Admin ${user.email}`,
      });

      await hydrateUserSession(user);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'system/setup');
    }
  };

  const effectiveRole: UserRole =
    roleAssignment?.role ||
    (firebaseUser?.email?.toLowerCase() === 'awe.prianshu@gmail.com' && firebaseUser.emailVerified ? 'super_admin' : 'employee');

  const needsEmailVerification = Boolean(firebaseUser && !firebaseUser.emailVerified);
  const isPendingApproval = Boolean(
    firebaseUser &&
      firebaseUser.emailVerified &&
      !needsInitialSetup &&
      roleAssignment?.status === 'pending'
  );
  const isDeactivated = Boolean(
    firebaseUser &&
      firebaseUser.emailVerified &&
      roleAssignment?.status === 'inactive'
  );

  return (
    <AuthContext.Provider
      value={{
        firebaseUser,
        userAccount,
        roleAssignment,
        employeeProfile,
        systemSetup,
        effectiveRole,
        loading,
        needsEmailVerification,
        needsInitialSetup,
        isPendingApproval,
        isDeactivated,
        pendingInvite,
        authActionMode,
        authOobCode,
        mfaEnrolledFactors,
        pendingMfaResolver,
        clearAuthAction,
        clearMfaChallenge,
        loginWithEmail,
        signupWithEmail,
        loginWithGoogle,
        resolveMfaChallenge,
        startTotpEnrollment,
        unenrollMfaFactor,
        sendResetEmail,
        completePasswordReset,
        resendVerification,
        reauthenticateCurrentUser,
        refreshSession,
        logout,
        initializeFirstSuperAdmin,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
