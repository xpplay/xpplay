import { useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  Eye,
  FileCheck2,
  HardDrive,
  Lock,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Unlock,
} from 'lucide-react';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import {
  createSystemBackupApi,
  deleteSystemBackupApi,
  executeRestoreApi,
  fetchBackupManifestApi,
  fetchBackupRetentionApi,
  fetchRestoreJobsApi,
  fetchSystemBackupsApi,
  fetchSystemHealthApi,
  forceUnlockRestoreApi,
  previewRestoreApi,
  runIntegrityAuditApi,
  saveBackupRetentionApi,
  verifySystemBackupApi,
} from '../services/xpService.ts';
import {
  formatBytesHuman,
  RESTORE_CONFIRMATION_PHRASE,
} from '../shared/backupRestoreLogic.ts';
import { formatJakartaDateTime } from '../shared/xpLogic.ts';
import type {
  AdminUser,
  BackupManifest,
  BackupRetentionConfig,
  BackupVerificationResult,
  HealthStatusLevel,
  IntegrityAuditReport,
  RestoreJobRecord,
  RestoreLockState,
  RestorePreviewResult,
  SystemBackupRecord,
  SystemHealthReport,
} from '../types/xpplay.ts';

type BackupSubTab = 'overview' | 'history' | 'restore' | 'integrity' | 'retention' | 'restoreLogs';

interface AdminBackupRestoreProps {
  adminProfile: AdminUser;
}

function statusTextColor(status: HealthStatusLevel): string {
  if (status === 'HEALTHY') return 'text-emerald-300';
  if (status === 'WARNING') return 'text-amber-300';
  if (status === 'MAINTENANCE') return 'text-sky-300';
  return 'text-rose-300';
}

