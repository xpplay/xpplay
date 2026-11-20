export type BranchId = 'DEMANG' | 'SEKIP';

export type MemberStatus = 'PRE_REGISTERED' | 'ACTIVE' | 'SUSPENDED' | 'INACTIVE' | 'DELETED';

export type RegistrationStage = 'PHONE_ONLY' | 'COMPLETED';

export type MemberCategory = 'MAHASISWA' | 'PELAJAR' | 'PEKERJA' | 'LAINNYA';

export type AdminRole = 'SUPER_ADMIN' | 'ADMIN' | 'CASHIER' | 'STAFF';

export type RolePermissionKey =
  | 'MEMBER_DASHBOARD'
  | 'PRE_REGISTER_CUSTOMER'
  | 'VIEW_MEMBERS_BRANCH'
  | 'VIEW_MEMBERS_ALL'
  | 'TRANSACTION_INPUT'
  | 'XP_PROGRESS_ADJUSTMENT'
  | 'XP_REWARD_ADJUSTMENT'
  | 'LEVEL_OVERRIDE'
  | 'PASSWORD_RESET_MEMBER'
  | 'BENEFIT_REQUEST_ASSIST'
  | 'BENEFIT_REQUEST_PROCESS'
  | 'BENEFIT_CRUD'
  | 'CHALLENGE_CRUD'
  | 'EVENT_CRUD'
  | 'PROMO_CRUD'
  | 'NOTIFICATIONS_MANAGE'
  | 'CMS_EDIT'
  | 'CMS_PUBLISH'
  | 'BACKUP_EXECUTE'
  | 'RESTORE_EXECUTE'
  | 'ADMIN_MANAGEMENT'
  | 'CASHIER_MANAGEMENT'
  | 'SYSTEM_SETTINGS'
  | 'RESET_CYCLE'
  | 'AUDIT_LOG_VIEW'
  | 'MEMBER_STATUS_MANAGE';

export type LevelId = 'BRONZE' | 'SILVER' | 'JURAGAN' | 'SULTAN';

export type ClaimStatus = 'ON_PROCESS' | 'APPROVED' | 'DENIED';

export type RedemptionStatus = 'ON_PROCESS' | 'APPROVED' | 'DENIED';

export type BenefitRequestSourceType =
  | 'CHALLENGE'
  | 'EVENT'
  | 'PROMO'
  | 'GENERAL_BENEFIT'
  | 'LEVEL_BENEFIT';

export type BenefitRequestStatus =
  | 'ON_PROCESS'
  | 'APPROVED'
  | 'DENIED'
  | 'USED'
  | 'EXPIRED'
  | 'REFUNDED';

export type CampaignType = 'CHALLENGE' | 'EVENT' | 'PROMO';

export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'EXPIRED' | 'DISABLED';

export type NotificationStatus = 'DRAFT' | 'ACTIVE' | 'EXPIRED';

export type NotificationTargetType =
  | 'ALL_MEMBERS'
  | 'SPECIFIC_MEMBER'
  | 'LEVEL'
  | 'BRANCH'
  | 'INACTIVE_MEMBERS'
  | 'ADMIN_ALERT';

export type XpLedgerSource =
  | 'REGISTRATION'
  | 'REGISTRATION_BONUS'
  | 'REFERRAL'
  | 'TRANSACTION'
  | 'CHALLENGE'
  | 'EVENT'
  | 'PROMO'
  | 'LEVEL_BONUS'
  | 'ADMIN_ADD'
  | 'ADMIN_ADJUSTMENT'
  | 'XP_REWARD_ADMIN_ADJUSTMENT'
  | 'BENEFIT_REQUEST_HOLD'
  | 'REDEMPTION'
  | 'ADMIN_DEDUCT'
  | 'TRANSACTION_REVERSAL'
  | 'DENIED_REFUND'
  | 'EXPIRY_REFUND'
  | 'ADMIN_REFUND'
  | 'REVERSAL_REFUND'
  | 'RESET';

export type XpAdjustmentKind = 'PROGRESS' | 'REWARD';

export type LevelMode = 'AUTOMATIC' | 'MANUAL_OVERRIDE' | 'RESET';

