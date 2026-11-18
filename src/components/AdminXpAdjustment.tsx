import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  History,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import {
  adjustMemberXpByAdmin,
  fetchRecentXpAdjustments,
  findMemberByIdentifierAdmin,
} from '../services/xpService.ts';
import {
  calculateXpProgressAdjustment,
  calculateXpRewardAdjustment,
  formatJakartaDateTime,
} from '../shared/xpLogic.ts';
import type {
  AdminUser,
  LevelConfig,
  MemberProfile,
  XpAdjustmentKind,
  XpAdjustmentRecord,
} from '../types/xpplay.ts';

interface AdminXpAdjustmentProps {
  adminProfile: AdminUser;
  levels: LevelConfig[];
  adminSdkConfigured: boolean;
  initialMember?: MemberProfile | null;
  onFeedback: (fb: { type: 'success' | 'error'; text: string } | null) => void;
}

function makeOperationId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `op_${Date.now()}_${rand}`;
}

export function AdminXpAdjustment({
  adminProfile,
  levels,
  adminSdkConfigured,
  initialMember = null,
  onFeedback,
}: AdminXpAdjustmentProps) {
  const canAdjust = adminProfile.role === 'SUPER_ADMIN' || adminProfile.role === 'ADMIN';

  const [kind, setKind] = useState<XpAdjustmentKind>('PROGRESS');
  const [searchInput, setSearchInput] = useState(initialMember?.username || '');
  const [searching, setSearching] = useState(false);
  const [selectedMember, setSelectedMember] = useState<MemberProfile | null>(initialMember);

  const [adjustmentInput, setAdjustmentInput] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');

  const [pendingConfirm, setPendingConfirm] = useState<{
    operationId: string;
    kind: XpAdjustmentKind;
    member: MemberProfile;
    adjustment: number;
    beforeBalance: number;
    afterBalance: number;
    newXpProgress: number;
    newXpReward: number;
    levelBefore: MemberProfile['currentLevel'];
    levelAfter: MemberProfile['currentLevel'];
    levelChanged: boolean;
    reason: string;
    reference: string;
  } | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // History state
  const [historyFilter, setHistoryFilter] = useState<'ALL' | XpAdjustmentKind>('ALL');
  const [historyRows, setHistoryRows] = useState<XpAdjustmentRecord[]>([]);
  const [historyCursor, setHistoryCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  useEffect(() => {
    if (initialMember) {
      setSelectedMember(initialMember);
      setSearchInput(initialMember.username);
    }
  }, [initialMember]);

  const loadHistory = async (reset: boolean) => {
    setLoadingHistory(true);
    try {
      const res = await fetchRecentXpAdjustments({
        kindFilter: historyFilter,
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
    } catch (err) {
      onFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setSearching(false);
    }
  };

  const parsedAdjustment = (() => {
    const trimmed = adjustmentInput.trim();
    if (!trimmed) return { valid: false as const, error: null, value: 0 };
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return {
        valid: false as const,
        error: 'Adjustment harus berupa bilangan bulat (contoh: -100 atau 50).',
        value: 0,
      };
    }
    const num = Number(trimmed);
    if (!Number.isSafeInteger(num) || num === 0) {
      return {
        valid: false as const,
        error: 'Adjustment harus bilangan bulat selain 0.',
        value: 0,
      };
    }
    return { valid: true as const, error: null, value: num };
  })();

  const previewResult = (() => {
    if (!selectedMember || !parsedAdjustment.valid) {
      return { ok: false as const, error: parsedAdjustment.error, data: null };
    }
    try {
      const data =
        kind === 'PROGRESS'
          ? calculateXpProgressAdjustment({
              currentXpProgress: selectedMember.xpProgress,
              currentXpReward: selectedMember.xpReward,
              currentLevel: selectedMember.currentLevel,
              adjustment: parsedAdjustment.value,
              levels,
            })
          : calculateXpRewardAdjustment({
              currentXpProgress: selectedMember.xpProgress,
              currentXpReward: selectedMember.xpReward,
              currentLevel: selectedMember.currentLevel,
              adjustment: parsedAdjustment.value,
            });
      return { ok: true as const, error: null, data };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : 'Adjustment tidak valid.',
        data: null,
      };
    }
  })();

  const handleOpenConfirm = (e: FormEvent) => {
    e.preventDefault();
    if (!canAdjust) return;
    onFeedback(null);

    if (!selectedMember) {
      onFeedback({ type: 'error', text: 'Cari dan pilih member terlebih dahulu.' });
      return;
    }
    if (selectedMember.status === 'DELETED') {
      onFeedback({ type: 'error', text: 'Member berstatus DELETED tidak dapat disesuaikan saldonya.' });
      return;
    }
    if (!parsedAdjustment.valid || !previewResult.ok || !previewResult.data) {
      onFeedback({ type: 'error', text: previewResult.error || 'Nilai adjustment tidak valid.' });
      return;
    }
    const cleanReason = reason.trim();
    if (cleanReason.length < 3) {
      onFeedback({ type: 'error', text: 'Alasan penyesuaian XP wajib diisi (minimal 3 karakter).' });
      return;
    }

    setModalError(null);
    setPendingConfirm({
      operationId: makeOperationId(),
      kind,
      member: selectedMember,
      adjustment: parsedAdjustment.value,
      beforeBalance: previewResult.data.beforeBalance,
      afterBalance: previewResult.data.afterBalance,
      newXpProgress: previewResult.data.newXpProgress,
      newXpReward: previewResult.data.newXpReward,
      levelBefore: previewResult.data.levelBefore,
      levelAfter: previewResult.data.levelAfter,
      levelChanged: previewResult.data.levelChanged,
      reason: cleanReason,
      reference: reference.trim(),
    });
  };

  const handleConfirmExecute = async () => {
    if (!canAdjust || !pendingConfirm || submitting) return;
    setSubmitting(true);
    setModalError(null);
    onFeedback(null);
    try {
      const res = await adjustMemberXpByAdmin({
        operationId: pendingConfirm.operationId,
        kind: pendingConfirm.kind,
        identifier: pendingConfirm.member.username,
        memberUid: pendingConfirm.member.uid,
        adjustment: pendingConfirm.adjustment,
        reason: pendingConfirm.reason,
        reference: pendingConfirm.reference,
        admin: adminProfile,
        adminSdkConfigured,
      });

      setSelectedMember((prev) =>
        prev && prev.uid === pendingConfirm.member.uid
          ? {
              ...prev,
              xpProgress: res.newXpProgress,
              xpReward: res.newXpReward,
              currentLevel: res.levelAfter,
              levelMode: pendingConfirm.kind === 'PROGRESS' ? 'AUTOMATIC' : prev.levelMode,
              updatedAt: res.record.timestamp,
            }
          : prev
      );

      const signStr =
        pendingConfirm.adjustment > 0
          ? `+${pendingConfirm.adjustment}`
          : `${pendingConfirm.adjustment}`;
      const label = pendingConfirm.kind === 'PROGRESS' ? 'XP Progress' : 'XP Reward';

      onFeedback({
        type: 'success',
        text: `${label} @${pendingConfirm.member.username} berhasil disesuaikan (${signStr} XP). Saldo baru — Progress: ${res.newXpProgress} XP, Reward: ${res.newXpReward} XP, Level: ${res.levelAfter}.`,
      });

      setPendingConfirm(null);
      setAdjustmentInput('');
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
      {!canAdjust && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200 flex items-center gap-2.5">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            Mode Read-Only: Role STAFF hanya dapat melihat riwayat penyesuaian XP. Penyesuaian XP Progress maupun XP Reward hanya diizinkan untuk ADMIN atau SUPER_ADMIN.
          </span>
        </div>
      )}

      {/* Mode Selector + Member Lookup */}
      <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-indigo-500/15 pb-4">
          <div className="space-y-1">
            <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-sky-400" />
              <span>Penyesuaian XP Member (Adjustment)</span>
            </h2>
            <p className="text-xs text-slate-400">
              Seluruh perubahan saldo tercatat sebagai entri ledger baru yang immutable tanpa menghapus riwayat lama.
            </p>
          </div>

          <div className="inline-flex rounded-xl border border-indigo-500/25 bg-[#070B19] p-1 self-start">
            <button
              type="button"
              onClick={() => setKind('PROGRESS')}
              className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                kind === 'PROGRESS'
                  ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              XP Progress
            </button>
            <button
              type="button"
              onClick={() => setKind('REWARD')}
              className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                kind === 'REWARD'
                  ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              XP Reward
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
          <div className="rounded-xl border border-indigo-500/20 bg-[#070B19] p-4 grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="col-span-2 lg:col-span-1">
              <p className="text-[11px] text-slate-400">Member Terpilih</p>
              <p className="text-sm font-bold text-white truncate">{selectedMember.fullName}</p>
              <p className="text-xs font-mono text-slate-400 truncate">
                @{selectedMember.username} · {selectedMember.memberId} · {selectedMember.status}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-slate-400">Current XP Progress</p>
              <p className="font-mono text-lg font-bold text-sky-300 tabular-nums">
                {selectedMember.xpProgress} XP
              </p>
            </div>
            <div>
              <p className="text-[11px] text-slate-400">Current XP Reward</p>
              <p className="font-mono text-lg font-bold text-purple-300 tabular-nums">
                {selectedMember.xpReward} XP
              </p>
            </div>
            <div>
              <p className="text-[11px] text-slate-400">Current Level</p>
              <p className="font-display text-lg font-bold text-white">
                {selectedMember.currentLevel}
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-indigo-500/15 bg-[#070B19]/70 p-4 text-xs text-slate-400">
            Cari username atau nomor WhatsApp member di atas untuk memuat saldo XP saat ini dan melakukan penyesuaian.
          </div>
        )}

        {/* Adjustment Form + Live Preview Split */}
        <form onSubmit={handleOpenConfirm} className="grid lg:grid-cols-12 gap-5 items-start">
          <div className="lg:col-span-7 space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-semibold text-slate-200">
                  Nilai Adjustment ({kind === 'PROGRESS' ? 'XP Progress' : 'XP Reward'}) *
                </label>
                <div className="flex items-center gap-1.5">
                  {[-100, -50, 50, 100].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      disabled={!canAdjust || !selectedMember}
                      onClick={() => setAdjustmentInput(String(preset))}
                      className="px-2 py-1 rounded-md border border-indigo-500/25 bg-[#070B19] font-mono text-[11px] text-slate-300 hover:border-sky-400/50 hover:text-white disabled:opacity-40"
                    >
                      {preset > 0 ? `+${preset}` : preset}
                    </button>
                  ))}
                </div>
              </div>
              <input
                type="number"
                step={1}
                required
                disabled={!canAdjust || !selectedMember}
                value={adjustmentInput}
                onChange={(e) => setAdjustmentInput(e.target.value)}
                placeholder="Contoh: -100 untuk mengurangi atau 100 untuk menambah"
                className="w-full h-11 rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-sm font-mono text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none disabled:opacity-50"
              />
              <p className="text-[11px] text-slate-400">
                {kind === 'PROGRESS'
                  ? 'Mengubah XP Progress akan menghitung ulang Level otomatis sesuai threshold tanpa mengubah XP Reward.'
                  : 'Mengubah XP Reward hanya menambah/mengurangi saldo tukar reward tanpa mengubah XP Progress ataupun Level.'}
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-200">
                Alasan Penyesuaian (Reason) *
              </label>
              <textarea
                rows={2}
                required
                disabled={!canAdjust || !selectedMember}
                maxLength={300}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Jelaskan alasan adjustment (wajib untuk jejak audit, misal: Koreksi double input struk #1024)"
                className="w-full rounded-xl border border-indigo-500/30 bg-[#070B19] p-3 text-sm text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none disabled:opacity-50"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-200">
                Referensi / No. Tiket (Opsional)
              </label>
              <input
                type="text"
                disabled={!canAdjust || !selectedMember}
                maxLength={120}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Contoh: TRX-2026-089 atau Tiket Koreksi #12"
                className="w-full h-10 rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-sm font-mono text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none disabled:opacity-50"
              />
            </div>
          </div>

          {/* Live Preview Card */}
          <div className="lg:col-span-5 rounded-xl border border-indigo-500/25 bg-[#070B19] p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-indigo-500/15 pb-2.5">
              <h3 className="font-display text-sm font-bold text-white">Preview Perubahan</h3>
              <span className="font-mono text-[11px] text-sky-300">
                {kind === 'PROGRESS' ? 'ADMIN_ADJUSTMENT' : 'XP_REWARD_ADMIN_ADJUSTMENT'}
              </span>
            </div>

            {!selectedMember ? (
              <p className="text-xs text-slate-400 py-4">
                Pilih member untuk melihat simulasi Before / After secara real-time.
              </p>
            ) : previewResult.error ? (
              <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 p-3 text-xs text-rose-200">
                {previewResult.error}
              </div>
            ) : previewResult.data ? (
              <div className="space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">
                    {kind === 'PROGRESS' ? 'Before XP Progress' : 'Before XP Reward'}
                  </span>
                  <span className="font-mono font-semibold text-white tabular-nums">
                    {previewResult.data.beforeBalance} XP
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Adjustment</span>
                  <span
                    className={`font-mono font-bold tabular-nums ${
                      parsedAdjustment.value >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {parsedAdjustment.value > 0
                      ? `+${parsedAdjustment.value}`
                      : parsedAdjustment.value}{' '}
                    XP
                  </span>
                </div>
                <div className="flex items-center justify-between border-t border-indigo-500/15 pt-2.5">
                  <span className="text-slate-200 font-semibold">
                    {kind === 'PROGRESS' ? 'After XP Progress' : 'After XP Reward'}
                  </span>
                  <span className="font-mono text-base font-bold text-sky-300 tabular-nums">
                    {previewResult.data.afterBalance} XP
                  </span>
                </div>

                <div className="border-t border-indigo-500/15 pt-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Level Before</span>
                    <span className="font-semibold text-white">{previewResult.data.levelBefore}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Level After</span>
                    <span
                      className={`font-bold flex items-center gap-1 ${
                        previewResult.data.levelChanged ? 'text-amber-300' : 'text-white'
                      }`}
                    >
                      <span>{previewResult.data.levelAfter}</span>
                      {!previewResult.data.levelChanged && (
                        <span className="text-[11px] font-normal text-slate-400">(Tetap)</span>
                      )}
                    </span>
                  </div>
                </div>

                <div className="rounded-lg border border-indigo-500/20 bg-[#0B1124] p-2.5 text-[11px] text-slate-300">
                  {kind === 'PROGRESS' ? (
                    <span>
                      XP Reward member tetap <strong className="font-mono text-white">{previewResult.data.newXpReward} XP</strong> (tidak berubah).
                    </span>
                  ) : (
                    <span>
                      XP Progress tetap <strong className="font-mono text-white">{previewResult.data.newXpProgress} XP</strong> &amp; Level tetap <strong className="text-white">{previewResult.data.levelAfter}</strong>.
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-400 py-4">
                Masukkan nominal adjustment (+ atau -) untuk melihat Preview Before / After dan perubahan level.
              </p>
            )}

            <button
              type="submit"
              disabled={
                !canAdjust ||
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

      {/* Adjustment History Table */}
      <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 overflow-hidden">
        <div className="p-4 border-b border-indigo-500/15 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-purple-300" />
            <h3 className="font-display text-sm font-bold text-white">Riwayat Penyesuaian XP (Audit Trail)</h3>
          </div>
          <div className="inline-flex rounded-xl border border-indigo-500/25 bg-[#070B19] p-1">
            {(['ALL', 'PROGRESS', 'REWARD'] as const).map((f) => (
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
                {f === 'ALL' ? 'Semua' : f === 'PROGRESS' ? 'XP Progress' : 'XP Reward'}
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
                <th className="p-3">Tipe</th>
                <th className="p-3 text-right">Adjustment</th>
                <th className="p-3 text-right">Saldo (Before → After)</th>
                <th className="p-3">Level</th>
                <th className="p-3">Alasan &amp; Ref</th>
                <th className="p-3">Admin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-indigo-500/15">
              {historyRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-sm text-slate-400">
                    {loadingHistory
                      ? 'Memuat riwayat penyesuaian XP...'
                      : 'Belum ada riwayat penyesuaian XP.'}
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
                    <td className="p-3 text-xs font-semibold text-slate-200 whitespace-nowrap">
                      {row.kind === 'PROGRESS' ? 'XP Progress' : 'XP Reward'}
                    </td>
                    <td
                      className={`p-3 text-right font-mono font-bold tabular-nums whitespace-nowrap ${
                        row.adjustment >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {row.adjustment > 0 ? `+${row.adjustment}` : row.adjustment} XP
                    </td>
                    <td className="p-3 text-right font-mono text-xs tabular-nums whitespace-nowrap text-slate-200">
                      {row.beforeBalance} → <strong>{row.afterBalance}</strong> XP
                    </td>
                    <td className="p-3 text-xs whitespace-nowrap">
                      {row.levelBefore !== row.levelAfter ? (
                        <span className="font-semibold text-amber-300">
                          {row.levelBefore} → {row.levelAfter}
                        </span>
                      ) : (
                        <span className="text-slate-300">{row.levelAfter}</span>
                      )}
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
                  Konfirmasi Penyesuaian XP
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Periksa kembali ringkasan perubahan sebelum menyimpan secara permanen ke ledger.
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
                <span className="text-slate-400">Jenis Adjustment</span>
                <span className="font-semibold text-sky-300">
                  {pendingConfirm.kind === 'PROGRESS'
                    ? 'XP Progress (ADMIN_ADJUSTMENT)'
                    : 'XP Reward (XP_REWARD_ADMIN_ADJUSTMENT)'}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-400">Nominal</span>
                <span
                  className={`font-mono font-bold tabular-nums ${
                    pendingConfirm.adjustment >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {pendingConfirm.adjustment > 0
                    ? `+${pendingConfirm.adjustment}`
                    : pendingConfirm.adjustment}{' '}
                  XP
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-400">Saldo Before → After</span>
                <span className="font-mono font-bold text-white tabular-nums flex items-center gap-1.5">
                  <span>{pendingConfirm.beforeBalance} XP</span>
                  <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
                  <span className="text-sky-300">{pendingConfirm.afterBalance} XP</span>
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-400">Level Before → After</span>
                <span className="font-semibold text-white flex items-center gap-1.5">
                  <span>{pendingConfirm.levelBefore}</span>
                  <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
                  <span className={pendingConfirm.levelChanged ? 'text-amber-300' : 'text-white'}>
                    {pendingConfirm.levelAfter}
                  </span>
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
