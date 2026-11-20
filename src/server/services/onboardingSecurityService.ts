import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getAdminDb } from '../firebaseServer.ts';
import {
  isValidVerificationCodeFormat,
  ONBOARDING_CODE_EXPIRY_MS,
  ONBOARDING_CODE_MAX_ATTEMPTS,
} from '../../shared/registrationLogic.ts';
import type { AdminRole, BranchId, OnboardingVerificationRecord } from '../../types/xpplay.ts';

const ONBOARDING_SECRET =
  process.env.ONBOARDING_HMAC_SECRET ||
  process.env.CAPTCHA_SECRET ||
  crypto
    .createHash('sha256')
    .update(`${process.cwd()}:xpplay_onboarding_v3_hmac_secret`)
    .digest('hex');

const STORE_DIR = path.resolve(process.cwd(), '.uploads');
const STORE_PATH = path.join(STORE_DIR, '.onboarding_codes.json');
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes single-use onboarding completion token

interface StoredCodeEntry extends OnboardingVerificationRecord {
  normalizedWhatsapp: string;
}

interface OnboardingSessionPayload {
  wHash: string;
  normalizedWhatsapp: string;
  preMemberUid: string;
  memberId: string;
  branchId: BranchId;
  verifiedAt: number;
  jti: string;
  exp: number;
}

const usedSessionJtis = new Set<string>();

function readLocalStore(): Record<string, StoredCodeEntry> {
  try {
    if (!fs.existsSync(STORE_PATH)) return {};
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, StoredCodeEntry>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLocalStore(data: Record<string, StoredCodeEntry>): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function hashWhatsappServer(normalizedWhatsapp: string): string {
  const hex = crypto
    .createHash('sha256')
    .update(`wa:${normalizedWhatsapp.trim()}`)
    .digest('hex');
  return `w_${hex}`;
}

export function computeCodeHmac(wHash: string, code: string, salt: string): string {
  return crypto
    .createHmac('sha256', ONBOARDING_SECRET)
    .update(`${wHash}:${salt}:${code.trim()}`)
    .digest('hex');
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function generateSixDigitCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

export function signOnboardingSessionToken(payload: OnboardingSessionPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', ONBOARDING_SECRET)
    .update(`session:${encoded}`)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyOnboardingSessionToken(
  token: string,
  options?: { consume?: boolean }
): { valid: boolean; payload?: OnboardingSessionPayload; error?: string } {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, error: 'Token sesi verifikasi tidak valid. Ulangi verifikasi kode.' };
  }
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) {
    return { valid: false, error: 'Format token sesi verifikasi tidak valid.' };
  }
  const expectedSig = crypto
    .createHmac('sha256', ONBOARDING_SECRET)
    .update(`session:${encoded}`)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, error: 'Tanda tangan token verifikasi tidak sah.' };
  }

  let payload: OnboardingSessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OnboardingSessionPayload;
  } catch {
    return { valid: false, error: 'Payload token verifikasi rusak.' };
  }

  if (!payload.wHash || !payload.preMemberUid || !payload.jti || !payload.exp) {
    return { valid: false, error: 'Data token verifikasi tidak lengkap.' };
  }
  if (Date.now() > payload.exp) {
    return { valid: false, error: 'Sesi verifikasi sudah berakhir (15 menit). Masukkan ulang kode verifikasi.' };
  }
  if (usedSessionJtis.has(payload.jti)) {
    return { valid: false, error: 'Token sesi verifikasi sudah digunakan sebelumnya.' };
  }

  if (options?.consume) {
    usedSessionJtis.add(payload.jti);
  }

  return { valid: true, payload };
}

/**
 * Issues a cryptographically random 6-digit One-Time Verification Code.
 * Stores ONLY the HMAC-SHA256 hash (never plaintext) in Firestore (when Admin SDK active)
 * and server-local registry (for Preview mode compatibility).
 */
export async function issueOnboardingVerificationCode(input: {
  normalizedWhatsapp: string;
  preMemberUid: string;
  memberId: string;
  branchId: BranchId;
  issuedBy: string;
  issuedByRole: AdminRole;
  nowMs?: number;
}): Promise<{
  verificationCode: string;
  record: OnboardingVerificationRecord;
}> {
  const now = input.nowMs ?? Date.now();
  const wHash = hashWhatsappServer(input.normalizedWhatsapp);
  const code = generateSixDigitCode();
  const codeSalt = crypto.randomBytes(16).toString('hex');
  const codeHmac = computeCodeHmac(wHash, code, codeSalt);

  const record: OnboardingVerificationRecord = {
    wHash,
    preMemberUid: input.preMemberUid,
    memberId: input.memberId,
    branchId: input.branchId,
    codeHmac,
    codeSalt,
    status: 'PENDING',
    used: false,
    attempts: 0,
    maxAttempts: ONBOARDING_CODE_MAX_ATTEMPTS,
    expiresAt: now + ONBOARDING_CODE_EXPIRY_MS,
    issuedBy: input.issuedBy,
    issuedByRole: input.issuedByRole,
    issuedAt: now,
    updatedAt: now,
  };

  // Persist to Firestore if Admin SDK is active
  const db = getAdminDb();
  if (db) {
    await db.collection('onboardingVerifications').doc(wHash).set(record);
  }

  // Always persist to protected local server registry (0600) so Client Preview mode works seamlessly
  const store = readLocalStore();
  store[wHash] = {
    ...record,
    normalizedWhatsapp: input.normalizedWhatsapp,
  };
  writeLocalStore(store);

  return { verificationCode: code, record };
}

