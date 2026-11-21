import type { CmsFaqItem, HomepageCmsContent } from '../types/xpplay.ts';

export const DEFAULT_HOMEPAGE_CMS: HomepageCmsContent = {
  brandName: 'XP PLAY',
  storeName: 'XP PLAY Member System — Demang & Sekip',
  logoUrl: '',
  faviconUrl: '',
  headerTagline: 'XP PLAY Demang · XP PLAY Sekip · Palembang',
  headerCtaText: 'Daftar Member',
  heroTitle: 'Main lebih seru, naikkan XP Progress, dan tukarkan XP Reward.',
  heroSubtitle: 'Program Membership Resmi XP PLAY Demang & Sekip',
  heroDescription:
    'Program membership resmi XP PLAY Game Center Demang dan XP PLAY Game Platinum Sekip. Setiap transaksi, referral, challenge, dan event tercatat transparan ke dalam kartu member Anda.',
  heroImageUrl: '',
  bannerEnabled: false,
  bannerTitle: 'Turnamen & Bonus XP Spesial Akhir Pekan',
  bannerText:
    'Kunjungi cabang Demang & Sekip akhir pekan ini untuk bonus XP transaksi dan challenge komunitas.',
  bannerImageUrl: '',
  ctaPrimaryText: 'Daftar Member (+10 XP)',
  ctaPrimaryUrl: '/register',
  ctaSecondaryText: 'Login Member',
  ctaSecondaryUrl: '/login',
  promoBannerEnabled: false,
  promoBannerTitle: 'Promo Member Baru XP PLAY',
  promoBannerText: 'Daftar sekarang dan langsung dapatkan +10 XP awal serta +5 XP referral.',
  promoBannerCtaText: 'Klaim Sekarang',
  promoBannerCtaUrl: '/register',
  announcementEnabled: false,
  announcementText: 'Jam operasional XP PLAY Demang & Sekip buka setiap hari pukul 10.00 – 23.00 WIB.',
  aboutTitle: 'Tentang XP PLAY Member System',
  aboutDescription:
    'XP PLAY menghadirkan sistem loyalitas gaming transparan untuk seluruh pengunjung di Palembang. Kumpulkan XP Progress untuk menaikkan level permanen sepanjang season dan gunakan XP Reward untuk menukar berbagai benefit eksklusif.',
  aboutImageUrl: '',
  mechanicsTitle: 'Cara Kerja XP PLAY',
  mechanicsSubtitle:
    'XP Progress dan XP Reward dipisahkan agar Anda tetap bisa menukar hadiah tanpa menurunkan level keanggotaan Anda.',
  levelsSectionTitle: 'Tingkatan Level Member',
  levelsSectionSubtitle:
    'Setiap kenaikan threshold XP Progress membuka benefit eksklusif baru di seluruh cabang.',
  branchesSectionTitle: 'Cabang Resmi XP PLAY',
  faqEnabled: true,
  faqTitle: 'Pertanyaan yang Sering Diajukan',
  faqItems: [
    {
      id: 'faq_1',
      question: 'Apa perbedaan XP Progress dan XP Reward?',
      answer:
        'XP Progress menentukan kenaikan level membership Anda (Bronze, Silver, Juragan, Sultan), sedangkan XP Reward adalah saldo poin yang bisa Anda tukarkan dengan hadiah atau benefit.',
    },
    {
      id: 'faq_2',
      question: 'Apakah menukar hadiah menurunkan level member saya?',
      answer:
        'Tidak. Menukar benefit hanya memotong XP Reward, sementara XP Progress dan Level Anda tetap aman.',
    },
    {
      id: 'faq_3',
      question: 'Bagaimana cara mendapatkan XP tambahan?',
      answer:
        'Selain bonus pendaftaran (+10 XP) dan referral (+5 XP), Anda mendapatkan +1 XP setiap transaksi Rp2.000 di kasir cabang Demang atau Sekip serta dari XP Challenge dan Event. XP Reward dapat ditukarkan untuk klaim Benefit dan Promo spesial.',
    },
  ],
  contactTitle: 'Hubungi & Kunjungi XP PLAY',
  contactDescription:
    'Butuh bantuan pendaftaran member, pengecekan transaksi, atau informasi ketersediaan konsol? Hubungi admin cabang kami.',
  address: 'Jl. Demang Lebar Daun & Jl. Sekip Jaya, Palembang, Sumatera Selatan',
  whatsapp: '08983761001',
  mapsUrl: 'https://maps.app.goo.gl/tY9v9hXJx234s2H17',
  operatingHours: 'Setiap Hari · 10.00 – 23.00 WIB',
  instagramUrl: '',
  tiktokUrl: '',
  facebookUrl: '',
  youtubeUrl: '',
  footerText: 'Program membership game center terintegrasi untuk XP PLAY Demang & XP PLAY Sekip.',
  footerCopyright: '© 2026 XP PLAY Member System — Demang & Sekip',
};

