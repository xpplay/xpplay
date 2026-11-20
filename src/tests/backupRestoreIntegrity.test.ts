import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Response } from 'express';
import { BackupRestoreEngine } from '../server/services/backupRestoreService.ts';
import type { BackupDataStore, StoredDocEntry } from '../server/services/firestoreRestHelper.ts';
import { requireSystemNotLocked, type AuthenticatedRequest } from '../server/middleware/authMiddleware.ts';
import {
  canDeleteBackupRecord,
  checkBackupSchemaCompatibility,
  DEFAULT_BACKUP_RETENTION,
  RESTORE_CONFIRMATION_PHRASE,
  RESTORE_MAINTENANCE_MESSAGE,
} from '../shared/backupRestoreLogic.ts';
import { runDataIntegrityChecks, type IntegrityDataset } from '../shared/integrityLogic.ts';
import { DEFAULT_LEVELS } from '../shared/xpLogic.ts';
import type {
  BenefitItem,
  BenefitRequestRecord,
  CampaignItem,
  ClaimRecord,
  CmsPublishedDoc,
  MemberProfile,
  RedemptionRecord,
  ReferralRecord,
  TransactionRecord,
  XpLedgerEntry,
} from '../types/xpplay.ts';

class InMemoryBackupDataStore implements BackupDataStore {
  public collections = new Map<string, Map<string, Record<string, unknown>>>();

  private ensureCol(name: string): Map<string, Record<string, unknown>> {
    let col = this.collections.get(name);
    if (!col) {
      col = new Map();
      this.collections.set(name, col);
    }
    return col;
  }

  public async listCollection(collectionName: string): Promise<StoredDocEntry[]> {
    const col = this.collections.get(collectionName);
    if (!col) return [];
    return Array.from(col.entries()).map(([id, data]) => ({
      id,
      data: structuredClone(data),
    }));
  }

  public async getDocument(
    collectionName: string,
    docId: string
  ): Promise<Record<string, unknown> | null> {
    const found = this.collections.get(collectionName)?.get(docId);
    return found ? structuredClone(found) : null;
  }

  public async setDocument(
    collectionName: string,
    docId: string,
    data: Record<string, unknown>
  ): Promise<void> {
    this.ensureCol(collectionName).set(docId, structuredClone(data));
  }

  public async deleteDocument(collectionName: string, docId: string): Promise<void> {
    this.collections.get(collectionName)?.delete(docId);
  }

  public async replaceCollection(collectionName: string, docs: StoredDocEntry[]): Promise<number> {
    const next = new Map<string, Record<string, unknown>>();
    for (const d of docs) {
      next.set(d.id, structuredClone(d.data));
    }
    this.collections.set(collectionName, next);
    return docs.length;
  }
}

