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
  enforceBranchScopeInRequest,
  requireAdminRole,
  requireAuth,
  requirePermission,
  requireSystemNotLocked,
  type AuthenticatedRequest,
} from '../middleware/authMiddleware.ts';
import { backupRestoreEngine } from '../services/backupRestoreService.ts';
import {
  createCaptchaChallenge,
  isRecaptchaConfigured,
  verifyCaptchaResponse,
} from '../services/captchaService.ts';
import {
  issueOnboardingVerificationCode,
  lookupLocalOnboardingEntry,
  markOnboardingCodeUsed,
  verifyOnboardingSessionToken,
  verifyOnboardingVerificationCode,
} from '../services/onboardingSecurityService.ts';
import {
  adjustMemberXpServer,
  changeMemberPasswordServer,
  checkOnboardingPhoneServer,
  completeMemberRegistrationServer,
  executeCycleResetServer,
  loginMemberServer,
  markBenefitRequestUsedServer,
  overrideMemberLevelServer,
  preRegisterCustomerServer,
  processExpiredBenefitRequestsServer,
  recordTransactionXpServer,
  registerMemberServer,
  reviewBenefitRequestServer,
  reviewClaimServer,
  reviewRedemptionServer,
  submitBenefitRequestServer,
} from '../services/xpEngineServer.ts';
import { validateWhatsapp } from '../../shared/xpLogic.ts';
import { evaluatePhoneRegistrationState } from '../../shared/registrationLogic.ts';
import type {
  BackupKind,
  BenefitRequestSourceType,
  BranchId,
  LevelId,
  LevelOverrideAction,
  MemberCategory,
  XpAdjustmentKind,
} from '../../types/xpplay.ts';

export const apiRouter = express.Router();

const UPLOAD_ROOT = path.resolve(process.cwd(), '.uploads', 'claims');
const CMS_UPLOAD_ROOT = path.resolve(process.cwd(), '.uploads', 'cms');
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
fs.mkdirSync(CMS_UPLOAD_ROOT, { recursive: true });

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
    restoreLocked: backupRestoreEngine.isRestoreLockActiveSync(),
    timezone: 'Asia/Jakarta',
  });
});

