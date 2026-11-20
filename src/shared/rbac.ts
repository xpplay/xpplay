import type { AdminRole, AdminUser, BranchId, RolePermissionKey } from '../types/xpplay.ts';

export type SystemRole = 'MEMBER' | 'CASHIER' | 'ADMIN' | 'SUPER_ADMIN';

export function normalizeSystemRole(role: AdminRole | 'MEMBER' | null | undefined): SystemRole {
  if (role === 'SUPER_ADMIN') return 'SUPER_ADMIN';
  if (role === 'ADMIN') return 'ADMIN';
  if (role === 'CASHIER' || role === 'STAFF') return 'CASHIER';
  return 'MEMBER';
}

export function isCashierRole(role: AdminRole | string | null | undefined): boolean {
  return role === 'CASHIER' || role === 'STAFF';
}

export function isFullAdminRole(role: AdminRole | string | null | undefined): boolean {
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}

export function isSuperAdminRole(role: AdminRole | string | null | undefined): boolean {
  return role === 'SUPER_ADMIN';
}

export const ROLE_PERMISSIONS: Readonly<Record<SystemRole, ReadonlySet<RolePermissionKey>>> = {
  MEMBER: new Set<RolePermissionKey>(['MEMBER_DASHBOARD']),
  CASHIER: new Set<RolePermissionKey>([
    'PRE_REGISTER_CUSTOMER',
    'VIEW_MEMBERS_BRANCH',
    'TRANSACTION_INPUT',
    'BENEFIT_REQUEST_ASSIST',
    'BENEFIT_REQUEST_PROCESS',
  ]),
  ADMIN: new Set<RolePermissionKey>([
    'PRE_REGISTER_CUSTOMER',
    'VIEW_MEMBERS_BRANCH',
    'VIEW_MEMBERS_ALL',
    'TRANSACTION_INPUT',
    'XP_PROGRESS_ADJUSTMENT',
    'XP_REWARD_ADJUSTMENT',
    'LEVEL_OVERRIDE',
    'PASSWORD_RESET_MEMBER',
    'BENEFIT_REQUEST_ASSIST',
    'BENEFIT_REQUEST_PROCESS',
    'BENEFIT_CRUD',
    'CHALLENGE_CRUD',
    'EVENT_CRUD',
    'PROMO_CRUD',
    'NOTIFICATIONS_MANAGE',
    'CMS_EDIT',
    'CMS_PUBLISH',
    'AUDIT_LOG_VIEW',
    'MEMBER_STATUS_MANAGE',
  ]),
  SUPER_ADMIN: new Set<RolePermissionKey>([
    'PRE_REGISTER_CUSTOMER',
    'VIEW_MEMBERS_BRANCH',
    'VIEW_MEMBERS_ALL',
    'TRANSACTION_INPUT',
    'XP_PROGRESS_ADJUSTMENT',
    'XP_REWARD_ADJUSTMENT',
    'LEVEL_OVERRIDE',
    'PASSWORD_RESET_MEMBER',
    'BENEFIT_REQUEST_ASSIST',
    'BENEFIT_REQUEST_PROCESS',
    'BENEFIT_CRUD',
    'CHALLENGE_CRUD',
    'EVENT_CRUD',
    'PROMO_CRUD',
    'NOTIFICATIONS_MANAGE',
    'CMS_EDIT',
    'CMS_PUBLISH',
    'BACKUP_EXECUTE',
    'RESTORE_EXECUTE',
    'ADMIN_MANAGEMENT',
    'CASHIER_MANAGEMENT',
    'SYSTEM_SETTINGS',
    'RESET_CYCLE',
    'AUDIT_LOG_VIEW',
    'MEMBER_STATUS_MANAGE',
  ]),
};

export function hasPermission(
  role: AdminRole | 'MEMBER' | null | undefined,
  permission: RolePermissionKey
): boolean {
  const normalized = normalizeSystemRole(role);
  return ROLE_PERMISSIONS[normalized].has(permission);
}

export function assertRolePermission(
  role: AdminRole | 'MEMBER' | null | undefined,
  permission: RolePermissionKey,
  actionLabel?: string
): void {
  if (!hasPermission(role, permission)) {
    const norm = normalizeSystemRole(role);
    throw new Error(
      `AKSES DITOLAK (403): Role ${norm} tidak memiliki izin untuk ${actionLabel || permission}.`
    );
  }
}

export function getDashboardRouteForRole(role: AdminRole | 'MEMBER' | null | undefined): string {
  const normalized = normalizeSystemRole(role);
  switch (normalized) {
    case 'SUPER_ADMIN':
      return '/superadmin';
    case 'ADMIN':
      return '/admin';
    case 'CASHIER':
      return '/cashier';
    case 'MEMBER':
    default:
      return '/member';
  }
}

