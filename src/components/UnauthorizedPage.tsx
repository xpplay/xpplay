import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { logCashierAuditEvent } from '../services/xpService.ts';
import { getDashboardRouteForRole, isCashierRole } from '../shared/rbac.ts';

interface UnauthorizedPageProps {
  statusCode?: number;
  title?: string;
  reason?: string;
  attemptedPath?: string;
}

export function UnauthorizedPage({
  statusCode = 403,
  title = 'Akses Ditolak (Unauthorized)',
  reason = 'Role akun Anda tidak memiliki izin untuk membuka halaman atau fitur ini.',
  attemptedPath,
}: UnauthorizedPageProps) {
  const location = useLocation();
  const { adminProfile, memberProfile, defaultRoute, logout } = useAuth();
  const loggedRef = useRef(false);

  const pathDisplay = attemptedPath || location.pathname;

  useEffect(() => {
    if (loggedRef.current) return;
    if (adminProfile && isCashierRole(adminProfile.role)) {
      loggedRef.current = true;
      void logCashierAuditEvent({
        actor: adminProfile,
        action: 'CASHIER_DENIED_ACTION',
        targetType: 'route',
        targetId: pathDisplay,
        reason,
      });
    }
  }, [adminProfile, pathDisplay, reason]);

  const homeRoute = adminProfile
    ? getDashboardRouteForRole(adminProfile.role)
    : memberProfile
      ? '/member'
      : defaultRoute || '/';

  const homeLabel = adminProfile
    ? isCashierRole(adminProfile.role)
      ? 'Kembali ke Cashier Dashboard'
      : adminProfile.role === 'SUPER_ADMIN'
        ? 'Kembali ke Superadmin Console'
        : 'Kembali ke Admin Console'
    : memberProfile
      ? 'Kembali ke Member Dashboard'
      : 'Kembali ke Beranda';

  return (
    <div className="min-h-screen gaming-canvas text-slate-100 flex items-center justify-center p-4">
      <div className="max-w-lg w-full bg-[#0B1124] rounded-2xl border border-rose-500/40 p-6 sm:p-8 space-y-6 shadow-[0_0_40px_-14px_rgba(244,63,94,0.45)]">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-rose-500/15 border border-rose-500/40 text-rose-400 flex items-center justify-center shrink-0">
            <ShieldAlert className="w-6 h-6" />
          </div>
          <div className="min-w-0">
            <p className="font-mono text-xs font-semibold tracking-wider text-rose-400">
              HTTP {statusCode} · FORBIDDEN
            </p>
            <h1 className="mt-1 font-display text-2xl font-extrabold text-white tracking-tight">
              {title}
            </h1>
            <p className="mt-2 text-sm text-slate-300 leading-relaxed">{reason}</p>
          </div>
        </div>

        <div className="rounded-xl bg-[#070B19] border border-indigo-500/25 p-4 space-y-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Halaman yang dituju</span>
            <span className="font-mono text-rose-300 truncate">{pathDisplay}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Role aktif</span>
            <span className="font-mono font-semibold text-sky-300">
              {adminProfile?.role ?? (memberProfile ? 'MEMBER' : 'GUEST')}
              {adminProfile && isCashierRole(adminProfile.role) && adminProfile.branchScope !== 'ALL'
                ? ` · CABANG ${adminProfile.branchScope}`
                : ''}
            </span>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <Link
            to={homeRoute}
            className="flex-1 h-[46px] inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-4 text-sm font-semibold text-white hover:from-blue-500 hover:to-purple-500 transition-all"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>{homeLabel}</span>
          </Link>
          {(adminProfile || memberProfile) && (
            <button
              type="button"
              onClick={() => void logout()}
              className="h-[46px] rounded-xl border border-indigo-500/30 px-4 text-sm font-medium text-slate-300 hover:bg-[#101836] hover:text-white transition-colors"
            >
              Keluar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
