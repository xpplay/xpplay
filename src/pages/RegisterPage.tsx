import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, UserPlus } from 'lucide-react';
import { CaptchaWidget } from '../components/CaptchaWidget.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import { registerMemberClient } from '../services/xpService.ts';
import { validateUsername, validateWhatsapp } from '../shared/xpLogic.ts';
import type { BranchId } from '../types/xpplay.ts';

export function RegisterPage() {
  const navigate = useNavigate();
  const {
    memberProfile,
    adminProfile,
    capabilities,
    systemSettings,
    signInWithServerToken,
    refreshProfiles,
  } = useAuth();
  const regBonus = systemSettings.registrationBonusXp;
  const refBonus = systemSettings.referralBonusXp;

  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [socialMedia, setSocialMedia] = useState('');
  const [referralUsername, setReferralUsername] = useState('');
  const [preferredBranch, setPreferredBranch] = useState<BranchId>('DEMANG');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [captcha, setCaptcha] = useState({ token: '', answer: '' });
  const [captchaReset, setCaptchaReset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successInfo, setSuccessInfo] = useState<{
    username: string;
    xpTotal: number;
    referralNote?: string;
  } | null>(null);

  useEffect(() => {
    if (memberProfile && !successInfo) {
      navigate('/member', { replace: true });
    } else if (adminProfile) {
      navigate('/admin', { replace: true });
    }
  }, [memberProfile, adminProfile, successInfo, navigate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (fullName.trim().length < 2) {
      setError('Nama lengkap minimal 2 karakter.');
      return;
    }

    const uCheck = validateUsername(username);
    if (!uCheck.valid) {
      setError(uCheck.error || 'Username tidak valid.');
      return;
    }

    const wCheck = validateWhatsapp(whatsapp);
    if (!wCheck.valid) {
      setError(wCheck.error || 'Nomor WhatsApp tidak valid.');
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
      if (capabilities.adminSdkConfigured) {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fullName: fullName.trim(),
            username: uCheck.normalized,
            whatsapp: wCheck.normalized,
            socialMedia: socialMedia.trim(),
            referralUsername: referralUsername.trim() || undefined,
            preferredBranch,
            password,
            captchaToken: captcha.token,
            captchaAnswer: captcha.answer,
          }),
        });

        const data = (await res.json()) as {
          customToken?: string;
          member?: { username: string; xpProgress: number };
          referralApplied?: boolean;
          referralMessage?: string;
          error?: string;
        };

        if (!res.ok || !data.customToken || !data.member) {
          setCaptchaReset((v) => v + 1);
          setError(data.error || 'Registrasi gagal diproses.');
          return;
        }

        await signInWithServerToken(data.customToken);
        setSuccessInfo({
          username: data.member.username,
          xpTotal: data.member.xpProgress,
          referralNote: data.referralApplied
            ? `Bonus referral +${refBonus} XP berhasil diterapkan untuk Anda dan referrer!`
            : data.referralMessage,
        });
      } else {
        const res = await registerMemberClient({
          fullName: fullName.trim(),
          username: uCheck.normalized,
          whatsapp: wCheck.normalized,
          socialMedia: socialMedia.trim(),
          referralUsername: referralUsername.trim() || undefined,
          preferredBranch,
          password,
          captchaToken: captcha.token,
          captchaAnswer: captcha.answer,
        });
        await refreshProfiles();
        setSuccessInfo({
          username: res.member.username,
          xpTotal: res.member.xpProgress,
          referralNote: res.referralApplied
            ? `Bonus referral +${refBonus} XP berhasil diterapkan untuk Anda dan referrer!`
            : res.referralMessage,
        });
      }
    } catch (err) {
      setCaptchaReset((v) => v + 1);
      setError(mapFriendlyError(err, 'Registrasi gagal diproses.'));
    } finally {
      setLoading(false);
    }
  };

  if (successInfo) {
    return (
      <div className="min-h-screen gaming-canvas flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md bg-[#0B1124] rounded-2xl border border-sky-400/35 p-6 sm:p-8 text-center space-y-5 shadow-[0_0_40px_-12px_rgba(56,189,248,0.45)]">
          <div className="w-14 h-14 rounded-2xl bg-emerald-500/15 border border-emerald-400/35 text-emerald-400 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <div>
            <h1 className="font-display text-2xl font-extrabold text-white">Selamat Datang di XP PLAY!</h1>
            <p className="mt-2 text-sm text-slate-300">
              Akun <strong className="text-sky-300 font-mono">@{successInfo.username}</strong> berhasil dibuat.
            </p>
          </div>
          <div className="rounded-xl bg-[#070B19] border border-indigo-500/25 p-4 text-left space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-300">XP Progress Awal</span>
              <span className="font-mono font-bold text-sky-300 tabular-nums">+{successInfo.xpTotal} XP</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-300">XP Reward Awal</span>
              <span className="font-mono font-bold text-purple-300 tabular-nums">+{successInfo.xpTotal} XP</span>
            </div>
            {successInfo.referralNote && (
              <p className="pt-2 text-xs text-slate-300 border-t border-indigo-500/20">{successInfo.referralNote}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => navigate('/member', { replace: true })}
            className="w-full h-[48px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 transition-all"
          >
            Masuk ke Dashboard Member
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen gaming-canvas text-slate-100 px-4 py-8 sm:py-10">
      <div className="w-full max-w-lg mx-auto">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 min-h-[40px] text-xs font-medium text-sky-300 hover:text-white mb-4 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Kembali ke Beranda</span>
        </Link>

        <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/30 p-5 sm:p-8 space-y-6 shadow-[0_0_40px_-14px_rgba(99,102,241,0.4)]">
          <div>
            <p className="text-xs font-medium text-sky-300">
              Registrasi Member Baru · Bonus +{regBonus} XP
            </p>
            <h1 className="mt-1 font-display text-2xl font-extrabold tracking-tight text-white">
              Daftar XP PLAY Member
            </h1>
            <p className="mt-1 text-sm text-slate-300">
              Dapatkan +{regBonus} XP langsung saat mendaftar, dan +{refBonus} XP tambahan bila menggunakan username referral teman.
            </p>
          </div>

          {error && (
            <div role="alert" className="rounded-xl border border-rose-500/35 bg-rose-500/10 p-3.5 text-sm text-rose-200">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
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
                  placeholder="Nama lengkap"
                  className="w-full h-[46px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
                />
              </div>
              <div>
                <label htmlFor="reg-username" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Username Unik *
                </label>
                <input
                  id="reg-username"
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase())}
                  placeholder="contoh: andi_play"
                  className="w-full h-[46px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm font-mono text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
                />
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="reg-wa" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Nomor WhatsApp *
                </label>
                <input
                  id="reg-wa"
                  type="tel"
                  required
                  value={whatsapp}
                  onChange={(e) => setWhatsapp(e.target.value)}
                  placeholder="0898xxxxxxx"
                  className="w-full h-[46px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm font-mono text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
                />
              </div>
              <div>
                <label htmlFor="reg-sosmed" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Sosial Media (IG/TikTok)
                </label>
                <input
                  id="reg-sosmed"
                  type="text"
                  value={socialMedia}
                  onChange={(e) => setSocialMedia(e.target.value)}
                  placeholder="@username_ig"
                  className="w-full h-[46px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
                />
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="reg-branch" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Cabang Utama
                </label>
                <select
                  id="reg-branch"
                  value={preferredBranch}
                  onChange={(e) => setPreferredBranch(e.target.value as BranchId)}
                  className="w-full h-[46px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3 text-sm text-white focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
                >
                  <option value="DEMANG">XP PLAY DEMANG (Game Center)</option>
                  <option value="SEKIP">XP PLAY SEKIP (Game Platinum)</option>
                </select>
              </div>
              <div>
                <label htmlFor="reg-ref" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Username Referral (Opsional)
                </label>
                <input
                  id="reg-ref"
                  type="text"
                  value={referralUsername}
                  onChange={(e) => setReferralUsername(e.target.value.toLowerCase())}
                  placeholder={`Isi username teman (+${refBonus} XP)`}
                  className="w-full h-[46px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm font-mono text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
                />
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="reg-pass" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Password (min. 8 karakter) *
                </label>
                <input
                  id="reg-pass"
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimal 8 karakter"
                  className="w-full h-[46px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
                />
              </div>
              <div>
                <label htmlFor="reg-pass2" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Konfirmasi Password *
                </label>
                <input
                  id="reg-pass2"
                  type="password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Ulangi password"
                  className="w-full h-[46px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
                />
              </div>
            </div>

            <CaptchaWidget onChange={setCaptcha} resetSignal={captchaReset} />

            <button
              type="submit"
              disabled={loading}
              className="w-full h-[48px] inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-4 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 shadow-[0_0_24px_-6px_rgba(99,102,241,0.65)] disabled:opacity-50 transition-all"
            >
              <UserPlus className="w-4 h-4" />
              <span>{loading ? 'Memproses Pendaftaran...' : `Daftar Sekarang (+${regBonus} XP)`}</span>
            </button>
          </form>

          <p className="text-center text-sm text-slate-300">
            Sudah terdaftar?{' '}
            <Link to="/login" className="font-semibold text-sky-300 hover:underline">
              Login Member
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
