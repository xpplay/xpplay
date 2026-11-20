import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Activity,
  Bell,
  Check,
  CheckCircle2,
  Copy,
  CreditCard,
  Gift,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogOut,
  MapPin,
  Menu,
  MessageSquare,
  Phone,
  RefreshCw,
  Search,
  ShieldCheck,
  TicketCheck,
  User as UserIcon,
  UserPlus,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import {
  fetchCashierBranchDashboardData,
  findMemberByIdentifierAdmin,
  markBenefitRequestUsedByCashier,
  preRegisterCustomerClient,
  recordTransactionByAdmin,
  regenerateOnboardingCodeClient,
  reviewBenefitRequestByAdmin,
  submitAssistedBenefitRequestByCashier,
} from '../services/xpService.ts';
import {
  getBenefitRemainingDaysLabel,
  isBenefitRequestEffectivelyExpired,
} from '../shared/benefitRequestLogic.ts';
import { getEffectiveCashierBranch } from '../shared/rbac.ts';
import {
  calculateTransactionXp,
  formatIdr,
  formatJakartaDateTime,
  getBranchLabel,
  resolveEffectiveMemberLevel,
} from '../shared/xpLogic.ts';
import type {
  BenefitItem,
  BenefitRequestRecord,
  BenefitRequestSourceType,
  BranchId,
  CampaignItem,
  MemberProfile,
  MemberStatus,
  NotificationCampaign,
  PreRegistrationResult,
  TransactionRecord,
} from '../types/xpplay.ts';

type CashierMenu =
  | 'dashboard'
  | 'registerCustomer'
  | 'members'
  | 'transactions'
  | 'benefitRequests'
  | 'memberLookup'
  | 'customerActivity'
  | 'notifications'
  | 'profile';

// STRICT 9-MENU CASHIER SIDEBAR (ZERO Admin/Superadmin Menus)
const CASHIER_MENUS: { id: CashierMenu; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'registerCustomer', label: 'Register Customer', icon: UserPlus },
  { id: 'members', label: 'Members', icon: Users },
  { id: 'transactions', label: 'Transactions', icon: CreditCard },
  { id: 'benefitRequests', label: 'Benefit Requests', icon: TicketCheck },
  { id: 'memberLookup', label: 'Member Lookup', icon: Search },
  { id: 'customerActivity', label: 'Customer Activity', icon: Activity },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'profile', label: 'Profile / Logout', icon: UserIcon },
];

