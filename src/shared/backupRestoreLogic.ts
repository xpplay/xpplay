import type {
  BackupLockState,
  BackupManifest,
  BackupRetentionConfig,
  IntegrityAuditReport,
  SystemBackupRecord,
} from '../types/xpplay.ts';

export const CURRENT_APP_VERSION = '2.4.0';
export const CURRENT_SCHEMA_VERSION = 'xpplay-schema-v2';
export const COMPATIBLE_SCHEMA_VERSIONS: readonly string[] = [
  'xpplay-schema-v1',
  'xpplay-schema-v2',
];

export const RESTORE_CONFIRMATION_PHRASE = 'RESTORE XP PLAY';

export const RESTORE_MAINTENANCE_MESSAGE =
  'XP PLAY sedang melakukan maintenance sistem. Silakan kembali beberapa saat lagi.';

/**
 * Complete set of Firestore collections exported during backup.
 */
export const BACKUP_COLLECTIONS: readonly string[] = [
  'members',
  'identityIndex',
  'admins',
  'branches',
  'levels',
  'systemSettings',
  'transactions',
  'xpProgressLedger',
  'xpRewardLedger',
  'xpAdjustments',
  'levelOverrides',
  'levelHistory',
  'referrals',
  'benefits',
  'campaigns',
  'claims',
  'redemptions',
  'notifications',
  'memberNotifications',
  'membershipCycles',
  'cycleSnapshots',
  'cmsPublished',
  'cmsDrafts',
  'cmsVersions',
  'auditLogs',
];

/**
 * Business & configuration collections restored during Full System Restore.
 * Explicitly excludes systemBackups, restoreJobs, systemOperations, and auditLogs
 * so audit history and backup snapshots are NEVER deleted or overwritten during restore.
 */
export const RESTORABLE_BUSINESS_COLLECTIONS: readonly string[] = BACKUP_COLLECTIONS.filter(
  (col) => col !== 'auditLogs'
);

export const PROTECTED_SYSTEM_COLLECTIONS: readonly string[] = [
  'systemBackups',
  'restoreJobs',
  'systemOperations',
  'auditLogs',
];

export const DEFAULT_BACKUP_RETENTION: BackupRetentionConfig = {
  id: 'backupRetention',
  dailyRetentionCount: 7,
  weeklyRetentionCount: 4,
  monthlyRetentionCount: 3,
  customMaxAgeDays: 90,
  alwaysKeepLatestSuccessful: true,
  alwaysKeepLatestPreRestore: true,
  updatedAt: 0,
  updatedBy: 'system',
};

export const FORBIDDEN_PASSWORD_FIELD_NAMES = new Set([
  'password',
  'newpassword',
  'oldpassword',
  'confirmpassword',
  'passwordhash',
  'rawpassword',
  'plaintextpassword',
  'hashedpassword',
  'passwordsalt',
]);

export function validateRestoreConfirmationPhrase(input: string): boolean {
  return typeof input === 'string' && input.trim() === RESTORE_CONFIRMATION_PHRASE;
}

export function detectForbiddenPasswordFields(
  value: unknown,
  pathPrefix = ''
): string[] {
  const hits: string[] = [];
  if (!value || typeof value !== 'object') return hits;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      hits.push(...detectForbiddenPasswordFields(value[i], `${pathPrefix}[${i}]`));
    }
    return hits;
  }

  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (FORBIDDEN_PASSWORD_FIELD_NAMES.has(key.toLowerCase())) {
      hits.push(fullPath);
    }
    if (val && typeof val === 'object') {
      hits.push(...detectForbiddenPasswordFields(val, fullPath));
    }
  }
  return hits;
}

export function validateBackupManifestStructure(manifest: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest backup tidak ditemukan atau bukan objek JSON valid.'] };
  }
  const m = manifest as Partial<BackupManifest>;
  if (!m.backupId || typeof m.backupId !== 'string') errors.push('backupId wajib ada.');
  if (!m.operationId || typeof m.operationId !== 'string') errors.push('operationId wajib ada.');
  if (!m.appVersion || typeof m.appVersion !== 'string') errors.push('appVersion wajib ada.');
  if (!m.schemaVersion || typeof m.schemaVersion !== 'string') errors.push('schemaVersion wajib ada.');
  if (typeof m.createdAt !== 'number' || !Number.isFinite(m.createdAt)) {
    errors.push('createdAt harus berupa timestamp angka valid.');
  }
  if (!Array.isArray(m.firestoreCollections) || m.firestoreCollections.length === 0) {
    errors.push('firestoreCollections tidak boleh kosong.');
  }
  if (!Array.isArray(m.storageFiles)) {
    errors.push('storageFiles harus berupa array.');
  }
  if (!m.manifestChecksumSha256 || !/^[a-f0-9]{64}$/i.test(m.manifestChecksumSha256)) {
    errors.push('manifestChecksumSha256 tidak valid (harus SHA-256 64 karakter hex).');
  }
  if (!m.authChecksumSha256 || !/^[a-f0-9]{64}$/i.test(m.authChecksumSha256)) {
    errors.push('authChecksumSha256 tidak valid.');
  }
  if (!m.storageManifestChecksumSha256 || !/^[a-f0-9]{64}$/i.test(m.storageManifestChecksumSha256)) {
    errors.push('storageManifestChecksumSha256 tidak valid.');
  }

  return { valid: errors.length === 0, errors };
}