function seedBaselineStore(store: InMemoryBackupDataStore, uploadsRoot: string): void {
  const now = Date.UTC(2026, 5, 1, 10, 0, 0);
  for (const lvl of DEFAULT_LEVELS) {
    void store.setDocument('levels', lvl.id, lvl as unknown as Record<string, unknown>);
  }
  void store.setDocument('systemSettings', 'default', {
    id: 'default',
    transactionXpRate: 10000,
    registrationBonusXp: 10,
    referralBonusXp: 5,
    refundOnExpiry: false,
    currentCycleId: 'cycle_2026_q2',
    resetEnabled: false,
    resetInterval: 6,
    resetUnit: 'MONTHS',
    nextResetAt: null,
    resetXpProgress: true,
    resetLevel: true,
    resetXpReward: false,
    updatedAt: now,
    updatedBy: 'uid_super',
  });
  void store.setDocument('admins', 'uid_super', {
    uid: 'uid_super',
    email: 'spv.xpplay@gmail.com',
    fullName: 'Super Admin XP PLAY',
    role: 'SUPER_ADMIN',
    branchScope: 'ALL',
    permissions: {},
    active: true,
    createdAt: now,
    updatedAt: now,
  });

  const member1: MemberProfile = {
    uid: 'uid_m1',
    memberId: 'XPP-100001',
    fullName: 'Andi Saputra',
    username: 'andi.gaming',
    whatsapp: '6281234500001',
    socialMedia: '@andigaming',
    birthDate: '1999-08-17',
    birthMonth: 8,
    birthDay: 17,
    memberCategory: 'MAHASISWA',
    status: 'ACTIVE',
    xpProgress: 180,
    xpReward: 80,
    reservedXp: 0,
    currentLevel: 'SILVER',
    levelMode: 'AUTOMATIC',
    currentCycleId: 'cycle_2026_q2',
    referredByUid: null,
    referredByUsername: null,
    referralCount: 1,
    lastPlayAt: now - 3 * 86400000,
    lastPlayBranch: 'DEMANG',
    preferredBranch: 'DEMANG',
    createdAt: now - 30 * 86400000,
    updatedAt: now,
  };
  const member2: MemberProfile = {
    uid: 'uid_m2',
    memberId: 'XPP-100002',
    fullName: 'Siti Rahma',
    username: 'siti.play',
    whatsapp: '6281234500002',
    socialMedia: '',
    birthDate: '2001-03-10',
    birthMonth: 3,
    birthDay: 10,
    memberCategory: 'PELAJAR',
    status: 'ACTIVE',
    xpProgress: 15,
    xpReward: 15,
    reservedXp: 0,
    currentLevel: 'BRONZE',
    levelMode: 'AUTOMATIC',
    currentCycleId: 'cycle_2026_q2',
    referredByUid: 'uid_m1',
    referredByUsername: 'andi.gaming',
    referralCount: 0,
    lastPlayAt: now - 10 * 86400000,
    lastPlayBranch: 'SEKIP',
    preferredBranch: 'SEKIP',
    createdAt: now - 20 * 86400000,
    updatedAt: now,
  };
  void store.setDocument('members', member1.uid, member1 as unknown as Record<string, unknown>);
  void store.setDocument('members', member2.uid, member2 as unknown as Record<string, unknown>);

  const referral: ReferralRecord = {
    id: 'ref_uid_m2',
    referrerUid: 'uid_m1',
    referrerMemberId: member1.memberId,
    referrerUsername: 'andi.gaming',
    refereeUid: 'uid_m2',
    refereeMemberId: member2.memberId,
    refereeUsername: 'siti.play',
    referrerXp: 5,
    refereeXp: 5,
    cycleId: 'cycle_2026_q2',
    createdAt: now - 20 * 86400000,
  };
  void store.setDocument('referrals', referral.id, referral as unknown as Record<string, unknown>);

  const campaign: CampaignItem = {
    id: 'camp_1',
    type: 'CHALLENGE',
    title: 'Weekend Streak',
    description: 'Main 2 jam akhir pekan',
    startAt: now - 5 * 86400000,
    endAt: now + 30 * 86400000,
    xpReward: 20,
    imageUrl: '',
    terms: '',
    maxClaimsPerMember: 1,
    totalClaimLimit: 50,
    claimsCount: 1,
    active: true,
    status: 'ACTIVE',
    requiresEvidence: true,
    createdBy: 'uid_super',
    createdAt: now - 5 * 86400000,
    updatedAt: now,
  };
  void store.setDocument('campaigns', campaign.id, campaign as unknown as Record<string, unknown>);

  const benefit: BenefitItem = {
    id: 'ben_1',
    name: 'Gratis 1 Jam PS5',
    description: 'Voucher main 1 jam',
    imageUrl: '',
    xpCost: 40,
    levelRequirement: 'BRONZE',
    claimable: true,
    redeemable: true,
    stock: 20,
    expiryAt: null,
    terms: '',
    active: true,
    createdBy: 'uid_super',
    createdAt: now - 10 * 86400000,
    updatedAt: now,
  };
  void store.setDocument('benefits', benefit.id, benefit as unknown as Record<string, unknown>);

  // Write real claim evidence & cms asset files
  fs.mkdirSync(path.join(uploadsRoot, 'claims', 'uid_m1'), { recursive: true });
  fs.writeFileSync(path.join(uploadsRoot, 'claims', 'uid_m1', 'proof1.png'), Buffer.from('PNGDATA_CLAIM_1'));
  fs.mkdirSync(path.join(uploadsRoot, 'cms'), { recursive: true });
  fs.writeFileSync(path.join(uploadsRoot, 'cms', 'hero_v1.png'), Buffer.from('PNGDATA_CMS_HERO'));

  const claim: ClaimRecord = {
    id: 'clm_1',
    memberId: member1.memberId,
    memberUid: member1.uid,
    memberUsername: member1.username,
    campaignId: campaign.id,
    campaignTitle: campaign.title,
    campaignType: campaign.type,
    xpRewardSnapshot: 20,
    evidenceUrl: '/api/claims/evidence/uid_m1/proof1.png',
    evidencePath: 'claims/uid_m1/proof1.png',
    note: 'Struk PS5 Demang',
    status: 'APPROVED',
    reviewedBy: 'uid_super',
    reviewerRole: 'SUPER_ADMIN',
    reviewedAt: now,
    denialReason: null,
    cycleId: 'cycle_2026_q2',
    createdAt: now - 86400000,
  };
  void store.setDocument('claims', claim.id, claim as unknown as Record<string, unknown>);

  const redemption: RedemptionRecord = {
    id: 'red_1',
    memberId: member1.memberId,
    memberUid: member1.uid,
    memberUsername: member1.username,
    benefitId: benefit.id,
    benefitName: benefit.name,
    xpCostSnapshot: 40,
    levelRequirement: 'BRONZE',
    redemptionKind: 'XP_REWARD',
    status: 'APPROVED',
    reviewedBy: 'uid_super',
    reviewerRole: 'SUPER_ADMIN',
    reviewedAt: now,
    denialReason: null,
    cycleId: 'cycle_2026_q2',
    createdAt: now - 86400000,
  };
  void store.setDocument('redemptions', redemption.id, redemption as unknown as Record<string, unknown>);

  const benefitRequest: BenefitRequestRecord = {
    id: 'BRQ-20260601-BASE',
    memberId: member1.memberId,
    memberUid: member1.uid,
    memberUsername: member1.username,
    memberName: member1.fullName,
    memberWhatsapp: member1.whatsapp,
    sourceType: 'GENERAL_BENEFIT',
    sourceId: benefit.id,
    title: benefit.name,
    xpCost: 40,
    xpRewardGrant: 0,
    levelRequirement: 'BRONZE',
    evidenceUrl: '',
    evidencePath: '',
    note: 'Baseline unified benefit request',
    status: 'APPROVED',
    resolution: null,
    holdLedgerId: 'xpr_hold_base',
    refundLedgerId: null,
    branch: 'DEMANG',
    approvedAt: now - 86400000,
    approvedBy: 'uid_super',
    approvedByRole: 'SUPER_ADMIN',
    deniedAt: null,
    deniedBy: null,
    deniedReason: null,
    expiresAt: now + 6 * 86400000,
    expiredAt: null,
    usedAt: null,
    usedBy: null,
    usedBranch: null,
    receiptReference: null,
    refundedAt: null,
    refundReason: null,
    refundedAmount: 0,
    cycleId: 'cycle_2026_q2',
    createdAt: now - 2 * 86400000,
    updatedAt: now - 86400000,
  };
  void store.setDocument('benefitRequests', benefitRequest.id, benefitRequest as unknown as Record<string, unknown>);

  const tx: TransactionRecord = {
    id: 'tx_1',
    memberId: member1.memberId,
    memberUid: member1.uid,
    memberUsername: member1.username,
    branch: 'DEMANG',
    amountIdr: 100000,
    xpRateUsed: 10000,
    xpGenerated: 10,
    source: 'TRANSACTION',
    receiptNumber: 'RCP-001',
    note: 'Billing 2 jam',
    adminId: 'uid_super',
    adminName: 'Super Admin XP PLAY',
    cycleId: 'cycle_2026_q2',
    createdAt: now - 3 * 86400000,
  };
  void store.setDocument('transactions', tx.id, tx as unknown as Record<string, unknown>);

  const progLedger: XpLedgerEntry = {
    id: 'xpp_1',
    memberId: member1.memberId,
    memberUid: member1.uid,
    amount: 180,
    type: 'PROGRESS',
    direction: 'CREDIT',
    source: 'TRANSACTION',
    referenceId: tx.id,
    branch: 'DEMANG',
    cycleId: 'cycle_2026_q2',
    createdBy: 'uid_super',
    note: 'Baseline XP Progress',
    createdAt: now - 3 * 86400000,
  };
  const rewLedger: XpLedgerEntry = {
    id: 'xpr_1',
    memberId: member1.memberId,
    memberUid: member1.uid,
    amount: 80,
    type: 'REWARD',
    direction: 'CREDIT',
    source: 'TRANSACTION',
    referenceId: tx.id,
    branch: 'DEMANG',
    cycleId: 'cycle_2026_q2',
    createdBy: 'uid_super',
    note: 'Baseline XP Reward',
    createdAt: now - 3 * 86400000,
  };
  void store.setDocument('xpProgressLedger', progLedger.id, progLedger as unknown as Record<string, unknown>);
  void store.setDocument('xpRewardLedger', rewLedger.id, rewLedger as unknown as Record<string, unknown>);

  void store.setDocument('cmsPublished', 'homepage', {
    id: 'homepage',
    content: {
      brandName: 'XP PLAY',
      storeName: 'XP PLAY Demang & Sekip',
      logoUrl: '',
      faviconUrl: '',
      heroImageUrl: '/api/cms/assets/hero_v1.png',
      bannerImageUrl: '',
      aboutImageUrl: '',
    },
    versionId: 'v1',
    versionNumber: 1,
    publishedAt: now,
    publishedBy: 'uid_super',
    publishedByEmail: 'spv.xpplay@gmail.com',
    updatedAt: now,
  });

  void store.setDocument('auditLogs', 'audit_preexisting_001', {
    id: 'audit_preexisting_001',
    actorId: 'uid_super',
    actorRole: 'SUPER_ADMIN',
    action: 'SYSTEM_INIT',
    targetType: 'system',
    targetId: 'default',
    before: null,
    after: { ok: true },
    metadata: null,
    timestamp: now - 86400000,
  });
}

