import { describe, expect, it } from 'vitest';
import {
  buildInactiveNotificationDedupeKey,
  calculateMemberInactivity,
  filterAndSortInactiveMembers,
  formatInactiveDurationLabel,
  INACTIVE_PERIOD_PRESETS,
  isMemberInactive,
  MS_PER_DAY,
  sortInactiveRowsLongestFirst,
  validateAdminNewPassword,
} from '../shared/inactiveLogic.ts';
import { detectForbiddenPasswordFields } from '../shared/backupRestoreLogic.ts';
import { changeMemberPasswordServer } from '../server/services/xpEngineServer.ts';
import type { MemberProfile } from '../types/xpplay.ts';

function makeMember(overrides: Partial<MemberProfile> & { uid: string; username: string }): MemberProfile {
  const baseCreated = Date.UTC(2025, 0, 1);
  return {
    uid: overrides.uid,
    memberId: overrides.memberId ?? `XPP-${overrides.uid.slice(-6).toUpperCase()}`,
    fullName: overrides.fullName ?? `Member ${overrides.username}`,
    username: overrides.username,
    whatsapp: overrides.whatsapp ?? '6281234567890',
    socialMedia: overrides.socialMedia ?? '',
    status: overrides.status ?? 'ACTIVE',
    xpProgress: overrides.xpProgress ?? 120,
    xpReward: overrides.xpReward ?? 50,
    currentLevel: overrides.currentLevel ?? 'SILVER',
    levelMode: overrides.levelMode ?? 'AUTOMATIC',
    currentCycleId: overrides.currentCycleId ?? 'cycle_2026_q1',
    referredByUid: overrides.referredByUid ?? null,
    referredByUsername: overrides.referredByUsername ?? null,
    referralCount: overrides.referralCount ?? 0,
    lastPlayAt: overrides.lastPlayAt === undefined ? baseCreated : overrides.lastPlayAt,
    lastPlayBranch: overrides.lastPlayBranch === undefined ? 'DEMANG' : overrides.lastPlayBranch,
    preferredBranch: overrides.preferredBranch === undefined ? 'DEMANG' : overrides.preferredBranch,
    createdAt: overrides.createdAt ?? baseCreated,
    updatedAt: overrides.updatedAt ?? baseCreated,
  };
}

describe('PHASE D — Admin Member Password Management (MODULE 5)', () => {
  it('validates strong password rules and rejects weak/mismatched passwords', () => {
    expect(validateAdminNewPassword('', '').valid).toBe(false);
    expect(validateAdminNewPassword('abc123', 'abc123').valid).toBe(false); // < 8 chars
    expect(validateAdminNewPassword('onlyletters', 'onlyletters').valid).toBe(false); // no digit
    expect(validateAdminNewPassword('123456789', '123456789').valid).toBe(false); // no letter
    expect(validateAdminNewPassword(' XpPlay123', ' XpPlay123').valid).toBe(false); // leading space
    expect(validateAdminNewPassword('XpPlay123', 'XpPlay999').valid).toBe(false); // mismatch
    expect(validateAdminNewPassword('A'.repeat(128) + '1', 'A'.repeat(128) + '1').valid).toBe(false); // > 128 chars
    expect(validateAdminNewPassword('XpPlay2026!', 'XpPlay2026!').valid).toBe(true);
  });

  it('guarantees forbidden password fields are detected and never allowed in logs/backups', () => {
    const cleanAuditPayload = {
      id: 'audit_1',
      action: 'PASSWORD_CHANGED_BY_ADMIN',
      metadata: {
        memberId: 'XPP-100001',
        reason: 'Member lupa password',
        sessionsRevoked: true,
      },
    };
    expect(detectForbiddenPasswordFields(cleanAuditPayload)).toEqual([]);

    const leakyPayload = {
      id: 'audit_2',
      metadata: {
        newPassword: 'secret123',
        nested: [{ passwordHash: 'abc' }],
      },
    };
    const hits = detectForbiddenPasswordFields(leakyPayload);
    expect(hits).toContain('metadata.newPassword');
    expect(hits).toContain('metadata.nested[0].passwordHash');
  });

  it('refuses honestly with 503 ADMIN_SDK_UNAVAILABLE when Firebase Admin SDK is not configured', async () => {
    await expect(
      changeMemberPasswordServer({
        operationId: 'pwd_test_001',
        memberUid: 'uid_member_1',
        newPassword: 'NewPassword2026',
        confirmPassword: 'NewPassword2026',
        reason: 'Member lupa password di cabang Demang',
        adminUid: 'uid_super',
        adminEmail: 'spv.xpplay@gmail.com',
        adminRole: 'SUPER_ADMIN',
      })
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'ADMIN_SDK_UNAVAILABLE',
    });
  });
});

