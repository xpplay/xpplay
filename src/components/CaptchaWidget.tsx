import { useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { fetchCaptchaChallenge } from '../services/xpService.ts';

interface CaptchaWidgetProps {
  onChange: (payload: { token: string; answer: string }) => void;
  resetSignal?: number;
}

export function CaptchaWidget({ onChange, resetSignal = 0 }: CaptchaWidgetProps) {
  const [mode, setMode] = useState<'recaptcha' | 'server_svg'>('server_svg');
  const [svg, setSvg] = useState<string>('');
  const [challengeToken, setChallengeToken] = useState<string>('');
  const [answer, setAnswer] = useState<string>('');
  const [siteKey, setSiteKey] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');

  const loadChallenge = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchCaptchaChallenge();
      setMode(data.mode);
      if (data.mode === 'recaptcha' && data.siteKey) {
        setSiteKey(data.siteKey);
        setChallengeToken('');
        setAnswer('');
        onChange({ token: '', answer: '' });
      } else {
        setSvg(data.svg || '');
        setChallengeToken(data.challengeToken || '');
        setAnswer('');
        onChange({ token: data.challengeToken || '', answer: '' });
      }
    } catch {
      setError('Gagal memuat kode keamanan.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadChallenge();
  }, [resetSignal]);

  // If Google reCAPTCHA is configured, load Google script dynamically
  useEffect(() => {
    if (mode !== 'recaptcha' || !siteKey) return;
    const win = window as unknown as {
      grecaptcha?: {
        render: (el: string, opts: { sitekey: string; callback: (tok: string) => void }) => void;
      };
      __xpRecaptchaOnLoad?: () => void;
    };

    const renderWidget = () => {
      const container = document.getElementById('xp-recaptcha-box');
      if (container && win.grecaptcha && container.childElementCount === 0) {
        win.grecaptcha.render('xp-recaptcha-box', {
          sitekey: siteKey,
          callback: (tok: string) => {
            onChange({ token: tok, answer: '' });
          },
        });
      }
    };

    if (win.grecaptcha) {
      renderWidget();
      return;
    }

    win.__xpRecaptchaOnLoad = renderWidget;
    const script = document.createElement('script');
    script.src = 'https://www.google.com/recaptcha/api.js?onload=__xpRecaptchaOnLoad&render=explicit';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }, [mode, siteKey]);

  if (mode === 'recaptcha') {
    return (
      <div className="space-y-2 rounded-xl border border-indigo-500/25 bg-[#070B19] p-3.5">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-300">
          <ShieldCheck className="w-4 h-4 text-sky-400" />
          <span>Verifikasi Keamanan (reCAPTCHA)</span>
        </div>
        <div id="xp-recaptcha-box" className="min-h-[78px]" />
      </div>
    );
  }

  return (
    <div className="space-y-2.5 rounded-xl border border-indigo-500/25 bg-[#070B19] p-3.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="captcha-input" className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
          <ShieldCheck className="w-4 h-4 text-sky-400" />
          <span>Verifikasi Keamanan</span>
        </label>
        <button
          type="button"
          onClick={() => void loadChallenge()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 min-h-[36px] text-xs font-medium text-sky-300 hover:bg-indigo-500/15 hover:text-sky-200 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Muat Ulang</span>
        </button>
      </div>

      {error ? (
        <p className="text-xs text-rose-400">{error}</p>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div
            className="shrink-0 overflow-hidden rounded-lg border border-sky-400/30 bg-slate-100 flex items-center justify-center h-[52px] w-[180px]"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          <input
            id="captcha-input"
            type="text"
            autoComplete="off"
            value={answer}
            onChange={(e) => {
              const val = e.target.value.toUpperCase();
              setAnswer(val);
              onChange({ token: challengeToken, answer: val });
            }}
            placeholder="Ketik 5 karakter"
            maxLength={8}
            className="w-full h-[46px] rounded-xl border border-indigo-500/30 bg-[#0B1124] px-3.5 text-sm font-mono uppercase tracking-widest text-white placeholder:normal-case placeholder:tracking-normal placeholder:font-sans placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
          />
        </div>
      )}
    </div>
  );
}
