import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, KeyRound, Search, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import {
  changeMemberPasswordByAdmin,
  fetchPasswordChangeAuditLogs,
  findMemberByIdentifierAdmin,
} from '../services/xpService.ts';
import { validateAdminNewPassword } from '../shared/inactiveLogic.ts';
import { formatJakartaDateTime } from '../shared/xpLogic.ts';
import type { AdminUser, AuditLogRecord, MemberProfile } from '../types/xpplay.ts';

interface AdminPasswordManagementProps {
  adminProfile: AdminUser;
  adminSdkConfigured: boolean;
  restoreLocked: boolean;
  initialMember?: MemberProfile | null;
  onConsumeInitialMember?: () => void;
}

export function AdminPasswordManagement({
  adminProfile,
  adminSdkConfigured,
  restoreLocked,
  initialMember,
  onConsumeInitialMember,
}: AdminPasswordManagementProps) {
  const canManagePassword = adminProfile.role === 'SUPER_ADMIN' || adminProfile.role === 'ADMIN';

  const [lookupInput, setLookupInput] = useState('');
  const [searching, setSearching] = useState(false);
  const [selectedMember, setSelectedMember] = useState<MemberProfile | null>(null);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [revokeSessions, setRevokeSessions] = useState(true);
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');

  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Audit logs state
  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);
  const [auditCursor, setAuditCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [auditHasMore, setAuditHasMore] = useState(false);
  const [loadingLogs, setLoadingLogs] = useState(false);

  useEffect(() => {
    if (initialMember) {
      setSelectedMember(initialMember);
      setLookupInput(initialMember.username);
      setFeedback(null);
      onConsumeInitialMember?.();
    }
  }, [initialMember, onConsumeInitialMember]);

  const loadLogs = async (reset: boolean) => {
    setLoadingLogs(true);
    try {
      const res = await fetchPasswordChangeAuditLogs({
        pageSize: 15,
        cursor: reset ? null : auditCursor,
      });
      setAuditLogs((prev) => (reset ? res.items : [...prev, ...res.items]));
      setAuditCursor(res.lastCursor);
      setAuditHasMore(res.hasMore);
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setLoadingLogs(false);
    }
  };

  useEffect(() => {
    void loadLogs(true);
  }, []);

  const handleLookup = async (e: FormEvent) => {
    e.preventDefault();
    const q = lookupInput.trim();
    if (!q) return;
    setSearching(true);
    setFeedback(null);
    try {
      const found = await findMemberByIdentifierAdmin(q);
      if (!found) {
        setSelectedMember(null);
        setFeedback({ type: 'error', text: 'Member dengan username atau nomor WhatsApp tersebut tidak ditemukan.' });
      } else {
        setSelectedMember(found);
      }
    } catch (err) {
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setSearching(false);
    }
  };

  const pwdValidation = validateAdminNewPassword(newPassword, confirmPassword);
  const canOpenConfirm =
    canManagePassword &&
    adminSdkConfigured &&
    !restoreLocked &&
    selectedMember !== null &&
    selectedMember.status !== 'DELETED' &&
    pwdValidation.valid &&
    reason.trim().length >= 3;

  const handleOpenConfirm = (e: FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    if (!selectedMember) {
      setFeedback({ type: 'error', text: 'Cari dan pilih member terlebih dahulu.' });
      return;
    }
    if (!pwdValidation.valid) {
      setFeedback({ type: 'error', text: pwdValidation.error || 'Password baru tidak valid.' });
      return;
    }
    if (reason.trim().length < 3) {
      setFeedback({ type: 'error', text: 'Alasan perubahan password wajib diisi (minimal 3 karakter).' });
      return;
    }
    setConfirmModalOpen(true);
  };

  const handleConfirmChange = async () => {
    if (!selectedMember || submitting) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const opId = `pwd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const res = await changeMemberPasswordByAdmin({
        operationId: opId,
        memberUid: selectedMember.uid,
        newPassword,
        confirmPassword,
        reason: reason.trim(),
        reference: reference.trim(),
        revokeSessions,
      });
      // Immediately scrub sensitive password inputs from memory/UI
      setNewPassword('');
      setConfirmPassword('');
      setReason('');
      setReference('');
      setConfirmModalOpen(false);
      setFeedback({
        type: 'success',
        text: `Password member @${res.memberUsername} (${res.memberId}) berhasil diperbarui${
          res.sessionsRevoked ? ' dan sesi login lama telah dicabut' : ''
        }. Audit ID: ${res.auditId}.`,
      });
      await loadLogs(true);
    } catch (err) {
      setConfirmModalOpen(false);
      setFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-bold text-white">Manajemen Password Member</h2>
          <p className="text-sm text-slate-400 mt-1">
            Ubah password akun member secara aman melalui Firebase Admin SDK tanpa pernah menyimpan atau menampilkan password di log maupun database.
          </p>
        </div>
        <div className="text-xs text-slate-400 font-mono tabular-nums">
          Role Anda: <span className="text-sky-300 font-semibold">{adminProfile.role}</span>
        </div>
      </div>

      {!canManagePassword && (
        <div className="rounded-xl bg-amber-950/35 border border-amber-500/40 p-4 text-sm text-amber-200">
          Role <span className="font-semibold">{adminProfile.role}</span> hanya memiliki akses baca riwayat audit. Perubahan password member hanya diizinkan untuk <span className="font-semibold">SUPER_ADMIN</span> dan <span className="font-semibold">ADMIN</span>.
        </div>
      )}

      {!adminSdkConfigured && (
        <div className="rounded-xl bg-rose-950/35 border border-rose-500/40 p-4 space-y-1.5 text-sm text-rose-200">
          <div className="font-semibold flex items-center gap-2 text-rose-100">
            <ShieldAlert className="w-4 h-4 shrink-0" />
            Firebase Admin SDK Belum Aktif di Server
          </div>
          <p className="text-xs text-rose-200/90 leading-relaxed">
            Sesuai standar keamanan XP PLAY, perubahan password member oleh Admin dilarang dijalankan dari sisi browser. Konfigurasikan variabel lingkungan <span className="font-mono text-white">FIREBASE_SERVICE_ACCOUNT_JSON</span> di server untuk mengaktifkan fitur ini secara penuh.
          </p>
        </div>
      )}

      {restoreLocked && (
        <div className="rounded-xl bg-amber-950/40 border border-amber-500/40 p-4 text-sm text-amber-200">
          Restore Lock sedang aktif. Perubahan password member diblokir sementara hingga maintenance selesai.
        </div>
      )}

      {feedback && (
        <div
          className={`rounded-xl px-4 py-3 text-sm border ${
            feedback.type === 'success'
              ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
              : 'bg-rose-950/40 border-rose-500/40 text-rose-200'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Lookup + Form */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 rounded-xl bg-[#0B1124] border border-indigo-500/20 p-5 space-y-4">
          <h3 className="font-display text-sm font-bold text-white">1. Cari Akun Member</h3>
          <form onSubmit={handleLookup} className="flex gap-2">
            <input
              type="text"
              value={lookupInput}
              onChange={(e) => setLookupInput(e.target.value)}
              placeholder="Username atau nomor WhatsApp"
              className="flex-1 min-w-0 px-3.5 py-2.5 rounded-lg bg-[#070B19] border border-indigo-500/25 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-sky-400"
            />
            <button
              type="submit"
              disabled={searching || !lookupInput.trim()}
              className="px-4 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
            >
              <Search className="w-3.5 h-3.5" />
              {searching ? 'Mencari...' : 'Cari'}
            </button>
          </form>

          {selectedMember ? (
            <div className="pt-3 border-t border-indigo-500/15 space-y-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-white">{selectedMember.fullName}</span>
                <span className="font-mono text-xs text-sky-300">{selectedMember.memberId}</span>
              </div>
              <div className="text-xs text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>@{selectedMember.username}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">{selectedMember.whatsapp}</span>
                <span aria-hidden="true">·</span>
                <span>Level {selectedMember.currentLevel}</span>
                <span aria-hidden="true">·</span>
                <span className={selectedMember.status === 'ACTIVE' ? 'text-emerald-300' : 'text-amber-300'}>
                  {selectedMember.status}
                </span>
              </div>
              <div className="text-xs text-slate-400 font-mono tabular-nums pt-1">
                UID: {selectedMember.uid}
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500 pt-2">
              Masukkan username atau WhatsApp member yang meminta bantuan reset/penggantian password.
            </p>
          )}
        </div>

        <form
          onSubmit={handleOpenConfirm}
          className="lg:col-span-7 rounded-xl bg-[#0B1124] border border-indigo-500/20 p-5 space-y-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-display text-sm font-bold text-white">2. Tetapkan Password Baru</h3>
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="text-xs text-sky-300 hover:text-sky-200 flex items-center gap-1 whitespace-nowrap"
            >
              {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              {showPassword ? 'Sembunyikan' : 'Tampilkan'}
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-300">Password Baru (min. 8 karakter, huruf & angka)</span>
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={!canManagePassword || !adminSdkConfigured || restoreLocked}
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#070B19] border border-indigo-500/25 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-sky-400 disabled:opacity-50"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-300">Konfirmasi Password Baru</span>
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={!canManagePassword || !adminSdkConfigured || restoreLocked}
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#070B19] border border-indigo-500/25 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-sky-400 disabled:opacity-50"
              />
            </label>
          </div>

          {newPassword.length > 0 && !pwdValidation.valid && (
            <p className="text-xs text-amber-300">{pwdValidation.error}</p>
          )}
          {newPassword.length > 0 && pwdValidation.valid && (
            <p className="text-xs text-emerald-300 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5" />
              Kekuatan password memenuhi standar keamanan.
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-300">Alasan Perubahan (Wajib)</span>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={!canManagePassword || !adminSdkConfigured || restoreLocked}
                placeholder="Contoh: Member lupa password & verifikasi kasir Demang"
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#070B19] border border-indigo-500/25 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-sky-400 disabled:opacity-50"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-300">Referensi / Tiket (Opsional)</span>
              <input
                type="text"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                disabled={!canManagePassword || !adminSdkConfigured || restoreLocked}
                placeholder="Contoh: WA-2026-0412"
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#070B19] border border-indigo-500/25 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-sky-400 disabled:opacity-50"
              />
            </label>
          </div>

          <label className="flex items-start gap-2.5 text-xs text-slate-300 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={revokeSessions}
              onChange={(e) => setRevokeSessions(e.target.checked)}
              disabled={!canManagePassword || !adminSdkConfigured || restoreLocked}
              className="mt-0.5 rounded border-indigo-500/40 bg-[#070B19] text-sky-400 focus:ring-sky-400"
            />
            <span>
              Cabut seluruh sesi login aktif member (<span className="font-mono text-sky-300">revokeRefreshTokens</span>) agar perangkat lama otomatis logout.
            </span>
          </label>

          <div className="pt-2 flex items-center justify-between gap-4 border-t border-indigo-500/15">
            <span className="text-xs text-slate-500">
              Password tidak pernah dicatat dalam Audit Log maupun Firestore.
            </span>
            <button
              type="submit"
              disabled={!canOpenConfirm}
              className="px-4 py-2.5 rounded-lg bg-gradient-to-r from-sky-500 to-indigo-500 hover:from-sky-400 hover:to-indigo-400 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
            >
              <KeyRound className="w-3.5 h-3.5" />
              Ubah Password Member
            </button>
          </div>
        </form>
      </div>

      {/* Audit History */}
      <div className="rounded-xl bg-[#0B1124] border border-indigo-500/20 overflow-hidden">
        <div className="px-5 py-4 border-b border-indigo-500/15 flex items-center justify-between gap-4">
          <div>
            <h3 className="font-display text-sm font-bold text-white">Riwayat Audit Perubahan Password</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Menampilkan metadata immutable <span className="font-mono">PASSWORD_CHANGED_BY_ADMIN</span> tanpa kredensial mentah.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadLogs(true)}
            className="px-3 py-1.5 rounded-lg border border-indigo-500/25 text-xs text-slate-300 hover:text-white transition-colors whitespace-nowrap"
          >
            Muat Ulang
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#070B19] text-slate-400 border-b border-indigo-500/15">
              <tr>
                <th className="py-3 px-4 font-medium">Waktu (WIB)</th>
                <th className="py-3 px-4 font-medium">Member</th>
                <th className="py-3 px-4 font-medium">Admin</th>
                <th className="py-3 px-4 font-medium">Alasan & Referensi</th>
                <th className="py-3 px-4 font-medium">Revoke Sesi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-indigo-500/10 text-slate-200">
              {loadingLogs && auditLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500">
                    Memuat riwayat perubahan password...
                  </td>
                </tr>
              ) : auditLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500">
                    Belum ada riwayat perubahan password member oleh Admin.
                  </td>
                </tr>
              ) : (
                auditLogs.map((log) => {
                  const meta = (log.metadata || {}) as Record<string, unknown>;
                  return (
                    <tr key={log.id} className="hover:bg-indigo-500/5">
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-300 whitespace-nowrap">
                        {formatJakartaDateTime(log.timestamp)}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-white">@{String(meta.memberUsername || '-')}</div>
                        <div className="text-slate-400 font-mono">{String(meta.memberId || log.targetId)}</div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="text-slate-200">{String(meta.adminEmail || log.actorId)}</div>
                        <div className="text-slate-400">{log.actorRole}</div>
                      </td>
                      <td className="py-3 px-4 max-w-xs">
                        <div className="text-slate-200">{String(meta.reason || '-')}</div>
                        {Boolean(meta.reference) && (
                          <div className="text-slate-400 font-mono">Ref: {String(meta.reference)}</div>
                        )}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className={meta.sessionsRevoked ? 'text-emerald-300' : 'text-slate-400'}>
                          {meta.sessionsRevoked ? 'Ya (Dicabut)' : 'Tidak'}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {auditHasMore && (
          <div className="p-4 border-t border-indigo-500/15 text-center">
            <button
              type="button"
              disabled={loadingLogs}
              onClick={() => void loadLogs(false)}
              className="px-4 py-2 rounded-lg border border-indigo-500/30 text-xs text-sky-300 hover:text-white transition-colors"
            >
              {loadingLogs ? 'Memuat...' : 'Muat Lebih Banyak'}
            </button>
          </div>
        )}
      </div>

      {/* Confirmation Modal */}
      {confirmModalOpen && selectedMember && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-md w-full rounded-xl bg-[#0B1124] border border-indigo-500/30 p-6 space-y-4">
            <h3 className="font-display text-lg font-bold text-white">Konfirmasi Penggantian Password</h3>
            <p className="text-sm text-slate-300 leading-relaxed">
              Anda akan mengganti password akun <span className="font-semibold text-white">@{selectedMember.username}</span> ({selectedMember.fullName}) via Firebase Admin SDK.
            </p>
            <div className="rounded-lg bg-[#070B19] border border-indigo-500/20 p-3.5 space-y-1.5 text-xs text-slate-300">
              <div>
                <span className="text-slate-500">Member ID:</span>{' '}
                <span className="font-mono text-white">{selectedMember.memberId}</span>
              </div>
              <div>
                <span className="text-slate-500">Alasan:</span> <span className="text-white">{reason.trim()}</span>
              </div>
              <div>
                <span className="text-slate-500">Cabut sesi lama:</span>{' '}
                <span className="text-sky-300">{revokeSessions ? 'Ya' : 'Tidak'}</span>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setConfirmModalOpen(false)}
                className="px-4 py-2 rounded-lg border border-indigo-500/25 text-xs text-slate-300 hover:text-white"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleConfirmChange()}
                className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 text-xs font-semibold"
              >
                {submitting ? 'Memproses...' : 'Ya, Perbarui Password'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
