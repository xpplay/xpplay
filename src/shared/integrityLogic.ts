import {
  DEFAULT_LEVELS,
  normalizeUsername,
  normalizeWhatsapp,
  resolveLevelFromXp,
} from './xpLogic.ts';
import {
  VALID_BENEFIT_REQUEST_STATUSES,
  VALID_MEMBER_CATEGORIES,
  VALID_MEMBER_STATUSES,
  validateBirthDate,
} from './benefitRequestLogic.ts';
import type {
  BenefitItem,
  BenefitRequestRecord,
  CampaignItem,
  ClaimRecord,
  CmsDraftDoc,
  CmsPublishedDoc,
  IntegrityAuditReport,
  IntegrityCheckItem,
  LevelConfig,
  LevelId,
  MemberProfile,
  RedemptionRecord,
  ReferralRecord,
  TransactionRecord,
  XpLedgerEntry,
} from '../types/xpplay.ts';

export interface IntegrityDataset {
  members: MemberProfile[];
  levels: LevelConfig[];
  xpProgressLedger: XpLedgerEntry[];
  xpRewardLedger: XpLedgerEntry[];
  referrals: ReferralRecord[];
  claims: ClaimRecord[];
  redemptions: RedemptionRecord[];
  benefitRequests?: BenefitRequestRecord[];
  transactions: TransactionRecord[];
  campaigns: CampaignItem[];
  benefits: BenefitItem[];
  identityIndex?: { id: string; uid: string; type: 'username' | 'wa' }[];
  cmsPublished?: CmsPublishedDoc | null;
  cmsDraft?: CmsDraftDoc | null;
  /** Set of relative storage paths currently present on disk (e.g. 'claims/uid/file.jpg', 'cms/cms_123.png') */
  existingStoragePaths: Set<string>;
}

const VALID_LEVEL_IDS: Set<LevelId> = new Set(['BRONZE', 'SILVER', 'JURAGAN', 'SULTAN']);

function extractLocalCmsPath(url: string | undefined | null): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  const prefix = '/api/cms/assets/';
  if (trimmed.startsWith(prefix)) {
    const fileName = trimmed.slice(prefix.length).split('?')[0].trim();
    return fileName ? `cms/${fileName}` : null;
  }
  return null;
}

function extractLocalClaimPath(claim: Pick<ClaimRecord, 'evidencePath' | 'evidenceUrl'>): string | null {
  if (claim.evidencePath && claim.evidencePath.trim()) {
    const clean = claim.evidencePath.trim().replace(/^\/+/, '');
    if (clean.startsWith('claims/')) return clean;
  }
  if (claim.evidenceUrl && claim.evidenceUrl.startsWith('/api/claims/evidence/')) {
    const rest = claim.evidenceUrl.slice('/api/claims/evidence/'.length).split('?')[0];
    if (rest) return `claims/${rest}`;
  }
  return null;
}

/**
 * 15-Point Data Integrity Verification Engine.
 * Pure, deterministic, executable both post-restore and on-demand against live datasets.
 */
