import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  BENEFIT_VALIDITY_DAYS,
  BENEFIT_VALIDITY_MS,
  classifyXpLedgerMovement,
  computeBenefitApproval,
  computeBenefitDenial,
  computeBenefitExpiry,
  computeBenefitHoldBalances,
  computeBenefitMarkUsed,
  filterAndSortMembers,
  filterAndSortTransactions,
  formatBirthDateJakarta,
  getBenefitRemainingDaysLabel,
  getJakartaTodayDateString,
  getMemberCategoryLabel,
  getXpLedgerMovementLabel,
  isBenefitRequestEffectivelyExpired,
  resolveCampaignBenefitRequestEconomics,
  resolveJakartaDateRange,
  validateBirthDate,
  validateMemberCategory,
} from '../shared/benefitRequestLogic.ts';
import { runDataIntegrityChecks, type IntegrityDataset } from '../shared/integrityLogic.ts';
import { DEFAULT_LEVELS } from '../shared/xpLogic.ts';
import type {
  BenefitRequestRecord,
  MemberProfile,
  TransactionRecord,
} from '../types/xpplay.ts';

function makeMember(overrides: Partial<MemberProfile> = {}): MemberProfile {
  const base = Date.UTC(2026, 4, 1, 10, 0, 0);
  return {
    uid: 'uid_1',
    memberId: 'XPP-100001',
    fullName: 'Budi Santoso',
    username: 'budi.gamer',
    whatsapp: '6281234567890',
    socialMedia: '@budigamer',
    birthDate: '2000-05-15',
    birthMonth: 5,
    birthDay: 15,
    memberCategory: 'MAHASISWA',
    status: 'ACTIVE',
    xpProgress: 180,
    xpReward: 300,
    reservedXp: 0,
    currentLevel: 'SILVER',
    levelMode: 'AUTOMATIC',
    currentCycleId: 'cycle_2026_s1',
    referredByUid: null,
    referredByUsername: null,
    referralCount: 0,
    lastPlayAt: base,
    lastPlayBranch: 'DEMANG',
    preferredBranch: 'DEMANG',
    createdAt: base - 10 * 86400000,
    updatedAt: base,
    ...overrides,
  };
}

