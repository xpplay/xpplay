import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
} from 'firebase/auth';
import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  increment,
  limit,
  orderBy,
  query,
  runTransaction,
  setDoc,
  startAfter,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { auth, db } from '../lib/firebase.ts';
import { handleFirestoreError, OperationType } from '../lib/firestoreError.ts';
import {
  buildUsernameHashId,
  buildWhatsappHashId,
  calculateManualLevelOverride,
  calculateRecalculateLevelFromXp,
  calculateTransactionXp,
  calculateXpProgressAdjustment,
  calculateXpRewardAdjustment,
  DEFAULT_LEVELS,
  DEFAULT_SYSTEM_SETTINGS,
  isCampaignClaimable,
  isLevelEligible,
  normalizeUsername,
  normalizeWhatsapp,
  resolveEffectiveMemberLevel,
  resolveLevelFromXp,
  validateLevelThresholds,
  validateUsername,
  validateWhatsapp,
} from '../shared/xpLogic.ts';
import {
  DEFAULT_HOMEPAGE_CMS,
  sanitizeHomepageCmsContent,
  validateCmsSecurity,
} from '../shared/cmsSanitizer.ts';
import {
  buildInactiveNotificationDedupeKey,
  calculateMemberInactivity,
  isMemberInactive,
  sortInactiveRowsLongestFirst,
} from '../shared/inactiveLogic.ts';
import type {
  AdminPasswordChangeResult,
  AdminRole,
  AdminUser,
  AuditLogRecord,
  BackupKind,
  BackupManifest,
  BackupRetentionConfig,
  BackupVerificationResult,
  BenefitItem,
  BranchId,
  BranchInfo,
  CampaignItem,
  ClaimRecord,
  CmsDraftDoc,
  CmsPublishedDoc,
  CmsVersionRecord,
  CycleSnapshot,
  HomepageCmsContent,
  InactiveMemberRow,
  IntegrityAuditReport,
  LevelConfig,
  LevelId,
  LevelMode,
  LevelOverrideAction,
  LevelOverrideRecord,
  MemberNotification,
  MemberProfile,
  MembershipCycle,
  MemberStatus,
  NotificationCampaign,
  RedemptionRecord,
  RestoreJobRecord,
  RestoreLockState,
  RestorePreviewResult,
  SystemBackupRecord,
  SystemHealthReport,
  SystemSettings,
  TransactionRecord,
  XpAdjustmentKind,
  XpAdjustmentRecord,
} from '../types/xpplay.ts';

