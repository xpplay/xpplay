import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  Bell,
  Check,
  Clock,
  Copy,
  Gift,
  History,
  Home,
  LogOut,
  MapPin,
  Upload,
  User as UserIcon,
  Users,
} from 'lucide-react';
import { where, type DocumentData, type QueryConstraint, type QueryDocumentSnapshot } from 'firebase/firestore';
import { MemberXpShowcase } from '../components/MemberXpShowcase.tsx';
import { ProtectedImage } from '../components/ProtectedImage.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import {
  isPreRegisteredMember,
  PRE_REGISTERED_LOGIN_BLOCKED_MESSAGE,
} from '../shared/registrationLogic.ts';
import {
  fetchActiveBenefits,
  fetchActiveCampaigns,
  fetchBenefitRequestsForMember,
  fetchPaginatedCollection,
  markMemberNotificationRead,
  submitBenefitRequestForMember,
  updateMemberOwnProfile,
  uploadClaimEvidence,
} from '../services/xpService.ts';
import {
  classifyXpLedgerMovement,
  formatBirthDateJakarta,
  getBenefitRemainingDaysLabel,
  getJakartaTodayDateString,
  getMemberCategoryLabel,
  getXpLedgerMovementLabel,
  isBenefitRequestEffectivelyExpired,
  MEMBER_CATEGORIES,
} from '../shared/benefitRequestLogic.ts';
import {
  formatIdr,
  formatJakartaDateTime,
  getBranchLabel,
  isCampaignClaimable,
  isLevelEligible,
  resolveCampaignStatus,
  resolveEffectiveMemberLevel,
} from '../shared/xpLogic.ts';
import type {
  BenefitItem,
  BenefitRequestRecord,
  BranchId,
  CampaignItem,
  ClaimRecord,
  LevelHistoryRecord,
  MemberCategory,
  MemberNotification,
  RedemptionRecord,
  ReferralRecord,
  TransactionRecord,
  XpLedgerEntry,
} from '../types/xpplay.ts';

// FASE 1 & 37: Simplified 4-tab mobile-first member navigation
type MemberTab = 'overview' | 'benefits' | 'history' | 'profile';
type UnifiedCatalogFilter = 'ALL' | 'REWARD_BENEFIT' | 'LEVEL_BENEFIT' | 'CHALLENGE' | 'EVENT' | 'PROMO';
type HistoryKind = 'xpProgress' | 'xpReward' | 'transactions' | 'referrals' | 'levels';

const STATUS_DISPLAY: Record<string, { label: string; color: string }> = {
  ON_PROCESS: { label: 'MENUNGGU VERIFIKASI', color: 'text-amber-300' },
  APPROVED: { label: 'DISETUJUI · SIAP DIPAKAI', color: 'text-emerald-400' },
  USED: { label: 'SUDAH DIGUNAKAN', color: 'text-sky-300' },
  EXPIRED: { label: 'KADALUARSA (EXPIRED)', color: 'text-slate-400' },
  DENIED: { label: 'DITOLAK', color: 'text-rose-400' },
  REFUNDED: { label: 'XP DIKEMBALIKAN (REFUND)', color: 'text-purple-300' },
};

