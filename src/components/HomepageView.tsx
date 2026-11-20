import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  ChevronDown,
  Clock,
  Crown,
  Gift,
  HelpCircle,
  MapPin,
  Megaphone,
  MessageCircle,
  Shield,
  Sparkles,
  Trophy,
  Zap,
} from 'lucide-react';
import { MemberXpShowcase } from './MemberXpShowcase.tsx';
import { sanitizeCmsImageUrl, sanitizeCmsUrl, sanitizeHomepageCmsContent } from '../shared/cmsSanitizer.ts';
import { getDashboardRouteForRole, isCashierRole } from '../shared/rbac.ts';
import type {
  AdminUser,
  BranchInfo,
  HomepageCmsContent,
  LevelConfig,
  MemberProfile,
  SystemSettings,
} from '../types/xpplay.ts';

interface HomepageViewProps {
  cmsContent: HomepageCmsContent;
  levels: LevelConfig[];
  branches: BranchInfo[];
  systemSettings: SystemSettings;
  memberProfile: MemberProfile | null;
  adminProfile: AdminUser | null;
  hasUserSession: boolean;
  isPreviewMode?: boolean;
  previewLabel?: string;
}

function CmsLink({
  url,
  className,
  children,
}: {
  url: string;
  className: string;
  children: React.ReactNode;
}) {
  const safeUrl = sanitizeCmsUrl(url, '/register') || '/register';
  if (safeUrl.startsWith('/')) {
    return (
      <Link to={safeUrl} className={className}>
        {children}
      </Link>
    );
  }
  if (safeUrl.startsWith('#')) {
    return (
      <a href={safeUrl} className={className}>
        {children}
      </a>
    );
  }
  return (
    <a href={safeUrl} target="_blank" rel="noreferrer noopener" className={className}>
      {children}
    </a>
  );
}

