import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type DocumentData,
  type Query,
} from 'firebase/firestore';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import {
  BriefcaseBusiness,
  Clock3,
  FileSpreadsheet,
  Wallet,
  Laptop,
  LifeBuoy,
  ClipboardList,
  Download,
  MessageSquare,
  CheckCircle2,
  X,
} from 'lucide-react';
import { db } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import { makeId, writeAuditLog, dispatchNotification, uploadToStorage } from '../../services/hrmsApi';
import { exportToCsv, exportToXlsx, formatCurrency } from '../../utils/exportUtils';
import { getChartTheme, useThemeMode } from '../../utils/themeUtils';

type OpsTab =
  | 'wfh'
  | 'overtime'
  | 'comp_off'
  | 'timesheets'
  | 'expenses'
  | 'assets'
  | 'helpdesk'
  | 'polls'
  | 'feedback360';

type TicketComment = { authorUid: string; authorName: string; message: string; createdAt: string };
type OpsRecord = {
  id: string;
  uid?: string;
  employeeName?: string;
  departmentId?: string;
  title?: string;
  reason?: string;
  date?: string;
  status?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  [key: string]: unknown;
};

const tabs: { id: OpsTab; label: string; icon: React.ElementType }[] = [
  { id: 'wfh', label: 'Work From Home', icon: BriefcaseBusiness },
  { id: 'overtime', label: 'Overtime', icon: Clock3 },
  { id: 'comp_off', label: 'Comp-Off', icon: Clock3 },
  { id: 'timesheets', label: 'Timesheets', icon: FileSpreadsheet },
  { id: 'expenses', label: 'Expenses', icon: Wallet },
  { id: 'assets', label: 'Assets', icon: Laptop },
  { id: 'helpdesk', label: 'HR Helpdesk', icon: LifeBuoy },
  { id: 'polls', label: 'Polls & Surveys', icon: ClipboardList },
  { id: 'feedback360', label: '360° Feedback', icon: ClipboardList },
];

const orgWideRole = (role: string) => ['super_admin', 'hr_manager'].includes(role);
const managerRole = (role: string) => ['super_admin', 'hr_manager', 'dept_manager', 'team_lead'].includes(role);

const SLA_HOURS_BY_PRIORITY: Record<string, number> = {
  urgent: 4,
  high: 12,
  normal: 24,
  low: 48,
};

