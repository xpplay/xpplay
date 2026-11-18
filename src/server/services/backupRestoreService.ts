import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  firebaseAppletConfig,
  getAdminAuth,
  isAdminSdkAvailable,
} from '../firebaseServer.ts';
import {
  defaultFirestoreDataStore,
  type BackupDataStore,
  type StoredDocEntry,
} from './firestoreRestHelper.ts';
import {
  BACKUP_COLLECTIONS,
  canDeleteBackupRecord,
  checkBackupSchemaCompatibility,
  CURRENT_APP_VERSION,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_BACKUP_RETENTION,
  detectForbiddenPasswordFields,
  evaluatePostRestoreVerification,
  PROTECTED_SYSTEM_COLLECTIONS,
  RESTORABLE_BUSINESS_COLLECTIONS,
  RESTORE_CONFIRMATION_PHRASE,
  RESTORE_MAINTENANCE_MESSAGE,
  validateBackupManifestStructure,
  validateRestoreConfirmationPhrase,
} from '../../shared/backupRestoreLogic.ts';
import { runDataIntegrityChecks } from '../../shared/integrityLogic.ts';
import type {
  AdminRole,
  AuthUserMetadataEntry,
  BackupCollectionSummary,
  BackupKind,
  BackupLockState,
  BackupManifest,
  BackupRetentionConfig,
  BackupVerificationCheck,
  BackupVerificationResult,
  BenefitItem,
  CampaignItem,
  ClaimRecord,
  CmsDraftDoc,
  CmsPublishedDoc,
  IntegrityAuditReport,
  LevelConfig,
  MemberProfile,
  RedemptionRecord,
  ReferralRecord,
  RestoreJobRecord,
  RestoreLockState,
  RestorePreviewCollectionDiff,
  RestorePreviewResult,
  RestoreStepLog,
  StorageBackupFileEntry,
  SystemBackupRecord,
  SystemHealthComponent,
  SystemHealthReport,
  TransactionRecord,
  XpLedgerEntry,
} from '../../types/xpplay.ts';

function sha256Buffer(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeTimestampSlug(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(
    d.getUTCHours()
  )}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function makeUniqueId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function walkFilesRecursive(baseDir: string, currentDir: string, out: string[]): void {
  if (!fs.existsSync(currentDir)) return;
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkFilesRecursive(baseDir, full, out);
    } else if (entry.isFile()) {
      const rel = path.relative(baseDir, full).split(path.sep).join('/');
      out.push(rel);
    }
  }
}

export interface BackupRestoreEngineOptions {
  backupsRoot?: string;
  uploadsRoot?: string;
  store?: BackupDataStore;
  authExporter?: () => Promise<{
    mode: 'FIREBASE_ADMIN_SDK' | 'FIRESTORE_DERIVED_METADATA_ONLY';
    users: AuthUserMetadataEntry[];
  }>;
  authMetadataRestorer?: (users: AuthUserMetadataEntry[]) => Promise<{
    mode: 'METADATA_SYNCED' | 'SKIPPED_NO_ADMIN_SDK';
    notice: string;
  }>;
}

export class BackupRestoreEngine {
  private readonly backupsRoot: string;
  private readonly uploadsRoot: string;
  private readonly store: BackupDataStore;
  private readonly customAuthExporter?: BackupRestoreEngineOptions['authExporter'];
  private readonly customAuthRestorer?: BackupRestoreEngineOptions['authMetadataRestorer'];

  // Process-local atomic mutexes preventing millisecond race conditions on concurrent requests
  private localBackupLock: BackupLockState = {
    id: 'backupLock',
    locked: false,
    operationId: null,
    backupId: null,
    lockedBy: null,
    lockedAt: null,
    updatedAt: 0,
  };

  private localRestoreLock: RestoreLockState = {
    id: 'restoreLock',
    locked: false,
    state: 'IDLE',
    restoreJobId: null,
    backupId: null,
    lockedBy: null,
    lockedByEmail: null,
    lockedAt: null,
    updatedAt: 0,
    message: '',
  };

  constructor(options: BackupRestoreEngineOptions = {}) {
    this.backupsRoot = options.backupsRoot ?? path.resolve(process.cwd(), '.backups');
    this.uploadsRoot = options.uploadsRoot ?? path.resolve(process.cwd(), '.uploads');
    this.store = options.store ?? defaultFirestoreDataStore;
    this.customAuthExporter = options.authExporter;
    this.customAuthRestorer = options.authMetadataRestorer;
    fs.mkdirSync(this.backupsRoot, { recursive: true });
    fs.mkdirSync(path.join(this.uploadsRoot, 'claims'), { recursive: true });
    fs.mkdirSync(path.join(this.uploadsRoot, 'cms'), { recursive: true });
  }

  public getLocalRestoreLock(): RestoreLockState {
    return { ...this.localRestoreLock };
  }

  public getLocalBackupLock(): BackupLockState {
    return { ...this.localBackupLock };
  }

  public isRestoreLockActiveSync(): boolean {
    return this.localRestoreLock.locked;
  }

  public async getRestoreLockState(bearerToken?: string): Promise<RestoreLockState> {
    if (this.localRestoreLock.locked) {
      return { ...this.localRestoreLock };
    }
    try {
      const remote = await this.store.getDocument('systemOperations', 'restoreLock', bearerToken);
      if (remote && remote.locked === true) {
        const state: RestoreLockState = {
          id: 'restoreLock',
          locked: true,
          state: 'RESTORE_IN_PROGRESS',
          restoreJobId: (remote.restoreJobId as string | null) ?? null,
          backupId: (remote.backupId as string | null) ?? null,
          lockedBy: (remote.lockedBy as string | null) ?? null,
          lockedByEmail: (remote.lockedByEmail as string | null) ?? null,
          lockedAt: (remote.lockedAt as number | null) ?? null,
          updatedAt: Number(remote.updatedAt ?? Date.now()),
          message: String(remote.message || RESTORE_MAINTENANCE_MESSAGE),
        };
        return state;
      }
    } catch {
      // Fallback to local state if Firestore read is unavailable unauthenticated
    }
    return { ...this.localRestoreLock };
  }

  private async writeAuditLog(input: {
    actorId: string;
    actorRole: AdminRole;
    action: string;
    targetType: string;
    targetId: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
    bearerToken?: string;
  }): Promise<string> {
    const auditId = makeUniqueId('audit');
    await this.store.setDocument(
      'auditLogs',
      auditId,
      {
        id: auditId,
        actorId: input.actorId,
        actorRole: input.actorRole,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        before: input.before ?? null,
        after: input.after ?? null,
        metadata: input.metadata ?? null,
        timestamp: Date.now(),
      },
      input.bearerToken
    );
    return auditId;
  }

  private listLocalStorageFiles(): { relativePath: string; bucketGroup: 'claims' | 'cms'; fullPath: string }[] {
    const files: { relativePath: string; bucketGroup: 'claims' | 'cms'; fullPath: string }[] = [];
    for (const group of ['claims', 'cms'] as const) {
      const groupDir = path.join(this.uploadsRoot, group);
      const relList: string[] = [];
      walkFilesRecursive(groupDir, groupDir, relList);
      relList.sort();
      for (const rel of relList) {
        files.push({
          relativePath: `${group}/${rel}`,
          bucketGroup: group,
          fullPath: path.join(groupDir, rel),
        });
      }
    }
    return files;
  }

  private async exportAuthMetadata(
    membersDocs: StoredDocEntry[],
    adminsDocs: StoredDocEntry[]
  ): Promise<{
    mode: 'FIREBASE_ADMIN_SDK' | 'FIRESTORE_DERIVED_METADATA_ONLY';
    users: AuthUserMetadataEntry[];
  }> {
    if (this.customAuthExporter) {
      return this.customAuthExporter();
    }

    const adminAuth = getAdminAuth();
    const adminUids = new Set(adminsDocs.map((a) => a.id));
    const memberUids = new Set(membersDocs.map((m) => m.id));

    if (adminAuth && isAdminSdkAvailable()) {
      const users: AuthUserMetadataEntry[] = [];
      let nextPageToken: string | undefined;
      while (true) {
        const page = await adminAuth.listUsers(1000, nextPageToken);
        for (const u of page.users) {
          const isAdm = adminUids.has(u.uid);
          const isMem = memberUids.has(u.uid);
          users.push({
            uid: u.uid,
            email: u.email ?? null,
            displayName: u.displayName ?? null,
            disabled: Boolean(u.disabled),
            emailVerified: Boolean(u.emailVerified),
            providers: u.providerData.map((p) => p.providerId),
            roleHint: isAdm && isMem ? 'BOTH' : isAdm ? 'ADMIN' : isMem ? 'MEMBER' : 'UNKNOWN',
            createdAt: u.metadata.creationTime ?? null,
            lastSignInAt: u.metadata.lastSignInTime ?? null,
          });
        }
        if (!page.pageToken) break;
        nextPageToken = page.pageToken;
      }
      users.sort((a, b) => a.uid.localeCompare(b.uid));
      return { mode: 'FIREBASE_ADMIN_SDK', users };
    }

    // Preview/non-Admin-SDK mode: derive honest metadata strictly from admins & members (NEVER fake Firebase Auth export)
    const map = new Map<string, AuthUserMetadataEntry>();
    for (const mDoc of membersDocs) {
      const d = mDoc.data;
      map.set(mDoc.id, {
        uid: mDoc.id,
        email: typeof d.username === 'string' ? `${d.username}@member.xpplay.id` : null,
        displayName: typeof d.fullName === 'string' ? d.fullName : null,
        disabled: d.status === 'SUSPENDED' || d.status === 'DELETED',
        emailVerified: false,
        providers: ['derived:members'],
        roleHint: adminUids.has(mDoc.id) ? 'BOTH' : 'MEMBER',
        createdAt: typeof d.createdAt === 'number' ? new Date(d.createdAt).toISOString() : null,
        lastSignInAt: typeof d.lastPlayAt === 'number' ? new Date(d.lastPlayAt).toISOString() : null,
      });
    }
    for (const aDoc of adminsDocs) {
      const d = aDoc.data;
      const existing = map.get(aDoc.id);
      map.set(aDoc.id, {
        uid: aDoc.id,
        email: typeof d.email === 'string' ? d.email : existing?.email ?? null,
        displayName: typeof d.fullName === 'string' ? d.fullName : existing?.displayName ?? null,
        disabled: d.active === false,
        emailVerified: true,
        providers: ['derived:admins'],
        roleHint: memberUids.has(aDoc.id) ? 'BOTH' : 'ADMIN',
        createdAt: typeof d.createdAt === 'number' ? new Date(d.createdAt).toISOString() : null,
        lastSignInAt: existing?.lastSignInAt ?? null,
      });
    }
    const users = Array.from(map.values()).sort((a, b) => a.uid.localeCompare(b.uid));
    return { mode: 'FIRESTORE_DERIVED_METADATA_ONLY', users };
  }

