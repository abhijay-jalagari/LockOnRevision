import {
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions, isFirebaseConfigured } from "../config/firebase.js";
import { deleteForgeSubject, fetchForgeSubjects } from "./forgeService.js";
import { calculateTotalScore } from "./userService.js";
import { emitScoreChanged } from "./forgeEvents.js";
import { applyCompetitionRanking, mapUserData } from "./leaderboardService.js";

const ADMIN_FIELDS = new Set(["isAdmin", "role", "adminRewards"]);

function stripAdminFields(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const cleaned = { ...obj };
  for (const key of ADMIN_FIELDS) delete cleaned[key];
  return cleaned;
}

async function verifyAdminServer() {
  if (!functions) throw new Error("Firebase is not configured.");
  try {
    const check = httpsCallable(functions, "verifyAdminAccess");
    const result = await check();
    return result.data.admin === true;
  } catch (error) {
    console.error("[adminService] Admin verification failed:", error);
    throw new Error("Admin verification failed. Please try again.");
  }
}

async function requireAdmin() {
  const isAdmin = await verifyAdminServer();
  if (!isAdmin) throw new Error("Admin access required.");
}

export async function searchUsers(searchTerm = "", max = 50) {
  if (!db) throw new Error("Firebase is not configured.");
  await requireAdmin();

  const clampedMax = Math.min(Math.max(1, Number(max) || 50), 200);
  const snapshot = await getDocs(query(collection(db, "users"), limit(clampedMax)));
  const users = snapshot.docs.map((item) => stripAdminFields({ id: item.id, ...item.data() }));
  const term = (searchTerm ?? "").trim().toLowerCase();

  if (!term) return users;
  return users.filter(
    (user) =>
      user.name?.toLowerCase().includes(term) ||
      user.email?.toLowerCase().includes(term) ||
      user.id?.toLowerCase().includes(term),
  );
}

const MAX_ADJUSTMENT = 10000;

export async function adjustUserXp(uid, delta) {
  if (!db) throw new Error("Firebase is not configured.");
  await requireAdmin();
  const clampedDelta = Math.min(Math.max(Number(delta || 0), -MAX_ADJUSTMENT), MAX_ADJUSTMENT);
  const userRef = doc(db, "users", uid);

  const result = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(userRef);
    if (!snapshot.exists()) throw new Error("User not found.");

    const data = snapshot.data();
    const nextXp = Math.max(0, Number(data.xp || 0) + clampedDelta);
    const nextTotal = calculateTotalScore({ xp: nextXp, energy: data.energy || 0 });

    transaction.update(userRef, {
      xp: nextXp,
      totalScore: nextTotal,
      updatedAt: serverTimestamp(),
    });

    return { xp: nextXp, energy: data.energy || 0, totalScore: nextTotal, prevTotal: calculateTotalScore({ xp: data.xp || 0, energy: data.energy || 0 }) };
  });

  emitScoreChanged({ uid, reason: "admin-xp-adjust", totalChange: result.totalScore - result.prevTotal });
  return result;
}

export async function adjustUserEnergy(uid, delta) {
  if (!db) throw new Error("Firebase is not configured.");
  await requireAdmin();
  const clampedDelta = Math.min(Math.max(Number(delta || 0), -MAX_ADJUSTMENT), MAX_ADJUSTMENT);
  const userRef = doc(db, "users", uid);

  const result = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(userRef);
    if (!snapshot.exists()) throw new Error("User not found.");

    const data = snapshot.data();
    const nextEnergy = Math.max(0, Number(data.energy || 0) + clampedDelta);
    const nextTotal = calculateTotalScore({ xp: data.xp || 0, energy: nextEnergy });

    transaction.update(userRef, {
      energy: nextEnergy,
      totalScore: nextTotal,
      updatedAt: serverTimestamp(),
    });

    return { xp: data.xp || 0, energy: nextEnergy, totalScore: nextTotal, prevTotal: calculateTotalScore({ xp: data.xp || 0, energy: data.energy || 0 }) };
  });

  emitScoreChanged({ uid, reason: "admin-energy-adjust", totalChange: result.totalScore - result.prevTotal });
  return result;
}