// Lightweight Maintenance / Restore Lock status for Portal Member & Admin
apiRouter.get('/system/maintenance', async (_req, res) => {
  const lock = await backupRestoreEngine.getRestoreLockState();
  res.json(lock);
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

// ---------- TWO-STEP MEMBER ONBOARDING API (Stage 1 Cashier Pre-Reg -> Stage 2 Verified Completion) ----------

// Public Step 1: Check whether WhatsApp is PRE_REGISTERED / ACTIVE / NOT_FOUND (CAPTCHA-protected, Zero-PII)
apiRouter.post('/onboarding/check', authLimiter, async (req, res) => {
  try {
    const { whatsapp, captchaToken, captchaAnswer } = req.body as {
      whatsapp?: string;
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

    const waCheck = validateWhatsapp(whatsapp || '');
    if (!waCheck.valid) {
      res.status(400).json({ error: waCheck.error || 'Nomor WhatsApp tidak valid.' });
      return;
    }

    if (isAdminSdkAvailable()) {
      const result = await checkOnboardingPhoneServer(waCheck.normalized);
      res.json(result);
      return;
    }

    // Preview mode fallback: check local server onboarding registry (client will also verify onboardingPublicStatus/{wHash})
    const localEntry = lookupLocalOnboardingEntry(waCheck.normalized);
    if (localEntry) {
      const status = localEntry.used ? 'ACTIVE' : 'PRE_REGISTERED';
      res.json(
        evaluatePhoneRegistrationState(waCheck.normalized, {
          status,
          hasActiveCode: !localEntry.used && localEntry.status !== 'EXPIRED' && localEntry.status !== 'REVOKED',
          branchId: localEntry.branchId,
        })
      );
      return;
    }

    res.json({
      ...evaluatePhoneRegistrationState(waCheck.normalized, null),
      checkFirestorePublicStatus: true,
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Gagal memeriksa nomor WhatsApp.',
    });
  }
});

// Public Step 2: Verify 6-digit One-Time Verification Code -> returns short-lived signed single-use session token
apiRouter.post('/onboarding/verify-code', authLimiter, async (req, res) => {
  try {
    const { whatsapp, code } = req.body as { whatsapp?: string; code?: string };
    const waCheck = validateWhatsapp(whatsapp || '');
    if (!waCheck.valid) {
      res.status(400).json({ error: waCheck.error || 'Nomor WhatsApp tidak valid.' });
      return;
    }

    const result = await verifyOnboardingVerificationCode({
      normalizedWhatsapp: waCheck.normalized,
      code: code || '',
    });

    if (!result.verified) {
      res.status(400).json({
        verified: false,
        remainingAttempts: result.remainingAttempts,
        error: result.error || 'Kode verifikasi tidak valid.',
      });
      return;
    }

    res.json(result);
  } catch (err) {
    res.status(400).json({
      verified: false,
      error: err instanceof Error ? err.message : 'Verifikasi kode gagal.',
    });
  }
});

// Public Step 3: Complete online registration (Admin SDK atomic path)
apiRouter.post('/onboarding/complete', authLimiter, requireSystemNotLocked(), async (req, res) => {
  try {
    const {
      onboardingSessionToken,
      fullName,
      username,
      birthDate,
      memberCategory,
      socialMedia,
      preferredBranch,
      referralUsername,
      password,
    } = req.body as {
      onboardingSessionToken?: string;
      fullName?: string;
      username?: string;
      birthDate?: string;
      memberCategory?: MemberCategory;
      socialMedia?: string;
      preferredBranch?: BranchId;
      referralUsername?: string;
      password?: string;
    };

    if (!isAdminSdkAvailable()) {
      const check = verifyOnboardingSessionToken(onboardingSessionToken || '', { consume: false });
      if (!check.valid || !check.payload) {
        res.status(400).json({ error: check.error || 'Sesi verifikasi tidak valid.' });
        return;
      }
      res.status(503).json({
        code: 'ADMIN_SDK_UNAVAILABLE',
        verifiedSession: {
          preMemberUid: check.payload.preMemberUid,
          memberId: check.payload.memberId,
          branchId: check.payload.branchId,
          verifiedAt: check.payload.verifiedAt,
        },
        error: 'Gunakan alur completion klien yang terverifikasi untuk mode preview.',
      });
      return;
    }

    const result = await completeMemberRegistrationServer({
      onboardingSessionToken: onboardingSessionToken || '',
      fullName: fullName || '',
      username: username || '',
      birthDate: birthDate || '',
      memberCategory: memberCategory || 'LAINNYA',
      socialMedia,
      preferredBranch: preferredBranch || 'DEMANG',
      referralUsername,
      password: password || '',
    });

    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Gagal menyelesaikan pendaftaran online.',
    });
  }
});

// Marks single-use onboarding token as consumed after Client Preview mode completes atomically
apiRouter.post('/onboarding/consume-session', authLimiter, async (req, res) => {
  try {
    const { onboardingSessionToken } = req.body as { onboardingSessionToken?: string };
    const check = verifyOnboardingSessionToken(onboardingSessionToken || '', { consume: true });
    if (!check.valid || !check.payload) {
      res.status(400).json({ error: check.error || 'Token sesi tidak valid.' });
      return;
    }
    await markOnboardingCodeUsed(check.payload.normalizedWhatsapp);
    res.json({ consumed: true });
  } catch {
    res.status(400).json({ error: 'Gagal menyelesaikan sesi verifikasi.' });
  }
});

// Cashier / Admin: Issue or Re-issue cryptographic 6-digit One-Time Verification Code (works in BOTH modes)
apiRouter.post(
  '/cashier/onboarding/issue',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'STAFF']),
  requireSystemNotLocked(),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { whatsapp, preMemberUid, memberId, branchId } = req.body as {
        whatsapp?: string;
        preMemberUid?: string;
        memberId?: string;
        branchId?: BranchId;
      };
      if (!branchId || (branchId !== 'DEMANG' && branchId !== 'SEKIP')) {
        res.status(400).json({ error: 'Cabang wajib DEMANG atau SEKIP.' });
        return;
      }
      const allowed = await enforceBranchScopeInRequest(req, res, branchId, 'menerbitkan kode verifikasi');
      if (!allowed) return;

      const waCheck = validateWhatsapp(whatsapp || '');
      if (!waCheck.valid) {
        res.status(400).json({ error: waCheck.error || 'Nomor WhatsApp tidak valid.' });
        return;
      }
      if (!preMemberUid || !memberId) {
        res.status(400).json({ error: 'preMemberUid dan memberId wajib disertakan.' });
        return;
      }

      const issued = await issueOnboardingVerificationCode({
        normalizedWhatsapp: waCheck.normalized,
        preMemberUid,
        memberId,
        branchId,
        issuedBy: req.authUser!.uid,
        issuedByRole: req.adminRole!,
      });

      res.status(201).json({
        verificationCode: issued.verificationCode,
        expiresAt: issued.record.expiresAt,
        wHash: issued.record.wHash,
        codeHmac: issued.record.codeHmac,
        codeSalt: issued.record.codeSalt,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Gagal menerbitkan kode verifikasi.',
      });
    }
  }
);

