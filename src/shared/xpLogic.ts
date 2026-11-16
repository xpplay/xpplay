import type {
  BranchId,
  BranchInfo,
  CampaignItem,
  CampaignStatus,
  LevelConfig,
  LevelId,
  SystemSettings,
} from '../types/xpplay.ts';

export const XP_TIMEZONE = 'Asia/Jakarta';

export const DEFAULT_BRANCHES: BranchInfo[] = [
  {
    id: 'DEMANG',
    name: 'XP PLAY DEMANG',
    subtitle: 'XP PLAY GAME CENTER',
    whatsapp: '08983761001',
    mapsUrl: 'https://maps.app.goo.gl/JCAvqgP2X2M9morS7',
    active: true,
  },
  {
    id: 'SEKIP',
    name: 'XP PLAY SEKIP',
    subtitle: 'XP PLAY GAME PLATINUM',
    whatsapp: '08983761001',
    mapsUrl: 'https://maps.app.goo.gl/KZGGXG7JYzJ3hQA39',
    active: true,
  },
];

export const DEFAULT_LEVELS: LevelConfig[] = [
  {
    id: 'BRONZE',
    name: 'Bronze',
    rank: 1,
    minXp: 0,
    colorHex: '#B45309',
    description: 'Level awal member XP PLAY. Kumpulkan XP Progress untuk naik ke Silver.',
  },
  {
    id: 'SILVER',
    name: 'Silver',
    rank: 2,
    minXp: 150,
    colorHex: '#64748B',
    description: 'Member aktif XP PLAY dengan akses benefit Silver.',
  },
  {
    id: 'JURAGAN',
    name: 'Juragan',
    rank: 3,
    minXp: 300,
    colorHex: '#0284C7',
    description: 'Gamer loyal XP PLAY dengan akses benefit prioritas.',
  },
  {
    id: 'SULTAN',
    name: 'Sultan',
    rank: 4,
    minXp: 600,
    colorHex: '#D97706',
    description: 'Level tertinggi XP PLAY dengan seluruh benefit eksklusif.',
  },
];

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  id: 'default',
  transactionXpRate: 2000,
  registrationBonusXp: 10,
  referralBonusXp: 5,
  currentCycleId: '2026-S1',
  resetEnabled: false,
  resetInterval: 90,
  resetUnit: 'DAYS',
  nextResetAt: null,
  resetXpProgress: true,
  resetLevel: true,
  resetXpReward: true,
  updatedAt: 0,
  updatedBy: 'system',
};

export const RESERVED_USERNAMES = new Set([
  'admin',
  'superadmin',
  'super_admin',
  'staff',
  'root',
  'system',
  'xpplay',
  'xp_play',
  'support',
  'moderator',
  'mod',
  'operator',
  'official',
  'demang',
  'sekip',
  'null',
  'undefined',
]);

/**
 * Normalize username: trim, lowercase, validate format (3-24 chars, alphanumeric & underscore/dot, not reserved).
 */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateUsername(raw: string): { valid: boolean; normalized: string; error?: string } {
  const normalized = normalizeUsername(raw);
  if (normalized.length < 3 || normalized.length > 24) {
    return {
      valid: false,
      normalized,
      error: 'Username harus terdiri dari 3 hingga 24 karakter.',
    };
  }
  if (!/^[a-z0-9][a-z0-9._]*[a-z0-9]$/.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'Username hanya boleh berisi huruf kecil, angka, titik, atau garis bawah, dan diawali/diakhiri huruf atau angka.',
    };
  }
  if (normalized.includes('..') || normalized.includes('__')) {
    return {
      valid: false,
      normalized,
      error: 'Username tidak boleh mengandung tanda titik atau garis bawah berurutan.',
    };
  }
  if (RESERVED_USERNAMES.has(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'Username tersebut tidak dapat digunakan.',
    };
  }
  return { valid: true, normalized };
}

/**
 * Normalize Indonesian WhatsApp numbers into canonical digits-only `628...` format.
 */
export function normalizeWhatsapp(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0')) {
    return `62${digits.slice(1)}`;
  }
  if (digits.startsWith('620')) {
    return `62${digits.slice(3)}`;
  }
  if (digits.startsWith('8')) {
    return `62${digits}`;
  }
  return digits;
}

export function validateWhatsapp(raw: string): { valid: boolean; normalized: string; error?: string } {
  const normalized = normalizeWhatsapp(raw);
  if (!/^628[1-9][0-9]{6,11}$/.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'Nomor WhatsApp tidak valid. Gunakan format Indonesia, contoh: 0898xxxxxxx atau 62898xxxxxxx.',
    };
  }
  return { valid: true, normalized };
}

/**
 * Validate integer IDR transaction amount and calculate XP with integer division (no floating-point errors).
 */
export function calculateTransactionXp(amountIdr: number, xpRate: number): number {
  if (!Number.isSafeInteger(amountIdr) || amountIdr <= 0) {
    throw new Error('Nominal transaksi harus berupa bilangan bulat lebih dari 0.');
  }
  if (!Number.isSafeInteger(xpRate) || xpRate <= 0) {
    throw new Error('Rate XP transaksi harus berupa bilangan bulat lebih dari 0.');
  }
  return Math.floor(amountIdr / xpRate);
}

