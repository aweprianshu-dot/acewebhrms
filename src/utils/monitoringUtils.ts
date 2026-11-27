export interface MonitoringAgentStatusLike {
  uid: string;
  employeeName?: string;
  departmentId?: string;
  online?: boolean;
  lastHeartbeat?: string;
  lastHeartbeatAt?: string;
  lastScreenshotAt?: string;
  lastScreenshotId?: string;
  state?: string;
  agentVersion?: string;
  date?: string;
  monitoringActive?: boolean;
  consentGranted?: boolean;
}

export const DEFAULT_HEARTBEAT_FRESHNESS_MS = 120_000;

export function getAgentHeartbeatIso(agent: Pick<MonitoringAgentStatusLike, 'lastHeartbeat' | 'lastHeartbeatAt'>): string | null {
  const raw = agent.lastHeartbeat || agent.lastHeartbeatAt || '';
  return raw.trim() ? raw.trim() : null;
}

export function isMonitoringAgentOnline(
  agent: Partial<MonitoringAgentStatusLike>,
  nowMs: number = Date.now(),
  freshnessMs: number = DEFAULT_HEARTBEAT_FRESHNESS_MS,
): boolean {
  const iso = getAgentHeartbeatIso(agent);
  if (iso) {
    const parsedMs = new Date(iso).getTime();
    if (Number.isFinite(parsedMs)) {
      return nowMs - parsedMs <= freshnessMs && nowMs - parsedMs >= -60_000;
    }
  }
  return Boolean(agent.online);
}
