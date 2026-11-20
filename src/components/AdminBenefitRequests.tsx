import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  Clock,
  Copy,
  Gift,
  RefreshCw,
  Search,
  ShieldCheck,
  TicketCheck,
  TimerOff,
  XCircle,
} from 'lucide-react';
import { where } from 'firebase/firestore';
import { ProtectedImage } from './ProtectedImage.tsx';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import {
  fetchBenefitRequestsAdmin,
  fetchPaginatedCollection,
  markBenefitRequestUsedByCashier,
  processExpiredBenefitRequestsByAdmin,
  reviewBenefitRequestByAdmin,
  reviewClaimByAdmin,
  reviewRedemptionByAdmin,
  searchBenefitRequestsForCashier,
} from '../services/xpService.ts';
import {
  getBenefitRemainingDaysLabel,
  isBenefitRequestEffectivelyExpired,
} from '../shared/benefitRequestLogic.ts';
import { formatJakartaDateTime } from '../shared/xpLogic.ts';
import type {
  AdminUser,
  BenefitRequestRecord,
  BenefitRequestStatus,
  BranchId,
  ClaimRecord,
  RedemptionRecord,
  SystemSettings,
} from '../types/xpplay.ts';

type SubTab = 'queue' | 'cashier' | 'legacy';

interface AdminBenefitRequestsProps {
  adminProfile: AdminUser;
  systemSettings: SystemSettings;
  adminSdkConfigured: boolean;
  restoreLocked: boolean;
  onViewMember: (memberUid: string) => void;
  onFeedback: (fb: { type: 'success' | 'error'; text: string } | null) => void;
}

const STATUS_FILTERS: readonly ('ALL' | BenefitRequestStatus)[] = [
  'ON_PROCESS',
  'APPROVED',
  'USED',
  'EXPIRED',
  'REFUNDED',
  'DENIED',
  'ALL',
];

function statusAccent(status: BenefitRequestStatus, effectivelyExpired: boolean): string {
  if (effectivelyExpired) return 'text-amber-300';
  switch (status) {
    case 'ON_PROCESS':
      return 'text-sky-300';
    case 'APPROVED':
      return 'text-emerald-300';
    case 'USED':
      return 'text-indigo-300';
    case 'REFUNDED':
      return 'text-purple-300';
    case 'EXPIRED':
      return 'text-amber-400';
    case 'DENIED':
      return 'text-rose-400';
  }
}

