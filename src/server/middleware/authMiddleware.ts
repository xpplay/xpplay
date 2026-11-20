import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  firebaseAppletConfig,
  getAdminDb,
  getBootstrapSuperAdminEmails,
  verifyFirebaseIdToken,
  type VerifiedTokenPayload,
} from '../firebaseServer.ts';
import {
  canAccessBranch,
  hasPermission,
  isCashierRole,
} from '../../shared/rbac.ts';
import type { AdminRole, BranchId, RolePermissionKey } from '../../types/xpplay.ts';

export interface AuthenticatedRequest extends Request {
  authUser?: VerifiedTokenPayload;
  adminRole?: AdminRole;
  adminBranchScope?: BranchId | 'ALL';
  adminBranchId?: BranchId | null;
}

async function logCashierDeniedAuditBestEffort(input: {
  req: AuthenticatedRequest;
  actorRole: AdminRole;
  reason: string;
  targetType?: string;
  targetId?: string;
}): Promise<void> {
  if (!isCashierRole(input.actorRole) || !input.req.authUser) return;
  const now = Date.now();
  const auditId = `audit_${now}_${crypto.randomBytes(4).toString('hex')}`;
  const db = getAdminDb();
  const payload = {
    id: auditId,
    actorId: input.req.authUser.uid,
    actorRole: input.actorRole,
    action: 'CASHIER_DENIED_ACTION',
    targetType: input.targetType || 'api_endpoint',
    targetId: input.targetId || input.req.originalUrl || input.req.path,
    before: null,
    after: null,
    metadata: {
      method: input.req.method,
      path: input.req.originalUrl || input.req.path,
      branchScope: input.req.adminBranchScope ?? null,
      reason: input.reason,
    },
    timestamp: now,
  };

  if (db) {
    await db.collection('auditLogs').doc(auditId).set(payload).catch(() => {});
  }
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Sesi tidak ditemukan. Silakan login kembali.' });
    return;
  }

  const token = authHeader.slice(7).trim();
  try {
    const decoded = await verifyFirebaseIdToken(token);
    req.authUser = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Sesi login tidak valid atau telah berakhir.' });
  }
}

async function resolveStaffAuthorization(
  req: AuthenticatedRequest
): Promise<{
  ok: boolean;
  statusCode: number;
  error?: string;
  role?: AdminRole;
  branchScope?: BranchId | 'ALL';
  branchId?: BranchId | null;
}> {
  if (!req.authUser) {
    return { ok: false, statusCode: 401, error: 'Autentikasi diperlukan.' };
  }

  const email = req.authUser.email?.toLowerCase() ?? '';
  const bootstrapEmails = getBootstrapSuperAdminEmails();

  if (req.authUser.emailVerified && email && bootstrapEmails.includes(email)) {
    return { ok: true, statusCode: 200, role: 'SUPER_ADMIN', branchScope: 'ALL', branchId: null };
  }

  const adminDb = getAdminDb();
  if (!adminDb) {
    if (!req.authUser.emailVerified) {
      return { ok: false, statusCode: 403, error: 'Email staff/admin belum terverifikasi.' };
    }
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!bearer) {
      return { ok: false, statusCode: 403, error: 'Akses ditolak.' };
    }
    try {
      const restUrl = `https://firestore.googleapis.com/v1/projects/${firebaseAppletConfig.projectId}/databases/${firebaseAppletConfig.firestoreDatabaseId}/documents/admins/${encodeURIComponent(req.authUser.uid)}`;
      const adminRes = await fetch(restUrl, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      if (!adminRes.ok) {
        return { ok: false, statusCode: 403, error: 'Akun Anda tidak memiliki hak akses staff/admin.' };
      }
      const docJson = (await adminRes.json()) as {
        fields?: {
          active?: { booleanValue?: boolean };
          role?: { stringValue?: AdminRole };
          branchScope?: { stringValue?: BranchId | 'ALL' };
          branchId?: { stringValue?: BranchId };
        };
      };
      const active = docJson.fields?.active?.booleanValue === true;
      const role = docJson.fields?.role?.stringValue;
      const branchScope = docJson.fields?.branchScope?.stringValue ?? 'ALL';
      const branchId = docJson.fields?.branchId?.stringValue ?? (branchScope !== 'ALL' ? branchScope : null);
      if (!active || !role) {
        return { ok: false, statusCode: 403, error: 'Akun staff/admin tidak aktif.' };
      }
      return { ok: true, statusCode: 200, role, branchScope, branchId };
    } catch {
      return { ok: false, statusCode: 403, error: 'Gagal memverifikasi otorisasi staff/admin.' };
    }
  }

  try {
    const snap = await adminDb.collection('admins').doc(req.authUser.uid).get();
    if (!snap.exists) {
      return { ok: false, statusCode: 403, error: 'Akun Anda tidak memiliki hak akses staff/admin.' };
    }
    const data = snap.data() as {
      active?: boolean;
      role?: AdminRole;
      branchScope?: BranchId | 'ALL';
      branchId?: BranchId | null;
    };
    if (!data.active || !data.role) {
      return { ok: false, statusCode: 403, error: 'Akun staff/admin tidak aktif.' };
    }
    const branchScope = data.branchScope ?? 'ALL';
    const branchId = data.branchId ?? (branchScope !== 'ALL' ? branchScope : null);
    return { ok: true, statusCode: 200, role: data.role, branchScope, branchId };
  } catch {
    return { ok: false, statusCode: 500, error: 'Gagal memverifikasi otorisasi staff/admin.' };
  }
}

