import {
  DEFAULT_LEVELS,
  getLevelRank,
  normalizeUsername,
  normalizeWhatsapp,
  resolveLevelFromXp,
  XP_TIMEZONE,
} from './xpLogic.ts';
import type {
  BenefitRequestRecord,
  BenefitRequestStatus,
  BranchId,
  LevelConfig,
  LevelId,
  MemberCategory,
  MemberProfile,
  MemberStatus,
  TransactionRecord,
  XpLedgerEntry,
  XpLedgerSource,
} from '../types/xpplay.ts';

export const BENEFIT_VALIDITY_DAYS = 7;
export const BENEFIT_VALIDITY_MS = BENEFIT_VALIDITY_DAYS * 24 * 60 * 60 * 1000;

export const MEMBER_CATEGORIES: readonly { value: MemberCategory; label: string }[] = [
  { value: 'MAHASISWA', label: 'Mahasiswa' },
  { value: 'PELAJAR', label: 'Pelajar' },
  { value: 'PEKERJA', label: 'Pekerja' },
  { value: 'LAINNYA', label: 'Lainnya' },
];

export const VALID_MEMBER_CATEGORIES: ReadonlySet<MemberCategory> = new Set([
  'MAHASISWA',
  'PELAJAR',
  'PEKERJA',
  'LAINNYA',
]);

export const VALID_MEMBER_STATUSES: ReadonlySet<MemberStatus> = new Set([
  'PRE_REGISTERED',
  'ACTIVE',
  'INACTIVE',
  'SUSPENDED',
  'DELETED',
]);

export const VALID_BENEFIT_REQUEST_STATUSES: ReadonlySet<BenefitRequestStatus> = new Set([
  'ON_PROCESS',
  'APPROVED',
  'DENIED',
  'USED',
  'EXPIRED',
  'REFUNDED',
]);

export function getMemberCategoryLabel(category: MemberCategory | null | undefined): string {
  const found = MEMBER_CATEGORIES.find((c) => c.value === category);
  return found ? found.label : '-';
}

export function validateMemberCategory(raw: unknown): {
  valid: boolean;
  value: MemberCategory | null;
  error?: string;
} {
  if (raw === null || raw === undefined || raw === '') {
    return { valid: true, value: null };
  }
  const upper = String(raw).trim().toUpperCase() as MemberCategory;
  if (!VALID_MEMBER_CATEGORIES.has(upper)) {
    return {
      valid: false,
      value: null,
      error: 'Status member tidak valid. Pilih Mahasiswa, Pelajar, Pekerja, atau Lainnya.',
    };
  }
  return { valid: true, value: upper };
}

/**
 * Returns today's calendar date string (YYYY-MM-DD) in Asia/Jakarta timezone.
 */
export function getJakartaTodayDateString(nowMs: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: XP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

/**
 * Validates member birth date (YYYY-MM-DD):
 * - Real Gregorian calendar date (rejects e.g. 2026-02-30)
 * - Not in the future relative to Asia/Jakarta today
 * - Reasonable lower bound >= 1900-01-01
 * - Extracts birthMonth (1..12) and birthDay (1..31) for birthday campaigns
 */
export function validateBirthDate(
  raw: string | null | undefined,
  nowMs: number = Date.now()
): {
  valid: boolean;
  birthDate: string | null;
  birthMonth: number | null;
  birthDay: number | null;
  error?: string;
} {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { valid: true, birthDate: null, birthMonth: null, birthDay: null };
  }

  const trimmed = String(raw).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    return {
      valid: false,
      birthDate: null,
      birthMonth: null,
      birthDay: null,
      error: 'Format tanggal lahir harus YYYY-MM-DD.',
    };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) {
    return {
      valid: false,
      birthDate: null,
      birthMonth: null,
      birthDay: null,
      error: 'Tanggal lahir tidak valid.',
    };
  }

  const checkDate = new Date(Date.UTC(year, month - 1, day));
  if (
    checkDate.getUTCFullYear() !== year ||
    checkDate.getUTCMonth() !== month - 1 ||
    checkDate.getUTCDate() !== day
  ) {
    return {
      valid: false,
      birthDate: null,
      birthMonth: null,
      birthDay: null,
      error: 'Tanggal lahir bukan tanggal kalender yang valid.',
    };
  }

  const todayJakarta = getJakartaTodayDateString(nowMs);
  if (trimmed > todayJakarta) {
    return {
      valid: false,
      birthDate: null,
      birthMonth: null,
      birthDay: null,
      error: 'Tanggal lahir tidak boleh berada di masa depan.',
    };
  }

  return {
    valid: true,
    birthDate: trimmed,
    birthMonth: month,
    birthDay: day,
  };
}