export function getEffectiveCashierBranch(
  actor: Pick<AdminUser, 'role' | 'branchScope' | 'branchId'> | null | undefined
): BranchId | null {
  if (!actor) return null;
  if (!isCashierRole(actor.role)) return null;
  const branch = actor.branchId ?? (actor.branchScope !== 'ALL' ? actor.branchScope : null);
  return branch === 'DEMANG' || branch === 'SEKIP' ? branch : null;
}

/**
 * Strict Branch Isolation check:
 * - SUPER_ADMIN: always allowed for all branches.
 * - ADMIN: allowed for ALL if branchScope === 'ALL', or their assigned branchScope.
 * - CASHIER / STAFF: MUST have branchScope === 'DEMANG' or 'SEKIP' (NEVER 'ALL')
 *   and targetBranch MUST match their assigned branch.
 */
export function canAccessBranch(
  actor: { role: AdminRole; branchScope: BranchId | 'ALL'; branchId?: BranchId | null },
  targetBranch: BranchId
): boolean {
  if (actor.role === 'SUPER_ADMIN') return true;
  if (actor.role === 'ADMIN') {
    if (actor.branchScope === 'ALL') return true;
    const assigned = actor.branchId ?? actor.branchScope;
    return assigned === targetBranch;
  }
  // CASHIER / STAFF strict branch isolation
  const assigned = getEffectiveCashierBranch(actor);
  if (!assigned) return false;
  return assigned === targetBranch;
}

export function assertCashierBranchAccess(
  actor: { role: AdminRole; branchScope: BranchId | 'ALL'; branchId?: BranchId | null },
  targetBranch: BranchId,
  operationLabel: string = 'operasi cabang ini'
): void {
  if (isCashierRole(actor.role)) {
    const assigned = getEffectiveCashierBranch(actor);
    if (!assigned) {
      throw new Error(
        `AKSES DITOLAK (403): Akun Kasir wajib terikat ke 1 cabang tetap (DEMANG atau SEKIP) sebelum menjalankan ${operationLabel}.`
      );
    }
    if (assigned !== targetBranch) {
      throw new Error(
        `AKSES DITOLAK (403): Kasir cabang ${assigned} tidak diizinkan mengakses atau memproses data operasional cabang ${targetBranch} (${operationLabel}).`
      );
    }
    return;
  }
  if (!canAccessBranch(actor, targetBranch)) {
    throw new Error(
      `AKSES DITOLAK (403): Akun Anda hanya memiliki akses cabang ${actor.branchScope}, bukan ${targetBranch}.`
    );
  }
}

export function getDefaultPermissionsForRole(role: AdminRole): AdminUser['permissions'] {
  if (role === 'SUPER_ADMIN') {
    return {
      manageMembers: true,
      preRegisterCustomer: true,
      inputTransactions: true,
      reviewClaims: true,
      reviewRedemptions: true,
      manageCampaigns: true,
      manageBenefits: true,
      manageNotifications: true,
      manageSettings: true,
      manageAdmins: true,
      manageCashiers: true,
      manageCms: true,
      manageBackupRestore: true,
      adjustXp: true,
      overrideLevel: true,
      resetMemberPassword: true,
      executeReset: true,
    };
  }
  if (role === 'ADMIN') {
    return {
      manageMembers: true,
      preRegisterCustomer: true,
      inputTransactions: true,
      reviewClaims: true,
      reviewRedemptions: true,
      manageCampaigns: true,
      manageBenefits: true,
      manageNotifications: true,
      manageSettings: false,
      manageAdmins: false,
      manageCashiers: false,
      manageCms: true,
      manageBackupRestore: false,
      adjustXp: true,
      overrideLevel: true,
      resetMemberPassword: true,
      executeReset: false,
    };
  }
  // CASHIER / STAFF
  return {
    manageMembers: false,
    preRegisterCustomer: true,
    inputTransactions: true,
    reviewClaims: true,
    reviewRedemptions: true,
    manageCampaigns: false,
    manageBenefits: false,
    manageNotifications: false,
    manageSettings: false,
    manageAdmins: false,
    manageCashiers: false,
    manageCms: false,
    manageBackupRestore: false,
    adjustXp: false,
    overrideLevel: false,
    resetMemberPassword: false,
    executeReset: false,
  };
}

export interface CashierSlotTemplate {
  code: 'CASHIER_DEMANG_01' | 'CASHIER_DEMANG_02' | 'CASHIER_SEKIP_01' | 'CASHIER_SEKIP_02';
  branchId: BranchId;
  label: string;
}

/**
 * 4 Operational Cashier Slots (2 Demang + 2 Sekip).
 * NO credentials or hardcoded accounts are embedded in source code — Superadmin provisions real accounts via Cashier Management.
 */