describe('PHASES F, G, H, I, K — Backup, Verification, Restore, Lock & 15-Point Integrity (MODULES 7–24, 26, 27)', () => {
  let tmpDir: string;
  let backupsRoot: string;
  let uploadsRoot: string;
  let store: InMemoryBackupDataStore;
  let engine: BackupRestoreEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpplay-bkp-test-'));
    backupsRoot = path.join(tmpDir, '.backups');
    uploadsRoot = path.join(tmpDir, '.uploads');
    store = new InMemoryBackupDataStore();
    seedBaselineStore(store, uploadsRoot);
    engine = new BackupRestoreEngine({
      backupsRoot,
      uploadsRoot,
      store,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('TEST 5 — Backup A and Backup B have unique IDs, isolated directories, separate manifests, and never overwrite each other', async () => {
    const resA = await engine.createSystemBackup({
      kind: 'MANUAL',
      note: 'Backup A',
      actorUid: 'uid_super',
      actorEmail: 'spv.xpplay@gmail.com',
      actorRole: 'SUPER_ADMIN',
    });

    // Mutate live data between A and B
    const m1 = await store.getDocument('members', 'uid_m1');
    await store.setDocument('members', 'uid_m1', { ...m1!, xpProgress: 250, currentLevel: 'SILVER' });

    const resB = await engine.createSystemBackup({
      kind: 'MANUAL',
      note: 'Backup B',
      actorUid: 'uid_super',
      actorEmail: 'spv.xpplay@gmail.com',
      actorRole: 'SUPER_ADMIN',
    });

    expect(resA.record.status).toBe('COMPLETED');
    expect(resB.record.status).toBe('COMPLETED');
    expect(resA.record.backupId).not.toBe(resB.record.backupId);
    expect(resA.record.operationId).not.toBe(resB.record.operationId);
    expect(resA.record.storagePath).not.toBe(resB.record.storagePath);

    // Both manifests and snapshots exist independently on disk
    const manifestA = engine.readBackupManifestFromDisk(resA.record.backupId);
    const manifestB = engine.readBackupManifestFromDisk(resB.record.backupId);
    expect(manifestA?.backupId).toBe(resA.record.backupId);
    expect(manifestB?.backupId).toBe(resB.record.backupId);
    expect(manifestA?.manifestChecksumSha256).not.toBe(manifestB?.manifestChecksumSha256);

    // Verify Backup A still preserves original xpProgress=180
    const membersA = JSON.parse(
      fs.readFileSync(path.join(backupsRoot, resA.record.backupId, 'firestore', 'members.json'), 'utf8')
    ) as StoredDocEntry[];
    const m1InA = membersA.find((d) => d.id === 'uid_m1');
    expect(m1InA?.data.xpProgress).toBe(180);
  });

  it('TEST 6 — Concurrent backup request collides cleanly and is rejected with 409 BACKUP_IN_PROGRESS', async () => {
    const slowStore = new InMemoryBackupDataStore();
    seedBaselineStore(slowStore, uploadsRoot);
    const origList = slowStore.listCollection.bind(slowStore);
    slowStore.listCollection = async (col) => {
      if (col === 'members') {
        await new Promise((r) => setTimeout(r, 40));
      }
      return origList(col);
    };

    const slowEngine = new BackupRestoreEngine({ backupsRoot, uploadsRoot, store: slowStore });
    const p1 = slowEngine.createSystemBackup({
      kind: 'MANUAL',
      note: 'First backup',
      actorUid: 'uid_super',
      actorEmail: 'spv.xpplay@gmail.com',
      actorRole: 'SUPER_ADMIN',
    });
    const p2 = slowEngine.createSystemBackup({
      kind: 'MANUAL',
      note: 'Concurrent colliding backup',
      actorUid: 'uid_super',
      actorEmail: 'spv.xpplay@gmail.com',
      actorRole: 'SUPER_ADMIN',
    });

    const [r1, r2] = await Promise.allSettled([p1, p2]);
    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('rejected');
    if (r2.status === 'rejected') {
      expect((r2.reason as { statusCode?: number; code?: string }).statusCode).toBe(409);
      expect((r2.reason as { statusCode?: number; code?: string }).code).toBe('BACKUP_IN_PROGRESS');
    }
  });

  it('TEST 7 — Full Restore creates mandatory Pre-Restore Backup FIRST, restores state & storage, and preserves auditLogs & systemBackups', async () => {
    // 1. Create clean Backup A (baseline: uid_m1 xpProgress=120, proof1.png exists)
    const backupA = await engine.createSystemBackup({
      kind: 'MANUAL',
      note: 'Baseline before accidental edit',
      actorUid: 'uid_super',
      actorEmail: 'spv.xpplay@gmail.com',
      actorRole: 'SUPER_ADMIN',
    });

    // 2. Mutate live DB & storage (simulate operator mistake)
    const m1Live = await store.getDocument('members', 'uid_m1');
    await store.setDocument('members', 'uid_m1', { ...m1Live!, xpProgress: 999, currentLevel: 'SULTAN' });
    fs.writeFileSync(path.join(uploadsRoot, 'claims', 'uid_m1', 'proof1.png'), Buffer.from('OVERWRITTEN'));
    await store.setDocument('auditLogs', 'audit_before_restore_999', {
      id: 'audit_before_restore_999',
      actorId: 'uid_super',
      actorRole: 'SUPER_ADMIN',
      action: 'IMPORTANT_EVENT',
      targetType: 'member',
      targetId: 'uid_m1',
      before: null,
      after: null,
      metadata: null,
      timestamp: Date.now(),
    });

    // 3. Preview restore
    const preview = await engine.previewRestore({
      backupId: backupA.record.backupId,
      actorUid: 'uid_super',
      actorRole: 'SUPER_ADMIN',
    });
    expect(preview.canProceed).toBe(true);
    expect(preview.compatible).toBe(true);
    expect(preview.requiresConfirmationPhrase).toBe(RESTORE_CONFIRMATION_PHRASE);

    // 4. Execute restore
    const job = await engine.executeRestore({
      backupId: backupA.record.backupId,
      confirmationPhrase: RESTORE_CONFIRMATION_PHRASE,
      reason: 'Rollback kesalahan input massal',
      actorUid: 'uid_super',
      actorEmail: 'spv.xpplay@gmail.com',
      actorRole: 'SUPER_ADMIN',
    });

    expect(job.status).toBe('COMPLETED');
    expect(job.postRestoreVerificationPassed).toBe(true);
    expect(job.preRestoreBackupId).toMatch(/^backup_pre_restore_/);
    expect(job.integrityReport?.passed).toBe(true);
    expect(job.integrityReport?.totalChecks).toBe(15);

    // Confirm step order: PRE_RESTORE_BACKUP strictly preceded RESTORE_FIRESTORE
    const preIdx = job.steps.findIndex((s) => s.step === 'PRE_RESTORE_BACKUP');
    const fsIdx = job.steps.findIndex((s) => s.step === 'RESTORE_FIRESTORE');
    expect(preIdx).toBeGreaterThan(-1);
    expect(fsIdx).toBeGreaterThan(preIdx);

    // Confirm live DB & storage were restored back to Backup A (including benefitRequests)
    const m1Restored = await store.getDocument('members', 'uid_m1');
    expect(m1Restored?.xpProgress).toBe(180);
    expect(m1Restored?.currentLevel).toBe('SILVER');
    const brqRestored = await store.getDocument('benefitRequests', 'BRQ-20260601-BASE');
    expect(brqRestored?.status).toBe('APPROVED');
    expect(
      fs.readFileSync(path.join(uploadsRoot, 'claims', 'uid_m1', 'proof1.png'), 'utf8')
    ).toBe('PNGDATA_CLAIM_1');

    // Confirm Pre-Restore Backup actually captured the mutated xpProgress=999 snapshot!
    const preMembers = JSON.parse(
      fs.readFileSync(path.join(backupsRoot, job.preRestoreBackupId!, 'firestore', 'members.json'), 'utf8')
    ) as StoredDocEntry[];
    expect(preMembers.find((d) => d.id === 'uid_m1')?.data.xpProgress).toBe(999);

    // Confirm protected collections (auditLogs & systemBackups) were NEVER deleted
    const preservedAudit = await store.getDocument('auditLogs', 'audit_before_restore_999');
    expect(preservedAudit).not.toBeNull();
    const backupsAfter = await engine.listSystemBackups();
    expect(backupsAfter.some((b) => b.backupId === backupA.record.backupId)).toBe(true);
    expect(backupsAfter.some((b) => b.backupId === job.preRestoreBackupId)).toBe(true);

    // Confirm restore lock was cleanly released in finally
    expect(engine.isRestoreLockActiveSync()).toBe(false);
  });

  it('TEST 8 & TEST 9 — Restore Lock blocks Admin XP/Transaction writes & Member Claim writes with HTTP 503 and returns zero-PII Maintenance message', async () => {
    const backupA = await engine.createSystemBackup({
      kind: 'MANUAL',
      note: 'Lock test baseline',
      actorUid: 'uid_super',
      actorEmail: 'spv.xpplay@gmail.com',
      actorRole: 'SUPER_ADMIN',
    });

    let adminStatusCode = 0;
    let adminBody: Record<string, unknown> = {};
    let memberStatusCode = 0;
    let memberBody: Record<string, unknown> = {};
    let observedLockDuringRestore: Awaited<ReturnType<typeof engine.getRestoreLockState>> | null = null;

    const middleware = requireSystemNotLocked(async () => engine.getRestoreLockState());

    await engine.executeRestore({
      backupId: backupA.record.backupId,
      confirmationPhrase: RESTORE_CONFIRMATION_PHRASE,
      reason: 'Verifikasi blokir write saat maintenance lock aktif',
      actorUid: 'uid_super',
      actorEmail: 'spv.xpplay@gmail.com',
      actorRole: 'SUPER_ADMIN',
      onBeforeVerificationHook: async () => {
        observedLockDuringRestore = await engine.getRestoreLockState();

        // TEST 8: Simulate Admin XP Adjustment / Transaction write during Restore Lock
        const adminReq = { headers: {} } as AuthenticatedRequest;
        const adminRes = {
          status: vi.fn((code: number) => {
            adminStatusCode = code;
            return adminRes;
          }),
          json: vi.fn((payload: Record<string, unknown>) => {
            adminBody = payload;
            return adminRes;
          }),
        } as unknown as Response;
        const adminNext = vi.fn() as NextFunction;
        await middleware(adminReq, adminRes, adminNext);
        expect(adminNext).not.toHaveBeenCalled();

        // TEST 9: Simulate Member Claim Evidence upload during Restore Lock
        const memberReq = { headers: {} } as AuthenticatedRequest;
        const memberRes = {
          status: vi.fn((code: number) => {
            memberStatusCode = code;
            return memberRes;
          }),
          json: vi.fn((payload: Record<string, unknown>) => {
            memberBody = payload;
            return memberRes;
          }),
        } as unknown as Response;
        const memberNext = vi.fn() as NextFunction;
        await middleware(memberReq, memberRes, memberNext);
        expect(memberNext).not.toHaveBeenCalled();
      },
    });

    expect(observedLockDuringRestore!.locked).toBe(true);
    expect(observedLockDuringRestore!.state).toBe('RESTORE_IN_PROGRESS');
    expect(observedLockDuringRestore!.message).toBe(RESTORE_MAINTENANCE_MESSAGE);
    // Zero PII on restoreLock document (readable by signed-in members)
    expect(observedLockDuringRestore!.lockedByEmail).toBeNull();

    expect(adminStatusCode).toBe(503);
    expect(adminBody.code).toBe('RESTORE_IN_PROGRESS');
    expect(adminBody.error).toBe(RESTORE_MAINTENANCE_MESSAGE);

    expect(memberStatusCode).toBe(503);
    expect(memberBody.code).toBe('RESTORE_IN_PROGRESS');
    expect(memberBody.error).toBe(RESTORE_MAINTENANCE_MESSAGE);
  });

  it('TEST 10 — Post-Restore Verification failure strictly sets status to VERIFICATION_FAILED (never COMPLETED) with recovery recommendation', async () => {
    const backupA = await engine.createSystemBackup({
      kind: 'MANUAL',
      note: 'Baseline for Test 10',
      actorUid: 'uid_super',
      actorEmail: 'spv.xpplay@gmail.com',
      actorRole: 'SUPER_ADMIN',
    });

    const job = await engine.executeRestore({
      backupId: backupA.record.backupId,
      confirmationPhrase: RESTORE_CONFIRMATION_PHRASE,
      reason: 'Simulasi kegagalan integritas pasca-restore',
      actorUid: 'uid_super',
      actorEmail: 'spv.xpplay@gmail.com',
      actorRole: 'SUPER_ADMIN',
      onBeforeVerificationHook: async () => {
        // Inject critical post-restore corruption: negative XP balance + orphan claim
        const m1 = await store.getDocument('members', 'uid_m1');
        await store.setDocument('members', 'uid_m1', { ...m1!, xpReward: -50 });
        await store.setDocument('claims', 'clm_orphan', {
          id: 'clm_orphan',
          memberId: 'XPP-999999',
          memberUid: 'uid_missing',
          memberUsername: 'ghost',
          campaignId: 'camp_1',
          campaignTitle: 'Weekend Streak',
          campaignType: 'CHALLENGE',
          xpRewardSnapshot: 20,
          evidenceUrl: '',
          evidencePath: '',
          note: '',
          status: 'ON_PROCESS',
          reviewedBy: null,
          reviewerRole: null,
          reviewedAt: null,
          denialReason: null,
          cycleId: 'cycle_2026_q2',
          createdAt: Date.now(),
        });
      },
    });

    expect(job.status).toBe('VERIFICATION_FAILED');
    expect(job.status).not.toBe('COMPLETED');
    expect(job.postRestoreVerificationPassed).toBe(false);
    expect(job.integrityReport?.passed).toBe(false);
    expect(job.integrityReport?.criticalCount).toBeGreaterThan(0);
    expect(job.recoveryRecommendation).toContain(job.preRestoreBackupId!);
    expect(engine.isRestoreLockActiveSync()).toBe(false);
  });

  it('detects tampered/corrupted backup files during verification and blocks restore', async () => {
    const bkp = await engine.createSystemBackup({
      kind: 'MANUAL',
      note: 'Will be tampered',
      actorUid: 'uid_super',
      actorEmail: 'spv.xpplay@gmail.com',
      actorRole: 'SUPER_ADMIN',
    });

    // Tamper with members.json inside backup folder
    const membersFile = path.join(backupsRoot, bkp.record.backupId, 'firestore', 'members.json');
    fs.appendFileSync(membersFile, '\n// tampered');

    const verify = await engine.verifySystemBackup({
      backupId: bkp.record.backupId,
      actorUid: 'uid_super',
      actorRole: 'SUPER_ADMIN',
    });
    expect(verify.passed).toBe(false);
    expect(verify.status).toBe('VERIFICATION_FAILED');
    expect(verify.checks.find((c) => c.code === 'FIRESTORE_CHECKSUMS')?.passed).toBe(false);

    // Restore from corrupted backup must be rejected
    await expect(
      engine.executeRestore({
        backupId: bkp.record.backupId,
        confirmationPhrase: RESTORE_CONFIRMATION_PHRASE,
        reason: 'Coba restore dari backup korup',
        actorUid: 'uid_super',
        actorEmail: 'spv.xpplay@gmail.com',
        actorRole: 'SUPER_ADMIN',
      })
    ).rejects.toThrow(/tidak valid|belum berstatus COMPLETED|verifikasi/i);
  });

  it('enforces SUPER_ADMIN-only restore, exact confirmation phrase, schema compatibility, and retention protection', async () => {
    const b1 = await engine.createSystemBackup({
      kind: 'MANUAL',
      note: 'Backup 1',
      actorUid: 'uid_super',
      actorEmail: 'spv.xpplay@gmail.com',
      actorRole: 'SUPER_ADMIN',
    });
    const b2 = await engine.createSystemBackup({
      kind: 'MANUAL',
      note: 'Backup 2 (latest)',
      actorUid: 'uid_super',
      actorEmail: 'spv.xpplay@gmail.com',
      actorRole: 'SUPER_ADMIN',
    });
    const pre1 = await engine.createSystemBackup({
      kind: 'PRE_RESTORE',
      note: 'Latest Pre-Restore',
      actorUid: 'uid_super',
      actorEmail: 'spv.xpplay@gmail.com',
      actorRole: 'SUPER_ADMIN',
    });

    // Non-SUPER_ADMIN cannot execute restore
    await expect(
      engine.executeRestore({
        backupId: b2.record.backupId,
        confirmationPhrase: RESTORE_CONFIRMATION_PHRASE,
        reason: 'Admin biasa mencoba restore',
        actorUid: 'uid_admin',
        actorEmail: 'admin@xpplay.id',
        actorRole: 'ADMIN',
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    // Wrong confirmation phrase rejected
    await expect(
      engine.executeRestore({
        backupId: b2.record.backupId,
        confirmationPhrase: 'restore xp play', // wrong case
        reason: 'Salah ketik konfirmasi',
        actorUid: 'uid_super',
        actorEmail: 'spv.xpplay@gmail.com',
        actorRole: 'SUPER_ADMIN',
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    // Schema compatibility guard
    expect(
      checkBackupSchemaCompatibility({ appVersion: '9.0.0', schemaVersion: 'xpplay-schema-v2' }).compatible
    ).toBe(false);
    expect(
      checkBackupSchemaCompatibility({ appVersion: '2.4.0', schemaVersion: 'xpplay-schema-v99' }).compatible
    ).toBe(false);

    // Retention protection: latest successful regular backup (b2) & latest pre-restore (pre1) CANNOT be deleted
    const all = [b1.record, b2.record, pre1.record];
    expect(canDeleteBackupRecord(b2.record, all, DEFAULT_BACKUP_RETENTION).allowed).toBe(false);
    expect(canDeleteBackupRecord(pre1.record, all, DEFAULT_BACKUP_RETENTION).allowed).toBe(false);
    expect(canDeleteBackupRecord(b1.record, all, DEFAULT_BACKUP_RETENTION).allowed).toBe(true);

    await expect(
      engine.deleteSystemBackup({
        backupId: b2.record.backupId,
        actorUid: 'uid_super',
        actorRole: 'SUPER_ADMIN',
      })
    ).rejects.toThrow(/melindungi backup sukses terakhir/i);

    // Older completed backup b1 CAN be deleted cleanly
    await engine.deleteSystemBackup({
      backupId: b1.record.backupId,
      actorUid: 'uid_super',
      actorRole: 'SUPER_ADMIN',
    });
    expect(fs.existsSync(path.join(backupsRoot, b1.record.backupId))).toBe(false);
  });

  it('runs all 15 Data Integrity Checks accurately on healthy and corrupted datasets', () => {
    const now = Date.UTC(2026, 5, 1);
    const healthyMember: MemberProfile = {
      uid: 'm1',
      memberId: 'XPP-001',
      fullName: 'Player One',
      username: 'player.one',
      whatsapp: '628111111111',
      socialMedia: '',
      birthDate: '2000-05-20',
      birthMonth: 5,
      birthDay: 20,
      memberCategory: 'MAHASISWA',
      status: 'ACTIVE',
      xpProgress: 180,
      xpReward: 60,
      reservedXp: 0,
      currentLevel: 'SILVER',
      levelMode: 'AUTOMATIC',
      currentCycleId: 'c1',
      referredByUid: null,
      referredByUsername: null,
      referralCount: 0,
      lastPlayAt: now,
      lastPlayBranch: 'DEMANG',
      preferredBranch: 'DEMANG',
      createdAt: now - 86400000,
      updatedAt: now,
    };

    const healthyDataset: IntegrityDataset = {
      members: [healthyMember],
      levels: DEFAULT_LEVELS,
      xpProgressLedger: [
        {
          id: 'p1',
          memberId: 'XPP-001',
          memberUid: 'm1',
          amount: 180,
          type: 'PROGRESS',
          direction: 'CREDIT',
          source: 'TRANSACTION',
          referenceId: 'tx1',
          branch: 'DEMANG',
          cycleId: 'c1',
          createdBy: 'admin',
          note: 'Init progress',
          createdAt: now,
        },
      ],
      xpRewardLedger: [
        {
          id: 'r1',
          memberId: 'XPP-001',
          memberUid: 'm1',
          amount: 60,
          type: 'REWARD',
          direction: 'CREDIT',
          source: 'TRANSACTION',
          referenceId: 'tx1',
          branch: 'DEMANG',
          cycleId: 'c1',
          createdBy: 'admin',
          note: 'Init reward',
          createdAt: now,
        },
      ],
      referrals: [],
      claims: [
        {
          id: 'clm1',
          memberId: 'XPP-001',
          memberUid: 'm1',
          memberUsername: 'player.one',
          campaignId: 'camp1',
          campaignTitle: 'Test',
          campaignType: 'CHALLENGE',
          xpRewardSnapshot: 10,
          evidenceUrl: '/api/claims/evidence/m1/ok.png',
          evidencePath: 'claims/m1/ok.png',
          note: '',
          status: 'APPROVED',
          reviewedBy: 'admin',
          reviewerRole: 'SUPER_ADMIN',
          reviewedAt: now,
          denialReason: null,
          cycleId: 'c1',
          createdAt: now,
        },
      ],
      redemptions: [
        {
          id: 'red1',
          memberId: 'XPP-001',
          memberUid: 'm1',
          memberUsername: 'player.one',
          benefitId: 'ben1',
          benefitName: 'Free Hour',
          xpCostSnapshot: 20,
          levelRequirement: 'BRONZE',
          redemptionKind: 'XP_REWARD',
          status: 'APPROVED',
          reviewedBy: 'admin',
          reviewerRole: 'SUPER_ADMIN',
          reviewedAt: now,
          denialReason: null,
          cycleId: 'c1',
          createdAt: now,
        },
      ],
      transactions: [
        {
          id: 'tx1',
          memberId: 'XPP-001',
          memberUid: 'm1',
          memberUsername: 'player.one',
          branch: 'DEMANG',
          amountIdr: 50000,
          xpRateUsed: 10000,
          xpGenerated: 5,
          source: 'TRANSACTION',
          receiptNumber: 'RCP-100',
          note: '',
          adminId: 'admin',
          adminName: 'Super Admin',
          cycleId: 'c1',
          createdAt: now,
        },
      ],
      campaigns: [
        {
          id: 'camp1',
          type: 'CHALLENGE',
          title: 'Test',
          description: '',
          startAt: now,
          endAt: now + 86400000,
          xpReward: 10,
          imageUrl: '',
          terms: '',
          maxClaimsPerMember: 1,
          totalClaimLimit: null,
          claimsCount: 1,
          active: true,
          status: 'ACTIVE',
          requiresEvidence: true,
          createdBy: 'admin',
          createdAt: now,
          updatedAt: now,
        },
      ],
      benefits: [
        {
          id: 'ben1',
          name: 'Free Hour',
          description: '',
          imageUrl: '',
          xpCost: 20,
          levelRequirement: 'BRONZE',
          claimable: true,
          redeemable: true,
          stock: 10,
          expiryAt: null,
          terms: '',
          active: true,
          createdBy: 'admin',
          createdAt: now,
          updatedAt: now,
        },
      ],
      cmsPublished: {
        id: 'homepage',
        content: {
          heroImageUrl: '/api/cms/assets/hero.png',
        } as CmsPublishedDoc['content'],
        versionId: 'v1',
        versionNumber: 1,
        publishedAt: now,
        publishedBy: 'admin',
        publishedByEmail: 'spv.xpplay@gmail.com',
        updatedAt: now,
      },
      benefitRequests: [
        {
          id: 'BRQ-20260601-OK01',
          memberId: 'XPP-001',
          memberUid: 'm1',
          memberUsername: 'player.one',
          memberName: 'Player One',
          memberWhatsapp: '628111111111',
          sourceType: 'GENERAL_BENEFIT',
          sourceId: 'ben1',
          title: 'Free Hour',
          xpCost: 20,
          xpRewardGrant: 0,
          levelRequirement: 'BRONZE',
          evidenceUrl: '',
          evidencePath: '',
          note: '',
          status: 'APPROVED',
          resolution: null,
          holdLedgerId: 'r_hold_ok',
          refundLedgerId: null,
          branch: 'DEMANG',
          approvedAt: now,
          approvedBy: 'admin',
          approvedByRole: 'SUPER_ADMIN',
          deniedAt: null,
          deniedBy: null,
          deniedReason: null,
          expiresAt: now + 7 * 86400000,
          expiredAt: null,
          usedAt: null,
          usedBy: null,
          usedBranch: null,
          receiptReference: null,
          refundedAt: null,
          refundReason: null,
          refundedAmount: 0,
          cycleId: 'c1',
          createdAt: now,
          updatedAt: now,
        },
      ],
      existingStoragePaths: new Set(['claims/m1/ok.png', 'cms/hero.png']),
    };

    const okReport = runDataIntegrityChecks(healthyDataset, {
      auditId: 'int_ok',
      checkedBy: 'uid_super',
      checkedAt: now,
    });
    expect(okReport.passed).toBe(true);
    expect(okReport.totalChecks).toBe(15);
    expect(okReport.passedChecks).toBe(15);
    expect(okReport.criticalCount).toBe(0);

    // Corrupt ALL 15 checks simultaneously and verify every single check catches its fault
    const badDataset: IntegrityDataset = {
      ...healthyDataset,
      members: [
        {
          ...healthyMember,
          birthDate: '2099-12-31', // future birth date (check 15)
          memberCategory: 'INVALID_CAT' as MemberProfile['memberCategory'], // invalid category (check 15)
          xpProgress: -10,
          xpReward: -5,
          reservedXp: 99, // mismatched reservedXp (check 13)
          currentLevel: 'SULTAN', // mismatch in AUTOMATIC mode
          referredByUid: 'm1', // self-referral
        },
        {
          ...healthyMember,
          uid: 'm2',
          memberId: 'XPP-002',
          username: 'player.one', // duplicate username
          whatsapp: '628111111111', // duplicate whatsapp
        },
      ],
      xpProgressLedger: [{ ...healthyDataset.xpProgressLedger[0], memberUid: 'missing_uid' }],
      xpRewardLedger: [
        { ...healthyDataset.xpRewardLedger[0], memberUid: 'missing_uid' },
        // Duplicate hold entries for same referenceId (check 14)
        {
          ...healthyDataset.xpRewardLedger[0],
          id: 'dup_hold_1',
          memberUid: 'm1',
          amount: -20,
          direction: 'DEBIT',
          source: 'BENEFIT_REQUEST_HOLD',
          referenceId: 'BRQ-DUP',
        },
        {
          ...healthyDataset.xpRewardLedger[0],
          id: 'dup_hold_2',
          memberUid: 'm1',
          amount: -20,
          direction: 'DEBIT',
          source: 'BENEFIT_REQUEST_HOLD',
          referenceId: 'BRQ-DUP',
        },
      ],
      referrals: [
        {
          id: 'bad_ref',
          referrerUid: 'm1',
          referrerMemberId: 'XPP-001',
          referrerUsername: 'player.one',
          refereeUid: 'missing_referee',
          refereeMemberId: 'XPP-999',
          refereeUsername: 'ghost',
          referrerXp: 5,
          refereeXp: 5,
          cycleId: 'c1',
          createdAt: now,
        },
      ],
      claims: [{ ...healthyDataset.claims[0], memberUid: 'missing_uid', campaignId: 'missing_camp' }],
      redemptions: [{ ...healthyDataset.redemptions[0], memberUid: 'missing_uid', benefitId: 'missing_ben' }],
      benefitRequests: [
        {
          ...healthyDataset.benefitRequests![0],
          memberUid: 'missing_uid',
          sourceId: 'missing_ben',
        },
      ],
      transactions: [{ ...healthyDataset.transactions[0], memberUid: 'missing_uid', amountIdr: -100 }],
      existingStoragePaths: new Set(), // missing both claim evidence & CMS hero asset
    };

    const badReport = runDataIntegrityChecks(badDataset, {
      auditId: 'int_bad',
      checkedBy: 'uid_super',
      checkedAt: now,
    });
    expect(badReport.passed).toBe(false);
    expect(badReport.totalChecks).toBe(15);
    expect(badReport.passedChecks).toBe(0);
    for (const check of badReport.checks) {
      expect(check.passed).toBe(false);
      expect(check.issueCount).toBeGreaterThan(0);
    }
  });

  it('reports all 9 MODULE 23 System Health components honestly and enforces Firestore security rules invariants', async () => {
    await engine.createSystemBackup({
      kind: 'MANUAL',
      note: 'Health check baseline',
      actorUid: 'uid_super',
      actorEmail: 'spv.xpplay@gmail.com',
      actorRole: 'SUPER_ADMIN',
    });

    const health = await engine.getSystemHealth();
    expect(health.components.length).toBe(9);
    const keys = health.components.map((c) => c.key);
    expect(keys).toEqual([
      'DATABASE',
      'AUTHENTICATION',
      'STORAGE',
      'XP_ENGINE',
      'CMS_CONFIG',
      'BACKUP_SERVICE',
      'RESTORE_LOCK',
      'LAST_BACKUP',
      'LAST_VERIFICATION',
    ]);

    // Static verification of Phase J hardened firestore.rules
    const rulesText = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
    expect(rulesText).toContain('function isSystemRestoreLocked()');
    expect(rulesText).toContain('match /systemBackups/{backupId}');
    expect(rulesText).toContain('match /restoreJobs/{restoreJobId}');
    expect(rulesText).toContain('match /systemOperations/{opId}');
    expect(rulesText).toContain('data.lockedByEmail == null');
    expect(rulesText).toContain('allow update, delete: if false;'); // auditLogs
  });
});
