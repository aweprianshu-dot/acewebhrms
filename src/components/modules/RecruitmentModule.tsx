import React, { useMemo, useState } from 'react';
import { doc, setDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { Briefcase, Plus, Upload, Star, Calendar, Trash2, X, Download } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import { makeId, uploadToStorage, writeAuditLog } from '../../services/hrmsApi';
import { exportToCsv } from '../../utils/exportUtils';
import type { Candidate, CandidateStage, EmploymentType, JobOpening } from '../../types/hrms';

const STAGES: { id: CandidateStage; label: string }[] = [
  { id: 'applied', label: 'Applied' },
  { id: 'screening', label: 'Screening' },
  { id: 'interview', label: 'Interview' },
  { id: 'offer', label: 'Offer' },
  { id: 'selected', label: 'Selected' },
  { id: 'rejected', label: 'Rejected' },
];

export const RecruitmentModule: React.FC = () => {
  const { firebaseUser, effectiveRole } = useAuth();
  const { jobs, candidates, departments } = useHrmsData();

  const isHR = effectiveRole === 'super_admin' || effectiveRole === 'hr_manager';
  const uid = firebaseUser?.uid || '';

  const [subTab, setSubTab] = useState<'pipeline' | 'jobs'>('pipeline');
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [jobFilter, setJobFilter] = useState<string>('all');

  // Job modal
  const [showJobModal, setShowJobModal] = useState(false);
  const [jobTitle, setJobTitle] = useState('');
  const [jobDeptId, setJobDeptId] = useState(departments[0]?.id || 'dept_eng');
  const [jobLocation, setJobLocation] = useState('Remote / Hybrid');
  const [jobType, setJobType] = useState<EmploymentType>('full_time');
  const [jobOpenings, setJobOpenings] = useState(1);
  const [jobDesc, setJobDesc] = useState('');

  // Candidate modal
  const [showCandModal, setShowCandModal] = useState(false);
  const [candJobId, setCandJobId] = useState('');
  const [candName, setCandName] = useState('');
  const [candEmail, setCandEmail] = useState('');
  const [candPhone, setCandPhone] = useState('');
  const [candResumeUrl, setCandResumeUrl] = useState('');
  const [candResumeName, setCandResumeName] = useState('');
  const [uploadingResume, setUploadingResume] = useState(false);

  // Interview feedback modal
  const [feedbackCand, setFeedbackCand] = useState<Candidate | null>(null);
  const [intDate, setIntDate] = useState('');
  const [intFeedback, setIntFeedback] = useState('');
  const [intRating, setIntRating] = useState(4);
  const [intStage, setIntStage] = useState<CandidateStage>('interview');

  const filteredCandidates = useMemo(() => {
    return candidates.filter((c) => {
      const mStage = stageFilter === 'all' || c.stage === stageFilter;
      const mJob = jobFilter === 'all' || c.jobId === jobFilter;
      return mStage && mJob;
    });
  }, [candidates, stageFilter, jobFilter]);

  const handleCreateJob = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isHR) return;
    const dept = departments.find((d) => d.id === jobDeptId);
    const id = makeId('job');
    try {
      await setDoc(doc(db, 'jobs', id), {
        id,
        title: jobTitle.trim(),
        departmentId: jobDeptId,
        departmentName: dept?.name || 'General',
        location: jobLocation.trim(),
        employmentType: jobType,
        openings: Number(jobOpenings) || 1,
        description: jobDesc.trim(),
        requirements: '',
        status: 'open',
        createdByUid: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog({
        actorUid: uid,
        actorEmail: firebaseUser?.email || '',
        actorRole: effectiveRole,
        action: 'JOB_CREATED',
        targetCollection: 'jobs',
        targetId: id,
        summary: `Opened job requisition: ${jobTitle.trim()}`,
      });
      setShowJobModal(false);
      setJobTitle('');
      setJobDesc('');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `jobs/${id}`);
    }
  };

  const toggleJobStatus = async (job: JobOpening) => {
    if (!isHR) return;
    const next = job.status === 'open' ? 'closed' : 'open';
    try {
      await updateDoc(doc(db, 'jobs', job.id), { status: next, updatedAt: serverTimestamp() });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `jobs/${job.id}`);
    }
  };

  const handleResumeUpload = async (file: File) => {
    setUploadingResume(true);
    try {
      const url = await uploadToStorage('resumes', file);
      setCandResumeUrl(url);
      setCandResumeName(file.name);
    } catch {
      setCandResumeName(`${file.name} (Storage pending)`);
    } finally {
      setUploadingResume(false);
    }
  };

  const handleAddCandidate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isHR) return;
    const job = jobs.find((j) => j.id === candJobId) || jobs[0];
    if (!job) return;
    const id = makeId('cand');

    try {
      await setDoc(doc(db, 'candidates', id), {
        id,
        jobId: job.id,
        jobTitle: job.title,
        fullName: candName.trim(),
        email: candEmail.trim().toLowerCase(),
        phone: candPhone.trim(),
        resumeUrl: candResumeUrl,
        resumeName: candResumeName,
        stage: 'applied',
        interviewDate: '',
        interviewerUid: '',
        interviewerName: '',
        interviewFeedback: '',
        rating: 0,
        notes: '',
        createdByUid: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setShowCandModal(false);
      setCandName('');
      setCandEmail('');
      setCandPhone('');
      setCandResumeUrl('');
      setCandResumeName('');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `candidates/${id}`);
    }
  };

  const openFeedback = (c: Candidate) => {
    setFeedbackCand(c);
    setIntDate(c.interviewDate || '');
    setIntFeedback(c.interviewFeedback || '');
    setIntRating(c.rating || 4);
    setIntStage(c.stage);
  };

  const saveFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedbackCand) return;
    try {
      const payload = isHR
        ? {
            interviewDate: intDate,
            interviewFeedback: intFeedback.trim(),
            rating: Number(intRating),
            stage: intStage,
            interviewerUid: uid,
            interviewerName: firebaseUser?.displayName || 'Interviewer',
            updatedAt: serverTimestamp(),
          }
        : {
            interviewFeedback: intFeedback.trim(),
            rating: Number(intRating),
            updatedAt: serverTimestamp(),
          };
      await updateDoc(doc(db, 'candidates', feedbackCand.id), payload);
      setFeedbackCand(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `candidates/${feedbackCand.id}`);
    }
  };

  const deleteJob = async (id: string) => {
    if (!isHR) return;
    try {
      await deleteDoc(doc(db, 'jobs', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `jobs/${id}`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#FFFFFF]">Recruitment & Hiring</h1>
          <p className="text-sm text-[#A1A1AA] mt-1">
            {jobs.filter((j) => j.status === 'open').length} open roles · {candidates.length} candidates in pipeline
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              exportToCsv(
                'recruitment_candidates',
                ['Candidate', 'Email', 'Role', 'Stage', 'Interview Date', 'Rating'],
                candidates.map((c) => [c.fullName, c.email, c.jobTitle, c.stage, c.interviewDate || '-', c.rating ?? 0])
              )
            }
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#151922] border border-[#292D36] text-[#A1A1AA] hover:text-[#FFFFFF] hover:border-[#FF4634]/50 text-xs rounded-xl transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>
          {isHR && (
            <>
              <button
                type="button"
                onClick={() => {
                  setCandJobId(jobs[0]?.id || '');
                  setShowCandModal(true);
                }}
                disabled={jobs.length === 0}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#151922] hover:bg-[#1B1F28] border border-[#292D36] disabled:opacity-40 text-[#FFFFFF] text-xs font-medium rounded-xl transition-colors"
              >
                <Plus className="w-3.5 h-3.5 text-[#FF6A33]" />
                Add Candidate
              </button>
              <button
                type="button"
                onClick={() => setShowJobModal(true)}
                className="ace-btn-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl"
              >
                <Briefcase className="w-3.5 h-3.5" />
                New Job Opening
              </button>
            </>
          )}
        </div>
      </div>

      {/* Stage Summary Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
        {STAGES.map((st) => (
          <button
            key={st.id}
            type="button"
            onClick={() => {
              setSubTab('pipeline');
              setStageFilter(stageFilter === st.id ? 'all' : st.id);
            }}
            className={`p-3.5 rounded-2xl border text-left transition-colors ${
              stageFilter === st.id
                ? 'bg-[#FF4634]/15 border-[#FF4634]'
                : 'bg-[#151922] border-[#292D36] hover:border-[#FF4634]/40'
            }`}
          >
            <div className="text-xs text-[#A1A1AA]">{st.label}</div>
            <div className="font-mono text-lg font-semibold text-[#FFFFFF] tabular-nums mt-1">
              {candidates.filter((c) => c.stage === st.id).length}
            </div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1.5 bg-[#151922] border border-[#292D36] rounded-2xl">
          <button
            type="button"
            onClick={() => setSubTab('pipeline')}
            className={`px-3 py-1.5 text-xs font-medium rounded-xl transition-all ${
              subTab === 'pipeline'
                ? 'bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-white'
                : 'text-[#A1A1AA] hover:text-[#FFFFFF]'
            }`}
          >
            Candidates ({filteredCandidates.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('jobs')}
            className={`px-3 py-1.5 text-xs font-medium rounded-xl transition-all ${
              subTab === 'jobs'
                ? 'bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-white'
                : 'text-[#A1A1AA] hover:text-[#FFFFFF]'
            }`}
          >
            Job Openings ({jobs.length})
          </button>
        </div>

        {subTab === 'pipeline' && (
          <select
            value={jobFilter}
            onChange={(e) => setJobFilter(e.target.value)}
            className="px-3 py-1.5 bg-[#151922] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-xs text-[#FFFFFF]"
          >
            <option value="all" className="bg-[#151922]">All Job Openings</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id} className="bg-[#151922]">{j.title}</option>
            ))}
          </select>
        )}
      </div>

      {subTab === 'pipeline' ? (
        <div className="bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden">
          {filteredCandidates.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#A1A1AA]">
              No candidates match the selected stage or job filter.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#1B1F28] border-b border-[#292D36] text-[#A1A1AA]">
                    <th className="px-4 py-3 text-left font-medium">Candidate</th>
                    <th className="px-4 py-3 text-left font-medium">Job Opening</th>
                    <th className="px-4 py-3 text-left font-medium">Stage</th>
                    <th className="px-4 py-3 text-left font-medium">Interview</th>
                    <th className="px-4 py-3 text-left font-medium">Resume</th>
                    <th className="px-4 py-3 text-right font-medium">Review</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#292D36]/70">
                  {filteredCandidates.map((c) => (
                    <tr key={c.id} className="hover:bg-[#1B1F28]/60">
                      <td className="px-4 py-3">
                        <div className="text-[#FFFFFF] font-medium">{c.fullName}</div>
                        <div className="text-[#A1A1AA]">{c.email} {c.phone ? `· ${c.phone}` : ''}</div>
                      </td>
                      <td className="px-4 py-3 text-[#A1A1AA]">{c.jobTitle}</td>
                      <td className="px-4 py-3 capitalize font-medium">
                        <span
                          className={
                            c.stage === 'selected'
                              ? 'text-emerald-400'
                              : c.stage === 'rejected'
                              ? 'text-rose-400'
                              : 'text-[#FF6A33]'
                          }
                        >
                          {c.stage}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-[#A1A1AA]">
                        {c.interviewDate ? (
                          <span className="inline-flex items-center gap-1">
                            <Calendar className="w-3.5 h-3.5 text-[#A1A1AA]" />
                            {c.interviewDate}
                          </span>
                        ) : (
                          'Not scheduled'
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {c.resumeUrl ? (
                          <a href={c.resumeUrl} target="_blank" rel="noreferrer" className="text-[#FF6A33] hover:text-[#FF4634] hover:underline">
                            {c.resumeName || 'View Resume'}
                          </a>
                        ) : (
                          <span className="text-[#A1A1AA]/60">None</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => openFeedback(c)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-[#1B1F28] hover:bg-[#292D36] border border-[#292D36] text-[#FFFFFF] rounded-lg"
                        >
                          <Star className="w-3 h-3 text-amber-400" />
                          <span>Evaluate ({c.rating ?? 0}/5)</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {jobs.length === 0 ? (
            <div className="col-span-full p-8 text-center text-sm text-[#A1A1AA] bg-[#151922] border border-[#292D36] rounded-2xl">
              No job openings created yet.
            </div>
          ) : (
            jobs.map((job) => (
              <div key={job.id} className="p-5 bg-[#151922] border border-[#292D36] rounded-2xl flex flex-col justify-between gap-4">
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-display text-base font-semibold text-[#FFFFFF]">{job.title}</h3>
                      <div className="text-xs text-[#A1A1AA] mt-1">
                        {job.departmentName} · {job.location || 'Remote'} · {job.openings} opening(s)
                      </div>
                    </div>
                    <span className={`text-xs capitalize font-medium ${job.status === 'open' ? 'text-emerald-400' : 'text-[#A1A1AA]'}`}>
                      {job.status}
                    </span>
                  </div>
                  {job.description && <p className="text-xs text-[#A1A1AA] mt-3 line-clamp-3">{job.description}</p>}
                </div>
                {isHR && (
                  <div className="flex items-center justify-between pt-3 border-t border-[#292D36] text-xs">
                    <button
                      type="button"
                      onClick={() => toggleJobStatus(job)}
                      className="text-[#FF6A33] hover:text-[#FF4634] font-medium"
                    >
                      {job.status === 'open' ? 'Close Requisition' : 'Reopen'}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteJob(job.id)}
                      className="text-[#A1A1AA] hover:text-rose-400"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* New Job Modal */}
      {showJobModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setShowJobModal(false)} />
          <form onSubmit={handleCreateJob} className="relative z-10 w-full max-w-md bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs">
            <h3 className="font-display text-base font-bold text-[#FFFFFF]">Create Job Opening</h3>
            <input type="text" required placeholder="Job Title (e.g. Senior React Engineer)" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
            <div className="grid grid-cols-2 gap-3">
              <select value={jobDeptId} onChange={(e) => setJobDeptId(e.target.value)} className="px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]">
                {departments.map((d) => (
                  <option key={d.id} value={d.id} className="bg-[#151922]">{d.name}</option>
                ))}
              </select>
              <select value={jobType} onChange={(e) => setJobType(e.target.value as EmploymentType)} className="px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]">
                <option value="full_time" className="bg-[#151922]">Full Time</option>
                <option value="part_time" className="bg-[#151922]">Part Time</option>
                <option value="contract" className="bg-[#151922]">Contract</option>
                <option value="intern" className="bg-[#151922]">Intern</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input type="text" placeholder="Location" value={jobLocation} onChange={(e) => setJobLocation(e.target.value)} className="px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
              <input type="number" min={1} value={jobOpenings} onChange={(e) => setJobOpenings(Number(e.target.value))} className="px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
            </div>
            <textarea rows={3} placeholder="Role description & requirements" value={jobDesc} onChange={(e) => setJobDesc(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowJobModal(false)} className="px-4 py-2 border border-[#292D36] bg-[#1B1F28] rounded-xl text-[#A1A1AA] hover:text-[#FFFFFF]">Cancel</button>
              <button type="submit" className="ace-btn-primary px-4 py-2 font-semibold rounded-xl">Publish Job</button>
            </div>
          </form>
        </div>
      )}

      {/* Add Candidate Modal */}
      {showCandModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setShowCandModal(false)} />
          <form onSubmit={handleAddCandidate} className="relative z-10 w-full max-w-md bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs">
            <h3 className="font-display text-base font-bold text-[#FFFFFF]">Add Candidate</h3>
            <select value={candJobId} onChange={(e) => setCandJobId(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]">
              {jobs.map((j) => (
                <option key={j.id} value={j.id} className="bg-[#151922]">{j.title}</option>
              ))}
            </select>
            <input type="text" required placeholder="Candidate Full Name" value={candName} onChange={(e) => setCandName(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
            <input type="email" required placeholder="Email Address" value={candEmail} onChange={(e) => setCandEmail(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
            <input type="text" placeholder="Phone Number" value={candPhone} onChange={(e) => setCandPhone(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
            <label className="flex items-center justify-center gap-2 px-3 py-2.5 bg-[#0B0D12] border border-dashed border-[#292D36] rounded-xl text-[#A1A1AA] cursor-pointer hover:border-[#FF4634] hover:text-[#FFFFFF]">
              <Upload className="w-4 h-4" />
              <span>{uploadingResume ? 'Uploading Resume...' : candResumeName || 'Upload Resume (PDF/DOCX)'}</span>
              <input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && handleResumeUpload(e.target.files[0])} />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowCandModal(false)} className="px-4 py-2 border border-[#292D36] bg-[#1B1F28] rounded-xl text-[#A1A1AA] hover:text-[#FFFFFF]">Cancel</button>
              <button type="submit" className="ace-btn-primary px-4 py-2 font-semibold rounded-xl">Add to Pipeline</button>
            </div>
          </form>
        </div>
      )}

      {/* Interview & Feedback Modal */}
      {feedbackCand && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setFeedbackCand(null)} />
          <form onSubmit={saveFeedback} className="relative z-10 w-full max-w-md bg-[#151922] border border-[#292D36] rounded-2xl p-6 space-y-4 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-[#FFFFFF]">Interview & Stage · {feedbackCand.fullName}</h3>
              <button type="button" onClick={() => setFeedbackCand(null)} className="text-[#A1A1AA] hover:text-[#FFFFFF]"><X className="w-5 h-5" /></button>
            </div>
            {isHR && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Hiring Stage</label>
                  <select value={intStage} onChange={(e) => setIntStage(e.target.value as CandidateStage)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]">
                    {STAGES.map((s) => (
                      <option key={s.id} value={s.id} className="bg-[#151922]">{s.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[#A1A1AA] mb-1">Interview Date</label>
                  <input type="datetime-local" value={intDate} onChange={(e) => setIntDate(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
                </div>
              </div>
            )}
            <div>
              <label className="block text-[#A1A1AA] mb-1">Rating (1-5)</label>
              <input type="number" min={1} max={5} value={intRating} onChange={(e) => setIntRating(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF] font-mono" />
            </div>
            <div>
              <label className="block text-[#A1A1AA] mb-1">Interview Feedback</label>
              <textarea rows={3} value={intFeedback} onChange={(e) => setIntFeedback(e.target.value)} className="w-full px-3 py-2 bg-[#0B0D12] border border-[#292D36] focus:border-[#FF4634] focus:outline-none rounded-xl text-[#FFFFFF]" />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setFeedbackCand(null)} className="px-4 py-2 border border-[#292D36] bg-[#1B1F28] rounded-xl text-[#A1A1AA] hover:text-[#FFFFFF]">Cancel</button>
              <button type="submit" className="ace-btn-primary px-4 py-2 font-semibold rounded-xl">Save Evaluation</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
