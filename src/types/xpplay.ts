export type BranchId = 'DEMANG' | 'SEKIP';

export type MemberStatus = 'ACTIVE' | 'SUSPENDED' | 'INACTIVE' | 'DELETED';

export type AdminRole = 'SUPER_ADMIN' | 'ADMIN' | 'STAFF';

export type LevelId = 'BRONZE' | 'SILVER' | 'JURAGAN' | 'SULTAN';

export type ClaimStatus = 'ON_PROCESS' | 'APPROVED' | 'DENIED';

export type RedemptionStatus = 'ON_PROCESS' | 'APPROVED' | 'DENIED';

export type CampaignType = 'CHALLENGE' | 'EVENT' | 'PROMO';

export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'EXPIRED' | 'DISABLED';

export type NotificationStatus = 'DRAFT' | 'ACTIVE' | 'EXPIRED';

export type NotificationTargetType =
  | 'ALL_MEMBERS'
  | 'SPECIFIC_MEMBER'
  | 'LEVEL'
  | 'BRANCH'
  | 'INACTIVE_MEMBERS';

export type XpLedgerSource =
  | 'REGISTRATION'
  | 'REFERRAL'
  | 'TRANSACTION'
  | 'CHALLENGE'
  | 'EVENT'
  | 'PROMO'
  | 'LEVEL_BONUS'
  | 'ADMIN_ADJUSTMENT'
  | 'REDEMPTION'
  | 'RESET';

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
  status: MemberStatus;
  xpProgress: number;
  xpReward: number;
  currentLevel: LevelId;
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
  permissions: {
    manageMembers: boolean;
    inputTransactions: boolean;
    reviewClaims: boolean;
    reviewRedemptions: boolean;
    manageCampaigns: boolean;
    manageBenefits: boolean;
    manageNotifications: boolean;
    manageSettings: boolean;
    manageAdmins: boolean;
    executeReset: boolean;
  };
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface XpLedgerEntry {
  id: string;
  memberId: string;
  memberUid: string;
  amount: number;
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
  category: 'SYSTEM' | 'LEVEL_UP' | 'CLAIM' | 'REDEMPTION' | 'PROMO' | 'INACTIVITY' | 'RESET';
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
