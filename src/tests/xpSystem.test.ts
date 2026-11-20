import { describe, expect, it } from 'vitest';
import {
  buildUsernameHashId,
  buildWhatsappHashId,
  calculateTransactionXp,
  DEFAULT_LEVELS,
  formatDateTimeLocalInput,
  isCampaignClaimable,
  isLevelEligible,
  normalizeUsername,
  normalizeWhatsapp,
  resolveCampaignStatus,
  resolveLevelFromXp,
  validateLevelThresholds,
  validateUsername,
  validateWhatsapp,
} from '../shared/xpLogic.ts';
import {
  createCaptchaChallenge,
  verifyCaptchaResponse,
} from '../server/services/captchaService.ts';
import fs from 'fs';

describe('XP PLAY Mandatory Business Logic & Security Tests', () => {
  it('resolves member levels accurately across all default thresholds (149/150/299/300/599/600)', () => {
    expect(resolveLevelFromXp(0, DEFAULT_LEVELS).current.id).toBe('BRONZE');
    expect(resolveLevelFromXp(149, DEFAULT_LEVELS).current.id).toBe('BRONZE');
    expect(resolveLevelFromXp(150, DEFAULT_LEVELS).current.id).toBe('SILVER');
    expect(resolveLevelFromXp(299, DEFAULT_LEVELS).current.id).toBe('SILVER');
    expect(resolveLevelFromXp(300, DEFAULT_LEVELS).current.id).toBe('JURAGAN');
    expect(resolveLevelFromXp(599, DEFAULT_LEVELS).current.id).toBe('JURAGAN');
    expect(resolveLevelFromXp(600, DEFAULT_LEVELS).current.id).toBe('SULTAN');
    expect(resolveLevelFromXp(1200, DEFAULT_LEVELS).next).toBeNull();
  });

  it('validates admin threshold ordering strictly: Bronze < Silver < Juragan < Sultan', () => {
    expect(validateLevelThresholds(DEFAULT_LEVELS).valid).toBe(true);
    const invalid = [
      { ...DEFAULT_LEVELS[0], minXp: 0 },
      { ...DEFAULT_LEVELS[1], minXp: 300 },
      { ...DEFAULT_LEVELS[2], minXp: 250 },
      { ...DEFAULT_LEVELS[3], minXp: 600 },
    ];
    expect(validateLevelThresholds(invalid).valid).toBe(false);
  });

  it('calculates transaction XP with integer arithmetic: Rp100.000 / 2000 = 50 XP', () => {
    expect(calculateTransactionXp(100000, 2000)).toBe(50);
    expect(calculateTransactionXp(10000, 2000)).toBe(5);
    expect(calculateTransactionXp(20000, 2000)).toBe(10);
    expect(calculateTransactionXp(50000, 2000)).toBe(25);
    expect(calculateTransactionXp(3999, 2000)).toBe(1);
    expect(() => calculateTransactionXp(-1000, 2000)).toThrow();
    expect(() => calculateTransactionXp(1000.5, 2000)).toThrow();
  });

  it('validates and normalizes usernames & Indonesian WhatsApp numbers', () => {
    expect(normalizeUsername('  Andi_Play  ')).toBe('andi_play');
    expect(validateUsername('andi_play').valid).toBe(true);
    expect(validateUsername('admin').valid).toBe(false);
    expect(validateUsername('superadmin').valid).toBe(false);
    expect(validateUsername('ab').valid).toBe(false);

    expect(normalizeWhatsapp('0898-3761-001')).toBe('628983761001');
    expect(normalizeWhatsapp('+62 898 3761 001')).toBe('628983761001');
    expect(validateWhatsapp('08983761001').valid).toBe(true);
    expect(validateWhatsapp('12345').valid).toBe(false);
  });

  it('enforces level benefit eligibility (currentLevel >= requiredLevel)', () => {
    expect(isLevelEligible('BRONZE', 'BRONZE', DEFAULT_LEVELS)).toBe(true);
    expect(isLevelEligible('BRONZE', 'SILVER', DEFAULT_LEVELS)).toBe(false);
    expect(isLevelEligible('JURAGAN', 'SILVER', DEFAULT_LEVELS)).toBe(true);
    expect(isLevelEligible('SULTAN', 'JURAGAN', DEFAULT_LEVELS)).toBe(true);
  });

  it('prevents claiming expired or quota-exhausted challenges/events/promos', () => {
    const now = Date.now();
    const expiredCampaign = {
      status: 'ACTIVE' as const,
      active: true,
      startAt: now - 100000,
      endAt: now - 1000,
      totalClaimLimit: null,
      claimsCount: 0,
    };
    expect(resolveCampaignStatus(expiredCampaign, now)).toBe('EXPIRED');
    expect(isCampaignClaimable(expiredCampaign, now)).toBe(false);

    const activeCampaign = {
      ...expiredCampaign,
      endAt: now + 60000,
    };
    expect(resolveCampaignStatus(activeCampaign, now)).toBe('ACTIVE');
    expect(isCampaignClaimable(activeCampaign, now)).toBe(true);

    const fullCampaign = {
      ...activeCampaign,
      totalClaimLimit: 10,
      claimsCount: 10,
    };
    expect(isCampaignClaimable(fullCampaign, now)).toBe(false);
  });

  it('formats datetime-local strings strictly in Asia/Jakarta (UTC+7)', () => {
    // 2026-06-01T00:30:00.000Z === 2026-06-01T07:30 WIB
    const utcMs = Date.UTC(2026, 5, 1, 0, 30, 0);
    expect(formatDateTimeLocalInput(utcMs)).toBe('2026-06-01T07:30');
  });

  it('verifies server-side CAPTCHA and rejects missing/wrong/replayed tokens', async () => {
    const challenge = createCaptchaChallenge();
    expect(challenge.mode).toBe('server_svg');
    expect(challenge.challengeToken).toBeTruthy();
    expect(challenge.svg).toContain('<svg');

    const bad = await verifyCaptchaResponse({
      token: challenge.challengeToken,
      answer: 'WRONG',
    });
    expect(bad.valid).toBe(false);

    const empty = await verifyCaptchaResponse({ token: '', answer: '' });
    expect(empty.valid).toBe(false);
  });

  it('generates deterministic zero-PII SHA-256 authIndex document IDs', async () => {
    const u1 = await buildUsernameHashId('Andi_Play');
    const u2 = await buildUsernameHashId('  andi_play ');
    expect(u1).toBe(u2);
    expect(u1).toMatch(/^u_[a-f0-9]{64}$/);

    const w1 = await buildWhatsappHashId('0898-3761-001');
    const w2 = await buildWhatsappHashId('+62 898 3761 001');
    expect(w1).toBe(w2);
    expect(w1).toMatch(/^w_[a-f0-9]{64}$/);
  });

  it('enforces Zero-Trust Firestore security rules invariants in firestore.rules', () => {
    const rules = fs.readFileSync('firestore.rules', 'utf8');
    // Default deny present
    expect(rules).toContain('allow read, write: if false;');
    // AuthIndex and Identity index locked
    expect(rules).toContain('match /authIndex/{hashId}');
    expect(rules).toContain('match /identityIndex/{indexKey}');
    // Admin email verification enforced
    expect(rules).toContain('request.auth.token.email_verified == true');
    // Members cannot update XP/level/status (only allowed profile fields)
    expect(rules).toContain("'fullName', 'socialMedia', 'preferredBranch',");
    expect(rules).toContain("'birthDate', 'birthMonth', 'birthDay', 'memberCategory', 'updatedAt'");
    // Dynamic initial level validation on member registration
    expect(rules).toContain("incoming().currentLevel in ['SILVER', 'JURAGAN', 'SULTAN']");
    // Claims & Redemptions locked to ON_PROCESS on create and admin-only (when not restore-locked) on update
    expect(rules).toContain("incoming().status == 'ON_PROCESS'");
    expect(rules).toContain("existing().status == 'ON_PROCESS'");
    expect(rules).toContain('isAdmin()\n          && !isSystemRestoreLocked()');
    // Atomic review counters scoped cleanly
    expect(rules).toContain("affectedKeys().hasOnly(['claimsCount', 'updatedAt'])");
    expect(rules).toContain("affectedKeys().hasOnly(['stock', 'updatedAt'])");
  });
});
