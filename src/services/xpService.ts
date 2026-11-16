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
  calculateTransactionXp,
  DEFAULT_LEVELS,
  DEFAULT_SYSTEM_SETTINGS,
  isCampaignClaimable,
  isLevelEligible,
  normalizeUsername,
  normalizeWhatsapp,
  resolveLevelFromXp,
  validateLevelThresholds,
  validateUsername,
  validateWhatsapp,
} from '../shared/xpLogic.ts';
import type {
  AdminRole,
  AdminUser,
  AuditLogRecord,
  BenefitItem,
  BranchId,
  BranchInfo,
  CampaignItem,
  ClaimRecord,
  CycleSnapshot,
  LevelConfig,
  LevelId,
  MemberNotification,
  MemberProfile,
  MembershipCycle,
  MemberStatus,
  NotificationCampaign,
  RedemptionRecord,
  SystemSettings,
  TransactionRecord,
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

    if (withReferralUid && refBonus > 0) {
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

      // Credit referrer atomically
      batch.update(doc(db, 'members', withReferralUid), {
        xpProgress: increment(refBonus),
        xpReward: increment(refBonus),
        referralCount: increment(1),
        updatedAt: now,
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
  const effectiveLevel = resolveLevelFromXp(input.member.xpProgress, input.levels).current.id;
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

// ---------- Paginated Queries (Member & Admin) ----------
export async function fetchPaginatedCollection<T>(input: {
  collectionName: string;
  constraints: QueryConstraint[];
  orderByField?: string;
  pageSize?: number;
  cursor?: QueryDocumentSnapshot<DocumentData> | null;
}): Promise<PaginatedResult<T>> {
  const pageSize = input.pageSize ?? 10;
  const parts: QueryConstraint[] = [
    ...input.constraints,
    orderBy(input.orderByField ?? 'createdAt', 'desc'),
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
        const rLvl = resolveLevelFromXp(rNewProg, levels);

        tx.update(doc(db, 'members', freshReferrer.uid), {
          xpProgress: rNewProg,
          xpReward: rNewRew,
          currentLevel: rLvl.current.id,
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

        if (rLvl.current.id !== freshReferrer.currentLevel) {
          const lhId = genId('lvl');
          tx.set(doc(db, 'levelHistory', lhId), {
            id: lhId,
            memberId: freshReferrer.memberId,
            memberUid: freshReferrer.uid,
            fromLevel: freshReferrer.currentLevel,
            toLevel: rLvl.current.id,
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
      const levelEval = resolveLevelFromXp(newProgress, levels);

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
        currentLevel: levelEval.current.id,
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

      if (levelEval.current.id !== member.currentLevel) {
        const lhId = genId('lvl');
        tx.set(doc(db, 'levelHistory', lhId), {
          id: lhId,
          memberId: member.memberId,
          memberUid: member.uid,
          fromLevel: member.currentLevel,
          toLevel: levelEval.current.id,
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
          currentLevel: levelEval.current.id,
          amountIdr: input.amountIdr,
          xpGenerated,
          branch: input.branch,
        },
        metadata: { receiptNumber: txRecord.receiptNumber },
        timestamp: now,
      });

      return { xpGenerated, newProgress, newReward, newLevel: levelEval.current.id };
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
      const memberSnap = await tx.get(memberRef);
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

      const xpAward = claim.xpRewardSnapshot;
      const newProgress = member.xpProgress + xpAward;
      const newReward = member.xpReward + xpAward;
      const levelEval = resolveLevelFromXp(newProgress, levels);

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
        currentLevel: levelEval.current.id,
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

      if (levelEval.current.id !== member.currentLevel) {
        const lhId = genId('lvl');
        tx.set(doc(db, 'levelHistory', lhId), {
          id: lhId,
          memberId: member.memberId,
          memberUid: member.uid,
          fromLevel: member.currentLevel,
          toLevel: levelEval.current.id,
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

      const effectiveLevel = resolveLevelFromXp(member.xpProgress, levels).current.id;
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
  if (!Number.isSafeInteger(settings.transactionXpRate) || settings.transactionXpRate < 100) {
    throw new Error('Rate XP transaksi minimal Rp100 per 1 XP.');
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
  admin: AdminUser;
}): Promise<{ campaignId: string; dispatchedCount: number }> {
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

  await setDoc(doc(db, 'notifications', campaignId), campaign);

  // Target paginated matching members without loading whole DB into memory
  const constraints: QueryConstraint[] = [where('status', '==', 'ACTIVE')];
  if (input.targetType === 'LEVEL' && input.targetFilter) {
    constraints.push(where('currentLevel', '==', input.targetFilter));
  } else if (input.targetType === 'BRANCH' && input.targetFilter) {
    constraints.push(where('lastPlayBranch', '==', input.targetFilter));
  } else if (input.targetType === 'SPECIFIC_MEMBER' && input.targetFilter) {
    constraints.push(where('username', '==', normalizeUsername(input.targetFilter)));
  } else if (input.targetType === 'INACTIVE_MEMBERS' && input.inactivityDays) {
    const cutoff = now - input.inactivityDays * 24 * 60 * 60 * 1000;
    constraints.push(where('lastPlayAt', '<=', cutoff));
  }

  let dispatchedCount = 0;
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;

  while (true) {
    const parts: QueryConstraint[] = [...constraints, limit(100)];
    if (cursor) parts.push(startAfter(cursor));

    const snap = await getDocs(query(collection(db, 'members'), ...parts));
    if (snap.empty) break;

    const batch = writeBatch(db);
    for (const d of snap.docs) {
      const m = d.data() as MemberProfile;
      // Deterministic ID prevents duplicate notifications for the same campaign & member
      const notifId = `${campaignId}__${m.uid}`;
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
    }
    await batch.commit();
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
    after: { targetType: input.targetType, dispatchedCount },
    metadata: null,
    timestamp: now,
  });

  return { campaignId, dispatchedCount };
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
      inactive7Snap,
      inactive14Snap,
      inactive30Snap,
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
      getCountFromServer(
        query(collection(db, 'members'), where('status', '==', 'ACTIVE'), where('lastPlayAt', '<=', d7))
      ),
      getCountFromServer(
        query(collection(db, 'members'), where('status', '==', 'ACTIVE'), where('lastPlayAt', '<=', d14))
      ),
      getCountFromServer(
        query(collection(db, 'members'), where('status', '==', 'ACTIVE'), where('lastPlayAt', '<=', d30))
      ),
      getDocs(query(collection(db, 'transactions'), orderBy('createdAt', 'desc'), limit(25))),
    ]);

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
      inactive7Days: inactive7Snap.data().count,
      inactive14Days: inactive14Snap.data().count,
      inactive30Days: inactive30Snap.data().count,
      recentTransactions: recentTransactions.slice(0, 6),
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'admin_metrics');
  }
}