export function AdminBackupRestore({ adminProfile }: AdminBackupRestoreProps) {
  const isSuperAdmin = adminProfile.role === 'SUPER_ADMIN';
  const [subTab, setSubTab] = useState<BackupSubTab>('overview');
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [health, setHealth] = useState<SystemHealthReport | null>(null);
  const [backups, setBackups] = useState<SystemBackupRecord[]>([]);
  const [restoreJobs, setRestoreJobs] = useState<RestoreJobRecord[]>([]);
  const [restoreLock, setRestoreLock] = useState<RestoreLockState | null>(null);
  const [retention, setRetention] = useState<BackupRetentionConfig | null>(null);
  const [integrityReport, setIntegrityReport] = useState<IntegrityAuditReport | null>(null);

  // Create Backup form
  const [backupNote, setBackupNote] = useState('');

  // Modals: Manifest Inspector & Verification Details
  const [manifestModal, setManifestModal] = useState<BackupManifest | null>(null);
  const [verifyModal, setVerifyModal] = useState<BackupVerificationResult | null>(null);

  // Restore Center workflow
  const [selectedBackupId, setSelectedBackupId] = useState('');
  const [restorePreview, setRestorePreview] = useState<RestorePreviewResult | null>(null);
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [restorePhrase, setRestorePhrase] = useState('');
  const [restoreReason, setRestoreReason] = useState('');
  const [lastRestoreJob, setLastRestoreJob] = useState<RestoreJobRecord | null>(null);

  // Emergency Force Unlock
  const [unlockReason, setUnlockReason] = useState('');

  const loadAll = async () => {
    setLoading(true);
    try {
      const [h, bList, rData, ret] = await Promise.all([
        fetchSystemHealthApi(),
        isSuperAdmin ? fetchSystemBackupsApi() : Promise.resolve([]),
        isSuperAdmin ? fetchRestoreJobsApi() : Promise.resolve({ jobs: [], lock: null }),
        isSuperAdmin ? fetchBackupRetentionApi() : Promise.resolve(null),
      ]);
      setHealth(h);
      setBackups(bList);
      setRestoreJobs(rData.jobs);
      setRestoreLock(rData.lock);
      setRetention(ret);
      if (!selectedBackupId) {
        const firstCompleted = bList.find((b) => b.status === 'COMPLETED');
        if (firstCompleted) setSelectedBackupId(firstCompleted.backupId);
      }
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  if (!isSuperAdmin) {
    return (
      <div className="rounded-xl bg-rose-950/35 border border-rose-500/40 p-6 space-y-2">
        <h2 className="font-display text-lg font-bold text-white flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-rose-400" />
          Akses Khusus SUPER_ADMIN
        </h2>
        <p className="text-sm text-rose-200">
          Modul Backup, Verification, Retention, dan Full System Restore hanya boleh diakses oleh SUPER_ADMIN demi menjaga keamanan data produksi XP PLAY.
        </p>
      </div>
    );
  }

  const handleCreateBackup = async (e: FormEvent) => {
    e.preventDefault();
    if (busyAction) return;
    setBusyAction('createBackup');
    setFeedback(null);
    try {
      const res = await createSystemBackupApi({ kind: 'MANUAL', note: backupNote.trim() });
      setBackupNote('');
      setVerifyModal(res.verification);
      setFeedback({
        type: res.record.status === 'COMPLETED' ? 'success' : 'error',
        text:
          res.record.status === 'COMPLETED'
            ? `Backup ${res.record.backupId} selesai & terverifikasi (${res.record.scopeType} · ${res.record.totalDocuments} dokumen, ${res.record.storageFileCount} file storage, ${formatBytesHuman(res.record.totalBackupBytes)}).`
            : `Backup ${res.record.backupId} selesai dengan status ${res.record.status}: ${res.record.verificationSummary}`,
      });
      await loadAll();
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const handleViewManifest = async (backupId: string) => {
    setBusyAction(`manifest:${backupId}`);
    setFeedback(null);
    try {
      const manifest = await fetchBackupManifestApi(backupId);
      setManifestModal(manifest);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const handleVerifyBackup = async (backupId: string) => {
    setBusyAction(`verify:${backupId}`);
    setFeedback(null);
    try {
      const res = await verifySystemBackupApi(backupId);
      setVerifyModal(res);
      setFeedback({
        type: res.passed ? 'success' : 'error',
        text: res.passed
          ? `Verifikasi backup ${backupId} LULUS (${res.checks.length}/${res.checks.length} pemeriksaan).`
          : `Verifikasi backup ${backupId} GAGAL (${res.status}). Backup ini tidak diizinkan untuk di-restore.`,
      });
      await loadAll();
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteBackup = async (backupId: string) => {
    setBusyAction(`delete:${backupId}`);
    setFeedback(null);
    try {
      await deleteSystemBackupApi(backupId);
      setFeedback({ type: 'success', text: `Backup ${backupId} berhasil dihapus.` });
      await loadAll();
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const handlePreviewRestore = async (targetId?: string) => {
    const id = targetId || selectedBackupId;
    if (!id) {
      setFeedback({ type: 'error', text: 'Pilih backup berstatus COMPLETED terlebih dahulu.' });
      return;
    }
    setSelectedBackupId(id);
    setSubTab('restore');
    setBusyAction('previewRestore');
    setFeedback(null);
    try {
      const prev = await previewRestoreApi(id);
      setRestorePreview(prev);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const handleExecuteRestore = async (e: FormEvent) => {
    e.preventDefault();
    if (!restorePreview || busyAction) return;
    setBusyAction('executeRestore');
    setFeedback(null);
    try {
      const job = await executeRestoreApi({
        backupId: restorePreview.backupId,
        confirmationPhrase: restorePhrase,
        reason: restoreReason,
      });
      setLastRestoreJob(job);
      setRestoreConfirmOpen(false);
      setRestorePhrase('');
      setRestoreReason('');
      setFeedback({
        type: job.status === 'COMPLETED' ? 'success' : 'error',
        text:
          job.status === 'COMPLETED'
            ? `Full System Restore selesai & terverifikasi (${job.restoreJobId}). Pre-Restore Backup pengaman: ${job.preRestoreBackupId}.`
            : `Restore berakhir dengan status ${job.status}: ${job.errorMessage || 'Verifikasi pasca-restore gagal.'}`,
      });
      await loadAll();
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
      await loadAll();
    } finally {
      setBusyAction(null);
    }
  };

  const handleRunIntegrityAudit = async () => {
    if (busyAction) return;
    setBusyAction('integrityAudit');
    setFeedback(null);
    try {
      const report = await runIntegrityAuditApi();
      setIntegrityReport(report);
      setFeedback({
        type: report.passed ? 'success' : 'error',
        text: report.passed
          ? `15-Point Data Integrity Audit LULUS (${report.passedChecks}/${report.totalChecks}, 0 temuan kritikal).`
          : `15-Point Data Integrity Audit menemukan ${report.criticalCount} masalah kritikal yang perlu ditindaklanjuti.`,
      });
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveRetention = async (e: FormEvent) => {
    e.preventDefault();
    if (!retention || busyAction) return;
    setBusyAction('saveRetention');
    setFeedback(null);
    try {
      const updated = await saveBackupRetentionApi({
        dailyRetentionCount: retention.dailyRetentionCount,
        weeklyRetentionCount: retention.weeklyRetentionCount,
        monthlyRetentionCount: retention.monthlyRetentionCount,
        customMaxAgeDays: retention.customMaxAgeDays,
        alwaysKeepLatestSuccessful: retention.alwaysKeepLatestSuccessful,
        alwaysKeepLatestPreRestore: retention.alwaysKeepLatestPreRestore,
      });
      setRetention(updated);
      setFeedback({ type: 'success', text: 'Kebijakan retensi backup berhasil diperbarui.' });
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const handleForceUnlock = async (e: FormEvent) => {
    e.preventDefault();
    if (busyAction) return;
    setBusyAction('forceUnlock');
    setFeedback(null);
    try {
      const lock = await forceUnlockRestoreApi(unlockReason);
      setRestoreLock(lock);
      setUnlockReason('');
      setFeedback({ type: 'success', text: 'Restore Lock darurat berhasil dilepas. Sistem kembali ke status IDLE.' });
      await loadAll();
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const completedBackups = backups.filter((b) => b.status === 'COMPLETED');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-bold text-white">Backup, Restore & System Integrity</h2>
          <p className="text-sm text-slate-400 mt-1">
            Backup terisolasi dengan checksum SHA-256, verifikasi otomatis, Restore Lock & Pre-Restore Backup wajib, 15-Point Data Integrity Audit, dan monitor kesehatan 9 komponen sistem.
          </p>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadAll()}
          className="px-3.5 py-2 rounded-lg border border-indigo-500/30 text-xs text-sky-300 hover:text-white flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Muat Ulang Status
        </button>
      </div>

      {/* Sub-Navigation */}
      <div className="flex flex-wrap items-center gap-1 p-1 rounded-xl bg-[#0B1124] border border-indigo-500/20">
        {(
          [
            ['overview', 'Overview & System Health', Activity],
            ['history', `Backup History (${backups.length})`, Database],
            ['restore', 'Restore Center', RotateCcw],
            ['integrity', '15-Point Integrity Audit', ShieldCheck],
            ['retention', 'Retention Settings', Settings],
            ['restoreLogs', `Restore Logs (${restoreJobs.length})`, FileCheck2],
          ] as [BackupSubTab, string, typeof Activity][]
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setSubTab(id)}
            className={`px-3.5 py-2 rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-colors ${
              subTab === id
                ? 'bg-sky-500 text-slate-950 font-semibold'
                : 'text-slate-300 hover:text-white hover:bg-indigo-500/10'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {feedback && (
        <div
          className={`rounded-xl px-4 py-3 text-sm border ${
            feedback.type === 'success'
              ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
              : 'bg-rose-950/40 border-rose-500/40 text-rose-200'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Active Restore Lock Alert + Emergency Recovery */}
      {restoreLock?.locked && (
        <div className="rounded-xl bg-amber-950/40 border border-amber-500/50 p-5 space-y-3">
          <div className="flex items-center gap-2 text-amber-200 font-semibold text-sm">
            <Lock className="w-4 h-4" />
            RESTORE LOCK AKTIF — Maintenance Mode Sedang Berjalan
          </div>
          <p className="text-xs text-amber-100/90">
            Job: <span className="font-mono">{restoreLock.restoreJobId}</span> · Target Backup:{' '}
            <span className="font-mono">{restoreLock.backupId}</span> · Dikunci oleh:{' '}
            <span>{restoreLock.lockedByEmail || restoreLock.lockedBy}</span>
          </p>
          <form onSubmit={handleForceUnlock} className="flex flex-wrap gap-2 pt-1">
            <input
              type="text"
              required
              value={unlockReason}
              onChange={(e) => setUnlockReason(e.target.value)}
              placeholder="Alasan pelepasan paksa (hanya jika proses restore terhenti abnormal)"
              className="flex-1 min-w-[240px] px-3 py-2 rounded-lg bg-[#070B19] border border-amber-500/40 text-xs text-white"
            />
            <button
              type="submit"
              disabled={busyAction === 'forceUnlock'}
              className="px-3.5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap"
            >
              <Unlock className="w-3.5 h-3.5" />
              Lepas Restore Lock Darurat
            </button>
          </form>
        </div>
      )}

      {/* TAB 1: OVERVIEW & 9-COMPONENT SYSTEM HEALTH */}
      {subTab === 'overview' && (
        <div className="space-y-6">
          {/* Quick Backup Action */}
          <form
            onSubmit={handleCreateBackup}
            className="rounded-xl bg-[#0B1124] border border-indigo-500/20 p-5 flex flex-col lg:flex-row lg:items-end justify-between gap-4"
          >
            <div className="flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-display text-base font-bold text-white">Jalankan Backup Sistem Sekarang</h3>
                <span className="text-xs text-slate-400">
                  · Mode aktual:{' '}
                  <strong className={health?.adminSdkConfigured ? 'text-emerald-300' : 'text-amber-300'}>
                    {health?.adminSdkConfigured
                      ? 'FULL_SYSTEM_BACKUP (Firestore + Storage + Firebase Auth Metadata)'
                      : 'FIRESTORE_AND_STORAGE_BACKUP (Firestore + Storage + Metadata Turunan)'}
                  </strong>
                </span>
              </div>
              <input
                type="text"
                value={backupNote}
                onChange={(e) => setBackupNote(e.target.value)}
                placeholder="Catatan backup opsional (contoh: Sebelum penyesuaian jadwal Season 2)"
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#070B19] border border-indigo-500/25 text-xs text-white placeholder-slate-500"
              />
            </div>
            <button
              type="submit"
              disabled={Boolean(busyAction) || Boolean(restoreLock?.locked)}
              className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-sky-500 to-indigo-500 hover:from-sky-400 hover:to-indigo-400 disabled:opacity-40 text-white text-xs font-semibold flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
            >
              <HardDrive className="w-4 h-4" />
              {busyAction === 'createBackup' ? 'Menjalankan Backup & Verifikasi...' : 'Buat Backup Terverifikasi'}
            </button>
          </form>

          {/* 9-Component System Health Grid (MODULE 23) */}
          <div className="rounded-xl bg-[#0B1124] border border-indigo-500/20 overflow-hidden">
            <div className="px-5 py-4 border-b border-indigo-500/15 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-display text-sm font-bold text-white">System Health Monitoring (9 Komponen)</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Status nyata konektivitas database, autentikasi, storage, XP Engine, CMS, backup, dan Restore Lock.
                </p>
              </div>
              {health && (
                <div className="text-xs font-mono">
                  Status Global:{' '}
                  <span className={`font-bold ${statusTextColor(health.overallStatus)}`}>
                    {health.overallStatus}
                  </span>{' '}
                  · v{health.appVersion} ({health.schemaVersion})
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:gap-px bg-indigo-500/15">
              {(health?.components ?? []).map((comp) => (
                <div key={comp.key} className="bg-[#0B1124] p-4 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-white">{comp.label}</span>
                    <span className={`text-[11px] font-mono font-bold ${statusTextColor(comp.status)}`}>
                      {comp.status}
                    </span>
                  </div>
                  <div className="text-xs text-slate-200 font-medium">{comp.summary}</div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">{comp.detail}</p>
                </div>
              ))}
              {!health && (
                <div className="col-span-3 bg-[#0B1124] p-8 text-center text-xs text-slate-500">
                  Memuat status kesehatan sistem...
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: BACKUP HISTORY */}
      {subTab === 'history' && (
        <div className="rounded-xl bg-[#0B1124] border border-indigo-500/20 overflow-hidden">
          <div className="px-5 py-4 border-b border-indigo-500/15 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-display text-sm font-bold text-white">Riwayat Backup Terisolasi</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Setiap backup disimpan pada direktori unik dengan checksum SHA-256 dan tidak pernah saling menimpa.
              </p>
            </div>
            <span className="text-xs font-mono text-slate-400">{backups.length} snapshot tercatat</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#070B19] text-slate-400 border-b border-indigo-500/15">
                <tr>
                  <th className="py-3 px-4 font-medium">Backup ID & Jenis</th>
                  <th className="py-3 px-4 font-medium">Cakupan</th>
                  <th className="py-3 px-4 font-medium">Status & Verifikasi</th>
                  <th className="py-3 px-4 font-medium text-right">Isi & Ukuran</th>
                  <th className="py-3 px-4 font-medium">Waktu & Pembuat</th>
                  <th className="py-3 px-4 font-medium text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-indigo-500/10 text-slate-200">
                {backups.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-slate-500">
                      Belum ada backup tersimpan. Buat backup pertama Anda dari tab Overview.
                    </td>
                  </tr>
                ) : (
                  backups.map((b) => (
                    <tr key={b.backupId} className="hover:bg-indigo-500/5">
                      <td className="py-3 px-4">
                        <div className="font-mono text-white font-medium">{b.backupId}</div>
                        <div className="text-[11px] text-slate-400">
                          {b.kind} · {b.schemaVersion} {b.note ? `· ${b.note}` : ''}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-[11px] font-mono text-sky-300 whitespace-nowrap">
                        {b.scopeType}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <div
                          className={`font-semibold ${
                            b.status === 'COMPLETED'
                              ? 'text-emerald-300'
                              : b.status === 'FAILED' || b.status === 'VERIFICATION_FAILED'
                              ? 'text-rose-300'
                              : 'text-amber-300'
                          }`}
                        >
                          {b.status}
                        </div>
                        <div className="text-[11px] text-slate-400">Verify: {b.verificationStatus}</div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                        <div>
                          {b.totalDocuments} doc · {b.storageFileCount} file · {b.authUserCount} akun
                        </div>
                        <div className="text-[11px] text-slate-400">
                          {formatBytesHuman(b.totalBackupBytes)}
                          {b.durationMs !== null ? ` · ${(b.durationMs / 1000).toFixed(1)}s` : ''}
                        </div>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <div className="font-mono tabular-nums text-slate-300">
                          {formatJakartaDateTime(b.createdAt)}
                        </div>
                        <div className="text-[11px] text-slate-400">{b.createdByEmail}</div>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={Boolean(busyAction)}
                            onClick={() => void handleViewManifest(b.backupId)}
                            className="px-2.5 py-1 rounded bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-200 border border-indigo-500/30 inline-flex items-center gap-1"
                          >
                            <Eye className="w-3 h-3" />
                            Manifest
                          </button>
                          <button
                            type="button"
                            disabled={Boolean(busyAction)}
                            onClick={() => void handleVerifyBackup(b.backupId)}
                            className="px-2.5 py-1 rounded bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 border border-sky-500/30 inline-flex items-center gap-1"
                          >
                            <CheckCircle2 className="w-3 h-3" />
                            Verify
                          </button>
                          {b.status === 'COMPLETED' && (
                            <button
                              type="button"
                              disabled={Boolean(busyAction) || Boolean(restoreLock?.locked)}
                              onClick={() => void handlePreviewRestore(b.backupId)}
                              className="px-2.5 py-1 rounded bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 border border-amber-500/30 inline-flex items-center gap-1"
                            >
                              <RotateCcw className="w-3 h-3" />
                              Restore
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={Boolean(busyAction)}
                            onClick={() => void handleDeleteBackup(b.backupId)}
                            title="Hapus backup (dilindungi kebijakan retensi)"
                            className="px-2 py-1 rounded bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: RESTORE CENTER (MODULES 11-19) */}
      {subTab === 'restore' && (
        <div className="space-y-6">
          <div className="rounded-xl bg-[#0B1124] border border-indigo-500/20 p-5 space-y-4">
            <div>
              <h3 className="font-display text-base font-bold text-white">Full System Restore Center</h3>
              <p className="text-xs text-slate-400 mt-1">
                Setiap restore wajib melewati validasi manifest & checksum, Preview Perbandingan, konfirmasi ketik <span className="font-mono text-amber-300">{RESTORE_CONFIRMATION_PHRASE}</span>, pengaktifan Restore Lock, pembuatan Pre-Restore Backup otomatis, dan 15-Point Post-Restore Verification.
              </p>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <label className="flex-1 min-w-[260px] space-y-1.5">
                <span className="text-xs font-medium text-slate-300">Pilih Backup Target (Hanya Status COMPLETED)</span>
                <select
                  value={selectedBackupId}
                  onChange={(e) => {
                    setSelectedBackupId(e.target.value);
                    setRestorePreview(null);
                  }}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#070B19] border border-indigo-500/25 text-xs text-white font-mono"
                >
                  <option value="">-- Pilih snapshot backup --</option>
                  {completedBackups.map((b) => (
                    <option key={b.backupId} value={b.backupId}>
                      {b.backupId} ({b.kind} · {b.totalDocuments} doc · {formatJakartaDateTime(b.createdAt)})
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                disabled={!selectedBackupId || busyAction === 'previewRestore'}
                onClick={() => void handlePreviewRestore(selectedBackupId)}
                className="px-4 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 text-xs font-semibold whitespace-nowrap"
              >
                {busyAction === 'previewRestore' ? 'Menyiapkan Preview...' : 'Preview Perbandingan Restore'}
              </button>
            </div>
          </div>

          {restorePreview && (
            <div className="rounded-xl bg-[#0B1124] border border-amber-500/35 p-5 space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h4 className="font-display text-sm font-bold text-white">
                    Restore Preview: <span className="font-mono text-sky-300">{restorePreview.backupId}</span>
                  </h4>
                  <p className="text-xs text-slate-400 mt-1">
                    Dibuat {formatJakartaDateTime(restorePreview.backupCreatedAt)} · {restorePreview.backupScopeType} · App v{restorePreview.backupAppVersion} / Schema {restorePreview.backupSchemaVersion}
                  </p>
                </div>
                <div className="text-xs font-mono">
                  Kompatibilitas:{' '}
                  <span className={restorePreview.canProceed ? 'text-emerald-300 font-bold' : 'text-rose-300 font-bold'}>
                    {restorePreview.canProceed ? 'SIAP DI-RESTORE' : 'DIBLOKIR'}
                  </span>
                </div>
              </div>

              {restorePreview.blockingReasons.length > 0 && (
                <div className="rounded-lg bg-rose-950/40 border border-rose-500/40 p-4 space-y-1 text-xs text-rose-200">
                  <div className="font-semibold text-rose-100">Restore Diblokir Karena:</div>
                  {restorePreview.blockingReasons.map((r, i) => (
                    <div key={i}>• {r}</div>
                  ))}
                </div>
              )}

              <div className="rounded-lg bg-amber-950/30 border border-amber-500/35 p-4 space-y-1.5 text-xs text-amber-100">
                <div className="font-semibold flex items-center gap-1.5 text-amber-200">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  Peringatan Penting Sebelum Restore
                </div>
                {restorePreview.warnings.map((w, i) => (
                  <div key={i}>• {w}</div>
                ))}
              </div>

              <div className="overflow-x-auto border border-indigo-500/15 rounded-lg">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#070B19] text-slate-400 border-b border-indigo-500/15">
                    <tr>
                      <th className="py-2.5 px-4 font-medium">Koleksi / Aset</th>
                      <th className="py-2.5 px-4 font-medium text-right">Data Live</th>
                      <th className="py-2.5 px-4 font-medium text-right">Data Backup</th>
                      <th className="py-2.5 px-4 font-medium text-right">Selisih</th>
                      <th className="py-2.5 px-4 font-medium">Perlakuan</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-indigo-500/10 text-slate-200 font-mono tabular-nums">
                    {restorePreview.collections.map((c) => (
                      <tr key={c.collection}>
                        <td className="py-2 px-4 text-white">{c.collection}</td>
                        <td className="py-2 px-4 text-right">{c.liveCount}</td>
                        <td className="py-2 px-4 text-right text-sky-300">{c.backupCount}</td>
                        <td
                          className={`py-2 px-4 text-right ${
                            c.delta === 0 ? 'text-slate-500' : c.delta > 0 ? 'text-emerald-300' : 'text-amber-300'
                          }`}
                        >
                          {c.delta > 0 ? `+${c.delta}` : c.delta}
                        </td>
                        <td className="py-2 px-4 font-sans text-[11px]">
                          {c.protectedFromOverwrite ? (
                            <span className="text-emerald-300">Dilindungi (Tidak ditimpa)</span>
                          ) : (
                            <span className="text-amber-200">Akan dipulihkan ke snapshot</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-[#070B19]/60">
                      <td className="py-2 px-4 text-white">storageObjects (claims + cms)</td>
                      <td className="py-2 px-4 text-right">{restorePreview.liveStorageCount}</td>
                      <td className="py-2 px-4 text-right text-sky-300">{restorePreview.backupStorageCount}</td>
                      <td className="py-2 px-4 text-right">
                        {restorePreview.backupStorageCount - restorePreview.liveStorageCount}
                      </td>
                      <td className="py-2 px-4 font-sans text-[11px] text-amber-200">
                        Dipulihkan dari backup
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={!restorePreview.canProceed || Boolean(restoreLock?.locked)}
                  onClick={() => setRestoreConfirmOpen(true)}
                  className="px-5 py-2.5 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-2"
                >
                  <RotateCcw className="w-4 h-4" />
                  Lanjutkan ke Konfirmasi Restore
                </button>
              </div>
            </div>
          )}

          {lastRestoreJob && (
            <div className="rounded-xl bg-[#0B1124] border border-indigo-500/25 p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-display text-sm font-bold text-white">
                  Hasil Eksekusi Restore: <span className="font-mono text-sky-300">{lastRestoreJob.restoreJobId}</span>
                </h4>
                <span
                  className={`text-xs font-mono font-bold ${
                    lastRestoreJob.status === 'COMPLETED' ? 'text-emerald-300' : 'text-rose-300'
                  }`}
                >
                  {lastRestoreJob.status}
                </span>
              </div>
              <div className="text-xs text-slate-300 space-y-1">
                <div>
                  Pre-Restore Backup Pengaman:{' '}
                  <span className="font-mono text-emerald-300">{lastRestoreJob.preRestoreBackupId || '-'}</span>
                </div>
                <div>Catatan Auth Restore: {lastRestoreJob.authRestoreNotice}</div>
                {lastRestoreJob.recoveryRecommendation && (
                  <div className="p-3 rounded-lg bg-rose-950/35 border border-rose-500/35 text-rose-200 mt-2">
                    {lastRestoreJob.recoveryRecommendation}
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                {lastRestoreJob.steps.map((s, idx) => (
                  <div
                    key={idx}
                    className="flex flex-wrap items-center justify-between gap-2 text-xs py-1.5 border-b border-indigo-500/10"
                  >
                    <span className="font-mono text-slate-200">{s.step}</span>
                    <span className="text-slate-400 flex-1 px-3">{s.detail}</span>
                    <span
                      className={`font-mono font-semibold ${
                        s.status === 'DONE'
                          ? 'text-emerald-300'
                          : s.status === 'FAILED'
                          ? 'text-rose-300'
                          : 'text-amber-300'
                      }`}
                    >
                      {s.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: 15-POINT DATA INTEGRITY AUDIT (FASE 32) */}
      {subTab === 'integrity' && (
        <div className="space-y-5">
          <div className="rounded-xl bg-[#0B1124] border border-indigo-500/20 p-5 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="font-display text-base font-bold text-white">15-Point Data Integrity Verification</h3>
              <p className="text-xs text-slate-400 mt-1">
                Audit menyeluruh atas konsistensi XP Progress, XP Reward, Reserved XP, Benefit Requests, anti-duplicate hold/refund, profil member, Level, saldo negatif, duplikat username/WA, referral, claims, redemptions, transaksi, storage, dan aset CMS.
              </p>
            </div>
            <button
              type="button"
              disabled={busyAction === 'integrityAudit'}
              onClick={() => void handleRunIntegrityAudit()}
              className="px-4 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 text-xs font-semibold flex items-center gap-2 whitespace-nowrap"
            >
              <ShieldCheck className="w-4 h-4" />
              {busyAction === 'integrityAudit' ? 'Memeriksa 15 Indikator...' : 'Jalankan 15-Point Audit'}
            </button>
          </div>

          {integrityReport ? (
            <div className="rounded-xl bg-[#0B1124] border border-indigo-500/20 overflow-hidden">
              <div className="px-5 py-4 border-b border-indigo-500/15 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="font-mono">
                  Audit ID: <span className="text-sky-300">{integrityReport.auditId}</span> ·{' '}
                  {formatJakartaDateTime(integrityReport.checkedAt)}
                </div>
                <div className="font-mono font-bold">
                  <span className={integrityReport.passed ? 'text-emerald-300' : 'text-rose-300'}>
                    {integrityReport.passed ? 'LULUS' : 'DITEMUKAN MASALAH'} ({integrityReport.passedChecks}/
                    {integrityReport.totalChecks} · Kritikal: {integrityReport.criticalCount})
                  </span>
                </div>
              </div>
              <div className="divide-y divide-indigo-500/10">
                {integrityReport.checks.map((chk) => (
                  <div key={chk.code} className="p-4 space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-white">{chk.label}</span>
                      <span
                        className={`text-xs font-mono font-bold ${
                          chk.passed ? 'text-emerald-300' : 'text-rose-300'
                        }`}
                      >
                        {chk.passed ? 'PASS' : `FAIL (${chk.issueCount})`}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">{chk.summary}</p>
                    {chk.samples.length > 0 && (
                      <div className="mt-2 p-2.5 rounded bg-rose-950/30 border border-rose-500/30 font-mono text-[11px] text-rose-200 space-y-1">
                        {chk.samples.map((s, i) => (
                          <div key={i}>• {s}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-[#0B1124] border border-indigo-500/20 p-10 text-center text-xs text-slate-500">
              Klik tombol &ldquo;Jalankan 15-Point Audit&rdquo; untuk memeriksa kesehatan data live secara real-time.
            </div>
          )}
        </div>
      )}

      {/* TAB 5: RETENTION SETTINGS (MODULE 9) */}
      {subTab === 'retention' && retention && (
        <form
          onSubmit={handleSaveRetention}
          className="rounded-xl bg-[#0B1124] border border-indigo-500/20 p-6 space-y-5 max-w-2xl"
        >
          <div>
            <h3 className="font-display text-base font-bold text-white">Kebijakan Retensi Backup</h3>
            <p className="text-xs text-slate-400 mt-1">
              Mengatur jumlah snapshot harian, mingguan, bulanan, dan perlindungan wajib terhadap backup sukses terakhir & Pre-Restore Backup terakhir.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block space-y-1.5">
              <span className="text-xs text-slate-300">Retensi Harian (jumlah backup)</span>
              <input
                type="number"
                min={1}
                max={90}
                value={retention.dailyRetentionCount}
                onChange={(e) =>
                  setRetention({ ...retention, dailyRetentionCount: Number(e.target.value) })
                }
                className="w-full px-3.5 py-2 rounded-lg bg-[#070B19] border border-indigo-500/25 text-sm text-white font-mono tabular-nums"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs text-slate-300">Retensi Mingguan (jumlah backup)</span>
              <input
                type="number"
                min={1}
                max={52}
                value={retention.weeklyRetentionCount}
                onChange={(e) =>
                  setRetention({ ...retention, weeklyRetentionCount: Number(e.target.value) })
                }
                className="w-full px-3.5 py-2 rounded-lg bg-[#070B19] border border-indigo-500/25 text-sm text-white font-mono tabular-nums"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs text-slate-300">Retensi Bulanan (jumlah backup)</span>
              <input
                type="number"
                min={1}
                max={36}
                value={retention.monthlyRetentionCount}
                onChange={(e) =>
                  setRetention({ ...retention, monthlyRetentionCount: Number(e.target.value) })
                }
                className="w-full px-3.5 py-2 rounded-lg bg-[#070B19] border border-indigo-500/25 text-sm text-white font-mono tabular-nums"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs text-slate-300">Batas Usia Maksimum (hari)</span>
              <input
                type="number"
                min={7}
                max={3650}
                value={retention.customMaxAgeDays}
                onChange={(e) =>
                  setRetention({ ...retention, customMaxAgeDays: Number(e.target.value) })
                }
                className="w-full px-3.5 py-2 rounded-lg bg-[#070B19] border border-indigo-500/25 text-sm text-white font-mono tabular-nums"
              />
            </label>
          </div>

          <div className="space-y-2.5 pt-2 border-t border-indigo-500/15">
            <label className="flex items-center gap-2.5 text-xs text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={retention.alwaysKeepLatestSuccessful}
                onChange={(e) =>
                  setRetention({ ...retention, alwaysKeepLatestSuccessful: e.target.checked })
                }
                className="rounded border-indigo-500/40 bg-[#070B19] text-sky-400"
              />
              Selalu lindungi backup sukses terakhir agar tidak dapat dihapus
            </label>
            <label className="flex items-center gap-2.5 text-xs text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={retention.alwaysKeepLatestPreRestore}
                onChange={(e) =>
                  setRetention({ ...retention, alwaysKeepLatestPreRestore: e.target.checked })
                }
                className="rounded border-indigo-500/40 bg-[#070B19] text-sky-400"
              />
              Selalu lindungi Pre-Restore Backup terakhir untuk keamanan rollback
            </label>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={busyAction === 'saveRetention'}
              className="px-4 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 text-xs font-semibold"
            >
              {busyAction === 'saveRetention' ? 'Menyimpan...' : 'Simpan Kebijakan Retensi'}
            </button>
          </div>
        </form>
      )}

      {/* TAB 6: RESTORE HISTORY & LOGS */}
      {subTab === 'restoreLogs' && (
        <div className="rounded-xl bg-[#0B1124] border border-indigo-500/20 overflow-hidden">
          <div className="px-5 py-4 border-b border-indigo-500/15">
            <h3 className="font-display text-sm font-bold text-white">Riwayat Job Full System Restore</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#070B19] text-slate-400 border-b border-indigo-500/15">
                <tr>
                  <th className="py-3 px-4 font-medium">Restore Job ID</th>
                  <th className="py-3 px-4 font-medium">Target & Pre-Restore Backup</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                  <th className="py-3 px-4 font-medium">Verifikasi 15-Point</th>
                  <th className="py-3 px-4 font-medium">Waktu & Operator</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-indigo-500/10 text-slate-200">
                {restoreJobs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-10 text-center text-slate-500">
                      Belum ada riwayat proses restore.
                    </td>
                  </tr>
                ) : (
                  restoreJobs.map((j) => (
                    <tr key={j.restoreJobId} className="hover:bg-indigo-500/5">
                      <td className="py-3 px-4 font-mono">
                        <div className="text-white">{j.restoreJobId}</div>
                        <div className="text-[11px] text-slate-400 font-sans">{j.reason}</div>
                      </td>
                      <td className="py-3 px-4 font-mono text-[11px]">
                        <div>Target: <span className="text-sky-300">{j.targetBackupId}</span></div>
                        <div>Pre-Restore: <span className="text-emerald-300">{j.preRestoreBackupId || '-'}</span></div>
                      </td>
                      <td className="py-3 px-4 font-mono font-bold whitespace-nowrap">
                        <span
                          className={
                            j.status === 'COMPLETED'
                              ? 'text-emerald-300'
                              : j.status === 'VERIFICATION_FAILED' || j.status === 'FAILED'
                              ? 'text-rose-300'
                              : 'text-amber-300'
                          }
                        >
                          {j.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-mono text-[11px] whitespace-nowrap">
                        {j.integrityReport ? (
                          <span className={j.integrityReport.passed ? 'text-emerald-300' : 'text-rose-300'}>
                            {j.integrityReport.passedChecks}/{j.integrityReport.totalChecks} (Kritikal:{' '}
                            {j.integrityReport.criticalCount})
                          </span>
                        ) : (
                          <span className="text-slate-500">-</span>
                        )}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <div className="font-mono tabular-nums">{formatJakartaDateTime(j.startedAt)}</div>
                        <div className="text-[11px] text-slate-400">{j.requestedByEmail}</div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MODAL: RESTORE DOUBLE CONFIRMATION (MODULE 15) */}
      {restoreConfirmOpen && restorePreview && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleExecuteRestore}
            className="max-w-lg w-full rounded-xl bg-[#0B1124] border border-rose-500/50 p-6 space-y-4"
          >
            <h3 className="font-display text-lg font-bold text-rose-200 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-rose-400" />
              Konfirmasi Akhir Full System Restore
            </h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              Anda akan memulihkan seluruh data bisnis & storage ke snapshot{' '}
              <span className="font-mono text-white">{restorePreview.backupId}</span>. Selama restore berlangsung, portal member masuk ke Maintenance Mode dan Pre-Restore Backup akan dibuat otomatis terlebih dahulu.
            </p>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-300">Alasan Restore (Wajib)</span>
              <input
                type="text"
                required
                minLength={3}
                value={restoreReason}
                onChange={(e) => setRestoreReason(e.target.value)}
                placeholder="Contoh: Pemulihan insiden kesalahan input massal"
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#070B19] border border-indigo-500/25 text-xs text-white"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-300">
                Ketik persis <span className="font-mono text-amber-300 font-bold">{RESTORE_CONFIRMATION_PHRASE}</span> untuk mengonfirmasi:
              </span>
              <input
                type="text"
                required
                value={restorePhrase}
                onChange={(e) => setRestorePhrase(e.target.value)}
                placeholder={RESTORE_CONFIRMATION_PHRASE}
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#070B19] border border-rose-500/40 text-sm text-white font-mono"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={busyAction === 'executeRestore'}
                onClick={() => setRestoreConfirmOpen(false)}
                className="px-4 py-2 rounded-lg border border-indigo-500/25 text-xs text-slate-300 hover:text-white"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={
                  busyAction === 'executeRestore' ||
                  restorePhrase.trim() !== RESTORE_CONFIRMATION_PHRASE ||
                  restoreReason.trim().length < 3
                }
                className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white text-xs font-semibold"
              >
                {busyAction === 'executeRestore' ? 'Menjalankan Restore...' : 'Jalankan Full System Restore'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: MANIFEST INSPECTOR */}
      {manifestModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-3xl w-full max-h-[85vh] overflow-y-auto rounded-xl bg-[#0B1124] border border-indigo-500/30 p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-base font-bold text-white">Backup Manifest Inspector</h3>
                <div className="text-xs font-mono text-sky-300 mt-0.5">{manifestModal.backupId}</div>
              </div>
              <button
                type="button"
                onClick={() => setManifestModal(null)}
                className="px-3 py-1.5 rounded-lg border border-indigo-500/25 text-xs text-slate-300 hover:text-white"
              >
                Tutup
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs bg-[#070B19] rounded-lg p-4 border border-indigo-500/15 font-mono">
              <div>Scope: <span className="text-sky-300">{manifestModal.scopeType}</span></div>
              <div>Auth Mode: <span className="text-white">{manifestModal.authExportMode}</span></div>
              <div>App / Schema: <span className="text-white">v{manifestModal.appVersion} / {manifestModal.schemaVersion}</span></div>
              <div>Total Size: <span className="text-white">{formatBytesHuman(manifestModal.totalBackupBytes)}</span></div>
              <div className="sm:col-span-2 break-all">
                Manifest SHA-256: <span className="text-emerald-300">{manifestModal.manifestChecksumSha256}</span>
              </div>
            </div>

            <p className="text-xs text-amber-200 bg-amber-950/30 border border-amber-500/30 rounded-lg p-3">
              {manifestModal.authLimitationNotice}
            </p>

            <div className="overflow-x-auto border border-indigo-500/15 rounded-lg">
              <table className="w-full text-left text-xs font-mono tabular-nums">
                <thead className="bg-[#070B19] text-slate-400">
                  <tr>
                    <th className="py-2 px-3">Koleksi</th>
                    <th className="py-2 px-3 text-right">Dokumen</th>
                    <th className="py-2 px-3 text-right">Ukuran</th>
                    <th className="py-2 px-3">SHA-256</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-indigo-500/10 text-slate-200">
                  {manifestModal.firestoreCollections.map((c) => (
                    <tr key={c.collection}>
                      <td className="py-1.5 px-3 text-white">{c.collection}</td>
                      <td className="py-1.5 px-3 text-right">{c.documentCount}</td>
                      <td className="py-1.5 px-3 text-right">{formatBytesHuman(c.byteSize)}</td>
                      <td className="py-1.5 px-3 text-slate-400">{c.checksumSha256.slice(0, 20)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: VERIFICATION RESULT */}
      {verifyModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-2xl w-full max-h-[85vh] overflow-y-auto rounded-xl bg-[#0B1124] border border-indigo-500/30 p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-base font-bold text-white">Hasil Verifikasi Integritas Backup</h3>
                <div className="text-xs font-mono text-sky-300 mt-0.5">
                  {verifyModal.backupId} ·{' '}
                  <span className={verifyModal.passed ? 'text-emerald-300' : 'text-rose-300'}>
                    {verifyModal.status}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setVerifyModal(null)}
                className="px-3 py-1.5 rounded-lg border border-indigo-500/25 text-xs text-slate-300 hover:text-white"
              >
                Tutup
              </button>
            </div>
            <div className="divide-y divide-indigo-500/10">
              {verifyModal.checks.map((c) => (
                <div key={c.code} className="py-2.5 flex items-start justify-between gap-3 text-xs">
                  <div>
                    <div className="font-semibold text-white">{c.label}</div>
                    <div className="text-slate-400 mt-0.5">{c.detail}</div>
                  </div>
                  <span className={`font-mono font-bold shrink-0 ${c.passed ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {c.passed ? 'PASS' : 'FAIL'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