export function formatBirthDateJakarta(birthDate: string | null | undefined): string {
  if (!birthDate) return '-';
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate.trim());
  if (!parsed) return birthDate;
  const utcMidday = Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3]), 5, 0, 0);
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: XP_TIMEZONE,
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(new Date(utcMidday));
}

// ---------- FASE 2–5: PURE DETERMINISTIC BENEFIT REQUEST & XP HOLD ENGINE ----------

export interface BenefitHoldComputation {
  beforeXpReward: number;
  afterXpReward: number;
  beforeReservedXp: number;
  afterReservedXp: number;
  xpProgress: number; // strictly unchanged
  currentLevel: LevelId; // strictly unchanged
  ledgerAmount: number; // -xpCost
}

/**
 * FASE 2: Immediate XP Hold upon Benefit Request submission.
 * Deducts xpCost from Available XP Reward and moves it to Reserved XP.
 * NEVER modifies XP Progress or Level.
 */
export function computeBenefitHoldBalances(input: {
  memberXpReward: number;
  memberReservedXp?: number;
  memberXpProgress: number;
  memberLevel: LevelId;
  xpCost: number;
}): BenefitHoldComputation {
  const xpCost = Math.floor(Number(input.xpCost));
  if (!Number.isSafeInteger(xpCost) || xpCost < 0) {
    throw new Error('Biaya XP benefit tidak valid.');
  }
  const beforeXpReward = Math.floor(Number(input.memberXpReward));
  const beforeReservedXp = Math.max(0, Math.floor(Number(input.memberReservedXp ?? 0)));

  if (beforeXpReward < xpCost) {
    throw new Error(
      `XP Reward tersedia tidak mencukupi. Saldo tersedia ${beforeXpReward} XP, dibutuhkan ${xpCost} XP.`
    );
  }

  return {
    beforeXpReward,
    afterXpReward: beforeXpReward - xpCost,
    beforeReservedXp,
    afterReservedXp: beforeReservedXp + xpCost,
    xpProgress: input.memberXpProgress,
    currentLevel: input.memberLevel,
    ledgerAmount: -xpCost,
  };
}

export interface BenefitApproveComputation {
  nextStatus: 'APPROVED';
  approvedAt: number;
  expiresAt: number;
  nextXpProgress: number;
  nextXpReward: number;
  nextReservedXp: number;
  nextLevel: LevelId;
  levelChanged: boolean;
}

/**
 * Resolves XP economics for a campaign Benefit Request:
 * - PROMO: deducts member XP Reward (xpCost = xpReward, xpRewardGrant = 0),
 *   following the exact same XP Hold -> Approve / Auto-Refund lifecycle as Benefits.
 * - CHALLENGE / EVENT: grants XP Progress & XP Reward upon approval (xpCost = 0, xpRewardGrant = xpReward).
 */
export function resolveCampaignBenefitRequestEconomics(campaign: {
  type: 'CHALLENGE' | 'EVENT' | 'PROMO';
  xpReward: number;
}): { xpCost: number; xpRewardGrant: number } {
  const xpAmount = Math.max(0, Math.floor(Number(campaign.xpReward) || 0));
  if (campaign.type === 'PROMO') {
    return { xpCost: xpAmount, xpRewardGrant: 0 };
  }
  return { xpCost: 0, xpRewardGrant: xpAmount };
}

