import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Activity,
  Award,
  BarChart3,
  Bell,
  Building2,
  Calendar,
  CheckCircle2,
  CreditCard,
  FileCheck2,
  Gift,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  RefreshCw,
  Shield,
  Sliders,
  Sparkles,
  Tag,
  Trophy,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import { where, type DocumentData, type QueryConstraint, type QueryDocumentSnapshot } from 'firebase/firestore';
import { ProtectedImage } from '../components/ProtectedImage.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import {
  createAndDispatchNotificationByAdmin,
  createMemberByAdmin,
  executeCycleResetByAdmin,
  fetchAdminSummaryMetrics,
  fetchPaginatedCollection,
  recordTransactionByAdmin,
  reviewClaimByAdmin,
  reviewRedemptionByAdmin,
  saveLevelsByAdmin,
  saveSystemSettingsByAdmin,
  updateMemberDetailsByAdmin,
  updateMemberStatusByAdmin,
  upsertAdminUserBySuperAdmin,
  upsertBenefitByAdmin,
  upsertBranchByAdmin,
  upsertCampaignByAdmin,
} from '../services/xpService.ts';
import {
  calculateTransactionXp,
  formatIdr,
  formatJakartaDateTime,
  getBranchLabel,
  resolveCampaignStatus,
} from '../shared/xpLogic.ts';
import type {
  AdminRole,
  AdminUser,
  AuditLogRecord,
  BenefitItem,
  BranchId,
  BranchInfo,
  CampaignItem,
  CampaignStatus,
  CampaignType,
  ClaimRecord,
  CycleSnapshot,
  LevelConfig,
  LevelHistoryRecord,
  LevelId,
  MemberProfile,
  MembershipCycle,
  MemberStatus,
  NotificationCampaign,
  RedemptionRecord,
  SystemSettings,
  TransactionRecord,
  XpLedgerEntry,
} from '../types/xpplay.ts';

type AdminMenu =
  | 'dashboard'
  | 'members'
  | 'transactions'
  | 'xpHistory'
  | 'levelHistory'
  | 'claims'
  | 'redemptions'
  | 'benefits'
  | 'challenges'
  | 'events'
  | 'promos'
  | 'notifications'
  | 'adminManagement'
  | 'levels'
  | 'xpSettings'
  | 'resetCycle'
  | 'branches'
  | 'auditLogs'
  | 'settings';

const MENU_ITEMS: { id: AdminMenu; label: string; icon: typeof LayoutDashboard; superOnly?: boolean }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'members', label: 'Members', icon: Users },
  { id: 'transactions', label: 'Transactions', icon: CreditCard },
  { id: 'xpHistory', label: 'XP History', icon: History },
  { id: 'levelHistory', label: 'Level Up History', icon: Trophy },
  { id: 'claims', label: 'Claims', icon: FileCheck2 },
  { id: 'redemptions', label: 'Redemptions', icon: Gift },
  { id: 'benefits', label: 'Benefits', icon: Award },
  { id: 'challenges', label: 'Challenges', icon: Sparkles },
  { id: 'events', label: 'Events', icon: Calendar },
  { id: 'promos', label: 'Promos', icon: Tag },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'adminManagement', label: 'Admin Management', icon: UserCog, superOnly: true },
  { id: 'levels', label: 'Levels', icon: Sliders, superOnly: true },
  { id: 'xpSettings', label: 'XP Settings', icon: Activity, superOnly: true },
  { id: 'resetCycle', label: 'Reset / Membership Cycle', icon: RefreshCw, superOnly: true },
  { id: 'branches', label: 'Branches', icon: Building2, superOnly: true },
  { id: 'auditLogs', label: 'Audit Logs', icon: Shield },
  { id: 'settings', label: 'Settings & Reporting', icon: BarChart3 },
];

