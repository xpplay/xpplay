import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import { fetchUnifiedXpHistory } from '../services/xpService.ts';
import {
  classifyXpLedgerMovement,
  getXpLedgerMovementLabel,
  type XpLedgerMovementCategory,
} from '../shared/benefitRequestLogic.ts';
import { formatJakartaDateTime } from '../shared/xpLogic.ts';
import type { BranchId, XpLedgerEntry, XpLedgerSource } from '../types/xpplay.ts';

interface AdminXpHistoryProps {
  onSelectMember: (memberUid: string) => void;
  onFeedback: (fb: { type: 'success' | 'error'; text: string } | null) => void;
}

const PAGE_SIZE = 25;

const SOURCE_OPTIONS: ('ALL' | XpLedgerSource)[] = [
  'ALL',
  'REGISTRATION',
  'REFERRAL',
  'TRANSACTION',
  'CHALLENGE',
  'EVENT',
  'PROMO',
  'LEVEL_BONUS',
  'BENEFIT_REQUEST_HOLD',
  'DENIED_REFUND',
  'EXPIRY_REFUND',
  'ADMIN_ADJUSTMENT',
  'XP_REWARD_ADMIN_ADJUSTMENT',
  'REDEMPTION',
  'RESET',
];

export function AdminXpHistory({ onSelectMember, onFeedback }: AdminXpHistoryProps) {
  const [entries, setEntries] = useState<XpLedgerEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const [xpTypeFilter, setXpTypeFilter] = useState<'ALL' | 'PROGRESS' | 'REWARD'>('ALL');
  const [movementFilter, setMovementFilter] = useState<'ALL' | XpLedgerMovementCategory>('ALL');
  const [sourceFilter, setSourceFilter] = useState<'ALL' | XpLedgerSource>('ALL');
  const [branchFilter, setBranchFilter] = useState<'ALL' | BranchId>('ALL');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const loadData = async () => {
    setLoading(true);
    try {
      const items = await fetchUnifiedXpHistory(300);
      setEntries(items);
    } catch (err) {
      onFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (xpTypeFilter !== 'ALL' && e.type !== xpTypeFilter) return false;
      if (movementFilter !== 'ALL' && classifyXpLedgerMovement(e) !== movementFilter) return false;
      if (sourceFilter !== 'ALL' && e.source !== sourceFilter) return false;
      if (branchFilter !== 'ALL' && e.branch !== branchFilter) return false;
      if (q) {
        const hitUser = (e.memberUsername || '').toLowerCase().includes(q);
        const hitMemberId = (e.memberId || '').toLowerCase().includes(q);
        const hitRef = (e.referenceId || '').toLowerCase().includes(q);
        const hitNote = (e.note || '').toLowerCase().includes(q);
        const hitId = (e.id || '').toLowerCase().includes(q);
        if (!hitUser && !hitMemberId && !hitRef && !hitNote && !hitId) return false;
      }
      return true;
    });
  }, [entries, xpTypeFilter, movementFilter, sourceFilter, branchFilter, search]);

  useEffect(() => {
    setPage(1);
  }, [xpTypeFilter, movementFilter, sourceFilter, branchFilter, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-4">
      {/* Filter Toolbar */}
      <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-base font-bold text-white">
              Buku Besar XP History Terpadu (Progress & Reward)
            </h2>
            <p className="text-xs text-slate-400">
              Menampilkan {filtered.length} dari {entries.length} catatan ledger immutable (Hold, Refund, Transaksi, Adjustment, Bonus).
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadData()}
            className="min-h-[40px] px-3.5 rounded-xl border border-indigo-500/30 bg-[#070B19] text-xs font-semibold text-slate-200 inline-flex items-center gap-1.5 hover:border-sky-400/50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Muat Ulang</span>
          </button>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Username / Member ID / Ref / Note..."
              className="w-full h-10 pl-9 pr-3 rounded-xl border border-indigo-500/30 bg-[#070B19] text-xs text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none"
            />
          </div>

          <select
            value={xpTypeFilter}
            onChange={(e) => setXpTypeFilter(e.target.value as 'ALL' | 'PROGRESS' | 'REWARD')}
            className="h-10 rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-xs text-white"
          >
            <option value="ALL">Semua Jenis XP</option>
            <option value="PROGRESS">XP PROGRESS</option>
            <option value="REWARD">XP REWARD</option>
          </select>

          <select
            value={movementFilter}
            onChange={(e) => setMovementFilter(e.target.value as 'ALL' | XpLedgerMovementCategory)}
            className="h-10 rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-xs text-white"
          >
            <option value="ALL">Semua Pergerakan</option>
            <option value="POSITIVE">XP Bertambah (+)</option>
            <option value="NEGATIVE">XP Berkurang / Hold (-)</option>
            <option value="REFUND">XP Dikembalikan (Refund)</option>
          </select>

          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as 'ALL' | XpLedgerSource)}
            className="h-10 rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-xs text-white"
          >
            {SOURCE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s === 'ALL' ? 'Semua Source' : s}
              </option>
            ))}
          </select>

          <select
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value as 'ALL' | BranchId)}
            className="h-10 rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-xs text-white"
          >
            <option value="ALL">Semua Cabang</option>
            <option value="DEMANG">DEMANG</option>
            <option value="SEKIP">SEKIP</option>
          </select>
        </div>
      </div>

      {/* 12-Column Table */}
      <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-indigo-500/20 text-left text-slate-400">
              <th className="p-3">Ledger ID</th>
              <th className="p-3">Tanggal</th>
              <th className="p-3">Member</th>
              <th className="p-3">XP Type</th>
              <th className="p-3">Pergerakan</th>
              <th className="p-3 text-right">Amount</th>
              <th className="p-3 text-right">Before</th>
              <th className="p-3 text-right">After</th>
              <th className="p-3">Source</th>
              <th className="p-3">Reference ID</th>
              <th className="p-3">Cabang</th>
              <th className="p-3">Reason & Actor</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-indigo-500/15">
            {loading && entries.length === 0 ? (
              <tr>
                <td colSpan={12} className="p-8 text-center text-slate-400">
                  Memuat buku besar XP History...
                </td>
              </tr>
            ) : paged.length === 0 ? (
              <tr>
                <td colSpan={12} className="p-8 text-center text-slate-400">
                  Tidak ada entri ledger yang cocok dengan filter.
                </td>
              </tr>
            ) : (
              paged.map((e) => {
                const cat = classifyXpLedgerMovement(e);
                return (
                  <tr key={`${e.type}_${e.id}`} className="hover:bg-[#0F1733]/60">
                    <td className="p-3 font-mono text-[11px] text-slate-400 whitespace-nowrap">{e.id}</td>
                    <td className="p-3 font-mono text-slate-300 whitespace-nowrap">
                      {formatJakartaDateTime(e.createdAt)}
                    </td>
                    <td className="p-3 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => onSelectMember(e.memberUid)}
                        className="font-mono text-sky-300 hover:underline font-semibold"
                      >
                        {e.memberUsername ? `@${e.memberUsername}` : e.memberId}
                      </button>
                      <p className="font-mono text-[10px] text-slate-500">{e.memberId}</p>
                    </td>
                    <td className="p-3 font-mono font-semibold text-white">{e.type}</td>
                    <td
                      className={`p-3 font-semibold whitespace-nowrap ${
                        cat === 'REFUND'
                          ? 'text-purple-300'
                          : cat === 'POSITIVE'
                            ? 'text-emerald-300'
                            : 'text-amber-300'
                      }`}
                    >
                      {getXpLedgerMovementLabel(e)}
                    </td>
                    <td
                      className={`p-3 text-right font-mono font-bold tabular-nums whitespace-nowrap ${
                        e.amount >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {e.amount >= 0 ? `+${e.amount}` : e.amount} XP
                    </td>
                    <td className="p-3 text-right font-mono text-slate-400 tabular-nums">
                      {typeof e.beforeBalance === 'number' ? e.beforeBalance : '-'}
                    </td>
                    <td className="p-3 text-right font-mono text-slate-200 tabular-nums">
                      {typeof e.afterBalance === 'number' ? e.afterBalance : '-'}
                    </td>
                    <td className="p-3 font-mono text-slate-300 whitespace-nowrap">{e.source}</td>
                    <td className="p-3 font-mono text-slate-400 whitespace-nowrap">{e.referenceId}</td>
                    <td className="p-3 font-mono text-slate-300">{e.branch || '-'}</td>
                    <td className="p-3 text-slate-300 max-w-xs">
                      <p className="truncate" title={e.note}>{e.note}</p>
                      <p className="font-mono text-[10px] text-slate-500">By: {e.createdBy}</p>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="p-3 border-t border-indigo-500/15 flex items-center justify-between text-xs text-slate-300">
            <span className="font-mono">
              Halaman {page} / {totalPages} ({filtered.length} baris)
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1.5 rounded-lg border border-indigo-500/30 bg-[#070B19] disabled:opacity-40"
              >
                Sebelumnya
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="px-3 py-1.5 rounded-lg border border-indigo-500/30 bg-[#070B19] disabled:opacity-40"
              >
                Berikutnya
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