/**
 * FASE 3 & 4: Approve an ON_PROCESS Benefit Request.
 * - Consumes held reservedXp (does NOT return xpCost to available XP Reward) — applies to Benefits & Promos.
 * - If xpRewardGrant > 0 (Challenge/Event claim), credits both XP Progress & XP Reward and updates level if AUTOMATIC.
 * - Sets 7-day benefit validity: expiresAt = approvedAt + 7 days.
 */
export function computeBenefitApproval(input: {
  request: Pick<BenefitRequestRecord, 'status' | 'xpCost' | 'xpRewardGrant'>;
  member: Pick<MemberProfile, 'xpProgress' | 'xpReward' | 'reservedXp' | 'currentLevel' | 'levelMode'>;
  levels?: LevelConfig[];
  nowMs?: number;
}): BenefitApproveComputation {
  if (input.request.status !== 'ON_PROCESS') {
    throw new Error(`Benefit Request sudah berstatus ${input.request.status} dan tidak dapat di-approve ulang.`);
  }
  const now = input.nowMs ?? Date.now();
  const xpCost = Math.max(0, Math.floor(input.request.xpCost || 0));
  const xpGrant = Math.max(0, Math.floor(input.request.xpRewardGrant || 0));
  const prevReserved = Math.max(0, Math.floor(input.member.reservedXp ?? 0));

  const nextReservedXp = Math.max(0, prevReserved - xpCost);
  const nextXpProgress = input.member.xpProgress + xpGrant;
  const nextXpReward = input.member.xpReward + xpGrant;

  const levels = input.levels && input.levels.length > 0 ? input.levels : DEFAULT_LEVELS;
  const isManual = input.member.levelMode === 'MANUAL_OVERRIDE';
  const resolved = resolveLevelFromXp(nextXpProgress, levels).current.id;
  const nextLevel: LevelId = isManual ? input.member.currentLevel : resolved;

  return {
    nextStatus: 'APPROVED',
    approvedAt: now,
    expiresAt: now + BENEFIT_VALIDITY_MS,
    nextXpProgress,
    nextXpReward,
    nextReservedXp,
    nextLevel,
    levelChanged: !isManual && nextLevel !== input.member.currentLevel,
  };
}

export interface BenefitDenyComputation {
  nextStatus: 'REFUNDED' | 'DENIED';
  resolution: 'DENIED';
  deniedAt: number;
  refundedAt: number | null;
  refundedAmount: number;
  beforeXpReward: number;
  afterXpReward: number;
  beforeReservedXp: number;
  afterReservedXp: number;
  shouldCreateRefundLedger: boolean;
  refundLedgerSource: 'DENIED_REFUND';
}

/**
 * FASE 3: Deny an ON_PROCESS Benefit Request.
 * - If xpCost > 0: atomically refunds xpCost back to Available XP Reward, releases reservedXp,
 *   marks status = 'REFUNDED' (resolution = 'DENIED') to lock out any double refund,
 *   and instructs caller to append +xpCost xpRewardLedger with source = 'DENIED_REFUND'.
 * - If xpCost === 0: marks status = 'DENIED' without creating a zero-XP ledger entry.
 */