export async function setUserTotalScore(uid, totalScore) {
  if (!db) throw new Error("Firebase is not configured.");
  await requireAdmin();
  const clampedScore = Math.min(Math.max(0, Number(totalScore || 0)), 1000000);
  const userRef = doc(db, "users", uid);

  const result = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(userRef);
    if (!snapshot.exists()) throw new Error("User not found.");

    transaction.update(userRef, {
      totalScore: clampedScore,
      updatedAt: serverTimestamp(),
    });

    return { totalScore: clampedScore };
  });

  emitScoreChanged({ uid, reason: "admin-set-score", totalChange: 0 });
  return result;
}

export async function grantLeaderboardReward(uid, { xp = 0, energy = 0, reason = "Admin reward" }) {
  if (!db) throw new Error("Firebase is not configured.");
  await requireAdmin();
  const clampedXp = Math.min(Math.max(0, Number(xp || 0)), MAX_ADJUSTMENT);
  const clampedEnergy = Math.min(Math.max(0, Number(energy || 0)), MAX_ADJUSTMENT);
  const userRef = doc(db, "users", uid);

  const result = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(userRef);
    if (!snapshot.exists()) throw new Error("User not found.");

    const data = snapshot.data();
    const nextXp = Math.max(0, Number(data.xp || 0) + clampedXp);
    const nextEnergy = Math.max(0, Number(data.energy || 0) + clampedEnergy);
    const nextTotal = calculateTotalScore({ xp: nextXp, energy: nextEnergy });
    const rewards = Array.isArray(data.adminRewards) ? data.adminRewards : [];

    transaction.update(userRef, {
      xp: nextXp,
      energy: nextEnergy,
      totalScore: nextTotal,
      adminRewards: [
        { xp: clampedXp, energy: clampedEnergy, reason, grantedAt: new Date().toISOString() },
        ...rewards,
      ].slice(0, 20),
      updatedAt: serverTimestamp(),
    });

    return { xp: nextXp, energy: nextEnergy, totalScore: nextTotal, prevTotal: calculateTotalScore({ xp: data.xp || 0, energy: data.energy || 0 }) };
  });

  emitScoreChanged({ uid, reason: "admin-reward", totalChange: result.totalScore - result.prevTotal });
  return result;
}

export async function fetchAllForgeSubjects() {
  if (!db) throw new Error("Firebase is not configured.");
  await requireAdmin();

  const usersSnap = await getDocs(query(collection(db, "users"), limit(100)));
  const results = [];

  for (const userDoc of usersSnap.docs) {
    const subjects = await fetchForgeSubjects(userDoc.id);
    subjects.forEach((subject) => {
      results.push({
        userId: userDoc.id,
        userName: userDoc.data().name || "Unknown",
        userEmail: userDoc.data().email || "",
        subject,
      });
    });
  }

  return results;
}

export async function moderateForgeSubject(userId, subjectId) {
  await requireAdmin();
  await deleteForgeSubject(userId, subjectId);
  return { ok: true };
}

export async function getAdminOverview() {
  if (!isFirebaseConfigured || !db) {
    return {
      available: false,
      message: "Firebase is not configured.",
    };
  }
  await requireAdmin();

  const usersSnap = await getDocs(query(collection(db, "users"), orderBy("totalScore", "desc"), limit(10)));
  const rawUsers = usersSnap.docs.map(mapUserData);
  const ranked = applyCompetitionRanking(rawUsers);
  return {
    available: true,
    topUsers: ranked.map((item) => stripAdminFields({
      id: item.id,
      rank: item._rank,
      ...item,
    })),
  };
}
