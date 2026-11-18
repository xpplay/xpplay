import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Crown,
  History,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import {
  fetchRecentLevelOverrides,
  findMemberByIdentifierAdmin,
  overrideMemberLevelByAdmin,
} from '../services/xpService.ts';
import {
  calculateManualLevelOverride,
  calculateRecalculateLevelFromXp,
  formatJakartaDateTime,
  resolveEffectiveMemberLevel,
  resolveLevelFromXp,
} from '../shared/xpLogic.ts';
import type {
  AdminUser,
  LevelConfig,
  LevelId,
  LevelMode,
  LevelOverrideAction,
  LevelOverrideRecord,
  MemberProfile,
} from '../types/xpplay.ts';

interface AdminLevelOverrideProps {
  adminProfile: AdminUser;
  levels: LevelConfig[];
  adminSdkConfigured: boolean;
  initialMember?: MemberProfile | null;
  onFeedback: (fb: { type: 'success' | 'error'; text: string } | null) => void;
}

function makeOverrideOperationId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `ovrOp_${Date.now()}_${rand}`;
}

function formatModeLabel(mode?: LevelMode): string {
  if (mode === 'MANUAL_OVERRIDE') return 'MANUAL_OVERRIDE';
  if (mode === 'RESET') return 'RESET';
  return 'AUTOMATIC';
}