export function computeBenefitDenial(input: {
  request: Pick<BenefitRequestRecord, 'status' | 'xpCost'>;
  member: Pick<MemberProfile, 'xpReward' | 'reservedXp'>;
  nowMs?: number;
}): BenefitDenyComputation {
  if (input.request.status !== 'ON_PROCESS') {
    throw new Error(`Benefit Request sudah berstatus ${input.request.status} dan tidak dapat ditolak ulang.`);
  }
  const now = input.nowMs ?? Date.now();
  const xpCost = Math.max(0, Math.floor(input.request.xpCost || 0));
  const beforeXpReward = Math.floor(input.member.xpReward);
  const beforeReservedXp = Math.max(0, Math.floor(input.member.reservedXp ?? 0));

  if (xpCost > 0) {
    return {
      nextStatus: 'REFUNDED',
      resolution: 'DENIED',
      deniedAt: now,
      refundedAt: now,
      refundedAmount: xpCost,
      beforeXpReward,
      afterXpReward: beforeXpReward + xpCost,
      beforeReservedXp,
      afterReservedXp: Math.max(0, beforeReservedXp - xpCost),
      shouldCreateRefundLedger: true,
      refundLedgerSource: 'DENIED_REFUND',
    };
  }

  return {
    nextStatus: 'DENIED',
    resolution: 'DENIED',
    deniedAt: now,
    refundedAt: null,
    refundedAmount: 0,
    beforeXpReward,
    afterXpReward: beforeXpReward,
    beforeReservedXp,
    afterReservedXp: beforeReservedXp,
    shouldCreateRefundLedger: false,
    refundLedgerSource: 'DENIED_REFUND',
  };
}

/**
 * FASE 4 & 6: Cashier MARK AS USED validation.
 * Only APPROVED requests within their 7-day validity window (now <= expiresAt) can transition to USED.
 */
export function computeBenefitMarkUsed(input: {
  request: Pick<BenefitRequestRecord, 'status' | 'expiresAt'>;
  nowMs?: number;
}): { nextStatus: 'USED'; usedAt: number } {
  const now = input.nowMs ?? Date.now();
  if (input.request.status === 'USED') {
    throw new Error('Benefit ini sudah pernah digunakan (USED) dan tidak dapat digunakan ulang.');
  }
  if (input.request.status === 'EXPIRED') {
    throw new Error('Benefit ini sudah kadaluarsa (EXPIRED) dan tidak dapat digunakan.');
  }
  if (input.request.status !== 'APPROVED') {
    throw new Error(`Benefit berstatus ${input.request.status}. Hanya benefit berstatus APPROVED yang dapat ditandai USED.`);
  }
  if (input.request.expiresAt !== null && now > input.request.expiresAt) {
    throw new Error('Masa berlaku 7 hari benefit ini sudah berakhir (EXPIRED). Tidak dapat ditandai USED.');
  }
  return {
    nextStatus: 'USED',
    usedAt: now,
  };
}

export interface BenefitExpiryComputation {
  eligible: boolean;
  nextStatus: 'EXPIRED' | 'REFUNDED';
  resolution: 'EXPIRED';
  expiredAt: number;
  refundedAt: number | null;
  refundedAmount: number;
  beforeXpReward: number;
  afterXpReward: number;
  shouldCreateRefundLedger: boolean;
  refundLedgerSource: 'EXPIRY_REFUND';
}

/**
 * FASE 5: Process expired APPROVED benefit request (now > expiresAt).
 * - If refundOnExpiry === false (default): status = 'EXPIRED', NO refund.
 * - If refundOnExpiry === true and xpCost > 0: status = 'REFUNDED' (resolution = 'EXPIRED'),
 *   credits xpCost back to member.xpReward, appends +xpCost xpRewardLedger with source = 'EXPIRY_REFUND'.
 */