export function AdminBenefitRequests({
  adminProfile,
  systemSettings,
  adminSdkConfigured,
  restoreLocked,
  onViewMember,
  onFeedback,
}: AdminBenefitRequestsProps) {
  const [subTab, setSubTab] = useState<SubTab>('queue');
  const [statusFilter, setStatusFilter] = useState<'ALL' | BenefitRequestStatus>('ON_PROCESS');
  const [searchQueue, setSearchQueue] = useState('');
  const [requests, setRequests] = useState<BenefitRequestRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Deny modal
  const [denyModal, setDenyModal] = useState<{
    kind: 'benefitRequest' | 'claim' | 'redemption';
    id: string;
    title: string;
    xpCost: number;
  } | null>(null);
  const [denyReason, setDenyReason] = useState('');

  // Cashier Mode (FASE 6)
  const [cashierQuery, setCashierQuery] = useState('');
  const [cashierResults, setCashierResults] = useState<BenefitRequestRecord[]>([]);
  const [loadingCashier, setLoadingCashier] = useState(false);
  const [cashierBranch, setCashierBranch] = useState<BranchId>(
    adminProfile.branchScope === 'SEKIP' ? 'SEKIP' : 'DEMANG'
  );
  const [cashierReceiptRef, setCashierReceiptRef] = useState('');

  // Legacy Claims & Redemptions
  const [legacyClaims, setLegacyClaims] = useState<ClaimRecord[]>([]);
  const [legacyRedemptions, setLegacyRedemptions] = useState<RedemptionRecord[]>([]);
  const [loadingLegacy, setLoadingLegacy] = useState(false);

  const loadQueue = async () => {
    setLoading(true);
    try {
      const items = await fetchBenefitRequestsAdmin({ status: statusFilter, maxItems: 200 });
      setRequests(items);
    } catch (err) {
      onFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setLoading(false);
    }
  };

  const loadCashier = async (keyword: string) => {
    setLoadingCashier(true);
    try {
      const items = await searchBenefitRequestsForCashier(keyword);
      setCashierResults(items);
    } catch (err) {
      onFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setLoadingCashier(false);
    }
  };

  const loadLegacy = async () => {
    setLoadingLegacy(true);
    try {
      const [cRes, rRes] = await Promise.all([
        fetchPaginatedCollection<ClaimRecord>({
          collectionName: 'claims',
          constraints: [where('status', '==', 'ON_PROCESS')],
          orderByField: 'createdAt',
          orderDirection: 'desc',
          pageSize: 50,
        }),
        fetchPaginatedCollection<RedemptionRecord>({
          collectionName: 'redemptions',
          constraints: [where('status', '==', 'ON_PROCESS')],
          orderByField: 'createdAt',
          orderDirection: 'desc',
          pageSize: 50,
        }),
      ]);
      setLegacyClaims(cRes.items);
      setLegacyRedemptions(rRes.items);
    } catch (err) {
      onFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setLoadingLegacy(false);
    }
  };

  useEffect(() => {
    if (subTab === 'queue') {
      void loadQueue();
    } else if (subTab === 'cashier') {
      void loadCashier(cashierQuery);
    } else {
      void loadLegacy();
    }
  }, [subTab, statusFilter]);

  const filteredQueue = useMemo(() => {
    const q = searchQueue.trim().toLowerCase();
    if (!q) return requests;
    return requests.filter(
      (r) =>
        r.id.toLowerCase().includes(q) ||
        r.memberUsername.toLowerCase().includes(q) ||
        r.memberName.toLowerCase().includes(q) ||
        r.memberWhatsapp.includes(q) ||
        r.title.toLowerCase().includes(q)
    );
  }, [requests, searchQueue]);

  const handleCopyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1500);
    } catch {
      // Clipboard not available
    }
  };

  const handleApproveBenefitRequest = async (req: BenefitRequestRecord) => {
    if (restoreLocked) return;
    setBusyId(req.id);
    onFeedback(null);
    try {
      await reviewBenefitRequestByAdmin({
        requestId: req.id,
        decision: 'APPROVED',
        admin: adminProfile,
        adminSdkConfigured,
      });
      onFeedback({
        type: 'success',
        text: `Benefit Request ${req.id} (@${req.memberUsername} · ${req.title}) DISETUJUI dan berlaku 7 hari.`,
      });
      await loadQueue();
    } catch (err) {
      onFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmDeny = async (e: FormEvent) => {
    e.preventDefault();
    if (!denyModal || restoreLocked) return;
    const reason = denyReason.trim();
    if (reason.length < 3) {
      onFeedback({ type: 'error', text: 'Alasan penolakan minimal 3 karakter.' });
      return;
    }
    setBusyId(denyModal.id);
    onFeedback(null);
    try {
      if (denyModal.kind === 'benefitRequest') {
        await reviewBenefitRequestByAdmin({
          requestId: denyModal.id,
          decision: 'DENIED',
          reason,
          admin: adminProfile,
          adminSdkConfigured,
        });
        onFeedback({
          type: 'success',
          text:
            denyModal.xpCost > 0
              ? `Request ${denyModal.id} ditolak & ${denyModal.xpCost} XP otomatis dikembalikan (REFUNDED) ke saldo member.`
              : `Request ${denyModal.id} berhasil ditolak (DENIED).`,
        });
        await loadQueue();
      } else if (denyModal.kind === 'claim') {
        await reviewClaimByAdmin({
          claimId: denyModal.id,
          decision: 'DENIED',
          reason,
          admin: adminProfile,
          adminSdkConfigured,
        });
        onFeedback({ type: 'success', text: `Legacy Claim ${denyModal.id} ditolak.` });
        await loadLegacy();
      } else {
        await reviewRedemptionByAdmin({
          redemptionId: denyModal.id,
          decision: 'DENIED',
          reason,
          admin: adminProfile,
          adminSdkConfigured,
        });
        onFeedback({ type: 'success', text: `Legacy Redemption ${denyModal.id} ditolak.` });
        await loadLegacy();
      }
      setDenyModal(null);
      setDenyReason('');
    } catch (err) {
      onFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusyId(null);
    }
  };

  const handleMarkUsed = async (req: BenefitRequestRecord) => {
    if (restoreLocked) return;
    setBusyId(req.id);
    onFeedback(null);
    try {
      await markBenefitRequestUsedByCashier({
        requestId: req.id,
        usedBranch: cashierBranch,
        receiptReference: cashierReceiptRef,
        admin: adminProfile,
        adminSdkConfigured,
      });
      onFeedback({
        type: 'success',
        text: `Benefit ${req.id} (${req.title}) milik @${req.memberUsername} telah ditandai USED di cabang ${cashierBranch}.`,
      });
      setCashierReceiptRef('');
      await loadCashier(cashierQuery);
    } catch (err) {
      onFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusyId(null);
    }
  };

  const handleProcessExpired = async () => {
    if (restoreLocked) return;
    setBusyId('__expired__');
    onFeedback(null);
    try {
      const res = await processExpiredBenefitRequestsByAdmin({
        admin: adminProfile,
        adminSdkConfigured,
      });
      onFeedback({
        type: 'success',
        text:
          res.processedCount === 0
            ? 'Tidak ada Benefit Request APPROVED yang melewati batas 7 hari saat ini.'
            : `Berhasil memproses ${res.processedCount} benefit kadaluarsa (${res.refundedCount} REFUNDED, ${res.expiredOnlyCount} EXPIRED).`,
      });
      await loadQueue();
    } catch (err) {
      onFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusyId(null);
    }
  };

  const handleCashierSearchSubmit = (e: FormEvent) => {
    e.preventDefault();
    void loadCashier(cashierQuery);
  };

  const handleApproveLegacy = async (kind: 'claim' | 'redemption', id: string) => {
    if (restoreLocked) return;
    setBusyId(id);
    onFeedback(null);
    try {
      if (kind === 'claim') {
        await reviewClaimByAdmin({
          claimId: id,
          decision: 'APPROVED',
          admin: adminProfile,
          adminSdkConfigured,
        });
      } else {
        await reviewRedemptionByAdmin({
          redemptionId: id,
          decision: 'APPROVED',
          admin: adminProfile,
          adminSdkConfigured,
        });
      }
      onFeedback({ type: 'success', text: `Legacy ${kind} ${id} disetujui.` });
      await loadLegacy();
    } catch (err) {
      onFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Sub-navigation tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
          <button
            type="button"
            onClick={() => setSubTab('queue')}
            className={`min-h-[44px] px-4 py-2 rounded-xl text-xs font-semibold border flex items-center gap-2 whitespace-nowrap transition-all ${
              subTab === 'queue'
                ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white border-sky-400/50 shadow-[0_0_16px_-4px_rgba(99,102,241,0.5)]'
                : 'bg-[#0B1124] text-slate-300 border-indigo-500/25 hover:text-white'
            }`}
          >
            <Gift className="w-4 h-4" />
            <span>Antrian Benefit Request</span>
          </button>
          <button
            type="button"
            onClick={() => setSubTab('cashier')}
            className={`min-h-[44px] px-4 py-2 rounded-xl text-xs font-semibold border flex items-center gap-2 whitespace-nowrap transition-all ${
              subTab === 'cashier'
                ? 'bg-gradient-to-r from-emerald-600 to-sky-600 text-white border-emerald-400/50 shadow-[0_0_16px_-4px_rgba(16,185,129,0.5)]'
                : 'bg-[#0B1124] text-slate-300 border-indigo-500/25 hover:text-white'
            }`}
          >
            <TicketCheck className="w-4 h-4" />
            <span>Kasir / Verifikasi Benefit</span>
          </button>
          <button
            type="button"
            onClick={() => setSubTab('legacy')}
            className={`min-h-[44px] px-4 py-2 rounded-xl text-xs font-semibold border flex items-center gap-2 whitespace-nowrap transition-all ${
              subTab === 'legacy'
                ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white border-sky-400/50'
                : 'bg-[#0B1124] text-slate-300 border-indigo-500/25 hover:text-white'
            }`}
          >
            <Clock className="w-4 h-4" />
            <span>Antrian Legacy (Claims & Redemptions)</span>
          </button>
        </div>

        <button
          type="button"
          disabled={busyId === '__expired__' || restoreLocked}
          onClick={() => void handleProcessExpired()}
          className="min-h-[44px] px-4 py-2 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 text-xs font-semibold flex items-center gap-2 disabled:opacity-50"
        >
          <TimerOff className="w-4 h-4" />
          <span>
            {busyId === '__expired__' ? 'Memproses Expired...' : 'Proses Benefit Expired (>7 Hari)'}
          </span>
        </button>
      </div>

      {/* Policy strip */}
      <div className="rounded-xl border border-indigo-500/20 bg-[#0B1124] px-4 py-3 text-xs text-slate-300 flex flex-wrap items-center justify-between gap-2">
        <span>
          Aturan Hold & Masa Berlaku: XP langsung ditahan saat pengajuan, refund otomatis jika ditolak, dan berlaku{' '}
          <strong className="text-white font-mono">7 Hari</strong> sejak disetujui.
        </span>
        <span className="font-mono text-slate-400">
          Kebijakan Refund Expired:{' '}
          <strong className={systemSettings.refundOnExpiry ? 'text-emerald-300' : 'text-amber-300'}>
            {systemSettings.refundOnExpiry ? 'AKTIF (Refund Otomatis)' : 'NONAKTIF (Hangus / EXPIRED)'}
          </strong>
        </span>
      </div>

      {/* SUB-TAB 1: BENEFIT REQUESTS QUEUE */}
      {subTab === 'queue' && (
        <div className="space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
              {STATUS_FILTERS.map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-mono font-semibold border whitespace-nowrap transition-colors ${
                    statusFilter === st
                      ? 'bg-indigo-600 text-white border-sky-400/50'
                      : 'bg-[#0B1124] text-slate-300 border-indigo-500/20 hover:text-white'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1 sm:w-72">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQueue}
                  onChange={(e) => setSearchQueue(e.target.value)}
                  placeholder="Cari BRQ-ID, username, WA, benefit..."
                  className="w-full h-10 pl-9 pr-3 rounded-xl border border-indigo-500/30 bg-[#070B19] text-sm text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={() => void loadQueue()}
                className="min-h-[40px] px-3 rounded-xl border border-indigo-500/30 bg-[#0B1124] text-slate-200 hover:border-sky-400/50"
                aria-label="Muat ulang antrian"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 divide-y divide-indigo-500/15">
            {loading && requests.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-400">Memuat antrian Benefit Request...</div>
            ) : filteredQueue.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-400">
                Tidak ada Benefit Request pada filter <span className="font-mono text-white">{statusFilter}</span>.
              </div>
            ) : (
              filteredQueue.map((req) => {
                const effExpired = isBenefitRequestEffectivelyExpired(req);
                const isBusy = busyId === req.id;
                return (
                  <div
                    key={req.id}
                    className="p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      {req.evidenceUrl ? (
                        <ProtectedImage
                          src={req.evidenceUrl}
                          alt={`Bukti ${req.title}`}
                          className="w-20 h-20 rounded-xl object-cover border border-indigo-500/25 shrink-0"
                        />
                      ) : null}
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                          <button
                            type="button"
                            onClick={() => void handleCopyId(req.id)}
                            className="font-mono text-xs font-bold text-sky-300 hover:text-sky-200 inline-flex items-center gap-1"
                            title="Salin Request ID"
                          >
                            <span>{req.id}</span>
                            <Copy className="w-3 h-3" />
                            {copiedId === req.id && <span className="text-emerald-300 text-[10px]">Disalin</span>}
                          </button>
                          <span className="text-xs font-mono text-slate-400">{req.sourceType}</span>
                          <span className={`font-mono text-xs font-bold ${statusAccent(req.status, effExpired)}`}>
                            {effExpired ? 'APPROVED (LEWAT 7 HARI)' : req.status}
                          </span>
                          {req.resolution && (
                            <span className="font-mono text-[11px] text-slate-400">({req.resolution})</span>
                          )}
                        </div>

                        <p className="text-sm font-bold text-white truncate">{req.title}</p>

                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-300">
                          <button
                            type="button"
                            onClick={() => onViewMember(req.memberUid)}
                            className="font-mono text-sky-300 hover:underline font-semibold"
                          >
                            {req.memberUsername ? `@${req.memberUsername}` : '(PRE_REGISTERED)'} ({req.memberName})
                          </button>
                          <span className="font-mono text-slate-400">{req.memberWhatsapp}</span>
                          {req.xpCost > 0 && (
                            <span className="font-mono font-semibold text-purple-300 tabular-nums">
                              Hold: {req.xpCost} XP
                            </span>
                          )}
                          {req.xpRewardGrant > 0 && (
                            <span className="font-mono font-semibold text-emerald-300 tabular-nums">
                              Reward: +{req.xpRewardGrant} XP
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400 font-mono">
                          <span>Diajukan: {formatJakartaDateTime(req.createdAt)}</span>
                          {req.approvedAt && <span>Disetujui: {formatJakartaDateTime(req.approvedAt)}</span>}
                          {req.expiresAt && (
                            <span className={effExpired ? 'text-amber-300' : 'text-sky-300'}>
                              Berlaku s/d: {formatJakartaDateTime(req.expiresAt)} ({getBenefitRemainingDaysLabel(req.expiresAt)})
                            </span>
                          )}
                          {req.usedAt && (
                            <span className="text-indigo-300">
                              Digunakan: {formatJakartaDateTime(req.usedAt)} ({req.usedBranch})
                            </span>
                          )}
                          {req.refundedAt && (
                            <span className="text-purple-300">
                              Refund: +{req.refundedAmount} XP pada {formatJakartaDateTime(req.refundedAt)}
                            </span>
                          )}
                        </div>

                        {req.note && <p className="text-xs text-slate-300">Catatan Member: {req.note}</p>}
                        {req.deniedReason && <p className="text-xs text-rose-400">Alasan Ditolak: {req.deniedReason}</p>}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onViewMember(req.memberUid)}
                        className="min-h-[40px] px-3 py-1.5 rounded-lg border border-indigo-500/30 bg-[#070B19] text-xs font-semibold text-slate-200 hover:border-sky-400/50"
                      >
                        Detail Member
                      </button>

                      {req.status === 'ON_PROCESS' && (
                        <>
                          <button
                            type="button"
                            disabled={isBusy || restoreLocked}
                            onClick={() => void handleApproveBenefitRequest(req)}
                            className="min-h-[40px] px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white inline-flex items-center gap-1.5 disabled:opacity-50"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>{isBusy ? 'Memproses...' : 'APPROVE'}</span>
                          </button>
                          <button
                            type="button"
                            disabled={isBusy || restoreLocked}
                            onClick={() => {
                              setDenyModal({
                                kind: 'benefitRequest',
                                id: req.id,
                                title: req.title,
                                xpCost: req.xpCost,
                              });
                              setDenyReason('');
                            }}
                            className="min-h-[40px] px-3.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs font-semibold text-white inline-flex items-center gap-1.5 disabled:opacity-50"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                            <span>DENY{req.xpCost > 0 ? ' & REFUND' : ''}</span>
                          </button>
                        </>
                      )}

                      {req.status === 'APPROVED' && !effExpired && (
                        <button
                          type="button"
                          onClick={() => {
                            setCashierQuery(req.id);
                            setSubTab('cashier');
                            void loadCashier(req.id);
                          }}
                          className="min-h-[40px] px-3.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white inline-flex items-center gap-1.5"
                        >
                          <TicketCheck className="w-3.5 h-3.5" />
                          <span>Verifikasi Kasir</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* SUB-TAB 2: CASHIER VERIFICATION MODE (FASE 6) */}
      {subTab === 'cashier' && (
        <div className="space-y-5">
          <div className="bg-[#0B1124] rounded-2xl border border-emerald-500/30 p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-emerald-400" />
                  <span>Mode Kasir — Verifikasi & Gunakan Benefit (MARK AS USED)</span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Cari cepat berdasarkan Request ID (<span className="font-mono text-sky-300">BRQ-...</span>), Username, atau Nomor WhatsApp member.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-400">Cabang Kasir:</label>
                <select
                  value={cashierBranch}
                  onChange={(e) => setCashierBranch(e.target.value as BranchId)}
                  className="h-10 rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-xs font-semibold text-white"
                >
                  <option value="DEMANG">XP PLAY DEMANG</option>
                  <option value="SEKIP">XP PLAY SEKIP</option>
                </select>
              </div>
            </div>

            <form onSubmit={handleCashierSearchSubmit} className="grid sm:grid-cols-4 gap-3">
              <div className="relative sm:col-span-2">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={cashierQuery}
                  onChange={(e) => setCashierQuery(e.target.value)}
                  placeholder="Ketik BRQ-XXXX, username, atau 08..."
                  className="w-full h-11 pl-9 pr-3 rounded-xl border border-indigo-500/35 bg-[#070B19] text-sm font-mono text-white placeholder:text-slate-400 focus:border-emerald-400 focus:outline-none"
                />
              </div>
              <input
                type="text"
                value={cashierReceiptRef}
                onChange={(e) => setCashierReceiptRef(e.target.value)}
                placeholder="No. Struk / Billing Ref (opsional)"
                className="h-11 rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-xs font-mono text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none"
              />
              <button
                type="submit"
                disabled={loadingCashier}
                className="h-11 rounded-xl bg-gradient-to-r from-emerald-600 to-sky-600 hover:from-emerald-500 hover:to-sky-500 text-xs font-bold text-white"
              >
                {loadingCashier ? 'Mencari...' : 'Cari Voucher Benefit'}
              </button>
            </form>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {loadingCashier ? (
              <div className="md:col-span-2 rounded-2xl bg-[#0B1124] border border-indigo-500/20 p-8 text-center text-sm text-slate-400">
                Mencari benefit untuk verifikasi kasir...
              </div>
            ) : cashierResults.length === 0 ? (
              <div className="md:col-span-2 rounded-2xl bg-[#0B1124] border border-indigo-500/20 p-8 text-center text-sm text-slate-400">
                Tidak ditemukan voucher benefit yang cocok. Kosongkan pencarian untuk menampilkan daftar benefit APPROVED aktif.
              </div>
            ) : (
              cashierResults.map((req) => {
                const effExpired = isBenefitRequestEffectivelyExpired(req);
                const canMarkUsed = req.status === 'APPROVED' && !effExpired && !restoreLocked;
                const isBusy = busyId === req.id;

                return (
                  <div
                    key={req.id}
                    className={`rounded-2xl border p-5 space-y-4 ${
                      canMarkUsed
                        ? 'bg-[#0B1124] border-emerald-500/40'
                        : 'bg-[#090E1E] border-indigo-500/20 opacity-90'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-xs font-bold text-sky-300">{req.id}</p>
                        <h3 className="font-display text-base font-bold text-white mt-0.5">{req.title}</h3>
                        <button
                          type="button"
                          onClick={() => onViewMember(req.memberUid)}
                          className="text-xs font-mono text-slate-300 hover:text-sky-300 hover:underline mt-0.5"
                        >
                          {req.memberUsername ? `@${req.memberUsername}` : '(PRE_REGISTERED)'} · {req.memberName} · {req.memberWhatsapp}
                        </button>
                      </div>
                      <span className={`font-mono text-xs font-bold shrink-0 ${statusAccent(req.status, effExpired)}`}>
                        {effExpired ? 'EXPIRED (>7 HARI)' : req.status}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5 text-xs bg-[#070B19] rounded-xl p-3 border border-indigo-500/15">
                      <div>
                        <p className="text-slate-400">Jenis / Biaya XP</p>
                        <p className="font-mono text-white font-semibold mt-0.5">
                          {req.sourceType} · {req.xpCost > 0 ? `${req.xpCost} XP` : `+${req.xpRewardGrant} XP`}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400">Sisa Masa Berlaku</p>
                        <p className={`font-mono font-semibold mt-0.5 ${effExpired ? 'text-amber-400' : 'text-emerald-300'}`}>
                          {req.status === 'USED'
                            ? `Sudah dipakai (${req.usedBranch})`
                            : req.expiresAt
                              ? getBenefitRemainingDaysLabel(req.expiresAt)
                              : '-'}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400">Tanggal Disetujui</p>
                        <p className="font-mono text-slate-200 mt-0.5">
                          {req.approvedAt ? formatJakartaDateTime(req.approvedAt) : '-'}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400">Batas Berlaku (7 Hari)</p>
                        <p className="font-mono text-slate-200 mt-0.5">
                          {req.expiresAt ? formatJakartaDateTime(req.expiresAt) : '-'}
                        </p>
                      </div>
                    </div>

                    {canMarkUsed ? (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleMarkUsed(req)}
                        className="w-full min-h-[44px] rounded-xl bg-emerald-600 hover:bg-emerald-500 text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
                      >
                        <TicketCheck className="w-4 h-4" />
                        <span>{isBusy ? 'Memverifikasi...' : `MARK AS USED (${cashierBranch})`}</span>
                      </button>
                    ) : (
                      <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 px-3 py-2.5 text-xs text-slate-300">
                        {req.status === 'USED'
                          ? `Sudah digunakan pada ${formatJakartaDateTime(req.usedAt)} di cabang ${req.usedBranch}${req.receiptReference ? ` (Ref: ${req.receiptReference})` : ''}. Tidak bisa dipakai ulang.`
                          : effExpired || req.status === 'EXPIRED'
                            ? 'Masa berlaku 7 hari telah habis. Benefit kadaluarsa tidak dapat ditandai USED.'
                            : req.status === 'ON_PROCESS'
                              ? 'Benefit masih menunggu persetujuan admin (ON_PROCESS). Setujui di tab Antrian terlebih dahulu.'
                              : `Benefit berstatus ${req.status} dan tidak dapat digunakan.`}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* SUB-TAB 3: LEGACY CLAIMS & REDEMPTIONS QUEUE (Backward Compatibility) */}
      {subTab === 'legacy' && (
        <div className="grid lg:grid-cols-2 gap-5">
          <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 overflow-hidden">
            <div className="p-4 border-b border-indigo-500/15 flex items-center justify-between">
              <h3 className="font-display text-sm font-bold text-white">Legacy Claims (ON_PROCESS)</h3>
              <span className="font-mono text-xs text-slate-400">{legacyClaims.length} pending</span>
            </div>
            <div className="divide-y divide-indigo-500/15">
              {loadingLegacy ? (
                <div className="p-6 text-center text-xs text-slate-400">Memuat legacy claims...</div>
              ) : legacyClaims.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400">Tidak ada antrian legacy claim pending.</div>
              ) : (
                legacyClaims.map((cl) => (
                  <div key={cl.id} className="p-4 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-white truncate">{cl.campaignTitle}</p>
                      <p className="text-xs font-mono text-slate-400">
                        @{cl.memberUsername} · +{cl.xpRewardSnapshot} XP · {formatJakartaDateTime(cl.createdAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={busyId === cl.id || restoreLocked}
                        onClick={() => void handleApproveLegacy('claim', cl.id)}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 text-xs font-semibold text-white"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busyId === cl.id || restoreLocked}
                        onClick={() => {
                          setDenyModal({ kind: 'claim', id: cl.id, title: cl.campaignTitle, xpCost: 0 });
                          setDenyReason('');
                        }}
                        className="px-3 py-1.5 rounded-lg bg-rose-600 text-xs font-semibold text-white"
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 overflow-hidden">
            <div className="p-4 border-b border-indigo-500/15 flex items-center justify-between">
              <h3 className="font-display text-sm font-bold text-white">Legacy Redemptions (ON_PROCESS)</h3>
              <span className="font-mono text-xs text-slate-400">{legacyRedemptions.length} pending</span>
            </div>
            <div className="divide-y divide-indigo-500/15">
              {loadingLegacy ? (
                <div className="p-6 text-center text-xs text-slate-400">Memuat legacy redemptions...</div>
              ) : legacyRedemptions.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400">Tidak ada antrian legacy redemption pending.</div>
              ) : (
                legacyRedemptions.map((rd) => (
                  <div key={rd.id} className="p-4 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-white truncate">{rd.benefitName}</p>
                      <p className="text-xs font-mono text-slate-400">
                        @{rd.memberUsername} · {rd.xpCostSnapshot} XP · {formatJakartaDateTime(rd.createdAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={busyId === rd.id || restoreLocked}
                        onClick={() => void handleApproveLegacy('redemption', rd.id)}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 text-xs font-semibold text-white"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busyId === rd.id || restoreLocked}
                        onClick={() => {
                          setDenyModal({ kind: 'redemption', id: rd.id, title: rd.benefitName, xpCost: 0 });
                          setDenyReason('');
                        }}
                        className="px-3 py-1.5 rounded-lg bg-rose-600 text-xs font-semibold text-white"
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Deny Modal */}
      {denyModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleConfirmDeny}
            className="w-full max-w-md bg-[#0B1124] rounded-2xl border border-rose-500/40 p-6 space-y-4"
          >
            <h3 className="font-display text-lg font-bold text-white">
              Tolak Pengajuan: {denyModal.title}
            </h3>
            {denyModal.xpCost > 0 && (
              <div className="rounded-xl border border-purple-500/35 bg-purple-500/10 p-3 text-xs text-purple-200">
                Menolak pengajuan ini akan otomatis mengembalikan{' '}
                <strong className="font-mono text-white">{denyModal.xpCost} XP</strong> ke saldo XP Reward member dan mencatat entri ledger <span className="font-mono">DENIED_REFUND</span>.
              </div>
            )}
            <textarea
              rows={3}
              required
              minLength={3}
              placeholder="Tuliskan alasan penolakan yang jelas untuk member..."
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              className="w-full rounded-xl border border-indigo-500/30 bg-[#070B19] p-3 text-sm text-white placeholder:text-slate-400 focus:border-rose-400 focus:outline-none"
            />
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setDenyModal(null)}
                className="flex-1 min-h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] text-xs font-semibold text-slate-200"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={busyId === denyModal.id}
                className="flex-1 min-h-[44px] rounded-xl bg-rose-600 hover:bg-rose-500 text-xs font-bold text-white disabled:opacity-50"
              >
                {busyId === denyModal.id
                  ? 'Memproses...'
                  : denyModal.xpCost > 0
                    ? `Tolak & Refund ${denyModal.xpCost} XP`
                    : 'Konfirmasi Tolak'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