const UNSAFE_MARKUP_PATTERNS: RegExp[] = [
  /<\s*script\b/i,
  /<\/\s*script\s*>/i,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:\s*text\/html/i,
  /data\s*:\s*image\/svg\+xml/i,
  /<\s*iframe\b/i,
  /<\s*object\b/i,
  /<\s*embed\b/i,
  /<\s*svg\b/i,
  /\bon[a-z]+\s*=/i,
  /<\s*img[^>]*on\w+/i,
];

export function containsUnsafeMarkup(value: string): boolean {
  return UNSAFE_MARKUP_PATTERNS.some((re) => re.test(value));
}

export function sanitizeCmsText(raw: unknown, maxLength = 500, allowNewlines = false): string {
  if (typeof raw !== 'string') return '';
  let cleaned = raw
    .replace(/<\s*script[\s\S]*?>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*style[\s\S]*?>[\s\S]*?<\s*\/\s*style\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

  if (allowNewlines) {
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  } else {
    cleaned = cleaned.replace(/\s+/g, ' ');
  }

  return cleaned.trim().slice(0, maxLength);
}

export function isSafeCmsUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return true;
  if (containsUnsafeMarkup(trimmed)) return false;
  if (trimmed.startsWith('//')) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) {
    return !/[\s<>"'`]/.test(trimmed);
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function isSafeCmsImageUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return true;
  if (containsUnsafeMarkup(trimmed)) return false;
  if (trimmed.startsWith('//')) return false;
  if (trimmed.startsWith('/assets/') || trimmed.startsWith('/api/cms/assets/')) {
    return !/[\s<>"'`]/.test(trimmed);
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function sanitizeCmsUrl(raw: unknown, fallback = ''): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim().slice(0, 500);
  return isSafeCmsUrl(trimmed) ? trimmed : fallback;
}

export function sanitizeCmsImageUrl(raw: unknown, fallback = ''): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim().slice(0, 500);
  return isSafeCmsImageUrl(trimmed) ? trimmed : fallback;
}

export function validateCmsSecurity(content: HomepageCmsContent): { valid: boolean; error?: string } {
  const stringEntries: [string, string][] = [
    ['brandName', content.brandName],
    ['storeName', content.storeName],
    ['headerTagline', content.headerTagline],
    ['headerCtaText', content.headerCtaText],
    ['heroTitle', content.heroTitle],
    ['heroSubtitle', content.heroSubtitle],
    ['heroDescription', content.heroDescription],
    ['bannerTitle', content.bannerTitle],
    ['bannerText', content.bannerText],
    ['ctaPrimaryText', content.ctaPrimaryText],
    ['ctaSecondaryText', content.ctaSecondaryText],
    ['promoBannerTitle', content.promoBannerTitle],
    ['promoBannerText', content.promoBannerText],
    ['promoBannerCtaText', content.promoBannerCtaText],
    ['announcementText', content.announcementText],
    ['aboutTitle', content.aboutTitle],
    ['aboutDescription', content.aboutDescription],
    ['mechanicsTitle', content.mechanicsTitle],
    ['mechanicsSubtitle', content.mechanicsSubtitle],
    ['levelsSectionTitle', content.levelsSectionTitle],
    ['levelsSectionSubtitle', content.levelsSectionSubtitle],
    ['branchesSectionTitle', content.branchesSectionTitle],
    ['faqTitle', content.faqTitle],
    ['contactTitle', content.contactTitle],
    ['contactDescription', content.contactDescription],
    ['address', content.address],
    ['whatsapp', content.whatsapp],
    ['operatingHours', content.operatingHours],
    ['footerText', content.footerText],
    ['footerCopyright', content.footerCopyright],
  ];

  for (const [field, val] of stringEntries) {
    if (typeof val !== 'string') {
      return { valid: false, error: `Field ${field} harus berupa teks.` };
    }
    if (containsUnsafeMarkup(val) || /<[^>]+>/.test(val)) {
      return {
        valid: false,
        error: `Input HTML/JavaScript tidak diizinkan pada field ${field} demi keamanan XSS.`,
      };
    }
  }

  if (!content.brandName.trim() || !content.heroTitle.trim()) {
    return { valid: false, error: 'Nama Brand dan Hero Title wajib diisi.' };
  }

  const navUrls: [string, string][] = [
    ['ctaPrimaryUrl', content.ctaPrimaryUrl],
    ['ctaSecondaryUrl', content.ctaSecondaryUrl],
    ['promoBannerCtaUrl', content.promoBannerCtaUrl],
    ['mapsUrl', content.mapsUrl],
    ['instagramUrl', content.instagramUrl],
    ['tiktokUrl', content.tiktokUrl],
    ['facebookUrl', content.facebookUrl],
    ['youtubeUrl', content.youtubeUrl],
  ];
  for (const [field, u] of navUrls) {
    if (!isSafeCmsUrl(u)) {
      return {
        valid: false,
        error: `URL tidak valid atau tidak aman pada ${field}. Gunakan https://, /path, atau #anchor.`,
      };
    }
  }

  const imgUrls: [string, string][] = [
    ['logoUrl', content.logoUrl],
    ['faviconUrl', content.faviconUrl],
    ['heroImageUrl', content.heroImageUrl],
    ['bannerImageUrl', content.bannerImageUrl],
    ['aboutImageUrl', content.aboutImageUrl],
  ];
  for (const [field, u] of imgUrls) {
    if (!isSafeCmsImageUrl(u)) {
      return {
        valid: false,
        error: `Image URL tidak valid atau tidak aman pada ${field}. Gunakan upload CMS atau URL https://.`,
      };
    }
  }

  if (!Array.isArray(content.faqItems) || content.faqItems.length > 15) {
    return { valid: false, error: 'FAQ maksimal 15 item.' };
  }
  for (const faq of content.faqItems) {
    if (
      containsUnsafeMarkup(faq.question) ||
      containsUnsafeMarkup(faq.answer) ||
      /<[^>]+>/.test(faq.question) ||
      /<[^>]+>/.test(faq.answer)
    ) {
      return { valid: false, error: 'HTML/JavaScript tidak diizinkan di dalam FAQ.' };
    }
  }

  return { valid: true };
}

export function sanitizeHomepageCmsContent(raw?: Partial<HomepageCmsContent> | null): HomepageCmsContent {
  const src = raw || {};
  const d = DEFAULT_HOMEPAGE_CMS;

  const rawFaq = Array.isArray(src.faqItems) ? src.faqItems : d.faqItems;
  const faqItems: CmsFaqItem[] = rawFaq
    .slice(0, 15)
    .map((item, idx) => ({
      id: sanitizeCmsText(item?.id || `faq_${idx + 1}`, 40) || `faq_${idx + 1}`,
      question: sanitizeCmsText(item?.question ?? '', 200),
      answer: sanitizeCmsText(item?.answer ?? '', 600, true),
    }))
    .filter((f) => f.question.length > 0 && f.answer.length > 0);

  return {
    brandName: sanitizeCmsText(src.brandName, 60) || d.brandName,
    storeName: sanitizeCmsText(src.storeName, 120) || d.storeName,
    logoUrl: sanitizeCmsImageUrl(src.logoUrl, d.logoUrl),
    faviconUrl: sanitizeCmsImageUrl(src.faviconUrl, d.faviconUrl),
    headerTagline: sanitizeCmsText(src.headerTagline, 120) || d.headerTagline,
    headerCtaText: sanitizeCmsText(src.headerCtaText, 40) || d.headerCtaText,
    heroTitle: sanitizeCmsText(src.heroTitle, 180) || d.heroTitle,
    heroSubtitle: sanitizeCmsText(src.heroSubtitle, 180) || d.heroSubtitle,
    heroDescription: sanitizeCmsText(src.heroDescription, 600, true) || d.heroDescription,
    heroImageUrl: sanitizeCmsImageUrl(src.heroImageUrl, d.heroImageUrl),
    bannerEnabled: Boolean(src.bannerEnabled ?? d.bannerEnabled),
    bannerTitle: sanitizeCmsText(src.bannerTitle, 160),
    bannerText: sanitizeCmsText(src.bannerText, 400, true),
    bannerImageUrl: sanitizeCmsImageUrl(src.bannerImageUrl, d.bannerImageUrl),
    ctaPrimaryText: sanitizeCmsText(src.ctaPrimaryText, 60) || d.ctaPrimaryText,
    ctaPrimaryUrl: sanitizeCmsUrl(src.ctaPrimaryUrl, d.ctaPrimaryUrl) || d.ctaPrimaryUrl,
    ctaSecondaryText: sanitizeCmsText(src.ctaSecondaryText, 60) || d.ctaSecondaryText,
    ctaSecondaryUrl: sanitizeCmsUrl(src.ctaSecondaryUrl, d.ctaSecondaryUrl) || d.ctaSecondaryUrl,
    promoBannerEnabled: Boolean(src.promoBannerEnabled ?? d.promoBannerEnabled),
    promoBannerTitle: sanitizeCmsText(src.promoBannerTitle, 160),
    promoBannerText: sanitizeCmsText(src.promoBannerText, 400, true),
    promoBannerCtaText: sanitizeCmsText(src.promoBannerCtaText, 60),
    promoBannerCtaUrl: sanitizeCmsUrl(src.promoBannerCtaUrl, d.promoBannerCtaUrl),
    announcementEnabled: Boolean(src.announcementEnabled ?? d.announcementEnabled),
    announcementText: sanitizeCmsText(src.announcementText, 240),
    aboutTitle: sanitizeCmsText(src.aboutTitle, 140) || d.aboutTitle,
    aboutDescription: sanitizeCmsText(src.aboutDescription, 1000, true) || d.aboutDescription,
    aboutImageUrl: sanitizeCmsImageUrl(src.aboutImageUrl, d.aboutImageUrl),
    mechanicsTitle: sanitizeCmsText(src.mechanicsTitle, 120) || d.mechanicsTitle,
    mechanicsSubtitle: sanitizeCmsText(src.mechanicsSubtitle, 300, true) || d.mechanicsSubtitle,
    levelsSectionTitle: sanitizeCmsText(src.levelsSectionTitle, 120) || d.levelsSectionTitle,
    levelsSectionSubtitle: sanitizeCmsText(src.levelsSectionSubtitle, 300, true) || d.levelsSectionSubtitle,
    branchesSectionTitle: sanitizeCmsText(src.branchesSectionTitle, 120) || d.branchesSectionTitle,
    faqEnabled: Boolean(src.faqEnabled ?? d.faqEnabled),
    faqTitle: sanitizeCmsText(src.faqTitle, 120) || d.faqTitle,
    faqItems,
    contactTitle: sanitizeCmsText(src.contactTitle, 120) || d.contactTitle,
    contactDescription: sanitizeCmsText(src.contactDescription, 400, true) || d.contactDescription,
    address: sanitizeCmsText(src.address, 260) || d.address,
    whatsapp: sanitizeCmsText(src.whatsapp, 30) || d.whatsapp,
    mapsUrl: sanitizeCmsUrl(src.mapsUrl, d.mapsUrl) || d.mapsUrl,
    operatingHours: sanitizeCmsText(src.operatingHours, 120) || d.operatingHours,
    instagramUrl: sanitizeCmsUrl(src.instagramUrl, ''),
    tiktokUrl: sanitizeCmsUrl(src.tiktokUrl, ''),
    facebookUrl: sanitizeCmsUrl(src.facebookUrl, ''),
    youtubeUrl: sanitizeCmsUrl(src.youtubeUrl, ''),
    footerText: sanitizeCmsText(src.footerText, 300) || d.footerText,
    footerCopyright: sanitizeCmsText(src.footerCopyright, 160) || d.footerCopyright,
  };
}
