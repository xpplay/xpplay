import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  onSnapshot,
  setDoc,
} from 'firebase/firestore';
import { auth, db } from '../lib/firebase.ts';
import { handleFirestoreError, OperationType } from '../lib/firestoreError.ts';
import {
  DEFAULT_HOMEPAGE_CMS,
  sanitizeHomepageCmsContent,
} from '../shared/cmsSanitizer.ts';
import {
  DEFAULT_BRANCHES,
  DEFAULT_LEVELS,
  DEFAULT_SYSTEM_SETTINGS,
} from '../shared/xpLogic.ts';
import {
  getDashboardRouteForRole,
  getDefaultPermissionsForRole,
  isCashierRole,
  isFullAdminRole,
} from '../shared/rbac.ts';
import { isMemberAllowedDashboardAccess } from '../shared/registrationLogic.ts';
import type {
  AdminUser,
  BranchInfo,
  CmsPublishedDoc,
  HomepageCmsContent,
  LevelConfig,
  MemberProfile,
  RestoreLockState,
  SystemSettings,
} from '../types/xpplay.ts';

const BOOTSTRAP_SUPER_ADMINS = ['spv.xpplay@gmail.com'];

interface ServerCapabilities {
  adminSdkConfigured: boolean;
  recaptchaConfigured: boolean;
}

interface CmsPublishedMeta {
  versionId: string;
  versionNumber: number;
  publishedAt: number;
}

interface AuthContextValue {
  firebaseUser: User | null;
  memberProfile: MemberProfile | null;
  adminProfile: AdminUser | null;
  levels: LevelConfig[];
  branches: BranchInfo[];
  systemSettings: SystemSettings;
  publishedHomepage: HomepageCmsContent;
  publishedCmsMeta: CmsPublishedMeta | null;
  restoreLock: RestoreLockState | null;
  capabilities: ServerCapabilities;
  loading: boolean;
  isCompletedMember: boolean;
  defaultRoute: string;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  registerAdminWithEmail: (email: string, password: string, fullName: string) => Promise<void>;
  resendVerificationEmail: () => Promise<void>;
  reloadCurrentUser: () => Promise<void>;
  sendAdminPasswordReset: (email: string) => Promise<void>;
  signInWithServerToken: (customToken: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
  refreshPublishedCms: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [memberProfile, setMemberProfile] = useState<MemberProfile | null>(null);
  const [adminProfile, setAdminProfile] = useState<AdminUser | null>(null);
  const [levels, setLevels] = useState<LevelConfig[]>(DEFAULT_LEVELS);
  const [branches, setBranches] = useState<BranchInfo[]>(DEFAULT_BRANCHES);
  const [systemSettings, setSystemSettings] = useState<SystemSettings>(DEFAULT_SYSTEM_SETTINGS);
  const [publishedHomepage, setPublishedHomepage] = useState<HomepageCmsContent>(
    DEFAULT_HOMEPAGE_CMS
  );
  const [publishedCmsMeta, setPublishedCmsMeta] = useState<CmsPublishedMeta | null>(null);
  const [restoreLock, setRestoreLock] = useState<RestoreLockState | null>(null);
  const [capabilities, setCapabilities] = useState<ServerCapabilities>({
    adminSdkConfigured: false,
    recaptchaConfigured: false,
  });
  const [loading, setLoading] = useState(true);
  const [profilesLoaded, setProfilesLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((data: Partial<ServerCapabilities>) => {
        setCapabilities({
          adminSdkConfigured: Boolean(data.adminSdkConfigured),
          recaptchaConfigured: Boolean(data.recaptchaConfigured),
        });
      })
      .catch(() => {});

    fetch('/api/system/maintenance')
      .then((r) => (r.ok ? r.json() : null))
      .then((lock: RestoreLockState | null) => {
        if (lock && typeof lock.locked === 'boolean') {
          setRestoreLock(lock);
        }
      })
      .catch(() => {});
  }, []);

  const [, setAuthRevision] = useState(0);

  const loadPublicConfigs = async () => {
    const levelIds = ['BRONZE', 'SILVER', 'JURAGAN', 'SULTAN'] as const;
    const levelRes = await Promise.all(
      levelIds.map(async (id) => {
        try {
          const snap = await getDoc(doc(db, 'levels', id));
          return snap.exists() ? (snap.data() as LevelConfig) : null;
        } catch {
          return null;
        }
      })
    );
    const validLevels = levelRes.filter((x): x is LevelConfig => x !== null);
    if (validLevels.length === 4) {
      setLevels(validLevels.sort((a, b) => a.rank - b.rank));
    }

    const branchIds = ['DEMANG', 'SEKIP'] as const;
    const branchRes = await Promise.all(
      branchIds.map(async (id) => {
        try {
          const snap = await getDoc(doc(db, 'branches', id));
          return snap.exists() ? (snap.data() as BranchInfo) : null;
        } catch {
          return null;
        }
      })
    );
    const validBranches = branchRes.filter((x): x is BranchInfo => x !== null);
    if (validBranches.length > 0) {
      setBranches(validBranches);
    }
  };