export function requireAdminRole(allowedRoles: AdminRole[]) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const resolved = await resolveStaffAuthorization(req);
    if (!resolved.ok || !resolved.role) {
      res.status(resolved.statusCode).json({ error: resolved.error || 'Akses ditolak.' });
      return;
    }

    req.adminRole = resolved.role;
    req.adminBranchScope = resolved.branchScope ?? 'ALL';
    req.adminBranchId = resolved.branchId ?? null;

    if (!allowedRoles.includes(resolved.role)) {
      await logCashierDeniedAuditBestEffort({
        req,
        actorRole: resolved.role,
        reason: `Role ${resolved.role} tidak diizinkan mengakses endpoint ini (butuh: ${allowedRoles.join(', ')}).`,
      });
      res.status(403).json({
        code: 'FORBIDDEN_ROLE',
        error: 'Anda tidak memiliki izin (403 Forbidden) untuk melakukan tindakan ini.',
      });
      return;
    }

    next();
  };
}

export function requirePermission(permission: RolePermissionKey) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const resolved = await resolveStaffAuthorization(req);
    if (!resolved.ok || !resolved.role) {
      res.status(resolved.statusCode).json({ error: resolved.error || 'Akses ditolak.' });
      return;
    }

    req.adminRole = resolved.role;
    req.adminBranchScope = resolved.branchScope ?? 'ALL';
    req.adminBranchId = resolved.branchId ?? null;

    if (!hasPermission(resolved.role, permission)) {
      await logCashierDeniedAuditBestEffort({
        req,
        actorRole: resolved.role,
        reason: `Role ${resolved.role} tidak memiliki permission ${permission}.`,
      });
      res.status(403).json({
        code: 'FORBIDDEN_PERMISSION',
        error: `Akses ditolak (403): Role ${resolved.role} tidak memiliki izin ${permission}.`,
      });
      return;
    }

    next();
  };
}

export async function enforceBranchScopeInRequest(
  req: AuthenticatedRequest,
  res: Response,
  targetBranch: BranchId,
  operationLabel: string
): Promise<boolean> {
  const role = req.adminRole;
  const branchScope = req.adminBranchScope ?? 'ALL';
  const branchId = req.adminBranchId ?? null;
  if (!role) {
    res.status(401).json({ error: 'Otorisasi diperlukan.' });
    return false;
  }
  if (!canAccessBranch({ role, branchScope, branchId }, targetBranch)) {
    const reason = `Percobaan lintas cabang ditolak: role ${role} (scope ${branchScope}) mencoba ${operationLabel} di cabang ${targetBranch}.`;
    await logCashierDeniedAuditBestEffort({
      req,
      actorRole: role,
      reason,
      targetType: 'branch_isolation',
      targetId: targetBranch,
    });
    res.status(403).json({
      code: 'CROSS_BRANCH_FORBIDDEN',
      error: `Akses ditolak (403): Akun Anda tidak memiliki izin untuk ${operationLabel} pada cabang ${targetBranch}.`,
    });
    return false;
  }
  return true;
}

export function requireSystemNotLocked(
  checkLockedFn?: () => Promise<{ locked: boolean; message?: string }>
) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || undefined;
      const lockState = checkLockedFn
        ? await checkLockedFn()
        : await (await import('../services/backupRestoreService.ts')).backupRestoreEngine.getRestoreLockState(bearer);

      if (lockState.locked) {
        res.status(503).json({
          code: 'RESTORE_IN_PROGRESS',
          error:
            lockState.message ||
            'XP PLAY sedang melakukan maintenance sistem. Silakan kembali beberapa saat lagi.',
        });
        return;
      }
      next();
    } catch {
      next();
    }
  };
}
