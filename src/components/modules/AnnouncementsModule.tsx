import React, { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, query, setDoc, deleteDoc, serverTimestamp, where } from 'firebase/firestore';
import { Megaphone, Pin, Plus, Trash2, X, CheckCircle2, Eye, FileSpreadsheet, Users } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import { dispatchNotification, makeId } from '../../services/hrmsApi';
import { exportToXlsx } from '../../utils/exportUtils';
import type { Announcement, AnnouncementAudience } from '../../types/hrms';

interface AnnouncementReadDoc {
  id: string;
  uid: string;
  employeeName?: string;
  departmentId?: string;
  announcementId: string;
  title: string;
  category: Announcement['category'];
}

export const AnnouncementsModule: React.FC = () => {
  const { firebaseUser, employeeProfile, roleAssignment, effectiveRole } = useAuth();
  const { announcements, directory, employees, departments, roles } = useHrmsData();

  const uid = firebaseUser?.uid || '';
  const isHR = effectiveRole === 'super_admin' || effectiveRole === 'hr_manager';
  const isTeamLead = effectiveRole === 'team_lead';
  const canPublish = isHR || isTeamLead;

  const [catFilter, setCatFilter] = useState('all');
  const [audienceFilter, setAudienceFilter] = useState<'all' | AnnouncementAudience>('all');
  const [showModal, setShowModal] = useState(false);

  const [reads, setReads] = useState<AnnouncementReadDoc[]>([]);
  const [readsLoaded, setReadsLoaded] = useState(false);
  const [birthdayPopup, setBirthdayPopup] = useState<Announcement | null>(null);
  const [dismissedBirthdayIds, setDismissedBirthdayIds] = useState<string[]>([]);
  const [expandedReadAnnId, setExpandedReadAnnId] = useState<string | null>(null);
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null);
  const [publishError, setPublishError] = useState('');

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<Announcement['category']>('notice');
  const [audience, setAudience] = useState<AnnouncementAudience>(isTeamLead ? 'team' : 'company');
  const [targetDeptId, setTargetDeptId] = useState('');
  const [targetTeamLeadUid, setTargetTeamLeadUid] = useState('');
  const [content, setContent] = useState('');
  const [pinned, setPinned] = useState(false);
  const [broadcast, setBroadcast] = useState(true);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    if (!uid) return;
    const q = isHR ? collection(db, 'announcementReads') : query(collection(db, 'announcementReads'), where('uid', '==', uid));
    return onSnapshot(
      q,
      (snap) => { setReads(snap.docs.map((d) => ({ id: d.id, ...d.data() } as AnnouncementReadDoc))); setReadsLoaded(true); },
      () => {}
    );
  }, [uid, isHR]);

  useEffect(() => {
    if (!uid || !readsLoaded || birthdayPopup) return;
    const nextBirthday = announcements.find((item) =>
      item.category === 'birthday' &&
      item.id.startsWith('auto_birthday_') &&
      !reads.some((read) => read.uid === uid && read.announcementId === item.id) &&
      !dismissedBirthdayIds.includes(item.id)
    );
    if (nextBirthday) setBirthdayPopup(nextBirthday);
  }, [uid, readsLoaded, reads, announcements, birthdayPopup, dismissedBirthdayIds]);

  const activeMembers = useMemo(
    () => directory.filter((d) => d.uid && d.status === 'active'),
    [directory]
  );

  // Build selectable team options for HR / Super Admin team-targeted notices
  const teamOptions = useMemo(() => {
    const map = new Map<string, { leadUid: string; teamId: string; teamName: string; departmentId: string; label: string }>();
    for (const emp of employees) {
      if (emp.status !== 'active' || !emp.uid) continue;
      const roleRec = roles.find((r) => r.uid === emp.uid);
      if (roleRec?.role === 'team_lead') {
        const tName = emp.teamName || `${emp.fullName}'s Team`;
        map.set(emp.uid, {
          leadUid: emp.uid,
          teamId: emp.teamId || emp.uid,
          teamName: tName,
          departmentId: emp.departmentId,
          label: `${tName} (Lead: ${emp.fullName})`,
        });
      }
    }
    for (const emp of employees) {
      if (emp.status !== 'active' || !emp.teamLeadUid || map.has(emp.teamLeadUid)) continue;
      const tName = emp.teamName || `${emp.teamLeadName || 'Team'}`;
      map.set(emp.teamLeadUid, {
        leadUid: emp.teamLeadUid,
        teamId: emp.teamId || emp.teamLeadUid,
        teamName: tName,
        departmentId: emp.departmentId,
        label: `${tName}${emp.teamLeadName ? ` (Lead: ${emp.teamLeadName})` : ''}`,
      });
    }
    return Array.from(map.values());
  }, [employees, roles]);

  const filtered = useMemo(() => {
    return [...announcements]
      .filter((a) => {
        const matchesCat = catFilter === 'all' || a.category === catFilter;
        const aAud = a.audience || 'company';
        const matchesAud = audienceFilter === 'all' || aAud === audienceFilter;
        return matchesCat && matchesAud;
      })
      .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  }, [announcements, catFilter, audienceFilter]);

  const acknowledgeAnnouncement = async (ann: Announcement) => {
    if (!uid) return;
    const readId = `${ann.id}_${uid}`.slice(0, 128);
    setAcknowledgingId(ann.id);
    try {
      await setDoc(doc(db, 'announcementReads', readId), {
        id: readId,
        uid,
        employeeName: employeeProfile?.fullName || firebaseUser?.displayName || 'Employee',
        departmentId: employeeProfile?.departmentId || '',
        announcementId: ann.id,
        title: ann.title.slice(0, 240),
        category: ann.category,
        readAt: serverTimestamp(),
        acknowledgedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `announcementReads/${readId}`);
    } finally {
      setAcknowledgingId(null);
    }
  };

  const openPublishModal = () => {
    setPublishError('');
    setTitle('');
    setContent('');
    setCategory('notice');
    setPinned(false);
    setBroadcast(true);
    if (isTeamLead) {
      setAudience('team');
      setTargetDeptId(employeeProfile?.departmentId || roleAssignment?.departmentId || '');
      setTargetTeamLeadUid(uid);
    } else {
      setAudience('company');
      setTargetDeptId(departments[0]?.id || '');
      setTargetTeamLeadUid(teamOptions[0]?.leadUid || '');
    }
    setShowModal(true);
  };

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !canPublish) return;
    setPublishing(true);
    setPublishError('');
    const id = makeId('ann');

    try {
      const cleanTitle = title.trim();
      const cleanContent = content.trim();
      const resolvedAudience: AnnouncementAudience = isTeamLead ? 'team' : audience;
      const selectedTeam =
        resolvedAudience === 'team'
          ? isTeamLead
            ? {
                leadUid: uid,
                teamId: employeeProfile?.teamId || uid,
                teamName: employeeProfile?.teamName || `${employeeProfile?.fullName || 'Team Lead'}'s Team`,
                departmentId: employeeProfile?.departmentId || roleAssignment?.departmentId || '',
              }
            : teamOptions.find((t) => t.leadUid === targetTeamLeadUid)
          : undefined;

      const resolvedDeptId =
        resolvedAudience === 'department'
          ? targetDeptId
          : resolvedAudience === 'team'
          ? selectedTeam?.departmentId || employeeProfile?.departmentId || roleAssignment?.departmentId || ''
          : '';

      if (resolvedAudience === 'department' && !resolvedDeptId) {
        setPublishError('Please select a target department.');
        setPublishing(false);
        return;
      }

      await setDoc(doc(db, 'announcements', id), {
        id,
        title: cleanTitle,
        category,
        content: cleanContent,
        pinned: isHR ? pinned : false,
        audience: resolvedAudience,
        ...(resolvedDeptId ? { departmentId: resolvedDeptId } : {}),
        ...(resolvedAudience === 'team'
          ? {
              teamId: selectedTeam?.teamId || targetTeamLeadUid || uid,
              teamName: selectedTeam?.teamName || 'Team Notice',
              teamLeadUid: selectedTeam?.leadUid || targetTeamLeadUid || uid,
            }
          : {}),
        authorUid: firebaseUser.uid,
        authorName: employeeProfile?.fullName || firebaseUser.displayName || (isTeamLead ? 'Team Lead' : 'HR Team'),
        authorRole: effectiveRole,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      setShowModal(false);
      setTitle('');
      setContent('');
      setPinned(false);

      if (broadcast) {
        let recipientUids: string[] = [];
        if (resolvedAudience === 'company') {
          recipientUids = [...new Set(directory.filter((d) => d.uid && d.status === 'active').map((d) => d.uid!))];
        } else if (resolvedAudience === 'department') {
          recipientUids = [
            ...new Set(
              directory
                .filter((d) => d.uid && d.status === 'active' && d.departmentId === resolvedDeptId)
                .map((d) => d.uid!)
            ),
          ];
        } else if (resolvedAudience === 'team') {
          const leadUid = selectedTeam?.leadUid || targetTeamLeadUid || uid;
          const tId = selectedTeam?.teamId || '';
          recipientUids = [
            ...new Set(
              employees
                .filter(
                  (emp) =>
                    emp.uid &&
                    emp.status === 'active' &&
                    (emp.teamLeadUid === leadUid ||
                      emp.reportingManagerUid === leadUid ||
                      (tId && emp.teamId === tId) ||
                      emp.uid === leadUid)
                )
                .map((emp) => emp.uid!)
            ),
          ];
        }

        for (let i = 0; i < recipientUids.length; i += 5) {
          const chunk = recipientUids.slice(i, i + 5);
          await Promise.allSettled(
            chunk.map(async (rUid) => {
              const emp = employees.find((item) => item.uid === rUid);
              await dispatchNotification({
                recipientUid: rUid,
                recipientEmail: emp?.email,
                title:
                  resolvedAudience === 'team'
                    ? `Team Announcement: ${cleanTitle}`
                    : resolvedAudience === 'department'
                    ? `Department Notice: ${cleanTitle}`
                    : `Announcement: ${cleanTitle}`,
                message: cleanContent.slice(0, 300),
                type: 'announcement',
                linkTab: 'announcements',
                sendEmail: Boolean(emp?.email),
              });
            }),
          );
        }
      }
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : 'Unable to publish announcement.');
      handleFirestoreError(err, OperationType.CREATE, `announcements/${id}`);
    } finally {
      setPublishing(false);
    }
  };

  const handleDelete = async (ann: Announcement) => {
    const canDeleteThis = isHR || (isTeamLead && ann.authorUid === uid && ann.audience === 'team');
    if (!canDeleteThis) return;
    try {
      await deleteDoc(doc(db, 'announcements', ann.id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `announcements/${ann.id}`);
    }
  };

  const exportPolicyCompliance = async () => {
    const policyAnns = announcements.filter((a) => a.category === 'policy' || a.pinned);
    const targetAnns = policyAnns.length > 0 ? policyAnns : announcements;
    const rows = targetAnns.map((ann) => {
      const annReads = reads.filter((r) => r.announcementId === ann.id);
      const rate = activeMembers.length ? Math.round((annReads.length / activeMembers.length) * 100) : 0;
      return [ann.title, ann.category, ann.audience || 'company', annReads.length, activeMembers.length, `${rate}%`];
    });
    await exportToXlsx(
      'ace_policy_read_rates',
      ['Announcement / Policy', 'Category', 'Audience', 'Acknowledged Count', 'Active Headcount', 'Read Rate %'],
      rows,
      'Read Rates'
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#FFFFFF]">
            {isTeamLead ? 'Company & Team Announcements' : 'Company Announcements'}
          </h1>
          <p className="text-sm text-[#A1A1AA] mt-1">
            Official notices, team-scoped updates, holidays, birthdays, anniversaries, and policy read-rate tracking
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isHR && announcements.length > 0 && (
            <button
              type="button"
              onClick={() => void exportPolicyCompliance()}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#151922] border border-[#292D36] text-[#FFFFFF] hover:border-[#FF4634]/50 text-xs font-medium rounded-xl whitespace-nowrap"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
              Export Read-Rate XLSX
            </button>
          )}
          {canPublish && (
            <button
              type="button"
              onClick={openPublishModal}
              className="ace-btn-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              {isTeamLead ? 'Publish Team Announcement' : 'Publish Announcement'}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-[#151922] border border-[#292D36] rounded-xl w-fit">
          {['all', 'notice', 'holiday', 'birthday', 'anniversary', 'event', 'policy'].map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCatFilter(c)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${
                catFilter === c
                  ? 'bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-white'
                  : 'text-[#A1A1AA] hover:text-[#FFFFFF]'
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#151922] border border-[#292D36] rounded-xl w-fit">
          {(['all', 'company', 'department', 'team'] as const).map((aud) => (
            <button
              key={aud}
              type="button"
              onClick={() => setAudienceFilter(aud)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${
                audienceFilter === aud
                  ? 'bg-[#1B1F28] text-[#FF6A33] border border-[#FF4634]/40'
                  : 'text-[#A1A1AA] hover:text-[#FFFFFF]'
              }`}
            >
              {aud === 'all' ? 'All Scopes' : aud}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="p-10 text-center bg-[#151922] border border-[#292D36] rounded-2xl text-sm text-[#A1A1AA]">
          No announcements in this filter yet.
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((a) => {
            const annReads = reads.filter((r) => r.announcementId === a.id);
            const hasAcknowledged = annReads.some((r) => r.uid === uid);
            const readUids = new Set(annReads.map((r) => r.uid));
            const unreadMembers = activeMembers.filter((m) => m.uid && !readUids.has(m.uid));
            const readPct = activeMembers.length
              ? Math.min(100, Math.round((annReads.length / activeMembers.length) * 100))
              : 0;
            const audienceLabel =
              a.audience === 'team'
                ? `Team · ${a.teamName || 'Assigned Team'}`
                : a.audience === 'department'
                ? `Department · ${departments.find((d) => d.id === a.departmentId)?.name || 'Dept'}`
                : 'Company-Wide';
            const canDeleteThis = isHR || (isTeamLead && a.authorUid === uid && a.audience === 'team');

            return (
              <article key={a.id} className="p-5 bg-[#151922] border border-[#292D36] rounded-2xl space-y-3 hover:border-[#FF4634]/30 transition-colors">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[#A1A1AA]">
                      <Megaphone className="w-3.5 h-3.5 text-[#FF6A33]" />
                      <span className="capitalize text-[#FF6A33] font-medium">{a.category}</span>
                      <span>·</span>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#1B1F28] border border-[#292D36] text-[#D4D4D8] text-[11px]">
                        <Users className="w-3 h-3 text-[#FF9A65]" />
                        {audienceLabel}
                      </span>
                      <span>·</span>
                      <span>Posted by {a.authorName}</span>
                      {a.pinned && (
                        <>
                          <span>·</span>
                          <span className="inline-flex items-center gap-1 text-amber-400">
                            <Pin className="w-3 h-3" /> Pinned
                          </span>
                        </>
                      )}
                    </div>
                    <h2 className="font-display text-lg font-semibold text-[#FFFFFF] mt-1">{a.title}</h2>
                  </div>

                  <div className="flex items-center gap-2">
                    {hasAcknowledged ? (
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/15 text-emerald-400 text-xs font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Acknowledged
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={acknowledgingId === a.id}
                        onClick={() => void acknowledgeAnnouncement(a)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#1B1F28] border border-[#292D36] hover:border-[#FF4634]/50 text-xs text-[#FFFFFF] font-medium disabled:opacity-50"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5 text-[#FF6A33]" />
                        {acknowledgingId === a.id ? 'Saving…' : 'Acknowledge Read'}
                      </button>
                    )}

                    {canDeleteThis && (
                      <button
                        type="button"
                        onClick={() => void handleDelete(a)}
                        className="p-1.5 text-[#A1A1AA] hover:text-rose-400 transition-colors"
                        title="Delete announcement"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                <p className="text-sm text-[#D4D4D8] leading-relaxed whitespace-pre-line">{a.content}</p>

                {isHR && (
                  <div className="pt-2 border-t border-[#292D36]/70">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="text-[#A1A1AA]">
                        Read & Acknowledged: <b className="text-[#FFFFFF]">{annReads.length}</b> / {activeMembers.length} active staff ({readPct}%)
                      </span>
                      <button
                        type="button"
                        onClick={() => setExpandedReadAnnId(expandedReadAnnId === a.id ? null : a.id)}
                        className="inline-flex items-center gap-1 text-[#FF8B5B] hover:underline"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        {expandedReadAnnId === a.id ? 'Hide pending list' : `View pending (${unreadMembers.length})`}
                      </button>
                    </div>
                    {expandedReadAnnId === a.id && (
                      <div className="mt-2 p-3 rounded-xl bg-[#0B0D12] border border-[#292D36] text-xs space-y-1">
                        {unreadMembers.length === 0 ? (
                          <span className="text-emerald-400">100% of active employees have acknowledged this announcement.</span>
                        ) : (
                          <>
                            <div className="text-[#A1A1AA] font-medium mb-1">Pending acknowledgement ({unreadMembers.length}):</div>
                            <div className="flex flex-wrap gap-1.5">
                              {unreadMembers.map((m) => (
                                <span key={m.id} className="px-2 py-0.5 rounded bg-[#151922] border border-[#292D36] text-[#D4D4D8]">
                                  {m.fullName}
                                </span>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {birthdayPopup && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="birthday-popup-title">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-md" />
          <section className="relative z-10 w-full max-w-md overflow-hidden rounded-3xl border border-[#FF9A65]/40 bg-[#151922] p-7 text-center shadow-2xl">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-[#FF4634] to-[#FF9A65] text-3xl" aria-hidden="true">🎂</div>
            <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-[#FF9A65]">ACE Web Experts celebrates you</p>
            <h2 id="birthday-popup-title" className="mt-3 font-display text-2xl font-bold text-white">{birthdayPopup.title}</h2>
            <p className="mt-3 text-sm leading-6 text-[#D4D4D8]">{birthdayPopup.content}</p>
            <button type="button" onClick={() => {
              const item = birthdayPopup;
              setDismissedBirthdayIds((current) => [...current, item.id]);
              setBirthdayPopup(null);
              void acknowledgeAnnouncement(item);
            }} className="ace-btn-primary mt-6 w-full rounded-xl px-4 py-3 text-sm font-semibold">Thank you!</button>
          </section>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75 backdrop-blur-sm" onClick={() => setShowModal(false)} />
          <form onSubmit={handlePublish} className="relative z-10 w-full max-w-lg bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#FFFFFF]">
                {isTeamLead ? 'Publish Team Announcement' : 'Publish Announcement'}
              </h3>
              <button type="button" onClick={() => setShowModal(false)} className="text-[#A1A1AA] hover:text-[#FFFFFF]">
                <X className="w-5 h-5" />
              </button>
            </div>
            {publishError && (
              <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">
                {publishError}
              </div>
            )}
            <input
              type="text"
              required
              placeholder="Announcement Headline"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-lg text-[#FFFFFF]"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as Announcement['category'])}
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-lg text-[#FFFFFF]"
              >
                <option value="notice">Notice</option>
                <option value="holiday">Holiday</option>
                <option value="birthday">Birthday</option>
                <option value="anniversary">Work Anniversary</option>
                <option value="event">Team / Company Event</option>
                <option value="policy">Policy Announcement</option>
              </select>

              {isHR ? (
                <select
                  value={audience}
                  onChange={(e) => setAudience(e.target.value as AnnouncementAudience)}
                  className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-lg text-[#FFFFFF]"
                >
                  <option value="company">Company-Wide</option>
                  <option value="department">Specific Department</option>
                  <option value="team">Specific Team</option>
                </select>
              ) : (
                <div className="px-3 py-2 bg-[#0B0D12] border border-[#292D36] rounded-lg text-[#FF9A65] font-medium flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5" />
                  <span>Audience: {employeeProfile?.teamName || 'My Team Only'}</span>
                </div>
              )}
            </div>

            {isHR && audience === 'department' && (
              <select
                value={targetDeptId}
                onChange={(e) => setTargetDeptId(e.target.value)}
                required
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-lg text-[#FFFFFF]"
              >
                <option value="">Select department...</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            )}

            {isHR && audience === 'team' && (
              <select
                value={targetTeamLeadUid}
                onChange={(e) => setTargetTeamLeadUid(e.target.value)}
                required
                className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-lg text-[#FFFFFF]"
              >
                <option value="">Select team...</option>
                {teamOptions.map((t) => (
                  <option key={t.leadUid} value={t.leadUid}>{t.label}</option>
                ))}
              </select>
            )}

            <textarea
              required
              rows={4}
              placeholder={isTeamLead ? 'Write an update for your team members...' : 'Write announcement details...'}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-lg text-[#FFFFFF]"
            />
            <div className="flex flex-col gap-2">
              {isHR && (
                <label className="flex items-center gap-2 text-[#D4D4D8] cursor-pointer">
                  <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="accent-[#FF4634]" />
                  <span>Pin to top of announcements</span>
                </label>
              )}
              <label className="flex items-center gap-2 text-[#D4D4D8] cursor-pointer">
                <input type="checkbox" checked={broadcast} onChange={(e) => setBroadcast(e.target.checked)} className="accent-[#FF4634]" />
                <span>
                  {isTeamLead || audience === 'team'
                    ? 'Notify only assigned team members (in-app + email when SMTP is configured)'
                    : 'Send real-time in-app notification (plus email when SMTP is configured)'}
                </span>
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="px-4 py-2 bg-[#1B1F28] border border-[#292D36] rounded-lg text-[#A1A1AA] hover:text-[#FFFFFF]"
              >
                Cancel
              </button>
              <button type="submit" disabled={publishing} className="ace-btn-primary px-4 py-2 font-semibold rounded-lg disabled:opacity-60">
                {publishing ? 'Publishing...' : 'Publish'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
