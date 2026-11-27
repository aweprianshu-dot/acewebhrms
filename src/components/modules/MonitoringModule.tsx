import React, { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { Camera, ShieldCheck, Clock3, Activity, Eye, Download, FileSpreadsheet, X, MonitorCheck } from 'lucide-react';
import { db } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { apiRequest } from '../../services/hrmsApi';
import { exportToCsv, exportToXlsx } from '../../utils/exportUtils';
import { getChartTheme, useThemeMode } from '../../utils/themeUtils';
import { isMonitoringAgentOnline, type MonitoringAgentStatusLike } from '../../utils/monitoringUtils';

type Snapshot = {
  id: string;
  uid: string;
  employeeName: string;
  departmentId: string;
  date: string;
  capturedAt: string;
  activeApp: string;
  windowTitle: string;
  idleSeconds: number;
  activityPercent: number;
};

type AgentStatus = MonitoringAgentStatusLike;

export const MonitoringModule: React.FC = () => {
  const { effectiveRole, employeeProfile, roleAssignment } = useAuth();
  const { isLight } = useThemeMode();
  const chartTheme = getChartTheme(isLight);

  const role = effectiveRole || 'employee';
  const deptId = employeeProfile?.departmentId || roleAssignment?.departmentId || '';
  const canView = ['super_admin', 'hr_manager', 'dept_manager', 'team_lead'].includes(role);
  const isDeptScoped = role === 'dept_manager' || role === 'team_lead';

  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [agentStatuses, setAgentStatuses] = useState<AgentStatus[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [opening, setOpening] = useState<string | null>(null);

  // Inline signed-URL screenshot viewer modal (avoids window.open popup/iframe blocks)
  const [viewerSnapshot, setViewerSnapshot] = useState<Snapshot | null>(null);
  const [viewerUrl, setViewerUrl] = useState<string>('');

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }

    const snapQ =
      isDeptScoped && deptId
        ? query(collection(db, 'monitoringSnapshots'), where('departmentId', '==', deptId))
        : collection(db, 'monitoringSnapshots');

    const statusQ =
      isDeptScoped && deptId
        ? query(collection(db, 'monitoringAgentStatus'), where('departmentId', '==', deptId))
        : collection(db, 'monitoringAgentStatus');

    const unsubSnaps = onSnapshot(
      snapQ,
      (snap) => {
        setSnapshots(
          snap.docs
            .map((d) => ({ id: d.id, ...d.data() } as Snapshot))
            .sort((a, b) => (b.capturedAt || '').localeCompare(a.capturedAt || ''))
        );
        setLoading(false);
        setError('');
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      }
    );

    const unsubStatus = onSnapshot(
      statusQ,
      (snap) => {
        setAgentStatuses(snap.docs.map((d) => ({ uid: d.id, ...d.data() } as AgentStatus)));
      },
      () => {
        // Ignore optional heartbeat listener issues if collection is empty
      }
    );

    return () => {
      unsubSnaps();
      unsubStatus();
    };
  }, [canView, isDeptScoped, deptId]);

  const openSnapshot = async (row: Snapshot) => {
    setOpening(row.id);
    setError('');
    try {
      const result = await apiRequest<{ url: string }>('/api/monitoring/snapshot-url', {
        method: 'POST',
        body: JSON.stringify({ snapshotId: row.id }),
      });
      setViewerSnapshot(row);
      setViewerUrl(result.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load signed screenshot.');
    } finally {
      setOpening(null);
    }
  };

  const visible = useMemo(() => {
    return snapshots.filter((s) => {
      const matchesDate = !dateFilter || s.date === dateFilter;
      const matchesText =
        !filter ||
        `${s.employeeName} ${s.activeApp} ${s.windowTitle} ${s.date}`
          .toLowerCase()
          .includes(filter.toLowerCase());
      return matchesDate && matchesText;
    });
  }, [snapshots, filter, dateFilter]);

  const analytics = useMemo(() => {
    const apps = new Map<string, number>();
    const chronological = [...visible].sort((a, b) => a.uid.localeCompare(b.uid) || new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
    chronological.forEach((sample, index) => {
      const next = chronological[index + 1];
      if (!next || next.uid !== sample.uid || (next.activeApp || 'Unknown') !== (sample.activeApp || 'Unknown')) return;
      const gapSeconds = Math.floor((new Date(next.capturedAt).getTime() - new Date(sample.capturedAt).getTime()) / 1000);
      // Estimate continuity only when two consecutive samples show the same app; never extrapolate across long gaps.
      if (gapSeconds > 0 && gapSeconds <= 15 * 60) {
        const app = sample.activeApp || 'Unknown';
        apps.set(app, (apps.get(app) || 0) + gapSeconds);
      }
    });
    const byDate = new Map<string, { count: number; activitySum: number; idleSeconds: number }>();
    visible.forEach((s) => {
      const day = s.date || (s.capturedAt ? s.capturedAt.slice(0, 10) : 'Unknown');
      const prev = byDate.get(day) || { count: 0, activitySum: 0, idleSeconds: 0 };
      byDate.set(day, {
        count: prev.count + 1,
        activitySum: prev.activitySum + (Number(s.activityPercent) || 0),
        idleSeconds: prev.idleSeconds + (Number(s.idleSeconds) || 0),
      });
    });

    const topApps = [...apps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const avgActivity = visible.length
      ? Math.round(visible.reduce((sum, s) => sum + (Number(s.activityPercent) || 0), 0) / visible.length)
      : 0;
    const totalIdleSeconds = visible.reduce((sum, s) => sum + (Number(s.idleSeconds) || 0), 0);

    const trend = [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-14)
      .map(([date, stats]) => ({
        date: date.slice(5),
        activity: Math.round(stats.activitySum / stats.count),
        idleMinutes: Math.round(stats.idleSeconds / 60),
        samples: stats.count,
      }));

    return { topApps, avgActivity, totalIdleSeconds, trend };
  }, [visible]);

  const exportRows = () =>
    visible.map((s) => [
      s.date,
      new Date(s.capturedAt).toLocaleString(),
      s.employeeName,
      s.activeApp || 'Unknown',
      s.windowTitle || '',
      `${s.activityPercent}%`,
      Math.floor((s.idleSeconds || 0) / 60),
    ]);

  const exportHeaders = ['Date', 'Captured At', 'Employee', 'Active App', 'Window Title', 'Activity %', 'Idle (min)'];

  if (!canView) {
    return (
      <div className="rounded-2xl border border-[#343A46] bg-[#151922] p-6 text-sm text-[#A1A1AA]">
        Only Team Leads, Managers, HR, and Super Admin can view monitoring records.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-widest text-[#FF8B5B] font-semibold">Workplace monitoring</p>
          <h1 className="font-display text-2xl font-bold text-[#FFFFFF] mt-1">Screen Monitoring</h1>
          <p className="text-sm text-[#A1A1AA] mt-1">
            Screenshots are captured at random intervals during checked-in working hours only. Monitoring pauses during recorded breaks.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={visible.length === 0}
            onClick={() => exportToCsv('ace_monitoring_snapshots', exportHeaders, exportRows())}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#151922] border border-[#292D36] text-[#FFFFFF] hover:border-[#FF4634]/40 text-xs rounded-xl disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5 text-[#FF6A33]" />
            Export CSV
          </button>
          <button
            type="button"
            disabled={visible.length === 0}
            onClick={() => void exportToXlsx('ace_monitoring_snapshots', exportHeaders, exportRows(), 'Monitoring')}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#151922] border border-[#292D36] text-[#FFFFFF] hover:border-[#FF4634]/40 text-xs rounded-xl disabled:opacity-50"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
            Export XLSX
          </button>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl border border-[#343A46] bg-[#151922] p-4">
          <Camera className="text-[#FF8B5B]" size={18} />
          <div className="text-xs text-[#A1A1AA] mt-2">Stored screenshots</div>
          <div className="text-xl font-semibold text-[#FFFFFF]">{visible.length}</div>
        </div>
        <div className="rounded-xl border border-[#343A46] bg-[#151922] p-4">
          <MonitorCheck className="text-emerald-400" size={18} />
          <div className="text-xs text-[#A1A1AA] mt-2">Online desktop agents</div>
          <div className="text-xl font-semibold text-[#FFFFFF]">
            {agentStatuses.filter((a) => isMonitoringAgentOnline(a)).length} / {agentStatuses.length}
          </div>
        </div>
        <div className="rounded-xl border border-[#343A46] bg-[#151922] p-4">
          <ShieldCheck className="text-[#FF8B5B]" size={18} />
          <div className="text-xs text-[#A1A1AA] mt-2">Permitted access</div>
          <div className="text-sm font-semibold text-[#FFFFFF] mt-1">
            {isDeptScoped ? 'Department Team Scope' : 'Team Lead / Manager / HR / Admin'}
          </div>
        </div>
        <div className="rounded-xl border border-[#343A46] bg-[#151922] p-4">
          <Clock3 className="text-[#FF8B5B]" size={18} />
          <div className="text-xs text-[#A1A1AA] mt-2">Retention policy</div>
          <div className="text-sm font-semibold text-[#FFFFFF] mt-1">30–90 days auto-purge</div>
        </div>
      </div>

      <section className="rounded-2xl border border-[#343A46] bg-[#151922] p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-[#FFFFFF]">Connected Employees</h2>
            <p className="text-xs text-[#A1A1AA] mt-1">Live agent heartbeat and most recent screenshot for each employee who has connected the agent.</p>
          </div>
          <span className="text-xs text-[#A1A1AA]">{agentStatuses.length} registered agent(s)</span>
        </div>
        {agentStatuses.length ? (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-2">
            {[...agentStatuses].sort((a,b) => (a.employeeName || a.uid).localeCompare(b.employeeName || b.uid)).map((agent) => {
              const online = isMonitoringAgentOnline(agent);
              return (
                <article key={agent.uid} className="rounded-xl border border-[#292D36] bg-[#0B0D12] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-sm text-[#FFFFFF] truncate">{agent.employeeName || 'Employee name unavailable'}</div>
                      <div className="text-[10px] text-[#A1A1AA] truncate">{agent.uid}</div>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${online ? 'bg-emerald-500/10 text-emerald-400' : 'bg-zinc-500/10 text-zinc-400'}`}>
                      {online ? 'ONLINE' : 'OFFLINE'}
                    </span>
                  </div>
                  <div className="mt-3 space-y-1 text-[11px] text-[#A1A1AA]">
                    <div>Last seen: <span className="text-[#D4D4D8]">{agent.lastHeartbeat || agent.lastHeartbeatAt ? new Date(agent.lastHeartbeat || agent.lastHeartbeatAt || '').toLocaleString() : 'Not yet reported'}</span></div>
                    <div>Last screenshot: <span className="text-[#D4D4D8]">{agent.lastScreenshotAt ? new Date(agent.lastScreenshotAt).toLocaleString() : 'No screenshot uploaded yet'}</span></div>
                    <div>Agent state: <span className="text-[#D4D4D8]">{agent.state || 'Unknown'}</span></div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="rounded-xl bg-[#0B0D12] p-4 text-sm text-[#A1A1AA]">No employee agent has sent a heartbeat yet. Sign in to the desktop agent with the employee's verified HRMS account and start it during a checked-in shift.</p>
        )}
      </section>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by employee, app, window title…"
          className="sm:col-span-3 w-full rounded-xl bg-[#151922] border border-[#343A46] p-3 text-sm text-[#FFFFFF] focus:border-[#FF4634] focus:outline-none"
        />
        <input
          type="date"
          value={dateFilter}
          onChange={(e) => setDateFilter(e.target.value)}
          className="w-full rounded-xl bg-[#151922] border border-[#343A46] p-3 text-sm text-[#FFFFFF] font-mono focus:border-[#FF4634] focus:outline-none"
        />
      </div>

      {/* Sampled Productivity Trend & App Summary */}
      <section className="rounded-2xl border border-[#343A46] bg-[#151922] p-5 space-y-4">
        <div>
          <h2 className="font-semibold text-[#FFFFFF] flex items-center gap-2">
            <Activity size={17} className="text-[#FF6A33]" /> Sampled Productivity Trend & App Summary
          </h2>
          <p className="text-xs text-[#A1A1AA] mt-1">
            App time is an estimate only where consecutive samples show the same app (maximum 15-minute gap); this is not continuous recording or a standalone performance score.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-4">
          <div className="rounded-xl bg-[#0B0D12] border border-[#292D36] p-3.5">
            <div className="text-xs text-[#A1A1AA]">Average sampled activity</div>
            <div className="text-2xl font-bold text-[#FFFFFF] mt-1">{analytics.avgActivity}%</div>
          </div>
          <div className="rounded-xl bg-[#0B0D12] border border-[#292D36] p-3.5">
            <div className="text-xs text-[#A1A1AA]">Sampled idle time</div>
            <div className="text-2xl font-bold text-[#FFFFFF] mt-1">{Math.floor(analytics.totalIdleSeconds / 60)}m</div>
          </div>
          <div className="rounded-xl bg-[#0B0D12] border border-[#292D36] p-3.5">
            <div className="text-xs text-[#A1A1AA] mb-1">Top active apps</div>
            {analytics.topApps.length ? (
              analytics.topApps.map(([app, seconds]) => (
                <div key={app} className="flex justify-between text-xs mt-1 text-[#D4D4D8]">
                  <span className="truncate">{app}</span>
                  <b className="text-[#FFFFFF]">{Math.round(seconds / 60)}m est.</b>
                </div>
              ))
            ) : (
              <div className="text-xs text-[#A1A1AA]">No samples yet</div>
            )}
          </div>
        </div>

        {analytics.trend.length > 0 && (
          <div className="h-52 w-full pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={analytics.trend}>
                <defs>
                  <linearGradient id="aceActivityGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#FF4634" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#FF4634" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} />
                <XAxis dataKey="date" stroke={chartTheme.axisStroke} tick={{ fill: chartTheme.tickFill, fontSize: 11 }} />
                <YAxis stroke={chartTheme.axisStroke} tick={{ fill: chartTheme.tickFill, fontSize: 11 }} domain={[0, 100]} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: chartTheme.tooltipBg,
                    borderColor: chartTheme.tooltipBorder,
                    borderRadius: '10px',
                    color: chartTheme.tooltipText,
                    fontSize: '12px',
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="activity"
                  name="Avg Activity %"
                  stroke="#FF4634"
                  strokeWidth={2}
                  fill="url(#aceActivityGrad)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {error && (
        <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-[#A1A1AA]">Loading monitoring records…</p>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-[#343A46] bg-[#151922] p-6 text-sm text-[#A1A1AA]">
          No screenshots match your current filters or team scope.
        </div>
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
          {visible.map((row) => (
            <article key={row.id} className="rounded-2xl border border-[#343A46] bg-[#151922] p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="font-semibold text-sm text-[#FFFFFF]">{row.employeeName}</div>
                  <span className="text-[11px] font-mono text-[#A1A1AA]">{row.date}</span>
                </div>
                <div className="text-xs text-[#FF8B5B] font-medium mt-2">{row.activeApp || 'Unknown app'}</div>
                <p className="text-xs text-[#A1A1AA] mt-1 line-clamp-2">{row.windowTitle || 'No window title captured'}</p>
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <div className="rounded-lg bg-[#0B0D12] border border-[#292D36] p-2">
                    <div className="text-[10px] text-[#A1A1AA]">Activity</div>
                    <div className="text-sm font-semibold text-[#FFFFFF]">{row.activityPercent}%</div>
                  </div>
                  <div className="rounded-lg bg-[#0B0D12] border border-[#292D36] p-2">
                    <div className="text-[10px] text-[#A1A1AA]">Idle</div>
                    <div className="text-sm font-semibold text-[#FFFFFF]">{Math.floor((row.idleSeconds || 0) / 60)}m</div>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between mt-3 pt-2 border-t border-[#292D36]">
                <span className="text-[10px] text-[#A1A1AA]">{new Date(row.capturedAt).toLocaleString()}</span>
                <button
                  type="button"
                  disabled={opening === row.id}
                  onClick={() => void openSnapshot(row)}
                  className="ace-btn-primary inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                >
                  <Eye size={12} />
                  {opening === row.id ? 'Loading…' : 'View'}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* Inline Signed Screenshot Lightbox Modal */}
      {viewerSnapshot && viewerUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-black/80 backdrop-blur-sm"
            onClick={() => {
              setViewerSnapshot(null);
              setViewerUrl('');
            }}
          />
          <div className="relative z-10 w-full max-w-4xl bg-[#151922] border border-[#292D36] rounded-2xl p-5 space-y-4 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-base font-bold text-[#FFFFFF]">
                  {viewerSnapshot.employeeName} · {viewerSnapshot.activeApp || 'Screen Capture'}
                </h3>
                <p className="text-xs text-[#A1A1AA] mt-0.5">
                  Captured {new Date(viewerSnapshot.capturedAt).toLocaleString()} · Activity {viewerSnapshot.activityPercent}% · Idle {Math.floor((viewerSnapshot.idleSeconds || 0) / 60)}m
                </p>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={viewerUrl}
                  download={`snapshot_${viewerSnapshot.id}.png`}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#1B1F28] border border-[#292D36] text-xs text-[#FFFFFF] rounded-lg hover:border-[#FF4634]/50"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download
                </a>
                <button
                  type="button"
                  onClick={() => {
                    setViewerSnapshot(null);
                    setViewerUrl('');
                  }}
                  className="p-1.5 text-[#A1A1AA] hover:text-[#FFFFFF]"
                  aria-label="Close viewer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="rounded-xl overflow-hidden border border-[#292D36] bg-[#0B0D12] max-h-[70vh] flex items-center justify-center">
              <img
                src={viewerUrl}
                alt={`Captured screen for ${viewerSnapshot.employeeName}`}
                className="max-h-[68vh] w-auto object-contain"
              />
            </div>
            {viewerSnapshot.windowTitle && (
              <p className="text-xs text-[#A1A1AA]">
                Active Window: <span className="text-[#FFFFFF]">{viewerSnapshot.windowTitle}</span>
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
