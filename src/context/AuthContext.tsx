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
  DEFAULT_BRANCHES,
  DEFAULT_LEVELS,
  DEFAULT_SYSTEM_SETTINGS,
} from '../shared/xpLogic.ts';
import type {
  AdminUser,
  BranchInfo,
  LevelConfig,
  MemberProfile,
  SystemSettings,
} from '../types/xpplay.ts';

const BOOTSTRAP_SUPER_ADMINS = ['spv.xpplay@gmail.com'];

interface ServerCapabilities {
  adminSdkConfigured: boolean;
  recaptchaConfigured: boolean;
}

interface AuthContextValue {
  firebaseUser: User | null;
  memberProfile: MemberProfile | null;
  adminProfile: AdminUser | null;
  levels: LevelConfig[];
  branches: BranchInfo[];
  systemSettings: SystemSettings;
  capabilities: ServerCapabilities;
  loading: boolean;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  registerAdminWithEmail: (email: string, password: string, fullName: string) => Promise<void>;
  resendVerificationEmail: () => Promise<void>;
  reloadCurrentUser: () => Promise<void>;
  sendAdminPasswordReset: (email: string) => Promise<void>;
  signInWithServerToken: (customToken: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [memberProfile, setMemberProfile] = useState<MemberProfile | null>(null);
  const [adminProfile, setAdminProfile] = useState<AdminUser | null>(null);
  const [levels, setLevels] = useState<LevelConfig[]>(DEFAULT_LEVELS);
  const [branches, setBranches] = useState<BranchInfo[]>(DEFAULT_BRANCHES);
  const [systemSettings, setSystemSettings] = useState<SystemSettings>(DEFAULT_SYSTEM_SETTINGS);
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
  }, []);

  // Public level & branch config listeners
  useEffect(() => {
    const levelIds = ['BRONZE', 'SILVER', 'JURAGAN', 'SULTAN'] as const;
    Promise.all(
      levelIds.map(async (id) => {
        try {
          const snap = await getDoc(doc(db, 'levels', id));
          return snap.exists() ? (snap.data() as LevelConfig) : null;
        } catch {
          return null;
        }
      })
    ).then((res) => {
      const valid = res.filter((x): x is LevelConfig => x !== null);
      if (valid.length === 4) {
        setLevels(valid.sort((a, b) => a.rank - b.rank));
      }
    });

    const branchIds = ['DEMANG', 'SEKIP'] as const;
    Promise.all(
      branchIds.map(async (id) => {
        try {
          const snap = await getDoc(doc(db, 'branches', id));
          return snap.exists() ? (snap.data() as BranchInfo) : null;
        } catch {
          return null;
        }
      })
    ).then((res) => {
      const valid = res.filter((x): x is BranchInfo => x !== null);
      if (valid.length > 0) {
        setBranches(valid);
      }
    });
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
              permissions: {
                manageMembers: true,
                inputTransactions: true,
                reviewClaims: true,
                reviewRedemptions: true,
                manageCampaigns: true,
                manageBenefits: true,
                manageNotifications: true,
                manageSettings: true,
                manageAdmins: true,
                executeReset: true,
              },
              active: true,
              createdAt: now,
              updatedAt: now,
            };
            await setDoc(doc(db, 'admins', user.uid), newAdmin);
            resolvedAdmin = newAdmin;
          }
        } catch (err) {
          if (!isBootstrapAdmin) {
            const msg = err instanceof Error ? err.message : '';
            if (!msg.includes('permission-denied') && !msg.includes('insufficient permissions')) {
              console.warn('Admin check warning:', msg);
            }
          }
        }
      }

      if (resolvedAdmin) {
        await ensureClientAdminSeed(resolvedAdmin.uid);
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

    return () => {
      unsubMember();
      unsubSettings();
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
    if (auth.currentUser) {
      await loadUserProfiles(auth.currentUser);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        firebaseUser,
        memberProfile,
        adminProfile,
        levels,
        branches,
        systemSettings,
        capabilities,
        loading,
        signInWithEmail,
        registerAdminWithEmail,
        resendVerificationEmail,
        reloadCurrentUser,
        sendAdminPasswordReset,
        signInWithServerToken,
        logout,
        refreshProfiles,
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