  private async persistBackupLock(lock: BackupLockState, bearerToken?: string): Promise<void> {
    this.localBackupLock = { ...lock };
    await this.store.setDocument(
      'systemOperations',
      'backupLock',
      lock as unknown as Record<string, unknown>,
      bearerToken
    );
  }

  private async persistRestoreLock(lock: RestoreLockState, bearerToken?: string): Promise<void> {
    this.localRestoreLock = { ...lock };
    await this.store.setDocument(
      'systemOperations',
      'restoreLock',
      lock as unknown as Record<string, unknown>,
      bearerToken
    );
  }

  private async saveBackupRecord(record: SystemBackupRecord, bearerToken?: string): Promise<void> {
    await this.store.setDocument(
      'systemBackups',
      record.backupId,
      record as unknown as Record<string, unknown>,
      bearerToken
    );
  }

  private async saveRestoreJobRecord(record: RestoreJobRecord, bearerToken?: string): Promise<void> {
    await this.store.setDocument(
      'restoreJobs',
      record.restoreJobId,
      record as unknown as Record<string, unknown>,
      bearerToken
    );
  }

  // ---------- CREATE BACKUP (MODULES 7, 8, 10, 28) ----------
  public async createSystemBackup(input: {
    kind: BackupKind;
    note?: string;
    actorUid: string;
    actorEmail: string;
    actorRole: AdminRole;
    bearerToken?: string;
    /** Internal flag used only by executeRestore while restore lock is already held by the same job */
    allowDuringRestoreLock?: boolean;
  }): Promise<{ record: SystemBackupRecord; manifest: BackupManifest; verification: BackupVerificationResult }> {
    // Block backup if restore is running (unless this is the mandatory pre-restore backup itself)
    if (!input.allowDuringRestoreLock && this.localRestoreLock.locked) {
      const err = new Error(RESTORE_MAINTENANCE_MESSAGE) as Error & { statusCode?: number; code?: string };
      err.statusCode = 503;
      err.code = 'RESTORE_IN_PROGRESS';
      throw err;
    }

    // Concurrency & collision guard (MODULE 10, TEST 6) — reserve local mutex synchronously BEFORE any await
    if (this.localBackupLock.locked) {
      const err = new Error(
        `Proses backup lain sedang berjalan (${this.localBackupLock.backupId || 'active'}). Tunggu hingga selesai sebelum memulai backup baru.`
      ) as Error & { statusCode?: number; code?: string };
      err.statusCode = 409;
      err.code = 'BACKUP_IN_PROGRESS';
      throw err;
    }

    const startedAt = Date.now();
    const slug = makeTimestampSlug(startedAt);
    const rand = crypto.randomBytes(4).toString('hex');
    const backupId =
      input.kind === 'PRE_RESTORE'
        ? `backup_pre_restore_${slug}_${rand}`
        : `backup_${slug}_${rand}`;
    const operationId = makeUniqueId('op_bkp');
    const backupDir = path.join(this.backupsRoot, backupId);

    // Reserve synchronous process-local lock immediately so simultaneous Promise.all calls collide atomically
    this.localBackupLock = {
      id: 'backupLock',
      locked: true,
      operationId,
      backupId,
      lockedBy: input.actorUid,
      lockedAt: startedAt,
      updatedAt: startedAt,
    };

    const remoteBackupLock = await this.store
      .getDocument('systemOperations', 'backupLock', input.bearerToken)
      .catch(() => null);
    if (remoteBackupLock && remoteBackupLock.locked === true) {
      const lockedAt = Number(remoteBackupLock.lockedAt ?? 0);
      // Treat remote lock older than 30 minutes as stale
      if (Date.now() - lockedAt < 30 * 60 * 1000) {
        this.localBackupLock = {
          id: 'backupLock',
          locked: false,
          operationId: null,
          backupId: null,
          lockedBy: null,
          lockedAt: null,
          updatedAt: Date.now(),
        };
        const err = new Error(
          `Proses backup lain sedang berjalan (${String(remoteBackupLock.backupId || 'active')}).`
        ) as Error & { statusCode?: number; code?: string };
        err.statusCode = 409;
        err.code = 'BACKUP_IN_PROGRESS';
        throw err;
      }
    }

    let record: SystemBackupRecord = {
      backupId,
      operationId,
      kind: input.kind,
      scopeType: isAdminSdkAvailable() ? 'FULL_SYSTEM_BACKUP' : 'FIRESTORE_AND_STORAGE_BACKUP',
      status: 'REQUESTED',
      appVersion: CURRENT_APP_VERSION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: startedAt,
      completedAt: null,
      durationMs: null,
      createdBy: input.actorUid,
      createdByEmail: input.actorEmail,
      createdByRole: input.actorRole,
      note: (input.note || '').trim().slice(0, 300),
      totalDocuments: 0,
      authUserCount: 0,
      storageFileCount: 0,
      totalBackupBytes: 0,
      storagePath: `.backups/${backupId}`,
      manifestChecksumSha256: '',
      verified: false,
      verifiedAt: null,
      verificationStatus: 'PENDING',
      verificationSummary: 'Menunggu proses backup & verifikasi.',
      errorMessage: null,
      protectedFromRetention: input.kind === 'PRE_RESTORE',
    };

    try {
      await this.persistBackupLock(this.localBackupLock, input.bearerToken);
      await this.saveBackupRecord(record, input.bearerToken);

      await this.writeAuditLog({
        actorId: input.actorUid,
        actorRole: input.actorRole,
        action: 'BACKUP_REQUESTED',
        targetType: 'systemBackup',
        targetId: backupId,
        after: { kind: input.kind, operationId, status: 'REQUESTED' },
        metadata: { note: record.note },
        bearerToken: input.bearerToken,
      });

      // Stage: PREPARING
      record = { ...record, status: 'PREPARING' };
      await this.saveBackupRecord(record, input.bearerToken);

      if (fs.existsSync(backupDir)) {
        throw new Error(`Direktori backup ${backupId} sudah ada (collision terdeteksi).`);
      }
      const firestoreDir = path.join(backupDir, 'firestore');
      const authDir = path.join(backupDir, 'auth');
      const storageDir = path.join(backupDir, 'storage');
      const storageFilesDir = path.join(storageDir, 'files');
      fs.mkdirSync(firestoreDir, { recursive: true });
      fs.mkdirSync(authDir, { recursive: true });
      fs.mkdirSync(storageFilesDir, { recursive: true });

      // Stage: RUNNING
      record = { ...record, status: 'RUNNING' };
      await this.saveBackupRecord(record, input.bearerToken);

      const firestoreSummaries: BackupCollectionSummary[] = [];
      let totalDocuments = 0;
      let totalBackupBytes = 0;
      let membersDocs: StoredDocEntry[] = [];
      let adminsDocs: StoredDocEntry[] = [];

      for (const colName of BACKUP_COLLECTIONS) {
        const docs = await this.store.listCollection(colName, input.bearerToken);
        docs.sort((a, b) => a.id.localeCompare(b.id));
        if (colName === 'members') membersDocs = docs;
        if (colName === 'admins') adminsDocs = docs;

        // Guard: NEVER allow plaintext password fields into backup snapshots
        const forbiddenHits = detectForbiddenPasswordFields(docs);
        if (forbiddenHits.length > 0) {
          throw new Error(
            `Pelanggaran keamanan: ditemukan field password terlarang di koleksi ${colName} (${forbiddenHits[0]}).`
          );
        }

        const serialized = JSON.stringify(docs, null, 2);
        const buf = Buffer.from(serialized, 'utf8');
        fs.writeFileSync(path.join(firestoreDir, `${colName}.json`), buf);

        firestoreSummaries.push({
          collection: colName,
          documentCount: docs.length,
          byteSize: buf.byteLength,
          checksumSha256: sha256Buffer(buf),
        });
        totalDocuments += docs.length;
        totalBackupBytes += buf.byteLength;
      }

      // Export Auth Metadata (honest per MODULE 28)
      const authExport = await this.exportAuthMetadata(membersDocs, adminsDocs);
      const authBuf = Buffer.from(JSON.stringify(authExport.users, null, 2), 'utf8');
      fs.writeFileSync(path.join(authDir, 'users_metadata.json'), authBuf);
      const authChecksumSha256 = sha256Buffer(authBuf);
      totalBackupBytes += authBuf.byteLength;

      // Export Storage Objects (.uploads/claims + .uploads/cms)
      const liveStorage = this.listLocalStorageFiles();
      const storageEntries: StorageBackupFileEntry[] = [];
      let storageTotalBytes = 0;
      for (const item of liveStorage) {
        const buf = fs.readFileSync(item.fullPath);
        const stat = fs.statSync(item.fullPath);
        const destPath = path.join(storageFilesDir, item.relativePath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, buf);

        storageEntries.push({
          relativePath: item.relativePath,
          bucketGroup: item.bucketGroup,
          byteSize: buf.byteLength,
          checksumSha256: sha256Buffer(buf),
          modifiedAt: Math.floor(stat.mtimeMs),
        });
        storageTotalBytes += buf.byteLength;
        totalBackupBytes += buf.byteLength;
      }
      const storageManifestBuf = Buffer.from(JSON.stringify(storageEntries, null, 2), 'utf8');
      fs.writeFileSync(path.join(storageDir, 'storage_manifest.json'), storageManifestBuf);
      const storageManifestChecksumSha256 = sha256Buffer(storageManifestBuf);
      totalBackupBytes += storageManifestBuf.byteLength;

      const scopeType =
        authExport.mode === 'FIREBASE_ADMIN_SDK'
          ? 'FULL_SYSTEM_BACKUP'
          : 'FIRESTORE_AND_STORAGE_BACKUP';

      const scopeDescription =
        scopeType === 'FULL_SYSTEM_BACKUP'
          ? 'Backup penuh Firestore (25 koleksi), Storage (bukti claim & aset CMS), dan Firebase Auth metadata.'
          : 'Backup Firestore (25 koleksi) & Storage (bukti claim & aset CMS) + metadata akun turunan Firestore. Firebase Auth Admin SDK tidak aktif di environment ini.';

      const authLimitationNotice =
        authExport.mode === 'FIREBASE_ADMIN_SDK'
          ? 'Password hash terkelola Firebase Auth tidak pernah diekspor dalam bentuk plaintext. Restore metadata Auth mempertahankan kredensial login yang ada tanpa menulis ulang password mentah.'
          : 'FIREBASE_SERVICE_ACCOUNT_JSON belum dikonfigurasi sehingga daftar user Firebase Auth tidak dapat diekspor langsung via Admin SDK; metadata diturunkan dari koleksi admins & members.';

      const manifestBase: Omit<BackupManifest, 'manifestChecksumSha256'> = {
        backupId,
        operationId,
        kind: input.kind,
        scopeType,
        scopeDescription,
        authExportMode: authExport.mode,
        authLimitationNotice,
        appVersion: CURRENT_APP_VERSION,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: startedAt,
        createdBy: input.actorUid,
        createdByEmail: input.actorEmail,
        createdByRole: input.actorRole,
        projectId: firebaseAppletConfig.projectId,
        firestoreDatabaseId: firebaseAppletConfig.firestoreDatabaseId,
        firestoreCollections: firestoreSummaries,
        totalDocuments,
        authUserCount: authExport.users.length,
        authChecksumSha256,
        storageFiles: storageEntries,
        storageFileCount: storageEntries.length,
        storageTotalBytes,
        storageManifestChecksumSha256,
        totalBackupBytes,
      };

      const manifestChecksumSha256 = sha256Buffer(JSON.stringify(manifestBase));
      const manifest: BackupManifest = {
        ...manifestBase,
        manifestChecksumSha256,
      };
      const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
      fs.writeFileSync(path.join(backupDir, 'manifest.json'), manifestBuf);

      // Stage: VERIFYING (Mandatory before COMPLETED per MODULE 8)
      record = {
        ...record,
        scopeType,
        status: 'VERIFYING',
        totalDocuments,
        authUserCount: authExport.users.length,
        storageFileCount: storageEntries.length,
        totalBackupBytes: totalBackupBytes + manifestBuf.byteLength,
        manifestChecksumSha256,
      };
      await this.saveBackupRecord(record, input.bearerToken);

      const verification = await this.verifySystemBackup({
        backupId,
        actorUid: input.actorUid,
        actorRole: input.actorRole,
        bearerToken: input.bearerToken,
      });

      const finishedAt = Date.now();
      record = {
        ...record,
        status: verification.passed ? 'COMPLETED' : 'VERIFICATION_FAILED',
        completedAt: finishedAt,
        durationMs: finishedAt - startedAt,
        verified: verification.passed,
        verifiedAt: verification.verifiedAt,
        verificationStatus: verification.status,
        verificationSummary: verification.passed
          ? `${verification.checks.length}/${verification.checks.length} pemeriksaan integritas backup lulus.`
          : `Verifikasi gagal: ${verification.checks
              .filter((c) => !c.passed)
              .map((c) => c.label)
              .join('; ')}`,
      };
      await this.saveBackupRecord(record, input.bearerToken);

      await this.writeAuditLog({
        actorId: input.actorUid,
        actorRole: input.actorRole,
        action: verification.passed ? 'BACKUP_COMPLETED' : 'BACKUP_FAILED',
        targetType: 'systemBackup',
        targetId: backupId,
        after: {
          status: record.status,
          scopeType: record.scopeType,
          totalDocuments: record.totalDocuments,
          storageFileCount: record.storageFileCount,
          authUserCount: record.authUserCount,
          totalBackupBytes: record.totalBackupBytes,
          durationMs: record.durationMs,
        },
        bearerToken: input.bearerToken,
      });

      return { record, manifest, verification };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Backup gagal dijalankan.';
      const finishedAt = Date.now();
      record = {
        ...record,
        status: 'FAILED',
        completedAt: finishedAt,
        durationMs: finishedAt - startedAt,
        errorMessage: msg.slice(0, 500),
      };
      await this.saveBackupRecord(record, input.bearerToken).catch(() => {});
      await this.writeAuditLog({
        actorId: input.actorUid,
        actorRole: input.actorRole,
        action: 'BACKUP_FAILED',
        targetType: 'systemBackup',
        targetId: backupId,
        after: { status: 'FAILED', errorMessage: record.errorMessage },
        bearerToken: input.bearerToken,
      }).catch(() => {});
      throw err;
    } finally {
      await this.persistBackupLock(
        {
          id: 'backupLock',
          locked: false,
          operationId: null,
          backupId: null,
          lockedBy: null,
          lockedAt: null,
          updatedAt: Date.now(),
        },
        input.bearerToken
      ).catch(() => {
        this.localBackupLock.locked = false;
      });
    }
  }

