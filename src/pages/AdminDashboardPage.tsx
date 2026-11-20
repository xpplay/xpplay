import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Activity,
  Award,
  BarChart3,
  Bell,
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  CreditCard,
  Crown,
  Database,
  FileCheck2,
  Gift,
  Globe,
  History,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  RefreshCw,
  Shield,
  Sliders,
  SlidersHorizontal,
  Sparkles,
  Tag,
  TicketCheck,
  Trophy,
  UserCog,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { where, type DocumentData, type QueryConstraint, type QueryDocumentSnapshot } from 'firebase/firestore';
import { AdminBackupRestore } from '../components/AdminBackupRestore.tsx';
import { AdminBenefitRequests } from '../components/AdminBenefitRequests.tsx';
import { AdminCmsEditor } from '../components/AdminCmsEditor.tsx';
import { AdminInactiveMembers } from '../components/AdminInactiveMembers.tsx';
import { AdminLevelOverride } from '../components/AdminLevelOverride.tsx';
import { AdminMemberDetail } from '../components/AdminMemberDetail.tsx';
import { AdminPasswordManagement } from '../components/AdminPasswordManagement.tsx';
import { AdminXpAdjustment } from '../components/AdminXpAdjustment.tsx';
import { AdminXpHistory } from '../components/AdminXpHistory.tsx';
import { ProtectedImage } from '../components/ProtectedImage.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import {
  createAndDispatchNotificationByAdmin,
  createMemberByAdmin,
  executeCycleResetByAdmin,
  fetchAdminSummaryMetrics,
  fetchMembersBatchForFilter,
  fetchNewMembersOverview,
  fetchPaginatedCollection,
  fetchTransactionsBatchForFilter,
  preRegisterCustomerClient,
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
  CASHIER_SLOT_TEMPLATES,
  getDefaultPermissionsForRole,
  isCashierRole,
  ROLE_PERMISSION_MATRIX_ROWS,
} from '../shared/rbac.ts';
import {
  filterAndSortMembers,
  filterAndSortTransactions,
  formatBirthDateJakarta,
  getJakartaTodayDateString,
  getMemberCategoryLabel,
  MEMBER_CATEGORIES,
  type MemberSortOption,
  type TransactionDatePreset,
  type TransactionSortOption,
} from '../shared/benefitRequestLogic.ts';
import {
  calculateTransactionXp,
  formatDateTimeLocalInput,
  formatIdr,
  formatJakartaDateTime,
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
  MemberCategory,
  MemberProfile,
  MemberStatus,
  NotificationCampaign,
  RedemptionRecord,
  SystemSettings,
  TransactionRecord,
} from '../types/xpplay.ts';

type AdminMenu =
  | 'dashboard'
  | 'benefitRequests'
  | 'members'
  | 'inactiveMembers'
  | 'passwordManagement'
  | 'transactions'
  | 'xpAdjustment'
  | 'levelOverride'
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
  | 'cmsHomepage'
  | 'backupRestore'
  | 'auditLogs'
  | 'settings';

const MENU_ITEMS: { id: AdminMenu; label: string; icon: typeof LayoutDashboard; superOnly?: boolean }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'benefitRequests', label: 'Benefit Requests & Kasir', icon: TicketCheck },
  { id: 'members', label: 'Members', icon: Users },
  { id: 'inactiveMembers', label: 'Inactive Members', icon: Clock },
  { id: 'passwordManagement', label: 'Password Member', icon: KeyRound },
  { id: 'transactions', label: 'Transactions', icon: CreditCard },
  { id: 'xpAdjustment', label: 'XP Adjustment', icon: SlidersHorizontal },
  { id: 'levelOverride', label: 'Level Override', icon: Crown },
  { id: 'xpHistory', label: 'XP History', icon: History },
  { id: 'levelHistory', label: 'Level Up History', icon: Trophy },
  { id: 'claims', label: 'Legacy Claims', icon: FileCheck2 },
  { id: 'redemptions', label: 'Legacy Redemptions', icon: Gift },
  { id: 'benefits', label: 'Benefits', icon: Award },
  { id: 'challenges', label: 'Challenges', icon: Sparkles },
  { id: 'events', label: 'Events', icon: Calendar },
  { id: 'promos', label: 'Promos', icon: Tag },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'cmsHomepage', label: 'CMS Homepage', icon: Globe },
  { id: 'backupRestore', label: 'Backup & Restore', icon: Database, superOnly: true },
  { id: 'adminManagement', label: 'Admin Management', icon: UserCog, superOnly: true },
  { id: 'levels', label: 'Levels', icon: Sliders, superOnly: true },
  { id: 'xpSettings', label: 'XP Settings', icon: Activity, superOnly: true },
  { id: 'resetCycle', label: 'Reset / Membership Cycle', icon: RefreshCw, superOnly: true },
  { id: 'branches', label: 'Branches', icon: Building2, superOnly: true },
  { id: 'auditLogs', label: 'Audit Logs', icon: Shield },
  { id: 'settings', label: 'Settings & Reporting', icon: BarChart3 },
];

