import { describe, expect, it } from 'vitest';
import fs from 'fs';
import {
  calculateManualLevelOverride,
  calculateRecalculateLevelFromXp,
  DEFAULT_LEVELS,
  resolveEffectiveMemberLevel,
} from '../shared/xpLogic.ts';
import type { LevelId } from '../types/xpplay.ts';

describe('PHASE C — Admin Level Override & Recalculate Tests (MODULE 4, 27)', () => {
  it('TEST 3: Force Level Override changes level from BRONZE (50 XP) -> SULTAN with levelMode = MANUAL_OVERRIDE and keeps XP Progress unchanged', () => {
    const res = calculateManualLevelOverride({
      currentXpProgress: 50,
      currentLevel: 'BRONZE',
      currentLevelMode: 'AUTOMATIC',
      targetLevel: 'SULTAN',
    });

    expect(res.xpProgress).toBe(50);
    expect(res.previousLevel).toBe('BRONZE');
    expect(res.newLevel).toBe('SULTAN');
    expect(res.previousLevelMode).toBe('AUTOMATIC');
    expect(res.newLevelMode).toBe('MANUAL_OVERRIDE');
    expect(res.levelChanged).toBe(true);
  });

  it('preserves MANUAL_OVERRIDE and RESET levels when resolving effective member level regardless of XP Progress', () => {
    const overridden = resolveEffectiveMemberLevel(
      { xpProgress: 50, currentLevel: 'SULTAN', levelMode: 'MANUAL_OVERRIDE' },
      DEFAULT_LEVELS
    );
    expect(overridden.id).toBe('SULTAN');

    const resetMember = resolveEffectiveMemberLevel(
      { xpProgress: 400, currentLevel: 'BRONZE', levelMode: 'RESET' },
      DEFAULT_LEVELS
    );
    expect(resetMember.id).toBe('BRONZE');

    const automaticMember = resolveEffectiveMemberLevel(
      { xpProgress: 320, currentLevel: 'SILVER', levelMode: 'AUTOMATIC' },
      DEFAULT_LEVELS
    );
    expect(automaticMember.id).toBe('JURAGAN');
  });

  it('TEST 4: Recalculate Level From XP restores level from SULTAN (50 XP, MANUAL_OVERRIDE) -> BRONZE with levelMode = AUTOMATIC and keeps XP Progress unchanged', () => {
    const res = calculateRecalculateLevelFromXp({
      currentXpProgress: 50,
      currentLevel: 'SULTAN',
      currentLevelMode: 'MANUAL_OVERRIDE',
      levels: DEFAULT_LEVELS,
    });

    expect(res.xpProgress).toBe(50);
    expect(res.previousLevel).toBe('SULTAN');
    expect(res.newLevel).toBe('BRONZE');
    expect(res.previousLevelMode).toBe('MANUAL_OVERRIDE');
    expect(res.newLevelMode).toBe('AUTOMATIC');
    expect(res.levelChanged).toBe(true);

    // Works with dynamic level thresholds too
    const customLevels = DEFAULT_LEVELS.map((lvl) =>
      lvl.id === 'SILVER' ? { ...lvl, minXp: 40 } : lvl
    );
    const customRes = calculateRecalculateLevelFromXp({
      currentXpProgress: 50,
      currentLevel: 'SULTAN',
      currentLevelMode: 'MANUAL_OVERRIDE',
      levels: customLevels,
    });
    expect(customRes.newLevel).toBe('SILVER');
    expect(customRes.newLevelMode).toBe('AUTOMATIC');
  });

  it('rejects invalid target levels during manual override', () => {
    expect(() =>
      calculateManualLevelOverride({
        currentXpProgress: 100,
        currentLevel: 'BRONZE',
        currentLevelMode: 'AUTOMATIC',
        targetLevel: 'DIAMOND' as LevelId,
      })
    ).toThrow(/Target level tidak valid/i);
  });

  it('enforces immutable levelOverrides rules, RBAC (ADMIN/SUPER_ADMIN), idempotency, and dashboard preservation', () => {
    const rules = fs.readFileSync('firestore.rules', 'utf8');
    expect(rules).toContain('match /levelOverrides/{overrideId}');
    expect(rules).toContain('isValidLevelOverride(incoming())');
    expect(rules).toContain('isFullAdminOrSuper()');
    expect(rules).toContain('!exists(/databases/$(database)/documents/levelOverrides/$(overrideId))');
    expect(rules).toContain('allow update, delete: if false;');
    expect(rules).toContain("'MANUAL_OVERRIDE', 'RESET'");

    const apiCode = fs.readFileSync('src/server/routes/api.ts', 'utf8');
    expect(apiCode).toContain("'/admin/level-overrides'");
    expect(apiCode).toContain("requireAdminRole(['SUPER_ADMIN', 'ADMIN'])");

    const serverEngine = fs.readFileSync('src/server/services/xpEngineServer.ts', 'utf8');
    expect(serverEngine).toContain('overrideMemberLevelServer');
    expect(serverEngine).toContain("member.levelMode === 'MANUAL_OVERRIDE'");

    const clientService = fs.readFileSync('src/services/xpService.ts', 'utf8');
    expect(clientService).toContain('overrideMemberLevelByAdmin');
    expect(clientService).toContain('resolveEffectiveMemberLevel');

    const showcase = fs.readFileSync('src/components/MemberXpShowcase.tsx', 'utf8');
    const memberDash = fs.readFileSync('src/pages/MemberDashboardPage.tsx', 'utf8');
    expect(showcase).toContain('resolveEffectiveMemberLevel');
    expect(memberDash).toContain('resolveEffectiveMemberLevel');
  });
});