  // ---------- VERIFY BACKUP (MODULE 8) ----------
  public async verifySystemBackup(input: {
    backupId: string;
    actorUid: string;
    actorRole: AdminRole;
    bearerToken?: string;
  }): Promise<BackupVerificationResult> {
    const safeId = path.basename(input.backupId);
    const backupDir = path.join(this.backupsRoot, safeId);
    const manifestPath = path.join(backupDir, 'manifest.json');
    const checks: BackupVerificationCheck[] = [];

    let manifest: BackupManifest | null = null;

    // 1. Manifest exists & valid structure
    if (!fs.existsSync(manifestPath)) {
      checks.push({
        code: 'MANIFEST_EXISTS',
        label: 'Keberadaan & Struktur Manifest',
        passed: false,
        detail: 'File manifest.json tidak ditemukan.',
      });
    } else {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest;
        const struct = validateBackupManifestStructure(parsed);
        manifest = struct.valid ? parsed : null;
        checks.push({
          code: 'MANIFEST_EXISTS',
          label: 'Keberadaan & Struktur Manifest',
          passed: struct.valid,
          detail: struct.valid
            ? `Manifest valid (${parsed.backupId}, schema ${parsed.schemaVersion}).`
            : struct.errors.join(' '),
        });
      } catch (e) {
        checks.push({
          code: 'MANIFEST_EXISTS',
          label: 'Keberadaan & Struktur Manifest',
          passed: false,
          detail: `JSON manifest korup: ${e instanceof Error ? e.message : 'parse error'}`,
        });
      }
    }

