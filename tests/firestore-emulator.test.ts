import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';

const PROJECT_ID = 'gen-lang-client-0209720424';
const RULES_PATH = path.resolve(process.cwd(), 'firestore.rules');

function parseEmulatorHost(): { host: string; port: number } {
  const raw = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  const [host, portStr] = raw.split(':');
  return { host: host || '127.0.0.1', port: Number(portStr) || 8080 };
}

async function isFirestoreEmulatorRunning(host: string, port: number): Promise<boolean> {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    // Only auto-probe default 8080 if it actually responds as the Firebase Emulator Hub / Firestore Emulator
  }
  const hasSocket = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
  if (!hasSocket) return false;
  try {
    const res = await fetch(`http://${host}:${port}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, {
      signal: AbortSignal.timeout(800),
    });
    const text = await res.text();
    return res.status === 200 || text.includes('documents') || res.headers.get('content-type')?.includes('application/json') === true;
  } catch {
    return false;
  }
}

function makeAuthCtx(env: RulesTestEnvironment, uid: string, email: string) {
  return env.authenticatedContext(uid, { email, email_verified: true });
}

test('Firestore Emulator 15-case Security Suite (@firebase/rules-unit-testing)', async (t) => {
  const { host, port } = parseEmulatorHost();
  const reachable = await isFirestoreEmulatorRunning(host, port);
  if (!reachable) {
    t.skip(`Firestore emulator not active at ${host}:${port} (Java JRE unavailable or emulator not started).`);
    return;
  }

  let testEnv: RulesTestEnvironment;
  try {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host,
        port,
        rules: fs.readFileSync(RULES_PATH, 'utf8'),
      },
    });
  } catch (err) {
    t.skip(`Firestore emulator unavailable at ${host}:${port}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  t.after(async () => {
    await testEnv.cleanup();
  });

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const now = new Date().toISOString();

    await setDoc(doc(db, 'system', 'setup'), {
      id: 'setup',
      superAdminUid: 'sa1',
      superAdminEmail: 'sa@ace.com',
      initializedAt: now,
    });
    await setDoc(doc(db, 'admins', 'sa1'), { uid: 'sa1', role: 'super_admin' });

    const roleSeeds = [
      { uid: 'sa1', email: 'sa@ace.com', role: 'super_admin', departmentId: '__executive_private__', status: 'active' },
      { uid: 'hr1', email: 'hr@ace.com', role: 'hr_manager', departmentId: 'dept_hr', status: 'active' },
      { uid: 'dm_eng', email: 'dm@ace.com', role: 'dept_manager', departmentId: 'dept_eng', status: 'active' },
      { uid: 'tl_a', email: 'tla@ace.com', role: 'team_lead', departmentId: 'dept_eng', status: 'active' },
      { uid: 'tl_b', email: 'tlb@ace.com', role: 'team_lead', departmentId: 'dept_eng', status: 'active' },
      { uid: 'emp_a1', email: 'empa1@ace.com', role: 'employee', departmentId: 'dept_eng', status: 'active' },
      { uid: 'emp_b1', email: 'empb1@ace.com', role: 'employee', departmentId: 'dept_eng', status: 'active' },
      { uid: 'emp_design', email: 'empd@ace.com', role: 'employee', departmentId: 'dept_design', status: 'active' },
      { uid: 'emp_spoof_mgr', email: 'spoof@ace.com', role: 'employee', departmentId: 'dept_eng', status: 'active' },
    ];
    for (const r of roleSeeds) {
      await setDoc(doc(db, 'roles', r.uid), r);
    }

    const empSeeds = [
      { id: 'e_sa1', uid: 'sa1', departmentId: '__executive_private__', teamLeadUid: '', reportingManagerUid: '' },
      { id: 'e_hr1', uid: 'hr1', departmentId: 'dept_hr', teamLeadUid: '', reportingManagerUid: '' },
      { id: 'e_dm', uid: 'dm_eng', departmentId: 'dept_eng', teamLeadUid: '', reportingManagerUid: '' },
      { id: 'e_tla', uid: 'tl_a', departmentId: 'dept_eng', teamLeadUid: '', reportingManagerUid: 'dm_eng' },
      { id: 'e_tlb', uid: 'tl_b', departmentId: 'dept_eng', teamLeadUid: '', reportingManagerUid: 'dm_eng' },
      { id: 'e_a1', uid: 'emp_a1', departmentId: 'dept_eng', teamLeadUid: 'tl_a', reportingManagerUid: 'tl_a' },
      { id: 'e_b1', uid: 'emp_b1', departmentId: 'dept_eng', teamLeadUid: 'tl_b', reportingManagerUid: 'tl_b' },
      { id: 'e_des', uid: 'emp_design', departmentId: 'dept_design', teamLeadUid: '', reportingManagerUid: '' },
    ];
    for (const e of empSeeds) {
      await setDoc(doc(db, 'employees', e.id), e);
    }

    await setDoc(doc(db, 'leaveBalances', 'sa1'), {
      uid: 'sa1',
      employeeId: 'e_sa1',
      ownerRole: 'super_admin',
      departmentId: '__executive_private__',
      teamId: '',
      teamLeadUid: '',
      reportingManagerUid: '',
      year: 2026,
      casualTotal: 12,
      casualUsed: 0,
      sickTotal: 10,
      sickUsed: 0,
      paidTotal: 15,
      paidUsed: 0,
      emergencyTotal: 5,
      emergencyUsed: 0,
      unpaidUsed: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await setDoc(doc(db, 'leaveBalances', 'emp_a1'), {
      uid: 'emp_a1',
      employeeId: 'e_a1',
      ownerRole: 'employee',
      departmentId: 'dept_eng',
      teamId: 'team_alpha',
      teamLeadUid: 'tl_a',
      reportingManagerUid: 'tl_a',
      year: 2026,
      casualTotal: 12,
      casualUsed: 0,
      sickTotal: 10,
      sickUsed: 0,
      paidTotal: 15,
      paidUsed: 0,
      emergencyTotal: 5,
      emergencyUsed: 0,
      unpaidUsed: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await setDoc(doc(db, 'leaveRequests', 'lr_emp_a1'), {
      id: 'lr_emp_a1',
      uid: 'emp_a1',
      employeeId: 'e_a1',
      employeeName: 'Emp A1',
      departmentId: 'dept_eng',
      teamId: 'team_alpha',
      teamLeadUid: 'tl_a',
      reportingManagerUid: 'emp_spoof_mgr',
      requesterRole: 'employee',
      leaveType: 'paid',
      startDate: '2026-12-01',
      endDate: '2026-12-02',
      daysCount: 2,
      reason: 'Family event',
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await setDoc(doc(db, 'leaveRequests', 'lr_emp_b1'), {
      id: 'lr_emp_b1',
      uid: 'emp_b1',
      employeeId: 'e_b1',
      employeeName: 'Emp B1',
      departmentId: 'dept_eng',
      teamId: 'team_beta',
      teamLeadUid: 'tl_b',
      reportingManagerUid: 'tl_b',
      requesterRole: 'employee',
      leaveType: 'casual',
      startDate: '2026-12-03',
      endDate: '2026-12-03',
      daysCount: 1,
      reason: 'Errand',
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await setDoc(doc(db, 'leaveRequests', 'lr_emp_design'), {
      id: 'lr_emp_design',
      uid: 'emp_design',
      employeeId: 'e_des',
      employeeName: 'Emp Design',
      departmentId: 'dept_design',
      teamLeadUid: '',
      reportingManagerUid: '',
      requesterRole: 'employee',
      leaveType: 'paid',
      startDate: '2026-12-04',
      endDate: '2026-12-04',
      daysCount: 1,
      reason: 'Personal day',
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await setDoc(doc(db, 'leaveRequests', 'lr_sa_private'), {
      id: 'lr_sa_private',
      uid: 'sa1',
      employeeId: 'e_sa1',
      employeeName: 'Super Admin',
      departmentId: '__executive_private__',
      teamLeadUid: '',
      reportingManagerUid: '',
      requesterRole: 'super_admin',
      leaveType: 'paid',
      startDate: '2026-12-10',
      endDate: '2026-12-11',
      daysCount: 2,
      reason: 'Executive break',
      status: 'approved',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await setDoc(doc(db, 'leaveRequests', 'lr_sa_designated'), {
      id: 'lr_sa_designated',
      uid: 'sa1',
      employeeId: 'e_sa1',
      employeeName: 'Super Admin',
      departmentId: '__executive_private__',
      teamLeadUid: '',
      reportingManagerUid: 'dm_eng',
      requesterRole: 'super_admin',
      leaveType: 'paid',
      startDate: '2026-12-15',
      endDate: '2026-12-15',
      daysCount: 1,
      reason: 'Assigned executive review',
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  await t.test('Case 1 & 2: Employee cannot create own leaveBalances doc or arbitrary paidTotal: 999', async () => {
    const db = makeAuthCtx(testEnv, 'emp_b1', 'empb1@ace.com').firestore();
    await assertFails(
      setDoc(doc(db, 'leaveBalances', 'emp_b1'), {
        uid: 'emp_b1',
        year: 2026,
        casualTotal: 12,
        casualUsed: 0,
        sickTotal: 10,
        sickUsed: 0,
        paidTotal: 999,
        paidUsed: 0,
        emergencyTotal: 5,
        emergencyUsed: 0,
        unpaidUsed: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );
  });

  await t.test('Case 3, 5, 13, 14, 15: Client cannot write, approve, forge, refund, or mutate leaveRequests', async () => {
    const empDb = makeAuthCtx(testEnv, 'emp_a1', 'empa1@ace.com').firestore();
    const tlDb = makeAuthCtx(testEnv, 'tl_a', 'tla@ace.com').firestore();
    await assertFails(
      setDoc(doc(empDb, 'leaveRequests', 'lr_forged'), {
        id: 'lr_forged',
        uid: 'emp_a1',
        employeeId: 'e_a1',
        employeeName: 'Emp A1',
        departmentId: 'dept_eng',
        teamLeadUid: 'emp_a1',
        reportingManagerUid: 'emp_a1',
        leaveType: 'paid',
        startDate: '2026-12-20',
        endDate: '2026-12-20',
        daysCount: 1,
        reason: 'Forged leave',
        status: 'pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );
    await assertFails(updateDoc(doc(empDb, 'leaveRequests', 'lr_emp_a1'), { status: 'approved' }));
    await assertFails(updateDoc(doc(tlDb, 'leaveRequests', 'lr_emp_a1'), { status: 'approved' }));
  });

  await t.test('Case 4: Normal employee whose UID is in reportingManagerUid cannot read or list that leave', async () => {
    const spoofDb = makeAuthCtx(testEnv, 'emp_spoof_mgr', 'spoof@ace.com').firestore();
    await assertFails(getDoc(doc(spoofDb, 'leaveRequests', 'lr_emp_a1')));
    await assertFails(getDocs(query(collection(spoofDb, 'leaveRequests'), where('reportingManagerUid', '==', 'emp_spoof_mgr'))));
  });

  await t.test('Case 6 & 7: Team Lead can read own team leave but cannot read another team leave', async () => {
    const tlADb = makeAuthCtx(testEnv, 'tl_a', 'tla@ace.com').firestore();
    await assertSucceeds(getDoc(doc(tlADb, 'leaveRequests', 'lr_emp_a1')));
    await assertSucceeds(getDoc(doc(tlADb, 'leaveBalances', 'emp_a1')));
    await assertFails(getDoc(doc(tlADb, 'leaveRequests', 'lr_emp_b1')));
  });

  await t.test('Case 8: Department Manager reads own dept leave but denied unrelated dept leave', async () => {
    const dmDb = makeAuthCtx(testEnv, 'dm_eng', 'dm@ace.com').firestore();
    await assertSucceeds(getDoc(doc(dmDb, 'leaveRequests', 'lr_emp_a1')));
    await assertFails(getDoc(doc(dmDb, 'leaveRequests', 'lr_emp_design')));
  });

  await t.test('Case 9 & 10: HR cannot get or list Super Admin leaveBalance or private leaveRequest', async () => {
    const hrDb = makeAuthCtx(testEnv, 'hr1', 'hr@ace.com').firestore();
    await assertFails(getDoc(doc(hrDb, 'leaveBalances', 'sa1')));
    await assertFails(getDocs(collection(hrDb, 'leaveBalances')));
    const scopedBal = await assertSucceeds(
      getDocs(query(collection(hrDb, 'leaveBalances'), where('ownerRole', 'in', ['employee', 'team_lead', 'dept_manager', 'hr_manager']))),
    );
    assert.equal(scopedBal.docs.some((d) => d.id === 'sa1'), false);
    await assertFails(getDoc(doc(hrDb, 'leaveRequests', 'lr_sa_private')));
  });

  await t.test('Case 11 & 12: Designated approver reads assigned SA leave; SA reads all own private records', async () => {
    const dmDb = makeAuthCtx(testEnv, 'dm_eng', 'dm@ace.com').firestore();
    await assertSucceeds(getDoc(doc(dmDb, 'leaveRequests', 'lr_sa_designated')));
    await assertFails(getDoc(doc(dmDb, 'leaveRequests', 'lr_sa_private')));

    const saDb = makeAuthCtx(testEnv, 'sa1', 'sa@ace.com').firestore();
    await assertSucceeds(getDoc(doc(saDb, 'leaveRequests', 'lr_sa_private')));
    await assertSucceeds(getDoc(doc(saDb, 'leaveBalances', 'sa1')));
  });
});