export function AdminDashboardPage() {
  const { adminProfile, levels, branches, systemSettings, capabilities, logout, refreshProfiles } = useAuth();
  const [menu, setMenu] = useState<AdminMenu>('dashboard');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Dashboard metrics
  const [metrics, setMetrics] = useState<Awaited<ReturnType<typeof fetchAdminSummaryMetrics>> | null>(null);
  const [loadingMetrics, setLoadingMetrics] = useState(false);

  // Generic paginated list state for active view
  const [rows, setRows] = useState<unknown[]>([]);
  const [rowsOwnerKey, setRowsOwnerKey] = useState<string>('');
  const [cursor, setCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const fetchSeqRef = useRef(0);

  // Filters
  const [branchFilter, setBranchFilter] = useState<'ALL' | BranchId>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ON_PROCESS');
  const [ledgerType, setLedgerType] = useState<'xpProgressLedger' | 'xpRewardLedger'>('xpProgressLedger');
  const [memberSearch, setMemberSearch] = useState('');

  // Forms: Add Member
  const [showAddMember, setShowAddMember] = useState(false);
  const [newMember, setNewMember] = useState({
    fullName: '',
    username: '',
    whatsapp: '',
    socialMedia: '',
    referralUsername: '',
    preferredBranch: 'DEMANG' as BranchId,
  });

  // Forms: Edit Member modal
  const [editMemberTarget, setEditMemberTarget] = useState<MemberProfile | null>(null);
  const [editMemberPatch, setEditMemberPatch] = useState({
    fullName: '',
    socialMedia: '',
    preferredBranch: 'DEMANG' as BranchId,
  });

  // Forms: Transaction XP
  const [txForm, setTxForm] = useState({
    identifier: '',
    amountIdr: '',
    branch: 'DEMANG' as BranchId,
    receiptNumber: '',
    note: '',
  });

  // Forms: Denial reason
  const [denyTarget, setDenyTarget] = useState<{ kind: 'claim' | 'redemption'; id: string; title: string } | null>(null);
  const [denyReason, setDenyReason] = useState('');

  // Forms: Benefit CRUD
  const [benefitForm, setBenefitForm] = useState({
    id: '',
    name: '',
    description: '',
    xpCost: '50',
    levelRequirement: 'BRONZE' as LevelId,
    claimable: true,
    redeemable: true,
    stock: '',
    terms: '',
    active: true,
  });

  // Forms: Campaign CRUD (Challenge / Event / Promo)
  const [campaignForm, setCampaignForm] = useState({
    id: '',
    title: '',
    description: '',
    xpReward: '25',
    startAt: new Date().toISOString().slice(0, 16),
    endAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16),
    terms: '',
    maxClaimsPerMember: '1',
    requiresEvidence: true,
    status: 'ACTIVE' as CampaignStatus,
    active: true,
  });

  // Forms: Notification & Inactivity
  const [notifForm, setNotifForm] = useState({
    title: 'Kami sudah lama tidak bertemu. Yuk main lagi di XP PLAY!',
    message: 'Dapatkan pengalaman bermain seru di XP PLAY Demang & Sekip minggu ini!',
    targetType: 'INACTIVE_MEMBERS' as NotificationCampaign['targetType'],
    targetFilter: '',
    inactivityDays: '7',
  });

  // Forms: Levels, XP Settings, Reset Cycle, Branches, Admins
  const [levelDrafts, setLevelDrafts] = useState<LevelConfig[]>(levels);
  const [settingsDraft, setSettingsDraft] = useState<SystemSettings>(systemSettings);
  const [resetForm, setResetForm] = useState({
    nextCycleId: `2026-S${Math.floor(Date.now() / 1000) % 100}`,
    nextCycleName: 'Season Baru 2026',
    resetReason: 'Reset periodik membership cycle',
  });
  const [adminForm, setAdminForm] = useState({
    uid: '',
    email: '',
    fullName: '',
    role: 'STAFF' as AdminRole,
    branchScope: 'ALL' as BranchId | 'ALL',
    active: true,
  });

  useEffect(() => {
    setLevelDrafts(levels);
  }, [levels]);

  useEffect(() => {
    setSettingsDraft(systemSettings);
  }, [systemSettings]);

  const loadDashboardMetrics = async () => {
    setLoadingMetrics(true);
    try {
      const data = await fetchAdminSummaryMetrics();
      setMetrics(data);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setLoadingMetrics(false);
    }
  };

  const currentQueryKey = `${menu}:${branchFilter}:${statusFilter}:${ledgerType}`;
  const activeRows = rowsOwnerKey === currentQueryKey ? rows : [];

  const loadMenuRows = async (reset: boolean) => {
    if (menu === 'dashboard' || menu === 'levels' || menu === 'xpSettings' || menu === 'branches' || menu === 'settings') {
      return;
    }
    const seq = ++fetchSeqRef.current;
    const requestKey = `${menu}:${branchFilter}:${statusFilter}:${ledgerType}`;
    if (reset) {
      setRows([]);
      setCursor(null);
      setHasMore(false);
    }
    setLoadingRows(true);
    try {
      let colName = 'members';
      let orderByField = 'createdAt';
      const constraints: QueryConstraint[] = [];

      if (menu === 'members') {
        colName = 'members';
      } else if (menu === 'transactions') {
        colName = 'transactions';
        if (branchFilter !== 'ALL') constraints.push(where('branch', '==', branchFilter));
      } else if (menu === 'xpHistory') {
        colName = ledgerType;
        if (branchFilter !== 'ALL' && ledgerType === 'xpProgressLedger') {
          constraints.push(where('branch', '==', branchFilter));
        }
      } else if (menu === 'levelHistory') {
        colName = 'levelHistory';
      } else if (menu === 'claims') {
        colName = 'claims';
        if (statusFilter !== 'ALL') constraints.push(where('status', '==', statusFilter));
      } else if (menu === 'redemptions') {
        colName = 'redemptions';
        if (statusFilter !== 'ALL') constraints.push(where('status', '==', statusFilter));
      } else if (menu === 'benefits') {
        colName = 'benefits';
        orderByField = 'xpCost';
      } else if (menu === 'challenges' || menu === 'events' || menu === 'promos') {
        colName = 'campaigns';
        const t: CampaignType = menu === 'challenges' ? 'CHALLENGE' : menu === 'events' ? 'EVENT' : 'PROMO';
        constraints.push(where('type', '==', t));
        orderByField = 'endAt';
      } else if (menu === 'notifications') {
        colName = 'notifications';
      } else if (menu === 'adminManagement') {
        colName = 'admins';
      } else if (menu === 'resetCycle') {
        colName = 'cycleSnapshots';
        orderByField = 'resetAt';
      } else if (menu === 'auditLogs') {
        colName = 'auditLogs';
        orderByField = 'timestamp';
      }

      const res = await fetchPaginatedCollection<unknown>({
        collectionName: colName,
        constraints,
        orderByField,
        pageSize: 15,
        cursor: reset ? null : cursor,
      });

      if (seq !== fetchSeqRef.current) {
        return;
      }
      setRows((prev) => (reset ? res.items : [...prev, ...res.items]));
      setRowsOwnerKey(requestKey);
      setCursor(res.lastCursor);
      setHasMore(res.hasMore);
    } catch (err) {
      if (seq === fetchSeqRef.current) {
        setFeedback({ type: 'error', text: mapFriendlyError(err) });
      }
    } finally {
      if (seq === fetchSeqRef.current) {
        setLoadingRows(false);
      }
    }
  };

  useEffect(() => {
    if (menu === 'dashboard' || menu === 'settings') {
      void loadDashboardMetrics();
    } else {
      void loadMenuRows(true);
    }
  }, [menu, branchFilter, statusFilter, ledgerType]);

  if (!adminProfile) return null;
  const isSuper = adminProfile.role === 'SUPER_ADMIN';

  const handleAddMember = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const res = await createMemberByAdmin({
        ...newMember,
        admin: adminProfile,
      });
      setFeedback({
        type: 'success',
        text: `Member @${res.member.username} berhasil ditambahkan (+${res.member.xpProgress} XP). ${res.referralMessage || ''}`,
      });
      setShowAddMember(false);
      setNewMember({
        fullName: '',
        username: '',
        whatsapp: '',
        socialMedia: '',
        referralUsername: '',
        preferredBranch: 'DEMANG',
      });
      await loadMenuRows(true);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEditMember = async (e: FormEvent) => {
    e.preventDefault();
    if (!editMemberTarget) return;
    setBusy(true);
    try {
      await updateMemberDetailsByAdmin(editMemberTarget.uid, editMemberPatch, adminProfile);
      setEditMemberTarget(null);
      setFeedback({ type: 'success', text: 'Data member diperbarui.' });
      await loadMenuRows(true);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleRecordTransaction = async (e: FormEvent) => {
    e.preventDefault();
    const amountInt = Number(txForm.amountIdr);
    if (!Number.isSafeInteger(amountInt) || amountInt <= 0) {
      setFeedback({ type: 'error', text: 'Nominal transaksi harus bilangan bulat > 0.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const res = await recordTransactionByAdmin({
        identifier: txForm.identifier,
        amountIdr: amountInt,
        branch: txForm.branch,
        receiptNumber: txForm.receiptNumber,
        note: txForm.note,
        admin: adminProfile,
        adminSdkConfigured: capabilities.adminSdkConfigured,
      });
      setFeedback({
        type: 'success',
        text: `Transaksi dicatat! Member memperoleh +${res.xpGenerated} XP (XP Progress: ${res.newProgress}, XP Reward: ${res.newReward}, Level: ${res.newLevel}).`,
      });
      setTxForm({ identifier: '', amountIdr: '', branch: txForm.branch, receiptNumber: '', note: '' });
      await loadMenuRows(true);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleReviewDecision = async (
    kind: 'claim' | 'redemption',
    id: string,
    decision: 'APPROVED' | 'DENIED',
    reason?: string
  ) => {
    setBusy(true);
    setFeedback(null);
    try {
      if (kind === 'claim') {
        await reviewClaimByAdmin({
          claimId: id,
          decision,
          reason,
          admin: adminProfile,
          adminSdkConfigured: capabilities.adminSdkConfigured,
        });
      } else {
        await reviewRedemptionByAdmin({
          redemptionId: id,
          decision,
          reason,
          admin: adminProfile,
          adminSdkConfigured: capabilities.adminSdkConfigured,
        });
      }
      setDenyTarget(null);
      setDenyReason('');
      setFeedback({
        type: 'success',
        text: `${kind === 'claim' ? 'Claim' : 'Redemption'} berhasil diubah ke ${decision}.`,
      });
      await loadMenuRows(true);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveBenefit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const id = benefitForm.id || `ben_${Date.now()}`;
      const item: BenefitItem = {
        id,
        name: benefitForm.name.trim(),
        description: benefitForm.description.trim(),
        imageUrl: '',
        xpCost: Math.max(0, Math.floor(Number(benefitForm.xpCost) || 0)),
        levelRequirement: benefitForm.levelRequirement,
        claimable: benefitForm.claimable,
        redeemable: benefitForm.redeemable,
        stock: benefitForm.stock.trim() === '' ? null : Math.max(0, Math.floor(Number(benefitForm.stock))),
        expiryAt: null,
        terms: benefitForm.terms.trim(),
        active: benefitForm.active,
        createdBy: adminProfile.uid,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await upsertBenefitByAdmin(item, adminProfile);
      setBenefitForm({
        id: '',
        name: '',
        description: '',
        xpCost: '50',
        levelRequirement: 'BRONZE',
        claimable: true,
        redeemable: true,
        stock: '',
        terms: '',
        active: true,
      });
      setFeedback({ type: 'success', text: `Benefit "${item.name}" berhasil disimpan.` });
      await loadMenuRows(true);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveCampaign = async (e: FormEvent, type: CampaignType) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const startAt = new Date(campaignForm.startAt).getTime();
      const endAt = new Date(campaignForm.endAt).getTime();
      if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt) {
        throw new Error('Tanggal berakhir harus lebih besar atau sama dengan tanggal mulai.');
      }
      const id = campaignForm.id || `camp_${Date.now()}`;
      const item: CampaignItem = {
        id,
        type,
        title: campaignForm.title.trim(),
        description: campaignForm.description.trim(),
        startAt,
        endAt,
        xpReward: Math.max(1, Math.floor(Number(campaignForm.xpReward) || 10)),
        imageUrl: '',
        terms: campaignForm.terms.trim(),
        maxClaimsPerMember: Math.max(1, Math.floor(Number(campaignForm.maxClaimsPerMember) || 1)),
        totalClaimLimit: null,
        claimsCount: 0,
        active: campaignForm.status === 'ACTIVE',
        status: campaignForm.status,
        requiresEvidence: campaignForm.requiresEvidence,
        createdBy: adminProfile.uid,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await upsertCampaignByAdmin(item, adminProfile);
      setFeedback({ type: 'success', text: `${type} "${item.title}" berhasil disimpan.` });
      setCampaignForm({ ...campaignForm, id: '', title: '', description: '', terms: '' });
      await loadMenuRows(true);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleDispatchNotification = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const res = await createAndDispatchNotificationByAdmin({
        title: notifForm.title,
        message: notifForm.message,
        targetType: notifForm.targetType,
        targetFilter: notifForm.targetFilter,
        inactivityDays:
          notifForm.targetType === 'INACTIVE_MEMBERS'
            ? Math.max(1, Math.floor(Number(notifForm.inactivityDays) || 7))
            : null,
        admin: adminProfile,
      });
      setFeedback({
        type: 'success',
        text: `Notifikasi berhasil dikirim ke ${res.dispatchedCount} member yang memenuhi target.`,
      });
      await loadMenuRows(true);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleExecuteReset = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const res = await executeCycleResetByAdmin({
        nextCycleId: resetForm.nextCycleId,
        nextCycleName: resetForm.nextCycleName,
        resetReason: resetForm.resetReason,
        admin: adminProfile,
        adminSdkConfigured: capabilities.adminSdkConfigured,
      });
      await refreshProfiles();
      setFeedback({
        type: 'success',
        text: `Reset berhasil: ${res.prevCycleId} -> ${res.nextCycleId} (${res.processedMembers} member diarsipkan).`,
      });
      await loadMenuRows(true);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const previewTxXp = (() => {
    const num = Number(txForm.amountIdr);
    if (!Number.isSafeInteger(num) || num <= 0) return 0;
    return calculateTransactionXp(num, systemSettings.transactionXpRate);
  })();

  const visibleMenu = MENU_ITEMS.filter((m) => !m.superOnly || isSuper);
  const currentTitle = MENU_ITEMS.find((m) => m.id === menu)?.label || 'Dashboard';

  return (
    <div className="min-h-screen gaming-canvas text-slate-100 flex overflow-x-hidden">
      {/* Sidebar Desktop */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 bg-[#070B1A] text-slate-300 border-r border-indigo-500/20">
        <div className="h-16 px-5 flex items-center justify-between border-b border-indigo-500/20">
          <span className="font-display text-base font-extrabold tracking-tight bg-gradient-to-r from-sky-300 to-purple-300 bg-clip-text text-transparent">XP PLAY ADMIN</span>
          <span className="font-mono text-[11px] text-purple-300">{adminProfile.role}</span>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
          {visibleMenu.map((item) => {
            const Icon = item.icon;
            const active = menu === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setMenu(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                  active
                    ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white shadow-[0_0_16px_-4px_rgba(99,102,241,0.6)]'
                    : 'text-slate-300 hover:bg-[#0D1533] hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="p-4 border-t border-indigo-500/20 space-y-2">
          <p className="text-xs text-slate-400 truncate">{adminProfile.email}</p>
          <button
            type="button"
            onClick={() => void logout()}
            className="w-full min-h-[40px] flex items-center justify-center gap-2 rounded-xl border border-indigo-500/30 bg-[#0B1124] py-2 text-xs font-medium text-slate-200 hover:border-sky-400/50 hover:text-white transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Keluar Admin</span>
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden bg-black/50 flex">
          <div className="w-72 bg-[#070B1A] text-slate-200 flex flex-col h-full border-r border-indigo-500/25">
            <div className="h-14 px-4 flex items-center justify-between border-b border-indigo-500/20">
              <span className="font-display font-bold text-white">XP PLAY ADMIN</span>
              <button type="button" onClick={() => setMobileNavOpen(false)}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto p-3 space-y-1">
              {visibleMenu.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setMenu(item.id);
                      setMobileNavOpen(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-medium ${
                      menu === item.id ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white' : 'text-slate-300 hover:bg-[#0D1533]'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 h-16 bg-[#050814]/90 backdrop-blur-md border-b border-indigo-500/20 px-4 sm:px-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl border border-indigo-500/25 bg-[#0B1124] text-slate-200"
              aria-label="Menu Admin"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="truncate">
              <p className="text-[11px] text-slate-400 truncate">
                Admin / {currentTitle} · Cycle {systemSettings.currentCycleId}
              </p>
              <h1 className="font-display text-base sm:text-lg font-bold text-white truncate">
                {currentTitle}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <button
              type="button"
              onClick={() => (menu === 'dashboard' ? void loadDashboardMetrics() : void loadMenuRows(true))}
              className="min-h-[40px] rounded-xl border border-indigo-500/25 bg-[#0B1124] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-sky-400/50 transition-colors"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void logout()}
              className="lg:hidden min-h-[40px] rounded-xl border border-indigo-500/25 bg-[#0B1124] px-3 py-1.5 text-xs font-medium text-slate-200"
            >
              Keluar
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-8 max-w-7xl w-full mx-auto space-y-6">
          {feedback && (
            <div
              role="alert"
              className={`rounded-xl border p-3.5 text-sm flex items-center justify-between gap-3 ${
                feedback.type === 'success'
                  ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200'
                  : 'border-rose-500/35 bg-rose-500/10 text-rose-200'
              }`}
            >
              <span>{feedback.text}</span>
              <button type="button" onClick={() => setFeedback(null)} className="text-xs font-semibold underline">
                Tutup
              </button>
            </div>
          )}

          {/* 1. DASHBOARD */}
          {menu === 'dashboard' && (
            <div className="space-y-6">
              {loadingMetrics && !metrics ? (
                <div className="h-40 rounded-2xl bg-[#0B1124] border border-indigo-500/20 animate-pulse" />
              ) : metrics ? (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-4">
                      <p className="text-xs text-slate-400">Total / Active Members</p>
                      <p className="mt-1 font-mono text-2xl font-bold text-white tabular-nums">
                        {metrics.totalMembers} / {metrics.activeMembers}
                      </p>
                    </div>
                    <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-4">
                      <p className="text-xs text-slate-400">Pending Claims / Redemptions</p>
                      <p className="mt-1 font-mono text-2xl font-bold text-purple-300 tabular-nums">
                        {metrics.pendingClaims} / {metrics.pendingRedemptions}
                      </p>
                    </div>
                    <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-4">
                      <p className="text-xs text-slate-400">Total Transaksi</p>
                      <p className="mt-1 font-mono text-2xl font-bold text-white tabular-nums">
                        {metrics.totalTransactions}
                      </p>
                    </div>
                    <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-4">
                      <p className="text-xs text-slate-400">Inaktif (7 / 14 / 30 Hari)</p>
                      <p className="mt-1 font-mono text-xl font-bold text-white tabular-nums">
                        {metrics.inactive7Days} / {metrics.inactive14Days} / {metrics.inactive30Days}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {(['BRONZE', 'SILVER', 'JURAGAN', 'SULTAN'] as LevelId[]).map((lvl) => (
                      <div key={lvl} className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-4 flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-300">{lvl}</span>
                        <span className="font-mono text-lg font-bold text-white tabular-nums">
                          {metrics.levelCounts[lvl]}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <h2 className="font-display text-base font-bold text-white">Transaksi Terbaru</h2>
                      <button
                        type="button"
                        onClick={() => setMenu('transactions')}
                        className="text-xs font-semibold text-purple-300 hover:underline"
                      >
                        Input Transaksi XP
                      </button>
                    </div>
                    {metrics.recentTransactions.length === 0 ? (
                      <p className="text-sm text-slate-400">Belum ada transaksi tercatat.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-indigo-500/20 text-left text-xs text-slate-400">
                              <th className="py-2 pr-4">Member</th>
                              <th className="py-2 pr-4">Cabang</th>
                              <th className="py-2 pr-4 text-right">Nominal</th>
                              <th className="py-2 pr-4 text-right">XP</th>
                              <th className="py-2">Waktu</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-indigo-500/15">
                            {metrics.recentTransactions.map((t, idx) => (
                              <tr key={t.id || `recent-tx-${idx}`}>
                                <td className="py-2.5 pr-4 font-mono text-xs">@{t.memberUsername}</td>
                                <td className="py-2.5 pr-4 text-xs">{t.branch}</td>
                                <td className="py-2.5 pr-4 text-right font-mono tabular-nums">{formatIdr(t.amountIdr)}</td>
                                <td className="py-2.5 pr-4 text-right font-mono font-bold text-emerald-400 tabular-nums">+{t.xpGenerated}</td>
                                <td className="py-2.5 text-xs text-slate-400">{formatJakartaDateTime(t.createdAt)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          )}

          {/* 2. MEMBERS */}
          {menu === 'members' && (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <input
                  type="text"
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value.toLowerCase())}
                  placeholder="Filter cepat halaman ini (username / WA / nama)"
                  className="h-10 w-full sm:w-80 rounded-xl border border-indigo-500/30 bg-[#070B19] text-white px-3 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowAddMember((v) => !v)}
                  className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-4 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500 whitespace-nowrap"
                >
                  {showAddMember ? 'Tutup Form' : '+ Tambah Member'}
                </button>
              </div>

              {showAddMember && (
                <form onSubmit={handleAddMember} className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 grid sm:grid-cols-3 gap-4">
                  <input
                    type="text"
                    required
                    placeholder="Nama Lengkap *"
                    value={newMember.fullName}
                    onChange={(e) => setNewMember({ ...newMember, fullName: e.target.value })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  />
                  <input
                    type="text"
                    required
                    placeholder="Username unik *"
                    value={newMember.username}
                    onChange={(e) => setNewMember({ ...newMember, username: e.target.value.toLowerCase() })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                  />
                  <input
                    type="tel"
                    required
                    placeholder="WhatsApp (0898...) *"
                    value={newMember.whatsapp}
                    onChange={(e) => setNewMember({ ...newMember, whatsapp: e.target.value })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                  />
                  <input
                    type="text"
                    placeholder="Sosial Media"
                    value={newMember.socialMedia}
                    onChange={(e) => setNewMember({ ...newMember, socialMedia: e.target.value })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  />
                  <input
                    type="text"
                    placeholder="Referral Username (opsional)"
                    value={newMember.referralUsername}
                    onChange={(e) => setNewMember({ ...newMember, referralUsername: e.target.value.toLowerCase() })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                  />
                  <select
                    value={newMember.preferredBranch}
                    onChange={(e) => setNewMember({ ...newMember, preferredBranch: e.target.value as BranchId })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  >
                    <option value="DEMANG">Cabang DEMANG</option>
                    <option value="SEKIP">Cabang SEKIP</option>
                  </select>
                  <div className="sm:col-span-3 flex justify-end">
                    <button
                      type="submit"
                      disabled={busy}
                      className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-5 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500"
                    >
                      {busy ? 'Menyimpan...' : 'Simpan Member (+10 XP)'}
                    </button>
                  </div>
                </form>
              )}

              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-indigo-500/20 text-left text-xs text-slate-400">
                      <th className="p-3">Member</th>
                      <th className="p-3">WhatsApp</th>
                      <th className="p-3">Level</th>
                      <th className="p-3 text-right">XP Progress</th>
                      <th className="p-3 text-right">XP Reward</th>
                      <th className="p-3">Last Play</th>
                      <th className="p-3">Status</th>
                      <th className="p-3 text-right">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-indigo-500/15">
                    {(activeRows as MemberProfile[])
                      .filter(
                        (m) =>
                          !memberSearch ||
                          (m.username || '').includes(memberSearch) ||
                          (m.fullName || '').toLowerCase().includes(memberSearch) ||
                          (m.whatsapp || '').includes(memberSearch)
                      )
                      .map((m, idx) => (
                        <tr key={m.uid || m.memberId || `mem-${idx}`}>
                          <td className="p-3">
                            <p className="font-semibold text-white">{m.fullName}</p>
                            <p className="text-xs font-mono text-slate-400">@{m.username} · {m.memberId}</p>
                          </td>
                          <td className="p-3 font-mono text-xs">{m.whatsapp}</td>
                          <td className="p-3 text-xs font-semibold">{m.currentLevel}</td>
                          <td className="p-3 text-right font-mono tabular-nums">{m.xpProgress}</td>
                          <td className="p-3 text-right font-mono tabular-nums text-purple-300">{m.xpReward}</td>
                          <td className="p-3 text-xs text-slate-400">
                            {m.lastPlayAt ? `${formatJakartaDateTime(m.lastPlayAt)} (${m.lastPlayBranch})` : '-'}
                          </td>
                          <td className="p-3 text-xs font-mono font-semibold">{m.status}</td>
                          <td className="p-3 text-right space-x-2 whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => {
                                setEditMemberTarget(m);
                                setEditMemberPatch({
                                  fullName: m.fullName,
                                  socialMedia: m.socialMedia,
                                  preferredBranch: m.preferredBranch || 'DEMANG',
                                });
                              }}
                              className="text-xs font-semibold text-sky-300 hover:underline"
                            >
                              Edit
                            </button>
                            {m.status !== 'ACTIVE' ? (
                              <button
                                type="button"
                                onClick={() =>
                                  void updateMemberStatusByAdmin(m.uid, 'ACTIVE', adminProfile).then(() =>
                                    loadMenuRows(true)
                                  )
                                }
                                className="text-xs font-semibold text-emerald-400 hover:underline"
                              >
                                Activate
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() =>
                                  void updateMemberStatusByAdmin(m.uid, 'SUSPENDED', adminProfile).then(() =>
                                    loadMenuRows(true)
                                  )
                                }
                                className="text-xs font-semibold text-purple-300 hover:underline"
                              >
                                Suspend
                              </button>
                            )}
                            {m.status !== 'DELETED' && (
                              <button
                                type="button"
                                onClick={() =>
                                  void updateMemberStatusByAdmin(m.uid, 'DELETED', adminProfile).then(() =>
                                    loadMenuRows(true)
                                  )
                                }
                                className="text-xs font-semibold text-rose-400 hover:underline"
                              >
                                Soft Delete
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {hasMore && (
                  <div className="p-3 border-t border-indigo-500/15 text-center">
                    <button
                      type="button"
                      disabled={loadingRows}
                      onClick={() => void loadMenuRows(false)}
                      className="text-xs font-semibold text-slate-200 underline"
                    >
                      Muat Halaman Berikutnya
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 3. TRANSACTIONS */}
          {menu === 'transactions' && (
            <div className="space-y-6">
              <form onSubmit={handleRecordTransaction} className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="font-display text-base font-bold text-white">Input Transaksi XP Manual</h2>
                  <span className="text-xs font-mono text-slate-300">
                    Rate: Rp{systemSettings.transactionXpRate.toLocaleString('id-ID')} = 1 XP · Estimasi: <strong>+{previewTxXp} XP</strong>
                  </span>
                </div>
                <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  <input
                    type="text"
                    required
                    placeholder="Username atau WhatsApp *"
                    value={txForm.identifier}
                    onChange={(e) => setTxForm({ ...txForm, identifier: e.target.value })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  />
                  <input
                    type="number"
                    required
                    min={1}
                    step={1}
                    placeholder="Nominal (Rp) *"
                    value={txForm.amountIdr}
                    onChange={(e) => setTxForm({ ...txForm, amountIdr: e.target.value })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                  />
                  <select
                    value={txForm.branch}
                    onChange={(e) => setTxForm({ ...txForm, branch: e.target.value as BranchId })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  >
                    <option value="DEMANG">XP PLAY DEMANG</option>
                    <option value="SEKIP">XP PLAY SEKIP</option>
                  </select>
                  <input
                    type="text"
                    placeholder="No. Receipt / Ref"
                    value={txForm.receiptNumber}
                    onChange={(e) => setTxForm({ ...txForm, receiptNumber: e.target.value })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                  />
                  <input
                    type="text"
                    placeholder="Catatan (opsional)"
                    value={txForm.note}
                    onChange={(e) => setTxForm({ ...txForm, note: e.target.value })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  />
                </div>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={busy}
                    className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-6 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500 disabled:opacity-50"
                  >
                    {busy ? 'Memproses...' : `Catat Transaksi (+${previewTxXp} XP)`}
                  </button>
                </div>
              </form>

              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 overflow-hidden">
                <div className="p-4 border-b border-indigo-500/15 flex items-center justify-between">
                  <h3 className="font-display text-sm font-bold text-white">Riwayat Transaksi</h3>
                  <select
                    value={branchFilter}
                    onChange={(e) => setBranchFilter(e.target.value as 'ALL' | BranchId)}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-8 rounded-lg border border-indigo-500/30 px-2.5 text-xs"
                  >
                    <option value="ALL">Semua Cabang</option>
                    <option value="DEMANG">Demang</option>
                    <option value="SEKIP">Sekip</option>
                  </select>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-indigo-500/20 text-left text-xs text-slate-400">
                        <th className="p-3">Waktu</th>
                        <th className="p-3">Member</th>
                        <th className="p-3">Cabang</th>
                        <th className="p-3 text-right">Nominal</th>
                        <th className="p-3 text-right">XP</th>
                        <th className="p-3">Receipt</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-indigo-500/15">
                      {(activeRows as TransactionRecord[]).map((t, idx) => (
                        <tr key={t.id || `tx-${idx}`}>
                          <td className="p-3 text-xs text-slate-400">{formatJakartaDateTime(t.createdAt)}</td>
                          <td className="p-3 font-mono text-xs">@{t.memberUsername}</td>
                          <td className="p-3 text-xs">{t.branch}</td>
                          <td className="p-3 text-right font-mono tabular-nums">{formatIdr(t.amountIdr)}</td>
                          <td className="p-3 text-right font-mono font-bold text-emerald-400 tabular-nums">+{t.xpGenerated}</td>
                          <td className="p-3 font-mono text-xs text-slate-400">{t.receiptNumber || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {hasMore && (
                  <div className="p-3 border-t border-indigo-500/15 text-center">
                    <button type="button" onClick={() => void loadMenuRows(false)} className="text-xs font-semibold underline">
                      Muat Lebih Banyak
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 4. XP HISTORY & 5. LEVEL UP HISTORY */}
          {(menu === 'xpHistory' || menu === 'levelHistory') && (
            <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 overflow-hidden">
              <div className="p-4 border-b border-indigo-500/15 flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-display text-sm font-bold text-white">
                  {menu === 'xpHistory' ? 'Ledger XP Progress & XP Reward' : 'Riwayat Kenaikan Level'}
                </h2>
                {menu === 'xpHistory' && (
                  <div className="flex items-center gap-2">
                    <select
                      value={ledgerType}
                      onChange={(e) => setLedgerType(e.target.value as 'xpProgressLedger' | 'xpRewardLedger')}
                      className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-8 rounded-lg border border-indigo-500/30 px-2.5 text-xs"
                    >
                      <option value="xpProgressLedger">XP Progress Ledger</option>
                      <option value="xpRewardLedger">XP Reward Ledger</option>
                    </select>
                    {ledgerType === 'xpProgressLedger' && (
                      <select
                        value={branchFilter}
                        onChange={(e) => setBranchFilter(e.target.value as 'ALL' | BranchId)}
                        className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-8 rounded-lg border border-indigo-500/30 px-2.5 text-xs"
                      >
                        <option value="ALL">Semua Cabang</option>
                        <option value="DEMANG">Demang</option>
                        <option value="SEKIP">Sekip</option>
                      </select>
                    )}
                  </div>
                )}
              </div>
              <div className="divide-y divide-indigo-500/15">
                {menu === 'xpHistory'
                  ? (activeRows as XpLedgerEntry[]).map((e, idx) => (
                      <div key={e.id || `xp-${idx}`} className="p-3.5 flex items-center justify-between gap-4 text-sm">
                        <div>
                          <p className="font-semibold text-white">{e.note}</p>
                          <p className="text-xs text-slate-400">
                            {e.memberId} · {e.source} · Cycle {e.cycleId} · {formatJakartaDateTime(e.createdAt)}
                          </p>
                        </div>
                        <span className={`font-mono font-bold tabular-nums ${e.amount >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {e.amount >= 0 ? `+${e.amount}` : e.amount} XP
                        </span>
                      </div>
                    ))
                  : (activeRows as LevelHistoryRecord[]).map((lh, idx) => (
                      <div key={lh.id || `lh-${idx}`} className="p-3.5 flex items-center justify-between gap-4 text-sm">
                        <div>
                          <p className="font-semibold text-white">
                            {lh.memberId}: {lh.fromLevel} → {lh.toLevel}
                          </p>
                          <p className="text-xs text-slate-400">
                            XP Progress: {lh.xpProgressAtEvent} XP · {lh.source} · {formatJakartaDateTime(lh.createdAt)}
                          </p>
                        </div>
                        <span className="font-mono text-xs font-semibold text-purple-300">{lh.cycleId}</span>
                      </div>
                    ))}
              </div>
              {hasMore && (
                <div className="p-3 border-t border-indigo-500/15 text-center">
                  <button type="button" onClick={() => void loadMenuRows(false)} className="text-xs font-semibold underline">
                    Muat Lebih Banyak
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 6. CLAIMS APPROVAL & 7. REDEMPTIONS APPROVAL */}
          {(menu === 'claims' || menu === 'redemptions') && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
                {(['ON_PROCESS', 'APPROVED', 'DENIED', 'ALL'] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setStatusFilter(st)}
                    className={`min-h-[40px] px-3.5 py-1.5 rounded-xl text-xs font-semibold border whitespace-nowrap shrink-0 transition-all ${
                      statusFilter === st ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white border-sky-400/50' : 'bg-[#0B1124] text-slate-300 border-indigo-500/25 hover:text-white'
                    }`}
                  >
                    {st}
                  </button>
                ))}
              </div>

              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 divide-y divide-indigo-500/15">
                {activeRows.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-400">
                    {loadingRows ? 'Memuat data...' : `Tidak ada data pada filter ${statusFilter}.`}
                  </div>
                ) : menu === 'claims' ? (
                  (activeRows as ClaimRecord[]).map((cl, idx) => (
                    <div key={cl.id || `cl-${idx}`} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="flex items-start gap-3">
                        {cl.evidenceUrl && (
                          <ProtectedImage
                            src={cl.evidenceUrl}
                            alt={`Bukti ${cl.campaignTitle}`}
                            className="w-20 h-20 rounded-lg object-cover border border-indigo-500/20 shrink-0"
                          />
                        )}
                        <div className="space-y-1">
                          <p className="text-sm font-bold text-white">
                            @{cl.memberUsername} · {cl.campaignTitle} (+{cl.xpRewardSnapshot} XP)
                          </p>
                          <p className="text-xs text-slate-400">
                            {cl.campaignType} · {formatJakartaDateTime(cl.createdAt)} · Status: <strong>{cl.status}</strong>
                          </p>
                          {cl.note && <p className="text-xs text-slate-300">Catatan: {cl.note}</p>}
                          {cl.denialReason && <p className="text-xs text-rose-400">Alasan ditolak: {cl.denialReason}</p>}
                        </div>
                      </div>
                      {cl.status === 'ON_PROCESS' && (
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleReviewDecision('claim', cl.id, 'APPROVED')}
                            className="rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
                          >
                            APPROVE
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setDenyTarget({ kind: 'claim', id: cl.id, title: cl.campaignTitle })}
                            className="rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-rose-500"
                          >
                            DENY
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                ) : (
                  (activeRows as RedemptionRecord[]).map((rd, idx) => (
                    <div key={rd.id || `rd-${idx}`} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="space-y-1">
                        <p className="text-sm font-bold text-white">
                          @{rd.memberUsername} · {rd.benefitName} ({rd.xpCostSnapshot} XP)
                        </p>
                        <p className="text-xs text-slate-400">
                          Jenis: {rd.redemptionKind} · Min Level: {rd.levelRequirement} · {formatJakartaDateTime(rd.createdAt)} · Status: <strong>{rd.status}</strong>
                        </p>
                        {rd.denialReason && <p className="text-xs text-rose-400">Alasan: {rd.denialReason}</p>}
                      </div>
                      {rd.status === 'ON_PROCESS' && (
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleReviewDecision('redemption', rd.id, 'APPROVED')}
                            className="rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
                          >
                            APPROVE
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setDenyTarget({ kind: 'redemption', id: rd.id, title: rd.benefitName })}
                            className="rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-rose-500"
                          >
                            DENY
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* 8. BENEFITS */}
          {menu === 'benefits' && (
            <div className="space-y-6">
              <form onSubmit={handleSaveBenefit} className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-4">
                <h2 className="font-display text-base font-bold text-white">Tambah / Ubah Benefit</h2>
                <div className="grid sm:grid-cols-3 gap-3">
                  <input
                    type="text"
                    required
                    placeholder="Nama Benefit *"
                    value={benefitForm.name}
                    onChange={(e) => setBenefitForm({ ...benefitForm, name: e.target.value })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  />
                  <input
                    type="number"
                    min={0}
                    placeholder="XP Cost (0 untuk Level Benefit)"
                    value={benefitForm.xpCost}
                    onChange={(e) => setBenefitForm({ ...benefitForm, xpCost: e.target.value })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                  />
                  <select
                    value={benefitForm.levelRequirement}
                    onChange={(e) => setBenefitForm({ ...benefitForm, levelRequirement: e.target.value as LevelId })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  >
                    <option value="BRONZE">Min Level: BRONZE</option>
                    <option value="SILVER">Min Level: SILVER</option>
                    <option value="JURAGAN">Min Level: JURAGAN</option>
                    <option value="SULTAN">Min Level: SULTAN</option>
                  </select>
                  <input
                    type="text"
                    placeholder="Deskripsi benefit"
                    value={benefitForm.description}
                    onChange={(e) => setBenefitForm({ ...benefitForm, description: e.target.value })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm sm:col-span-2"
                  />
                  <input
                    type="number"
                    min={0}
                    placeholder="Kuota/Stok (kosong = unlimited)"
                    value={benefitForm.stock}
                    onChange={(e) => setBenefitForm({ ...benefitForm, stock: e.target.value })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                  />
                  <input
                    type="text"
                    placeholder="Syarat & ketentuan"
                    value={benefitForm.terms}
                    onChange={(e) => setBenefitForm({ ...benefitForm, terms: e.target.value })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm sm:col-span-2"
                  />
                  <div className="flex items-center gap-4 text-xs">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={benefitForm.claimable}
                        onChange={(e) => setBenefitForm({ ...benefitForm, claimable: e.target.checked, redeemable: e.target.checked })}
                      />
                      <span>Claimable/Redeemable</span>
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={benefitForm.active}
                        onChange={(e) => setBenefitForm({ ...benefitForm, active: e.target.checked })}
                      />
                      <span>Aktif</span>
                    </label>
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-5 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500"
                >
                  Simpan Benefit
                </button>
              </form>

              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 divide-y divide-indigo-500/15">
                {(activeRows as BenefitItem[]).map((b, idx) => (
                  <div key={b.id || `ben-${idx}`} className="p-4 flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-bold text-white">{b.name}</p>
                      <p className="text-xs text-slate-400">
                        Level {b.levelRequirement} · {b.xpCost} XP · {b.claimable ? 'Redeemable' : 'Info Only'} · {b.active ? 'ACTIVE' : 'DISABLED'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setBenefitForm({
                          id: b.id,
                          name: b.name,
                          description: b.description,
                          xpCost: String(b.xpCost),
                          levelRequirement: b.levelRequirement,
                          claimable: b.claimable,
                          redeemable: b.redeemable,
                          stock: b.stock === null ? '' : String(b.stock),
                          terms: b.terms,
                          active: b.active,
                        })
                      }
                      className="text-xs font-semibold text-sky-300 hover:underline"
                    >
                      Edit
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 9. CHALLENGES / 10. EVENTS / 11. PROMOS */}
          {(menu === 'challenges' || menu === 'events' || menu === 'promos') && (
            <div className="space-y-6">
              {(() => {
                const cType: CampaignType = menu === 'challenges' ? 'CHALLENGE' : menu === 'events' ? 'EVENT' : 'PROMO';
                return (
                  <form onSubmit={(e) => void handleSaveCampaign(e, cType)} className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-4">
                    <h2 className="font-display text-base font-bold text-white">Buat / Edit {cType}</h2>
                    <div className="grid sm:grid-cols-3 gap-3">
                      <input
                        type="text"
                        required
                        placeholder={`Judul ${cType} *`}
                        value={campaignForm.title}
                        onChange={(e) => setCampaignForm({ ...campaignForm, title: e.target.value })}
                        className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                      />
                      <input
                        type="number"
                        required
                        min={1}
                        placeholder="XP Reward *"
                        value={campaignForm.xpReward}
                        onChange={(e) => setCampaignForm({ ...campaignForm, xpReward: e.target.value })}
                        className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                      />
                      <select
                        value={campaignForm.status}
                        onChange={(e) => setCampaignForm({ ...campaignForm, status: e.target.value as CampaignStatus })}
                        className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                      >
                        <option value="ACTIVE">ACTIVE</option>
                        <option value="DRAFT">DRAFT</option>
                        <option value="DISABLED">DISABLED</option>
                      </select>
                      <input
                        type="datetime-local"
                        value={campaignForm.startAt}
                        onChange={(e) => setCampaignForm({ ...campaignForm, startAt: e.target.value })}
                        className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                      />
                      <input
                        type="datetime-local"
                        value={campaignForm.endAt}
                        onChange={(e) => setCampaignForm({ ...campaignForm, endAt: e.target.value })}
                        className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                      />
                      <input
                        type="number"
                        min={1}
                        placeholder="Max Claim / Member"
                        value={campaignForm.maxClaimsPerMember}
                        onChange={(e) => setCampaignForm({ ...campaignForm, maxClaimsPerMember: e.target.value })}
                        className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                      />
                      <input
                        type="text"
                        required
                        placeholder="Deskripsi *"
                        value={campaignForm.description}
                        onChange={(e) => setCampaignForm({ ...campaignForm, description: e.target.value })}
                        className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm sm:col-span-2"
                      />
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={campaignForm.requiresEvidence}
                          onChange={(e) => setCampaignForm({ ...campaignForm, requiresEvidence: e.target.checked })}
                        />
                        <span>Wajib Upload Bukti Foto</span>
                      </label>
                    </div>
                    <button
                      type="submit"
                      disabled={busy}
                      className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-5 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500"
                    >
                      Simpan {cType}
                    </button>
                  </form>
                );
              })()}

              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 divide-y divide-indigo-500/15">
                {(activeRows as CampaignItem[]).map((c, idx) => (
                  <div key={c.id || `camp-${idx}`} className="p-4 flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-bold text-white">{c.title} (+{c.xpReward} XP)</p>
                      <p className="text-xs text-slate-400">
                        Status Efektif: <strong>{resolveCampaignStatus(c)}</strong> · Berakhir: {formatJakartaDateTime(c.endAt)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setCampaignForm({
                          id: c.id,
                          title: c.title,
                          description: c.description,
                          xpReward: String(c.xpReward),
                          startAt: new Date(c.startAt).toISOString().slice(0, 16),
                          endAt: new Date(c.endAt).toISOString().slice(0, 16),
                          terms: c.terms,
                          maxClaimsPerMember: String(c.maxClaimsPerMember),
                          requiresEvidence: c.requiresEvidence,
                          status: c.status,
                          active: c.active,
                        })
                      }
                      className="text-xs font-semibold text-sky-300 hover:underline"
                    >
                      Edit
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 12. NOTIFICATIONS & INACTIVITY CAMPAIGN */}
          {menu === 'notifications' && (
            <div className="space-y-6">
              <form onSubmit={handleDispatchNotification} className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-4">
                <h2 className="font-display text-base font-bold text-white">Kirim Notifikasi / Kampanye Member Inaktif</h2>
                <div className="grid sm:grid-cols-3 gap-3">
                  <select
                    value={notifForm.targetType}
                    onChange={(e) =>
                      setNotifForm({
                        ...notifForm,
                        targetType: e.target.value as NotificationCampaign['targetType'],
                      })
                    }
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  >
                    <option value="INACTIVE_MEMBERS">Member Tidak Aktif (Last Play)</option>
                    <option value="ALL_MEMBERS">Semua Member Aktif</option>
                    <option value="LEVEL">Berdasarkan Level</option>
                    <option value="BRANCH">Berdasarkan Cabang Terakhir</option>
                    <option value="SPECIFIC_MEMBER">Member Tertentu (Username)</option>
                  </select>

                  {notifForm.targetType === 'INACTIVE_MEMBERS' ? (
                    <select
                      value={notifForm.inactivityDays}
                      onChange={(e) => setNotifForm({ ...notifForm, inactivityDays: e.target.value })}
                      className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                    >
                      <option value="7">Inaktif ≥ 7 Hari</option>
                      <option value="14">Inaktif ≥ 14 Hari</option>
                      <option value="30">Inaktif ≥ 30 Hari</option>
                      <option value="60">Inaktif ≥ 60 Hari (Custom)</option>
                    </select>
                  ) : notifForm.targetType !== 'ALL_MEMBERS' ? (
                    <input
                      type="text"
                      required
                      placeholder={
                        notifForm.targetType === 'LEVEL'
                          ? 'BRONZE / SILVER / JURAGAN / SULTAN'
                          : notifForm.targetType === 'BRANCH'
                            ? 'DEMANG / SEKIP'
                            : 'Username member'
                      }
                      value={notifForm.targetFilter}
                      onChange={(e) => setNotifForm({ ...notifForm, targetFilter: e.target.value })}
                      className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                    />
                  ) : null}

                  <input
                    type="text"
                    required
                    placeholder="Judul Notifikasi *"
                    value={notifForm.title}
                    onChange={(e) => setNotifForm({ ...notifForm, title: e.target.value })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  />
                  <textarea
                    rows={2}
                    required
                    placeholder="Isi pesan notifikasi *"
                    value={notifForm.message}
                    onChange={(e) => setNotifForm({ ...notifForm, message: e.target.value })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none sm:col-span-3 rounded-lg border border-indigo-500/30 p-3 text-sm"
                  />
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-5 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500"
                >
                  {busy ? 'Mengirim...' : 'Kirim Kampanye Notifikasi'}
                </button>
              </form>

              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 divide-y divide-indigo-500/15">
                {(activeRows as NotificationCampaign[]).map((nc, idx) => (
                  <div key={nc.id || `nc-${idx}`} className="p-4">
                    <p className="text-sm font-bold text-white">{nc.title}</p>
                    <p className="text-xs text-slate-300">{nc.message}</p>
                    <p className="text-[11px] text-slate-400 mt-1">
                      Target: {nc.targetType} {nc.inactivityDays ? `(>= ${nc.inactivityDays} hari)` : nc.targetFilter} · {formatJakartaDateTime(nc.createdAt)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 13. ADMIN MANAGEMENT (SUPER_ADMIN) */}
          {menu === 'adminManagement' && isSuper && (
            <div className="space-y-6">
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  try {
                    const target: AdminUser = {
                      uid: adminForm.uid.trim(),
                      email: adminForm.email.trim().toLowerCase(),
                      fullName: adminForm.fullName.trim(),
                      role: adminForm.role,
                      branchScope: adminForm.branchScope,
                      permissions: {
                        manageMembers: adminForm.role !== 'STAFF',
                        inputTransactions: true,
                        reviewClaims: true,
                        reviewRedemptions: true,
                        manageCampaigns: adminForm.role !== 'STAFF',
                        manageBenefits: adminForm.role !== 'STAFF',
                        manageNotifications: adminForm.role !== 'STAFF',
                        manageSettings: adminForm.role === 'SUPER_ADMIN',
                        manageAdmins: adminForm.role === 'SUPER_ADMIN',
                        executeReset: adminForm.role === 'SUPER_ADMIN',
                      },
                      active: adminForm.active,
                      createdAt: Date.now(),
                      updatedAt: Date.now(),
                    };
                    await upsertAdminUserBySuperAdmin(target, adminProfile);
                    setFeedback({ type: 'success', text: `Admin ${target.email} (${target.role}) berhasil disimpan.` });
                    await loadMenuRows(true);
                  } catch (err) {
                    setFeedback({ type: 'error', text: mapFriendlyError(err) });
                  } finally {
                    setBusy(false);
                  }
                }}
                className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-4"
              >
                <h2 className="font-display text-base font-bold text-white">Kelola Operator & Role RBAC</h2>
                <div className="grid sm:grid-cols-3 gap-3">
                  <input
                    type="text"
                    required
                    placeholder="Firebase Auth UID *"
                    value={adminForm.uid}
                    onChange={(e) => setAdminForm({ ...adminForm, uid: e.target.value })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                  />
                  <input
                    type="email"
                    required
                    placeholder="Email Admin / Operator *"
                    value={adminForm.email}
                    onChange={(e) => setAdminForm({ ...adminForm, email: e.target.value })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  />
                  <input
                    type="text"
                    required
                    placeholder="Nama Lengkap *"
                    value={adminForm.fullName}
                    onChange={(e) => setAdminForm({ ...adminForm, fullName: e.target.value })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  />
                  <select
                    value={adminForm.role}
                    onChange={(e) => setAdminForm({ ...adminForm, role: e.target.value as AdminRole })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  >
                    <option value="STAFF">STAFF (Kasir & Review)</option>
                    <option value="ADMIN">ADMIN (Operasional Penuh)</option>
                    <option value="SUPER_ADMIN">SUPER_ADMIN (Semua Izin)</option>
                  </select>
                  <select
                    value={adminForm.branchScope}
                    onChange={(e) => setAdminForm({ ...adminForm, branchScope: e.target.value as BranchId | 'ALL' })}
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  >
                    <option value="ALL">Semua Cabang</option>
                    <option value="DEMANG">Cabang DEMANG</option>
                    <option value="SEKIP">Cabang SEKIP</option>
                  </select>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={adminForm.active}
                      onChange={(e) => setAdminForm({ ...adminForm, active: e.target.checked })}
                    />
                    <span>Status Aktif</span>
                  </label>
                </div>
                <button type="submit" disabled={busy} className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-5 text-xs font-semibold text-white">
                  Simpan Admin
                </button>
              </form>

              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 divide-y divide-indigo-500/15">
                {(activeRows as AdminUser[]).map((a, idx) => (
                  <div key={a.uid || a.email || `adm-${idx}`} className="p-4 flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-bold text-white">{a.fullName} ({a.role})</p>
                      <p className="text-xs font-mono text-slate-400">
                        {a.email} · UID: {a.uid} · Cabang: {a.branchScope} · {a.active ? 'ACTIVE' : 'DISABLED'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setAdminForm({
                          uid: a.uid,
                          email: a.email,
                          fullName: a.fullName,
                          role: a.role,
                          branchScope: a.branchScope,
                          active: a.active,
                        })
                      }
                      className="text-xs font-semibold text-sky-300 hover:underline"
                    >
                      Edit
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 14. LEVELS */}
          {menu === 'levels' && isSuper && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  await saveLevelsByAdmin(levelDrafts, adminProfile);
                  await refreshProfiles();
                  setFeedback({ type: 'success', text: 'Threshold level berhasil diperbarui.' });
                } catch (err) {
                  setFeedback({ type: 'error', text: mapFriendlyError(err) });
                } finally {
                  setBusy(false);
                }
              }}
              className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-6 space-y-4"
            >
              <h2 className="font-display text-base font-bold text-white">
                Konfigurasi Threshold Level (Bronze &lt; Silver &lt; Juragan &lt; Sultan)
              </h2>
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {levelDrafts.map((lvl, idx) => (
                  <div key={lvl.id} className="rounded-xl border border-indigo-500/20 p-4 space-y-2">
                    <p className="font-display font-bold text-white">{lvl.name}</p>
                    <label className="block text-xs text-slate-400">Minimal XP Progress</label>
                    <input
                      type="number"
                      min={0}
                      value={lvl.minXp}
                      onChange={(e) => {
                        const updated = [...levelDrafts];
                        updated[idx] = { ...lvl, minXp: Math.max(0, Math.floor(Number(e.target.value) || 0)) };
                        setLevelDrafts(updated);
                      }}
                      className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                    />
                  </div>
                ))}
              </div>
              <button type="submit" disabled={busy} className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-5 text-xs font-semibold text-white">
                Simpan Konfigurasi Level
              </button>
            </form>
          )}

          {/* 15. XP SETTINGS */}
          {menu === 'xpSettings' && isSuper && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  await saveSystemSettingsByAdmin(settingsDraft, adminProfile);
                  await refreshProfiles();
                  setFeedback({ type: 'success', text: 'Konfigurasi XP berhasil disimpan.' });
                } catch (err) {
                  setFeedback({ type: 'error', text: mapFriendlyError(err) });
                } finally {
                  setBusy(false);
                }
              }}
              className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-6 space-y-4 max-w-2xl"
            >
              <h2 className="font-display text-base font-bold text-white">Pengaturan Formula & Bonus XP</h2>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-200 mb-1">
                    Rate Transaksi (Rupiah per 1 XP, default Rp2.000)
                  </label>
                  <input
                    type="number"
                    min={100}
                    value={settingsDraft.transactionXpRate}
                    onChange={(e) =>
                      setSettingsDraft({ ...settingsDraft, transactionXpRate: Math.floor(Number(e.target.value) || 2000) })
                    }
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-200 mb-1">Bonus Registrasi Baru (XP)</label>
                  <input
                    type="number"
                    min={0}
                    value={settingsDraft.registrationBonusXp}
                    onChange={(e) =>
                      setSettingsDraft({ ...settingsDraft, registrationBonusXp: Math.floor(Number(e.target.value) || 0) })
                    }
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-200 mb-1">Bonus Referral (XP untuk masing-masing)</label>
                  <input
                    type="number"
                    min={0}
                    value={settingsDraft.referralBonusXp}
                    onChange={(e) =>
                      setSettingsDraft({ ...settingsDraft, referralBonusXp: Math.floor(Number(e.target.value) || 0) })
                    }
                    className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                  />
                </div>
              </div>
              <button type="submit" disabled={busy} className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-5 text-xs font-semibold text-white">
                Simpan Pengaturan XP
              </button>
            </form>
          )}

          {/* 16. RESET / MEMBERSHIP CYCLE */}
          {menu === 'resetCycle' && isSuper && (
            <div className="space-y-6">
              <div className="grid lg:grid-cols-2 gap-6">
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setBusy(true);
                    try {
                      await saveSystemSettingsByAdmin(settingsDraft, adminProfile);
                      await refreshProfiles();
                      setFeedback({ type: 'success', text: 'Kebijakan reset otomatis diperbarui.' });
                    } catch (err) {
                      setFeedback({ type: 'error', text: mapFriendlyError(err) });
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-4"
                >
                  <h2 className="font-display text-base font-bold text-white">Kebijakan Reset Membership Cycle</h2>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <label className="flex items-center gap-2 col-span-2">
                      <input
                        type="checkbox"
                        checked={settingsDraft.resetEnabled}
                        onChange={(e) => setSettingsDraft({ ...settingsDraft, resetEnabled: e.target.checked })}
                      />
                      <span>Aktifkan Jadwal Reset Periodik</span>
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={settingsDraft.resetInterval}
                      onChange={(e) =>
                        setSettingsDraft({ ...settingsDraft, resetInterval: Math.max(1, Math.floor(Number(e.target.value) || 90)) })
                      }
                      className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                    />
                    <select
                      value={settingsDraft.resetUnit}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, resetUnit: e.target.value as 'DAYS' | 'MONTHS' })}
                      className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                    >
                      <option value="DAYS">Hari (30/60/90/180/365)</option>
                      <option value="MONTHS">Bulan</option>
                    </select>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={settingsDraft.resetXpProgress}
                        onChange={(e) => setSettingsDraft({ ...settingsDraft, resetXpProgress: e.target.checked })}
                      />
                      <span>Reset XP Progress</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={settingsDraft.resetXpReward}
                        onChange={(e) => setSettingsDraft({ ...settingsDraft, resetXpReward: e.target.checked })}
                      />
                      <span>Reset XP Reward</span>
                    </label>
                    <label className="flex items-center gap-2 col-span-2">
                      <input
                        type="checkbox"
                        checked={settingsDraft.resetLevel}
                        onChange={(e) => setSettingsDraft({ ...settingsDraft, resetLevel: e.target.checked })}
                      />
                      <span>Reset Level ke Bronze</span>
                    </label>
                  </div>
                  <button type="submit" disabled={busy} className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-5 text-xs font-semibold text-white">
                    Simpan Kebijakan Reset
                  </button>
                </form>

                <form onSubmit={handleExecuteReset} className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-4">
                  <h2 className="font-display text-base font-bold text-white">Eksekusi Tutup Cycle & Mulai Season Baru</h2>
                  <p className="text-xs text-slate-300">
                    Cycle aktif saat ini: <strong className="font-mono">{systemSettings.currentCycleId}</strong>. Proses bersifat idempoten dan tidak menghapus ledger, transaksi, atau riwayat lama.
                  </p>
                  <div className="space-y-3">
                    <input
                      type="text"
                      required
                      placeholder="ID Cycle Baru (misal: 2026-S2)"
                      value={resetForm.nextCycleId}
                      onChange={(e) => setResetForm({ ...resetForm, nextCycleId: e.target.value })}
                      className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                    />
                    <input
                      type="text"
                      required
                      placeholder="Nama Season Baru"
                      value={resetForm.nextCycleName}
                      onChange={(e) => setResetForm({ ...resetForm, nextCycleName: e.target.value })}
                      className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                    />
                    <input
                      type="text"
                      required
                      placeholder="Alasan reset"
                      value={resetForm.resetReason}
                      onChange={(e) => setResetForm({ ...resetForm, resetReason: e.target.value })}
                      className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                    />
                  </div>
                  <button type="submit" disabled={busy} className="h-10 rounded-xl bg-rose-600 px-5 text-xs font-semibold text-white hover:bg-rose-500">
                    {busy ? 'Memproses...' : 'Jalankan Reset Cycle'}
                  </button>
                </form>
              </div>

              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 divide-y divide-indigo-500/15">
                <div className="p-4 font-display text-sm font-bold text-white">Snapshot Riwayat Reset Cycle</div>
                {(activeRows as CycleSnapshot[]).map((s, idx) => (
                  <div key={s.id || `cyc-${idx}`} className="p-3.5 text-xs flex items-center justify-between gap-4">
                    <div>
                      <p className="font-semibold text-white">
                        @{s.memberUsername} · {s.cycleId} → {s.nextCycleId}
                      </p>
                      <p className="text-slate-400">
                        Sebelum: Progress {s.previousXpProgress}, Reward {s.previousXpReward}, Level {s.previousLevel}
                      </p>
                    </div>
                    <span className="font-mono text-slate-400">{formatJakartaDateTime(s.resetAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 17. BRANCHES */}
          {menu === 'branches' && isSuper && (
            <div className="grid md:grid-cols-2 gap-6">
              {branches.map((br) => (
                <BranchCardEditor
                  key={br.id}
                  branch={br}
                  onSave={async (updated) => {
                    await upsertBranchByAdmin(updated, adminProfile);
                    await refreshProfiles();
                    setFeedback({ type: 'success', text: `Cabang ${updated.name} diperbarui.` });
                  }}
                />
              ))}
            </div>
          )}

          {/* 18. AUDIT LOGS */}
          {menu === 'auditLogs' && (
            <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 divide-y divide-indigo-500/15">
              {(activeRows as AuditLogRecord[]).map((log, idx) => (
                <div key={log.id || `log-${idx}`} className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                  <div>
                    <p className="font-mono font-bold text-white">
                      {log.action} · {log.targetType}:{log.targetId}
                    </p>
                    <p className="text-slate-400">
                      Actor: {log.actorId} ({log.actorRole})
                    </p>
                  </div>
                  <span className="font-mono text-slate-400">{formatJakartaDateTime(log.timestamp)} WIB</span>
                </div>
              ))}
              {hasMore && (
                <div className="p-3 text-center">
                  <button type="button" onClick={() => void loadMenuRows(false)} className="text-xs font-semibold underline">
                    Muat Lebih Banyak
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 19. SETTINGS & REPORTING */}
          {menu === 'settings' && (
            <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-lg font-bold text-white">Ringkasan Laporan & Konfigurasi Sistem</h2>
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              </div>
              <div className="grid sm:grid-cols-2 gap-4 text-sm">
                <div className="rounded-xl bg-[#070B19] border border-indigo-500/20 p-4 space-y-1">
                  <p className="text-xs text-slate-400">Status Server Authoritative</p>
                  <p className="font-semibold text-white">
                    {capabilities.adminSdkConfigured
                      ? 'Firebase Admin SDK Aktif (Full Server Mode)'
                      : 'Client Verified Admin + Server Token Guard (Preview Mode)'}
                  </p>
                </div>
                <div className="rounded-xl bg-[#070B19] border border-indigo-500/20 p-4 space-y-1">
                  <p className="text-xs text-slate-400">Mode CAPTCHA Server</p>
                  <p className="font-semibold text-white">
                    {capabilities.recaptchaConfigured
                      ? 'Google reCAPTCHA Aktif'
                      : 'HMAC-Signed Server SVG Challenge Aktif'}
                  </p>
                </div>
              </div>
              {metrics && (
                <div className="rounded-xl border border-indigo-500/20 p-4 text-sm space-y-1.5">
                  <p className="font-semibold text-white">Ringkasan Agregat Cabang & Aktivitas</p>
                  <p className="text-slate-300">
                    Total Member: <strong className="font-mono">{metrics.totalMembers}</strong> · Active: <strong className="font-mono">{metrics.activeMembers}</strong> · Total Transaksi: <strong className="font-mono">{metrics.totalTransactions}</strong>
                  </p>
                  <p className="text-slate-300">
                    25 Transaksi Terakhir: <strong className="font-mono">{formatIdr(metrics.recentTxAmount)}</strong> ({metrics.recentXpDistributed} XP diterbitkan)
                  </p>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* Edit Member Modal */}
      {editMemberTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <form onSubmit={handleSaveEditMember} className="w-full max-w-md bg-[#0B1124] rounded-2xl border border-indigo-500/30 p-6 space-y-4">
            <h3 className="font-display text-lg font-bold text-white">
              Edit Member @{editMemberTarget.username}
            </h3>
            <input
              type="text"
              required
              value={editMemberPatch.fullName}
              onChange={(e) => setEditMemberPatch({ ...editMemberPatch, fullName: e.target.value })}
              className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
            />
            <input
              type="text"
              value={editMemberPatch.socialMedia}
              onChange={(e) => setEditMemberPatch({ ...editMemberPatch, socialMedia: e.target.value })}
              placeholder="Sosial Media"
              className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
            />
            <select
              value={editMemberPatch.preferredBranch}
              onChange={(e) => setEditMemberPatch({ ...editMemberPatch, preferredBranch: e.target.value as BranchId })}
              className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
            >
              <option value="DEMANG">DEMANG</option>
              <option value="SEKIP">SEKIP</option>
            </select>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setEditMemberTarget(null)}
                className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none flex-1 h-10 rounded-xl border border-indigo-500/30 text-xs font-semibold"
              >
                Batal
              </button>
              <button type="submit" disabled={busy} className="flex-1 h-10 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-xs font-semibold text-white">
                Simpan
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Deny Reason Modal */}
      {denyTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#0B1124] rounded-2xl border border-indigo-500/30 p-6 space-y-4">
            <h3 className="font-display text-lg font-bold text-white">
              Tolak {denyTarget.kind === 'claim' ? 'Claim' : 'Redemption'}: {denyTarget.title}
            </h3>
            <textarea
              rows={3}
              required
              placeholder="Tuliskan alasan penolakan untuk member..."
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none w-full rounded-xl border border-indigo-500/30 p-3 text-sm"
            />
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setDenyTarget(null)}
                className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none flex-1 h-10 rounded-xl border border-indigo-500/30 text-xs font-semibold"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleReviewDecision(denyTarget.kind, denyTarget.id, 'DENIED', denyReason)}
                className="flex-1 h-10 rounded-xl bg-rose-600 text-xs font-semibold text-white"
              >
                Konfirmasi Tolak
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BranchCardEditor({
  branch,
  onSave,
}: {
  branch: BranchInfo;
  onSave: (updated: BranchInfo) => Promise<void>;
}) {
  const [draft, setDraft] = useState(branch);
  const [saving, setSaving] = useState(false);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await onSave(draft);
        } finally {
          setSaving(false);
        }
      }}
      className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-3"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-display font-bold text-white">{branch.id}</h3>
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
          />
          <span>Aktif</span>
        </label>
      </div>
      <input
        type="text"
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
      />
      <input
        type="text"
        value={draft.subtitle}
        onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })}
        className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
      />
      <input
        type="text"
        value={draft.whatsapp}
        onChange={(e) => setDraft({ ...draft, whatsapp: e.target.value })}
        className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
      />
      <input
        type="url"
        value={draft.mapsUrl}
        onChange={(e) => setDraft({ ...draft, mapsUrl: e.target.value })}
        className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-xs"
      />
      <button type="submit" disabled={saving} className="h-9 rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 px-4 text-xs font-semibold text-white">
        {saving ? 'Menyimpan...' : 'Simpan Cabang'}
      </button>
    </form>
  );
}