describe('PHASE E — Inactive Member Management & Notification Deduplication (MODULE 6)', () => {
  const NOW = Date.UTC(2026, 6, 1, 12, 0, 0);

  it('exposes all required MODULE 6 presets (7, 14, 30, 60, 90, 180, 365)', () => {
    expect([...INACTIVE_PERIOD_PRESETS]).toEqual([7, 14, 30, 60, 90, 180, 365]);
  });

  it('computes inactivity accurately for played and never-played members', () => {
    const played45 = makeMember({
      uid: 'u1',
      username: 'played45',
      lastPlayAt: NOW - 45 * MS_PER_DAY,
      createdAt: NOW - 120 * MS_PER_DAY,
    });
    const calc1 = calculateMemberInactivity(played45, NOW);
    expect(calc1.neverPlayed).toBe(false);
    expect(calc1.daysInactive).toBe(45);

    const neverPlayed95 = makeMember({
      uid: 'u2',
      username: 'never95',
      lastPlayAt: null,
      createdAt: NOW - 95 * MS_PER_DAY,
    });
    const calc2 = calculateMemberInactivity(neverPlayed95, NOW);
    expect(calc2.neverPlayed).toBe(true);
    expect(calc2.daysInactive).toBe(95);
    expect(calc2.baselineTimestamp).toBe(neverPlayed95.createdAt);
  });

  it('excludes SUSPENDED/DELETED members and filters accurately by preset, custom days, branch, level, and search', () => {
    const members: MemberProfile[] = [
      makeMember({
        uid: 'u_active_recent',
        username: 'recent_player',
        lastPlayAt: NOW - 5 * MS_PER_DAY,
        lastPlayBranch: 'DEMANG',
        currentLevel: 'BRONZE',
      }),
      makeMember({
        uid: 'u_35d',
        username: 'sekip_silver',
        fullName: 'Raka Pratama',
        lastPlayAt: NOW - 35 * MS_PER_DAY,
        lastPlayBranch: 'SEKIP',
        currentLevel: 'SILVER',
      }),
      makeMember({
        uid: 'u_190d',
        username: 'demang_sultan',
        fullName: 'Budi Santoso',
        lastPlayAt: NOW - 190 * MS_PER_DAY,
        lastPlayBranch: 'DEMANG',
        currentLevel: 'SULTAN',
      }),
      makeMember({
        uid: 'u_never_400d',
        username: 'never_played_old',
        fullName: 'Dina Lestari',
        lastPlayAt: null,
        lastPlayBranch: null,
        preferredBranch: 'SEKIP',
        createdAt: NOW - 400 * MS_PER_DAY,
        currentLevel: 'BRONZE',
      }),
      makeMember({
        uid: 'u_suspended',
        username: 'suspended_old',
        status: 'SUSPENDED',
        lastPlayAt: NOW - 200 * MS_PER_DAY,
      }),
      makeMember({
        uid: 'u_deleted',
        username: 'deleted_old',
        status: 'DELETED',
        lastPlayAt: NOW - 300 * MS_PER_DAY,
      }),
    ];

    // 30-day threshold -> excludes 5d, suspended, deleted; sorted longest-inactive first
    const inactive30 = filterAndSortInactiveMembers(members, { thresholdDays: 30, now: NOW });
    expect(inactive30.map((r) => r.member.username)).toEqual([
      'never_played_old',
      'demang_sultan',
      'sekip_silver',
    ]);
    expect(inactive30[0].daysInactive).toBe(400);
    expect(inactive30[1].daysInactive).toBe(190);
    expect(inactive30[2].daysInactive).toBe(35);

    // Custom 45-day threshold excludes 35-day member
    const inactive45 = filterAndSortInactiveMembers(members, { thresholdDays: 45, now: NOW });
    expect(inactive45.map((r) => r.member.username)).toEqual(['never_played_old', 'demang_sultan']);

    // Exclude never-played
    const playedOnly = filterAndSortInactiveMembers(members, {
      thresholdDays: 30,
      now: NOW,
      includeNeverPlayed: false,
    });
    expect(playedOnly.map((r) => r.member.username)).toEqual(['demang_sultan', 'sekip_silver']);

    // Branch filter falls back to preferredBranch when lastPlayBranch is null
    const sekipOnly = filterAndSortInactiveMembers(members, {
      thresholdDays: 30,
      now: NOW,
      branch: 'SEKIP',
    });
    expect(sekipOnly.map((r) => r.member.username)).toEqual(['never_played_old', 'sekip_silver']);

    // Level + search filters
    const sultanOnly = filterAndSortInactiveMembers(members, {
      thresholdDays: 30,
      now: NOW,
      level: 'SULTAN',
      search: 'budi',
    });
    expect(sultanOnly.map((r) => r.member.username)).toEqual(['demang_sultan']);

    // Direct isMemberInactive sanity checks
    expect(isMemberInactive(members[4], 30, NOW)).toBe(false); // SUSPENDED
    expect(isMemberInactive(members[5], 30, NOW)).toBe(false); // DELETED
    expect(isMemberInactive(members[0], 7, NOW)).toBe(false); // 5 days < 7
  });

  it('sorts longest-inactive first deterministically and generates stable daily dedupe keys', () => {
    const mA = makeMember({ uid: 'a', username: 'alpha', lastPlayAt: NOW - 60 * MS_PER_DAY });
    const mB = makeMember({ uid: 'b', username: 'beta', lastPlayAt: NOW - 120 * MS_PER_DAY });
    const sorted = sortInactiveRowsLongestFirst([
      { member: mA, daysInactive: 60, baselineTimestamp: mA.lastPlayAt!, neverPlayed: false },
      { member: mB, daysInactive: 120, baselineTimestamp: mB.lastPlayAt!, neverPlayed: false },
    ]);
    expect(sorted[0].member.username).toBe('beta');

    const k1 = buildInactiveNotificationDedupeKey({
      inactivityDays: 30,
      branch: 'DEMANG',
      level: 'ALL',
      now: Date.UTC(2026, 6, 1, 2, 0, 0), // 09:00 WIB
    });
    const k2 = buildInactiveNotificationDedupeKey({
      inactivityDays: 30,
      branch: 'DEMANG',
      level: 'ALL',
      now: Date.UTC(2026, 6, 1, 14, 0, 0), // 21:00 WIB same Jakarta day
    });
    const kNextDay = buildInactiveNotificationDedupeKey({
      inactivityDays: 30,
      branch: 'DEMANG',
      level: 'ALL',
      now: Date.UTC(2026, 6, 2, 2, 0, 0),
    });
    expect(k1).toBe(k2);
    expect(k1).not.toBe(kNextDay);

    expect(formatInactiveDurationLabel(400, false)).toContain('400 hari');
    expect(formatInactiveDurationLabel(95, true)).toContain('Belum pernah main');
  });
});
