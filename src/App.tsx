import type { ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { UnauthorizedPage } from './components/UnauthorizedPage.tsx';
import { AuthProvider, useAuth } from './context/AuthContext.tsx';
import { AdminDashboardPage } from './pages/AdminDashboardPage.tsx';
import { AdminLoginPage } from './pages/AdminLoginPage.tsx';
import { CashierDashboardPage } from './pages/CashierDashboardPage.tsx';
import { LandingPage } from './pages/LandingPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { MemberDashboardPage } from './pages/MemberDashboardPage.tsx';
import { RegisterPage } from './pages/RegisterPage.tsx';
import { getDashboardRouteForRole, isCashierRole, isFullAdminRole } from './shared/rbac.ts';
import {
  isMemberAllowedDashboardAccess,
  isPreRegisteredMember,
  PRE_REGISTERED_LOGIN_BLOCKED_MESSAGE,
} from './shared/registrationLogic.ts';

function FullScreenLoader() {
  return (
    <div className="min-h-screen gaming-canvas flex items-center justify-center p-4">
      <div className="text-center space-y-3">
        <div className="w-9 h-9 rounded-full border-2 border-sky-400 border-t-purple-500 animate-spin mx-auto shadow-[0_0_20px_rgba(56,189,248,0.45)]" />
        <p className="text-xs font-medium text-slate-300 tracking-wide">Memuat XP PLAY...</p>
      </div>
    </div>
  );
}

function MemberRoute({ children }: { children: ReactNode }) {
  const { firebaseUser, memberProfile, adminProfile, loading, logout } = useAuth();
  if (loading) return <FullScreenLoader />;
  if (!firebaseUser) return <Navigate to="/login" replace />;
  if (adminProfile && !memberProfile) {
    return <Navigate to={getDashboardRouteForRole(adminProfile.role)} replace />;
  }
  if (!memberProfile) return <Navigate to="/login" replace />;

  if (isPreRegisteredMember(memberProfile)) {
    const waParam = encodeURIComponent(memberProfile.whatsapp || '');
    return (
      <div className="min-h-screen gaming-canvas flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-[#0B1124] rounded-2xl border border-amber-400/40 p-6 sm:p-8 text-center space-y-4">
          <p className="font-mono text-xs font-semibold uppercase tracking-wider text-amber-300">
            Pendaftaran Belum Lengkap
          </p>
          <h1 className="font-display text-xl font-extrabold text-white">
            Selesaikan Pendaftaran Online
          </h1>
          <p className="text-sm text-slate-300 leading-relaxed">
            {PRE_REGISTERED_LOGIN_BLOCKED_MESSAGE}
          </p>
          <div className="flex flex-col gap-2.5 pt-2">
            <Link
              to={`/register?wa=${waParam}`}
              className="w-full h-[46px] inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 text-sm font-semibold text-white"
            >
              Lengkapi Pendaftaran
            </Link>
            <button
              type="button"
              onClick={() => void logout()}
              className="w-full h-[42px] rounded-xl border border-indigo-500/30 text-xs font-medium text-slate-300 hover:bg-[#101836]"
            >
              Keluar
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!isMemberAllowedDashboardAccess(memberProfile)) {
    return <>{children}</>;
  }

  return <>{children}</>;
}

function CashierRoute({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { firebaseUser, adminProfile, memberProfile, loading } = useAuth();
  if (loading) return <FullScreenLoader />;
  if (!firebaseUser) return <Navigate to="/cashier/login" replace />;
  if (!adminProfile) {
    if (memberProfile) {
      return (
        <UnauthorizedPage
          statusCode={403}
          attemptedPath={location.pathname}
          reason="Akun Member tidak diizinkan mengakses Dashboard Kasir."
        />
      );
    }
    return <Navigate to="/cashier/login" replace />;
  }
  if (!isCashierRole(adminProfile.role)) {
    return (
      <UnauthorizedPage
        statusCode={403}
        attemptedPath={location.pathname}
        reason="Halaman /cashier dikhususkan untuk akun Kasir cabang. Gunakan portal Admin / Superadmin Anda."
      />
    );
  }
  return <>{children}</>;
}

const SUPER_ADMIN_ONLY_PREFIXES = [
  '/admin/settings',
  '/admin/backup',
  '/admin/restore',
  '/admin/admins',
  '/admin/cashiers',
  '/admin/reset-cycle',
];

function AdminRoute({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { firebaseUser, adminProfile, memberProfile, loading } = useAuth();
  if (loading) return <FullScreenLoader />;
  if (!firebaseUser) return <Navigate to="/admin/login" replace />;
  if (!adminProfile) {
    if (memberProfile) {
      return (
        <UnauthorizedPage
          statusCode={403}
          attemptedPath={location.pathname}
          reason="Akun Member tidak memiliki akses ke Panel Admin."
        />
      );
    }
    return <Navigate to="/admin/login" replace />;
  }

  if (isCashierRole(adminProfile.role)) {
    return (
      <UnauthorizedPage
        statusCode={403}
        attemptedPath={location.pathname}
        reason="Role CASHIER tidak diizinkan mengakses Panel Admin, pengaturan XP/Level, CMS, atau manajemen sistem."
      />
    );
  }

  if (!isFullAdminRole(adminProfile.role)) {
    return <UnauthorizedPage statusCode={403} attemptedPath={location.pathname} />;
  }

  const lowerPath = location.pathname.toLowerCase();
  if (
    adminProfile.role !== 'SUPER_ADMIN' &&
    SUPER_ADMIN_ONLY_PREFIXES.some((prefix) => lowerPath === prefix || lowerPath.startsWith(`${prefix}/`))
  ) {
    return (
      <UnauthorizedPage
        statusCode={403}
        attemptedPath={location.pathname}
        reason="Halaman ini hanya dapat diakses oleh SUPER_ADMIN."
      />
    );
  }

  return <>{children}</>;
}

function SuperAdminRoute({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { firebaseUser, adminProfile, memberProfile, loading } = useAuth();
  if (loading) return <FullScreenLoader />;
  if (!firebaseUser) return <Navigate to="/admin/login" replace />;
  if (!adminProfile) {
    if (memberProfile) {
      return (
        <UnauthorizedPage
          statusCode={403}
          attemptedPath={location.pathname}
          reason="Akun Member tidak diizinkan mengakses Superadmin Console."
        />
      );
    }
    return <Navigate to="/admin/login" replace />;
  }

  if (adminProfile.role !== 'SUPER_ADMIN') {
    return (
      <UnauthorizedPage
        statusCode={403}
        attemptedPath={location.pathname}
        reason={`Role ${adminProfile.role} tidak diizinkan mengakses halaman Superadmin.`}
      />
    );
  }

  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/complete-membership" element={<RegisterPage />} />
          <Route path="/admin/login" element={<AdminLoginPage />} />
          <Route path="/cashier/login" element={<AdminLoginPage />} />
          <Route
            path="/member"
            element={
              <MemberRoute>
                <MemberDashboardPage />
              </MemberRoute>
            }
          />
          <Route
            path="/cashier"
            element={
              <CashierRoute>
                <CashierDashboardPage />
              </CashierRoute>
            }
          />
          <Route
            path="/cashier/*"
            element={
              <CashierRoute>
                <CashierDashboardPage />
              </CashierRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <AdminRoute>
                <AdminDashboardPage mode="ADMIN" />
              </AdminRoute>
            }
          />
          <Route
            path="/admin/*"
            element={
              <AdminRoute>
                <AdminDashboardPage mode="ADMIN" />
              </AdminRoute>
            }
          />
          <Route
            path="/superadmin"
            element={
              <SuperAdminRoute>
                <AdminDashboardPage mode="SUPER_ADMIN" />
              </SuperAdminRoute>
            }
          />
          <Route
            path="/superadmin/*"
            element={
              <SuperAdminRoute>
                <AdminDashboardPage mode="SUPER_ADMIN" />
              </SuperAdminRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
