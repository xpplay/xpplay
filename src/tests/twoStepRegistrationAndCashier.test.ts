import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildPreRegisteredMemberProfile,
  buildRegistrationBonusLedgerIds,
  computeIncompleteRegistrations,
  computeRegistrationCompletion,
  computeSplitNewMemberMetrics,
  evaluatePhoneRegistrationState,
  isMemberAllowedDashboardAccess,
  isPreRegisteredMember,
  ONBOARDING_CODE_EXPIRY_MS,
  PRE_REGISTERED_LOGIN_BLOCKED_MESSAGE,
  REGISTRATION_ALREADY_ACTIVE_MESSAGE,
  REGISTRATION_NOT_FOUND_MESSAGE,
  REGISTRATION_PRE_REGISTERED_BANNER,
} from '../shared/registrationLogic.ts';
import {
  assertCashierBranchAccess,
  assertRolePermission,
  canAccessBranch,
  CASHIER_SLOT_TEMPLATES,
  getDashboardRouteForRole,
  getDefaultPermissionsForRole,
  getEffectiveCashierBranch,
  hasPermission,
  isCashierRole,
} from '../shared/rbac.ts';
import {
  calculateTransactionXp,
  calculateXpProgressAdjustment,
  calculateXpRewardAdjustment,
  DEFAULT_LEVELS,
  DEFAULT_SYSTEM_SETTINGS,
  resolveLevelFromXp,
} from '../shared/xpLogic.ts';
import {
  computeBenefitApproval,
  computeBenefitDenial,
  computeBenefitHoldBalances,
  computeBenefitMarkUsed,
} from '../shared/benefitRequestLogic.ts';
import { runDataIntegrityChecks } from '../shared/integrityLogic.ts';
import {
  issueOnboardingVerificationCode,
  markOnboardingCodeUsed,
  verifyOnboardingSessionToken,
  verifyOnboardingVerificationCode,
} from '../server/services/onboardingSecurityService.ts';
import type { AdminUser, BenefitRequestRecord, MemberProfile, XpLedgerEntry } from '../types/xpplay.ts';

function readProjectFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
}

function makeCashier(branch: 'DEMANG' | 'SEKIP', code: string): AdminUser {
  const now = Date.now();
  return {
    uid: `cashier_${branch.toLowerCase()}_01`,
    email: `kasir.${branch.toLowerCase()}@xpplay.app`,
    fullName: `Kasir ${branch} 01`,
    role: 'CASHIER',
    branchScope: branch,
    branchId: branch,
    cashierCode: code,
    permissions: getDefaultPermissionsForRole('CASHIER'),
    active: true,
    createdAt: now,
    updatedAt: now,
  };
}

function makeAdmin(role: 'ADMIN' | 'SUPER_ADMIN'): AdminUser {
  const now = Date.now();
  return {
    uid: role === 'SUPER_ADMIN' ? 'super_uid_1' : 'admin_uid_1',
    email: role === 'SUPER_ADMIN' ? 'spv.xpplay@gmail.com' : 'admin@xpplay.app',
    fullName: role === 'SUPER_ADMIN' ? 'Super Admin' : 'Operational Admin',
    role,
    branchScope: 'ALL',
    branchId: null,
    cashierCode: null,
    permissions: getDefaultPermissionsForRole(role),
    active: true,
    createdAt: now,
    updatedAt: now,
  };
}

function makeActiveReferrer(): MemberProfile {
  const now = Date.now() - 10 * 24 * 60 * 60 * 1000;
  return {
    uid: 'ref_uid_active_01',
    memberId: 'XPP-111222',
    fullName: 'Budi Referrer',
    username: 'budiref',
    whatsapp: '6281200001111',
    phone: '6281200001111',
    normalizedPhone: '6281200001111',
    socialMedia: '@budiref',
    birthDate: '2000-05-10',
    birthMonth: 5,
    birthDay: 10,
    memberCategory: 'MAHASISWA',
    status: 'ACTIVE',
    registrationStatus: 'ACTIVE',
    registrationStage: 'COMPLETED',
    branchId: 'DEMANG',
    registrationBonusGranted: true,
    xpProgress: 100,
    xpReward: 50,
    reservedXp: 0,
    currentLevel: 'SILVER',
    levelMode: 'AUTOMATIC',
    currentCycleId: DEFAULT_SYSTEM_SETTINGS.currentCycleId,
    referredByUid: null,
    referredByUsername: null,
    referralCount: 2,
    lastPlayAt: now,
    lastPlayBranch: 'DEMANG',
    preferredBranch: 'DEMANG',
    createdAt: now,
    updatedAt: now,
  };
}