export function computeBenefitExpiry(input: {
  request: Pick<BenefitRequestRecord, 'status' | 'expiresAt' | 'xpCost'>;
  member: Pick<MemberProfile, 'xpReward'>;
  refundOnExpiry: boolean;
  nowMs?: number;
}): BenefitExpiryComputation {
  const now = input.nowMs ?? Date.now();
  if (input.request.status !== 'APPROVED') {
    throw new Error(`Hanya benefit APPROVED yang dapat diproses kadaluarsa (status saat ini: ${input.request.status}).`);
  }
  if (input.request.expiresAt === null || now <= input.request.expiresAt) {
    throw new Error('Benefit ini belum melewati batas waktu kadaluarsa 7 hari.');
  }

  const xpCost = Math.max(0, Math.floor(input.request.xpCost || 0));
  const beforeXpReward = Math.floor(input.member.xpReward);

  if (input.refundOnExpiry && xpCost > 0) {
    return {
      eligible: true,
      nextStatus: 'REFUNDED',
      resolution: 'EXPIRED',
      expiredAt: now,
      refundedAt: now,
      refundedAmount: xpCost,
      beforeXpReward,
      afterXpReward: beforeXpReward + xpCost,
      shouldCreateRefundLedger: true,
      refundLedgerSource: 'EXPIRY_REFUND',
    };
  }

  return {
    eligible: true,
    nextStatus: 'EXPIRED',
    resolution: 'EXPIRED',
    expiredAt: now,
    refundedAt: null,
    refundedAmount: 0,
    beforeXpReward,
    afterXpReward: beforeXpReward,
    shouldCreateRefundLedger: false,
    refundLedgerSource: 'EXPIRY_REFUND',
  };
}

export function isBenefitRequestEffectivelyExpired(
  req: Pick<BenefitRequestRecord, 'status' | 'expiresAt'>,
  nowMs: number = Date.now()
): boolean {
  return req.status === 'APPROVED' && req.expiresAt !== null && nowMs > req.expiresAt;
}

export function getBenefitRemainingDaysLabel(
  expiresAt: number | null,
  nowMs: number = Date.now()
): string {
  if (!expiresAt) return '-';
  const diff = expiresAt - nowMs;
  if (diff <= 0) return 'Kadaluarsa';
  const hours = Math.floor(diff / (60 * 60 * 1000));
  if (hours < 24) return `${Math.max(1, hours)} jam lagi`;
  const days = Math.ceil(diff / (24 * 60 * 60 * 1000));
  return `${days} hari lagi`;
}

// ---------- FASE 9, 11, 12: DETERMINISTIC FILTER / SEARCH / SORT ENGINE ----------

export type MemberSortOption =
  | 'NEWEST'
  | 'OLDEST'
  | 'XP_PROGRESS_DESC'
  | 'XP_PROGRESS_ASC'
  | 'XP_REWARD_DESC'
  | 'XP_REWARD_ASC'
  | 'LAST_PLAY_RECENT'
  | 'LONGEST_INACTIVE'
  | 'LEVEL_DESC'
  | 'LEVEL_ASC';

export interface MemberFilterCriteria {
  search?: string;
  level?: 'ALL' | LevelId;
  status?: 'ALL' | MemberStatus;
  branch?: 'ALL' | BranchId;
  memberCategory?: 'ALL' | MemberCategory;
  registeredFromMs?: number | null;
  registeredToMs?: number | null;
  sort?: MemberSortOption;
}

