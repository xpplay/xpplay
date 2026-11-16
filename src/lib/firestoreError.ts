import { auth } from './firebase.ts';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export function mapFriendlyError(
  error: unknown,
  fallback = 'Data tidak dapat diproses. Silakan coba lagi.'
): string {
  if (!(error instanceof Error)) return fallback;
  const msg = error.message;

  // Never expose raw JSON FirestoreErrorInfo or raw Firebase error codes to UI users
  if (msg.startsWith('{') && msg.includes('operationType')) {
    if (msg.includes('permission-denied') || msg.includes('insufficient permissions')) {
      return 'Anda tidak memiliki izin untuk melakukan tindakan ini.';
    }
    if (msg.includes('Quota exceeded')) {
      return 'Batas kuota harian database tercapai. Silakan coba kembali besok.';
    }
    return fallback;
  }

  if (msg.includes('auth/operation-not-allowed')) {
    return 'Metode login Email/Password belum diaktifkan di Firebase Console (Authentication → Sign-in method → Email/Password).';
  }
  if (msg.includes('auth/email-already-in-use')) {
    return 'Akun dengan kredensial tersebut sudah terdaftar. Silakan login.';
  }
  if (msg.includes('auth/weak-password')) {
    return 'Password terlalu lemah. Gunakan minimal 8 karakter kombinasi huruf dan angka.';
  }
  if (msg.includes('auth/invalid-email')) {
    return 'Format email tidak valid.';
  }
  if (msg.includes('auth/network-request-failed')) {
    return 'Koneksi jaringan terganggu. Periksa internet Anda dan coba lagi.';
  }
  if (msg.includes('auth/too-many-requests')) {
    return 'Terlalu banyak percobaan login. Silakan tunggu beberapa menit.';
  }
  if (
    msg.includes('auth/invalid-credential') ||
    msg.includes('auth/wrong-password') ||
    msg.includes('auth/user-not-found')
  ) {
    return 'Kredensial atau password tidak sesuai.';
  }
  if (msg.includes('Missing or insufficient permissions')) {
    return 'Anda tidak memiliki izin untuk mengakses data ini.';
  }
  if (msg.includes('Quota exceeded')) {
    return 'Batas kuota harian database tercapai. Silakan coba kembali besok.';
  }

  return msg || fallback;
}
