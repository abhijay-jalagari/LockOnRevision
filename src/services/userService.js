import { db, isFirebaseConfigured } from "../config/firebase.js";
import { emitScoreChanged } from "./forgeEvents.js";
import { calculateUnitReward } from "./energyService.js";

import { doc, updateDoc, increment, serverTimestamp, arrayUnion, arrayRemove, getDocs, getDoc, query, orderBy, collection, limit } from "firebase/firestore";

const ADMIN_FIELDS = new Set(["isAdmin", "role", "adminRewards"]);

function stripAdminFields(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const cleaned = { ...obj };
  for (const key of ADMIN_FIELDS) delete cleaned[key];
  return cleaned;
}

export async function fetchLeaderboard(limitCount = 50) {
  if (!isFirebaseConfigured) {
    const { readLocalState } = await import("./localStore.js");
    const state = readLocalState();
    const users = Object.entries(state.users || {}).map(([uid, data]) => stripAdminFields({
      id: uid,
      ...data.profile,
      xp: data.xp ?? data.profile?.xp ?? 0,
      energy: data.energy ?? data.profile?.energy ?? 0,
      totalScore: data.totalScore ?? data.profile?.totalScore ?? 0,
    }));
    return users.sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0)).slice(0, limitCount);
  }
  if (!db) throw new Error("Firebase is not configured.");
  const usersSnap = await getDocs(
    query(collection(db, "users"), orderBy("totalScore", "desc"), limit(limitCount))
  );
  return usersSnap.docs.map(doc => stripAdminFields({ id: doc.id, ...doc.data() }));
}

export function calculateTotalScore(profile) {
  const xp = Number(profile?.xp || 0);
  const energy = Number(profile?.energy || 0);
  return xp + energy * 100;
}

// PRESERVED for future development — Mock Tests backend logic
// Currently no user-facing UI; may be re-enabled in a later roadmap release.
export const TESTS = [
  { id: 'test-1', title: 'Foundations of Knowledge', difficulty: 'Easy', energy: 10, xp: 100 },
  { id: 'test-2', title: 'Intermediate Concepts', difficulty: 'Medium', energy: 20, xp: 250 },
  { id: 'test-3', title: 'Advanced Mastery', difficulty: 'Hard', energy: 40, xp: 500 },
];

export async function completeMockTest(uid, testId, score) {
  if (!db) throw new Error("Firebase is not configured.");
  const test = TESTS.find(t => t.id === testId);
  if (!test) throw new Error("Test not found.");

  const earnedEnergy = score >= 60 ? test.energy : 0;
  const earnedXp = score >= 60 ? test.xp : Math.round(test.xp * (score / 100));
  const earnedTotal = earnedXp + earnedEnergy * 100;

  const userRef = doc(db, "users", uid);
  await updateDoc(userRef, {
    xp: increment(earnedXp),
    energy: increment(earnedEnergy),
    totalScore: increment(earnedTotal),
    completedTests: arrayUnion(testId),
    updatedAt: serverTimestamp(),
  });

  emitScoreChanged({ uid, reason: "mock-test", totalChange: earnedTotal });
  return { earnedEnergy, earnedXp };
}

export async function completeUnit(uid, unitId, profile = {}) {
  if (!db) throw new Error("Firebase is not configured.");
  
  const userRef = doc(db, "users", uid);
  const userSnap = await getDoc(userRef);
  const userData = userSnap.exists() ? userSnap.data() : {};
  const completedUnits = userData.completedUnits || [];
  if (completedUnits.includes(unitId)) {
    return { earnedEnergy: 0, earnedXp: 0, alreadyCompleted: true };
  }
  
  const earnedEnergy = calculateUnitReward(profile);
  const earnedXp = 150;
  const earnedTotal = earnedXp + earnedEnergy * 100;
  
  await updateDoc(userRef, {
    xp: increment(earnedXp),
    energy: increment(earnedEnergy),
    totalScore: increment(earnedTotal),
    completedUnits: arrayUnion(unitId),
    updatedAt: serverTimestamp(),
  });
  
  emitScoreChanged({ uid, reason: "complete-unit", totalChange: earnedTotal });
  return { earnedEnergy, earnedXp };
}

const PROFILE_ALLOWED_FIELDS = [
  "name", "username", "bio", "avatarUrl", "avatarIcon", "hasCustomAvatar",
  "grade", "curriculum", "goals", "theme", "preferredLanguage",
  "favoriteSubjects", "referralSource", "onboardingCompleted",
];

export async function updateUserProfile(uid, updates) {
  if (!isFirebaseConfigured) {
    const { updateLocalUser } = await import("./localStore.js");
    updateLocalUser(uid, (userData) => ({
      ...userData,
      profile: { ...userData.profile, ...updates, updatedAt: new Date().toISOString() },
    }));
    return;
  }
  if (!db) throw new Error("Firebase is not configured.");
  const userRef = doc(db, "users", uid);
  const safeUpdates = Object.fromEntries(
    Object.entries(updates).filter(([key]) => PROFILE_ALLOWED_FIELDS.includes(key)),
  );
  return updateDoc(userRef, {
    ...safeUpdates,
    updatedAt: serverTimestamp(),
  });
}

export async function trackStudyTime(uid, minutes) {
  if (!db) throw new Error("Firebase is not configured.");
  const userRef = doc(db, "users", uid);
  const today = new Date().toISOString().split('T')[0];
  
  return updateDoc(userRef, {
    totalStudyHours: increment(minutes / 60),
    [`activity.${today}`]: increment(minutes / 60),
    updatedAt: serverTimestamp(),
  });
}

export async function updateGoal(uid, goalId, goalData) {
  if (!db) throw new Error("Firebase is not configured.");
  const userRef = doc(db, "users", uid);
  
  return updateDoc(userRef, {
    [`goals.${goalId}`]: goalData,
    updatedAt: serverTimestamp(),
  });
}

export async function toggleFavoriteSubject(uid, subjectName, currentlyFavorites) {
  if (!db) throw new Error("Firebase is not configured.");
  const userRef = doc(db, "users", uid);
  const isFavorited = currentlyFavorites?.includes(subjectName);
  return updateDoc(userRef, {
    favoriteSubjects: isFavorited ? arrayRemove(subjectName) : arrayUnion(subjectName),
    updatedAt: serverTimestamp(),
  });
}

export function calculateLevel(xp) {
  return Math.floor(Math.sqrt(xp / 100)) + 1;
}

export function getRank(level) {
  if (level < 5) return "Novice";
  if (level < 15) return "Apprentice";
  if (level < 30) return "Scholar";
  if (level < 50) return "Expert";
  return "Master";
}

export function getBadge(xp, lessonsCompleted, streak) {
  const badges = [];
  if (xp >= 1000) badges.push({ id: 'xp-1k', label: '1k XP Club', icon: '🏆' });
  if (lessonsCompleted >= 50) badges.push({ id: 'lesson-50', label: 'Consistent Learner', icon: '📚' });
  if (streak >= 7) badges.push({ id: 'streak-7', label: 'Week Warrior', icon: '🔥' });
  if (streak >= 30) badges.push({ id: 'streak-30', label: 'Month Master', icon: '🌟' });
  return badges;
}