export function CashierDashboardPage() {
  const { adminProfile, levels, systemSettings, restoreLock, capabilities, logout } = useAuth();
  const isMaintenance = Boolean(restoreLock?.locked);
  const assignedBranch: BranchId | null = adminProfile ? getEffectiveCashierBranch(adminProfile) : null;

  const [menu, setMenu] = useState<CashierMenu>('dashboard');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Branch-isolated state
  const [members, setMembers] = useState<MemberProfile[]>([]);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [benefitRequests, setBenefitRequests] = useState<BenefitRequestRecord[]>([]);
  const [benefits, setBenefits] = useState<BenefitItem[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationCampaign[]>([]);
  const [metrics, setMetrics] = useState({
    preRegisteredToday: 0,
    totalPreRegisteredBranch: 0,
    transactionsTodayCount: 0,
    transactionsTodayAmount: 0,
    xpDistributedToday: 0,
    pendingBenefitRequests: 0,
    approvedBenefitRequests: 0,
  });

  // Register Customer (Stage 1 Pre-Registration)
  const [preRegWa, setPreRegWa] = useState('');
  const [preRegNotes, setPreRegNotes] = useState('');
  const [preRegResult, setPreRegResult] = useState<PreRegistrationResult | null>(null);
  const [reissuedCodeCard, setReissuedCodeCard] = useState<{
    member: MemberProfile;
    verificationCode: string;
    expiresAt: number;
    onboardingUrl: string;
    whatsappShareMessage: string;
  } | null>(null);

  // Members filters
  const [memberSearch, setMemberSearch] = useState('');
  const [memberStatusFilter, setMemberStatusFilter] = useState<'ALL' | MemberStatus>('ALL');

  // Transactions form (branch locked!)
  const [txIdentifier, setTxIdentifier] = useState('');
  const [txAmount, setTxAmount] = useState('');
  const [txReceipt, setTxReceipt] = useState('');
  const [txNote, setTxNote] = useState('');

  // Assisted Benefit Request form + Queue filters
  const [brqFilter, setBrqFilter] = useState<'ALL' | 'ON_PROCESS' | 'APPROVED' | 'USED' | 'DENIED'>('ON_PROCESS');
  const [assistIdentifier, setAssistIdentifier] = useState('');
  const [assistMember, setAssistMember] = useState<MemberProfile | null>(null);
  const [assistCatalogChoice, setAssistCatalogChoice] = useState('');
  const [assistNote, setAssistNote] = useState('');
  const [denyTarget, setDenyTarget] = useState<BenefitRequestRecord | null>(null);
  const [denyReason, setDenyReason] = useState('');
  const [useReceiptRef, setUseReceiptRef] = useState('');

  // Member Lookup
  const [lookupQuery, setLookupQuery] = useState('');
  const [lookupResult, setLookupResult] = useState<MemberProfile | null>(null);
  const [lookupNotFound, setLookupNotFound] = useState(false);

  const loadData = async () => {
    if (!adminProfile || !assignedBranch) return;
    setLoading(true);
    try {
      const data = await fetchCashierBranchDashboardData(adminProfile);
      setMembers(data.members);
      setTransactions(data.transactions);
      setBenefitRequests(data.benefitRequests);
      setBenefits(data.benefits);
      setCampaigns(data.campaigns);
      setNotifications(data.notifications);
      setMetrics(data.metrics);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [adminProfile?.uid, assignedBranch]);

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1800);
    } catch {
      // Clipboard blocked in restricted iframe
    }
  };

  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    return members.filter((m) => {
      if (memberStatusFilter !== 'ALL' && m.status !== memberStatusFilter) return false;
      if (!q) return true;
      return (
        m.whatsapp.toLowerCase().includes(q) ||
        m.memberId.toLowerCase().includes(q) ||
        m.fullName.toLowerCase().includes(q) ||
        (m.username || '').toLowerCase().includes(q)
      );
    });
  }, [members, memberSearch, memberStatusFilter]);

  const filteredBenefitRequests = useMemo(() => {
    if (brqFilter === 'ALL') return benefitRequests;
    return benefitRequests.filter((r) => r.status === brqFilter);
  }, [benefitRequests, brqFilter]);

  const activityFeed = useMemo(() => {
    const items: { id: string; timestamp: number; kind: 'TRANSACTION' | 'BENEFIT'; title: string; subtitle: string; amountLabel: string }[] = [];
    for (const t of transactions) {
      items.push({
        id: `tx_${t.id}`,
        timestamp: t.createdAt,
        kind: 'TRANSACTION',
        title: `Transaksi ${t.memberUsername ? `@${t.memberUsername}` : t.memberId}`,
        subtitle: `Struk: ${t.receiptNumber || '-'} · ${t.note || 'Pembayaran cabang'}`,
        amountLabel: `${formatIdr(t.amountIdr)} (+${t.xpGenerated} XP)`,
      });
    }
    for (const r of benefitRequests) {
      items.push({
        id: `brq_${r.id}`,
        timestamp: r.updatedAt || r.createdAt,
        kind: 'BENEFIT',
        title: `Benefit ${r.title} (${r.status})`,
        subtitle: `${r.memberName}${r.memberUsername ? ` (@${r.memberUsername})` : ' (PRE_REGISTERED)'} · ${r.id}`,
        amountLabel: r.xpCost > 0 ? `-${r.xpCost} XP` : r.xpRewardGrant > 0 ? `+${r.xpRewardGrant} XP` : 'GRATIS',
      });
    }
    return items.sort((a, b) => b.timestamp - a.timestamp).slice(0, 60);
  }, [transactions, benefitRequests]);

  const txXpPreview = useMemo(() => {
    const amt = Number(txAmount);
    if (!Number.isFinite(amt) || amt <= 0) return 0;
    return calculateTransactionXp(Math.floor(amt), systemSettings.transactionXpRate);
  }, [txAmount, systemSettings.transactionXpRate]);

  if (!adminProfile) return null;

  if (!assignedBranch) {
    return (
      <div className="min-h-screen gaming-canvas text-slate-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-[#0B1124] rounded-2xl border border-rose-500/40 p-6 text-center space-y-4">
          <h1 className="font-display text-xl font-bold text-white">Cabang Kasir Belum Ditetapkan</h1>
          <p className="text-sm text-slate-300">
            Akun Kasir wajib terikat ke 1 cabang tetap (DEMANG atau SEKIP). Hubungi Superadmin untuk menetapkan cabang akun Anda.
          </p>
          <button
            type="button"
            onClick={() => void logout()}
            className="w-full h-[44px] rounded-xl bg-rose-600 text-sm font-semibold text-white"
          >
            Keluar
          </button>
        </div>
      </div>
    );
  }

  const branchLabel = getBranchLabel(assignedBranch);

  const handlePreRegisterSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || isMaintenance) return;
    setBusy(true);
    setFeedback(null);
    setPreRegResult(null);
    setReissuedCodeCard(null);
    try {
      const res = await preRegisterCustomerClient({
        whatsapp: preRegWa.trim(),
        branchId: assignedBranch,
        notes: preRegNotes.trim(),
        actor: adminProfile,
        adminSdkConfigured: capabilities.adminSdkConfigured,
      });
      setPreRegResult(res);
      if (!res.alreadyExists) {
        setPreRegWa('');
        setPreRegNotes('');
        setFeedback({ type: 'success', text: res.message });
        await loadData();
      } else {
        setFeedback({ type: 'error', text: res.message });
      }
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleReissueCode = async (member: MemberProfile) => {
    if (busy || isMaintenance) return;
    setBusy(true);
    setFeedback(null);
    try {
      const issued = await regenerateOnboardingCodeClient({
        member,
        actor: adminProfile,
      });
      setReissuedCodeCard({ member, ...issued });
      setFeedback({
        type: 'success',
        text: `Kode verifikasi 6 digit baru diterbitkan untuk ${member.whatsapp} (${member.memberId}).`,
      });
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleTransactionSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || isMaintenance) return;
    const amt = Math.floor(Number(txAmount));
    if (!txIdentifier.trim() || !Number.isFinite(amt) || amt <= 0) {
      setFeedback({ type: 'error', text: 'Masukkan nomor WhatsApp/Member ID/Username dan nominal transaksi yang valid.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const res = await recordTransactionByAdmin({
        identifier: txIdentifier.trim(),
        amountIdr: amt,
        branch: assignedBranch,
        receiptNumber: txReceipt.trim(),
        note: txNote.trim(),
        admin: adminProfile,
        adminSdkConfigured: capabilities.adminSdkConfigured,
      });
      setTxIdentifier('');
      setTxAmount('');
      setTxReceipt('');
      setTxNote('');
      setFeedback({
        type: 'success',
        text: `Transaksi cabang ${assignedBranch} dicatat (+${res.xpGenerated} XP). Saldo baru: ${res.newProgress} XP Progress · ${res.newReward} XP Reward (${res.newLevel}).`,
      });
      await loadData();
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleLookupCustomer = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!lookupQuery.trim()) return;
    setBusy(true);
    setLookupNotFound(false);
    setLookupResult(null);
    try {
      const found = await findMemberByIdentifierAdmin(lookupQuery.trim());
      if (!found) {
        setLookupNotFound(true);
      } else {
        setLookupResult(found);
      }
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleLookupAssistMember = async () => {
    if (!assistIdentifier.trim()) return;
    setBusy(true);
    setFeedback(null);
    try {
      const found = await findMemberByIdentifierAdmin(assistIdentifier.trim());
      if (!found) {
        setAssistMember(null);
        setFeedback({ type: 'error', text: 'Customer tidak ditemukan. Pastikan sudah Pre-Registered atau Active.' });
      } else {
        setAssistMember(found);
      }
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleAssistedBenefitSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || isMaintenance || !assistMember || !assistCatalogChoice) return;
    const [sourceType, sourceId] = assistCatalogChoice.split('::') as [BenefitRequestSourceType, string];
    if (!sourceType || !sourceId) return;
    setBusy(true);
    setFeedback(null);
    try {
      const created = await submitAssistedBenefitRequestByCashier({
        member: assistMember,
        sourceType,
        sourceId,
        branch: assignedBranch,
        note: assistNote.trim(),
        actor: adminProfile,
        adminSdkConfigured: capabilities.adminSdkConfigured,
      });
      setAssistNote('');
      setAssistCatalogChoice('');
      setFeedback({
        type: 'success',
        text: `Benefit Request ${created.id} (${created.title}) berhasil diajukan untuk ${assistMember.fullName} dengan status ON_PROCESS.`,
      });
      await loadData();
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleApproveBrq = async (req: BenefitRequestRecord) => {
    if (busy || isMaintenance) return;
    setBusy(true);
    setFeedback(null);
    try {
      await reviewBenefitRequestByAdmin({
        requestId: req.id,
        decision: 'APPROVED',
        admin: adminProfile,
        adminSdkConfigured: capabilities.adminSdkConfigured,
      });
      setFeedback({ type: 'success', text: `Benefit Request ${req.id} disetujui (APPROVED · berlaku 7 hari).` });
      await loadData();
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleDenyBrqConfirm = async (e: FormEvent) => {
    e.preventDefault();
    if (!denyTarget || !denyReason.trim() || busy || isMaintenance) return;
    setBusy(true);
    setFeedback(null);
    try {
      await reviewBenefitRequestByAdmin({
        requestId: denyTarget.id,
        decision: 'DENIED',
        reason: denyReason.trim(),
        admin: adminProfile,
        adminSdkConfigured: capabilities.adminSdkConfigured,
      });
      setDenyTarget(null);
      setDenyReason('');
      setFeedback({ type: 'success', text: `Benefit Request ${denyTarget.id} ditolak & XP Hold dikembalikan otomatis.` });
      await loadData();
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleMarkUsed = async (req: BenefitRequestRecord) => {
    if (busy || isMaintenance) return;
    setBusy(true);
    setFeedback(null);
    try {
      await markBenefitRequestUsedByCashier({
        requestId: req.id,
        usedBranch: assignedBranch,
        receiptReference: useReceiptRef.trim(),
        admin: adminProfile,
        adminSdkConfigured: capabilities.adminSdkConfigured,
      });
      setUseReceiptRef('');
      setFeedback({ type: 'success', text: `Voucher ${req.id} (${req.title}) ditandai USED di ${branchLabel}.` });
      await loadData();
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const jumpToTransaction = (member: MemberProfile) => {
    setTxIdentifier(member.whatsapp || member.memberId);
    setMenu('transactions');
  };

  const jumpToAssistBenefit = (member: MemberProfile) => {
    setAssistIdentifier(member.whatsapp || member.memberId);
    setAssistMember(member);
    setMenu('benefitRequests');
  };

  const renderStatusText = (status: MemberStatus) => {
    if (status === 'PRE_REGISTERED') {
      return <span className="font-mono text-xs font-semibold text-amber-300">PRE_REGISTERED · Belum menyelesaikan profil</span>;
    }
    if (status === 'ACTIVE') {
      return <span className="font-mono text-xs font-semibold text-emerald-400">ACTIVE · Membership Aktif</span>;
    }
    return <span className="font-mono text-xs font-semibold text-rose-400">{status}</span>;
  };

  const SidebarContent = (
    <div className="flex flex-col h-full bg-[#090F22] border-r border-indigo-500/20">
      <div className="p-5 border-b border-indigo-500/20 space-y-2">
        <p className="font-display text-lg font-extrabold tracking-tight bg-gradient-to-r from-sky-300 to-purple-300 bg-clip-text text-transparent">
          XP PLAY KASIR
        </p>
        <div className="flex items-center gap-1.5 text-xs font-mono font-semibold text-sky-300">
          <MapPin className="w-3.5 h-3.5 shrink-0" />
          <span>CABANG {assignedBranch}</span>
        </div>
        <p className="text-[11px] text-slate-400 truncate">
          {adminProfile.fullName} {adminProfile.cashierCode ? `· ${adminProfile.cashierCode}` : ''}
        </p>
      </div>

      <nav className="flex-1 overflow-y-auto p-3 space-y-1">
        {CASHIER_MENUS.map((item) => {
          const Icon = item.icon;
          const active = menu === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setMenu(item.id);
                setMobileNavOpen(false);
              }}
              className={`w-full min-h-[42px] px-3.5 rounded-xl text-xs font-semibold flex items-center gap-2.5 transition-colors ${
                active
                  ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-[0_0_20px_-8px_rgba(56,189,248,0.65)]'
                  : 'text-slate-300 hover:bg-[#101936] hover:text-white'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="p-3 border-t border-indigo-500/20">
        <button
          type="button"
          onClick={() => void logout()}
          className="w-full min-h-[40px] rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-200 text-xs font-semibold flex items-center justify-center gap-2 hover:bg-rose-500/20 transition-colors"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>Keluar Kasir</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen gaming-canvas text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 sticky top-0 h-screen">{SidebarContent}</aside>

      {/* Mobile Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="w-64 max-w-[82vw] h-full">{SidebarContent}</div>
          <button
            type="button"
            aria-label="Tutup menu"
            onClick={() => setMobileNavOpen(false)}
            className="flex-1 bg-black/65"
          />
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-30 h-16 px-4 sm:px-6 bg-[#070B19]/90 backdrop-blur-md border-b border-indigo-500/20 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden min-h-[40px] min-w-[40px] rounded-xl border border-indigo-500/30 bg-[#0B1124] flex items-center justify-center text-slate-200"
              aria-label="Buka menu kasir"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <p className="text-[11px] font-mono text-sky-300 uppercase tracking-wider">
                CASHIER OPERATIONAL CONSOLE · {branchLabel}
              </p>
              <h1 className="font-display text-base sm:text-lg font-bold text-white truncate">
                {CASHIER_MENUS.find((m) => m.id === menu)?.label}
              </h1>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void loadData()}
            disabled={loading}
            className="min-h-[38px] px-3 rounded-xl border border-indigo-500/30 bg-[#0B1124] text-xs font-medium text-slate-200 hover:border-sky-400/50 inline-flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Muat Ulang</span>
          </button>
        </header>

        <main className="flex-1 p-4 sm:p-6 max-w-6xl w-full mx-auto space-y-6">
          {isMaintenance && (
            <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-3.5 text-xs text-amber-200">
              Sistem sedang dalam mode pemeliharaan (restore lock). Aksi tulis sementara dinonaktifkan.
            </div>
          )}

          {feedback && (
            <div
              role="alert"
              className={`rounded-xl border px-4 py-3 text-sm flex items-center justify-between gap-3 ${
                feedback.type === 'success'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                  : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
              }`}
            >
              <span>{feedback.text}</span>
              <button type="button" onClick={() => setFeedback(null)} className="text-xs underline shrink-0">
                Tutup
              </button>
            </div>
          )}

          {/* Re-issued 6-digit code banner (available from Members / Lookup / Register Customer) */}
          {reissuedCodeCard && (
            <div className="rounded-2xl border border-sky-400/45 bg-[#0B1124] p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-mono font-semibold text-sky-300 uppercase">
                    Kode Verifikasi 6 Digit Baru · {reissuedCodeCard.member.memberId}
                  </p>
                  <p className="text-sm text-slate-300 mt-0.5">
                    Nomor WhatsApp: <strong className="font-mono text-white">{reissuedCodeCard.member.whatsapp}</strong>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setReissuedCodeCard(null)}
                  className="text-slate-400 hover:text-white"
                  aria-label="Tutup kartu kode"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <div className="rounded-xl bg-[#070B19] border border-sky-400/40 px-5 py-3">
                  <p className="text-[11px] text-slate-400">Kode Verifikasi</p>
                  <p className="font-mono text-3xl font-extrabold tracking-[0.25em] text-sky-300 tabular-nums">
                    {reissuedCodeCard.verificationCode}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void copyText('re_code', reissuedCodeCard.verificationCode)}
                    className="min-h-[40px] px-3.5 rounded-xl bg-sky-500 text-slate-950 font-bold text-xs inline-flex items-center gap-1.5"
                  >
                    {copiedKey === 're_code' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedKey === 're_code' ? 'Kode Disalin' : 'Salin Kode'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void copyText('re_link', reissuedCodeCard.onboardingUrl)}
                    className="min-h-[40px] px-3.5 rounded-xl border border-indigo-500/35 bg-[#070B19] text-xs font-semibold text-sky-200 inline-flex items-center gap-1.5"
                  >
                    {copiedKey === 're_link' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedKey === 're_link' ? 'Link Disalin' : 'Salin Link'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void copyText('re_wa', reissuedCodeCard.whatsappShareMessage)}
                    className="min-h-[40px] px-3.5 rounded-xl border border-emerald-500/35 bg-emerald-500/10 text-xs font-semibold text-emerald-200 inline-flex items-center gap-1.5"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    <span>{copiedKey === 're_wa' ? 'Pesan WA Disalin' : 'Salin Pesan WhatsApp'}</span>
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-slate-400">
                Berlaku hingga {formatJakartaDateTime(reissuedCodeCard.expiresAt)} (maks 5 kali percobaan).
              </p>
            </div>
          )}

          {/* 1. DASHBOARD */}
          {menu === 'dashboard' && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/25 p-5">
                  <p className="text-xs text-slate-400">Pre-Registered Hari Ini ({assignedBranch})</p>
                  <p className="mt-2 font-mono text-3xl font-extrabold text-amber-300 tabular-nums">
                    {metrics.preRegisteredToday}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    Total belum lengkap cabang: <span className="font-mono text-white">{metrics.totalPreRegisteredBranch}</span>
                  </p>
                </div>

                <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/25 p-5">
                  <p className="text-xs text-slate-400">Transaksi Hari Ini ({assignedBranch})</p>
                  <p className="mt-2 font-mono text-3xl font-extrabold text-sky-300 tabular-nums">
                    {metrics.transactionsTodayCount}
                  </p>
                  <p className="mt-1 text-xs text-slate-400 font-mono tabular-nums">
                    {formatIdr(metrics.transactionsTodayAmount)} · +{metrics.xpDistributedToday} XP
                  </p>
                </div>

                <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/25 p-5 col-span-2 lg:col-span-1">
                  <p className="text-xs text-slate-400">Benefit Requests ({assignedBranch})</p>
                  <p className="mt-2 font-mono text-3xl font-extrabold text-emerald-400 tabular-nums">
                    {metrics.pendingBenefitRequests}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    Menunggu Review · <span className="text-sky-300 font-mono">{metrics.approvedBenefitRequests}</span> Siap Dipakai
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <button
                  type="button"
                  onClick={() => setMenu('registerCustomer')}
                  className="min-h-[54px] rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-4 text-sm font-bold text-white flex items-center justify-center gap-2 hover:from-blue-500 hover:to-purple-500 transition-all"
                >
                  <UserPlus className="w-4 h-4" />
                  <span>+ Pre-Register Customer</span>
                </button>
                <button
                  type="button"
                  onClick={() => setMenu('transactions')}
                  className="min-h-[54px] rounded-xl border border-sky-400/40 bg-[#0B1124] px-4 text-sm font-bold text-sky-200 flex items-center justify-center gap-2 hover:bg-[#101936] transition-colors"
                >
                  <CreditCard className="w-4 h-4" />
                  <span>+ Input Transaksi ({assignedBranch})</span>
                </button>
                <button
                  type="button"
                  onClick={() => setMenu('memberLookup')}
                  className="min-h-[54px] rounded-xl border border-indigo-500/35 bg-[#0B1124] px-4 text-sm font-bold text-slate-100 flex items-center justify-center gap-2 hover:bg-[#101936] transition-colors"
                >
                  <Search className="w-4 h-4" />
                  <span>Cari Member / Voucher</span>
                </button>
              </div>

              <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/25 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="font-display text-base font-bold text-white">
                    Transaksi Terbaru — {branchLabel}
                  </h2>
                  <button
                    type="button"
                    onClick={() => setMenu('transactions')}
                    className="text-xs font-semibold text-sky-300 hover:underline"
                  >
                    Lihat Semua
                  </button>
                </div>
                {transactions.length === 0 ? (
                  <p className="text-sm text-slate-400">Belum ada transaksi tercatat di cabang {assignedBranch}.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-indigo-500/20 text-slate-400">
                        <tr>
                          <th className="py-2 pr-3">Waktu</th>
                          <th className="py-2 pr-3">Customer</th>
                          <th className="py-2 pr-3">Nominal</th>
                          <th className="py-2 pr-3">XP</th>
                          <th className="py-2">Struk</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-indigo-500/15">
                        {transactions.slice(0, 8).map((tx) => (
                          <tr key={tx.id}>
                            <td className="py-2.5 pr-3 text-slate-400 whitespace-nowrap">
                              {formatJakartaDateTime(tx.createdAt)}
                            </td>
                            <td className="py-2.5 pr-3 font-mono text-white">
                              {tx.memberUsername ? `@${tx.memberUsername}` : tx.memberId}
                            </td>
                            <td className="py-2.5 pr-3 font-mono tabular-nums text-slate-200">
                              {formatIdr(tx.amountIdr)}
                            </td>
                            <td className="py-2.5 pr-3 font-mono font-bold text-emerald-400">
                              +{tx.xpGenerated} XP
                            </td>
                            <td className="py-2.5 font-mono text-slate-400">{tx.receiptNumber || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 2. REGISTER CUSTOMER (STAGE 1 PRE-REGISTRATION) */}
          {menu === 'registerCustomer' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/25 p-6 space-y-5">
                <div>
                  <p className="text-xs font-mono font-semibold text-sky-300 uppercase">
                    Tahap 1 · Pre-Registration di Kasir
                  </p>
                  <h2 className="mt-1 font-display text-xl font-extrabold text-white">
                    Daftarkan Customer Baru (WhatsApp)
                  </h2>
                  <p className="mt-1 text-xs text-slate-300 leading-relaxed">
                    Kasir hanya memasukkan nomor WhatsApp customer. Status awal menjadi{' '}
                    <strong className="text-amber-300">PRE_REGISTERED</strong> (0 XP, tanpa bonus 10 XP). Customer
                    tetap bisa transaksi &amp; kumpulkan XP sekarang, lalu melengkapi profil online untuk bonus +10 XP.
                  </p>
                </div>

                <form onSubmit={handlePreRegisterSubmit} className="space-y-4">
                  <div className="rounded-xl bg-[#070B19] border border-indigo-500/25 px-3.5 py-2.5 flex items-center justify-between text-xs">
                    <span className="text-slate-400 flex items-center gap-1.5">
                      <Lock className="w-3.5 h-3.5 text-sky-300" />
                      <span>Cabang Pendaftaran (Terkunci)</span>
                    </span>
                    <span className="font-mono font-bold text-sky-300">{branchLabel}</span>
                  </div>

                  <div>
                    <label htmlFor="cashier-prereg-wa" className="block text-xs font-medium text-slate-300 mb-1.5">
                      Nomor WhatsApp Customer *
                    </label>
                    <div className="relative">
                      <Phone className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        id="cashier-prereg-wa"
                        type="tel"
                        required
                        value={preRegWa}
                        onChange={(e) => setPreRegWa(e.target.value)}
                        placeholder="Contoh: 081234567890"
                        className="w-full h-[46px] rounded-xl border border-indigo-500/30 bg-[#070B19] pl-10 pr-3.5 text-sm font-mono text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="cashier-prereg-notes" className="block text-xs font-medium text-slate-300 mb-1.5">
                      Catatan Kasir (Opsional)
                    </label>
                    <input
                      id="cashier-prereg-notes"
                      type="text"
                      maxLength={200}
                      value={preRegNotes}
                      onChange={(e) => setPreRegNotes(e.target.value)}
                      placeholder="Contoh: Main PS5 room 3, referral teman"
                      className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={busy || isMaintenance}
                    className="w-full h-[48px] inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-4 text-sm font-bold text-white hover:from-blue-500 hover:to-purple-500 disabled:opacity-50"
                  >
                    <UserPlus className="w-4 h-4" />
                    <span>{busy ? 'Mendaftarkan...' : 'Pre-Register Customer'}</span>
                  </button>
                </form>
              </div>

              {/* Result / Duplicate Card */}
              <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/25 p-6 space-y-4">
                <h3 className="font-display text-base font-bold text-white">
                  Hasil Pre-Registration &amp; Kode Verifikasi
                </h3>

                {!preRegResult ? (
                  <div className="rounded-xl border border-dashed border-indigo-500/30 bg-[#070B19] p-6 text-center space-y-2">
                    <KeyRound className="w-8 h-8 text-slate-500 mx-auto" />
                    <p className="text-sm text-slate-300">
                      Setelah Pre-Register berhasil, kode verifikasi 6 digit &amp; tautan pendaftaran online akan tampil di sini.
                    </p>
                  </div>
                ) : preRegResult.alreadyExists ? (
                  <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-4 space-y-3">
                    <p className="text-xs font-mono font-bold text-amber-300 uppercase">
                      Nomor WhatsApp Sudah Terdaftar
                    </p>
                    <p className="text-sm text-white">{preRegResult.message}</p>
                    <div className="rounded-lg bg-[#070B19] p-3 text-xs space-y-1">
                      <p className="text-slate-300">
                        Member ID: <strong className="font-mono text-white">{preRegResult.member.memberId}</strong>
                      </p>
                      <p className="text-slate-300">
                        Status: {renderStatusText(preRegResult.member.status)}
                      </p>
                      <p className="text-slate-300">
                        XP Progress / Reward:{' '}
                        <strong className="font-mono text-sky-300">
                          {preRegResult.member.xpProgress} / {preRegResult.member.xpReward} XP
                        </strong>
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => jumpToTransaction(preRegResult.member)}
                        className="min-h-[38px] px-3.5 rounded-lg bg-sky-500 text-slate-950 font-bold text-xs"
                      >
                        Input Transaksi Customer Ini
                      </button>
                      {preRegResult.member.status === 'PRE_REGISTERED' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleReissueCode(preRegResult.member)}
                          className="min-h-[38px] px-3.5 rounded-lg border border-sky-400/40 text-sky-200 font-semibold text-xs"
                        >
                          Buat Ulang Kode 6 Digit
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 space-y-1">
                      <p className="text-xs font-mono font-bold text-emerald-300 flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>PRE-REGISTRATION BERHASIL · {preRegResult.member.memberId}</span>
                      </p>
                      <p className="text-xs text-slate-200">
                        WhatsApp: <strong className="font-mono">{preRegResult.member.whatsapp}</strong> · Cabang:{' '}
                        <strong className="font-mono">{assignedBranch}</strong> · XP Awal: <strong className="font-mono">0 XP</strong>
                      </p>
                    </div>

                    {preRegResult.verificationCode && (
                      <div className="rounded-xl bg-[#070B19] border border-sky-400/45 p-5 text-center space-y-2">
                        <p className="text-xs text-slate-400 uppercase tracking-wider">
                          Kode Verifikasi 6 Digit Sekali Pakai
                        </p>
                        <p className="font-mono text-4xl font-extrabold tracking-[0.3em] text-sky-300 tabular-nums">
                          {preRegResult.verificationCode}
                        </p>
                        {preRegResult.verificationExpiresAt && (
                          <p className="text-[11px] text-slate-400">
                            Berlaku hingga {formatJakartaDateTime(preRegResult.verificationExpiresAt)}
                          </p>
                        )}
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      {preRegResult.verificationCode && (
                        <button
                          type="button"
                          onClick={() => void copyText('code', preRegResult.verificationCode!)}
                          className="min-h-[42px] rounded-xl bg-sky-500 text-slate-950 font-bold text-xs inline-flex items-center justify-center gap-1.5"
                        >
                          {copiedKey === 'code' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                          <span>{copiedKey === 'code' ? 'Disalin' : 'Salin Kode'}</span>
                        </button>
                      )}
                      {preRegResult.onboardingUrl && (
                        <button
                          type="button"
                          onClick={() => void copyText('url', preRegResult.onboardingUrl!)}
                          className="min-h-[42px] rounded-xl border border-indigo-500/35 bg-[#070B19] text-sky-200 font-semibold text-xs inline-flex items-center justify-center gap-1.5"
                        >
                          {copiedKey === 'url' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                          <span>{copiedKey === 'url' ? 'Link Disalin' : 'Salin Link'}</span>
                        </button>
                      )}
                      {preRegResult.whatsappShareMessage && (
                        <button
                          type="button"
                          onClick={() => void copyText('wa', preRegResult.whatsappShareMessage!)}
                          className="min-h-[42px] rounded-xl border border-emerald-500/35 bg-emerald-500/10 text-emerald-200 font-semibold text-xs inline-flex items-center justify-center gap-1.5"
                        >
                          <MessageSquare className="w-3.5 h-3.5" />
                          <span>{copiedKey === 'wa' ? 'WA Disalin' : 'Salin Pesan WA'}</span>
                        </button>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => jumpToTransaction(preRegResult.member)}
                      className="w-full min-h-[42px] rounded-xl border border-sky-400/35 text-sky-200 text-xs font-semibold hover:bg-[#101936]"
                    >
                      Langsung Input Transaksi untuk Customer Ini →
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 3. MEMBERS (BRANCH-SCOPED, OPERATIONAL ACTIONS ONLY) */}
          {menu === 'members' && (
            <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/25 p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-display text-lg font-bold text-white">
                    Daftar Member — {branchLabel}
                  </h2>
                  <p className="text-xs text-slate-400">
                    Menampilkan member cabang {assignedBranch} (PRE_REGISTERED &amp; ACTIVE). Kasir hanya memiliki akses operasional transaksi, benefit, dan kode verifikasi.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setMenu('registerCustomer')}
                  className="min-h-[40px] px-3.5 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-xs font-semibold text-white inline-flex items-center gap-1.5"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  <span>Pre-Register Baru</span>
                </button>
              </div>

              <div className="flex flex-wrap gap-3">
                <input
                  type="text"
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  placeholder="Cari WhatsApp, Member ID, Nama, Username..."
                  className="flex-1 min-w-[220px] h-[42px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
                />
                <select
                  value={memberStatusFilter}
                  onChange={(e) => setMemberStatusFilter(e.target.value as 'ALL' | MemberStatus)}
                  className="h-[42px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-xs font-medium text-white"
                >
                  <option value="ALL">Semua Status</option>
                  <option value="PRE_REGISTERED">PRE_REGISTERED (Belum Lengkap)</option>
                  <option value="ACTIVE">ACTIVE (Aktif)</option>
                  <option value="SUSPENDED">SUSPENDED</option>
                </select>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-indigo-500/20 text-slate-400">
                    <tr>
                      <th className="py-2.5 pr-3">Member</th>
                      <th className="py-2.5 pr-3">WhatsApp</th>
                      <th className="py-2.5 pr-3">Status</th>
                      <th className="py-2.5 pr-3">XP / Level</th>
                      <th className="py-2.5 text-right">Aksi Kasir</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-indigo-500/15">
                    {filteredMembers.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-slate-400">
                          Tidak ada member yang cocok dengan filter cabang {assignedBranch}.
                        </td>
                      </tr>
                    ) : (
                      filteredMembers.slice(0, 80).map((m) => (
                        <tr key={m.uid} className="hover:bg-[#0F1733]/60">
                          <td className="py-3 pr-3">
                            <p className="font-semibold text-white">{m.fullName}</p>
                            <p className="font-mono text-[11px] text-slate-400">
                              {m.memberId} {m.username ? `· @${m.username}` : '· (Belum punya username)'}
                            </p>
                          </td>
                          <td className="py-3 pr-3 font-mono text-sky-300">{m.whatsapp}</td>
                          <td className="py-3 pr-3">{renderStatusText(m.status)}</td>
                          <td className="py-3 pr-3 font-mono tabular-nums">
                            <span className="text-sky-300">{m.xpProgress}</span> /{' '}
                            <span className="text-purple-300">{m.xpReward} XP</span>
                            <span className="block text-[11px] text-slate-400">
                              {resolveEffectiveMemberLevel(m, levels).id}
                            </span>
                          </td>
                          <td className="py-3 text-right">
                            <div className="inline-flex flex-wrap justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => jumpToTransaction(m)}
                                className="px-2.5 py-1.5 rounded-lg bg-sky-500/15 border border-sky-400/35 text-sky-200 font-semibold hover:bg-sky-500/25"
                              >
                                Transaksi
                              </button>
                              <button
                                type="button"
                                onClick={() => jumpToAssistBenefit(m)}
                                className="px-2.5 py-1.5 rounded-lg bg-purple-500/15 border border-purple-400/35 text-purple-200 font-semibold hover:bg-purple-500/25"
                              >
                                Benefit
                              </button>
                              {m.status === 'PRE_REGISTERED' && (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void handleReissueCode(m)}
                                  className="px-2.5 py-1.5 rounded-lg bg-amber-500/15 border border-amber-400/35 text-amber-200 font-semibold hover:bg-amber-500/25"
                                >
                                  Kode Baru
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
            </div>
          )}

          {/* 4. TRANSACTIONS (BRANCH-LOCKED) */}
          {menu === 'transactions' && (
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              <div className="lg:col-span-2 rounded-2xl bg-[#0B1124] border border-indigo-500/25 p-5 space-y-4">
                <div>
                  <h2 className="font-display text-lg font-bold text-white">Input Transaksi XP</h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Berlaku untuk member <strong>PRE_REGISTERED</strong> maupun <strong>ACTIVE</strong>. Rate:{' '}
                    <span className="font-mono text-sky-300">
                      Rp{systemSettings.transactionXpRate.toLocaleString('id-ID')} = 1 XP
                    </span>
                  </p>
                </div>

                <form onSubmit={handleTransactionSubmit} className="space-y-3.5">
                  <div className="rounded-xl bg-[#070B19] border border-indigo-500/25 px-3.5 py-2.5 flex items-center justify-between text-xs">
                    <span className="text-slate-400 flex items-center gap-1.5">
                      <Lock className="w-3.5 h-3.5 text-sky-300" />
                      <span>Cabang Transaksi</span>
                    </span>
                    <span className="font-mono font-bold text-sky-300">{branchLabel}</span>
                  </div>

                  <div>
                    <label htmlFor="ctx-id" className="block text-xs font-medium text-slate-300 mb-1">
                      WhatsApp / Member ID / Username *
                    </label>
                    <input
                      id="ctx-id"
                      type="text"
                      required
                      value={txIdentifier}
                      onChange={(e) => setTxIdentifier(e.target.value)}
                      placeholder="0812xxx / XPP-XXXX / username"
                      className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm font-mono text-white"
                    />
                  </div>

                  <div>
                    <label htmlFor="ctx-amt" className="block text-xs font-medium text-slate-300 mb-1">
                      Nominal Transaksi (IDR) *
                    </label>
                    <input
                      id="ctx-amt"
                      type="number"
                      min={1000}
                      step={500}
                      required
                      value={txAmount}
                      onChange={(e) => setTxAmount(e.target.value)}
                      placeholder="Contoh: 50000"
                      className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm font-mono text-white tabular-nums"
                    />
                    <p className="mt-1 text-xs text-emerald-300 font-mono">
                      Estimasi XP: +{txXpPreview} XP Progress &amp; +{txXpPreview} XP Reward
                    </p>
                  </div>

                  <div>
                    <label htmlFor="ctx-receipt" className="block text-xs font-medium text-slate-300 mb-1">
                      Nomor Struk / Invoice
                    </label>
                    <input
                      id="ctx-receipt"
                      type="text"
                      value={txReceipt}
                      onChange={(e) => setTxReceipt(e.target.value)}
                      placeholder="INV-..."
                      className="w-full h-[42px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm font-mono text-white"
                    />
                  </div>

                  <div>
                    <label htmlFor="ctx-note" className="block text-xs font-medium text-slate-300 mb-1">
                      Catatan
                    </label>
                    <input
                      id="ctx-note"
                      type="text"
                      value={txNote}
                      onChange={(e) => setTxNote(e.target.value)}
                      placeholder="Billing PS5 2 jam"
                      className="w-full h-[42px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={busy || isMaintenance}
                    className="w-full h-[46px] rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 text-sm font-bold text-white disabled:opacity-50"
                  >
                    {busy ? 'Menyimpan...' : `Catat Transaksi (${assignedBranch})`}
                  </button>
                </form>
              </div>

              <div className="lg:col-span-3 rounded-2xl bg-[#0B1124] border border-indigo-500/25 p-5 space-y-4">
                <h2 className="font-display text-lg font-bold text-white">
                  Riwayat Transaksi Cabang {assignedBranch}
                </h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-indigo-500/20 text-slate-400">
                      <tr>
                        <th className="py-2 pr-3">Waktu</th>
                        <th className="py-2 pr-3">Customer</th>
                        <th className="py-2 pr-3">Nominal</th>
                        <th className="py-2 pr-3">XP</th>
                        <th className="py-2">Struk</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-indigo-500/15">
                      {transactions.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-slate-400">
                            Belum ada transaksi di cabang {assignedBranch}.
                          </td>
                        </tr>
                      ) : (
                        transactions.map((t) => (
                          <tr key={t.id}>
                            <td className="py-2.5 pr-3 text-slate-400 whitespace-nowrap">
                              {formatJakartaDateTime(t.createdAt)}
                            </td>
                            <td className="py-2.5 pr-3 font-mono text-white">
                              {t.memberUsername ? `@${t.memberUsername}` : t.memberId}
                            </td>
                            <td className="py-2.5 pr-3 font-mono tabular-nums">{formatIdr(t.amountIdr)}</td>
                            <td className="py-2.5 pr-3 font-mono font-bold text-emerald-400">
                              +{t.xpGenerated} XP
                            </td>
                            <td className="py-2.5 font-mono text-slate-400">{t.receiptNumber || '-'}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* 5. BENEFIT REQUESTS (ASSISTED + BRANCH QUEUE) */}
          {menu === 'benefitRequests' && (
            <div className="space-y-6">
              {/* Assisted Benefit Request Form for PRE_REGISTERED & ACTIVE customers */}
              <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/25 p-5 space-y-4">
                <div>
                  <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
                    <Gift className="w-4 h-4 text-purple-300" />
                    <span>Ajukan Benefit Atas Nama Customer (Termasuk PRE_REGISTERED)</span>
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Mengikuti aturan standar XP Hold → ON_PROCESS → APPROVED → USED (tanpa edit XP manual).
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <input
                    type="text"
                    value={assistIdentifier}
                    onChange={(e) => setAssistIdentifier(e.target.value)}
                    placeholder="Cari WhatsApp / Member ID / Username customer..."
                    className="flex-1 min-w-[220px] h-[42px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm font-mono text-white"
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleLookupAssistMember()}
                    className="h-[42px] px-4 rounded-xl bg-sky-500 text-slate-950 font-bold text-xs"
                  >
                    Cari Customer
                  </button>
                </div>

                {assistMember && (
                  <form onSubmit={handleAssistedBenefitSubmit} className="space-y-3 pt-2 border-t border-indigo-500/20">
                    <div className="rounded-xl bg-[#070B19] border border-indigo-500/25 p-3.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div>
                        <p className="font-semibold text-white">
                          {assistMember.fullName}{' '}
                          <span className="font-mono text-sky-300">({assistMember.whatsapp})</span>
                        </p>
                        <p className="mt-0.5">{renderStatusText(assistMember.status)}</p>
                      </div>
                      <div className="font-mono text-right">
                        <p className="text-purple-300 font-bold">XP Reward: {assistMember.xpReward} XP</p>
                        <p className="text-slate-400">
                          Level: {resolveEffectiveMemberLevel(assistMember, levels).id} · Hold:{' '}
                          {assistMember.reservedXp ?? 0} XP
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <select
                        required
                        value={assistCatalogChoice}
                        onChange={(e) => setAssistCatalogChoice(e.target.value)}
                        className="h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-xs text-white"
                      >
                        <option value="">-- Pilih Benefit / Program Aktif --</option>
                        {benefits.map((b) => (
                          <option
                            key={b.id}
                            value={`${b.xpCost > 0 ? 'GENERAL_BENEFIT' : 'LEVEL_BENEFIT'}::${b.id}`}
                          >
                            [BENEFIT] {b.name} ({b.xpCost > 0 ? `${b.xpCost} XP` : 'GRATIS'} · Min {b.levelRequirement})
                          </option>
                        ))}
                        {campaigns.map((c) => (
                          <option key={c.id} value={`${c.type}::${c.id}`}>
                            [{c.type}] {c.title} (+{c.xpReward} XP)
                          </option>
                        ))}
                      </select>

                      <input
                        type="text"
                        value={assistNote}
                        onChange={(e) => setAssistNote(e.target.value)}
                        placeholder="Catatan kasir (opsional)"
                        className="h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-xs text-white"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={busy || isMaintenance || !assistCatalogChoice}
                      className="h-[42px] px-5 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-xs font-bold text-white disabled:opacity-50"
                    >
                      {busy ? 'Mengajukan...' : `Submit Benefit Request (${assignedBranch})`}
                    </button>
                  </form>
                )}
              </div>

              {/* Branch Queue */}
              <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/25 p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="font-display text-base font-bold text-white">
                    Antrean Benefit Requests — {branchLabel}
                  </h2>
                  <div className="flex flex-wrap gap-1.5">
                    {(['ON_PROCESS', 'APPROVED', 'USED', 'DENIED', 'ALL'] as const).map((st) => (
                      <button
                        key={st}
                        type="button"
                        onClick={() => setBrqFilter(st)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                          brqFilter === st
                            ? 'bg-sky-500 text-slate-950'
                            : 'bg-[#070B19] text-slate-300 border border-indigo-500/25'
                        }`}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>

                {brqFilter === 'APPROVED' && (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={useReceiptRef}
                      onChange={(e) => setUseReceiptRef(e.target.value)}
                      placeholder="No. Struk / Ref Penggunaan Voucher (opsional)"
                      className="flex-1 max-w-sm h-[40px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-xs font-mono text-white"
                    />
                  </div>
                )}

                {filteredBenefitRequests.length === 0 ? (
                  <p className="text-sm text-slate-400">Tidak ada Benefit Request pada filter ini.</p>
                ) : (
                  <div className="space-y-3">
                    {filteredBenefitRequests.map((r) => {
                      const expired = isBenefitRequestEffectivelyExpired(r);
                      return (
                        <div
                          key={r.id}
                          className="rounded-xl bg-[#070B19] border border-indigo-500/25 p-4 flex flex-wrap items-center justify-between gap-4"
                        >
                          <div className="space-y-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="font-mono font-bold text-sky-300">{r.id}</span>
                              <span className="font-mono text-slate-400">· {r.sourceType}</span>
                              <span className="font-mono font-bold text-amber-300">
                                {expired ? 'EXPIRED' : r.status}
                              </span>
                            </div>
                            <p className="text-sm font-bold text-white">{r.title}</p>
                            <p className="text-xs text-slate-300">
                              {r.memberName}{' '}
                              <span className="font-mono text-slate-400">
                                {r.memberUsername ? `@${r.memberUsername}` : '(PRE_REGISTERED)'} · {r.memberWhatsapp}
                              </span>
                            </p>
                            <p className="text-[11px] text-slate-400">
                              {r.xpCost > 0 ? `XP Hold: ${r.xpCost} XP` : `Reward: +${r.xpRewardGrant} XP`} ·{' '}
                              {formatJakartaDateTime(r.createdAt)}
                              {r.status === 'APPROVED' && r.expiresAt ? ` · ${getBenefitRemainingDaysLabel(r.expiresAt)}` : ''}
                            </p>
                          </div>

                          <div className="flex flex-wrap gap-2 shrink-0">
                            {r.status === 'ON_PROCESS' && (
                              <>
                                <button
                                  type="button"
                                  disabled={busy || isMaintenance}
                                  onClick={() => void handleApproveBrq(r)}
                                  className="min-h-[38px] px-3.5 rounded-lg bg-emerald-500 text-slate-950 font-bold text-xs inline-flex items-center gap-1"
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                  <span>Approve</span>
                                </button>
                                <button
                                  type="button"
                                  disabled={busy || isMaintenance}
                                  onClick={() => {
                                    setDenyTarget(r);
                                    setDenyReason('');
                                  }}
                                  className="min-h-[38px] px-3.5 rounded-lg border border-rose-500/40 text-rose-300 font-semibold text-xs inline-flex items-center gap-1"
                                >
                                  <XCircle className="w-3.5 h-3.5" />
                                  <span>Deny</span>
                                </button>
                              </>
                            )}
                            {r.status === 'APPROVED' && !expired && (
                              <button
                                type="button"
                                disabled={busy || isMaintenance}
                                onClick={() => void handleMarkUsed(r)}
                                className="min-h-[38px] px-4 rounded-lg bg-sky-500 text-slate-950 font-bold text-xs"
                              >
                                Tandai USED ({assignedBranch})
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Deny Modal */}
              {denyTarget && (
                <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
                  <form
                    onSubmit={handleDenyBrqConfirm}
                    className="max-w-md w-full rounded-2xl bg-[#0B1124] border border-rose-500/40 p-6 space-y-4"
                  >
                    <h3 className="font-display text-lg font-bold text-white">Tolak Benefit Request</h3>
                    <p className="text-xs text-slate-300">
                      Menolak <strong>{denyTarget.title}</strong> ({denyTarget.id}) akan mengembalikan{' '}
                      <strong className="font-mono text-emerald-300">{denyTarget.xpCost} XP</strong> secara otomatis.
                    </p>
                    <input
                      type="text"
                      required
                      value={denyReason}
                      onChange={(e) => setDenyReason(e.target.value)}
                      placeholder="Alasan penolakan wajib diisi..."
                      className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setDenyTarget(null)}
                        className="h-[40px] px-4 rounded-xl border border-indigo-500/30 text-xs text-slate-300"
                      >
                        Batal
                      </button>
                      <button
                        type="submit"
                        disabled={busy || !denyReason.trim()}
                        className="h-[40px] px-4 rounded-xl bg-rose-600 text-xs font-bold text-white"
                      >
                        Tolak &amp; Refund XP
                      </button>
                    </div>
                  </form>
                </div>
              )}
            </div>
          )}

          {/* 6. MEMBER LOOKUP */}
          {menu === 'memberLookup' && (
            <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/25 p-6 space-y-5">
              <div>
                <h2 className="font-display text-lg font-bold text-white">Member Lookup Cepat</h2>
                <p className="text-xs text-slate-400">
                  Cari berdasarkan Nomor WhatsApp, Member ID (XPP-...), atau Username untuk mengecek status &amp; saldo XP.
                </p>
              </div>

              <form onSubmit={handleLookupCustomer} className="flex flex-wrap gap-2">
                <input
                  type="text"
                  required
                  value={lookupQuery}
                  onChange={(e) => setLookupQuery(e.target.value)}
                  placeholder="Contoh: 081234567890 / XPP-123456 / username"
                  className="flex-1 min-w-[240px] h-[46px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-4 text-sm font-mono text-white"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="h-[46px] px-5 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-sm font-bold text-white"
                >
                  {busy ? 'Mencari...' : 'Cari Member'}
                </button>
              </form>

              {lookupNotFound && (
                <div className="rounded-xl border border-amber-400/35 bg-amber-500/10 p-4 text-sm text-amber-200 flex flex-wrap items-center justify-between gap-3">
                  <span>Customer belum terdaftar di sistem XP PLAY.</span>
                  <button
                    type="button"
                    onClick={() => {
                      setPreRegWa(lookupQuery.trim());
                      setMenu('registerCustomer');
                    }}
                    className="px-3.5 py-2 rounded-lg bg-amber-400 text-slate-950 font-bold text-xs"
                  >
                    Pre-Register Nomor Ini →
                  </button>
                </div>
              )}

              {lookupResult && (
                <div className="rounded-xl bg-[#070B19] border border-sky-400/35 p-5 space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="font-mono text-xs text-sky-300">{lookupResult.memberId}</p>
                      <h3 className="font-display text-xl font-bold text-white mt-0.5">
                        {lookupResult.fullName}
                      </h3>
                      <p className="text-xs font-mono text-slate-300 mt-1">
                        WA: {lookupResult.whatsapp} · {lookupResult.username ? `@${lookupResult.username}` : 'Belum ada username'}
                      </p>
                      <div className="mt-2">{renderStatusText(lookupResult.status)}</div>
                    </div>

                    <div className="grid grid-cols-3 gap-2.5 text-center">
                      <div className="rounded-xl bg-[#0B1124] border border-indigo-500/25 px-3.5 py-2.5">
                        <p className="text-[10px] text-slate-400">XP PROGRESS</p>
                        <p className="font-mono text-lg font-extrabold text-sky-300 tabular-nums">
                          {lookupResult.xpProgress}
                        </p>
                      </div>
                      <div className="rounded-xl bg-[#0B1124] border border-indigo-500/25 px-3.5 py-2.5">
                        <p className="text-[10px] text-slate-400">XP REWARD</p>
                        <p className="font-mono text-lg font-extrabold text-purple-300 tabular-nums">
                          {lookupResult.xpReward}
                        </p>
                      </div>
                      <div className="rounded-xl bg-[#0B1124] border border-indigo-500/25 px-3.5 py-2.5">
                        <p className="text-[10px] text-slate-400">LEVEL</p>
                        <p className="font-mono text-lg font-extrabold text-emerald-300">
                          {resolveEffectiveMemberLevel(lookupResult, levels).id}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 pt-2 border-t border-indigo-500/20">
                    <button
                      type="button"
                      onClick={() => jumpToTransaction(lookupResult)}
                      className="min-h-[40px] px-4 rounded-xl bg-sky-500 text-slate-950 font-bold text-xs"
                    >
                      + Input Transaksi
                    </button>
                    <button
                      type="button"
                      onClick={() => jumpToAssistBenefit(lookupResult)}
                      className="min-h-[40px] px-4 rounded-xl bg-purple-600 text-white font-bold text-xs"
                    >
                      + Ajukan Benefit
                    </button>
                    {lookupResult.status === 'PRE_REGISTERED' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleReissueCode(lookupResult)}
                        className="min-h-[40px] px-4 rounded-xl border border-amber-400/40 text-amber-200 font-semibold text-xs"
                      >
                        Buat Ulang Kode Verifikasi 6 Digit
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 7. CUSTOMER ACTIVITY */}
          {menu === 'customerActivity' && (
            <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/25 p-5 space-y-4">
              <h2 className="font-display text-lg font-bold text-white">
                Aktivitas Customer — {branchLabel}
              </h2>
              {activityFeed.length === 0 ? (
                <p className="text-sm text-slate-400">Belum ada aktivitas customer di cabang {assignedBranch}.</p>
              ) : (
                <div className="divide-y divide-indigo-500/15">
                  {activityFeed.map((item) => (
                    <div key={item.id} className="py-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div>
                        <p className="font-semibold text-white">{item.title}</p>
                        <p className="text-slate-400 mt-0.5">{item.subtitle}</p>
                      </div>
                      <div className="text-right font-mono">
                        <p className={item.kind === 'TRANSACTION' ? 'text-emerald-400 font-bold' : 'text-sky-300 font-bold'}>
                          {item.amountLabel}
                        </p>
                        <p className="text-[11px] text-slate-500">{formatJakartaDateTime(item.timestamp)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 8. NOTIFICATIONS */}
          {menu === 'notifications' && (
            <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/25 p-5 space-y-4">
              <h2 className="font-display text-lg font-bold text-white">
                Notifikasi Operasional — {branchLabel}
              </h2>
              {notifications.length === 0 ? (
                <p className="text-sm text-slate-400">Belum ada notifikasi operasional untuk cabang ini.</p>
              ) : (
                <div className="space-y-2.5">
                  {notifications.map((n) => (
                    <div key={n.id} className="rounded-xl bg-[#070B19] border border-indigo-500/20 p-4 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-bold text-sky-300">{n.title}</p>
                        <span className="font-mono text-[11px] text-slate-500">
                          {formatJakartaDateTime(n.createdAt)}
                        </span>
                      </div>
                      <p className="text-xs text-slate-300">{n.message}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 9. PROFILE / LOGOUT */}
          {menu === 'profile' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/25 p-6 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-sky-500/15 border border-sky-400/35 text-sky-300 flex items-center justify-center">
                    <ShieldCheck className="w-6 h-6" />
                  </div>
                  <div>
                    <h2 className="font-display text-lg font-bold text-white">{adminProfile.fullName}</h2>
                    <p className="font-mono text-xs text-sky-300">{adminProfile.email}</p>
                  </div>
                </div>

                <div className="rounded-xl bg-[#070B19] border border-indigo-500/20 p-4 space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Role</span>
                    <span className="font-mono font-bold text-white">{adminProfile.role}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Cabang Terikat</span>
                    <span className="font-mono font-bold text-sky-300">{branchLabel} ({assignedBranch})</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Kode Kasir</span>
                    <span className="font-mono text-slate-200">{adminProfile.cashierCode || '-'}</span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void logout()}
                  className="w-full h-[46px] rounded-xl bg-rose-600 hover:bg-rose-500 text-sm font-bold text-white inline-flex items-center justify-center gap-2"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Keluar dari Akun Kasir</span>
                </button>
              </div>

              <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/25 p-6 space-y-4 text-xs">
                <h3 className="font-display text-base font-bold text-white">Batas Hak Akses Kasir</h3>
                <div className="space-y-2">
                  <p className="font-semibold text-emerald-300">Diizinkan (Hanya Cabang {assignedBranch}):</p>
                  <ul className="list-disc pl-5 text-slate-300 space-y-1">
                    <li>Pre-Register Customer (Nomor WhatsApp + Kode 6 Digit)</li>
                    <li>Input Transaksi &amp; Perolehan XP Otomatis</li>
                    <li>Ajukan, Approve/Deny, &amp; Tandai USED Benefit Request</li>
                    <li>Lookup &amp; Pantau Aktivitas Member Cabang {assignedBranch}</li>
                  </ul>
                </div>
                <div className="space-y-2 pt-2 border-t border-indigo-500/20">
                  <p className="font-semibold text-rose-300">Dibatasi (Khusus Admin / Superadmin):</p>
                  <ul className="list-disc pl-5 text-slate-400 space-y-1">
                    <li>XP Adjustment Manual, Pengaturan XP, Level Override</li>
                    <li>CRUD Benefits, Challenge, Event, Promo, CMS Homepage</li>
                    <li>Reset Password Member, Manajemen Admin/Kasir, Backup/Restore</li>
                    <li>Akses data operasional cabang lain</li>
                  </ul>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