// Cashier / Admin: Stage 1 Pre-Registration (Admin SDK authoritative endpoint)
apiRouter.post(
  '/cashier/pre-register',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'STAFF']),
  requireSystemNotLocked(),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { whatsapp, branchId, notes } = req.body as {
        whatsapp?: string;
        branchId?: BranchId;
        notes?: string;
      };
      if (!branchId || (branchId !== 'DEMANG' && branchId !== 'SEKIP')) {
        res.status(400).json({ error: 'Cabang wajib DEMANG atau SEKIP.' });
        return;
      }
      const allowed = await enforceBranchScopeInRequest(req, res, branchId, 'pre-registrasi customer');
      if (!allowed) return;

      if (!isAdminSdkAvailable()) {
        res.status(503).json({
          code: 'ADMIN_SDK_UNAVAILABLE',
          error: 'Gunakan alur pre-register klien untuk mode preview.',
        });
        return;
      }

      const result = await preRegisterCustomerServer({
        whatsapp: whatsapp || '',
        branchId,
        notes,
        actorUid: req.authUser!.uid,
        actorName: req.authUser!.email || req.authUser!.uid,
        actorRole: req.adminRole!,
        actorBranchScope: req.adminBranchScope ?? 'ALL',
      });
      res.status(result.alreadyExists ? 200 : 201).json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Gagal melakukan pre-registrasi customer.',
      });
    }
  }
);

// Cashier / Admin: Assisted Benefit Request (works for PRE_REGISTERED & ACTIVE members with branch isolation)
apiRouter.post(
  '/cashier/benefit-requests',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'STAFF']),
  requireSystemNotLocked(),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { memberUid, sourceType, sourceId, evidenceUrl, evidencePath, note, branch } = req.body as {
        memberUid?: string;
        sourceType?: BenefitRequestSourceType;
        sourceId?: string;
        evidenceUrl?: string;
        evidencePath?: string;
        note?: string;
        branch?: BranchId;
      };
      if (!branch || (branch !== 'DEMANG' && branch !== 'SEKIP')) {
        res.status(400).json({ error: 'Cabang wajib DEMANG atau SEKIP.' });
        return;
      }
      const allowed = await enforceBranchScopeInRequest(req, res, branch, 'mengajukan benefit atas nama customer');
      if (!allowed) return;

      if (!memberUid || !sourceType || !sourceId) {
        res.status(400).json({ error: 'memberUid, sourceType, dan sourceId wajib diisi.' });
        return;
      }

      const result = await submitBenefitRequestServer({
        memberUid,
        sourceType,
        sourceId,
        evidenceUrl,
        evidencePath,
        note,
        branch,
        assistedByUid: req.authUser!.uid,
        assistedByRole: req.adminRole!,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Gagal mengajukan Benefit Request via Kasir.',
      });
    }
  }
);