function genId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`;
}

function genMemberCode(): string {
  return `XPP-${Math.floor(100000 + Math.random() * 900000)}`;
}

async function getAuthBearer(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error('Sesi login tidak ditemukan.');
  return user.getIdToken();
}

export interface PaginatedResult<T> {
  items: T[];
  lastCursor: QueryDocumentSnapshot<DocumentData> | null;
  hasMore: boolean;
}

// ---------- Captcha & Auth API Helpers ----------
export async function fetchCaptchaChallenge() {
  const res = await fetch('/api/captcha/challenge');
  if (!res.ok) throw new Error('Gagal memuat CAPTCHA.');
  return res.json() as Promise<{
    mode: 'recaptcha' | 'server_svg';
    siteKey?: string;
    challengeToken?: string;
    svg?: string;
    expiresAt: number;
  }>;
}

function randomOpaqueMemberEmail(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `m_${hex}@member.xpplay.app`;
}

export async function registerMemberClient(input: {
  fullName: string;
  username: string;
  whatsapp: string;
  socialMedia: string;
  referralUsername?: string;
  preferredBranch: BranchId | null;
  password: string;
  captchaToken?: string;
  captchaAnswer?: string;
}): Promise<{
  member: MemberProfile;
  referralApplied: boolean;
  referralMessage?: string;
}> {
  // 1. Server-side CAPTCHA verification first
  const capRes = await fetch('/api/captcha/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: input.captchaToken,
      answer: input.captchaAnswer,
    }),
  });
  const capJson = (await capRes.json()) as { valid?: boolean; error?: string };
  if (!capRes.ok || !capJson.valid) {
    throw new Error(capJson.error || 'Verifikasi CAPTCHA gagal.');
  }

  const fullName = input.fullName.trim();
  if (fullName.length < 2 || fullName.length > 100) {
    throw new Error('Nama lengkap harus terdiri dari 2 hingga 100 karakter.');
  }

  const uCheck = validateUsername(input.username);
  if (!uCheck.valid) throw new Error(uCheck.error || 'Username tidak valid.');

  const wCheck = validateWhatsapp(input.whatsapp);
  if (!wCheck.valid) throw new Error(wCheck.error || 'Nomor WhatsApp tidak valid.');

  if (!input.password || input.password.length < 8) {
    throw new Error('Password minimal 8 karakter.');
  }

  const refInput = input.referralUsername ? normalizeUsername(input.referralUsername) : '';
  if (refInput && refInput === uCheck.normalized) {
    throw new Error('Anda tidak dapat menggunakan username Anda sendiri sebagai referral.');
  }

  // 2. Pre-check uniqueness via zero-PII SHA-256 authIndex
  const [uHash, wHash] = await Promise.all([
    buildUsernameHashId(uCheck.normalized),
    buildWhatsappHashId(wCheck.normalized),
  ]);

  const [uSnap, wSnap] = await Promise.all([
    getDoc(doc(db, 'authIndex', uHash)),
    getDoc(doc(db, 'authIndex', wHash)),
  ]);
  if (uSnap.exists()) {
    throw new Error('Username sudah terdaftar. Silakan pilih username lain.');
  }
  if (wSnap.exists()) {
    throw new Error('Nomor WhatsApp sudah terdaftar. Silakan gunakan nomor lain atau login.');
  }

  // Optional referral lookup before creating Auth user
  let candidateReferrerUid: string | null = null;
  let referralMessage: string | undefined;
  if (refInput) {
    const refHash = await buildUsernameHashId(refInput);
    const refIdxSnap = await getDoc(doc(db, 'authIndex', refHash));
    if (refIdxSnap.exists()) {
      candidateReferrerUid = (refIdxSnap.data() as { uid: string }).uid;
    } else {
      referralMessage = 'Username referral tidak ditemukan, registrasi dilanjutkan dengan bonus pendaftaran standar.';
    }
  }

  // 3. Create Firebase Auth Email/Password account with opaque alias email (no Google Sign-In)
  const authEmail = randomOpaqueMemberEmail();
  const cred = await createUserWithEmailAndPassword(auth, authEmail, input.password);
  const uid = cred.user.uid;
  try {
    await updateProfile(cred.user, { displayName: fullName });
  } catch {
    // Non-fatal
  }

  // 4. Commit atomic onboarding batch (roll back Auth user if batch fails)
  const { settings, levels } = await getSettingsAndLevelsClient();
  const now = Date.now();
  const memberId = genMemberCode();

  const writeOnboardingBatch = async (withReferralUid: string | null): Promise<MemberProfile> => {
    const regBonus = settings.registrationBonusXp;
    const refBonus = withReferralUid ? settings.referralBonusXp : 0;
    const totalXp = regBonus + refBonus;
    const levelEval = resolveLevelFromXp(totalXp, levels);

    const profile: MemberProfile = {
      uid,
      memberId,
      fullName,
      username: uCheck.normalized,
      whatsapp: wCheck.normalized,
      socialMedia: input.socialMedia.trim().slice(0, 100),
      status: 'ACTIVE',
      xpProgress: totalXp,
      xpReward: totalXp,
      currentLevel: levelEval.current.id,
      levelMode: 'AUTOMATIC',
      currentCycleId: settings.currentCycleId,
      referredByUid: withReferralUid,
      referredByUsername: withReferralUid ? refInput : null,
      referralCount: 0,
      lastPlayAt: null,
      lastPlayBranch: null,
      preferredBranch: input.preferredBranch,
      createdAt: now,
      updatedAt: now,
    };

    const batch = writeBatch(db);
    batch.set(doc(db, 'authIndex', uHash), {
      uid,
      authEmail,
      kind: 'USERNAME',
      createdAt: now,
    });
    batch.set(doc(db, 'authIndex', wHash), {
      uid,
      authEmail,
      kind: 'WHATSAPP',
      createdAt: now,
    });
    batch.set(doc(db, 'members', uid), profile);

    const progId = genId('xpp');
    const rewId = genId('xpr');
    batch.set(doc(db, 'xpProgressLedger', progId), {
      id: progId,
      memberId,
      memberUid: uid,
      amount: regBonus,
      type: 'PROGRESS',
      direction: 'CREDIT',
      source: 'REGISTRATION',
      referenceId: memberId,
      branch: null,
      cycleId: settings.currentCycleId,
      createdAt: now,
      createdBy: uid,
      note: 'Bonus pendaftaran member baru XP PLAY',
    });
    batch.set(doc(db, 'xpRewardLedger', rewId), {
      id: rewId,
      memberId,
      memberUid: uid,
      amount: regBonus,
      type: 'REWARD',
      direction: 'CREDIT',
      source: 'REGISTRATION',
      referenceId: memberId,
      branch: null,
      cycleId: settings.currentCycleId,
      createdAt: now,
      createdBy: uid,
      note: 'Bonus pendaftaran member baru XP PLAY',
    });

    if (withReferralUid) {
      const refDocId = `ref_${uid}`;
      batch.set(doc(db, 'referrals', refDocId), {
        id: refDocId,
        referrerUid: withReferralUid,
        referrerMemberId: withReferralUid.slice(0, 40),
        referrerUsername: refInput,
        refereeUid: uid,
        refereeMemberId: memberId,
        refereeUsername: uCheck.normalized,
        referrerXp: refBonus,
        refereeXp: refBonus,
        cycleId: settings.currentCycleId,
        createdAt: now,
      });

      // Credit referrer atomically (referralCount + optional refBonus XP)
      batch.update(doc(db, 'members', withReferralUid), {
        xpProgress: increment(refBonus),
        xpReward: increment(refBonus),
        referralCount: increment(1),
        updatedAt: now,
      });

      if (refBonus > 0) {
        const rProgId = genId('xpp');
        const rRewId = genId('xpr');
        batch.set(doc(db, 'xpProgressLedger', rProgId), {
          id: rProgId,
          memberId,
          memberUid: uid,
          amount: refBonus,
          type: 'PROGRESS',
          direction: 'CREDIT',
          source: 'REFERRAL',
          referenceId: refDocId,
          branch: null,
          cycleId: settings.currentCycleId,
          createdAt: now + 1,
          createdBy: uid,
          note: `Bonus referral dari @${refInput}`,
        });
        batch.set(doc(db, 'xpRewardLedger', rRewId), {
          id: rRewId,
          memberId,
          memberUid: uid,
          amount: refBonus,
          type: 'REWARD',
          direction: 'CREDIT',
          source: 'REFERRAL',
          referenceId: refDocId,
          branch: null,
          cycleId: settings.currentCycleId,
          createdAt: now + 1,
          createdBy: uid,
          note: `Bonus referral dari @${refInput}`,
        });

        const refRProgId = genId('xpp');
        const refRRewId = genId('xpr');
        batch.set(doc(db, 'xpProgressLedger', refRProgId), {
          id: refRProgId,
          memberId: withReferralUid.slice(0, 40),
          memberUid: withReferralUid,
          amount: refBonus,
          type: 'PROGRESS',
          direction: 'CREDIT',
          source: 'REFERRAL',
          referenceId: refDocId,
          branch: null,
          cycleId: settings.currentCycleId,
          createdAt: now + 1,
          createdBy: uid,
          note: `Bonus referral mengajak @${uCheck.normalized}`,
        });
        batch.set(doc(db, 'xpRewardLedger', refRRewId), {
          id: refRRewId,
          memberId: withReferralUid.slice(0, 40),
          memberUid: withReferralUid,
          amount: refBonus,
          type: 'REWARD',
          direction: 'CREDIT',
          source: 'REFERRAL',
          referenceId: refDocId,
          branch: null,
          cycleId: settings.currentCycleId,
          createdAt: now + 1,
          createdBy: uid,
          note: `Bonus referral mengajak @${uCheck.normalized}`,
        });
      }
    }

    await batch.commit();
    return profile;
  };

  try {
    if (candidateReferrerUid && candidateReferrerUid !== uid) {
      try {
        const member = await writeOnboardingBatch(candidateReferrerUid);
        return { member, referralApplied: true };
      } catch {
        // Referrer may be inactive/suspended; proceed with standard registration without referral bonus
        const member = await writeOnboardingBatch(null);
        return {
          member,
          referralApplied: false,
          referralMessage:
            'Akun referrer sedang tidak aktif, registrasi dilanjutkan dengan bonus pendaftaran standar.',
        };
      }
    }

    const member = await writeOnboardingBatch(null);
    return { member, referralApplied: false, referralMessage };
  } catch (err) {
    try {
      await cred.user.delete();
    } catch {
      // Ignore cleanup error
    }
    handleFirestoreError(err, OperationType.WRITE, `members/${uid}`);
  }
}

export async function loginMemberClient(input: {
  identifier: string;
  password: string;
  captchaToken?: string;
  captchaAnswer?: string;
}): Promise<void> {
  const capRes = await fetch('/api/captcha/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: input.captchaToken,
      answer: input.captchaAnswer,
    }),
  });
  const capJson = (await capRes.json()) as { valid?: boolean; error?: string };
  if (!capRes.ok || !capJson.valid) {
    throw new Error(capJson.error || 'Verifikasi CAPTCHA gagal.');
  }

  const raw = input.identifier.trim();
  if (!raw || !input.password) {
    throw new Error('Username/WhatsApp dan password wajib diisi.');
  }

  const digits = raw.replace(/\D/g, '');
  const looksLikePhone = /^\+?[0-9\s\-]{8,18}$/.test(raw) && digits.length >= 9;
  const hashId = looksLikePhone
    ? await buildWhatsappHashId(normalizeWhatsapp(raw))
    : await buildUsernameHashId(normalizeUsername(raw));

  const idxSnap = await getDoc(doc(db, 'authIndex', hashId));
  if (!idxSnap.exists()) {
    throw new Error('Username/WhatsApp atau password tidak sesuai.');
  }

  const { authEmail } = idxSnap.data() as { authEmail: string };
  try {
    await signInWithEmailAndPassword(auth, authEmail, input.password);
  } catch {
    throw new Error('Username/WhatsApp atau password tidak sesuai.');
  }
}

// ---------- Member Self Actions ----------
export async function updateMemberOwnProfile(
  uid: string,
  patch: { fullName: string; socialMedia: string; preferredBranch: BranchId | null }
): Promise<void> {
  try {
    await updateDoc(doc(db, 'members', uid), {
      fullName: patch.fullName.trim(),
      socialMedia: patch.socialMedia.trim().slice(0, 100),
      preferredBranch: patch.preferredBranch,
      updatedAt: Date.now(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `members/${uid}`);
  }
}

export async function uploadClaimEvidence(file: File): Promise<{
  evidenceUrl: string;
  evidencePath: string;
}> {
  const token = await getAuthBearer();
  const formData = new FormData();
  formData.append('evidence', file);

  const res = await fetch('/api/claims/evidence', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });

  const data = (await res.json()) as {
    evidenceUrl?: string;
    evidencePath?: string;
    error?: string;
  };
  if (!res.ok || !data.evidenceUrl || !data.evidencePath) {
    throw new Error(data.error || 'Bukti foto gagal diunggah.');
  }
  return {
    evidenceUrl: data.evidenceUrl,
    evidencePath: data.evidencePath,
  };
}

export async function submitClaimForMember(input: {
  member: MemberProfile;
  campaign: CampaignItem;
  evidenceUrl: string;
  evidencePath: string;
  note: string;
}): Promise<ClaimRecord> {
  const now = Date.now();
  if (!isCampaignClaimable(input.campaign, now)) {
    throw new Error('Challenge/Event/Promo ini sudah berakhir atau tidak aktif.');
  }

  if (input.campaign.requiresEvidence && !input.evidenceUrl) {
    throw new Error('Bukti foto wajib diunggah untuk mengajukan claim ini.');
  }

  // Anti-duplicate claim check per member & campaign
  try {
    const existingSnap = await getDocs(
      query(
        collection(db, 'claims'),
        where('memberUid', '==', input.member.uid),
        where('campaignId', '==', input.campaign.id),
        limit(input.campaign.maxClaimsPerMember + 5)
      )
    );
    const activeOrApproved = existingSnap.docs.filter((d) => {
      const st = (d.data() as ClaimRecord).status;
      return st === 'ON_PROCESS' || st === 'APPROVED';
    });
    if (activeOrApproved.length >= input.campaign.maxClaimsPerMember) {
      throw new Error(
        input.campaign.maxClaimsPerMember === 1
          ? 'Anda sudah mengajukan atau mengklaim program ini sebelumnya.'
          : `Batas maksimal ${input.campaign.maxClaimsPerMember} kali claim untuk program ini telah tercapai.`
      );
    }
  } catch (err) {
    if (err instanceof Error && !err.message.includes('permission')) {
      throw err;
    }
  }

  const claimId = genId('clm');
  const record: ClaimRecord = {
    id: claimId,
    memberId: input.member.memberId,
    memberUid: input.member.uid,
    memberUsername: input.member.username,
    campaignId: input.campaign.id,
    campaignTitle: input.campaign.title,
    campaignType: input.campaign.type,
    xpRewardSnapshot: input.campaign.xpReward,
    evidenceUrl: input.evidenceUrl,
    evidencePath: input.evidencePath,
    note: input.note.trim().slice(0, 400),
    status: 'ON_PROCESS',
    reviewedBy: null,
    reviewerRole: null,
    reviewedAt: null,
    denialReason: null,
    cycleId: input.member.currentCycleId,
    createdAt: now,
  };

  try {
    await setDoc(doc(db, 'claims', claimId), record);
    return record;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `claims/${claimId}`);
  }
}

export async function submitRedemptionForMember(input: {
  member: MemberProfile;
  benefit: BenefitItem;
  levels: LevelConfig[];
}): Promise<RedemptionRecord> {
  const now = Date.now();
  if (!input.benefit.active) {
    throw new Error('Benefit ini sedang tidak tersedia.');
  }
  if (input.benefit.expiryAt && now > input.benefit.expiryAt) {
    throw new Error('Masa berlaku benefit ini sudah berakhir.');
  }
  if (!input.benefit.claimable || !input.benefit.redeemable) {
    throw new Error('Benefit ini bersifat informasi/terkunci dan tidak dapat di-redeem.');
  }
  const effectiveLevel = resolveEffectiveMemberLevel(input.member, input.levels).id;
  if (!isLevelEligible(effectiveLevel, input.benefit.levelRequirement, input.levels)) {
    throw new Error(`Benefit ini memerlukan minimal level ${input.benefit.levelRequirement}.`);
  }
  if (input.benefit.stock !== null && input.benefit.stock <= 0) {
    throw new Error('Stok benefit ini sudah habis.');
  }
  if (input.member.xpReward < input.benefit.xpCost) {
    throw new Error('XP Reward Anda tidak mencukupi untuk benefit ini.');
  }

  const redId = genId('rdm');
  const record: RedemptionRecord = {
    id: redId,
    memberId: input.member.memberId,
    memberUid: input.member.uid,
    memberUsername: input.member.username,
    benefitId: input.benefit.id,
    benefitName: input.benefit.name,
    xpCostSnapshot: input.benefit.xpCost,
    levelRequirement: input.benefit.levelRequirement,
    redemptionKind: input.benefit.xpCost > 0 ? 'XP_REWARD' : 'LEVEL_BENEFIT',
    status: 'ON_PROCESS',
    reviewedBy: null,
    reviewerRole: null,
    reviewedAt: null,
    denialReason: null,
    cycleId: input.member.currentCycleId,
    createdAt: now,
  };

  try {
    await setDoc(doc(db, 'redemptions', redId), record);
    return record;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `redemptions/${redId}`);
  }
}

export async function markMemberNotificationRead(notificationId: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'memberNotifications', notificationId), {
      read: true,
      readAt: Date.now(),
      status: 'READ',
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `memberNotifications/${notificationId}`);
  }
}

function isMissingIndexError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('requires an index') ||
    msg.includes('failed-precondition') ||
    msg.includes('failed_precondition')
  );
}

// ---------- Paginated Queries (Member & Admin) ----------
export async function fetchPaginatedCollection<T>(input: {
  collectionName: string;
  constraints: QueryConstraint[];
  orderByField?: string;
  orderDirection?: 'asc' | 'desc';
  pageSize?: number;
  cursor?: QueryDocumentSnapshot<DocumentData> | null;
}): Promise<PaginatedResult<T>> {
  const pageSize = input.pageSize ?? 10;
  const sortField = input.orderByField ?? 'createdAt';
  const sortDir = input.orderDirection ?? 'desc';
  const parts: QueryConstraint[] = [
    ...input.constraints,
    orderBy(sortField, sortDir),
    limit(pageSize + 1),
  ];
  if (input.cursor) {
    parts.push(startAfter(input.cursor));
  }

  try {
    const snap = await getDocs(query(collection(db, input.collectionName), ...parts));
    const hasMore = snap.docs.length > pageSize;
    const sliced = hasMore ? snap.docs.slice(0, pageSize) : snap.docs;
    return {
      items: sliced.map((d) => d.data() as T),
      lastCursor: sliced.length > 0 ? sliced[sliced.length - 1] : null,
      hasMore,
    };
  } catch (err) {
    if (isMissingIndexError(err) && !input.cursor) {
      try {
        const fallbackSnap = await getDocs(
          query(collection(db, input.collectionName), ...input.constraints, limit(Math.max(pageSize * 5, 100)))
        );
        const sortedDocs = [...fallbackSnap.docs].sort((a, b) => {
          const av = Number((a.data() as Record<string, unknown>)[sortField] ?? 0);
          const bv = Number((b.data() as Record<string, unknown>)[sortField] ?? 0);
          return sortDir === 'asc' ? av - bv : bv - av;
        });
        const sliced = sortedDocs.slice(0, pageSize);
        return {
          items: sliced.map((d) => d.data() as T),
          lastCursor: null,
          hasMore: false,
        };
      } catch (fallbackErr) {
        handleFirestoreError(fallbackErr, OperationType.LIST, input.collectionName);
      }
    }
    handleFirestoreError(err, OperationType.LIST, input.collectionName);
  }
}

export async function fetchActiveCampaigns(): Promise<CampaignItem[]> {
  try {
    const snap = await getDocs(
      query(collection(db, 'campaigns'), where('active', '==', true), orderBy('endAt', 'desc'), limit(50))
    );
    return snap.docs.map((d) => d.data() as CampaignItem);
  } catch (err) {
    if (isMissingIndexError(err)) {
      try {
        const fallbackSnap = await getDocs(
          query(collection(db, 'campaigns'), where('active', '==', true), limit(50))
        );
        return fallbackSnap.docs
          .map((d) => d.data() as CampaignItem)
          .sort((a, b) => b.endAt - a.endAt);
      } catch (fallbackErr) {
        handleFirestoreError(fallbackErr, OperationType.LIST, 'campaigns');
      }
    }
    handleFirestoreError(err, OperationType.LIST, 'campaigns');
  }
}

export async function fetchActiveBenefits(): Promise<BenefitItem[]> {
  try {
    const snap = await getDocs(
      query(collection(db, 'benefits'), where('active', '==', true), orderBy('xpCost', 'asc'), limit(50))
    );
    return snap.docs.map((d) => d.data() as BenefitItem);
  } catch (err) {
    if (isMissingIndexError(err)) {
      try {
        const fallbackSnap = await getDocs(
          query(collection(db, 'benefits'), where('active', '==', true), limit(50))
        );
        return fallbackSnap.docs
          .map((d) => d.data() as BenefitItem)
          .sort((a, b) => a.xpCost - b.xpCost);
      } catch (fallbackErr) {
        handleFirestoreError(fallbackErr, OperationType.LIST, 'benefits');
      }
    }
    handleFirestoreError(err, OperationType.LIST, 'benefits');
  }
}

// ---------- Admin Operations (Server-API when Admin SDK ready, Transaction fallback when in Client Preview) ----------
async function getSettingsAndLevelsClient(): Promise<{
  settings: SystemSettings;
  levels: LevelConfig[];
}> {
  const [settingsSnap, levelsSnap] = await Promise.all([
    getDoc(doc(db, 'systemSettings', 'default')),
    getDocs(collection(db, 'levels')),
  ]);
  const settings = settingsSnap.exists()
    ? (settingsSnap.data() as SystemSettings)
    : DEFAULT_SYSTEM_SETTINGS;
  const levels = levelsSnap.empty
    ? DEFAULT_LEVELS
    : levelsSnap.docs.map((d) => d.data() as LevelConfig).sort((a, b) => a.rank - b.rank);
  return { settings, levels };
}

export async function findMemberByIdentifierAdmin(identifier: string): Promise<MemberProfile | null> {
  const raw = identifier.trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  const looksLikePhone = /^\+?[0-9\s\-]{8,18}$/.test(raw) && digits.length >= 9;

  try {
    if (looksLikePhone) {
      const normalizedWa = normalizeWhatsapp(raw);
      const snap = await getDocs(
        query(collection(db, 'members'), where('whatsapp', '==', normalizedWa), limit(1))
      );
      return snap.empty ? null : (snap.docs[0].data() as MemberProfile);
    }

    const normalizedUser = normalizeUsername(raw);
    const snap = await getDocs(
      query(collection(db, 'members'), where('username', '==', normalizedUser), limit(1))
    );
    return snap.empty ? null : (snap.docs[0].data() as MemberProfile);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'members');
  }
}

export async function createMemberByAdmin(input: {
  fullName: string;
  username: string;
  whatsapp: string;
  socialMedia: string;
  referralUsername?: string;
  preferredBranch?: BranchId | null;
  admin: AdminUser;
}): Promise<{ member: MemberProfile; referralApplied: boolean; referralMessage?: string }> {
  const uCheck = validateUsername(input.username);
  if (!uCheck.valid) throw new Error(uCheck.error);
  const wCheck = validateWhatsapp(input.whatsapp);
  if (!wCheck.valid) throw new Error(wCheck.error);

  const fullName = input.fullName.trim();
  if (fullName.length < 2) throw new Error('Nama lengkap minimal 2 karakter.');

  const refInput = input.referralUsername ? normalizeUsername(input.referralUsername) : '';
  if (refInput && refInput === uCheck.normalized) {
    throw new Error('Tidak boleh melakukan self-referral.');
  }

  // Uniqueness checks
  const [dupUser, dupWa] = await Promise.all([
    getDocs(query(collection(db, 'members'), where('username', '==', uCheck.normalized), limit(1))),
    getDocs(query(collection(db, 'members'), where('whatsapp', '==', wCheck.normalized), limit(1))),
  ]);
  if (!dupUser.empty) throw new Error('Username sudah terdaftar.');
  if (!dupWa.empty) throw new Error('Nomor WhatsApp sudah terdaftar.');

  let referrer: MemberProfile | null = null;
  let referralMessage: string | undefined;
  if (refInput) {
    const refSnap = await getDocs(
      query(collection(db, 'members'), where('username', '==', refInput), limit(1))
    );
    if (!refSnap.empty) {
      const candidate = refSnap.docs[0].data() as MemberProfile;
      if (candidate.status === 'ACTIVE') {
        referrer = candidate;
      } else {
        referralMessage = 'Akun referrer tidak aktif; bonus referral tidak diberikan.';
      }
    } else {
      referralMessage = 'Username referral tidak ditemukan; member tetap dibuat dengan bonus registrasi standar.';
    }
  }

  const { settings, levels } = await getSettingsAndLevelsClient();
  const uid = genId('mem');
  const memberId = genMemberCode();
  const now = Date.now();
  const regBonus = settings.registrationBonusXp;
  const refBonus = referrer ? settings.referralBonusXp : 0;
  const totalXp = regBonus + refBonus;
  const levelEval = resolveLevelFromXp(totalXp, levels);

  const member: MemberProfile = {
    uid,
    memberId,
    fullName,
    username: uCheck.normalized,
    whatsapp: wCheck.normalized,
    socialMedia: input.socialMedia.trim().slice(0, 100),
    status: 'ACTIVE',
    xpProgress: totalXp,
    xpReward: totalXp,
    currentLevel: levelEval.current.id,
    levelMode: 'AUTOMATIC',
    currentCycleId: settings.currentCycleId,
    referredByUid: referrer ? referrer.uid : null,
    referredByUsername: referrer ? referrer.username : null,
    referralCount: 0,
    lastPlayAt: null,
    lastPlayBranch: null,
    preferredBranch: input.preferredBranch ?? null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await runTransaction(db, async (tx) => {
      let freshReferrer: MemberProfile | null = null;
      if (referrer) {
        const rSnap = await tx.get(doc(db, 'members', referrer.uid));
        if (rSnap.exists()) {
          freshReferrer = rSnap.data() as MemberProfile;
        }
      }

      tx.set(doc(db, 'members', uid), member);

      const regProgId = genId('xpp');
      const regRewId = genId('xpr');
      tx.set(doc(db, 'xpProgressLedger', regProgId), {
        id: regProgId,
        memberId,
        memberUid: uid,
        amount: regBonus,
        type: 'PROGRESS',
        direction: 'CREDIT',
        source: 'REGISTRATION',
        referenceId: memberId,
        branch: null,
        cycleId: settings.currentCycleId,
        createdAt: now,
        createdBy: input.admin.uid,
        note: 'Bonus pendaftaran member baru',
      });
      tx.set(doc(db, 'xpRewardLedger', regRewId), {
        id: regRewId,
        memberId,
        memberUid: uid,
        amount: regBonus,
        type: 'REWARD',
        direction: 'CREDIT',
        source: 'REGISTRATION',
        referenceId: memberId,
        branch: null,
        cycleId: settings.currentCycleId,
        createdAt: now,
        createdBy: input.admin.uid,
        note: 'Bonus pendaftaran member baru',
      });

      if (freshReferrer) {
        const refId = genId('ref');
        tx.set(doc(db, 'referrals', refId), {
          id: refId,
          referrerUid: freshReferrer.uid,
          referrerMemberId: freshReferrer.memberId,
          referrerUsername: freshReferrer.username,
          refereeUid: uid,
          refereeMemberId: memberId,
          refereeUsername: uCheck.normalized,
          referrerXp: refBonus,
          refereeXp: refBonus,
          cycleId: settings.currentCycleId,
          createdAt: now,
        });

        const e1 = genId('xpp');
        const e2 = genId('xpr');
        tx.set(doc(db, 'xpProgressLedger', e1), {
          id: e1,
          memberId,
          memberUid: uid,
          amount: refBonus,
          type: 'PROGRESS',
          direction: 'CREDIT',
          source: 'REFERRAL',
          referenceId: refId,
          branch: null,
          cycleId: settings.currentCycleId,
          createdAt: now + 1,
          createdBy: input.admin.uid,
          note: `Bonus referral dari @${freshReferrer.username}`,
        });
        tx.set(doc(db, 'xpRewardLedger', e2), {
          id: e2,
          memberId,
          memberUid: uid,
          amount: refBonus,
          type: 'REWARD',
          direction: 'CREDIT',
          source: 'REFERRAL',
          referenceId: refId,
          branch: null,
          cycleId: settings.currentCycleId,
          createdAt: now + 1,
          createdBy: input.admin.uid,
          note: `Bonus referral dari @${freshReferrer.username}`,
        });

        const rNewProg = freshReferrer.xpProgress + refBonus;
        const rNewRew = freshReferrer.xpReward + refBonus;
        const isRefManual = freshReferrer.levelMode === 'MANUAL_OVERRIDE';
        const rLvl = resolveLevelFromXp(rNewProg, levels);
        const nextRefLevel: LevelId = isRefManual ? freshReferrer.currentLevel : rLvl.current.id;
        const nextRefMode: LevelMode = isRefManual ? 'MANUAL_OVERRIDE' : 'AUTOMATIC';

        tx.update(doc(db, 'members', freshReferrer.uid), {
          xpProgress: rNewProg,
          xpReward: rNewRew,
          currentLevel: nextRefLevel,
          levelMode: nextRefMode,
          referralCount: (freshReferrer.referralCount || 0) + 1,
          updatedAt: now,
        });

        const r1 = genId('xpp');
        const r2 = genId('xpr');
        tx.set(doc(db, 'xpProgressLedger', r1), {
          id: r1,
          memberId: freshReferrer.memberId,
          memberUid: freshReferrer.uid,
          amount: refBonus,
          type: 'PROGRESS',
          direction: 'CREDIT',
          source: 'REFERRAL',
          referenceId: refId,
          branch: null,
          cycleId: settings.currentCycleId,
          createdAt: now + 1,
          createdBy: input.admin.uid,
          note: `Bonus referral mengajak @${uCheck.normalized}`,
        });
        tx.set(doc(db, 'xpRewardLedger', r2), {
          id: r2,
          memberId: freshReferrer.memberId,
          memberUid: freshReferrer.uid,
          amount: refBonus,
          type: 'REWARD',
          direction: 'CREDIT',
          source: 'REFERRAL',
          referenceId: refId,
          branch: null,
          cycleId: settings.currentCycleId,
          createdAt: now + 1,
          createdBy: input.admin.uid,
          note: `Bonus referral mengajak @${uCheck.normalized}`,
        });

        if (!isRefManual && nextRefLevel !== freshReferrer.currentLevel) {
          const lhId = genId('lvl');
          tx.set(doc(db, 'levelHistory', lhId), {
            id: lhId,
            memberId: freshReferrer.memberId,
            memberUid: freshReferrer.uid,
            fromLevel: freshReferrer.currentLevel,
            toLevel: nextRefLevel,
            xpProgressAtEvent: rNewProg,
            source: 'REFERRAL',
            cycleId: settings.currentCycleId,
            createdAt: now,
          });
        }
      }

      const auditId = genId('audit');
      tx.set(doc(db, 'auditLogs', auditId), {
        id: auditId,
        actorId: input.admin.uid,
        actorRole: input.admin.role,
        action: 'ADMIN_CREATE_MEMBER',
        targetType: 'member',
        targetId: uid,
        before: null,
        after: { username: uCheck.normalized, xpProgress: totalXp, xpReward: totalXp },
        metadata: null,
        timestamp: now,
      });
    });

    return { member, referralApplied: Boolean(referrer), referralMessage };
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `members/${uid}`);
  }
}

export async function recordTransactionByAdmin(input: {
  identifier: string;
  amountIdr: number;
  branch: BranchId;
  receiptNumber: string;
  note: string;
  admin: AdminUser;
  adminSdkConfigured: boolean;
}): Promise<{ xpGenerated: number; newProgress: number; newReward: number; newLevel: LevelId }> {
  if (!Number.isSafeInteger(input.amountIdr) || input.amountIdr <= 0) {
    throw new Error('Nominal transaksi harus bilangan bulat lebih dari 0.');
  }

  if (input.adminSdkConfigured) {
    const token = await getAuthBearer();
    const res = await fetch('/api/admin/transactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        identifier: input.identifier,
        amountIdr: input.amountIdr,
        branch: input.branch,
        receiptNumber: input.receiptNumber,
        note: input.note,
      }),
    });
    const data = (await res.json()) as {
      xpGenerated?: number;
      newProgress?: number;
      newReward?: number;
      newLevel?: LevelId;
      error?: string;
    };
    if (!res.ok) throw new Error(data.error || 'Gagal mencatat transaksi.');
    return {
      xpGenerated: data.xpGenerated ?? 0,
      newProgress: data.newProgress ?? 0,
      newReward: data.newReward ?? 0,
      newLevel: data.newLevel ?? 'BRONZE',
    };
  }

  const target = await findMemberByIdentifierAdmin(input.identifier);
  if (!target) {
    throw new Error('Member dengan username atau nomor WhatsApp tersebut tidak ditemukan.');
  }

  const { settings, levels } = await getSettingsAndLevelsClient();

  try {
    return await runTransaction(db, async (tx) => {
      const now = Date.now();
      const memberRef = doc(db, 'members', target.uid);
      const mSnap = await tx.get(memberRef);
      if (!mSnap.exists()) throw new Error('Member tidak ditemukan.');

      const member = mSnap.data() as MemberProfile;
      if (member.status !== 'ACTIVE') {
        throw new Error(`Member berstatus ${member.status} dan tidak dapat menerima transaksi.`);
      }

      const xpGenerated = calculateTransactionXp(input.amountIdr, settings.transactionXpRate);
      const newProgress = member.xpProgress + xpGenerated;
      const newReward = member.xpReward + xpGenerated;
      const isManualOverride = member.levelMode === 'MANUAL_OVERRIDE';
      const levelEval = resolveLevelFromXp(newProgress, levels);
      const nextLevel: LevelId = isManualOverride ? member.currentLevel : levelEval.current.id;
      const nextLevelMode: LevelMode = isManualOverride ? 'MANUAL_OVERRIDE' : 'AUTOMATIC';

      const txId = genId('trx');
      const txRecord: TransactionRecord = {
        id: txId,
        memberId: member.memberId,
        memberUid: member.uid,
        memberUsername: member.username,
        branch: input.branch,
        amountIdr: input.amountIdr,
        xpRateUsed: settings.transactionXpRate,
        xpGenerated,
        source: 'TRANSACTION',
        receiptNumber: input.receiptNumber.trim().slice(0, 64),
        note: input.note.trim().slice(0, 300),
        adminId: input.admin.uid,
        adminName: input.admin.fullName,
        cycleId: settings.currentCycleId,
        createdAt: now,
      };

      tx.set(doc(db, 'transactions', txId), txRecord);
      tx.update(memberRef, {
        xpProgress: newProgress,
        xpReward: newReward,
        currentLevel: nextLevel,
        levelMode: nextLevelMode,
        lastPlayAt: now,
        lastPlayBranch: input.branch,
        updatedAt: now,
      });

      if (xpGenerated > 0) {
        const pId = genId('xpp');
        const rId = genId('xpr');
        tx.set(doc(db, 'xpProgressLedger', pId), {
          id: pId,
          memberId: member.memberId,
          memberUid: member.uid,
          amount: xpGenerated,
          type: 'PROGRESS',
          direction: 'CREDIT',
          source: 'TRANSACTION',
          referenceId: txId,
          branch: input.branch,
          cycleId: settings.currentCycleId,
          createdAt: now,
          createdBy: input.admin.uid,
          note: `Transaksi Rp${input.amountIdr.toLocaleString('id-ID')} (${input.branch})`,
        });
        tx.set(doc(db, 'xpRewardLedger', rId), {
          id: rId,
          memberId: member.memberId,
          memberUid: member.uid,
          amount: xpGenerated,
          type: 'REWARD',
          direction: 'CREDIT',
          source: 'TRANSACTION',
          referenceId: txId,
          branch: input.branch,
          cycleId: settings.currentCycleId,
          createdAt: now,
          createdBy: input.admin.uid,
          note: `Transaksi Rp${input.amountIdr.toLocaleString('id-ID')} (${input.branch})`,
        });
      }

      if (!isManualOverride && nextLevel !== member.currentLevel) {
        const lhId = genId('lvl');
        tx.set(doc(db, 'levelHistory', lhId), {
          id: lhId,
          memberId: member.memberId,
          memberUid: member.uid,
          fromLevel: member.currentLevel,
          toLevel: nextLevel,
          xpProgressAtEvent: newProgress,
          source: 'TRANSACTION',
          cycleId: settings.currentCycleId,
          createdAt: now,
        });

        const notifId = genId('notif');
        tx.set(doc(db, 'memberNotifications', notifId), {
          id: notifId,
          memberId: member.memberId,
          memberUid: member.uid,
          notificationCampaignId: null,
          category: 'LEVEL_UP',
          title: `Level Up: ${levelEval.current.name}!`,
          message: `Selamat! XP Progress Anda mencapai ${newProgress} XP dan naik ke level ${levelEval.current.name}.`,
          read: false,
          readAt: null,
          status: 'SENT',
          sentAt: now,
          createdAt: now,
        });
      }

      const auditId = genId('audit');
      tx.set(doc(db, 'auditLogs', auditId), {
        id: auditId,
        actorId: input.admin.uid,
        actorRole: input.admin.role,
        action: 'TRANSACTION_XP',
        targetType: 'transaction',
        targetId: txId,
        before: {
          xpProgress: member.xpProgress,
          xpReward: member.xpReward,
          currentLevel: member.currentLevel,
        },
        after: {
          xpProgress: newProgress,
          xpReward: newReward,
          currentLevel: nextLevel,
          amountIdr: input.amountIdr,
          xpGenerated,
          branch: input.branch,
        },
        metadata: { receiptNumber: txRecord.receiptNumber },
        timestamp: now,
      });

      return { xpGenerated, newProgress, newReward, newLevel: nextLevel };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'transactions');
  }
}

export async function reviewClaimByAdmin(input: {
  claimId: string;
  decision: 'APPROVED' | 'DENIED';
  reason?: string;
  admin: AdminUser;
  adminSdkConfigured: boolean;
}): Promise<void> {
  if (input.adminSdkConfigured) {
    const token = await getAuthBearer();
    const res = await fetch(`/api/admin/claims/${input.claimId}/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ decision: input.decision, reason: input.reason }),
    });
    const data = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(data.error || 'Gagal memproses claim.');
    return;
  }

  const { settings, levels } = await getSettingsAndLevelsClient();

  try {
    await runTransaction(db, async (tx) => {
      const now = Date.now();
      const claimRef = doc(db, 'claims', input.claimId);
      const claimSnap = await tx.get(claimRef);
      if (!claimSnap.exists()) throw new Error('Claim tidak ditemukan.');

      const claim = claimSnap.data() as ClaimRecord;
      if (claim.status !== 'ON_PROCESS') {
        throw new Error(`Claim sudah diproses sebelumnya (${claim.status}).`);
      }

      const memberRef = doc(db, 'members', claim.memberUid);
      const campaignRef = doc(db, 'campaigns', claim.campaignId);
      const [memberSnap, campaignSnap] = await Promise.all([
        tx.get(memberRef),
        tx.get(campaignRef),
      ]);
      if (!memberSnap.exists()) throw new Error('Member tidak ditemukan.');
      const member = memberSnap.data() as MemberProfile;

      if (input.decision === 'DENIED') {
        const denialReason = (input.reason || 'Bukti belum memenuhi ketentuan.').trim().slice(0, 300);
        tx.update(claimRef, {
          status: 'DENIED',
          reviewedBy: input.admin.uid,
          reviewerRole: input.admin.role,
          reviewedAt: now,
          denialReason,
        });

        const notifId = genId('notif');
        tx.set(doc(db, 'memberNotifications', notifId), {
          id: notifId,
          memberId: member.memberId,
          memberUid: member.uid,
          notificationCampaignId: null,
          category: 'CLAIM',
          title: `Claim Ditolak: ${claim.campaignTitle}`,
          message: `Pengajuan claim Anda ditolak. Alasan: ${denialReason}`,
          read: false,
          readAt: null,
          status: 'SENT',
          sentAt: now,
          createdAt: now,
        });

        const auditId = genId('audit');
        tx.set(doc(db, 'auditLogs', auditId), {
          id: auditId,
          actorId: input.admin.uid,
          actorRole: input.admin.role,
          action: 'CLAIM_DENY',
          targetType: 'claim',
          targetId: claim.id,
          before: { status: 'ON_PROCESS' },
          after: { status: 'DENIED', denialReason },
          metadata: null,
          timestamp: now,
        });
        return;
      }

      if (campaignSnap.exists()) {
        const campData = campaignSnap.data() as CampaignItem;
        if (campData.totalClaimLimit !== null && campData.claimsCount >= campData.totalClaimLimit) {
          throw new Error('Kuota total claim program ini telah habis.');
        }
        tx.update(campaignRef, {
          claimsCount: (campData.claimsCount || 0) + 1,
          updatedAt: now,
        });
      }

      const xpAward = claim.xpRewardSnapshot;
      const newProgress = member.xpProgress + xpAward;
      const newReward = member.xpReward + xpAward;
      const isManualOverride = member.levelMode === 'MANUAL_OVERRIDE';
      const levelEval = resolveLevelFromXp(newProgress, levels);
      const nextLevel: LevelId = isManualOverride ? member.currentLevel : levelEval.current.id;
      const nextLevelMode: LevelMode = isManualOverride ? 'MANUAL_OVERRIDE' : 'AUTOMATIC';

      tx.update(claimRef, {
        status: 'APPROVED',
        reviewedBy: input.admin.uid,
        reviewerRole: input.admin.role,
        reviewedAt: now,
        denialReason: null,
      });

      tx.update(memberRef, {
        xpProgress: newProgress,
        xpReward: newReward,
        currentLevel: nextLevel,
        levelMode: nextLevelMode,
        updatedAt: now,
      });

      const pId = genId('xpp');
      const rId = genId('xpr');
      tx.set(doc(db, 'xpProgressLedger', pId), {
        id: pId,
        memberId: member.memberId,
        memberUid: member.uid,
        amount: xpAward,
        type: 'PROGRESS',
        direction: 'CREDIT',
        source: claim.campaignType,
        referenceId: claim.id,
        branch: null,
        cycleId: settings.currentCycleId,
        createdAt: now,
        createdBy: input.admin.uid,
        note: `Claim disetujui: ${claim.campaignTitle}`,
      });
      tx.set(doc(db, 'xpRewardLedger', rId), {
        id: rId,
        memberId: member.memberId,
        memberUid: member.uid,
        amount: xpAward,
        type: 'REWARD',
        direction: 'CREDIT',
        source: claim.campaignType,
        referenceId: claim.id,
        branch: null,
        cycleId: settings.currentCycleId,
        createdAt: now,
        createdBy: input.admin.uid,
        note: `Claim disetujui: ${claim.campaignTitle}`,
      });

      if (!isManualOverride && nextLevel !== member.currentLevel) {
        const lhId = genId('lvl');
        tx.set(doc(db, 'levelHistory', lhId), {
          id: lhId,
          memberId: member.memberId,
          memberUid: member.uid,
          fromLevel: member.currentLevel,
          toLevel: nextLevel,
          xpProgressAtEvent: newProgress,
          source: claim.campaignType,
          cycleId: settings.currentCycleId,
          createdAt: now,
        });
      }

      const notifId = genId('notif');
      tx.set(doc(db, 'memberNotifications', notifId), {
        id: notifId,
        memberId: member.memberId,
        memberUid: member.uid,
        notificationCampaignId: null,
        category: 'CLAIM',
        title: `Claim Disetujui (+${xpAward} XP)`,
        message: `Claim "${claim.campaignTitle}" telah disetujui! XP Progress dan XP Reward bertambah ${xpAward} XP.`,
        read: false,
        readAt: null,
        status: 'SENT',
        sentAt: now,
        createdAt: now,
      });

      const auditId = genId('audit');
      tx.set(doc(db, 'auditLogs', auditId), {
        id: auditId,
        actorId: input.admin.uid,
        actorRole: input.admin.role,
        action: 'CLAIM_APPROVE',
        targetType: 'claim',
        targetId: claim.id,
        before: { status: 'ON_PROCESS', xpProgress: member.xpProgress, xpReward: member.xpReward },
        after: { status: 'APPROVED', xpProgress: newProgress, xpReward: newReward },
        metadata: null,
        timestamp: now,
      });
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `claims/${input.claimId}`);
  }
}