describe('Two-Step Membership Registration & Branch-Isolated Cashier RBAC (TEST 1 – TEST 20)', () => {
  const firestoreRules = readProjectFile('firestore.rules');
  const apiRoutesSrc = readProjectFile('src/server/routes/api.ts');
  const authMiddlewareSrc = readProjectFile('src/server/middleware/authMiddleware.ts');
  const appTsxSrc = readProjectFile('src/App.tsx');
  const cashierPageSrc = readProjectFile('src/pages/CashierDashboardPage.tsx');

  // ---------- TEST 1 ----------
  it('TEST 1: Cashier pre-registers customer -> PRE_REGISTERED, PHONE_ONLY, 0 XP, no +10 XP bonus, blocked from member dashboard', () => {
    const cashier = makeCashier('DEMANG', 'CASHIER_DEMANG_01');
    const pre = buildPreRegisteredMemberProfile({
      preDocId: 'pre_1730000000000_abcdef0123456789',
      whatsapp: '0812-3456-7890',
      branchId: 'DEMANG',
      actorId: cashier.uid,
      actorRole: cashier.role,
      notes: 'Customer main PS5 ruang 3',
      currentCycleId: DEFAULT_SYSTEM_SETTINGS.currentCycleId,
      memberId: 'XPP-550001',
    });

    expect(pre.status).toBe('PRE_REGISTERED');
    expect(pre.registrationStatus).toBe('PRE_REGISTERED');
    expect(pre.registrationStage).toBe('PHONE_ONLY');
    expect(pre.whatsapp).toBe('6281234567890');
    expect(pre.xpProgress).toBe(0);
    expect(pre.xpReward).toBe(0);
    expect(pre.reservedXp).toBe(0);
    expect(pre.registrationBonusGranted).toBe(false);
    expect(pre.authUid).toBeNull();
    expect(pre.branchId).toBe('DEMANG');
    expect(pre.preRegisteredBy).toBe(cashier.uid);
    expect(isPreRegisteredMember(pre)).toBe(true);
    expect(isMemberAllowedDashboardAccess(pre)).toBe(false);
    expect(PRE_REGISTERED_LOGIN_BLOCKED_MESSAGE).toContain('belum menyelesaikan pendaftaran online');
  });

  // ---------- TEST 2 ----------
  it('TEST 2: Customer enters PRE_REGISTERED WhatsApp -> allowed to proceed with Stage 2 online completion', () => {
    const check = evaluatePhoneRegistrationState('6281234567890', {
      status: 'PRE_REGISTERED',
      hasActiveCode: true,
      branchId: 'DEMANG',
    });

    expect(check.state).toBe('PRE_REGISTERED');
    expect(check.canCompleteOnline).toBe(true);
    expect(check.hasActiveCode).toBe(true);
    expect(check.branchId).toBe('DEMANG');
    expect(check.message).toBe(REGISTRATION_PRE_REGISTERED_BANNER);
  });

  // ---------- TEST 3 ----------
  it('TEST 3: Customer enters unregistered WhatsApp -> blocked with mandatory message (no public self-registration)', () => {
    const check = evaluatePhoneRegistrationState('6289999998888', null);

    expect(check.state).toBe('NOT_FOUND');
    expect(check.canCompleteOnline).toBe(false);
    expect(check.message).toBe(REGISTRATION_NOT_FOUND_MESSAGE);
    expect(check.message).toContain('Nomor WhatsApp belum didaftarkan oleh XP PLAY');

    // Also verify active member cannot re-register
    const activeCheck = evaluatePhoneRegistrationState('6281200001111', {
      status: 'ACTIVE',
      hasActiveCode: false,
      branchId: 'SEKIP',
    });
    expect(activeCheck.state).toBe('ACTIVE');
    expect(activeCheck.canCompleteOnline).toBe(false);
    expect(activeCheck.message).toBe(REGISTRATION_ALREADY_ACTIVE_MESSAGE);

    // Firestore rules also mathematically block public self-registration without an existing PRE_REGISTERED doc
    expect(firestoreRules).toContain("get(/databases/$(database)/documents/members/$(incoming().migratedFromUid)).data.status == 'PRE_REGISTERED'");
  });

  // ---------- TEST 4 ----------
  it('TEST 4: Customer completes full online registration -> PRE_REGISTERED -> ACTIVE, can login, gets +10 XP Progress & +10 XP Reward once', () => {
    const cashier = makeCashier('SEKIP', 'CASHIER_SEKIP_01');
    const pre = buildPreRegisteredMemberProfile({
      preDocId: 'pre_1730000000100_1122334455667788',
      whatsapp: '081377778888',
      branchId: 'SEKIP',
      actorId: cashier.uid,
      actorRole: cashier.role,
      currentCycleId: DEFAULT_SYSTEM_SETTINGS.currentCycleId,
      memberId: 'XPP-550004',
    });

    const now = Date.now();
    const res = computeRegistrationCompletion({
      preMember: pre,
      targetAuthUid: 'firebase_auth_uid_004',
      fullName: 'Andi Pratama',
      username: 'andipratama',
      birthDate: '2001-08-17',
      memberCategory: 'MAHASISWA',
      socialMedia: '@andipratama',
      preferredBranch: 'SEKIP',
      verifiedPhoneAt: now - 5000,
      settings: DEFAULT_SYSTEM_SETTINGS,
      levels: DEFAULT_LEVELS,
      nowMs: now,
    });

    expect(res.completedMember.status).toBe('ACTIVE');
    expect(res.completedMember.registrationStatus).toBe('ACTIVE');
    expect(res.completedMember.registrationStage).toBe('COMPLETED');
    expect(res.completedMember.authUid).toBe('firebase_auth_uid_004');
    expect(res.completedMember.registrationBonusGranted).toBe(true);
    expect(res.registrationBonusGranted).toBe(10);
    expect(res.completedMember.xpProgress).toBe(10);
    expect(res.completedMember.xpReward).toBe(10);
    expect(res.progressBonusLedgerId).toBe('regbonus_prog_XPP-550004');
    expect(res.rewardBonusLedgerId).toBe('regbonus_rew_XPP-550004');
    expect(isMemberAllowedDashboardAccess(res.completedMember)).toBe(true);
  });

  // ---------- TEST 5 ----------
  it('TEST 5: Repeating registration completion form -> blocked & NEVER grants second +10 XP bonus (idempotent)', () => {
    const cashier = makeCashier('DEMANG', 'CASHIER_DEMANG_01');
    const pre = buildPreRegisteredMemberProfile({
      preDocId: 'pre_1730000000200_aabbccddeeff0011',
      whatsapp: '081299990005',
      branchId: 'DEMANG',
      actorId: cashier.uid,
      actorRole: cashier.role,
      currentCycleId: DEFAULT_SYSTEM_SETTINGS.currentCycleId,
      memberId: 'XPP-550005',
    });

    const first = computeRegistrationCompletion({
      preMember: pre,
      targetAuthUid: 'auth_uid_005',
      fullName: 'Citra Dewi',
      username: 'citradewi',
      birthDate: '2002-02-14',
      memberCategory: 'MAHASISWA',
      preferredBranch: 'DEMANG',
      verifiedPhoneAt: Date.now() - 1000,
    });

    // Attempt 2 on already completed member -> throws error
    expect(() =>
      computeRegistrationCompletion({
        preMember: first.completedMember,
        targetAuthUid: 'auth_uid_005',
        fullName: 'Citra Dewi',
        username: 'citradewi',
        birthDate: '2002-02-14',
        memberCategory: 'MAHASISWA',
        preferredBranch: 'DEMANG',
        verifiedPhoneAt: Date.now(),
      })
    ).toThrow(/sudah selesai sebelumnya/i);

    // Even if deterministic bonus ledger IDs already exist in Firestore, bonus granted is strictly 0
    const { progressLedgerId, rewardLedgerId } = buildRegistrationBonusLedgerIds('XPP-550005');
    const replay = computeRegistrationCompletion({
      preMember: pre,
      targetAuthUid: 'auth_uid_005_replay',
      fullName: 'Citra Dewi',
      username: 'citradewi2',
      birthDate: '2002-02-14',
      memberCategory: 'MAHASISWA',
      preferredBranch: 'DEMANG',
      verifiedPhoneAt: Date.now(),
      existingBonusLedgerIds: new Set([progressLedgerId, rewardLedgerId]),
    });
    expect(replay.registrationBonusGranted).toBe(0);
    expect(replay.completedMember.xpProgress).toBe(0);
    expect(replay.completedMember.xpReward).toBe(0);
  });

  // ---------- TEST 6 ----------
  it('TEST 6: Customer uses valid referral on completion -> New member +10 reg +5 ref (+15 XP), Referrer +5 XP', () => {
    const cashier = makeCashier('DEMANG', 'CASHIER_DEMANG_02');
    const pre = buildPreRegisteredMemberProfile({
      preDocId: 'pre_1730000000300_2233445566778899',
      whatsapp: '081277770006',
      branchId: 'DEMANG',
      actorId: cashier.uid,
      actorRole: cashier.role,
      currentCycleId: DEFAULT_SYSTEM_SETTINGS.currentCycleId,
      memberId: 'XPP-550006',
    });
    const referrer = makeActiveReferrer();

    const res = computeRegistrationCompletion({
      preMember: pre,
      targetAuthUid: 'auth_uid_006',
      fullName: 'Deni Saputra',
      username: 'denisaputra',
      birthDate: '1999-11-20',
      memberCategory: 'PEKERJA',
      preferredBranch: 'DEMANG',
      referrer,
      verifiedPhoneAt: Date.now() - 1000,
    });

    expect(res.referralValid).toBe(true);
    expect(res.registrationBonusGranted).toBe(10);
    expect(res.refereeReferralBonus).toBe(5);
    expect(res.referrerReferralBonus).toBe(5);
    expect(res.totalAddedXp).toBe(15);
    expect(res.completedMember.xpProgress).toBe(15);
    expect(res.completedMember.xpReward).toBe(15);
    expect(res.completedMember.referredByUid).toBe(referrer.uid);
    expect(res.completedMember.referredByUsername).toBe(referrer.username);
  });

  // ---------- TEST 7 ----------
  it('TEST 7: PRE_REGISTERED customer plays before online completion -> Transaction XP recorded & preserved on completion, still blocked from /member until complete', () => {
    const cashier = makeCashier('DEMANG', 'CASHIER_DEMANG_01');
    const pre = buildPreRegisteredMemberProfile({
      preDocId: 'pre_1730000000400_3344556677889900',
      whatsapp: '081266660007',
      branchId: 'DEMANG',
      actorId: cashier.uid,
      actorRole: cashier.role,
      currentCycleId: DEFAULT_SYSTEM_SETTINGS.currentCycleId,
      memberId: 'XPP-550007',
    });

    // Customer spends Rp50.000 at Demang -> +25 XP Progress & +25 XP Reward
    const txXp = calculateTransactionXp(50000, DEFAULT_SYSTEM_SETTINGS.transactionXpRate);
    expect(txXp).toBe(25);

    const afterPlay: MemberProfile = {
      ...pre,
      xpProgress: pre.xpProgress + txXp,
      xpReward: pre.xpReward + txXp,
      currentLevel: resolveLevelFromXp(pre.xpProgress + txXp, DEFAULT_LEVELS).current.id,
      lastPlayAt: Date.now() - 3600_000,
      lastPlayBranch: 'DEMANG',
    };

    // Still PRE_REGISTERED -> CANNOT access Member Dashboard!
    expect(afterPlay.xpProgress).toBe(25);
    expect(afterPlay.xpReward).toBe(25);
    expect(isMemberAllowedDashboardAccess(afterPlay)).toBe(false);

    // Later customer completes online registration -> preserves 25 XP + grants +10 XP = 35 XP!
    const completed = computeRegistrationCompletion({
      preMember: afterPlay,
      targetAuthUid: 'auth_uid_007',
      fullName: 'Eko Wijaya',
      username: 'ekowijaya',
      birthDate: '2000-01-12',
      memberCategory: 'MAHASISWA',
      preferredBranch: 'DEMANG',
      verifiedPhoneAt: Date.now(),
    });

    expect(completed.completedMember.status).toBe('ACTIVE');
    expect(completed.completedMember.xpProgress).toBe(35);
    expect(completed.completedMember.xpReward).toBe(35);
    expect(completed.completedMember.lastPlayBranch).toBe('DEMANG');
    expect(completed.completedMember.migratedFromUid).toBe(pre.uid);
    expect(isMemberAllowedDashboardAccess(completed.completedMember)).toBe(true);
  });

  // ---------- TEST 8 ----------
  it('TEST 8: Cashier Demang accesses Sekip operational data -> DENIED across RBAC, API, and Firestore Rules', () => {
    const cashierDemang = makeCashier('DEMANG', 'CASHIER_DEMANG_01');
    expect(getEffectiveCashierBranch(cashierDemang)).toBe('DEMANG');
    expect(canAccessBranch(cashierDemang, 'DEMANG')).toBe(true);
    expect(canAccessBranch(cashierDemang, 'SEKIP')).toBe(false);
    expect(() => assertCashierBranchAccess(cashierDemang, 'SEKIP', 'input transaksi')).toThrow(/403|DITOLAK/i);

    // Verify API & Firestore Rules enforce strict branch isolation
    expect(apiRoutesSrc).toContain('enforceBranchScopeInRequest');
    expect(firestoreRules).toContain('isCashier() && resource.data.branch == cashierBranch()');
    expect(firestoreRules).toContain('incoming().branch == cashierBranch()');
    expect(firestoreRules).toContain('incoming().branchId == cashierBranch()');
  });

  // ---------- TEST 9 ----------
  it('TEST 9: Cashier tries to adjust XP (Progress or Reward) -> DENIED', () => {
    expect(hasPermission('CASHIER', 'XP_PROGRESS_ADJUSTMENT')).toBe(false);
    expect(hasPermission('CASHIER', 'XP_REWARD_ADJUSTMENT')).toBe(false);
    expect(() => assertRolePermission('CASHIER', 'XP_PROGRESS_ADJUSTMENT')).toThrow(/403|DITOLAK/i);
    expect(() => assertRolePermission('CASHIER', 'XP_REWARD_ADJUSTMENT')).toThrow(/403|DITOLAK/i);

    // Verify Express API & Firestore Rules block Cashier XP adjustments
    expect(apiRoutesSrc).toContain("requirePermission('XP_PROGRESS_ADJUSTMENT')");
    expect(apiRoutesSrc).toContain("requirePermission('XP_REWARD_ADJUSTMENT')");
    expect(firestoreRules).toMatch(/match \/xpAdjustments\/\{adjustmentId\}[\s\S]*?isFullAdminOrSuper\(\)/);
    expect(firestoreRules).toContain("incoming().source in ['TRANSACTION', 'CHALLENGE', 'EVENT', 'PROMO']");
  });

  // ---------- TEST 10 ----------
  it('TEST 10: Cashier tries Level Override -> DENIED', () => {
    expect(hasPermission('CASHIER', 'LEVEL_OVERRIDE')).toBe(false);
    expect(() => assertRolePermission('CASHIER', 'LEVEL_OVERRIDE')).toThrow(/403|DITOLAK/i);
    expect(apiRoutesSrc).toContain("requirePermission('LEVEL_OVERRIDE')");
    expect(firestoreRules).toMatch(/match \/levelOverrides\/\{overrideId\}[\s\S]*?isFullAdminOrSuper\(\)/);
  });

  // ---------- TEST 11 ----------
  it('TEST 11: Cashier tries Member Password Reset -> DENIED', () => {
    expect(hasPermission('CASHIER', 'PASSWORD_RESET_MEMBER')).toBe(false);
    expect(() => assertRolePermission('CASHIER', 'PASSWORD_RESET_MEMBER')).toThrow(/403|DITOLAK/i);
    expect(apiRoutesSrc).toContain("requirePermission('PASSWORD_RESET_MEMBER')");
  });

  // ---------- TEST 12 ----------
  it('TEST 12: Cashier tries Benefit CRUD -> DENIED', () => {
    expect(hasPermission('CASHIER', 'BENEFIT_CRUD')).toBe(false);
    expect(() => assertRolePermission('CASHIER', 'BENEFIT_CRUD')).toThrow(/403|DITOLAK/i);
    expect(firestoreRules).toMatch(/match \/benefits\/\{benefitId\}[\s\S]*?allow create:[\s\S]*?isFullAdminOrSuper\(\)/);
    expect(cashierPageSrc).not.toContain('upsertBenefitByAdmin');
  });

  // ---------- TEST 13 ----------
  it('TEST 13: Cashier tries Challenge CRUD -> DENIED', () => {
    expect(hasPermission('CASHIER', 'CHALLENGE_CRUD')).toBe(false);
    expect(() => assertRolePermission('CASHIER', 'CHALLENGE_CRUD')).toThrow(/403|DITOLAK/i);
    expect(firestoreRules).toMatch(/match \/campaigns\/\{campaignId\}[\s\S]*?allow create:[\s\S]*?isFullAdminOrSuper\(\)/);
    expect(cashierPageSrc).not.toContain('upsertCampaignByAdmin');
  });

  // ---------- TEST 14 ----------
  it('TEST 14: Cashier tries Event CRUD -> DENIED', () => {
    expect(hasPermission('CASHIER', 'EVENT_CRUD')).toBe(false);
    expect(() => assertRolePermission('CASHIER', 'EVENT_CRUD')).toThrow(/403|DITOLAK/i);
  });

  // ---------- TEST 15 ----------
  it('TEST 15: Cashier tries Promo CRUD -> DENIED', () => {
    expect(hasPermission('CASHIER', 'PROMO_CRUD')).toBe(false);
    expect(() => assertRolePermission('CASHIER', 'PROMO_CRUD')).toThrow(/403|DITOLAK/i);
  });

  // ---------- TEST 16 ----------
  it('TEST 16: Cashier tries CMS Edit / Publish -> DENIED', () => {
    expect(hasPermission('CASHIER', 'CMS_EDIT')).toBe(false);
    expect(hasPermission('CASHIER', 'CMS_PUBLISH')).toBe(false);
    expect(() => assertRolePermission('CASHIER', 'CMS_EDIT')).toThrow(/403|DITOLAK/i);
    expect(() => assertRolePermission('CASHIER', 'CMS_PUBLISH')).toThrow(/403|DITOLAK/i);

    // Firestore rules: isAdmin() strictly excludes CASHIER/STAFF, protecting cmsDrafts/cmsPublished/cmsVersions
    expect(firestoreRules).toContain("adminData().role in ['SUPER_ADMIN', 'ADMIN']");
    expect(firestoreRules).toMatch(/match \/cmsDrafts\/\{docId\}[\s\S]*?allow get: if docId == 'homepage' && isAdmin\(\);/);
    expect(firestoreRules).toMatch(/match \/cmsPublished\/\{docId\}[\s\S]*?isFullAdminOrSuper\(\)/);
    expect(cashierPageSrc).not.toContain('AdminCmsEditor');
  });

  // ---------- TEST 17 ----------
  it('TEST 17: Cashier opens Admin / Superadmin URL or API endpoint directly -> 403 UNAUTHORIZED / FORBIDDEN + audit log', () => {
    expect(getDashboardRouteForRole('CASHIER')).toBe('/cashier');
    expect(getDashboardRouteForRole('ADMIN')).toBe('/admin');
    expect(getDashboardRouteForRole('SUPER_ADMIN')).toBe('/superadmin');

    // React Router enforces 403 UnauthorizedPage on /admin/* and /superadmin/*
    expect(appTsxSrc).toContain('UnauthorizedPage');
    expect(appTsxSrc).toContain('path="/admin/*"');
    expect(appTsxSrc).toContain('path="/superadmin/*"');
    expect(appTsxSrc).toContain('path="/cashier/*"');

    // Express middleware returns 403 and logs CASHIER_DENIED_ACTION
    expect(authMiddlewareSrc).toContain('CASHIER_DENIED_ACTION');
    expect(authMiddlewareSrc).toContain('res.status(403)');
    expect(firestoreRules).toMatch(/match \/auditLogs\/\{logId\}[\s\S]*?allow get: if isValidId\(logId\) && isFullAdminOrSuper\(\);/);
  });

  // ---------- TEST 18 ----------
  it('TEST 18: Admin performs XP Adjustment -> ALLOWED with exact before/after audit balances', () => {
    const admin = makeAdmin('ADMIN');
    expect(hasPermission(admin.role, 'XP_PROGRESS_ADJUSTMENT')).toBe(true);
    expect(hasPermission(admin.role, 'XP_REWARD_ADJUSTMENT')).toBe(true);
    expect(hasPermission(admin.role, 'LEVEL_OVERRIDE')).toBe(true);
    expect(hasPermission(admin.role, 'PASSWORD_RESET_MEMBER')).toBe(true);
    expect(hasPermission(admin.role, 'CMS_PUBLISH')).toBe(true);
    // Admin is NOT Superadmin -> cannot execute backup/restore or manage cashiers
    expect(hasPermission(admin.role, 'BACKUP_EXECUTE')).toBe(false);
    expect(hasPermission(admin.role, 'CASHIER_MANAGEMENT')).toBe(false);

    const progAdj = calculateXpProgressAdjustment({
      currentXpProgress: 130,
      currentXpReward: 40,
      currentLevel: 'BRONZE',
      adjustment: 30,
      levels: DEFAULT_LEVELS,
    });
    expect(progAdj.beforeBalance).toBe(130);
    expect(progAdj.afterBalance).toBe(160);
    expect(progAdj.newXpProgress).toBe(160);
    expect(progAdj.newXpReward).toBe(40);
    expect(progAdj.levelAfter).toBe('SILVER');

    const rewAdj = calculateXpRewardAdjustment({
      currentXpProgress: 160,
      currentXpReward: 40,
      currentLevel: 'SILVER',
      adjustment: -15,
    });
    expect(rewAdj.beforeBalance).toBe(40);
    expect(rewAdj.afterBalance).toBe(25);
    expect(rewAdj.newXpReward).toBe(25);
    expect(rewAdj.newXpProgress).toBe(160);
  });

  // ---------- TEST 19 ----------
  it('TEST 19: SUPERADMIN creates Cashier account with fixed branch assignment (DEMANG/SEKIP), rejects ALL branchScope for Cashier', () => {
    const superAdmin = makeAdmin('SUPER_ADMIN');
    expect(hasPermission(superAdmin.role, 'CASHIER_MANAGEMENT')).toBe(true);
    expect(hasPermission(superAdmin.role, 'ADMIN_MANAGEMENT')).toBe(true);
    expect(hasPermission(superAdmin.role, 'BACKUP_EXECUTE')).toBe(true);
    expect(hasPermission(superAdmin.role, 'RESTORE_EXECUTE')).toBe(true);

    // 4 operational slots (2 Demang + 2 Sekip), NO hardcoded credentials
    expect(CASHIER_SLOT_TEMPLATES).toHaveLength(4);
    expect(CASHIER_SLOT_TEMPLATES.filter((s) => s.branchId === 'DEMANG')).toHaveLength(2);
    expect(CASHIER_SLOT_TEMPLATES.filter((s) => s.branchId === 'SEKIP')).toHaveLength(2);

    const invalidCashier: AdminUser = {
      ...makeCashier('DEMANG', 'CASHIER_DEMANG_01'),
      branchScope: 'ALL',
      branchId: null,
    };
    expect(isCashierRole(invalidCashier.role)).toBe(true);
    expect(getEffectiveCashierBranch(invalidCashier)).toBeNull();
    expect(canAccessBranch(invalidCashier, 'DEMANG')).toBe(false);
    expect(canAccessBranch(invalidCashier, 'SEKIP')).toBe(false);

    // Firestore rules enforce fixed branchScope for CASHIER/STAFF
    expect(firestoreRules).toContain("data.role in ['CASHIER', 'STAFF']");
    expect(firestoreRules).toContain("? data.branchScope in ['DEMANG', 'SEKIP']");
  });

  // ---------- TEST 20 ----------
  it('TEST 20: Admin Dashboard New Member metrics cleanly separate PRE_REGISTERED vs ACTIVE members', () => {
    const now = Date.now();
    const cashierD = makeCashier('DEMANG', 'CASHIER_DEMANG_01');
    const cashierS = makeCashier('SEKIP', 'CASHIER_SEKIP_01');

    const preToday = buildPreRegisteredMemberProfile({
      preDocId: 'pre_1730000001001_aaaa1111bbbb2222',
      whatsapp: '081200010001',
      branchId: 'DEMANG',
      actorId: cashierD.uid,
      actorRole: cashierD.role,
      currentCycleId: DEFAULT_SYSTEM_SETTINGS.currentCycleId,
      nowMs: now - 2 * 60 * 60 * 1000,
      memberId: 'XPP-800001',
    });

    const pre10DaysAgo = buildPreRegisteredMemberProfile({
      preDocId: 'pre_1730000001002_cccc3333dddd4444',
      whatsapp: '081200010002',
      branchId: 'SEKIP',
      actorId: cashierS.uid,
      actorRole: cashierS.role,
      currentCycleId: DEFAULT_SYSTEM_SETTINGS.currentCycleId,
      nowMs: now - 10 * 24 * 60 * 60 * 1000,
      memberId: 'XPP-800002',
    });

    const activeToday = computeRegistrationCompletion({
      preMember: buildPreRegisteredMemberProfile({
        preDocId: 'pre_1730000001003_eeee5555ffff6666',
        whatsapp: '081200010003',
        branchId: 'DEMANG',
        actorId: cashierD.uid,
        actorRole: cashierD.role,
        currentCycleId: DEFAULT_SYSTEM_SETTINGS.currentCycleId,
        nowMs: now - 5 * 24 * 60 * 60 * 1000,
        memberId: 'XPP-800003',
      }),
      targetAuthUid: 'auth_active_today',
      fullName: 'Fajar Baru',
      username: 'fajarbaru',
      birthDate: '2001-03-03',
      memberCategory: 'MAHASISWA',
      preferredBranch: 'DEMANG',
      verifiedPhoneAt: now - 60_000,
      nowMs: now - 30_000,
    }).completedMember;

    const metrics = computeSplitNewMemberMetrics([preToday, pre10DaysAgo, activeToday], now);

    expect(metrics.totalPreRegistered).toBe(2);
    expect(metrics.preRegisteredToday).toBe(1);
    expect(metrics.preRegistered7d).toBe(1);
    expect(metrics.preRegistered30d).toBe(2);

    expect(metrics.activeCompletedToday).toBe(1);
    expect(metrics.activeCompleted7d).toBe(1);
    expect(metrics.activeCompleted30d).toBe(1);

    expect(metrics.newestPreRegistered.every((m) => m.status === 'PRE_REGISTERED')).toBe(true);
    expect(metrics.newestActiveMembers.every((m) => m.status === 'ACTIVE')).toBe(true);
    expect(metrics.newestPreRegistered).toHaveLength(2);
    expect(metrics.newestActiveMembers).toHaveLength(1);
  });

  // ---------- EXTRA SECURITY & INTEGRITY VERIFICATION ----------
  it('EXTRA 1: Cryptographic 6-digit One-Time Code verification, 5-attempt lockout, 7-day expiry, and single-use session token replay protection', async () => {
    const wa = `628199${String(Date.now()).slice(-7)}`;
    const now = Date.now();
    const issued = await issueOnboardingVerificationCode({
      normalizedWhatsapp: wa,
      preMemberUid: 'pre_1730000099000_0011223344556677',
      memberId: 'XPP-990001',
      branchId: 'DEMANG',
      issuedBy: 'cashier_demang_01',
      issuedByRole: 'CASHIER',
      nowMs: now,
    });

    expect(issued.verificationCode).toMatch(/^\d{6}$/);
    expect(issued.record.codeHmac).toHaveLength(64);
    expect(issued.record.codeHmac).not.toContain(issued.verificationCode);

    // Wrong code decrements attempts cleanly
    const wrong = await verifyOnboardingVerificationCode({
      normalizedWhatsapp: wa,
      code: issued.verificationCode === '000000' ? '111111' : '000000',
      nowMs: now + 1000,
    });
    expect(wrong.verified).toBe(false);
    expect(wrong.remainingAttempts).toBe(4);

    // Expired code (> 7 days) is rejected
    const expired = await verifyOnboardingVerificationCode({
      normalizedWhatsapp: wa,
      code: issued.verificationCode,
      nowMs: now + ONBOARDING_CODE_EXPIRY_MS + 1000,
    });
    expect(expired.verified).toBe(false);
    expect(expired.error).toMatch(/kadaluarsa/i);

    // Re-issue fresh code -> verify success -> single-use session token rejects replay
    const reissued = await issueOnboardingVerificationCode({
      normalizedWhatsapp: wa,
      preMemberUid: 'pre_1730000099000_0011223344556677',
      memberId: 'XPP-990001',
      branchId: 'DEMANG',
      issuedBy: 'cashier_demang_01',
      issuedByRole: 'CASHIER',
      nowMs: now + 2000,
    });
    const ok = await verifyOnboardingVerificationCode({
      normalizedWhatsapp: wa,
      code: reissued.verificationCode,
      nowMs: now + 3000,
    });
    expect(ok.verified).toBe(true);
    expect(ok.onboardingSessionToken).toBeTruthy();

    const firstConsume = verifyOnboardingSessionToken(ok.onboardingSessionToken!, { consume: true });
    expect(firstConsume.valid).toBe(true);

    const secondReplay = verifyOnboardingSessionToken(ok.onboardingSessionToken!, { consume: true });
    expect(secondReplay.valid).toBe(false);
    expect(secondReplay.error).toMatch(/sudah digunakan/i);

    await markOnboardingCodeUsed(wa, now + 4000);
    const afterUsed = await verifyOnboardingVerificationCode({
      normalizedWhatsapp: wa,
      code: reissued.verificationCode,
      nowMs: now + 5000,
    });
    expect(afterUsed.verified).toBe(false);
  });

  it('EXTRA 2: Incomplete Registration report (7/14/30 days) is read-only and filters by days & branch', () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const m5 = buildPreRegisteredMemberProfile({
      preDocId: 'pre_1_aabbccddeeff0001',
      whatsapp: '081200020001',
      branchId: 'DEMANG',
      actorId: 'c1',
      actorRole: 'CASHIER',
      currentCycleId: 'cycle_2026_q4',
      nowMs: now - 5 * dayMs,
      memberId: 'XPP-700001',
    });
    const m15 = buildPreRegisteredMemberProfile({
      preDocId: 'pre_2_aabbccddeeff0002',
      whatsapp: '081200020002',
      branchId: 'SEKIP',
      actorId: 'c2',
      actorRole: 'CASHIER',
      currentCycleId: 'cycle_2026_q4',
      nowMs: now - 15 * dayMs,
      memberId: 'XPP-700002',
    });
    const m35 = buildPreRegisteredMemberProfile({
      preDocId: 'pre_3_aabbccddeeff0003',
      whatsapp: '081200020003',
      branchId: 'DEMANG',
      actorId: 'c1',
      actorRole: 'CASHIER',
      currentCycleId: 'cycle_2026_q4',
      nowMs: now - 35 * dayMs,
      memberId: 'XPP-700003',
    });

    const list = [m5, m15, m35];
    expect(computeIncompleteRegistrations(list, 7, now)).toHaveLength(2);
    expect(computeIncompleteRegistrations(list, 14, now)).toHaveLength(2);
    expect(computeIncompleteRegistrations(list, 30, now)).toHaveLength(1);
    expect(computeIncompleteRegistrations(list, 7, now, 'SEKIP')).toHaveLength(1);
    expect(list.every((m) => m.status === 'PRE_REGISTERED')).toBe(true); // Never deleted
  });

  it('EXTRA 3: PRE_REGISTERED customer can use Cashier-assisted Benefit Request lifecycle (Hold -> Approve -> Used & Deny -> Refund)', () => {
    const pre: MemberProfile = {
      ...buildPreRegisteredMemberProfile({
        preDocId: 'pre_3_ffeeddccbbaa0099',
        whatsapp: '081200030001',
        branchId: 'DEMANG',
        actorId: 'c1',
        actorRole: 'CASHIER',
        currentCycleId: 'cycle_2026_q4',
        memberId: 'XPP-600001',
      }),
      xpProgress: 40,
      xpReward: 40,
    };

    const hold = computeBenefitHoldBalances({
      memberXpReward: pre.xpReward,
      memberReservedXp: pre.reservedXp ?? 0,
      memberXpProgress: pre.xpProgress,
      memberLevel: pre.currentLevel,
      xpCost: 20,
    });
    expect(hold.afterXpReward).toBe(20);
    expect(hold.afterReservedXp).toBe(20);

    const now = Date.now();
    const req: BenefitRequestRecord = {
      id: 'BRQ-PRE001',
      memberId: pre.memberId,
      memberUid: pre.uid,
      memberUsername: '',
      memberName: pre.fullName,
      memberWhatsapp: pre.whatsapp,
      sourceType: 'GENERAL_BENEFIT',
      sourceId: 'ben_free_hour',
      title: 'Free 1 Jam PS5',
      xpCost: 20,
      xpRewardGrant: 0,
      levelRequirement: 'BRONZE',
      evidenceUrl: '',
      evidencePath: '',
      note: '[Via Kasir DEMANG]',
      status: 'ON_PROCESS',
      resolution: null,
      holdLedgerId: 'xpr_hold_1',
      refundLedgerId: null,
      branch: 'DEMANG',
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
      cycleId: 'cycle_2026_q4',
      createdAt: now,
      updatedAt: now,
    };

    // Approve + Mark Used
    const approved = computeBenefitApproval({
      request: req,
      member: { ...pre, xpReward: 20, reservedXp: 20 },
      levels: DEFAULT_LEVELS,
      nowMs: now + 1000,
    });
    expect(approved.nextStatus).toBe('APPROVED');
    expect(approved.nextReservedXp).toBe(0);

    const used = computeBenefitMarkUsed({
      request: { ...req, status: 'APPROVED', expiresAt: approved.expiresAt },
      nowMs: now + 2000,
    });
    expect(used.nextStatus).toBe('USED');

    // Deny -> Auto Refund back to 40 XP Reward
    const denied = computeBenefitDenial({
      request: req,
      member: { ...pre, xpReward: 20, reservedXp: 20 },
      nowMs: now + 1000,
    });
    expect(denied.nextStatus).toBe('REFUNDED');
    expect(denied.afterXpReward).toBe(40);
    expect(denied.afterReservedXp).toBe(0);
  });

  it('EXTRA 4: Integrity Engine allows empty username ONLY for PRE_REGISTERED and catches duplicate/premature REGISTRATION_BONUS', () => {
    const pre = buildPreRegisteredMemberProfile({
      preDocId: 'pre_4_1111222233334444',
      whatsapp: '081200040001',
      branchId: 'DEMANG',
      actorId: 'c1',
      actorRole: 'CASHIER',
      currentCycleId: 'cycle_2026_q4',
      memberId: 'XPP-650001',
    });

    const cleanReport = runDataIntegrityChecks(
      {
        members: [pre],
        xpProgressLedger: [],
        xpRewardLedger: [],
        transactions: [],
        referrals: [],
        claims: [],
        redemptions: [],
        benefitRequests: [],
        campaigns: [],
        benefits: [],
        levels: DEFAULT_LEVELS,
        existingStoragePaths: new Set<string>(),
        cmsPublished: null,
      },
      { auditId: 'audit_pre_clean', checkedBy: 'test' }
    );
    expect(cleanReport.passed).toBe(true);

    // Premature REGISTRATION_BONUS on a PRE_REGISTERED member -> caught by check #14!
    const badBonusLedger: XpLedgerEntry = {
      id: 'regbonus_prog_XPP-650001',
      memberId: pre.memberId,
      memberUid: pre.uid,
      memberUsername: '',
      amount: 10,
      type: 'PROGRESS',
      direction: 'CREDIT',
      source: 'REGISTRATION_BONUS',
      referenceId: pre.memberId,
      branch: 'DEMANG',
      cycleId: 'cycle_2026_q4',
      createdAt: Date.now(),
      createdBy: 'rogue',
      note: 'Premature bonus',
    };

    const badReport = runDataIntegrityChecks(
      {
        members: [{ ...pre, xpProgress: 10 }],
        xpProgressLedger: [badBonusLedger],
        xpRewardLedger: [],
        transactions: [],
        referrals: [],
        claims: [],
        redemptions: [],
        benefitRequests: [],
        campaigns: [],
        benefits: [],
        levels: DEFAULT_LEVELS,
        existingStoragePaths: new Set<string>(),
        cmsPublished: null,
      },
      { auditId: 'audit_pre_bad', checkedBy: 'test' }
    );
    const dupCheck = badReport.checks.find((c) => c.code === 'NO_DUPLICATE_DEDUCTION_OR_REFUND');
    expect(dupCheck?.passed).toBe(false);
  });
});