// Audit denied direct URL / unauthorized route attempts from Cashier UI
apiRouter.post(
  '/cashier/audit-denied',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'STAFF']),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { attemptedPath, reason } = req.body as { attemptedPath?: string; reason?: string };
      const db = getAdminDb();
      if (db) {
        const now = Date.now();
        const auditId = `audit_${now}_${crypto.randomBytes(4).toString('hex')}`;
        await db.collection('auditLogs').doc(auditId).set({
          id: auditId,
          actorId: req.authUser!.uid,
          actorRole: req.adminRole!,
          action: 'CASHIER_DENIED_ACTION',
          targetType: 'route',
          targetId: String(attemptedPath || '/unknown').slice(0, 160),
          before: null,
          after: null,
          metadata: {
            branchScope: req.adminBranchScope ?? null,
            reason: String(reason || 'Direct URL access denied (403)').slice(0, 240),
          },
          timestamp: now,
        });
      }
      res.json({ logged: true });
    } catch {
      res.json({ logged: false });
    }
  }
);

// Legacy Public Registration Endpoint — Strictly Blocked under Two-Step Registration Policy
apiRouter.post('/auth/register', authLimiter, async (req, res) => {
  try {
    const {
      fullName,
      username,
      whatsapp,
      socialMedia,
      birthDate,
      memberCategory,
      referralUsername,
      password,
      preferredBranch,
    } = req.body as {
      fullName?: string;
      username?: string;
      whatsapp?: string;
      socialMedia?: string;
      birthDate?: string | null;
      memberCategory?: MemberCategory | null;
      referralUsername?: string;
      password?: string;
      preferredBranch?: BranchId | null;
    };

    const result = await registerMemberServer({
      fullName: fullName || '',
      username: username || '',
      whatsapp: whatsapp || '',
      socialMedia: socialMedia || '',
      birthDate: birthDate ?? null,
      memberCategory: memberCategory ?? null,
      referralUsername,
      password: password || '',
      preferredBranch: preferredBranch || null,
    });
    res.status(201).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Registrasi mandiri dinonaktifkan.';
    res.status(403).json({ code: 'TWO_STEP_REQUIRED', error: message });
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
    const typed = err as Error & { code?: string; statusCode?: number };
    res.status(typed.statusCode || 401).json({
      code: typed.code || 'LOGIN_FAILED',
      error: typed.message || 'Username/WhatsApp atau password tidak sesuai.',
    });
  }
});

// Protected Claim Photo Evidence Upload
apiRouter.post(
  '/claims/evidence',
  requireAuth,
  requireSystemNotLocked(),
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

// Admin-only CMS Homepage Image Upload (JPG/PNG/WEBP magic bytes, max 5 MB)
apiRouter.post(
  '/admin/cms/assets',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN', 'ADMIN']),
  requireSystemNotLocked(),
  upload.single('asset'),
  (req: AuthenticatedRequest, res) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'File gambar CMS wajib dilampirkan.' });
        return;
      }

      const magic = hasValidImageMagicBytes(file.buffer);
      if (!magic.valid) {
        res.status(400).json({
          error: 'Format gambar CMS tidak didukung. Gunakan JPG, PNG, atau WEBP (maks. 5 MB). SVG dilarang demi keamanan XSS.',
        });
        return;
      }

      const fileName = `cms_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${magic.ext}`;
      const filePath = path.join(CMS_UPLOAD_ROOT, fileName);
      fs.writeFileSync(filePath, file.buffer);

      res.status(201).json({
        assetPath: `cms/${fileName}`,
        assetUrl: `/api/cms/assets/${fileName}`,
        mimeType: magic.mime,
        size: file.size,
      });
    } catch {
      res.status(500).json({ error: 'Gagal mengunggah aset CMS. Silakan coba lagi.' });
    }
  }
);

