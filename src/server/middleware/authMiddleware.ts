import type { NextFunction, Request, Response } from 'express';
import {
  firebaseAppletConfig,
  getAdminDb,
  getBootstrapSuperAdminEmails,
  verifyFirebaseIdToken,
  type VerifiedTokenPayload,
} from '../firebaseServer.ts';
import type { AdminRole } from '../../types/xpplay.ts';

export interface AuthenticatedRequest extends Request {
  authUser?: VerifiedTokenPayload;
  adminRole?: AdminRole;
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

export function requireAdminRole(allowedRoles: AdminRole[]) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    if (!req.authUser) {
      res.status(401).json({ error: 'Autentikasi diperlukan.' });
      return;
    }

    const email = req.authUser.email?.toLowerCase() ?? '';
    const bootstrapEmails = getBootstrapSuperAdminEmails();

    if (req.authUser.emailVerified && email && bootstrapEmails.includes(email)) {
      req.adminRole = 'SUPER_ADMIN';
      if (allowedRoles.includes('SUPER_ADMIN')) {
        next();
        return;
      }
    }

    const adminDb = getAdminDb();
    if (!adminDb) {
      if (!req.authUser.emailVerified) {
        res.status(403).json({ error: 'Email admin belum terverifikasi.' });
        return;
      }
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (!bearer) {
        res.status(403).json({ error: 'Akses admin ditolak.' });
        return;
      }
      try {
        const restUrl = `https://firestore.googleapis.com/v1/projects/${firebaseAppletConfig.projectId}/databases/${firebaseAppletConfig.firestoreDatabaseId}/documents/admins/${encodeURIComponent(req.authUser.uid)}`;
        const adminRes = await fetch(restUrl, {
          headers: { Authorization: `Bearer ${bearer}` },
        });
        if (!adminRes.ok) {
          res.status(403).json({ error: 'Akun Anda tidak memiliki hak akses admin.' });
          return;
        }
        const docJson = (await adminRes.json()) as {
          fields?: {
            active?: { booleanValue?: boolean };
            role?: { stringValue?: AdminRole };
          };
        };
        const active = docJson.fields?.active?.booleanValue === true;
        const role = docJson.fields?.role?.stringValue;
        if (!active || !role || !allowedRoles.includes(role)) {
          res.status(403).json({ error: 'Anda tidak memiliki izin untuk melakukan tindakan ini.' });
          return;
        }
        req.adminRole = role;
        next();
        return;
      } catch {
        res.status(403).json({ error: 'Gagal memverifikasi otorisasi admin.' });
        return;
      }
    }

    try {
      const snap = await adminDb.collection('admins').doc(req.authUser.uid).get();
      if (!snap.exists) {
        res.status(403).json({ error: 'Akun Anda tidak memiliki hak akses admin.' });
        return;
      }
      const data = snap.data() as { active?: boolean; role?: AdminRole };
      if (!data.active || !data.role || !allowedRoles.includes(data.role)) {
        res.status(403).json({ error: 'Anda tidak memiliki izin untuk melakukan tindakan ini.' });
        return;
      }
      req.adminRole = data.role;
      next();
    } catch {
      res.status(500).json({ error: 'Gagal memverifikasi otorisasi admin.' });
    }
  };
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


