import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
  calculateManualLevelOverride,
  calculateRecalculateLevelFromXp,
  calculateTransactionXp,
  calculateXpProgressAdjustment,
  calculateXpRewardAdjustment,
  DEFAULT_BRANCHES,
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
} from '../../shared/xpLogic.ts';
import { validateAdminNewPassword } from '../../shared/inactiveLogic.ts';
import {
  computeBenefitApproval,
  computeBenefitDenial,
  computeBenefitExpiry,
  computeBenefitHoldBalances,
  computeBenefitMarkUsed,
  resolveCampaignBenefitRequestEconomics,
  validateBirthDate,
  validateMemberCategory,
} from '../../shared/benefitRequestLogic.ts';
import {
  assertCashierBranchAccess,
  assertRolePermission,
  isCashierRole,
} from '../../shared/rbac.ts';
import {
  buildPreRegisteredMemberProfile,
  buildRegistrationBonusLedgerIds,
  computeRegistrationCompletion,
  evaluatePhoneRegistrationState,
  isPreRegisteredMember,
  PRE_REGISTERED_LOGIN_BLOCKED_MESSAGE,
} from '../../shared/registrationLogic.ts';
import {
  hashWhatsappServer,
  issueOnboardingVerificationCode,
  markOnboardingCodeUsed,
  verifyOnboardingSessionToken,
} from './onboardingSecurityService.ts';
import type {
  AdminPasswordChangeResult,
  AdminRole,
  BenefitItem,
  BenefitRequestRecord,
  BenefitRequestSourceType,
  BranchId,
  CampaignItem,
  ClaimRecord,
  LevelConfig,
  LevelId,
  LevelMode,
  LevelOverrideAction,
  LevelOverrideRecord,
  MemberCategory,
  MemberProfile,
  RedemptionRecord,
  SystemSettings,
  XpAdjustmentKind,
  XpAdjustmentRecord,
} from '../../types/xpplay.ts';
import {
  firebaseAppletConfig,
  getAdminAuth,
  getAdminDb,
} from '../firebaseServer.ts';

function generateDocId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
}

function generateMemberCode(): string {
  const num = crypto.randomInt(100000, 999999);
  return `XPP-${num}`;
}

export async function ensureSeedDataServer(db: Firestore): Promise<void> {
  const settingsRef = db.collection('systemSettings').doc('default');
  const settingsSnap = await settingsRef.get();
  if (!settingsSnap.exists) {
    await settingsRef.set({
      ...DEFAULT_SYSTEM_SETTINGS,
      updatedAt: Date.now(),
    });
  }

  for (const branch of DEFAULT_BRANCHES) {
    const ref = db.collection('branches').doc(branch.id);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set(branch);
    }
  }

  for (const level of DEFAULT_LEVELS) {
    const ref = db.collection('levels').doc(level.id);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set(level);
    }
  }

  const cycleRef = db.collection('membershipCycles').doc(DEFAULT_SYSTEM_SETTINGS.currentCycleId);
  const cycleSnap = await cycleRef.get();
  if (!cycleSnap.exists) {
    await cycleRef.set({
      id: DEFAULT_SYSTEM_SETTINGS.currentCycleId,
      name: 'Season 1 — 2026',
      startedAt: Date.now(),
      endedAt: null,
      status: 'ACTIVE',
      resetCount: 0,
      createdBy: 'system',
    });
  }
}

async function getSettingsAndLevels(db: Firestore): Promise<{
  settings: SystemSettings;
  levels: LevelConfig[];
}> {
  const [settingsSnap, levelsSnap] = await Promise.all([
    db.collection('systemSettings').doc('default').get(),
    db.collection('levels').get(),
  ]);

  const settings = settingsSnap.exists
    ? (settingsSnap.data() as SystemSettings)
    : DEFAULT_SYSTEM_SETTINGS;

  const levels = levelsSnap.empty
    ? DEFAULT_LEVELS
    : (levelsSnap.docs.map((d) => d.data() as LevelConfig)).sort((a, b) => a.rank - b.rank);

  return { settings, levels };
}

export async function registerMemberServer(_input: {
  fullName: string;
  username: string;
  whatsapp: string;
  socialMedia: string;
  birthDate?: string | null;
  memberCategory?: MemberCategory | null;
  referralUsername?: string;
  password: string;
  preferredBranch?: BranchId | null;
}): Promise<{
  uid: string;
  member: MemberProfile;
  customToken: string;
  referralApplied: boolean;
  referralMessage?: string;
}> {
  throw new Error(
    'Pendaftaran mandiri publik dinonaktifkan. Silakan daftarkan nomor WhatsApp melalui Kasir XP PLAY terlebih dahulu, lalu lengkapi pendaftaran online.'
  );
}

export async function preRegisterCustomerServer(input: {
  whatsapp: string;
  branchId: BranchId;
  notes?: string;
  actorUid: string;
  actorName: string;
  actorRole: AdminRole;
  actorBranchScope: BranchId | 'ALL';
}): Promise<{
  alreadyExists: boolean;
  member: MemberProfile;
  verificationCode?: string;
  verificationExpiresAt?: number;
  message: string;
}> {
  assertRolePermission(input.actorRole, 'PRE_REGISTER_CUSTOMER', 'pre-registrasi customer');
  assertCashierBranchAccess(
    { role: input.actorRole, branchScope: input.actorBranchScope },
    input.branchId,
    'pre-registrasi customer'
  );

  const db = getAdminDb();
  if (!db) throw new Error('ADMIN_SDK_UNAVAILABLE');
  await ensureSeedDataServer(db);

  const waCheck = validateWhatsapp(input.whatsapp);
  if (!waCheck.valid) {
    throw new Error(waCheck.error || 'Nomor WhatsApp tidak valid.');
  }
  const normalizedWa = waCheck.normalized;
  const wHash = hashWhatsappServer(normalizedWa);

  // Check existing non-deleted member with same WhatsApp
  const existingSnap = await db
    .collection('members')
    .where('whatsapp', '==', normalizedWa)
    .get();

  const existingMember = existingSnap.docs
    .map((d) => d.data() as MemberProfile)
    .find((m) => m.status !== 'DELETED');

  if (existingMember) {
    return {
      alreadyExists: true,
      member: existingMember,
      message:
        existingMember.status === 'PRE_REGISTERED'
          ? 'Nomor WhatsApp sudah terdaftar dengan status PRE_REGISTERED (belum menyelesaikan pendaftaran online).'
          : `Nomor WhatsApp sudah terdaftar sebagai member (${existingMember.status}).`,
    };
  }

  const now = Date.now();
  const { settings } = await getSettingsAndLevels(db);
  const preDocId = `pre_${now}_${crypto.randomBytes(8).toString('hex')}`;
  const memberDoc = buildPreRegisteredMemberProfile({
    preDocId,
    whatsapp: normalizedWa,
    branchId: input.branchId,
    actorId: input.actorUid,
    actorRole: input.actorRole,
    notes: input.notes,
    currentCycleId: settings.currentCycleId,
    nowMs: now,
    memberId: generateMemberCode(),
  });

  const issued = await issueOnboardingVerificationCode({
    normalizedWhatsapp: normalizedWa,
    preMemberUid: preDocId,
    memberId: memberDoc.memberId,
    branchId: input.branchId,
    issuedBy: input.actorUid,
    issuedByRole: input.actorRole,
    nowMs: now,
  });

  const batch = db.batch();
  batch.set(db.collection('members').doc(preDocId), memberDoc);
  batch.set(db.collection('onboardingPublicStatus').doc(wHash), {
    status: 'PRE_REGISTERED',
    hasActiveCode: true,
    branchId: input.branchId,
    updatedAt: now,
  });

  const alertId = `pre_reg_${preDocId}`;
  batch.set(db.collection('notifications').doc(alertId), {
    id: alertId,
    title: `Pre-Registrasi Baru (${input.branchId}): ${memberDoc.memberId}`,
    message: `Kasir/Admin ${input.actorName} mendaftarkan nomor ${normalizedWa} di cabang ${input.branchId} (Status: PRE_REGISTERED).`,
    targetType: 'ADMIN_ALERT',
    targetFilter: preDocId,
    inactivityDays: null,
    category: 'NEW_PRE_REGISTERED',
    memberUid: preDocId,
    memberUsername: '',
    memberName: memberDoc.fullName,
    referralUsername: null,
    startAt: now,
    endAt: null,
    active: true,
    status: 'ACTIVE',
    createdBy: input.actorUid,
    createdAt: now,
  });

  const auditId = generateDocId('audit');
  batch.set(db.collection('auditLogs').doc(auditId), {
    id: auditId,
    actorId: input.actorUid,
    actorRole: input.actorRole,
    action: 'PRE_REGISTERED_MEMBER_CREATED',
    targetType: 'member',
    targetId: preDocId,
    before: null,
    after: {
      memberId: memberDoc.memberId,
      whatsapp: normalizedWa,
      status: 'PRE_REGISTERED',
      registrationStage: 'PHONE_ONLY',
      branchId: input.branchId,
      xpProgress: 0,
      xpReward: 0,
    },
    metadata: {
      branchId: input.branchId,
      actorName: input.actorName,
      notes: memberDoc.preRegistrationNotes,
    },
    timestamp: now,
  });

  if (isCashierRole(input.actorRole)) {
    const cashierAuditId = generateDocId('audit');
    batch.set(db.collection('auditLogs').doc(cashierAuditId), {
      id: cashierAuditId,
      actorId: input.actorUid,
      actorRole: input.actorRole,
      action: 'CASHIER_ACTION',
      targetType: 'member',
      targetId: preDocId,
      before: null,
      after: { operation: 'PRE_REGISTER_CUSTOMER', branchId: input.branchId, memberId: memberDoc.memberId },
      metadata: { branchId: input.branchId },
      timestamp: now,
    });
  }

  await batch.commit();

  return {
    alreadyExists: false,
    member: memberDoc,
    verificationCode: issued.verificationCode,
    verificationExpiresAt: issued.record.expiresAt,
    message: 'Customer berhasil di-pre-register (PRE_REGISTERED). Bagikan kode verifikasi 6 digit kepada customer.',
  };
}

export async function checkOnboardingPhoneServer(whatsapp: string) {
  const waCheck = validateWhatsapp(whatsapp);
  if (!waCheck.valid) {
    throw new Error(waCheck.error || 'Nomor WhatsApp tidak valid.');
  }
  const normalizedWa = waCheck.normalized;
  const db = getAdminDb();
  if (!db) throw new Error('ADMIN_SDK_UNAVAILABLE');

  const wHash = hashWhatsappServer(normalizedWa);
  const pubSnap = await db.collection('onboardingPublicStatus').doc(wHash).get();
  if (pubSnap.exists) {
    const pub = pubSnap.data() as {
      status: MemberProfile['status'];
      hasActiveCode?: boolean;
      branchId?: BranchId;
    };
    return evaluatePhoneRegistrationState(normalizedWa, pub);
  }

  // Fallback check members collection in case legacy ACTIVE member lacks onboardingPublicStatus doc
  const qSnap = await db.collection('members').where('whatsapp', '==', normalizedWa).get();
  const activeOrPre = qSnap.docs
    .map((d) => d.data() as MemberProfile)
    .find((m) => m.status !== 'DELETED');

  return evaluatePhoneRegistrationState(normalizedWa, activeOrPre ?? null);
}