export function filterAndSortMembers(
  members: MemberProfile[],
  criteria: MemberFilterCriteria,
  levels: LevelConfig[] = DEFAULT_LEVELS
): MemberProfile[] {
  const q = (criteria.search || '').trim().toLowerCase();
  const qUser = q ? normalizeUsername(q) : '';
  const qWa = q ? normalizeWhatsapp(q) : '';

  const filtered = members.filter((m) => {
    if (criteria.level && criteria.level !== 'ALL' && m.currentLevel !== criteria.level) {
      return false;
    }
    if (criteria.status && criteria.status !== 'ALL' && m.status !== criteria.status) {
      return false;
    }
    if (criteria.branch && criteria.branch !== 'ALL') {
      const effBranch = m.lastPlayBranch ?? m.branchId ?? m.preferredBranch;
      if (effBranch !== criteria.branch) return false;
    }
    if (criteria.memberCategory && criteria.memberCategory !== 'ALL') {
      if ((m.memberCategory ?? null) !== criteria.memberCategory) return false;
    }
    if (criteria.registeredFromMs && m.createdAt < criteria.registeredFromMs) {
      return false;
    }
    if (criteria.registeredToMs && m.createdAt > criteria.registeredToMs) {
      return false;
    }
    if (q) {
      const hitUsername = (m.username || '').toLowerCase().includes(q) || (qUser && m.username === qUser);
      const hitName = (m.fullName || '').toLowerCase().includes(q);
      const hitWa = (m.whatsapp || '').includes(q) || (qWa.length >= 6 && (m.whatsapp || '').includes(qWa));
      const hitId = (m.memberId || '').toLowerCase().includes(q);
      if (!hitUsername && !hitName && !hitWa && !hitId) return false;
    }
    return true;
  });

  const sort = criteria.sort ?? 'NEWEST';
  return [...filtered].sort((a, b) => {
    switch (sort) {
      case 'OLDEST':
        return a.createdAt - b.createdAt;
      case 'XP_PROGRESS_DESC':
        return b.xpProgress - a.xpProgress || b.createdAt - a.createdAt;
      case 'XP_PROGRESS_ASC':
        return a.xpProgress - b.xpProgress || a.createdAt - b.createdAt;
      case 'XP_REWARD_DESC':
        return b.xpReward - a.xpReward || b.createdAt - a.createdAt;
      case 'XP_REWARD_ASC':
        return a.xpReward - b.xpReward || a.createdAt - b.createdAt;
      case 'LAST_PLAY_RECENT':
        return (b.lastPlayAt ?? 0) - (a.lastPlayAt ?? 0);
      case 'LONGEST_INACTIVE': {
        const aBase = a.lastPlayAt ?? a.createdAt;
        const bBase = b.lastPlayAt ?? b.createdAt;
        return aBase - bBase;
      }
      case 'LEVEL_DESC':
        return (
          getLevelRank(b.currentLevel, levels) - getLevelRank(a.currentLevel, levels) ||
          b.xpProgress - a.xpProgress
        );
      case 'LEVEL_ASC':
        return (
          getLevelRank(a.currentLevel, levels) - getLevelRank(b.currentLevel, levels) ||
          a.xpProgress - b.xpProgress
        );
      case 'NEWEST':
      default:
        return b.createdAt - a.createdAt;
    }
  });
}

export type TransactionDatePreset = 'ALL' | 'TODAY' | 'YESTERDAY' | 'THIS_WEEK' | 'THIS_MONTH' | 'CUSTOM';
export type TransactionSortOption =
  | 'NEWEST'
  | 'OLDEST'
  | 'AMOUNT_DESC'
  | 'AMOUNT_ASC'
  | 'XP_DESC'
  | 'XP_ASC';

export interface TransactionFilterCriteria {
  search?: string;
  branch?: 'ALL' | BranchId;
  datePreset?: TransactionDatePreset;
  dateFromMs?: number | null;
  dateToMs?: number | null;
  sort?: TransactionSortOption;
  nowMs?: number;
}

export function resolveJakartaDateRange(
  preset: TransactionDatePreset,
  nowMs: number = Date.now(),
  customFromMs?: number | null,
  customToMs?: number | null
): { fromMs: number | null; toMs: number | null } {
  if (preset === 'ALL') return { fromMs: null, toMs: null };
  if (preset === 'CUSTOM') {
    return { fromMs: customFromMs ?? null, toMs: customToMs ?? null };
  }
  const todayStr = getJakartaTodayDateString(nowMs);
  const [y, m, d] = todayStr.split('-').map(Number);
  // Start of Jakarta day in UTC ms (WIB is UTC+7)
  const startOfTodayMs = Date.UTC(y, m - 1, d, 0, 0, 0) - 7 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;

  if (preset === 'TODAY') {
    return { fromMs: startOfTodayMs, toMs: startOfTodayMs + dayMs - 1 };
  }
  if (preset === 'YESTERDAY') {
    return { fromMs: startOfTodayMs - dayMs, toMs: startOfTodayMs - 1 };
  }
  if (preset === 'THIS_WEEK') {
    return { fromMs: startOfTodayMs - 6 * dayMs, toMs: startOfTodayMs + dayMs - 1 };
  }
  // THIS_MONTH
  const startOfMonthMs = Date.UTC(y, m - 1, 1, 0, 0, 0) - 7 * 60 * 60 * 1000;
  return { fromMs: startOfMonthMs, toMs: startOfTodayMs + dayMs - 1 };
}

