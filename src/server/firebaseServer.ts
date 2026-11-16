import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

export interface FirebaseAppletConfig {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId: string;
  storageBucket: string;
  messagingSenderId: string;
}

const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
export const firebaseAppletConfig: FirebaseAppletConfig = JSON.parse(
  fs.readFileSync(configPath, 'utf8')
);

let adminApp: App | null = null;
let adminAuthInstance: Auth | null = null;
let adminDbInstance: Firestore | null = null;
let adminAvailable = false;

function initAdminSdk(): void {
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  const gacPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();

  if (!saJson && !gacPath) {
    adminAvailable = false;
    return;
  }

  try {
    if (getApps().length === 0) {
      if (saJson) {
        const parsed = JSON.parse(saJson);
        adminApp = initializeApp({
          credential: cert(parsed),
          projectId: firebaseAppletConfig.projectId,
          storageBucket: firebaseAppletConfig.storageBucket,
        });
      } else {
        adminApp = initializeApp({
          projectId: firebaseAppletConfig.projectId,
          storageBucket: firebaseAppletConfig.storageBucket,
        });
      }
    } else {
      adminApp = getApps()[0];
    }

    adminAuthInstance = getAuth(adminApp);
    adminDbInstance = getFirestore(adminApp, firebaseAppletConfig.firestoreDatabaseId);
    adminAvailable = true;
  } catch (err) {
    console.warn('[XP PLAY] Firebase Admin SDK tidak aktif:', (err as Error).message);
    adminAvailable = false;
  }
}

initAdminSdk();

export function isAdminSdkAvailable(): boolean {
  return adminAvailable && adminDbInstance !== null && adminAuthInstance !== null;
}

export function getAdminAuth(): Auth | null {
  return adminAuthInstance;
}

export function getAdminDb(): Firestore | null {
  return adminDbInstance;
}

// ---------- Fallback RS256 Firebase ID Token Verifier (No Service Account Needed) ----------
interface CertCache {
  certs: Record<string, string>;
  expiresAt: number;
}

let certCache: CertCache | null = null;

async function getGooglePublicCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (certCache && now < certCache.expiresAt) {
    return certCache.certs;
  }
  const res = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
  );
  if (!res.ok) {
    throw new Error('Gagal mengambil sertifikat publik Google.');
  }
  const certs = (await res.json()) as Record<string, string>;
  const cc = res.headers.get('cache-control') || '';
  const maxAgeMatch = cc.match(/max-age=(\d+)/);
  const maxAgeMs = maxAgeMatch ? Number(maxAgeMatch[1]) * 1000 : 3600 * 1000;
  certCache = { certs, expiresAt: now + maxAgeMs };
  return certs;
}

function decodeBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = pad ? normalized + '='.repeat(4 - pad) : normalized;
  return Buffer.from(padded, 'base64');
}

export interface VerifiedTokenPayload {
  uid: string;
  email: string | null;
  emailVerified: boolean;
}

export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedTokenPayload> {
  if (adminAvailable && adminAuthInstance) {
    const decoded = await adminAuthInstance.verifyIdToken(idToken);
    return {
      uid: decoded.uid,
      email: decoded.email ?? null,
      emailVerified: Boolean(decoded.email_verified),
    };
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Format token tidak valid.');
  }

  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(decodeBase64Url(headerB64).toString('utf8')) as {
    alg?: string;
    kid?: string;
  };
  const payload = JSON.parse(decodeBase64Url(payloadB64).toString('utf8')) as {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    email?: string;
    email_verified?: boolean;
  };

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Algoritma token tidak didukung.');
  }

  const certs = await getGooglePublicCerts();
  const certPem = certs[header.kid];
  if (!certPem) {
    throw new Error('Kunci verifikasi token tidak ditemukan.');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();

  const signatureValid = verifier.verify(certPem, decodeBase64Url(sigB64));
  if (!signatureValid) {
    throw new Error('Signature token tidak valid.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expectedIssuer = `https://securetoken.google.com/${firebaseAppletConfig.projectId}`;
  if (
    payload.aud !== firebaseAppletConfig.projectId ||
    payload.iss !== expectedIssuer ||
    !payload.sub ||
    typeof payload.exp !== 'number' ||
    payload.exp <= nowSec ||
    typeof payload.iat !== 'number' ||
    payload.iat > nowSec + 300
  ) {
    throw new Error('Klaim token tidak valid atau sudah kadaluarsa.');
  }

  return {
    uid: payload.sub,
    email: payload.email ?? null,
    emailVerified: Boolean(payload.email_verified),
  };
}

export function getBootstrapSuperAdminEmails(): string[] {
  const raw = process.env.BOOTSTRAP_SUPER_ADMIN_EMAILS || 'spv.xpplay@gmail.com';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
