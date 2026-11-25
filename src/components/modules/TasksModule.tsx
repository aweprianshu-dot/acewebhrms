import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  AlertCircle,
  Briefcase,
  CalendarDays,
  CheckCircle2,
  Circle,
  Clock3,
  ListTodo,
  MessageSquare,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Send,
  Timer,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { db } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import { dispatchNotification, makeId, uploadToStorage } from '../../services/hrmsApi';
import type { TaskAttachment, TaskComment, TaskItem } from '../../types/hrms';
import { computeElapsedTimerSeconds, formatTrackedSeconds } from '../../utils/taskTimerUtils';

const statusLabels: Record<TaskItem['status'], string> = {
  todo: 'To do',
  in_progress: 'In progress',
  review: 'In review',
  completed: 'Completed',
};

const priorityStyles: Record<TaskItem['priority'], string> = {
  low: 'text-[#A1A1AA] bg-[#292D36]',
  medium: 'text-[#FFB15C] bg-[#FFB15C]/10',
  high: 'text-[#FF6A33] bg-[#FF6A33]/10',
  urgent: 'text-[#FF4634] bg-[#FF4634]/15',
};

export const TasksModule: React.FC = () => {
  const { firebaseUser, employeeProfile, roleAssignment, effectiveRole } = useAuth();
  const { employees } = useHrmsData();
  const uid = firebaseUser?.uid || '';
  const canAssign = effectiveRole !== 'employee';
  const isDeptManager = effectiveRole === 'dept_manager' || effectiveRole === 'team_lead';
  const myDeptId = roleAssignment?.departmentId || employeeProfile?.departmentId || '';

  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Create / Edit modal state
  const [showForm, setShowForm] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [project, setProject] = useState('');
  const [clientName, setClientName] = useState('');
  const [assigneeUid, setAssigneeUid] = useState('');
  const [priority, setPriority] = useState<TaskItem['priority']>('medium');
  const [dueDate, setDueDate] = useState(new Date().toISOString().slice(0, 10));

  // Details / Comments / Attachments drawer
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);
  const [attachBusy, setAttachBusy] = useState(false);
  const [timerBusyId, setTimerBusyId] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!uid) return;
    setLoading(true);
    const base = collection(db, 'tasks');
    const sortTasks = (items: TaskItem[]) =>
      items.sort((a, b) => {
        const time = (v: unknown) =>
          v && typeof v === 'object' && 'toMillis' in v && typeof (v as { toMillis?: unknown }).toMillis === 'function'
            ? (v as { toMillis: () => number }).toMillis()
            : typeof v === 'string'
            ? Date.parse(v) || 0
            : 0;
        return time(b.createdAt) - time(a.createdAt);
      });

    if (effectiveRole === 'super_admin' || effectiveRole === 'hr_manager') {
      return onSnapshot(
        base,
        (snap) => {
          setTasks(sortTasks(snap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskItem))));
          setLoading(false);
          setError('');
        },
        (err) => {
          setError(err.message || 'Unable to load tasks. Check your Firebase permissions and connection.');
          setLoading(false);
        },
      );
    }

    if (isDeptManager) {
      const buckets = new Map<string, TaskItem[]>();
      const emit = () => {
        const merged = new Map<string, TaskItem>();
        for (const list of buckets.values()) {
          for (const item of list) merged.set(item.id, item);
        }
        setTasks(sortTasks(Array.from(merged.values())));
        setLoading(false);
        setError('');
      };
      const unsubSelf = onSnapshot(
        query(base, where('assigneeUid', '==', uid)),
        (snap) => {
          buckets.set('self', snap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskItem)));
          emit();
        },
        (err) => {
          setError(err.message || 'Unable to load tasks.');
          setLoading(false);
        },
      );
      const unsubDept = myDeptId
        ? onSnapshot(
            query(base, where('departmentId', '==', myDeptId)),
            (snap) => {
              buckets.set('dept', snap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskItem)));
              emit();
            },
            (err) => {
              setError(err.message || 'Unable to load department tasks.');
              setLoading(false);
            },
          )
        : () => {};
      return () => {
        unsubSelf();
        unsubDept();
      };
    }

    return onSnapshot(
      query(base, where('assigneeUid', '==', uid)),
      (snap) => {
        setTasks(sortTasks(snap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskItem))));
        setLoading(false);
        setError('');
      },
      (err) => {
        setError(err.message || 'Unable to load tasks. Check your Firebase permissions and connection.');
        setLoading(false);
      },
    );
  }, [uid, effectiveRole, isDeptManager, myDeptId]);

  const assignableEmployees = useMemo(
    () =>
      employees.filter(
        (e) =>
          e.status === 'active' &&
          e.uid &&
          (!isDeptManager || (myDeptId ? e.departmentId === myDeptId : e.uid === uid)),
      ),
    [employees, isDeptManager, myDeptId, uid],
  );

  const visibleTasks = useMemo(
    () =>
      tasks.filter((task) => {
        const matchesStatus = statusFilter === 'all' || (task.status || 'todo') === statusFilter;
        const q = search.trim().toLowerCase();
        const matchesSearch =
          !q ||
          (task.title || '').toLowerCase().includes(q) ||
          (task.assigneeName || '').toLowerCase().includes(q) ||
          (task.project || '').toLowerCase().includes(q) ||
          (task.clientName || '').toLowerCase().includes(q) ||
          (task.description || '').toLowerCase().includes(q);
        return matchesStatus && matchesSearch;
      }),
    [tasks, statusFilter, search],
  );

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) || null,
    [tasks, selectedTaskId],
  );

  const openCreateModal = () => {
    setEditingTask(null);
    setTitle('');
    setDescription('');
    setProject('');
    setClientName('');
    setAssigneeUid('');
    setPriority('medium');
    setDueDate(new Date().toISOString().slice(0, 10));
    setShowForm(true);
  };

  const openEditModal = (task: TaskItem) => {
    setEditingTask(task);
    setTitle(task.title);
    setDescription(task.description || '');
    setProject(task.project || '');
    setClientName(task.clientName || '');
    setAssigneeUid(task.assigneeUid);
    setPriority(task.priority);
    setDueDate(task.dueDate);
    setShowForm(true);
  };

  const saveTaskForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !canAssign || !title.trim() || !assigneeUid) return;
    const target = assignableEmployees.find((emp) => emp.uid === assigneeUid);
    if (!target) return;
    setSaving(true);
    setError('');
    try {
      if (editingTask) {
        await updateDoc(doc(db, 'tasks', editingTask.id), {
          title: title.trim(),
          description: description.trim(),
          project: project.trim(),
          clientName: clientName.trim(),
          assigneeUid,
          assigneeName: target.fullName,
          assigneeEmployeeId: target.id,
          departmentId: target.departmentId || myDeptId,
          priority,
          dueDate,
          updatedAt: serverTimestamp(),
        });
      } else {
        const id = makeId('task');
        const managerName = employeeProfile?.fullName || firebaseUser.displayName || 'ACE HR';
        const taskData = {
          id,
          title: title.trim(),
          description: description.trim(),
          project: project.trim(),
          clientName: clientName.trim(),
          assigneeUid,
          assigneeName: target.fullName,
          assigneeEmployeeId: target.id,
          departmentId: target.departmentId || myDeptId,
          assignedByUid: uid,
          assignedByName: managerName,
          priority,
          status: 'todo' as const,
          dueDate,
          timerRunning: false,
          timerStartedAt: null,
          activeTimerUid: '',
          trackedSeconds: 0,
          comments: [],
          attachments: [],
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        await setDoc(doc(db, 'tasks', id), taskData);
        await dispatchNotification({
          recipientUid: assigneeUid,
          recipientEmail: target.email,
          title: 'New task assigned',
          message: `${managerName} assigned you: ${title.trim()} (Due: ${dueDate}).`,
          type: 'task',
          linkTab: 'tasks',
          sendEmail: Boolean(target.email),
        });
      }
      setShowForm(false);
      setEditingTask(null);
    } catch (err) {
      setError('Task could not be saved. Verify Firestore task permissions and try again.');
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const toggleTaskTimer = async (task: TaskItem) => {
    if (!uid || (task.assigneeUid !== uid && !canAssign)) return;
    setTimerBusyId(task.id);
    setError('');
    const currentNow = Date.now();
    try {
      const batch = writeBatch(db);
      if (task.timerRunning) {
        const nextTotal = computeElapsedTimerSeconds(task, currentNow);
        batch.update(doc(db, 'tasks', task.id), {
          timerRunning: false,
          timerStartedAt: null,
          activeTimerUid: '',
          trackedSeconds: nextTotal,
          updatedAt: serverTimestamp(),
        });
      } else {
        // Enforce single active task timer per user: auto-pause any other running task timers for this user
        for (const other of tasks) {
          if (other.id !== task.id && other.timerRunning && (other.assigneeUid === uid || other.activeTimerUid === uid)) {
            batch.update(doc(db, 'tasks', other.id), {
              timerRunning: false,
              timerStartedAt: null,
              activeTimerUid: '',
              trackedSeconds: computeElapsedTimerSeconds(other, currentNow),
              updatedAt: serverTimestamp(),
            });
          }
        }
        batch.update(doc(db, 'tasks', task.id), {
          timerRunning: true,
          timerStartedAt: new Date(currentNow).toISOString(),
          activeTimerUid: uid,
          trackedSeconds: computeElapsedTimerSeconds(task, currentNow),
          ...(task.status === 'todo' ? { status: 'in_progress' } : {}),
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update task timer.');
    } finally {
      setTimerBusyId(null);
    }
  };

  const updateStatus = async (task: TaskItem, status: TaskItem['status']) => {
    try {
      const currentNow = Date.now();
      const shouldPauseTimer = status === 'completed' && task.timerRunning;
      await updateDoc(doc(db, 'tasks', task.id), {
        status,
        ...(status === 'completed' ? { completedAt: new Date(currentNow).toISOString() } : { completedAt: null }),
        ...(shouldPauseTimer
          ? {
              timerRunning: false,
              timerStartedAt: null,
              activeTimerUid: '',
              trackedSeconds: computeElapsedTimerSeconds(task, currentNow),
            }
          : {}),
        updatedAt: serverTimestamp(),
      });
      if (task.assignedByUid !== uid) {
        const assigner = employees.find((e) => e.uid === task.assignedByUid);
        await dispatchNotification({
          recipientUid: task.assignedByUid,
          recipientEmail: assigner?.email,
          title: 'Task status updated',
          message: `${task.assigneeName} moved “${task.title}” to ${statusLabels[status]}.`,
          type: 'task',
          linkTab: 'tasks',
          taskId: task.id,
          sendEmail: Boolean(assigner?.email),
        });
      }
    } catch (err) {
      setError('Could not update task status. Please try again.');
      console.error(err);
    }
  };

  const addComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTask || !commentText.trim() || !uid) return;
    setCommentBusy(true);
    setError('');
    try {
      const nextComment: TaskComment = {
        id: makeId('cmt'),
        authorUid: uid,
        authorName: employeeProfile?.fullName || firebaseUser?.displayName || 'Team Member',
        text: commentText.trim().slice(0, 1000),
        createdAt: new Date().toISOString(),
      };
      const existingComments = Array.isArray(selectedTask.comments) ? selectedTask.comments : [];
      await updateDoc(doc(db, 'tasks', selectedTask.id), {
        comments: [...existingComments.slice(-99), nextComment],
        updatedAt: serverTimestamp(),
      });
      setCommentText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add comment.');
    } finally {
      setCommentBusy(false);
    }
  };

  const uploadTaskAttachment = async (file: File) => {
    if (!selectedTask || !uid) return;
    if (file.size > 15 * 1024 * 1024) {
      setError('Attachment size must be under 15 MB.');
      return;
    }
    setAttachBusy(true);
    setError('');
    try {
      const url = await uploadToStorage(`task_attachments/${uid}`, file);
      const nextAttachment: TaskAttachment = {
        id: makeId('att'),
        name: file.name,
        url,
        size: file.size,
        uploadedByUid: uid,
        uploadedAt: new Date().toISOString(),
      };
      const existing = Array.isArray(selectedTask.attachments) ? selectedTask.attachments : [];
      await updateDoc(doc(db, 'tasks', selectedTask.id), {
        attachments: [...existing.slice(-19), nextAttachment],
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Attachment upload failed.');
    } finally {
      setAttachBusy(false);
    }
  };

  const removeTask = async (task: TaskItem) => {
    if (!canAssign) return;
    try {
      await deleteDoc(doc(db, 'tasks', task.id));
      setConfirmDeleteTaskId(null);
      if (selectedTaskId === task.id) setSelectedTaskId(null);
    } catch (err) {
      setError('Task could not be deleted.');
      console.error(err);
    }
  };

  const activeRunningTask = tasks.find((t) => t.timerRunning && (t.assigneeUid === uid || t.activeTimerUid === uid));
  const counts = {
    total: tasks.length,
    todo: tasks.filter((t) => t.status === 'todo').length,
    progress: tasks.filter((t) => t.status === 'in_progress').length,
    completed: tasks.filter((t) => t.status === 'completed').length,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[#FF6A33] text-xs font-semibold uppercase tracking-[.18em]">
            <ListTodo className="w-4 h-4" /> Work management
          </div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-[#FFFFFF] mt-2">Task Management</h1>
          <p className="text-sm text-[#A1A1AA] mt-1">
            Assign project tasks, log single-task focus timers, collaborate with comments & attachments.
          </p>
        </div>
        {canAssign && (
          <button
            onClick={openCreateModal}
            className="ace-btn-primary rounded-xl px-4 py-2.5 text-sm font-semibold inline-flex items-center justify-center gap-2"
          >
            <Plus className="w-4 h-4" /> Assign New Task
          </button>
        )}
      </div>

      {activeRunningTask && (
        <div className="rounded-2xl border border-[#FF6A33]/40 bg-[#FF4634]/10 p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-9 h-9 rounded-xl bg-[#FF4634]/20 text-[#FF6A33] grid place-items-center shrink-0">
              <Timer className="w-4 h-4 animate-pulse" />
            </span>
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wider text-[#FF8B5B] font-semibold">
                Active Single-Task Timer Running
              </div>
              <div className="text-sm font-semibold text-white truncate">
                {activeRunningTask.title}
                {activeRunningTask.project ? ` · ${activeRunningTask.project}` : ''}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-lg font-bold text-white tabular-nums">
              {formatTrackedSeconds(computeElapsedTimerSeconds(activeRunningTask, nowMs))}
            </span>
            <button
              type="button"
              disabled={timerBusyId === activeRunningTask.id}
              onClick={() => void toggleTaskTimer(activeRunningTask)}
              className="px-3.5 py-2 rounded-xl bg-[#151922] border border-[#FF6A33]/40 text-xs font-semibold text-[#FF8B5B] inline-flex items-center gap-1.5"
            >
              <Pause className="w-3.5 h-3.5" /> Pause
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'All Tasks', value: counts.total, icon: ListTodo },
          { label: 'To Do', value: counts.todo, icon: Circle },
          { label: 'In Progress', value: counts.progress, icon: Clock3 },
          { label: 'Completed', value: counts.completed, icon: CheckCircle2 },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="bg-[#151922] border border-[#292D36] rounded-2xl p-4">
              <div className="flex items-center justify-between text-xs text-[#A1A1AA]">
                <span>{item.label}</span>
                <Icon className="w-4 h-4 text-[#FF6A33]" />
              </div>
              <div className="text-2xl font-bold text-[#FFFFFF] mt-2 tabular-nums">{item.value}</div>
            </div>
          );
        })}
      </div>

      <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-4 flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-[#A1A1AA] absolute left-3 top-3" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks, projects, clients, or employees..."
            className="w-full bg-[#0B0D12] border border-[#292D36] rounded-xl pl-9 pr-3 py-2.5 text-sm text-[#FFFFFF] outline-none focus:border-[#FF4634]"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-[#0B0D12] border border-[#292D36] rounded-xl px-3 py-2.5 text-sm text-[#FFFFFF] outline-none focus:border-[#FF4634]"
        >
          <option value="all">All statuses</option>
          <option value="todo">To do</option>
          <option value="in_progress">In progress</option>
          <option value="review">In review</option>
          <option value="completed">Completed</option>
        </select>
      </div>

      {error && (
        <div className="rounded-xl border border-[#FF4634]/30 bg-[#FF4634]/10 p-3 text-sm text-[#FF9A87] flex gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl p-10 text-center text-sm text-[#A1A1AA]">
          Loading tasks from Firebase…
        </div>
      ) : visibleTasks.length === 0 ? (
        <div className="bg-[#151922] border border-dashed border-[#3A3030] rounded-2xl p-12 text-center">
          <div className="w-14 h-14 rounded-2xl bg-[#FF4634]/10 text-[#FF6A33] grid place-items-center mx-auto">
            <ListTodo className="w-7 h-7" />
          </div>
          <h3 className="text-[#FFFFFF] font-semibold mt-4">No tasks here yet</h3>
          <p className="text-sm text-[#A1A1AA] mt-1">
            {canAssign ? 'Create your first task and assign it to a team member.' : 'Your assigned tasks will appear here.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleTasks.map((task) => {
            const safePriority = task.priority && priorityStyles[task.priority] ? task.priority : 'medium';
            const safeStatus = task.status && statusLabels[task.status] ? task.status : 'todo';
            const overdue = safeStatus !== 'completed' && Boolean(task.dueDate) && task.dueDate < new Date().toISOString().slice(0, 10);
            const canChange = task.assigneeUid === uid || canAssign;
            const elapsedSeconds = computeElapsedTimerSeconds(task, nowMs);
            const commentCount = Array.isArray(task.comments) ? task.comments.length : 0;
            const attachCount = Array.isArray(task.attachments) ? task.attachments.length : 0;

            return (
              <article
                key={task.id}
                className={`bg-[#151922] border rounded-2xl p-4 sm:p-5 transition-colors ${
                  task.timerRunning ? 'border-[#FF6A33]/60' : 'border-[#292D36] hover:border-[#FF6A33]/40'
                }`}
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-[#FFFFFF]">{task.title || 'Untitled Task'}</h3>
                      <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-lg ${priorityStyles[safePriority]}`}>
                        {safePriority}
                      </span>
                      {(task.project || task.clientName) && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-[#D4D4D8] bg-[#1B1F28] border border-[#292D36] px-2 py-0.5 rounded-lg">
                          <Briefcase className="w-3 h-3 text-[#FF6A33]" />
                          {[task.project, task.clientName].filter(Boolean).join(' · ')}
                        </span>
                      )}
                      {overdue && (
                        <span className="text-[10px] font-semibold text-[#FF6A33] bg-[#FF6A33]/10 px-2 py-1 rounded-lg">
                          Overdue
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-[#A1A1AA] mt-1.5 whitespace-pre-wrap">
                      {task.description || 'No description provided.'}
                    </p>
                    <div className="flex flex-wrap gap-x-4 gap-y-2 mt-3 text-xs text-[#A1A1AA]">
                      <span className="inline-flex items-center gap-1.5">
                        <UserRound className="w-3.5 h-3.5 text-[#FF6A33]" />
                        {task.assigneeName || 'Unassigned'}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <CalendarDays className="w-3.5 h-3.5 text-[#FF6A33]" />
                        {task.dueDate ? `Due ${task.dueDate}` : 'No due date'}
                      </span>
                      <span className="inline-flex items-center gap-1.5 font-mono text-[#D4D4D8]">
                        <Timer className="w-3.5 h-3.5 text-[#FF6A33]" />
                        {formatTrackedSeconds(elapsedSeconds)}
                      </span>
                      <span>Assigned by {task.assignedByName || 'Manager'}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {canChange && task.status !== 'completed' && (
                      <button
                        type="button"
                        disabled={timerBusyId === task.id}
                        onClick={() => void toggleTaskTimer(task)}
                        className={`px-3 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 border ${
                          task.timerRunning
                            ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                            : 'bg-[#0B0D12] border-[#292D36] text-[#FFFFFF] hover:border-[#FF6A33]'
                        }`}
                        title={task.timerRunning ? 'Pause timer' : 'Start timer (auto-pauses any other active task timer)'}
                      >
                        {task.timerRunning ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 text-[#FF6A33]" />}
                        {task.timerRunning ? 'Pause' : 'Start Timer'}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => setSelectedTaskId(task.id)}
                      className="px-3 py-2 rounded-xl bg-[#0B0D12] border border-[#292D36] text-xs text-[#D4D4D8] hover:border-[#FF6A33] inline-flex items-center gap-2"
                    >
                      <span className="inline-flex items-center gap-1">
                        <MessageSquare className="w-3.5 h-3.5 text-[#FF6A33]" />
                        {commentCount}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Paperclip className="w-3.5 h-3.5 text-[#A1A1AA]" />
                        {attachCount}
                      </span>
                    </button>

                    <select
                      disabled={!canChange}
                      value={task.status}
                      onChange={(e) => updateStatus(task, e.target.value as TaskItem['status'])}
                      className="min-w-32 bg-[#0B0D12] border border-[#292D36] rounded-xl px-3 py-2.5 text-xs text-[#FFFFFF] outline-none focus:border-[#FF4634] disabled:opacity-70"
                    >
                      {Object.entries(statusLabels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>

                    {canAssign && (
                      <>
                        <button
                          type="button"
                          onClick={() => openEditModal(task)}
                          title="Edit task"
                          className="p-2.5 rounded-xl border border-[#292D36] text-[#A1A1AA] hover:text-white hover:border-[#FF6A33]/50"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        {confirmDeleteTaskId === task.id ? (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => void removeTask(task)}
                              className="px-2.5 py-2 rounded-xl bg-rose-600 text-white text-xs font-semibold"
                            >
                              Confirm Delete
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteTaskId(null)}
                              className="px-2.5 py-2 rounded-xl border border-[#292D36] text-xs text-[#A1A1AA]"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteTaskId(task.id)}
                            title="Delete task"
                            className="p-2.5 rounded-xl border border-[#292D36] text-[#A1A1AA] hover:text-[#FF4634] hover:border-[#FF4634]/50"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {showForm && (
        <div
          className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowForm(false);
          }}
        >
          <form
            onSubmit={saveTaskForm}
            className="w-full max-w-xl bg-[#151922] border border-[#FF6A33]/30 rounded-2xl p-5 sm:p-6 shadow-2xl"
          >
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-lg font-bold text-white">
                  {editingTask ? 'Edit Task' : 'Assign a new task'}
                </h2>
                <p className="text-xs text-[#A1A1AA] mt-1">
                  {editingTask ? 'Update task scope, project/client, or due date.' : 'The assignee will receive an in-app notification.'}
                </p>
              </div>
              <button type="button" onClick={() => setShowForm(false)} className="p-2 text-[#A1A1AA] hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-[#A1A1AA] mb-1.5">Task title *</label>
                <input
                  required
                  maxLength={140}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Complete monthly SEO report"
                  className="w-full bg-[#0B0D12] border border-[#292D36] rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-[#FF4634]"
                />
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#A1A1AA] mb-1.5">Project (optional)</label>
                  <input
                    maxLength={160}
                    value={project}
                    onChange={(e) => setProject(e.target.value)}
                    placeholder="e.g. Website Redesign"
                    className="w-full bg-[#0B0D12] border border-[#292D36] rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-[#FF4634]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#A1A1AA] mb-1.5">Client (optional)</label>
                  <input
                    maxLength={160}
                    value={clientName}
                    onChange={(e) => setClientName(e.target.value)}
                    placeholder="e.g. ACE Web Client"
                    className="w-full bg-[#0B0D12] border border-[#292D36] rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-[#FF4634]"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-[#A1A1AA] mb-1.5">Description</label>
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Add task details, deliverables or instructions..."
                  className="w-full bg-[#0B0D12] border border-[#292D36] rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-[#FF4634] resize-y"
                />
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#A1A1AA] mb-1.5">Assign to *</label>
                  <select
                    required
                    value={assigneeUid}
                    onChange={(e) => setAssigneeUid(e.target.value)}
                    className="w-full bg-[#0B0D12] border border-[#292D36] rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-[#FF4634]"
                  >
                    <option value="">Select employee</option>
                    {assignableEmployees.map((emp) => (
                      <option key={emp.id} value={emp.uid}>
                        {emp.fullName} · {emp.departmentName}
                      </option>
                    ))}
                  </select>
                  {assignableEmployees.length === 0 && (
                    <p className="text-[11px] text-[#FF9A87] mt-1">No active employees with linked user accounts found.</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs text-[#A1A1AA] mb-1.5">Due date *</label>
                  <input
                    required
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="w-full bg-[#0B0D12] border border-[#292D36] rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-[#FF4634]"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-[#A1A1AA] mb-1.5">Priority</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TaskItem['priority'])}
                  className="w-full bg-[#0B0D12] border border-[#292D36] rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-[#FF4634]"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-4 py-2.5 rounded-xl border border-[#292D36] text-sm text-[#A1A1AA]"
              >
                Cancel
              </button>
              <button
                disabled={saving || !assignableEmployees.length}
                type="submit"
                className="ace-btn-primary px-5 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50"
              >
                {saving ? 'Saving…' : editingTask ? 'Save Changes' : 'Assign Task'}
              </button>
            </div>
          </form>
        </div>
      )}

      {selectedTask && (
        <div
          className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSelectedTaskId(null);
          }}
        >
          <div className="w-full max-w-2xl max-h-[88vh] overflow-y-auto bg-[#151922] border border-[#292D36] rounded-2xl p-5 sm:p-6 shadow-2xl space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold text-white">{selectedTask.title}</h2>
                  <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-lg ${priorityStyles[selectedTask.priority]}`}>
                    {selectedTask.priority}
                  </span>
                </div>
                <p className="text-xs text-[#A1A1AA] mt-1">
                  {selectedTask.assigneeName} · Due {selectedTask.dueDate}
                  {(selectedTask.project || selectedTask.clientName)
                    ? ` · ${[selectedTask.project, selectedTask.clientName].filter(Boolean).join(' / ')}`
                    : ''}
                </p>
              </div>
              <button type="button" onClick={() => setSelectedTaskId(null)} className="p-2 text-[#A1A1AA] hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="rounded-xl bg-[#0B0D12] border border-[#292D36] p-3.5 text-sm text-[#D4D4D8] whitespace-pre-wrap">
              {selectedTask.description || 'No description provided.'}
            </div>

            {/* Attachments */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <h3 className="text-xs uppercase tracking-wider font-semibold text-[#A1A1AA] flex items-center gap-1.5">
                  <Paperclip className="w-3.5 h-3.5 text-[#FF6A33]" /> Attachments
                </h3>
                {(selectedTask.assigneeUid === uid || canAssign) && (
                  <label className="cursor-pointer px-3 py-1.5 rounded-lg bg-[#1B1F28] border border-[#292D36] hover:border-[#FF6A33] text-xs text-white inline-flex items-center gap-1.5">
                    <Plus className="w-3.5 h-3.5 text-[#FF6A33]" />
                    {attachBusy ? 'Uploading…' : 'Upload File'}
                    <input
                      type="file"
                      className="hidden"
                      disabled={attachBusy}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void uploadTaskAttachment(file);
                        e.currentTarget.value = '';
                      }}
                    />
                  </label>
                )}
              </div>
              {Array.isArray(selectedTask.attachments) && selectedTask.attachments.length > 0 ? (
                <div className="space-y-1.5">
                  {selectedTask.attachments.map((att) => (
                    <a
                      key={att.id}
                      href={att.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-between rounded-xl bg-[#0B0D12] border border-[#292D36] px-3 py-2 text-xs text-[#D4D4D8] hover:border-[#FF6A33]"
                    >
                      <span className="truncate">{att.name}</span>
                      <span className="text-[#A1A1AA] shrink-0 ml-2">{Math.max(1, Math.round(att.size / 1024))} KB</span>
                    </a>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-[#71717A]">No attachments uploaded yet.</p>
              )}
            </div>

            {/* Comments */}
            <div className="space-y-3">
              <h3 className="text-xs uppercase tracking-wider font-semibold text-[#A1A1AA] flex items-center gap-1.5">
                <MessageSquare className="w-3.5 h-3.5 text-[#FF6A33]" /> Comments ({selectedTask.comments?.length || 0})
              </h3>
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {Array.isArray(selectedTask.comments) && selectedTask.comments.length > 0 ? (
                  selectedTask.comments.map((cmt) => (
                    <div key={cmt.id} className="rounded-xl bg-[#0B0D12] border border-[#292D36] p-3">
                      <div className="flex items-center justify-between text-[11px] text-[#A1A1AA]">
                        <span className="font-semibold text-white">{cmt.authorName}</span>
                        <span>{new Date(cmt.createdAt).toLocaleString()}</span>
                      </div>
                      <p className="text-xs text-[#D4D4D8] mt-1 whitespace-pre-wrap">{cmt.text}</p>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-[#71717A]">No comments yet.</p>
                )}
              </div>

              {(selectedTask.assigneeUid === uid || canAssign) && (
                <form onSubmit={addComment} className="flex gap-2">
                  <input
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    maxLength={1000}
                    placeholder="Add a comment or status update..."
                    className="flex-1 bg-[#0B0D12] border border-[#292D36] rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-[#FF4634]"
                  />
                  <button
                    type="submit"
                    disabled={commentBusy || !commentText.trim()}
                    className="ace-btn-primary px-4 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Send className="w-3.5 h-3.5" />
                    Post
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