export function AdminDashboardPage({ mode = 'ADMIN' }: { mode?: 'ADMIN' | 'SUPER_ADMIN' } = {}) {
  const { adminProfile, levels, branches, systemSettings, restoreLock, capabilities, logout, refreshProfiles } = useAuth();
  const _consoleMode = mode;
  void _consoleMode;
  const [menu, setMenu] = useState<AdminMenu>('dashboard');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [newMemberViewMode, setNewMemberViewMode] = useState<'ACTIVE' | 'PRE_REGISTERED'>('ACTIVE');

  // Admin Quick Pre-Register Customer (Stage 1)
  const [showPreRegister, setShowPreRegister] = useState(false);
  const [adminPreRegWa, setAdminPreRegWa] = useState('');
  const [adminPreRegBranch, setAdminPreRegBranch] = useState<BranchId>('DEMANG');
  const [adminPreRegNotes, setAdminPreRegNotes] = useState('');
  const [adminPreRegCode, setAdminPreRegCode] = useState<{
    memberId: string;
    whatsapp: string;
    code: string;
    url: string;
    waMsg: string;
  } | null>(null);

  // Dashboard metrics & New Members Overview (FASE 18)
  const [metrics, setMetrics] = useState<Awaited<ReturnType<typeof fetchAdminSummaryMetrics>> | null>(null);
  const [newMembersOverview, setNewMembersOverview] = useState<Awaited<ReturnType<typeof fetchNewMembersOverview>> | null>(null);
  const [loadingMetrics, setLoadingMetrics] = useState(false);

  // 8-Tab Member Detail Drawer (FASE 10)
  const [detailMemberUid, setDetailMemberUid] = useState<string | null>(null);

  // Generic paginated list state for legacy / other views
  const [rows, setRows] = useState<unknown[]>([]);
  const [rowsOwnerKey, setRowsOwnerKey] = useState<string>('');
  const [cursor, setCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const fetchSeqRef = useRef(0);

  // Filters (Legacy)
  const [statusFilter, setStatusFilter] = useState<string>('ON_PROCESS');

  // FASE 9: Advanced Members Filter / Search / Sort / Pagination
  const [allMembers, setAllMembers] = useState<MemberProfile[]>([]);
  const [loadingMembersBatch, setLoadingMembersBatch] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [memberFilterLevel, setMemberFilterLevel] = useState<'ALL' | LevelId>('ALL');
  const [memberFilterStatus, setMemberFilterStatus] = useState<'ALL' | MemberStatus>('ALL');
  const [memberFilterBranch, setMemberFilterBranch] = useState<'ALL' | BranchId>('ALL');
  const [memberFilterCategory, setMemberFilterCategory] = useState<'ALL' | MemberCategory>('ALL');
  const [memberFilterFrom, setMemberFilterFrom] = useState('');
  const [memberFilterTo, setMemberFilterTo] = useState('');
  const [memberSort, setMemberSort] = useState<MemberSortOption>('NEWEST');
  const [memberPage, setMemberPage] = useState(1);

  // FASE 11: Advanced Transactions Filter / Search / Sort / Pagination
  const [allTransactions, setAllTransactions] = useState<TransactionRecord[]>([]);
  const [loadingTxBatch, setLoadingTxBatch] = useState(false);
  const [txSearch, setTxSearch] = useState('');
  const [txBranchFilter, setTxBranchFilter] = useState<'ALL' | BranchId>('ALL');
  const [txDatePreset, setTxDatePreset] = useState<TransactionDatePreset>('ALL');
  const [txDateFrom, setTxDateFrom] = useState('');
  const [txDateTo, setTxDateTo] = useState('');
  const [txSort, setTxSort] = useState<TransactionSortOption>('NEWEST');
  const [txPage, setTxPage] = useState(1);

  // Forms: Add Member (with Birth Date & Member Status)
  const [showAddMember, setShowAddMember] = useState(false);
  const [newMember, setNewMember] = useState({
    fullName: '',
    username: '',
    whatsapp: '',
    socialMedia: '',
    birthDate: '',
    memberCategory: '' as '' | MemberCategory,
    referralUsername: '',
    preferredBranch: 'DEMANG' as BranchId,
  });

  // Forms: Edit Member modal (with Birth Date & Member Status)
  const [editMemberTarget, setEditMemberTarget] = useState<MemberProfile | null>(null);
  const [editMemberPatch, setEditMemberPatch] = useState({
    fullName: '',
    socialMedia: '',
    preferredBranch: 'DEMANG' as BranchId,
    birthDate: '',
    memberCategory: '' as '' | MemberCategory,
  });
  const [xpAdjustmentInitialMember, setXpAdjustmentInitialMember] = useState<MemberProfile | null>(null);
  const [levelOverrideInitialMember, setLevelOverrideInitialMember] = useState<MemberProfile | null>(null);
  const [passwordInitialMember, setPasswordInitialMember] = useState<MemberProfile | null>(null);

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
  const [benefitOriginalMeta, setBenefitOriginalMeta] = useState<{ createdAt: number; createdBy: string } | null>(null);
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
  const [campaignOriginalMeta, setCampaignOriginalMeta] = useState<{
    createdAt: number;
    createdBy: string;
    claimsCount: number;
  } | null>(null);
  const makeDefaultCampaignForm = () => ({
    id: '',
    title: '',
    description: '',
    xpReward: '25',
    startAt: formatDateTimeLocalInput(Date.now()),
    endAt: formatDateTimeLocalInput(Date.now() + 7 * 24 * 60 * 60 * 1000),
    terms: '',
    maxClaimsPerMember: '1',
    totalClaimLimit: '',
    requiresEvidence: true,
    status: 'ACTIVE' as CampaignStatus,
    active: true,
  });
  const [campaignForm, setCampaignForm] = useState(makeDefaultCampaignForm);

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
  const [adminOriginalCreatedAt, setAdminOriginalCreatedAt] = useState<number | null>(null);
  const [adminForm, setAdminForm] = useState({
    uid: '',
    email: '',
    fullName: '',
    role: 'CASHIER' as AdminRole,
    branchScope: 'DEMANG' as BranchId | 'ALL',
    cashierCode: '',
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
      const [data, newMem] = await Promise.all([
        fetchAdminSummaryMetrics(),
        fetchNewMembersOverview(),
      ]);
      setMetrics(data);
      setNewMembersOverview(newMem);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setLoadingMetrics(false);
    }
  };

  const loadMembersBatch = async () => {
    setLoadingMembersBatch(true);
    try {
      const list = await fetchMembersBatchForFilter(500);
      setAllMembers(list);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setLoadingMembersBatch(false);
    }
  };

  const loadTransactionsBatch = async () => {
    setLoadingTxBatch(true);
    try {
      const [txList, memList] = await Promise.all([
        fetchTransactionsBatchForFilter(500),
        allMembers.length > 0 ? Promise.resolve(allMembers) : fetchMembersBatchForFilter(500),
      ]);
      setAllTransactions(txList);
      if (allMembers.length === 0) setAllMembers(memList);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setLoadingTxBatch(false);
    }
  };

  const currentQueryKey = `${menu}:${statusFilter}`;
  const activeRows = rowsOwnerKey === currentQueryKey ? rows : [];

  const loadMenuRows = async (reset: boolean) => {
    if (
      menu === 'dashboard' ||
      menu === 'benefitRequests' ||
      menu === 'members' ||
      menu === 'transactions' ||
      menu === 'xpHistory' ||
      menu === 'inactiveMembers' ||
      menu === 'passwordManagement' ||
      menu === 'xpAdjustment' ||
      menu === 'levelOverride' ||
      menu === 'levels' ||
      menu === 'xpSettings' ||
      menu === 'branches' ||
      menu === 'settings' ||
      menu === 'cmsHomepage' ||
      menu === 'backupRestore'
    ) {
      return;
    }
    const seq = ++fetchSeqRef.current;
    const requestKey = `${menu}:${statusFilter}`;
    if (reset) {
      setRows([]);
      setCursor(null);
      setHasMore(false);
    }
    setLoadingRows(true);
    try {
      let colName = 'levelHistory';
      let orderByField = 'createdAt';
      let orderDirection: 'asc' | 'desc' = 'desc';
      const constraints: QueryConstraint[] = [];

      if (menu === 'levelHistory') {
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
        orderDirection = 'asc';
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
        orderDirection,
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
    setCampaignForm(makeDefaultCampaignForm());
    setCampaignOriginalMeta(null);
  }, [menu]);

  useEffect(() => {
    if (menu === 'dashboard' || menu === 'settings') {
      void loadDashboardMetrics();
    } else if (menu === 'members') {
      void loadMembersBatch();
    } else if (menu === 'transactions') {
      void loadTransactionsBatch();
    } else {
      void loadMenuRows(true);
    }
  }, [menu, statusFilter]);

  useEffect(() => {
    setMemberPage(1);
  }, [
    memberSearch,
    memberFilterLevel,
    memberFilterStatus,
    memberFilterBranch,
    memberFilterCategory,
    memberFilterFrom,
    memberFilterTo,
    memberSort,
  ]);

  useEffect(() => {
    setTxPage(1);
  }, [txSearch, txBranchFilter, txDatePreset, txDateFrom, txDateTo, txSort]);

  const memberMapByUid = useMemo(() => {
    const map = new Map<string, MemberProfile>();
    for (const m of allMembers) map.set(m.uid, m);
    return map;
  }, [allMembers]);

  const filteredMembers = useMemo(() => {
    const fromMs = memberFilterFrom ? new Date(`${memberFilterFrom}T00:00:00+07:00`).getTime() : null;
    const toMs = memberFilterTo ? new Date(`${memberFilterTo}T23:59:59+07:00`).getTime() : null;
    return filterAndSortMembers(
      allMembers,
      {
        search: memberSearch,
        level: memberFilterLevel,
        status: memberFilterStatus,
        branch: memberFilterBranch,
        memberCategory: memberFilterCategory,
        registeredFromMs: Number.isFinite(fromMs ?? NaN) ? fromMs : null,
        registeredToMs: Number.isFinite(toMs ?? NaN) ? toMs : null,
        sort: memberSort,
      },
      levels
    );
  }, [
    allMembers,
    memberSearch,
    memberFilterLevel,
    memberFilterStatus,
    memberFilterBranch,
    memberFilterCategory,
    memberFilterFrom,
    memberFilterTo,
    memberSort,
    levels,
  ]);

  const memberTotalPages = Math.max(1, Math.ceil(filteredMembers.length / 20));
  const pagedMembers = filteredMembers.slice((memberPage - 1) * 20, memberPage * 20);

  const filteredTransactions = useMemo(() => {
    const fromMs = txDateFrom ? new Date(`${txDateFrom}T00:00:00+07:00`).getTime() : null;
    const toMs = txDateTo ? new Date(`${txDateTo}T23:59:59+07:00`).getTime() : null;
    return filterAndSortTransactions(
      allTransactions,
      {
        search: txSearch,
        branch: txBranchFilter,
        datePreset: txDatePreset,
        dateFromMs: Number.isFinite(fromMs ?? NaN) ? fromMs : null,
        dateToMs: Number.isFinite(toMs ?? NaN) ? toMs : null,
        sort: txSort,
      },
      memberMapByUid
    );
  }, [allTransactions, txSearch, txBranchFilter, txDatePreset, txDateFrom, txDateTo, txSort, memberMapByUid]);

  const txTotalPages = Math.max(1, Math.ceil(filteredTransactions.length / 20));
  const pagedTransactions = filteredTransactions.slice((txPage - 1) * 20, txPage * 20);
  const todayJakarta = getJakartaTodayDateString();

  if (!adminProfile) return null;
  const isSuper = adminProfile.role === 'SUPER_ADMIN';
  const canManageCatalog = isSuper || adminProfile.role === 'ADMIN';
  const canManageMembers = isSuper || adminProfile.role === 'ADMIN' || Boolean(adminProfile.permissions?.manageMembers);

  const handleAddMember = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const res = await createMemberByAdmin({
        fullName: newMember.fullName,
        username: newMember.username,
        whatsapp: newMember.whatsapp,
        socialMedia: newMember.socialMedia,
        birthDate: newMember.birthDate || null,
        memberCategory: newMember.memberCategory || null,
        referralUsername: newMember.referralUsername,
        preferredBranch: newMember.preferredBranch,
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
        birthDate: '',
        memberCategory: '',
        referralUsername: '',
        preferredBranch: 'DEMANG',
      });
      await loadMembersBatch();
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleMemberStatusChange = async (uid: string, status: MemberStatus) => {
    setBusy(true);
    setFeedback(null);
    try {
      await updateMemberStatusByAdmin(uid, status, adminProfile);
      setFeedback({ type: 'success', text: `Status member berhasil diubah ke ${status}.` });
      await loadMembersBatch();
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
      await updateMemberDetailsByAdmin(
        editMemberTarget.uid,
        {
          fullName: editMemberPatch.fullName,
          socialMedia: editMemberPatch.socialMedia,
          preferredBranch: editMemberPatch.preferredBranch,
          birthDate: editMemberPatch.birthDate || null,
          memberCategory: editMemberPatch.memberCategory || null,
        },
        adminProfile
      );
      setEditMemberTarget(null);
      setFeedback({ type: 'success', text: 'Data member diperbarui.' });
      await loadMembersBatch();
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
      await loadTransactionsBatch();
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

  const resetBenefitForm = () => {
    setBenefitOriginalMeta(null);
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
  };

  const handleSaveBenefit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const now = Date.now();
      const id = benefitForm.id || `ben_${now}`;
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
        createdBy: benefitOriginalMeta?.createdBy || adminProfile.uid,
        createdAt: benefitOriginalMeta?.createdAt || now,
        updatedAt: now,
      };
      await upsertBenefitByAdmin(item, adminProfile);
      resetBenefitForm();
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
      const totalClaimLimit =
        campaignForm.totalClaimLimit.trim() === ''
          ? null
          : Math.max(1, Math.floor(Number(campaignForm.totalClaimLimit) || 1));
      const now = Date.now();
      const id = campaignForm.id || `camp_${now}`;
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
        totalClaimLimit,
        claimsCount: campaignOriginalMeta?.claimsCount ?? 0,
        active: campaignForm.status === 'ACTIVE',
        status: campaignForm.status,
        requiresEvidence: campaignForm.requiresEvidence,
        createdBy: campaignOriginalMeta?.createdBy || adminProfile.uid,
        createdAt: campaignOriginalMeta?.createdAt || now,
        updatedAt: now,
      };
      await upsertCampaignByAdmin(item, adminProfile);
      setFeedback({ type: 'success', text: `${type} "${item.title}" berhasil disimpan.` });
      setCampaignForm(makeDefaultCampaignForm());
      setCampaignOriginalMeta(null);
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
              onClick={() => {
                if (menu === 'dashboard' || menu === 'settings') void loadDashboardMetrics();
                else if (menu === 'members') void loadMembersBatch();
                else if (menu === 'transactions') void loadTransactionsBatch();
                else void loadMenuRows(true);
              }}
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
          {restoreLock?.locked && (
            <div
              role="alert"
              className="rounded-xl border border-amber-500/50 bg-amber-950/40 p-4 text-xs sm:text-sm text-amber-100 flex flex-wrap items-center justify-between gap-3"
            >
              <div>
                <strong className="text-amber-300">RESTORE LOCK AKTIF:</strong>{' '}
                {restoreLock.message ||
                  'XP PLAY sedang melakukan maintenance sistem. Silakan kembali beberapa saat lagi.'}{' '}
                Seluruh operasi tulis transaksi, XP, claim, dan redemption diblokir sementara.
              </div>
              {isSuper && (
                <button
                  type="button"
                  onClick={() => setMenu('backupRestore')}
                  className="px-3 py-1.5 rounded-lg bg-amber-500 text-slate-950 font-semibold text-xs whitespace-nowrap"
                >
                  Buka Backup & Restore
                </button>
              )}
            </div>
          )}

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

          {/* 1. DASHBOARD (FASE 18 + BENEFIT REQUEST KPI) */}
          {menu === 'dashboard' && (
            <div className="space-y-6">
              {loadingMetrics && !metrics ? (
                <div className="h-40 rounded-2xl bg-[#0B1124] border border-indigo-500/20 animate-pulse" />
              ) : metrics ? (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
                    <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-4">
                      <p className="text-xs text-slate-400">Active / Pre-Reg</p>
                      <p className="mt-1 font-mono text-2xl font-bold text-white tabular-nums">
                        {metrics.activeMembers} / <span className="text-amber-300">{metrics.preRegisteredMembers}</span>
                      </p>
                      <p className="text-[11px] text-slate-400 font-mono">Total: {metrics.totalMembers}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setMenu('benefitRequests')}
                      className="text-left bg-[#0B1124] rounded-2xl border border-sky-500/35 p-4 hover:border-sky-400 transition-colors"
                    >
                      <p className="text-xs text-sky-300">Benefit Req (Pending / Aktif)</p>
                      <p className="mt-1 font-mono text-2xl font-bold text-white tabular-nums">
                        {metrics.pendingBenefitRequests} / {metrics.approvedBenefitRequests}
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMemberFilterStatus('PRE_REGISTERED');
                        setMenu('members');
                      }}
                      className="text-left bg-[#0B1124] rounded-2xl border border-amber-500/35 p-4 hover:border-amber-400 transition-colors"
                    >
                      <p className="text-xs text-amber-300">NEW PRE-REGISTERED (1/7/30 Hr)</p>
                      <p className="mt-1 font-mono text-xl font-bold text-amber-200 tabular-nums">
                        {metrics.newPreRegisteredToday} / {metrics.newPreRegistered7d} / {metrics.newPreRegistered30d}
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMemberFilterStatus('ACTIVE');
                        setMenu('members');
                      }}
                      className="text-left bg-[#0B1124] rounded-2xl border border-emerald-500/35 p-4 hover:border-emerald-400 transition-colors"
                    >
                      <p className="text-xs text-emerald-300">NEW ACTIVE MEMBERS (1/7/30 Hr)</p>
                      <p className="mt-1 font-mono text-xl font-bold text-emerald-200 tabular-nums">
                        {metrics.newActiveToday} / {metrics.newActive7d} / {metrics.newActive30d}
                      </p>
                    </button>
                    <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-4">
                      <p className="text-xs text-slate-400">Total Transaksi</p>
                      <p className="mt-1 font-mono text-2xl font-bold text-white tabular-nums">
                        {metrics.totalTransactions}
                      </p>
                    </div>
                    <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-4">
                      <p className="text-xs text-slate-400">Inaktif (7 / 14 / 30 Hr)</p>
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

                  {/* FASE 28: Split New Members (PRE_REGISTERED vs ACTIVE) + Alerts */}
                  <div className="grid lg:grid-cols-2 gap-6">
                    <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
                          <UserPlus className="w-4 h-4 text-emerald-400" />
                          <span>Member Baru (Split Status)</span>
                        </h2>
                        <div className="flex items-center gap-1 rounded-lg bg-[#070B19] p-1 border border-indigo-500/25">
                          <button
                            type="button"
                            onClick={() => setNewMemberViewMode('ACTIVE')}
                            className={`px-2.5 py-1 rounded text-[11px] font-semibold ${
                              newMemberViewMode === 'ACTIVE'
                                ? 'bg-emerald-500 text-slate-950'
                                : 'text-slate-400 hover:text-white'
                            }`}
                          >
                            NEW ACTIVE ({newMembersOverview?.newestActiveMembers?.length ?? 0})
                          </button>
                          <button
                            type="button"
                            onClick={() => setNewMemberViewMode('PRE_REGISTERED')}
                            className={`px-2.5 py-1 rounded text-[11px] font-semibold ${
                              newMemberViewMode === 'PRE_REGISTERED'
                                ? 'bg-amber-400 text-slate-950'
                                : 'text-slate-400 hover:text-white'
                            }`}
                          >
                            PRE-REGISTERED ({newMembersOverview?.newestPreRegistered?.length ?? 0})
                          </button>
                        </div>
                      </div>
                      {(() => {
                        const list =
                          newMemberViewMode === 'PRE_REGISTERED'
                            ? newMembersOverview?.newestPreRegistered ?? []
                            : newMembersOverview?.newestActiveMembers ?? [];
                        if (list.length === 0) {
                          return (
                            <p className="text-xs text-slate-400">
                              Belum ada member pada kategori {newMemberViewMode === 'PRE_REGISTERED' ? 'PRE_REGISTERED' : 'ACTIVE'}.
                            </p>
                          );
                        }
                        return (
                          <div className="divide-y divide-indigo-500/15">
                            {list.slice(0, 6).map((nm) => (
                              <div key={nm.uid} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                                <div className="min-w-0">
                                  <p className="font-semibold text-white truncate">
                                    {nm.fullName}{' '}
                                    <span className="font-mono text-sky-300">
                                      {nm.username ? `@${nm.username}` : nm.whatsapp}
                                    </span>
                                  </p>
                                  <p className="text-[11px] text-slate-400 font-mono">
                                    <span className={nm.status === 'PRE_REGISTERED' ? 'text-amber-300' : 'text-emerald-300'}>
                                      {nm.status === 'PRE_REGISTERED' ? 'Belum menyelesaikan profil' : 'Membership Aktif'}
                                    </span>{' '}
                                    · {nm.branchId || nm.preferredBranch || '-'} · {nm.xpProgress} XP ·{' '}
                                    {formatJakartaDateTime(nm.registrationCompletedAt ?? nm.preRegisteredAt ?? nm.createdAt)}
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setDetailMemberUid(nm.uid)}
                                  className="px-2.5 py-1.5 rounded-lg border border-indigo-500/30 bg-[#070B19] text-sky-300 hover:border-sky-400 font-semibold whitespace-nowrap shrink-0"
                                >
                                  View Member
                                </button>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>

                    <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-3">
                      <div className="flex items-center justify-between">
                        <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
                          <Bell className="w-4 h-4 text-purple-400" />
                          <span>Notifikasi Member Baru</span>
                        </h2>
                        <span className="font-mono text-[11px] text-slate-400">NEW_MEMBER_REGISTERED</span>
                      </div>
                      {!newMembersOverview || newMembersOverview.alerts.length === 0 ? (
                        <p className="text-xs text-slate-400">
                          Belum ada alert pendaftaran member baru di koleksi notifikasi.
                        </p>
                      ) : (
                        <div className="divide-y divide-indigo-500/15">
                          {newMembersOverview.alerts.slice(0, 6).map((al) => (
                            <div key={al.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                              <div className="min-w-0">
                                <p className="font-semibold text-white truncate">{al.title}</p>
                                <p className="text-slate-300 truncate">{al.message}</p>
                                <p className="font-mono text-[11px] text-slate-400">
                                  {formatJakartaDateTime(al.createdAt)}
                                </p>
                              </div>
                              {(al.memberUid || al.targetFilter) && (
                                <button
                                  type="button"
                                  onClick={() => setDetailMemberUid(al.memberUid || al.targetFilter)}
                                  className="px-2.5 py-1.5 rounded-lg border border-purple-500/35 bg-[#070B19] text-purple-300 hover:border-purple-400 font-semibold whitespace-nowrap shrink-0"
                                >
                                  View Member
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
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
                                <td className="py-2.5 pr-4 font-mono text-xs">
                                  <button
                                    type="button"
                                    onClick={() => setDetailMemberUid(t.memberUid)}
                                    className="text-sky-300 hover:underline"
                                  >
                                    @{t.memberUsername}
                                  </button>
                                </td>
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

          {/* 1B. UNIFIED BENEFIT REQUESTS & CASHIER VERIFICATION (FASE 1-6) */}
          {menu === 'benefitRequests' && (
            <AdminBenefitRequests
              adminProfile={adminProfile}
              systemSettings={systemSettings}
              adminSdkConfigured={capabilities.adminSdkConfigured}
              restoreLocked={Boolean(restoreLock?.locked)}
              onViewMember={(uid) => setDetailMemberUid(uid)}
              onFeedback={setFeedback}
            />
          )}

          {/* 2. MEMBERS (FASE 9 & 10: Advanced Search, Filter, Sort, 11 Columns, 8-Tab Detail) */}
          {menu === 'members' && (
            <div className="space-y-4">
              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-display text-sm font-bold text-white">
                      Direktori Member ({filteredMembers.length} / {allMembers.length})
                    </h2>
                    <p className="text-xs text-slate-400">
                      Cari berdasarkan username, nama, WhatsApp, atau Member ID; filter menurut level, status, cabang, kategori, dan tanggal daftar.
                    </p>
                  </div>
                  {canManageMembers && (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setShowPreRegister((v) => !v);
                          setAdminPreRegCode(null);
                        }}
                        className="min-h-[40px] rounded-xl border border-amber-400/45 bg-amber-500/15 px-4 text-xs font-semibold text-amber-200 hover:bg-amber-500/25 whitespace-nowrap"
                      >
                        {showPreRegister ? 'Tutup Pre-Register' : '+ Pre-Register Customer (WA)'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowAddMember((v) => !v)}
                        className="min-h-[40px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-4 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500 whitespace-nowrap"
                      >
                        {showAddMember ? 'Tutup Form' : '+ Tambah Member Lengkap'}
                      </button>
                    </div>
                  )}
                </div>

                {showPreRegister && canManageMembers && (
                  <div className="rounded-xl bg-[#070B19] border border-amber-400/35 p-4 space-y-3">
                    <p className="text-xs font-semibold text-amber-300">
                      Tahap 1 · Pre-Register Customer (Nomor WhatsApp Saja · Status PRE_REGISTERED · 0 XP)
                    </p>
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (!adminPreRegWa.trim() || busy) return;
                        setBusy(true);
                        setFeedback(null);
                        setAdminPreRegCode(null);
                        try {
                          const res = await preRegisterCustomerClient({
                            whatsapp: adminPreRegWa.trim(),
                            branchId: adminPreRegBranch,
                            notes: adminPreRegNotes.trim(),
                            actor: adminProfile,
                            adminSdkConfigured: capabilities.adminSdkConfigured,
                          });
                          if (res.alreadyExists) {
                            setFeedback({ type: 'error', text: res.message });
                          } else {
                            setAdminPreRegWa('');
                            setAdminPreRegNotes('');
                            if (res.verificationCode) {
                              setAdminPreRegCode({
                                memberId: res.member.memberId,
                                whatsapp: res.member.whatsapp,
                                code: res.verificationCode,
                                url: res.onboardingUrl || '',
                                waMsg: res.whatsappShareMessage || '',
                              });
                            }
                            setFeedback({ type: 'success', text: res.message });
                            await loadMembersBatch();
                          }
                        } catch (err) {
                          setFeedback({ type: 'error', text: mapFriendlyError(err) });
                        } finally {
                          setBusy(false);
                        }
                      }}
                      className="grid sm:grid-cols-4 gap-2.5"
                    >
                      <input
                        type="tel"
                        required
                        placeholder="Nomor WhatsApp (0812...) *"
                        value={adminPreRegWa}
                        onChange={(e) => setAdminPreRegWa(e.target.value)}
                        className="h-10 rounded-lg border border-indigo-500/30 bg-[#0B1124] px-3 text-xs font-mono text-white"
                      />
                      <select
                        value={adminPreRegBranch}
                        onChange={(e) => setAdminPreRegBranch(e.target.value as BranchId)}
                        className="h-10 rounded-lg border border-indigo-500/30 bg-[#0B1124] px-3 text-xs text-white"
                      >
                        <option value="DEMANG">Cabang DEMANG</option>
                        <option value="SEKIP">Cabang SEKIP</option>
                      </select>
                      <input
                        type="text"
                        placeholder="Catatan opsional"
                        value={adminPreRegNotes}
                        onChange={(e) => setAdminPreRegNotes(e.target.value)}
                        className="h-10 rounded-lg border border-indigo-500/30 bg-[#0B1124] px-3 text-xs text-white"
                      />
                      <button
                        type="submit"
                        disabled={busy}
                        className="h-10 rounded-lg bg-amber-400 text-slate-950 font-bold text-xs hover:bg-amber-300 disabled:opacity-50"
                      >
                        {busy ? 'Memproses...' : 'Buat Pre-Registered'}
                      </button>
                    </form>
                    {adminPreRegCode && (
                      <div className="rounded-lg border border-sky-400/40 bg-[#0B1124] p-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                        <div>
                          <span className="text-slate-400">Kode Verifikasi 6 Digit ({adminPreRegCode.memberId} · {adminPreRegCode.whatsapp}): </span>
                          <strong className="font-mono text-lg text-sky-300 tracking-widest">{adminPreRegCode.code}</strong>
                        </div>
                        <button
                          type="button"
                          onClick={() => void navigator.clipboard.writeText(adminPreRegCode.waMsg || adminPreRegCode.code)}
                          className="px-3 py-1.5 rounded-lg bg-sky-500 text-slate-950 font-bold text-xs"
                        >
                          Salin Pesan &amp; Kode WA
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                  <input
                    type="text"
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                    placeholder="Cari username / WA / nama / XPP-..."
                    className="h-10 rounded-xl border border-indigo-500/30 bg-[#070B19] text-white px-3 text-xs placeholder:text-slate-400 focus:border-sky-400 focus:outline-none"
                  />
                  <select
                    value={memberFilterLevel}
                    onChange={(e) => setMemberFilterLevel(e.target.value as 'ALL' | LevelId)}
                    className="h-10 rounded-xl border border-indigo-500/30 bg-[#070B19] text-white px-3 text-xs"
                  >
                    <option value="ALL">Semua Level</option>
                    <option value="BRONZE">BRONZE</option>
                    <option value="SILVER">SILVER</option>
                    <option value="JURAGAN">JURAGAN</option>
                    <option value="SULTAN">SULTAN</option>
                  </select>
                  <select
                    value={memberFilterStatus}
                    onChange={(e) => setMemberFilterStatus(e.target.value as 'ALL' | MemberStatus)}
                    className="h-10 rounded-xl border border-indigo-500/30 bg-[#070B19] text-white px-3 text-xs"
                  >
                    <option value="ALL">Semua Status Akun</option>
                    <option value="PRE_REGISTERED">PRE_REGISTERED (Belum menyelesaikan profil)</option>
                    <option value="ACTIVE">ACTIVE (Membership Aktif)</option>
                    <option value="INACTIVE">INACTIVE</option>
                    <option value="SUSPENDED">SUSPENDED</option>
                    <option value="DELETED">DELETED</option>
                  </select>
                  <select
                    value={memberFilterCategory}
                    onChange={(e) => setMemberFilterCategory(e.target.value as 'ALL' | MemberCategory)}
                    className="h-10 rounded-xl border border-indigo-500/30 bg-[#070B19] text-white px-3 text-xs"
                  >
                    <option value="ALL">Semua Status Member</option>
                    {MEMBER_CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={memberFilterBranch}
                    onChange={(e) => setMemberFilterBranch(e.target.value as 'ALL' | BranchId)}
                    className="h-10 rounded-xl border border-indigo-500/30 bg-[#070B19] text-white px-3 text-xs"
                  >
                    <option value="ALL">Semua Cabang</option>
                    <option value="DEMANG">DEMANG</option>
                    <option value="SEKIP">SEKIP</option>
                  </select>
                  <input
                    type="date"
                    value={memberFilterFrom}
                    onChange={(e) => setMemberFilterFrom(e.target.value)}
                    title="Tanggal Daftar Dari"
                    className="h-10 rounded-xl border border-indigo-500/30 bg-[#070B19] text-white px-3 text-xs font-mono"
                  />
                  <input
                    type="date"
                    value={memberFilterTo}
                    onChange={(e) => setMemberFilterTo(e.target.value)}
                    title="Tanggal Daftar Sampai"
                    className="h-10 rounded-xl border border-indigo-500/30 bg-[#070B19] text-white px-3 text-xs font-mono"
                  />
                  <select
                    value={memberSort}
                    onChange={(e) => setMemberSort(e.target.value as MemberSortOption)}
                    className="h-10 rounded-xl border border-indigo-500/30 bg-[#070B19] text-white px-3 text-xs"
                  >
                    <option value="NEWEST">Urutkan: Terbaru Daftar</option>
                    <option value="OLDEST">Urutkan: Terlama Daftar</option>
                    <option value="XP_PROGRESS_DESC">XP Progress Tertinggi</option>
                    <option value="XP_PROGRESS_ASC">XP Progress Terendah</option>
                    <option value="XP_REWARD_DESC">XP Reward Tertinggi</option>
                    <option value="XP_REWARD_ASC">XP Reward Terendah</option>
                    <option value="LAST_PLAY_RECENT">Terakhir Main Terbaru</option>
                    <option value="LONGEST_INACTIVE">Paling Lama Tidak Main</option>
                    <option value="LEVEL_DESC">Level Sultan → Bronze</option>
                    <option value="LEVEL_ASC">Level Bronze → Sultan</option>
                  </select>
                </div>
              </div>

              {showAddMember && canManageMembers && (
                <form onSubmit={handleAddMember} className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 grid sm:grid-cols-4 gap-3">
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
                    type="date"
                    max={todayJakarta}
                    value={newMember.birthDate}
                    onChange={(e) => setNewMember({ ...newMember, birthDate: e.target.value })}
                    title="Tanggal Lahir"
                    className="bg-[#070B19] text-white focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                  />
                  <select
                    value={newMember.memberCategory}
                    onChange={(e) => setNewMember({ ...newMember, memberCategory: e.target.value as '' | MemberCategory })}
                    className="bg-[#070B19] text-white focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  >
                    <option value="">Status Member (Opsional)</option>
                    {MEMBER_CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
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
                    className="bg-[#070B19] text-white focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  >
                    <option value="DEMANG">Cabang DEMANG</option>
                    <option value="SEKIP">Cabang SEKIP</option>
                  </select>
                  <div className="sm:col-span-4 flex justify-end">
                    <button
                      type="submit"
                      disabled={busy}
                      className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-5 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500"
                    >
                      {busy
                        ? 'Menyimpan...'
                        : `Simpan Member (+${systemSettings.registrationBonusXp} XP)`}
                    </button>
                  </div>
                </form>
              )}

              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-indigo-500/20 text-left text-slate-400">
                      <th className="p-3">Member ID</th>
                      <th className="p-3">Nama & Username</th>
                      <th className="p-3">WhatsApp</th>
                      <th className="p-3">Tanggal Lahir</th>
                      <th className="p-3">Status Member</th>
                      <th className="p-3">Level</th>
                      <th className="p-3 text-right">XP Progress</th>
                      <th className="p-3 text-right">XP Reward / Hold</th>
                      <th className="p-3">Terakhir Main</th>
                      <th className="p-3">Cabang</th>
                      <th className="p-3">Status Akun</th>
                      <th className="p-3 text-right">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-indigo-500/15">
                    {pagedMembers.length === 0 ? (
                      <tr>
                        <td colSpan={12} className="p-8 text-center text-sm text-slate-400">
                          {loadingMembersBatch ? 'Memuat data member...' : 'Belum ada data member yang sesuai.'}
                        </td>
                      </tr>
                    ) : (
                      pagedMembers.map((m, idx) => (
                        <tr key={m.uid || m.memberId || `mem-${idx}`} className="hover:bg-[#0F1733]/60">
                          <td className="p-3 font-mono text-slate-300 whitespace-nowrap">{m.memberId}</td>
                          <td className="p-3">
                            <button
                              type="button"
                              onClick={() => setDetailMemberUid(m.uid)}
                              className="text-left group"
                            >
                              <p className="font-semibold text-white group-hover:text-sky-300">{m.fullName}</p>
                              <p className="font-mono text-sky-300">
                                {m.username ? `@${m.username}` : '(Pre-Registered · Belum ada username)'}
                              </p>
                            </button>
                          </td>
                          <td className="p-3 font-mono text-slate-300 whitespace-nowrap">{m.whatsapp}</td>
                          <td className="p-3 text-slate-300 whitespace-nowrap">{formatBirthDateJakarta(m.birthDate)}</td>
                          <td className="p-3 text-slate-200 whitespace-nowrap">{getMemberCategoryLabel(m.memberCategory)}</td>
                          <td className="p-3 font-semibold whitespace-nowrap">
                            <span className="text-white">{m.currentLevel}</span>
                            {m.levelMode === 'MANUAL_OVERRIDE' && (
                              <span className="ml-1 font-mono text-[10px] text-amber-300">(Manual)</span>
                            )}
                          </td>
                          <td className="p-3 text-right font-mono tabular-nums text-white">{m.xpProgress}</td>
                          <td className="p-3 text-right font-mono tabular-nums whitespace-nowrap">
                            <span className="text-purple-300 font-semibold">{m.xpReward}</span>
                            {(m.reservedXp ?? 0) > 0 && (
                              <span className="ml-1 text-amber-300 text-[11px]">({m.reservedXp} hold)</span>
                            )}
                          </td>
                          <td className="p-3 text-slate-400 whitespace-nowrap">
                            {m.lastPlayAt ? formatJakartaDateTime(m.lastPlayAt) : '-'}
                          </td>
                          <td className="p-3 font-mono text-slate-300 whitespace-nowrap">
                            {m.branchId || m.lastPlayBranch || m.preferredBranch || '-'}
                          </td>
                          <td className="p-3 whitespace-nowrap">
                            <span
                              className={`font-mono font-semibold ${
                                m.status === 'PRE_REGISTERED'
                                  ? 'text-amber-300'
                                  : m.status === 'ACTIVE'
                                    ? 'text-emerald-400'
                                    : 'text-rose-400'
                              }`}
                            >
                              {m.status}
                            </span>
                            <span className="block text-[10px] text-slate-400">
                              {m.status === 'PRE_REGISTERED'
                                ? 'Belum menyelesaikan profil'
                                : m.status === 'ACTIVE'
                                  ? 'Membership Aktif'
                                  : m.status}
                            </span>
                          </td>
                          <td className="p-3 text-right space-x-2 whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => setDetailMemberUid(m.uid)}
                              className="font-semibold text-sky-300 hover:underline"
                            >
                              Detail
                            </button>
                            {canManageMembers && (
                              <>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    setEditMemberTarget(m);
                                    setEditMemberPatch({
                                      fullName: m.fullName,
                                      socialMedia: m.socialMedia,
                                      preferredBranch: m.preferredBranch || 'DEMANG',
                                      birthDate: m.birthDate || '',
                                      memberCategory: m.memberCategory || '',
                                    });
                                  }}
                                  className="font-semibold text-indigo-300 hover:underline disabled:opacity-50"
                                >
                                  Edit
                                </button>
                                {m.status !== 'ACTIVE' ? (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void handleMemberStatusChange(m.uid, 'ACTIVE')}
                                    className="font-semibold text-emerald-400 hover:underline disabled:opacity-50"
                                  >
                                    Activate
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void handleMemberStatusChange(m.uid, 'SUSPENDED')}
                                    className="font-semibold text-amber-300 hover:underline disabled:opacity-50"
                                  >
                                    Suspend
                                  </button>
                                )}
                                {m.status !== 'DELETED' && (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void handleMemberStatusChange(m.uid, 'DELETED')}
                                    className="font-semibold text-rose-400 hover:underline disabled:opacity-50"
                                  >
                                    Delete
                                  </button>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
                {memberTotalPages > 1 && (
                  <div className="p-3 border-t border-indigo-500/15 flex items-center justify-between text-xs text-slate-300">
                    <span className="font-mono">
                      Halaman {memberPage} / {memberTotalPages} ({filteredMembers.length} member)
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={memberPage <= 1}
                        onClick={() => setMemberPage((p) => Math.max(1, p - 1))}
                        className="px-3 py-1.5 rounded-lg border border-indigo-500/30 bg-[#070B19] disabled:opacity-40"
                      >
                        Sebelumnya
                      </button>
                      <button
                        type="button"
                        disabled={memberPage >= memberTotalPages}
                        onClick={() => setMemberPage((p) => Math.min(memberTotalPages, p + 1))}
                        className="px-3 py-1.5 rounded-lg border border-indigo-500/30 bg-[#070B19] disabled:opacity-40"
                      >
                        Berikutnya
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 3. TRANSACTIONS (FASE 11: Advanced Search, Branch, Date Presets, Sort, 10 Columns) */}
          {menu === 'transactions' && (
            <div className="space-y-6">
              <form onSubmit={handleRecordTransaction} className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
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
                    className="bg-[#070B19] text-white focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
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
                <div className="p-4 border-b border-indigo-500/15 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-display text-sm font-bold text-white">
                      Riwayat Transaksi ({filteredTransactions.length} / {allTransactions.length})
                    </h3>
                    <span className="font-mono text-xs text-slate-400">
                      Total Nominal Filter:{' '}
                      <strong className="text-white">
                        {formatIdr(filteredTransactions.reduce((acc, t) => acc + t.amountIdr, 0))}
                      </strong>
                    </span>
                  </div>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                    <input
                      type="text"
                      value={txSearch}
                      onChange={(e) => setTxSearch(e.target.value)}
                      placeholder="Cari username / WA / struk / Tx ID..."
                      className="h-9 rounded-lg border border-indigo-500/30 bg-[#070B19] px-3 text-xs text-white placeholder:text-slate-400"
                    />
                    <select
                      value={txBranchFilter}
                      onChange={(e) => setTxBranchFilter(e.target.value as 'ALL' | BranchId)}
                      className="h-9 rounded-lg border border-indigo-500/30 bg-[#070B19] px-3 text-xs text-white"
                    >
                      <option value="ALL">Semua Cabang</option>
                      <option value="DEMANG">DEMANG</option>
                      <option value="SEKIP">SEKIP</option>
                    </select>
                    <select
                      value={txDatePreset}
                      onChange={(e) => setTxDatePreset(e.target.value as TransactionDatePreset)}
                      className="h-9 rounded-lg border border-indigo-500/30 bg-[#070B19] px-3 text-xs text-white"
                    >
                      <option value="ALL">Semua Tanggal</option>
                      <option value="TODAY">Hari Ini (WIB)</option>
                      <option value="YESTERDAY">Kemarin (WIB)</option>
                      <option value="THIS_WEEK">7 Hari Terakhir</option>
                      <option value="THIS_MONTH">Bulan Ini</option>
                      <option value="CUSTOM">Custom Rentang Tanggal</option>
                    </select>
                    <select
                      value={txSort}
                      onChange={(e) => setTxSort(e.target.value as TransactionSortOption)}
                      className="h-9 rounded-lg border border-indigo-500/30 bg-[#070B19] px-3 text-xs text-white"
                    >
                      <option value="NEWEST">Urutkan: Terbaru</option>
                      <option value="OLDEST">Urutkan: Terlama</option>
                      <option value="AMOUNT_DESC">Nominal Tertinggi</option>
                      <option value="AMOUNT_ASC">Nominal Terendah</option>
                      <option value="XP_DESC">XP Tertinggi</option>
                      <option value="XP_ASC">XP Terendah</option>
                    </select>
                    {txDatePreset === 'CUSTOM' && (
                      <>
                        <input
                          type="date"
                          value={txDateFrom}
                          onChange={(e) => setTxDateFrom(e.target.value)}
                          className="h-9 rounded-lg border border-indigo-500/30 bg-[#070B19] px-3 text-xs font-mono text-white"
                        />
                        <input
                          type="date"
                          value={txDateTo}
                          onChange={(e) => setTxDateTo(e.target.value)}
                          className="h-9 rounded-lg border border-indigo-500/30 bg-[#070B19] px-3 text-xs font-mono text-white"
                        />
                      </>
                    )}
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-indigo-500/20 text-left text-slate-400">
                        <th className="p-3">Tx ID</th>
                        <th className="p-3">Tanggal</th>
                        <th className="p-3">Member</th>
                        <th className="p-3">Cabang</th>
                        <th className="p-3 text-right">Nominal</th>
                        <th className="p-3 text-right">XP Rate</th>
                        <th className="p-3 text-right">XP</th>
                        <th className="p-3">No. Struk</th>
                        <th className="p-3">Admin</th>
                        <th className="p-3">Catatan</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-indigo-500/15">
                      {pagedTransactions.length === 0 ? (
                        <tr>
                          <td colSpan={10} className="p-8 text-center text-sm text-slate-400">
                            {loadingTxBatch ? 'Memuat transaksi...' : 'Belum ada riwayat transaksi pada filter ini.'}
                          </td>
                        </tr>
                      ) : (
                        pagedTransactions.map((t, idx) => (
                          <tr key={t.id || `tx-${idx}`} className="hover:bg-[#0F1733]/60">
                            <td className="p-3 font-mono text-[11px] text-slate-400 whitespace-nowrap">{t.id}</td>
                            <td className="p-3 font-mono text-slate-300 whitespace-nowrap">
                              {formatJakartaDateTime(t.createdAt)}
                            </td>
                            <td className="p-3 whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => setDetailMemberUid(t.memberUid)}
                                className="font-mono text-sky-300 hover:underline font-semibold"
                              >
                                @{t.memberUsername}
                              </button>
                              <p className="font-mono text-[10px] text-slate-500">{t.memberId}</p>
                            </td>
                            <td className="p-3 font-mono">{t.branch}</td>
                            <td className="p-3 text-right font-mono tabular-nums whitespace-nowrap">{formatIdr(t.amountIdr)}</td>
                            <td className="p-3 text-right font-mono tabular-nums text-slate-400 whitespace-nowrap">
                              Rp{t.xpRateUsed.toLocaleString('id-ID')}
                            </td>
                            <td className="p-3 text-right font-mono font-bold text-emerald-400 tabular-nums whitespace-nowrap">
                              +{t.xpGenerated}
                            </td>
                            <td className="p-3 font-mono text-slate-300">{t.receiptNumber || '-'}</td>
                            <td className="p-3 text-slate-300 whitespace-nowrap">{t.adminName}</td>
                            <td className="p-3 text-slate-400">{t.note || '-'}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                {txTotalPages > 1 && (
                  <div className="p-3 border-t border-indigo-500/15 flex items-center justify-between text-xs text-slate-300">
                    <span className="font-mono">
                      Halaman {txPage} / {txTotalPages} ({filteredTransactions.length} transaksi)
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={txPage <= 1}
                        onClick={() => setTxPage((p) => Math.max(1, p - 1))}
                        className="px-3 py-1.5 rounded-lg border border-indigo-500/30 bg-[#070B19] disabled:opacity-40"
                      >
                        Sebelumnya
                      </button>
                      <button
                        type="button"
                        disabled={txPage >= txTotalPages}
                        onClick={() => setTxPage((p) => Math.min(txTotalPages, p + 1))}
                        className="px-3 py-1.5 rounded-lg border border-indigo-500/30 bg-[#070B19] disabled:opacity-40"
                      >
                        Berikutnya
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 3B. ADMIN XP ADJUSTMENT (PHASE B) */}
          {menu === 'xpAdjustment' && (
            <AdminXpAdjustment
              adminProfile={adminProfile}
              levels={levels}
              adminSdkConfigured={capabilities.adminSdkConfigured}
              initialMember={xpAdjustmentInitialMember}
              onFeedback={setFeedback}
            />
          )}

          {/* 3C. ADMIN LEVEL OVERRIDE (PHASE C) */}
          {menu === 'levelOverride' && (
            <AdminLevelOverride
              adminProfile={adminProfile}
              levels={levels}
              adminSdkConfigured={capabilities.adminSdkConfigured}
              initialMember={levelOverrideInitialMember}
              onFeedback={setFeedback}
            />
          )}

          {/* 3D. ADMIN PASSWORD MANAGEMENT (PHASE D) */}
          {menu === 'passwordManagement' && (
            <AdminPasswordManagement
              adminProfile={adminProfile}
              adminSdkConfigured={capabilities.adminSdkConfigured}
              restoreLocked={Boolean(restoreLock?.locked)}
              initialMember={passwordInitialMember}
              onConsumeInitialMember={() => setPasswordInitialMember(null)}
            />
          )}

          {/* 3E. INACTIVE MEMBERS (PHASE E) */}
          {menu === 'inactiveMembers' && (
            <AdminInactiveMembers
              adminProfile={adminProfile}
              restoreLocked={Boolean(restoreLock?.locked)}
              onSelectForPassword={(m) => {
                setPasswordInitialMember(m);
                setMenu('passwordManagement');
              }}
              onSelectForXpAdjustment={(m) => {
                setXpAdjustmentInitialMember(m);
                setMenu('xpAdjustment');
              }}
            />
          )}

          {/* 3F. BACKUP, VERIFICATION, RESTORE & SYSTEM INTEGRITY (PHASES F-I & K) */}
          {menu === 'backupRestore' && <AdminBackupRestore adminProfile={adminProfile} />}

          {/* 4. UNIFIED XP HISTORY (FASE 12) */}
          {menu === 'xpHistory' && (
            <AdminXpHistory
              onSelectMember={(uid) => setDetailMemberUid(uid)}
              onFeedback={setFeedback}
            />
          )}

          {/* 5. LEVEL UP HISTORY */}
          {menu === 'levelHistory' && (
            <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 overflow-hidden">
              <div className="p-4 border-b border-indigo-500/15 flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-display text-sm font-bold text-white">
                  Riwayat Kenaikan Level
                </h2>
              </div>
              <div className="divide-y divide-indigo-500/15">
                {activeRows.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-400">
                    {loadingRows ? 'Memuat riwayat...' : 'Belum ada catatan riwayat kenaikan level.'}
                  </div>
                ) : (
                  (activeRows as LevelHistoryRecord[]).map((lh, idx) => (
                    <div key={lh.id || `lh-${idx}`} className="p-3.5 flex items-center justify-between gap-4 text-sm">
                      <div>
                        <p className="font-semibold text-white">
                          <button
                            type="button"
                            onClick={() => setDetailMemberUid(lh.memberUid)}
                            className="text-sky-300 hover:underline font-mono mr-1.5"
                          >
                            {lh.memberId}
                          </button>
                          {lh.fromLevel} → {lh.toLevel}
                        </p>
                        <p className="text-xs text-slate-400">
                          XP Progress: {lh.xpProgressAtEvent} XP · {lh.source} · {formatJakartaDateTime(lh.createdAt)}
                        </p>
                      </div>
                      <span className="font-mono text-xs font-semibold text-purple-300">{lh.cycleId}</span>
                    </div>
                  ))
                )}
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
              {canManageCatalog ? (
                <form onSubmit={handleSaveBenefit} className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="font-display text-base font-bold text-white">
                      {benefitForm.id ? 'Ubah Benefit' : 'Tambah Benefit Baru'}
                    </h2>
                    {benefitForm.id && (
                      <button
                        type="button"
                        onClick={resetBenefitForm}
                        className="text-xs font-semibold text-slate-300 hover:text-white underline"
                      >
                        Batal Edit
                      </button>
                    )}
                  </div>
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
                    className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-5 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500 disabled:opacity-50"
                  >
                    {busy ? 'Menyimpan...' : benefitForm.id ? 'Simpan Perubahan Benefit' : 'Simpan Benefit'}
                  </button>
                </form>
              ) : (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200">
                  Mode Read-Only: Role STAFF hanya dapat melihat daftar benefit. Penambahan/perubahan benefit dilakukan oleh ADMIN atau SUPER_ADMIN.
                </div>
              )}

              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 divide-y divide-indigo-500/15">
                {activeRows.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-400">
                    {loadingRows ? 'Memuat daftar benefit...' : 'Belum ada benefit terdaftar.'}
                  </div>
                ) : (
                  (activeRows as BenefitItem[]).map((b, idx) => (
                    <div key={b.id || `ben-${idx}`} className="p-4 flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-bold text-white">{b.name}</p>
                        <p className="text-xs text-slate-400">
                          Level {b.levelRequirement} · {b.xpCost} XP · {b.claimable ? 'Redeemable' : 'Info Only'} · {b.stock !== null ? `Stok: ${b.stock} · ` : ''}{b.active ? 'ACTIVE' : 'DISABLED'}
                        </p>
                      </div>
                      {canManageCatalog && (
                        <button
                          type="button"
                          onClick={() => {
                            setBenefitOriginalMeta({ createdAt: b.createdAt, createdBy: b.createdBy });
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
                            });
                            window.scrollTo({ top: 0, behavior: 'smooth' });
                          }}
                          className="text-xs font-semibold text-sky-300 hover:underline shrink-0"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* 9. CHALLENGES / 10. EVENTS / 11. PROMOS */}
          {(menu === 'challenges' || menu === 'events' || menu === 'promos') && (
            <div className="space-y-6">
              {(() => {
                const cType: CampaignType = menu === 'challenges' ? 'CHALLENGE' : menu === 'events' ? 'EVENT' : 'PROMO';
                if (!canManageCatalog) {
                  return (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200">
                      Mode Read-Only: Role STAFF hanya dapat melihat daftar {cType}. Pengelolaan program dilakukan oleh ADMIN atau SUPER_ADMIN.
                    </div>
                  );
                }
                return (
                  <form onSubmit={(e) => void handleSaveCampaign(e, cType)} className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="font-display text-base font-bold text-white">
                        {campaignForm.id ? `Ubah ${cType}` : `Buat ${cType} Baru`}
                      </h2>
                      {campaignForm.id && (
                        <button
                          type="button"
                          onClick={() => {
                            setCampaignForm(makeDefaultCampaignForm());
                            setCampaignOriginalMeta(null);
                          }}
                          className="text-xs font-semibold text-slate-300 hover:text-white underline"
                        >
                          Batal Edit
                        </button>
                      )}
                    </div>
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
                      <input
                        type="number"
                        min={1}
                        placeholder="Kuota Total Claim (kosong = unlimited)"
                        value={campaignForm.totalClaimLimit}
                        onChange={(e) => setCampaignForm({ ...campaignForm, totalClaimLimit: e.target.value })}
                        className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
                      />
                      <input
                        type="text"
                        placeholder="Syarat & Ketentuan (opsional)"
                        value={campaignForm.terms}
                        onChange={(e) => setCampaignForm({ ...campaignForm, terms: e.target.value })}
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
                      className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-5 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500 disabled:opacity-50"
                    >
                      {busy ? 'Menyimpan...' : campaignForm.id ? `Simpan Perubahan ${cType}` : `Simpan ${cType}`}
                    </button>
                  </form>
                );
              })()}

              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 divide-y divide-indigo-500/15">
                {activeRows.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-400">
                    {loadingRows ? 'Memuat program...' : 'Belum ada program pada kategori ini.'}
                  </div>
                ) : (
                  (activeRows as CampaignItem[]).map((c, idx) => (
                    <div key={c.id || `camp-${idx}`} className="p-4 flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-bold text-white">{c.title} (+{c.xpReward} XP)</p>
                        <p className="text-xs text-slate-400">
                          Status Efektif: <strong>{resolveCampaignStatus(c)}</strong> · Claim: {c.claimsCount}{c.totalClaimLimit !== null ? `/${c.totalClaimLimit}` : ''} · Berakhir: {formatJakartaDateTime(c.endAt)} WIB
                        </p>
                      </div>
                      {canManageCatalog && (
                        <button
                          type="button"
                          onClick={() => {
                            setCampaignOriginalMeta({
                              createdAt: c.createdAt,
                              createdBy: c.createdBy,
                              claimsCount: c.claimsCount ?? 0,
                            });
                            setCampaignForm({
                              id: c.id,
                              title: c.title,
                              description: c.description,
                              xpReward: String(c.xpReward),
                              startAt: formatDateTimeLocalInput(c.startAt),
                              endAt: formatDateTimeLocalInput(c.endAt),
                              terms: c.terms,
                              maxClaimsPerMember: String(c.maxClaimsPerMember),
                              totalClaimLimit: c.totalClaimLimit === null ? '' : String(c.totalClaimLimit),
                              requiresEvidence: c.requiresEvidence,
                              status: c.status,
                              active: c.active,
                            });
                            window.scrollTo({ top: 0, behavior: 'smooth' });
                          }}
                          className="text-xs font-semibold text-sky-300 hover:underline shrink-0"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* 12. NOTIFICATIONS & INACTIVITY CAMPAIGN */}
          {menu === 'notifications' && (
            <div className="space-y-6">
              {canManageCatalog ? (
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
                    className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-5 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500 disabled:opacity-50"
                  >
                    {busy ? 'Mengirim...' : 'Kirim Kampanye Notifikasi'}
                  </button>
                </form>
              ) : (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200">
                  Mode Read-Only: Role STAFF hanya dapat melihat riwayat notifikasi. Pengiriman kampanye notifikasi dilakukan oleh ADMIN atau SUPER_ADMIN.
                </div>
              )}

              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 divide-y divide-indigo-500/15">
                {activeRows.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-400">
                    {loadingRows ? 'Memuat riwayat notifikasi...' : 'Belum ada riwayat kampanye notifikasi.'}
                  </div>
                ) : (
                  (activeRows as NotificationCampaign[]).map((nc, idx) => (
                    <div key={nc.id || `nc-${idx}`} className="p-4">
                      <p className="text-sm font-bold text-white">{nc.title}</p>
                      <p className="text-xs text-slate-300">{nc.message}</p>
                      <p className="text-[11px] text-slate-400 mt-1">
                        Target: {nc.targetType} {nc.inactivityDays ? `(>= ${nc.inactivityDays} hari)` : nc.targetFilter} · {formatJakartaDateTime(nc.createdAt)}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* 13. ADMIN & CASHIER MANAGEMENT (SUPER_ADMIN) */}
          {menu === 'adminManagement' && isSuper && (
            <div className="space-y-6">
              {/* 4 Branch Cashier Slot Architecture (NO hardcoded accounts/credentials) */}
              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-4">
                <div>
                  <h2 className="font-display text-base font-bold text-white">
                    Slot Akun Kasir Cabang (2 Demang · 2 Sekip)
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Tidak ada kredensial hardcoded. Superadmin menugaskan Firebase Auth UID &amp; email terverifikasi ke slot cabang tetap (isolasi data cabang ketat).
                  </p>
                </div>
                <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {CASHIER_SLOT_TEMPLATES.map((slot) => {
                    const assigned = (activeRows as AdminUser[]).find(
                      (a) =>
                        isCashierRole(a.role) &&
                        (a.cashierCode === slot.code ||
                          (!a.cashierCode && a.branchScope === slot.branchId))
                    );
                    return (
                      <div
                        key={slot.code}
                        className="rounded-xl bg-[#070B19] border border-indigo-500/25 p-3.5 space-y-2"
                      >
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-mono font-bold text-sky-300">{slot.code}</span>
                          <span className="font-mono text-[10px] text-slate-400">{slot.branchId}</span>
                        </div>
                        <p className="text-xs font-semibold text-white">{slot.label}</p>
                        {assigned ? (
                          <div className="text-[11px] space-y-0.5">
                            <p className="text-emerald-300 font-semibold truncate">{assigned.fullName}</p>
                            <p className="font-mono text-slate-400 truncate">{assigned.email}</p>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setAdminOriginalCreatedAt(null);
                              setAdminForm({
                                uid: '',
                                email: '',
                                fullName: slot.label,
                                role: 'CASHIER',
                                branchScope: slot.branchId,
                                cashierCode: slot.code,
                                active: true,
                              });
                            }}
                            className="w-full py-1.5 rounded-lg border border-sky-400/35 text-[11px] font-semibold text-sky-300 hover:bg-sky-500/15"
                          >
                            Assign ke Slot Ini
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  setFeedback(null);
                  try {
                    const now = Date.now();
                    if (isCashierRole(adminForm.role) && adminForm.branchScope === 'ALL') {
                      throw new Error('Akun CASHIER wajib terikat ke 1 cabang tetap (DEMANG atau SEKIP).');
                    }
                    const target: AdminUser = {
                      uid: adminForm.uid.trim(),
                      email: adminForm.email.trim().toLowerCase(),
                      fullName: adminForm.fullName.trim(),
                      role: adminForm.role,
                      branchScope: adminForm.branchScope,
                      branchId:
                        adminForm.branchScope === 'DEMANG' || adminForm.branchScope === 'SEKIP'
                          ? adminForm.branchScope
                          : null,
                      cashierCode: isCashierRole(adminForm.role)
                        ? adminForm.cashierCode.trim() || null
                        : null,
                      permissions: getDefaultPermissionsForRole(adminForm.role),
                      active: adminForm.active,
                      createdAt: adminOriginalCreatedAt || now,
                      updatedAt: now,
                    };
                    await upsertAdminUserBySuperAdmin(target, adminProfile);
                    setFeedback({
                      type: 'success',
                      text: `Operator ${target.email} (${target.role} · ${target.branchScope}) berhasil disimpan.`,
                    });
                    setAdminOriginalCreatedAt(null);
                    setAdminForm({
                      uid: '',
                      email: '',
                      fullName: '',
                      role: 'CASHIER',
                      branchScope: 'DEMANG',
                      cashierCode: '',
                      active: true,
                    });
                    await loadMenuRows(true);
                  } catch (err) {
                    setFeedback({ type: 'error', text: mapFriendlyError(err) });
                  } finally {
                    setBusy(false);
                  }
                }}
                className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-display text-base font-bold text-white">
                    Kelola Admin, Superadmin &amp; Kasir Cabang (RBAC)
                  </h2>
                  {adminForm.uid && (
                    <button
                      type="button"
                      onClick={() => {
                        setAdminOriginalCreatedAt(null);
                        setAdminForm({
                          uid: '',
                          email: '',
                          fullName: '',
                          role: 'CASHIER',
                          branchScope: 'DEMANG',
                          cashierCode: '',
                          active: true,
                        });
                      }}
                      className="text-xs font-semibold text-slate-300 hover:text-white underline"
                    >
                      Batal Edit
                    </button>
                  )}
                </div>
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
                    placeholder="Email Operator (Terverifikasi) *"
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
                    onChange={(e) => {
                      const nextRole = e.target.value as AdminRole;
                      setAdminForm({
                        ...adminForm,
                        role: nextRole,
                        branchScope:
                          isCashierRole(nextRole) && adminForm.branchScope === 'ALL'
                            ? 'DEMANG'
                            : adminForm.branchScope,
                      });
                    }}
                    className="bg-[#070B19] text-white focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  >
                    <option value="CASHIER">CASHIER (Kasir Cabang · Terisolasi)</option>
                    <option value="ADMIN">ADMIN (Operasional Penuh)</option>
                    <option value="SUPER_ADMIN">SUPER_ADMIN (Semua Izin Sistem)</option>
                    <option value="STAFF">STAFF (Legacy Alias Kasir)</option>
                  </select>
                  <select
                    value={adminForm.branchScope}
                    onChange={(e) => setAdminForm({ ...adminForm, branchScope: e.target.value as BranchId | 'ALL' })}
                    className="bg-[#070B19] text-white focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
                  >
                    {!isCashierRole(adminForm.role) && <option value="ALL">Semua Cabang (ALL)</option>}
                    <option value="DEMANG">Cabang DEMANG</option>
                    <option value="SEKIP">Cabang SEKIP</option>
                  </select>
                  {isCashierRole(adminForm.role) ? (
                    <select
                      value={adminForm.cashierCode}
                      onChange={(e) => setAdminForm({ ...adminForm, cashierCode: e.target.value })}
                      className="bg-[#070B19] text-white focus:border-sky-400 focus:outline-none h-10 rounded-lg border border-indigo-500/30 px-3 text-xs font-mono"
                    >
                      <option value="">-- Kode Slot Kasir (Opsional) --</option>
                      {CASHIER_SLOT_TEMPLATES.filter((s) => s.branchId === adminForm.branchScope).map((s) => (
                        <option key={s.code} value={s.code}>
                          {s.code} ({s.label})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <label className="flex items-center gap-2 text-xs px-2">
                      <input
                        type="checkbox"
                        checked={adminForm.active}
                        onChange={(e) => setAdminForm({ ...adminForm, active: e.target.checked })}
                      />
                      <span>Status Aktif</span>
                    </label>
                  )}
                </div>
                {isCashierRole(adminForm.role) && (
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={adminForm.active}
                      onChange={(e) => setAdminForm({ ...adminForm, active: e.target.checked })}
                    />
                    <span>Akun Kasir Aktif (akses /cashier cabang {adminForm.branchScope})</span>
                  </label>
                )}
                <button
                  type="submit"
                  disabled={busy}
                  className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  {busy ? 'Menyimpan...' : 'Simpan Operator'}
                </button>
              </form>

              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 divide-y divide-indigo-500/15">
                {activeRows.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-400">
                    {loadingRows ? 'Memuat daftar operator...' : 'Belum ada data operator tambahan.'}
                  </div>
                ) : (
                  (activeRows as AdminUser[]).map((a, idx) => (
                    <div key={a.uid || a.email || `adm-${idx}`} className="p-4 flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-bold text-white">
                          {a.fullName}{' '}
                          <span className="font-mono text-xs text-sky-300">
                            ({a.role}{a.cashierCode ? ` · ${a.cashierCode}` : ''})
                          </span>
                        </p>
                        <p className="text-xs font-mono text-slate-400">
                          {a.email} · UID: {a.uid} · Cabang: {a.branchScope} · {a.active ? 'ACTIVE' : 'DISABLED'}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setAdminOriginalCreatedAt(a.createdAt);
                          setAdminForm({
                            uid: a.uid,
                            email: a.email,
                            fullName: a.fullName,
                            role: a.role,
                            branchScope: a.branchScope,
                            cashierCode: a.cashierCode || '',
                            active: a.active,
                          });
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                        className="text-xs font-semibold text-sky-300 hover:underline shrink-0"
                      >
                        Edit
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* Formal 4-Role RBAC Matrix */}
              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-3 overflow-x-auto">
                <h3 className="font-display text-sm font-bold text-white">
                  Matriks Hak Akses Role (MEMBER · CASHIER · ADMIN · SUPER_ADMIN)
                </h3>
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-indigo-500/20 text-slate-400">
                    <tr>
                      <th className="py-2 pr-3">Fitur / Kapabilitas</th>
                      <th className="py-2 px-2 text-center">MEMBER</th>
                      <th className="py-2 px-2 text-center">CASHIER</th>
                      <th className="py-2 px-2 text-center">ADMIN</th>
                      <th className="py-2 pl-2 text-center">SUPER_ADMIN</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-indigo-500/15 font-mono">
                    {ROLE_PERMISSION_MATRIX_ROWS.map((row) => (
                      <tr key={row.feature}>
                        <td className="py-2 pr-3 font-sans text-slate-200">{row.feature}</td>
                        <td className={`py-2 px-2 text-center ${row.member ? 'text-emerald-400' : 'text-slate-600'}`}>
                          {row.member ? 'ALLOW' : 'DENY'}
                        </td>
                        <td className={`py-2 px-2 text-center ${row.cashier ? 'text-sky-300' : 'text-rose-400/80'}`}>
                          {row.cashier ? 'BRANCH' : 'DENY'}
                        </td>
                        <td className={`py-2 px-2 text-center ${row.admin ? 'text-emerald-400' : 'text-slate-600'}`}>
                          {row.admin ? 'ALLOW' : 'DENY'}
                        </td>
                        <td className="py-2 pl-2 text-center text-emerald-400">
                          {row.superAdmin ? 'ALLOW' : 'DENY'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
                <div className="rounded-xl border border-indigo-500/25 bg-[#070B19] p-4 space-y-1.5">
                  <label className="flex items-center gap-2.5 text-xs font-semibold text-white cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(settingsDraft.refundOnExpiry)}
                      onChange={(e) =>
                        setSettingsDraft({ ...settingsDraft, refundOnExpiry: e.target.checked })
                      }
                    />
                    <span>Refund XP Otomatis Saat Benefit Expired (refundOnExpiry)</span>
                  </label>
                  <p className="text-[11px] text-slate-400 pl-6">
                    Default: NONAKTIF (benefit APPROVED yang tidak digunakan dalam 7 hari menjadi EXPIRED tanpa refund). Jika diaktifkan, proses expiry akan mengembalikan XP Reward melalui ledger <span className="font-mono text-purple-300">EXPIRY_REFUND</span>.
                  </p>
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
                  <div className="flex flex-wrap items-center gap-1.5">
                    {([30, 60, 90, 180, 365] as const).map((days) => (
                      <button
                        key={days}
                        type="button"
                        onClick={() =>
                          setSettingsDraft({ ...settingsDraft, resetInterval: days, resetUnit: 'DAYS' })
                        }
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-mono border transition-colors ${
                          settingsDraft.resetUnit === 'DAYS' && settingsDraft.resetInterval === days
                            ? 'bg-sky-500/20 border-sky-400 text-sky-200 font-bold'
                            : 'bg-[#070B19] border-indigo-500/25 text-slate-300 hover:border-sky-400/50'
                        }`}
                      >
                        {days} Hari
                      </button>
                    ))}
                  </div>
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
                      <option value="DAYS">Hari (30/60/90/180/365/Custom)</option>
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
                {activeRows.length === 0 ? (
                  <div className="p-6 text-center text-sm text-slate-400">
                    {loadingRows ? 'Memuat snapshot...' : 'Belum ada riwayat snapshot reset cycle.'}
                  </div>
                ) : (
                  (activeRows as CycleSnapshot[]).map((s, idx) => (
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
                  ))
                )}
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
                    try {
                      await upsertBranchByAdmin(updated, adminProfile);
                      await refreshProfiles();
                      setFeedback({ type: 'success', text: `Cabang ${updated.name} diperbarui.` });
                    } catch (err) {
                      setFeedback({ type: 'error', text: mapFriendlyError(err) });
                    }
                  }}
                />
              ))}
            </div>
          )}

          {/* 17B. CMS HOMEPAGE */}
          {menu === 'cmsHomepage' && (
            <AdminCmsEditor
              adminProfile={adminProfile}
              levels={levels}
              branches={branches}
              systemSettings={systemSettings}
              onFeedback={setFeedback}
            />
          )}

          {/* 18. AUDIT LOGS */}
          {menu === 'auditLogs' && (
            <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 divide-y divide-indigo-500/15">
              {activeRows.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-400">
                  {loadingRows ? 'Memuat audit logs...' : 'Belum ada catatan audit log.'}
                </div>
              ) : (
                (activeRows as AuditLogRecord[]).map((log, idx) => (
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
                ))
              )}
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
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <form onSubmit={handleSaveEditMember} className="w-full max-w-md bg-[#0B1124] rounded-2xl border border-indigo-500/30 p-6 space-y-3.5">
            <h3 className="font-display text-lg font-bold text-white">
              Edit Member @{editMemberTarget.username}
            </h3>
            <input
              type="text"
              required
              value={editMemberPatch.fullName}
              onChange={(e) => setEditMemberPatch({ ...editMemberPatch, fullName: e.target.value })}
              placeholder="Nama Lengkap"
              className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
            />
            <input
              type="text"
              value={editMemberPatch.socialMedia}
              onChange={(e) => setEditMemberPatch({ ...editMemberPatch, socialMedia: e.target.value })}
              placeholder="Sosial Media"
              className="bg-[#070B19] text-white placeholder:text-slate-400 focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
            />
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">Tanggal Lahir</label>
              <input
                type="date"
                max={todayJakarta}
                value={editMemberPatch.birthDate}
                onChange={(e) => setEditMemberPatch({ ...editMemberPatch, birthDate: e.target.value })}
                className="bg-[#070B19] text-white focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">Status Member</label>
              <select
                value={editMemberPatch.memberCategory}
                onChange={(e) =>
                  setEditMemberPatch({ ...editMemberPatch, memberCategory: e.target.value as '' | MemberCategory })
                }
                className="bg-[#070B19] text-white focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
              >
                <option value="">Belum diisi</option>
                {MEMBER_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">Cabang Favorit</label>
              <select
                value={editMemberPatch.preferredBranch}
                onChange={(e) => setEditMemberPatch({ ...editMemberPatch, preferredBranch: e.target.value as BranchId })}
                className="bg-[#070B19] text-white focus:border-sky-400 focus:outline-none w-full h-10 rounded-lg border border-indigo-500/30 px-3 text-sm"
              >
                <option value="DEMANG">DEMANG</option>
                <option value="SEKIP">SEKIP</option>
              </select>
            </div>
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={() => setEditMemberTarget(null)}
                className="bg-[#070B19] text-white flex-1 h-10 rounded-xl border border-indigo-500/30 text-xs font-semibold"
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

      {/* 8-Tab Member Detail Drawer (FASE 10) */}
      {detailMemberUid && (
        <AdminMemberDetail
          memberUid={detailMemberUid}
          adminProfile={adminProfile}
          canManageMembers={canManageMembers}
          canManageCatalog={canManageCatalog}
          restoreLocked={Boolean(restoreLock?.locked)}
          onClose={() => setDetailMemberUid(null)}
          onMemberMutated={() => {
            if (menu === 'members') void loadMembersBatch();
            if (menu === 'dashboard') void loadDashboardMetrics();
          }}
          onJumpToXpAdjustment={(member) => {
            setXpAdjustmentInitialMember(member);
            setMenu('xpAdjustment');
          }}
          onJumpToLevelOverride={(member) => {
            setLevelOverrideInitialMember(member);
            setMenu('levelOverride');
          }}
          onJumpToPassword={(member) => {
            setPasswordInitialMember(member);
            setMenu('passwordManagement');
          }}
        />
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

  useEffect(() => {
    setDraft(branch);
  }, [branch]);

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
