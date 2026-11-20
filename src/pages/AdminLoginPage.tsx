import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, MailCheck, RefreshCw, ShieldCheck } from 'lucide-react';
import { CaptchaWidget } from '../components/CaptchaWidget.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import { getDashboardRouteForRole } from '../shared/rbac.ts';

type AdminAuthMode = 'login' | 'activate';

export function AdminLoginPage() {
  const navigate = useNavigate();
  const {
    firebaseUser,
    adminProfile,
    loading,
    signInWithEmail,
    registerAdminWithEmail,
    resendVerificationEmail,
    reloadCurrentUser,
    sendAdminPasswordReset,
    logout,
  } = useAuth();

  const [mode, setMode] = useState<AdminAuthMode>('login');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [captcha, setCaptcha] = useState({ token: '', answer: '' });
  const [captchaReset, setCaptchaReset] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  useEffect(() => {
    if (!loading && adminProfile) {
      navigate(getDashboardRouteForRole(adminProfile.role), { replace: true });
    }
  }, [loading, adminProfile, navigate]);

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
      setError('Email dan password admin wajib diisi.');
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
        await registerAdminWithEmail(cleanEmail, password, fullName.trim() || 'Admin XP PLAY');
        setInfo(
          `Akun berhasil dibuat. Link verifikasi email telah dikirim ke ${cleanEmail}. Silakan klik link tersebut lalu muat ulang sesi.`
        );
      }
    } catch (err) {
      setCaptchaReset((v) => v + 1);
      setError(mapFriendlyError(err, 'Gagal memproses login Admin.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotPassword = async () => {
    setError('');
    setInfo('');
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) {
      setError('Masukkan email admin terlebih dahulu untuk mengirim link reset password.');
      return;
    }
    setSubmitting(true);
    try {
      await sendAdminPasswordReset(cleanEmail);
      setInfo(`Link reset password telah dikirim ke ${cleanEmail} (periksa folder Inbox/Spam).`);
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
          className="inline-flex items-center gap-1.5 min-h-[40px] text-xs font-medium text-sky-300 hover:text-white mb-4 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Kembali ke Beranda</span>
        </Link>

        <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/30 p-5 sm:p-8 space-y-6 shadow-[0_0_40px_-14px_rgba(147,51,234,0.4)]">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-blue-600/25 to-purple-600/35 border border-sky-400/35 text-sky-300 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs font-medium text-purple-300">XP PLAY Internal Console</p>
              <h1 className="mt-0.5 font-display text-xl font-extrabold text-white">Portal Admin &amp; Kasir</h1>
              <p className="mt-1 text-xs text-slate-300">
                Masuk menggunakan Email &amp; Password admin terdaftar.
              </p>
            </div>
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

          {needsEmailVerification && firebaseUser && (
            <div className="rounded-xl border border-sky-400/35 bg-sky-500/10 p-4 text-xs text-sky-100 space-y-3">
              <div className="flex items-start gap-2">
                <MailCheck className="w-4 h-4 text-sky-300 shrink-0 mt-0.5" />
                <p>
                  Email <strong className="text-white">{firebaseUser.email}</strong> belum terverifikasi. Buka email Anda dan klik tautan verifikasi untuk mengaktifkan akses Admin.
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
                  className="inline-flex items-center gap-1.5 min-h-[38px] rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500"
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
                  className="min-h-[38px] rounded-lg border border-sky-400/40 px-3 py-1.5 text-xs font-medium text-sky-100 hover:bg-sky-500/20"
                >
                  Kirim Ulang Link
                </button>
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="min-h-[38px] rounded-lg border border-indigo-500/30 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-[#101836]"
                >
                  Keluar
                </button>
              </div>
            </div>
          )}

          {firebaseUser && firebaseUser.emailVerified && !loading && !adminProfile && (
            <div className="rounded-xl border border-purple-400/35 bg-purple-500/10 p-4 text-xs text-purple-100 space-y-3">
              <p>
                Akun <strong className="text-white">{firebaseUser.email || firebaseUser.uid}</strong> belum terdaftar sebagai Admin/Staff aktif. Hubungi Super Admin untuk otorisasi role (UID:{' '}
                <code className="font-mono text-sky-300 select-all">{firebaseUser.uid}</code>).
              </p>
              <button
                type="button"
                onClick={() => void logout()}
                className="min-h-[38px] rounded-lg border border-purple-400/40 px-3 py-1.5 text-xs font-medium text-purple-100 hover:bg-purple-500/20"
              >
                Keluar dari Akun Ini
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-1 rounded-xl bg-[#070B19] p-1 border border-indigo-500/25">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setError('');
              }}
              className={`min-h-[40px] rounded-lg text-xs font-semibold transition-all ${
                mode === 'login'
                  ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Masuk Admin
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('activate');
                setError('');
              }}
              className={`min-h-[40px] rounded-lg text-xs font-semibold transition-all ${
                mode === 'activate'
                  ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Aktivasi Akun
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'activate' && (
              <div>
                <label htmlFor="admin-name" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Nama Lengkap Admin
                </label>
                <input
                  id="admin-name"
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Super Admin XP PLAY"
                  className="w-full h-[46px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
                />
              </div>
            )}

            <div>
              <label htmlFor="admin-email" className="block text-xs font-medium text-slate-300 mb-1.5">
                Email Admin
              </label>
              <input
                id="admin-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="spv.xpplay@gmail.com"
                autoComplete="email"
                className="w-full h-[46px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="admin-password" className="block text-xs font-medium text-slate-300">
                  Password
                </label>
                {mode === 'login' && (
                  <button
                    type="button"
                    onClick={() => void handleForgotPassword()}
                    className="text-xs font-medium text-sky-300 hover:underline"
                  >
                    Lupa password?
                  </button>
                )}
              </div>
              <input
                id="admin-password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'activate' ? 'Minimal 8 karakter' : 'Masukkan password'}
                autoComplete={mode === 'activate' ? 'new-password' : 'current-password'}
                className="w-full h-[46px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
              />
            </div>

            <CaptchaWidget onChange={setCaptcha} resetSignal={captchaReset} />

            <button
              type="submit"
              disabled={submitting || loading}
              className="w-full h-[48px] inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-4 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 shadow-[0_0_24px_-6px_rgba(99,102,241,0.65)] disabled:opacity-50 transition-all"
            >
              <span>
                {submitting || loading
                  ? 'Memproses...'
                  : mode === 'activate'
                    ? 'Buat Akun Admin & Kirim Verifikasi'
                    : 'Masuk Portal Admin'}
              </span>
            </button>
          </form>

          <p className="text-center text-xs text-slate-400">
            Super Admin utama (<span className="font-mono text-sky-300">spv.xpplay@gmail.com</span>) diotorisasi otomatis setelah aktivasi &amp; verifikasi email.
          </p>
        </div>
      </div>
    </div>
  );
}
