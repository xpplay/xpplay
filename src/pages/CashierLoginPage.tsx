import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, MailCheck, RefreshCw, ShieldAlert, Store } from 'lucide-react';
import { CaptchaWidget } from '../components/CaptchaWidget.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import {
  getDashboardRouteForRole,
  getEffectiveCashierBranch,
  isCashierRole,
  isFullAdminRole,
} from '../shared/rbac.ts';

type CashierAuthMode = 'login' | 'activate';

export function CashierLoginPage() {
  const navigate = useNavigate();
  const {
    firebaseUser,
    adminProfile,
    memberProfile,
    loading,
    signInWithEmail,
    registerAdminWithEmail,
    resendVerificationEmail,
    reloadCurrentUser,
    sendAdminPasswordReset,
    logout,
  } = useAuth();

  const [mode, setMode] = useState<CashierAuthMode>('login');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [captcha, setCaptcha] = useState({ token: '', answer: '' });
  const [captchaReset, setCaptchaReset] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const isAuthenticatedCashier = Boolean(adminProfile && isCashierRole(adminProfile.role));
  const assignedBranch = adminProfile ? getEffectiveCashierBranch(adminProfile) : null;
  const isWrongPortalAdmin = Boolean(adminProfile && isFullAdminRole(adminProfile.role));
  const isWrongPortalMember = Boolean(!adminProfile && memberProfile);
  const isCashierMissingBranch = Boolean(isAuthenticatedCashier && !assignedBranch);

  useEffect(() => {
    if (!loading && isAuthenticatedCashier && assignedBranch) {
      navigate('/cashier', { replace: true });
    }
  }, [loading, isAuthenticatedCashier, assignedBranch, navigate]);

  const verifyCaptchaFirst = async () => {
    const capRes = await fetch('/api/captcha/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: captcha.token,
        answer: captcha.answer,
      }),
    });
    const capJson = (await capRes.json()) as { valid?: boolean; error?: string };
    if (!capRes.ok || !capJson.valid) {
      throw new Error(capJson.error || 'Verifikasi CAPTCHA gagal.');
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !password) {
      setError('Email dan password kasir wajib diisi.');
      return;
    }
    if (mode === 'activate' && password.length < 8) {
      setError('Password minimal 8 karakter.');
      return;
    }

    setSubmitting(true);
    try {
      await verifyCaptchaFirst();
      if (mode === 'login') {
        await signInWithEmail(cleanEmail, password);
      } else {
        await registerAdminWithEmail(cleanEmail, password, fullName.trim() || 'Kasir XP PLAY');
        setInfo(
          `Akun kasir berhasil dibuat. Tautan verifikasi email telah dikirim ke ${cleanEmail}. Buka email Anda, klik tautan verifikasi, lalu muat ulang sesi.`
        );
      }
    } catch (err) {
      setCaptchaReset((v) => v + 1);
      setError(mapFriendlyError(err, 'Gagal memproses login Kasir.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotPassword = async () => {
    setError('');
    setInfo('');
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) {
      setError('Masukkan email kasir terlebih dahulu untuk mengirim tautan reset password.');
      return;
    }
    setSubmitting(true);
    try {
      await sendAdminPasswordReset(cleanEmail);
      setInfo(`Tautan reset password telah dikirim ke ${cleanEmail} (periksa folder Inbox/Spam).`);
    } catch (err) {
      setError(mapFriendlyError(err, 'Gagal mengirim email reset password.'));
    } finally {
      setSubmitting(false);
    }
  };

  const needsEmailVerification = Boolean(firebaseUser && !firebaseUser.emailVerified);

  return (
    <div className="min-h-screen gaming-canvas text-slate-100 flex flex-col justify-center px-4 py-8 sm:py-10">
      <div className="w-full max-w-md mx-auto">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 min-h-[40px] text-xs font-medium text-emerald-300 hover:text-white mb-4 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Kembali ke Beranda</span>
        </Link>

        <div className="bg-[#09141C] rounded-2xl border border-emerald-500/30 p-5 sm:p-8 space-y-6 shadow-[0_0_40px_-14px_rgba(16,185,129,0.35)]">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-500/25 to-teal-600/35 border border-emerald-400/40 text-emerald-300 flex items-center justify-center shrink-0">
              <Store className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-emerald-300">
                XP PLAY Front Desk · Demang &amp; Sekip
              </p>
              <h1 className="mt-0.5 font-display text-xl font-extrabold text-white tracking-tight">
                Portal Login Kasir
              </h1>
              <p className="mt-1 text-xs text-slate-300 leading-relaxed">
                Khusus akun Kasir operasional cabang yang telah diotorisasi oleh Super Admin.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px] text-slate-400 border-y border-emerald-500/15 py-2.5">
            <span>Akses Terisolasi Per Cabang</span>
            <span className="font-mono text-emerald-300/90 tabular-nums">DEMANG · SEKIP</span>
          </div>

          {error && (
            <div role="alert" className="rounded-xl border border-rose-500/35 bg-rose-500/10 p-3.5 text-sm text-rose-200">
              {error}
            </div>
          )}

          {info && (
            <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3.5 text-xs text-emerald-200 leading-relaxed">
              {info}
            </div>
          )}

          {isWrongPortalAdmin && adminProfile && (
            <div
              role="alert"
              className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-4 text-xs text-amber-100 space-y-3"
            >
              <div className="flex items-start gap-2.5">
                <ShieldAlert className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-semibold text-white">Portal Login Tidak Sesuai Role</p>
                  <p className="leading-relaxed">
                    Akun <strong className="text-white">{adminProfile.email}</strong> terdaftar sebagai{' '}
                    <span className="font-mono font-semibold text-amber-300">{adminProfile.role}</span>, bukan akun Kasir cabang. Silakan masuk melalui Portal Admin.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  to={getDashboardRouteForRole(adminProfile.role)}
                  className="inline-flex items-center justify-center min-h-[38px] rounded-lg bg-indigo-600 hover:bg-indigo-500 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors"
                >
                  Buka Portal {adminProfile.role === 'SUPER_ADMIN' ? 'Superadmin' : 'Admin'}
                </Link>
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="min-h-[38px] rounded-lg border border-amber-400/35 px-3.5 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-500/20 transition-colors"
                >
                  Keluar &amp; Ganti Akun Kasir
                </button>
              </div>
            </div>
          )}

          {isWrongPortalMember && (
            <div
              role="alert"
              className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-4 text-xs text-amber-100 space-y-3"
            >
              <p className="leading-relaxed">
                Akun yang sedang aktif adalah akun <strong className="text-white">Member</strong>. Portal ini dikhususkan untuk Kasir cabang XP PLAY.
              </p>
              <div className="flex flex-wrap gap-2">
                <Link
                  to="/member"
                  className="inline-flex items-center justify-center min-h-[38px] rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors"
                >
                  Ke Member Dashboard
                </Link>
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="min-h-[38px] rounded-lg border border-amber-400/35 px-3.5 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-500/20 transition-colors"
                >
                  Keluar
                </button>
              </div>
            </div>
          )}

          {isCashierMissingBranch && adminProfile && (
            <div
              role="alert"
              className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-xs text-rose-100 space-y-3"
            >
              <p className="leading-relaxed">
                Akun Kasir <strong className="text-white">{adminProfile.email}</strong> belum memiliki penetapan cabang tetap (<span className="font-mono">DEMANG</span> atau <span className="font-mono">SEKIP</span>). Hubungi Super Admin untuk menetapkan slot cabang.
              </p>
              <button
                type="button"
                onClick={() => void logout()}
                className="min-h-[38px] rounded-lg border border-rose-400/40 px-3.5 py-1.5 text-xs font-medium text-rose-100 hover:bg-rose-500/20"
              >
                Keluar
              </button>
            </div>
          )}

          {needsEmailVerification && firebaseUser && (
            <div className="rounded-xl border border-emerald-400/35 bg-emerald-500/10 p-4 text-xs text-emerald-100 space-y-3">
              <div className="flex items-start gap-2">
                <MailCheck className="w-4 h-4 text-emerald-300 shrink-0 mt-0.5" />
                <p>
                  Email kasir <strong className="text-white">{firebaseUser.email}</strong> belum terverifikasi. Buka email Anda dan klik tautan verifikasi untuk mengaktifkan akses Kasir.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() =>
                    void (async () => {
                      setSubmitting(true);
                      setError('');
                      try {
                        await reloadCurrentUser();
                      } catch (err) {
                        setError(mapFriendlyError(err));
                      } finally {
                        setSubmitting(false);
                      }
                    })()
                  }
                  className="inline-flex items-center gap-1.5 min-h-[38px] rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:from-emerald-500 hover:to-teal-500"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Saya Sudah Verifikasi</span>
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() =>
                    void resendVerificationEmail()
                      .then(() => setInfo('Email verifikasi ulang telah dikirim.'))
                      .catch((err) => setError(mapFriendlyError(err)))
                  }
                  className="min-h-[38px] rounded-lg border border-emerald-400/40 px-3 py-1.5 text-xs font-medium text-emerald-100 hover:bg-emerald-500/20"
                >
                  Kirim Ulang Link
                </button>
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="min-h-[38px] rounded-lg border border-emerald-500/30 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-[#0D1E2A]"
                >
                  Keluar
                </button>
              </div>
            </div>
          )}

          {firebaseUser && firebaseUser.emailVerified && !loading && !adminProfile && !memberProfile && (
            <div className="rounded-xl border border-teal-400/35 bg-teal-500/10 p-4 text-xs text-teal-100 space-y-3">
              <p className="leading-relaxed">
                Akun <strong className="text-white">{firebaseUser.email || firebaseUser.uid}</strong> belum ditugaskan ke slot Kasir cabang. Berikan UID berikut kepada Super Admin untuk aktivasi slot Kasir:{' '}
                <code className="font-mono text-emerald-300 select-all">{firebaseUser.uid}</code>
              </p>
              <button
                type="button"
                onClick={() => void logout()}
                className="min-h-[38px] rounded-lg border border-teal-400/40 px-3 py-1.5 text-xs font-medium text-teal-100 hover:bg-teal-500/20"
              >
                Keluar dari Akun Ini
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-1 rounded-xl bg-[#050C12] p-1 border border-emerald-500/25">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setError('');
              }}
              className={`min-h-[40px] rounded-lg text-xs font-semibold transition-all whitespace-nowrap ${
                mode === 'login'
                  ? 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Masuk Kasir
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('activate');
                setError('');
              }}
              className={`min-h-[40px] rounded-lg text-xs font-semibold transition-all whitespace-nowrap ${
                mode === 'activate'
                  ? 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Aktivasi Akun Kasir
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'activate' && (
              <div>
                <label htmlFor="cashier-name" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Nama Lengkap Kasir
                </label>
                <input
                  id="cashier-name"
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Contoh: Kasir Demang Shift 1"
                  className="w-full h-[46px] rounded-xl border border-emerald-500/30 bg-[#050C12] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/20"
                />
              </div>
            )}

            <div>
              <label htmlFor="cashier-email" className="block text-xs font-medium text-slate-300 mb-1.5">
                Email Kasir Cabang
              </label>
              <input
                id="cashier-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="kasir.cabang@email.com"
                autoComplete="email"
                className="w-full h-[46px] rounded-xl border border-emerald-500/30 bg-[#050C12] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/20"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="cashier-password" className="block text-xs font-medium text-slate-300">
                  Password
                </label>
                {mode === 'login' && (
                  <button
                    type="button"
                    onClick={() => void handleForgotPassword()}
                    className="text-xs font-medium text-emerald-300 hover:underline"
                  >
                    Lupa password?
                  </button>
                )}
              </div>
              <input
                id="cashier-password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'activate' ? 'Minimal 8 karakter' : 'Masukkan password kasir'}
                autoComplete={mode === 'activate' ? 'new-password' : 'current-password'}
                className="w-full h-[46px] rounded-xl border border-emerald-500/30 bg-[#050C12] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/20"
              />
            </div>

            <CaptchaWidget onChange={setCaptcha} resetSignal={captchaReset} />

            <button
              type="submit"
              disabled={submitting || loading}
              className="w-full h-[48px] inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600 px-4 text-sm font-semibold text-white hover:from-emerald-500 hover:to-cyan-500 shadow-[0_0_24px_-6px_rgba(16,185,129,0.55)] disabled:opacity-50 transition-all"
            >
              <span>
                {submitting || loading
                  ? 'Memproses...'
                  : mode === 'activate'
                    ? 'Buat Akun Kasir & Kirim Verifikasi'
                    : 'Masuk Portal Kasir'}
              </span>
            </button>
          </form>

          <div className="pt-2 border-t border-emerald-500/15 text-center text-xs text-slate-400 space-y-1.5">
            <p>
              Cabang operasional otomatis mengikuti slot penugasan dari Super Admin.
            </p>
            <p className="flex items-center justify-center gap-2">
              <Link to="/admin/login" className="font-medium text-indigo-300 hover:text-white hover:underline">
                Portal Admin
              </Link>
              <span aria-hidden="true">·</span>
              <Link to="/login" className="font-medium text-sky-300 hover:text-white hover:underline">
                Login Member
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
