import {
  collection,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import type { Announcement, TaskItem, UserRole } from '../types/hrms';

export function computeElapsedTimerSeconds(
  task: Pick<TaskItem, 'trackedSeconds' | 'timerRunning' | 'timerStartedAt'>,
  nowMs: number = Date.now(),
): number {
  const base = Math.max(0, Math.floor(Number(task.trackedSeconds || 0)));
  if (!task.timerRunning || !task.timerStartedAt) {
    return base;
  }
  const startedMs = Date.parse(task.timerStartedAt);
  if (Number.isNaN(startedMs)) {
    return base;
  }
  const delta = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  return base + delta;
}

export function formatTrackedSeconds(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(Number(totalSeconds || 0)));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export async function pauseActiveTaskTimersForUser(
  db: Firestore,
  uid: string,
  nowMs: number = Date.now(),
): Promise<number> {
  if (!uid) return 0;
  const snap = await getDocs(query(collection(db, 'tasks'), where('assigneeUid', '==', uid)));
  const runningDocs = snap.docs.filter((d) => {
    const data = d.data() as TaskItem;
    return Boolean(data.timerRunning);
  });
  if (runningDocs.length === 0) return 0;

  const batch = writeBatch(db);
  for (const d of runningDocs) {
    const data = d.data() as TaskItem;
    const totalSeconds = computeElapsedTimerSeconds(data, nowMs);
    batch.update(d.ref, {
      timerRunning: false,
      timerStartedAt: null,
      activeTimerUid: '',
      trackedSeconds: totalSeconds,
      updatedAt: serverTimestamp(),
    });
  }
  await batch.commit();
  return runningDocs.length;
}

export function isAnnouncementCurrentlyActive(
  ann: Pick<Announcement, 'publishDate' | 'expiryDate'>,
  todayDate: string,
): boolean {
  if (ann.publishDate && ann.publishDate > todayDate) {
    return false;
  }
  if (ann.expiryDate && ann.expiryDate < todayDate) {
    return false;
  }
  return true;
}

export function isAnnouncementVisibleToViewer(
  ann: Announcement,
  viewer: {
    uid: string;
    effectiveRole: UserRole;
    departmentId: string;
    teamLeadUid?: string;
    reportingManagerUid?: string;
    teamId?: string;
  },
): boolean {
  if (
    viewer.effectiveRole === 'super_admin' ||
    viewer.effectiveRole === 'hr_manager' ||
    ann.authorUid === viewer.uid
  ) {
    return true;
  }

  const audience = ann.audience || 'company';
  if (audience === 'company') {
    return true;
  }

  if (audience === 'department') {
    if (!ann.departmentId) return true;
    return ann.departmentId === viewer.departmentId;
  }

  if (audience === 'team') {
    if (ann.teamLeadUid || ann.teamId) {
      if (
        (ann.teamLeadUid &&
          (viewer.uid === ann.teamLeadUid ||
            viewer.teamLeadUid === ann.teamLeadUid ||
            viewer.reportingManagerUid === ann.teamLeadUid)) ||
        (ann.teamId &&
          (viewer.uid === ann.teamId ||
            viewer.teamId === ann.teamId ||
            viewer.teamLeadUid === ann.teamId ||
            viewer.reportingManagerUid === ann.teamId))
      ) {
        return true;
      }
      if (
        viewer.effectiveRole === 'dept_manager' &&
        ann.departmentId &&
        ann.departmentId === viewer.departmentId
      ) {
        return true;
      }
      return false;
    }
    return !ann.departmentId || ann.departmentId === viewer.departmentId;
  }

  return true;
}