/**
 * Validate dynamic level threshold ordering: Bronze (0) < Silver < Juragan < Sultan.
 */
export function validateLevelThresholds(levels: LevelConfig[]): { valid: boolean; error?: string } {
  const byId = new Map<LevelId, LevelConfig>();
  for (const lvl of levels) {
    if (!Number.isSafeInteger(lvl.minXp) || lvl.minXp < 0) {
      return { valid: false, error: `Threshold XP untuk ${lvl.name} harus berupa bilangan bulat >= 0.` };
    }
    byId.set(lvl.id, lvl);
  }
  const bronze = byId.get('BRONZE');
  const silver = byId.get('SILVER');
  const juragan = byId.get('JURAGAN');
  const sultan = byId.get('SULTAN');

  if (!bronze || !silver || !juragan || !sultan) {
    return { valid: false, error: 'Semua konfigurasi level (Bronze, Silver, Juragan, Sultan) wajib tersedia.' };
  }
  if (
    !(
      bronze.minXp < silver.minXp &&
      silver.minXp < juragan.minXp &&
      juragan.minXp < sultan.minXp
    )
  ) {
    return {
      valid: false,
      error: 'Urutan threshold harus memenuhi Bronze < Silver < Juragan < Sultan.',
    };
  }
  return { valid: true };
}

/**
 * Resolve current member level and progress to next level from XP Progress using DB level config.
 */
export function resolveLevelFromXp(
  xpProgress: number,
  levels: LevelConfig[] = DEFAULT_LEVELS
): {
  current: LevelConfig;
  next: LevelConfig | null;
  progressPercent: number;
  xpToNext: number;
} {
  const sorted = [...levels].sort((a, b) => a.minXp - b.minXp);
  const safeXp = Math.max(0, Math.floor(xpProgress));
  let current = sorted[0];
  let currentIndex = 0;

  for (let i = 0; i < sorted.length; i++) {
    if (safeXp >= sorted[i].minXp) {
      current = sorted[i];
      currentIndex = i;
    }
  }

  const next = currentIndex < sorted.length - 1 ? sorted[currentIndex + 1] : null;
  if (!next) {
    return {
      current,
      next: null,
      progressPercent: 100,
      xpToNext: 0,
    };
  }

  const span = Math.max(1, next.minXp - current.minXp);
  const earnedInTier = Math.max(0, safeXp - current.minXp);
  const progressPercent = Math.min(100, Math.floor((earnedInTier / span) * 100));
  const xpToNext = Math.max(0, next.minXp - safeXp);

  return {
    current,
    next,
    progressPercent,
    xpToNext,
  };
}

export function getLevelRank(levelId: LevelId, levels: LevelConfig[] = DEFAULT_LEVELS): number {
  return levels.find((l) => l.id === levelId)?.rank ?? 1;
}

export function isLevelEligible(
  memberLevel: LevelId,
  requiredLevel: LevelId,
  levels: LevelConfig[] = DEFAULT_LEVELS
): boolean {
  return getLevelRank(memberLevel, levels) >= getLevelRank(requiredLevel, levels);
}

/**
 * Compute authoritative campaign status with automatic expiration check (currentTime > endAt).
 */
export function resolveCampaignStatus(
  campaign: Pick<CampaignItem, 'status' | 'active' | 'startAt' | 'endAt'>,
  nowMs: number = Date.now()
): CampaignStatus {
  if (campaign.status === 'DRAFT') return 'DRAFT';
  if (!campaign.active || campaign.status === 'DISABLED') return 'DISABLED';
  if (nowMs > campaign.endAt) return 'EXPIRED';
  return 'ACTIVE';
}

export function isCampaignClaimable(
  campaign: Pick<CampaignItem, 'status' | 'active' | 'startAt' | 'endAt' | 'totalClaimLimit' | 'claimsCount'>,
  nowMs: number = Date.now()
): boolean {
  const effective = resolveCampaignStatus(campaign, nowMs);
  if (effective !== 'ACTIVE') return false;
  if (nowMs < campaign.startAt) return false;
  if (campaign.totalClaimLimit !== null && campaign.claimsCount >= campaign.totalClaimLimit) {
    return false;
  }
  return true;
}

export function formatJakartaDateTime(timestampMs: number | null | undefined): string {
  if (!timestampMs) return 'Belum ada data';
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: XP_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestampMs));
}

export function formatJakartaDate(timestampMs: number | null | undefined): string {
  if (!timestampMs) return '-';
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: XP_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(timestampMs));
}

export function formatIdr(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(amount);
}

export function getBranchLabel(branch: BranchId | null | undefined): string {
  if (branch === 'DEMANG') return 'XP PLAY Demang';
  if (branch === 'SEKIP') return 'XP PLAY Sekip';
  return '-';
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function buildUsernameHashId(username: string): Promise<string> {
  const hash = await sha256Hex(`u:${normalizeUsername(username)}`);
  return `u_${hash}`;
}

export async function buildWhatsappHashId(whatsapp: string): Promise<string> {
  const hash = await sha256Hex(`w:${normalizeWhatsapp(whatsapp)}`);
  return `w_${hash}`;
}