export function MemberDashboardPage() {
  const { memberProfile, levels, branches, systemSettings, capabilities, restoreLock, logout, refreshProfiles } =
    useAuth();
  const isMaintenance = Boolean(restoreLock?.locked);
  const [activeTab, setActiveTab] = useState<MemberTab>('overview');

  // Unified Benefit Catalog & Requests
  const [campaigns, setCampaigns] = useState<CampaignItem[]>([]);
  const [benefits, setBenefits] = useState<BenefitItem[]>([]);
  const [catalogFilter, setCatalogFilter] = useState<UnifiedCatalogFilter>('ALL');
  const [myRequests, setMyRequests] = useState<BenefitRequestRecord[]>([]);
  const [myLegacyClaims, setMyLegacyClaims] = useState<ClaimRecord[]>([]);
  const [myLegacyRedemptions, setMyLegacyRedemptions] = useState<RedemptionRecord[]>([]);
  const [showLegacyHistory, setShowLegacyHistory] = useState(false);
  const [notifications, setNotifications] = useState<MemberNotification[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [copiedReqId, setCopiedReqId] = useState<string | null>(null);

  // Campaign Benefit Request modal (Challenge / Event / Promo)
  const [campaignTarget, setCampaignTarget] = useState<CampaignItem | null>(null);
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [requestNote, setRequestNote] = useState('');
  const [submittingRequest, setSubmittingRequest] = useState(false);

  // Benefit confirmation modal (shows immediate XP Hold preview before submitting)
  const [benefitConfirmTarget, setBenefitConfirmTarget] = useState<BenefitItem | null>(null);

  // History pagination state
  const [historyKind, setHistoryKind] = useState<HistoryKind>('xpReward');
  const [branchFilter, setBranchFilter] = useState<'ALL' | BranchId>('ALL');
  const [historyItems, setHistoryItems] = useState<unknown[]>([]);
  const [historyOwnerKey, setHistoryOwnerKey] = useState<string>('');
  const [historyCursor, setHistoryCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const historySeqRef = useRef(0);

  // Profile edit state (includes Birth Date & Member Status)
  const [editFullName, setEditFullName] = useState('');
  const [editSocial, setEditSocial] = useState('');
  const [editBranch, setEditBranch] = useState<BranchId>('DEMANG');
  const [editBirthDate, setEditBirthDate] = useState('');
  const [editCategory, setEditCategory] = useState<MemberCategory | ''>('');
  const [savingProfile, setSavingProfile] = useState(false);
  const todayJakarta = getJakartaTodayDateString();

  // Feedback banner
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (memberProfile) {
      setEditFullName(memberProfile.fullName);
      setEditSocial(memberProfile.socialMedia || '');
      setEditBranch(memberProfile.preferredBranch || 'DEMANG');
      setEditBirthDate(memberProfile.birthDate || '');
      setEditCategory(memberProfile.memberCategory || '');
    }
  }, [memberProfile?.uid, memberProfile?.birthDate, memberProfile?.memberCategory]);

  const loadMemberFeeds = async () => {
    if (!memberProfile) return;
    setLoadingCatalog(true);
    try {
      const migratedUid = memberProfile.migratedFromUid || null;
      const [camps, bens, brqs, preBrqs, claimsRes, redsRes, notifsRes] = await Promise.all([
        fetchActiveCampaigns(),
        fetchActiveBenefits(),
        fetchBenefitRequestsForMember(memberProfile.uid, 50),
        migratedUid ? fetchBenefitRequestsForMember(migratedUid, 25).catch(() => []) : Promise.resolve([]),
        fetchPaginatedCollection<ClaimRecord>({
          collectionName: 'claims',
          constraints: [where('memberUid', '==', memberProfile.uid)],
          pageSize: 20,
        }),
        fetchPaginatedCollection<RedemptionRecord>({
          collectionName: 'redemptions',
          constraints: [where('memberUid', '==', memberProfile.uid)],
          pageSize: 15,
        }),
        fetchPaginatedCollection<MemberNotification>({
          collectionName: 'memberNotifications',
          constraints: [where('memberUid', '==', memberProfile.uid)],
          pageSize: 25,
        }),
      ]);
      const mergedBrqMap = new Map<string, BenefitRequestRecord>();
      for (const r of [...brqs, ...preBrqs]) mergedBrqMap.set(r.id, r);
      const mergedBrqs = Array.from(mergedBrqMap.values()).sort((a, b) => b.createdAt - a.createdAt);

      setCampaigns(camps);
      setBenefits(bens);
      setMyRequests(mergedBrqs);
      setMyLegacyClaims(claimsRes.items);
      setMyLegacyRedemptions(redsRes.items);
      setNotifications(notifsRes.items);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setLoadingCatalog(false);
    }
  };

  useEffect(() => {
    void loadMemberFeeds();
  }, [memberProfile?.uid]);

  const currentHistoryKey = `${historyKind}:${branchFilter}:${memberProfile?.uid ?? ''}`;
  const activeHistoryItems = historyOwnerKey === currentHistoryKey ? historyItems : [];

  const loadHistory = async (reset: boolean) => {
    if (!memberProfile) return;
    const seq = ++historySeqRef.current;
    const reqKey = `${historyKind}:${branchFilter}:${memberProfile.uid}`;
    if (reset) {
      setHistoryItems([]);
      setHistoryCursor(null);
      setHistoryHasMore(false);
    }
    setLoadingHistory(true);
    try {
      let colName = 'xpRewardLedger';
      const constraints: QueryConstraint[] = [];
      const migratedUid = memberProfile.migratedFromUid || null;
      const migratedConstraints: QueryConstraint[] = [];

      if (historyKind === 'xpProgress') {
        colName = 'xpProgressLedger';
        constraints.push(where('memberUid', '==', memberProfile.uid));
        if (migratedUid) migratedConstraints.push(where('memberUid', '==', migratedUid));
        if (branchFilter !== 'ALL') {
          constraints.push(where('branch', '==', branchFilter));
          if (migratedUid) migratedConstraints.push(where('branch', '==', branchFilter));
        }
      } else if (historyKind === 'xpReward') {
        colName = 'xpRewardLedger';
        constraints.push(where('memberUid', '==', memberProfile.uid));
        if (migratedUid) migratedConstraints.push(where('memberUid', '==', migratedUid));
      } else if (historyKind === 'transactions') {
        colName = 'transactions';
        constraints.push(where('memberUid', '==', memberProfile.uid));
        if (migratedUid) migratedConstraints.push(where('memberUid', '==', migratedUid));
        if (branchFilter !== 'ALL') {
          constraints.push(where('branch', '==', branchFilter));
          if (migratedUid) migratedConstraints.push(where('branch', '==', branchFilter));
        }
      } else if (historyKind === 'referrals') {
        colName = 'referrals';
        constraints.push(where('referrerUid', '==', memberProfile.uid));
      } else {
        colName = 'levelHistory';
        constraints.push(where('memberUid', '==', memberProfile.uid));
      }

      const [res, preRes] = await Promise.all([
        fetchPaginatedCollection<{ id?: string; createdAt?: number }>({
          collectionName: colName,
          constraints,
          pageSize: 12,
          cursor: reset ? null : historyCursor,
        }),
        reset && migratedUid && migratedConstraints.length > 0
          ? fetchPaginatedCollection<{ id?: string; createdAt?: number }>({
              collectionName: colName,
              constraints: migratedConstraints,
              pageSize: 20,
            }).catch(() => ({ items: [] as { id?: string; createdAt?: number }[] }))
          : Promise.resolve({ items: [] as { id?: string; createdAt?: number }[] }),
      ]);

      if (seq !== historySeqRef.current) return;
      const mergedItems = reset && preRes.items.length > 0
        ? Array.from(
            new Map([...res.items, ...preRes.items].map((it, idx) => [it.id || `k_${idx}`, it])).values()
          ).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        : res.items;

      setHistoryItems((prev) => (reset ? mergedItems : [...prev, ...mergedItems]));
      setHistoryOwnerKey(reqKey);
      setHistoryCursor(res.lastCursor);
      setHistoryHasMore(res.hasMore);
    } catch (err) {
      if (seq === historySeqRef.current) {
        setFeedback({ type: 'error', text: mapFriendlyError(err) });
      }
    } finally {
      if (seq === historySeqRef.current) {
        setLoadingHistory(false);
      }
    }
  };

  useEffect(() => {
    if (activeTab === 'history') {
      void loadHistory(true);
    }
  }, [activeTab, historyKind, branchFilter, memberProfile?.uid]);

  if (!memberProfile) return null;

  if (isPreRegisteredMember(memberProfile)) {
    return (
      <div className="min-h-screen gaming-canvas flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-[#0B1124] rounded-2xl border border-amber-400/40 p-8 text-center space-y-4">
          <h1 className="font-display text-xl font-bold text-white">Pendaftaran Belum Selesai</h1>
          <p className="text-sm text-slate-300 leading-relaxed">
            {PRE_REGISTERED_LOGIN_BLOCKED_MESSAGE}
          </p>
          <Link
            to={`/register?wa=${encodeURIComponent(memberProfile.whatsapp || '')}`}
            className="w-full h-[46px] inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-sm font-semibold text-white"
          >
            Lengkapi Pendaftaran
          </Link>
          <button
            type="button"
            onClick={() => void logout()}
            className="w-full h-[42px] rounded-xl border border-indigo-500/30 text-xs font-medium text-slate-300"
          >
            Keluar
          </button>
        </div>
      </div>
    );
  }

  if (memberProfile.status !== 'ACTIVE') {
    return (
      <div className="min-h-screen gaming-canvas flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-[#0B1124] rounded-2xl border border-rose-500/35 p-8 text-center space-y-4">
          <h1 className="font-display text-xl font-bold text-white">Akun Tidak Aktif</h1>
          <p className="text-sm text-slate-300">
            Status keanggotaan Anda saat ini: <strong className="text-rose-300">{memberProfile.status}</strong>. Silakan hubungi admin XP PLAY di WhatsApp 08983761001 untuk informasi lebih lanjut.
          </p>
          <button
            type="button"
            onClick={() => void logout()}
            className="w-full h-[46px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-sm font-semibold text-white"
          >
            Keluar
          </button>
        </div>
      </div>
    );
  }

  const effectiveLevel = resolveEffectiveMemberLevel(memberProfile, levels);
  const unreadNotifs = notifications.filter((n) => !n.read).length;
  const reservedXp = memberProfile.reservedXp ?? 0;
  const activeApprovedVouchers = myRequests.filter(
    (r) => r.status === 'APPROVED' && !isBenefitRequestEffectivelyExpired(r)
  );

  const handleCopyRequestId = async (reqId: string) => {
    try {
      await navigator.clipboard.writeText(reqId);
      setCopiedReqId(reqId);
      setTimeout(() => setCopiedReqId(null), 1800);
    } catch {
      // Clipboard blocked in restricted iframe
    }
  };

  const handleCampaignRequestSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!campaignTarget || submittingRequest) return;
    setFeedback(null);
    setSubmittingRequest(true);
    try {
      let evidenceUrl = '';
      let evidencePath = '';
      if (campaignTarget.requiresEvidence) {
        if (!evidenceFile) {
          throw new Error('Silakan pilih atau ambil foto bukti terlebih dahulu.');
        }
        const uploaded = await uploadClaimEvidence(evidenceFile);
        evidenceUrl = uploaded.evidenceUrl;
        evidencePath = uploaded.evidencePath;
      }

      const res = await submitBenefitRequestForMember({
        member: memberProfile,
        sourceType: campaignTarget.type,
        sourceId: campaignTarget.id,
        campaign: campaignTarget,
        levels,
        evidenceUrl,
        evidencePath,
        note: requestNote,
        branch: memberProfile.preferredBranch ?? null,
        adminSdkConfigured: capabilities.adminSdkConfigured,
      });

      setFeedback({
        type: 'success',
        text: `Benefit Request ${res.request.id} berhasil dikirim dan menunggu persetujuan Admin.`,
      });
      setCampaignTarget(null);
      setEvidenceFile(null);
      setRequestNote('');
      await Promise.all([refreshProfiles(), loadMemberFeeds()]);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setSubmittingRequest(false);
    }
  };

  const handleConfirmBenefitRequest = async () => {
    if (!benefitConfirmTarget || submittingRequest) return;
    setSubmittingRequest(true);
    setFeedback(null);
    try {
      const sourceType = benefitConfirmTarget.xpCost > 0 ? 'GENERAL_BENEFIT' : 'LEVEL_BENEFIT';
      const res = await submitBenefitRequestForMember({
        member: memberProfile,
        sourceType,
        sourceId: benefitConfirmTarget.id,
        benefit: benefitConfirmTarget,
        levels,
        branch: memberProfile.preferredBranch ?? null,
        adminSdkConfigured: capabilities.adminSdkConfigured,
      });
      setFeedback({
        type: 'success',
        text:
          benefitConfirmTarget.xpCost > 0
            ? `Pengajuan ${res.request.id} dikirim! ${benefitConfirmTarget.xpCost} XP Reward ditahan sementara (Hold). Jika ditolak, XP otomatis kembali.`
            : `Pengajuan ${res.request.id} berhasil dikirim dan menunggu persetujuan Admin.`,
      });
      setBenefitConfirmTarget(null);
      await Promise.all([refreshProfiles(), loadMemberFeeds()]);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setSubmittingRequest(false);
    }
  };

  const handleMarkNotifRead = async (notifId: string) => {
    try {
      await markMemberNotificationRead(notifId);
      await loadMemberFeeds();
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    }
  };

  const handleSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    if (isMaintenance) {
      setFeedback({
        type: 'error',
        text: restoreLock?.message || 'XP PLAY sedang melakukan maintenance sistem. Silakan kembali beberapa saat lagi.',
      });
      return;
    }
    setSavingProfile(true);
    setFeedback(null);
    try {
      await updateMemberOwnProfile(memberProfile.uid, {
        fullName: editFullName,
        socialMedia: editSocial,
        preferredBranch: editBranch,
        birthDate: editBirthDate || null,
        memberCategory: editCategory || null,
      });
      await refreshProfiles();
      setFeedback({ type: 'success', text: 'Profil member berhasil diperbarui.' });
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setSavingProfile(false);
    }
  };

  const showBenefits =
    catalogFilter === 'ALL' || catalogFilter === 'REWARD_BENEFIT' || catalogFilter === 'LEVEL_BENEFIT';
  const showCampaigns =
    catalogFilter === 'ALL' || catalogFilter === 'CHALLENGE' || catalogFilter === 'EVENT' || catalogFilter === 'PROMO';

  const visibleBenefits = benefits.filter((b) => {
    if (catalogFilter === 'REWARD_BENEFIT') return b.xpCost > 0;
    if (catalogFilter === 'LEVEL_BENEFIT') return b.xpCost === 0;
    return true;
  });

  const visibleCampaigns = campaigns.filter((c) => {
    if (catalogFilter === 'CHALLENGE' || catalogFilter === 'EVENT' || catalogFilter === 'PROMO') {
      return c.type === catalogFilter;
    }
    return true;
  });

  if (isMaintenance) {
    return (
      <div className="min-h-screen gaming-canvas text-slate-100 flex items-center justify-center px-4">
        <div className="max-w-lg w-full rounded-2xl bg-[#0B1124] border border-amber-500/40 p-8 text-center space-y-5 shadow-2xl">
          <div className="font-display text-xl font-extrabold tracking-tight bg-gradient-to-r from-sky-300 via-blue-300 to-purple-300 bg-clip-text text-transparent">
            XP PLAY
          </div>
          <h1 className="font-display text-2xl font-bold text-white">
            Maintenance Sistem Sedang Berlangsung
          </h1>
          <p className="text-sm text-amber-200 leading-relaxed">
            {restoreLock?.message ||
              'XP PLAY sedang melakukan maintenance sistem. Silakan kembali beberapa saat lagi.'}
          </p>
          <p className="text-xs text-slate-400">
            Pengajuan benefit dan perubahan profil dinonaktifkan sementara demi menjaga integritas data akun Anda.
          </p>
          <div className="pt-2 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap"
            >
              Periksa Status Kembali
            </button>
            <button
              type="button"
              onClick={() => void logout()}
              className="px-4 py-2.5 rounded-lg border border-indigo-400/30 text-slate-200 hover:text-white text-xs font-medium transition-colors whitespace-nowrap"
            >
              Keluar
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen gaming-canvas text-slate-100 pb-24 md:pb-10 overflow-x-hidden">
      {/* Top Bar: 3-zone contract with 4 unified nav destinations */}
      <header className="sticky top-0 z-30 bg-[#050814]/90 backdrop-blur-md border-b border-indigo-500/20">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 h-14 sm:h-16 flex items-center justify-between gap-6">
          <div className="font-display text-lg font-extrabold tracking-tight bg-gradient-to-r from-sky-300 via-blue-300 to-purple-300 bg-clip-text text-transparent whitespace-nowrap shrink-0">
            XP PLAY
          </div>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-300">
            {(
              [
                ['overview', 'Ringkasan'],
                ['benefits', `Benefit${activeApprovedVouchers.length > 0 ? ` (${activeApprovedVouchers.length})` : ''}`],
                ['history', 'Riwayat'],
                ['profile', `Profil${unreadNotifs > 0 ? ` (${unreadNotifs})` : ''}`],
              ] as [MemberTab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`whitespace-nowrap shrink-0 py-1.5 border-b-2 transition-colors ${
                  activeTab === id
                    ? 'border-sky-400 text-white font-semibold'
                    : 'border-transparent hover:text-sky-300'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <span className="hidden sm:inline text-xs font-mono text-sky-300/80">
              @{memberProfile.username}
            </span>
            <button
              type="button"
              onClick={() => void logout()}
              className="inline-flex items-center gap-1.5 min-h-[38px] rounded-xl border border-indigo-500/30 bg-[#0B1124] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-sky-400/50 hover:text-white whitespace-nowrap shrink-0 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5 text-purple-300" />
              <span>Keluar</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-8 py-5 sm:py-7 space-y-6">
        {/* Global Feedback */}
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
            <button
              type="button"
              onClick={() => setFeedback(null)}
              className="text-xs font-semibold underline shrink-0 min-h-[36px] px-2"
            >
              Tutup
            </button>
          </div>
        )}

        {/* 1. OVERVIEW TAB */}
        {activeTab === 'overview' && (
          <div className="space-y-6">
            <MemberXpShowcase
              memberId={memberProfile.memberId}
              fullName={memberProfile.fullName}
              username={memberProfile.username}
              cycleId={systemSettings.currentCycleId}
              xpProgress={memberProfile.xpProgress}
              xpReward={memberProfile.xpReward}
              reservedXp={reservedXp}
              levels={levels}
              currentLevel={memberProfile.currentLevel}
              levelMode={memberProfile.levelMode}
              lastPlayAt={memberProfile.lastPlayAt}
              lastPlayBranch={memberProfile.lastPlayBranch}
              referralCount={memberProfile.referralCount}
              onOpenBenefits={() => setActiveTab('benefits')}
            />

            {/* Active Approved Benefits Ready for Cashier + Recent Notifications */}
            <div className="grid lg:grid-cols-2 gap-6">
              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-display text-lg font-bold text-white">
                    Benefit Aktif Siap Dipakai
                  </h2>
                  <button
                    type="button"
                    onClick={() => setActiveTab('benefits')}
                    className="text-xs font-semibold text-sky-300 hover:underline min-h-[36px]"
                  >
                    Buka Katalog Benefit
                  </button>
                </div>
                {loadingCatalog ? (
                  <div className="h-24 rounded-xl bg-[#070B19] animate-pulse" />
                ) : activeApprovedVouchers.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    Belum ada benefit disetujui yang menunggu dipakai di kasir. Ajukan benefit atau challenge di tab Benefit.
                  </p>
                ) : (
                  <ul className="divide-y divide-indigo-500/15">
                    {activeApprovedVouchers.slice(0, 4).map((r) => (
                      <li key={r.id} className="py-3 flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-white truncate">{r.title}</p>
                          <p className="text-xs text-slate-400 font-mono">
                            ID: <span className="text-sky-300 font-bold">{r.id}</span> · Sisa waktu:{' '}
                            <span className="text-emerald-400">{getBenefitRemainingDaysLabel(r.expiresAt)}</span>
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleCopyRequestId(r.id)}
                          className="inline-flex items-center gap-1.5 min-h-[38px] rounded-xl border border-emerald-400/35 bg-emerald-500/10 px-3 py-1.5 text-xs font-mono font-semibold text-emerald-300 hover:bg-emerald-500/20 shrink-0"
                        >
                          {copiedReqId === r.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                          <span>{copiedReqId === r.id ? 'Disalin' : 'Salin ID'}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-display text-lg font-bold text-white">Notifikasi Terbaru</h2>
                  <button
                    type="button"
                    onClick={() => setActiveTab('profile')}
                    className="text-xs font-semibold text-purple-300 hover:underline min-h-[36px]"
                  >
                    Semua ({unreadNotifs} baru)
                  </button>
                </div>
                {notifications.length === 0 ? (
                  <p className="text-sm text-slate-400">Belum ada notifikasi baru.</p>
                ) : (
                  <ul className="divide-y divide-indigo-500/15">
                    {notifications.slice(0, 4).map((n) => (
                      <li key={n.id} className="py-3 flex items-start justify-between gap-3">
                        <div className="space-y-0.5 min-w-0">
                          <p className={`text-sm ${n.read ? 'font-medium text-slate-300' : 'font-bold text-white'}`}>
                            {n.title}
                          </p>
                          <p className="text-xs text-slate-400">{n.message}</p>
                          <p className="text-[11px] text-slate-500 font-mono">
                            {formatJakartaDateTime(n.createdAt)} WIB
                          </p>
                        </div>
                        {!n.read && (
                          <button
                            type="button"
                            onClick={() => void handleMarkNotifRead(n.id)}
                            className="text-xs font-semibold text-sky-300 hover:underline shrink-0 min-h-[36px]"
                          >
                            Tandai dibaca
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 2. UNIFIED BENEFIT TAB (FASE 1–4: Claim + Redeem + 7-Day Validity) */}
        {activeTab === 'benefits' && (
          <div className="space-y-6">
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
              <div>
                <h1 className="font-display text-2xl font-bold text-white">Benefit, Challenge &amp; Promo</h1>
                <p className="text-sm text-slate-300 mt-1">
                  XP Reward Tersedia:{' '}
                  <strong className="font-mono text-purple-300 tabular-nums">{memberProfile.xpReward} XP</strong>
                  {reservedXp > 0 && (
                    <>
                      {' '}· Ditahan (Hold):{' '}
                      <strong className="font-mono text-amber-300 tabular-nums">{reservedXp} XP</strong>
                    </>
                  )}{' '}
                  · Level: <strong className="text-sky-300">{effectiveLevel.name}</strong>
                </p>
              </div>

              <div className="flex items-center gap-1 p-1 rounded-xl bg-[#0B1124] border border-indigo-500/25 self-start overflow-x-auto no-scrollbar max-w-full">
                {(
                  [
                    ['ALL', 'Semua'],
                    ['REWARD_BENEFIT', 'Tukar XP'],
                    ['LEVEL_BENEFIT', 'Benefit Level'],
                    ['CHALLENGE', 'Challenge'],
                    ['EVENT', 'Event'],
                    ['PROMO', 'Promo'],
                  ] as [UnifiedCatalogFilter, string][]
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setCatalogFilter(key)}
                    className={`px-3 py-2 min-h-[38px] rounded-lg text-xs font-semibold transition-all whitespace-nowrap shrink-0 ${
                      catalogFilter === key
                        ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Unified Catalog Grid */}
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
              {showBenefits &&
                visibleBenefits.map((b) => {
                  const eligibleLevel = isLevelEligible(effectiveLevel.id, b.levelRequirement, levels);
                  const enoughXp = memberProfile.xpReward >= b.xpCost;
                  const outOfStock = b.stock !== null && b.stock <= 0;
                  const expired = Boolean(b.expiryAt && Date.now() > b.expiryAt);
                  const canSubmit = eligibleLevel && (b.claimable || b.redeemable) && enoughXp && !outOfStock && !expired;

                  let buttonLabel = b.xpCost > 0 ? `AJUKAN BENEFIT (${b.xpCost} XP)` : 'AJUKAN BENEFIT LEVEL';
                  if (!b.claimable && !b.redeemable) buttonLabel = 'INFO SAJA (TERKUNCI)';
                  else if (!eligibleLevel) buttonLabel = `Minimal Level ${b.levelRequirement}`;
                  else if (expired) buttonLabel = 'Katalog Berakhir';
                  else if (outOfStock) buttonLabel = 'Stok Habis';
                  else if (!enoughXp) buttonLabel = `XP Kurang (Butuh ${b.xpCost} XP)`;

                  return (
                    <div
                      key={`ben_${b.id}`}
                      className="bg-[#0B1124] rounded-2xl border border-indigo-500/25 p-5 flex flex-col justify-between gap-4"
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-400">
                            {b.xpCost > 0 ? 'General Benefit' : 'Level Benefit'} · Min. {b.levelRequirement}
                          </span>
                          <span className="font-mono font-semibold text-purple-300 tabular-nums">
                            {b.xpCost > 0 ? `${b.xpCost} XP` : 'Gratis Level'}
                          </span>
                        </div>
                        <h3 className="font-display text-lg font-bold text-white">{b.name}</h3>
                        <p className="text-sm text-slate-300 leading-relaxed">{b.description}</p>
                        {b.stock !== null && (
                          <p className="text-xs text-sky-300 font-mono">Sisa kuota: {b.stock}</p>
                        )}
                        {b.terms && (
                          <p className="text-xs text-slate-400 border-t border-indigo-500/15 pt-2">
                            Ketentuan: {b.terms}
                          </p>
                        )}
                      </div>

                      <button
                        type="button"
                        disabled={!canSubmit || submittingRequest}
                        onClick={() => setBenefitConfirmTarget(b)}
                        className="w-full h-[46px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 disabled:bg-none disabled:bg-slate-800 disabled:text-slate-500 transition-all"
                      >
                        {buttonLabel}
                      </button>
                    </div>
                  );
                })}

              {showCampaigns &&
                visibleCampaigns.map((camp) => {
                  const status = resolveCampaignStatus(camp);
                  const claimable = isCampaignClaimable(camp);
                  const reqCount = myRequests.filter(
                    (r) => r.sourceId === camp.id && (r.status === 'ON_PROCESS' || r.status === 'APPROVED' || r.status === 'USED')
                  ).length;
                  const legacyCount = myLegacyClaims.filter(
                    (cl) => cl.campaignId === camp.id && (cl.status === 'ON_PROCESS' || cl.status === 'APPROVED')
                  ).length;
                  const limitReached = reqCount + legacyCount >= camp.maxClaimsPerMember;

                  return (
                    <div
                      key={`camp_${camp.id}`}
                      className="bg-[#0B1124] rounded-2xl border border-sky-500/25 p-5 flex flex-col justify-between gap-4"
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-sky-300 font-mono font-semibold">
                            {camp.type} · +{camp.xpReward} XP
                          </span>
                          <span className={status === 'ACTIVE' ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                            {status}
                          </span>
                        </div>
                        <h3 className="font-display text-lg font-bold text-white">{camp.title}</h3>
                        <p className="text-sm text-slate-300 leading-relaxed">{camp.description}</p>
                        {camp.terms && (
                          <p className="text-xs text-slate-400 border-t border-indigo-500/15 pt-2">
                            Syarat: {camp.terms}
                          </p>
                        )}
                        <p className="text-xs text-slate-400 font-mono">
                          Berakhir: {formatJakartaDateTime(camp.endAt)} WIB
                        </p>
                      </div>

                      <button
                        type="button"
                        disabled={!claimable || limitReached}
                        onClick={() => {
                          setCampaignTarget(camp);
                          setEvidenceFile(null);
                          setRequestNote('');
                        }}
                        className="w-full h-[46px] rounded-xl bg-gradient-to-r from-sky-600 to-indigo-600 text-sm font-semibold text-white hover:from-sky-500 hover:to-indigo-500 disabled:bg-none disabled:bg-slate-800 disabled:text-slate-500 transition-all"
                      >
                        {!claimable
                          ? 'Program Tidak Aktif'
                          : limitReached
                            ? 'Sudah Diajukan'
                            : `AJUKAN ${camp.type} (+${camp.xpReward} XP)`}
                      </button>
                    </div>
                  );
                })}
            </div>

            {(!showBenefits || visibleBenefits.length === 0) && (!showCampaigns || visibleCampaigns.length === 0) && (
              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-8 text-center text-sm text-slate-400">
                Belum ada benefit atau program pada kategori ini.
              </div>
            )}

            {/* Status Pengajuan Benefit Saya (Unified Benefit Requests) */}
            <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 sm:p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-display text-lg font-bold text-white">Status Pengajuan Benefit Saya</h2>
                  <p className="text-xs text-slate-400">
                    Benefit yang disetujui berlaku 7 hari. Tunjukkan Request ID ke kasir XP PLAY untuk digunakan.
                  </p>
                </div>
                {(myLegacyClaims.length > 0 || myLegacyRedemptions.length > 0) && (
                  <button
                    type="button"
                    onClick={() => setShowLegacyHistory((v) => !v)}
                    className="text-xs font-semibold text-sky-300 hover:underline min-h-[36px]"
                  >
                    {showLegacyHistory
                      ? 'Sembunyikan Riwayat Legacy'
                      : `Riwayat Legacy (${myLegacyClaims.length + myLegacyRedemptions.length})`}
                  </button>
                )}
              </div>

              {myRequests.length === 0 ? (
                <p className="text-sm text-slate-400">Belum ada pengajuan benefit.</p>
              ) : (
                <div className="divide-y divide-indigo-500/15">
                  {myRequests.map((req) => {
                    const effectiveExpired = isBenefitRequestEffectivelyExpired(req);
                    const displayStatus = effectiveExpired ? 'EXPIRED' : req.status;
                    const stInfo = STATUS_DISPLAY[displayStatus] ?? { label: displayStatus, color: 'text-slate-300' };
                    return (
                      <div key={req.id} className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="flex items-start gap-3 min-w-0">
                          {req.evidenceUrl && (
                            <ProtectedImage
                              src={req.evidenceUrl}
                              alt={`Bukti ${req.title}`}
                              className="w-14 h-14 rounded-xl object-cover border border-indigo-500/25 shrink-0"
                            />
                          )}
                          <div className="space-y-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs font-bold text-sky-300">{req.id}</span>
                              <span className="text-xs text-slate-500">·</span>
                              <span className="text-xs text-slate-400">{req.sourceType}</span>
                            </div>
                            <p className="text-sm font-semibold text-white">{req.title}</p>
                            <p className="text-xs text-slate-400 font-mono">
                              {req.xpCost > 0
                                ? `Biaya: ${req.xpCost} XP`
                                : req.xpRewardGrant > 0
                                  ? `Hadiah: +${req.xpRewardGrant} XP`
                                  : 'Benefit Level'}{' '}
                              · Diajukan: {formatJakartaDateTime(req.createdAt)} WIB
                            </p>

                            {req.status === 'APPROVED' && req.expiresAt && (
                              <p className="text-xs text-emerald-300 flex items-center gap-1.5 font-mono">
                                <Clock className="w-3.5 h-3.5 shrink-0" />
                                <span>
                                  Berlaku s/d {formatJakartaDateTime(req.expiresAt)} WIB (
                                  {getBenefitRemainingDaysLabel(req.expiresAt)})
                                </span>
                              </p>
                            )}
                            {req.status === 'USED' && req.usedAt && (
                              <p className="text-xs text-sky-300 font-mono">
                                Digunakan {formatJakartaDateTime(req.usedAt)} WIB di {getBranchLabel(req.usedBranch)}
                              </p>
                            )}
                            {req.deniedReason && (
                              <p className="text-xs text-rose-400">Alasan ditolak: {req.deniedReason}</p>
                            )}
                            {req.status === 'REFUNDED' && req.refundedAmount > 0 && (
                              <p className="text-xs text-purple-300 font-mono">
                                +{req.refundedAmount} XP telah dikembalikan ke saldo XP Reward Anda.
                              </p>
                            )}
                          </div>
                        </div>

                        <div className="flex sm:flex-col items-center sm:items-end justify-between gap-2 shrink-0">
                          <span className={`text-xs font-mono font-bold ${stInfo.color}`}>{stInfo.label}</span>
                          {req.status === 'APPROVED' && !effectiveExpired && (
                            <button
                              type="button"
                              onClick={() => void handleCopyRequestId(req.id)}
                              className="inline-flex items-center gap-1.5 min-h-[34px] rounded-lg border border-sky-400/35 bg-[#070B19] px-2.5 text-[11px] font-mono text-sky-300 hover:border-sky-300"
                            >
                              {copiedReqId === req.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                              <span>{copiedReqId === req.id ? 'ID Disalin' : 'Salin Request ID'}</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Legacy Claims & Redemptions Compatibility Section */}
              {showLegacyHistory && (
                <div className="pt-4 border-t border-indigo-500/20 space-y-3">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Riwayat Legacy (Sebelum Penyatuan Benefit Request)
                  </p>
                  {myLegacyClaims.map((cl) => (
                    <div key={cl.id} className="flex items-center justify-between gap-3 text-xs py-1.5">
                      <span className="text-slate-300">
                        [Claim] {cl.campaignTitle} (+{cl.xpRewardSnapshot} XP) · {formatJakartaDateTime(cl.createdAt)}
                      </span>
                      <span className="font-mono font-semibold text-slate-400">{cl.status}</span>
                    </div>
                  ))}
                  {myLegacyRedemptions.map((rd) => (
                    <div key={rd.id} className="flex items-center justify-between gap-3 text-xs py-1.5">
                      <span className="text-slate-300">
                        [Redeem] {rd.benefitName} ({rd.xpCostSnapshot} XP) · {formatJakartaDateTime(rd.createdAt)}
                      </span>
                      <span className="font-mono font-semibold text-slate-400">{rd.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 3. HISTORY TAB */}
        {activeTab === 'history' && (
          <div className="space-y-5">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div>
                <h1 className="font-display text-2xl font-bold text-white">Riwayat &amp; Ledger XP</h1>
                <p className="text-sm text-slate-300">
                  Catatan transparan XP bertambah, ditahan (hold), dikembalikan (refund), dan transaksi.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {(
                  [
                    ['xpReward', 'XP Reward'],
                    ['xpProgress', 'XP Progress'],
                    ['transactions', 'Transaksi'],
                    ['referrals', 'Referral'],
                    ['levels', 'Level Up'],
                  ] as [HistoryKind, string][]
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setHistoryKind(k)}
                    className={`px-3.5 py-2 min-h-[40px] rounded-xl text-xs font-semibold border transition-all whitespace-nowrap ${
                      historyKind === k
                        ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white border-sky-400/50'
                        : 'bg-[#0B1124] text-slate-300 border-indigo-500/25 hover:border-sky-400/50 hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                ))}

                {(historyKind === 'xpProgress' || historyKind === 'transactions') && (
                  <select
                    value={branchFilter}
                    onChange={(e) => setBranchFilter(e.target.value as 'ALL' | BranchId)}
                    className="h-10 rounded-xl border border-indigo-500/30 bg-[#0B1124] px-3 text-xs font-medium text-slate-200 focus:border-sky-400 focus:outline-none"
                  >
                    <option value="ALL">Semua Cabang</option>
                    <option value="DEMANG">Cabang Demang</option>
                    <option value="SEKIP">Cabang Sekip</option>
                  </select>
                )}
              </div>
            </div>

            <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 overflow-hidden">
              {loadingHistory && activeHistoryItems.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-400">Memuat riwayat...</div>
              ) : activeHistoryItems.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-400">Belum ada riwayat pada kategori ini.</div>
              ) : (
                <div className="divide-y divide-indigo-500/15">
                  {activeHistoryItems.map((item, idx) => {
                    if (historyKind === 'xpProgress' || historyKind === 'xpReward') {
                      const entry = item as XpLedgerEntry;
                      const mov = classifyXpLedgerMovement(entry);
                      const movLabel = getXpLedgerMovementLabel(entry);
                      const amountColor =
                        mov === 'REFUND'
                          ? 'text-purple-300'
                          : entry.amount >= 0
                            ? 'text-emerald-400'
                            : 'text-rose-400';

                      return (
                        <div key={entry.id || idx} className="p-4 flex items-center justify-between gap-4">
                          <div className="space-y-0.5 min-w-0">
                            <p className="text-sm font-semibold text-white">{entry.note}</p>
                            <p className="text-xs text-slate-400">
                              <span className="text-sky-300">{movLabel}</span> · {entry.source} ·{' '}
                              {entry.branch ? getBranchLabel(entry.branch) : 'Sistem'} ·{' '}
                              {formatJakartaDateTime(entry.createdAt)} WIB
                            </p>
                            {typeof entry.beforeBalance === 'number' && typeof entry.afterBalance === 'number' && (
                              <p className="text-[11px] font-mono text-slate-500 tabular-nums">
                                Saldo: {entry.beforeBalance} XP → {entry.afterBalance} XP
                              </p>
                            )}
                          </div>
                          <span className={`font-mono text-sm font-bold tabular-nums shrink-0 ${amountColor}`}>
                            {entry.amount >= 0 ? `+${entry.amount}` : entry.amount} XP
                          </span>
                        </div>
                      );
                    }
                    if (historyKind === 'transactions') {
                      const trx = item as TransactionRecord;
                      return (
                        <div key={trx.id || idx} className="p-4 flex items-center justify-between gap-4">
                          <div className="space-y-0.5 min-w-0">
                            <p className="text-sm font-semibold text-white">
                              {formatIdr(trx.amountIdr)} · {getBranchLabel(trx.branch)}
                            </p>
                            <p className="text-xs text-slate-400">
                              Struk: {trx.receiptNumber || '-'} · {formatJakartaDateTime(trx.createdAt)} WIB
                            </p>
                          </div>
                          <span className="font-mono text-sm font-bold text-sky-300 tabular-nums shrink-0">
                            +{trx.xpGenerated} XP
                          </span>
                        </div>
                      );
                    }
                    if (historyKind === 'referrals') {
                      const ref = item as ReferralRecord;
                      return (
                        <div key={ref.id || idx} className="p-4 flex items-center justify-between gap-4">
                          <div>
                            <p className="text-sm font-semibold text-white">Mengajak @{ref.refereeUsername}</p>
                            <p className="text-xs text-slate-400">{formatJakartaDateTime(ref.createdAt)} WIB</p>
                          </div>
                          <span className="font-mono text-sm font-bold text-purple-300 tabular-nums">
                            +{ref.referrerXp} XP
                          </span>
                        </div>
                      );
                    }
                    const lh = item as LevelHistoryRecord;
                    return (
                      <div key={lh.id || idx} className="p-4 flex items-center justify-between gap-4">
                        <div>
                          <p className="text-sm font-semibold text-white">
                            Perubahan Level: {lh.fromLevel} → {lh.toLevel}
                          </p>
                          <p className="text-xs text-slate-400">
                            XP Progress: {lh.xpProgressAtEvent} XP · {formatJakartaDateTime(lh.createdAt)} WIB
                          </p>
                        </div>
                        <span className="font-mono text-xs font-semibold text-sky-300">{lh.source}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {historyHasMore && (
                <div className="p-4 border-t border-indigo-500/15 text-center">
                  <button
                    type="button"
                    disabled={loadingHistory}
                    onClick={() => void loadHistory(false)}
                    className="min-h-[42px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-5 py-2 text-xs font-semibold text-sky-300 hover:border-sky-400 transition-colors"
                  >
                    {loadingHistory ? 'Memuat...' : 'Muat Lebih Banyak'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 4. PROFILE & NOTIFICATIONS TAB */}
        {activeTab === 'profile' && (
          <div className="grid lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 sm:p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-lg font-bold text-white">Semua Notifikasi</h2>
                <span className="text-xs text-sky-300 font-mono">{unreadNotifs} belum dibaca</span>
              </div>
              {notifications.length === 0 ? (
                <p className="text-sm text-slate-400">Belum ada notifikasi untuk Anda.</p>
              ) : (
                <div className="divide-y divide-indigo-500/15">
                  {notifications.map((n) => (
                    <div key={n.id} className="py-3.5 flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <p className={`text-sm ${n.read ? 'font-medium text-slate-300' : 'font-bold text-white'}`}>
                          {n.title}
                        </p>
                        <p className="text-xs text-slate-400">{n.message}</p>
                        <p className="text-[11px] text-slate-500 font-mono">
                          {n.category} · {formatJakartaDateTime(n.createdAt)} WIB
                        </p>
                      </div>
                      {!n.read && (
                        <button
                          type="button"
                          onClick={() => void handleMarkNotifRead(n.id)}
                          className="min-h-[36px] rounded-lg border border-sky-400/35 px-3 py-1 text-xs font-medium text-sky-300 hover:bg-sky-500/15 shrink-0"
                        >
                          Baca
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="lg:col-span-5 space-y-6">
              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 sm:p-6 space-y-4">
                <h2 className="font-display text-lg font-bold text-white">Profil &amp; Pengaturan</h2>
                <form onSubmit={handleSaveProfile} className="space-y-3.5">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1">Username</label>
                      <input
                        type="text"
                        disabled
                        value={`@${memberProfile.username}`}
                        className="w-full h-[44px] rounded-xl border border-indigo-500/20 bg-[#070B19]/60 px-3 text-xs font-mono text-slate-400"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1">WhatsApp</label>
                      <input
                        type="text"
                        disabled
                        value={memberProfile.whatsapp}
                        className="w-full h-[44px] rounded-xl border border-indigo-500/20 bg-[#070B19]/60 px-3 text-xs font-mono text-slate-400"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Nama Lengkap</label>
                    <input
                      type="text"
                      required
                      value={editFullName}
                      onChange={(e) => setEditFullName(e.target.value)}
                      className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-sm text-white focus:border-sky-400 focus:outline-none"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Tanggal Lahir ({formatBirthDateJakarta(memberProfile.birthDate)})
                      </label>
                      <input
                        type="date"
                        max={todayJakarta}
                        value={editBirthDate}
                        onChange={(e) => setEditBirthDate(e.target.value)}
                        className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-xs font-mono text-white focus:border-sky-400 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Status ({getMemberCategoryLabel(memberProfile.memberCategory)})
                      </label>
                      <select
                        value={editCategory}
                        onChange={(e) => setEditCategory(e.target.value as MemberCategory | '')}
                        className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-sm text-white focus:border-sky-400 focus:outline-none"
                      >
                        <option value="">-- Pilih Status --</option>
                        {MEMBER_CATEGORIES.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Sosial Media</label>
                    <input
                      type="text"
                      value={editSocial}
                      onChange={(e) => setEditSocial(e.target.value)}
                      className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-sm text-white focus:border-sky-400 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Cabang Favorit</label>
                    <select
                      value={editBranch}
                      onChange={(e) => setEditBranch(e.target.value as BranchId)}
                      className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-sm text-white focus:border-sky-400 focus:outline-none"
                    >
                      <option value="DEMANG">XP PLAY DEMANG</option>
                      <option value="SEKIP">XP PLAY SEKIP</option>
                    </select>
                  </div>
                  <button
                    type="submit"
                    disabled={savingProfile}
                    className="w-full h-[46px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 disabled:opacity-50"
                  >
                    {savingProfile ? 'Menyimpan...' : 'Simpan Profil'}
                  </button>
                </form>
              </div>

              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 sm:p-6 space-y-3">
                <h3 className="font-display text-base font-bold text-white flex items-center gap-2">
                  <Users className="w-4 h-4 text-purple-400" />
                  <span>Referral &amp; Lokasi Cabang</span>
                </h3>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Bagikan username Anda (<strong className="font-mono text-sky-300">{memberProfile.username}</strong>) saat teman mendaftar agar keduanya memperoleh +{systemSettings.referralBonusXp} XP!
                </p>
                <div className="space-y-2 pt-2 border-t border-indigo-500/15">
                  {branches.map((br) => (
                    <a
                      key={br.id}
                      href={br.mapsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-between min-h-[40px] text-xs text-slate-300 hover:text-sky-300 py-1 transition-colors"
                    >
                      <span className="flex items-center gap-1.5">
                        <MapPin className="w-3.5 h-3.5 text-sky-400" />
                        <span>{br.name}</span>
                      </span>
                      <span className="underline">Maps</span>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Benefit Request Confirmation Modal (Immediate XP Hold Transparency) */}
      {benefitConfirmTarget && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="w-full sm:max-w-md bg-[#0B1124] rounded-t-3xl sm:rounded-2xl border border-indigo-500/35 p-5 sm:p-6 space-y-4">
            <div className="sm:hidden w-10 h-1.5 rounded-full bg-slate-700 mx-auto mb-1" />
            <div>
              <p className="text-xs font-mono text-purple-300">
                {benefitConfirmTarget.xpCost > 0 ? 'Konfirmasi Penukaran XP' : 'Konfirmasi Benefit Level'}
              </p>
              <h2 className="font-display text-lg font-bold text-white mt-0.5">{benefitConfirmTarget.name}</h2>
            </div>

            <div className="rounded-xl bg-[#070B19] border border-indigo-500/20 p-4 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400">XP Reward Tersedia Saat Ini</span>
                <span className="font-mono font-bold text-white tabular-nums">{memberProfile.xpReward} XP</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Biaya Benefit (Hold Langsung)</span>
                <span className="font-mono font-bold text-amber-300 tabular-nums">
                  {benefitConfirmTarget.xpCost > 0 ? `-${benefitConfirmTarget.xpCost} XP` : '0 XP (Gratis)'}
                </span>
              </div>
              <div className="flex justify-between pt-2 border-t border-indigo-500/15">
                <span className="text-slate-300">Sisa XP Reward Tersedia</span>
                <span className="font-mono font-bold text-sky-300 tabular-nums">
                  {memberProfile.xpReward - benefitConfirmTarget.xpCost} XP
                </span>
              </div>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              {benefitConfirmTarget.xpCost > 0
                ? 'XP Reward akan langsung ditahan (Hold) saat diajukan. XP Progress & Level Anda tidak berkurang. Jika ditolak Admin, XP otomatis dikembalikan 100%. Setelah disetujui, benefit berlaku 7 hari.'
                : 'Pengajuan benefit level akan dikirim ke Admin untuk verifikasi. Setelah disetujui, benefit berlaku 7 hari dan dapat dipakai di kasir.'}
            </p>

            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={submittingRequest}
                onClick={() => setBenefitConfirmTarget(null)}
                className="flex-1 h-[46px] rounded-xl border border-indigo-500/30 text-sm font-semibold text-slate-300 hover:text-white disabled:opacity-40"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={submittingRequest}
                onClick={() => void handleConfirmBenefitRequest()}
                className="flex-1 h-[46px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 disabled:opacity-50"
              >
                {submittingRequest ? 'Mengirim...' : 'Konfirmasi & Ajukan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Campaign Benefit Request Modal (Challenge / Event / Promo) */}
      {campaignTarget && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="w-full sm:max-w-md bg-[#0B1124] rounded-t-3xl sm:rounded-2xl border border-indigo-500/35 p-5 sm:p-6 space-y-4">
            <div className="sm:hidden w-10 h-1.5 rounded-full bg-slate-700 mx-auto mb-1" />
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-sky-300 font-mono">
                  {campaignTarget.type} · +{campaignTarget.xpReward} XP
                </p>
                <h2 className="font-display text-lg font-bold text-white">{campaignTarget.title}</h2>
              </div>
              <button
                type="button"
                disabled={submittingRequest}
                onClick={() => setCampaignTarget(null)}
                className="min-h-[36px] px-2 text-xs font-semibold text-slate-400 hover:text-white disabled:opacity-40"
              >
                Tutup
              </button>
            </div>

            <form onSubmit={handleCampaignRequestSubmit} className="space-y-4">
              {campaignTarget.requiresEvidence && (
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Upload Bukti Foto (JPG/PNG/WEBP, maks. 5 MB) *
                  </label>
                  <label className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-indigo-500/35 bg-[#070B19] p-4 cursor-pointer hover:border-sky-400/60 transition-colors">
                    <Upload className="w-5 h-5 text-sky-300 mb-1.5" />
                    <span className="text-xs font-medium text-slate-200 text-center">
                      {evidenceFile ? evidenceFile.name : 'Pilih foto dari galeri / kamera'}
                    </span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={(e) => setEvidenceFile(e.target.files?.[0] || null)}
                    />
                  </label>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Catatan / Keterangan (Opsional)
                </label>
                <textarea
                  rows={3}
                  value={requestNote}
                  onChange={(e) => setRequestNote(e.target.value)}
                  placeholder="Contoh: Sudah follow & tag story IG @xpplay"
                  className="w-full rounded-xl border border-indigo-500/30 bg-[#070B19] p-3 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
                />
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={submittingRequest}
                  onClick={() => setCampaignTarget(null)}
                  className="flex-1 h-[46px] rounded-xl border border-indigo-500/30 text-sm font-semibold text-slate-300 hover:text-white disabled:opacity-40"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={submittingRequest}
                  className="flex-1 h-[46px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 disabled:opacity-50"
                >
                  {submittingRequest ? 'Mengirim...' : 'Kirim Pengajuan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Mobile Bottom Tab Bar — Clean 4-Tab Navigation (44px+ hitboxes) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#070B1A]/95 backdrop-blur-md border-t border-indigo-500/25 grid grid-cols-4 h-16">
        {(
          [
            ['overview', 'Home', Home],
            ['benefits', 'Benefit', Gift],
            ['history', 'Riwayat', History],
            ['profile', 'Profil', unreadNotifs > 0 ? Bell : UserIcon],
          ] as [MemberTab, string, typeof Home][]
        ).map(([id, label, Icon]) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={`flex flex-col items-center justify-center min-h-[44px] transition-colors ${
                active ? 'text-sky-300 font-semibold' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon className={`w-5 h-5 ${active ? 'text-sky-300' : ''}`} />
              <span className="text-[11px] mt-1 leading-none">{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