    if (manifest) {
      // 2. Manifest checksum recomputation
      const { manifestChecksumSha256, ...rest } = manifest;
      const expectedHash = sha256Buffer(JSON.stringify(rest));
      const hashMatches = expectedHash === manifestChecksumSha256;
      checks.push({
        code: 'MANIFEST_CHECKSUM',
        label: 'Checksum SHA-256 Manifest',
        passed: hashMatches,
        detail: hashMatches
          ? `Checksum cocok (${expectedHash.slice(0, 16)}…).`
          : 'Checksum manifest tidak cocok — file kemungkinan telah diubah atau korup.',
      });

      // 3. Schema & app compatibility
      const compat = checkBackupSchemaCompatibility(manifest);
      checks.push({
        code: 'SCHEMA_COMPATIBILITY',
        label: 'Kompatibilitas Schema & App Version',
        passed: compat.compatible,
        detail: compat.compatible
          ? `Schema ${manifest.schemaVersion} & App v${manifest.appVersion} kompatibel.`
          : compat.reason || 'Versi schema tidak kompatibel.',
      });

      // 4 & 5. Firestore files exist, doc counts match, SHA-256 matches, zero password leaks
      const missingCols: string[] = [];
      const checksumMismatches: string[] = [];
      const countMismatches: string[] = [];
      const passwordLeaks: string[] = [];
      const presentCols = new Set<string>();

      for (const summary of manifest.firestoreCollections) {
        presentCols.add(summary.collection);
        const colPath = path.join(backupDir, 'firestore', `${summary.collection}.json`);
        if (!fs.existsSync(colPath)) {
          missingCols.push(summary.collection);
          continue;
        }
        const buf = fs.readFileSync(colPath);
        if (sha256Buffer(buf) !== summary.checksumSha256) {
          checksumMismatches.push(summary.collection);
        }
        try {
          const parsedDocs = JSON.parse(buf.toString('utf8'));
          if (!Array.isArray(parsedDocs) || parsedDocs.length !== summary.documentCount) {
            countMismatches.push(
              `${summary.collection} (manifest: ${summary.documentCount}, aktual: ${
                Array.isArray(parsedDocs) ? parsedDocs.length : 'invalid'
              })`
            );
          }
          const leaks = detectForbiddenPasswordFields(parsedDocs);
          if (leaks.length > 0) {
            passwordLeaks.push(`${summary.collection}: ${leaks[0]}`);
          }
        } catch {
          countMismatches.push(`${summary.collection} (JSON korup)`);
        }
      }

      checks.push({
        code: 'FIRESTORE_FILES_AND_COUNTS',
        label: 'Kelengkapan File & Jumlah Dokumen Firestore',
        passed: missingCols.length === 0 && countMismatches.length === 0,
        detail:
          missingCols.length === 0 && countMismatches.length === 0
            ? `${manifest.firestoreCollections.length} koleksi & ${manifest.totalDocuments} dokumen terverifikasi.`
            : `Masalah: hilang=[${missingCols.join(', ')}], jumlah=[${countMismatches.join(', ')}]`,
      });

      checks.push({
        code: 'FIRESTORE_CHECKSUMS',
        label: 'Integritas Checksum SHA-256 Firestore',
        passed: checksumMismatches.length === 0,
        detail:
          checksumMismatches.length === 0
            ? 'Seluruh checksum koleksi Firestore cocok 100%.'
            : `Checksum tidak cocok pada: ${checksumMismatches.join(', ')}`,
      });

      // 6. Auth metadata verification
      const authPath = path.join(backupDir, 'auth', 'users_metadata.json');
      let authOk = false;
      let authDetail = 'File auth/users_metadata.json tidak ditemukan.';
      if (fs.existsSync(authPath)) {
        const authBuf = fs.readFileSync(authPath);
        const authHashOk = sha256Buffer(authBuf) === manifest.authChecksumSha256;
        try {
          const parsedAuth = JSON.parse(authBuf.toString('utf8'));
          const leaks = detectForbiddenPasswordFields(parsedAuth);
          if (leaks.length > 0) passwordLeaks.push(`auth: ${leaks[0]}`);
          const countOk = Array.isArray(parsedAuth) && parsedAuth.length === manifest.authUserCount;
          authOk = authHashOk && countOk;
          authDetail = authOk
            ? `${manifest.authUserCount} metadata akun valid (mode: ${manifest.authExportMode}).`
            : `Checksum atau jumlah user metadata tidak cocok.`;
        } catch {
          authDetail = 'File auth/users_metadata.json korup.';
        }
      }
      checks.push({
        code: 'AUTH_METADATA',
        label: 'Integritas Metadata Auth (Tanpa Password)',
        passed: authOk,
        detail: authDetail,
      });

      // 7. Storage manifest & physical files verification
      const storageManifestPath = path.join(backupDir, 'storage', 'storage_manifest.json');
      let storageOk = false;
      let storageDetail = 'storage_manifest.json tidak ditemukan.';
      if (fs.existsSync(storageManifestPath)) {
        const smBuf = fs.readFileSync(storageManifestPath);
        const smHashOk = sha256Buffer(smBuf) === manifest.storageManifestChecksumSha256;
        const missingStorage: string[] = [];
        const corruptStorage: string[] = [];
        for (const entry of manifest.storageFiles) {
          const filePath = path.join(backupDir, 'storage', 'files', entry.relativePath);
          if (!fs.existsSync(filePath)) {
            missingStorage.push(entry.relativePath);
            continue;
          }
          const fBuf = fs.readFileSync(filePath);
          if (fBuf.byteLength !== entry.byteSize || sha256Buffer(fBuf) !== entry.checksumSha256) {
            corruptStorage.push(entry.relativePath);
          }
        }
        storageOk = smHashOk && missingStorage.length === 0 && corruptStorage.length === 0;
        storageDetail = storageOk
          ? `${manifest.storageFileCount} file storage terverifikasi (checksum & ukuran cocok).`
          : `Storage error: manifestHash=${smHashOk}, hilang=${missingStorage.length}, korup=${corruptStorage.length}.`;
      }
      checks.push({
        code: 'STORAGE_INTEGRITY',
        label: 'Kelengkapan & Checksum Objek Storage',
        passed: storageOk,
        detail: storageDetail,
      });

      // 8. Zero password plaintext/hash leaks
      checks.push({
        code: 'NO_PASSWORD_SECRETS',
        label: 'Keamanan: Nol Field Password/Hash di Backup',
        passed: passwordLeaks.length === 0,
        detail:
          passwordLeaks.length === 0
            ? 'Terverifikasi tidak ada field password/hash terlarang dalam backup.'
            : `Ditemukan field terlarang: ${passwordLeaks.slice(0, 5).join(', ')}`,
      });

      // 9. Core collections present
      const requiredCore = ['members', 'levels', 'systemSettings'];
      const missingCore = requiredCore.filter((c) => !presentCols.has(c));
      checks.push({
        code: 'CORE_COLLECTIONS',
        label: 'Koleksi Inti XP PLAY Lengkap',
        passed: missingCore.length === 0,
        detail:
          missingCore.length === 0
            ? 'Koleksi inti (members, levels, systemSettings) lengkap.'
            : `Koleksi inti hilang: ${missingCore.join(', ')}`,
      });
    }

    const passed = checks.length > 0 && checks.every((c) => c.passed);
    const verifiedAt = Date.now();
    const result: BackupVerificationResult = {
      backupId: safeId,
      verifiedAt,
      verifiedBy: input.actorUid,
      passed,
      status: passed ? 'VERIFIED' : 'VERIFICATION_FAILED',
      checks,
    };

    // Update Firestore backup record if it exists
    const existingDoc = await this.store
      .getDocument('systemBackups', safeId, input.bearerToken)
      .catch(() => null);
    if (existingDoc) {
      const updatedRecord: SystemBackupRecord = {
        ...(existingDoc as unknown as SystemBackupRecord),
        verified: passed,
        verifiedAt,
        verificationStatus: result.status,
        verificationSummary: passed
          ? `${checks.length}/${checks.length} pemeriksaan integritas lulus.`
          : `Gagal pada: ${checks
              .filter((c) => !c.passed)
              .map((c) => c.label)
              .join(', ')}`,
        status: passed
          ? ((existingDoc.status as SystemBackupRecord['status']) === 'VERIFYING'
              ? 'COMPLETED'
              : (existingDoc.status as SystemBackupRecord['status']))
          : 'VERIFICATION_FAILED',
      };
      await this.saveBackupRecord(updatedRecord, input.bearerToken).catch(() => {});
    }

    await this.writeAuditLog({
      actorId: input.actorUid,
      actorRole: input.actorRole,
      action: passed ? 'BACKUP_VERIFIED' : 'BACKUP_VERIFICATION_FAILED',
      targetType: 'systemBackup',
      targetId: safeId,
      after: {
        status: result.status,
        passedChecks: checks.filter((c) => c.passed).length,
        totalChecks: checks.length,
      },
      bearerToken: input.bearerToken,
    }).catch(() => {});