describe('FASE 2–6 — Unified Benefit Request, XP Hold, 7-Day Validity, Cashier Mode & Auto-Refund', () => {
  const T0 = Date.UTC(2026, 5, 10, 8, 0, 0);

  it('FASE 2: Immediate XP Hold deducts Available XP Reward into Reserved XP without modifying XP Progress or Level', () => {
    const hold = computeBenefitHoldBalances({
      memberXpReward: 300,
      memberReservedXp: 0,
      memberXpProgress: 180,
      memberLevel: 'SILVER',
      xpCost: 100,
    });

    expect(hold.beforeXpReward).toBe(300);
    expect(hold.afterXpReward).toBe(200);
    expect(hold.beforeReservedXp).toBe(0);
    expect(hold.afterReservedXp).toBe(100);
    expect(hold.xpProgress).toBe(180);
    expect(hold.currentLevel).toBe('SILVER');
    expect(hold.ledgerAmount).toBe(-100);
  });

  it('FASE 2 & 34: Rejects Benefit Request when Available XP Reward is insufficient (including after a prior hold)', () => {
    const firstHold = computeBenefitHoldBalances({
      memberXpReward: 150,
      memberReservedXp: 0,
      memberXpProgress: 180,
      memberLevel: 'SILVER',
      xpCost: 100,
    });
    expect(firstHold.afterXpReward).toBe(50);
    expect(firstHold.afterReservedXp).toBe(100);

    // Second concurrent/sequential request of 100 XP must fail because available is only 50 XP
    expect(() =>
      computeBenefitHoldBalances({
        memberXpReward: firstHold.afterXpReward,
        memberReservedXp: firstHold.afterReservedXp,
        memberXpProgress: 180,
        memberLevel: 'SILVER',
        xpCost: 100,
      })
    ).toThrow(/tidak mencukupi/i);

    // Negative xpCost rejected
    expect(() =>
      computeBenefitHoldBalances({
        memberXpReward: 300,
        memberReservedXp: 0,
        memberXpProgress: 180,
        memberLevel: 'SILVER',
        xpCost: -10,
      })
    ).toThrow(/tidak valid/i);
  });

  it('FASE 3 & 4: Approve paid Benefit Request releases reservedXp permanently and grants exact 7-day validity', () => {
    const member = makeMember({ xpReward: 200, reservedXp: 100, xpProgress: 180, currentLevel: 'SILVER' });
    const app = computeBenefitApproval({
      request: { status: 'ON_PROCESS', xpCost: 100, xpRewardGrant: 0 },
      member,
      levels: DEFAULT_LEVELS,
      nowMs: T0,
    });

    expect(app.nextStatus).toBe('APPROVED');
    expect(app.approvedAt).toBe(T0);
    expect(app.expiresAt).toBe(T0 + BENEFIT_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
    expect(app.expiresAt - app.approvedAt).toBe(BENEFIT_VALIDITY_MS);
    expect(app.nextXpReward).toBe(200); // Held XP is NOT returned on approve
    expect(app.nextReservedXp).toBe(0);
    expect(app.nextXpProgress).toBe(180);
    expect(app.nextLevel).toBe('SILVER');
    expect(app.levelChanged).toBe(false);
  });

  it('FASE 3: Approve Campaign Benefit Request credits XP Progress + XP Reward and auto-upgrades level unless MANUAL_OVERRIDE', () => {
    const autoMember = makeMember({ xpProgress: 140, xpReward: 50, reservedXp: 0, currentLevel: 'BRONZE', levelMode: 'AUTOMATIC' });
    const autoApp = computeBenefitApproval({
      request: { status: 'ON_PROCESS', xpCost: 0, xpRewardGrant: 40 },
      member: autoMember,
      levels: DEFAULT_LEVELS,
      nowMs: T0,
    });
    expect(autoApp.nextXpProgress).toBe(180);
    expect(autoApp.nextXpReward).toBe(90);
    expect(autoApp.nextLevel).toBe('SILVER');
    expect(autoApp.levelChanged).toBe(true);

    const manualMember = makeMember({ xpProgress: 140, xpReward: 50, reservedXp: 0, currentLevel: 'JURAGAN', levelMode: 'MANUAL_OVERRIDE' });
    const manualApp = computeBenefitApproval({
      request: { status: 'ON_PROCESS', xpCost: 0, xpRewardGrant: 40 },
      member: manualMember,
      levels: DEFAULT_LEVELS,
      nowMs: T0,
    });
    expect(manualApp.nextXpProgress).toBe(180);
    expect(manualApp.nextLevel).toBe('JURAGAN');
    expect(manualApp.levelChanged).toBe(false);
  });

  it('FASE 3: Deny paid Benefit Request refunds XP atomically with DENIED_REFUND and sets status = REFUNDED', () => {
    const member = makeMember({ xpReward: 200, reservedXp: 100 });
    const deny = computeBenefitDenial({
      request: { status: 'ON_PROCESS', xpCost: 100 },
      member,
      nowMs: T0,
    });

    expect(deny.nextStatus).toBe('REFUNDED');
    expect(deny.resolution).toBe('DENIED');
    expect(deny.shouldCreateRefundLedger).toBe(true);
    expect(deny.refundLedgerSource).toBe('DENIED_REFUND');
    expect(deny.refundedAmount).toBe(100);
    expect(deny.beforeXpReward).toBe(200);
    expect(deny.afterXpReward).toBe(300);
    expect(deny.afterReservedXp).toBe(0);

    // Free campaign denial sets DENIED with zero refund ledger
    const freeDeny = computeBenefitDenial({
      request: { status: 'ON_PROCESS', xpCost: 0 },
      member,
      nowMs: T0,
    });
    expect(freeDeny.nextStatus).toBe('DENIED');
    expect(freeDeny.shouldCreateRefundLedger).toBe(false);
    expect(freeDeny.refundedAmount).toBe(0);
  });

  it('FASE 4 & 6: Cashier MARK AS USED succeeds before expiry and rejects USED, EXPIRED, ON_PROCESS, and past-7-day requests', () => {
    const expiresAt = T0 + BENEFIT_VALIDITY_MS;
    const okUse = computeBenefitMarkUsed({
      request: { status: 'APPROVED', expiresAt },
      nowMs: T0 + 3 * 86400000,
    });
    expect(okUse.nextStatus).toBe('USED');
    expect(okUse.usedAt).toBe(T0 + 3 * 86400000);

    // Double use rejected
    expect(() =>
      computeBenefitMarkUsed({ request: { status: 'USED', expiresAt }, nowMs: T0 + 4 * 86400000 })
    ).toThrow(/USED/);

    // Expired status rejected
    expect(() =>
      computeBenefitMarkUsed({ request: { status: 'EXPIRED', expiresAt }, nowMs: T0 + 4 * 86400000 })
    ).toThrow(/EXPIRED/);

    // Past 7-day timestamp rejected even if batch expiry hasn't run yet
    expect(() =>
      computeBenefitMarkUsed({ request: { status: 'APPROVED', expiresAt }, nowMs: expiresAt + 1000 })
    ).toThrow(/7 hari|EXPIRED/i);

    // ON_PROCESS rejected
    expect(() =>
      computeBenefitMarkUsed({ request: { status: 'ON_PROCESS', expiresAt: null }, nowMs: T0 })
    ).toThrow(/APPROVED/);
  });

  it('FASE 5: Expiry logic respects refundOnExpiry toggle (false = EXPIRED no refund; true = REFUNDED + EXPIRY_REFUND)', () => {
    const expiresAt = T0 + BENEFIT_VALIDITY_MS;
    const afterExpiry = expiresAt + 60_000;
    const member = makeMember({ xpReward: 200 });

    // Default refundOnExpiry = false
    const noRefund = computeBenefitExpiry({
      request: { status: 'APPROVED', expiresAt, xpCost: 100 },
      member,
      refundOnExpiry: false,
      nowMs: afterExpiry,
    });
    expect(noRefund.nextStatus).toBe('EXPIRED');
    expect(noRefund.resolution).toBe('EXPIRED');
    expect(noRefund.shouldCreateRefundLedger).toBe(false);
    expect(noRefund.refundedAmount).toBe(0);
    expect(noRefund.afterXpReward).toBe(200);

    // Enabled refundOnExpiry = true
    const withRefund = computeBenefitExpiry({
      request: { status: 'APPROVED', expiresAt, xpCost: 100 },
      member,
      refundOnExpiry: true,
      nowMs: afterExpiry,
    });
    expect(withRefund.nextStatus).toBe('REFUNDED');
    expect(withRefund.resolution).toBe('EXPIRED');
    expect(withRefund.shouldCreateRefundLedger).toBe(true);
    expect(withRefund.refundLedgerSource).toBe('EXPIRY_REFUND');
    expect(withRefund.refundedAmount).toBe(100);
    expect(withRefund.afterXpReward).toBe(300);

    // Helper checks
    expect(isBenefitRequestEffectivelyExpired({ status: 'APPROVED', expiresAt }, afterExpiry)).toBe(true);
    expect(isBenefitRequestEffectivelyExpired({ status: 'APPROVED', expiresAt }, T0 + 86400000)).toBe(false);
    expect(getBenefitRemainingDaysLabel(expiresAt, afterExpiry)).toBe('Kadaluarsa');
    expect(getBenefitRemainingDaysLabel(expiresAt, T0 + 2 * 86400000)).toBe('5 hari lagi');

    // Rejects non-expired
    expect(() =>
      computeBenefitExpiry({
        request: { status: 'APPROVED', expiresAt, xpCost: 100 },
        member,
        refundOnExpiry: true,
        nowMs: T0 + 86400000,
      })
    ).toThrow(/belum melewati/i);
  });

  it('FASE 34: Race Condition Guards — prevents double approve, double deny, and double refund', () => {
    const member = makeMember({ xpReward: 200, reservedXp: 0 });
    expect(() =>
      computeBenefitApproval({
        request: { status: 'APPROVED', xpCost: 100, xpRewardGrant: 0 },
        member,
      })
    ).toThrow(/tidak dapat di-approve ulang/i);

    expect(() =>
      computeBenefitDenial({
        request: { status: 'REFUNDED', xpCost: 100 },
        member,
      })
    ).toThrow(/tidak dapat ditolak ulang/i);

    expect(() =>
      computeBenefitExpiry({
        request: { status: 'REFUNDED', expiresAt: T0, xpCost: 100 },
        member,
        refundOnExpiry: true,
        nowMs: T0 + 999999,
      })
    ).toThrow(/Hanya benefit APPROVED/i);
  });
});

describe('FASE 7–8 — Birth Date & Member Status (Category) Validation', () => {
  const fixedNow = Date.UTC(2026, 5, 15, 5, 0, 0); // 2026-06-15 12:00 WIB

  it('validates real Gregorian birth dates, extracts birthMonth & birthDay, rejects future & impossible dates', () => {
    expect(getJakartaTodayDateString(fixedNow)).toBe('2026-06-15');

    const ok = validateBirthDate('1998-11-24', fixedNow);
    expect(ok).toEqual({
      valid: true,
      birthDate: '1998-11-24',
      birthMonth: 11,
      birthDay: 24,
    });

    // Empty is allowed (optional for legacy compatibility)
    expect(validateBirthDate('', fixedNow).valid).toBe(true);
    expect(validateBirthDate(null, fixedNow).birthDate).toBeNull();

    // Future date rejected
    expect(validateBirthDate('2026-06-16', fixedNow).valid).toBe(false);
    expect(validateBirthDate('2030-01-01', fixedNow).valid).toBe(false);

    // Impossible calendar date rejected (Feb 30, Apr 31)
    expect(validateBirthDate('2024-02-30', fixedNow).valid).toBe(false);
    expect(validateBirthDate('2025-02-29', fixedNow).valid).toBe(false);
    expect(validateBirthDate('2024-02-29', fixedNow).valid).toBe(true); // Leap year valid!
    expect(validateBirthDate('1899-12-31', fixedNow).valid).toBe(false);

    // Indonesian display formatter
    expect(formatBirthDateJakarta('1998-11-24')).toContain('1998');
    expect(formatBirthDateJakarta(null)).toBe('-');
  });

  it('validates Member Status (Category) enum cleanly', () => {
    expect(validateMemberCategory('mahasiswa')).toEqual({ valid: true, value: 'MAHASISWA' });
    expect(validateMemberCategory('PELAJAR')).toEqual({ valid: true, value: 'PELAJAR' });
    expect(validateMemberCategory('PEKERJA')).toEqual({ valid: true, value: 'PEKERJA' });
    expect(validateMemberCategory('LAINNYA')).toEqual({ valid: true, value: 'LAINNYA' });
    expect(validateMemberCategory('')).toEqual({ valid: true, value: null });
    expect(validateMemberCategory('VIP_HACK').valid).toBe(false);

    expect(getMemberCategoryLabel('MAHASISWA')).toBe('Mahasiswa');
    expect(getMemberCategoryLabel(null)).toBe('-');
  });
});

describe('FASE 9, 11 & 12 — Advanced Member Filter/Sort, Transaction Filter/Sort & XP Ledger Labels', () => {
  const now = Date.UTC(2026, 5, 15, 5, 0, 0); // 2026-06-15 12:00 WIB
  const day = 86400000;

  const members: MemberProfile[] = [
    makeMember({
      uid: 'u1',
      memberId: 'XPP-001',
      fullName: 'Aldo Wijaya',
      username: 'aldo.ps5',
      whatsapp: '628111111001',
      memberCategory: 'MAHASISWA',
      status: 'ACTIVE',
      xpProgress: 500,
      xpReward: 120,
      currentLevel: 'JURAGAN',
      lastPlayAt: now - 1 * day,
      lastPlayBranch: 'DEMANG',
      createdAt: now - 5 * day,
    }),
    makeMember({
      uid: 'u2',
      memberId: 'XPP-002',
      fullName: 'Citra Dewi',
      username: 'citra.sekip',
      whatsapp: '628222222002',
      memberCategory: 'PEKERJA',
      status: 'INACTIVE',
      xpProgress: 1200,
      xpReward: 400,
      currentLevel: 'SULTAN',
      lastPlayAt: now - 45 * day,
      lastPlayBranch: 'SEKIP',
      createdAt: now - 60 * day,
    }),
    makeMember({
      uid: 'u3',
      memberId: 'XPP-003',
      fullName: 'Deni Pratama',
      username: 'deni.bronze',
      whatsapp: '628333333003',
      memberCategory: 'PELAJAR',
      status: 'ACTIVE',
      xpProgress: 20,
      xpReward: 10,
      currentLevel: 'BRONZE',
      lastPlayAt: null,
      lastPlayBranch: null,
      preferredBranch: 'DEMANG',
      createdAt: now - 2 * day,
    }),
  ];

  it('FASE 9: filters members by search, level, status, branch, category, date range and sorts across all modes', () => {
    expect(filterAndSortMembers(members, { search: 'citra' }).map((m) => m.uid)).toEqual(['u2']);
    expect(filterAndSortMembers(members, { search: '08333333003' }).map((m) => m.uid)).toEqual(['u3']);
    expect(filterAndSortMembers(members, { level: 'SULTAN' }).map((m) => m.uid)).toEqual(['u2']);
    expect(filterAndSortMembers(members, { status: 'ACTIVE', branch: 'DEMANG' }).map((m) => m.uid)).toEqual(['u3', 'u1']);
    expect(filterAndSortMembers(members, { memberCategory: 'PEKERJA' }).map((m) => m.uid)).toEqual(['u2']);
    expect(filterAndSortMembers(members, { registeredFromMs: now - 10 * day }).map((m) => m.uid)).toEqual(['u3', 'u1']);

    expect(filterAndSortMembers(members, { sort: 'XP_PROGRESS_DESC' }).map((m) => m.uid)).toEqual(['u2', 'u1', 'u3']);
    expect(filterAndSortMembers(members, { sort: 'XP_REWARD_ASC' }).map((m) => m.uid)).toEqual(['u3', 'u1', 'u2']);
    expect(filterAndSortMembers(members, { sort: 'LONGEST_INACTIVE' }).map((m) => m.uid)).toEqual(['u2', 'u3', 'u1']);
    expect(filterAndSortMembers(members, { sort: 'LEVEL_DESC' }).map((m) => m.uid)).toEqual(['u2', 'u1', 'u3']);
  });

  it('FASE 11: filters transactions by search, branch, Asia/Jakarta date presets, and sorts accurately', () => {
    const txs: TransactionRecord[] = [
      {
        id: 'tx_today',
        memberId: 'XPP-001',
        memberUid: 'u1',
        memberUsername: 'aldo.ps5',
        branch: 'DEMANG',
        amountIdr: 80000,
        xpRateUsed: 2000,
        xpGenerated: 40,
        source: 'TRANSACTION',
        receiptNumber: 'INV-101',
        note: '',
        adminId: 'adm1',
        adminName: 'Kasir Demang',
        cycleId: 'c1',
        createdAt: now - 2 * 3600 * 1000, // Today WIB
      },
      {
        id: 'tx_yesterday',
        memberId: 'XPP-002',
        memberUid: 'u2',
        memberUsername: 'citra.sekip',
        branch: 'SEKIP',
        amountIdr: 200000,
        xpRateUsed: 2000,
        xpGenerated: 100,
        source: 'TRANSACTION',
        receiptNumber: 'INV-100',
        note: '',
        adminId: 'adm2',
        adminName: 'Kasir Sekip',
        cycleId: 'c1',
        createdAt: now - 1 * day, // Yesterday WIB
      },
    ];
    const memberMap = new Map(members.map((m) => [m.uid, m]));

    expect(resolveJakartaDateRange('TODAY', now).fromMs).toBeLessThan(now);
    expect(filterAndSortTransactions(txs, { datePreset: 'TODAY', nowMs: now }, memberMap).map((t) => t.id)).toEqual(['tx_today']);
    expect(filterAndSortTransactions(txs, { datePreset: 'YESTERDAY', nowMs: now }, memberMap).map((t) => t.id)).toEqual(['tx_yesterday']);
    expect(filterAndSortTransactions(txs, { branch: 'SEKIP', nowMs: now }, memberMap).map((t) => t.id)).toEqual(['tx_yesterday']);
    expect(filterAndSortTransactions(txs, { search: 'Citra', nowMs: now }, memberMap).map((t) => t.id)).toEqual(['tx_yesterday']);
    expect(filterAndSortTransactions(txs, { search: 'INV-101', nowMs: now }, memberMap).map((t) => t.id)).toEqual(['tx_today']);
    expect(filterAndSortTransactions(txs, { sort: 'AMOUNT_DESC', nowMs: now }, memberMap).map((t) => t.id)).toEqual(['tx_yesterday', 'tx_today']);
  });

  it('FASE 12: classifies and labels XP Ledger movements cleanly (+, -, Hold, Denied Refund, Expiry Refund)', () => {
    expect(classifyXpLedgerMovement({ amount: 50, source: 'TRANSACTION' })).toBe('POSITIVE');
    expect(classifyXpLedgerMovement({ amount: -100, source: 'BENEFIT_REQUEST_HOLD' })).toBe('NEGATIVE');
    expect(classifyXpLedgerMovement({ amount: 100, source: 'DENIED_REFUND' })).toBe('REFUND');
    expect(classifyXpLedgerMovement({ amount: 100, source: 'EXPIRY_REFUND' })).toBe('REFUND');

    expect(getXpLedgerMovementLabel({ amount: -100, source: 'BENEFIT_REQUEST_HOLD' })).toBe('XP Ditahan (Hold)');
    expect(getXpLedgerMovementLabel({ amount: 100, source: 'DENIED_REFUND' })).toBe('XP Dikembalikan (Refund Ditolak)');
    expect(getXpLedgerMovementLabel({ amount: 100, source: 'EXPIRY_REFUND' })).toBe('XP Dikembalikan (Refund Expired)');
    expect(getXpLedgerMovementLabel({ amount: 25, source: 'TRANSACTION' })).toBe('XP Bertambah (+)');
    expect(getXpLedgerMovementLabel({ amount: -10, source: 'ADMIN_DEDUCT' })).toBe('XP Berkurang (-)');
  });
});

describe('FASE 32 & 33 — 15-Point Integrity Specific Checks & Firestore Rules Hardening Verification', () => {
  it('FASE 32: catches orphan benefitRequests, reservedXp mismatch, duplicate refund, and invalid profile fields', () => {
    const now = Date.UTC(2026, 5, 15, 5, 0, 0);
    const m = makeMember({ uid: 'm1', reservedXp: 50, birthDate: '2028-01-01' });
    const req: BenefitRequestRecord = {
      id: 'BRQ-TEST-1',
      memberId: m.memberId,
      memberUid: 'm1',
      memberUsername: m.username,
      memberName: m.fullName,
      memberWhatsapp: m.whatsapp,
      sourceType: 'GENERAL_BENEFIT',
      sourceId: 'ben_missing',
      title: 'Missing Benefit',
      xpCost: 100, // ON_PROCESS cost is 100, while member.reservedXp is 50 -> mismatch!
      xpRewardGrant: 0,
      levelRequirement: 'BRONZE',
      evidenceUrl: '',
      evidencePath: '',
      note: '',
      status: 'ON_PROCESS',
      resolution: null,
      holdLedgerId: 'h1',
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
      cycleId: 'cycle_2026_s1',
      createdAt: now,
      updatedAt: now,
    };

    const dataset: IntegrityDataset = {
      members: [m],
      levels: DEFAULT_LEVELS,
      xpProgressLedger: [],
      xpRewardLedger: [
        {
          id: 'rf1',
          memberId: m.memberId,
          memberUid: 'm1',
          amount: 100,
          type: 'REWARD',
          direction: 'CREDIT',
          source: 'DENIED_REFUND',
          referenceId: 'BRQ-TEST-1',
          branch: 'DEMANG',
          cycleId: 'cycle_2026_s1',
          createdAt: now,
          createdBy: 'adm1',
          note: 'Refund 1',
        },
        {
          id: 'rf2',
          memberId: m.memberId,
          memberUid: 'm1',
          amount: 100,
          type: 'REWARD',
          direction: 'CREDIT',
          source: 'DENIED_REFUND',
          referenceId: 'BRQ-TEST-1',
          branch: 'DEMANG',
          cycleId: 'cycle_2026_s1',
          createdAt: now + 1000,
          createdBy: 'adm1',
          note: 'Duplicate refund',
        },
      ],
      referrals: [],
      claims: [],
      redemptions: [],
      benefitRequests: [req],
      transactions: [],
      campaigns: [],
      benefits: [
        {
          id: 'ben_real',
          name: 'Real Benefit',
          description: '',
          imageUrl: '',
          xpCost: 100,
          levelRequirement: 'BRONZE',
          claimable: true,
          redeemable: true,
          stock: 10,
          expiryAt: null,
          terms: '',
          active: true,
          createdBy: 'adm1',
          createdAt: now,
          updatedAt: now,
        },
      ],
      existingStoragePaths: new Set(),
    };

    const report = runDataIntegrityChecks(dataset, { auditId: 'audit_v3', checkedBy: 'adm1', checkedAt: now });
    expect(report.totalChecks).toBe(15);
    expect(report.checks.find((c) => c.code === 'NO_ORPHAN_BENEFIT_REQUESTS')?.passed).toBe(false);
    expect(report.checks.find((c) => c.code === 'NO_DUPLICATE_DEDUCTION_OR_REFUND')?.passed).toBe(false);
    expect(report.checks.find((c) => c.code === 'VALID_MEMBER_STATUS_AND_PROFILE')?.passed).toBe(false);
  });

  it('FASE 33: verifies firestore.rules enforces v3 security invariants and state machine', () => {
    const rules = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
    expect(rules).toContain('match /benefitRequests/{requestId}');
    expect(rules).toContain('function isValidBenefitRequest(data)');
    expect(rules).toContain("'BENEFIT_REQUEST_HOLD'");
    expect(rules).toContain("'refundOnExpiry'");
    expect(rules).toContain("'birthDate'");
    expect(rules).toContain("'memberCategory'");
    expect(rules).toContain("'reservedXp'");
    expect(rules).toContain("existing().status == 'ON_PROCESS' && incoming().status in ['APPROVED', 'DENIED', 'REFUNDED']");
    expect(rules).toContain("existing().status == 'APPROVED' && incoming().status in ['USED', 'EXPIRED', 'REFUNDED']");
    expect(rules).toContain("notificationId == ('new_member_' + request.auth.uid)");
  });

  it('PROMO XP DEDUCTION: Promo claim deducts member XP Reward via XP Hold (same lifecycle as Benefit) instead of adding XP', () => {
    const T0 = Date.UTC(2026, 6, 1, 10, 0, 0);

    // 1. Economics resolution: PROMO deducts xpCost (grant = 0), while CHALLENGE/EVENT grant XP (cost = 0)
    expect(resolveCampaignBenefitRequestEconomics({ type: 'PROMO', xpReward: 80 })).toEqual({
      xpCost: 80,
      xpRewardGrant: 0,
    });
    expect(resolveCampaignBenefitRequestEconomics({ type: 'PROMO', xpReward: 0 })).toEqual({
      xpCost: 0,
      xpRewardGrant: 0,
    });
    expect(resolveCampaignBenefitRequestEconomics({ type: 'CHALLENGE', xpReward: 50 })).toEqual({
      xpCost: 0,
      xpRewardGrant: 50,
    });
    expect(resolveCampaignBenefitRequestEconomics({ type: 'EVENT', xpReward: 120 })).toEqual({
      xpCost: 0,
      xpRewardGrant: 120,
    });

    // 2. Submit PROMO claim (80 XP): immediately holds 80 XP Reward into reservedXp; XP Progress & Level unchanged
    const memberBefore = makeMember({ xpProgress: 180, xpReward: 120, reservedXp: 0, currentLevel: 'SILVER' });
    const promoEcon = resolveCampaignBenefitRequestEconomics({ type: 'PROMO', xpReward: 80 });
    const hold = computeBenefitHoldBalances({
      memberXpReward: memberBefore.xpReward,
      memberReservedXp: memberBefore.reservedXp,
      memberXpProgress: memberBefore.xpProgress,
      memberLevel: memberBefore.currentLevel,
      xpCost: promoEcon.xpCost,
    });

    expect(hold.afterXpReward).toBe(40);
    expect(hold.afterReservedXp).toBe(80);
    expect(hold.xpProgress).toBe(180);
    expect(hold.currentLevel).toBe('SILVER');
    expect(hold.ledgerAmount).toBe(-80);

    // 3. Approve PROMO claim: consumes held reservedXp, does NOT add XP Progress or XP Reward, grants 7-day validity
    const memberAfterHold = makeMember({
      xpProgress: 180,
      xpReward: hold.afterXpReward,
      reservedXp: hold.afterReservedXp,
      currentLevel: 'SILVER',
    });
    const approved = computeBenefitApproval({
      request: {
        status: 'ON_PROCESS',
        xpCost: promoEcon.xpCost,
        xpRewardGrant: promoEcon.xpRewardGrant,
      },
      member: memberAfterHold,
      levels: DEFAULT_LEVELS,
      nowMs: T0,
    });

    expect(approved.nextStatus).toBe('APPROVED');
    expect(approved.nextXpProgress).toBe(180); // unchanged — Promo never adds XP!
    expect(approved.nextXpReward).toBe(40); // permanently reduced from 120 -> 40!
    expect(approved.nextReservedXp).toBe(0);
    expect(approved.nextLevel).toBe('SILVER');
    expect(approved.levelChanged).toBe(false);
    expect(approved.expiresAt).toBe(T0 + BENEFIT_VALIDITY_MS);

    // 4. Deny PROMO claim: automatically refunds 80 XP back to available XP Reward
    const denied = computeBenefitDenial({
      request: { status: 'ON_PROCESS', xpCost: promoEcon.xpCost },
      member: memberAfterHold,
      nowMs: T0,
    });
    expect(denied.nextStatus).toBe('REFUNDED');
    expect(denied.refundedAmount).toBe(80);
    expect(denied.afterXpReward).toBe(120);
    expect(denied.afterReservedXp).toBe(0);
    expect(denied.shouldCreateRefundLedger).toBe(true);

    // 5. Reject PROMO claim when member's XP Reward is insufficient
    expect(() =>
      computeBenefitHoldBalances({
        memberXpReward: 50,
        memberReservedXp: 0,
        memberXpProgress: 180,
        memberLevel: 'SILVER',
        xpCost: promoEcon.xpCost,
      })
    ).toThrow(/tidak mencukupi/i);

    // 6. Integrity engine passes cleanly for an ON_PROCESS PROMO request with matching reservedXp
    const promoMember = makeMember({ uid: 'm_promo', xpProgress: 180, xpReward: 40, reservedXp: 80 });
    const promoReq: BenefitRequestRecord = {
      id: 'BRQ-PROMO-1',
      memberId: promoMember.memberId,
      memberUid: promoMember.uid,
      memberUsername: promoMember.username,
      memberName: promoMember.fullName,
      memberWhatsapp: promoMember.whatsapp,
      sourceType: 'PROMO',
      sourceId: 'camp_promo_1',
      title: 'Diskon 50% VIP Room',
      xpCost: 80,
      xpRewardGrant: 0,
      levelRequirement: 'BRONZE',
      evidenceUrl: '',
      evidencePath: '',
      note: '',
      status: 'ON_PROCESS',
      resolution: null,
      holdLedgerId: 'hold_promo_1',
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
      cycleId: 'cycle_2026_s1',
      createdAt: T0,
      updatedAt: T0,
    };
    const dataset: IntegrityDataset = {
      members: [promoMember],
      levels: DEFAULT_LEVELS,
      xpProgressLedger: [],
      xpRewardLedger: [
        {
          id: 'hold_promo_1',
          memberId: promoMember.memberId,
          memberUid: promoMember.uid,
          amount: -80,
          type: 'REWARD',
          direction: 'DEBIT',
          source: 'BENEFIT_REQUEST_HOLD',
          referenceId: promoReq.id,
          branch: 'DEMANG',
          cycleId: 'cycle_2026_s1',
          createdAt: T0,
          createdBy: promoMember.uid,
          note: 'XP Ditahan (Hold) untuk Klaim Promo: Diskon 50% VIP Room',
        },
      ],
      referrals: [],
      claims: [],
      redemptions: [],
      benefitRequests: [promoReq],
      transactions: [],
      campaigns: [
        {
          id: 'camp_promo_1',
          type: 'PROMO',
          title: 'Diskon 50% VIP Room',
          description: 'Tukar 80 XP untuk diskon 50%',
          startAt: T0 - 86400000,
          endAt: T0 + 7 * 86400000,
          xpReward: 80,
          imageUrl: '',
          terms: '',
          maxClaimsPerMember: 1,
          totalClaimLimit: 20,
          claimsCount: 0,
          active: true,
          status: 'ACTIVE',
          requiresEvidence: false,
          createdBy: 'adm1',
          createdAt: T0 - 86400000,
          updatedAt: T0 - 86400000,
        },
      ],
      benefits: [],
      existingStoragePaths: new Set(),
    };
    const report = runDataIntegrityChecks(dataset, { auditId: 'audit_promo', checkedBy: 'adm1', checkedAt: T0 });
    expect(report.checks.find((c) => c.code === 'NO_ORPHAN_BENEFIT_REQUESTS')?.passed).toBe(true);
    expect(report.checks.find((c) => c.code === 'NO_DUPLICATE_DEDUCTION_OR_REFUND')?.passed).toBe(true);
  });
});