export async function completeMemberRegistrationServer(input: {
  onboardingSessionToken: string;
  fullName: string;
  username: string;
  birthDate: string;
  memberCategory: MemberCategory;
  socialMedia?: string;
  preferredBranch: BranchId;
  referralUsername?: string;
  password: string;
}): Promise<{
  uid: string;
  member: MemberProfile;
  customToken: string;
  registrationBonusGranted: number;
  referralApplied: boolean;
  referralMessage?: string;
}> {
  const adminAuth = getAdminAuth();
  const db = getAdminDb();
  if (!adminAuth || !db) throw new Error('ADMIN_SDK_UNAVAILABLE');

  const tokenCheck = verifyOnboardingSessionToken(input.onboardingSessionToken, { consume: false });
  if (!tokenCheck.valid || !tokenCheck.payload) {
    throw new Error(tokenCheck.error || 'Verifikasi nomor WhatsApp tidak valid atau sudah kedaluwarsa.');
  }
  const session = tokenCheck.payload;

  if (!input.password || input.password.length < 8) {
    throw new Error('Password minimal 8 karakter.');
  }

  const userCheck = validateUsername(input.username);
  if (!userCheck.valid) {
    throw new Error(userCheck.error || 'Username tidak valid.');
  }
  const normalizedUsername = userCheck.normalized;
  const referralInput = input.referralUsername ? normalizeUsername(input.referralUsername) : '';
  if (referralInput && referralInput === normalizedUsername) {
    throw new Error('Anda tidak dapat menggunakan username Anda sendiri sebagai referral.');
  }

  // Pre-verify username uniqueness & pre-registered doc existence
  const [uIdxPre, preSnapPre] = await Promise.all([
    db.collection('identityIndex').doc(`username:${normalizedUsername}`).get(),
    db.collection('members').doc(session.preMemberUid).get(),
  ]);
  if (uIdxPre.exists) {
    throw new Error('Username sudah terdaftar. Silakan pilih username lain.');
  }
  if (!preSnapPre.exists) {
    throw new Error('Data pre-registrasi tidak ditemukan.');
  }
  const preDocCheck = preSnapPre.data() as MemberProfile;
  if (preDocCheck.status !== 'PRE_REGISTERED') {
    throw new Error('Membership ini sudah selesai atau tidak berstatus PRE_REGISTERED.');
  }

  const uid = session.preMemberUid;
  const authEmail = `m_${uid}@member.xpplay.internal`;

  // Create Firebase Auth user using SAME uid as pre-registered doc so Stage 1 transactions/ledgers remain seamlessly attached
  await adminAuth.createUser({
    uid,
    email: authEmail,
    emailVerified: true,
    password: input.password,
    displayName: input.fullName.trim(),
  });

  try {
    const result = await db.runTransaction(async (tx) => {
      const now = Date.now();
      const { settings, levels } = await getSettingsAndLevels(db);

      const memberRef = db.collection('members').doc(uid);
      const uIdxRef = db.collection('identityIndex').doc(`username:${normalizedUsername}`);
      const wIdxRef = db.collection('identityIndex').doc(`wa:${session.normalizedWhatsapp}`);

      const { progressLedgerId, rewardLedgerId } = buildRegistrationBonusLedgerIds(preDocCheck.memberId);
      const bonusProgRef = db.collection('xpProgressLedger').doc(progressLedgerId);
      const bonusRewRef = db.collection('xpRewardLedger').doc(rewardLedgerId);

      const [memberSnap, uSnap, bonusProgSnap, bonusRewSnap] = await Promise.all([
        tx.get(memberRef),
        tx.get(uIdxRef),
        tx.get(bonusProgRef),
        tx.get(bonusRewRef),
      ]);

      if (!memberSnap.exists) throw new Error('Data pre-registrasi tidak ditemukan.');
      const preMember = memberSnap.data() as MemberProfile;
      if (preMember.status !== 'PRE_REGISTERED') {
        throw new Error('Membership ini sudah diaktifkan sebelumnya.');
      }
      if (uSnap.exists) {
        throw new Error('Username sudah digunakan member lain.');
      }

      let referrerSnapData: MemberProfile | null = null;
      let referralMessage: string | undefined;
      if (referralInput) {
        const refIdxSnap = await tx.get(db.collection('identityIndex').doc(`username:${referralInput}`));
        if (refIdxSnap.exists) {
          const refUid = (refIdxSnap.data() as { uid: string }).uid;
          if (refUid !== uid) {
            const refMemberSnap = await tx.get(db.collection('members').doc(refUid));
            if (refMemberSnap.exists) {
              const cand = refMemberSnap.data() as MemberProfile;
              if (cand.status === 'ACTIVE') {
                referrerSnapData = cand;
              } else {
                referralMessage = 'Akun referrer sedang tidak aktif, pendaftaran selesai tanpa bonus referral.';
              }
            }
          }
        } else {
          referralMessage = 'Username referral tidak ditemukan, pendaftaran selesai dengan bonus registrasi standar.';
        }
      }

      const existingBonusSet = new Set<string>();
      if (bonusProgSnap.exists) existingBonusSet.add(progressLedgerId);
      if (bonusRewSnap.exists) existingBonusSet.add(rewardLedgerId);

      const computed = computeRegistrationCompletion({
        preMember,
        targetAuthUid: uid,
        fullName: input.fullName,
        username: normalizedUsername,
        birthDate: input.birthDate,
        memberCategory: input.memberCategory,
        socialMedia: input.socialMedia,
        preferredBranch: input.preferredBranch,
        referrer: referrerSnapData,
        verifiedPhoneAt: session.verifiedAt,
        settings,
        levels,
        existingBonusLedgerIds: existingBonusSet,
        nowMs: now,
      });

      const completed = computed.completedMember;
      tx.set(memberRef, completed);

      // Auth & Identity indexes
      const uHash = `u_${crypto.createHash('sha256').update(`u:${normalizedUsername}`).digest('hex')}`;
      const wHash = session.wHash;
      tx.set(uIdxRef, { uid, authEmail, kind: 'USERNAME', value: normalizedUsername, createdAt: now });
      tx.set(wIdxRef, { uid, authEmail, kind: 'WHATSAPP', value: session.normalizedWhatsapp, createdAt: now });
      tx.set(db.collection('authIndex').doc(uHash), { uid, authEmail, kind: 'USERNAME', createdAt: now });
      tx.set(db.collection('authIndex').doc(wHash), { uid, authEmail, kind: 'WHATSAPP', createdAt: now });
      tx.set(db.collection('onboardingPublicStatus').doc(wHash), {
        status: 'ACTIVE',
        hasActiveCode: false,
        branchId: completed.branchId ?? input.preferredBranch,
        updatedAt: now,
      });

      // Deterministic one-time Registration Bonus (+10 XP)
      if (computed.registrationBonusGranted > 0) {
        tx.set(bonusProgRef, {
          id: progressLedgerId,
          memberId: completed.memberId,
          memberUid: uid,
          memberUsername: completed.username,
          amount: computed.registrationBonusGranted,
          beforeBalance: preMember.xpProgress,
          afterBalance: preMember.xpProgress + computed.registrationBonusGranted,
          type: 'PROGRESS',
          direction: 'CREDIT',
          source: 'REGISTRATION_BONUS',
          referenceId: completed.memberId,
          branch: completed.branchId ?? null,
          cycleId: settings.currentCycleId,
          createdAt: now,
          createdBy: 'system',
          note: 'Bonus penyelesaian pendaftaran online XP PLAY (+10 XP)',
        });
        tx.set(bonusRewRef, {
          id: rewardLedgerId,
          memberId: completed.memberId,
          memberUid: uid,
          memberUsername: completed.username,
          amount: computed.registrationBonusGranted,
          beforeBalance: preMember.xpReward,
          afterBalance: preMember.xpReward + computed.registrationBonusGranted,
          type: 'REWARD',
          direction: 'CREDIT',
          source: 'REGISTRATION_BONUS',
          referenceId: completed.memberId,
          branch: completed.branchId ?? null,
          cycleId: settings.currentCycleId,
          createdAt: now,
          createdBy: 'system',
          note: 'Bonus penyelesaian pendaftaran online XP PLAY (+10 XP)',
        });

        const bonusAuditId = generateDocId('audit');
        tx.set(db.collection('auditLogs').doc(bonusAuditId), {
          id: bonusAuditId,
          actorId: uid,
          actorRole: 'MEMBER',
          action: 'REGISTRATION_BONUS_GRANTED',
          targetType: 'member',
          targetId: uid,
          before: { xpProgress: preMember.xpProgress, xpReward: preMember.xpReward },
          after: {
            xpProgress: preMember.xpProgress + computed.registrationBonusGranted,
            xpReward: preMember.xpReward + computed.registrationBonusGranted,
            amount: computed.registrationBonusGranted,
          },
          metadata: { memberId: completed.memberId, ledgerIds: [progressLedgerId, rewardLedgerId] },
          timestamp: now,
        });
      }

      // Optional Referral Bonus (+5 / +5 XP)
      if (computed.referralValid && referrerSnapData && computed.refereeReferralBonus > 0) {
        const refRecordId = generateDocId('ref');
        const refereeProgId = generateDocId('xpp');
        const refereeRewId = generateDocId('xpr');
        const referrerProgId = generateDocId('xpp');
        const referrerRewId = generateDocId('xpr');

        tx.set(db.collection('referrals').doc(refRecordId), {
          id: refRecordId,
          referrerUid: referrerSnapData.uid,
          referrerMemberId: referrerSnapData.memberId,
          referrerUsername: referrerSnapData.username,
          refereeUid: uid,
          refereeMemberId: completed.memberId,
          refereeUsername: completed.username,
          referrerXp: computed.referrerReferralBonus,
          refereeXp: computed.refereeReferralBonus,
          cycleId: settings.currentCycleId,
          createdAt: now,
        });

        tx.set(db.collection('xpProgressLedger').doc(refereeProgId), {
          id: refereeProgId,
          memberId: completed.memberId,
          memberUid: uid,
          memberUsername: completed.username,
          amount: computed.refereeReferralBonus,
          type: 'PROGRESS',
          direction: 'CREDIT',
          source: 'REFERRAL',
          referenceId: refRecordId,
          branch: completed.branchId ?? null,
          cycleId: settings.currentCycleId,
          createdAt: now + 1,
          createdBy: 'system',
          note: `Bonus referral menggunakan username @${referrerSnapData.username}`,
        });
        tx.set(db.collection('xpRewardLedger').doc(refereeRewId), {
          id: refereeRewId,
          memberId: completed.memberId,
          memberUid: uid,
          memberUsername: completed.username,
          amount: computed.refereeReferralBonus,
          type: 'REWARD',
          direction: 'CREDIT',
          source: 'REFERRAL',
          referenceId: refRecordId,
          branch: completed.branchId ?? null,
          cycleId: settings.currentCycleId,
          createdAt: now + 1,
          createdBy: 'system',
          note: `Bonus referral menggunakan username @${referrerSnapData.username}`,
        });

        const nextRefProg = referrerSnapData.xpProgress + computed.referrerReferralBonus;
        const nextRefRew = referrerSnapData.xpReward + computed.referrerReferralBonus;
        const isRefManual = referrerSnapData.levelMode === 'MANUAL_OVERRIDE';
        const refLevelEval = resolveLevelFromXp(nextRefProg, levels);
        const nextRefLevel: LevelId = isRefManual ? referrerSnapData.currentLevel : refLevelEval.current.id;

        tx.update(db.collection('members').doc(referrerSnapData.uid), {
          xpProgress: nextRefProg,
          xpReward: nextRefRew,
          currentLevel: nextRefLevel,
          levelMode: isRefManual ? 'MANUAL_OVERRIDE' : 'AUTOMATIC',
          referralCount: (referrerSnapData.referralCount || 0) + 1,
          updatedAt: now,
        });

        tx.set(db.collection('xpProgressLedger').doc(referrerProgId), {
          id: referrerProgId,
          memberId: referrerSnapData.memberId,
          memberUid: referrerSnapData.uid,
          memberUsername: referrerSnapData.username,
          amount: computed.referrerReferralBonus,
          type: 'PROGRESS',
          direction: 'CREDIT',
          source: 'REFERRAL',
          referenceId: refRecordId,
          branch: null,
          cycleId: settings.currentCycleId,
          createdAt: now + 1,
          createdBy: 'system',
          note: `Bonus mengajak member baru @${completed.username}`,
        });
        tx.set(db.collection('xpRewardLedger').doc(referrerRewId), {
          id: referrerRewId,
          memberId: referrerSnapData.memberId,
          memberUid: referrerSnapData.uid,
          memberUsername: referrerSnapData.username,
          amount: computed.referrerReferralBonus,
          type: 'REWARD',
          direction: 'CREDIT',
          source: 'REFERRAL',
          referenceId: refRecordId,
          branch: null,
          cycleId: settings.currentCycleId,
          createdAt: now + 1,
          createdBy: 'system',
          note: `Bonus mengajak member baru @${completed.username}`,
        });

        const refAuditId = generateDocId('audit');
        tx.set(db.collection('auditLogs').doc(refAuditId), {
          id: refAuditId,
          actorId: uid,
          actorRole: 'MEMBER',
          action: 'REFERRAL_BONUS_GRANTED',
          targetType: 'referral',
          targetId: refRecordId,
          before: null,
          after: {
            referrerUid: referrerSnapData.uid,
            refereeUid: uid,
            referrerXp: computed.referrerReferralBonus,
            refereeXp: computed.refereeReferralBonus,
          },
          metadata: { referrerUsername: referrerSnapData.username, refereeUsername: completed.username },
          timestamp: now,
        });
      }

      // Admin alert for newly completed ACTIVE member
      const adminAlertId = `new_member_${uid}`;
      tx.set(db.collection('notifications').doc(adminAlertId), {
        id: adminAlertId,
        title: `Member Aktif Baru: @${completed.username}`,
        message: `${completed.fullName} (@${completed.username}) menyelesaikan pendaftaran online (+${computed.registrationBonusGranted} XP${
          computed.referralValid && referrerSnapData ? `, referral @${referrerSnapData.username}` : ''
        }).`,
        targetType: 'ADMIN_ALERT',
        targetFilter: uid,
        inactivityDays: null,
        category: 'NEW_MEMBER_REGISTERED',
        memberUid: uid,
        memberUsername: completed.username,
        memberName: completed.fullName,
        referralUsername: referrerSnapData ? referrerSnapData.username : null,
        startAt: now,
        endAt: null,
        active: true,
        status: 'ACTIVE',
        createdBy: uid,
        createdAt: now,
      });

      const auditId = generateDocId('audit');
      tx.set(db.collection('auditLogs').doc(auditId), {
        id: auditId,
        actorId: uid,
        actorRole: 'MEMBER',
        action: 'REGISTRATION_COMPLETED',
        targetType: 'member',
        targetId: uid,
        before: { status: 'PRE_REGISTERED', registrationStage: 'PHONE_ONLY', xpProgress: preMember.xpProgress, xpReward: preMember.xpReward },
        after: {
          status: 'ACTIVE',
          registrationStage: 'COMPLETED',
          username: completed.username,
          xpProgress: completed.xpProgress,
          xpReward: completed.xpReward,
          branchId: completed.branchId,
        },
        metadata: { verifiedPhoneAt: session.verifiedAt, referralApplied: computed.referralValid },
        timestamp: now,
      });

      return {
        member: completed,
        registrationBonusGranted: computed.registrationBonusGranted,
        referralApplied: computed.referralValid,
        referralMessage,
      };
    });

    verifyOnboardingSessionToken(input.onboardingSessionToken, { consume: true });
    await markOnboardingCodeUsed(session.normalizedWhatsapp);

    const customToken = await adminAuth.createCustomToken(uid);
    return {
      uid,
      member: result.member,
      customToken,
      registrationBonusGranted: result.registrationBonusGranted,
      referralApplied: result.referralApplied,
      referralMessage: result.referralMessage,
    };
  } catch (err) {
    await adminAuth.deleteUser(uid).catch(() => {});
    throw err;
  }
}

