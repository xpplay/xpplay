import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
  calculateTransactionXp,
  DEFAULT_BRANCHES,
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
} from '../../shared/xpLogic.ts';
import type {
  AdminRole,
  BranchId,
  CampaignItem,
  ClaimRecord,
  LevelConfig,
  LevelId,
  MemberProfile,
  RedemptionRecord,
  SystemSettings,
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

export async function registerMemberServer(input: {
  fullName: string;
  username: string;
  whatsapp: string;
  socialMedia: string;
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
  const adminAuth = getAdminAuth();
  const db = getAdminDb();
  if (!adminAuth || !db) {
    throw new Error('ADMIN_SDK_UNAVAILABLE');
  }

  await ensureSeedDataServer(db);

  const fullName = input.fullName.trim();
  if (fullName.length < 2 || fullName.length > 100) {
    throw new Error('Nama lengkap harus terdiri dari 2 hingga 100 karakter.');
  }

  const userCheck = validateUsername(input.username);
  if (!userCheck.valid) {
    throw new Error(userCheck.error || 'Username tidak valid.');
  }

  const waCheck = validateWhatsapp(input.whatsapp);
  if (!waCheck.valid) {
    throw new Error(waCheck.error || 'Nomor WhatsApp tidak valid.');
  }

  if (!input.password || input.password.length < 8) {
    throw new Error('Password minimal 8 karakter.');
  }

  const normalizedUsername = userCheck.normalized;
  const normalizedWhatsapp = waCheck.normalized;
  const socialMedia = (input.socialMedia || '').trim().slice(0, 100);
  const referralInput = input.referralUsername ? normalizeUsername(input.referralUsername) : '';

  if (referralInput && referralInput === normalizedUsername) {
    throw new Error('Anda tidak dapat menggunakan username Anda sendiri sebagai referral.');
  }

  // Pre-check uniqueness before creating Auth user
  const [uIndexSnap, wIndexSnap] = await Promise.all([
    db.collection('identityIndex').doc(`username:${normalizedUsername}`).get(),
    db.collection('identityIndex').doc(`wa:${normalizedWhatsapp}`).get(),
  ]);

  if (uIndexSnap.exists) {
    throw new Error('Username sudah terdaftar. Silakan pilih username lain.');
  }
  if (wIndexSnap.exists) {
    throw new Error('Nomor WhatsApp sudah terdaftar. Silakan gunakan nomor lain atau login.');
  }

  const uid = crypto.randomUUID().replace(/-/g, '').slice(0, 28);
  const authEmail = `m_${uid}@member.xpplay.internal`;

  // Create Firebase Auth user (password managed securely by Firebase Auth)
  await adminAuth.createUser({
    uid,
    email: authEmail,
    emailVerified: true,
    password: input.password,
    displayName: fullName,
  });

  try {
    const result = await db.runTransaction(async (tx) => {
      const now = Date.now();
      const { settings, levels } = await getSettingsAndLevels(db);

      const uIdxRef = db.collection('identityIndex').doc(`username:${normalizedUsername}`);
      const wIdxRef = db.collection('identityIndex').doc(`wa:${normalizedWhatsapp}`);
      const [uSnap, wSnap] = await Promise.all([tx.get(uIdxRef), tx.get(wIdxRef)]);

      if (uSnap.exists) {
        throw new Error('Username sudah terdaftar.');
      }
      if (wSnap.exists) {
        throw new Error('Nomor WhatsApp sudah terdaftar.');
      }

      let referrerSnapData: MemberProfile | null = null;
      let referralApplied = false;
      let referralMessage: string | undefined;

      if (referralInput) {
        const refIdxSnap = await tx.get(db.collection('identityIndex').doc(`username:${referralInput}`));
        if (refIdxSnap.exists) {
          const refUid = (refIdxSnap.data() as { uid: string }).uid;
          if (refUid !== uid) {
            const refMemberSnap = await tx.get(db.collection('members').doc(refUid));
            if (refMemberSnap.exists) {
              const candidate = refMemberSnap.data() as MemberProfile;
              if (candidate.status === 'ACTIVE') {
                referrerSnapData = candidate;
                referralApplied = true;
              } else {
                referralMessage = 'Akun referrer sedang tidak aktif, registrasi dilanjutkan tanpa bonus referral.';
              }
            }
          }
        } else {
          referralMessage = 'Username referral tidak ditemukan, registrasi dilanjutkan dengan bonus pendaftaran standar.';
        }
      }

      const regBonus = settings.registrationBonusXp;
      const refBonus = referralApplied ? settings.referralBonusXp : 0;
      const totalInitialXp = regBonus + refBonus;
      const levelEval = resolveLevelFromXp(totalInitialXp, levels);
      const memberId = generateMemberCode();

      const memberDoc: MemberProfile = {
        uid,
        memberId,
        fullName,
        username: normalizedUsername,
        whatsapp: normalizedWhatsapp,
        socialMedia,
        status: 'ACTIVE',
        xpProgress: totalInitialXp,
        xpReward: totalInitialXp,
        currentLevel: levelEval.current.id,
        currentCycleId: settings.currentCycleId,
        referredByUid: referrerSnapData ? referrerSnapData.uid : null,
        referredByUsername: referrerSnapData ? referrerSnapData.username : null,
        referralCount: 0,
        lastPlayAt: null,
        lastPlayBranch: null,
        preferredBranch: input.preferredBranch ?? null,
        createdAt: now,
        updatedAt: now,
      };

      tx.set(uIdxRef, {
        uid,
        authEmail,
        kind: 'USERNAME',
        value: normalizedUsername,
        createdAt: now,
      });

      tx.set(wIdxRef, {
        uid,
        authEmail,
        kind: 'WHATSAPP',
        value: normalizedWhatsapp,
        createdAt: now,
      });

      tx.set(db.collection('members').doc(uid), memberDoc);

      // Registration bonus ledgers
      const regProgId = generateDocId('xpp');
      const regRewId = generateDocId('xpr');
      tx.set(db.collection('xpProgressLedger').doc(regProgId), {
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
        createdBy: 'system',
        note: 'Bonus pendaftaran member baru XP PLAY',
      });
      tx.set(db.collection('xpRewardLedger').doc(regRewId), {
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
        createdBy: 'system',
        note: 'Bonus pendaftaran member baru XP PLAY',
      });

      // Referral processing if valid
      if (referralApplied && referrerSnapData) {
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
          refereeMemberId: memberId,
          refereeUsername: normalizedUsername,
          referrerXp: refBonus,
          refereeXp: refBonus,
          cycleId: settings.currentCycleId,
          createdAt: now,
        });

        tx.set(db.collection('xpProgressLedger').doc(refereeProgId), {
          id: refereeProgId,
          memberId,
          memberUid: uid,
          amount: refBonus,
          type: 'PROGRESS',
          direction: 'CREDIT',
          source: 'REFERRAL',
          referenceId: refRecordId,
          branch: null,
          cycleId: settings.currentCycleId,
          createdAt: now + 1,
          createdBy: 'system',
          note: `Bonus referral menggunakan username ${referrerSnapData.username}`,
        });
        tx.set(db.collection('xpRewardLedger').doc(refereeRewId), {
          id: refereeRewId,
          memberId,
          memberUid: uid,
          amount: refBonus,
          type: 'REWARD',
          direction: 'CREDIT',
          source: 'REFERRAL',
          referenceId: refRecordId,
          branch: null,
          cycleId: settings.currentCycleId,
          createdAt: now + 1,
          createdBy: 'system',
          note: `Bonus referral menggunakan username ${referrerSnapData.username}`,
        });

        // Update referrer XP Progress & Reward + Level check
        const nextReferrerProgress = referrerSnapData.xpProgress + refBonus;
        const nextReferrerReward = referrerSnapData.xpReward + refBonus;
        const referrerLevelEval = resolveLevelFromXp(nextReferrerProgress, levels);

        tx.update(db.collection('members').doc(referrerSnapData.uid), {
          xpProgress: nextReferrerProgress,
          xpReward: nextReferrerReward,
          currentLevel: referrerLevelEval.current.id,
          referralCount: (referrerSnapData.referralCount || 0) + 1,
          updatedAt: now,
        });

        tx.set(db.collection('xpProgressLedger').doc(referrerProgId), {
          id: referrerProgId,
          memberId: referrerSnapData.memberId,
          memberUid: referrerSnapData.uid,
          amount: refBonus,
          type: 'PROGRESS',
          direction: 'CREDIT',
          source: 'REFERRAL',
          referenceId: refRecordId,
          branch: null,
          cycleId: settings.currentCycleId,
          createdAt: now + 1,
          createdBy: 'system',
          note: `Bonus mengajak member baru @${normalizedUsername}`,
        });
        tx.set(db.collection('xpRewardLedger').doc(referrerRewId), {
          id: referrerRewId,
          memberId: referrerSnapData.memberId,
          memberUid: referrerSnapData.uid,
          amount: refBonus,
          type: 'REWARD',
          direction: 'CREDIT',
          source: 'REFERRAL',
          referenceId: refRecordId,
          branch: null,
          cycleId: settings.currentCycleId,
          createdAt: now + 1,
          createdBy: 'system',
          note: `Bonus mengajak member baru @${normalizedUsername}`,
        });

        if (referrerLevelEval.current.id !== referrerSnapData.currentLevel) {
          const lhId = generateDocId('lvl');
          tx.set(db.collection('levelHistory').doc(lhId), {
            id: lhId,
            memberId: referrerSnapData.memberId,
            memberUid: referrerSnapData.uid,
            fromLevel: referrerSnapData.currentLevel,
            toLevel: referrerLevelEval.current.id,
            xpProgressAtEvent: nextReferrerProgress,
            source: 'REFERRAL',
            cycleId: settings.currentCycleId,
            createdAt: now,
          });
          const notifId = generateDocId('notif');
          tx.set(db.collection('memberNotifications').doc(notifId), {
            id: notifId,
            memberId: referrerSnapData.memberId,
            memberUid: referrerSnapData.uid,
            notificationCampaignId: null,
            category: 'LEVEL_UP',
            title: `Selamat! Level Naik ke ${referrerLevelEval.current.name}`,
            message: `XP Progress Anda mencapai ${nextReferrerProgress} XP dan level Anda naik menjadi ${referrerLevelEval.current.name}.`,
            read: false,
            readAt: null,
            status: 'SENT',
            sentAt: now,
            createdAt: now,
          });
        }
      }

      // Audit log
      const auditId = generateDocId('audit');
      tx.set(db.collection('auditLogs').doc(auditId), {
        id: auditId,
        actorId: uid,
        actorRole: 'MEMBER',
        action: 'MEMBER_REGISTER',
        targetType: 'member',
        targetId: uid,
        before: null,
        after: {
          username: normalizedUsername,
          xpProgress: totalInitialXp,
          xpReward: totalInitialXp,
          referralApplied,
        },
        metadata: null,
        timestamp: now,
      });

      return { memberDoc, referralApplied, referralMessage };
    });

    const customToken = await adminAuth.createCustomToken(uid);
    return {
      uid,
      member: result.memberDoc,
      customToken,
      referralApplied: result.referralApplied,
      referralMessage: result.referralMessage,
    };
  } catch (err) {
    await adminAuth.deleteUser(uid).catch(() => {});
    throw err;
  }
}

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
    // Generic error to prevent account enumeration
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
  const indexKey = looksLikePhone
    ? `wa:${normalizeWhatsapp(raw)}`
    : `username:${normalizeUsername(raw)}`;

  const idxSnap = await db.collection('identityIndex').doc(indexKey).get();
  if (!idxSnap.exists) {
    throw new Error('Member dengan username atau nomor WhatsApp tersebut tidak ditemukan.');
  }
  const { uid } = idxSnap.data() as { uid: string };

  return db.runTransaction(async (tx) => {
    const now = Date.now();
    const { settings, levels } = await getSettingsAndLevels(db);
    const memberRef = db.collection('members').doc(uid);
    const memberSnap = await tx.get(memberRef);

    if (!memberSnap.exists) {
      throw new Error('Profil member tidak ditemukan.');
    }

    const member = memberSnap.data() as MemberProfile;
    if (member.status !== 'ACTIVE') {
      throw new Error(`Member berstatus ${member.status} dan tidak dapat menerima transaksi.`);
    }

    const xpGenerated = calculateTransactionXp(input.amountIdr, settings.transactionXpRate);
    const newProgress = member.xpProgress + xpGenerated;
    const newReward = member.xpReward + xpGenerated;
    const levelEval = resolveLevelFromXp(newProgress, levels);

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
      currentLevel: levelEval.current.id,
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
        amount: xpGenerated,
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
        amount: xpGenerated,
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

    if (levelEval.current.id !== member.currentLevel) {
      const lhId = generateDocId('lvl');
      tx.set(db.collection('levelHistory').doc(lhId), {
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
        currentLevel: levelEval.current.id,
        amountIdr: input.amountIdr,
        xpGenerated,
        branch: input.branch,
      },
      metadata: { receiptNumber: txDoc.receiptNumber },
      timestamp: now,
    });

    return { transaction: txDoc, xpGenerated, newProgress, newReward, newLevel: levelEval.current.id };
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
    const memberSnap = await tx.get(memberRef);
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
    const xpAward = claim.xpRewardSnapshot;
    const newProgress = member.xpProgress + xpAward;
    const newReward = member.xpReward + xpAward;
    const levelEval = resolveLevelFromXp(newProgress, levels);

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
      currentLevel: levelEval.current.id,
      updatedAt: now,
    });

    const progId = generateDocId('xpp');
    const rewId = generateDocId('xpr');
    tx.set(db.collection('xpProgressLedger').doc(progId), {
      id: progId,
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
      createdBy: input.adminUid,
      note: `Claim disetujui: ${claim.campaignTitle}`,
    });
    tx.set(db.collection('xpRewardLedger').doc(rewId), {
      id: rewId,
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
      createdBy: input.adminUid,
      note: `Claim disetujui: ${claim.campaignTitle}`,
    });

    if (levelEval.current.id !== member.currentLevel) {
      const lhId = generateDocId('lvl');
      tx.set(db.collection('levelHistory').doc(lhId), {
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

    const notifId = generateDocId('notif');
    tx.set(db.collection('memberNotifications').doc(notifId), {
      id: notifId,
      memberId: member.memberId,
      memberUid: member.uid,
      notificationCampaignId: null,
      category: 'CLAIM',
      title: `Claim Disetujui (+${xpAward} XP)`,
      message: `Claim "${claim.campaignTitle}" disetujui. XP Progress dan XP Reward Anda bertambah ${xpAward} XP.`,
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

    return { status: 'APPROVED', xpAward, newProgress, newReward };
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

    // APPROVED: Check level requirement & non-negative XP Reward
    if (!isLevelEligible(member.currentLevel, redemption.levelRequirement, levels)) {
      throw new Error(`Level member (${member.currentLevel}) belum memenuhi syarat (${redemption.levelRequirement}).`);
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

export { validateLevelThresholds, isCampaignClaimable };