export const AdvancedOperationsModule: React.FC = () => {
  const { firebaseUser, employeeProfile, roleAssignment, effectiveRole } = useAuth();
  const { employees, directory, payrollConfig } = useHrmsData();
  const { isLight } = useThemeMode();
  const chartTheme = getChartTheme(isLight);

  const uid = firebaseUser?.uid || '';
  const role = effectiveRole || 'employee';
  const manager = managerRole(role);
  const orgWide = orgWideRole(role);
  const name = employeeProfile?.fullName || firebaseUser?.displayName || 'Employee';
  const departmentId = roleAssignment?.departmentId || employeeProfile?.departmentId || '';

  const [tab, setTab] = useState<OpsTab>('wfh');
  const [rows, setRows] = useState<Record<OpsTab, OpsRecord[]>>({
    wfh: [],
    overtime: [],
    comp_off: [],
    timesheets: [],
    expenses: [],
    assets: [],
    helpdesk: [],
    polls: [],
    feedback360: [],
  });
  const [pollResponses, setPollResponses] = useState<
    Array<{ id: string; pollId: string; uid: string; option: string; departmentId?: string }>
  >([]);
  const [notice, setNotice] = useState('');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [hours, setHours] = useState('1');
  const [compOffAction, setCompOffAction] = useState<'earn' | 'use'>('earn');
  const [compOffDays, setCompOffDays] = useState('0.5');
  const [compOffBalance, setCompOffBalance] = useState(0);

  // Timesheet billing & profitability fields
  const [minutes, setMinutes] = useState('60');
  const [clientName, setClientName] = useState('');
  const [billable, setBillable] = useState(true);
  const [hourlyRate, setHourlyRate] = useState('50');
  const [costRate, setCostRate] = useState('25');

  // Expense fields + reconciliation modal
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(payrollConfig.currency || 'USD');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [reconcileRow, setReconcileRow] = useState<OpsRecord | null>(null);
  const [utrRef, setUtrRef] = useState('');
  const [batchRef, setBatchRef] = useState('');

  // Asset fields + return modal
  const [assetTag, setAssetTag] = useState('');
  const [assetType, setAssetType] = useState('Laptop');
  const [assignee, setAssignee] = useState('');
  const [returnAssetRow, setReturnAssetRow] = useState<OpsRecord | null>(null);
  const [returnCondition, setReturnCondition] = useState<'Good' | 'Damaged' | 'Needs Repair'>('Good');
  const [returnNotes, setReturnNotes] = useState('');

  // Helpdesk priority, SLA, assignee & comments
  const [ticketPriority, setTicketPriority] = useState<'low' | 'normal' | 'high' | 'urgent'>('normal');
  const [commentInputs, setCommentInputs] = useState<Record<string, string>>({});

  // 360 Feedback & Polls
  const [feedbackRecipient, setFeedbackRecipient] = useState('');
  const [feedbackRating, setFeedbackRating] = useState('4');
  const [feedbackType, setFeedbackType] = useState<'peer' | 'manager' | 'direct_report'>('peer');
  const [options, setOptions] = useState('Yes\nNo');
  const [vote, setVote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unsubscribers: (() => void)[] = [];
    const configs: Record<OpsTab, { collection: string; query: Query<DocumentData> }> = {
      wfh: {
        collection: 'wfhRequests',
        query: orgWide
          ? collection(db, 'wfhRequests')
          : manager && departmentId
          ? query(collection(db, 'wfhRequests'), where('departmentId', '==', departmentId))
          : query(collection(db, 'wfhRequests'), where('uid', '==', uid)),
      },
      overtime: {
        collection: 'overtimeRequests',
        query: orgWide
          ? collection(db, 'overtimeRequests')
          : manager && departmentId
          ? query(collection(db, 'overtimeRequests'), where('departmentId', '==', departmentId))
          : query(collection(db, 'overtimeRequests'), where('uid', '==', uid)),
      },
      comp_off: {
        collection: 'compOffRequests',
        query: orgWide
          ? collection(db, 'compOffRequests')
          : manager && departmentId
          ? query(collection(db, 'compOffRequests'), where('departmentId', '==', departmentId))
          : query(collection(db, 'compOffRequests'), where('uid', '==', uid)),
      },
      timesheets: {
        collection: 'timesheets',
        query: orgWide
          ? collection(db, 'timesheets')
          : manager && departmentId
          ? query(collection(db, 'timesheets'), where('departmentId', '==', departmentId))
          : query(collection(db, 'timesheets'), where('uid', '==', uid)),
      },
      expenses: {
        collection: 'expenseClaims',
        query: orgWide
          ? collection(db, 'expenseClaims')
          : manager && departmentId
          ? query(collection(db, 'expenseClaims'), where('departmentId', '==', departmentId))
          : query(collection(db, 'expenseClaims'), where('uid', '==', uid)),
      },
      assets: {
        collection: 'assets',
        query: orgWide ? collection(db, 'assets') : query(collection(db, 'assets'), where('assignedToUid', '==', uid)),
      },
      helpdesk: {
        collection: 'helpdeskTickets',
        query: orgWide
          ? collection(db, 'helpdeskTickets')
          : manager && departmentId
          ? query(collection(db, 'helpdeskTickets'), where('departmentId', '==', departmentId))
          : query(collection(db, 'helpdeskTickets'), where('uid', '==', uid)),
      },
      polls: { collection: 'polls', query: collection(db, 'polls') },
      feedback360: {
        collection: 'feedback360',
        query: orgWide
          ? collection(db, 'feedback360')
          : manager && departmentId
          ? query(collection(db, 'feedback360'), where('departmentId', '==', departmentId))
          : query(collection(db, 'feedback360'), where('recipientUid', '==', uid)),
      },
    };

    const balanceUnsub = uid
      ? onSnapshot(doc(db, 'compOffBalances', uid), (snap) => setCompOffBalance(Number(snap.data()?.availableDays || 0)))
      : () => {};
    unsubscribers.push(balanceUnsub);

    const responseQuery = orgWide
      ? collection(db, 'pollResponses')
      : manager && departmentId
      ? query(collection(db, 'pollResponses'), where('departmentId', '==', departmentId))
      : query(collection(db, 'pollResponses'), where('uid', '==', uid));
    unsubscribers.push(
      onSnapshot(responseQuery, (s) =>
        setPollResponses(
          s.docs.map((d) => ({ id: d.id, ...d.data() } as { id: string; pollId: string; uid: string; option: string; departmentId?: string }))
        )
      )
    );

    (Object.keys(configs) as OpsTab[]).forEach((key) => {
      const config = configs[key];
      unsubscribers.push(
        onSnapshot(config.query, (snap) =>
          setRows((prev) => ({ ...prev, [key]: snap.docs.map((d) => ({ id: d.id, ...d.data() } as OpsRecord)) }))
        )
      );
    });

    return () => unsubscribers.forEach((unsub) => unsub());
  }, [uid, role, departmentId, manager, orgWide]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uid) return;
    setBusy(true);
    setNotice('');
    try {
      const id = makeId(tab);
      const base = {
        id,
        uid,
        employeeName: name,
        departmentId,
        date,
        status: 'pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      let collectionName = 'wfhRequests';
      let payload: Record<string, unknown> = { ...base, reason: detail.trim() };

      if (tab === 'wfh') {
        if (detail.trim().length < 5) throw new Error('Enter a reason for the WFH request (min 5 characters).');
        collectionName = 'wfhRequests';
      }
      if (tab === 'overtime') {
        if (Number(hours) <= 0 || !detail.trim()) throw new Error('Enter overtime hours and reason.');
        collectionName = 'overtimeRequests';
        payload = { ...base, hours: Number(hours), reason: detail.trim(), requestType: 'overtime' };
      }
      if (tab === 'comp_off') {
        if (!detail.trim()) throw new Error('Enter a reason for the Comp-Off request.');
        collectionName = 'compOffRequests';
        payload = { ...base, action: compOffAction, days: Number(compOffDays), reason: detail.trim() };
      }
      if (tab === 'timesheets') {
        if (!title.trim() || Number(minutes) <= 0) throw new Error('Enter project/client and time spent.');
        collectionName = 'timesheets';
        payload = {
          ...base,
          project: title.trim(),
          clientName: clientName.trim() || 'Internal',
          billable,
          hourlyRate: billable ? Number(hourlyRate) || 0 : 0,
          costRate: Number(costRate) || 0,
          description: detail.trim(),
          minutes: Number(minutes),
          status: 'submitted',
        };
      }
      if (tab === 'expenses') {
        if (!title.trim() || Number(amount) <= 0) throw new Error('Enter expense title and a valid amount.');
        collectionName = 'expenseClaims';
        const receiptUrl = receiptFile ? await uploadToStorage(`expenseReceipts/${uid}`, receiptFile) : '';
        payload = {
          ...base,
          title: title.trim(),
          notes: detail.trim(),
          amount: Number(amount),
          currency,
          expenseDate: date,
          ...(receiptUrl ? { receiptUrl, receiptName: receiptFile?.name || '' } : {}),
        };
      }
      if (tab === 'helpdesk') {
        if (!title.trim() || detail.trim().length < 5) throw new Error('Enter a ticket subject and description.');
        collectionName = 'helpdeskTickets';
        payload = {
          ...base,
          title: title.trim(),
          description: detail.trim(),
          priority: ticketPriority,
          slaHours: SLA_HOURS_BY_PRIORITY[ticketPriority] || 24,
          comments: [],
          status: 'open',
        };
      }
      if (tab === 'assets') {
        if (!orgWide || !assetTag.trim() || !assignee) throw new Error('HR/Admin must provide an asset tag and assignee.');
        const emp = employees.find((e) => e.uid === assignee);
        collectionName = 'assets';
        payload = {
          id,
          assetTag: assetTag.trim(),
          assetType,
          title: assetType,
          assignedToUid: assignee,
          assignedToName: emp?.fullName || 'Employee',
          departmentId: emp?.departmentId || '',
          status: 'assigned',
          assignedAt: date,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
      }
      if (tab === 'feedback360') {
        if (!feedbackRecipient || !detail.trim()) throw new Error('Choose an employee and enter feedback.');
        const recipient = directory.find((e) => e.uid === feedbackRecipient);
        if (!recipient) throw new Error('Selected employee is not available.');
        collectionName = 'feedback360';
        payload = {
          id,
          uid,
          employeeName: name,
          departmentId: recipient.departmentId || departmentId || '',
          recipientUid: feedbackRecipient,
          recipientName: recipient.fullName,
          feedbackType,
          rating: Number(feedbackRating),
          strengths: detail.trim(),
          improvementAreas: title.trim(),
          status: 'submitted',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
      }
      if (tab === 'polls') {
        const opts = options.split('\n').map((x) => x.trim()).filter(Boolean);
        if (!orgWide || !title.trim() || opts.length < 2) {
          throw new Error('HR/Admin must provide a poll question and at least two options.');
        }
        collectionName = 'polls';
        payload = {
          id,
          title: title.trim(),
          options: opts,
          active: true,
          createdByUid: uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
      }

      await setDoc(doc(db, collectionName, id), payload);
      await writeAuditLog({
        actorUid: uid,
        actorEmail: firebaseUser?.email || '',
        actorRole: role,
        action: `${tab.toUpperCase()}_CREATED`,
        targetCollection: collectionName,
        targetId: id,
        summary: `Created ${tab} record`,
      });
      setTitle('');
      setDetail('');
      setAmount('');
      setAssetTag('');
      setClientName('');
      setReceiptFile(null);
      setNotice('Saved successfully.');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Unable to save record. Check permissions and try again.');
    } finally {
      setBusy(false);
    }
  };

  const review = async (collectionName: string, row: OpsRecord, status: string) => {
    if (!manager) return;
    const finalStatus = tab === 'helpdesk' ? (status === 'approved' ? 'resolved' : 'in_progress') : status;
    try {
      if (tab === 'comp_off' && finalStatus === 'approved') {
        await runTransaction(db, async (tx) => {
          const balanceRef = doc(db, 'compOffBalances', String(row.uid));
          const requestRef = doc(db, collectionName, row.id);
          const balanceSnap = await tx.get(balanceRef);
          const current = Number(balanceSnap.data()?.availableDays || 0);
          const amt = Number(row.days || 0);
          const next = String(row.action) === 'use' ? current - amt : current + amt;
          if (next < 0) throw new Error('Employee does not have enough Comp-Off balance.');
          tx.set(
            balanceRef,
            { uid: row.uid, employeeName: row.employeeName, departmentId: row.departmentId, availableDays: next, updatedAt: serverTimestamp() },
            { merge: true }
          );
          tx.update(requestRef, { status: finalStatus, reviewedByUid: uid, reviewedAt: serverTimestamp(), updatedAt: serverTimestamp() });
        });
      } else {
        await updateDoc(doc(db, collectionName, row.id), {
          status: finalStatus,
          reviewedByUid: uid,
          reviewedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      if (row.uid) {
        const targetEmp = employees.find((e) => e.uid === String(row.uid));
        await dispatchNotification({
          recipientUid: String(row.uid),
          recipientEmail: targetEmp?.email,
          title: `${collectionName} request ${finalStatus}`,
          message: `Your ${collectionName} request was ${finalStatus}.`,
          type: 'system',
          linkTab: 'advanced_operations',
          sendEmail: Boolean(targetEmp?.email),
        });
      }
      await writeAuditLog({
        actorUid: uid,
        actorEmail: firebaseUser?.email || '',
        actorRole: role,
        action: 'OPS_REQUEST_REVIEWED',
        targetCollection: collectionName,
        targetId: row.id,
        summary: `${status} ${collectionName}`,
      });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Unable to update request.');
    }
  };

  // Expense Payment Reconciliation (HR / Admin on approved claims)
  const submitReconciliation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reconcileRow || !orgWide || !utrRef.trim()) return;
    setBusy(true);
    try {
      await updateDoc(doc(db, 'expenseClaims', reconcileRow.id), {
        status: 'reconciled',
        utrRef: utrRef.trim(),
        batchRef: batchRef.trim() || `BATCH-${new Date().toISOString().slice(0, 10)}`,
        reconciledAt: new Date().toISOString(),
        reconciledByUid: uid,
        updatedAt: serverTimestamp(),
      });
      if (reconcileRow.uid) {
        const targetEmp = employees.find((e) => e.uid === String(reconcileRow.uid));
        await dispatchNotification({
          recipientUid: String(reconcileRow.uid),
          recipientEmail: targetEmp?.email,
          title: 'Expense Claim Paid & Reconciled',
          message: `Your claim "${reconcileRow.title}" has been reconciled (UTR: ${utrRef.trim()}).`,
          type: 'system',
          linkTab: 'advanced_operations',
          sendEmail: Boolean(targetEmp?.email),
        });
      }
      await writeAuditLog({
        actorUid: uid,
        actorEmail: firebaseUser?.email || '',
        actorRole: role,
        action: 'EXPENSE_RECONCILED',
        targetCollection: 'expenseClaims',
        targetId: reconcileRow.id,
        summary: `Reconciled expense ${reconcileRow.title} with UTR ${utrRef.trim()}`,
      });
      setReconcileRow(null);
      setUtrRef('');
      setBatchRef('');
      setNotice('Expense payment reconciled successfully.');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to reconcile expense.');
    } finally {
      setBusy(false);
    }
  };

  // Asset Return with Condition Tracking
  const submitAssetReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!returnAssetRow || !orgWide) return;
    setBusy(true);
    try {
      await updateDoc(doc(db, 'assets', returnAssetRow.id), {
        status: 'returned',
        returnCondition,
        returnNotes: returnNotes.trim(),
        returnedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog({
        actorUid: uid,
        actorEmail: firebaseUser?.email || '',
        actorRole: role,
        action: 'ASSET_RETURNED',
        targetCollection: 'assets',
        targetId: returnAssetRow.id,
        summary: `Returned asset ${returnAssetRow.assetTag} in ${returnCondition} condition`,
      });
      setReturnAssetRow(null);
      setReturnNotes('');
      setNotice('Asset return recorded with condition inspection.');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Unable to return asset.');
    } finally {
      setBusy(false);
    }
  };

  // Helpdesk Assignee & Comments
  const assignHelpdeskTicket = async (row: OpsRecord, assigneeUid: string) => {
    if (!orgWide) return;
    const emp = directory.find((d) => d.uid === assigneeUid);
    try {
      await updateDoc(doc(db, 'helpdeskTickets', row.id), {
        assignedToUid: assigneeUid,
        assignedToName: emp?.fullName || 'HR Assignee',
        status: row.status === 'open' ? 'in_progress' : row.status,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Unable to assign ticket.');
    }
  };

  const postHelpdeskComment = async (row: OpsRecord) => {
    const msg = (commentInputs[row.id] || '').trim();
    if (!msg) return;
    const existingComments = Array.isArray(row.comments) ? (row.comments as TicketComment[]) : [];
    const nextComments: TicketComment[] = [
      ...existingComments,
      { authorUid: uid, authorName: name, message: msg, createdAt: new Date().toISOString() },
    ];
    try {
      await updateDoc(doc(db, 'helpdeskTickets', row.id), {
        comments: nextComments,
        updatedAt: serverTimestamp(),
      });
      setCommentInputs((prev) => ({ ...prev, [row.id]: '' }));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Unable to post comment.');
    }
  };

  const config = useMemo(
    () =>
      ({
        wfh: 'wfhRequests',
        overtime: 'overtimeRequests',
        comp_off: 'compOffRequests',
        timesheets: 'timesheets',
        expenses: 'expenseClaims',
        assets: 'assets',
        helpdesk: 'helpdeskTickets',
        polls: 'polls',
        feedback360: 'feedback360',
      }) as const,
    []
  );

  // Timesheet Client/Project Profitability Aggregation
  const profitabilitySummary = useMemo(() => {
    const map = new Map<string, { project: string; client: string; hours: number; billableRevenue: number; internalCost: number }>();
    rows.timesheets.forEach((t) => {
      const hrs = Number(t.minutes || 0) / 60;
      const client = String(t.clientName || 'Internal');
      const proj = String(t.project || t.title || 'Project');
      const key = `${client}__${proj}`;
      const isBillable = t.billable !== false;
      const hRate = isBillable ? Number(t.hourlyRate || 0) : 0;
      const cRate = Number(t.costRate || 0);
      const prev = map.get(key) || { project: proj, client, hours: 0, billableRevenue: 0, internalCost: 0 };
      prev.hours += hrs;
      prev.billableRevenue += hrs * hRate;
      prev.internalCost += hrs * cRate;
      map.set(key, prev);
    });
    return [...map.values()].map((item) => ({
      ...item,
      hours: Number(item.hours.toFixed(2)),
      billableRevenue: Number(item.billableRevenue.toFixed(2)),
      internalCost: Number(item.internalCost.toFixed(2)),
      margin: Number((item.billableRevenue - item.internalCost).toFixed(2)),
    }));
  }, [rows.timesheets]);

  // Asset Catalog Stats
  const assetStats = useMemo(() => {
    const total = rows.assets.length;
    const assigned = rows.assets.filter((a) => a.status === 'assigned').length;
    const returned = rows.assets.filter((a) => a.status === 'returned').length;
    return { total, assigned, returned };
  }, [rows.assets]);

  const activeHeadcount = Math.max(1, directory.filter((d) => d.status === 'active').length);
  const currentRows = rows[tab] || [];
  const canCreate = (tab !== 'assets' && tab !== 'polls') || orgWide;

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs uppercase tracking-widest text-[#FF8B5B] font-semibold">Extended people operations</p>
        <h1 className="font-display text-2xl font-bold text-[#FFFFFF] mt-1">Advanced Operations</h1>
        <p className="text-sm text-[#A1A1AA] mt-1">
          WFH, overtime, comp-off, client billing timesheets, expense reconciliation, IT assets, HR helpdesk SLA, and survey analytics.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {tabs.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs transition-colors ${
                tab === item.id
                  ? 'bg-[#FF4634]/15 border-[#FF6A33] text-[#FFFFFF] font-semibold'
                  : 'bg-[#151922] border-[#343A46] text-[#D1D5DB] hover:text-[#FFFFFF]'
              }`}
            >
              <Icon size={14} />
              {item.label}
            </button>
          );
        })}
      </div>

      {notice && (
        <div role="status" className="rounded-xl border border-[#FF6A33]/30 bg-[#FF6A33]/10 p-3 text-sm text-[#FFD0B8]">
          {notice}
        </div>
      )}

      {canCreate && (
        <form onSubmit={submit} className="rounded-2xl border border-[#343A46] bg-[#151922] p-5 grid md:grid-cols-2 gap-3">
          <h2 className="md:col-span-2 font-semibold text-[#FFFFFF]">Create {tabs.find((x) => x.id === tab)?.label} entry</h2>

          {tab === 'wfh' && (
            <>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
              <textarea value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Reason / work plan" className="md:col-span-2 rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
            </>
          )}

          {tab === 'overtime' && (
            <>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
              <input type="number" min="0.5" max="24" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="Hours" className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
              <textarea value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Reason / project" className="md:col-span-2 rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
            </>
          )}

          {tab === 'comp_off' && (
            <>
              <div className="text-sm text-[#A1A1AA]">
                Available Comp-Off balance: <b className="text-[#FFFFFF]">{compOffBalance.toFixed(2)} day(s)</b>
              </div>
              <select value={compOffAction} onChange={(e) => setCompOffAction(e.target.value as 'earn' | 'use')} className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]">
                <option value="earn">Request Comp-Off credit</option>
                <option value="use">Request Comp-Off leave</option>
              </select>
              <select value={compOffDays} onChange={(e) => setCompOffDays(e.target.value)} className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]">
                <option value="0.5">0.5 day</option>
                <option value="1">1 day</option>
                <option value="1.5">1.5 days</option>
                <option value="2">2 days</option>
              </select>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
              <textarea value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Reason / supporting details" className="md:col-span-2 rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
            </>
          )}

          {tab === 'timesheets' && (
            <>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Project name" className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
              <input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Client name (or Internal)" className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
              <input type="number" min="1" max="1440" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="Minutes spent" className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
              <div className="flex items-center gap-3 px-2">
                <label className="inline-flex items-center gap-2 text-xs text-[#D4D4D8] cursor-pointer">
                  <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} className="accent-[#FF4634]" />
                  <span>Billable to client</span>
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  disabled={!billable}
                  value={hourlyRate}
                  onChange={(e) => setHourlyRate(e.target.value)}
                  placeholder="Bill Rate / hr"
                  className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF] disabled:opacity-50"
                />
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={costRate}
                  onChange={(e) => setCostRate(e.target.value)}
                  placeholder="Cost Rate / hr"
                  className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]"
                />
              </div>
              <textarea value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Work description" className="md:col-span-2 rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
            </>
          )}

          {tab === 'expenses' && (
            <>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Expense title" className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
              <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]">
                <option>USD</option>
                <option>INR</option>
                <option>NZD</option>
                <option>AUD</option>
                <option>GBP</option>
              </select>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
              <textarea value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Expense notes" className="md:col-span-2 rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
              <input type="file" accept="image/*,.pdf" onChange={(e) => setReceiptFile(e.target.files?.[0] || null)} className="md:col-span-2 text-xs text-[#A1A1AA]" />
            </>
          )}

          {tab === 'helpdesk' && (
            <>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ticket subject" className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
              <select value={ticketPriority} onChange={(e) => setTicketPriority(e.target.value as typeof ticketPriority)} className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]">
                <option value="low">Low Priority (48h SLA)</option>
                <option value="normal">Normal Priority (24h SLA)</option>
                <option value="high">High Priority (12h SLA)</option>
                <option value="urgent">Urgent Priority (4h SLA)</option>
              </select>
              <textarea value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Describe your HR query" className="md:col-span-2 rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
            </>
          )}

          {tab === 'assets' && orgWide && (
            <>
              <input value={assetTag} onChange={(e) => setAssetTag(e.target.value)} placeholder="Asset tag / serial number" className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
              <select value={assetType} onChange={(e) => setAssetType(e.target.value)} className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]">
                <option>Laptop</option>
                <option>Desktop</option>
                <option>Monitor</option>
                <option>Phone</option>
                <option>Account / Software</option>
                <option>Other</option>
              </select>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="md:col-span-2 rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]">
                <option value="">Assign to employee</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.uid || ''}>{e.fullName}</option>
                ))}
              </select>
            </>
          )}

          {tab === 'feedback360' && (
            <>
              <select value={feedbackRecipient} onChange={(e) => setFeedbackRecipient(e.target.value)} className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]">
                <option value="">Select employee to review</option>
                {directory.filter((e) => e.uid && e.uid !== uid).map((e) => (
                  <option key={e.id} value={e.uid}>{e.fullName} · {e.designation}</option>
                ))}
              </select>
              <select value={feedbackType} onChange={(e) => setFeedbackType(e.target.value as 'peer' | 'manager' | 'direct_report')} className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]">
                <option value="peer">Peer feedback</option>
                <option value="manager">Manager feedback</option>
                <option value="direct_report">Direct report feedback</option>
              </select>
              <select value={feedbackRating} onChange={(e) => setFeedbackRating(e.target.value)} className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]">
                <option value="5">5 – Excellent</option>
                <option value="4">4 – Strong</option>
                <option value="3">3 – Meets expectations</option>
                <option value="2">2 – Needs improvement</option>
                <option value="1">1 – Unsatisfactory</option>
              </select>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Development / improvement areas" className="md:col-span-2 rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
              <textarea value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Strengths and examples" className="md:col-span-2 rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
            </>
          )}

          {tab === 'polls' && orgWide && (
            <>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Poll / survey question" className="rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
              <textarea value={options} onChange={(e) => setOptions(e.target.value)} placeholder="One option per line" className="md:col-span-2 rounded-xl bg-[#0B0D12] border border-[#343A46] p-3 text-sm text-[#FFFFFF]" />
            </>
          )}

          <button disabled={busy} className="ace-btn-primary md:col-span-2 justify-self-start rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-50">
            {busy ? 'Saving…' : 'Save entry'}
          </button>
        </form>
      )}

      {/* Phase 2: Timesheet Client Billing & Profitability Summary */}
      {tab === 'timesheets' && profitabilitySummary.length > 0 && (
        <section className="rounded-2xl border border-[#343A46] bg-[#151922] p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-[#FFFFFF]">Client & Project Billing Profitability</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  exportToCsv(
                    'ace_timesheet_profitability',
                    ['Client', 'Project', 'Hours', 'Billable Revenue', 'Internal Cost', 'Margin'],
                    profitabilitySummary.map((r) => [r.client, r.project, r.hours, r.billableRevenue, r.internalCost, r.margin])
                  )
                }
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#0B0D12] border border-[#292D36] text-xs text-[#FFFFFF]"
              >
                <Download size={12} /> CSV
              </button>
              <button
                type="button"
                onClick={() =>
                  void exportToXlsx(
                    'ace_timesheet_profitability',
                    ['Client', 'Project', 'Hours', 'Billable Revenue', 'Internal Cost', 'Margin'],
                    profitabilitySummary.map((r) => [r.client, r.project, r.hours, r.billableRevenue, r.internalCost, r.margin]),
                    'Profitability'
                  )
                }
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#0B0D12] border border-[#292D36] text-xs text-[#FFFFFF]"
              >
                <FileSpreadsheet size={12} className="text-emerald-400" /> XLSX
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                  <th className="px-3 py-2 text-left">Client</th>
                  <th className="px-3 py-2 text-left">Project</th>
                  <th className="px-3 py-2 text-right">Hours</th>
                  <th className="px-3 py-2 text-right">Billable Value</th>
                  <th className="px-3 py-2 text-right">Internal Cost</th>
                  <th className="px-3 py-2 text-right">Margin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#292D36]/70">
                {profitabilitySummary.map((item) => (
                  <tr key={`${item.client}-${item.project}`}>
                    <td className="px-3 py-2 text-[#A1A1AA]">{item.client}</td>
                    <td className="px-3 py-2 text-[#FFFFFF] font-medium">{item.project}</td>
                    <td className="px-3 py-2 text-right font-mono text-[#FFFFFF]">{item.hours}h</td>
                    <td className="px-3 py-2 text-right font-mono text-emerald-400">
                      {formatCurrency(item.billableRevenue, payrollConfig.currency)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-amber-400">
                      {formatCurrency(item.internalCost, payrollConfig.currency)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-semibold text-[#FFFFFF]">
                      {formatCurrency(item.margin, payrollConfig.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Phase 3: Asset Catalog Stats */}
      {tab === 'assets' && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-[#343A46] bg-[#151922] p-3.5">
            <div className="text-xs text-[#A1A1AA]">Total Assets</div>
            <div className="text-xl font-bold text-[#FFFFFF] mt-1">{assetStats.total}</div>
          </div>
          <div className="rounded-xl border border-[#343A46] bg-[#151922] p-3.5">
            <div className="text-xs text-[#A1A1AA]">Currently Assigned</div>
            <div className="text-xl font-bold text-amber-400 mt-1">{assetStats.assigned}</div>
          </div>
          <div className="rounded-xl border border-[#343A46] bg-[#151922] p-3.5">
            <div className="text-xs text-[#A1A1AA]">Returned</div>
            <div className="text-xl font-bold text-emerald-400 mt-1">{assetStats.returned}</div>
          </div>
        </div>
      )}

      {/* Records List + Actions */}
      <section className="rounded-2xl border border-[#343A46] bg-[#151922] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h2 className="font-semibold text-[#FFFFFF]">{tabs.find((x) => x.id === tab)?.label} records</h2>
          {tab === 'expenses' && currentRows.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  exportToCsv(
                    'ace_expense_reconciliation',
                    ['Date', 'Employee', 'Title', 'Amount', 'Currency', 'Status', 'UTR Ref', 'Batch Ref'],
                    currentRows.map((r) => [
                      String(r.expenseDate || r.date || ''),
                      String(r.employeeName || ''),
                      String(r.title || ''),
                      Number(r.amount || 0),
                      String(r.currency || 'USD'),
                      String(r.status || ''),
                      String(r.utrRef || ''),
                      String(r.batchRef || ''),
                    ])
                  )
                }
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#0B0D12] border border-[#292D36] text-xs text-[#FFFFFF]"
              >
                <Download size={12} /> CSV
              </button>
              <button
                type="button"
                onClick={() =>
                  void exportToXlsx(
                    'ace_expense_reconciliation',
                    ['Date', 'Employee', 'Title', 'Amount', 'Currency', 'Status', 'UTR Ref', 'Batch Ref'],
                    currentRows.map((r) => [
                      String(r.expenseDate || r.date || ''),
                      String(r.employeeName || ''),
                      String(r.title || ''),
                      Number(r.amount || 0),
                      String(r.currency || 'USD'),
                      String(r.status || ''),
                      String(r.utrRef || ''),
                      String(r.batchRef || ''),
                    ]),
                    'Expenses'
                  )
                }
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#0B0D12] border border-[#292D36] text-xs text-[#FFFFFF]"
              >
                <FileSpreadsheet size={12} className="text-emerald-400" /> XLSX
              </button>
            </div>
          )}
        </div>

        <div className="space-y-3">
          {currentRows.map((row) => {
            const ticketComments = Array.isArray(row.comments) ? (row.comments as TicketComment[]) : [];
            const pollOpts = Array.isArray(row.options) ? (row.options as string[]) : [];
            const pollCountMap = pollOpts.map((opt) => ({
              option: String(opt),
              votes: pollResponses.filter((r) => r.pollId === row.id && r.option === opt).length,
            }));
            const uniquePollVoters = new Set(pollResponses.filter((r) => r.pollId === row.id).map((r) => r.uid)).size;
            const participationPct = Math.min(100, Math.round((uniquePollVoters / activeHeadcount) * 100));

            return (
              <div key={row.id} className="rounded-xl border border-[#343A46] p-3.5 space-y-2.5">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-sm text-[#FFFFFF]">
                        {String(row.title || row.project || row.assetTag || row.employeeName || 'Entry')}
                      </span>
                      {tab === 'helpdesk' && typeof row.priority === 'string' && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-[#FF6A33]/15 text-[#FF8B5B]">
                          {row.priority} · SLA {Number(row.slaHours || SLA_HOURS_BY_PRIORITY[row.priority] || 24)}h
                        </span>
                      )}
                      {tab === 'timesheets' && typeof row.clientName === 'string' && row.clientName && (
                        <span className="px-2 py-0.5 rounded text-[10px] bg-[#0B0D12] border border-[#292D36] text-[#A1A1AA]">
                          {row.clientName} · {row.billable !== false ? 'Billable' : 'Non-billable'}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-[#A1A1AA] mt-1">
                      {String(row.employeeName || row.assignedToName || '')} · {String(row.date || row.expenseDate || row.assignedAt || '')} · Status:{' '}
                      <b className="text-[#FFFFFF] capitalize">{String(row.status || '')}</b>
                      {typeof row.assignedToName === 'string' && row.assignedToName && tab === 'helpdesk' && (
                        <span> · Assigned to {row.assignedToName}</span>
                      )}
                      {typeof row.utrRef === 'string' && row.utrRef && (
                        <span className="text-emerald-400"> · UTR: {row.utrRef} ({String(row.batchRef || '')})</span>
                      )}
                      {typeof row.returnCondition === 'string' && row.returnCondition && (
                        <span className="text-amber-400"> · Return Condition: {row.returnCondition}</span>
                      )}
                    </div>
                    <div className="text-xs text-[#D1D5DB] mt-1 line-clamp-2">
                      {String(row.reason || row.description || row.notes || row.strengths || '')}
                    </div>
                    {typeof row.receiptUrl === 'string' && row.receiptUrl && (
                      <a href={row.receiptUrl} target="_blank" rel="noreferrer" className="text-xs text-[#FF9A65] underline mt-1 inline-block">
                        View receipt
                      </a>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {orgWide && tab === 'assets' && row.status === 'assigned' && (
                      <button
                        type="button"
                        onClick={() => {
                          setReturnAssetRow(row);
                          setReturnCondition('Good');
                          setReturnNotes('');
                        }}
                        className="rounded-lg bg-amber-600/20 border border-amber-500/30 text-amber-300 px-3 py-1.5 text-xs font-medium hover:bg-amber-600/30"
                      >
                        Record Return
                      </button>
                    )}

                    {orgWide && tab === 'expenses' && row.status === 'approved' && (
                      <button
                        type="button"
                        onClick={() => {
                          setReconcileRow(row);
                          setUtrRef('');
                          setBatchRef('');
                        }}
                        className="rounded-lg bg-emerald-600/20 border border-emerald-500/30 text-emerald-300 px-3 py-1.5 text-xs font-medium hover:bg-emerald-600/30"
                      >
                        Reconcile Payment
                      </button>
                    )}

                    {orgWide && tab === 'helpdesk' && row.status !== 'resolved' && row.status !== 'closed' && (
                      <select
                        value={String(row.assignedToUid || '')}
                        onChange={(e) => void assignHelpdeskTicket(row, e.target.value)}
                        className="rounded-lg bg-[#0B0D12] border border-[#292D36] px-2.5 py-1.5 text-xs text-[#FFFFFF]"
                      >
                        <option value="">Assign handler…</option>
                        {directory.filter((d) => d.uid).map((d) => (
                          <option key={d.id} value={d.uid}>{d.fullName}</option>
                        ))}
                      </select>
                    )}

                    {manager && ['pending', 'submitted', 'open', 'in_progress'].includes(String(row.status)) && tab !== 'assets' && tab !== 'polls' && tab !== 'feedback360' && (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void review(config[tab], row, 'approved')}
                          className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs text-white font-medium"
                        >
                          {tab === 'helpdesk' ? 'Resolve' : 'Approve'}
                        </button>
                        {row.status !== 'in_progress' && (
                          <button
                            type="button"
                            onClick={() => void review(config[tab], row, 'rejected')}
                            className="rounded-lg bg-red-700 px-3 py-1.5 text-xs text-white font-medium"
                          >
                            {tab === 'helpdesk' ? 'In Progress' : 'Reject'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Helpdesk Threaded Comments */}
                {tab === 'helpdesk' && (
                  <div className="pt-2 border-t border-[#292D36]/70 space-y-2">
                    {ticketComments.length > 0 && (
                      <div className="space-y-1.5 pl-3 border-l-2 border-[#292D36]">
                        {ticketComments.map((c, idx) => (
                          <div key={idx} className="text-xs text-[#D4D4D8]">
                            <b className="text-[#FFFFFF]">{c.authorName}:</b> {c.message}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <input
                        value={commentInputs[row.id] || ''}
                        onChange={(e) => setCommentInputs((prev) => ({ ...prev, [row.id]: e.target.value }))}
                        placeholder="Add comment or update…"
                        className="flex-1 rounded-lg bg-[#0B0D12] border border-[#292D36] px-3 py-1.5 text-xs text-[#FFFFFF]"
                      />
                      <button
                        type="button"
                        onClick={() => void postHelpdeskComment(row)}
                        className="inline-flex items-center gap-1 rounded-lg bg-[#1B1F28] border border-[#292D36] px-3 py-1.5 text-xs text-[#FFFFFF] hover:border-[#FF4634]/50"
                      >
                        <MessageSquare size={12} /> Reply
                      </button>
                    </div>
                  </div>
                )}

                {/* Poll Voting + Survey Analytics */}
                {tab === 'polls' && (
                  <div className="space-y-3 pt-2 border-t border-[#292D36]/70">
                    <div className="flex flex-wrap gap-2">
                      {pollOpts.map((option) => (
                        <button
                          key={String(option)}
                          type="button"
                          onClick={() => setVote((v) => ({ ...v, [row.id]: String(option) }))}
                          className={`rounded-lg border px-3 py-1.5 text-xs ${
                            vote[row.id] === option
                              ? 'border-[#FF6A33] bg-[#FF6A33]/10 text-[#FFFFFF]'
                              : 'border-[#343A46] text-[#D1D5DB]'
                          }`}
                        >
                          {String(option)}
                        </button>
                      ))}
                      {vote[row.id] && (
                        <button
                          type="button"
                          onClick={async () => {
                            const responseId = `${row.id}_${uid}`.slice(0, 128);
                            await setDoc(doc(db, 'pollResponses', responseId), {
                              id: responseId,
                              pollId: row.id,
                              uid,
                              employeeName: name,
                              departmentId,
                              option: vote[row.id],
                              createdAt: serverTimestamp(),
                            });
                            setVote((v) => ({ ...v, [row.id]: '' }));
                          }}
                          className="ace-btn-primary rounded-lg px-3 py-1.5 text-xs font-semibold"
                        >
                          Submit vote
                        </button>
                      )}
                    </div>

                    {manager && (
                      <div className="rounded-xl bg-[#0B0D12] border border-[#292D36] p-3 space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-[#A1A1AA]">
                            Participation: <b className="text-[#FFFFFF]">{uniquePollVoters}</b> / {activeHeadcount} ({participationPct}%)
                          </span>
                          <span className="text-[11px] text-[#A1A1AA]">
                            {pollCountMap.map((m) => `${m.option}: ${m.votes}`).join(' · ')}
                          </span>
                        </div>
                        <div className="h-32 w-full">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={pollCountMap}>
                              <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} />
                              <XAxis dataKey="option" stroke={chartTheme.axisStroke} tick={{ fill: chartTheme.tickFill, fontSize: 11 }} />
                              <YAxis stroke={chartTheme.axisStroke} tick={{ fill: chartTheme.tickFill, fontSize: 11 }} allowDecimals={false} />
                              <Tooltip
                                cursor={{ fill: chartTheme.cursorFill }}
                                contentStyle={{
                                  backgroundColor: chartTheme.tooltipBg,
                                  borderColor: chartTheme.tooltipBorder,
                                  borderRadius: '8px',
                                  color: chartTheme.tooltipText,
                                }}
                              />
                              <Bar dataKey="votes" name="Votes" fill="#FF4634" radius={[4, 4, 0, 0]} />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {!currentRows.length && <p className="text-sm text-[#A1A1AA]">No records yet.</p>}
      </section>

      {/* Expense Reconciliation Modal */}
      {reconcileRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setReconcileRow(null)} />
          <form onSubmit={submitReconciliation} className="relative z-10 w-full max-w-md bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#FFFFFF]">Reconcile Expense Payment</h3>
              <button type="button" onClick={() => setReconcileRow(null)} className="text-[#A1A1AA] hover:text-[#FFFFFF]">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[#A1A1AA]">
              {String(reconcileRow.employeeName)} · {String(reconcileRow.title)} ·{' '}
              <b className="text-[#FFFFFF]">
                {formatCurrency(Number(reconcileRow.amount || 0), String(reconcileRow.currency || 'USD'))}
              </b>
            </p>
            <div>
              <label className="block text-[#A1A1AA] mb-1">Bank UTR / Transaction Reference *</label>
              <input
                type="text"
                required
                value={utrRef}
                onChange={(e) => setUtrRef(e.target.value)}
                placeholder="e.g., UTR2026112300192"
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono"
              />
            </div>
            <div>
              <label className="block text-[#A1A1AA] mb-1">Disbursement Batch Reference</label>
              <input
                type="text"
                value={batchRef}
                onChange={(e) => setBatchRef(e.target.value)}
                placeholder="e.g., BATCH-NOV-2026"
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setReconcileRow(null)} className="px-4 py-2 border border-[#292D36] rounded-xl text-[#A1A1AA]">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="ace-btn-primary inline-flex items-center gap-1.5 px-4 py-2 rounded-xl font-semibold">
                <CheckCircle2 className="w-3.5 h-3.5" /> Mark Reconciled
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Asset Return Inspection Modal */}
      {returnAssetRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setReturnAssetRow(null)} />
          <form onSubmit={submitAssetReturn} className="relative z-10 w-full max-w-md bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#FFFFFF]">Record Asset Return</h3>
              <button type="button" onClick={() => setReturnAssetRow(null)} className="text-[#A1A1AA] hover:text-[#FFFFFF]">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[#A1A1AA]">
              Asset: <b className="text-[#FFFFFF]">{String(returnAssetRow.assetTag)}</b> ({String(returnAssetRow.assetType || returnAssetRow.title)}) · Assigned to{' '}
              <b className="text-[#FFFFFF]">{String(returnAssetRow.assignedToName)}</b>
            </p>
            <div>
              <label className="block text-[#A1A1AA] mb-1">Return Condition</label>
              <select
                value={returnCondition}
                onChange={(e) => setReturnCondition(e.target.value as typeof returnCondition)}
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]"
              >
                <option value="Good">Good</option>
                <option value="Needs Repair">Needs Repair</option>
                <option value="Damaged">Damaged</option>
              </select>
            </div>
            <div>
              <label className="block text-[#A1A1AA] mb-1">Inspection Notes</label>
              <textarea
                rows={3}
                value={returnNotes}
                onChange={(e) => setReturnNotes(e.target.value)}
                placeholder="Charger included, screen intact, serial verified..."
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setReturnAssetRow(null)} className="px-4 py-2 border border-[#292D36] rounded-xl text-[#A1A1AA]">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="ace-btn-primary px-4 py-2 rounded-xl font-semibold">
                Confirm Return
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