export function runDataIntegrityChecks(
  dataset: IntegrityDataset,
  meta: { auditId: string; checkedBy: string; checkedAt?: number }
): IntegrityAuditReport {
  const checkedAt = meta.checkedAt ?? Date.now();
  const levels = dataset.levels.length === 4 ? dataset.levels : DEFAULT_LEVELS;
  const benefitRequests = dataset.benefitRequests ?? [];
  const checks: IntegrityCheckItem[] = [];

  const memberByUid = new Map<string, MemberProfile>();
  const validMemberUids = new Set<string>();
  for (const m of dataset.members) {
    memberByUid.set(m.uid, m);
    validMemberUids.add(m.uid);
    if (m.migratedFromUid) {
      validMemberUids.add(m.migratedFromUid);
    }
  }
  const campaignIds = new Set(dataset.campaigns.map((c) => c.id));
  const benefitIds = new Set(dataset.benefits.map((b) => b.id));

  // Pre-aggregate ledger sums per memberUid for currentCycleId when ledger entries exist
  const progSumByUid = new Map<string, number>();
  const progHasEntries = new Set<string>();
  for (const e of dataset.xpProgressLedger) {
    const m = memberByUid.get(e.memberUid);
    if (m && e.cycleId === m.currentCycleId) {
      progHasEntries.add(e.memberUid);
      progSumByUid.set(e.memberUid, (progSumByUid.get(e.memberUid) ?? 0) + Number(e.amount || 0));
    }
  }

  const rewSumByUid = new Map<string, number>();
  const rewHasEntries = new Set<string>();
  for (const e of dataset.xpRewardLedger) {
    rewHasEntries.add(e.memberUid);
    rewSumByUid.set(e.memberUid, (rewSumByUid.get(e.memberUid) ?? 0) + Number(e.amount || 0));
  }

  // 1. XP Progress Consistency
  {
    const issues: string[] = [];
    for (const m of dataset.members) {
      if (!Number.isFinite(m.xpProgress) || !Number.isInteger(m.xpProgress) || m.xpProgress < 0) {
        issues.push(`${m.username}: xpProgress tidak valid (${String(m.xpProgress)})`);
      } else if (progHasEntries.has(m.uid)) {
        const expected = Math.max(0, progSumByUid.get(m.uid) ?? 0);
        if (expected !== m.xpProgress && m.xpProgress < 0) {
          issues.push(`${m.username}: saldo XP Progress inkonsisten`);
        }
      }
    }
    for (const e of dataset.xpProgressLedger) {
      if (!validMemberUids.has(e.memberUid)) {
        issues.push(`Ledger ${e.id}: memberUid ${e.memberUid} tidak ditemukan`);
      } else if (!Number.isFinite(e.amount)) {
        issues.push(`Ledger ${e.id}: nominal XP tidak valid`);
      }
    }
    checks.push({
      code: 'XP_PROGRESS_CONSISTENCY',
      label: '1. Konsistensi XP Progress & Ledger',
      passed: issues.length === 0,
      severity: 'CRITICAL',
      issueCount: issues.length,
      samples: issues.slice(0, 10),
      summary:
        issues.length === 0
          ? `${dataset.members.length} member & ${dataset.xpProgressLedger.length} entri ledger XP Progress valid.`
          : `Ditemukan ${issues.length} inkonsistensi XP Progress.`,
    });
  }

  // 2. XP Reward Consistency
  {
    const issues: string[] = [];
    for (const m of dataset.members) {
      if (!Number.isFinite(m.xpReward) || !Number.isInteger(m.xpReward) || m.xpReward < 0) {
        issues.push(`${m.username}: xpReward tidak valid (${String(m.xpReward)})`);
      }
      const resXp = m.reservedXp ?? 0;
      if (!Number.isFinite(resXp) || !Number.isInteger(resXp) || resXp < 0) {
        issues.push(`${m.username}: reservedXp tidak valid (${String(m.reservedXp)})`);
      }
    }
    for (const e of dataset.xpRewardLedger) {
      if (!validMemberUids.has(e.memberUid)) {
        issues.push(`Reward Ledger ${e.id}: memberUid ${e.memberUid} tidak ditemukan`);
      } else if (!Number.isFinite(e.amount)) {
        issues.push(`Reward Ledger ${e.id}: nominal XP tidak valid`);
      }
    }
    for (const uid of rewHasEntries) {
      const m = memberByUid.get(uid);
      const sum = rewSumByUid.get(uid) ?? 0;
      if (m && sum < 0) {
        issues.push(`${m.username}: total ledger XP Reward negatif (${sum})`);
      }
    }
    checks.push({
      code: 'XP_REWARD_CONSISTENCY',
      label: '2. Konsistensi XP Reward & Ledger',
      passed: issues.length === 0,
      severity: 'CRITICAL',
      issueCount: issues.length,
      samples: issues.slice(0, 10),
      summary:
        issues.length === 0
          ? `${dataset.members.length} member & ${dataset.xpRewardLedger.length} entri ledger XP Reward valid.`
          : `Ditemukan ${issues.length} inkonsistensi XP Reward.`,
    });
  }

  // 3. Level Consistency
  {
    const issues: string[] = [];
    for (const m of dataset.members) {
      if (!VALID_LEVEL_IDS.has(m.currentLevel)) {
        issues.push(`${m.username}: level tidak dikenali (${String(m.currentLevel)})`);
        continue;
      }
      const mode = m.levelMode ?? 'AUTOMATIC';
      if (mode === 'AUTOMATIC') {
        const expected = resolveLevelFromXp(m.xpProgress, levels).current.id;
        if (m.currentLevel !== expected) {
          issues.push(
            `${m.username}: mode AUTOMATIC memiliki level ${m.currentLevel}, seharusnya ${expected} (XP Progress ${m.xpProgress})`
          );
        }
      }
    }
    checks.push({
      code: 'LEVEL_CONSISTENCY',
      label: '3. Konsistensi Level Member',
      passed: issues.length === 0,
      severity: 'CRITICAL',
      issueCount: issues.length,
      samples: issues.slice(0, 10),
      summary:
        issues.length === 0
          ? 'Seluruh level member konsisten dengan mode (AUTOMATIC / MANUAL_OVERRIDE / RESET).'
          : `Ditemukan ${issues.length} ketidakcocokan level member.`,
    });
  }

  // 4. No Negative Balance
  {
    const issues: string[] = [];
    for (const m of dataset.members) {
      if (m.xpProgress < 0) {
        issues.push(`${m.username}: xpProgress negatif (${m.xpProgress})`);
      }
      if (m.xpReward < 0) {
        issues.push(`${m.username}: xpReward negatif (${m.xpReward})`);
      }
      if ((m.reservedXp ?? 0) < 0) {
        issues.push(`${m.username}: reservedXp negatif (${String(m.reservedXp)})`);
      }
    }
    checks.push({
      code: 'NO_NEGATIVE_BALANCE',
      label: '4. Nol Saldo XP Negatif',
      passed: issues.length === 0,
      severity: 'CRITICAL',
      issueCount: issues.length,
      samples: issues.slice(0, 10),
      summary:
        issues.length === 0
          ? 'Tidak ada saldo XP Progress, XP Reward, atau Reserved XP bernilai negatif.'
          : `Ditemukan ${issues.length} saldo negatif.`,
    });
  }

  // 5. No Duplicate Username
  {
    const issues: string[] = [];
    const seen = new Map<string, string>();
    for (const m of dataset.members) {
      if (m.status === 'DELETED') continue;
      const norm = normalizeUsername(m.username);
      if (!norm) {
        if (m.status === 'PRE_REGISTERED' && (m.registrationStage ?? 'PHONE_ONLY') === 'PHONE_ONLY') {
          continue;
        }
        issues.push(`UID ${m.uid}: username kosong`);
        continue;
      }
      if (seen.has(norm)) {
        issues.push(`Username duplikat "@${norm}" pada UID ${seen.get(norm)} & ${m.uid}`);
      } else {
        seen.set(norm, m.uid);
      }
    }
    checks.push({
      code: 'NO_DUPLICATE_USERNAME',
      label: '5. Unikitas Username Member',
      passed: issues.length === 0,
      severity: 'CRITICAL',
      issueCount: issues.length,
      samples: issues.slice(0, 10),
      summary:
        issues.length === 0
          ? `${seen.size} username aktif seluruhnya unik.`
          : `Ditemukan ${issues.length} konflik/duplikat username.`,
    });
  }

  // 6. No Duplicate WhatsApp
  {
    const issues: string[] = [];
    const seen = new Map<string, string>();
    for (const m of dataset.members) {
      if (m.status === 'DELETED') continue;
      const norm = normalizeWhatsapp(m.whatsapp);
      if (!norm) {
        issues.push(`UID ${m.uid}: nomor WhatsApp kosong`);
        continue;
      }
      if (seen.has(norm)) {
        issues.push(`WhatsApp duplikat "${norm}" pada UID ${seen.get(norm)} & ${m.uid}`);
      } else {
        seen.set(norm, m.uid);
      }
    }
    checks.push({
      code: 'NO_DUPLICATE_WHATSAPP',
      label: '6. Unikitas Nomor WhatsApp Member',
      passed: issues.length === 0,
      severity: 'CRITICAL',
      issueCount: issues.length,
      samples: issues.slice(0, 10),
      summary:
        issues.length === 0
          ? `${seen.size} nomor WhatsApp aktif seluruhnya unik.`
          : `Ditemukan ${issues.length} konflik/duplikat WhatsApp.`,
    });
  }

  // 7. Referral Integrity
  {
    const issues: string[] = [];
    for (const m of dataset.members) {
      if (m.referredByUid) {
        if (m.referredByUid === m.uid) {
          issues.push(`${m.username}: self-referral terdeteksi`);
        } else if (!memberByUid.has(m.referredByUid)) {
          issues.push(`${m.username}: referredByUid ${m.referredByUid} tidak ditemukan`);
        }
      }
    }
    for (const ref of dataset.referrals) {
      if (ref.referrerUid === ref.refereeUid) {
        issues.push(`Referral ${ref.id}: self-referral tidak sah`);
      }
      if (!memberByUid.has(ref.referrerUid)) {
        issues.push(`Referral ${ref.id}: referrer ${ref.referrerUid} tidak ditemukan`);
      }
      if (!memberByUid.has(ref.refereeUid)) {
        issues.push(`Referral ${ref.id}: referee ${ref.refereeUid} tidak ditemukan`);
      }
    }
    checks.push({
      code: 'REFERRAL_INTEGRITY',
      label: '7. Integritas Relasi Referral',
      passed: issues.length === 0,
      severity: 'CRITICAL',
      issueCount: issues.length,
      samples: issues.slice(0, 10),
      summary:
        issues.length === 0
          ? `${dataset.referrals.length} relasi referral valid tanpa broken reference.`
          : `Ditemukan ${issues.length} broken referral.`,
    });
  }

  // 8. No Orphan Claims
  {
    const issues: string[] = [];
    for (const c of dataset.claims) {
      if (!memberByUid.has(c.memberUid)) {
        issues.push(`Claim ${c.id}: memberUid ${c.memberUid} tidak ada`);
      }
      if (dataset.campaigns.length > 0 && !campaignIds.has(c.campaignId)) {
        issues.push(`Claim ${c.id}: campaignId ${c.campaignId} tidak ada`);
      }
    }
    checks.push({
      code: 'NO_ORPHAN_CLAIMS',
      label: '8. Validitas Relasi Claims (No Orphan)',
      passed: issues.length === 0,
      severity: 'CRITICAL',
      issueCount: issues.length,
      samples: issues.slice(0, 10),
      summary:
        issues.length === 0
          ? `${dataset.claims.length} dokumen claim terhubung ke member & program valid.`
          : `Ditemukan ${issues.length} orphan claim.`,
    });
  }

  // 9. No Orphan Redemptions
  {
    const issues: string[] = [];
    for (const r of dataset.redemptions) {
      if (!memberByUid.has(r.memberUid)) {
        issues.push(`Redemption ${r.id}: memberUid ${r.memberUid} tidak ada`);
      }
      if (dataset.benefits.length > 0 && !benefitIds.has(r.benefitId)) {
        issues.push(`Redemption ${r.id}: benefitId ${r.benefitId} tidak ada`);
      }
    }
    checks.push({
      code: 'NO_ORPHAN_REDEMPTIONS',
      label: '9. Validitas Relasi Redemptions (No Orphan)',
      passed: issues.length === 0,
      severity: 'CRITICAL',
      issueCount: issues.length,
      samples: issues.slice(0, 10),
      summary:
        issues.length === 0
          ? `${dataset.redemptions.length} dokumen redemption terhubung ke member & benefit valid.`
          : `Ditemukan ${issues.length} orphan redemption.`,
    });
  }

  // 10. Transaction Integrity
  {
    const issues: string[] = [];
    for (const t of dataset.transactions) {
      if (!validMemberUids.has(t.memberUid)) {
        issues.push(`Transaksi ${t.id}: memberUid ${t.memberUid} tidak ditemukan`);
      }
      if (t.branch !== 'DEMANG' && t.branch !== 'SEKIP') {
        issues.push(`Transaksi ${t.id}: cabang tidak valid (${String(t.branch)})`);
      }
      if (!Number.isFinite(t.amountIdr) || t.amountIdr <= 0) {
        issues.push(`Transaksi ${t.id}: amountIdr tidak valid (${String(t.amountIdr)})`);
      }
      if (!Number.isFinite(t.xpGenerated) || t.xpGenerated < 0) {
        issues.push(`Transaksi ${t.id}: xpGenerated negatif (${String(t.xpGenerated)})`);
      }
    }
    checks.push({
      code: 'TRANSACTION_INTEGRITY',
      label: '10. Integritas Data Transaksi',
      passed: issues.length === 0,
      severity: 'CRITICAL',
      issueCount: issues.length,
      samples: issues.slice(0, 10),
      summary:
        issues.length === 0
          ? `${dataset.transactions.length} transaksi valid dan terhubung ke member aktif.`
          : `Ditemukan ${issues.length} transaksi bermasalah.`,
    });
  }

  // 11. Storage Object Integrity (Claim & BenefitRequest Evidence)
  {
    const issues: string[] = [];
    for (const c of dataset.claims) {
      const localPath = extractLocalClaimPath(c);
      if (localPath && !dataset.existingStoragePaths.has(localPath)) {
        issues.push(`Claim ${c.id}: file bukti "${localPath}" tidak ditemukan di storage`);
      }
    }
    for (const br of benefitRequests) {
      const localPath = extractLocalClaimPath(br);
      if (localPath && !dataset.existingStoragePaths.has(localPath)) {
        issues.push(`BenefitRequest ${br.id}: file bukti "${localPath}" tidak ditemukan di storage`);
      }
    }
    checks.push({
      code: 'STORAGE_OBJECT_INTEGRITY',
      label: '11. Keberadaan File Storage (Bukti Claim & Benefit)',
      passed: issues.length === 0,
      severity: 'CRITICAL',
      issueCount: issues.length,
      samples: issues.slice(0, 10),
      summary:
        issues.length === 0
          ? 'Seluruh referensi file bukti claim & benefit request tersedia di storage.'
          : `Ditemukan ${issues.length} referensi file bukti hilang di storage.`,
    });
  }

  // 12. CMS Asset Reference Integrity
  {
    const issues: string[] = [];
    const inspectCms = (label: string, content: CmsPublishedDoc['content'] | undefined) => {
      if (!content) return;
      const fields: [string, string | undefined][] = [
        ['logoUrl', content.logoUrl],
        ['faviconUrl', content.faviconUrl],
        ['heroImageUrl', content.heroImageUrl],
        ['bannerImageUrl', content.bannerImageUrl],
        ['aboutImageUrl', content.aboutImageUrl],
      ];
      for (const [key, val] of fields) {
        const localPath = extractLocalCmsPath(val);
        if (localPath && !dataset.existingStoragePaths.has(localPath)) {
          issues.push(`${label}.${key}: aset "${localPath}" tidak ditemukan di storage`);
        }
      }
    };
    inspectCms('cmsPublished', dataset.cmsPublished?.content);
    inspectCms('cmsDraft', dataset.cmsDraft?.content);

    checks.push({
      code: 'CMS_ASSET_INTEGRITY',
      label: '12. Integritas Referensi Aset CMS Homepage',
      passed: issues.length === 0,
      severity: 'CRITICAL',
      issueCount: issues.length,
      samples: issues.slice(0, 10),
      summary:
        issues.length === 0
          ? 'Seluruh aset gambar lokal CMS Homepage valid dan tersedia.'
          : `Ditemukan ${issues.length} referensi aset CMS yang rusak/hilang.`,
    });
  }

  // 13. No Orphan Benefit Requests & Reserved XP Consistency
  {
    const issues: string[] = [];
    const expectedReservedByUid = new Map<string, number>();

    for (const br of benefitRequests) {
      if (!validMemberUids.has(br.memberUid)) {
        issues.push(`BenefitRequest ${br.id}: memberUid ${br.memberUid} tidak ada`);
      }
      if (!VALID_BENEFIT_REQUEST_STATUSES.has(br.status)) {
        issues.push(`BenefitRequest ${br.id}: status tidak valid (${String(br.status)})`);
      }
      if (br.sourceType === 'CHALLENGE' || br.sourceType === 'EVENT' || br.sourceType === 'PROMO') {
        if (dataset.campaigns.length > 0 && !campaignIds.has(br.sourceId)) {
          issues.push(`BenefitRequest ${br.id}: campaign sourceId ${br.sourceId} tidak ada`);
        }
      } else if (dataset.benefits.length > 0 && !benefitIds.has(br.sourceId)) {
        issues.push(`BenefitRequest ${br.id}: benefit sourceId ${br.sourceId} tidak ada`);
      }
      if (br.status === 'ON_PROCESS' && br.xpCost > 0) {
        expectedReservedByUid.set(
          br.memberUid,
          (expectedReservedByUid.get(br.memberUid) ?? 0) + br.xpCost
        );
      }
    }

    for (const m of dataset.members) {
      const expected = expectedReservedByUid.get(m.uid) ?? 0;
      const actual = m.reservedXp ?? 0;
      if (benefitRequests.length > 0 && actual !== expected) {
        issues.push(
          `${m.username}: reservedXp (${actual}) tidak sesuai total ON_PROCESS hold (${expected})`
        );
      }
    }

    checks.push({
      code: 'NO_ORPHAN_BENEFIT_REQUESTS',
      label: '13. Validitas Benefit Request & Reserved XP',
      passed: issues.length === 0,
      severity: 'CRITICAL',
      issueCount: issues.length,
      samples: issues.slice(0, 10),
      summary:
        issues.length === 0
          ? `${benefitRequests.length} dokumen Benefit Request & saldo Reserved XP seluruhnya konsisten.`
          : `Ditemukan ${issues.length} masalah pada Benefit Request / Reserved XP.`,
    });
  }

  // 14. No Duplicate XP Hold Deduction, Duplicate Refund, or Duplicate Registration Bonus
  {
    const issues: string[] = [];
    const holdCountByRef = new Map<string, number>();
    const refundCountByRef = new Map<string, number>();
    const regBonusCountByMember = new Map<string, number>();

    for (const e of dataset.xpRewardLedger) {
      if (e.source === 'BENEFIT_REQUEST_HOLD') {
        const next = (holdCountByRef.get(e.referenceId) ?? 0) + 1;
        holdCountByRef.set(e.referenceId, next);
        if (next > 1) {
          issues.push(`Double hold terdeteksi pada referenceId ${e.referenceId} (${next} entri)`);
        }
      } else if (e.source === 'DENIED_REFUND' || e.source === 'EXPIRY_REFUND') {
        const next = (refundCountByRef.get(e.referenceId) ?? 0) + 1;
        refundCountByRef.set(e.referenceId, next);
        if (next > 1) {
          issues.push(`Double refund terdeteksi pada referenceId ${e.referenceId} (${next} entri)`);
        }
      } else if (e.source === 'REGISTRATION_BONUS' || e.source === 'REGISTRATION') {
        const key = e.memberId || e.memberUid;
        const next = (regBonusCountByMember.get(key) ?? 0) + 1;
        regBonusCountByMember.set(key, next);
        if (next > 1) {
          issues.push(`Double Registration Bonus terdeteksi pada member ${key} (${next} entri)`);
        }
        const m = memberByUid.get(e.memberUid);
        if (m && m.status === 'PRE_REGISTERED') {
          issues.push(`Member PRE_REGISTERED ${m.memberId} menerima Registration Bonus sebelum selesai`);
        }
      }
    }

    const progRegBonusCountByMember = new Map<string, number>();
    for (const e of dataset.xpProgressLedger) {
      if (e.source === 'REGISTRATION_BONUS' || e.source === 'REGISTRATION') {
        const key = e.memberId || e.memberUid;
        const next = (progRegBonusCountByMember.get(key) ?? 0) + 1;
        progRegBonusCountByMember.set(key, next);
        if (next > 1) {
          issues.push(`Double Registration Bonus (XP Progress) terdeteksi pada member ${key} (${next} entri)`);
        }
        const m = memberByUid.get(e.memberUid);
        if (m && m.status === 'PRE_REGISTERED') {
          issues.push(`Member PRE_REGISTERED ${m.memberId} menerima Registration Bonus (XP Progress) sebelum selesai`);
        }
      }
    }

    checks.push({
      code: 'NO_DUPLICATE_DEDUCTION_OR_REFUND',
      label: '14. Proteksi Double Deduction, Double Refund & Double Registration Bonus',
      passed: issues.length === 0,
      severity: 'CRITICAL',
      issueCount: issues.length,
      samples: issues.slice(0, 10),
      summary:
        issues.length === 0
          ? 'Tidak ada potongan hold ganda, refund ganda, atau bonus registrasi ganda.'
          : `Ditemukan ${issues.length} duplikasi hold/refund/bonus.`,
    });
  }

  // 15. Valid Member Status, Birth Date & Category
  {
    const issues: string[] = [];
    for (const m of dataset.members) {
      if (!VALID_MEMBER_STATUSES.has(m.status)) {
        issues.push(`${m.username}: status akun tidak valid (${String(m.status)})`);
      }
      if (m.memberCategory !== undefined && m.memberCategory !== null && !VALID_MEMBER_CATEGORIES.has(m.memberCategory)) {
        issues.push(`${m.username}: kategori status member tidak valid (${String(m.memberCategory)})`);
      }
      if (m.birthDate) {
        const bCheck = validateBirthDate(m.birthDate, checkedAt);
        if (!bCheck.valid) {
          issues.push(`${m.username}: tanggal lahir tidak valid (${m.birthDate})`);
        }
      }
    }
    checks.push({
      code: 'VALID_MEMBER_STATUS_AND_PROFILE',
      label: '15. Validitas Status, Tanggal Lahir & Kategori Member',
      passed: issues.length === 0,
      severity: 'CRITICAL',
      issueCount: issues.length,
      samples: issues.slice(0, 10),
      summary:
        issues.length === 0
          ? `${dataset.members.length} profil member memiliki status akun, tanggal lahir, dan kategori valid.`
          : `Ditemukan ${issues.length} profil member dengan status/tanggal lahir/kategori tidak valid.`,
    });
  }

  const passedChecks = checks.filter((c) => c.passed).length;
  const criticalCount = checks
    .filter((c) => !c.passed && c.severity === 'CRITICAL')
    .reduce((acc, c) => acc + c.issueCount, 0);
  const warningCount = checks
    .filter((c) => !c.passed && c.severity === 'WARNING')
    .reduce((acc, c) => acc + c.issueCount, 0);

  return {
    auditId: meta.auditId,
    checkedAt,
    checkedBy: meta.checkedBy,
    passed: criticalCount === 0,
    totalChecks: checks.length,
    passedChecks,
    criticalCount,
    warningCount,
    checks,
  };
}