// Public read for published CMS assets with strict filename validation & nosniff
apiRouter.get('/cms/assets/:fileName', (req, res) => {
  try {
    const fileName = path.basename(String(req.params.fileName || ''));
    if (!/^cms_[0-9]+_[a-f0-9]+\.(jpg|png|webp)$/.test(fileName)) {
      res.status(400).json({ error: 'Nama aset tidak valid.' });
      return;
    }
    const fullPath = path.join(CMS_UPLOAD_ROOT, fileName);
    if (!fs.existsSync(fullPath)) {
      res.status(404).json({ error: 'Aset CMS tidak ditemukan.' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(fullPath);
  } catch {
    res.status(500).json({ error: 'Gagal memuat aset CMS.' });
  }
});

// Server-authoritative Admin & Cashier Transaction API (strict branch isolation for Cashier)
apiRouter.post(
  '/admin/transactions',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'STAFF']),
  requireSystemNotLocked(),
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
      const allowed = await enforceBranchScopeInRequest(req, res, branch, 'input transaksi');
      if (!allowed) return;

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
  requireSystemNotLocked(),
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
  requireSystemNotLocked(),
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

// ---------- FASE 1–6: Unified Benefit Request + Cashier + Expiry Endpoints ----------
apiRouter.post(
  '/benefit-requests',
  requireAuth,
  requireSystemNotLocked(),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sourceType, sourceId, evidenceUrl, evidencePath, note, branch } = req.body as {
        sourceType?: BenefitRequestSourceType;
        sourceId?: string;
        evidenceUrl?: string;
        evidencePath?: string;
        note?: string;
        branch?: BranchId | null;
      };
      const allowedTypes: BenefitRequestSourceType[] = [
        'CHALLENGE',
        'EVENT',
        'PROMO',
        'GENERAL_BENEFIT',
        'LEVEL_BENEFIT',
      ];
      if (!sourceType || !allowedTypes.includes(sourceType) || !sourceId) {
        res.status(400).json({ error: 'sourceType dan sourceId wajib diisi dengan valid.' });
        return;
      }
      const result = await submitBenefitRequestServer({
        memberUid: req.authUser!.uid,
        sourceType,
        sourceId,
        evidenceUrl,
        evidencePath,
        note,
        branch: branch ?? null,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Gagal mengajukan Benefit Request.',
      });
    }
  }
);

apiRouter.post(
  '/admin/benefit-requests/:requestId/review',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'STAFF']),
  requireSystemNotLocked(),
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
      const result = await reviewBenefitRequestServer({
        requestId: String(req.params.requestId),
        decision,
        reason,
        adminUid: req.authUser!.uid,
        adminRole: req.adminRole!,
        adminBranchScope: req.adminBranchScope ?? 'ALL',
      });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal memproses Benefit Request.';
      res.status(msg.includes('(403)') ? 403 : 400).json({ error: msg });
    }
  }
);

apiRouter.post(
  '/admin/benefit-requests/:requestId/use',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'STAFF']),
  requireSystemNotLocked(),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { usedBranch, receiptReference } = req.body as {
        usedBranch?: BranchId;
        receiptReference?: string;
      };
      if (usedBranch !== 'DEMANG' && usedBranch !== 'SEKIP') {
        res.status(400).json({ error: 'Cabang penggunaan wajib DEMANG atau SEKIP.' });
        return;
      }
      const allowed = await enforceBranchScopeInRequest(req, res, usedBranch, 'menandai benefit USED');
      if (!allowed) return;

      const result = await markBenefitRequestUsedServer({
        requestId: String(req.params.requestId),
        usedBranch,
        receiptReference,
        adminUid: req.authUser!.uid,
        adminRole: req.adminRole!,
        adminBranchScope: req.adminBranchScope ?? 'ALL',
      });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal menandai benefit sebagai USED.';
      res.status(msg.includes('(403)') ? 403 : 400).json({ error: msg });
    }
  }
);

