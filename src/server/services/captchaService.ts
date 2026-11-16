import crypto from 'crypto';

interface CaptchaChallengeResponse {
  mode: 'recaptcha' | 'server_svg';
  siteKey?: string;
  challengeToken?: string;
  svg?: string;
  expiresAt: number;
}

const CAPTCHA_TTL_MS = 5 * 60 * 1000; // 5 minutes
const usedNonces = new Map<string, number>();

const EPHEMERAL_CAPTCHA_SECRET = crypto.randomBytes(32).toString('hex');

function getHmacSecret(): string {
  return (
    process.env.CAPTCHA_HMAC_SECRET ||
    process.env.GEMINI_API_KEY ||
    EPHEMERAL_CAPTCHA_SECRET
  );
}

function cleanupExpiredNonces(): void {
  const now = Date.now();
  for (const [nonce, expiresAt] of usedNonces.entries()) {
    if (expiresAt <= now) {
      usedNonces.delete(nonce);
    }
  }
}

export function isRecaptchaConfigured(): boolean {
  return Boolean(
    process.env.RECAPTCHA_SECRET_KEY?.trim() && process.env.VITE_RECAPTCHA_SITE_KEY?.trim()
  );
}

export function createCaptchaChallenge(): CaptchaChallengeResponse {
  cleanupExpiredNonces();
  const expiresAt = Date.now() + CAPTCHA_TTL_MS;

  if (isRecaptchaConfigured()) {
    return {
      mode: 'recaptcha',
      siteKey: process.env.VITE_RECAPTCHA_SITE_KEY!.trim(),
      expiresAt,
    };
  }

  // Generate 5-char unambiguous alphanumeric code (server-side only, never sent in plaintext)
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += alphabet[crypto.randomInt(0, alphabet.length)];
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${nonce}.${expiresAt}.${code}`;
  const hmac = crypto.createHmac('sha256', getHmacSecret()).update(payload).digest('hex');
  const challengeToken = Buffer.from(`${nonce}.${expiresAt}.${hmac}`).toString('base64url');

  // Render SVG server-side with mild distortion lines
  const charsMarkup = code
    .split('')
    .map((ch, idx) => {
      const x = 22 + idx * 30;
      const y = 34 + crypto.randomInt(-4, 5);
      const rot = crypto.randomInt(-14, 15);
      return `<text x="${x}" y="${y}" transform="rotate(${rot} ${x} ${y})" font-family="monospace" font-size="24" font-weight="700" fill="#0f172a">${ch}</text>`;
    })
    .join('');

  const noiseLines = Array.from({ length: 4 })
    .map(() => {
      const x1 = crypto.randomInt(0, 180);
      const y1 = crypto.randomInt(0, 52);
      const x2 = crypto.randomInt(0, 180);
      const y2 = crypto.randomInt(0, 52);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#94a3b8" stroke-width="1.2" opacity="0.6" />`;
    })
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="52" viewBox="0 0 180 52" role="img" aria-label="Kode verifikasi keamanan">
    <rect width="180" height="52" rx="8" fill="#f1f5f9" />
    ${noiseLines}
    ${charsMarkup}
  </svg>`;

  return {
    mode: 'server_svg',
    challengeToken,
    svg,
    expiresAt,
  };
}

export async function verifyCaptchaResponse(params: {
  token?: string;
  answer?: string;
  remoteIp?: string;
}): Promise<{ valid: boolean; error?: string }> {
  cleanupExpiredNonces();

  if (isRecaptchaConfigured()) {
    const recaptchaToken = params.token?.trim();
    if (!recaptchaToken) {
      return { valid: false, error: 'Silakan selesaikan verifikasi CAPTCHA terlebih dahulu.' };
    }
    try {
      const body = new URLSearchParams({
        secret: process.env.RECAPTCHA_SECRET_KEY!.trim(),
        response: recaptchaToken,
      });
      if (params.remoteIp) {
        body.set('remoteip', params.remoteIp);
      }
      const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const json = (await res.json()) as { success?: boolean; score?: number };
      if (!json.success || (typeof json.score === 'number' && json.score < 0.4)) {
        return { valid: false, error: 'Verifikasi CAPTCHA gagal. Silakan muat ulang dan coba lagi.' };
      }
      return { valid: true };
    } catch {
      return { valid: false, error: 'Layanan verifikasi CAPTCHA sedang gangguan. Silakan coba lagi.' };
    }
  }

  const challengeToken = params.token?.trim();
  const answer = params.answer?.trim().toUpperCase();
  if (!challengeToken || !answer) {
    return { valid: false, error: 'Kode CAPTCHA wajib diisi.' };
  }

  let decoded = '';
  try {
    decoded = Buffer.from(challengeToken, 'base64url').toString('utf8');
  } catch {
    return { valid: false, error: 'Token CAPTCHA tidak valid.' };
  }

  const parts = decoded.split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'Token CAPTCHA tidak valid.' };
  }

  const [nonce, expiresAtStr, providedHmac] = parts;
  const expiresAt = Number(expiresAtStr);
  if (!nonce || !Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return { valid: false, error: 'CAPTCHA sudah kedaluwarsa. Silakan muat ulang kode baru.' };
  }

  if (usedNonces.has(nonce)) {
    return { valid: false, error: 'Token CAPTCHA sudah digunakan. Silakan muat ulang kode baru.' };
  }

  const expectedPayload = `${nonce}.${expiresAt}.${answer}`;
  const expectedHmac = crypto
    .createHmac('sha256', getHmacSecret())
    .update(expectedPayload)
    .digest('hex');

  const bufA = Buffer.from(providedHmac, 'hex');
  const bufB = Buffer.from(expectedHmac, 'hex');
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    return { valid: false, error: 'Kode CAPTCHA tidak sesuai. Silakan periksa kembali.' };
  }

  // Mark nonce as consumed to prevent replay attacks
  usedNonces.set(nonce, expiresAt);
  return { valid: true };
}
