import {
  DEFAULT_LEVELS,
  DEFAULT_SYSTEM_SETTINGS,
  normalizeUsername,
  normalizeWhatsapp,
  resolveLevelFromXp,
  validateUsername,
  validateWhatsapp,
} from './xpLogic.ts';
import { validateBirthDate, validateMemberCategory } from './benefitRequestLogic.ts';
import type {
  AdminRole,
  BranchId,
  IncompleteRegistrationRow,
  LevelConfig,
  MemberCategory,
  MemberProfile,
  PhoneCheckResult,
  SystemSettings,
} from '../types/xpplay.ts';

export const REGISTRATION_NOT_FOUND_MESSAGE =
  'Nomor WhatsApp belum didaftarkan oleh XP PLAY. Silakan hubungi Kasir XP PLAY untuk mendaftar sebagai member.';

export const REGISTRATION_ALREADY_ACTIVE_MESSAGE =
  'Membership sudah aktif. Silakan masuk menggunakan halaman Login Member.';

export const REGISTRATION_PRE_REGISTERED_BANNER =
  'Nomor WhatsApp Anda sudah didaftarkan sebagai member XP PLAY. Lengkapi pendaftaran online untuk mendapatkan akses Member Dashboard dan bonus 10 XP.';

export const PRE_REGISTERED_LOGIN_BLOCKED_MESSAGE =
  'Membership Anda sudah didaftarkan oleh Kasir, tetapi belum menyelesaikan pendaftaran online. Silakan selesaikan pendaftaran membership.';

export const REGISTRATION_SUSPENDED_MESSAGE =
  'Akun membership Anda sedang dinonaktifkan sementara. Silakan hubungi Kasir atau Admin XP PLAY.';

export const ONBOARDING_CODE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const ONBOARDING_CODE_MAX_ATTEMPTS = 5;

export function isValidVerificationCodeFormat(code: string): boolean {
  return /^\d{6}$/.test((code || '').trim());
}

/**
 * Deterministic ledger IDs for the one-time Registration Bonus (+10 XP).
 * Using memberId ensures idempotency even across retries or concurrent submissions.
 */