export const CASHIER_SLOT_TEMPLATES: readonly CashierSlotTemplate[] = [
  { code: 'CASHIER_DEMANG_01', branchId: 'DEMANG', label: 'Kasir Demang Shift 1' },
  { code: 'CASHIER_DEMANG_02', branchId: 'DEMANG', label: 'Kasir Demang Shift 2' },
  { code: 'CASHIER_SEKIP_01', branchId: 'SEKIP', label: 'Kasir Sekip Shift 1' },
  { code: 'CASHIER_SEKIP_02', branchId: 'SEKIP', label: 'Kasir Sekip Shift 2' },
];

export interface RoleMatrixRow {
  feature: string;
  permissionKey: RolePermissionKey | 'MEMBER_LOGIN';
  member: string;
  cashier: string;
  admin: string;
  superAdmin: string;
}

export const ROLE_PERMISSION_MATRIX_ROWS: readonly RoleMatrixRow[] = [
  {
    feature: 'Member Login & Dashboard',
    permissionKey: 'MEMBER_DASHBOARD',
    member: 'ACTIVE ONLY',
    cashier: 'NO',
    admin: 'NO',
    superAdmin: 'NO',
  },
  {
    feature: 'Pre-Register Customer (WhatsApp)',
    permissionKey: 'PRE_REGISTER_CUSTOMER',
    member: 'NO',
    cashier: 'BRANCH',
    admin: 'YES',
    superAdmin: 'YES',
  },
  {
    feature: 'View Member Directory',
    permissionKey: 'VIEW_MEMBERS_ALL',
    member: 'SELF',
    cashier: 'BRANCH / LOOKUP',
    admin: 'ALL',
    superAdmin: 'ALL',
  },
  {
    feature: 'Transaction Input (Rupiah -> XP)',
    permissionKey: 'TRANSACTION_INPUT',
    member: 'NO',
    cashier: 'BRANCH',
    admin: 'YES',
    superAdmin: 'YES',
  },
  {
    feature: 'XP Progress Adjustment (Manual)',
    permissionKey: 'XP_PROGRESS_ADJUSTMENT',
    member: 'NO',
    cashier: 'NO',
    admin: 'YES',
    superAdmin: 'YES',
  },
  {
    feature: 'XP Reward Adjustment (Manual)',
    permissionKey: 'XP_REWARD_ADJUSTMENT',
    member: 'NO',
    cashier: 'NO',
    admin: 'YES',
    superAdmin: 'YES',
  },
  {
    feature: 'Manual Level Override',
    permissionKey: 'LEVEL_OVERRIDE',
    member: 'NO',
    cashier: 'NO',
    admin: 'YES',
    superAdmin: 'YES',
  },
  {
    feature: 'Password Reset Member',
    permissionKey: 'PASSWORD_RESET_MEMBER',
    member: 'SELF',
    cashier: 'NO',
    admin: 'YES',
    superAdmin: 'YES',
  },
  {
    feature: 'Benefit Request Assist & Process',
    permissionKey: 'BENEFIT_REQUEST_PROCESS',
    member: 'SELF (ACTIVE)',
    cashier: 'BRANCH',
    admin: 'YES',
    superAdmin: 'YES',
  },
  {
    feature: 'Benefit CRUD',
    permissionKey: 'BENEFIT_CRUD',
    member: 'NO',
    cashier: 'NO',
    admin: 'YES',
    superAdmin: 'YES',
  },
  {
    feature: 'Challenge / Event / Promo CRUD',
    permissionKey: 'CHALLENGE_CRUD',
    member: 'NO',
    cashier: 'NO',
    admin: 'YES',
    superAdmin: 'YES',
  },
  {
    feature: 'Notifications Broadcast',
    permissionKey: 'NOTIFICATIONS_MANAGE',
    member: 'READ SELF',
    cashier: 'READ BRANCH',
    admin: 'YES',
    superAdmin: 'YES',
  },
  {
    feature: 'CMS Homepage Edit & Publish',
    permissionKey: 'CMS_PUBLISH',
    member: 'NO',
    cashier: 'NO',
    admin: 'YES',
    superAdmin: 'YES',
  },
  {
    feature: 'Backup & Restore System',
    permissionKey: 'BACKUP_EXECUTE',
    member: 'NO',
    cashier: 'NO',
    admin: 'NO',
    superAdmin: 'YES',
  },
  {
    feature: 'Admin & Cashier Management',
    permissionKey: 'CASHIER_MANAGEMENT',
    member: 'NO',
    cashier: 'NO',
    admin: 'NO',
    superAdmin: 'YES',
  },
  {
    feature: 'System / XP / Level / Reset Settings',
    permissionKey: 'SYSTEM_SETTINGS',
    member: 'NO',
    cashier: 'NO',
    admin: 'NO',
    superAdmin: 'YES',
  },
];
