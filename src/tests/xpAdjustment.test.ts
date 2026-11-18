import { describe, expect, it } from 'vitest';
import fs from 'fs';
import {
  calculateXpProgressAdjustment,
  calculateXpRewardAdjustment,
  DEFAULT_LEVELS,
} from '../shared/xpLogic.ts';

describe('PHASE B — Admin XP Progress & XP Reward Adjustment Tests (MODULE 2, 3, 27)', () => {
  it('TEST 1: reduces XP Progress (-100) from 650 SULTAN -> 550 JURAGAN while keeping XP Reward (300) unchanged', () => {
    const res = calculateXpProgressAdjustment({
      currentXpProgress: 650,
      currentXpReward: 300,
      currentLevel: 'SULTAN',
      adjustment: -100,
      levels: DEFAULT_LEVELS,
    });

    expect(res.beforeBalance).toBe(650);
    expect(res.afterBalance).toBe(550);
    expect(res.newXpProgress).toBe(550);
    expect(res.levelBefore).toBe('SULTAN');
    expect(res.levelAfter).toBe('JURAGAN');
    expect(res.levelChanged).toBe(true);
    expect(res.newXpReward).toBe(300);
  });

  it('TEST 2: reduces XP Reward (-100) from 300 -> 200 while keeping XP Progress (650) and Level (SULTAN) unchanged', () => {
    const res = calculateXpRewardAdjustment({
      currentXpProgress: 650,
      currentXpReward: 300,
      currentLevel: 'SULTAN',
      adjustment: -100,
    });

    expect(res.beforeBalance).toBe(300);
    expect(res.afterBalance).toBe(200);
    expect(res.newXpReward).toBe(200);
    expect(res.newXpProgress).toBe(650);
    expect(res.levelBefore).toBe('SULTAN');
    expect(res.levelAfter).toBe('SULTAN');
    expect(res.levelChanged).toBe(false);
  });

  it('supports positive XP Progress and XP Reward adjustments accurately across dynamic level configs', () => {
    const progUp = calculateXpProgressAdjustment({
      currentXpProgress: 280,
      currentXpReward: 50,
      currentLevel: 'SILVER',
      adjustment: 40,
      levels: DEFAULT_LEVELS,
    });
    expect(progUp.newXpProgress).toBe(320);
    expect(progUp.levelAfter).toBe('JURAGAN');
    expect(progUp.newXpReward).toBe(50);

    const customLevels = DEFAULT_LEVELS.map((lvl) =>
      lvl.id === 'SULTAN' ? { ...lvl, minXp: 800 } : lvl
    );
    const progCustom = calculateXpProgressAdjustment({
      currentXpProgress: 850,
      currentXpReward: 200,
      currentLevel: 'SULTAN',
      adjustment: -100,
      levels: customLevels,
    });
    expect(progCustom.newXpProgress).toBe(750);
    expect(progCustom.levelAfter).toBe('JURAGAN');

    const rewUp = calculateXpRewardAdjustment({
      currentXpProgress: 280,
      currentXpReward: 50,
      currentLevel: 'SILVER',
      adjustment: 75,
    });
    expect(rewUp.newXpReward).toBe(125);
    expect(rewUp.newXpProgress).toBe(280);
    expect(rewUp.levelAfter).toBe('SILVER');
  });

  it('rejects negative resulting balances, zero adjustments, and non-integer inputs', () => {
    expect(() =>
      calculateXpProgressAdjustment({
        currentXpProgress: 50,
        currentXpReward: 100,
        currentLevel: 'BRONZE',
        adjustment: -60,
        levels: DEFAULT_LEVELS,
      })
    ).toThrow(/negatif/i);

    expect(() =>
      calculateXpRewardAdjustment({
        currentXpProgress: 200,
        currentXpReward: 40,
        currentLevel: 'SILVER',
        adjustment: -41,
      })
    ).toThrow(/negatif/i);

    expect(() =>
      calculateXpProgressAdjustment({
        currentXpProgress: 100,
        currentXpReward: 100,
        currentLevel: 'BRONZE',
        adjustment: 0,
      })
    ).toThrow();

    expect(() =>
      calculateXpRewardAdjustment({
        currentXpProgress: 100,
        currentXpReward: 100,
        currentLevel: 'BRONZE',
        adjustment: 12.5,
      })
    ).toThrow();
  });

  it('enforces immutable xpAdjustments rules, RBAC (ADMIN/SUPER_ADMIN), and idempotency invariants', () => {
    const rules = fs.readFileSync('firestore.rules', 'utf8');
    expect(rules).toContain('match /xpAdjustments/{adjustmentId}');
    expect(rules).toContain('isValidXpAdjustment(incoming())');
    expect(rules).toContain('isFullAdminOrSuper()');
    expect(rules).toContain('!exists(/databases/$(database)/documents/xpAdjustments/$(adjustmentId))');
    expect(rules).toContain('allow update, delete: if false;');

    const apiCode = fs.readFileSync('src/server/routes/api.ts', 'utf8');
    expect(apiCode).toContain("'/admin/xp-adjustments'");
    expect(apiCode).toContain("requireAdminRole(['SUPER_ADMIN', 'ADMIN'])");

    const xpServiceCode = fs.readFileSync('src/services/xpService.ts', 'utf8');
    expect(xpServiceCode).toContain("'ADMIN_ADJUSTMENT'");
    expect(xpServiceCode).toContain("'XP_REWARD_ADMIN_ADJUSTMENT'");
  });
});