export type LevelOverrideAction = 'MANUAL_OVERRIDE' | 'RECALCULATE';

export interface BranchInfo {
  id: BranchId;
  name: string;
  subtitle: string;
  whatsapp: string;
  mapsUrl: string;
  active: boolean;
}

export interface LevelConfig {
  id: LevelId;
  name: string;
  rank: number;
  minXp: number;
  colorHex: string;
  description: string;
}

export interface SystemSettings {
  id: string;
  transactionXpRate: number; // default 2000 (Rp2.000 = 1 XP)
  registrationBonusXp: number; // default 10
  referralBonusXp: number; // default 5 (to both referrer and referee)
  refundOnExpiry?: boolean; // default false: expired approved benefit does not auto-refund unless enabled
  currentCycleId: string;
  resetEnabled: boolean;
  resetInterval: number;
  resetUnit: 'DAYS' | 'MONTHS';
  nextResetAt: number | null;
  resetXpProgress: boolean;
  resetLevel: boolean;
  resetXpReward: boolean;
  updatedAt: number;
  updatedBy: string;
}

export interface MemberProfile {
  uid: string;
  memberId: string;
  fullName: string;
  username: string;
  whatsapp: string;
  socialMedia: string;
  birthDate?: string | null; // YYYY-MM-DD (Asia/Jakarta calendar)
  birthMonth?: number | null; // 1..12 ready for birthday campaigns
  birthDay?: number | null; // 1..31 ready for birthday campaigns
  memberCategory?: MemberCategory | null; // Status Member: MAHASISWA / PELAJAR / PEKERJA / LAINNYA
  status: MemberStatus; // Account status: PRE_REGISTERED / ACTIVE / INACTIVE / SUSPENDED / DELETED
  registrationStatus?: MemberStatus; // Explicit compatibility alias mirroring status
  registrationStage?: RegistrationStage; // PHONE_ONLY (Stage 1) -> COMPLETED (Stage 2)
  phone?: string; // Compatibility alias for normalized WhatsApp
  normalizedPhone?: string; // Canonical 628... WhatsApp format
  branchId?: BranchId | null; // Branch where member was pre-registered / primarily registered
  preRegisteredAt?: number | null;
  preRegisteredBy?: string | null;
  preRegisteredByRole?: AdminRole | null;
  preRegistrationNotes?: string | null;
  registrationCompletedAt?: number | null;
  verifiedPhoneAt?: number | null;
  registrationBonusGranted?: boolean;
  authUid?: string | null;
  migratedFromUid?: string | null;
  mergedIntoUid?: string | null;
  xpProgress: number;
  xpReward: number; // Available XP Reward balance
  reservedXp?: number; // XP Reward currently held for ON_PROCESS benefit requests
  currentLevel: LevelId;
  levelMode?: LevelMode;
  currentCycleId: string;
  referredByUid: string | null;
  referredByUsername: string | null;
  referralCount: number;
  lastPlayAt: number | null;
  lastPlayBranch: BranchId | null;
  preferredBranch: BranchId | null;
  createdAt: number;
  updatedAt: number;
}

