import { Link } from 'react-router-dom';
import { ArrowRight, Crown, Gift, MapPin, MessageCircle, Shield, Trophy, Zap } from 'lucide-react';
import { MemberXpShowcase } from '../components/MemberXpShowcase.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { DEFAULT_BRANCHES, DEFAULT_LEVELS } from '../shared/xpLogic.ts';

export function LandingPage() {
  const { firebaseUser, memberProfile, adminProfile, levels, branches, systemSettings } = useAuth();
  const displayLevels = levels.length ? levels : DEFAULT_LEVELS;
  const displayBranches = branches.length ? branches : DEFAULT_BRANCHES;

  const primaryCta = adminProfile
    ? { to: '/admin', label: 'Dashboard Admin' }
    : memberProfile
      ? { to: '/member', label: 'Dashboard Member' }
      : { to: '/register', label: 'Daftar Member' };

  const tierAccents: Record<string, { border: string; text: string; Icon: typeof Shield }> = {
    BRONZE: { border: 'border-sky-500/25', text: 'text-sky-300', Icon: Shield },
    SILVER: { border: 'border-cyan-400/30', text: 'text-cyan-300', Icon: Zap },
    JURAGAN: { border: 'border-indigo-400/35', text: 'text-indigo-300', Icon: Trophy },
    SULTAN: { border: 'border-purple-400/45', text: 'text-purple-300', Icon: Crown },
  };

  return (
    <div className="min-h-screen gaming-canvas text-slate-100 flex flex-col overflow-x-hidden">
      {/* Top Bar: 3-zone contract */}
      <header className="sticky top-0 z-30 bg-[#050814]/90 backdrop-blur-md border-b border-indigo-500/20">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 h-14 sm:h-16 flex items-center justify-between gap-8">
          <Link
            to="/"
            className="font-display text-lg font-extrabold tracking-tight bg-gradient-to-r from-sky-300 via-blue-300 to-purple-300 bg-clip-text text-transparent whitespace-nowrap shrink-0"
          >
            XP PLAY
          </Link>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-300">
            <a href="#sistem-xp" className="hover:text-sky-300 transition-colors whitespace-nowrap shrink-0">
              Sistem XP
            </a>
            <a href="#kartu-member" className="hover:text-sky-300 transition-colors whitespace-nowrap shrink-0">
              Kartu Member
            </a>
            <a href="#level" className="hover:text-sky-300 transition-colors whitespace-nowrap shrink-0">
              Tingkatan Level
            </a>
            <a href="#cabang" className="hover:text-sky-300 transition-colors whitespace-nowrap shrink-0">
              Lokasi Cabang
            </a>
            <Link to="/login" className="hover:text-sky-300 transition-colors whitespace-nowrap shrink-0">
              Masuk Member
            </Link>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <Link
              to={primaryCta.to}
              className="inline-flex items-center gap-2 min-h-[40px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-4 py-2 text-xs sm:text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 shadow-[0_0_20px_-4px_rgba(99,102,241,0.6)] transition-all whitespace-nowrap shrink-0"
            >
              <span>{primaryCta.label}</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero Section */}
        <section className="max-w-7xl mx-auto px-4 sm:px-8 pt-10 pb-8 lg:pt-16 lg:pb-12 space-y-10">
          <div className="max-w-3xl space-y-5">
            <p className="text-xs font-medium text-sky-300 tracking-wide">
              XP PLAY Demang · XP PLAY Sekip · Palembang
            </p>
            <h1 className="font-display text-3xl sm:text-5xl font-extrabold tracking-tight text-white text-balance leading-[1.12]">
              Main lebih seru, naikkan{' '}
              <span className="bg-gradient-to-r from-sky-400 via-blue-400 to-purple-400 bg-clip-text text-transparent">
                XP Progress
              </span>
              , dan tukarkan{' '}
              <span className="bg-gradient-to-r from-purple-400 to-sky-300 bg-clip-text text-transparent">
                XP Reward
              </span>
              .
            </h1>
            <p className="text-base sm:text-lg text-slate-300 max-w-2xl leading-relaxed">
              Program membership resmi XP PLAY Game Center Demang dan XP PLAY Game Platinum Sekip. Setiap transaksi, referral, challenge, dan event tercatat transparan ke dalam kartu member Anda.
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Link
                to={primaryCta.to}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-6 py-3 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 shadow-[0_0_26px_-6px_rgba(99,102,241,0.65)] transition-all min-h-[46px]"
              >
                <span>{memberProfile || adminProfile ? primaryCta.label : 'Daftar Member (+10 XP)'}</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
              {!firebaseUser && (
                <Link
                  to="/login"
                  className="inline-flex items-center justify-center rounded-xl border border-indigo-400/35 bg-[#0B1124] px-6 py-3 text-sm font-semibold text-slate-100 hover:border-sky-400/60 hover:bg-[#101836] transition-colors min-h-[46px]"
                >
                  Login Member
                </Link>
              )}
            </div>
            <div className="pt-4 border-t border-indigo-500/20 flex flex-wrap gap-x-6 gap-y-2 text-xs text-slate-300">
              <span>
                Bonus Daftar: <strong className="text-sky-300 font-mono tabular-nums">+10 XP</strong>
              </span>
              <span>
                Bonus Referral: <strong className="text-purple-300 font-mono tabular-nums">+5 XP</strong>
              </span>
              <span>
                Rate Transaksi: <strong className="text-white font-mono tabular-nums">Rp2.000 = 1 XP</strong>
              </span>
            </div>
          </div>

          {/* Interactive Member Card Preview */}
          <div id="kartu-member">
            <MemberXpShowcase
              memberId={memberProfile?.memberId || 'XPP-PREVIEW'}
              fullName={memberProfile?.fullName || 'Andi Pratama'}
              username={memberProfile?.username || 'andi_play'}
              cycleId={systemSettings.currentCycleId}
              xpProgress={memberProfile?.xpProgress ?? 450}
              xpReward={memberProfile?.xpReward ?? 250}
              levels={displayLevels}
              previewMode
            />
          </div>
        </section>

        {/* System Mechanics */}
        <section id="sistem-xp" className="border-t border-indigo-500/20 bg-[#070B19]/75 py-14">
          <div className="max-w-7xl mx-auto px-4 sm:px-8">
            <h2 className="font-display text-2xl sm:text-3xl font-bold text-white">Cara Kerja XP PLAY</h2>
            <p className="mt-2 text-sm text-slate-300 max-w-2xl">
              XP Progress dan XP Reward dipisahkan agar Anda tetap bisa menukar hadiah tanpa menurunkan level keanggotaan Anda.
            </p>
            <div className="mt-8 grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
              <div className="rounded-2xl border border-indigo-500/20 bg-[#0B1124] p-5 space-y-2.5">
                <div className="w-9 h-9 rounded-xl bg-sky-500/15 border border-sky-400/30 flex items-center justify-center">
                  <Zap className="w-4 h-4 text-sky-300" />
                </div>
                <h3 className="font-display font-bold text-white">1. Kumpulkan XP</h3>
                <p className="text-sm text-slate-300 leading-relaxed">
                  Dapatkan +10 XP saat daftar, +5 XP via referral username, serta 1 XP setiap transaksi Rp2.000.
                </p>
              </div>
              <div className="rounded-2xl border border-indigo-500/20 bg-[#0B1124] p-5 space-y-2.5">
                <div className="w-9 h-9 rounded-xl bg-blue-500/15 border border-blue-400/30 flex items-center justify-center">
                  <Trophy className="w-4 h-4 text-blue-300" />
                </div>
                <h3 className="font-display font-bold text-white">2. Naik Level Otomatis</h3>
                <p className="text-sm text-slate-300 leading-relaxed">
                  XP Progress mengakumulasi perjalanan Anda dari Bronze, Silver, Juragan, hingga Sultan.
                </p>
              </div>
              <div className="rounded-2xl border border-indigo-500/20 bg-[#0B1124] p-5 space-y-2.5">
                <div className="w-9 h-9 rounded-xl bg-purple-500/15 border border-purple-400/30 flex items-center justify-center">
                  <Gift className="w-4 h-4 text-purple-300" />
                </div>
                <h3 className="font-display font-bold text-white">3. Claim &amp; Redeem</h3>
                <p className="text-sm text-slate-300 leading-relaxed">
                  Ikuti Challenge, Event, dan Promo. Tukarkan XP Reward dan nikmati Level Benefit eksklusif.
                </p>
              </div>
              <div className="rounded-2xl border border-indigo-500/20 bg-[#0B1124] p-5 space-y-2.5">
                <div className="w-9 h-9 rounded-xl bg-indigo-500/15 border border-indigo-400/30 flex items-center justify-center">
                  <Shield className="w-4 h-4 text-indigo-300" />
                </div>
                <h3 className="font-display font-bold text-white">4. Riwayat Transparan</h3>
                <p className="text-sm text-slate-300 leading-relaxed">
                  Semua penambahan XP, penukaran, dan status persetujuan admin tercatat rapi dalam ledger.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Levels */}
        <section id="level" className="max-w-7xl mx-auto px-4 sm:px-8 py-14">
          <h2 className="font-display text-2xl sm:text-3xl font-bold text-white">Tingkatan Level Member</h2>
          <p className="mt-2 text-sm text-slate-300">
            Setiap kenaikan threshold XP Progress membuka benefit eksklusif baru di seluruh cabang.
          </p>
          <div className="mt-6 grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {displayLevels.map((lvl, idx) => {
              const next = displayLevels[idx + 1];
              const rangeLabel = next ? `${lvl.minXp} – ${next.minXp - 1} XP` : `${lvl.minXp}+ XP`;
              const accent = tierAccents[lvl.id] || tierAccents.BRONZE;
              const TierIcon = accent.Icon;
              return (
                <div
                  key={lvl.id}
                  className={`rounded-2xl border ${accent.border} bg-[#0B1124] p-5 space-y-3`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <TierIcon className={`w-5 h-5 ${accent.text}`} />
                      <h3 className={`font-display text-lg font-bold ${accent.text}`}>{lvl.name}</h3>
                    </div>
                    <span className="font-mono text-xs font-semibold text-slate-300 tabular-nums">{rangeLabel}</span>
                  </div>
                  <p className="text-sm text-slate-300 leading-relaxed">{lvl.description}</p>
                </div>
              );
            })}
          </div>
        </section>

        {/* Branches */}
        <section id="cabang" className="border-t border-indigo-500/20 bg-[#070B19]/75 py-14">
          <div className="max-w-7xl mx-auto px-4 sm:px-8">
            <h2 className="font-display text-2xl sm:text-3xl font-bold text-white">Cabang Resmi XP PLAY</h2>
            <div className="mt-6 grid md:grid-cols-2 gap-6">
              {displayBranches.map((branch) => (
                <div
                  key={branch.id}
                  className="rounded-2xl border border-indigo-500/20 bg-[#0B1124] p-6 flex flex-col justify-between gap-5"
                >
                  <div>
                    <p className="text-xs font-medium text-sky-300">{branch.subtitle}</p>
                    <h3 className="mt-1 font-display text-xl font-bold text-white">{branch.name}</h3>
                    <p className="mt-2 text-sm text-slate-300">
                      WhatsApp Resmi:{' '}
                      <span className="font-mono font-semibold text-white">{branch.whatsapp}</span>
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <a
                      href={branch.mapsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center gap-2 min-h-[44px] rounded-xl border border-indigo-400/35 bg-[#070B19] px-4 py-2 text-xs font-semibold text-slate-100 hover:border-sky-400 transition-colors"
                    >
                      <MapPin className="w-4 h-4 text-sky-400" />
                      <span>Lihat Lokasi Maps</span>
                    </a>
                    <a
                      href={`https://wa.me/${branch.whatsapp.replace(/^0/, '62')}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center gap-2 min-h-[44px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-4 py-2 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500 transition-all"
                    >
                      <MessageCircle className="w-4 h-4" />
                      <span>Hubungi WhatsApp</span>
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-indigo-500/20 bg-[#050814] py-6">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-400">
          <span>© 2026 XP PLAY Member System — Demang &amp; Sekip</span>
          <div className="flex items-center gap-5">
            <Link to="/login" className="hover:text-sky-300 transition-colors py-1">
              Login Member
            </Link>
            <Link to="/register" className="hover:text-sky-300 transition-colors py-1">
              Daftar Member
            </Link>
            <Link to="/admin/login" className="hover:text-purple-300 transition-colors py-1">
              Portal Admin
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