export function AdminLevelOverride({
  adminProfile,
  levels,
  adminSdkConfigured,
  initialMember = null,
  onFeedback,
}: AdminLevelOverrideProps) {
  const canOverride = adminProfile.role === 'SUPER_ADMIN' || adminProfile.role === 'ADMIN';
  const sortedLevels = [...levels].sort((a, b) => a.rank - b.rank);

  const [action, setAction] = useState<LevelOverrideAction>('MANUAL_OVERRIDE');
  const [searchInput, setSearchInput] = useState(initialMember?.username || '');
  const [searching, setSearching] = useState(false);
  const [selectedMember, setSelectedMember] = useState<MemberProfile | null>(initialMember);

  const [targetLevel, setTargetLevel] = useState<LevelId>(initialMember?.currentLevel || 'SILVER');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');

  const [pendingConfirm, setPendingConfirm] = useState<{
    operationId: string;
    action: LevelOverrideAction;
    member: MemberProfile;
    previousLevel: LevelId;
    newLevel: LevelId;
    previousLevelMode: LevelMode;
    newLevelMode: LevelMode;
    levelChanged: boolean;
    modeChanged: boolean;
    reason: string;
    reference: string;
  } | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // History state
  const [historyFilter, setHistoryFilter] = useState<'ALL' | LevelOverrideAction>('ALL');
  const [historyRows, setHistoryRows] = useState<LevelOverrideRecord[]>([]);
  const [historyCursor, setHistoryCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  useEffect(() => {
    if (initialMember) {
      setSelectedMember(initialMember);
      setSearchInput(initialMember.username);
      setTargetLevel(initialMember.currentLevel);
    }
  }, [initialMember]);

  const loadHistory = async (reset: boolean) => {
    setLoadingHistory(true);
    try {
      const res = await fetchRecentLevelOverrides({
        actionFilter: historyFilter,
        pageSize: 15,
        cursor: reset ? null : historyCursor,
      });
      setHistoryRows((prev) => (reset ? res.items : [...prev, ...res.items]));
      setHistoryCursor(res.lastCursor);
      setHistoryHasMore(res.hasMore);
    } catch (err) {
      onFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    void loadHistory(true);
  }, [historyFilter]);

  const handleSearchMember = async (e: FormEvent) => {
    e.preventDefault();
    const raw = searchInput.trim();
    if (!raw) {
      onFeedback({ type: 'error', text: 'Masukkan username atau nomor WhatsApp member.' });
      return;
    }
    setSearching(true);
    onFeedback(null);
    try {
      const found = await findMemberByIdentifierAdmin(raw);
      if (!found) {
        setSelectedMember(null);
        onFeedback({
          type: 'error',
          text: `Member dengan username atau nomor WhatsApp "${raw}" tidak ditemukan.`,
        });
        return;
      }
      setSelectedMember(found);
      setTargetLevel(found.currentLevel);
    } catch (err) {
      onFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setSearching(false);
    }
  };

  const xpCalculatedLevel = selectedMember
    ? resolveLevelFromXp(selectedMember.xpProgress, levels).current.id
    : null;
  const effectiveCurrentLevel = selectedMember
    ? resolveEffectiveMemberLevel(selectedMember, levels).id
    : null;

  const previewResult = (() => {
    if (!selectedMember) {
      return { ok: false as const, error: null, data: null };
    }
    try {
      const data =
        action === 'MANUAL_OVERRIDE'
          ? calculateManualLevelOverride({
              currentXpProgress: selectedMember.xpProgress,
              currentLevel: selectedMember.currentLevel,
              currentLevelMode: selectedMember.levelMode,
              targetLevel,
            })
          : calculateRecalculateLevelFromXp({
              currentXpProgress: selectedMember.xpProgress,
              currentLevel: selectedMember.currentLevel,
              currentLevelMode: selectedMember.levelMode,
              levels,
            });
      return { ok: true as const, error: null, data };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : 'Perubahan level tidak valid.',
        data: null,
      };
    }
  })();

  const handleOpenConfirm = (e: FormEvent) => {
    e.preventDefault();
    if (!canOverride) return;
    onFeedback(null);

    if (!selectedMember) {
      onFeedback({ type: 'error', text: 'Cari dan pilih member terlebih dahulu.' });
      return;
    }
    if (selectedMember.status === 'DELETED') {
      onFeedback({ type: 'error', text: 'Member berstatus DELETED tidak dapat diubah levelnya.' });
      return;
    }
    if (!previewResult.ok || !previewResult.data) {
      onFeedback({ type: 'error', text: previewResult.error || 'Simulasi level override tidak valid.' });
      return;
    }
    const cleanReason = reason.trim();
    if (cleanReason.length < 3) {
      onFeedback({ type: 'error', text: 'Alasan perubahan level wajib diisi (minimal 3 karakter).' });
      return;
    }

    setModalError(null);
    setPendingConfirm({
      operationId: makeOverrideOperationId(),
      action,
      member: selectedMember,
      previousLevel: previewResult.data.previousLevel,
      newLevel: previewResult.data.newLevel,
      previousLevelMode: previewResult.data.previousLevelMode,
      newLevelMode: previewResult.data.newLevelMode,
      levelChanged: previewResult.data.levelChanged,
      modeChanged: previewResult.data.newLevelMode !== previewResult.data.previousLevelMode,
      reason: cleanReason,
      reference: reference.trim(),
    });
  };

  const handleConfirmExecute = async () => {
    if (!canOverride || !pendingConfirm || submitting) return;
    setSubmitting(true);
    setModalError(null);
    onFeedback(null);
    try {
      const res = await overrideMemberLevelByAdmin({
        operationId: pendingConfirm.operationId,
        action: pendingConfirm.action,
        identifier: pendingConfirm.member.username,
        memberUid: pendingConfirm.member.uid,
        targetLevel: pendingConfirm.action === 'MANUAL_OVERRIDE' ? pendingConfirm.newLevel : undefined,
        reason: pendingConfirm.reason,
        reference: pendingConfirm.reference,
        admin: adminProfile,
        adminSdkConfigured,
      });

      setSelectedMember((prev) =>
        prev && prev.uid === pendingConfirm.member.uid
          ? {
              ...prev,
              currentLevel: res.newLevel,
              levelMode: res.newLevelMode,
              updatedAt: res.record.timestamp,
            }
          : prev
      );
      setTargetLevel(res.newLevel);

      onFeedback({
        type: 'success',
        text:
          pendingConfirm.action === 'MANUAL_OVERRIDE'
            ? `Level @${pendingConfirm.member.username} berhasil di-override menjadi ${res.newLevel} (Mode: ${res.newLevelMode}). XP Progress tetap ${pendingConfirm.member.xpProgress} XP.`
            : `Level @${pendingConfirm.member.username} berhasil direkalkulasi dari XP Progress (${pendingConfirm.member.xpProgress} XP) menjadi ${res.newLevel} (Mode: AUTOMATIC).`,
      });

      setPendingConfirm(null);
      setReason('');
      setReference('');
      await loadHistory(true);
    } catch (err) {
      const msg = mapFriendlyError(err);
      setModalError(msg);
      onFeedback({ type: 'error', text: msg });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {!canOverride && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200 flex items-center gap-2.5">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            Mode Read-Only: Role STAFF hanya dapat melihat riwayat Level Override. Force Level Change dan Recalculate Level hanya diizinkan untuk ADMIN atau SUPER_ADMIN.
          </span>
        </div>
      )}

      {/* Mode Selector + Member Lookup */}
      <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-indigo-500/15 pb-4">
          <div className="space-y-1">
            <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
              <Crown className="w-4 h-4 text-purple-300" />
              <span>Admin Level Override &amp; Recalculate</span>
            </h2>
            <p className="text-xs text-slate-400">
              Ubah level member secara manual (<code className="text-sky-300">MANUAL_OVERRIDE</code>) tanpa mengubah XP, atau kembalikan ke perhitungan XP otomatis (<code className="text-sky-300">RECALCULATE</code>).
            </p>
          </div>

          <div className="inline-flex rounded-xl border border-indigo-500/25 bg-[#070B19] p-1 self-start">
            <button
              type="button"
              onClick={() => setAction('MANUAL_OVERRIDE')}
              className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                action === 'MANUAL_OVERRIDE'
                  ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Force Level Override
            </button>
            <button
              type="button"
              onClick={() => setAction('RECALCULATE')}
              className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                action === 'RECALCULATE'
                  ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Recalculate From XP</span>
            </button>
          </div>
        </div>

        {/* Search Member */}
        <form onSubmit={handleSearchMember} className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Cari member via username atau nomor WhatsApp (misal: andi_play atau 0898...)"
              className="w-full h-11 rounded-xl border border-indigo-500/30 bg-[#070B19] pl-9 pr-3 text-sm text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={searching}
            className="min-h-[44px] px-5 rounded-xl border border-indigo-500/35 bg-[#0D1533] text-xs font-semibold text-white hover:border-sky-400/60 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            {searching ? 'Mencari...' : 'Cari Member'}
          </button>
        </form>

        {/* Selected Member Snapshot */}
        {selectedMember ? (
          <div className="rounded-xl border border-indigo-500/20 bg-[#070B19] p-4 grid grid-cols-2 lg:grid-cols-5 gap-4">
            <div className="col-span-2 lg:col-span-1">
              <p className="text-[11px] text-slate-400">Member Terpilih</p>
              <p className="text-sm font-bold text-white truncate">{selectedMember.fullName}</p>
              <p className="text-xs font-mono text-slate-400 truncate">
                @{selectedMember.username} · {selectedMember.status}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-slate-400">XP Progress (Tetap)</p>
              <p className="font-mono text-lg font-bold text-sky-300 tabular-nums">
                {selectedMember.xpProgress} XP
              </p>
            </div>
            <div>
              <p className="text-[11px] text-slate-400">XP Reward (Tetap)</p>
              <p className="font-mono text-lg font-bold text-purple-300 tabular-nums">
                {selectedMember.xpReward} XP
              </p>
            </div>
            <div>
              <p className="text-[11px] text-slate-400">Level Aktif &amp; Mode</p>
              <p className="font-display text-lg font-bold text-white">
                {effectiveCurrentLevel}
              </p>
              <p
                className={`text-[11px] font-mono ${
                  selectedMember.levelMode === 'MANUAL_OVERRIDE'
                    ? 'text-amber-300'
                    : selectedMember.levelMode === 'RESET'
                      ? 'text-purple-300'
                      : 'text-emerald-300'
                }`}
              >
                {formatModeLabel(selectedMember.levelMode)}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-slate-400">Kalkulasi XP Otomatis</p>
              <p className="font-display text-lg font-bold text-slate-200">
                {xpCalculatedLevel}
              </p>
              <p className="text-[11px] text-slate-400">Berdasarkan threshold XP</p>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-indigo-500/15 bg-[#070B19]/70 p-4 text-xs text-slate-400">
            Cari username atau nomor WhatsApp member di atas untuk melihat status level saat ini dan melakukan Force Level Override atau Recalculate.
          </div>
        )}

        {/* Override Form + Live Preview Split */}
        <form onSubmit={handleOpenConfirm} className="grid lg:grid-cols-12 gap-5 items-start">
          <div className="lg:col-span-7 space-y-4">
            {action === 'MANUAL_OVERRIDE' ? (
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-slate-200">
                  Target Level Baru (Force Override) *
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {sortedLevels.map((lvl) => {
                    const active = targetLevel === lvl.id;
                    return (
                      <button
                        key={lvl.id}
                        type="button"
                        disabled={!canOverride || !selectedMember}
                        onClick={() => setTargetLevel(lvl.id)}
                        className={`rounded-xl border p-3 text-left transition-all disabled:opacity-40 ${
                          active
                            ? 'border-sky-400 bg-indigo-500/25 text-white shadow-[0_0_16px_-4px_rgba(56,189,248,0.45)]'
                            : 'border-indigo-500/25 bg-[#070B19] text-slate-300 hover:border-indigo-400/50 hover:text-white'
                        }`}
                      >
                        <p className="font-display text-sm font-bold">{lvl.name}</p>
                        <p className="font-mono text-[11px] text-slate-400 mt-0.5">
                          Normal: {lvl.minXp}+ XP
                        </p>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-slate-400">
                  Level yang dipilih menjadi <code className="text-amber-300">MANUAL_OVERRIDE</code> sehingga dashboard member maupun transaksi XP baru tidak otomatis menimpa level hasil override.
                </p>
              </div>
            ) : (
              <div className="rounded-xl border border-sky-500/25 bg-[#070B19] p-4 space-y-1.5">
                <p className="text-xs font-semibold text-sky-300">
                  Mode Recalculate Level From XP
                </p>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Menghitung ulang level member secara otomatis berdasarkan saldo XP Progress saat ini (
                  <strong className="font-mono text-white">
                    {selectedMember ? `${selectedMember.xpProgress} XP` : '-'}
                  </strong>
                  ) dan mengembalikan status level menjadi <code className="text-emerald-300">AUTOMATIC</code>.
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-200">
                Alasan Perubahan Level (Reason) *
              </label>
              <textarea
                rows={2}
                required
                disabled={!canOverride || !selectedMember}
                maxLength={300}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={
                  action === 'MANUAL_OVERRIDE'
                    ? 'Jelaskan alasan force level (misal: Promo VIP Tournament Juara 1 / Kompensasi khusus)'
                    : 'Jelaskan alasan recalculate level dari XP (misal: Selesai masa promo VIP, sinkronisasi ulang ke XP)'
                }
                className="w-full rounded-xl border border-indigo-500/30 bg-[#070B19] p-3 text-sm text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none disabled:opacity-50"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-200">
                Referensi / No. Tiket (Opsional)
              </label>
              <input
                type="text"
                disabled={!canOverride || !selectedMember}
                maxLength={120}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Contoh: VIP-PROMO-01 atau Tiket #402"
                className="w-full h-10 rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-sm font-mono text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none disabled:opacity-50"
              />
            </div>
          </div>

          {/* Live Preview Card */}
          <div className="lg:col-span-5 rounded-xl border border-indigo-500/25 bg-[#070B19] p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-indigo-500/15 pb-2.5">
              <h3 className="font-display text-sm font-bold text-white">Preview Perubahan Level</h3>
              <span className="font-mono text-[11px] text-purple-300">
                {action === 'MANUAL_OVERRIDE' ? 'ADMIN_MANUAL_OVERRIDE' : 'ADMIN_RECALCULATE'}
              </span>
            </div>

            {!selectedMember ? (
              <p className="text-xs text-slate-400 py-4">
                Pilih member terlebih dahulu untuk melihat preview perubahan level &amp; mode.
              </p>
            ) : previewResult.error ? (
              <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 p-3 text-xs text-rose-200">
                {previewResult.error}
              </div>
            ) : previewResult.data ? (
              <div className="space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Level Before</span>
                  <span className="font-semibold text-white">{previewResult.data.previousLevel}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Level After</span>
                  <span
                    className={`font-bold flex items-center gap-1 ${
                      previewResult.data.levelChanged ? 'text-amber-300' : 'text-sky-300'
                    }`}
                  >
                    <span>{previewResult.data.newLevel}</span>
                    {!previewResult.data.levelChanged && (
                      <span className="text-[11px] font-normal text-slate-400">(Tetap)</span>
                    )}
                  </span>
                </div>

                <div className="border-t border-indigo-500/15 pt-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Mode Before</span>
                    <span className="font-mono text-slate-200">{previewResult.data.previousLevelMode}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Mode After</span>
                    <span
                      className={`font-mono font-bold ${
                        previewResult.data.newLevelMode === 'MANUAL_OVERRIDE'
                          ? 'text-amber-300'
                          : 'text-emerald-300'
                      }`}
                    >
                      {previewResult.data.newLevelMode}
                    </span>
                  </div>
                </div>

                <div className="rounded-lg border border-indigo-500/20 bg-[#0B1124] p-2.5 text-[11px] text-slate-300">
                  XP Progress tetap{' '}
                  <strong className="font-mono text-white">{selectedMember.xpProgress} XP</strong> &amp; XP
                  Reward tetap <strong className="font-mono text-white">{selectedMember.xpReward} XP</strong>{' '}
                  (tidak ada mutasi XP).
                </div>
              </div>
            ) : null}

            <button
              type="submit"
              disabled={
                !canOverride ||
                !selectedMember ||
                !previewResult.ok ||
                !previewResult.data ||
                reason.trim().length < 3
              }
              className="w-full min-h-[44px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-4 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500 disabled:opacity-40 transition-colors"
            >
              Lanjut ke Konfirmasi
            </button>
          </div>
        </form>
      </div>

      {/* Override History Table */}
      <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 overflow-hidden">
        <div className="p-4 border-b border-indigo-500/15 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-purple-300" />
            <h3 className="font-display text-sm font-bold text-white">Riwayat Level Override &amp; Recalculate</h3>
          </div>
          <div className="inline-flex rounded-xl border border-indigo-500/25 bg-[#070B19] p-1">
            {(['ALL', 'MANUAL_OVERRIDE', 'RECALCULATE'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setHistoryFilter(f)}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                  historyFilter === f
                    ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                {f === 'ALL' ? 'Semua' : f === 'MANUAL_OVERRIDE' ? 'Force Override' : 'Recalculate'}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-indigo-500/20 text-left text-xs text-slate-400">
                <th className="p-3">Waktu (WIB)</th>
                <th className="p-3">Member</th>
                <th className="p-3">Aksi</th>
                <th className="p-3">Level (Before → After)</th>
                <th className="p-3">Mode</th>
                <th className="p-3 text-right">XP Progress Snapshot</th>
                <th className="p-3">Alasan &amp; Ref</th>
                <th className="p-3">Admin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-indigo-500/15">
              {historyRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-sm text-slate-400">
                    {loadingHistory
                      ? 'Memuat riwayat Level Override...'
                      : 'Belum ada riwayat Level Override atau Recalculate.'}
                  </td>
                </tr>
              ) : (
                historyRows.map((row) => (
                  <tr key={row.id} className="hover:bg-[#0D1533]/50">
                    <td className="p-3 text-xs text-slate-400 whitespace-nowrap font-mono tabular-nums">
                      {formatJakartaDateTime(row.timestamp)}
                    </td>
                    <td className="p-3 text-xs">
                      <p className="font-mono font-semibold text-white">@{row.memberUsername}</p>
                      <p className="font-mono text-[11px] text-slate-400">{row.memberId}</p>
                    </td>
                    <td className="p-3 text-xs font-mono font-semibold whitespace-nowrap">
                      <span
                        className={
                          row.action === 'MANUAL_OVERRIDE' ? 'text-amber-300' : 'text-sky-300'
                        }
                      >
                        {row.action}
                      </span>
                    </td>
                    <td className="p-3 text-xs whitespace-nowrap font-semibold text-white">
                      {row.previousLevel} →{' '}
                      <span className={row.previousLevel !== row.newLevel ? 'text-amber-300' : 'text-sky-300'}>
                        {row.newLevel}
                      </span>
                    </td>
                    <td className="p-3 text-[11px] font-mono whitespace-nowrap text-slate-300">
                      {row.previousLevelMode} →{' '}
                      <span
                        className={
                          row.newLevelMode === 'MANUAL_OVERRIDE' ? 'text-amber-300' : 'text-emerald-300'
                        }
                      >
                        {row.newLevelMode}
                      </span>
                    </td>
                    <td className="p-3 text-right font-mono text-xs tabular-nums whitespace-nowrap text-sky-300">
                      {row.xpProgressSnapshot} XP
                    </td>
                    <td className="p-3 text-xs text-slate-300 max-w-xs">
                      <p className="truncate" title={row.reason}>
                        {row.reason}
                      </p>
                      <p className="text-[11px] font-mono text-slate-400 truncate">
                        {row.reference ? `Ref: ${row.reference} · ` : ''}Audit: {row.auditId}
                      </p>
                    </td>
                    <td className="p-3 text-xs text-slate-400 whitespace-nowrap">
                      {row.adminEmail || row.adminId}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {historyHasMore && (
          <div className="p-3 border-t border-indigo-500/15 text-center">
            <button
              type="button"
              disabled={loadingHistory}
              onClick={() => void loadHistory(false)}
              className="text-xs font-semibold text-slate-200 underline disabled:opacity-50"
            >
              {loadingHistory ? 'Memuat...' : 'Muat Lebih Banyak'}
            </button>
          </div>
        )}
      </div>

      {/* Confirmation Modal */}
      {pendingConfirm && (
        <div className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-[#0B1124] rounded-2xl border border-indigo-500/35 p-6 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-lg font-bold text-white">
                  Konfirmasi {pendingConfirm.action === 'MANUAL_OVERRIDE' ? 'Force Level Override' : 'Recalculate Level'}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Periksa ringkasan perubahan sebelum menyimpan ke database &amp; audit log.
                </p>
              </div>
              <button
                type="button"
                disabled={submitting}
                onClick={() => setPendingConfirm(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white"
                aria-label="Tutup Konfirmasi"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="rounded-xl border border-indigo-500/20 bg-[#070B19] p-4 space-y-2.5 text-xs">
              <div className="flex justify-between gap-2">
                <span className="text-slate-400">Member</span>
                <span className="font-mono font-semibold text-white">
                  @{pendingConfirm.member.username} ({pendingConfirm.member.memberId})
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-400">Aksi</span>
                <span className="font-mono font-semibold text-purple-300">
                  {pendingConfirm.action}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-400">Level Before → After</span>
                <span className="font-semibold text-white flex items-center gap-1.5">
                  <span>{pendingConfirm.previousLevel}</span>
                  <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
                  <span className="text-amber-300">{pendingConfirm.newLevel}</span>
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-400">Mode Before → After</span>
                <span className="font-mono text-white flex items-center gap-1.5">
                  <span>{pendingConfirm.previousLevelMode}</span>
                  <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
                  <span
                    className={
                      pendingConfirm.newLevelMode === 'MANUAL_OVERRIDE'
                        ? 'text-amber-300 font-bold'
                        : 'text-emerald-300 font-bold'
                    }
                  >
                    {pendingConfirm.newLevelMode}
                  </span>
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-400">XP Progress / XP Reward</span>
                <span className="font-mono text-sky-300 tabular-nums">
                  Tetap {pendingConfirm.member.xpProgress} XP / {pendingConfirm.member.xpReward} XP
                </span>
              </div>
              <div className="border-t border-indigo-500/15 pt-2">
                <p className="text-slate-400">Alasan:</p>
                <p className="text-white mt-0.5">{pendingConfirm.reason}</p>
                {pendingConfirm.reference && (
                  <p className="text-slate-400 font-mono mt-1">Ref: {pendingConfirm.reference}</p>
                )}
              </div>
            </div>

            {modalError && (
              <div
                role="alert"
                className="rounded-xl border border-rose-500/35 bg-rose-500/10 p-3 text-xs text-rose-200"
              >
                {modalError}
              </div>
            )}

            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setPendingConfirm(null)}
                className="min-h-[42px] px-4 rounded-xl border border-indigo-500/30 bg-[#070B19] text-xs font-semibold text-slate-200 hover:text-white disabled:opacity-50"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleConfirmExecute()}
                className="min-h-[42px] px-5 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500 flex items-center gap-1.5 disabled:opacity-50"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>{submitting ? 'Memproses...' : 'Konfirmasi & Simpan'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
