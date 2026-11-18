import type {
  BranchId,
  InactiveMemberRow,
  LevelId,
  MemberProfile,
} from '../types/xpplay.ts';

export const INACTIVE_PERIOD_PRESETS = [7, 14, 30, 60, 90, 180, 365] as const;

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function validateAdminNewPassword(
  newPassword: string,
  confirmPassword: string
): { valid: boolean; error: string | null } {
  if (!newPassword || typeof newPassword !== 'string') {
    return { valid: false, error: 'Password baru wajib diisi.' };
  }
  if (newPassword !== newPassword.trim()) {
    return { valid: false, error: 'Password tidak boleh diawali atau diakhiri spasi.' };
  }
  if (newPassword.length < 8) {
    return { valid: false, error: 'Password baru minimal 8 karakter.' };
  }
  if (newPassword.length > 128) {
    return { valid: false, error: 'Password baru maksimal 128 karakter.' };
  }
  const hasLetter = /[a-zA-Z]/.test(newPassword);
  const hasDigit = /[0-9]/.test(newPassword);
  if (!hasLetter || !hasDigit) {
    return {
      valid: false,
      error: 'Password baru harus mengandung kombinasi huruf dan angka demi keamanan akun member.',
    };
  }
  if (newPassword !== confirmPassword) {
    return { valid: false, error: 'Konfirmasi password baru tidak cocok.' };
  }
  return { valid: true, error: null };
}

export function calculateMemberInactivity(
  member: Pick<MemberProfile, 'lastPlayAt' | 'createdAt'>,
  now: number = Date.now()
): { daysInactive: number; baselineTimestamp: number; neverPlayed: boolean } {
  const neverPlayed = member.lastPlayAt === null || member.lastPlayAt === undefined;
  const baselineTimestamp = neverPlayed ? member.createdAt : (member.lastPlayAt as number);
  const diffMs = Math.max(0, now - baselineTimestamp);
  const daysInactive = Math.floor(diffMs / MS_PER_DAY);
  return { daysInactive, baselineTimestamp, neverPlayed };
}

export function isMemberInactive(
  member: Pick<MemberProfile, 'status' | 'lastPlayAt' | 'createdAt'>,
  thresholdDays: number,
  now: number = Date.now(),
  includeNeverPlayed: boolean = true
): boolean {
  if (member.status !== 'ACTIVE') return false;
  if (!Number.isFinite(thresholdDays) || thresholdDays < 1) return false;

  const { neverPlayed, baselineTimestamp } = calculateMemberInactivity(member, now);
  if (neverPlayed && !includeNeverPlayed) return false;

  const cutoff = now - thresholdDays * MS_PER_DAY;
  return baselineTimestamp <= cutoff;
}

export function sortInactiveRowsLongestFirst(rows: InactiveMemberRow[]): InactiveMemberRow[] {
  return [...rows].sort((a, b) => {
    if (b.daysInactive !== a.daysInactive) {
      return b.daysInactive - a.daysInactive;
    }
    if (a.baselineTimestamp !== b.baselineTimestamp) {
      return a.baselineTimestamp - b.baselineTimestamp;
    }
    return a.member.username.localeCompare(b.member.username);
  });
}

export interface InactiveFilterOptions {
  thresholdDays: number;
  now?: number;
  branch?: 'ALL' | BranchId;
  level?: 'ALL' | LevelId;
  search?: string;
  includeNeverPlayed?: boolean;
}

export function filterAndSortInactiveMembers(
  members: MemberProfile[],
  options: InactiveFilterOptions
): InactiveMemberRow[] {
  const now = options.now ?? Date.now();
  const includeNeverPlayed = options.includeNeverPlayed ?? true;
  const search = (options.search ?? '').trim().toLowerCase();

  const rows: InactiveMemberRow[] = [];
  for (const member of members) {
    if (!isMemberInactive(member, options.thresholdDays, now, includeNeverPlayed)) {
      continue;
    }
    if (options.branch && options.branch !== 'ALL') {
      const effectiveBranch = member.lastPlayBranch ?? member.preferredBranch;
      if (effectiveBranch !== options.branch) continue;
    }
    if (options.level && options.level !== 'ALL') {
      if (member.currentLevel !== options.level) continue;
    }
    if (search) {
      const haystack = `${member.fullName} ${member.username} ${member.whatsapp} ${member.memberId}`.toLowerCase();
      if (!haystack.includes(search)) continue;
    }

    const { daysInactive, baselineTimestamp, neverPlayed } = calculateMemberInactivity(member, now);
    rows.push({
      member,
      daysInactive,
      baselineTimestamp,
      neverPlayed,
    });
  }

  return sortInactiveRowsLongestFirst(rows);
}

export function buildInactiveNotificationDedupeKey(input: {
  inactivityDays: number;
  branch?: string;
  level?: string;
  now?: number;
}): string {
  const date = new Date(input.now ?? Date.now());
  // Jakarta date bucket (UTC+7) so repeat clicks on the same day do not spam the same member
  const jakartaMs = date.getTime() + 7 * 60 * 60 * 1000;
  const isoDay = new Date(jakartaMs).toISOString().slice(0, 10);
  const branchKey = (input.branch || 'ALL').toUpperCase();
  const levelKey = (input.level || 'ALL').toUpperCase();
  return `inact_${isoDay}_d${input.inactivityDays}_${branchKey}_${levelKey}`;
}

export function formatInactiveDurationLabel(daysInactive: number, neverPlayed: boolean): string {
  if (neverPlayed) {
    return daysInactive > 0 ? `Belum pernah main (${daysInactive} hari sejak daftar)` : 'Belum pernah main';
  }
  if (daysInactive >= 365) {
    const years = Math.floor(daysInactive / 365);
    const remDays = daysInactive % 365;
    return remDays > 0 ? `${daysInactive} hari (${years} thn ${remDays} hr)` : `${daysInactive} hari (${years} thn)`;
  }
  return `${daysInactive} hari`;
}