export async function reviewRedemptionByAdmin(input: {
  redemptionId: string;
  decision: 'APPROVED' | 'DENIED';
  reason?: string;
  admin: AdminUser;
  adminSdkConfigured: boolean;
}): Promise<void> {
  if (input.adminSdkConfigured) {
    const token = await getAuthBearer();
    const res = await fetch(`/api/admin/redemptions/${input.redemptionId}/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ decision: input.decision, reason: input.reason }),
    });
    const data = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(data.error || 'Gagal memproses redemption.');
    return;
  }

  const { settings, levels } = await getSettingsAndLevelsClient();

  try {
    await runTransaction(db, async (tx) => {
      const now = Date.now();
      const redRef = doc(db, 'redemptions', input.redemptionId);
      const redSnap = await tx.get(redRef);
      if (!redSnap.exists()) throw new Error('Redemption tidak ditemukan.');

      const redemption = redSnap.data() as RedemptionRecord;
      if (redemption.status !== 'ON_PROCESS') {
        throw new Error(`Redemption sudah diproses sebelumnya (${redemption.status}).`);
      }

      const memberRef = doc(db, 'members', redemption.memberUid);
      const memberSnap = await tx.get(memberRef);
      if (!memberSnap.exists()) throw new Error('Member tidak ditemukan.');
      const member = memberSnap.data() as MemberProfile;

      const benefitRef = doc(db, 'benefits', redemption.benefitId);
      const benefitSnap = await tx.get(benefitRef);

      if (input.decision === 'DENIED') {
        const denialReason = (input.reason || 'Penukaran benefit ditolak admin.').trim().slice(0, 300);
        tx.update(redRef, {
          status: 'DENIED',
          reviewedBy: input.admin.uid,
          reviewerRole: input.admin.role,
          reviewedAt: now,
          denialReason,
        });

        const notifId = genId('notif');
        tx.set(doc(db, 'memberNotifications', notifId), {
          id: notifId,
          memberId: member.memberId,
          memberUid: member.uid,
          notificationCampaignId: null,
          category: 'REDEMPTION',
          title: `Redemption Ditolak: ${redemption.benefitName}`,
          message: `Permintaan redeem Anda ditolak (${denialReason}). Saldo XP Reward Anda tidak berkurang.`,
          read: false,
          readAt: null,
          status: 'SENT',
          sentAt: now,
          createdAt: now,
        });

        const auditId = genId('audit');
        tx.set(doc(db, 'auditLogs', auditId), {
          id: auditId,
          actorId: input.admin.uid,
          actorRole: input.admin.role,
          action: 'REDEMPTION_DENY',
          targetType: 'redemption',
          targetId: redemption.id,
          before: { status: 'ON_PROCESS', xpReward: member.xpReward },
          after: { status: 'DENIED', xpReward: member.xpReward, denialReason },
          metadata: null,
          timestamp: now,
        });
        return;
      }

      const effectiveLevel = resolveEffectiveMemberLevel(member, levels).id;
      if (!isLevelEligible(effectiveLevel, redemption.levelRequirement, levels)) {
        throw new Error(`Level member (${effectiveLevel}) belum memenuhi syarat (${redemption.levelRequirement}).`);
      }

      const cost = redemption.xpCostSnapshot;
      if (member.xpReward < cost) {
        throw new Error('XP Reward member tidak mencukupi.');
      }

      if (benefitSnap.exists()) {
        const bData = benefitSnap.data() as BenefitItem;
        if (typeof bData.stock === 'number') {
          if (bData.stock <= 0) throw new Error('Stok benefit sudah habis.');
          tx.update(benefitRef, { stock: bData.stock - 1, updatedAt: now });
        }
      }

      // CRITICAL INVARIANT: Deduct ONLY xpReward; xpProgress & currentLevel stay unchanged!
      const newReward = member.xpReward - cost;

      tx.update(redRef, {
        status: 'APPROVED',
        reviewedBy: input.admin.uid,
        reviewerRole: input.admin.role,
        reviewedAt: now,
        denialReason: null,
      });

      tx.update(memberRef, {
        xpReward: newReward,
        updatedAt: now,
      });

      if (cost > 0) {
        const rId = genId('xpr');
        tx.set(doc(db, 'xpRewardLedger', rId), {
          id: rId,
          memberId: member.memberId,
          memberUid: member.uid,
          amount: -cost,
          type: 'REWARD',
          direction: 'DEBIT',
          source: 'REDEMPTION',
          referenceId: redemption.id,
          branch: null,
          cycleId: settings.currentCycleId,
          createdAt: now,
          createdBy: input.admin.uid,
          note: `Redeem benefit: ${redemption.benefitName}`,
        });
      }

      const notifId = genId('notif');
      tx.set(doc(db, 'memberNotifications', notifId), {
        id: notifId,
        memberId: member.memberId,
        memberUid: member.uid,
        notificationCampaignId: null,
        category: 'REDEMPTION',
        title: `Redemption Disetujui: ${redemption.benefitName}`,
        message: `Benefit "${redemption.benefitName}" disetujui. Sisa XP Reward Anda: ${newReward} XP.`,
        read: false,
        readAt: null,
        status: 'SENT',
        sentAt: now,
        createdAt: now,
      });

      const auditId = genId('audit');
      tx.set(doc(db, 'auditLogs', auditId), {
        id: auditId,
        actorId: input.admin.uid,
        actorRole: input.admin.role,
        action: 'REDEMPTION_APPROVE',
        targetType: 'redemption',
        targetId: redemption.id,
        before: { status: 'ON_PROCESS', xpProgress: member.xpProgress, xpReward: member.xpReward, level: member.currentLevel },
        after: { status: 'APPROVED', xpProgress: member.xpProgress, xpReward: newReward, level: member.currentLevel },
        metadata: null,
        timestamp: now,
      });
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `redemptions/${input.redemptionId}`);
  }
}

export async function updateMemberStatusByAdmin(
  uid: string,
  status: MemberStatus,
  admin: AdminUser
): Promise<void> {
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, 'members', uid);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('Member tidak ditemukan.');
      const prev = snap.data() as MemberProfile;
      const now = Date.now();
      tx.update(ref, { status, updatedAt: now });

      const auditId = genId('audit');
      tx.set(doc(db, 'auditLogs', auditId), {
        id: auditId,
        actorId: admin.uid,
        actorRole: admin.role,
        action: `MEMBER_STATUS_${status}`,
        targetType: 'member',
        targetId: uid,
        before: { status: prev.status },
        after: { status },
        metadata: null,
        timestamp: now,
      });
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `members/${uid}`);
  }
}

export async function updateMemberDetailsByAdmin(
  uid: string,
  patch: { fullName: string; socialMedia: string; preferredBranch: BranchId | null },
  admin: AdminUser
): Promise<void> {
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, 'members', uid);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('Member tidak ditemukan.');
      const prev = snap.data() as MemberProfile;
      const now = Date.now();
      tx.update(ref, {
        fullName: patch.fullName.trim(),
        socialMedia: patch.socialMedia.trim().slice(0, 100),
        preferredBranch: patch.preferredBranch,
        updatedAt: now,
      });

      const auditId = genId('audit');
      tx.set(doc(db, 'auditLogs', auditId), {
        id: auditId,
        actorId: admin.uid,
        actorRole: admin.role,
        action: 'MEMBER_EDIT',
        targetType: 'member',
        targetId: uid,
        before: { fullName: prev.fullName, socialMedia: prev.socialMedia, preferredBranch: prev.preferredBranch },
        after: patch,
        metadata: null,
        timestamp: now,
      });
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `members/${uid}`);
  }
}

export async function upsertBenefitByAdmin(benefit: BenefitItem, admin: AdminUser): Promise<void> {
  const now = Date.now();
  const payload = { ...benefit, updatedAt: now };
  try {
    await setDoc(doc(db, 'benefits', benefit.id), payload);
    const auditId = genId('audit');
    await setDoc(doc(db, 'auditLogs', auditId), {
      id: auditId,
      actorId: admin.uid,
      actorRole: admin.role,
      action: 'BENEFIT_SAVE',
      targetType: 'benefit',
      targetId: benefit.id,
      before: null,
      after: { name: benefit.name, xpCost: benefit.xpCost, levelRequirement: benefit.levelRequirement, active: benefit.active },
      metadata: null,
      timestamp: now,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `benefits/${benefit.id}`);
  }
}

export async function upsertCampaignByAdmin(campaign: CampaignItem, admin: AdminUser): Promise<void> {
  const now = Date.now();
  const payload = { ...campaign, updatedAt: now };
  try {
    await setDoc(doc(db, 'campaigns', campaign.id), payload);
    const auditId = genId('audit');
    await setDoc(doc(db, 'auditLogs', auditId), {
      id: auditId,
      actorId: admin.uid,
      actorRole: admin.role,
      action: `${campaign.type}_SAVE`,
      targetType: 'campaign',
      targetId: campaign.id,
      before: null,
      after: { title: campaign.title, type: campaign.type, xpReward: campaign.xpReward, status: campaign.status },
      metadata: null,
      timestamp: now,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `campaigns/${campaign.id}`);
  }
}

export async function saveLevelsByAdmin(levels: LevelConfig[], admin: AdminUser): Promise<void> {
  const check = validateLevelThresholds(levels);
  if (!check.valid) throw new Error(check.error);

  const now = Date.now();
  try {
    const batch = writeBatch(db);
    for (const lvl of levels) {
      batch.set(doc(db, 'levels', lvl.id), lvl);
    }
    const auditId = genId('audit');
    batch.set(doc(db, 'auditLogs', auditId), {
      id: auditId,
      actorId: admin.uid,
      actorRole: admin.role,
      action: 'LEVEL_CONFIG_UPDATE',
      targetType: 'levels',
      targetId: 'all',
      before: null,
      after: { thresholds: levels.map((l) => ({ id: l.id, minXp: l.minXp })) },
      metadata: null,
      timestamp: now,
    });
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'levels');
  }
}

export async function saveSystemSettingsByAdmin(
  settings: SystemSettings,
  admin: AdminUser
): Promise<void> {
  if (
    !Number.isSafeInteger(settings.transactionXpRate) ||
    settings.transactionXpRate < 100 ||
    settings.transactionXpRate > 10000000
  ) {
    throw new Error('Rate XP transaksi harus antara Rp100 hingga Rp10.000.000 per 1 XP.');
  }
  if (
    !Number.isSafeInteger(settings.registrationBonusXp) ||
    settings.registrationBonusXp < 0 ||
    settings.registrationBonusXp > 10000
  ) {
    throw new Error('Bonus registrasi harus bilangan bulat antara 0 hingga 10.000 XP.');
  }
  if (
    !Number.isSafeInteger(settings.referralBonusXp) ||
    settings.referralBonusXp < 0 ||
    settings.referralBonusXp > 10000
  ) {
    throw new Error('Bonus referral harus bilangan bulat antara 0 hingga 10.000 XP.');
  }
  if (
    !Number.isSafeInteger(settings.resetInterval) ||
    settings.resetInterval < 1 ||
    settings.resetInterval > 3650
  ) {
    throw new Error('Interval reset harus antara 1 hingga 3.650.');
  }
  const now = Date.now();
  try {
    await setDoc(doc(db, 'systemSettings', 'default'), {
      ...settings,
      updatedAt: now,
      updatedBy: admin.uid,
    });
    const auditId = genId('audit');
    await setDoc(doc(db, 'auditLogs', auditId), {
      id: auditId,
      actorId: admin.uid,
      actorRole: admin.role,
      action: 'SYSTEM_SETTINGS_UPDATE',
      targetType: 'systemSettings',
      targetId: 'default',
      before: null,
      after: {
        transactionXpRate: settings.transactionXpRate,
        registrationBonusXp: settings.registrationBonusXp,
        referralBonusXp: settings.referralBonusXp,
        resetEnabled: settings.resetEnabled,
      },
      metadata: null,
      timestamp: now,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'systemSettings/default');
  }
}

export async function upsertBranchByAdmin(branch: BranchInfo, admin: AdminUser): Promise<void> {
  try {
    await setDoc(doc(db, 'branches', branch.id), branch);
    const auditId = genId('audit');
    await setDoc(doc(db, 'auditLogs', auditId), {
      id: auditId,
      actorId: admin.uid,
      actorRole: admin.role,
      action: 'BRANCH_UPDATE',
      targetType: 'branch',
      targetId: branch.id,
      before: null,
      after: { name: branch.name, active: branch.active },
      metadata: null,
      timestamp: Date.now(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `branches/${branch.id}`);
  }
}

export async function upsertAdminUserBySuperAdmin(
  targetAdmin: AdminUser,
  actor: AdminUser
): Promise<void> {
  const now = Date.now();
  try {
    await setDoc(doc(db, 'admins', targetAdmin.uid), {
      ...targetAdmin,
      updatedAt: now,
    });
    const auditId = genId('audit');
    await setDoc(doc(db, 'auditLogs', auditId), {
      id: auditId,
      actorId: actor.uid,
      actorRole: actor.role,
      action: 'ADMIN_USER_SAVE',
      targetType: 'admin',
      targetId: targetAdmin.uid,
      before: null,
      after: { email: targetAdmin.email, role: targetAdmin.role, active: targetAdmin.active },
      metadata: null,
      timestamp: now,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `admins/${targetAdmin.uid}`);
  }
}

export async function createAndDispatchNotificationByAdmin(input: {
  title: string;
  message: string;
  targetType: NotificationCampaign['targetType'];
  targetFilter: string;
  inactivityDays: number | null;
  branchFilter?: 'ALL' | BranchId;
  levelFilter?: 'ALL' | LevelId;
  includeNeverPlayed?: boolean;
  dedupeDaily?: boolean;
  admin: AdminUser;
}): Promise<{ campaignId: string; dispatchedCount: number; skippedDuplicateCount: number }> {
  const now = Date.now();
  const campaignId = genId('ncamp');

  const campaign: NotificationCampaign = {
    id: campaignId,
    title: input.title.trim(),
    message: input.message.trim(),
    targetType: input.targetType,
    targetFilter: input.targetFilter.trim(),
    inactivityDays: input.inactivityDays,
    startAt: now,
    endAt: null,
    active: true,
    status: 'ACTIVE',
    createdBy: input.admin.uid,
    createdAt: now,
  };

  try {
    await setDoc(doc(db, 'notifications', campaignId), campaign);

    const normalizedFilter = input.targetFilter.trim().toUpperCase();
    const includeNeverPlayed = input.includeNeverPlayed ?? true;
    const dedupeKey =
      input.targetType === 'INACTIVE_MEMBERS' && input.dedupeDaily !== false && input.inactivityDays
        ? buildInactiveNotificationDedupeKey({
            inactivityDays: input.inactivityDays,
            branch: input.branchFilter,
            level: input.levelFilter,
            now,
          })
        : null;

    // Single-field where queries avoid missing composite indexes; filter secondary conditions safely in loop
    const baseConstraints: QueryConstraint[] = [];
    if (input.targetType === 'LEVEL' && normalizedFilter) {
      baseConstraints.push(where('currentLevel', '==', normalizedFilter));
    } else if (input.targetType === 'BRANCH' && normalizedFilter) {
      baseConstraints.push(where('lastPlayBranch', '==', normalizedFilter));
    } else if (input.targetType === 'SPECIFIC_MEMBER' && input.targetFilter.trim()) {
      baseConstraints.push(where('username', '==', normalizeUsername(input.targetFilter)));
    } else {
      baseConstraints.push(where('status', '==', 'ACTIVE'));
    }

    let dispatchedCount = 0;
    let skippedDuplicateCount = 0;
    let cursor: QueryDocumentSnapshot<DocumentData> | null = null;

    while (true) {
      const parts: QueryConstraint[] = [...baseConstraints, limit(100)];
      if (cursor) parts.push(startAfter(cursor));

      const snap = await getDocs(query(collection(db, 'members'), ...parts));
      if (snap.empty) break;

      const batch = writeBatch(db);
      let batchCount = 0;
      for (const d of snap.docs) {
        const m = d.data() as MemberProfile;
        if (m.status !== 'ACTIVE') continue;

        if (input.targetType === 'INACTIVE_MEMBERS' && input.inactivityDays) {
          if (!isMemberInactive(m, input.inactivityDays, now, includeNeverPlayed)) {
            continue;
          }
          if (input.branchFilter && input.branchFilter !== 'ALL') {
            const effBranch = m.lastPlayBranch ?? m.preferredBranch;
            if (effBranch !== input.branchFilter) continue;
          }
          if (input.levelFilter && input.levelFilter !== 'ALL' && m.currentLevel !== input.levelFilter) {
            continue;
          }
        }

        // Deterministic ID prevents duplicate notifications for the same campaign OR same daily inactive cohort
        const notifId = dedupeKey ? `${dedupeKey}__${m.uid}` : `${campaignId}__${m.uid}`;
        if (dedupeKey) {
          const existingNotif = await getDoc(doc(db, 'memberNotifications', notifId));
          if (existingNotif.exists()) {
            skippedDuplicateCount++;
            continue;
          }
        }

        const payload: MemberNotification = {
          id: notifId,
          memberId: m.memberId,
          memberUid: m.uid,
          notificationCampaignId: campaignId,
          category: input.targetType === 'INACTIVE_MEMBERS' ? 'INACTIVITY' : 'PROMO',
          title: campaign.title,
          message: campaign.message,
          read: false,
          readAt: null,
          status: 'SENT',
          sentAt: now,
          createdAt: now,
        };
        batch.set(doc(db, 'memberNotifications', notifId), payload);
        dispatchedCount++;
        batchCount++;
      }
      if (batchCount > 0) {
        await batch.commit();
      }
      cursor = snap.docs[snap.docs.length - 1];
      if (snap.size < 100) break;
    }

    const auditId = genId('audit');
    await setDoc(doc(db, 'auditLogs', auditId), {
      id: auditId,
      actorId: input.admin.uid,
      actorRole: input.admin.role,
      action: 'NOTIFICATION_DISPATCH',
      targetType: 'notification',
      targetId: campaignId,
      before: null,
      after: {
        targetType: input.targetType,
        dispatchedCount,
        skippedDuplicateCount,
        inactivityDays: input.inactivityDays,
      },
      metadata: dedupeKey ? { dedupeKey } : null,
      timestamp: now,
    });

    return { campaignId, dispatchedCount, skippedDuplicateCount };
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `notifications/${campaignId}`);
  }
}

export async function executeCycleResetByAdmin(input: {
  nextCycleId: string;
  nextCycleName: string;
  resetReason: string;
  admin: AdminUser;
  adminSdkConfigured: boolean;
}): Promise<{ prevCycleId: string; nextCycleId: string; processedMembers: number }> {
  if (input.adminSdkConfigured) {
    const token = await getAuthBearer();
    const res = await fetch('/api/admin/reset-cycle/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        nextCycleId: input.nextCycleId,
        nextCycleName: input.nextCycleName,
        resetReason: input.resetReason,
      }),
    });
    const data = (await res.json()) as {
      prevCycleId?: string;
      nextCycleId?: string;
      processedMembers?: number;
      error?: string;
    };
    if (!res.ok) throw new Error(data.error || 'Gagal menjalankan reset cycle.');
    return {
      prevCycleId: data.prevCycleId || '',
      nextCycleId: data.nextCycleId || input.nextCycleId,
      processedMembers: data.processedMembers || 0,
    };
  }

  const nextCycleId = input.nextCycleId.trim();
  if (nextCycleId.length < 2) throw new Error('ID Cycle baru minimal 2 karakter.');

  try {
    const { settings } = await getSettingsAndLevelsClient();
    if (settings.currentCycleId === nextCycleId) {
      throw new Error(`Cycle ${nextCycleId} sudah aktif.`);
    }

    const nextCycleRef = doc(db, 'membershipCycles', nextCycleId);
    const nextCycleSnap = await getDoc(nextCycleRef);
    if (nextCycleSnap.exists()) {
      throw new Error(`Cycle ${nextCycleId} sudah pernah ada. Gunakan ID baru untuk menjaga idempotency.`);
    }

    const now = Date.now();
    const prevCycleId = settings.currentCycleId;
    let processedMembers = 0;
    let cursor: QueryDocumentSnapshot<DocumentData> | null = null;

    while (true) {
      const parts: QueryConstraint[] = [orderBy('createdAt', 'asc'), limit(100)];
      if (cursor) parts.push(startAfter(cursor));

      const snap = await getDocs(query(collection(db, 'members'), ...parts));
      if (snap.empty) break;

      const batch = writeBatch(db);
      for (const mDoc of snap.docs) {
        const m = mDoc.data() as MemberProfile;
        if (m.currentCycleId === nextCycleId) continue;

        const newProgress = settings.resetXpProgress ? 0 : m.xpProgress;
        const newReward = settings.resetXpReward ? 0 : m.xpReward;
        const newLevel: LevelId = settings.resetLevel ? 'BRONZE' : m.currentLevel;
        const newLevelMode: LevelMode = settings.resetLevel
          ? 'RESET'
          : (m.levelMode ?? 'AUTOMATIC');

        const snapId = `${prevCycleId}__${m.uid}`;
        const snapshotDoc: CycleSnapshot = {
          id: snapId,
          memberId: m.memberId,
          memberUid: m.uid,
          memberUsername: m.username,
          cycleId: prevCycleId,
          nextCycleId,
          previousXpProgress: m.xpProgress,
          previousXpReward: m.xpReward,
          previousLevel: m.currentLevel,
          newXpProgress: newProgress,
          newXpReward: newReward,
          newLevel,
          resetAt: now,
          resetReason: input.resetReason,
          executedBy: input.admin.uid,
        };
        batch.set(doc(db, 'cycleSnapshots', snapId), snapshotDoc);

        batch.update(mDoc.ref, {
          xpProgress: newProgress,
          xpReward: newReward,
          currentLevel: newLevel,
          levelMode: newLevelMode,
          currentCycleId: nextCycleId,
          updatedAt: now,
        });

        if (settings.resetXpProgress && m.xpProgress > 0) {
          const lid = genId('xpp');
          batch.set(doc(db, 'xpProgressLedger', lid), {
            id: lid,
            memberId: m.memberId,
            memberUid: m.uid,
            amount: -m.xpProgress,
            type: 'PROGRESS',
            direction: 'DEBIT',
            source: 'RESET',
            referenceId: nextCycleId,
            branch: null,
            cycleId: prevCycleId,
            createdAt: now,
            createdBy: input.admin.uid,
            note: `Reset cycle ke ${nextCycleId}`,
          });
        }

        if (settings.resetXpReward && m.xpReward > 0) {
          const lid = genId('xpr');
          batch.set(doc(db, 'xpRewardLedger', lid), {
            id: lid,
            memberId: m.memberId,
            memberUid: m.uid,
            amount: -m.xpReward,
            type: 'REWARD',
            direction: 'DEBIT',
            source: 'RESET',
            referenceId: nextCycleId,
            branch: null,
            cycleId: prevCycleId,
            createdAt: now,
            createdBy: input.admin.uid,
            note: `Reset cycle ke ${nextCycleId}`,
          });
        }

        const notifId = genId('notif');
        batch.set(doc(db, 'memberNotifications', notifId), {
          id: notifId,
          memberId: m.memberId,
          memberUid: m.uid,
          notificationCampaignId: null,
          category: 'RESET',
          title: `Season Baru: ${input.nextCycleName}`,
          message: `Membership cycle ${prevCycleId} berakhir dan beralih ke ${nextCycleId}. Seluruh riwayat Anda tetap aman.`,
          read: false,
          readAt: null,
          status: 'SENT',
          sentAt: now,
          createdAt: now,
        });

        processedMembers++;
      }
      await batch.commit();
      cursor = snap.docs[snap.docs.length - 1];
      if (snap.size < 100) break;
    }

    const finalBatch = writeBatch(db);
    finalBatch.set(
      doc(db, 'membershipCycles', prevCycleId),
      { status: 'CLOSED', endedAt: now },
      { merge: true }
    );
    const newCycle: MembershipCycle = {
      id: nextCycleId,
      name: input.nextCycleName.trim() || nextCycleId,
      startedAt: now,
      endedAt: null,
      status: 'ACTIVE',
      resetCount: processedMembers,
      createdBy: input.admin.uid,
    };
    finalBatch.set(nextCycleRef, newCycle);

    const intervalMs =
      settings.resetUnit === 'MONTHS'
        ? settings.resetInterval * 30 * 24 * 60 * 60 * 1000
        : settings.resetInterval * 24 * 60 * 60 * 1000;

    finalBatch.set(
      doc(db, 'systemSettings', 'default'),
      {
        ...settings,
        currentCycleId: nextCycleId,
        nextResetAt: settings.resetEnabled ? now + intervalMs : null,
        updatedAt: now,
        updatedBy: input.admin.uid,
      },
      { merge: true }
    );

    const auditId = genId('audit');
    const auditDoc: AuditLogRecord = {
      id: auditId,
      actorId: input.admin.uid,
      actorRole: input.admin.role,
      action: 'CYCLE_RESET',
      targetType: 'membershipCycle',
      targetId: nextCycleId,
      before: { cycleId: prevCycleId },
      after: { cycleId: nextCycleId, processedMembers, reason: input.resetReason },
      metadata: null,
      timestamp: now,
    };
    finalBatch.set(doc(db, 'auditLogs', auditId), auditDoc);
    await finalBatch.commit();

    return { prevCycleId, nextCycleId, processedMembers };
  } catch (err) {
    if (err instanceof Error && (err.message.includes('sudah aktif') || err.message.includes('sudah pernah'))) {
      throw err;
    }
    handleFirestoreError(err, OperationType.WRITE, `membershipCycles/${nextCycleId}`);
  }
}

// ---------- Admin Aggregate Metrics (Efficient Count Queries) ----------
export async function fetchAdminSummaryMetrics() {
  const now = Date.now();
  const d7 = now - 7 * 24 * 60 * 60 * 1000;
  const d14 = now - 14 * 24 * 60 * 60 * 1000;
  const d30 = now - 30 * 24 * 60 * 60 * 1000;

  try {
    const [
      totalMembersSnap,
      activeMembersSnap,
      bronzeSnap,
      silverSnap,
      juraganSnap,
      sultanSnap,
      totalTxSnap,
      pendingClaimsSnap,
      pendingRedemptionsSnap,
      recentTxSnap,
    ] = await Promise.all([
      getCountFromServer(collection(db, 'members')),
      getCountFromServer(query(collection(db, 'members'), where('status', '==', 'ACTIVE'))),
      getCountFromServer(query(collection(db, 'members'), where('currentLevel', '==', 'BRONZE'))),
      getCountFromServer(query(collection(db, 'members'), where('currentLevel', '==', 'SILVER'))),
      getCountFromServer(query(collection(db, 'members'), where('currentLevel', '==', 'JURAGAN'))),
      getCountFromServer(query(collection(db, 'members'), where('currentLevel', '==', 'SULTAN'))),
      getCountFromServer(collection(db, 'transactions')),
      getCountFromServer(query(collection(db, 'claims'), where('status', '==', 'ON_PROCESS'))),
      getCountFromServer(query(collection(db, 'redemptions'), where('status', '==', 'ON_PROCESS'))),
      getDocs(query(collection(db, 'transactions'), orderBy('createdAt', 'desc'), limit(25))),
    ]);

    let inactive7Days = 0;
    let inactive14Days = 0;
    let inactive30Days = 0;
    try {
      const [in7, in14, in30] = await Promise.all([
        getCountFromServer(
          query(collection(db, 'members'), where('status', '==', 'ACTIVE'), where('lastPlayAt', '<=', d7))
        ),
        getCountFromServer(
          query(collection(db, 'members'), where('status', '==', 'ACTIVE'), where('lastPlayAt', '<=', d14))
        ),
        getCountFromServer(
          query(collection(db, 'members'), where('status', '==', 'ACTIVE'), where('lastPlayAt', '<=', d30))
        ),
      ]);
      inactive7Days = in7.data().count;
      inactive14Days = in14.data().count;
      inactive30Days = in30.data().count;
    } catch {
      // Composite index (status, lastPlayAt) fallback without blocking dashboard metrics
      const activeSnap = await getDocs(
        query(collection(db, 'members'), where('status', '==', 'ACTIVE'), limit(250))
      );
      for (const mDoc of activeSnap.docs) {
        const lp = (mDoc.data() as MemberProfile).lastPlayAt;
        if (lp !== null) {
          if (lp <= d7) inactive7Days++;
          if (lp <= d14) inactive14Days++;
          if (lp <= d30) inactive30Days++;
        }
      }
    }

    const recentTransactions = recentTxSnap.docs.map((d) => d.data() as TransactionRecord);
    const recentTxAmount = recentTransactions.reduce((acc, t) => acc + t.amountIdr, 0);
    const recentXpDistributed = recentTransactions.reduce((acc, t) => acc + t.xpGenerated, 0);

    return {
      totalMembers: totalMembersSnap.data().count,
      activeMembers: activeMembersSnap.data().count,
      levelCounts: {
        BRONZE: bronzeSnap.data().count,
        SILVER: silverSnap.data().count,
        JURAGAN: juraganSnap.data().count,
        SULTAN: sultanSnap.data().count,
      },
      totalTransactions: totalTxSnap.data().count,
      recentTxAmount,
      recentXpDistributed,
      pendingClaims: pendingClaimsSnap.data().count,
      pendingRedemptions: pendingRedemptionsSnap.data().count,
      inactive7Days,
      inactive14Days,
      inactive30Days,
      recentTransactions: recentTransactions.slice(0, 6),
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'admin_metrics');
  }
}

// ---------- CMS Homepage (Draft / Preview / Publish / Immutable Version History / Rollback) ----------
export async function fetchPublishedHomepageCms(): Promise<{
  content: HomepageCmsContent;
  meta: { versionId: string; versionNumber: number; publishedAt: number } | null;
}> {
  try {
    const snap = await getDoc(doc(db, 'cmsPublished', 'homepage'));
    if (!snap.exists()) {
      return { content: sanitizeHomepageCmsContent(DEFAULT_HOMEPAGE_CMS), meta: null };
    }
    const data = snap.data() as CmsPublishedDoc;
    return {
      content: sanitizeHomepageCmsContent(data.content),
      meta: {
        versionId: data.versionId,
        versionNumber: data.versionNumber,
        publishedAt: data.publishedAt,
      },
    };
  } catch {
    return { content: sanitizeHomepageCmsContent(DEFAULT_HOMEPAGE_CMS), meta: null };
  }
}

export async function fetchDraftHomepageCms(): Promise<{
  draft: CmsDraftDoc | null;
  content: HomepageCmsContent;
}> {
  try {
    const draftSnap = await getDoc(doc(db, 'cmsDrafts', 'homepage'));
    if (draftSnap.exists()) {
      const data = draftSnap.data() as CmsDraftDoc;
      return {
        draft: data,
        content: sanitizeHomepageCmsContent(data.content),
      };
    }
    const pub = await fetchPublishedHomepageCms();
    return { draft: null, content: pub.content };
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, 'cmsDrafts/homepage');
  }
}

export async function saveHomepageCmsDraft(input: {
  content: HomepageCmsContent;
  admin: AdminUser;
  basePublishedVersionId: string | null;
}): Promise<CmsDraftDoc> {
  if (input.admin.role !== 'SUPER_ADMIN' && input.admin.role !== 'ADMIN') {
    throw new Error('Hanya ADMIN atau SUPER_ADMIN yang dapat mengubah draft CMS.');
  }

  const sec = validateCmsSecurity(input.content);
  if (!sec.valid) {
    throw new Error(sec.error || 'Konten CMS tidak lolos validasi keamanan.');
  }

  const sanitized = sanitizeHomepageCmsContent(input.content);
  const now = Date.now();
  const payload: CmsDraftDoc = {
    id: 'homepage',
    content: sanitized,
    updatedAt: now,
    updatedBy: input.admin.uid,
    updatedByEmail: input.admin.email,
    basePublishedVersionId: input.basePublishedVersionId,
  };

  try {
    await setDoc(doc(db, 'cmsDrafts', 'homepage'), payload);
    const auditId = genId('audit');
    await setDoc(doc(db, 'auditLogs', auditId), {
      id: auditId,
      actorId: input.admin.uid,
      actorRole: input.admin.role,
      action: 'CMS_DRAFT_SAVE',
      targetType: 'cmsDraft',
      targetId: 'homepage',
      before: null,
      after: {
        brandName: sanitized.brandName,
        heroTitle: sanitized.heroTitle,
        basePublishedVersionId: input.basePublishedVersionId,
      },
      metadata: null,
      timestamp: now,
    });
    return payload;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'cmsDrafts/homepage');
  }
}

export async function publishHomepageCms(input: {
  content: HomepageCmsContent;
  admin: AdminUser;
  note?: string;
}): Promise<{ published: CmsPublishedDoc; version: CmsVersionRecord }> {
  if (input.admin.role !== 'SUPER_ADMIN' && input.admin.role !== 'ADMIN') {
    throw new Error('Hanya ADMIN atau SUPER_ADMIN yang dapat mempublikasikan CMS.');
  }

  const sec = validateCmsSecurity(input.content);
  if (!sec.valid) {
    throw new Error(sec.error || 'Konten CMS tidak lolos validasi keamanan.');
  }

  const sanitized = sanitizeHomepageCmsContent(input.content);
  const cleanNote = (input.note || 'Publish pembaruan konten homepage').trim().slice(0, 240);

  try {
    return await runTransaction(db, async (tx) => {
      const now = Date.now();
      const pubRef = doc(db, 'cmsPublished', 'homepage');
      const pubSnap = await tx.get(pubRef);

      const prevVersionNum = pubSnap.exists()
        ? Number((pubSnap.data() as CmsPublishedDoc).versionNumber || 0)
        : 0;
      const prevVersionId = pubSnap.exists()
        ? (pubSnap.data() as CmsPublishedDoc).versionId
        : null;
      const nextVersionNum = prevVersionNum + 1;
      const versionId = `v${nextVersionNum}`;

      const versionDoc: CmsVersionRecord = {
        versionId,
        versionNumber: nextVersionNum,
        content: sanitized,
        createdBy: input.admin.uid,
        createdAt: now,
        publishedBy: input.admin.uid,
        publishedByEmail: input.admin.email,
        publishedAt: now,
        sourceAction: 'PUBLISH',
        restoredFromVersionId: null,
        note: cleanNote,
      };

      const publishedDoc: CmsPublishedDoc = {
        id: 'homepage',
        content: sanitized,
        versionId,
        versionNumber: nextVersionNum,
        publishedAt: now,
        publishedBy: input.admin.uid,
        publishedByEmail: input.admin.email,
        updatedAt: now,
      };

      const draftDoc: CmsDraftDoc = {
        id: 'homepage',
        content: sanitized,
        updatedAt: now,
        updatedBy: input.admin.uid,
        updatedByEmail: input.admin.email,
        basePublishedVersionId: versionId,
      };

      tx.set(doc(db, 'cmsVersions', versionId), versionDoc);
      tx.set(pubRef, publishedDoc);
      tx.set(doc(db, 'cmsDrafts', 'homepage'), draftDoc);

      const auditId = genId('audit');
      tx.set(doc(db, 'auditLogs', auditId), {
        id: auditId,
        actorId: input.admin.uid,
        actorRole: input.admin.role,
        action: 'CMS_PUBLISH',
        targetType: 'cmsPublished',
        targetId: versionId,
        before: prevVersionId ? { versionId: prevVersionId, versionNumber: prevVersionNum } : null,
        after: { versionId, versionNumber: nextVersionNum, note: cleanNote },
        metadata: null,
        timestamp: now,
      });

      return { published: publishedDoc, version: versionDoc };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'cmsPublished/homepage');
  }
}

export async function fetchCmsVersionHistory(maxRows = 30): Promise<CmsVersionRecord[]> {
  try {
    const snap = await getDocs(
      query(collection(db, 'cmsVersions'), orderBy('versionNumber', 'desc'), limit(maxRows))
    );
    return snap.docs.map((d) => d.data() as CmsVersionRecord);
  } catch (err) {
    if (isMissingIndexError(err)) {
      try {
        const fallbackSnap = await getDocs(query(collection(db, 'cmsVersions'), limit(maxRows)));
        return fallbackSnap.docs
          .map((d) => d.data() as CmsVersionRecord)
          .sort((a, b) => b.versionNumber - a.versionNumber);
      } catch (fallbackErr) {
        handleFirestoreError(fallbackErr, OperationType.LIST, 'cmsVersions');
      }
    }
    handleFirestoreError(err, OperationType.LIST, 'cmsVersions');
  }
}

export async function rollbackHomepageCmsVersion(input: {
  targetVersion: CmsVersionRecord;
  admin: AdminUser;
  note?: string;
}): Promise<{ published: CmsPublishedDoc; version: CmsVersionRecord }> {
  if (input.admin.role !== 'SUPER_ADMIN' && input.admin.role !== 'ADMIN') {
    throw new Error('Hanya ADMIN atau SUPER_ADMIN yang dapat melakukan rollback CMS.');
  }

  const sanitized = sanitizeHomepageCmsContent(input.targetVersion.content);
  const sec = validateCmsSecurity(sanitized);
  if (!sec.valid) {
    throw new Error(sec.error || 'Snapshot versi target tidak lolos validasi keamanan.');
  }

  const cleanNote = (
    input.note || `Rollback ke ${input.targetVersion.versionId}`
  ).trim().slice(0, 240);

  try {
    return await runTransaction(db, async (tx) => {
      const now = Date.now();
      const pubRef = doc(db, 'cmsPublished', 'homepage');
      const pubSnap = await tx.get(pubRef);

      const prevVersionNum = pubSnap.exists()
        ? Number((pubSnap.data() as CmsPublishedDoc).versionNumber || 0)
        : 0;
      const prevVersionId = pubSnap.exists()
        ? (pubSnap.data() as CmsPublishedDoc).versionId
        : null;
      const nextVersionNum = prevVersionNum + 1;
      const versionId = `v${nextVersionNum}`;

      const versionDoc: CmsVersionRecord = {
        versionId,
        versionNumber: nextVersionNum,
        content: sanitized,
        createdBy: input.admin.uid,
        createdAt: now,
        publishedBy: input.admin.uid,
        publishedByEmail: input.admin.email,
        publishedAt: now,
        sourceAction: 'ROLLBACK',
        restoredFromVersionId: input.targetVersion.versionId,
        note: cleanNote,
      };

      const publishedDoc: CmsPublishedDoc = {
        id: 'homepage',
        content: sanitized,
        versionId,
        versionNumber: nextVersionNum,
        publishedAt: now,
        publishedBy: input.admin.uid,
        publishedByEmail: input.admin.email,
        updatedAt: now,
      };

      const draftDoc: CmsDraftDoc = {
        id: 'homepage',
        content: sanitized,
        updatedAt: now,
        updatedBy: input.admin.uid,
        updatedByEmail: input.admin.email,
        basePublishedVersionId: versionId,
      };

      tx.set(doc(db, 'cmsVersions', versionId), versionDoc);
      tx.set(pubRef, publishedDoc);
      tx.set(doc(db, 'cmsDrafts', 'homepage'), draftDoc);

      const auditId = genId('audit');
      tx.set(doc(db, 'auditLogs', auditId), {
        id: auditId,
        actorId: input.admin.uid,
        actorRole: input.admin.role,
        action: 'CMS_ROLLBACK',
        targetType: 'cmsPublished',
        targetId: versionId,
        before: prevVersionId ? { versionId: prevVersionId, versionNumber: prevVersionNum } : null,
        after: {
          versionId,
          versionNumber: nextVersionNum,
          restoredFromVersionId: input.targetVersion.versionId,
          note: cleanNote,
        },
        metadata: null,
        timestamp: now,
      });

      return { published: publishedDoc, version: versionDoc };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'cmsPublished/homepage');
  }
}

export async function uploadCmsAsset(file: File): Promise<{
  assetUrl: string;
  assetPath: string;
}> {
  const token = await getAuthBearer();
  const formData = new FormData();
  formData.append('asset', file);

  const res = await fetch('/api/admin/cms/assets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });

  const data = (await res.json()) as {
    assetUrl?: string;
    assetPath?: string;
    error?: string;
  };
  if (!res.ok || !data.assetUrl || !data.assetPath) {
    throw new Error(data.error || 'Gambar CMS gagal diunggah.');
  }
  return {
    assetUrl: data.assetUrl,
    assetPath: data.assetPath,
  };
}

// ---------- Admin XP Adjustment (Phase B — Progress & Reward Separate Adjustments) ----------
export async function adjustMemberXpByAdmin(input: {
  operationId: string;
  kind: XpAdjustmentKind;
  identifier: string;
  memberUid?: string;
  adjustment: number;
  reason: string;
  reference?: string;
  admin: AdminUser;
  adminSdkConfigured: boolean;
}): Promise<{
  record: XpAdjustmentRecord;
  newXpProgress: number;
  newXpReward: number;
  levelAfter: LevelId;
}> {
  if (input.admin.role !== 'SUPER_ADMIN' && input.admin.role !== 'ADMIN') {
    throw new Error('Hanya ADMIN atau SUPER_ADMIN yang dapat melakukan penyesuaian XP.');
  }

  const cleanOpId = (input.operationId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (cleanOpId.length < 6 || cleanOpId.length > 80) {
    throw new Error('Operation ID tidak valid.');
  }

  if (!Number.isSafeInteger(input.adjustment) || input.adjustment === 0) {
    throw new Error('Nilai adjustment harus berupa bilangan bulat selain 0.');
  }

  const cleanReason = (input.reason || '').trim().slice(0, 300);
  if (cleanReason.length < 3) {
    throw new Error('Alasan penyesuaian XP wajib diisi (minimal 3 karakter).');
  }
  const cleanRef = (input.reference || '').trim().slice(0, 120);

  if (input.adminSdkConfigured) {
    const token = await getAuthBearer();
    const res = await fetch('/api/admin/xp-adjustments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        operationId: cleanOpId,
        kind: input.kind,
        identifier: input.identifier,
        memberUid: input.memberUid,
        adjustment: input.adjustment,
        reason: cleanReason,
        reference: cleanRef,
      }),
    });
    const data = (await res.json()) as {
      record?: XpAdjustmentRecord;
      newXpProgress?: number;
      newXpReward?: number;
      levelAfter?: LevelId;
      error?: string;
    };
    if (!res.ok || !data.record) {
      throw new Error(data.error || 'Gagal memproses penyesuaian XP.');
    }
    return {
      record: data.record,
      newXpProgress: data.newXpProgress ?? data.record.afterXpProgress,
      newXpReward: data.newXpReward ?? data.record.afterXpReward,
      levelAfter: data.levelAfter ?? data.record.levelAfter,
    };
  }

  // Client Firestore Transactional Execution (when Admin SDK service account not set)
  let targetUid = (input.memberUid || '').trim();
  if (!targetUid) {
    const found = await findMemberByIdentifierAdmin(input.identifier);
    if (!found) {
      throw new Error('Member dengan username atau nomor WhatsApp tersebut tidak ditemukan.');
    }
    targetUid = found.uid;
  }

  const { settings, levels } = await getSettingsAndLevelsClient();
  const adjDocId = `adj_${cleanOpId}`;

  try {
    return await runTransaction(db, async (tx) => {
      const now = Date.now();
      const adjRef = doc(db, 'xpAdjustments', adjDocId);
      const existingAdj = await tx.get(adjRef);
      if (existingAdj.exists()) {
        throw new Error('Penyesuaian XP dengan ID operasi ini sudah diproses sebelumnya.');
      }

      const memberRef = doc(db, 'members', targetUid);
      const memberSnap = await tx.get(memberRef);
      if (!memberSnap.exists()) {
        throw new Error('Profil member tidak ditemukan.');
      }

      const member = memberSnap.data() as MemberProfile;
      if (member.status === 'DELETED') {
        throw new Error('Member berstatus DELETED dan tidak dapat disesuaikan saldonya.');
      }

      const computed =
        input.kind === 'PROGRESS'
          ? calculateXpProgressAdjustment({
              currentXpProgress: member.xpProgress,
              currentXpReward: member.xpReward,
              currentLevel: member.currentLevel,
              adjustment: input.adjustment,
              levels,
            })
          : calculateXpRewardAdjustment({
              currentXpProgress: member.xpProgress,
              currentXpReward: member.xpReward,
              currentLevel: member.currentLevel,
              adjustment: input.adjustment,
            });

      const auditId = genId('audit');
      const ledgerCollection = input.kind === 'PROGRESS' ? 'xpProgressLedger' : 'xpRewardLedger';
      const ledgerId = genId(input.kind === 'PROGRESS' ? 'xpp' : 'xpr');
      const ledgerSource =
        input.kind === 'PROGRESS' ? 'ADMIN_ADJUSTMENT' : 'XP_REWARD_ADMIN_ADJUSTMENT';

      if (input.kind === 'PROGRESS') {
        tx.update(memberRef, {
          xpProgress: computed.newXpProgress,
          currentLevel: computed.levelAfter,
          levelMode: 'AUTOMATIC',
          updatedAt: now,
        });
      } else {
        tx.update(memberRef, {
          xpReward: computed.newXpReward,
          updatedAt: now,
        });
      }

      const notePrefix =
        input.kind === 'PROGRESS' ? 'Penyesuaian XP Progress' : 'Penyesuaian XP Reward';
      tx.set(doc(db, ledgerCollection, ledgerId), {
        id: ledgerId,
        memberId: member.memberId,
        memberUid: member.uid,
        amount: input.adjustment,
        type: input.kind,
        direction: input.adjustment > 0 ? 'CREDIT' : 'DEBIT',
        source: ledgerSource,
        referenceId: adjDocId,
        branch: null,
        cycleId: settings.currentCycleId,
        createdAt: now,
        createdBy: input.admin.uid,
        note: `${notePrefix}: ${cleanReason}${cleanRef ? ` (Ref: ${cleanRef})` : ''}`.slice(0, 300),
      });

      const adjRecord: XpAdjustmentRecord = {
        id: adjDocId,
        operationId: cleanOpId,
        kind: input.kind,
        memberId: member.memberId,
        memberUid: member.uid,
        memberUsername: member.username,
        adjustment: input.adjustment,
        beforeBalance: computed.beforeBalance,
        afterBalance: computed.afterBalance,
        beforeXpProgress: member.xpProgress,
        afterXpProgress: computed.newXpProgress,
        beforeXpReward: member.xpReward,
        afterXpReward: computed.newXpReward,
        levelBefore: computed.levelBefore,
        levelAfter: computed.levelAfter,
        reason: cleanReason,
        reference: cleanRef,
        auditId,
        adminId: input.admin.uid,
        adminEmail: input.admin.email,
        adminRole: input.admin.role,
        cycleId: settings.currentCycleId,
        timestamp: now,
      };

      tx.set(adjRef, adjRecord);

      if (input.kind === 'PROGRESS' && computed.levelChanged) {
        const lhId = genId('lvl');
        tx.set(doc(db, 'levelHistory', lhId), {
          id: lhId,
          memberId: member.memberId,
          memberUid: member.uid,
          fromLevel: computed.levelBefore,
          toLevel: computed.levelAfter,
          xpProgressAtEvent: computed.newXpProgress,
          source: 'ADMIN_ADJUSTMENT',
          cycleId: settings.currentCycleId,
          createdAt: now,
        });
      }

      const notifId = genId('notif');
      const signStr = input.adjustment > 0 ? `+${input.adjustment}` : `${input.adjustment}`;
      const balanceLabel = input.kind === 'PROGRESS' ? 'XP Progress' : 'XP Reward';
      tx.set(doc(db, 'memberNotifications', notifId), {
        id: notifId,
        memberId: member.memberId,
        memberUid: member.uid,
        notificationCampaignId: null,
        category: 'SYSTEM',
        title: `Penyesuaian ${balanceLabel} (${signStr} XP)`,
        message: `${balanceLabel} Anda disesuaikan sebesar ${signStr} XP (saldo baru: ${computed.afterBalance} XP${
          input.kind === 'PROGRESS' && computed.levelChanged ? `, Level: ${computed.levelAfter}` : ''
        }). Alasan: ${cleanReason}`,
        read: false,
        readAt: null,
        status: 'SENT',
        sentAt: now,
        createdAt: now,
      });

      tx.set(doc(db, 'auditLogs', auditId), {
        id: auditId,
        actorId: input.admin.uid,
        actorRole: input.admin.role,
        action:
          input.kind === 'PROGRESS'
            ? 'XP_PROGRESS_ADMIN_ADJUSTMENT'
            : 'XP_REWARD_ADMIN_ADJUSTMENT',
        targetType: 'member',
        targetId: member.uid,
        before: {
          xpProgress: member.xpProgress,
          xpReward: member.xpReward,
          currentLevel: member.currentLevel,
        },
        after: {
          xpProgress: computed.newXpProgress,
          xpReward: computed.newXpReward,
          currentLevel: computed.levelAfter,
        },
        metadata: {
          adjustmentId: adjDocId,
          operationId: cleanOpId,
          kind: input.kind,
          adjustment: input.adjustment,
          reason: cleanReason,
          reference: cleanRef,
          memberId: member.memberId,
          memberUsername: member.username,
        },
        timestamp: now,
      });

      return {
        record: adjRecord,
        newXpProgress: computed.newXpProgress,
        newXpReward: computed.newXpReward,
        levelAfter: computed.levelAfter,
      };
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('sudah diproses') ||
        err.message.includes('tidak boleh negatif') ||
        err.message.includes('tidak ditemukan') ||
        err.message.includes('DELETED') ||
        err.message.includes('bilangan bulat') ||
        err.message.includes('wajib diisi'))
    ) {
      throw err;
    }
    handleFirestoreError(err, OperationType.WRITE, `xpAdjustments/${adjDocId}`);
  }
}

export async function fetchRecentXpAdjustments(input?: {
  kindFilter?: 'ALL' | XpAdjustmentKind;
  pageSize?: number;
  cursor?: QueryDocumentSnapshot<DocumentData> | null;
}): Promise<PaginatedResult<XpAdjustmentRecord>> {
  const constraints: QueryConstraint[] = [];
  if (input?.kindFilter && input.kindFilter !== 'ALL') {
    constraints.push(where('kind', '==', input.kindFilter));
  }
  return fetchPaginatedCollection<XpAdjustmentRecord>({
    collectionName: 'xpAdjustments',
    constraints,
    orderByField: 'timestamp',
    orderDirection: 'desc',
    pageSize: input?.pageSize ?? 15,
    cursor: input?.cursor ?? null,
  });
}

// ---------- Admin Force Level Override & Recalculate (Phase C) ----------
export async function overrideMemberLevelByAdmin(input: {
  operationId: string;
  action: LevelOverrideAction;
  identifier: string;
  memberUid?: string;
  targetLevel?: LevelId;
  reason: string;
  reference?: string;
  admin: AdminUser;
  adminSdkConfigured: boolean;
}): Promise<{
  record: LevelOverrideRecord;
  newLevel: LevelId;
  newLevelMode: 'AUTOMATIC' | 'MANUAL_OVERRIDE';
}> {
  if (input.admin.role !== 'SUPER_ADMIN' && input.admin.role !== 'ADMIN') {
    throw new Error('Hanya ADMIN atau SUPER_ADMIN yang dapat mengubah level member.');
  }

  const cleanOpId = (input.operationId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (cleanOpId.length < 6 || cleanOpId.length > 80) {
    throw new Error('Operation ID tidak valid.');
  }

  const cleanReason = (input.reason || '').trim().slice(0, 300);
  if (cleanReason.length < 3) {
    throw new Error('Alasan perubahan level wajib diisi (minimal 3 karakter).');
  }
  const cleanRef = (input.reference || '').trim().slice(0, 120);

  if (input.adminSdkConfigured) {
    const token = await getAuthBearer();
    const res = await fetch('/api/admin/level-overrides', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        operationId: cleanOpId,
        action: input.action,
        identifier: input.identifier,
        memberUid: input.memberUid,
        targetLevel: input.targetLevel,
        reason: cleanReason,
        reference: cleanRef,
      }),
    });
    const data = (await res.json()) as {
      record?: LevelOverrideRecord;
      newLevel?: LevelId;
      newLevelMode?: 'AUTOMATIC' | 'MANUAL_OVERRIDE';
      error?: string;
    };
    if (!res.ok || !data.record) {
      throw new Error(data.error || 'Gagal memproses level override.');
    }
    return {
      record: data.record,
      newLevel: data.newLevel ?? data.record.newLevel,
      newLevelMode: data.newLevelMode ?? data.record.newLevelMode,
    };
  }

  // Client Firestore Transactional Execution (when Admin SDK service account not set)
  let targetUid = (input.memberUid || '').trim();
  if (!targetUid) {
    const found = await findMemberByIdentifierAdmin(input.identifier);
    if (!found) {
      throw new Error('Member dengan username atau nomor WhatsApp tersebut tidak ditemukan.');
    }
    targetUid = found.uid;
  }

  const { settings, levels } = await getSettingsAndLevelsClient();
  const ovrDocId = `ovr_${cleanOpId}`;

  try {
    return await runTransaction(db, async (tx) => {
      const now = Date.now();
      const ovrRef = doc(db, 'levelOverrides', ovrDocId);
      const existingOvr = await tx.get(ovrRef);
      if (existingOvr.exists()) {
        throw new Error('Operasi Level Override dengan ID ini sudah diproses sebelumnya.');
      }

      const memberRef = doc(db, 'members', targetUid);
      const memberSnap = await tx.get(memberRef);
      if (!memberSnap.exists()) {
        throw new Error('Profil member tidak ditemukan.');
      }

      const member = memberSnap.data() as MemberProfile;
      if (member.status === 'DELETED') {
        throw new Error('Member berstatus DELETED dan tidak dapat diubah levelnya.');
      }

      const computed =
        input.action === 'MANUAL_OVERRIDE'
          ? calculateManualLevelOverride({
              currentXpProgress: member.xpProgress,
              currentLevel: member.currentLevel,
              currentLevelMode: member.levelMode,
              targetLevel: input.targetLevel as LevelId,
            })
          : calculateRecalculateLevelFromXp({
              currentXpProgress: member.xpProgress,
              currentLevel: member.currentLevel,
              currentLevelMode: member.levelMode,
              levels,
            });

      // CRITICAL INVARIANT: XP Progress & XP Reward NEVER change on level override / recalculate!
      tx.update(memberRef, {
        currentLevel: computed.newLevel,
        levelMode: computed.newLevelMode,
        updatedAt: now,
      });

      const auditId = genId('audit');
      const overrideRecord: LevelOverrideRecord = {
        id: ovrDocId,
        operationId: cleanOpId,
        action: input.action,
        memberId: member.memberId,
        memberUid: member.uid,
        memberUsername: member.username,
        xpProgressSnapshot: member.xpProgress,
        previousLevel: computed.previousLevel,
        newLevel: computed.newLevel,
        previousLevelMode: computed.previousLevelMode,
        newLevelMode: computed.newLevelMode,
        reason: cleanReason,
        reference: cleanRef,
        auditId,
        adminId: input.admin.uid,
        adminEmail: input.admin.email,
        adminRole: input.admin.role,
        cycleId: settings.currentCycleId,
        timestamp: now,
      };

      tx.set(ovrRef, overrideRecord);

      const lhId = genId('lvl');
      tx.set(doc(db, 'levelHistory', lhId), {
        id: lhId,
        memberId: member.memberId,
        memberUid: member.uid,
        fromLevel: computed.previousLevel,
        toLevel: computed.newLevel,
        xpProgressAtEvent: member.xpProgress,
        source: input.action === 'MANUAL_OVERRIDE' ? 'ADMIN_MANUAL_OVERRIDE' : 'ADMIN_RECALCULATE',
        cycleId: settings.currentCycleId,
        createdAt: now,
      });

      const notifId = genId('notif');
      tx.set(doc(db, 'memberNotifications', notifId), {
        id: notifId,
        memberId: member.memberId,
        memberUid: member.uid,
        notificationCampaignId: null,
        category: 'SYSTEM',
        title:
          input.action === 'MANUAL_OVERRIDE'
            ? `Penyesuaian Level Membership: ${computed.newLevel}`
            : `Rekalkulasi Level Otomatis: ${computed.newLevel}`,
        message:
          input.action === 'MANUAL_OVERRIDE'
            ? `Level membership Anda disesuaikan oleh Admin dari ${computed.previousLevel} ke ${computed.newLevel} (XP Progress tetap ${member.xpProgress} XP). Alasan: ${cleanReason}`
            : `Level membership Anda dihitung ulang otomatis dari XP Progress (${member.xpProgress} XP) menjadi ${computed.newLevel}. Alasan: ${cleanReason}`,
        read: false,
        readAt: null,
        status: 'SENT',
        sentAt: now,
        createdAt: now,
      });

      tx.set(doc(db, 'auditLogs', auditId), {
        id: auditId,
        actorId: input.admin.uid,
        actorRole: input.admin.role,
        action:
          input.action === 'MANUAL_OVERRIDE' ? 'LEVEL_MANUAL_OVERRIDE' : 'LEVEL_RECALCULATE_FROM_XP',
        targetType: 'member',
        targetId: member.uid,
        before: {
          currentLevel: computed.previousLevel,
          levelMode: computed.previousLevelMode,
          xpProgress: member.xpProgress,
          xpReward: member.xpReward,
        },
        after: {
          currentLevel: computed.newLevel,
          levelMode: computed.newLevelMode,
          xpProgress: member.xpProgress,
          xpReward: member.xpReward,
        },
        metadata: {
          overrideId: ovrDocId,
          operationId: cleanOpId,
          action: input.action,
          reason: cleanReason,
          reference: cleanRef,
          memberId: member.memberId,
          memberUsername: member.username,
        },
        timestamp: now,
      });

      return {
        record: overrideRecord,
        newLevel: computed.newLevel,
        newLevelMode: computed.newLevelMode,
      };
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('sudah diproses') ||
        err.message.includes('tidak ditemukan') ||
        err.message.includes('DELETED') ||
        err.message.includes('Target level') ||
        err.message.includes('wajib diisi'))
    ) {
      throw err;
    }
    handleFirestoreError(err, OperationType.WRITE, `levelOverrides/${ovrDocId}`);
  }
}

export async function fetchRecentLevelOverrides(input?: {
  actionFilter?: 'ALL' | LevelOverrideAction;
  pageSize?: number;
  cursor?: QueryDocumentSnapshot<DocumentData> | null;
}): Promise<PaginatedResult<LevelOverrideRecord>> {
  const constraints: QueryConstraint[] = [];
  if (input?.actionFilter && input.actionFilter !== 'ALL') {
    constraints.push(where('action', '==', input.actionFilter));
  }
  return fetchPaginatedCollection<LevelOverrideRecord>({
    collectionName: 'levelOverrides',
    constraints,
    orderByField: 'timestamp',
    orderDirection: 'desc',
    pageSize: input?.pageSize ?? 15,
    cursor: input?.cursor ?? null,
  });
}

// ---------- PHASE D: Admin Password Management ----------
export async function changeMemberPasswordByAdmin(input: {
  operationId: string;
  memberUid: string;
  newPassword: string;
  confirmPassword: string;
  reason: string;
  reference?: string;
  revokeSessions?: boolean;
}): Promise<AdminPasswordChangeResult> {
  const token = await getAuthBearer();
  const res = await fetch(`/api/admin/members/${encodeURIComponent(input.memberUid)}/password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      operationId: input.operationId,
      newPassword: input.newPassword,
      confirmPassword: input.confirmPassword,
      reason: input.reason,
      reference: input.reference || '',
      revokeSessions: input.revokeSessions !== false,
    }),
  });
  const data = (await res.json()) as AdminPasswordChangeResult & { error?: string; code?: string };
  if (!res.ok) {
    throw new Error(data.error || 'Gagal mengubah password member.');
  }
  return data;
}