/* Legacy registerMemberServer body removed intentionally — Two-Step Registration is mandatory. */
async function _legacyRegisterPlaceholder(): Promise<void> {
  return;
}
void _legacyRegisterPlaceholder;


// End of Two-Step Registration Server Engine


export async function loginMemberServer(input: {
  identifier: string;
  password: string;
}): Promise<{ customToken: string; uid: string }> {
  const adminAuth = getAdminAuth();
  const db = getAdminDb();
  if (!adminAuth || !db) {
    throw new Error('ADMIN_SDK_UNAVAILABLE');
  }

  const raw = input.identifier.trim();
  const password = input.password;
  if (!raw || !password) {
    throw new Error('Username/WhatsApp dan password wajib diisi.');
  }

  // Determine whether identifier looks like phone number or username
  const digits = raw.replace(/\D/g, '');
  const looksLikePhone = /^\+?[0-9\s\-]{8,18}$/.test(raw) && digits.length >= 9;
  const indexKey = looksLikePhone
    ? `wa:${normalizeWhatsapp(raw)}`
    : `username:${normalizeUsername(raw)}`;

  const idxSnap = await db.collection('identityIndex').doc(indexKey).get();
  if (!idxSnap.exists) {
    // Check if phone is PRE_REGISTERED so we show exact onboarding prompt
    if (looksLikePhone) {
      const normalizedWa = normalizeWhatsapp(raw);
      const wHash = hashWhatsappServer(normalizedWa);
      const pubSnap = await db.collection('onboardingPublicStatus').doc(wHash).get();
      if (pubSnap.exists && (pubSnap.data() as { status?: string }).status === 'PRE_REGISTERED') {
        const err = new Error(PRE_REGISTERED_LOGIN_BLOCKED_MESSAGE) as Error & {
          code?: string;
          statusCode?: number;
        };
        err.code = 'PRE_REGISTERED_INCOMPLETE';
        err.statusCode = 403;
        throw err;
      }
    }
    throw new Error('Username/WhatsApp atau password tidak sesuai.');
  }

  const { uid, authEmail } = idxSnap.data() as { uid: string; authEmail: string };

  // Verify password against Firebase Auth Identity Toolkit REST API
  const verifyRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseAppletConfig.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: authEmail,
        password,
        returnSecureToken: false,
      }),
    }
  );

  if (!verifyRes.ok) {
    throw new Error('Username/WhatsApp atau password tidak sesuai.');
  }

  const memberSnap = await db.collection('members').doc(uid).get();
  if (!memberSnap.exists) {
    throw new Error('Akun tidak dapat diakses. Silakan hubungi admin XP PLAY.');
  }

  const member = memberSnap.data() as MemberProfile;
  if (isPreRegisteredMember(member)) {
    const err = new Error(PRE_REGISTERED_LOGIN_BLOCKED_MESSAGE) as Error & {
      code?: string;
      statusCode?: number;
    };
    err.code = 'PRE_REGISTERED_INCOMPLETE';
    err.statusCode = 403;
    throw err;
  }
  if (member.status === 'SUSPENDED') {
    throw new Error('Akun Anda sedang ditangguhkan sementara. Hubungi admin XP PLAY.');
  }
  if (member.status === 'DELETED') {
    throw new Error('Username/WhatsApp atau password tidak sesuai.');
  }

  const customToken = await adminAuth.createCustomToken(uid);
  return { customToken, uid };
}

