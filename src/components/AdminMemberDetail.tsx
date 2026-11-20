import { useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  Bell,
  CreditCard,
  Crown,
  Gift,
  History,
  KeyRound,
  RefreshCw,
  SlidersHorizontal,
  Trophy,
  User,
  Users,
  X,
} from 'lucide-react';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import {
  fetchMemberDetailBundle,
  regenerateOnboardingCodeClient,
  updateMemberDetailsByAdmin,
  updateMemberStatusByAdmin,
  type MemberDetailBundle,
} from '../services/xpService.ts';
import {
  classifyXpLedgerMovement,
  formatBirthDateJakarta,
  getJakartaTodayDateString,
  getMemberCategoryLabel,
  getXpLedgerMovementLabel,
  MEMBER_CATEGORIES,
} from '../shared/benefitRequestLogic.ts';
import { formatIdr, formatJakartaDateTime } from '../shared/xpLogic.ts';
import type {
  AdminUser,
  BranchId,
  MemberCategory,
  MemberProfile,
  MemberStatus,
} from '../types/xpplay.ts';

type DetailTab =
  | 'PROFILE'
  | 'TRANSACTIONS'
  | 'XP_HISTORY'
  | 'BENEFIT_REQUESTS'
  | 'REFERRAL'
  | 'LEVEL_HISTORY'
  | 'NOTIFICATIONS'
  | 'ACTIVITY';

const TABS: { id: DetailTab; label: string; icon: typeof User }[] = [
  { id: 'PROFILE', label: 'Profile', icon: User },
  { id: 'TRANSACTIONS', label: 'Transactions', icon: CreditCard },
  { id: 'XP_HISTORY', label: 'XP History', icon: History },
  { id: 'BENEFIT_REQUESTS', label: 'Benefit Requests', icon: Gift },
  { id: 'REFERRAL', label: 'Referral', icon: Users },
  { id: 'LEVEL_HISTORY', label: 'Level History', icon: Trophy },
  { id: 'NOTIFICATIONS', label: 'Notifications', icon: Bell },
  { id: 'ACTIVITY', label: 'Activity', icon: Activity },
];

interface AdminMemberDetailProps {
  memberUid: string;
  adminProfile: AdminUser;
  canManageMembers: boolean;
  canManageCatalog: boolean;
  restoreLocked: boolean;
  onClose: () => void;
  onMemberMutated: () => void;
  onJumpToXpAdjustment: (member: MemberProfile) => void;
  onJumpToLevelOverride: (member: MemberProfile) => void;
  onJumpToPassword: (member: MemberProfile) => void;
}