/**
 * Verifies a 6-digit code against stored HMAC-SHA256 hash with max 5 attempts & expiry checks.
 * Returns a short-lived signed single-use onboardingSessionToken on success.
 */
export async function verifyOnboardingVerificationCode(input: {
  normalizedWhatsapp: string;
  code: string;
  nowMs?: number;
}): Promise<{
  verified: boolean;
  onboardingSessionToken?: string;
  preMemberUid?: string;
  memberId?: string;
  branchId?: BranchId;
  verifiedAt?: number;
  remainingAttempts?: number;
  error?: string;
}> {
  const now = input.nowMs ?? Date.now();
  const cleanCode = (input.code || '').trim();
  if (!isValidVerificationCodeFormat(cleanCode)) {
    return {
      verified: false,
      error: 'Kode verifikasi harus terdiri dari 6 digit angka dari Kasir XP PLAY.',
    };
  }

  const wHash = hashWhatsappServer(input.normalizedWhatsapp);
  const db = getAdminDb();
  const store = readLocalStore();

  let record: OnboardingVerificationRecord | null = null;
  if (db) {
    const snap = await db.collection('onboardingVerifications').doc(wHash).get();
    if (snap.exists) {
      record = snap.data() as OnboardingVerificationRecord;
    }
  }
  if (!record && store[wHash]) {
    record = store[wHash];
  }

  if (!record) {
    return {
      verified: false,
      error: 'Kode verifikasi tidak ditemukan. Silakan minta Kasir XP PLAY menerbitkan ulang kode verifikasi.',
    };
  }

  if (record.used || record.status === 'USED') {
    return {
      verified: false,
      error: 'Kode verifikasi sudah digunakan. Pendaftaran membership Anda sudah aktif.',
    };
  }

  if (record.status === 'REVOKED') {
    return {
      verified: false,
      error: 'Kode verifikasi ini sudah tidak berlaku. Gunakan kode terbaru dari Kasir XP PLAY.',
    };
  }

  if (now > record.expiresAt) {
    record.status = 'EXPIRED';
    record.updatedAt = now;
    if (db) {
      await db.collection('onboardingVerifications').doc(wHash).update({ status: 'EXPIRED', updatedAt: now });
    }
    if (store[wHash]) {
      store[wHash].status = 'EXPIRED';
      store[wHash].updatedAt = now;
      writeLocalStore(store);
    }
    return {
      verified: false,
      error: 'Kode verifikasi telah kadaluarsa. Silakan hubungi Kasir XP PLAY untuk menerbitkan kode baru.',
    };
  }

  if (record.attempts >= record.maxAttempts) {
    return {
      verified: false,
      remainingAttempts: 0,
      error: 'Batas percobaan kode verifikasi (5x) telah tercapai. Silakan minta Kasir menerbitkan kode baru.',
    };
  }

  const candidateHmac = computeCodeHmac(wHash, cleanCode, record.codeSalt);
  const matched = constantTimeHexEqual(candidateHmac, record.codeHmac);

  if (!matched) {
    const nextAttempts = record.attempts + 1;
    const remaining = Math.max(0, record.maxAttempts - nextAttempts);
    if (db) {
      await db.collection('onboardingVerifications').doc(wHash).update({
        attempts: nextAttempts,
        updatedAt: now,
      });
    }
    if (store[wHash]) {
      store[wHash].attempts = nextAttempts;
      store[wHash].updatedAt = now;
      writeLocalStore(store);
    }
    return {
      verified: false,
      remainingAttempts: remaining,
      error:
        remaining > 0
          ? `Kode verifikasi tidak sesuai. Sisa percobaan: ${remaining}x.`
          : 'Kode verifikasi salah dan batas percobaan (5x) tercapai. Minta Kasir menerbitkan kode baru.',
    };
  }

  // Matched! Issue signed short-lived single-use session token
  if (db) {
    await db.collection('onboardingVerifications').doc(wHash).update({
      status: 'VERIFIED',
      updatedAt: now,
    });
  }
  if (store[wHash]) {
    store[wHash].status = 'VERIFIED';
    store[wHash].updatedAt = now;
    writeLocalStore(store);
  }

  const sessionPayload: OnboardingSessionPayload = {
    wHash,
    normalizedWhatsapp: input.normalizedWhatsapp,
    preMemberUid: record.preMemberUid,
    memberId: record.memberId,
    branchId: record.branchId,
    verifiedAt: now,
    jti: crypto.randomBytes(16).toString('hex'),
    exp: now + SESSION_TTL_MS,
  };

  return {
    verified: true,
    onboardingSessionToken: signOnboardingSessionToken(sessionPayload),
    preMemberUid: record.preMemberUid,
    memberId: record.memberId,
    branchId: record.branchId,
    verifiedAt: now,
  };
}

export async function markOnboardingCodeUsed(normalizedWhatsapp: string, nowMs: number = Date.now()): Promise<void> {
  const wHash = hashWhatsappServer(normalizedWhatsapp);
  const db = getAdminDb();
  if (db) {
    await db
      .collection('onboardingVerifications')
      .doc(wHash)
      .update({ status: 'USED', used: true, updatedAt: nowMs })
      .catch(() => {});
  }
  const store = readLocalStore();
  if (store[wHash]) {
    store[wHash].status = 'USED';
    store[wHash].used = true;
    store[wHash].updatedAt = nowMs;
    writeLocalStore(store);
  }
}

export function lookupLocalOnboardingEntry(normalizedWhatsapp: string): StoredCodeEntry | null {
  const wHash = hashWhatsappServer(normalizedWhatsapp);
  const store = readLocalStore();
  return store[wHash] ?? null;
}