export async function recordTransactionXpServer(input: {
  identifier: string;
  amountIdr: number;
  branch: BranchId;
  receiptNumber?: string;
  note?: string;
  adminUid: string;
  adminName: string;
  adminRole: AdminRole;
}) {
  const db = getAdminDb();
  if (!db) throw new Error('ADMIN_SDK_UNAVAILABLE');

  if (!Number.isSafeInteger(input.amountIdr) || input.amountIdr <= 0) {
    throw new Error('Nominal transaksi harus bilangan bulat lebih dari 0.');
  }

  const raw = input.identifier.trim();
  const digits = raw.replace(/\D/g, '');
  const looksLikePhone = /^\+?[0-9\s\-]{8,18}$/.test(raw) && digits.length >= 9;
  const normalizedWa = normalizeWhatsapp(raw);
  const normalizedUser = normalizeUsername(raw);
  const indexKey = looksLikePhone ? `wa:${normalizedWa}` : `username:${normalizedUser}`;

  let uid: string | null = null;
  const idxSnap = await db.collection('identityIndex').doc(indexKey).get();
  if (idxSnap.exists) {
    uid = (idxSnap.data() as { uid: string }).uid;
  } else {
    const memberQuerySnap = await db
      .collection('members')
      .where(looksLikePhone ? 'whatsapp' : 'username', '==', looksLikePhone ? normalizedWa : normalizedUser)
      .limit(1)
      .get();
    if (!memberQuerySnap.empty) {
      uid = memberQuerySnap.docs[0].id;
    }
  }

  if (!uid) {
    throw new Error('Member dengan username atau nomor WhatsApp tersebut tidak ditemukan.');
  }

  return db.runTransaction(async (tx) => {
    const now = Date.now();
    const { settings, levels } = await getSettingsAndLevels(db);
    const memberRef = db.collection('members').doc(uid);
    const memberSnap = await tx.get(memberRef);

    if (!memberSnap.exists) {
      throw new Error('Profil member tidak ditemukan.');
    }

    const member = memberSnap.data() as MemberProfile;
    if (member.status !== 'ACTIVE' && member.status !== 'PRE_REGISTERED') {
      throw new Error(`Member berstatus ${member.status} dan tidak dapat menerima transaksi.`);
    }

    const xpGenerated = calculateTransactionXp(input.amountIdr, settings.transactionXpRate);
    const newProgress = member.xpProgress + xpGenerated;
    const newReward = member.xpReward + xpGenerated;
    const isManualOverride = member.levelMode === 'MANUAL_OVERRIDE';
    const levelEval = resolveLevelFromXp(newProgress, levels);
    const nextLevel: LevelId = isManualOverride ? member.currentLevel : levelEval.current.id;
    const nextLevelMode: LevelMode = isManualOverride ? 'MANUAL_OVERRIDE' : 'AUTOMATIC';

    const txId = generateDocId('trx');
    const txDoc = {
      id: txId,
      memberId: member.memberId,
      memberUid: member.uid,
      memberUsername: member.username,
      branch: input.branch,
      amountIdr: input.amountIdr,
      xpRateUsed: settings.transactionXpRate,
      xpGenerated,
      source: 'TRANSACTION' as const,
      receiptNumber: (input.receiptNumber || '').trim().slice(0, 64),
      note: (input.note || '').trim().slice(0, 300),
      adminId: input.adminUid,
      adminName: input.adminName,
      cycleId: settings.currentCycleId,
      createdAt: now,
    };

    tx.set(db.collection('transactions').doc(txId), txDoc);
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
      const progId = generateDocId('xpp');
      const rewId = generateDocId('xpr');
      tx.set(db.collection('xpProgressLedger').doc(progId), {
        id: progId,
        memberId: member.memberId,
        memberUid: member.uid,
        memberUsername: member.username,
        amount: xpGenerated,
        beforeBalance: member.xpProgress,
        afterBalance: newProgress,
        type: 'PROGRESS',
        direction: 'CREDIT',
        source: 'TRANSACTION',
        referenceId: txId,
        branch: input.branch,
        cycleId: settings.currentCycleId,
        createdAt: now,
        createdBy: input.adminUid,
        note: `Transaksi Rp${input.amountIdr.toLocaleString('id-ID')} (${input.branch})`,
      });
      tx.set(db.collection('xpRewardLedger').doc(rewId), {
        id: rewId,
        memberId: member.memberId,
        memberUid: member.uid,
        memberUsername: member.username,
        amount: xpGenerated,
        beforeBalance: member.xpReward,
        afterBalance: newReward,
        type: 'REWARD',
        direction: 'CREDIT',
        source: 'TRANSACTION',
        referenceId: txId,
        branch: input.branch,
        cycleId: settings.currentCycleId,
        createdAt: now,
        createdBy: input.adminUid,
        note: `Transaksi Rp${input.amountIdr.toLocaleString('id-ID')} (${input.branch})`,
      });
    }

    if (!isManualOverride && nextLevel !== member.currentLevel) {
      const lhId = generateDocId('lvl');
      tx.set(db.collection('levelHistory').doc(lhId), {
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

      const notifId = generateDocId('notif');
      tx.set(db.collection('memberNotifications').doc(notifId), {
        id: notifId,
        memberId: member.memberId,
        memberUid: member.uid,
        notificationCampaignId: null,
        category: 'LEVEL_UP',
        title: `Level Up: ${levelEval.current.name}!`,
        message: `Selamat! Transaksi di XP PLAY ${input.branch} membawa XP Progress Anda ke ${newProgress} XP (Level ${levelEval.current.name}).`,
        read: false,
        readAt: null,
        status: 'SENT',
        sentAt: now,
        createdAt: now,
      });
    }

    const auditId = generateDocId('audit');
    tx.set(db.collection('auditLogs').doc(auditId), {
      id: auditId,
      actorId: input.adminUid,
      actorRole: input.adminRole,
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
      metadata: { receiptNumber: txDoc.receiptNumber },
      timestamp: now,
    });

    return { transaction: txDoc, xpGenerated, newProgress, newReward, newLevel: nextLevel };
  });
}

export async function reviewClaimServer(input: {
  claimId: string;
  decision: 'APPROVED' | 'DENIED';
  reason?: string;
  adminUid: string;
  adminRole: AdminRole;
}) {
  const db = getAdminDb();
  if (!db) throw new Error('ADMIN_SDK_UNAVAILABLE');

  return db.runTransaction(async (tx) => {
    const now = Date.now();
    const claimRef = db.collection('claims').doc(input.claimId);
    const claimSnap = await tx.get(claimRef);
    if (!claimSnap.exists) throw new Error('Data claim tidak ditemukan.');

    const claim = claimSnap.data() as ClaimRecord;
    // Idempotency guard: never process twice
    if (claim.status !== 'ON_PROCESS') {
      throw new Error(`Claim sudah diproses sebelumnya dengan status ${claim.status}.`);
    }

    const memberRef = db.collection('members').doc(claim.memberUid);
    const campaignRef = db.collection('campaigns').doc(claim.campaignId);
    const [memberSnap, campaignSnap] = await Promise.all([
      tx.get(memberRef),
      tx.get(campaignRef),
    ]);
    if (!memberSnap.exists) throw new Error('Member tidak ditemukan.');
    const member = memberSnap.data() as MemberProfile;

    const { settings, levels } = await getSettingsAndLevels(db);

    if (input.decision === 'DENIED') {
      const denialReason = (input.reason || 'Bukti belum memenuhi syarat.').trim().slice(0, 300);
      tx.update(claimRef, {
        status: 'DENIED',
        reviewedBy: input.adminUid,
        reviewerRole: input.adminRole,
        reviewedAt: now,
        denialReason,
      });

      const notifId = generateDocId('notif');
      tx.set(db.collection('memberNotifications').doc(notifId), {
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

      const auditId = generateDocId('audit');
      tx.set(db.collection('auditLogs').doc(auditId), {
        id: auditId,
        actorId: input.adminUid,
        actorRole: input.adminRole,
        action: 'CLAIM_DENY',
        targetType: 'claim',
        targetId: claim.id,
        before: { status: 'ON_PROCESS' },
        after: { status: 'DENIED', denialReason },
        metadata: null,
        timestamp: now,
      });

      return { status: 'DENIED', member };
    }

    // APPROVED
    if (campaignSnap.exists) {
      const campData = campaignSnap.data() as CampaignItem;
      if (campData.totalClaimLimit !== null && campData.claimsCount >= campData.totalClaimLimit) {
        throw new Error('Kuota total claim program ini telah habis.');
      }
      tx.update(campaignRef, {
        claimsCount: (campData.claimsCount || 0) + 1,
        updatedAt: now,
      });
    }

    const xpAmount = Math.max(0, Math.floor(claim.xpRewardSnapshot || 0));
    const isPromoClaim = claim.campaignType === 'PROMO';
    const isManualOverride = member.levelMode === 'MANUAL_OVERRIDE';

    let newProgress = member.xpProgress;
    let newReward = member.xpReward;
    let nextLevel: LevelId = member.currentLevel;
    const nextLevelMode: LevelMode = isManualOverride ? 'MANUAL_OVERRIDE' : 'AUTOMATIC';

    if (isPromoClaim) {
      if (member.xpReward < xpAmount) {
        throw new Error(
          `XP Reward member (${member.xpReward} XP) tidak mencukupi untuk klaim promo ini (butuh ${xpAmount} XP).`
        );
      }
      newReward = member.xpReward - xpAmount;
    } else {
      newProgress = member.xpProgress + xpAmount;
      newReward = member.xpReward + xpAmount;
      const levelEval = resolveLevelFromXp(newProgress, levels);
      nextLevel = isManualOverride ? member.currentLevel : levelEval.current.id;
    }

    tx.update(claimRef, {
      status: 'APPROVED',
      reviewedBy: input.adminUid,
      reviewerRole: input.adminRole,
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

    if (isPromoClaim) {
      if (xpAmount > 0) {
        const rewId = generateDocId('xpr');
        tx.set(db.collection('xpRewardLedger').doc(rewId), {
          id: rewId,
          memberId: member.memberId,
          memberUid: member.uid,
          amount: -xpAmount,
          type: 'REWARD',
          direction: 'DEBIT',
          source: 'PROMO',
          referenceId: claim.id,
          branch: null,
          cycleId: settings.currentCycleId,
          createdAt: now,
          createdBy: input.adminUid,
          note: `Promo disetujui (-${xpAmount} XP): ${claim.campaignTitle}`,
        });
      }
    } else {
      const progId = generateDocId('xpp');
      const rewId = generateDocId('xpr');
      tx.set(db.collection('xpProgressLedger').doc(progId), {
        id: progId,
        memberId: member.memberId,
        memberUid: member.uid,
        amount: xpAmount,
        type: 'PROGRESS',
        direction: 'CREDIT',
        source: claim.campaignType,
        referenceId: claim.id,
        branch: null,
        cycleId: settings.currentCycleId,
        createdAt: now,
        createdBy: input.adminUid,
        note: `Claim disetujui: ${claim.campaignTitle}`,
      });
      tx.set(db.collection('xpRewardLedger').doc(rewId), {
        id: rewId,
        memberId: member.memberId,
        memberUid: member.uid,
        amount: xpAmount,
        type: 'REWARD',
        direction: 'CREDIT',
        source: claim.campaignType,
        referenceId: claim.id,
        branch: null,
        cycleId: settings.currentCycleId,
        createdAt: now,
        createdBy: input.adminUid,
        note: `Claim disetujui: ${claim.campaignTitle}`,
      });
    }

    if (!isPromoClaim && !isManualOverride && nextLevel !== member.currentLevel) {
      const lhId = generateDocId('lvl');
      tx.set(db.collection('levelHistory').doc(lhId), {
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

    const notifId = generateDocId('notif');
    tx.set(db.collection('memberNotifications').doc(notifId), {
      id: notifId,
      memberId: member.memberId,
      memberUid: member.uid,
      notificationCampaignId: null,
      category: 'CLAIM',
      title: isPromoClaim
        ? `Promo Disetujui (-${xpAmount} XP)`
        : `Claim Disetujui (+${xpAmount} XP)`,
      message: isPromoClaim
        ? `Promo "${claim.campaignTitle}" disetujui. Saldo XP Reward Anda terpotong ${xpAmount} XP (sisa ${newReward} XP).`
        : `Claim "${claim.campaignTitle}" disetujui. XP Progress dan XP Reward Anda bertambah ${xpAmount} XP.`,
      read: false,
      readAt: null,
      status: 'SENT',
      sentAt: now,
      createdAt: now,
    });

    const auditId = generateDocId('audit');
    tx.set(db.collection('auditLogs').doc(auditId), {
      id: auditId,
      actorId: input.adminUid,
      actorRole: input.adminRole,
      action: 'CLAIM_APPROVE',
      targetType: 'claim',
      targetId: claim.id,
      before: { status: 'ON_PROCESS', xpProgress: member.xpProgress, xpReward: member.xpReward },
      after: { status: 'APPROVED', xpProgress: newProgress, xpReward: newReward },
      metadata: null,
      timestamp: now,
    });

    return { status: 'APPROVED', xpAward: isPromoClaim ? -xpAmount : xpAmount, newProgress, newReward };
  });
}

export async function reviewRedemptionServer(input: {
  redemptionId: string;
  decision: 'APPROVED' | 'DENIED';
  reason?: string;
  adminUid: string;
  adminRole: AdminRole;
}) {
  const db = getAdminDb();
  if (!db) throw new Error('ADMIN_SDK_UNAVAILABLE');

  return db.runTransaction(async (tx) => {
    const now = Date.now();
    const redRef = db.collection('redemptions').doc(input.redemptionId);
    const redSnap = await tx.get(redRef);
    if (!redSnap.exists) throw new Error('Data redemption tidak ditemukan.');

    const redemption = redSnap.data() as RedemptionRecord;
    if (redemption.status !== 'ON_PROCESS') {
      throw new Error(`Redemption sudah diproses sebelumnya (${redemption.status}).`);
    }

    const memberRef = db.collection('members').doc(redemption.memberUid);
    const memberSnap = await tx.get(memberRef);
    if (!memberSnap.exists) throw new Error('Member tidak ditemukan.');
    const member = memberSnap.data() as MemberProfile;

    const benefitRef = db.collection('benefits').doc(redemption.benefitId);
    const benefitSnap = await tx.get(benefitRef);

    const { settings, levels } = await getSettingsAndLevels(db);

    if (input.decision === 'DENIED') {
      const denialReason = (input.reason || 'Permintaan penukaran belum memenuhi syarat.').trim().slice(0, 300);
      tx.update(redRef, {
        status: 'DENIED',
        reviewedBy: input.adminUid,
        reviewerRole: input.adminRole,
        reviewedAt: now,
        denialReason,
      });

      const notifId = generateDocId('notif');
      tx.set(db.collection('memberNotifications').doc(notifId), {
        id: notifId,
        memberId: member.memberId,
        memberUid: member.uid,
        notificationCampaignId: null,
        category: 'REDEMPTION',
        title: `Redemption Ditolak: ${redemption.benefitName}`,
        message: `Penukaran benefit ditolak (${denialReason}). Saldo XP Reward Anda tidak berkurang.`,
        read: false,
        readAt: null,
        status: 'SENT',
        sentAt: now,
        createdAt: now,
      });

      const auditId = generateDocId('audit');
      tx.set(db.collection('auditLogs').doc(auditId), {
        id: auditId,
        actorId: input.adminUid,
        actorRole: input.adminRole,
        action: 'REDEMPTION_DENY',
        targetType: 'redemption',
        targetId: redemption.id,
        before: { status: 'ON_PROCESS', xpReward: member.xpReward },
        after: { status: 'DENIED', xpReward: member.xpReward, denialReason },
        metadata: null,
        timestamp: now,
      });

      return { status: 'DENIED', xpReward: member.xpReward, xpProgress: member.xpProgress };
    }

    // APPROVED: Check effective level requirement & non-negative XP Reward
    const effectiveLevel = resolveEffectiveMemberLevel(member, levels).id;
    if (!isLevelEligible(effectiveLevel, redemption.levelRequirement, levels)) {
      throw new Error(`Level member (${effectiveLevel}) belum memenuhi syarat (${redemption.levelRequirement}).`);
    }

    const cost = redemption.xpCostSnapshot;
    if (member.xpReward < cost) {
      throw new Error('XP Reward member tidak mencukupi untuk menyetujui redemption ini.');
    }

    // Optional stock check
    if (benefitSnap.exists) {
      const bData = benefitSnap.data() as { stock?: number | null };
      if (typeof bData.stock === 'number') {
        if (bData.stock <= 0) {
          throw new Error('Stok benefit sudah habis.');
        }
        tx.update(benefitRef, { stock: bData.stock - 1, updatedAt: now });
      }
    }

    // CRITICAL INVARIANT: Only XP Reward decreases; XP Progress & Level NEVER decrease on redemption!
    const newReward = member.xpReward - cost;

    tx.update(redRef, {
      status: 'APPROVED',
      reviewedBy: input.adminUid,
      reviewerRole: input.adminRole,
      reviewedAt: now,
      denialReason: null,
    });

    tx.update(memberRef, {
      xpReward: newReward,
      updatedAt: now,
    });

    if (cost > 0) {
      const rewId = generateDocId('xpr');
      tx.set(db.collection('xpRewardLedger').doc(rewId), {
        id: rewId,
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
        createdBy: input.adminUid,
        note: `Redeem benefit: ${redemption.benefitName}`,
      });
    }

    const notifId = generateDocId('notif');
    tx.set(db.collection('memberNotifications').doc(notifId), {
      id: notifId,
      memberId: member.memberId,
      memberUid: member.uid,
      notificationCampaignId: null,
      category: 'REDEMPTION',
      title: `Redemption Disetujui: ${redemption.benefitName}`,
      message: `Penukaran benefit "${redemption.benefitName}" telah disetujui. Sisa XP Reward Anda: ${newReward} XP.`,
      read: false,
      readAt: null,
      status: 'SENT',
      sentAt: now,
      createdAt: now,
    });

    const auditId = generateDocId('audit');
    tx.set(db.collection('auditLogs').doc(auditId), {
      id: auditId,
      actorId: input.adminUid,
      actorRole: input.adminRole,
      action: 'REDEMPTION_APPROVE',
      targetType: 'redemption',
      targetId: redemption.id,
      before: { status: 'ON_PROCESS', xpProgress: member.xpProgress, xpReward: member.xpReward, level: member.currentLevel },
      after: { status: 'APPROVED', xpProgress: member.xpProgress, xpReward: newReward, level: member.currentLevel },
      metadata: null,
      timestamp: now,
    });

    return {
      status: 'APPROVED',
      xpReward: newReward,
      xpProgress: member.xpProgress,
      currentLevel: member.currentLevel,
    };
  });
}

export async function expireOverdueCampaignsServer(): Promise<number> {
  const db = getAdminDb();
  if (!db) return 0;

  const now = Date.now();
  const snap = await db.collection('campaigns').where('status', '==', 'ACTIVE').get();
  if (snap.empty) return 0;

  const batch = db.batch();
  let count = 0;
  for (const docSnap of snap.docs) {
    const camp = docSnap.data() as CampaignItem;
    if (now > camp.endAt) {
      batch.update(docSnap.ref, { status: 'EXPIRED', active: false, updatedAt: now });
      count++;
    }
  }
  if (count > 0) {
    await batch.commit();
  }
  return count;
}

export async function executeCycleResetServer(input: {
  nextCycleId: string;
  nextCycleName: string;
  resetReason: string;
  adminUid: string;
  adminRole: AdminRole;
}) {
  const db = getAdminDb();
  if (!db) throw new Error('ADMIN_SDK_UNAVAILABLE');

  const nextCycleId = input.nextCycleId.trim();
  if (nextCycleId.length < 2 || nextCycleId.length > 64) {
    throw new Error('ID cycle baru harus 2 hingga 64 karakter.');
  }

  const settingsRef = db.collection('systemSettings').doc('default');
  const settingsSnap = await settingsRef.get();
  const settings = settingsSnap.exists
    ? (settingsSnap.data() as SystemSettings)
    : DEFAULT_SYSTEM_SETTINGS;

  if (settings.currentCycleId === nextCycleId) {
    throw new Error(`Cycle ${nextCycleId} sudah aktif. Reset bersifat idempoten dan tidak dapat dijalankan dua kali untuk ID yang sama.`);
  }

  const nextCycleRef = db.collection('membershipCycles').doc(nextCycleId);
  const existingNext = await nextCycleRef.get();
  if (existingNext.exists) {
    throw new Error(`Cycle ${nextCycleId} sudah pernah dibuat sebelumnya.`);
  }

  const now = Date.now();
  const prevCycleId = settings.currentCycleId;

  // Paginate members in batches of 200 to stay within Firestore 500-op batch limits
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let processedMembers = 0;

  while (true) {
    let q = db.collection('members').orderBy('createdAt').limit(100);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    const batch = db.batch();
    for (const mDoc of snap.docs) {
      const m = mDoc.data() as MemberProfile;
      if (m.currentCycleId === nextCycleId) continue; // Idempotency guard

      const newProgress = settings.resetXpProgress ? 0 : m.xpProgress;
      const newReward = settings.resetXpReward ? 0 : m.xpReward;
      const newLevel: LevelId = settings.resetLevel ? 'BRONZE' : m.currentLevel;
      const newLevelMode: LevelMode = settings.resetLevel ? 'RESET' : (m.levelMode ?? 'AUTOMATIC');

      const snapshotId = `${prevCycleId}__${m.uid}`;
      batch.set(db.collection('cycleSnapshots').doc(snapshotId), {
        id: snapshotId,
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
        executedBy: input.adminUid,
      });

      batch.update(mDoc.ref, {
        xpProgress: newProgress,
        xpReward: newReward,
        currentLevel: newLevel,
        levelMode: newLevelMode,
        currentCycleId: nextCycleId,
        updatedAt: now,
      });

      if (settings.resetXpProgress && m.xpProgress > 0) {
        const lid = generateDocId('xpp');
        batch.set(db.collection('xpProgressLedger').doc(lid), {
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
          createdBy: input.adminUid,
          note: `Reset cycle ke ${nextCycleId}: ${input.resetReason}`,
        });
      }

      if (settings.resetXpReward && m.xpReward > 0) {
        const lid = generateDocId('xpr');
        batch.set(db.collection('xpRewardLedger').doc(lid), {
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
          createdBy: input.adminUid,
          note: `Reset cycle ke ${nextCycleId}: ${input.resetReason}`,
        });
      }

      const notifId = generateDocId('notif');
      batch.set(db.collection('memberNotifications').doc(notifId), {
        id: notifId,
        memberId: m.memberId,
        memberUid: m.uid,
        notificationCampaignId: null,
        category: 'RESET',
        title: `Season Baru Dimulai: ${input.nextCycleName}`,
        message: `Membership cycle ${prevCycleId} telah ditutup dan berpindah ke ${nextCycleId}. Riwayat Anda tetap tersimpan aman.`,
        read: false,
        readAt: null,
        status: 'SENT',
        sentAt: now,
        createdAt: now,
      });

      processedMembers++;
    }

    await batch.commit();
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < 100) break;
  }

  // Update cycles & settings
  const batchFinal = db.batch();
  batchFinal.set(
    db.collection('membershipCycles').doc(prevCycleId),
    { status: 'CLOSED', endedAt: now },
    { merge: true }
  );
  batchFinal.set(nextCycleRef, {
    id: nextCycleId,
    name: input.nextCycleName.trim() || nextCycleId,
    startedAt: now,
    endedAt: null,
    status: 'ACTIVE',
    resetCount: processedMembers,
    createdBy: input.adminUid,
  });

  const intervalMs =
    settings.resetUnit === 'MONTHS'
      ? settings.resetInterval * 30 * 24 * 60 * 60 * 1000
      : settings.resetInterval * 24 * 60 * 60 * 1000;

  batchFinal.set(
    settingsRef,
    {
      currentCycleId: nextCycleId,
      nextResetAt: settings.resetEnabled ? now + intervalMs : null,
      updatedAt: now,
      updatedBy: input.adminUid,
    },
    { merge: true }
  );

  const auditId = generateDocId('audit');
  batchFinal.set(db.collection('auditLogs').doc(auditId), {
    id: auditId,
    actorId: input.adminUid,
    actorRole: input.adminRole,
    action: 'CYCLE_RESET',
    targetType: 'membershipCycle',
    targetId: nextCycleId,
    before: { cycleId: prevCycleId },
    after: { cycleId: nextCycleId, processedMembers, reason: input.resetReason },
    metadata: null,
    timestamp: now,
  });

  await batchFinal.commit();
  return { prevCycleId, nextCycleId, processedMembers };
}

export async function adjustMemberXpServer(input: {
  operationId: string;
  kind: XpAdjustmentKind;
  identifier?: string;
  memberUid?: string;
  adjustment: number;
  reason: string;
  reference?: string;
  adminUid: string;
  adminEmail: string;
  adminRole: AdminRole;
}): Promise<{
  record: XpAdjustmentRecord;
  newXpProgress: number;
  newXpReward: number;
  levelAfter: LevelId;
}> {
  const db = getAdminDb();
  if (!db) throw new Error('ADMIN_SDK_UNAVAILABLE');

  if (input.kind !== 'PROGRESS' && input.kind !== 'REWARD') {
    throw new Error('Jenis adjustment harus PROGRESS atau REWARD.');
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

  let uid = (input.memberUid || '').trim();
  if (!uid) {
    const raw = (input.identifier || '').trim();
    if (!raw) {
      throw new Error('Username atau nomor WhatsApp member wajib diisi.');
    }
    const digits = raw.replace(/\D/g, '');
    const looksLikePhone = /^\+?[0-9\s\-]{8,18}$/.test(raw) && digits.length >= 9;
    const normalizedWa = normalizeWhatsapp(raw);
    const normalizedUser = normalizeUsername(raw);
    const indexKey = looksLikePhone ? `wa:${normalizedWa}` : `username:${normalizedUser}`;
    const idxSnap = await db.collection('identityIndex').doc(indexKey).get();
    if (idxSnap.exists) {
      uid = (idxSnap.data() as { uid: string }).uid;
    } else {
      const qSnap = await db
        .collection('members')
        .where(looksLikePhone ? 'whatsapp' : 'username', '==', looksLikePhone ? normalizedWa : normalizedUser)
        .limit(1)
        .get();
      if (!qSnap.empty) {
        uid = qSnap.docs[0].id;
      }
    }
  }

  if (!uid) {
    throw new Error('Member dengan username atau nomor WhatsApp tersebut tidak ditemukan.');
  }

  const adjDocId = `adj_${cleanOpId}`;

  return db.runTransaction(async (tx) => {
    const now = Date.now();
    const adjRef = db.collection('xpAdjustments').doc(adjDocId);
    const existingAdj = await tx.get(adjRef);
    if (existingAdj.exists) {
      throw new Error('Penyesuaian XP dengan ID operasi ini sudah diproses sebelumnya.');
    }

    const { settings, levels } = await getSettingsAndLevels(db);
    const memberRef = db.collection('members').doc(uid);
    const memberSnap = await tx.get(memberRef);
    if (!memberSnap.exists) {
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

    const auditId = generateDocId('audit');
    const ledgerCollection = input.kind === 'PROGRESS' ? 'xpProgressLedger' : 'xpRewardLedger';
    const ledgerId = generateDocId(input.kind === 'PROGRESS' ? 'xpp' : 'xpr');
    const ledgerSource = input.kind === 'PROGRESS' ? 'ADMIN_ADJUSTMENT' : 'XP_REWARD_ADMIN_ADJUSTMENT';

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
    tx.set(db.collection(ledgerCollection).doc(ledgerId), {
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
      createdBy: input.adminUid,
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
      adminId: input.adminUid,
      adminEmail: input.adminEmail,
      adminRole: input.adminRole,
      cycleId: settings.currentCycleId,
      timestamp: now,
    };

    tx.set(adjRef, adjRecord);

    if (input.kind === 'PROGRESS' && computed.levelChanged) {
      const lhId = generateDocId('lvl');
      tx.set(db.collection('levelHistory').doc(lhId), {
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

    const notifId = generateDocId('notif');
    const signStr = input.adjustment > 0 ? `+${input.adjustment}` : `${input.adjustment}`;
    const balanceLabel = input.kind === 'PROGRESS' ? 'XP Progress' : 'XP Reward';
    tx.set(db.collection('memberNotifications').doc(notifId), {
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

    tx.set(db.collection('auditLogs').doc(auditId), {
      id: auditId,
      actorId: input.adminUid,
      actorRole: input.adminRole,
      action: input.kind === 'PROGRESS' ? 'XP_PROGRESS_ADMIN_ADJUSTMENT' : 'XP_REWARD_ADMIN_ADJUSTMENT',
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
}

export async function overrideMemberLevelServer(input: {
  operationId: string;
  action: LevelOverrideAction;
  identifier?: string;
  memberUid?: string;
  targetLevel?: LevelId;
  reason: string;
  reference?: string;
  adminUid: string;
  adminEmail: string;
  adminRole: AdminRole;
}): Promise<{
  record: LevelOverrideRecord;
  newLevel: LevelId;
  newLevelMode: 'AUTOMATIC' | 'MANUAL_OVERRIDE';
}> {
  const db = getAdminDb();
  if (!db) throw new Error('ADMIN_SDK_UNAVAILABLE');

  if (input.action !== 'MANUAL_OVERRIDE' && input.action !== 'RECALCULATE') {
    throw new Error('Aksi level harus MANUAL_OVERRIDE atau RECALCULATE.');
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

  let uid = (input.memberUid || '').trim();
  if (!uid) {
    const raw = (input.identifier || '').trim();
    if (!raw) {
      throw new Error('Username atau nomor WhatsApp member wajib diisi.');
    }
    const digits = raw.replace(/\D/g, '');
    const looksLikePhone = /^\+?[0-9\s\-]{8,18}$/.test(raw) && digits.length >= 9;
    const normalizedWa = normalizeWhatsapp(raw);
    const normalizedUser = normalizeUsername(raw);
    const indexKey = looksLikePhone ? `wa:${normalizedWa}` : `username:${normalizedUser}`;
    const idxSnap = await db.collection('identityIndex').doc(indexKey).get();
    if (idxSnap.exists) {
      uid = (idxSnap.data() as { uid: string }).uid;
    } else {
      const qSnap = await db
        .collection('members')
        .where(looksLikePhone ? 'whatsapp' : 'username', '==', looksLikePhone ? normalizedWa : normalizedUser)
        .limit(1)
        .get();
      if (!qSnap.empty) {
        uid = qSnap.docs[0].id;
      }
    }
  }

  if (!uid) {
    throw new Error('Member dengan username atau nomor WhatsApp tersebut tidak ditemukan.');
  }

  const ovrDocId = `ovr_${cleanOpId}`;

  return db.runTransaction(async (tx) => {
    const now = Date.now();
    const ovrRef = db.collection('levelOverrides').doc(ovrDocId);
    const existingOvr = await tx.get(ovrRef);
    if (existingOvr.exists) {
      throw new Error('Operasi Level Override dengan ID ini sudah diproses sebelumnya.');
    }

    const { settings, levels } = await getSettingsAndLevels(db);
    const memberRef = db.collection('members').doc(uid);
    const memberSnap = await tx.get(memberRef);
    if (!memberSnap.exists) {
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

    const auditId = generateDocId('audit');
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
      adminId: input.adminUid,
      adminEmail: input.adminEmail,
      adminRole: input.adminRole,
      cycleId: settings.currentCycleId,
      timestamp: now,
    };

    tx.set(ovrRef, overrideRecord);

    const lhId = generateDocId('lvl');
    tx.set(db.collection('levelHistory').doc(lhId), {
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

    const notifId = generateDocId('notif');
    tx.set(db.collection('memberNotifications').doc(notifId), {
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

    tx.set(db.collection('auditLogs').doc(auditId), {
      id: auditId,
      actorId: input.adminUid,
      actorRole: input.adminRole,
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
}

export async function changeMemberPasswordServer(input: {
  operationId: string;
  memberUid: string;
  newPassword: string;
  confirmPassword: string;
  reason: string;
  reference?: string;
  revokeSessions?: boolean;
  adminUid: string;
  adminEmail: string;
  adminRole: AdminRole;
}): Promise<AdminPasswordChangeResult> {
  const adminAuth = getAdminAuth();
  const db = getAdminDb();
  if (!adminAuth || !db) {
    const err = new Error(
      'Firebase Admin SDK (FIREBASE_SERVICE_ACCOUNT_JSON) belum dikonfigurasi di server. Perubahan password member oleh Admin wajib menggunakan Firebase Admin SDK agar aman dan tidak boleh dilakukan dari sisi klien.'
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 503;
    err.code = 'ADMIN_SDK_UNAVAILABLE';
    throw err;
  }

  if (input.adminRole !== 'SUPER_ADMIN' && input.adminRole !== 'ADMIN') {
    const err = new Error('Hanya SUPER_ADMIN atau ADMIN yang diizinkan mengubah password member.') as Error & {
      statusCode?: number;
    };
    err.statusCode = 403;
    throw err;
  }

  const cleanOpId = (input.operationId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (cleanOpId.length < 6 || cleanOpId.length > 80) {
    throw new Error('Operation ID tidak valid.');
  }

  const pwdCheck = validateAdminNewPassword(input.newPassword, input.confirmPassword);
  if (!pwdCheck.valid) {
    throw new Error(pwdCheck.error || 'Password baru tidak memenuhi ketentuan keamanan.');
  }

  const cleanReason = (input.reason || '').trim().slice(0, 300);
  if (cleanReason.length < 3) {
    throw new Error('Alasan perubahan password wajib diisi (minimal 3 karakter).');
  }
  const cleanRef = (input.reference || '').trim().slice(0, 120);
  const uid = (input.memberUid || '').trim();
  if (!uid) {
    throw new Error('UID member wajib diisi.');
  }

  const memberSnap = await db.collection('members').doc(uid).get();
  if (!memberSnap.exists) {
    throw new Error('Profil member tidak ditemukan.');
  }
  const member = memberSnap.data() as MemberProfile;
  if (member.status === 'DELETED') {
    throw new Error('Akun member berstatus DELETED dan password-nya tidak dapat diubah.');
  }

  // Update password securely via Firebase Admin Auth API (NEVER stored in Firestore or logs)
  await adminAuth.updateUser(uid, { password: input.newPassword });

  const shouldRevoke = input.revokeSessions !== false;
  if (shouldRevoke) {
    await adminAuth.revokeRefreshTokens(uid);
  }

  const now = Date.now();
  const auditId = generateDocId('audit');
  const notifId = generateDocId('notif');

  const batch = db.batch();
  // STRICT SECURITY INVARIANT: ZERO password fields (no oldPassword, no newPassword, no hash)
  batch.set(db.collection('auditLogs').doc(auditId), {
    id: auditId,
    actorId: input.adminUid,
    actorRole: input.adminRole,
    action: 'PASSWORD_CHANGED_BY_ADMIN',
    targetType: 'member',
    targetId: member.uid,
    before: null,
    after: {
      sessionsRevoked: shouldRevoke,
      changedAt: now,
    },
    metadata: {
      operationId: cleanOpId,
      adminId: input.adminUid,
      adminEmail: input.adminEmail,
      adminRole: input.adminRole,
      memberId: member.memberId,
      memberUid: member.uid,
      memberUsername: member.username,
      reason: cleanReason,
      reference: cleanRef,
      sessionsRevoked: shouldRevoke,
    },
    timestamp: now,
  });

  batch.set(db.collection('memberNotifications').doc(notifId), {
    id: notifId,
    memberId: member.memberId,
    memberUid: member.uid,
    notificationCampaignId: null,
    category: 'SYSTEM',
    title: 'Password Akun Diperbarui oleh Admin',
    message: shouldRevoke
      ? 'Password akun XP PLAY Anda telah diperbarui oleh Admin dan sesi aktif sebelumnya telah dikeluarkan. Silakan login kembali menggunakan password baru Anda.'
      : 'Password akun XP PLAY Anda telah diperbarui oleh Admin. Jika Anda tidak meminta perubahan ini, segera hubungi petugas XP PLAY.',
    read: false,
    readAt: null,
    status: 'SENT',
    sentAt: now,
    createdAt: now,
  });

  await batch.commit();

  return {
    operationId: cleanOpId,
    auditId,
    memberUid: member.uid,
    memberId: member.memberId,
    memberUsername: member.username,
    sessionsRevoked: shouldRevoke,
    timestamp: now,
  };
}

// ---------- FASE 1–6: UNIFIED BENEFIT REQUEST ENGINE (SERVER-AUTHORITATIVE) ----------

function generateBenefitRequestCode(): string {
  const num = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `BRQ-${num}`;
}

export async function submitBenefitRequestServer(input: {
  memberUid: string;
  sourceType: BenefitRequestSourceType;
  sourceId: string;
  evidenceUrl?: string;
  evidencePath?: string;
  note?: string;
  branch?: BranchId | null;
  assistedByUid?: string | null;
  assistedByRole?: AdminRole | null;
}): Promise<{
  request: BenefitRequestRecord;
  afterXpReward: number;
  afterReservedXp: number;
}> {
  const db = getAdminDb();
  if (!db) throw new Error('ADMIN_SDK_UNAVAILABLE');

  return db.runTransaction(async (tx) => {
    const now = Date.now();
    const { settings, levels } = await getSettingsAndLevels(db);
    const memberRef = db.collection('members').doc(input.memberUid);
    const memberSnap = await tx.get(memberRef);
    if (!memberSnap.exists) throw new Error('Profil member tidak ditemukan.');
    const member = memberSnap.data() as MemberProfile;

    const allowPreReg = Boolean(input.assistedByUid && input.assistedByRole);
    if (member.status !== 'ACTIVE' && !(allowPreReg && member.status === 'PRE_REGISTERED')) {
      throw new Error(`Akun member berstatus ${member.status} dan tidak dapat mengajukan benefit.`);
    }

    const isCampaign =
      input.sourceType === 'CHALLENGE' ||
      input.sourceType === 'EVENT' ||
      input.sourceType === 'PROMO';

    let title = '';
    let xpCost = 0;
    let xpRewardGrant = 0;
    let levelRequirement: LevelId = 'BRONZE';

    if (isCampaign) {
      const campSnap = await tx.get(db.collection('campaigns').doc(input.sourceId));
      if (!campSnap.exists) throw new Error('Program Challenge/Event/Promo tidak ditemukan.');
      const camp = campSnap.data() as CampaignItem;
      const claimable = isCampaignClaimable(camp, now);
      if (!claimable) throw new Error('Program tidak dapat diajukan saat ini (tidak aktif, kadaluarsa, atau kuota penuh).');
      if (camp.requiresEvidence && !(input.evidenceUrl || '').trim()) {
        throw new Error('Bukti foto wajib dilampirkan untuk program ini.');
      }

      // Enforce per-member claim limit across unified benefitRequests
      const existingReqs = await tx.get(
        db
          .collection('benefitRequests')
          .where('memberUid', '==', member.uid)
          .where('sourceId', '==', camp.id)
      );
      const validCount = existingReqs.docs.filter((d) => {
        const st = (d.data() as BenefitRequestRecord).status;
        return st === 'ON_PROCESS' || st === 'APPROVED' || st === 'USED';
      }).length;
      if (validCount >= camp.maxClaimsPerMember) {
        throw new Error(
          `Batas pengajuan program ini adalah ${camp.maxClaimsPerMember}x per member.`
        );
      }

      title = camp.title;
      const econ = resolveCampaignBenefitRequestEconomics(camp);
      xpCost = econ.xpCost;
      xpRewardGrant = econ.xpRewardGrant;
      levelRequirement = 'BRONZE';
    } else {
      const benSnap = await tx.get(db.collection('benefits').doc(input.sourceId));
      if (!benSnap.exists) throw new Error('Benefit tidak ditemukan.');
      const benefit = benSnap.data() as BenefitItem;
      if (!benefit.active) throw new Error('Benefit sedang tidak aktif.');
      if (benefit.expiryAt !== null && now > benefit.expiryAt) {
        throw new Error('Masa berlaku katalog benefit ini sudah berakhir.');
      }
      if (typeof benefit.stock === 'number' && benefit.stock <= 0) {
        throw new Error('Stok benefit sudah habis.');
      }

      const effectiveLevel = resolveEffectiveMemberLevel(member, levels).id;
      if (!isLevelEligible(effectiveLevel, benefit.levelRequirement, levels)) {
        throw new Error(
          `Level Anda (${effectiveLevel}) belum memenuhi syarat minimal ${benefit.levelRequirement}.`
        );
      }

      title = benefit.name;
      xpCost = Math.max(0, Math.floor(benefit.xpCost || 0));
      xpRewardGrant = 0;
      levelRequirement = benefit.levelRequirement;
    }

    const hold = computeBenefitHoldBalances({
      memberXpReward: member.xpReward,
      memberReservedXp: member.reservedXp ?? 0,
      memberXpProgress: member.xpProgress,
      memberLevel: member.currentLevel,
      xpCost,
    });

    const requestId = generateBenefitRequestCode();
    const holdLedgerId = xpCost > 0 ? generateDocId('xpr') : null;

    const reqDoc: BenefitRequestRecord = {
      id: requestId,
      memberId: member.memberId,
      memberUid: member.uid,
      memberUsername: member.username,
      memberName: member.fullName,
      memberWhatsapp: member.whatsapp,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      title,
      xpCost,
      xpRewardGrant,
      levelRequirement,
      evidenceUrl: (input.evidenceUrl || '').trim().slice(0, 500),
      evidencePath: (input.evidencePath || '').trim().slice(0, 500),
      note: (input.note || '').trim().slice(0, 300),
      status: 'ON_PROCESS',
      resolution: null,
      holdLedgerId,
      refundLedgerId: null,
      branch: input.branch ?? member.preferredBranch ?? null,
      approvedAt: null,
      approvedBy: null,
      approvedByRole: null,
      deniedAt: null,
      deniedBy: null,
      deniedReason: null,
      expiresAt: null,
      expiredAt: null,
      usedAt: null,
      usedBy: null,
      usedBranch: null,
      receiptReference: null,
      refundedAt: null,
      refundReason: null,
      refundedAmount: 0,
      cycleId: settings.currentCycleId,
      createdAt: now,
      updatedAt: now,
    };

    tx.set(db.collection('benefitRequests').doc(requestId), reqDoc);

    if (xpCost > 0 && holdLedgerId) {
      tx.update(memberRef, {
        xpReward: hold.afterXpReward,
        reservedXp: hold.afterReservedXp,
        updatedAt: now,
      });

      tx.set(db.collection('xpRewardLedger').doc(holdLedgerId), {
        id: holdLedgerId,
        memberId: member.memberId,
        memberUid: member.uid,
        memberUsername: member.username,
        amount: -xpCost,
        beforeBalance: hold.beforeXpReward,
        afterBalance: hold.afterXpReward,
        type: 'REWARD',
        direction: 'DEBIT',
        source: 'BENEFIT_REQUEST_HOLD',
        referenceId: requestId,
        branch: reqDoc.branch,
        cycleId: settings.currentCycleId,
        createdAt: now,
        createdBy: member.uid,
        note: `XP Ditahan (Hold) untuk Benefit Request: ${title}`,
      });
    }

    const auditId = generateDocId('audit');
    tx.set(db.collection('auditLogs').doc(auditId), {
      id: auditId,
      actorId: member.uid,
      actorRole: 'MEMBER',
      action: 'BENEFIT_REQUEST_CREATED',
      targetType: 'benefitRequest',
      targetId: requestId,
      before: { xpReward: hold.beforeXpReward, reservedXp: hold.beforeReservedXp },
      after: {
        status: 'ON_PROCESS',
        xpCost,
        xpRewardGrant,
        xpReward: hold.afterXpReward,
        reservedXp: hold.afterReservedXp,
      },
      metadata: { sourceType: input.sourceType, sourceId: input.sourceId, title },
      timestamp: now,
    });

    return {
      request: reqDoc,
      afterXpReward: hold.afterXpReward,
      afterReservedXp: hold.afterReservedXp,
    };
  });
}

export async function reviewBenefitRequestServer(input: {
  requestId: string;
  decision: 'APPROVED' | 'DENIED';
  reason?: string;
  adminUid: string;
  adminRole: AdminRole;
  adminBranchScope?: BranchId | 'ALL';
}) {
  const db = getAdminDb();
  if (!db) throw new Error('ADMIN_SDK_UNAVAILABLE');

  return db.runTransaction(async (tx) => {
    const now = Date.now();
    const reqRef = db.collection('benefitRequests').doc(input.requestId);
    const reqSnap = await tx.get(reqRef);
    if (!reqSnap.exists) throw new Error('Data Benefit Request tidak ditemukan.');
    const reqDoc = reqSnap.data() as BenefitRequestRecord;

    if (reqDoc.branch && isCashierRole(input.adminRole)) {
      assertCashierBranchAccess(
        { role: input.adminRole, branchScope: input.adminBranchScope ?? 'ALL' },
        reqDoc.branch,
        'memproses Benefit Request'
      );
    }

    if (reqDoc.status !== 'ON_PROCESS') {
      throw new Error(`Benefit Request sudah berstatus ${reqDoc.status} dan tidak dapat diproses ulang.`);
    }

    const memberRef = db.collection('members').doc(reqDoc.memberUid);
    const memberSnap = await tx.get(memberRef);
    if (!memberSnap.exists) throw new Error('Profil member tidak ditemukan.');
    const member = memberSnap.data() as MemberProfile;

    const { settings, levels } = await getSettingsAndLevels(db);

    if (input.decision === 'DENIED') {
      const denialReason = (input.reason || 'Pengajuan benefit belum memenuhi syarat.').trim().slice(0, 300);
      const denyEval = computeBenefitDenial({ request: reqDoc, member, nowMs: now });
      const refundLedgerId = denyEval.shouldCreateRefundLedger ? generateDocId('xpr') : null;

      tx.update(reqRef, {
        status: denyEval.nextStatus,
        resolution: denyEval.resolution,
        deniedAt: denyEval.deniedAt,
        deniedBy: input.adminUid,
        deniedReason: denialReason,
        refundedAt: denyEval.refundedAt,
        refundReason: denyEval.shouldCreateRefundLedger ? `Pengajuan ditolak: ${denialReason}` : null,
        refundedAmount: denyEval.refundedAmount,
        refundLedgerId,
        updatedAt: now,
      });

      if (denyEval.shouldCreateRefundLedger && refundLedgerId) {
        tx.update(memberRef, {
          xpReward: denyEval.afterXpReward,
          reservedXp: denyEval.afterReservedXp,
          updatedAt: now,
        });

        tx.set(db.collection('xpRewardLedger').doc(refundLedgerId), {
          id: refundLedgerId,
          memberId: member.memberId,
          memberUid: member.uid,
          memberUsername: member.username,
          amount: denyEval.refundedAmount,
          beforeBalance: denyEval.beforeXpReward,
          afterBalance: denyEval.afterXpReward,
          type: 'REWARD',
          direction: 'CREDIT',
          source: 'DENIED_REFUND',
          referenceId: reqDoc.id,
          branch: reqDoc.branch,
          cycleId: settings.currentCycleId,
          createdAt: now,
          createdBy: input.adminUid,
          note: `Refund XP otomatis — Benefit Request ditolak (${reqDoc.title}): ${denialReason}`,
        });
      }

      const notifId = generateDocId('notif');
      tx.set(db.collection('memberNotifications').doc(notifId), {
        id: notifId,
        memberId: member.memberId,
        memberUid: member.uid,
        notificationCampaignId: null,
        category: 'BENEFIT_REQUEST',
        title:
          denyEval.refundedAmount > 0
            ? `Benefit Ditolak — ${denyEval.refundedAmount} XP Dikembalikan`
            : `Benefit Request Ditolak: ${reqDoc.title}`,
        message:
          denyEval.refundedAmount > 0
            ? `Pengajuan "${reqDoc.title}" (${reqDoc.id}) ditolak (${denialReason}). Saldo ${denyEval.refundedAmount} XP telah dikembalikan ke XP Reward Anda.`
            : `Pengajuan "${reqDoc.title}" (${reqDoc.id}) ditolak. Alasan: ${denialReason}`,
        read: false,
        readAt: null,
        status: 'SENT',
        sentAt: now,
        createdAt: now,
      });

      const auditId = generateDocId('audit');
      tx.set(db.collection('auditLogs').doc(auditId), {
        id: auditId,
        actorId: input.adminUid,
        actorRole: input.adminRole,
        action: denyEval.refundedAmount > 0 ? 'BENEFIT_REQUEST_DENIED_REFUNDED' : 'BENEFIT_REQUEST_DENIED',
        targetType: 'benefitRequest',
        targetId: reqDoc.id,
        before: { status: 'ON_PROCESS', xpReward: member.xpReward, reservedXp: member.reservedXp ?? 0 },
        after: {
          status: denyEval.nextStatus,
          xpReward: denyEval.afterXpReward,
          reservedXp: denyEval.afterReservedXp,
          refundedAmount: denyEval.refundedAmount,
          denialReason,
        },
        metadata: { refundLedgerId },
        timestamp: now,
      });

      return {
        status: denyEval.nextStatus,
        refundedAmount: denyEval.refundedAmount,
        afterXpReward: denyEval.afterXpReward,
      };
    }

    // APPROVED
    const isCampaign =
      reqDoc.sourceType === 'CHALLENGE' ||
      reqDoc.sourceType === 'EVENT' ||
      reqDoc.sourceType === 'PROMO';

    if (isCampaign) {
      const campRef = db.collection('campaigns').doc(reqDoc.sourceId);
      const campSnap = await tx.get(campRef);
      if (campSnap.exists) {
        const camp = campSnap.data() as CampaignItem;
        if (camp.totalClaimLimit !== null && camp.claimsCount >= camp.totalClaimLimit) {
          throw new Error('Kuota total program ini sudah habis.');
        }
        tx.update(campRef, { claimsCount: (camp.claimsCount || 0) + 1, updatedAt: now });
      }
    } else {
      const benRef = db.collection('benefits').doc(reqDoc.sourceId);
      const benSnap = await tx.get(benRef);
      if (benSnap.exists) {
        const ben = benSnap.data() as BenefitItem;
        if (typeof ben.stock === 'number') {
          if (ben.stock <= 0) throw new Error('Stok benefit sudah habis.');
          tx.update(benRef, { stock: ben.stock - 1, updatedAt: now });
        }
      }
    }

    const appEval = computeBenefitApproval({ request: reqDoc, member, levels, nowMs: now });

    tx.update(reqRef, {
      status: appEval.nextStatus,
      approvedAt: appEval.approvedAt,
      approvedBy: input.adminUid,
      approvedByRole: input.adminRole,
      expiresAt: appEval.expiresAt,
      updatedAt: now,
    });

    tx.update(memberRef, {
      xpProgress: appEval.nextXpProgress,
      xpReward: appEval.nextXpReward,
      reservedXp: appEval.nextReservedXp,
      currentLevel: appEval.nextLevel,
      updatedAt: now,
    });

    if (reqDoc.xpRewardGrant > 0) {
      const progId = generateDocId('xpp');
      const rewId = generateDocId('xpr');
      const ledgerSource =
        reqDoc.sourceType === 'CHALLENGE' ||
        reqDoc.sourceType === 'EVENT' ||
        reqDoc.sourceType === 'PROMO'
          ? reqDoc.sourceType
          : 'LEVEL_BONUS';

      tx.set(db.collection('xpProgressLedger').doc(progId), {
        id: progId,
        memberId: member.memberId,
        memberUid: member.uid,
        memberUsername: member.username,
        amount: reqDoc.xpRewardGrant,
        beforeBalance: member.xpProgress,
        afterBalance: appEval.nextXpProgress,
        type: 'PROGRESS',
        direction: 'CREDIT',
        source: ledgerSource,
        referenceId: reqDoc.id,
        branch: reqDoc.branch,
        cycleId: settings.currentCycleId,
        createdAt: now,
        createdBy: input.adminUid,
        note: `Benefit Request disetujui: ${reqDoc.title}`,
      });
      tx.set(db.collection('xpRewardLedger').doc(rewId), {
        id: rewId,
        memberId: member.memberId,
        memberUid: member.uid,
        memberUsername: member.username,
        amount: reqDoc.xpRewardGrant,
        beforeBalance: member.xpReward,
        afterBalance: appEval.nextXpReward,
        type: 'REWARD',
        direction: 'CREDIT',
        source: ledgerSource,
        referenceId: reqDoc.id,
        branch: reqDoc.branch,
        cycleId: settings.currentCycleId,
        createdAt: now,
        createdBy: input.adminUid,
        note: `Benefit Request disetujui: ${reqDoc.title}`,
      });
    }

    if (appEval.levelChanged) {
      const lhId = generateDocId('lvl');
      tx.set(db.collection('levelHistory').doc(lhId), {
        id: lhId,
        memberId: member.memberId,
        memberUid: member.uid,
        fromLevel: member.currentLevel,
        toLevel: appEval.nextLevel,
        xpProgressAtEvent: appEval.nextXpProgress,
        source: reqDoc.sourceType,
        cycleId: settings.currentCycleId,
        createdAt: now,
      });
    }

    const notifId = generateDocId('notif');
    tx.set(db.collection('memberNotifications').doc(notifId), {
      id: notifId,
      memberId: member.memberId,
      memberUid: member.uid,
      notificationCampaignId: null,
      category: 'BENEFIT_REQUEST',
      title: `Benefit Disetujui: ${reqDoc.title}`,
      message: `Pengajuan "${reqDoc.title}" (${reqDoc.id}) telah disetujui dan berlaku selama 7 hari. Tunjukkan Request ID ke kasir XP PLAY untuk digunakan.`,
      read: false,
      readAt: null,
      status: 'SENT',
      sentAt: now,
      createdAt: now,
    });

    const auditId = generateDocId('audit');
    tx.set(db.collection('auditLogs').doc(auditId), {
      id: auditId,
      actorId: input.adminUid,
      actorRole: input.adminRole,
      action: 'BENEFIT_REQUEST_APPROVED',
      targetType: 'benefitRequest',
      targetId: reqDoc.id,
      before: { status: 'ON_PROCESS', xpProgress: member.xpProgress, xpReward: member.xpReward, reservedXp: member.reservedXp ?? 0 },
      after: {
        status: 'APPROVED',
        expiresAt: appEval.expiresAt,
        xpProgress: appEval.nextXpProgress,
        xpReward: appEval.nextXpReward,
        reservedXp: appEval.nextReservedXp,
      },
      metadata: null,
      timestamp: now,
    });

    return {
      status: 'APPROVED',
      approvedAt: appEval.approvedAt,
      expiresAt: appEval.expiresAt,
      xpProgress: appEval.nextXpProgress,
      xpReward: appEval.nextXpReward,
    };
  });
}

export async function markBenefitRequestUsedServer(input: {
  requestId: string;
  usedBranch: BranchId;
  receiptReference?: string;
  adminUid: string;
  adminRole: AdminRole;
  adminBranchScope?: BranchId | 'ALL';
}) {
  if (isCashierRole(input.adminRole)) {
    assertCashierBranchAccess(
      { role: input.adminRole, branchScope: input.adminBranchScope ?? 'ALL' },
      input.usedBranch,
      'menandai Benefit USED'
    );
  }
  const db = getAdminDb();
  if (!db) throw new Error('ADMIN_SDK_UNAVAILABLE');

  return db.runTransaction(async (tx) => {
    const now = Date.now();
    const reqRef = db.collection('benefitRequests').doc(input.requestId);
    const reqSnap = await tx.get(reqRef);
    if (!reqSnap.exists) throw new Error('Data Benefit Request tidak ditemukan.');
    const reqDoc = reqSnap.data() as BenefitRequestRecord;

    if (reqDoc.branch && isCashierRole(input.adminRole)) {
      assertCashierBranchAccess(
        { role: input.adminRole, branchScope: input.adminBranchScope ?? 'ALL' },
        reqDoc.branch,
        'menandai Benefit USED'
      );
    }

    const usedEval = computeBenefitMarkUsed({ request: reqDoc, nowMs: now });
    const receiptRef = (input.receiptReference || '').trim().slice(0, 80) || null;

    tx.update(reqRef, {
      status: usedEval.nextStatus,
      usedAt: usedEval.usedAt,
      usedBy: input.adminUid,
      usedBranch: input.usedBranch,
      receiptReference: receiptRef,
      updatedAt: now,
    });

    const notifId = generateDocId('notif');
    tx.set(db.collection('memberNotifications').doc(notifId), {
      id: notifId,
      memberId: reqDoc.memberId,
      memberUid: reqDoc.memberUid,
      notificationCampaignId: null,
      category: 'BENEFIT_REQUEST',
      title: `Benefit Digunakan: ${reqDoc.title}`,
      message: `Benefit "${reqDoc.title}" (${reqDoc.id}) telah digunakan di XP PLAY ${input.usedBranch}. Terima kasih!`,
      read: false,
      readAt: null,
      status: 'SENT',
      sentAt: now,
      createdAt: now,
    });

    const auditId = generateDocId('audit');
    tx.set(db.collection('auditLogs').doc(auditId), {
      id: auditId,
      actorId: input.adminUid,
      actorRole: input.adminRole,
      action: 'BENEFIT_REQUEST_USED',
      targetType: 'benefitRequest',
      targetId: reqDoc.id,
      before: { status: 'APPROVED' },
      after: { status: 'USED', usedAt: usedEval.usedAt, usedBranch: input.usedBranch, receiptReference: receiptRef },
      metadata: null,
      timestamp: now,
    });

    return {
      status: 'USED',
      usedAt: usedEval.usedAt,
      usedBranch: input.usedBranch,
      receiptReference: receiptRef,
    };
  });
}

export async function processExpiredBenefitRequestsServer(input: {
  adminUid: string;
  adminRole: AdminRole;
}): Promise<{ processedCount: number; refundedCount: number; expiredOnlyCount: number }> {
  const db = getAdminDb();
  if (!db) throw new Error('ADMIN_SDK_UNAVAILABLE');

  const now = Date.now();
  const { settings } = await getSettingsAndLevels(db);
  const refundOnExpiry = Boolean(settings.refundOnExpiry);

  const snap = await db.collection('benefitRequests').where('status', '==', 'APPROVED').get();
  let processedCount = 0;
  let refundedCount = 0;
  let expiredOnlyCount = 0;

  for (const docSnap of snap.docs) {
    const candidate = docSnap.data() as BenefitRequestRecord;
    if (candidate.expiresAt === null || now <= candidate.expiresAt) continue;

    await db.runTransaction(async (tx) => {
      const freshSnap = await tx.get(docSnap.ref);
      if (!freshSnap.exists) return;
      const reqDoc = freshSnap.data() as BenefitRequestRecord;
      if (reqDoc.status !== 'APPROVED' || reqDoc.expiresAt === null || now <= reqDoc.expiresAt) return;

      const memberRef = db.collection('members').doc(reqDoc.memberUid);
      const memberSnap = await tx.get(memberRef);
      if (!memberSnap.exists) return;
      const member = memberSnap.data() as MemberProfile;

      const expEval = computeBenefitExpiry({
        request: reqDoc,
        member,
        refundOnExpiry,
        nowMs: now,
      });

      const refundLedgerId = expEval.shouldCreateRefundLedger ? generateDocId('xpr') : null;

      tx.update(docSnap.ref, {
        status: expEval.nextStatus,
        resolution: expEval.resolution,
        expiredAt: expEval.expiredAt,
        refundedAt: expEval.refundedAt,
        refundReason: expEval.shouldCreateRefundLedger
          ? 'Benefit kadaluarsa melewati 7 hari (refundOnExpiry aktif)'
          : null,
        refundedAmount: expEval.refundedAmount,
        refundLedgerId,
        updatedAt: now,
      });

      if (expEval.shouldCreateRefundLedger && refundLedgerId) {
        tx.update(memberRef, {
          xpReward: expEval.afterXpReward,
          updatedAt: now,
        });

        tx.set(db.collection('xpRewardLedger').doc(refundLedgerId), {
          id: refundLedgerId,
          memberId: member.memberId,
          memberUid: member.uid,
          memberUsername: member.username,
          amount: expEval.refundedAmount,
          beforeBalance: expEval.beforeXpReward,
          afterBalance: expEval.afterXpReward,
          type: 'REWARD',
          direction: 'CREDIT',
          source: 'EXPIRY_REFUND',
          referenceId: reqDoc.id,
          branch: reqDoc.branch,
          cycleId: settings.currentCycleId,
          createdAt: now,
          createdBy: input.adminUid,
          note: `Refund XP otomatis — Benefit kadaluarsa (${reqDoc.title})`,
        });
      }

      const notifId = generateDocId('notif');
      tx.set(db.collection('memberNotifications').doc(notifId), {
        id: notifId,
        memberId: member.memberId,
        memberUid: member.uid,
        notificationCampaignId: null,
        category: 'BENEFIT_REQUEST',
        title:
          expEval.refundedAmount > 0
            ? `Benefit Kadaluarsa — ${expEval.refundedAmount} XP Dikembalikan`
            : `Benefit Kadaluarsa: ${reqDoc.title}`,
        message:
          expEval.refundedAmount > 0
            ? `Masa berlaku 7 hari benefit "${reqDoc.title}" (${reqDoc.id}) telah berakhir. ${expEval.refundedAmount} XP dikembalikan ke saldo XP Reward Anda.`
            : `Masa berlaku 7 hari benefit "${reqDoc.title}" (${reqDoc.id}) telah berakhir (EXPIRED).`,
        read: false,
        readAt: null,
        status: 'SENT',
        sentAt: now,
        createdAt: now,
      });

      const auditId = generateDocId('audit');
      tx.set(db.collection('auditLogs').doc(auditId), {
        id: auditId,
        actorId: input.adminUid,
        actorRole: input.adminRole,
        action: expEval.refundedAmount > 0 ? 'BENEFIT_REQUEST_EXPIRED_REFUNDED' : 'BENEFIT_REQUEST_EXPIRED',
        targetType: 'benefitRequest',
        targetId: reqDoc.id,
        before: { status: 'APPROVED', xpReward: member.xpReward },
        after: { status: expEval.nextStatus, xpReward: expEval.afterXpReward, refundedAmount: expEval.refundedAmount },
        metadata: { refundOnExpiry, refundLedgerId },
        timestamp: now,
      });

      processedCount++;
      if (expEval.refundedAmount > 0) refundedCount++;
      else expiredOnlyCount++;
    });
  }

  return { processedCount, refundedCount, expiredOnlyCount };
}

export { validateLevelThresholds, isCampaignClaimable };