  const refreshPublishedCms = async () => {
    try {
      const snap = await getDoc(doc(db, 'cmsPublished', 'homepage'));
      if (snap.exists()) {
        const data = snap.data() as CmsPublishedDoc;
        setPublishedHomepage(sanitizeHomepageCmsContent(data.content));
        setPublishedCmsMeta({
          versionId: data.versionId,
          versionNumber: data.versionNumber,
          publishedAt: data.publishedAt,
        });
      }
    } catch {
      // keep safe default fallback
    }
  };

  // Public level, branch, and published CMS homepage listeners
  useEffect(() => {
    void loadPublicConfigs();
    const unsubCms = onSnapshot(
      doc(db, 'cmsPublished', 'homepage'),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as CmsPublishedDoc;
          setPublishedHomepage(sanitizeHomepageCmsContent(data.content));
          setPublishedCmsMeta({
            versionId: data.versionId,
            versionNumber: data.versionNumber,
            publishedAt: data.publishedAt,
          });
        } else {
          setPublishedHomepage(DEFAULT_HOMEPAGE_CMS);
          setPublishedCmsMeta(null);
        }
      },
      () => {
        // Fallback to defaults silently if offline or unreachable
      }
    );
    return () => unsubCms();
  }, []);

  const loadUserProfiles = async (user: User) => {
    try {
      const email = (user.email || '').toLowerCase();
      const isBootstrapAdmin = user.emailVerified && BOOTSTRAP_SUPER_ADMINS.includes(email);

      // Load admin profile (requires verified email for admin RBAC security)
      let resolvedAdmin: AdminUser | null = null;
      if (user.emailVerified) {
        try {
          const adminSnap = await getDoc(doc(db, 'admins', user.uid));
          if (adminSnap.exists()) {
            const data = adminSnap.data() as AdminUser;
            if (data.active) {
              resolvedAdmin = data;
            }
          } else if (isBootstrapAdmin) {
            const now = Date.now();
            const newAdmin: AdminUser = {
              uid: user.uid,
              email,
              fullName: user.displayName || 'Super Admin XP PLAY',
              role: 'SUPER_ADMIN',
              branchScope: 'ALL',
              branchId: null,
              cashierCode: null,
              permissions: getDefaultPermissionsForRole('SUPER_ADMIN'),
              active: true,
              createdAt: now,
              updatedAt: now,
            };
            await setDoc(doc(db, 'admins', user.uid), newAdmin);
            resolvedAdmin = newAdmin;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : '';
          if (isBootstrapAdmin) {
            console.error('Bootstrap admin initialization failed:', msg);
          } else if (!msg.includes('permission-denied') && !msg.includes('insufficient permissions')) {
            console.warn('Admin check warning:', msg);
          }
        }
      }

      if (resolvedAdmin && isFullAdminRole(resolvedAdmin.role)) {
        await ensureClientAdminSeed(resolvedAdmin.uid);
      }

      if (resolvedAdmin && isCashierRole(resolvedAdmin.role)) {
        const sessionKey = `xpplay_cashier_login_logged_${resolvedAdmin.uid}`;
        try {
          if (typeof sessionStorage !== 'undefined' && !sessionStorage.getItem(sessionKey)) {
            sessionStorage.setItem(sessionKey, String(Date.now()));
            const now = Date.now();
            const auditId = `audit_${now}_${Math.random().toString(36).slice(2, 8)}`;
            await setDoc(doc(db, 'auditLogs', auditId), {
              id: auditId,
              actorId: resolvedAdmin.uid,
              actorRole: resolvedAdmin.role,
              action: 'CASHIER_LOGIN',
              targetType: 'session',
              targetId: resolvedAdmin.uid,
              before: null,
              after: {
                role: resolvedAdmin.role,
                branchScope: resolvedAdmin.branchScope,
                branchId: resolvedAdmin.branchId ?? (resolvedAdmin.branchScope !== 'ALL' ? resolvedAdmin.branchScope : null),
              },
              metadata: { email: resolvedAdmin.email },
              timestamp: now,
            }).catch(() => {});
          }
        } catch {
          // Non-fatal
        }
      }

      setAdminProfile(resolvedAdmin);

      // Load systemSettings
      try {
        const settingsSnap = await getDoc(doc(db, 'systemSettings', 'default'));
        if (settingsSnap.exists()) {
          setSystemSettings(settingsSnap.data() as SystemSettings);
        }
      } catch {
        // fallback defaults
      }

      // Load member profile
      try {
        const memberSnap = await getDoc(doc(db, 'members', user.uid));
        setMemberProfile(memberSnap.exists() ? (memberSnap.data() as MemberProfile) : null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (!msg.includes('permission-denied')) {
          handleFirestoreError(err, OperationType.GET, `members/${user.uid}`);
        }
        setMemberProfile(null);
      }
    } finally {
      setProfilesLoaded(true);
      setLoading(false);
    }
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      if (!user) {
        setMemberProfile(null);
        setAdminProfile(null);
        setProfilesLoaded(true);
        setLoading(false);
        return;
      }
      setLoading(true);
      setProfilesLoaded(false);
      void loadUserProfiles(user);
    });
    return () => unsub();
  }, []);

  // Real-time listener on member's own document & settings once authenticated
  useEffect(() => {
    if (!firebaseUser || !profilesLoaded) return;

    const unsubMember = onSnapshot(
      doc(db, 'members', firebaseUser.uid),
      (snap) => {
        setMemberProfile(snap.exists() ? (snap.data() as MemberProfile) : null);
      },
      () => {
        // Ignore if doc doesn't exist yet
      }
    );

    const unsubSettings = onSnapshot(
      doc(db, 'systemSettings', 'default'),
      (snap) => {
        if (snap.exists()) {
          setSystemSettings(snap.data() as SystemSettings);
        }
      },
      () => {}
    );

    const unsubRestoreLock = onSnapshot(
      doc(db, 'systemOperations', 'restoreLock'),
      (snap) => {
        if (snap.exists()) {
          setRestoreLock(snap.data() as RestoreLockState);
        } else {
          setRestoreLock(null);
        }
      },
      () => {}
    );

    return () => {
      unsubMember();
      unsubSettings();
      unsubRestoreLock();
    };
  }, [firebaseUser, profilesLoaded]);

  const signInWithEmail = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
  };

  const registerAdminWithEmail = async (email: string, password: string, fullName: string) => {
    const cred = await createUserWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
    if (fullName.trim()) {
      await updateProfile(cred.user, { displayName: fullName.trim() });
    }
    await sendEmailVerification(cred.user);
  };

  const resendVerificationEmail = async () => {
    if (!auth.currentUser) {
      throw new Error('Tidak ada sesi aktif.');
    }
    await sendEmailVerification(auth.currentUser);
  };

  const reloadCurrentUser = async () => {
    if (!auth.currentUser) return;
    await auth.currentUser.reload();
    await auth.currentUser.getIdToken(true);
    setFirebaseUser(auth.currentUser);
    setAuthRevision((v) => v + 1);
    await loadUserProfiles(auth.currentUser);
  };

  const sendAdminPasswordReset = async (email: string) => {
    await sendPasswordResetEmail(auth, email.trim().toLowerCase());
  };

  const signInWithServerToken = async (customToken: string) => {
    await signInWithCustomToken(auth, customToken);
  };

  const logout = async () => {
    await signOut(auth);
    setMemberProfile(null);
    setAdminProfile(null);
  };

  const refreshProfiles = async () => {
    await loadPublicConfigs();
    if (auth.currentUser) {
      await loadUserProfiles(auth.currentUser);
    }
  };

  const isCompletedMember = isMemberAllowedDashboardAccess(memberProfile);
  const defaultRoute = adminProfile
    ? getDashboardRouteForRole(adminProfile.role)
    : isCompletedMember
      ? '/member'
      : '/';

  return (
    <AuthContext.Provider
      value={{
        firebaseUser,
        memberProfile,
        adminProfile,
        levels,
        branches,
        systemSettings,
        publishedHomepage,
        publishedCmsMeta,
        restoreLock,
        capabilities,
        loading,
        isCompletedMember,
        defaultRoute,
        signInWithEmail,
        registerAdminWithEmail,
        resendVerificationEmail,
        reloadCurrentUser,
        sendAdminPasswordReset,
        signInWithServerToken,
        logout,
        refreshProfiles,
        refreshPublishedCms,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

async function ensureClientAdminSeed(adminUid: string): Promise<void> {
  const now = Date.now();
  try {
    const settingsRef = doc(db, 'systemSettings', 'default');
    const settingsSnap = await getDoc(settingsRef);
    if (!settingsSnap.exists()) {
      await setDoc(settingsRef, {
        ...DEFAULT_SYSTEM_SETTINGS,
        updatedAt: now,
        updatedBy: adminUid,
      });
    }

    for (const branch of DEFAULT_BRANCHES) {
      const ref = doc(db, 'branches', branch.id);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, branch);
      }
    }

    for (const level of DEFAULT_LEVELS) {
      const ref = doc(db, 'levels', level.id);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, level);
      }
    }

    const cycleRef = doc(db, 'membershipCycles', DEFAULT_SYSTEM_SETTINGS.currentCycleId);
    const cycleSnap = await getDoc(cycleRef);
    if (!cycleSnap.exists()) {
      await setDoc(cycleRef, {
        id: DEFAULT_SYSTEM_SETTINGS.currentCycleId,
        name: 'Season 1 — 2026',
        startedAt: now,
        endedAt: null,
        status: 'ACTIVE',
        resetCount: 0,
        createdBy: adminUid,
      });
    }
  } catch {
    // Seed best-effort
  }
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth harus digunakan di dalam AuthProvider.');
  }
  return ctx;
}
