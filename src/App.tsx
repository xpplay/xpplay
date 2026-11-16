import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext.tsx';
import { AdminDashboardPage } from './pages/AdminDashboardPage.tsx';
import { AdminLoginPage } from './pages/AdminLoginPage.tsx';
import { LandingPage } from './pages/LandingPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { MemberDashboardPage } from './pages/MemberDashboardPage.tsx';
import { RegisterPage } from './pages/RegisterPage.tsx';

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
  const { firebaseUser, memberProfile, adminProfile, loading } = useAuth();
  if (loading) return <FullScreenLoader />;
  if (!firebaseUser) return <Navigate to="/login" replace />;
  if (adminProfile && !memberProfile) return <Navigate to="/admin" replace />;
  if (!memberProfile) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AdminRoute({ children }: { children: ReactNode }) {
  const { firebaseUser, adminProfile, loading } = useAuth();
  if (loading) return <FullScreenLoader />;
  if (!firebaseUser || !adminProfile) return <Navigate to="/admin/login" replace />;
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
          <Route path="/admin/login" element={<AdminLoginPage />} />
          <Route
            path="/member"
            element={
              <MemberRoute>
                <MemberDashboardPage />
              </MemberRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <AdminRoute>
                <AdminDashboardPage />
              </AdminRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
