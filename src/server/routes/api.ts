import crypto from 'crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import {
  firebaseAppletConfig,
  getAdminDb,
  getBootstrapSuperAdminEmails,
  isAdminSdkAvailable,
} from '../firebaseServer.ts';
import {
  requireAdminRole,
  requireAuth,
  type AuthenticatedRequest,
} from '../middleware/authMiddleware.ts';
import {
  createCaptchaChallenge,
  isRecaptchaConfigured,
  verifyCaptchaResponse,
} from '../services/captchaService.ts';
import {
  executeCycleResetServer,
  loginMemberServer,
  recordTransactionXpServer,
  registerMemberServer,
  reviewClaimServer,
  reviewRedemptionServer,
} from '../services/xpEngineServer.ts';
import type { BranchId } from '../../types/xpplay.ts';

export const apiRouter = express.Router();

const UPLOAD_ROOT = path.resolve(process.cwd(), '.uploads', 'claims');
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan. Silakan tunggu beberapa menit sebelum mencoba lagi.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB max
  },
});

function hasValidImageMagicBytes(buf: Buffer): { valid: boolean; ext: string; mime: string } {
  if (buf.length < 12) return { valid: false, ext: '', mime: '' };
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { valid: true, ext: 'jpg', mime: 'image/jpeg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return { valid: true, ext: 'png', mime: 'image/png' };
  }
  // WEBP: RIFF....WEBP
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { valid: true, ext: 'webp', mime: 'image/webp' };
  }
  return { valid: false, ext: '', mime: '' };
}

// Health & capabilities
apiRouter.get('/health', (_req, res) => {
  res.json({
    ok: true,
    adminSdkConfigured: isAdminSdkAvailable(),
    recaptchaConfigured: isRecaptchaConfigured(),
    timezone: 'Asia/Jakarta',
  });
});

// Server-side CAPTCHA endpoints
apiRouter.get('/captcha/challenge', authLimiter, (_req, res) => {
  const challenge = createCaptchaChallenge();
  res.json(challenge);
});

apiRouter.post('/captcha/verify', authLimiter, async (req, res) => {
  const { token, answer } = req.body as { token?: string; answer?: string };
  const result = await verifyCaptchaResponse({
    token,
    answer,
    remoteIp: req.ip,
  });
  if (!result.valid) {
    res.status(400).json({ valid: false, error: result.error });
    return;
  }
  res.json({ valid: true });
});

// Member Registration (Server-side CAPTCHA + Atomic Firebase Auth + XP Bonus + Referral)
apiRouter.post('/auth/register', authLimiter, async (req, res) => {
  try {
    const {
      fullName,
      username,
      whatsapp,
      socialMedia,
      referralUsername,
      password,
      preferredBranch,
      captchaToken,
      captchaAnswer,
    } = req.body as {
      fullName?: string;
      username?: string;
      whatsapp?: string;
      socialMedia?: string;
      referralUsername?: string;
      password?: string;
      preferredBranch?: BranchId | null;
      captchaToken?: string;
      captchaAnswer?: string;
    };

    const captchaResult = await verifyCaptchaResponse({
      token: captchaToken,
      answer: captchaAnswer,
      remoteIp: req.ip,
    });
    if (!captchaResult.valid) {
      res.status(400).json({ error: captchaResult.error });
      return;
    }

    if (!isAdminSdkAvailable()) {
      res.status(503).json({
        code: 'ADMIN_SDK_UNAVAILABLE',
        error:
          'Endpoint server register tidak tersedia tanpa FIREBASE_SERVICE_ACCOUNT_JSON. Gunakan alur registrasi klien Email/Password.',
      });
      return;
    }

    const result = await registerMemberServer({
      fullName: fullName || '',
      username: username || '',
      whatsapp: whatsapp || '',
      socialMedia: socialMedia || '',
      referralUsername,
      password: password || '',
      preferredBranch: preferredBranch || null,
    });

    res.status(201).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Registrasi gagal diproses.';
    res.status(400).json({ error: message });
  }
});

// Member Login via Username or WhatsApp + Password + Server-side CAPTCHA
apiRouter.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const { identifier, password, captchaToken, captchaAnswer } = req.body as {
      identifier?: string;
      password?: string;
      captchaToken?: string;
      captchaAnswer?: string;
    };

    const captchaResult = await verifyCaptchaResponse({
      token: captchaToken,
      answer: captchaAnswer,
      remoteIp: req.ip,
    });
    if (!captchaResult.valid) {
      res.status(400).json({ error: captchaResult.error });
      return;
    }

    if (!isAdminSdkAvailable()) {
      res.status(503).json({
        code: 'ADMIN_SDK_UNAVAILABLE',
        error:
          'Endpoint server login tidak tersedia tanpa FIREBASE_SERVICE_ACCOUNT_JSON. Gunakan alur login klien Email/Password.',
      });
      return;
    }

    const result = await loginMemberServer({
      identifier: identifier || '',
      password: password || '',
    });

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Username/WhatsApp atau password tidak sesuai.';
    res.status(401).json({ error: message });
  }
});