function CmsImageFrame({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className: string;
}) {
  const [failed, setFailed] = useState(false);
  const safeSrc = sanitizeCmsImageUrl(src, '');
  if (!safeSrc || failed) return null;
  return (
    <img
      src={safeSrc}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}

export function HomepageView({
  cmsContent,
  levels,
  branches,
  systemSettings,
  memberProfile,
  adminProfile,
  hasUserSession,
  isPreviewMode = false,
  previewLabel,
}: HomepageViewProps) {
  const cms = sanitizeHomepageCmsContent(cmsContent);
  const [openFaqId, setOpenFaqId] = useState<string | null>(cms.faqItems[0]?.id ?? null);

  const staffTarget = adminProfile
    ? {
        to: getDashboardRouteForRole(adminProfile.role),
        label: isCashierRole(adminProfile.role)
          ? 'Dashboard Kasir'
          : adminProfile.role === 'SUPER_ADMIN'
            ? 'Superadmin Console'
            : 'Dashboard Admin',
      }
    : null;

  const primaryRouteFallback = staffTarget
    ? staffTarget
    : memberProfile && memberProfile.status === 'ACTIVE'
      ? { to: '/member', label: 'Dashboard Member' }
      : { to: cms.ctaPrimaryUrl || '/register', label: cms.ctaPrimaryText || 'Lengkapi Pendaftaran' };

  const headerCtaTarget = staffTarget
    ? staffTarget
    : memberProfile && memberProfile.status === 'ACTIVE'
      ? { to: '/member', label: 'Dashboard Member' }
      : { to: cms.ctaPrimaryUrl || '/register', label: cms.headerCtaText || 'Lengkapi Pendaftaran' };

  const tierAccents: Record<string, { border: string; text: string; Icon: typeof Shield }> = {
    BRONZE: { border: 'border-sky-500/25', text: 'text-sky-300', Icon: Shield },
    SILVER: { border: 'border-cyan-400/30', text: 'text-cyan-300', Icon: Zap },
    JURAGAN: { border: 'border-indigo-400/35', text: 'text-indigo-300', Icon: Trophy },
    SULTAN: { border: 'border-purple-400/45', text: 'text-purple-300', Icon: Crown },
  };

  const whatsappNormalized = cms.whatsapp.replace(/[^0-9]/g, '').replace(/^0/, '62');
  const socialLinks = [
    { label: 'Instagram', url: sanitizeCmsUrl(cms.instagramUrl, '') },
    { label: 'TikTok', url: sanitizeCmsUrl(cms.tiktokUrl, '') },
    { label: 'Facebook', url: sanitizeCmsUrl(cms.facebookUrl, '') },
    { label: 'YouTube', url: sanitizeCmsUrl(cms.youtubeUrl, '') },
  ].filter((item) => item.url.length > 0);

  return (
    <div className="min-h-screen gaming-canvas text-slate-100 flex flex-col overflow-x-hidden">
      {isPreviewMode && (
        <div className="bg-amber-500/15 border-b border-amber-400/35 px-4 py-2 text-center text-xs font-semibold text-amber-200">
          {previewLabel || 'Mode Preview CMS — Perubahan belum dipublikasikan ke pengunjung.'}
        </div>
      )}

      {cms.announcementEnabled && cms.announcementText && (
        <div className="bg-gradient-to-r from-blue-950/90 via-indigo-950/90 to-purple-950/90 border-b border-indigo-500/25 px-4 py-2">
          <div className="max-w-7xl mx-auto flex items-center justify-center gap-2 text-xs font-medium text-sky-200 text-center">
            <Megaphone className="w-3.5 h-3.5 text-sky-300 shrink-0" />
            <span>{cms.announcementText}</span>
          </div>
        </div>
      )}

      {/* Top Bar: 3-zone contract */}
      <header className="sticky top-0 z-30 bg-[#050814]/90 backdrop-blur-md border-b border-indigo-500/20">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 h-14 sm:h-16 flex items-center justify-between gap-8">
          <Link
            to="/"
            className="inline-flex items-center gap-2.5 font-display text-lg font-extrabold tracking-tight bg-gradient-to-r from-sky-300 via-blue-300 to-purple-300 bg-clip-text text-transparent whitespace-nowrap shrink-0"
          >
            <CmsImageFrame
              src={cms.logoUrl}
              alt={cms.brandName}
              className="w-7 h-7 rounded-lg object-cover border border-indigo-400/30"
            />
            <span>{cms.brandName}</span>
          </Link>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-300">
            <a href="#sistem-xp" className="hover:text-sky-300 transition-colors whitespace-nowrap shrink-0">
              Sistem XP
            </a>
            <a href="#tentang" className="hover:text-sky-300 transition-colors whitespace-nowrap shrink-0">
              Tentang
            </a>
            <a href="#level" className="hover:text-sky-300 transition-colors whitespace-nowrap shrink-0">
              Level
            </a>
            <a href="#cabang" className="hover:text-sky-300 transition-colors whitespace-nowrap shrink-0">
              Cabang &amp; Kontak
            </a>
            <Link to="/login" className="hover:text-sky-300 transition-colors whitespace-nowrap shrink-0">
              Masuk Member
            </Link>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <CmsLink
              url={headerCtaTarget.to}
              className="inline-flex items-center gap-2 min-h-[40px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-4 py-2 text-xs sm:text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 shadow-[0_0_20px_-4px_rgba(99,102,241,0.6)] transition-all whitespace-nowrap shrink-0"
            >
              <span>{headerCtaTarget.label}</span>
              <ArrowRight className="w-4 h-4" />
            </CmsLink>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero Section */}
        <section className="max-w-7xl mx-auto px-4 sm:px-8 pt-10 pb-8 lg:pt-14 lg:pb-12 space-y-10">
          <div className={cms.heroImageUrl ? 'grid lg:grid-cols-12 gap-8 items-center' : 'max-w-3xl'}>
            <div className={`${cms.heroImageUrl ? 'lg:col-span-7' : ''} space-y-5`}>
              {cms.headerTagline && (
                <p className="text-xs font-medium text-sky-300 tracking-wide">
                  {cms.headerTagline}
                </p>
              )}
              {cms.heroSubtitle && (
                <p className="text-sm font-semibold text-purple-300">
                  {cms.heroSubtitle}
                </p>
              )}
              <h1 className="font-display text-3xl sm:text-5xl font-extrabold tracking-tight text-white text-balance leading-[1.12]">
                {cms.heroTitle}
              </h1>
              <p className="text-base sm:text-lg text-slate-300 max-w-2xl leading-relaxed whitespace-pre-line">
                {cms.heroDescription}
              </p>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <CmsLink
                  url={primaryRouteFallback.to}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-6 py-3 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 shadow-[0_0_26px_-6px_rgba(99,102,241,0.65)] transition-all min-h-[46px]"
                >
                  <span>{primaryRouteFallback.label}</span>
                  <ArrowRight className="w-4 h-4" />
                </CmsLink>
                {!hasUserSession && cms.ctaSecondaryText && (
                  <CmsLink
                    url={cms.ctaSecondaryUrl || '/login'}
                    className="inline-flex items-center justify-center rounded-xl border border-indigo-400/35 bg-[#0B1124] px-6 py-3 text-sm font-semibold text-slate-100 hover:border-sky-400/60 hover:bg-[#101836] transition-colors min-h-[46px]"
                  >
                    {cms.ctaSecondaryText}
                  </CmsLink>
                )}
              </div>
              <div className="pt-4 border-t border-indigo-500/20 flex flex-wrap gap-x-6 gap-y-2 text-xs text-slate-300">
                <span>
                  Bonus Daftar:{' '}
                  <strong className="text-sky-300 font-mono tabular-nums">
                    +{systemSettings.registrationBonusXp} XP
                  </strong>
                </span>
                <span>
                  Bonus Referral:{' '}
                  <strong className="text-purple-300 font-mono tabular-nums">
                    +{systemSettings.referralBonusXp} XP
                  </strong>
                </span>
                <span>
                  Rate Transaksi:{' '}
                  <strong className="text-white font-mono tabular-nums">
                    Rp{systemSettings.transactionXpRate.toLocaleString('id-ID')} = 1 XP
                  </strong>
                </span>
              </div>
            </div>

            {cms.heroImageUrl && (
              <div className="lg:col-span-5">
                <div className="rounded-2xl border border-indigo-500/25 bg-[#0B1124] overflow-hidden shadow-[0_0_32px_-8px_rgba(59,130,246,0.4)]">
                  <CmsImageFrame
                    src={cms.heroImageUrl}
                    alt={cms.heroTitle}
                    className="w-full h-64 sm:h-80 object-cover"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Optional CMS Highlight Banner */}
          {cms.bannerEnabled && (cms.bannerTitle || cms.bannerText || cms.bannerImageUrl) && (
            <div className="rounded-2xl border border-sky-500/30 bg-[#0B1124] overflow-hidden grid md:grid-cols-12 items-center">
              <div className={`${cms.bannerImageUrl ? 'md:col-span-7' : 'md:col-span-12'} p-6 space-y-2`}>
                <p className="text-xs font-semibold text-sky-300">{cms.storeName}</p>
                {cms.bannerTitle && (
                  <h2 className="font-display text-xl sm:text-2xl font-bold text-white">{cms.bannerTitle}</h2>
                )}
                {cms.bannerText && (
                  <p className="text-sm text-slate-300 whitespace-pre-line leading-relaxed">{cms.bannerText}</p>
                )}
              </div>
              {cms.bannerImageUrl && (
                <div className="md:col-span-5 h-48 md:h-full">
                  <CmsImageFrame
                    src={cms.bannerImageUrl}
                    alt={cms.bannerTitle || 'Banner XP PLAY'}
                    className="w-full h-full object-cover"
                  />
                </div>
              )}
            </div>
          )}

          {/* Optional CMS Promo Banner */}
          {cms.promoBannerEnabled && (cms.promoBannerTitle || cms.promoBannerText) && (
            <div className="rounded-2xl border border-purple-500/35 bg-gradient-to-r from-[#0E1733] via-[#13183A] to-[#1D123B] p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="space-y-1.5">
                <div className="inline-flex items-center gap-2 text-xs font-semibold text-purple-300">
                  <Sparkles className="w-4 h-4" />
                  <span>Promo Aktif</span>
                </div>
                {cms.promoBannerTitle && (
                  <h2 className="font-display text-lg sm:text-xl font-bold text-white">{cms.promoBannerTitle}</h2>
                )}
                {cms.promoBannerText && (
                  <p className="text-sm text-slate-300 whitespace-pre-line">{cms.promoBannerText}</p>
                )}
              </div>
              {cms.promoBannerCtaText && (
                <CmsLink
                  url={cms.promoBannerCtaUrl || '/register'}
                  className="inline-flex items-center gap-2 min-h-[44px] rounded-xl bg-gradient-to-r from-purple-600 to-blue-600 px-5 py-2.5 text-xs sm:text-sm font-semibold text-white hover:from-purple-500 hover:to-blue-500 whitespace-nowrap shrink-0"
                >
                  <span>{cms.promoBannerCtaText}</span>
                  <ArrowRight className="w-4 h-4" />
                </CmsLink>
              )}
            </div>
          )}

          {/* Interactive Member Card Preview */}
          <div id="kartu-member">
            <MemberXpShowcase
              memberId={memberProfile?.memberId || 'XPP-PREVIEW'}
              fullName={memberProfile?.fullName || 'Andi Pratama'}
              username={memberProfile?.username || 'andi_play'}
              cycleId={systemSettings.currentCycleId}
              xpProgress={memberProfile?.xpProgress ?? 450}
              xpReward={memberProfile?.xpReward ?? 250}
              levels={levels}
              previewMode
            />
          </div>
        </section>

        {/* System Mechanics */}
        <section id="sistem-xp" className="border-t border-indigo-500/20 bg-[#070B19]/75 py-14">
          <div className="max-w-7xl mx-auto px-4 sm:px-8">
            <h2 className="font-display text-2xl sm:text-3xl font-bold text-white">{cms.mechanicsTitle}</h2>
            <p className="mt-2 text-sm text-slate-300 max-w-2xl whitespace-pre-line">
              {cms.mechanicsSubtitle}
            </p>
            <div className="mt-8 grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
              <div className="rounded-2xl border border-indigo-500/20 bg-[#0B1124] p-5 space-y-2.5">
                <div className="w-9 h-9 rounded-xl bg-sky-500/15 border border-sky-400/30 flex items-center justify-center">
                  <Zap className="w-4 h-4 text-sky-300" />
                </div>
                <h3 className="font-display font-bold text-white">1. Kumpulkan XP</h3>
                <p className="text-sm text-slate-300 leading-relaxed">
                  Dapatkan +{systemSettings.registrationBonusXp} XP saat daftar, +{systemSettings.referralBonusXp} XP via referral username, serta 1 XP setiap transaksi Rp{systemSettings.transactionXpRate.toLocaleString('id-ID')}.
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

        {/* About Section */}
        <section id="tentang" className="max-w-7xl mx-auto px-4 sm:px-8 py-14 border-t border-indigo-500/20">
          <div className={cms.aboutImageUrl ? 'grid lg:grid-cols-12 gap-8 items-center' : 'max-w-3xl'}>
            <div className={`${cms.aboutImageUrl ? 'lg:col-span-7' : ''} space-y-4`}>
              <p className="text-xs font-medium text-sky-300">{cms.storeName}</p>
              <h2 className="font-display text-2xl sm:text-3xl font-bold text-white">{cms.aboutTitle}</h2>
              <p className="text-sm sm:text-base text-slate-300 leading-relaxed whitespace-pre-line">
                {cms.aboutDescription}
              </p>
            </div>
            {cms.aboutImageUrl && (
              <div className="lg:col-span-5">
                <div className="rounded-2xl border border-indigo-500/25 bg-[#0B1124] overflow-hidden">
                  <CmsImageFrame
                    src={cms.aboutImageUrl}
                    alt={cms.aboutTitle}
                    className="w-full h-64 object-cover"
                  />
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Levels */}
        <section id="level" className="max-w-7xl mx-auto px-4 sm:px-8 py-14 border-t border-indigo-500/20">
          <h2 className="font-display text-2xl sm:text-3xl font-bold text-white">{cms.levelsSectionTitle}</h2>
          <p className="mt-2 text-sm text-slate-300 whitespace-pre-line">
            {cms.levelsSectionSubtitle}
          </p>
          <div className="mt-6 grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {levels.map((lvl, idx) => {
              const next = levels[idx + 1];
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

        {/* FAQ Section */}
        {cms.faqEnabled && cms.faqItems.length > 0 && (
          <section id="faq" className="border-t border-indigo-500/20 bg-[#070B19]/75 py-14">
            <div className="max-w-4xl mx-auto px-4 sm:px-8">
              <div className="flex items-center gap-2.5 mb-6">
                <HelpCircle className="w-5 h-5 text-sky-400" />
                <h2 className="font-display text-2xl sm:text-3xl font-bold text-white">{cms.faqTitle}</h2>
              </div>
              <div className="space-y-3">
                {cms.faqItems.map((item) => {
                  const isOpen = openFaqId === item.id;
                  return (
                    <div
                      key={item.id}
                      className="rounded-2xl border border-indigo-500/20 bg-[#0B1124] overflow-hidden"
                    >
                      <button
                        type="button"
                        onClick={() => setOpenFaqId(isOpen ? null : item.id)}
                        className="w-full px-5 py-4 flex items-center justify-between gap-4 text-left text-sm sm:text-base font-semibold text-white hover:bg-[#101836] transition-colors"
                      >
                        <span>{item.question}</span>
                        <ChevronDown
                          className={`w-4 h-4 text-sky-300 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                        />
                      </button>
                      {isOpen && (
                        <div className="px-5 pb-4 text-sm text-slate-300 leading-relaxed whitespace-pre-line border-t border-indigo-500/15 pt-3">
                          {item.answer}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {/* Branches & Contact */}
        <section id="cabang" className="border-t border-indigo-500/20 bg-[#070B19]/75 py-14">
          <div className="max-w-7xl mx-auto px-4 sm:px-8 space-y-10">
            <div>
              <h2 className="font-display text-2xl sm:text-3xl font-bold text-white">{cms.branchesSectionTitle}</h2>
              <div className="mt-6 grid md:grid-cols-2 gap-6">
                {branches.map((branch) => (
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

            {/* Contact & Operating Hours Box */}
            <div className="rounded-2xl border border-indigo-500/25 bg-[#0B1124] p-6 sm:p-8 grid md:grid-cols-12 gap-6 items-center">
              <div className="md:col-span-7 space-y-2.5">
                <h3 className="font-display text-xl font-bold text-white">{cms.contactTitle}</h3>
                <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-line">
                  {cms.contactDescription}
                </p>
                <div className="pt-2 space-y-1.5 text-sm text-slate-200">
                  <p className="flex items-start gap-2">
                    <MapPin className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                    <span>{cms.address}</span>
                  </p>
                  <p className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-purple-300 shrink-0" />
                    <span>{cms.operatingHours}</span>
                  </p>
                </div>
                {socialLinks.length > 0 && (
                  <div className="pt-2 flex flex-wrap gap-3 text-xs">
                    {socialLinks.map((soc) => (
                      <a
                        key={soc.label}
                        href={soc.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="rounded-lg border border-indigo-500/30 bg-[#070B19] px-3 py-1.5 font-medium text-sky-300 hover:border-sky-400 transition-colors"
                      >
                        {soc.label}
                      </a>
                    ))}
                  </div>
                )}
              </div>
              <div className="md:col-span-5 flex flex-wrap md:justify-end gap-3">
                {cms.mapsUrl && (
                  <a
                    href={sanitizeCmsUrl(cms.mapsUrl, '#cabang')}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center justify-center gap-2 min-h-[44px] rounded-xl border border-indigo-400/35 bg-[#070B19] px-4 py-2 text-xs font-semibold text-slate-100 hover:border-sky-400 transition-colors"
                  >
                    <MapPin className="w-4 h-4 text-sky-400" />
                    <span>Buka Google Maps</span>
                  </a>
                )}
                {whatsappNormalized && (
                  <a
                    href={`https://wa.me/${whatsappNormalized}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center justify-center gap-2 min-h-[44px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-5 py-2 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500 transition-all"
                  >
                    <MessageCircle className="w-4 h-4" />
                    <span>Chat Admin ({cms.whatsapp})</span>
                  </a>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-indigo-500/20 bg-[#050814] py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-400">
          <div className="space-y-1 text-center sm:text-left">
            <p className="font-semibold text-slate-200">{cms.footerCopyright}</p>
            <p>{cms.footerText}</p>
          </div>
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