export async function fetchPasswordChangeAuditLogs(input?: {
  pageSize?: number;
  cursor?: QueryDocumentSnapshot<DocumentData> | null;
}): Promise<PaginatedResult<AuditLogRecord>> {
  return fetchPaginatedCollection<AuditLogRecord>({
    collectionName: 'auditLogs',
    constraints: [where('action', '==', 'PASSWORD_CHANGED_BY_ADMIN')],
    orderByField: 'timestamp',
    orderDirection: 'desc',
    pageSize: input?.pageSize ?? 15,
    cursor: input?.cursor ?? null,
  });
}

// ---------- PHASE E: Inactive Members (Indexed Cursor Pagination) ----------
export interface InactiveMembersPageResult {
  rows: InactiveMemberRow[];
  nextCursor: QueryDocumentSnapshot<DocumentData> | null;
  hasMore: boolean;
}

export async function fetchInactiveMembersPage(input: {
  thresholdDays: number;
  mode: 'PLAYED' | 'NEVER_PLAYED';
  branchFilter?: 'ALL' | BranchId;
  levelFilter?: 'ALL' | LevelId;
  search?: string;
  pageSize?: number;
  cursor?: QueryDocumentSnapshot<DocumentData> | null;
}): Promise<InactiveMembersPageResult> {
  const now = Date.now();
  const cutoff = now - input.thresholdDays * 24 * 60 * 60 * 1000;
  const pageSize = Math.min(Math.max(input.pageSize ?? 25, 10), 50);
  const searchNorm = (input.search || '').trim().toLowerCase();

  try {
    const constraints: QueryConstraint[] = [where('status', '==', 'ACTIVE')];
    if (input.mode === 'PLAYED') {
      // Uses composite index (status ASC, lastPlayAt ASC) — oldest/longest inactive first
      constraints.push(where('lastPlayAt', '<=', cutoff));
      constraints.push(orderBy('lastPlayAt', 'asc'));
    } else {
      // Never-played members registered at or before cutoff
      constraints.push(where('lastPlayAt', '==', null));
      constraints.push(where('createdAt', '<=', cutoff));
      constraints.push(orderBy('createdAt', 'asc'));
    }
    if (input.cursor) {
      constraints.push(startAfter(input.cursor));
    }
    constraints.push(limit(pageSize + 1));

    const snap = await getDocs(query(collection(db, 'members'), ...constraints));
    const hasMore = snap.docs.length > pageSize;
    const docs = hasMore ? snap.docs.slice(0, pageSize) : snap.docs;
    const nextCursor = docs.length > 0 ? docs[docs.length - 1] : null;

    const rows: InactiveMemberRow[] = [];
    for (const d of docs) {
      const m = d.data() as MemberProfile;
      if (input.branchFilter && input.branchFilter !== 'ALL') {
        const effBranch = m.lastPlayBranch ?? m.preferredBranch;
        if (effBranch !== input.branchFilter) continue;
      }
      if (input.levelFilter && input.levelFilter !== 'ALL' && m.currentLevel !== input.levelFilter) {
        continue;
      }
      if (searchNorm) {
        const hay = `${m.fullName} ${m.username} ${m.whatsapp} ${m.memberId}`.toLowerCase();
        if (!hay.includes(searchNorm)) continue;
      }
      const calc = calculateMemberInactivity(m, now);
      rows.push({
        member: m,
        daysInactive: calc.daysInactive,
        baselineTimestamp: calc.baselineTimestamp,
        neverPlayed: calc.neverPlayed,
      });
    }

    return {
      rows: sortInactiveRowsLongestFirst(rows),
      nextCursor,
      hasMore,
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'members');
  }
}