export interface AdminUser {
  uid: string;
  email: string;
  fullName: string;
  role: AdminRole;
  branchScope: BranchId | 'ALL';
  branchId?: BranchId | null;
  cashierCode?: string | null;
  permissions: {
    manageMembers: boolean;
    preRegisterCustomer?: boolean;
    inputTransactions: boolean;
    reviewClaims: boolean;
    reviewRedemptions: boolean;
    manageCampaigns: boolean;
    manageBenefits: boolean;
    manageNotifications: boolean;
    manageSettings: boolean;
    manageAdmins: boolean;
    manageCashiers?: boolean;
    manageCms?: boolean;
    manageBackupRestore?: boolean;
    adjustXp?: boolean;
    overrideLevel?: boolean;
    resetMemberPassword?: boolean;
    executeReset: boolean;
  };
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AdminInviteRecord {
  email: string; // lowercase normalized email, also serves as doc ID in adminInvites
  fullName: string;
  role: AdminRole;
  branchScope: BranchId | 'ALL';
  branchId: BranchId | null;
  cashierCode: string | null;
  status: 'PENDING' | 'CLAIMED';
  active: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  claimedByUid: string | null;
  claimedAt: number | null;
}

export interface XpLedgerEntry {
  id: string;
  memberId: string;
  memberUid: string;
  memberUsername?: string;
  amount: number;
  beforeBalance?: number;
  afterBalance?: number;
  type: 'PROGRESS' | 'REWARD';
  direction: 'CREDIT' | 'DEBIT';
  source: XpLedgerSource;
  referenceId: string;
  branch: BranchId | null;
  cycleId: string;
  createdAt: number;
  createdBy: string;
  note: string;
}

export interface BenefitRequestRecord {
  id: string;
  memberId: string;
  memberUid: string;
  memberUsername: string;
  memberName: string;
  memberWhatsapp: string;
  sourceType: BenefitRequestSourceType;
  sourceId: string;
  title: string;
  xpCost: number;
  xpRewardGrant: number;
  levelRequirement: LevelId;
  evidenceUrl: string;
  evidencePath: string;
  note: string;
  status: BenefitRequestStatus;
  resolution: 'DENIED' | 'EXPIRED' | null;
  holdLedgerId: string | null;
  refundLedgerId: string | null;
  branch: BranchId | null;
  approvedAt: number | null;
  approvedBy: string | null;
  approvedByRole: AdminRole | null;
  deniedAt: number | null;
  deniedBy: string | null;
  deniedReason: string | null;
  expiresAt: number | null;
  expiredAt: number | null;
  usedAt: number | null;
  usedBy: string | null;
  usedBranch: BranchId | null;
  receiptReference: string | null;
  refundedAt: number | null;
  refundReason: string | null;
  refundedAmount: number;
  cycleId: string;
  createdAt: number;
  updatedAt: number;
}

export interface TransactionRecord {
  id: string;
  memberId: string;
  memberUid: string;
  memberUsername: string;
  branch: BranchId;
  amountIdr: number;
  xpRateUsed: number;
  xpGenerated: number;
  source: 'TRANSACTION';
  receiptNumber: string;
  note: string;
  adminId: string;
  adminName: string;
  cycleId: string;
  createdAt: number;
}

export interface ReferralRecord {
  id: string;
  referrerUid: string;
  referrerMemberId: string;
  referrerUsername: string;
  refereeUid: string;
  refereeMemberId: string;
  refereeUsername: string;
  referrerXp: number;
  refereeXp: number;
  cycleId: string;
  createdAt: number;
}

export interface LevelHistoryRecord {
  id: string;
  memberId: string;
  memberUid: string;
  fromLevel: LevelId;
  toLevel: LevelId;
  xpProgressAtEvent: number;
  source: string;
  cycleId: string;
  createdAt: number;
}

export interface XpAdjustmentRecord {
  id: string;
  operationId: string;
  kind: XpAdjustmentKind;
  memberId: string;
  memberUid: string;
  memberUsername: string;
  adjustment: number;
  beforeBalance: number;
  afterBalance: number;
  beforeXpProgress: number;
  afterXpProgress: number;
  beforeXpReward: number;
  afterXpReward: number;
  levelBefore: LevelId;
  levelAfter: LevelId;
  reason: string;
  reference: string;
  auditId: string;
  adminId: string;
  adminEmail: string;
  adminRole: AdminRole;
  cycleId: string;
  timestamp: number;
}

export interface LevelOverrideRecord {
  id: string;
  operationId: string;
  action: LevelOverrideAction;
  memberId: string;
  memberUid: string;
  memberUsername: string;
  xpProgressSnapshot: number;
  previousLevel: LevelId;
  newLevel: LevelId;
  previousLevelMode: LevelMode;
  newLevelMode: 'AUTOMATIC' | 'MANUAL_OVERRIDE';
  reason: string;
  reference: string;
  auditId: string;
  adminId: string;
  adminEmail: string;
  adminRole: AdminRole;
  cycleId: string;
  timestamp: number;
}

export interface BenefitItem {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  xpCost: number;
  levelRequirement: LevelId;
  claimable: boolean;
  redeemable: boolean;
  stock: number | null;
  expiryAt: number | null;
  terms: string;
  active: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface CampaignItem {
  id: string;
  type: CampaignType;
  title: string;
  description: string;
  startAt: number;
  endAt: number;
  xpReward: number;
  imageUrl: string;
  terms: string;
  maxClaimsPerMember: number;
  totalClaimLimit: number | null;
  claimsCount: number;
  active: boolean;
  status: CampaignStatus;
  requiresEvidence: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface ClaimRecord {
  id: string;
  memberId: string;
  memberUid: string;
  memberUsername: string;
  campaignId: string;
  campaignTitle: string;
  campaignType: CampaignType;
  xpRewardSnapshot: number;
  evidenceUrl: string;
  evidencePath: string;
  note: string;
  status: ClaimStatus;
  reviewedBy: string | null;
  reviewerRole: AdminRole | null;
  reviewedAt: number | null;
  denialReason: string | null;
  cycleId: string;
  createdAt: number;
}

export interface RedemptionRecord {
  id: string;
  memberId: string;
  memberUid: string;
  memberUsername: string;
  benefitId: string;
  benefitName: string;
  xpCostSnapshot: number;
  levelRequirement: LevelId;
  redemptionKind: 'XP_REWARD' | 'LEVEL_BENEFIT';
  status: RedemptionStatus;
  reviewedBy: string | null;
  reviewerRole: AdminRole | null;
  reviewedAt: number | null;
  denialReason: string | null;
  cycleId: string;
  createdAt: number;
}

export interface NotificationCampaign {
  id: string;
  title: string;
  message: string;
  targetType: NotificationTargetType;
  targetFilter: string;
  inactivityDays: number | null;
  category?: 'CAMPAIGN' | 'NEW_MEMBER_REGISTERED' | 'NEW_PRE_REGISTERED';
  memberUid?: string | null;
  memberUsername?: string | null;
  memberName?: string | null;
  referralUsername?: string | null;
  startAt: number;
  endAt: number | null;
  active: boolean;
  status: NotificationStatus;
  createdBy: string;
  createdAt: number;
}

export interface MemberNotification {
  id: string;
  memberId: string;
  memberUid: string;
  notificationCampaignId: string | null;
  category: 'SYSTEM' | 'LEVEL_UP' | 'CLAIM' | 'REDEMPTION' | 'BENEFIT_REQUEST' | 'PROMO' | 'INACTIVITY' | 'RESET';
  title: string;
  message: string;
  read: boolean;
  readAt: number | null;
  status: 'SENT' | 'READ';
  sentAt: number;
  createdAt: number;
}

export interface MembershipCycle {
  id: string;
  name: string;
  startedAt: number;
  endedAt: number | null;
  status: 'ACTIVE' | 'CLOSED';
  resetCount: number;
  createdBy: string;
}

export interface CycleSnapshot {
  id: string;
  memberId: string;
  memberUid: string;
  memberUsername: string;
  cycleId: string;
  nextCycleId: string;
  previousXpProgress: number;
  previousXpReward: number;
  previousLevel: LevelId;
  newXpProgress: number;
  newXpReward: number;
  newLevel: LevelId;
  resetAt: number;
  resetReason: string;
  executedBy: string;
}

export interface AuditLogRecord {
  id: string;
  actorId: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  timestamp: number;
}

export interface CmsFaqItem {
  id: string;
  question: string;
  answer: string;
}

export interface HomepageCmsContent {
  brandName: string;
  storeName: string;
  logoUrl: string;
  faviconUrl: string;
  headerTagline: string;
  headerCtaText: string;
  heroTitle: string;
  heroSubtitle: string;
  heroDescription: string;
  heroImageUrl: string;
  bannerEnabled: boolean;
  bannerTitle: string;
  bannerText: string;
  bannerImageUrl: string;
  ctaPrimaryText: string;
  ctaPrimaryUrl: string;
  ctaSecondaryText: string;
  ctaSecondaryUrl: string;
  promoBannerEnabled: boolean;
  promoBannerTitle: string;
  promoBannerText: string;
  promoBannerCtaText: string;
  promoBannerCtaUrl: string;
  announcementEnabled: boolean;
  announcementText: string;
  aboutTitle: string;
  aboutDescription: string;
  aboutImageUrl: string;
  mechanicsTitle: string;
  mechanicsSubtitle: string;
  levelsSectionTitle: string;
  levelsSectionSubtitle: string;
  branchesSectionTitle: string;
  faqEnabled: boolean;
  faqTitle: string;
  faqItems: CmsFaqItem[];
  contactTitle: string;
  contactDescription: string;
  address: string;
  whatsapp: string;
  mapsUrl: string;
  operatingHours: string;
  instagramUrl: string;
  tiktokUrl: string;
  facebookUrl: string;
  youtubeUrl: string;
  footerText: string;
  footerCopyright: string;
}

export interface CmsDraftDoc {
  id: 'homepage';
  content: HomepageCmsContent;
  updatedAt: number;
  updatedBy: string;
  updatedByEmail: string;
  basePublishedVersionId: string | null;
}

export interface CmsPublishedDoc {
  id: 'homepage';
  content: HomepageCmsContent;
  versionId: string;
  versionNumber: number;
  publishedAt: number;
  publishedBy: string;
  publishedByEmail: string;
  updatedAt: number;
}

export interface CmsVersionRecord {
  versionId: string;
  versionNumber: number;
  content: HomepageCmsContent;
  createdBy: string;
  createdAt: number;
  publishedBy: string;
  publishedByEmail: string;
  publishedAt: number;
  sourceAction: 'PUBLISH' | 'ROLLBACK';
  restoredFromVersionId: string | null;
  note: string;
}

// ---------- PHASE D: Admin Password Management ----------
export interface AdminPasswordChangeResult {
  operationId: string;
  auditId: string;
  memberUid: string;
  memberId: string;
  memberUsername: string;
  sessionsRevoked: boolean;
  timestamp: number;
}

// ---------- PHASE E: Inactive Member Management ----------
export type InactivePeriodPreset = 7 | 14 | 30 | 60 | 90 | 180 | 365 | 'CUSTOM';

export interface InactiveMemberRow {
  member: MemberProfile;
  daysInactive: number;
  baselineTimestamp: number;
  neverPlayed: boolean;
}

// ---------- PHASES F, G, H, I, K: Backup, Verification, Restore, Lock, Integrity & Health ----------
export type BackupJobStatus =
  | 'REQUESTED'
  | 'PREPARING'
  | 'RUNNING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'VERIFICATION_FAILED'
  | 'FAILED'
  | 'CANCELLED';

export type BackupKind = 'MANUAL' | 'SCHEDULED' | 'PRE_RESTORE';

export type BackupScopeType =
  | 'FULL_SYSTEM_BACKUP'
  | 'FIRESTORE_AND_STORAGE_BACKUP';

export interface BackupCollectionSummary {
  collection: string;
  documentCount: number;
  byteSize: number;
  checksumSha256: string;
}

export interface StorageBackupFileEntry {
  relativePath: string;
  bucketGroup: 'claims' | 'cms';
  byteSize: number;
  checksumSha256: string;
  modifiedAt: number;
}

export interface AuthUserMetadataEntry {
  uid: string;
  email: string | null;
  displayName: string | null;
  disabled: boolean;
  emailVerified: boolean;
  providers: string[];
  roleHint: 'ADMIN' | 'MEMBER' | 'BOTH' | 'UNKNOWN';
  createdAt: string | null;
  lastSignInAt: string | null;
}

export interface BackupManifest {
  backupId: string;
  operationId: string;
  kind: BackupKind;
  scopeType: BackupScopeType;
  scopeDescription: string;
  authExportMode: 'FIREBASE_ADMIN_SDK' | 'FIRESTORE_DERIVED_METADATA_ONLY';
  authLimitationNotice: string;
  appVersion: string;
  schemaVersion: string;
  createdAt: number;
  createdBy: string;
  createdByEmail: string;
  createdByRole: AdminRole;
  projectId: string;
  firestoreDatabaseId: string;
  firestoreCollections: BackupCollectionSummary[];
  totalDocuments: number;
  authUserCount: number;
  authChecksumSha256: string;
  storageFiles: StorageBackupFileEntry[];
  storageFileCount: number;
  storageTotalBytes: number;
  storageManifestChecksumSha256: string;
  totalBackupBytes: number;
  manifestChecksumSha256: string;
}

export interface BackupVerificationCheck {
  code: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface BackupVerificationResult {
  backupId: string;
  verifiedAt: number;
  verifiedBy: string;
  passed: boolean;
  status: 'VERIFIED' | 'VERIFICATION_FAILED';
  checks: BackupVerificationCheck[];
}

export interface SystemBackupRecord {
  backupId: string;
  operationId: string;
  kind: BackupKind;
  scopeType: BackupScopeType;
  status: BackupJobStatus;
  appVersion: string;
  schemaVersion: string;
  createdAt: number;
  completedAt: number | null;
  durationMs: number | null;
  createdBy: string;
  createdByEmail: string;
  createdByRole: AdminRole;
  note: string;
  totalDocuments: number;
  authUserCount: number;
  storageFileCount: number;
  totalBackupBytes: number;
  storagePath: string;
  manifestChecksumSha256: string;
  verified: boolean;
  verifiedAt: number | null;
  verificationStatus: 'PENDING' | 'VERIFIED' | 'VERIFICATION_FAILED';
  verificationSummary: string;
  errorMessage: string | null;
  protectedFromRetention: boolean;
}

export interface BackupRetentionConfig {
  id: 'backupRetention';
  dailyRetentionCount: number;
  weeklyRetentionCount: number;
  monthlyRetentionCount: number;
  customMaxAgeDays: number;
  alwaysKeepLatestSuccessful: boolean;
  alwaysKeepLatestPreRestore: boolean;
  updatedAt: number;
  updatedBy: string;
}

export interface RestoreLockState {
  id: 'restoreLock';
  locked: boolean;
  state: 'IDLE' | 'RESTORE_IN_PROGRESS';
  restoreJobId: string | null;
  backupId: string | null;
  lockedBy: string | null;
  lockedByEmail: string | null;
  lockedAt: number | null;
  updatedAt: number;
  message: string;
}

export interface BackupLockState {
  id: 'backupLock';
  locked: boolean;
  operationId: string | null;
  backupId: string | null;
  lockedBy: string | null;
  lockedAt: number | null;
  updatedAt: number;
}

export type RestoreJobStatus =
  | 'VALIDATING'
  | 'LOCKING'
  | 'PRE_RESTORE_BACKUP'
  | 'RESTORING_FIRESTORE'
  | 'RESTORING_STORAGE'
  | 'RESTORING_AUTH_METADATA'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'VERIFICATION_FAILED'
  | 'FAILED'
  | 'CANCELLED';

export interface RestorePreviewCollectionDiff {
  collection: string;
  liveCount: number;
  backupCount: number;
  delta: number;
  protectedFromOverwrite: boolean;
}

export interface RestorePreviewResult {
  backupId: string;
  compatible: boolean;
  canProceed: boolean;
  blockingReasons: string[];
  warnings: string[];
  backupCreatedAt: number;
  backupScopeType: BackupScopeType;
  backupAppVersion: string;
  backupSchemaVersion: string;
  currentAppVersion: string;
  currentSchemaVersion: string;
  collections: RestorePreviewCollectionDiff[];
  liveStorageCount: number;
  backupStorageCount: number;
  backupAuthUserCount: number;
  requiresConfirmationPhrase: string;
}

export interface RestoreStepLog {
  step: string;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';
  startedAt: number;
  finishedAt: number | null;
  detail: string;
}

export type IntegritySeverity = 'CRITICAL' | 'WARNING';

export type IntegrityCheckCode =
  | 'XP_PROGRESS_CONSISTENCY'
  | 'XP_REWARD_CONSISTENCY'
  | 'LEVEL_CONSISTENCY'
  | 'NO_NEGATIVE_BALANCE'
  | 'NO_DUPLICATE_USERNAME'
  | 'NO_DUPLICATE_WHATSAPP'
  | 'REFERRAL_INTEGRITY'
  | 'NO_ORPHAN_CLAIMS'
  | 'NO_ORPHAN_REDEMPTIONS'
  | 'TRANSACTION_INTEGRITY'
  | 'STORAGE_OBJECT_INTEGRITY'
  | 'CMS_ASSET_INTEGRITY'
  | 'NO_ORPHAN_BENEFIT_REQUESTS'
  | 'NO_DUPLICATE_DEDUCTION_OR_REFUND'
  | 'VALID_MEMBER_STATUS_AND_PROFILE';

export interface IntegrityCheckItem {
  code: IntegrityCheckCode;
  label: string;
  passed: boolean;
  severity: IntegritySeverity;
  issueCount: number;
  samples: string[];
  summary: string;
}

export interface IntegrityAuditReport {
  auditId: string;
  checkedAt: number;
  checkedBy: string;
  passed: boolean;
  totalChecks: number;
  passedChecks: number;
  criticalCount: number;
  warningCount: number;
  checks: IntegrityCheckItem[];
}

export interface RestoreJobRecord {
  restoreJobId: string;
  operationId: string;
  targetBackupId: string;
  preRestoreBackupId: string | null;
  status: RestoreJobStatus;
  requestedBy: string;
  requestedByEmail: string;
  requestedByRole: AdminRole;
  reason: string;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  steps: RestoreStepLog[];
  restoredCollectionCounts: Record<string, number>;
  expectedCollectionCounts: Record<string, number>;
  restoredStorageCount: number;
  expectedStorageCount: number;
  authRestoreMode: 'METADATA_SYNCED' | 'SKIPPED_NO_ADMIN_SDK';
  authRestoreNotice: string;
  postRestoreVerificationPassed: boolean;
  integrityReport: IntegrityAuditReport | null;
  errorMessage: string | null;
  recoveryRecommendation: string | null;
}

export type HealthStatusLevel = 'HEALTHY' | 'WARNING' | 'ERROR' | 'MAINTENANCE';

export interface SystemHealthComponent {
  key:
    | 'DATABASE'
    | 'AUTHENTICATION'
    | 'STORAGE'
    | 'XP_ENGINE'
    | 'CMS_CONFIG'
    | 'BACKUP_SERVICE'
    | 'RESTORE_LOCK'
    | 'LAST_BACKUP'
    | 'LAST_VERIFICATION';
  label: string;
  status: HealthStatusLevel;
  summary: string;
  detail: string;
}

export interface SystemHealthReport {
  checkedAt: number;
  overallStatus: HealthStatusLevel;
  adminSdkConfigured: boolean;
  restoreLocked: boolean;
  backupLocked: boolean;
  appVersion: string;
  schemaVersion: string;
  components: SystemHealthComponent[];
}

export interface OnboardingPublicStatusDoc {
  status: MemberStatus;
  hasActiveCode: boolean;
  branchId: BranchId;
  updatedAt: number;
}

export interface OnboardingVerificationRecord {
  wHash: string;
  preMemberUid: string;
  memberId: string;
  branchId: BranchId;
  codeHmac: string;
  codeSalt: string;
  status: 'PENDING' | 'VERIFIED' | 'USED' | 'REVOKED' | 'EXPIRED';
  used: boolean;
  attempts: number;
  maxAttempts: number;
  expiresAt: number;
  issuedBy: string;
  issuedByRole: AdminRole;
  issuedAt: number;
  updatedAt: number;
}

export interface PreRegistrationResult {
  alreadyExists: boolean;
  member: MemberProfile;
  verificationCode?: string;
  verificationExpiresAt?: number;
  onboardingUrl?: string;
  whatsappShareMessage?: string;
  message: string;
}

export interface PhoneCheckResult {
  state: 'NOT_FOUND' | 'PRE_REGISTERED' | 'ACTIVE' | 'SUSPENDED' | 'INACTIVE' | 'DELETED';
  canCompleteOnline: boolean;
  hasActiveCode: boolean;
  branchId: BranchId | null;
  normalizedWhatsapp: string;
  message: string;
}

export interface IncompleteRegistrationRow {
  member: MemberProfile;
  daysSincePreRegistered: number;
  hasTransactions: boolean;
  branchId: BranchId | null;
}