// Protected Claim Photo Evidence Upload
apiRouter.post(
  '/claims/evidence',
  requireAuth,
  upload.single('evidence'),
  (req: AuthenticatedRequest, res) => {
    try {
      const uid = req.authUser!.uid;
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'File bukti foto wajib dilampirkan.' });
        return;
      }

      const magic = hasValidImageMagicBytes(file.buffer);
      if (!magic.valid) {
        res.status(400).json({ error: 'Bukti foto tidak valid. Gunakan format JPG, PNG, atau WEBP (maks. 5 MB).' });
        return;
      }

      const safeUid = uid.replace(/[^a-zA-Z0-9_-]/g, '');
      const memberDir = path.join(UPLOAD_ROOT, safeUid);
      fs.mkdirSync(memberDir, { recursive: true });

      const fileName = `ev_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${magic.ext}`;
      const filePath = path.join(memberDir, fileName);
      fs.writeFileSync(filePath, file.buffer);

      const relativePath = `claims/${safeUid}/${fileName}`;
      const evidenceUrl = `/api/claims/evidence/${safeUid}/${fileName}`;

      res.status(201).json({
        evidencePath: relativePath,
        evidenceUrl,
        mimeType: magic.mime,
        size: file.size,
      });
    } catch {
      res.status(500).json({ error: 'Gagal mengunggah bukti foto. Silakan coba lagi.' });
    }
  }
);

// Protected Claim Photo Evidence Download (Owner OR Admin only)
apiRouter.get(
  '/claims/evidence/:memberUid/:fileName',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const uid = req.authUser!.uid;
      const paramUid = String(req.params.memberUid || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const paramFile = path.basename(String(req.params.fileName || ''));

      let authorized = uid === paramUid;
      if (!authorized) {
        const email = req.authUser?.email?.toLowerCase() ?? '';
        if (req.authUser?.emailVerified && getBootstrapSuperAdminEmails().includes(email)) {
          authorized = true;
        } else {
          const db = getAdminDb();
          if (db) {
            const adminSnap = await db.collection('admins').doc(uid).get();
            if (adminSnap.exists && (adminSnap.data() as { active?: boolean }).active) {
              authorized = true;
            }
          } else {
            const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
            if (bearer) {
              try {
                const restUrl = `https://firestore.googleapis.com/v1/projects/${firebaseAppletConfig.projectId}/databases/${firebaseAppletConfig.firestoreDatabaseId}/documents/admins/${encodeURIComponent(uid)}`;
                const adminRes = await fetch(restUrl, {
                  headers: { Authorization: `Bearer ${bearer}` },
                });
                if (adminRes.ok) {
                  const docJson = (await adminRes.json()) as {
                    fields?: { active?: { booleanValue?: boolean } };
                  };
                  if (docJson.fields?.active?.booleanValue === true) {
                    authorized = true;
                  }
                }
              } catch {
                // Deny if lookup fails
              }
            }
          }
        }
      }

      if (!authorized) {
        res.status(403).json({ error: 'Anda tidak memiliki izin untuk melihat bukti milik member lain.' });
        return;
      }

      const fullPath = path.join(UPLOAD_ROOT, paramUid, paramFile);
      if (!fs.existsSync(fullPath)) {
        res.status(404).json({ error: 'File bukti tidak ditemukan.' });
        return;
      }

      res.sendFile(fullPath);
    } catch {
      res.status(500).json({ error: 'Gagal memuat bukti foto.' });
    }
  }
);

// Server-authoritative Admin APIs (active when Admin SDK is configured)
apiRouter.post(
  '/admin/transactions',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN', 'ADMIN', 'STAFF']),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { identifier, amountIdr, branch, receiptNumber, note } = req.body as {
        identifier?: string;
        amountIdr?: number;
        branch?: BranchId;
        receiptNumber?: string;
        note?: string;
      };
      if (!branch || (branch !== 'DEMANG' && branch !== 'SEKIP')) {
        res.status(400).json({ error: 'Cabang harus DEMANG atau SEKIP.' });
        return;
      }
      const result = await recordTransactionXpServer({
        identifier: identifier || '',
        amountIdr: Number(amountIdr),
        branch,
        receiptNumber,
        note,
        adminUid: req.authUser!.uid,
        adminName: req.authUser!.email || req.authUser!.uid,
        adminRole: req.adminRole!,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Gagal memproses transaksi.' });
    }
  }
);

apiRouter.post(
  '/admin/claims/:claimId/review',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN', 'ADMIN', 'STAFF']),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { decision, reason } = req.body as {
        decision?: 'APPROVED' | 'DENIED';
        reason?: string;
      };
      if (decision !== 'APPROVED' && decision !== 'DENIED') {
        res.status(400).json({ error: 'Keputusan harus APPROVED atau DENIED.' });
        return;
      }
      const result = await reviewClaimServer({
        claimId: String(req.params.claimId),
        decision,
        reason,
        adminUid: req.authUser!.uid,
        adminRole: req.adminRole!,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Gagal memproses claim.' });
    }
  }
);

apiRouter.post(
  '/admin/redemptions/:redemptionId/review',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN', 'ADMIN', 'STAFF']),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { decision, reason } = req.body as {
        decision?: 'APPROVED' | 'DENIED';
        reason?: string;
      };
      if (decision !== 'APPROVED' && decision !== 'DENIED') {
        res.status(400).json({ error: 'Keputusan harus APPROVED atau DENIED.' });
        return;
      }
      const result = await reviewRedemptionServer({
        redemptionId: String(req.params.redemptionId),
        decision,
        reason,
        adminUid: req.authUser!.uid,
        adminRole: req.adminRole!,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Gagal memproses redemption.' });
    }
  }
);

apiRouter.post(
  '/admin/reset-cycle/execute',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN']),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { nextCycleId, nextCycleName, resetReason } = req.body as {
        nextCycleId?: string;
        nextCycleName?: string;
        resetReason?: string;
      };
      const result = await executeCycleResetServer({
        nextCycleId: nextCycleId || '',
        nextCycleName: nextCycleName || '',
        resetReason: resetReason || 'Reset periodik Membership Cycle',
        adminUid: req.authUser!.uid,
        adminRole: req.adminRole!,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Gagal menjalankan reset cycle.' });
    }
  }
);
