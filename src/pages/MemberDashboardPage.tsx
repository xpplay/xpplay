import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Award,
  Bell,
  Gift,
  History,
  Home,
  LogOut,
  MapPin,
  Sparkles,
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
  fetchActiveBenefits,
  fetchActiveCampaigns,
  fetchPaginatedCollection,
  markMemberNotificationRead,
  submitClaimForMember,
  submitRedemptionForMember,
  updateMemberOwnProfile,
  uploadClaimEvidence,
} from '../services/xpService.ts';
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
  BranchId,
  CampaignItem,
  CampaignType,
  ClaimRecord,
  LevelHistoryRecord,
  MemberNotification,
  RedemptionRecord,
  ReferralRecord,
  TransactionRecord,
  XpLedgerEntry,
} from '../types/xpplay.ts';

type MemberTab = 'overview' | 'programs' | 'benefits' | 'history' | 'profile';
type HistoryKind = 'xpProgress' | 'xpReward' | 'transactions' | 'referrals' | 'levels';

export function MemberDashboardPage() {
  const { memberProfile, levels, branches, systemSettings, restoreLock, logout, refreshProfiles } = useAuth();
  const isMaintenance = Boolean(restoreLock?.locked);
  const [activeTab, setActiveTab] = useState<MemberTab>('overview');

  // Programs & Benefits
  const [campaigns, setCampaigns] = useState<CampaignItem[]>([]);
  const [campaignFilter, setCampaignFilter] = useState<'ALL' | CampaignType>('ALL');
  const [benefits, setBenefits] = useState<BenefitItem[]>([]);
  const [myClaims, setMyClaims] = useState<ClaimRecord[]>([]);
  const [myRedemptions, setMyRedemptions] = useState<RedemptionRecord[]>([]);
  const [notifications, setNotifications] = useState<MemberNotification[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);

  // Claim modal state
  const [claimTarget, setClaimTarget] = useState<CampaignItem | null>(null);
  const [claimFile, setClaimFile] = useState<File | null>(null);
  const [claimNote, setClaimNote] = useState('');
  const [submittingClaim, setSubmittingClaim] = useState(false);

  // History pagination state
  const [historyKind, setHistoryKind] = useState<HistoryKind>('xpProgress');
  const [branchFilter, setBranchFilter] = useState<'ALL' | BranchId>('ALL');
  const [historyItems, setHistoryItems] = useState<unknown[]>([]);
  const [historyOwnerKey, setHistoryOwnerKey] = useState<string>('');
  const [historyCursor, setHistoryCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const historySeqRef = useRef(0);

  // Redemption submitting guard
  const [redeemingId, setRedeemingId] = useState<string | null>(null);

  // Profile edit state
  const [editFullName, setEditFullName] = useState('');
  const [editSocial, setEditSocial] = useState('');
  const [editBranch, setEditBranch] = useState<BranchId>('DEMANG');
  const [savingProfile, setSavingProfile] = useState(false);

  // Feedback banner
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (memberProfile) {
      setEditFullName(memberProfile.fullName);
      setEditSocial(memberProfile.socialMedia || '');
      setEditBranch(memberProfile.preferredBranch || 'DEMANG');
    }
  }, [memberProfile?.uid]);

  const loadMemberFeeds = async () => {
    if (!memberProfile) return;
    setLoadingCatalog(true);
    try {
      const [camps, bens, claimsRes, redsRes, notifsRes] = await Promise.all([
        fetchActiveCampaigns(),
        fetchActiveBenefits(),
        fetchPaginatedCollection<ClaimRecord>({
          collectionName: 'claims',
          constraints: [where('memberUid', '==', memberProfile.uid)],
          pageSize: 30,
        }),
        fetchPaginatedCollection<RedemptionRecord>({
          collectionName: 'redemptions',
          constraints: [where('memberUid', '==', memberProfile.uid)],
          pageSize: 15,
        }),
        fetchPaginatedCollection<MemberNotification>({
          collectionName: 'memberNotifications',
          constraints: [where('memberUid', '==', memberProfile.uid)],
          pageSize: 20,
        }),
      ]);
      setCampaigns(camps);
      setBenefits(bens);
      setMyClaims(claimsRes.items);
      setMyRedemptions(redsRes.items);
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
      let colName = 'xpProgressLedger';
      const constraints: QueryConstraint[] = [];

      if (historyKind === 'xpProgress') {
        colName = 'xpProgressLedger';
        constraints.push(where('memberUid', '==', memberProfile.uid));
        if (branchFilter !== 'ALL') constraints.push(where('branch', '==', branchFilter));
      } else if (historyKind === 'xpReward') {
        colName = 'xpRewardLedger';
        constraints.push(where('memberUid', '==', memberProfile.uid));
      } else if (historyKind === 'transactions') {
        colName = 'transactions';
        constraints.push(where('memberUid', '==', memberProfile.uid));
        if (branchFilter !== 'ALL') constraints.push(where('branch', '==', branchFilter));
      } else if (historyKind === 'referrals') {
        colName = 'referrals';
        constraints.push(where('referrerUid', '==', memberProfile.uid));
      } else {
        colName = 'levelHistory';
        constraints.push(where('memberUid', '==', memberProfile.uid));
      }

      const res = await fetchPaginatedCollection<unknown>({
        collectionName: colName,
        constraints,
        pageSize: 10,
        cursor: reset ? null : historyCursor,
      });

      if (seq !== historySeqRef.current) return;
      setHistoryItems((prev) => (reset ? res.items : [...prev, ...res.items]));
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

  const unlockedBenefits = benefits.filter(
    (b) => isLevelEligible(effectiveLevel.id, b.levelRequirement, levels)
  );

  const handleClaimSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!claimTarget) return;
    setFeedback(null);
    setSubmittingClaim(true);
    try {
      let evidenceUrl = '';
      let evidencePath = '';
      if (claimTarget.requiresEvidence) {
        if (!claimFile) {
          throw new Error('Silakan pilih atau ambil foto bukti terlebih dahulu.');
        }
        const uploaded = await uploadClaimEvidence(claimFile);
        evidenceUrl = uploaded.evidenceUrl;
        evidencePath = uploaded.evidencePath;
      }

      await submitClaimForMember({
        member: memberProfile,
        campaign: claimTarget,
        evidenceUrl,
        evidencePath,
        note: claimNote,
      });

      setFeedback({
        type: 'success',
        text: 'Claim berhasil dikirim dan sedang menunggu pemeriksaan Admin.',
      });
      setClaimTarget(null);
      setClaimFile(null);
      setClaimNote('');
      await loadMemberFeeds();
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setSubmittingClaim(false);
    }
  };

  const handleRedeem = async (benefit: BenefitItem) => {
    if (isMaintenance) {
      setFeedback({
        type: 'error',
        text: restoreLock?.message || 'XP PLAY sedang melakukan maintenance sistem. Silakan kembali beberapa saat lagi.',
      });
      return;
    }
    if (redeemingId) return;
    setRedeemingId(benefit.id);
    setFeedback(null);
    try {
      await submitRedemptionForMember({
        member: memberProfile,
        benefit,
        levels,
      });
      setFeedback({
        type: 'success',
        text: 'Redemption sedang diproses. XP Reward Anda akan dipotong setelah disetujui Admin.',
      });
      await loadMemberFeeds();
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setRedeemingId(null);
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
      });
      await refreshProfiles();
      setFeedback({ type: 'success', text: 'Profil member berhasil diperbarui.' });
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setSavingProfile(false);
    }
  };

  const filteredCampaigns = campaigns.filter(
    (c) => campaignFilter === 'ALL' || c.type === campaignFilter
  );

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
            Pengajuan claim, penukaran reward, dan perubahan profil dinonaktifkan sementara demi menjaga integritas data akun Anda.
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
      {/* Top Bar: 3-zone contract */}
      <header className="sticky top-0 z-30 bg-[#050814]/90 backdrop-blur-md border-b border-indigo-500/20">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 h-14 sm:h-16 flex items-center justify-between gap-6">
          <div className="font-display text-lg font-extrabold tracking-tight bg-gradient-to-r from-sky-300 via-blue-300 to-purple-300 bg-clip-text text-transparent whitespace-nowrap shrink-0">
            XP PLAY
          </div>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-300">
            {(
              [
                ['overview', 'Ringkasan'],
                ['programs', 'Challenge & Promo'],
                ['benefits', 'Benefit & Redeem'],
                ['history', 'Riwayat'],
                ['profile', `Notifikasi${unreadNotifs > 0 ? ` (${unreadNotifs})` : ''}`],
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

        {/* OVERVIEW TAB */}
        {activeTab === 'overview' && (
          <div className="space-y-6">
            <MemberXpShowcase
              memberId={memberProfile.memberId}
              fullName={memberProfile.fullName}
              username={memberProfile.username}
              cycleId={systemSettings.currentCycleId}
              xpProgress={memberProfile.xpProgress}
              xpReward={memberProfile.xpReward}
              levels={levels}
              currentLevel={memberProfile.currentLevel}
              levelMode={memberProfile.levelMode}
              lastPlayAt={memberProfile.lastPlayAt}
              lastPlayBranch={memberProfile.lastPlayBranch}
              referralCount={memberProfile.referralCount}
              onOpenBenefits={() => setActiveTab('benefits')}
            />

            {/* Level Benefits Preview & Notifications */}
            <div className="grid lg:grid-cols-2 gap-6">
              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-display text-lg font-bold text-white">
                    Benefit Level {effectiveLevel.name}
                  </h2>
                  <button
                    type="button"
                    onClick={() => setActiveTab('benefits')}
                    className="text-xs font-semibold text-sky-300 hover:underline min-h-[36px]"
                  >
                    Lihat Semua
                  </button>
                </div>
                {loadingCatalog ? (
                  <div className="h-24 rounded-xl bg-[#070B19] animate-pulse" />
                ) : unlockedBenefits.length === 0 ? (
                  <p className="text-sm text-slate-400">Belum ada benefit aktif yang dikonfigurasi admin.</p>
                ) : (
                  <ul className="divide-y divide-indigo-500/15">
                    {unlockedBenefits.slice(0, 4).map((b) => (
                      <li key={b.id} className="py-3 flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-white truncate">{b.name}</p>
                          <p className="text-xs text-slate-400">
                            Level {b.levelRequirement} · {b.xpCost > 0 ? `${b.xpCost} XP` : 'Benefit Level'}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setActiveTab('benefits')}
                          className="min-h-[38px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 py-1.5 text-xs font-semibold text-sky-300 hover:border-sky-400 shrink-0 transition-colors"
                        >
                          Detail
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

        {/* PROGRAMS TAB (CHALLENGE / EVENT / PROMO & CLAIM XP) */}
        {activeTab === 'programs' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h1 className="font-display text-2xl font-bold text-white">Challenge, Event &amp; Promo</h1>
                <p className="text-sm text-slate-300">
                  Ajukan Claim XP disertai bukti foto. XP masuk setelah diverifikasi Admin.
                </p>
              </div>
              <div className="flex items-center gap-1 p-1 rounded-xl bg-[#0B1124] border border-indigo-500/25 self-start overflow-x-auto no-scrollbar max-w-full">
                {(['ALL', 'CHALLENGE', 'EVENT', 'PROMO'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setCampaignFilter(t)}
                    className={`px-3.5 py-2 min-h-[38px] rounded-lg text-xs font-semibold transition-all whitespace-nowrap shrink-0 ${
                      campaignFilter === t
                        ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    {t === 'ALL' ? 'Semua' : t}
                  </button>
                ))}
              </div>
            </div>

            {filteredCampaigns.length === 0 ? (
              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-8 text-center text-sm text-slate-400">
                Belum ada program Challenge, Event, atau Promo aktif saat ini.
              </div>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
                {filteredCampaigns.map((camp) => {
                  const status = resolveCampaignStatus(camp);
                  const claimable = isCampaignClaimable(camp);
                  const myCount = myClaims.filter(
                    (cl) => cl.campaignId === camp.id && (cl.status === 'ON_PROCESS' || cl.status === 'APPROVED')
                  ).length;
                  const limitReached = myCount >= camp.maxClaimsPerMember;

                  return (
                    <div
                      key={camp.id}
                      className="bg-[#0B1124] rounded-2xl border border-indigo-500/25 p-5 flex flex-col justify-between gap-4"
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-sky-300 font-mono">
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
                          setClaimTarget(camp);
                          setClaimFile(null);
                          setClaimNote('');
                        }}
                        className="w-full h-[46px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 disabled:bg-none disabled:bg-slate-800 disabled:text-slate-500 transition-all"
                      >
                        {!claimable
                          ? 'Program Berakhir / Tidak Aktif'
                          : limitReached
                            ? 'Sudah Diklaim'
                            : `CLAIM XP (+${camp.xpReward} XP)`}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* My Claims History */}
            <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 sm:p-6 space-y-4">
              <h2 className="font-display text-lg font-bold text-white">Status Pengajuan Claim Saya</h2>
              {myClaims.length === 0 ? (
                <p className="text-sm text-slate-400">Belum ada pengajuan claim XP.</p>
              ) : (
                <div className="divide-y divide-indigo-500/15">
                  {myClaims.map((cl) => (
                    <div key={cl.id} className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="flex items-start gap-3">
                        {cl.evidenceUrl && (
                          <ProtectedImage
                            src={cl.evidenceUrl}
                            alt={`Bukti ${cl.campaignTitle}`}
                            className="w-16 h-16 rounded-xl object-cover border border-indigo-500/25 shrink-0"
                          />
                        )}
                        <div className="space-y-1">
                          <p className="text-sm font-semibold text-white">{cl.campaignTitle}</p>
                          <p className="text-xs text-slate-400">
                            {cl.campaignType} · +{cl.xpRewardSnapshot} XP · {formatJakartaDateTime(cl.createdAt)} WIB
                          </p>
                          {cl.denialReason && (
                            <p className="text-xs text-rose-400">Alasan ditolak: {cl.denialReason}</p>
                          )}
                        </div>
                      </div>
                      <span
                        className={`text-xs font-mono font-bold shrink-0 ${
                          cl.status === 'APPROVED'
                            ? 'text-emerald-400'
                            : cl.status === 'DENIED'
                              ? 'text-rose-400'
                              : 'text-amber-300'
                        }`}
                      >
                        {cl.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* BENEFITS & REDEMPTION TAB */}
        {activeTab === 'benefits' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h1 className="font-display text-2xl font-bold text-white">Benefit &amp; Redeem XP</h1>
                <p className="text-sm text-slate-300">
                  Saldo XP Reward tersedia:{' '}
                  <strong className="font-mono text-purple-300 tabular-nums">{memberProfile.xpReward} XP</strong>{' '}
                  · Level Anda:{' '}
                  <strong className="text-sky-300">
                    {effectiveLevel.name}
                    {memberProfile.levelMode === 'MANUAL_OVERRIDE' ? ' (Manual Override)' : ''}
                  </strong>
                </p>
              </div>
            </div>

            {benefits.length === 0 ? (
              <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-8 text-center text-sm text-slate-400">
                Belum ada daftar benefit yang tersedia.
              </div>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
                {benefits.map((b) => {
                  const eligibleLevel = isLevelEligible(effectiveLevel.id, b.levelRequirement, levels);
                  const enoughXp = memberProfile.xpReward >= b.xpCost;
                  const outOfStock = b.stock !== null && b.stock <= 0;
                  const expired = Boolean(b.expiryAt && Date.now() > b.expiryAt);
                  const canRedeem = eligibleLevel && b.claimable && b.redeemable && enoughXp && !outOfStock && !expired;

                  let buttonLabel = `REDEEM (${b.xpCost} XP)`;
                  if (!b.claimable || !b.redeemable) buttonLabel = 'LOCKED / INFORMATION ONLY';
                  else if (!eligibleLevel) buttonLabel = `Minimal Level ${b.levelRequirement}`;
                  else if (expired) buttonLabel = 'Benefit Kadaluarsa';
                  else if (outOfStock) buttonLabel = 'Stok Habis';
                  else if (!enoughXp) buttonLabel = `XP Tidak Cukup (Butuh ${b.xpCost} XP)`;
                  else if (b.xpCost === 0) buttonLabel = 'KLAIM BENEFIT LEVEL';

                  return (
                    <div
                      key={b.id}
                      className="bg-[#0B1124] rounded-2xl border border-indigo-500/25 p-5 flex flex-col justify-between gap-4"
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-400">Syarat Level: {b.levelRequirement}</span>
                          <span className="font-mono font-semibold text-purple-300">
                            {b.xpCost > 0 ? `${b.xpCost} XP` : 'Gratis Level'}
                          </span>
                        </div>
                        <h3 className="font-display text-lg font-bold text-white">{b.name}</h3>
                        <p className="text-sm text-slate-300">{b.description}</p>
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
                        disabled={!canRedeem || redeemingId !== null}
                        onClick={() => void handleRedeem(b)}
                        className="w-full h-[46px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 disabled:bg-none disabled:bg-slate-800 disabled:text-slate-500 transition-all"
                      >
                        {redeemingId === b.id ? 'Memproses Redeem...' : buttonLabel}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Redemption History */}
            <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 sm:p-6 space-y-4">
              <h2 className="font-display text-lg font-bold text-white">Riwayat Redemption</h2>
              {myRedemptions.length === 0 ? (
                <p className="text-sm text-slate-400">Belum ada pengajuan redemption.</p>
              ) : (
                <div className="divide-y divide-indigo-500/15">
                  {myRedemptions.map((rd) => (
                    <div key={rd.id} className="py-3.5 flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-semibold text-white">{rd.benefitName}</p>
                        <p className="text-xs text-slate-400">
                          {rd.xpCostSnapshot} XP · {formatJakartaDateTime(rd.createdAt)} WIB
                        </p>
                        {rd.denialReason && (
                          <p className="text-xs text-rose-400">Alasan: {rd.denialReason}</p>
                        )}
                      </div>
                      <span
                        className={`text-xs font-mono font-bold ${
                          rd.status === 'APPROVED'
                            ? 'text-emerald-400'
                            : rd.status === 'DENIED'
                              ? 'text-rose-400'
                              : 'text-amber-300'
                        }`}
                      >
                        {rd.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* HISTORY TAB */}
        {activeTab === 'history' && (
          <div className="space-y-5">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div>
                <h1 className="font-display text-2xl font-bold text-white">Riwayat &amp; Ledger Member</h1>
                <p className="text-sm text-slate-300">
                  Seluruh mutasi XP Progress, XP Reward, Transaksi, dan Referral tercatat permanen.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {(
                  [
                    ['xpProgress', 'XP Progress'],
                    ['xpReward', 'XP Reward'],
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
                      return (
                        <div key={entry.id || idx} className="p-4 flex items-center justify-between gap-4">
                          <div className="space-y-0.5 min-w-0">
                            <p className="text-sm font-semibold text-white">{entry.note}</p>
                            <p className="text-xs text-slate-400">
                              {entry.source} · {entry.branch ? getBranchLabel(entry.branch) : 'Sistem'} · Cycle {entry.cycleId} · {formatJakartaDateTime(entry.createdAt)} WIB
                            </p>
                          </div>
                          <span
                            className={`font-mono text-sm font-bold tabular-nums shrink-0 ${
                              entry.amount >= 0 ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
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
                            <p className="text-sm font-semibold text-white">
                              Mengajak @{ref.refereeUsername}
                            </p>
                            <p className="text-xs text-slate-400">{formatJakartaDateTime(ref.createdAt)} WIB</p>
                          </div>
                          <span className="font-mono text-sm font-bold text-purple-300 tabular-nums">
                            +{ref.referrerXp} XP
                          </span>
                        </div>
                      );
                    }
                    const lh = item as LevelHistoryRecord;
                    const transitionPrefix =
                      lh.source === 'ADMIN_MANUAL_OVERRIDE'
                        ? 'Override Level'
                        : lh.source === 'ADMIN_RECALCULATE'
                          ? 'Rekalkulasi Level'
                          : 'Perubahan Level';
                    return (
                      <div key={lh.id || idx} className="p-4 flex items-center justify-between gap-4">
                        <div>
                          <p className="text-sm font-semibold text-white">
                            {transitionPrefix}: {lh.fromLevel} → {lh.toLevel}
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

        {/* PROFILE & NOTIFICATIONS TAB */}
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
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Username (Tetap)</label>
                    <input
                      type="text"
                      disabled
                      value={`@${memberProfile.username}`}
                      className="w-full h-[44px] rounded-xl border border-indigo-500/20 bg-[#070B19]/60 px-3 text-sm font-mono text-slate-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Nomor WhatsApp</label>
                    <input
                      type="text"
                      disabled
                      value={memberProfile.whatsapp}
                      className="w-full h-[44px] rounded-xl border border-indigo-500/20 bg-[#070B19]/60 px-3 text-sm font-mono text-slate-400"
                    />
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

      {/* Claim XP Bottom-Sheet / Modal */}
      {claimTarget && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="w-full sm:max-w-md bg-[#0B1124] rounded-t-3xl sm:rounded-2xl border border-indigo-500/35 p-5 sm:p-6 space-y-4">
            <div className="sm:hidden w-10 h-1.5 rounded-full bg-slate-700 mx-auto mb-1" />
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-sky-300 font-mono">
                  {claimTarget.type} · +{claimTarget.xpReward} XP
                </p>
                <h2 className="font-display text-lg font-bold text-white">{claimTarget.title}</h2>
              </div>
              <button
                type="button"
                disabled={submittingClaim}
                onClick={() => setClaimTarget(null)}
                className="min-h-[36px] px-2 text-xs font-semibold text-slate-400 hover:text-white disabled:opacity-40"
              >
                Tutup
              </button>
            </div>

            <form onSubmit={handleClaimSubmit} className="space-y-4">
              {claimTarget.requiresEvidence && (
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Upload Bukti Foto (JPG/PNG/WEBP, maks. 5 MB) *
                  </label>
                  <label className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-indigo-500/35 bg-[#070B19] p-4 cursor-pointer hover:border-sky-400/60 transition-colors">
                    <Upload className="w-5 h-5 text-sky-300 mb-1.5" />
                    <span className="text-xs font-medium text-slate-200 text-center">
                      {claimFile ? claimFile.name : 'Pilih foto dari galeri / kamera'}
                    </span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={(e) => setClaimFile(e.target.files?.[0] || null)}
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
                  value={claimNote}
                  onChange={(e) => setClaimNote(e.target.value)}
                  placeholder="Contoh: Sudah follow & tag story IG @xpplay"
                  className="w-full rounded-xl border border-indigo-500/30 bg-[#070B19] p-3 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
                />
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={submittingClaim}
                  onClick={() => setClaimTarget(null)}
                  className="flex-1 h-[46px] rounded-xl border border-indigo-500/30 text-sm font-semibold text-slate-300 hover:text-white disabled:opacity-40"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={submittingClaim}
                  className="flex-1 h-[46px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 disabled:opacity-50"
                >
                  {submittingClaim ? 'Mengirim...' : 'Kirim Claim'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Mobile Bottom Tab Bar (<= 15% viewport height, 44px+ hitboxes) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#070B1A]/95 backdrop-blur-md border-t border-indigo-500/25 grid grid-cols-5 h-16">
        {(
          [
            ['overview', 'Home', Home],
            ['programs', 'Program', Sparkles],
            ['benefits', 'Benefit', Gift],
            ['history', 'Riwayat', History],
            ['profile', 'Profil', unreadNotifs > 0 ? Bell : UserIcon],
          ] as [MemberTab, string, typeof Award][]
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
              <span className="text-[10px] mt-1 leading-none">{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
