import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  KeyRound,
  Lock,
  Phone,
  ShieldAlert,
  Sparkles,
  UserCheck,
} from 'lucide-react';
import { CaptchaWidget } from '../components/CaptchaWidget.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import {
  checkPhoneForRegistrationClient,
  completeMemberRegistrationClient,
  verifyOnboardingCodeClient,
} from '../services/xpService.ts';
import { getJakartaTodayDateString, MEMBER_CATEGORIES } from '../shared/benefitRequestLogic.ts';
import { getDashboardRouteForRole } from '../shared/rbac.ts';
import {
  REGISTRATION_PRE_REGISTERED_BANNER,
} from '../shared/registrationLogic.ts';
import { getBranchLabel } from '../shared/xpLogic.ts';
import type { BranchId, MemberCategory, MemberProfile, PhoneCheckResult } from '../types/xpplay.ts';

type RegisterStep = 'CHECK_PHONE' | 'VERIFY_CODE' | 'COMPLETE_PROFILE' | 'SUCCESS';

export function RegisterPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    memberProfile,
    adminProfile,
    isCompletedMember,
    systemSettings,
    capabilities,
    signInWithServerToken,
    refreshProfiles,
  } = useAuth();

  const initialWa = searchParams.get('wa') || '';
  const initialCode = searchParams.get('code') || '';
  const initialRef = searchParams.get('ref') || '';

  const [step, setStep] = useState<RegisterStep>('CHECK_PHONE');
  const [whatsapp, setWhatsapp] = useState(initialWa);
  const [captcha, setCaptcha] = useState({ token: '', answer: '' });
  const [captchaReset, setCaptchaReset] = useState(0);

  const [phoneResult, setPhoneResult] = useState<PhoneCheckResult | null>(null);
  const [verificationCode, setVerificationCode] = useState(initialCode.replace(/\D/g, '').slice(0, 6));

  // Verified session data from Step 2
  const [verifiedSession, setVerifiedSession] = useState<{
    onboardingSessionToken: string;
    preMemberUid: string;
    memberId: string;
    branchId: BranchId;
    verifiedAt: number;
    normalizedWhatsapp: string;
  } | null>(null);

  // Step 3 Profile fields (WhatsApp is LOCKED / read-only)
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [memberCategory, setMemberCategory] = useState<MemberCategory>('MAHASISWA');
  const [socialMedia, setSocialMedia] = useState('');
  const [preferredBranch, setPreferredBranch] = useState<BranchId>('DEMANG');
  const [referralUsername, setReferralUsername] = useState(initialRef);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Step 4 completion outcome
  const [completionOutcome, setCompletionOutcome] = useState<{
    member: MemberProfile;
    registrationBonusGranted: number;
    referralApplied: boolean;
    referralMessage?: string;
  } | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const todayJakarta = getJakartaTodayDateString();

  useEffect(() => {
    if (step === 'SUCCESS') return;
    if (isCompletedMember && memberProfile) {
      navigate('/member', { replace: true });
    } else if (adminProfile) {
      navigate(getDashboardRouteForRole(adminProfile.role), { replace: true });
    }
  }, [isCompletedMember, memberProfile, adminProfile, navigate, step]);

  const handleCheckPhone = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setPhoneResult(null);

    if (!whatsapp.trim()) {
      setError('Masukkan nomor WhatsApp yang didaftarkan oleh Kasir XP PLAY.');
      return;
    }

    setLoading(true);
    try {
      const res = await checkPhoneForRegistrationClient({
        whatsapp: whatsapp.trim(),
        captchaToken: captcha.token,
        captchaAnswer: captcha.answer,
      });
      setPhoneResult(res);
      setWhatsapp(res.normalizedWhatsapp);
      if (res.branchId) {
        setPreferredBranch(res.branchId);
      }
      setCaptchaReset((v) => v + 1);
    } catch (err) {
      setCaptchaReset((v) => v + 1);
      setError(mapFriendlyError(err, 'Gagal memeriksa status nomor WhatsApp.'));
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    const cleanCode = verificationCode.replace(/\D/g, '');
    if (cleanCode.length !== 6) {
      setError('Masukkan 6 digit kode verifikasi yang diberikan oleh Kasir XP PLAY.');
      return;
    }

    setLoading(true);
    try {
      const normalizedWa = phoneResult?.normalizedWhatsapp || whatsapp.trim();
      const verified = await verifyOnboardingCodeClient({
        whatsapp: normalizedWa,
        code: cleanCode,
      });
      setVerifiedSession({
        ...verified,
        normalizedWhatsapp: normalizedWa,
      });
      setPreferredBranch(verified.branchId);
      setStep('COMPLETE_PROFILE');
    } catch (err) {
      setError(mapFriendlyError(err, 'Kode verifikasi tidak valid atau sudah kadaluarsa.'));
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteProfile = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (!verifiedSession) {
      setError('Sesi verifikasi tidak ditemukan. Silakan verifikasi ulang nomor WhatsApp Anda.');
      setStep('CHECK_PHONE');
      return;
    }
    if (!fullName.trim() || fullName.trim().length < 2) {
      setError('Nama lengkap wajib diisi minimal 2 karakter.');
      return;
    }
    if (!username.trim()) {
      setError('Username wajib diisi.');
      return;
    }
    if (!birthDate) {
      setError('Tanggal lahir wajib diisi.');
      return;
    }
    if (password.length < 8) {
      setError('Password minimal 8 karakter.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Konfirmasi password tidak cocok.');
      return;
    }

    setLoading(true);
    try {
      const outcome = await completeMemberRegistrationClient({
        onboardingSessionToken: verifiedSession.onboardingSessionToken,
        preMemberUid: verifiedSession.preMemberUid,
        memberId: verifiedSession.memberId,
        whatsapp: verifiedSession.normalizedWhatsapp,
        fullName: fullName.trim(),
        username: username.trim(),
        birthDate,
        memberCategory,
        socialMedia: socialMedia.trim(),
        preferredBranch,
        referralUsername: referralUsername.trim(),
        password,
        verifiedAt: verifiedSession.verifiedAt,
        adminSdkConfigured: capabilities.adminSdkConfigured,
      });

      if (outcome.customToken) {
        await signInWithServerToken(outcome.customToken);
      }
      await refreshProfiles();
      setCompletionOutcome({
        member: outcome.member,
        registrationBonusGranted: outcome.registrationBonusGranted,
        referralApplied: outcome.referralApplied,
        referralMessage: outcome.referralMessage,
      });
      setStep('SUCCESS');
    } catch (err) {
      setError(mapFriendlyError(err, 'Gagal menyelesaikan pendaftaran member.'));
    } finally {
      setLoading(false);
    }
  };

  const stepIndex =
    step === 'CHECK_PHONE' ? 1 : step === 'VERIFY_CODE' ? 2 : step === 'COMPLETE_PROFILE' ? 3 : 4;

  return (
    <div className="min-h-screen gaming-canvas text-slate-100 flex flex-col justify-center px-4 py-8 sm:py-12">
      <div className="w-full max-w-lg mx-auto">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 min-h-[40px] text-xs font-medium text-sky-300 hover:text-white mb-4 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Kembali ke Beranda</span>
        </Link>

        <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/30 p-5 sm:p-8 space-y-6 shadow-[0_0_40px_-14px_rgba(99,102,241,0.4)]">
          {/* Header & Stepper */}
          <div className="space-y-4">
            <div>
              <p className="text-xs font-medium text-sky-300">
                XP PLAY Two-Step Membership Onboarding
              </p>
              <h1 className="mt-1 font-display text-2xl font-extrabold tracking-tight text-white">
                {step === 'CHECK_PHONE' && 'Cek Nomor WhatsApp Member'}
                {step === 'VERIFY_CODE' && 'Verifikasi Kode Kasir (6 Digit)'}
                {step === 'COMPLETE_PROFILE' && 'Lengkapi Profil Membership'}
                {step === 'SUCCESS' && 'Membership Aktif!'}
              </h1>
              <p className="mt-1 text-sm text-slate-300">
                {step === 'CHECK_PHONE' &&
                  'Pendaftaran member dimulai oleh Kasir XP PLAY di cabang. Masukkan nomor WhatsApp Anda untuk melanjutkan pendaftaran online.'}
                {step === 'VERIFY_CODE' &&
                  'Masukkan kode verifikasi 6 digit sekali pakai dari Kasir XP PLAY untuk membuka formulir profil Anda.'}
                {step === 'COMPLETE_PROFILE' &&
                  `Lengkapi data diri Anda untuk mengaktifkan Member Dashboard dan menerima bonus +${systemSettings.registrationBonusXp} XP.`}
                {step === 'SUCCESS' &&
                  'Akun XP PLAY Anda telah aktif sepenuhnya. Semua riwayat transaksi dari Kasir tetap tersimpan.'}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[
                { num: 1, label: 'Cek WhatsApp' },
                { num: 2, label: 'Kode 6 Digit' },
                { num: 3, label: 'Profil & Aktif' },
              ].map((s) => {
                const done = stepIndex > s.num;
                const active = stepIndex === s.num || (s.num === 3 && stepIndex === 4);
                return (
                  <div
                    key={s.num}
                    className={`rounded-xl border px-3 py-2 text-xs font-medium flex items-center gap-2 ${
                      done
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                        : active
                          ? 'border-sky-400/50 bg-sky-500/10 text-sky-200'
                          : 'border-indigo-500/20 bg-[#070B19] text-slate-500'
                    }`}
                  >
                    <span className="font-mono font-bold">{done ? '✓' : `0${s.num}`}</span>
                    <span className="truncate">{s.label}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3.5 text-sm text-rose-200 flex items-start gap-2.5"
            >
              <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* STEP 1: CHECK WHATSAPP */}
          {step === 'CHECK_PHONE' && (
            <div className="space-y-5">
              <form onSubmit={handleCheckPhone} className="space-y-4">
                <div>
                  <label
                    htmlFor="reg-check-wa"
                    className="block text-xs font-medium text-slate-300 mb-1.5"
                  >
                    Nomor WhatsApp Terdaftar
                  </label>
                  <div className="relative">
                    <Phone className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="reg-check-wa"
                      type="tel"
                      required
                      value={whatsapp}
                      onChange={(e) => {
                        setWhatsapp(e.target.value);
                        if (phoneResult) setPhoneResult(null);
                      }}
                      placeholder="Contoh: 081234567890"
                      autoComplete="tel"
                      className="w-full h-[46px] rounded-xl border border-indigo-500/30 bg-[#070B19] pl-10 pr-3.5 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
                    />
                  </div>
                </div>

                <CaptchaWidget onChange={setCaptcha} resetSignal={captchaReset} />

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-[48px] inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-4 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 shadow-[0_0_24px_-6px_rgba(99,102,241,0.65)] disabled:opacity-50 transition-all"
                >
                  <span>{loading ? 'Memeriksa Nomor...' : 'Cek Status Nomor WhatsApp'}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </form>

              {/* Step 1 Outcome Panels */}
              {phoneResult && phoneResult.state === 'PRE_REGISTERED' && (
                <div className="rounded-xl border border-sky-400/45 bg-sky-500/10 p-4 space-y-3">
                  <div className="flex items-start gap-2.5">
                    <Sparkles className="w-5 h-5 text-sky-300 shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="text-xs font-mono font-semibold uppercase tracking-wider text-sky-300">
                        Status: PRE_REGISTERED
                        {phoneResult.branchId ? ` · Cabang ${getBranchLabel(phoneResult.branchId)}` : ''}
                      </p>
                      <p className="text-sm text-white leading-relaxed">
                        {REGISTRATION_PRE_REGISTERED_BANNER}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setError('');
                      setStep('VERIFY_CODE');
                    }}
                    className="w-full h-[46px] inline-flex items-center justify-center gap-2 rounded-xl bg-sky-400 text-[#050814] font-bold text-sm hover:bg-sky-300 transition-colors"
                  >
                    <span>LENGKAPI PENDAFTARAN</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              )}

              {phoneResult && phoneResult.state === 'NOT_FOUND' && (
                <div
                  role="alert"
                  className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-4 space-y-2 text-sm text-amber-100"
                >
                  <p className="font-semibold text-amber-300">Belum Terdaftar di Kasir XP PLAY</p>
                  <p className="leading-relaxed">{phoneResult.message}</p>
                </div>
              )}

              {phoneResult && phoneResult.state === 'ACTIVE' && (
                <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 p-4 space-y-3 text-sm text-emerald-100">
                  <p className="font-semibold text-emerald-300">Membership Sudah Aktif</p>
                  <p>{phoneResult.message}</p>
                  <Link
                    to="/login"
                    className="w-full h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 text-[#050814] font-bold text-sm hover:bg-emerald-400 transition-colors"
                  >
                    <span>Masuk ke Member Dashboard</span>
                    <ArrowRight className="w-4 h-4" />
                  </Link>
                </div>
              )}

              {phoneResult &&
                (phoneResult.state === 'SUSPENDED' || phoneResult.state === 'INACTIVE') && (
                  <div
                    role="alert"
                    className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200"
                  >
                    {phoneResult.message}
                  </div>
                )}
            </div>
          )}

          {/* STEP 2: 6-DIGIT ONE-TIME VERIFICATION CODE */}
          {step === 'VERIFY_CODE' && (
            <form onSubmit={handleVerifyCode} className="space-y-4">
              <div className="rounded-xl bg-[#070B19] border border-indigo-500/25 p-3.5 flex items-center justify-between gap-2 text-xs">
                <span className="text-slate-400">Nomor WhatsApp</span>
                <span className="font-mono font-semibold text-sky-300">
                  {phoneResult?.normalizedWhatsapp || whatsapp}
                </span>
              </div>

              <div>
                <label
                  htmlFor="reg-otp-code"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Kode Verifikasi 6 Digit dari Kasir
                </label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="reg-otp-code"
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    required
                    value={verificationCode}
                    onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    className="w-full h-[52px] rounded-xl border border-sky-400/40 bg-[#070B19] pl-10 pr-4 font-mono text-xl font-bold tracking-[0.4em] text-white placeholder:text-slate-600 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/25"
                  />
                </div>
                <p className="mt-1.5 text-xs text-slate-400">
                  Kode sekali pakai ini diberikan oleh Kasir XP PLAY saat pre-registrasi (berlaku 7 hari, maks 5 percobaan).
                </p>
              </div>

              <div className="flex gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setError('');
                    setStep('CHECK_PHONE');
                  }}
                  className="h-[46px] px-4 rounded-xl border border-indigo-500/30 text-xs font-medium text-slate-300 hover:bg-[#101836]"
                >
                  Ganti Nomor
                </button>
                <button
                  type="submit"
                  disabled={loading || verificationCode.length !== 6}
                  className="flex-1 h-[46px] inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-4 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 disabled:opacity-50 transition-all"
                >
                  <span>{loading ? 'Memverifikasi...' : 'Verifikasi & Lanjut'}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </form>
          )}

          {/* STEP 3: COMPLETE PROFILE (WHATSAPP LOCKED) */}
          {step === 'COMPLETE_PROFILE' && verifiedSession && (
            <form onSubmit={handleCompleteProfile} className="space-y-4">
              {/* Locked Verified WhatsApp Field */}
              <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-emerald-300 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5" />
                    <span>Nomor WhatsApp Terverifikasi (Terkunci)</span>
                  </p>
                  <p className="mt-0.5 font-mono text-sm font-bold text-white">
                    {verifiedSession.normalizedWhatsapp}
                  </p>
                </div>
                <span className="font-mono text-xs text-emerald-300 shrink-0">
                  {verifiedSession.memberId}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label htmlFor="reg-fullname" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Nama Lengkap *
                  </label>
                  <input
                    id="reg-fullname"
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Nama sesuai identitas"
                    className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="reg-username" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Username *
                  </label>
                  <input
                    id="reg-username"
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
                    placeholder="contoh: andi.xp"
                    autoComplete="username"
                    className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm font-mono text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label htmlFor="reg-birthdate" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Tanggal Lahir *
                  </label>
                  <input
                    id="reg-birthdate"
                    type="date"
                    required
                    max={todayJakarta}
                    value={birthDate}
                    onChange={(e) => setBirthDate(e.target.value)}
                    className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white focus:border-sky-400 focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="reg-category" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Status Member *
                  </label>
                  <select
                    id="reg-category"
                    value={memberCategory}
                    onChange={(e) => setMemberCategory(e.target.value as MemberCategory)}
                    className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-sm text-white focus:border-sky-400 focus:outline-none"
                  >
                    {MEMBER_CATEGORIES.map((cat) => (
                      <option key={cat.value} value={cat.value}>
                        {cat.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label htmlFor="reg-social" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Social Media (IG / TikTok)
                  </label>
                  <input
                    id="reg-social"
                    type="text"
                    value={socialMedia}
                    onChange={(e) => setSocialMedia(e.target.value)}
                    placeholder="@instagram_anda"
                    className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="reg-branch" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Cabang Utama *
                  </label>
                  <select
                    id="reg-branch"
                    value={preferredBranch}
                    onChange={(e) => setPreferredBranch(e.target.value as BranchId)}
                    className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-sm text-white focus:border-sky-400 focus:outline-none"
                  >
                    <option value="DEMANG">XP PLAY Demang</option>
                    <option value="SEKIP">XP PLAY Sekip</option>
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="reg-referral" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Username Referral (Opsional · +{systemSettings.referralBonusXp} XP untuk Anda &amp; Referrer)
                </label>
                <input
                  id="reg-referral"
                  type="text"
                  value={referralUsername}
                  onChange={(e) => setReferralUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
                  placeholder="Kosongkan jika tidak ada"
                  className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm font-mono text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label htmlFor="reg-password" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Password Baru *
                  </label>
                  <input
                    id="reg-password"
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimal 8 karakter"
                    autoComplete="new-password"
                    className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="reg-confirm" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Konfirmasi Password *
                  </label>
                  <input
                    id="reg-confirm"
                    type="password"
                    required
                    minLength={8}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Ulangi password"
                    autoComplete="new-password"
                    className="w-full h-[44px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full h-[48px] inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-4 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 shadow-[0_0_24px_-6px_rgba(99,102,241,0.65)] disabled:opacity-50 transition-all"
              >
                <UserCheck className="w-4 h-4" />
                <span>
                  {loading
                    ? 'Mengaktifkan Membership...'
                    : `Aktifkan Membership (+${systemSettings.registrationBonusXp} XP)`}
                </span>
              </button>
            </form>
          )}

          {/* STEP 4: SUCCESS */}
          {step === 'SUCCESS' && completionOutcome && (
            <div className="space-y-5">
              <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 p-5 text-center space-y-2">
                <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto" />
                <h2 className="font-display text-xl font-extrabold text-white">
                  Selamat Datang, {completionOutcome.member.fullName}!
                </h2>
                <p className="text-sm text-emerald-200">
                  Akun <span className="font-mono font-semibold">@{completionOutcome.member.username}</span> kini berstatus{' '}
                  <strong>ACTIVE</strong>.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 text-center">
                <div className="rounded-xl bg-[#070B19] border border-indigo-500/25 p-3.5">
                  <p className="text-[11px] text-slate-400 uppercase tracking-wider">Total XP Progress</p>
                  <p className="mt-1 font-mono text-2xl font-extrabold text-sky-300 tabular-nums">
                    {completionOutcome.member.xpProgress} XP
                  </p>
                </div>
                <div className="rounded-xl bg-[#070B19] border border-indigo-500/25 p-3.5">
                  <p className="text-[11px] text-slate-400 uppercase tracking-wider">Saldo XP Reward</p>
                  <p className="mt-1 font-mono text-2xl font-extrabold text-purple-300 tabular-nums">
                    {completionOutcome.member.xpReward} XP
                  </p>
                </div>
              </div>

              <div className="rounded-xl bg-[#070B19] border border-indigo-500/25 p-4 text-xs text-slate-300 space-y-1.5">
                <p>
                  Bonus Pendaftaran Online:{' '}
                  <strong className="text-emerald-400 font-mono">
                    +{completionOutcome.registrationBonusGranted} XP Progress &amp; +{completionOutcome.registrationBonusGranted} XP Reward
                  </strong>
                </p>
                {completionOutcome.referralApplied && (
                  <p>
                    Bonus Referral:{' '}
                    <strong className="text-sky-300 font-mono">
                      +{systemSettings.referralBonusXp} XP diterapkan untuk Anda &amp; Referrer
                    </strong>
                  </p>
                )}
                {completionOutcome.referralMessage && (
                  <p className="text-amber-300">{completionOutcome.referralMessage}</p>
                )}
              </div>

              <button
                type="button"
                onClick={() => navigate('/member', { replace: true })}
                className="w-full h-[48px] inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-4 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500"
              >
                <span>Buka Member Dashboard</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {step !== 'SUCCESS' && (
            <div className="pt-2 text-center text-sm text-slate-300 space-y-2 border-t border-indigo-500/20">
              <p>
                Membership sudah aktif?{' '}
                <Link to="/login" className="font-semibold text-sky-300 hover:underline">
                  Masuk Member
                </Link>
              </p>
              <p className="text-xs text-slate-400">
                Kasir atau Admin XP PLAY?{' '}
                <Link to="/admin/login" className="font-medium text-purple-300 hover:underline">
                  Portal Kasir &amp; Admin
                </Link>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