export function AdminMemberDetail({
  memberUid,
  adminProfile,
  canManageMembers,
  canManageCatalog,
  restoreLocked,
  onClose,
  onMemberMutated,
  onJumpToXpAdjustment,
  onJumpToLevelOverride,
  onJumpToPassword,
}: AdminMemberDetailProps) {
  const [tab, setTab] = useState<DetailTab>('PROFILE');
  const [bundle, setBundle] = useState<MemberDetailBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Inline Edit Profile state
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    fullName: '',
    socialMedia: '',
    preferredBranch: '' as '' | BranchId,
    birthDate: '',
    memberCategory: '' as '' | MemberCategory,
  });
  const [issuedCodeInfo, setIssuedCodeInfo] = useState<{
    verificationCode: string;
    expiresAt: number;
    whatsappShareMessage: string;
  } | null>(null);

  const todayJakarta = getJakartaTodayDateString();

  const loadBundle = async () => {
    setLoading(true);
    setNotice(null);
    try {
      const data = await fetchMemberDetailBundle(memberUid);
      setBundle(data);
      setEditForm({
        fullName: data.member.fullName,
        socialMedia: data.member.socialMedia || '',
        preferredBranch: data.member.preferredBranch || '',
        birthDate: data.member.birthDate || '',
        memberCategory: data.member.memberCategory || '',
      });
    } catch (err) {
      setNotice({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadBundle();
  }, [memberUid]);

  const handleSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    if (!bundle || restoreLocked) return;
    setBusy(true);
    setNotice(null);
    try {
      await updateMemberDetailsByAdmin(
        bundle.member.uid,
        {
          fullName: editForm.fullName,
          socialMedia: editForm.socialMedia,
          preferredBranch: editForm.preferredBranch || null,
          birthDate: editForm.birthDate || null,
          memberCategory: editForm.memberCategory || null,
        },
        adminProfile
      );
      setEditing(false);
      setNotice({ type: 'success', text: 'Profil member berhasil diperbarui.' });
      await loadBundle();
      onMemberMutated();
    } catch (err) {
      setNotice({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleStatusChange = async (status: MemberStatus) => {
    if (!bundle || restoreLocked) return;
    setBusy(true);
    setNotice(null);
    try {
      await updateMemberStatusByAdmin(bundle.member.uid, status, adminProfile);
      setNotice({ type: 'success', text: `Status akun member diubah menjadi ${status}.` });
      await loadBundle();
      onMemberMutated();
    } catch (err) {
      setNotice({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const m = bundle?.member ?? null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex justify-end">
      <div className="w-full max-w-5xl bg-[#070B19] border-l border-indigo-500/30 h-full flex flex-col overflow-hidden">
        {/* Top Header */}
        <div className="px-5 py-4 bg-[#0B1124] border-b border-indigo-500/20 flex items-center justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <p className="text-[11px] font-mono text-slate-400">
              DETAIL MEMBER 8-TAB {m ? `· ${m.memberId}` : ''}
            </p>
            <h2 className="font-display text-lg font-bold text-white truncate">
              {m ? `${m.fullName} (${m.username ? `@${m.username}` : 'PRE_REGISTERED'})` : 'Memuat profil member...'}
            </h2>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void loadBundle()}
              className="min-h-[40px] min-w-[40px] rounded-xl border border-indigo-500/30 bg-[#070B19] text-slate-200 flex items-center justify-center hover:border-sky-400/50"
              aria-label="Muat ulang detail member"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="min-h-[40px] min-w-[40px] rounded-xl border border-indigo-500/30 bg-[#070B19] text-slate-200 flex items-center justify-center hover:border-rose-400/50"
              aria-label="Tutup detail member"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* 8-Tab Bar */}
        <div className="px-4 py-2.5 bg-[#090F22] border-b border-indigo-500/20 flex items-center gap-1.5 overflow-x-auto no-scrollbar shrink-0">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                  active
                    ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white'
                    : 'text-slate-300 hover:bg-[#0F1733] hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {notice && (
            <div
              role="alert"
              className={`rounded-xl border p-3 text-xs flex items-center justify-between gap-2 ${
                notice.type === 'success'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                  : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
              }`}
            >
              <span>{notice.text}</span>
              <button type="button" onClick={() => setNotice(null)} className="underline">
                Tutup
              </button>
            </div>
          )}

          {loading && !bundle ? (
            <div className="h-56 rounded-2xl bg-[#0B1124] border border-indigo-500/20 animate-pulse" />
          ) : !bundle || !m ? (
            <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/20 p-8 text-center text-sm text-slate-400">
              Data member tidak ditemukan.
            </div>
          ) : (
            <>
              {/* TAB 1: PROFILE */}
              {tab === 'PROFILE' && (
                <div className="space-y-5">
                  {/* KPI Strip */}
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="rounded-xl bg-[#0B1124] border border-indigo-500/20 p-4">
                      <p className="text-[11px] text-slate-400">Current Level</p>
                      <p className="mt-1 font-display text-xl font-bold text-white">
                        {m.currentLevel}
                      </p>
                      <p className="text-[11px] font-mono text-amber-300 mt-0.5">
                        {m.levelMode === 'MANUAL_OVERRIDE' ? 'MANUAL OVERRIDE' : 'AUTOMATIC'}
                      </p>
                    </div>
                    <div className="rounded-xl bg-[#0B1124] border border-indigo-500/20 p-4">
                      <p className="text-[11px] text-slate-400">XP Progress</p>
                      <p className="mt-1 font-mono text-2xl font-bold text-sky-300 tabular-nums">
                        {m.xpProgress}
                      </p>
                    </div>
                    <div className="rounded-xl bg-[#0B1124] border border-indigo-500/20 p-4">
                      <p className="text-[11px] text-slate-400">XP Reward Tersedia</p>
                      <p className="mt-1 font-mono text-2xl font-bold text-purple-300 tabular-nums">
                        {m.xpReward}
                      </p>
                    </div>
                    <div className="rounded-xl bg-[#0B1124] border border-indigo-500/20 p-4">
                      <p className="text-[11px] text-slate-400">Reserved XP (Hold)</p>
                      <p className="mt-1 font-mono text-2xl font-bold text-amber-300 tabular-nums">
                        {m.reservedXp ?? 0}
                      </p>
                    </div>
                  </div>

                  {/* Two-Step Registration Metadata Card */}
                  <div className="rounded-xl bg-[#0B1124] border border-indigo-500/25 p-4 space-y-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-mono text-[11px] text-sky-300 uppercase">Status Registrasi Two-Step</p>
                        <p className="mt-0.5 font-semibold text-white">
                          {m.status === 'PRE_REGISTERED'
                            ? 'PRE_REGISTERED · Belum menyelesaikan profil online'
                            : `${m.status} · ${m.registrationStage || 'COMPLETED'}`}
                        </p>
                      </div>
                      {m.status === 'PRE_REGISTERED' && canManageMembers && (
                        <button
                          type="button"
                          disabled={busy || restoreLocked}
                          onClick={async () => {
                            setBusy(true);
                            setNotice(null);
                            try {
                              const res = await regenerateOnboardingCodeClient({
                                member: m,
                                actor: adminProfile,
                              });
                              setIssuedCodeInfo({
                                verificationCode: res.verificationCode,
                                expiresAt: res.expiresAt,
                                whatsappShareMessage: res.whatsappShareMessage,
                              });
                              setNotice({
                                type: 'success',
                                text: `Kode verifikasi 6 digit baru diterbitkan: ${res.verificationCode}`,
                              });
                            } catch (err) {
                              setNotice({ type: 'error', text: mapFriendlyError(err) });
                            } finally {
                              setBusy(false);
                            }
                          }}
                          className="min-h-[38px] px-3.5 rounded-lg bg-amber-400 text-slate-950 font-bold text-xs hover:bg-amber-300 disabled:opacity-50"
                        >
                          Buat Ulang Kode Verifikasi (6 Digit)
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono text-slate-300">
                      <div>
                        <span className="text-slate-500 block">Cabang Daftar</span>
                        <span>{m.branchId || m.preferredBranch || '-'}</span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">Pre-Registered</span>
                        <span>{m.preRegisteredAt ? formatJakartaDateTime(m.preRegisteredAt) : '-'}</span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">Selesai Online</span>
                        <span>{m.registrationCompletedAt ? formatJakartaDateTime(m.registrationCompletedAt) : '-'}</span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">Bonus 10 XP</span>
                        <span className={m.registrationBonusGranted ? 'text-emerald-400' : 'text-amber-300'}>
                          {m.registrationBonusGranted ? 'SUDAH DIBERIKAN' : 'MENUNGGU STAGE 2'}
                        </span>
                      </div>
                    </div>
                    {issuedCodeInfo && (
                      <div className="rounded-lg border border-sky-400/40 bg-[#070B19] p-3 flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <span className="text-slate-400">Kode Baru: </span>
                          <strong className="font-mono text-lg text-sky-300 tracking-widest">
                            {issuedCodeInfo.verificationCode}
                          </strong>
                          <span className="ml-2 text-slate-400">
                            (s/d {formatJakartaDateTime(issuedCodeInfo.expiresAt)})
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => void navigator.clipboard.writeText(issuedCodeInfo.whatsappShareMessage)}
                          className="px-3 py-1.5 rounded-lg bg-sky-500 text-slate-950 font-bold text-xs"
                        >
                          Salin Pesan WhatsApp
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Quick Actions */}
                  {canManageMembers && (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={restoreLocked}
                        onClick={() => setEditing((v) => !v)}
                        className="min-h-[40px] px-3.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white disabled:opacity-50"
                      >
                        {editing ? 'Tutup Form Edit' : 'Edit Profil Member'}
                      </button>
                      {canManageCatalog && (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              onClose();
                              onJumpToXpAdjustment(m);
                            }}
                            className="min-h-[40px] px-3.5 py-2 rounded-xl border border-indigo-500/35 bg-[#0B1124] text-xs font-semibold text-indigo-300 hover:border-indigo-400 inline-flex items-center gap-1.5"
                          >
                            <SlidersHorizontal className="w-3.5 h-3.5" />
                            <span>Adjust XP</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              onClose();
                              onJumpToLevelOverride(m);
                            }}
                            className="min-h-[40px] px-3.5 py-2 rounded-xl border border-amber-500/35 bg-[#0B1124] text-xs font-semibold text-amber-300 hover:border-amber-400 inline-flex items-center gap-1.5"
                          >
                            <Crown className="w-3.5 h-3.5" />
                            <span>Manual Level</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              onClose();
                              onJumpToPassword(m);
                            }}
                            className="min-h-[40px] px-3.5 py-2 rounded-xl border border-purple-500/35 bg-[#0B1124] text-xs font-semibold text-purple-300 hover:border-purple-400 inline-flex items-center gap-1.5"
                          >
                            <KeyRound className="w-3.5 h-3.5" />
                            <span>Ubah Password</span>
                          </button>
                        </>
                      )}
                      {m.status !== 'ACTIVE' ? (
                        <button
                          type="button"
                          disabled={busy || restoreLocked}
                          onClick={() => void handleStatusChange('ACTIVE')}
                          className="min-h-[40px] px-3.5 py-2 rounded-xl bg-emerald-600 text-xs font-semibold text-white disabled:opacity-50"
                        >
                          Aktifkan Akun
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy || restoreLocked}
                          onClick={() => void handleStatusChange('SUSPENDED')}
                          className="min-h-[40px] px-3.5 py-2 rounded-xl bg-amber-600 text-xs font-semibold text-white disabled:opacity-50"
                        >
                          Suspend Akun
                        </button>
                      )}
                    </div>
                  )}

                  {/* Inline Edit Form */}
                  {editing && canManageMembers && (
                    <form
                      onSubmit={handleSaveProfile}
                      className="rounded-2xl bg-[#0B1124] border border-sky-500/40 p-5 space-y-4"
                    >
                      <h3 className="font-display text-sm font-bold text-white">Edit Profil Member</h3>
                      <div className="grid sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Nama Lengkap *</label>
                          <input
                            type="text"
                            required
                            value={editForm.fullName}
                            onChange={(e) => setEditForm({ ...editForm, fullName: e.target.value })}
                            className="w-full h-10 rounded-lg border border-indigo-500/30 bg-[#070B19] px-3 text-sm text-white"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Sosial Media</label>
                          <input
                            type="text"
                            value={editForm.socialMedia}
                            onChange={(e) => setEditForm({ ...editForm, socialMedia: e.target.value })}
                            placeholder="@instagram / TikTok"
                            className="w-full h-10 rounded-lg border border-indigo-500/30 bg-[#070B19] px-3 text-sm text-white"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Tanggal Lahir</label>
                          <input
                            type="date"
                            max={todayJakarta}
                            value={editForm.birthDate}
                            onChange={(e) => setEditForm({ ...editForm, birthDate: e.target.value })}
                            className="w-full h-10 rounded-lg border border-indigo-500/30 bg-[#070B19] px-3 text-sm font-mono text-white"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Status Member</label>
                          <select
                            value={editForm.memberCategory}
                            onChange={(e) =>
                              setEditForm({ ...editForm, memberCategory: e.target.value as '' | MemberCategory })
                            }
                            className="w-full h-10 rounded-lg border border-indigo-500/30 bg-[#070B19] px-3 text-sm text-white"
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
                          <label className="block text-xs text-slate-400 mb-1">Cabang Favorit</label>
                          <select
                            value={editForm.preferredBranch}
                            onChange={(e) =>
                              setEditForm({ ...editForm, preferredBranch: e.target.value as '' | BranchId })
                            }
                            className="w-full h-10 rounded-lg border border-indigo-500/30 bg-[#070B19] px-3 text-sm text-white"
                          >
                            <option value="">Tidak ditentukan</option>
                            <option value="DEMANG">XP PLAY DEMANG</option>
                            <option value="SEKIP">XP PLAY SEKIP</option>
                          </select>
                        </div>
                      </div>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditing(false)}
                          className="min-h-[40px] px-4 rounded-xl border border-indigo-500/30 text-xs font-semibold text-slate-300"
                        >
                          Batal
                        </button>
                        <button
                          type="submit"
                          disabled={busy}
                          className="min-h-[40px] px-5 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-xs font-bold text-white"
                        >
                          {busy ? 'Menyimpan...' : 'Simpan Perubahan'}
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Full 14+ Profile Fields Grid */}
                  <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/20 p-5">
                    <h3 className="font-display text-sm font-bold text-white mb-4">Informasi Lengkap Member</h3>
                    <dl className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
                      <div>
                        <dt className="text-slate-400">Member ID</dt>
                        <dd className="font-mono text-white font-semibold mt-0.5">{m.memberId}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">Nama Lengkap</dt>
                        <dd className="text-white font-semibold mt-0.5">{m.fullName}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">Username</dt>
                        <dd className="font-mono text-sky-300 font-semibold mt-0.5">@{m.username}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">WhatsApp</dt>
                        <dd className="font-mono text-white mt-0.5">{m.whatsapp}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">Sosial Media</dt>
                        <dd className="text-white mt-0.5">{m.socialMedia || '-'}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">Tanggal Lahir</dt>
                        <dd className="text-white mt-0.5">
                          {formatBirthDateJakarta(m.birthDate)}
                          {m.birthDate && (
                            <span className="ml-1.5 font-mono text-[11px] text-slate-400">({m.birthDate})</span>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">Status Member</dt>
                        <dd className="text-white font-semibold mt-0.5">
                          {getMemberCategoryLabel(m.memberCategory)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">Status Akun</dt>
                        <dd className="font-mono font-bold text-emerald-300 mt-0.5">{m.status}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">Cycle Aktif</dt>
                        <dd className="font-mono text-slate-200 mt-0.5">{m.currentCycleId}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">Cabang Favorit / Terakhir Main</dt>
                        <dd className="font-mono text-white mt-0.5">
                          {m.preferredBranch || '-'} / {m.lastPlayBranch || '-'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">Terakhir Main (Last Play)</dt>
                        <dd className="font-mono text-slate-200 mt-0.5">
                          {m.lastPlayAt ? formatJakartaDateTime(m.lastPlayAt) : 'Belum pernah main'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">Info Referral</dt>
                        <dd className="text-slate-200 mt-0.5">
                          Diajak oleh:{' '}
                          <strong className="font-mono text-sky-300">
                            {m.referredByUsername ? `@${m.referredByUsername}` : '-'}
                          </strong>{' '}
                          · Mengajak: <strong className="font-mono text-white">{m.referralCount}</strong>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">Waktu Daftar (Created At)</dt>
                        <dd className="font-mono text-slate-200 mt-0.5">{formatJakartaDateTime(m.createdAt)}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">Terakhir Diperbarui</dt>
                        <dd className="font-mono text-slate-200 mt-0.5">{formatJakartaDateTime(m.updatedAt)}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">UID Internal</dt>
                        <dd className="font-mono text-[11px] text-slate-400 mt-0.5 truncate">{m.uid}</dd>
                      </div>
                    </dl>
                  </div>
                </div>
              )}

              {/* TAB 2: TRANSACTIONS */}
              {tab === 'TRANSACTIONS' && (
                <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/20 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-indigo-500/20 text-left text-slate-400">
                        <th className="p-3">Tx ID</th>
                        <th className="p-3">Tanggal</th>
                        <th className="p-3">Cabang</th>
                        <th className="p-3 text-right">Nominal</th>
                        <th className="p-3 text-right">Rate</th>
                        <th className="p-3 text-right">XP</th>
                        <th className="p-3">No. Struk</th>
                        <th className="p-3">Admin</th>
                        <th className="p-3">Catatan</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-indigo-500/15">
                      {bundle.transactions.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="p-8 text-center text-slate-400">
                            Belum ada transaksi untuk member ini.
                          </td>
                        </tr>
                      ) : (
                        bundle.transactions.map((t) => (
                          <tr key={t.id}>
                            <td className="p-3 font-mono text-slate-300">{t.id}</td>
                            <td className="p-3 font-mono text-slate-300 whitespace-nowrap">
                              {formatJakartaDateTime(t.createdAt)}
                            </td>
                            <td className="p-3 font-mono">{t.branch}</td>
                            <td className="p-3 text-right font-mono tabular-nums">{formatIdr(t.amountIdr)}</td>
                            <td className="p-3 text-right font-mono tabular-nums text-slate-400">
                              Rp{t.xpRateUsed.toLocaleString('id-ID')}
                            </td>
                            <td className="p-3 text-right font-mono font-bold text-emerald-400 tabular-nums">
                              +{t.xpGenerated}
                            </td>
                            <td className="p-3 font-mono text-slate-300">{t.receiptNumber || '-'}</td>
                            <td className="p-3 text-slate-300">{t.adminName}</td>
                            <td className="p-3 text-slate-400">{t.note || '-'}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* TAB 3: XP HISTORY */}
              {tab === 'XP_HISTORY' && (
                <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/20 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-indigo-500/20 text-left text-slate-400">
                        <th className="p-3">Tanggal</th>
                        <th className="p-3">Jenis XP</th>
                        <th className="p-3">Pergerakan</th>
                        <th className="p-3 text-right">Jumlah</th>
                        <th className="p-3 text-right">Before → After</th>
                        <th className="p-3">Source / Ref</th>
                        <th className="p-3">Catatan</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-indigo-500/15">
                      {bundle.xpHistory.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="p-8 text-center text-slate-400">
                            Belum ada catatan XP ledger.
                          </td>
                        </tr>
                      ) : (
                        bundle.xpHistory.map((e) => {
                          const cat = classifyXpLedgerMovement(e);
                          return (
                            <tr key={`${e.type}_${e.id}`}>
                              <td className="p-3 font-mono text-slate-400 whitespace-nowrap">
                                {formatJakartaDateTime(e.createdAt)}
                              </td>
                              <td className="p-3 font-mono font-semibold text-white">{e.type}</td>
                              <td
                                className={`p-3 font-semibold ${
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
                                className={`p-3 text-right font-mono font-bold tabular-nums ${
                                  e.amount >= 0 ? 'text-emerald-400' : 'text-rose-400'
                                }`}
                              >
                                {e.amount >= 0 ? `+${e.amount}` : e.amount} XP
                              </td>
                              <td className="p-3 text-right font-mono text-slate-300 tabular-nums whitespace-nowrap">
                                {typeof e.beforeBalance === 'number' && typeof e.afterBalance === 'number'
                                  ? `${e.beforeBalance} → ${e.afterBalance}`
                                  : '-'}
                              </td>
                              <td className="p-3 font-mono text-slate-300">
                                {e.source} · {e.referenceId}
                              </td>
                              <td className="p-3 text-slate-300">{e.note}</td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* TAB 4: BENEFIT REQUESTS (12 Columns + Legacy) */}
              {tab === 'BENEFIT_REQUESTS' && (
                <div className="space-y-5">
                  <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/20 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-indigo-500/20 text-left text-slate-400">
                          <th className="p-3">Request ID</th>
                          <th className="p-3">Type</th>
                          <th className="p-3">Benefit Name</th>
                          <th className="p-3 text-right">XP Cost / Grant</th>
                          <th className="p-3">Status</th>
                          <th className="p-3">Created At</th>
                          <th className="p-3">Approved At</th>
                          <th className="p-3">Expires At</th>
                          <th className="p-3">Used At</th>
                          <th className="p-3">Used Branch</th>
                          <th className="p-3">Refunded At</th>
                          <th className="p-3">Reason / Notes</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-indigo-500/15">
                        {bundle.benefitRequests.length === 0 ? (
                          <tr>
                            <td colSpan={12} className="p-8 text-center text-slate-400">
                              Belum ada Benefit Request tercatat untuk member ini.
                            </td>
                          </tr>
                        ) : (
                          bundle.benefitRequests.map((br) => (
                            <tr key={br.id}>
                              <td className="p-3 font-mono font-bold text-sky-300 whitespace-nowrap">{br.id}</td>
                              <td className="p-3 font-mono text-slate-300">{br.sourceType}</td>
                              <td className="p-3 font-semibold text-white">{br.title}</td>
                              <td className="p-3 text-right font-mono tabular-nums whitespace-nowrap">
                                {br.xpCost > 0 ? `-${br.xpCost} XP` : br.xpRewardGrant > 0 ? `+${br.xpRewardGrant} XP` : '0 XP'}
                              </td>
                              <td className="p-3 font-mono font-bold text-white whitespace-nowrap">
                                {br.status}
                                {br.resolution ? ` (${br.resolution})` : ''}
                              </td>
                              <td className="p-3 font-mono text-slate-400 whitespace-nowrap">
                                {formatJakartaDateTime(br.createdAt)}
                              </td>
                              <td className="p-3 font-mono text-slate-400 whitespace-nowrap">
                                {br.approvedAt ? formatJakartaDateTime(br.approvedAt) : '-'}
                              </td>
                              <td className="p-3 font-mono text-slate-400 whitespace-nowrap">
                                {br.expiresAt ? formatJakartaDateTime(br.expiresAt) : '-'}
                              </td>
                              <td className="p-3 font-mono text-slate-400 whitespace-nowrap">
                                {br.usedAt ? formatJakartaDateTime(br.usedAt) : '-'}
                              </td>
                              <td className="p-3 font-mono text-slate-300">{br.usedBranch || '-'}</td>
                              <td className="p-3 font-mono text-purple-300 whitespace-nowrap">
                                {br.refundedAt
                                  ? `${formatJakartaDateTime(br.refundedAt)} (+${br.refundedAmount} XP)`
                                  : '-'}
                              </td>
                              <td className="p-3 text-slate-300">
                                {br.deniedReason || br.refundReason || br.note || '-'}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  {(bundle.legacyClaims.length > 0 || bundle.legacyRedemptions.length > 0) && (
                    <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/20 p-4 space-y-3">
                      <h4 className="font-display text-xs font-bold text-slate-300 uppercase tracking-wider">
                        Arsip Legacy Claims ({bundle.legacyClaims.length}) & Redemptions ({bundle.legacyRedemptions.length})
                      </h4>
                      <div className="divide-y divide-indigo-500/15 text-xs">
                        {bundle.legacyClaims.map((c) => (
                          <div key={c.id} className="py-2 flex items-center justify-between gap-2">
                            <span className="text-slate-200">
                              [CLAIM] {c.campaignTitle} (+{c.xpRewardSnapshot} XP)
                            </span>
                            <span className="font-mono text-slate-400">
                              {c.status} · {formatJakartaDateTime(c.createdAt)}
                            </span>
                          </div>
                        ))}
                        {bundle.legacyRedemptions.map((r) => (
                          <div key={r.id} className="py-2 flex items-center justify-between gap-2">
                            <span className="text-slate-200">
                              [REDEMPTION] {r.benefitName} ({r.xpCostSnapshot} XP)
                            </span>
                            <span className="font-mono text-slate-400">
                              {r.status} · {formatJakartaDateTime(r.createdAt)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 5: REFERRAL */}
              {tab === 'REFERRAL' && (
                <div className="space-y-4">
                  <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/20 p-4 text-xs text-slate-300">
                    Diajak oleh:{' '}
                    <strong className="font-mono text-sky-300">
                      {m.referredByUsername ? `@${m.referredByUsername}` : 'Tidak menggunakan referral'}
                    </strong>{' '}
                    · Total Member Diajak: <strong className="font-mono text-white">{bundle.referralsAsReferrer.length}</strong>
                  </div>
                  <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/20 divide-y divide-indigo-500/15">
                    {bundle.referralsAsReferrer.length === 0 ? (
                      <div className="p-8 text-center text-xs text-slate-400">
                        Member ini belum mengajak member lain melalui referral.
                      </div>
                    ) : (
                      bundle.referralsAsReferrer.map((ref) => (
                        <div key={ref.id} className="p-3.5 flex items-center justify-between gap-3 text-xs">
                          <div>
                            <p className="font-mono font-bold text-white">@{ref.refereeUsername}</p>
                            <p className="text-slate-400">
                              ID: {ref.refereeMemberId} · Bonus: +{ref.referrerXp} XP
                            </p>
                          </div>
                          <span className="font-mono text-slate-400">{formatJakartaDateTime(ref.createdAt)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* TAB 6: LEVEL HISTORY */}
              {tab === 'LEVEL_HISTORY' && (
                <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/20 divide-y divide-indigo-500/15">
                  {bundle.levelHistory.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-400">
                      Belum ada riwayat perubahan level.
                    </div>
                  ) : (
                    bundle.levelHistory.map((lh) => (
                      <div key={lh.id} className="p-3.5 flex items-center justify-between gap-3 text-xs">
                        <div>
                          <p className="font-semibold text-white">
                            {lh.fromLevel} → {lh.toLevel}
                          </p>
                          <p className="text-slate-400">
                            XP Progress saat kejadian: {lh.xpProgressAtEvent} XP · Sumber: {lh.source} · Cycle {lh.cycleId}
                          </p>
                        </div>
                        <span className="font-mono text-slate-400">{formatJakartaDateTime(lh.createdAt)}</span>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* TAB 7: NOTIFICATIONS */}
              {tab === 'NOTIFICATIONS' && (
                <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/20 divide-y divide-indigo-500/15">
                  {bundle.notifications.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-400">
                      Belum ada notifikasi yang diterima member ini.
                    </div>
                  ) : (
                    bundle.notifications.map((n) => (
                      <div key={n.id} className="p-3.5 space-y-1 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-semibold text-white">{n.title}</p>
                          <span className={`font-mono text-[11px] ${n.read ? 'text-slate-400' : 'text-sky-300 font-bold'}`}>
                            {n.read ? 'READ' : 'UNREAD'}
                          </span>
                        </div>
                        <p className="text-slate-300">{n.message}</p>
                        <p className="font-mono text-[11px] text-slate-500">
                          {n.category} · {formatJakartaDateTime(n.createdAt)}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* TAB 8: ACTIVITY (AUDIT LOGS) */}
              {tab === 'ACTIVITY' && (
                <div className="rounded-2xl bg-[#0B1124] border border-indigo-500/20 divide-y divide-indigo-500/15">
                  {bundle.auditLogs.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-400">
                      Belum ada catatan audit log yang menargetkan UID member ini.
                    </div>
                  ) : (
                    bundle.auditLogs.map((log) => (
                      <div key={log.id} className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                        <div>
                          <p className="font-mono font-bold text-white">{log.action}</p>
                          <p className="text-slate-400">
                            Actor: {log.actorId} ({log.actorRole})
                          </p>
                        </div>
                        <span className="font-mono text-slate-400">{formatJakartaDateTime(log.timestamp)}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
