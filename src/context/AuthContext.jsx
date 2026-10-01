import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  updateProfile,
} from "firebase/auth";
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db, isFirebaseConfigured } from "../config/firebase.js";
import { readLocalUser, writeLocalUser, signOutLocalUser } from "../services/localStore.js";
import i18n from "../i18n/index.js";

const AuthContext = createContext(null);

const PLACEHOLDER_NAME = "Lock-on Learner";

const FATAL_AUTH_ERRORS = new Set([
  "auth/user-token-expired",
  "auth/invalid-user-token",
  "auth/token-expired",
  "auth/user-disabled",
  "auth/refresh-token-revoked",
]);

function createUserProfile(user, name) {
  return {
    name: name || user.displayName || user.email?.split('@')[0] || PLACEHOLDER_NAME,
    email: user.email,
    username: user.email?.split('@')[0] || "learner",
    bio: "",
    avatarUrl: "",
    avatarIcon: "",
    hasCustomAvatar: false,
    isAdmin: false,
    role: "user",
    xp: 0,
    energy: 0,
    totalScore: 0,
    streak: 0,
    totalStudyHours: 0,
    completedLessons: 0,
    completedTests: [],
    completedUnits: [],
    lastTestAttempt: null,
    goals: "",
    grade: "",
    curriculum: "",
    favoriteSubjects: [],
    theme: "system",
    preferredLanguage: "en",
    activity: {},
    onboardingCompleted: false,
    referralSource: "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

async function ensureUserDocument(user, name) {
  if (!db) return false;

  const userPath = `users/${user?.uid}`;

  try {
    const userRef = doc(db, "users", user.uid);
    const snapshot = await getDoc(userRef);

    if (!snapshot.exists()) {
      await setDoc(userRef, createUserProfile(user, name));
      return true;
    }

    const data = snapshot.data();
    const patch = {};

    // Core Identity
    if (!data.name) patch.name = name || user.displayName || user.email?.split('@')[0] || PLACEHOLDER_NAME;
    if (!data.email) patch.email = user.email;
    if (!data.username) patch.username = user.email?.split('@')[0] || "learner";

    // Migrate role -> isAdmin
    if (data.role === "admin" && data.isAdmin !== true) {
      patch.isAdmin = true;
    }

    // If the display name is the placeholder AND onboardingCompleted is not set,
    // treat as incomplete onboarding (only if explicitly undefined, not if false)
    if (data.name === PLACEHOLDER_NAME && data.onboardingCompleted === undefined) {
      patch.onboardingCompleted = false;
    }

    // Gamification Defaults
    if (typeof data.xp !== "number") patch.xp = 0;
    if (typeof data.energy !== "number") patch.energy = 0;
    if (typeof data.streak !== "number") patch.streak = 0;
    if (typeof data.totalStudyHours !== "number") patch.totalStudyHours = 0;
    if (typeof data.completedLessons !== "number") patch.completedLessons = 0;
    const expectedTotal = (data.xp || 0) + (data.energy || 0) * 100;
    if (typeof data.totalScore !== "number" || data.totalScore !== expectedTotal) patch.totalScore = expectedTotal;

    // Data Structures
    if (!Array.isArray(data.completedTests)) patch.completedTests = [];
    if (!Array.isArray(data.completedUnits)) patch.completedUnits = [];
    if (!Array.isArray(data.favoriteSubjects)) patch.favoriteSubjects = [];
    if (typeof data.activity !== "object" || data.activity === null) patch.activity = {};
    if (!("lastTestAttempt" in data)) patch.lastTestAttempt = null;

    // Profile Settings
    if (data.bio === undefined) patch.bio = "";
    if (data.goals === undefined) patch.goals = "";
    if (data.grade === undefined) patch.grade = "";
    if (data.curriculum === undefined) patch.curriculum = "";
    if (data.theme === undefined) patch.theme = "system";
    if (data.preferredLanguage === undefined) patch.preferredLanguage = "en";
    if (data.avatarUrl === undefined) patch.avatarUrl = "";
    if (data.avatarIcon === undefined) patch.avatarIcon = "";
    if (data.hasCustomAvatar === undefined) patch.hasCustomAvatar = false;

    // Onboarding
    if (data.onboardingCompleted === undefined) patch.onboardingCompleted = false;
    if (data.referralSource === undefined) patch.referralSource = "";

    if (Object.keys(patch).length) {
      patch.updatedAt = serverTimestamp();
      await setDoc(userRef, patch, { merge: true });
    }

    return true;
  } catch (error) {
    console.error(
      "[AuthContext] Firestore operation failed while ensuring the user document.",
      {
        uid: user?.uid,
        path: userPath,
        code: error?.code,
        message: error?.message ?? String(error),
      },
    );
    return false;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isFirebaseConfigured || !auth) {
      const localUser = readLocalUser();
      // If there's an existing local user from dev mode, migrate and use it
      if (localUser && localUser.uid) {
        // Build profile ensuring all required fields exist
        const defaultProfile = {
          uid: localUser.uid,
          name: localUser.name || "Local learner",
          email: localUser.email || "local@example.com",
          username: localUser.email?.split('@')[0] || "locallearner",
          bio: localUser.bio || "",
          avatarUrl: localUser.avatarUrl || "",
          avatarIcon: localUser.avatarIcon || "",
          hasCustomAvatar: localUser.hasCustomAvatar ?? false,
          isAdmin: localUser.isAdmin ?? false,
          xp: typeof localUser.xp === "number" ? localUser.xp : 120,
          energy: typeof localUser.energy === "number" ? localUser.energy : 85,
          totalScore: typeof localUser.totalScore === "number" ? localUser.totalScore : 12000,
          streak: typeof localUser.streak === "number" ? localUser.streak : 5,
          totalStudyHours: typeof localUser.totalStudyHours === "number" ? localUser.totalStudyHours : 8,
          completedLessons: Array.isArray(localUser.completedLessons) ? localUser.completedLessons : 14,
          completedTests: Array.isArray(localUser.completedTests) ? localUser.completedTests : [],
          completedUnits: Array.isArray(localUser.completedUnits) ? localUser.completedUnits : [],
          lastTestAttempt: localUser.lastTestAttempt || null,
          goals: localUser.goals || "Stay consistent",
          grade: localUser.grade || "11",
          curriculum: localUser.curriculum || "GCSE",
          favoriteSubjects: Array.isArray(localUser.favoriteSubjects) ? localUser.favoriteSubjects : ["Maths", "Science"],
          theme: localUser.theme || "system",
          activity: typeof localUser.activity === "object" && localUser.activity !== null ? localUser.activity : {},
          onboardingCompleted: localUser.onboardingCompleted ?? true,
          referralSource: localUser.referralSource || "local-demo",
          createdAt: localUser.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        setProfile(defaultProfile);
        setUser({ uid: defaultProfile.uid, email: defaultProfile.email, displayName: defaultProfile.name });
        setLoading(false);
        return undefined;
      }

      // No existing local user – create a fresh demo profile
      const demoProfile = {
        uid: "local-demo-user",
        name: "Local learner",
        email: "local@example.com",
        username: "locallearner",
        bio: "",
        avatarUrl: "",
        avatarIcon: "",
        hasCustomAvatar: false,
        isAdmin: false,
        xp: 120,
        energy: 85,
        totalScore: 12000,
        streak: 5,
        totalStudyHours: 8,
        completedLessons: 14,
        completedTests: [],
        completedUnits: [],
        lastTestAttempt: null,
        goals: "Stay consistent",
        grade: "11",
        curriculum: "GCSE",
        favoriteSubjects: ["Maths", "Science"],
        theme: "system",
        activity: {},
        onboardingCompleted: true,
        referralSource: "local-demo",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      writeLocalUser(demoProfile);
      setProfile(demoProfile);
      setUser({ uid: demoProfile.uid, email: demoProfile.email, displayName: demoProfile.name });
      setLoading(false);
      return undefined;
    }

    return onAuthStateChanged(
      auth,
      async (firebaseUser) => {
        setUser(firebaseUser);
        if (firebaseUser) {
          await ensureUserDocument(firebaseUser);
        } else {
          setProfile(null);
        }
        setLoading(false);
      },
      (authError) => {
        console.error(
          "[AuthContext] Firebase Auth observer reported an error. If this repeats, check the Firebase API key, authorized domains, and that the sign-in provider is enabled.",
          { code: authError?.code, message: authError?.message ?? String(authError) },
        );
        if (authError?.code && FATAL_AUTH_ERRORS.has(authError.code)) {
          signOutLocalUser();
          setUser(null);
          setProfile(null);
          auth.signOut().catch(() => {});
        }
        setLoading(false);
      },
    );
  }, []);

  // Apply theme whenever profile changes
  useEffect(() => {
    if (!profile?.theme) return;
    const root = document.documentElement;
    if (profile.theme === "dark") {
      root.classList.add("dark");
    } else if (profile.theme === "light") {
      root.classList.remove("dark");
    } else {
      // system preference
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.classList.toggle("dark", prefersDark);
    }
  }, [profile?.theme]);

  // Apply preferredLanguage whenever profile changes (login, snapshot update)
  useEffect(() => {
    if (profile?.preferredLanguage) {
      i18n.changeLanguage(profile.preferredLanguage);
    }
  }, [profile?.preferredLanguage]);

  useEffect(() => {
    if (!user || !db || loading) return undefined;
    const userPath = `users/${user.uid}`;
    const unsub = onSnapshot(
      doc(db, "users", user.uid),
      (snapshot) => {
        setProfile(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null);
      },
      (snapshotError) => {
        console.error(
          "[AuthContext] Firestore user profile subscription failed.",
          {
            uid: user.uid,
            path: userPath,
            code: snapshotError?.code,
            message: snapshotError?.message ?? String(snapshotError),
          },
        );
      },
    );
    return unsub;
  }, [user, loading]);

  const value = useMemo(
    () => ({
      user,
      profile,
      loading,
      isFirebaseConfigured,
      async login(email, password) {
        if (!auth || !isFirebaseConfigured) {
          const demoProfile = {
            uid: "local-demo-user",
            name: email?.split("@")[0] || "Local learner",
            email,
            username: email?.split("@")[0] || "locallearner",
            bio: "",
            avatarUrl: "",
            avatarIcon: "",
            hasCustomAvatar: false,
            isAdmin: false,
            xp: 120,
            energy: 85,
            totalScore: 12000,
            streak: 5,
            totalStudyHours: 8,
            completedLessons: 14,
            completedTests: [],
            completedUnits: [],
            lastTestAttempt: null,
            goals: "Stay consistent",
            grade: "11",
            curriculum: "GCSE",
            favoriteSubjects: ["Maths", "Science"],
            theme: "system",
            activity: {},
            onboardingCompleted: true,
            referralSource: "local-demo",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          writeLocalUser(demoProfile);
          setProfile(demoProfile);
          setUser({ uid: demoProfile.uid, email: demoProfile.email, displayName: demoProfile.name });
          return;
        }
        await signInWithEmailAndPassword(auth, email, password);
      },
      async register(name, email, password) {
        if (!auth || !isFirebaseConfigured) {
          const demoProfile = {
            uid: "local-demo-user",
            name: name || email?.split("@")[0] || "Local learner",
            email,
            username: email?.split("@")[0] || "locallearner",
            bio: "",
            avatarUrl: "",
            avatarIcon: "",
            hasCustomAvatar: false,
            isAdmin: false,
            xp: 120,
            energy: 85,
            totalScore: 12000,
            streak: 5,
            totalStudyHours: 8,
            completedLessons: 14,
            completedTests: [],
            completedUnits: [],
            lastTestAttempt: null,
            goals: "Stay consistent",
            grade: "11",
            curriculum: "GCSE",
            favoriteSubjects: ["Maths", "Science"],
            theme: "system",
            activity: {},
            onboardingCompleted: true,
            referralSource: "local-demo",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          writeLocalUser(demoProfile);
          setProfile(demoProfile);
          setUser({ uid: demoProfile.uid, email: demoProfile.email, displayName: demoProfile.name });
          return;
        }
        const result = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(result.user, { displayName: name });
        await ensureUserDocument(result.user, name);
      },
      async resetPassword(email) {
        if (!auth || !isFirebaseConfigured) {
          return;
        }
        await sendPasswordResetEmail(auth, email);
      },
      async changePassword(newPassword) {
        if (!auth || !auth.currentUser) throw new Error("Not authenticated.");
        await updatePassword(auth.currentUser, newPassword);
      },
      logout: () => {
        signOutLocalUser();
        setProfile(null);
        setUser(null);
        return auth && isFirebaseConfigured ? signOut(auth).catch(() => {}) : undefined;
      },
    }),
    [loading, profile, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