export function checkBackupSchemaCompatibility(manifest: Pick<BackupManifest, 'appVersion' | 'schemaVersion'>): {
  compatible: boolean;
  reason: string | null;
} {
  if (!COMPATIBLE_SCHEMA_VERSIONS.includes(manifest.schemaVersion)) {
    return {
      compatible: false,
      reason: `Schema version backup (${manifest.schemaVersion}) tidak kompatibel dengan versi aktif (${CURRENT_SCHEMA_VERSION}).`,
    };
  }
  const majorBackup = Number(String(manifest.appVersion || '').split('.')[0]);
  const majorCurrent = Number(CURRENT_APP_VERSION.split('.')[0]);
  if (!Number.isFinite(majorBackup) || majorBackup > majorCurrent) {
    return {
      compatible: false,
      reason: `App version backup (${manifest.appVersion}) lebih baru daripada aplikasi aktif (${CURRENT_APP_VERSION}).`,
    };
  }
  return { compatible: true, reason: null };
}

export function canDeleteBackupRecord(
  target: SystemBackupRecord,
  allBackups: SystemBackupRecord[],
  retention: BackupRetentionConfig,
  activeBackupLock?: BackupLockState | null,
  activeRestoreBackupId?: string | null
): { allowed: boolean; reason: string | null } {
  const activeStatuses = new Set(['REQUESTED', 'PREPARING', 'RUNNING', 'VERIFYING']);
  if (activeStatuses.has(target.status)) {
    return { allowed: false, reason: 'Backup yang sedang berjalan tidak dapat dihapus.' };
  }
  if (activeBackupLock?.locked && activeBackupLock.backupId === target.backupId) {
    return { allowed: false, reason: 'Backup sedang terkunci oleh proses aktif.' };
  }
  if (activeRestoreBackupId && activeRestoreBackupId === target.backupId) {
    return { allowed: false, reason: 'Backup sedang digunakan oleh proses restore aktif.' };
  }

  const completedRegular = allBackups
    .filter((b) => b.status === 'COMPLETED' && b.kind !== 'PRE_RESTORE')
    .sort((a, b) => b.createdAt - a.createdAt);
  if (
    retention.alwaysKeepLatestSuccessful &&
    completedRegular.length > 0 &&
    completedRegular[0].backupId === target.backupId
  ) {
    return {
      allowed: false,
      reason: 'Kebijakan retensi melindungi backup sukses terakhir agar tidak terhapus.',
    };
  }

  const completedPreRestore = allBackups
    .filter((b) => b.status === 'COMPLETED' && b.kind === 'PRE_RESTORE')
    .sort((a, b) => b.createdAt - a.createdAt);
  if (
    retention.alwaysKeepLatestPreRestore &&
    completedPreRestore.length > 0 &&
    completedPreRestore[0].backupId === target.backupId
  ) {
    return {
      allowed: false,
      reason: 'Kebijakan retensi melindungi Pre-Restore Backup terakhir agar rollback darurat tetap aman.',
    };
  }

  return { allowed: true, reason: null };
}

export function evaluatePostRestoreVerification(input: {
  expectedCollectionCounts: Record<string, number>;
  restoredCollectionCounts: Record<string, number>;
  expectedStorageCount: number;
  restoredStorageCount: number;
  integrityReport: IntegrityAuditReport;
}): {
  passed: boolean;
  finalStatus: 'COMPLETED' | 'VERIFICATION_FAILED';
  mismatches: string[];
} {
  const mismatches: string[] = [];

  for (const [col, expected] of Object.entries(input.expectedCollectionCounts)) {
    if (PROTECTED_SYSTEM_COLLECTIONS.includes(col)) continue;
    const actual = input.restoredCollectionCounts[col] ?? 0;
    if (actual !== expected) {
      mismatches.push(`Koleksi ${col}: ekspektasi ${expected} dokumen, hasil restore ${actual} dokumen.`);
    }
  }

  if (input.restoredStorageCount !== input.expectedStorageCount) {
    mismatches.push(
      `Storage objects: ekspektasi ${input.expectedStorageCount} file, hasil restore ${input.restoredStorageCount} file.`
    );
  }

  if (!input.integrityReport.passed || input.integrityReport.criticalCount > 0) {
    mismatches.push(
      `Data Integrity Check gagal dengan ${input.integrityReport.criticalCount} temuan kritikal.`
    );
  }

  const passed = mismatches.length === 0;
  return {
    passed,
    finalStatus: passed ? 'COMPLETED' : 'VERIFICATION_FAILED',
    mismatches,
  };
}

export function formatBytesHuman(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let value = bytes;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}
