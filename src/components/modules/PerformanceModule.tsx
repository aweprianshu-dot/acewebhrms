import React, { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, query, setDoc, updateDoc, where, serverTimestamp } from 'firebase/firestore';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Target, Star, Plus, BellRing, CheckCircle2, CalendarRange, FileSpreadsheet, Users } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import { dispatchNotification, makeId } from '../../services/hrmsApi';
import { exportToXlsx } from '../../utils/exportUtils';
import { getChartTheme, useThemeMode } from '../../utils/themeUtils';
import { isHrOrAdmin, isManagementRole } from '../../utils/workflowUtils';
import type { PerformanceGoal, ReviewCycle } from '../../types/hrms';

interface PerformanceModuleProps {
  initialSubTab?: 'goals' | 'reviews' | 'cycles' | 'productivity';
}

interface Feedback360Entry {
  id: string;
  uid: string;
  recipientUid: string;
  recipientName: string;
  departmentId: string;
  feedbackType: 'peer' | 'manager' | 'direct_report';
  rating: number;
}

export const PerformanceModule: React.FC<PerformanceModuleProps> = ({ initialSubTab = 'goals' }) => {
  const { firebaseUser, employeeProfile, roleAssignment, effectiveRole } = useAuth();
  const { goals, reviews, employees, reviewCycles } = useHrmsData();
  const { isLight } = useThemeMode();
  const chartTheme = getChartTheme(isLight);

  const uid = firebaseUser?.uid || '';
  const deptId = roleAssignment?.departmentId || employeeProfile?.departmentId || '';
  const isManager = isManagementRole(effectiveRole);
  const isHrAdmin = isHrOrAdmin(effectiveRole);

  const [subTab, setSubTab] = useState<'goals' | 'reviews' | 'cycles' | 'productivity'>(initialSubTab);

  useEffect(() => {
    setSubTab(initialSubTab);
  }, [initialSubTab]);

  const [showGoalModal, setShowGoalModal] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [showCycleModal, setShowCycleModal] = useState(false);
  const [reminderStatus, setReminderStatus] = useState('');

  // 360 Feedback analytics listener (respects security rules)
  const [feedback360, setFeedback360] = useState<Feedback360Entry[]>([]);
  useEffect(() => {
    if (!uid) return;
    const q = isHrAdmin
      ? collection(db, 'feedback360')
      : isManager && deptId
      ? query(collection(db, 'feedback360'), where('departmentId', '==', deptId))
      : query(collection(db, 'feedback360'), where('recipientUid', '==', uid));
    return onSnapshot(
      q,
      (snap) => setFeedback360(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Feedback360Entry))),
      () => {}
    );
  }, [uid, isHrAdmin, isManager, deptId]);

  // Goal form
  const [goalEmpId, setGoalEmpId] = useState('');
  const [goalTitle, setGoalTitle] = useState('');
  const [goalDesc, setGoalDesc] = useState('');
  const [goalDate, setGoalDate] = useState(new Date().toISOString().slice(0, 10));

  // Review form
  const [revEmpId, setRevEmpId] = useState('');
  const [revPeriod, setRevPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [revCycleId, setRevCycleId] = useState('');
  const [kpiScoreMap, setKpiScoreMap] = useState<Record<string, number>>({});
  const [revRating, setRevRating] = useState(4);
  const [revProd, setRevProd] = useState(85);
  const [revAchieve, setRevAchieve] = useState('');
  const [revFeedback, setRevFeedback] = useState('');

  // Cycle form
  const [cycleName, setCycleName] = useState('');
  const [cyclePeriod, setCyclePeriod] = useState(new Date().toISOString().slice(0, 7));
  const [cycleStart, setCycleStart] = useState(new Date().toISOString().slice(0, 10));
  const [cycleEnd, setCycleEnd] = useState(new Date().toISOString().slice(0, 10));
  const [cycleKpisText, setCycleKpisText] = useState('Delivery Quality:40\nTeam Collaboration:30\nGoal Completion:30');

  const selectedCycle = useMemo(
    () => reviewCycles.find((c) => c.id === revCycleId) || null,
    [reviewCycles, revCycleId]
  );

  const computedWeightedScore = useMemo(() => {
    if (!selectedCycle || selectedCycle.kpis.length === 0) return null;
    const totalWeight = selectedCycle.kpis.reduce((s, k) => s + Number(k.weight || 0), 0) || 100;
    const weightedSum = selectedCycle.kpis.reduce((s, k) => {
      const score = Number(kpiScoreMap[k.name] ?? 80);
      return s + score * (Number(k.weight || 0) / totalWeight);
    }, 0);
    return Math.round(weightedSum);
  }, [selectedCycle, kpiScoreMap]);

  const productivityChart = useMemo(() => {
    return reviews.map((r) => ({
      name: `${r.employeeName.split(' ')[0]} (${r.reviewPeriod})`,
      score: r.weightedScore ?? r.productivityScore,
      rating: r.rating * 20,
    }));
  }, [reviews]);

  const feedback360Stats = useMemo(() => {
    const groups: Array<{ type: 'peer' | 'manager' | 'direct_report'; label: string }> = [
      { type: 'peer', label: 'Peer Feedback' },
      { type: 'manager', label: 'Manager Feedback' },
      { type: 'direct_report', label: 'Direct Report Feedback' },
    ];
    return groups.map((g) => {
      const items = feedback360.filter((f) => f.feedbackType === g.type);
      const avg = items.length ? Number((items.reduce((s, x) => s + Number(x.rating || 0), 0) / items.length).toFixed(2)) : 0;
      return { ...g, count: items.length, avg };
    });
  }, [feedback360]);

  const handleCreateGoal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;
    const emp = isManager && goalEmpId ? employees.find((x) => x.id === goalEmpId) : employeeProfile;
    const targetUid = emp?.uid || uid;
    const id = makeId('goal');

    try {
      await setDoc(doc(db, 'goals', id), {
        id,
        uid: targetUid,
        employeeId: emp?.id || uid,
        employeeName: emp?.fullName || firebaseUser.displayName || 'Employee',
        departmentId: emp?.departmentId || 'dept_exec',
        title: goalTitle.trim(),
        description: goalDesc.trim(),
        targetDate: goalDate,
        progress: 0,
        status: 'not_started',
        createdByUid: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setShowGoalModal(false);
      setGoalTitle('');
      setGoalDesc('');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `goals/${id}`);
    }
  };

  const updateGoalProgress = async (g: PerformanceGoal, progress: number) => {
    const status: PerformanceGoal['status'] =
      progress >= 100 ? 'completed' : progress > 0 ? 'in_progress' : 'not_started';
    try {
      await updateDoc(doc(db, 'goals', g.id), {
        progress,
        status,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `goals/${g.id}`);
    }
  };

  const handleCreateReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !isManager) return;
    const emp = employees.find((x) => x.id === revEmpId) || employees[0];
    if (!emp) return;
    const id = makeId('rev');
    const targetUid = emp.uid || emp.id;

    const kpiScores =
      selectedCycle?.kpis.map((k) => ({
        name: k.name,
        weight: k.weight,
        score: Number(kpiScoreMap[k.name] ?? revProd),
      })) || [];

    const finalWeighted = computedWeightedScore ?? Number(revProd);

    try {
      await setDoc(doc(db, 'reviews', id), {
        id,
        uid: targetUid,
        employeeId: emp.id,
        employeeName: emp.fullName,
        departmentId: emp.departmentId,
        reviewerUid: uid,
        reviewerName: employeeProfile?.fullName || firebaseUser.displayName || 'Manager',
        reviewPeriod: revPeriod,
        ...(selectedCycle ? { cycleId: selectedCycle.id, kpiScores, weightedScore: finalWeighted } : {}),
        rating: Number(revRating),
        productivityScore: finalWeighted,
        achievements: revAchieve.trim(),
        feedback: revFeedback.trim(),
        status: 'submitted',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      if (emp.uid) {
        await dispatchNotification({
          recipientUid: emp.uid,
          recipientEmail: emp.email,
          title: `Performance Review Published (${revPeriod})`,
          message: `Your ${revPeriod} monthly performance review (Rating: ${revRating}/5) is ready to view and acknowledge.`,
          type: 'performance',
          linkTab: 'performance',
          sendEmail: Boolean(emp.email),
        });
      }

      setShowReviewModal(false);
      setRevAchieve('');
      setRevFeedback('');
      setRevCycleId('');
      setKpiScoreMap({});
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `reviews/${id}`);
    }
  };

  const handleCreateCycle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !isHrAdmin) return;
    const id = makeId('cycle');
    const parsedKpis = cycleKpisText
      .split('\n')
      .map((line) => {
        const [rawName, rawWeight] = line.split(':');
        return { name: (rawName || '').trim(), weight: Number(rawWeight || 25) };
      })
      .filter((k) => k.name);

    try {
      await setDoc(doc(db, 'reviewCycles', id), {
        id,
        name: cycleName.trim(),
        period: cyclePeriod,
        startDate: cycleStart,
        endDate: cycleEnd,
        status: 'active',
        kpis: parsedKpis.length ? parsedKpis : [{ name: 'Core Execution', weight: 100 }],
        createdByUid: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setShowCycleModal(false);
      setCycleName('');
      setReminderStatus(`Created review cycle "${cycleName.trim()}" with ${parsedKpis.length} weighted KPIs.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `reviewCycles/${id}`);
    }
  };

  const toggleCycleStatus = async (cycle: ReviewCycle) => {
    if (!isHrAdmin) return;
    const nextStatus = cycle.status === 'active' ? 'closed' : 'active';
    try {
      await updateDoc(doc(db, 'reviewCycles', cycle.id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `reviewCycles/${cycle.id}`);
    }
  };

  const acknowledgeReview = async (revId: string) => {
    try {
      await updateDoc(doc(db, 'reviews', revId), {
        status: 'acknowledged',
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `reviews/${revId}`);
    }
  };

  const sendReviewReminders = async () => {
    if (!isManager) return;
    const period = new Date().toISOString().slice(0, 7);
    const reviewedUids = new Set(reviews.filter((r) => r.reviewPeriod === period).map((r) => r.uid));
    const pendingEmps = employees.filter((e) => e.uid && e.status === 'active' && !reviewedUids.has(e.uid));

    for (const emp of pendingEmps) {
      if (emp.uid) {
        await dispatchNotification({
          recipientUid: emp.uid,
          recipientEmail: emp.email,
          title: `Monthly Performance Check-in Reminder (${period})`,
          message: `Please update your monthly goals and achievements ahead of the ${period} review cycle.`,
          type: 'performance',
          linkTab: 'performance',
          sendEmail: Boolean(emp.email),
        });
      }
    }
    setReminderStatus(`Sent review reminders to ${pendingEmps.length} employee(s) for ${period}.`);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#FFFFFF]">
            {subTab === 'goals' ? 'Goals & OKRs' : 'Performance Management'}
          </h1>
          <p className="text-sm text-[#A1A1AA] mt-1">
            Employee goals, weighted KPI review cycles, 360° feedback analytics, and productivity tracking
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isManager && (
            <>
              <button
                type="button"
                onClick={sendReviewReminders}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#151922] border border-[#292D36] text-[#FFFFFF] hover:border-[#FF4634]/50 text-xs rounded-xl transition-colors"
              >
                <BellRing className="w-3.5 h-3.5 text-[#FF6A33]" />
                Send Review Reminders
              </button>
              <button
                type="button"
                onClick={() => {
                  setRevEmpId(employees[0]?.id || '');
                  const activeCycle = reviewCycles.find((c) => c.status === 'active');
                  setRevCycleId(activeCycle?.id || '');
                  setShowReviewModal(true);
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#151922] border border-[#292D36] hover:border-[#FF4634]/50 text-[#FFFFFF] text-xs font-medium rounded-xl transition-colors"
              >
                <Star className="w-3.5 h-3.5 text-amber-400" />
                Add Review
              </button>
            </>
          )}
          {isHrAdmin && (
            <button
              type="button"
              onClick={() => setShowCycleModal(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#151922] border border-[#292D36] hover:border-[#FF4634]/50 text-[#FFFFFF] text-xs font-medium rounded-xl transition-colors"
            >
              <CalendarRange className="w-3.5 h-3.5 text-[#FF6A33]" />
              New Cycle
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setGoalEmpId(employees[0]?.id || '');
              setShowGoalModal(true);
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 ace-btn-primary text-xs font-medium rounded-xl"
          >
            <Plus className="w-3.5 h-3.5" />
            New Goal
          </button>
        </div>
      </div>

      {reminderStatus && (
        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{reminderStatus}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-[#151922] border border-[#292D36] rounded-xl w-fit">
          {[
            { id: 'goals', label: `Goals & OKRs (${goals.length})` },
            { id: 'reviews', label: `Reviews (${reviews.length})` },
            { id: 'cycles', label: `Review Cycles (${reviewCycles.length})` },
            { id: 'productivity', label: 'Productivity & 360°' },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id as typeof subTab)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                subTab === t.id
                  ? 'bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-[#FFFFFF]'
                  : 'text-[#A1A1AA] hover:text-[#FFFFFF]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {reviews.length > 0 && (
          <button
            type="button"
            onClick={() =>
              void exportToXlsx(
                'ace_performance_reviews',
                ['Period', 'Employee', 'Reviewer', 'Rating (/5)', 'Weighted / Productivity %', 'Status', 'Achievements', 'Feedback'],
                reviews.map((r) => [
                  r.reviewPeriod,
                  r.employeeName,
                  r.reviewerName,
                  r.rating,
                  r.weightedScore ?? r.productivityScore,
                  r.status,
                  r.achievements || '',
                  r.feedback || '',
                ]),
                'Reviews'
              )
            }
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#151922] border border-[#292D36] text-[#A1A1AA] hover:text-[#FFFFFF] hover:border-[#FF4634]/50 text-xs rounded-xl transition-colors"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
            Export XLSX
          </button>
        )}
      </div>

      {subTab === 'goals' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {goals.length === 0 ? (
            <div className="col-span-full p-8 text-center bg-[#151922] border border-[#292D36] rounded-2xl text-sm text-[#A1A1AA]">
              No performance goals set yet. Click New Goal to get started.
            </div>
          ) : (
            goals.map((g) => (
              <div key={g.id} className="p-5 bg-[#151922] border border-[#292D36] rounded-2xl space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2 text-xs text-[#A1A1AA]">
                      <Target className="w-3.5 h-3.5 text-[#FF6A33]" />
                      <span>{g.employeeName}</span>
                      <span>·</span>
                      <span className="font-mono">Due {g.targetDate}</span>
                    </div>
                    <h3 className="font-display text-base font-semibold text-[#FFFFFF] mt-1">{g.title}</h3>
                  </div>
                  <span className="font-mono text-sm font-semibold text-[#FF6A33] tabular-nums">{g.progress}%</span>
                </div>
                {g.description && <p className="text-xs text-[#A1A1AA]">{g.description}</p>}
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={g.progress}
                  onChange={(e) => updateGoalProgress(g, Number(e.target.value))}
                  className="w-full accent-[#FF4634] cursor-pointer"
                />
                <div className="flex justify-between text-[11px] text-[#A1A1AA] capitalize">
                  <span>Status: {g.status.replace('_', ' ')}</span>
                  <span>Adjust slider to update progress</span>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {subTab === 'reviews' && (
        <div className="space-y-4">
          {reviews.length === 0 ? (
            <div className="p-8 text-center bg-[#151922] border border-[#292D36] rounded-2xl text-sm text-[#A1A1AA]">
              No monthly performance reviews submitted yet.
            </div>
          ) : (
            reviews.map((r) => (
              <div key={r.id} className="p-5 bg-[#151922] border border-[#292D36] rounded-2xl space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div>
                    <h3 className="font-display text-base font-semibold text-[#FFFFFF]">
                      {r.employeeName} · <span className="font-mono text-[#FF6A33]">{r.reviewPeriod}</span>
                    </h3>
                    <div className="text-xs text-[#A1A1AA] mt-0.5">
                      Reviewed by {r.reviewerName} · Status: <span className="capitalize text-[#FFFFFF]">{r.status}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs font-mono">
                    <span className="text-amber-400">Rating: {r.rating}/5</span>
                    <span className="text-emerald-400">
                      {r.weightedScore !== undefined ? `Weighted KPI: ${r.weightedScore}%` : `Productivity: ${r.productivityScore}%`}
                    </span>
                  </div>
                </div>
                {r.kpiScores && r.kpiScores.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {r.kpiScores.map((k) => (
                      <span
                        key={k.name}
                        className="px-2.5 py-1 rounded-lg bg-[#0B0D12] border border-[#292D36] text-[11px] text-[#D4D4D8]"
                      >
                        {k.name} ({k.weight}%): <b className="text-[#FFFFFF]">{k.score}%</b>
                      </span>
                    ))}
                  </div>
                )}
                {r.achievements && (
                  <div className="text-xs text-[#A1A1AA]">
                    <span className="text-[#FFFFFF] font-medium">Achievements: </span>{r.achievements}
                  </div>
                )}
                {r.feedback && (
                  <div className="text-xs text-[#A1A1AA]">
                    <span className="text-[#FFFFFF] font-medium">Manager Feedback: </span>{r.feedback}
                  </div>
                )}
                {r.uid === uid && r.status === 'submitted' && (
                  <button
                    type="button"
                    onClick={() => acknowledgeReview(r.id)}
                    className="px-3 py-1.5 bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 text-xs font-medium rounded-lg"
                  >
                    Acknowledge Review
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {subTab === 'cycles' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {reviewCycles.length === 0 ? (
            <div className="col-span-full p-8 text-center bg-[#151922] border border-[#292D36] rounded-2xl text-sm text-[#A1A1AA]">
              No appraisal review cycles configured yet. {isHrAdmin ? 'Click New Cycle to define weighted KPIs.' : ''}
            </div>
          ) : (
            reviewCycles.map((c) => (
              <div key={c.id} className="p-5 bg-[#151922] border border-[#292D36] rounded-2xl space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-display text-base font-semibold text-[#FFFFFF]">{c.name}</h3>
                    <p className="text-xs text-[#A1A1AA] font-mono mt-0.5">
                      Period {c.period} · {c.startDate} to {c.endDate}
                    </p>
                  </div>
                  <span
                    className={`px-2 py-1 rounded-md text-[11px] font-semibold capitalize ${
                      c.status === 'active'
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : 'bg-[#1B1F28] text-[#A1A1AA]'
                    }`}
                  >
                    {c.status}
                  </span>
                </div>
                <div className="space-y-1.5">
                  <div className="text-[11px] uppercase tracking-wider text-[#A1A1AA]">Weighted KPIs</div>
                  {c.kpis.map((k) => (
                    <div key={k.name} className="flex items-center justify-between text-xs text-[#D4D4D8] bg-[#0B0D12] px-3 py-1.5 rounded-lg border border-[#292D36]">
                      <span>{k.name}</span>
                      <span className="font-mono text-[#FF6A33] font-semibold">{k.weight}%</span>
                    </div>
                  ))}
                </div>
                {isHrAdmin && (
                  <button
                    type="button"
                    onClick={() => void toggleCycleStatus(c)}
                    className="px-3 py-1.5 bg-[#1B1F28] border border-[#292D36] text-xs text-[#FFFFFF] hover:border-[#FF4634]/50 rounded-lg"
                  >
                    {c.status === 'active' ? 'Close Cycle' : 'Reopen Cycle'}
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {subTab === 'productivity' && (
        <div className="space-y-5">
          {/* Anonymized 360 Feedback Analytics */}
          <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-[#FF6A33]" />
                <h2 className="font-display text-base font-semibold text-[#FFFFFF]">Anonymized 360° Feedback Analytics</h2>
              </div>
              <span className="text-xs text-[#A1A1AA]">{feedback360.length} feedback entry(s) in scope</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {feedback360Stats.map((stat) => (
                <div key={stat.type} className="p-3.5 rounded-xl bg-[#0B0D12] border border-[#292D36]">
                  <div className="text-xs text-[#A1A1AA]">{stat.label}</div>
                  <div className="text-xl font-bold text-[#FFFFFF] mt-1 font-mono">{stat.avg ? `${stat.avg} / 5` : '—'}</div>
                  <div className="text-[11px] text-[#A1A1AA] mt-0.5">{stat.count} aggregated responses</div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-5">
            <h2 className="font-display text-base font-semibold text-[#FFFFFF] mb-4">Productivity & Weighted Score Overview</h2>
            {productivityChart.length === 0 ? (
              <p className="text-xs text-[#A1A1AA]">Submit performance reviews to visualize productivity scores.</p>
            ) : (
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={productivityChart}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} />
                    <XAxis dataKey="name" stroke={chartTheme.axisStroke} tick={{ fill: chartTheme.tickFill, fontSize: 12 }} />
                    <YAxis stroke={chartTheme.axisStroke} tick={{ fill: chartTheme.tickFill, fontSize: 12 }} domain={[0, 100]} />
                    <Tooltip
                      cursor={{ fill: chartTheme.cursorFill }}
                      contentStyle={{
                        backgroundColor: chartTheme.tooltipBg,
                        borderColor: chartTheme.tooltipBorder,
                        borderRadius: '10px',
                        color: chartTheme.tooltipText,
                      }}
                    />
                    <Bar dataKey="score" name="Score %" fill="#FF4634" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Goal Modal */}
      {showGoalModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setShowGoalModal(false)} />
          <form onSubmit={handleCreateGoal} className="relative z-10 w-full max-w-md bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs">
            <h3 className="font-display text-base font-bold text-[#FFFFFF]">Create Performance Goal</h3>
            {isManager && employees.length > 0 && (
              <div>
                <label className="block text-[#A1A1AA] mb-1">Employee</label>
                <select value={goalEmpId} onChange={(e) => setGoalEmpId(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]">
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>{e.fullName}</option>
                  ))}
                </select>
              </div>
            )}
            <input type="text" required placeholder="Goal Title" value={goalTitle} onChange={(e) => setGoalTitle(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]" />
            <textarea rows={3} placeholder="Key deliverables or success criteria" value={goalDesc} onChange={(e) => setGoalDesc(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]" />
            <div>
              <label className="block text-[#A1A1AA] mb-1">Target Date</label>
              <input type="date" required value={goalDate} onChange={(e) => setGoalDate(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]" />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowGoalModal(false)} className="px-4 py-2 border border-[#292D36] rounded-xl text-[#A1A1AA] hover:text-[#FFFFFF]">Cancel</button>
              <button type="submit" className="px-4 py-2 ace-btn-primary font-medium rounded-xl">Save Goal</button>
            </div>
          </form>
        </div>
      )}

      {/* Review Modal */}
      {showReviewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setShowReviewModal(false)} />
          <form onSubmit={handleCreateReview} className="relative z-10 w-full max-w-lg bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs max-h-[90vh] overflow-y-auto">
            <h3 className="font-display text-base font-bold text-[#FFFFFF]">Submit Performance Review</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[#A1A1AA] mb-1">Employee</label>
                <select value={revEmpId} onChange={(e) => setRevEmpId(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]">
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>{e.fullName}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Review Cycle (Optional)</label>
                <select value={revCycleId} onChange={(e) => setRevCycleId(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]">
                  <option value="">Standard Monthly Review</option>
                  {reviewCycles.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.status})</option>
                  ))}
                </select>
              </div>
            </div>

            {selectedCycle && selectedCycle.kpis.length > 0 && (
              <div className="p-3 rounded-xl bg-[#0B0D12] border border-[#292D36] space-y-2">
                <div className="flex items-center justify-between text-[#FFFFFF] font-medium">
                  <span>Cycle Weighted KPIs</span>
                  <span className="font-mono text-[#FF6A33]">Weighted Score: {computedWeightedScore}%</span>
                </div>
                {selectedCycle.kpis.map((k) => (
                  <div key={k.name} className="grid grid-cols-3 items-center gap-2">
                    <span className="col-span-2 text-[#D4D4D8]">{k.name} ({k.weight}%)</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={kpiScoreMap[k.name] ?? 80}
                      onChange={(e) => setKpiScoreMap((prev) => ({ ...prev, [k.name]: Number(e.target.value) }))}
                      className="px-2.5 py-1.5 bg-[#151922] border border-[#292D36] rounded-lg text-[#FFFFFF] font-mono"
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-[#A1A1AA] mb-1">Month</label>
                <input type="month" required value={revPeriod} onChange={(e) => setRevPeriod(e.target.value)} className="w-full px-2.5 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono" />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Rating (1-5)</label>
                <input type="number" min={1} max={5} step="0.5" value={revRating} onChange={(e) => setRevRating(Number(e.target.value))} className="w-full px-2.5 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono" />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Productivity %</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  disabled={computedWeightedScore !== null}
                  value={computedWeightedScore ?? revProd}
                  onChange={(e) => setRevProd(Number(e.target.value))}
                  className="w-full px-2.5 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono disabled:opacity-60"
                />
              </div>
            </div>
            <textarea rows={2} placeholder="Key achievements" value={revAchieve} onChange={(e) => setRevAchieve(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]" />
            <textarea rows={3} required placeholder="Manager feedback" value={revFeedback} onChange={(e) => setRevFeedback(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]" />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowReviewModal(false)} className="px-4 py-2 border border-[#292D36] rounded-xl text-[#A1A1AA] hover:text-[#FFFFFF]">Cancel</button>
              <button type="submit" className="px-4 py-2 ace-btn-primary font-medium rounded-xl">Publish Review</button>
            </div>
          </form>
        </div>
      )}

      {/* New Review Cycle Modal */}
      {showCycleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setShowCycleModal(false)} />
          <form onSubmit={handleCreateCycle} className="relative z-10 w-full max-w-md bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs">
            <h3 className="font-display text-base font-bold text-[#FFFFFF]">Create Review Cycle & Weighted KPIs</h3>
            <input
              type="text"
              required
              placeholder="Cycle Name (e.g., Q4 2026 Appraisal)"
              value={cycleName}
              onChange={(e) => setCycleName(e.target.value)}
              className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF]"
            />
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-[#A1A1AA] mb-1">Period</label>
                <input type="month" required value={cyclePeriod} onChange={(e) => setCyclePeriod(e.target.value)} className="w-full px-2.5 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono" />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">Start Date</label>
                <input type="date" required value={cycleStart} onChange={(e) => setCycleStart(e.target.value)} className="w-full px-2.5 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono" />
              </div>
              <div>
                <label className="block text-[#A1A1AA] mb-1">End Date</label>
                <input type="date" required value={cycleEnd} onChange={(e) => setCycleEnd(e.target.value)} className="w-full px-2.5 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono" />
              </div>
            </div>
            <div>
              <label className="block text-[#A1A1AA] mb-1">KPIs (one per line: Name:Weight)</label>
              <textarea
                rows={4}
                value={cycleKpisText}
                onChange={(e) => setCycleKpisText(e.target.value)}
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-xl text-[#FFFFFF] font-mono"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowCycleModal(false)} className="px-4 py-2 border border-[#292D36] rounded-xl text-[#A1A1AA] hover:text-[#FFFFFF]">Cancel</button>
              <button type="submit" className="px-4 py-2 ace-btn-primary font-medium rounded-xl">Create Cycle</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