apiRouter.post(
  '/admin/benefit-requests/process-expired',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'STAFF']),
  requireSystemNotLocked(),
  async (req: AuthenticatedRequest, res) => {
    try {
      const result = await processExpiredBenefitRequestsServer({
        adminUid: req.authUser!.uid,
        adminRole: req.adminRole!,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Gagal memproses benefit kadaluarsa.',
      });
    }
  }
);

apiRouter.post(
  '/admin/reset-cycle/execute',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN']),
  requireSystemNotLocked(),
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

apiRouter.post(
  '/admin/xp-adjustments',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN', 'ADMIN']),
  requirePermission('XP_PROGRESS_ADJUSTMENT'),
  requirePermission('XP_REWARD_ADJUSTMENT'),
  requireSystemNotLocked(),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { operationId, kind, identifier, memberUid, adjustment, reason, reference } = req.body as {
        operationId?: string;
        kind?: XpAdjustmentKind;
        identifier?: string;
        memberUid?: string;
        adjustment?: number;
        reason?: string;
        reference?: string;
      };
      if (kind !== 'PROGRESS' && kind !== 'REWARD') {
        res.status(400).json({ error: 'Jenis adjustment harus PROGRESS atau REWARD.' });
        return;
      }
      const result = await adjustMemberXpServer({
        operationId: operationId || '',
        kind,
        identifier,
        memberUid,
        adjustment: Number(adjustment),
        reason: reason || '',
        reference,
        adminUid: req.authUser!.uid,
        adminEmail: req.authUser!.email || req.authUser!.uid,
        adminRole: req.adminRole!,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Gagal memproses penyesuaian XP.' });
    }
  }
);

apiRouter.post(
  '/admin/level-overrides',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN', 'ADMIN']),
  requirePermission('LEVEL_OVERRIDE'),
  requireSystemNotLocked(),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { operationId, action, identifier, memberUid, targetLevel, reason, reference } = req.body as {
        operationId?: string;
        action?: LevelOverrideAction;
        identifier?: string;
        memberUid?: string;
        targetLevel?: LevelId;
        reason?: string;
        reference?: string;
      };
      if (action !== 'MANUAL_OVERRIDE' && action !== 'RECALCULATE') {
        res.status(400).json({ error: 'Aksi harus MANUAL_OVERRIDE atau RECALCULATE.' });
        return;
      }
      const result = await overrideMemberLevelServer({
        operationId: operationId || '',
        action,
        identifier,
        memberUid,
        targetLevel,
        reason: reason || '',
        reference,
        adminUid: req.authUser!.uid,
        adminEmail: req.authUser!.email || req.authUser!.uid,
        adminRole: req.adminRole!,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Gagal memproses level override.' });
    }
  }
);

// ---------- PHASE D: Admin Password Management (MODULE 5) ----------
apiRouter.post(
  '/admin/members/:memberUid/password',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN', 'ADMIN']),
  requirePermission('PASSWORD_RESET_MEMBER'),
  requireSystemNotLocked(),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { operationId, newPassword, confirmPassword, reason, reference, revokeSessions } = req.body as {
        operationId?: string;
        newPassword?: string;
        confirmPassword?: string;
        reason?: string;
        reference?: string;
        revokeSessions?: boolean;
      };
      const result = await changeMemberPasswordServer({
        operationId: operationId || `pwd_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        memberUid: String(req.params.memberUid || ''),
        newPassword: newPassword || '',
        confirmPassword: confirmPassword || '',
        reason: reason || '',
        reference,
        revokeSessions,
        adminUid: req.authUser!.uid,
        adminEmail: req.authUser!.email || req.authUser!.uid,
        adminRole: req.adminRole!,
      });
      res.json(result);
    } catch (err) {
      const typed = err as Error & { statusCode?: number; code?: string };
      res.status(typed.statusCode || 400).json({
        code: typed.code || 'PASSWORD_CHANGE_FAILED',
        error: typed.message || 'Gagal mengubah password member.',
      });
    }
  }
);

// ---------- PHASES F, G, H, I, K: System Health, Integrity Audit, Backup, Verification & Restore ----------
function extractBearer(req: AuthenticatedRequest): string | undefined {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  return raw || undefined;
}

apiRouter.get(
  '/admin/system-health',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN', 'ADMIN']),
  async (req: AuthenticatedRequest, res) => {
    try {
      const report = await backupRestoreEngine.getSystemHealth(extractBearer(req));
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Gagal memeriksa kesehatan sistem.' });
    }
  }
);

apiRouter.post(
  '/admin/integrity-audit',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN', 'ADMIN']),
  async (req: AuthenticatedRequest, res) => {
    try {
      const report = await backupRestoreEngine.runLiveIntegrityAudit({
        actorUid: req.authUser!.uid,
        actorRole: req.adminRole!,
        bearerToken: extractBearer(req),
        writeAudit: true,
      });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Gagal menjalankan 15-point integrity audit.' });
    }
  }
);

apiRouter.get(
  '/admin/backups',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN']),
  async (req: AuthenticatedRequest, res) => {
    try {
      const backups = await backupRestoreEngine.listSystemBackups(extractBearer(req));
      res.json({ backups });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Gagal memuat daftar backup.' });
    }
  }
);

apiRouter.post(
  '/admin/backups',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN']),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { kind, note } = req.body as { kind?: BackupKind; note?: string };
      const safeKind: BackupKind =
        kind === 'SCHEDULED' || kind === 'PRE_RESTORE' ? kind : 'MANUAL';
      const result = await backupRestoreEngine.createSystemBackup({
        kind: safeKind,
        note: note || '',
        actorUid: req.authUser!.uid,
        actorEmail: req.authUser!.email || req.authUser!.uid,
        actorRole: req.adminRole!,
        bearerToken: extractBearer(req),
      });
      res.status(201).json(result);
    } catch (err) {
      const typed = err as Error & { statusCode?: number; code?: string };
      res.status(typed.statusCode || 500).json({
        code: typed.code || 'BACKUP_FAILED',
        error: typed.message || 'Gagal menjalankan backup sistem.',
      });
    }
  }
);

apiRouter.get(
  '/admin/backups/:backupId',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN']),
  async (req: AuthenticatedRequest, res) => {
    try {
      const backupId = String(req.params.backupId || '');
      const manifest = backupRestoreEngine.readBackupManifestFromDisk(backupId);
      if (!manifest) {
        res.status(404).json({ error: 'Manifest backup tidak ditemukan di server.' });
        return;
      }
      res.json({ manifest });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Gagal membaca manifest backup.' });
    }
  }
);

apiRouter.post(
  '/admin/backups/:backupId/verify',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN']),
  async (req: AuthenticatedRequest, res) => {
    try {
      const result = await backupRestoreEngine.verifySystemBackup({
        backupId: String(req.params.backupId || ''),
        actorUid: req.authUser!.uid,
        actorRole: req.adminRole!,
        bearerToken: extractBearer(req),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Gagal memverifikasi backup.' });
    }
  }
);

apiRouter.delete(
  '/admin/backups/:backupId',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN']),
  async (req: AuthenticatedRequest, res) => {
    try {
      await backupRestoreEngine.deleteSystemBackup({
        backupId: String(req.params.backupId || ''),
        actorUid: req.authUser!.uid,
        actorRole: req.adminRole!,
        bearerToken: extractBearer(req),
      });
      res.json({ deleted: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Gagal menghapus backup.' });
    }
  }
);

apiRouter.get(
  '/admin/backup-retention',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN']),
  async (req: AuthenticatedRequest, res) => {
    try {
      const config = await backupRestoreEngine.getBackupRetention(extractBearer(req));
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Gagal memuat konfigurasi retensi.' });
    }
  }
);

apiRouter.put(
  '/admin/backup-retention',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN']),
  async (req: AuthenticatedRequest, res) => {
    try {
      const body = req.body as {
        dailyRetentionCount?: number;
        weeklyRetentionCount?: number;
        monthlyRetentionCount?: number;
        customMaxAgeDays?: number;
        alwaysKeepLatestSuccessful?: boolean;
        alwaysKeepLatestPreRestore?: boolean;
      };
      const config = await backupRestoreEngine.saveBackupRetention({
        dailyRetentionCount: Number(body.dailyRetentionCount ?? 7),
        weeklyRetentionCount: Number(body.weeklyRetentionCount ?? 4),
        monthlyRetentionCount: Number(body.monthlyRetentionCount ?? 3),
        customMaxAgeDays: Number(body.customMaxAgeDays ?? 90),
        alwaysKeepLatestSuccessful: body.alwaysKeepLatestSuccessful !== false,
        alwaysKeepLatestPreRestore: body.alwaysKeepLatestPreRestore !== false,
        actorUid: req.authUser!.uid,
        actorRole: req.adminRole!,
        bearerToken: extractBearer(req),
      });
      res.json(config);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Gagal menyimpan kebijakan retensi.' });
    }
  }
);

apiRouter.get(
  '/admin/restores',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN']),
  async (req: AuthenticatedRequest, res) => {
    try {
      const jobs = await backupRestoreEngine.listRestoreJobs(extractBearer(req));
      const lock = await backupRestoreEngine.getRestoreLockState(extractBearer(req));
      res.json({ jobs, lock });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Gagal memuat riwayat restore.' });
    }
  }
);

apiRouter.post(
  '/admin/restores/preview',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN']),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { backupId } = req.body as { backupId?: string };
      if (!backupId) {
        res.status(400).json({ error: 'backupId wajib dipilih.' });
        return;
      }
      const preview = await backupRestoreEngine.previewRestore({
        backupId,
        actorUid: req.authUser!.uid,
        actorRole: req.adminRole!,
        bearerToken: extractBearer(req),
      });
      res.json(preview);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Gagal menyiapkan preview restore.' });
    }
  }
);

apiRouter.post(
  '/admin/restores/execute',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN']),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { backupId, confirmationPhrase, reason } = req.body as {
        backupId?: string;
        confirmationPhrase?: string;
        reason?: string;
      };
      if (!backupId) {
        res.status(400).json({ error: 'backupId wajib dipilih.' });
        return;
      }
      const job = await backupRestoreEngine.executeRestore({
        backupId,
        confirmationPhrase: confirmationPhrase || '',
        reason: reason || '',
        actorUid: req.authUser!.uid,
        actorEmail: req.authUser!.email || req.authUser!.uid,
        actorRole: req.adminRole!,
        bearerToken: extractBearer(req),
      });
      const statusCode = job.status === 'COMPLETED' ? 200 : 422;
      res.status(statusCode).json(job);
    } catch (err) {
      const typed = err as Error & { statusCode?: number; code?: string };
      res.status(typed.statusCode || 400).json({
        code: typed.code || 'RESTORE_FAILED',
        error: typed.message || 'Gagal menjalankan proses restore.',
      });
    }
  }
);

apiRouter.post(
  '/admin/restores/force-unlock',
  requireAuth,
  requireAdminRole(['SUPER_ADMIN']),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { reason } = req.body as { reason?: string };
      const lock = await backupRestoreEngine.forceReleaseRestoreLock({
        reason: reason || '',
        actorUid: req.authUser!.uid,
        actorRole: req.adminRole!,
        bearerToken: extractBearer(req),
      });
      res.json(lock);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Gagal melepas Restore Lock.' });
    }
  }
);
