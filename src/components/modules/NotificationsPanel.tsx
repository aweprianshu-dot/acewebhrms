import React, { useEffect, useState } from 'react';
import { X, CheckCheck, Mail, Bell, Trash2 } from 'lucide-react';
import { doc, updateDoc, deleteDoc, setDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { getMessaging, getToken, isSupported } from 'firebase/messaging';
import { app, db, handleFirestoreError, OperationType } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { useHrmsData } from '../../contexts/HrmsDataContext';
import { getEmailProviderStatus } from '../../services/hrmsApi';
import type { ActiveTab } from '../../types/hrms';

interface NotificationsPanelProps {
  open: boolean;
  mode?: 'drawer' | 'page';
  onClose: () => void;
  onNavigateTab: (tab: ActiveTab) => void;
}

export const NotificationsPanel: React.FC<NotificationsPanelProps> = ({
  open,
  mode = 'drawer',
  onClose,
  onNavigateTab,
}) => {
  const { firebaseUser } = useAuth();
  const { notifications, notificationPref } = useHrmsData();
  const [subTab, setSubTab] = useState<'inbox' | 'preferences'>('inbox');
  const [savingPref, setSavingPref] = useState(false);

  const [emailLeaveUpdates, setEmailLeaveUpdates] = useState(notificationPref?.emailLeaveUpdates ?? true);
  const [emailPayroll, setEmailPayroll] = useState(notificationPref?.emailPayroll ?? true);
  const [emailAnnouncements, setEmailAnnouncements] = useState(notificationPref?.emailAnnouncements ?? true);
  const [emailPerformance, setEmailPerformance] = useState(notificationPref?.emailPerformance ?? true);
  const [pushEnabled, setPushEnabled] = useState(notificationPref?.pushEnabled ?? true);
  const [prefSavedMsg, setPrefSavedMsg] = useState('');
  const [smtpReady, setSmtpReady] = useState<boolean | null>(null);

  useEffect(() => {
    if (open || mode === 'page') {
      getEmailProviderStatus(true).then(setSmtpReady).catch(() => setSmtpReady(false));
    }
  }, [open, mode]);

  useEffect(() => {
    if (!notificationPref) return;
    setEmailLeaveUpdates(notificationPref.emailLeaveUpdates);
    setEmailPayroll(notificationPref.emailPayroll);
    setEmailAnnouncements(notificationPref.emailAnnouncements);
    setEmailPerformance(notificationPref.emailPerformance);
    setPushEnabled(notificationPref.pushEnabled);
  }, [notificationPref]);

  if (mode === 'drawer' && !open) return null;

  const sorted = [...notifications].sort((a, b) => {
    const tA = (a.createdAt as { seconds?: number })?.seconds ?? 0;
    const tB = (b.createdAt as { seconds?: number })?.seconds ?? 0;
    return tB - tA;
  });

  const markRead = async (id: string) => {
    try {
      await updateDoc(doc(db, 'notifications', id), {
        read: true,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `notifications/${id}`);
    }
  };

  const markAllRead = async () => {
    const unread = sorted.filter((n) => !n.read);
    if (!unread.length) return;
    try {
      const batch = writeBatch(db);
      unread.forEach((n) => {
        batch.update(doc(db, 'notifications', n.id), {
          read: true,
          updatedAt: serverTimestamp(),
        });
      });
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'notifications');
    }
  };

  const removeNotif = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'notifications', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `notifications/${id}`);
    }
  };

  const savePreferences = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;
    setSavingPref(true);
    setPrefSavedMsg('');
    try {
      let fcmToken = notificationPref?.fcmToken || '';
      const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined;
      if (pushEnabled && vapidKey) {
        try {
          const supported = await isSupported();
          if (supported && typeof Notification !== 'undefined') {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
              const messaging = getMessaging(app);
              const token = await getToken(messaging, { vapidKey });
              if (token) fcmToken = token;
            }
          }
        } catch {
          // Graceful fallback to in-app real-time notifications if browser push / SW is unavailable
        }
      }

      await setDoc(doc(db, 'notificationPrefs', firebaseUser.uid), {
        uid: firebaseUser.uid,
        emailLeaveUpdates,
        emailPayroll,
        emailAnnouncements,
        emailPerformance,
        pushEnabled,
        ...(fcmToken ? { fcmToken } : {}),
        updatedAt: serverTimestamp(),
      });
      setPrefSavedMsg('Notification preferences saved.');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `notificationPrefs/${firebaseUser.uid}`);
    } finally {
      setSavingPref(false);
    }
  };

  const innerContent = (
    <>
      <div className={`${mode === 'drawer' ? 'h-16 px-5 border-b border-[#292D36]' : 'pb-4 border-b border-[#292D36]'} flex items-center justify-between`}>
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-xl bg-[#FF4634]/15 border border-[#FF4634]/30 flex items-center justify-center text-[#FF6A33]">
            <Bell className="w-4 h-4" />
          </span>
          <div>
            <h2 className="font-display text-base font-semibold text-[#FFFFFF]">Notifications</h2>
            {mode === 'page' && (
              <p className="text-xs text-[#A1A1AA]">Real-time HR updates, approvals, and alert preferences</p>
            )}
          </div>
        </div>
        {mode === 'drawer' && (
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-[#A1A1AA] hover:text-[#FFFFFF] rounded-lg hover:bg-[#1B1F28]"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      <div className={`${mode === 'drawer' ? 'px-5 pt-3 pb-2 border-b border-[#292D36]' : 'py-4'} flex items-center justify-between gap-2`}>
        <div className="flex items-center gap-1 p-1 bg-[#1B1F28] rounded-xl border border-[#292D36]">
          <button
            type="button"
            onClick={() => setSubTab('inbox')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
              subTab === 'inbox'
                ? 'bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-[#FFFFFF]'
                : 'text-[#A1A1AA] hover:text-[#FFFFFF]'
            }`}
          >
            Inbox ({sorted.filter((n) => !n.read).length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('preferences')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
              subTab === 'preferences'
                ? 'bg-gradient-to-r from-[#FF4634] to-[#FF6A33] text-[#FFFFFF]'
                : 'text-[#A1A1AA] hover:text-[#FFFFFF]'
            }`}
          >
            Preferences
          </button>
        </div>
        {subTab === 'inbox' && sorted.some((n) => !n.read) && (
          <button
            type="button"
            onClick={markAllRead}
            className="inline-flex items-center gap-1 text-xs font-medium text-[#FF6A33] hover:text-[#FF4634]"
          >
            <CheckCheck className="w-3.5 h-3.5" />
            Mark all read
          </button>
        )}
      </div>

      {subTab === 'inbox' ? (
        <div className={`${mode === 'drawer' ? 'flex-1 overflow-y-auto' : 'bg-[#151922] border border-[#292D36] rounded-2xl overflow-hidden'} divide-y divide-[#292D36]/80`}>
          {sorted.length === 0 ? (
            <div className="p-10 text-center text-sm text-[#A1A1AA]">
              No notifications yet. Updates for leaves, payroll, attendance, and announcements will appear here.
            </div>
          ) : (
            sorted.map((item) => (
              <div
                key={item.id}
                className={`p-4 transition-colors ${item.read ? 'bg-transparent' : 'bg-[#FF4634]/8'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div
                    className="flex-1 cursor-pointer"
                    onClick={() => {
                      if (!item.read) markRead(item.id);
                      if (item.linkTab) {
                        onNavigateTab(item.linkTab as ActiveTab);
                        if (mode === 'drawer') onClose();
                      }
                    }}
                  >
                    <div className="flex items-center gap-2 text-xs text-[#A1A1AA] mb-1">
                      <span className="capitalize text-[#FF6A33] font-medium">{item.type}</span>
                      <span>·</span>
                      <span className={item.read ? 'text-[#A1A1AA]' : 'text-amber-400 font-medium'}>
                        {item.read ? 'Read' : 'Unread'}
                      </span>
                      {item.emailSent && (
                        <>
                          <span>·</span>
                          <span className="inline-flex items-center gap-1 text-emerald-400">
                            <Mail className="w-3 h-3" /> Email sent
                          </span>
                        </>
                      )}
                    </div>
                    <div className="text-sm font-medium text-[#FFFFFF]">{item.title}</div>
                    <p className="text-xs text-[#A1A1AA] mt-1 leading-relaxed">{item.message}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeNotif(item.id)}
                    className="p-1 text-[#A1A1AA] hover:text-rose-400"
                    title="Delete notification"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <form onSubmit={savePreferences} className={`${mode === 'drawer' ? 'p-5' : 'bg-[#151922] border border-[#292D36] rounded-2xl p-6 max-w-2xl'} space-y-4`}>
          <div className="p-3.5 rounded-xl bg-[#1B1F28] border border-[#292D36] text-xs text-[#A1A1AA] leading-relaxed">
            {smtpReady ? (
              <span className="text-emerald-400 font-medium">Email provider active:</span>
            ) : (
              <span className="text-[#FFFFFF] font-medium">In-app & popup notifications active:</span>
            )}{' '}
            {smtpReady
              ? 'Outbound SMTP is configured. Selected email alerts will be delivered.'
              : 'No SMTP provider is configured yet, so email alerts are paused while Firebase real-time in-app and popup notifications operate normally.'}
          </div>
          {[
            { label: 'Leave approvals & rejections', value: emailLeaveUpdates, setter: setEmailLeaveUpdates },
            { label: 'Monthly payroll & payslip availability', value: emailPayroll, setter: setEmailPayroll },
            { label: 'Company notices & holiday announcements', value: emailAnnouncements, setter: setEmailAnnouncements },
            { label: 'Performance review & goal reminders', value: emailPerformance, setter: setEmailPerformance },
            { label: 'Real-time in-app popup notifications', value: pushEnabled, setter: setPushEnabled },
          ].map((pref) => (
            <label key={pref.label} className="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-[#1B1F28] border border-[#292D36] cursor-pointer">
              <span className="text-sm text-[#FFFFFF]">{pref.label}</span>
              <input
                type="checkbox"
                checked={pref.value}
                onChange={(e) => pref.setter(e.target.checked)}
                className="w-4 h-4 accent-[#FF4634]"
              />
            </label>
          ))}
          {prefSavedMsg && <div className="text-xs text-emerald-400">{prefSavedMsg}</div>}
          <button
            type="submit"
            disabled={savingPref}
            className="w-full py-2.5 px-4 ace-btn-primary text-sm font-medium rounded-xl"
          >
            {savingPref ? 'Saving...' : 'Save Preferences'}
          </button>
        </form>
      )}
    </>
  );

  if (mode === 'page') {
    return <div className="space-y-4">{innerContent}</div>;
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="fixed inset-0 bg-black/70" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md bg-[#151922] border-l border-[#292D36] h-full flex flex-col">
        {innerContent}
      </div>
    </div>
  );
};
