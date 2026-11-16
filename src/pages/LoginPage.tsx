import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, LogIn } from 'lucide-react';
import { CaptchaWidget } from '../components/CaptchaWidget.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import { loginMemberClient } from '../services/xpService.ts';

export function LoginPage() {
  const navigate = useNavigate();
  const { memberProfile, adminProfile, signInWithServerToken, capabilities } = useAuth();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [captcha, setCaptcha] = useState({ token: '', answer: '' });
  const [captchaReset, setCaptchaReset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (memberProfile) {
      navigate('/member', { replace: true });
    } else if (adminProfile) {
      navigate('/admin', { replace: true });
    }
  }, [memberProfile, adminProfile, navigate]);

  const handlePasswordLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (!identifier.trim() || !password) {
      setError('Username/WhatsApp dan password wajib diisi.');
      return;
    }

    setLoading(true);
    try {
      if (capabilities.adminSdkConfigured) {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: identifier.trim(),
            password,
            captchaToken: captcha.token,
            captchaAnswer: captcha.answer,
          }),
        });
        const data = (await res.json()) as { customToken?: string; error?: string };
        if (!res.ok || !data.customToken) {
          setCaptchaReset((v) => v + 1);
          setError(data.error || 'Username/WhatsApp atau password tidak sesuai.');
          return;
        }
        await signInWithServerToken(data.customToken);
      } else {
        await loginMemberClient({
          identifier: identifier.trim(),
          password,
          captchaToken: captcha.token,
          captchaAnswer: captcha.answer,
        });
      }

      navigate('/member', { replace: true });
    } catch (err) {
      setCaptchaReset((v) => v + 1);
      setError(mapFriendlyError(err, 'Login gagal diproses. Silakan coba lagi.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen gaming-canvas text-slate-100 flex flex-col justify-center px-4 py-8 sm:py-12">
      <div className="w-full max-w-md mx-auto">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 min-h-[40px] text-xs font-medium text-sky-300 hover:text-white mb-4 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Kembali ke Beranda</span>
        </Link>

        <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/30 p-5 sm:p-8 space-y-6 shadow-[0_0_40px_-14px_rgba(99,102,241,0.4)]">
          <div>
            <p className="text-xs font-medium text-sky-300">XP PLAY Member Portal</p>
            <h1 className="mt-1 font-display text-2xl font-extrabold tracking-tight text-white">
              Masuk Akun Member
            </h1>
            <p className="mt-1 text-sm text-slate-300">
              Gunakan username atau nomor WhatsApp Anda untuk memantau XP dan benefit.
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-xl border border-rose-500/35 bg-rose-500/10 p-3.5 text-sm text-rose-200"
            >
              {error}
            </div>
          )}

          <form onSubmit={handlePasswordLogin} className="space-y-4">
            <div>
              <label htmlFor="login-identifier" className="block text-xs font-medium text-slate-300 mb-1.5">
                Username atau Nomor WhatsApp
              </label>
              <input
                id="login-identifier"
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="Contoh: andi atau 0898xxxxxxx"
                autoComplete="username"
                className="w-full h-[46px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
              />
            </div>

            <div>
              <label htmlFor="login-password" className="block text-xs font-medium text-slate-300 mb-1.5">
                Password
              </label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Masukkan password"
                autoComplete="current-password"
                className="w-full h-[46px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
              />
            </div>

            <CaptchaWidget onChange={setCaptcha} resetSignal={captchaReset} />

            <button
              type="submit"
              disabled={loading}
              className="w-full h-[48px] inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-4 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 shadow-[0_0_24px_-6px_rgba(99,102,241,0.65)] disabled:opacity-50 transition-all"
            >
              <LogIn className="w-4 h-4" />
              <span>{loading ? 'Memproses...' : 'Masuk Member'}</span>
            </button>
          </form>

          <div className="pt-2 text-center text-sm text-slate-300 space-y-2">
            <p>
              Belum punya akun?{' '}
              <Link to="/register" className="font-semibold text-purple-300 hover:text-sky-300 hover:underline">
                Daftar Member (+10 XP)
              </Link>
            </p>
            <p className="text-xs text-slate-400">
              Operator / Kasir?{' '}
              <Link to="/admin/login" className="font-medium text-sky-300 hover:underline">
                Login Admin
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