export function buildRegistrationBonusLedgerIds(memberId: string): {
  progressLedgerId: string;
  rewardLedgerId: string;
} {
  const safe = (memberId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return {
    progressLedgerId: `regbonus_prog_${safe}`,
    rewardLedgerId: `regbonus_rew_${safe}`,
  };
}

/**
 * Checks whether a member document is permitted to access Member Dashboard (/member).
 * - PRE_REGISTERED / PHONE_ONLY -> DENIED
 * - SUSPENDED / DELETED / INACTIVE -> DENIED
 * - ACTIVE with COMPLETED (or legacy ACTIVE before two-step migration) -> ALLOWED
 */
export function isMemberAllowedDashboardAccess(member: MemberProfile | null | undefined): boolean {
  if (!member) return false;
  if (member.status !== 'ACTIVE') return false;
  if (member.registrationStatus && member.registrationStatus !== 'ACTIVE') return false;
  if (member.registrationStage && member.registrationStage !== 'COMPLETED') return false;
  return true;
}

export function isPreRegisteredMember(member: MemberProfile | null | undefined): boolean {
  if (!member) return false;
  return (
    member.status === 'PRE_REGISTERED' ||
    member.registrationStatus === 'PRE_REGISTERED' ||
    member.registrationStage === 'PHONE_ONLY'
  );
}

/**
 * Evaluates phone lookup result for Stage 2 customer online completion.
 */
export function evaluatePhoneRegistrationState(
  normalizedWhatsapp: string,
  memberOrStatus:
    | Pick<MemberProfile, 'status' | 'registrationStage' | 'branchId' | 'preferredBranch'>
    | { status: MemberProfile['status']; hasActiveCode?: boolean; branchId?: BranchId | null }
    | null
    | undefined
): PhoneCheckResult {
  if (!memberOrStatus || memberOrStatus.status === 'DELETED') {
    return {
      state: 'NOT_FOUND',
      canCompleteOnline: false,
      hasActiveCode: false,
      branchId: null,
      normalizedWhatsapp,
      message: REGISTRATION_NOT_FOUND_MESSAGE,
    };
  }

  const branchId =
    ('branchId' in memberOrStatus ? memberOrStatus.branchId : null) ??
    ('preferredBranch' in memberOrStatus ? memberOrStatus.preferredBranch : null) ??
    null;

  if (memberOrStatus.status === 'PRE_REGISTERED') {
    return {
      state: 'PRE_REGISTERED',
      canCompleteOnline: true,
      hasActiveCode: 'hasActiveCode' in memberOrStatus ? Boolean(memberOrStatus.hasActiveCode) : true,
      branchId,
      normalizedWhatsapp,
      message: REGISTRATION_PRE_REGISTERED_BANNER,
    };
  }

  if (memberOrStatus.status === 'ACTIVE') {
    return {
      state: 'ACTIVE',
      canCompleteOnline: false,
      hasActiveCode: false,
      branchId,
      normalizedWhatsapp,
      message: REGISTRATION_ALREADY_ACTIVE_MESSAGE,
    };
  }

  if (memberOrStatus.status === 'SUSPENDED') {
    return {
      state: 'SUSPENDED',
      canCompleteOnline: false,
      hasActiveCode: false,
      branchId,
      normalizedWhatsapp,
      message: REGISTRATION_SUSPENDED_MESSAGE,
    };
  }

  return {
    state: 'INACTIVE',
    canCompleteOnline: false,
    hasActiveCode: false,
    branchId,
    normalizedWhatsapp,
    message: REGISTRATION_SUSPENDED_MESSAGE,
  };
}

export interface BuildPreRegInput {
  preDocId: string;
  whatsapp: string;
  branchId: BranchId;
  actorId: string;
  actorRole: AdminRole;
  notes?: string;
  currentCycleId: string;
  nowMs?: number;
  memberId?: string;
}

/**
 * Pure Stage 1 builder: Creates a PRE_REGISTERED member with:
 * - status = PRE_REGISTERED, registrationStage = PHONE_ONLY
 * - xpProgress = 0, xpReward = 0, reservedXp = 0 (NO registration bonus, NO referral bonus!)
 * - authUid = null (NO active login account)
 */
export function buildPreRegisteredMemberProfile(input: BuildPreRegInput): MemberProfile {
  const waCheck = validateWhatsapp(input.whatsapp);
  if (!waCheck.valid) {
    throw new Error(waCheck.error || 'Nomor WhatsApp tidak valid.');
  }
  const now = input.nowMs ?? Date.now();
  const normalizedWa = waCheck.normalized;
  const memberId = input.memberId || `XPP-${Math.floor(100000 + Math.random() * 900000)}`;
  const cleanNotes = (input.notes || '').trim().slice(0, 240);

  return {
    uid: input.preDocId,
    memberId,
    fullName: 'Member Pre-Registered',
    username: '',
    whatsapp: normalizedWa,
    phone: normalizedWa,
    normalizedPhone: normalizedWa,
    socialMedia: '',
    birthDate: null,
    birthMonth: null,
    birthDay: null,
    memberCategory: null,
    status: 'PRE_REGISTERED',
    registrationStatus: 'PRE_REGISTERED',
    registrationStage: 'PHONE_ONLY',
    branchId: input.branchId,
    preferredBranch: input.branchId,
    preRegisteredAt: now,
    preRegisteredBy: input.actorId,
    preRegisteredByRole: input.actorRole,
    preRegistrationNotes: cleanNotes || null,
    registrationCompletedAt: null,
    verifiedPhoneAt: null,
    registrationBonusGranted: false,
    authUid: null,
    migratedFromUid: null,
    mergedIntoUid: null,
    xpProgress: 0,
    xpReward: 0,
    reservedXp: 0,
    currentLevel: 'BRONZE',
    levelMode: 'AUTOMATIC',
    currentCycleId: input.currentCycleId,
    referredByUid: null,
    referredByUsername: null,
    referralCount: 0,
    lastPlayAt: null,
    lastPlayBranch: null,
    createdAt: now,
    updatedAt: now,
  };
}

export interface CompleteRegistrationInput {
  preMember: MemberProfile;
  targetAuthUid: string;
  fullName: string;
  username: string;
  birthDate: string;
  memberCategory: MemberCategory;
  socialMedia?: string;
  preferredBranch: BranchId;
  referrer?: MemberProfile | null;
  verifiedPhoneAt: number;
  settings?: Pick<SystemSettings, 'registrationBonusXp' | 'referralBonusXp' | 'currentCycleId'>;
  levels?: LevelConfig[];
  existingBonusLedgerIds?: ReadonlySet<string>;
  nowMs?: number;
}

export interface CompleteRegistrationComputation {
  completedMember: MemberProfile;
  registrationBonusGranted: number;
  refereeReferralBonus: number;
  referrerReferralBonus: number;
  totalAddedXp: number;
  progressBonusLedgerId: string;
  rewardBonusLedgerId: string;
  referralValid: boolean;
}

/**
 * Pure deterministic Stage 2 completion computation.
 * - Rejects if member is already ACTIVE / COMPLETED / registrationBonusGranted === true.
 * - Preserves ALL Stage 1 XP (from cashier transactions/benefit requests before online completion).
 * - Grants one-time idempotent Registration Bonus (+10 XP Progress & +10 XP Reward).
 * - Applies optional Referral Bonus (+5 XP each to referee and referrer) ONLY on completion.
 * - Resolves updated level cleanly.
 */
export function computeRegistrationCompletion(
  input: CompleteRegistrationInput
): CompleteRegistrationComputation {
  const { preMember } = input;
  if (preMember.status !== 'PRE_REGISTERED' || preMember.registrationStage === 'COMPLETED') {
    throw new Error('Pendaftaran membership ini sudah selesai sebelumnya dan tidak dapat diulang.');
  }

  const fullName = (input.fullName || '').trim();
  if (fullName.length < 2) {
    throw new Error('Nama lengkap wajib diisi minimal 2 karakter.');
  }

  const userCheck = validateUsername(input.username);
  if (!userCheck.valid) {
    throw new Error(userCheck.error || 'Username tidak valid.');
  }

  const now = input.nowMs ?? Date.now();
  const birthCheck = validateBirthDate(input.birthDate, now);
  if (!birthCheck.valid || !birthCheck.birthDate) {
    throw new Error(birthCheck.error || 'Tanggal lahir tidak valid.');
  }

  const catCheck = validateMemberCategory(input.memberCategory);
  if (!catCheck.valid || !catCheck.value) {
    throw new Error(catCheck.error || 'Status member wajib dipilih.');
  }

  const regBonusConfig = input.settings?.registrationBonusXp ?? DEFAULT_SYSTEM_SETTINGS.registrationBonusXp;
  const refBonusConfig = input.settings?.referralBonusXp ?? DEFAULT_SYSTEM_SETTINGS.referralBonusXp;
  const levels = input.levels && input.levels.length === 4 ? input.levels : DEFAULT_LEVELS;

  const { progressLedgerId, rewardLedgerId } = buildRegistrationBonusLedgerIds(preMember.memberId);

  // Strict double-bonus prevention
  const alreadyHasBonus =
    Boolean(preMember.registrationBonusGranted) ||
    Boolean(input.existingBonusLedgerIds?.has(progressLedgerId)) ||
    Boolean(input.existingBonusLedgerIds?.has(rewardLedgerId));

  const registrationBonusGranted = alreadyHasBonus ? 0 : Math.max(0, Math.floor(regBonusConfig));

  // Referral validation (no self-referral, referrer must be ACTIVE)
  let referralValid = false;
  let refereeReferralBonus = 0;
  let referrerReferralBonus = 0;
  if (
    input.referrer &&
    input.referrer.status === 'ACTIVE' &&
    input.referrer.uid !== input.targetAuthUid &&
    input.referrer.uid !== preMember.uid &&
    normalizeUsername(input.referrer.username) !== userCheck.normalized
  ) {
    referralValid = true;
    refereeReferralBonus = Math.max(0, Math.floor(refBonusConfig));
    referrerReferralBonus = Math.max(0, Math.floor(refBonusConfig));
  }

  const totalAddedXp = registrationBonusGranted + refereeReferralBonus;
  const nextXpProgress = Math.max(0, (preMember.xpProgress || 0) + totalAddedXp);
  const nextXpReward = Math.max(0, (preMember.xpReward || 0) + totalAddedXp);

  const levelMode = preMember.levelMode ?? 'AUTOMATIC';
  const nextLevel =
    levelMode === 'MANUAL_OVERRIDE'
      ? preMember.currentLevel
      : resolveLevelFromXp(nextXpProgress, levels).current.id;

  const normalizedWa = normalizeWhatsapp(preMember.whatsapp);

  const completedMember: MemberProfile = {
    ...preMember,
    uid: input.targetAuthUid,
    authUid: input.targetAuthUid,
    migratedFromUid: input.targetAuthUid !== preMember.uid ? preMember.uid : preMember.migratedFromUid ?? null,
    mergedIntoUid: null,
    fullName,
    username: userCheck.normalized,
    whatsapp: normalizedWa,
    phone: normalizedWa,
    normalizedPhone: normalizedWa,
    socialMedia: (input.socialMedia || '').trim().slice(0, 120),
    birthDate: birthCheck.birthDate,
    birthMonth: birthCheck.birthMonth,
    birthDay: birthCheck.birthDay,
    memberCategory: catCheck.value,
    status: 'ACTIVE',
    registrationStatus: 'ACTIVE',
    registrationStage: 'COMPLETED',
    branchId: preMember.branchId ?? input.preferredBranch,
    preferredBranch: input.preferredBranch,
    preRegisteredAt: preMember.preRegisteredAt ?? preMember.createdAt,
    preRegisteredBy: preMember.preRegisteredBy ?? null,
    preRegisteredByRole: preMember.preRegisteredByRole ?? null,
    registrationCompletedAt: now,
    verifiedPhoneAt: input.verifiedPhoneAt,
    registrationBonusGranted: true,
    xpProgress: nextXpProgress,
    xpReward: nextXpReward,
    reservedXp: preMember.reservedXp ?? 0,
    currentLevel: nextLevel,
    levelMode,
    referredByUid: referralValid && input.referrer ? input.referrer.uid : null,
    referredByUsername: referralValid && input.referrer ? input.referrer.username : null,
    updatedAt: now,
  };

  return {
    completedMember,
    registrationBonusGranted,
    refereeReferralBonus,
    referrerReferralBonus,
    totalAddedXp,
    progressBonusLedgerId: progressLedgerId,
    rewardBonusLedgerId: rewardLedgerId,
    referralValid,
  };
}

/**
 * Computes read-only Incomplete Registration report (7 / 14 / 30 days) for Admin/Superadmin.
 * NEVER auto-deletes PRE_REGISTERED members.
 */
export function computeIncompleteRegistrations(
  members: MemberProfile[],
  minDays: number,
  nowMs: number = Date.now(),
  branchFilter?: BranchId | 'ALL'
): IncompleteRegistrationRow[] {
  const dayMs = 24 * 60 * 60 * 1000;
  const rows: IncompleteRegistrationRow[] = [];

  for (const m of members) {
    if (m.status !== 'PRE_REGISTERED') continue;
    const branchId = m.branchId ?? m.preferredBranch ?? null;
    if (branchFilter && branchFilter !== 'ALL' && branchId !== branchFilter) continue;

    const baseTs = m.preRegisteredAt ?? m.createdAt;
    const days = Math.max(0, Math.floor((nowMs - baseTs) / dayMs));
    if (days >= minDays) {
      rows.push({
        member: m,
        daysSincePreRegistered: days,
        hasTransactions: Boolean(m.lastPlayAt) || m.xpProgress > 0,
        branchId,
      });
    }
  }

  return rows.sort((a, b) => b.daysSincePreRegistered - a.daysSincePreRegistered);
}

/**
 * Splits New Member metrics cleanly into PRE_REGISTERED vs ACTIVE for Admin Dashboard.
 */
export interface SplitNewMembersMetrics {
  preRegisteredToday: number;
  preRegistered7d: number;
  preRegistered30d: number;
  totalPreRegistered: number;
  activeCompletedToday: number;
  activeCompleted7d: number;
  activeCompleted30d: number;
  newestPreRegistered: MemberProfile[];
  newestActiveMembers: MemberProfile[];
}

export function computeSplitNewMemberMetrics(
  members: MemberProfile[],
  nowMs: number = Date.now()
): SplitNewMembersMetrics {
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfToday = nowMs - dayMs;
  const last7d = nowMs - 7 * dayMs;
  const last30d = nowMs - 30 * dayMs;

  const preList: MemberProfile[] = [];
  const activeList: MemberProfile[] = [];

  let preRegisteredToday = 0;
  let preRegistered7d = 0;
  let preRegistered30d = 0;
  let activeCompletedToday = 0;
  let activeCompleted7d = 0;
  let activeCompleted30d = 0;

  for (const m of members) {
    if (m.status === 'DELETED') continue;
    if (m.status === 'PRE_REGISTERED') {
      preList.push(m);
      const ts = m.preRegisteredAt ?? m.createdAt;
      if (ts >= startOfToday) preRegisteredToday += 1;
      if (ts >= last7d) preRegistered7d += 1;
      if (ts >= last30d) preRegistered30d += 1;
    } else if (m.status === 'ACTIVE') {
      activeList.push(m);
      const ts = m.registrationCompletedAt ?? m.createdAt;
      if (ts >= startOfToday) activeCompletedToday += 1;
      if (ts >= last7d) activeCompleted7d += 1;
      if (ts >= last30d) activeCompleted30d += 1;
    }
  }

  preList.sort((a, b) => (b.preRegisteredAt ?? b.createdAt) - (a.preRegisteredAt ?? a.createdAt));
  activeList.sort(
    (a, b) => (b.registrationCompletedAt ?? b.createdAt) - (a.registrationCompletedAt ?? a.createdAt)
  );

  return {
    preRegisteredToday,
    preRegistered7d,
    preRegistered30d,
    totalPreRegistered: preList.length,
    activeCompletedToday,
    activeCompleted7d,
    activeCompleted30d,
    newestPreRegistered: preList.slice(0, 15),
    newestActiveMembers: activeList.slice(0, 15),
  };
}