// ---------- PHASES F, G, H, I, K: Backup, Verification, Restore, Integrity & System Health APIs ----------
async function authedApiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const token = await getAuthBearer();
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...((init?.headers as Record<string, string>) || {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(body.error || `Permintaan gagal (HTTP ${res.status}).`);
  }
  return body;
}

export async function fetchSystemHealthApi(): Promise<SystemHealthReport> {
  return authedApiJson<SystemHealthReport>('/api/admin/system-health', { method: 'GET' });
}

export async function runIntegrityAuditApi(): Promise<IntegrityAuditReport> {
  return authedApiJson<IntegrityAuditReport>('/api/admin/integrity-audit', { method: 'POST' });
}

export async function fetchSystemBackupsApi(): Promise<SystemBackupRecord[]> {
  const res = await authedApiJson<{ backups: SystemBackupRecord[] }>('/api/admin/backups', {
    method: 'GET',
  });
  return res.backups;
}

export async function createSystemBackupApi(input: {
  kind?: BackupKind;
  note?: string;
}): Promise<{
  record: SystemBackupRecord;
  manifest: BackupManifest;
  verification: BackupVerificationResult;
}> {
  return authedApiJson('/api/admin/backups', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function fetchBackupManifestApi(backupId: string): Promise<BackupManifest> {
  const res = await authedApiJson<{ manifest: BackupManifest }>(
    `/api/admin/backups/${encodeURIComponent(backupId)}`,
    { method: 'GET' }
  );
  return res.manifest;
}

export async function verifySystemBackupApi(backupId: string): Promise<BackupVerificationResult> {
  return authedApiJson<BackupVerificationResult>(
    `/api/admin/backups/${encodeURIComponent(backupId)}/verify`,
    { method: 'POST' }
  );
}

export async function deleteSystemBackupApi(backupId: string): Promise<void> {
  await authedApiJson<{ deleted: boolean }>(
    `/api/admin/backups/${encodeURIComponent(backupId)}`,
    { method: 'DELETE' }
  );
}

export async function fetchBackupRetentionApi(): Promise<BackupRetentionConfig> {
  return authedApiJson<BackupRetentionConfig>('/api/admin/backup-retention', { method: 'GET' });
}

export async function saveBackupRetentionApi(
  config: Omit<BackupRetentionConfig, 'id' | 'updatedAt' | 'updatedBy'>
): Promise<BackupRetentionConfig> {
  return authedApiJson<BackupRetentionConfig>('/api/admin/backup-retention', {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

export async function fetchRestoreJobsApi(): Promise<{
  jobs: RestoreJobRecord[];
  lock: RestoreLockState;
}> {
  return authedApiJson('/api/admin/restores', { method: 'GET' });
}

export async function previewRestoreApi(backupId: string): Promise<RestorePreviewResult> {
  return authedApiJson<RestorePreviewResult>('/api/admin/restores/preview', {
    method: 'POST',
    body: JSON.stringify({ backupId }),
  });
}

export async function executeRestoreApi(input: {
  backupId: string;
  confirmationPhrase: string;
  reason: string;
}): Promise<RestoreJobRecord> {
  const token = await getAuthBearer();
  const res = await fetch('/api/admin/restores/execute', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as RestoreJobRecord & { error?: string };
  // HTTP 422 returns the full VERIFICATION_FAILED RestoreJobRecord so UI can inspect exact failures
  if (res.status === 422 && body.restoreJobId) {
    return body;
  }
  if (!res.ok) {
    throw new Error(body.error || `Gagal menjalankan restore (HTTP ${res.status}).`);
  }
  return body;
}

export async function forceUnlockRestoreApi(reason: string): Promise<RestoreLockState> {
  return authedApiJson<RestoreLockState>('/api/admin/restores/force-unlock', {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}


