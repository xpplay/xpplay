import { useEffect, useState, type FormEvent } from 'react';
import { Bell, Clock, KeyRound, Search, Send, Users } from 'lucide-react';
import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import {
  createAndDispatchNotificationByAdmin,
  fetchInactiveMembersPage,
  fetchIncompleteRegistrationReport,
  regenerateOnboardingCodeClient,
} from '../services/xpService.ts';
import {
  formatInactiveDurationLabel,
  INACTIVE_PERIOD_PRESETS,
} from '../shared/inactiveLogic.ts';
import { formatJakartaDateTime, getBranchLabel } from '../shared/xpLogic.ts';
import type {
  AdminUser,
  BranchId,
  InactiveMemberRow,
  IncompleteRegistrationRow,
  LevelId,
  MemberProfile,
} from '../types/xpplay.ts';

interface AdminInactiveMembersProps {
  adminProfile: AdminUser;
  restoreLocked: boolean;
  onSelectForPassword?: (member: MemberProfile) => void;
  onSelectForXpAdjustment?: (member: MemberProfile) => void;
}

export function AdminInactiveMembers({
  adminProfile,
  restoreLocked,
  onSelectForPassword,
  onSelectForXpAdjustment,
}: AdminInactiveMembersProps) {
  const canSendNotification =
    adminProfile.role === 'SUPER_ADMIN' ||
    adminProfile.role === 'ADMIN' ||
    adminProfile.permissions.manageNotifications;

  const [reportTab, setReportTab] = useState<'INACTIVE_ACTIVE' | 'INCOMPLETE_PRE_REGISTERED'>('INACTIVE_ACTIVE');
  const [incompleteMinDays, setIncompleteMinDays] = useState<7 | 14 | 30>(7);
  const [incompleteBranch, setIncompleteBranch] = useState<'ALL' | BranchId>('ALL');
  const [incompleteRows, setIncompleteRows] = useState<IncompleteRegistrationRow[]>([]);
  const [loadingIncomplete, setLoadingIncomplete] = useState(false);

  const [presetDays, setPresetDays] = useState<number | 'CUSTOM'>(30);
  const [customDays, setCustomDays] = useState('45');
  const [mode, setMode] = useState<'PLAYED' | 'NEVER_PLAYED'>('PLAYED');
  const [branchFilter, setBranchFilter] = useState<'ALL' | BranchId>('ALL');
  const [levelFilter, setLevelFilter] = useState<'ALL' | LevelId>('ALL');
  const [search, setSearch] = useState('');

  const [rows, setRows] = useState<InactiveMemberRow[]>([]);
  const [cursor, setCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  // Integrated Notification Campaign Modal
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifTitle, setNotifTitle] = useState('');
  const [notifMessage, setNotifMessage] = useState('');
  const [dedupeDaily, setDedupeDaily] = useState(true);
  const [sendingNotif, setSendingNotif] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadIncompleteReport = async () => {
    setLoadingIncomplete(true);
    try {
      const list = await fetchIncompleteRegistrationReport({
        minDays: incompleteMinDays,
        branchFilter: incompleteBranch,
      });
      setIncompleteRows(list);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setLoadingIncomplete(false);
    }
  };

  useEffect(() => {
    if (reportTab === 'INCOMPLETE_PRE_REGISTERED') {
      void loadIncompleteReport();
    }
  }, [reportTab, incompleteMinDays, incompleteBranch]);

  const effectiveDays =
    presetDays === 'CUSTOM' ? Math.max(1, Math.min(3650, Number(customDays) || 30)) : presetDays;

  const loadPage = async (reset: boolean) => {
    setLoading(true);
    setFeedback(null);
    try {
      const res = await fetchInactiveMembersPage({
        thresholdDays: effectiveDays,
        mode,
        branchFilter,
        levelFilter,
        search,
        pageSize: 25,
        cursor: reset ? null : cursor,
      });
      setRows((prev) => (reset ? res.rows : [...prev, ...res.rows]));
      setCursor(res.nextCursor);
      setHasMore(res.hasMore);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPage(true);
  }, [effectiveDays, mode, branchFilter, levelFilter]);

  const handleSearchSubmit = (e: FormEvent) => {
    e.preventDefault();
    void loadPage(true);
  };

  const openBulkNotifModal = () => {
    setNotifTitle(`Kami rindu kehadiran Anda di XP PLAY (${effectiveDays}+ hari)`);
    setNotifMessage(
      `Sudah lebih dari ${effectiveDays} hari tidak bermain di XP PLAY Demang & Sekip. Yuk main lagi minggu ini dan kumpulkan XP Progress & XP Reward menarik!`
    );
    setNotifOpen(true);
  };

  const handleDispatchInactiveNotif = async (e: FormEvent) => {
    e.preventDefault();
    if (sendingNotif || restoreLocked) return;
    setSendingNotif(true);
    setFeedback(null);
    try {
      const res = await createAndDispatchNotificationByAdmin({
        title: notifTitle,
        message: notifMessage,
        targetType: 'INACTIVE_MEMBERS',
        targetFilter: `${effectiveDays}d:${branchFilter}:${levelFilter}`,
        inactivityDays: effectiveDays,
        branchFilter,
        levelFilter,
        includeNeverPlayed: mode === 'NEVER_PLAYED' || true,
        dedupeDaily,
        admin: adminProfile,
      });
      setNotifOpen(false);
      setFeedback({
        type: 'success',
        text: `Notifikasi inaktif terkirim ke ${res.dispatchedCount} member${
          res.skippedDuplicateCount > 0
            ? ` (${res.skippedDuplicateCount} dilewati karena sudah menerima notifikasi kohort hari ini)`
            : ''
        }.`,
      });
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setSendingNotif(false);
    }
  };

  const handleQuickSingleNotif = async (member: MemberProfile, days: number) => {
    if (!canSendNotification || restoreLocked) return;
    setFeedback(null);
    try {
      const res = await createAndDispatchNotificationByAdmin({
        title: 'Yuk Main Lagi di XP PLAY!',
        message: `Halo ${member.fullName}, sudah ${days} hari tidak bermain di XP PLAY. Kunjungi cabang Demang atau Sekip dan tingkatkan XP Anda!`,
        targetType: 'SPECIFIC_MEMBER',
        targetFilter: member.username,
        inactivityDays: null,
        admin: adminProfile,
      });
      setFeedback({
        type: 'success',
        text: `Notifikasi pengingat berhasil dikirim ke @${member.username} (${res.dispatchedCount} terkirim).`,
      });
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    }
  };

  const periodLabel = (d: number) => (d === 365 ? '1 Tahun' : `${d} Hari`);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-bold text-white">Inactive Member Management</h2>
          <p className="text-sm text-slate-400 mt-1">
            Pantau member aktif yang belum bermain kembali berdasarkan periode inaktivitas (diurutkan dari yang paling lama tidak bermain) dengan pagination terindeks.
          </p>
        </div>

        {canSendNotification && (
          <button
            type="button"
            disabled={restoreLocked}
            onClick={openBulkNotifModal}
            className="px-4 py-2.5 rounded-lg bg-gradient-to-r from-sky-500 to-purple-500 hover:from-sky-400 hover:to-purple-400 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
          >
            <Bell className="w-3.5 h-3.5" />
            Kirim Notifikasi Inaktif ({effectiveDays}+ hr)
          </button>
        )}
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

      {/* Report Mode Toggle: Inactive ACTIVE vs Incomplete PRE_REGISTERED */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setReportTab('INACTIVE_ACTIVE')}
          className={`px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${
            reportTab === 'INACTIVE_ACTIVE'
              ? 'bg-sky-500 text-slate-950'
              : 'bg-[#0B1124] border border-indigo-500/25 text-slate-300 hover:text-white'
          }`}
        >
          Member Aktif Inaktif
        </button>
        <button
          type="button"
          onClick={() => setReportTab('INCOMPLETE_PRE_REGISTERED')}
          className={`px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${
            reportTab === 'INCOMPLETE_PRE_REGISTERED'
              ? 'bg-amber-400 text-slate-950'
              : 'bg-[#0B1124] border border-indigo-500/25 text-slate-300 hover:text-white'
          }`}
        >
          Incomplete Registration (Pre-Registered 7 / 14 / 30 Hr)
        </button>
      </div>

      {reportTab === 'INCOMPLETE_PRE_REGISTERED' && (
        <div className="rounded-2xl bg-[#0B1124] border border-amber-400/35 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-base font-bold text-white">
                Laporan Incomplete Registration (PRE_REGISTERED)
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Monitoring read-only customer yang sudah didaftarkan Kasir namun belum menyelesaikan pendaftaran online. Member PRE_REGISTERED tidak pernah dihapus otomatis dan tetap dapat bertransaksi di Kasir.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {([7, 14, 30] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setIncompleteMinDays(d)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                    incompleteMinDays === d
                      ? 'bg-amber-400 text-slate-950'
                      : 'bg-[#070B19] border border-indigo-500/25 text-slate-300'
                  }`}
                >
                  &ge; {d} Hari
                </button>
              ))}
              <select
                value={incompleteBranch}
                onChange={(e) => setIncompleteBranch(e.target.value as 'ALL' | BranchId)}
                className="h-8 rounded-lg bg-[#070B19] border border-indigo-500/25 px-2.5 text-xs text-white"
              >
                <option value="ALL">Semua Cabang</option>
                <option value="DEMANG">Cabang DEMANG</option>
                <option value="SEKIP">Cabang SEKIP</option>
              </select>
            </div>
          </div>

          {loadingIncomplete ? (
            <p className="text-xs text-slate-400">Memuat laporan incomplete registration...</p>
          ) : incompleteRows.length === 0 ? (
            <p className="text-sm text-slate-400">
              Tidak ada member PRE_REGISTERED yang menunggu &ge; {incompleteMinDays} hari pada filter ini.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-indigo-500/20 text-slate-400">
                  <tr>
                    <th className="py-2 pr-3">Member ID</th>
                    <th className="py-2 pr-3">WhatsApp</th>
                    <th className="py-2 pr-3">Cabang</th>
                    <th className="py-2 pr-3">Pre-Registered</th>
                    <th className="py-2 pr-3">Durasi Tunggu</th>
                    <th className="py-2 pr-3">XP Transaksi</th>
                    <th className="py-2 text-right">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-indigo-500/15">
                  {incompleteRows.map((row) => (
                    <tr key={row.member.uid}>
                      <td className="py-2.5 pr-3 font-mono text-white">{row.member.memberId}</td>
                      <td className="py-2.5 pr-3 font-mono text-sky-300">{row.member.whatsapp}</td>
                      <td className="py-2.5 pr-3 font-mono text-slate-300">
                        {row.branchId ? getBranchLabel(row.branchId) : '-'}
                      </td>
                      <td className="py-2.5 pr-3 text-slate-400">
                        {formatJakartaDateTime(row.member.preRegisteredAt ?? row.member.createdAt)}
                      </td>
                      <td className="py-2.5 pr-3 font-mono font-bold text-amber-300">
                        {row.daysSincePreRegistered} hari
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-emerald-300">
                        {row.member.xpProgress} XP {row.hasTransactions ? '(Sudah main)' : '(Belum transaksi)'}
                      </td>
                      <td className="py-2.5 text-right">
                        <button
                          type="button"
                          disabled={restoreLocked}
                          onClick={async () => {
                            try {
                              const res = await regenerateOnboardingCodeClient({
                                member: row.member,
                                actor: adminProfile,
                              });
                              await navigator.clipboard.writeText(res.whatsappShareMessage).catch(() => {});
                              setFeedback({
                                type: 'success',
                                text: `Kode verifikasi baru ${res.verificationCode} untuk ${row.member.whatsapp} diterbitkan & pesan WA disalin.`,
                              });
                            } catch (err) {
                              setFeedback({ type: 'error', text: mapFriendlyError(err) });
                            }
                          }}
                          className="px-2.5 py-1.5 rounded-lg border border-amber-400/40 text-amber-200 font-semibold hover:bg-amber-500/15"
                        >
                          Buat Ulang Kode
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {reportTab === 'INACTIVE_ACTIVE' && (<>

      {/* Period Preset Selector + Cohort Mode + Filters */}
      <div className="rounded-xl bg-[#0B1124] border border-indigo-500/20 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {INACTIVE_PERIOD_PRESETS.map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => setPresetDays(days)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                  presetDays === days
                    ? 'bg-sky-500 text-slate-950 font-semibold'
                    : 'bg-[#070B19] text-slate-300 border border-indigo-500/20 hover:text-white'
                }`}
              >
                {periodLabel(days)}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPresetDays('CUSTOM')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                presetDays === 'CUSTOM'
                  ? 'bg-sky-500 text-slate-950 font-semibold'
                  : 'bg-[#070B19] text-slate-300 border border-indigo-500/20 hover:text-white'
              }`}
            >
              Custom
            </button>
            {presetDays === 'CUSTOM' && (
              <div className="flex items-center gap-1.5 ml-1">
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={customDays}
                  onChange={(e) => setCustomDays(e.target.value)}
                  className="w-20 px-2.5 py-1.5 rounded-lg bg-[#070B19] border border-sky-400/50 text-xs text-white font-mono tabular-nums"
                />
                <span className="text-xs text-slate-400">hari</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 p-1 rounded-lg bg-[#070B19] border border-indigo-500/20">
            <button
              type="button"
              onClick={() => setMode('PLAYED')}
              className={`px-3 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                mode === 'PLAYED' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              Sudah Pernah Main
            </button>
            <button
              type="button"
              onClick={() => setMode('NEVER_PLAYED')}
              className={`px-3 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                mode === 'NEVER_PLAYED' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              Belum Pernah Main
            </button>
          </div>
        </div>

        <form onSubmit={handleSearchSubmit} className="grid grid-cols-1 sm:grid-cols-12 gap-3 pt-2 border-t border-indigo-500/15">
          <div className="sm:col-span-5 flex gap-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter nama, username, WhatsApp, Member ID..."
              className="flex-1 min-w-0 px-3.5 py-2 rounded-lg bg-[#070B19] border border-indigo-500/25 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-400"
            />
            <button
              type="submit"
              className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <Search className="w-3.5 h-3.5" />
              Cari
            </button>
          </div>

          <select
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value as 'ALL' | BranchId)}
            className="sm:col-span-3 px-3 py-2 rounded-lg bg-[#070B19] border border-indigo-500/25 text-xs text-white"
          >
            <option value="ALL">Semua Cabang</option>
            <option value="DEMANG">XP PLAY Demang</option>
            <option value="SEKIP">XP PLAY Sekip</option>
          </select>

          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value as 'ALL' | LevelId)}
            className="sm:col-span-3 px-3 py-2 rounded-lg bg-[#070B19] border border-indigo-500/25 text-xs text-white"
          >
            <option value="ALL">Semua Level</option>
            <option value="BRONZE">Bronze</option>
            <option value="SILVER">Silver</option>
            <option value="JURAGAN">Juragan</option>
            <option value="SULTAN">Sultan</option>
          </select>

          <div className="sm:col-span-1 flex items-center justify-end text-xs text-slate-400 font-mono tabular-nums">
            <Users className="w-3.5 h-3.5 mr-1 text-sky-400" />
            {rows.length}
          </div>
        </form>
      </div>

      {/* 11-Column Data Table (MODULE 6.3) */}
      <div className="rounded-xl bg-[#0B1124] border border-indigo-500/20 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-indigo-500/15 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-sky-400" />
            <span>
              Menampilkan member aktif tidak bermain ≥ <strong className="text-white">{effectiveDays} hari</strong> ({mode === 'PLAYED' ? 'terakhir main tercatat' : 'belum pernah main sejak registrasi'}).
            </span>
          </div>
          <span className="font-mono">Urutan: Terlama Tidak Bermain</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#070B19] text-slate-400 border-b border-indigo-500/15">
              <tr>
                <th className="py-3 px-3.5 font-medium">Nama Member</th>
                <th className="py-3 px-3.5 font-medium">Username</th>
                <th className="py-3 px-3.5 font-medium">WhatsApp</th>
                <th className="py-3 px-3.5 font-medium">Level</th>
                <th className="py-3 px-3.5 font-medium text-right">XP Progress</th>
                <th className="py-3 px-3.5 font-medium text-right">XP Reward</th>
                <th className="py-3 px-3.5 font-medium">Last Play</th>
                <th className="py-3 px-3.5 font-medium">Lama Inaktif</th>
                <th className="py-3 px-3.5 font-medium">Last Branch</th>
                <th className="py-3 px-3.5 font-medium">Status</th>
                <th className="py-3 px-3.5 font-medium text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-indigo-500/10 text-slate-200">
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-10 text-center text-slate-500">
                    Memuat data member inaktif...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-10 text-center text-slate-500">
                    Tidak ada member aktif yang memenuhi kriteria inaktif ≥ {effectiveDays} hari pada filter saat ini.
                  </td>
                </tr>
              ) : (
                rows.map(({ member, daysInactive, neverPlayed }) => (
                  <tr key={member.uid} className="hover:bg-indigo-500/5">
                    <td className="py-3 px-3.5 font-medium text-white whitespace-nowrap">
                      {member.fullName}
                      <div className="text-[11px] font-mono text-slate-500">{member.memberId}</div>
                    </td>
                    <td className="py-3 px-3.5 text-sky-300 whitespace-nowrap">@{member.username}</td>
                    <td className="py-3 px-3.5 font-mono tabular-nums text-slate-300 whitespace-nowrap">
                      {member.whatsapp}
                    </td>
                    <td className="py-3 px-3.5 font-semibold text-purple-300 whitespace-nowrap">
                      {member.currentLevel}
                    </td>
                    <td className="py-3 px-3.5 text-right font-mono tabular-nums text-sky-300 whitespace-nowrap">
                      {member.xpProgress.toLocaleString('id-ID')}
                    </td>
                    <td className="py-3 px-3.5 text-right font-mono tabular-nums text-emerald-300 whitespace-nowrap">
                      {member.xpReward.toLocaleString('id-ID')}
                    </td>
                    <td className="py-3 px-3.5 font-mono tabular-nums text-slate-300 whitespace-nowrap">
                      {member.lastPlayAt ? formatJakartaDateTime(member.lastPlayAt) : 'Belum pernah main'}
                    </td>
                    <td className="py-3 px-3.5 whitespace-nowrap">
                      <span className={daysInactive >= 90 ? 'text-rose-300 font-semibold' : daysInactive >= 30 ? 'text-amber-300 font-medium' : 'text-slate-200'}>
                        {formatInactiveDurationLabel(daysInactive, neverPlayed)}
                      </span>
                    </td>
                    <td className="py-3 px-3.5 text-slate-300 whitespace-nowrap">
                      {member.lastPlayBranch
                        ? getBranchLabel(member.lastPlayBranch)
                        : member.preferredBranch
                        ? `${getBranchLabel(member.preferredBranch)} (pref)`
                        : '-'}
                    </td>
                    <td className="py-3 px-3.5 whitespace-nowrap">
                      <span className="text-emerald-300">{member.status}</span>
                    </td>
                    <td className="py-3 px-3.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        {canSendNotification && (
                          <button
                            type="button"
                            disabled={restoreLocked}
                            onClick={() => void handleQuickSingleNotif(member, daysInactive)}
                            title="Kirim notifikasi pengingat"
                            className="px-2 py-1 rounded bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 border border-sky-500/30 disabled:opacity-40"
                          >
                            <Send className="w-3 h-3" />
                          </button>
                        )}
                        {onSelectForXpAdjustment && (
                          <button
                            type="button"
                            onClick={() => onSelectForXpAdjustment(member)}
                            className="px-2 py-1 rounded bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-200 border border-indigo-500/30"
                          >
                            XP
                          </button>
                        )}
                        {onSelectForPassword && (adminProfile.role === 'SUPER_ADMIN' || adminProfile.role === 'ADMIN') && (
                          <button
                            type="button"
                            onClick={() => onSelectForPassword(member)}
                            title="Ubah password member"
                            className="px-2 py-1 rounded bg-purple-500/15 hover:bg-purple-500/25 text-purple-200 border border-purple-500/30"
                          >
                            <KeyRound className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {hasMore && (
          <div className="p-4 border-t border-indigo-500/15 text-center">
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadPage(false)}
              className="px-4 py-2 rounded-lg border border-indigo-500/30 text-xs text-sky-300 hover:text-white transition-colors"
            >
              {loading ? 'Memuat...' : 'Muat Halaman Berikutnya'}
            </button>
          </div>
        )}
      </div>

      {/* Bulk Inactive Notification Modal */}
      {notifOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleDispatchInactiveNotif}
            className="max-w-lg w-full rounded-xl bg-[#0B1124] border border-indigo-500/30 p-6 space-y-4"
          >
            <h3 className="font-display text-lg font-bold text-white">
              Kirim Notifikasi ke Member Inaktif ({effectiveDays}+ Hari)
            </h3>
            <p className="text-xs text-slate-400">
              Filter aktif: Cabang <span className="text-white">{branchFilter}</span> · Level{' '}
              <span className="text-white">{levelFilter}</span>. Notifikasi dikirim secara batch agar aman dan stabil.
            </p>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-300">Judul Notifikasi</span>
              <input
                type="text"
                required
                value={notifTitle}
                onChange={(e) => setNotifTitle(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#070B19] border border-indigo-500/25 text-sm text-white"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-300">Pesan</span>
              <textarea
                rows={4}
                required
                value={notifMessage}
                onChange={(e) => setNotifMessage(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#070B19] border border-indigo-500/25 text-sm text-white"
              />
            </label>
            <label className="flex items-start gap-2.5 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={dedupeDaily}
                onChange={(e) => setDedupeDaily(e.target.checked)}
                className="mt-0.5 rounded border-indigo-500/40 bg-[#070B19] text-sky-400"
              />
              <span>
                Aktifkan proteksi anti-duplikat harian (member yang sudah menerima notifikasi kohort hari ini otomatis dilewati).
              </span>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={sendingNotif}
                onClick={() => setNotifOpen(false)}
                className="px-4 py-2 rounded-lg border border-indigo-500/25 text-xs text-slate-300 hover:text-white"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={sendingNotif || !notifTitle.trim() || !notifMessage.trim()}
                className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 text-xs font-semibold"
              >
                {sendingNotif ? 'Mengirim...' : 'Kirim Notifikasi'}
              </button>
            </div>
          </form>
        </div>
      )}
      </>)}
    </div>
  );
}