export function filterAndSortTransactions(
  transactions: TransactionRecord[],
  criteria: TransactionFilterCriteria,
  memberMap?: Map<string, MemberProfile>
): TransactionRecord[] {
  const q = (criteria.search || '').trim().toLowerCase();
  const range = resolveJakartaDateRange(
    criteria.datePreset ?? 'ALL',
    criteria.nowMs ?? Date.now(),
    criteria.dateFromMs,
    criteria.dateToMs
  );

  const filtered = transactions.filter((t) => {
    if (criteria.branch && criteria.branch !== 'ALL' && t.branch !== criteria.branch) {
      return false;
    }
    if (range.fromMs !== null && t.createdAt < range.fromMs) return false;
    if (range.toMs !== null && t.createdAt > range.toMs) return false;
    if (q) {
      const m = memberMap?.get(t.memberUid);
      const hitUser = (t.memberUsername || '').toLowerCase().includes(q);
      const hitMemberId = (t.memberId || '').toLowerCase().includes(q);
      const hitReceipt = (t.receiptNumber || '').toLowerCase().includes(q);
      const hitTxId = (t.id || '').toLowerCase().includes(q);
      const hitName = (m?.fullName || '').toLowerCase().includes(q);
      const hitWa = (m?.whatsapp || '').includes(q);
      if (!hitUser && !hitMemberId && !hitReceipt && !hitTxId && !hitName && !hitWa) {
        return false;
      }
    }
    return true;
  });

  const sort = criteria.sort ?? 'NEWEST';
  return [...filtered].sort((a, b) => {
    switch (sort) {
      case 'OLDEST':
        return a.createdAt - b.createdAt;
      case 'AMOUNT_DESC':
        return b.amountIdr - a.amountIdr || b.createdAt - a.createdAt;
      case 'AMOUNT_ASC':
        return a.amountIdr - b.amountIdr || a.createdAt - b.createdAt;
      case 'XP_DESC':
        return b.xpGenerated - a.xpGenerated || b.createdAt - a.createdAt;
      case 'XP_ASC':
        return a.xpGenerated - b.xpGenerated || a.createdAt - b.createdAt;
      case 'NEWEST':
      default:
        return b.createdAt - a.createdAt;
    }
  });
}

export type XpLedgerMovementCategory = 'POSITIVE' | 'NEGATIVE' | 'REFUND';

const REFUND_SOURCES: ReadonlySet<XpLedgerSource> = new Set([
  'DENIED_REFUND',
  'EXPIRY_REFUND',
  'ADMIN_REFUND',
  'REVERSAL_REFUND',
]);

export function classifyXpLedgerMovement(entry: Pick<XpLedgerEntry, 'amount' | 'source'>): XpLedgerMovementCategory {
  if (REFUND_SOURCES.has(entry.source)) return 'REFUND';
  return entry.amount >= 0 ? 'POSITIVE' : 'NEGATIVE';
}

export function getXpLedgerMovementLabel(entry: Pick<XpLedgerEntry, 'amount' | 'source'>): string {
  if (entry.source === 'BENEFIT_REQUEST_HOLD') return 'XP Ditahan (Hold)';
  if (entry.source === 'DENIED_REFUND') return 'XP Dikembalikan (Refund Ditolak)';
  if (entry.source === 'EXPIRY_REFUND') return 'XP Dikembalikan (Refund Expired)';
  if (entry.source === 'ADMIN_REFUND' || entry.source === 'REVERSAL_REFUND') return 'XP Dikembalikan (Refund)';
  return entry.amount >= 0 ? 'XP Bertambah (+)' : 'XP Berkurang (-)';
}