    return result;
  }

  public readBackupManifestFromDisk(backupId: string): BackupManifest | null {
    const safeId = path.basename(backupId);
    const manifestPath = path.join(this.backupsRoot, safeId, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest;
    } catch {
      return null;
    }
  }

  public async listSystemBackups(bearerToken?: string): Promise<SystemBackupRecord[]> {
    const docs = await this.store.listCollection('systemBackups', bearerToken);
    return docs
      .map((d) => d.data as unknown as SystemBackupRecord)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  public async listRestoreJobs(bearerToken?: string): Promise<RestoreJobRecord[]> {
    const docs = await this.store.listCollection('restoreJobs', bearerToken);
    return docs
      .map((d) => d.data as unknown as RestoreJobRecord)
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }

  public async getBackupRetention(bearerToken?: string): Promise<BackupRetentionConfig> {
    const docData = await this.store
      .getDocument('systemOperations', 'backupRetention', bearerToken)
      .catch(() => null);
    if (!docData) return { ...DEFAULT_BACKUP_RETENTION };
    return {
      ...DEFAULT_BACKUP_RETENTION,
      ...(docData as Partial<BackupRetentionConfig>),
      id: 'backupRetention',
    };
  }

  public async saveBackupRetention(input: {
    dailyRetentionCount: number;
    weeklyRetentionCount: number;
    monthlyRetentionCount: number;
    customMaxAgeDays: number;
    alwaysKeepLatestSuccessful: boolean;
    alwaysKeepLatestPreRestore: boolean;
    actorUid: string;
    actorRole: AdminRole;
    bearerToken?: string;
  }): Promise<BackupRetentionConfig> {
    const clampInt = (v: number, min: number, max: number) =>
      Math.max(min, Math.min(max, Math.round(Number(v) || min)));

    const config: BackupRetentionConfig = {
      id: 'backupRetention',
      dailyRetentionCount: clampInt(input.dailyRetentionCount, 1, 90),
      weeklyRetentionCount: clampInt(input.weeklyRetentionCount, 1, 52),
      monthlyRetentionCount: clampInt(input.monthlyRetentionCount, 1, 36),
      customMaxAgeDays: clampInt(input.customMaxAgeDays, 7, 3650),
      alwaysKeepLatestSuccessful: Boolean(input.alwaysKeepLatestSuccessful),
      alwaysKeepLatestPreRestore: Boolean(input.alwaysKeepLatestPreRestore),
      updatedAt: Date.now(),
      updatedBy: input.actorUid,
    };

    await this.store.setDocument(
      'systemOperations',
      'backupRetention',
      config as unknown as Record<string, unknown>,
      input.bearerToken
    );

    await this.writeAuditLog({
      actorId: input.actorUid,
      actorRole: input.actorRole,
      action: 'BACKUP_RETENTION_UPDATED',
      targetType: 'systemOperations',
      targetId: 'backupRetention',
      after: config as unknown as Record<string, unknown>,
      bearerToken: input.bearerToken,
    });

    return config;
  }

  public async deleteSystemBackup(input: {
    backupId: string;
    actorUid: string;
    actorRole: AdminRole;
    bearerToken?: string;
  }): Promise<void> {
    const safeId = path.basename(input.backupId);
    const allBackups = await this.listSystemBackups(input.bearerToken);
    const target = allBackups.find((b) => b.backupId === safeId);
    if (!target) {
      throw new Error('Data backup tidak ditemukan.');
    }
    const retention = await this.getBackupRetention(input.bearerToken);
    const guard = canDeleteBackupRecord(
      target,
      allBackups,
      retention,
      this.localBackupLock,
      this.localRestoreLock.backupId
    );
    if (!guard.allowed) {
      throw new Error(guard.reason || 'Backup dilindungi kebijakan retensi dan tidak dapat dihapus.');
    }

    const backupDir = path.join(this.backupsRoot, safeId);
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
    await this.store.deleteDocument('systemBackups', safeId, input.bearerToken);

    await this.writeAuditLog({
      actorId: input.actorUid,
      actorRole: input.actorRole,
      action: 'BACKUP_DELETED',
      targetType: 'systemBackup',
      targetId: safeId,
      before: { kind: target.kind, status: target.status, createdAt: target.createdAt },
      bearerToken: input.bearerToken,
    });
  }

  // ---------- 12-POINT LIVE INTEGRITY AUDIT (MODULE 18) ----------
  public async runLiveIntegrityAudit(input: {
    actorUid: string;
    actorRole: AdminRole;
    bearerToken?: string;
    writeAudit?: boolean;
  }): Promise<IntegrityAuditReport> {
    const [
      membersDocs,
      levelsDocs,
      progDocs,
      rewDocs,
      refDocs,
      claimDocs,
      redDocs,
      txDocs,
      campDocs,
      benDocs,
      cmsPub,
      cmsDraft,
    ] = await Promise.all([
      this.store.listCollection('members', input.bearerToken),
      this.store.listCollection('levels', input.bearerToken),
      this.store.listCollection('xpProgressLedger', input.bearerToken),
      this.store.listCollection('xpRewardLedger', input.bearerToken),
      this.store.listCollection('referrals', input.bearerToken),
      this.store.listCollection('claims', input.bearerToken),
      this.store.listCollection('redemptions', input.bearerToken),
      this.store.listCollection('transactions', input.bearerToken),
      this.store.listCollection('campaigns', input.bearerToken),
      this.store.listCollection('benefits', input.bearerToken),
      this.store.getDocument('cmsPublished', 'homepage', input.bearerToken).catch(() => null),
      this.store.getDocument('cmsDrafts', 'homepage', input.bearerToken).catch(() => null),
    ]);

    const storageSet = new Set(this.listLocalStorageFiles().map((f) => f.relativePath));
    const auditId = makeUniqueId('intg');

    const report = runDataIntegrityChecks(
      {
        members: membersDocs.map((d) => d.data as unknown as MemberProfile),
        levels: levelsDocs.map((d) => d.data as unknown as LevelConfig),
        xpProgressLedger: progDocs.map((d) => d.data as unknown as XpLedgerEntry),
        xpRewardLedger: rewDocs.map((d) => d.data as unknown as XpLedgerEntry),
        referrals: refDocs.map((d) => d.data as unknown as ReferralRecord),
        claims: claimDocs.map((d) => d.data as unknown as ClaimRecord),
        redemptions: redDocs.map((d) => d.data as unknown as RedemptionRecord),
        transactions: txDocs.map((d) => d.data as unknown as TransactionRecord),
        campaigns: campDocs.map((d) => d.data as unknown as CampaignItem),
        benefits: benDocs.map((d) => d.data as unknown as BenefitItem),
        cmsPublished: cmsPub as unknown as CmsPublishedDoc | null,
        cmsDraft: cmsDraft as unknown as CmsDraftDoc | null,
        existingStoragePaths: storageSet,
      },
      { auditId, checkedBy: input.actorUid }
    );

    if (input.writeAudit !== false) {
      await this.writeAuditLog({
        actorId: input.actorUid,
        actorRole: input.actorRole,
        action: 'DATA_INTEGRITY_AUDIT',
        targetType: 'system',
        targetId: auditId,
        after: {
          passed: report.passed,
          passedChecks: report.passedChecks,
          totalChecks: report.totalChecks,
          criticalCount: report.criticalCount,
          warningCount: report.warningCount,
        },
        bearerToken: input.bearerToken,
      }).catch(() => {});
    }

    return report;
  }

  // ---------- RESTORE PREVIEW (MODULES 13 & 14) ----------
  public async previewRestore(input: {
    backupId: string;
    actorUid: string;
    actorRole: AdminRole;
    bearerToken?: string;
  }): Promise<RestorePreviewResult> {
    const safeId = path.basename(input.backupId);
    const blockingReasons: string[] = [];
    const warnings: string[] = [];

    if (this.localRestoreLock.locked) {
      blockingReasons.push('Proses restore lain sedang aktif berjalan.');
    }
    if (this.localBackupLock.locked) {
      blockingReasons.push('Proses backup sedang berjalan. Tunggu hingga selesai sebelum restore.');
    }

    const backupDoc = await this.store
      .getDocument('systemBackups', safeId, input.bearerToken)
      .catch(() => null);
    if (!backupDoc) {
      blockingReasons.push('Metadata backup tidak ditemukan di database.');
    } else if (backupDoc.status !== 'COMPLETED') {
      blockingReasons.push(
        `Backup berstatus "${String(backupDoc.status)}" dan tidak boleh di-restore (hanya status COMPLETED).`
      );
    }

    const verification = await this.verifySystemBackup({
      backupId: safeId,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      bearerToken: input.bearerToken,
    });
    if (!verification.passed) {
      blockingReasons.push(
        `Verifikasi integritas backup gagal (${verification.checks
          .filter((c) => !c.passed)
          .map((c) => c.label)
          .join(', ')}).`
      );
    }

    const manifest = this.readBackupManifestFromDisk(safeId);
    if (!manifest) {
      return {
        backupId: safeId,
        compatible: false,
        canProceed: false,
        blockingReasons: [...blockingReasons, 'File manifest.json backup tidak tersedia di server.'],
        warnings,
        backupCreatedAt: Number(backupDoc?.createdAt ?? 0),
        backupScopeType: (backupDoc?.scopeType as RestorePreviewResult['backupScopeType']) ?? 'FIRESTORE_AND_STORAGE_BACKUP',
        backupAppVersion: String(backupDoc?.appVersion ?? '-'),
        backupSchemaVersion: String(backupDoc?.schemaVersion ?? '-'),
        currentAppVersion: CURRENT_APP_VERSION,
        currentSchemaVersion: CURRENT_SCHEMA_VERSION,
        collections: [],
        liveStorageCount: this.listLocalStorageFiles().length,
        backupStorageCount: 0,
        backupAuthUserCount: 0,
        requiresConfirmationPhrase: RESTORE_CONFIRMATION_PHRASE,
      };
    }

    const compat = checkBackupSchemaCompatibility(manifest);
    if (!compat.compatible && compat.reason) {
      blockingReasons.push(compat.reason);
    }

    if (manifest.scopeType !== 'FULL_SYSTEM_BACKUP') {
      warnings.push(
        'Backup ini bertipe FIRESTORE_AND_STORAGE_BACKUP (tanpa ekspor langsung Firebase Auth Admin SDK). Password akun tidak terpengaruh.'
      );
    }
    warnings.push(
      'Semua data bisnis (member, transaksi, XP, level, claims, redemptions, CMS, settings) akan dikembalikan ke waktu backup. Sistem akan otomatis membuat Pre-Restore Backup terlebih dahulu.'
    );
    warnings.push(
      'Koleksi sistem (auditLogs, systemBackups, restoreJobs, systemOperations) dilindungi dan TIDAK akan dihapus selama restore.'
    );

    const backupCountMap = new Map(
      manifest.firestoreCollections.map((c) => [c.collection, c.documentCount])
    );

    const collections: RestorePreviewCollectionDiff[] = [];
    for (const col of BACKUP_COLLECTIONS) {
      const liveDocs = await this.store.listCollection(col, input.bearerToken);
      const backupCount = backupCountMap.get(col) ?? 0;
      collections.push({
        collection: col,
        liveCount: liveDocs.length,
        backupCount,
        delta: backupCount - liveDocs.length,
        protectedFromOverwrite: PROTECTED_SYSTEM_COLLECTIONS.includes(col),
      });
    }

    const liveStorageCount = this.listLocalStorageFiles().length;

    return {
      backupId: safeId,
      compatible: compat.compatible,
      canProceed: blockingReasons.length === 0,
      blockingReasons,
      warnings,
      backupCreatedAt: manifest.createdAt,
      backupScopeType: manifest.scopeType,
      backupAppVersion: manifest.appVersion,
      backupSchemaVersion: manifest.schemaVersion,
      currentAppVersion: CURRENT_APP_VERSION,
      currentSchemaVersion: CURRENT_SCHEMA_VERSION,
      collections,
      liveStorageCount,
      backupStorageCount: manifest.storageFileCount,
      backupAuthUserCount: manifest.authUserCount,
      requiresConfirmationPhrase: RESTORE_CONFIRMATION_PHRASE,
    };
  }

  // ---------- EXECUTE FULL SYSTEM RESTORE (MODULES 11-20, TESTS 7, 8, 9, 10) ----------
  public async executeRestore(input: {
    backupId: string;
    confirmationPhrase: string;
    reason: string;
    actorUid: string;
    actorEmail: string;
    actorRole: AdminRole;
    bearerToken?: string;
    /** Optional test hook executed right after restore writes and before verification */
    onBeforeVerificationHook?: () => Promise<void>;
  }): Promise<RestoreJobRecord> {
    if (input.actorRole !== 'SUPER_ADMIN') {
      const err = new Error('Hanya SUPER_ADMIN yang diizinkan menjalankan Full System Restore.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 403;
      throw err;
    }

    if (!validateRestoreConfirmationPhrase(input.confirmationPhrase)) {
      const err = new Error(
        `Frasa konfirmasi tidak cocok. Ketik persis "${RESTORE_CONFIRMATION_PHRASE}" untuk melanjutkan.`
      ) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    const cleanReason = (input.reason || '').trim().slice(0, 300);
    if (cleanReason.length < 3) {
      const err = new Error('Alasan restore wajib diisi (minimal 3 karakter).') as Error & {
        statusCode?: number;
      };
      err.statusCode = 400;
      throw err;
    }

    // Concurrency & collision guard (MODULE 10 & 12)
    if (this.localRestoreLock.locked) {
      const err = new Error(
        `Restore lain sedang berjalan (${this.localRestoreLock.restoreJobId}). Restore paralel dilarang.`
      ) as Error & { statusCode?: number; code?: string };
      err.statusCode = 409;
      err.code = 'RESTORE_IN_PROGRESS';
      throw err;
    }
    if (this.localBackupLock.locked) {
      const err = new Error(
        `Backup sedang berjalan (${this.localBackupLock.backupId}). Tunggu backup selesai sebelum menjalankan restore.`
      ) as Error & { statusCode?: number; code?: string };
      err.statusCode = 409;
      err.code = 'BACKUP_IN_PROGRESS';
      throw err;
    }

    const safeId = path.basename(input.backupId);
    const startedAt = Date.now();
    const restoreJobId = `restore_${makeTimestampSlug(startedAt)}_${crypto.randomBytes(4).toString('hex')}`;
    const operationId = makeUniqueId('op_rst');
    const steps: RestoreStepLog[] = [];

    const pushStep = (step: string, detail: string): RestoreStepLog => {
      const entry: RestoreStepLog = {
        step,
        status: 'RUNNING',
        startedAt: Date.now(),
        finishedAt: null,
        detail,
      };
      steps.push(entry);
      return entry;
    };
    const finishStep = (entry: RestoreStepLog, status: RestoreStepLog['status'], detail?: string) => {
      entry.status = status;
      entry.finishedAt = Date.now();
      if (detail) entry.detail = detail;
    };

    let job: RestoreJobRecord = {
      restoreJobId,
      operationId,
      targetBackupId: safeId,
      preRestoreBackupId: null,
      status: 'VALIDATING',
      requestedBy: input.actorUid,
      requestedByEmail: input.actorEmail,
      requestedByRole: input.actorRole,
      reason: cleanReason,
      startedAt,
      completedAt: null,
      durationMs: null,
      steps,
      restoredCollectionCounts: {},
      expectedCollectionCounts: {},
      restoredStorageCount: 0,
      expectedStorageCount: 0,
      authRestoreMode: 'SKIPPED_NO_ADMIN_SDK',
      authRestoreNotice: '',
      postRestoreVerificationPassed: false,
      integrityReport: null,
      errorMessage: null,
      recoveryRecommendation: null,
    };

    // Acquire local restore lock synchronously right now so concurrent requests immediately see locked=true
    this.localRestoreLock = {
      id: 'restoreLock',
      locked: true,
      state: 'RESTORE_IN_PROGRESS',
      restoreJobId,
      backupId: safeId,
      lockedBy: input.actorUid,
      lockedByEmail: null,
      lockedAt: startedAt,
      updatedAt: startedAt,
      message: RESTORE_MAINTENANCE_MESSAGE,
    };

    let remoteLockEnabled = false;

    try {
      await this.saveRestoreJobRecord(job, input.bearerToken);
      await this.writeAuditLog({
        actorId: input.actorUid,
        actorRole: input.actorRole,
        action: 'RESTORE_REQUESTED',
        targetType: 'restoreJob',
        targetId: restoreJobId,
        after: { targetBackupId: safeId, reason: cleanReason, operationId },
        bearerToken: input.bearerToken,
      });

      // STEP 1: Validate target backup record, manifest, checksums & compatibility
      const sValidate = pushStep('VALIDATE_BACKUP', 'Memvalidasi status, manifest, checksum & kompatibilitas backup.');
      const targetDoc = await this.store.getDocument('systemBackups', safeId, input.bearerToken);
      if (!targetDoc || targetDoc.status !== 'COMPLETED') {
        finishStep(sValidate, 'FAILED', 'Target backup tidak ada atau tidak berstatus COMPLETED.');
        throw new Error('Target backup tidak valid atau belum berstatus COMPLETED.');
      }

      const verifyRes = await this.verifySystemBackup({
        backupId: safeId,
        actorUid: input.actorUid,
        actorRole: input.actorRole,
        bearerToken: input.bearerToken,
      });
      if (!verifyRes.passed) {
        finishStep(sValidate, 'FAILED', 'Verifikasi checksum/file backup gagal.');
        throw new Error(
          `Restore dibatalkan karena verifikasi backup gagal: ${verifyRes.checks
            .filter((c) => !c.passed)
            .map((c) => c.label)
            .join(', ')}`
        );
      }

      const manifest = this.readBackupManifestFromDisk(safeId);
      if (!manifest) {
        finishStep(sValidate, 'FAILED', 'Manifest backup tidak terbaca.');
        throw new Error('Manifest backup tidak dapat dibaca.');
      }
      const compat = checkBackupSchemaCompatibility(manifest);
      if (!compat.compatible) {
        finishStep(sValidate, 'FAILED', compat.reason || 'Schema tidak kompatibel.');
        throw new Error(compat.reason || 'Schema backup tidak kompatibel.');
      }
      finishStep(sValidate, 'DONE', `Backup ${safeId} lulus validasi penuh.`);

      const expectedCounts: Record<string, number> = {};
      for (const c of manifest.firestoreCollections) {
        if (!PROTECTED_SYSTEM_COLLECTIONS.includes(c.collection)) {
          expectedCounts[c.collection] = c.documentCount;
        }
      }
      job.expectedCollectionCounts = expectedCounts;
      job.expectedStorageCount = manifest.storageFileCount;

      // STEP 2: Persist Restore Lock / Maintenance Mode (MODULE 12)
      job.status = 'LOCKING';
      const sLock = pushStep('ENABLE_RESTORE_LOCK', 'Mengaktifkan Restore Lock & Maintenance Mode.');
      await this.persistRestoreLock(this.localRestoreLock, input.bearerToken);
      remoteLockEnabled = true;
      await this.writeAuditLog({
        actorId: input.actorUid,
        actorRole: input.actorRole,
        action: 'RESTORE_LOCK_ENABLED',
        targetType: 'systemOperations',
        targetId: 'restoreLock',
        after: { restoreJobId, targetBackupId: safeId, state: 'RESTORE_IN_PROGRESS' },
        bearerToken: input.bearerToken,
      });
      finishStep(sLock, 'DONE', 'Restore Lock aktif — seluruh write operasional & portal member diblokir.');
      await this.saveRestoreJobRecord(job, input.bearerToken);

      // STEP 3: Mandatory Pre-Restore Backup (MODULE 11, TEST 7)
      job.status = 'PRE_RESTORE_BACKUP';
      const sPre = pushStep(
        'PRE_RESTORE_BACKUP',
        'Membuat Pre-Restore Backup dari kondisi sistem live sebelum menimpa data.'
      );
      await this.saveRestoreJobRecord(job, input.bearerToken);

      const preBackup = await this.createSystemBackup({
        kind: 'PRE_RESTORE',
        note: `Pre-Restore safety snapshot sebelum restore ke ${safeId} (Job: ${restoreJobId})`,
        actorUid: input.actorUid,
        actorEmail: input.actorEmail,
        actorRole: input.actorRole,
        bearerToken: input.bearerToken,
        allowDuringRestoreLock: true,
      });

      if (preBackup.record.status !== 'COMPLETED') {
        finishStep(sPre, 'FAILED', 'Pre-Restore Backup gagal verifikasi.');
        throw new Error('Pre-Restore Backup gagal selesai/verifikasi. Restore dibatalkan demi keselamatan data.');
      }
      job.preRestoreBackupId = preBackup.record.backupId;
      await this.writeAuditLog({
        actorId: input.actorUid,
        actorRole: input.actorRole,
        action: 'PRE_RESTORE_BACKUP_CREATED',
        targetType: 'systemBackup',
        targetId: preBackup.record.backupId,
        after: { restoreJobId, targetBackupId: safeId, totalDocuments: preBackup.record.totalDocuments },
        bearerToken: input.bearerToken,
      });
      finishStep(sPre, 'DONE', `Pre-Restore Backup berhasil: ${preBackup.record.backupId}`);
      await this.saveRestoreJobRecord(job, input.bearerToken);

      // STEP 4: Restore Firestore Business & Config Collections (NEVER touch protected collections)
      job.status = 'RESTORING_FIRESTORE';
      const sFs = pushStep('RESTORE_FIRESTORE', 'Memulihkan koleksi Firestore bisnis & konfigurasi.');
      await this.saveRestoreJobRecord(job, input.bearerToken);

      const backupDir = path.join(this.backupsRoot, safeId);
      let totalRestoredDocs = 0;
      for (const colName of RESTORABLE_BUSINESS_COLLECTIONS) {
        if (PROTECTED_SYSTEM_COLLECTIONS.includes(colName)) continue;
        const colPath = path.join(backupDir, 'firestore', `${colName}.json`);
        const docs: StoredDocEntry[] = fs.existsSync(colPath)
          ? (JSON.parse(fs.readFileSync(colPath, 'utf8')) as StoredDocEntry[])
          : [];
        const written = await this.store.replaceCollection(colName, docs, input.bearerToken);
        totalRestoredDocs += written;
      }
      finishStep(
        sFs,
        'DONE',
        `${RESTORABLE_BUSINESS_COLLECTIONS.length} koleksi bisnis (${totalRestoredDocs} dokumen) dipulihkan.`
      );
      await this.saveRestoreJobRecord(job, input.bearerToken);

      // STEP 5: Restore Storage Objects (.uploads/claims & .uploads/cms)
      job.status = 'RESTORING_STORAGE';
      const sSto = pushStep('RESTORE_STORAGE', 'Memulihkan file storage bukti claim & aset CMS.');
      await this.saveRestoreJobRecord(job, input.bearerToken);

      for (const group of ['claims', 'cms'] as const) {
        const targetGroupDir = path.join(this.uploadsRoot, group);
        fs.rmSync(targetGroupDir, { recursive: true, force: true });
        fs.mkdirSync(targetGroupDir, { recursive: true });
      }
      for (const entry of manifest.storageFiles) {
        const src = path.join(backupDir, 'storage', 'files', entry.relativePath);
        const dest = path.join(this.uploadsRoot, entry.relativePath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
      finishStep(sSto, 'DONE', `${manifest.storageFiles.length} file storage berhasil dipulihkan.`);
      await this.saveRestoreJobRecord(job, input.bearerToken);

      // STEP 6: Restore Auth Metadata safely (never overwriting plaintext passwords)
      job.status = 'RESTORING_AUTH_METADATA';
      const sAuth = pushStep('RESTORE_AUTH_METADATA', 'Menyelaraskan metadata akun Auth sesuai kapabilitas SDK.');
      const authPath = path.join(backupDir, 'auth', 'users_metadata.json');
      const authUsers: AuthUserMetadataEntry[] = fs.existsSync(authPath)
        ? (JSON.parse(fs.readFileSync(authPath, 'utf8')) as AuthUserMetadataEntry[])
        : [];

      if (this.customAuthRestorer) {
        const authRes = await this.customAuthRestorer(authUsers);
        job.authRestoreMode = authRes.mode;
        job.authRestoreNotice = authRes.notice;
        finishStep(sAuth, authRes.mode === 'METADATA_SYNCED' ? 'DONE' : 'SKIPPED', authRes.notice);
      } else {
        const adminAuth = getAdminAuth();
        if (adminAuth && isAdminSdkAvailable()) {
          let synced = 0;
          for (const u of authUsers) {
            try {
              await adminAuth.updateUser(u.uid, {
                disabled: u.disabled,
                ...(u.displayName ? { displayName: u.displayName } : {}),
              });
              synced++;
            } catch {
              // User may not exist in Firebase Auth if created externally — do not abort restore
            }
          }
          job.authRestoreMode = 'METADATA_SYNCED';
          job.authRestoreNotice = `${synced}/${authUsers.length} metadata Auth (disabled/displayName) disinkronkan. Password dikelola aman oleh Firebase Auth.`;
          finishStep(sAuth, 'DONE', job.authRestoreNotice);
        } else {
          job.authRestoreMode = 'SKIPPED_NO_ADMIN_SDK';
          job.authRestoreNotice =
            'Sinkronisasi Firebase Auth metadata dilewati karena FIREBASE_SERVICE_ACCOUNT_JSON tidak aktif di environment ini. Password akun tetap utuh di Firebase Auth.';
          finishStep(sAuth, 'SKIPPED', job.authRestoreNotice);
        }
      }
      await this.saveRestoreJobRecord(job, input.bearerToken);

      // Optional test hook for simulating post-restore corruption in automated verification tests
      if (input.onBeforeVerificationHook) {
        await input.onBeforeVerificationHook();
      }

      // STEP 7: Post-Restore Verification + 12-Point Integrity Check (MODULES 17 & 18, TEST 10)
      job.status = 'VERIFYING';
      const sVerify = pushStep(
        'POST_RESTORE_VERIFICATION',
        'Membandingkan jumlah dokumen/file & menjalankan 12-Point Data Integrity Audit.'
      );
      await this.saveRestoreJobRecord(job, input.bearerToken);

      const restoredCounts: Record<string, number> = {};
      for (const colName of RESTORABLE_BUSINESS_COLLECTIONS) {
        const liveCol = await this.store.listCollection(colName, input.bearerToken);
        restoredCounts[colName] = liveCol.length;
      }
      const restoredStorageCount = this.listLocalStorageFiles().length;
      const integrityReport = await this.runLiveIntegrityAudit({
        actorUid: input.actorUid,
        actorRole: input.actorRole,
        bearerToken: input.bearerToken,
        writeAudit: false,
      });

      const evaluation = evaluatePostRestoreVerification({
        expectedCollectionCounts: expectedCounts,
        restoredCollectionCounts: restoredCounts,
        expectedStorageCount: manifest.storageFileCount,
        restoredStorageCount,
        integrityReport,
      });

      job.restoredCollectionCounts = restoredCounts;
      job.restoredStorageCount = restoredStorageCount;
      job.integrityReport = integrityReport;
      job.postRestoreVerificationPassed = evaluation.passed;

      const completedAt = Date.now();
      job.completedAt = completedAt;
      job.durationMs = completedAt - startedAt;

      if (!evaluation.passed) {
        job.status = 'VERIFICATION_FAILED';
        job.errorMessage = evaluation.mismatches.join(' | ').slice(0, 1000);
        job.recoveryRecommendation = job.preRestoreBackupId
          ? `Verifikasi pasca-restore gagal. Data backup target & Pre-Restore Backup (${job.preRestoreBackupId}) tetap aman tersimpan. Anda dapat meninjau temuan integritas atau melakukan rollback ke ${job.preRestoreBackupId}.`
          : 'Verifikasi pasca-restore gagal. Tinjau temuan integritas sebelum melanjutkan operasi normal.';
        finishStep(sVerify, 'FAILED', job.errorMessage);
        await this.saveRestoreJobRecord(job, input.bearerToken);

        await this.writeAuditLog({
          actorId: input.actorUid,
          actorRole: input.actorRole,
          action: 'RESTORE_VERIFICATION_FAILED',
          targetType: 'restoreJob',
          targetId: restoreJobId,
          after: {
            status: 'VERIFICATION_FAILED',
            targetBackupId: safeId,
            preRestoreBackupId: job.preRestoreBackupId,
            mismatches: evaluation.mismatches.slice(0, 10),
            integrityCriticalCount: integrityReport.criticalCount,
          },
          bearerToken: input.bearerToken,
        });

        return job;
      }

      job.status = 'COMPLETED';
      finishStep(
        sVerify,
        'DONE',
        `Seluruh jumlah koleksi, ${restoredStorageCount} file storage, dan 12/12 Data Integrity Checks LULUS.`
      );
      await this.saveRestoreJobRecord(job, input.bearerToken);

      await this.writeAuditLog({
        actorId: input.actorUid,
        actorRole: input.actorRole,
        action: 'RESTORE_VERIFIED',
        targetType: 'restoreJob',
        targetId: restoreJobId,
        after: {
          passedChecks: integrityReport.passedChecks,
          totalChecks: integrityReport.totalChecks,
          restoredStorageCount,
        },
        bearerToken: input.bearerToken,
      });

      await this.writeAuditLog({
        actorId: input.actorUid,
        actorRole: input.actorRole,
        action: 'RESTORE_COMPLETED',
        targetType: 'restoreJob',
        targetId: restoreJobId,
        after: {
          status: 'COMPLETED',
          targetBackupId: safeId,
          preRestoreBackupId: job.preRestoreBackupId,
          durationMs: job.durationMs,
        },
        bearerToken: input.bearerToken,
      });

      return job;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Restore gagal dijalankan.';
      const finishedAt = Date.now();
      job.status = 'FAILED';
      job.completedAt = finishedAt;
      job.durationMs = finishedAt - startedAt;
      job.errorMessage = msg.slice(0, 1000);
      job.recoveryRecommendation = job.preRestoreBackupId
        ? `Restore gagal di tengah proses. Pre-Restore Backup (${job.preRestoreBackupId}) dan Target Backup (${safeId}) tetap tersimpan utuh. Gunakan ${job.preRestoreBackupId} untuk rollback jika diperlukan.`
        : `Restore gagal sebelum menimpa data live. Data live Anda tetap aman dan backup target (${safeId}) tidak dihapus.`;

      await this.saveRestoreJobRecord(job, input.bearerToken).catch(() => {});
      await this.writeAuditLog({
        actorId: input.actorUid,
        actorRole: input.actorRole,
        action: 'RESTORE_FAILED',
        targetType: 'restoreJob',
        targetId: restoreJobId,
        after: {
          status: 'FAILED',
          targetBackupId: safeId,
          preRestoreBackupId: job.preRestoreBackupId,
          errorMessage: job.errorMessage,
        },
        bearerToken: input.bearerToken,
      }).catch(() => {});

      throw err;
    } finally {
      const idleLock: RestoreLockState = {
        id: 'restoreLock',
        locked: false,
        state: 'IDLE',
        restoreJobId: null,
        backupId: null,
        lockedBy: null,
        lockedByEmail: null,
        lockedAt: null,
        updatedAt: Date.now(),
        message: '',
      };
      this.localRestoreLock = { ...idleLock };
      if (remoteLockEnabled) {
        await this.persistRestoreLock(idleLock, input.bearerToken).catch(() => {});
        await this.writeAuditLog({
          actorId: input.actorUid,
          actorRole: input.actorRole,
          action: 'RESTORE_LOCK_DISABLED',
          targetType: 'systemOperations',
          targetId: 'restoreLock',
          after: { state: 'IDLE', restoreJobId },
          bearerToken: input.bearerToken,
        }).catch(() => {});
      }
    }
  }

  public async forceReleaseRestoreLock(input: {
    reason: string;
    actorUid: string;
    actorRole: AdminRole;
    bearerToken?: string;
  }): Promise<RestoreLockState> {
    if (input.actorRole !== 'SUPER_ADMIN') {
      throw new Error('Hanya SUPER_ADMIN yang dapat melepas Restore Lock darurat.');
    }
    const cleanReason = (input.reason || '').trim().slice(0, 300);
    if (cleanReason.length < 3) {
      throw new Error('Alasan pelepasan Restore Lock wajib diisi.');
    }
    const idleLock: RestoreLockState = {
      id: 'restoreLock',
      locked: false,
      state: 'IDLE',
      restoreJobId: null,
      backupId: null,
      lockedBy: null,
      lockedByEmail: null,
      lockedAt: null,
      updatedAt: Date.now(),
      message: '',
    };
    await this.persistRestoreLock(idleLock, input.bearerToken);
    await this.writeAuditLog({
      actorId: input.actorUid,
      actorRole: input.actorRole,
      action: 'RESTORE_LOCK_DISABLED',
      targetType: 'systemOperations',
      targetId: 'restoreLock',
      after: { forced: true, reason: cleanReason, state: 'IDLE' },
      bearerToken: input.bearerToken,
    });
    return idleLock;
  }

  // ---------- SYSTEM HEALTH (MODULE 23 — 9 REAL COMPONENTS) ----------
  public async getSystemHealth(bearerToken?: string): Promise<SystemHealthReport> {
    const checkedAt = Date.now();
    const components: SystemHealthComponent[] = [];
    const adminSdkConfigured = isAdminSdkAvailable();

    // 1. Database Connectivity
    let dbOk = false;
    let settingsDoc: Record<string, unknown> | null = null;
    try {
      settingsDoc = await this.store.getDocument('systemSettings', 'default', bearerToken);
      dbOk = true;
      components.push({
        key: 'DATABASE',
        label: 'Database (Firestore)',
        status: 'HEALTHY',
        summary: 'Terhubung & responsif',
        detail: `Database ${firebaseAppletConfig.firestoreDatabaseId} dapat diakses normal.`,
      });
    } catch (e) {
      components.push({
        key: 'DATABASE',
        label: 'Database (Firestore)',
        status: 'ERROR',
        summary: 'Gagal terhubung ke Firestore',
        detail: e instanceof Error ? e.message : 'Koneksi database gagal.',
      });
    }

    // 2. Authentication Service
    components.push({
      key: 'AUTHENTICATION',
      label: 'Authentication Service',
      status: adminSdkConfigured ? 'HEALTHY' : 'WARNING',
      summary: adminSdkConfigured
        ? 'Firebase Auth + Admin SDK Aktif'
        : 'Client Auth Aktif (Admin SDK belum dikonfigurasi)',
      detail: adminSdkConfigured
        ? 'Verifikasi token, reset password member oleh admin, dan ekspor Auth penuh tersedia.'
        : 'Verifikasi token RS256 aktif. Fitur ubah password member & ekspor Auth penuh memerlukan FIREBASE_SERVICE_ACCOUNT_JSON.',
    });

    // 3. Storage Service
    let storageWritable = false;
    let storageFileCount = 0;
    try {
      fs.accessSync(this.uploadsRoot, fs.constants.R_OK | fs.constants.W_OK);
      storageWritable = true;
      storageFileCount = this.listLocalStorageFiles().length;
      components.push({
        key: 'STORAGE',
        label: 'Storage Service (Bukti & Aset CMS)',
        status: 'HEALTHY',
        summary: `${storageFileCount} file tersimpan`,
        detail: 'Direktori storage bukti claim & aset CMS dapat dibaca dan ditulis dengan normal.',
      });
    } catch {
      components.push({
        key: 'STORAGE',
        label: 'Storage Service (Bukti & Aset CMS)',
        status: 'ERROR',
        summary: 'Storage tidak dapat ditulis',
        detail: 'Direktori .uploads tidak memiliki izin baca/tulis.',
      });
    }

    // 4. XP Engine
    const levelsDocs = dbOk
      ? await this.store.listCollection('levels', bearerToken).catch(() => [])
      : [];
    const xpEngineHealthy = dbOk && levelsDocs.length >= 4 && settingsDoc !== null;
    components.push({
      key: 'XP_ENGINE',
      label: 'XP Engine & Konfigurasi Level',
      status: xpEngineHealthy ? 'HEALTHY' : dbOk ? 'WARNING' : 'ERROR',
      summary: xpEngineHealthy
        ? `4 Level & Rate Rp${Number(settingsDoc?.transactionXpRate ?? 2000).toLocaleString('id-ID')}/XP`
        : 'Konfigurasi XP/Level belum lengkap',
      detail: xpEngineHealthy
        ? `Cycle aktif: ${String(settingsDoc?.currentCycleId ?? '2026-S1')}.`
        : 'Pastikan systemSettings/default dan 4 dokumen levels telah terinisialisasi.',
    });

    // 5. CMS Config
    const cmsPub = dbOk
      ? await this.store.getDocument('cmsPublished', 'homepage', bearerToken).catch(() => null)
      : null;
    components.push({
      key: 'CMS_CONFIG',
      label: 'CMS Homepage Config',
      status: cmsPub ? 'HEALTHY' : 'WARNING',
      summary: cmsPub
        ? `Published v${Number(cmsPub.versionNumber ?? 1)}`
        : 'Menggunakan fallback default CMS',
      detail: cmsPub
        ? 'Dokumen cmsPublished/homepage aktif dan tersinkronisasi.'
        : 'Belum ada publish CMS dari Admin; tampilan menggunakan default aman.',
    });

    // 6. Backup Service
    let backupDirOk = false;
    try {
      fs.accessSync(this.backupsRoot, fs.constants.R_OK | fs.constants.W_OK);
      backupDirOk = true;
    } catch {
      backupDirOk = false;
    }
    components.push({
      key: 'BACKUP_SERVICE',
      label: 'Backup Service',
      status: !backupDirOk
        ? 'ERROR'
        : this.localBackupLock.locked
        ? 'MAINTENANCE'
        : storageWritable
        ? 'HEALTHY'
        : 'WARNING',
      summary: !backupDirOk
        ? 'Direktori backup tidak siap'
        : this.localBackupLock.locked
        ? `Sedang berjalan (${this.localBackupLock.backupId})`
        : 'Siap menjalankan backup terisolasi',
      detail: backupDirOk
        ? 'Penyimpanan backup terisolasi (.backups) aktif dengan proteksi collision.'
        : 'Direktori .backups tidak dapat diakses.',
    });

    // 7. Restore Lock Status
    const restoreLock = await this.getRestoreLockState(bearerToken);
    components.push({
      key: 'RESTORE_LOCK',
      label: 'Restore Lock & Maintenance Mode',
      status: restoreLock.locked ? 'MAINTENANCE' : 'HEALTHY',
      summary: restoreLock.locked ? 'LOCKED (RESTORE_IN_PROGRESS)' : 'IDLE (Operasional Normal)',
      detail: restoreLock.locked
        ? `Dikunci oleh ${restoreLock.lockedByEmail || restoreLock.lockedBy} untuk job ${restoreLock.restoreJobId}.`
        : 'Tidak ada proses restore aktif; seluruh endpoint & portal member normal.',
    });

    // 8 & 9. Last Backup & Last Verification
    const backups = dbOk ? await this.listSystemBackups(bearerToken).catch(() => []) : [];
    const latestBackup = backups[0] ?? null;
    const latestCompleted = backups.find((b) => b.status === 'COMPLETED') ?? null;

    if (!latestBackup) {
      components.push({
        key: 'LAST_BACKUP',
        label: 'Status Backup Terakhir',
        status: 'WARNING',
        summary: 'Belum pernah ada backup',
        detail: 'Disarankan membuat backup awal segera sebelum operasi produksi.',
      });
      components.push({
        key: 'LAST_VERIFICATION',
        label: 'Verifikasi Backup Terakhir',
        status: 'WARNING',
        summary: 'Belum ada hasil verifikasi',
        detail: 'Verifikasi otomatis dijalankan pada setiap pembuatan backup.',
      });
    } else {
      const ageHours = (checkedAt - (latestCompleted?.createdAt ?? latestBackup.createdAt)) / (3600 * 1000);
      components.push({
        key: 'LAST_BACKUP',
        label: 'Status Backup Terakhir',
        status:
          latestBackup.status === 'FAILED' || latestBackup.status === 'VERIFICATION_FAILED'
            ? 'ERROR'
            : ageHours > 168
            ? 'WARNING'
            : 'HEALTHY',
        summary: `${latestBackup.status} · ${latestBackup.backupId}`,
        detail: `Cakupan: ${latestBackup.scopeType} (${latestBackup.totalDocuments} dokumen, ${latestBackup.storageFileCount} file storage).`,
      });

      components.push({
        key: 'LAST_VERIFICATION',
        label: 'Verifikasi Backup Terakhir',
        status:
          latestBackup.verificationStatus === 'VERIFIED'
            ? 'HEALTHY'
            : latestBackup.verificationStatus === 'VERIFICATION_FAILED'
            ? 'ERROR'
            : 'WARNING',
        summary: latestBackup.verificationStatus,
        detail: latestBackup.verificationSummary || 'Belum diverifikasi.',
      });
    }

    const overallStatus: SystemHealthReport['overallStatus'] = restoreLock.locked
      ? 'MAINTENANCE'
      : components.some((c) => c.status === 'ERROR')
      ? 'ERROR'
      : components.some((c) => c.status === 'WARNING')
      ? 'WARNING'
      : 'HEALTHY';

    return {
      checkedAt,
      overallStatus,
      adminSdkConfigured,
      restoreLocked: restoreLock.locked,
      backupLocked: this.localBackupLock.locked,
      appVersion: CURRENT_APP_VERSION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      components,
    };
  }
}

export const backupRestoreEngine = new BackupRestoreEngine();
