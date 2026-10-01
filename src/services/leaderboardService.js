import { calculateTotalScore } from "./userService.js";
import { db, isFirebaseConfigured } from "../config/firebase.js";
import { collection, query, orderBy, limit, getDocs } from "firebase/firestore";
import { subscribeLocalState } from "./localStore.js";
import { onLessonCompleted, onSessionCompleted, onScoreChanged } from "./forgeEvents.js";

const PAGE_SIZE = 20;

const ADMIN_FIELDS = new Set(["isAdmin", "role", "adminRewards"]);

function stripAdminFields(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const cleaned = { ...obj };
  for (const key of ADMIN_FIELDS) delete cleaned[key];
  return cleaned;
}

function calcTotal(user) {
  const score = Number(user.totalScore);
  if (Number.isFinite(score) && score !== 0) return score;
  return calculateTotalScore(user);
}

export function applyCompetitionRanking(users) {
  const scored = users
    .map((user) => ({ ...user, _score: calcTotal(user) }))
    .sort((a, b) => b._score - a._score || (a.name || "").localeCompare(b.name || ""));

  return scored.map((user, index, arr) => {
    if (index > 0 && user._score === arr[index - 1]._score) {
      return { ...user, _rank: arr[index - 1]._rank };
    }
    return { ...user, _rank: index + 1 };
  });
}

export function searchFilter(users, term) {
  if (!term || !term.trim()) return users;
  const q = term.trim().toLowerCase();
  return users.filter(
    (u) =>
      (u.name || "").toLowerCase().includes(q) ||
      (u.email || "").toLowerCase().includes(q) ||
      (u.username || "").toLowerCase().includes(q)
  );
}

function paginate(users, page, pageSize) {
  const start = (page - 1) * pageSize;
  return {
    items: users.slice(start, start + pageSize),
    total: users.length,
    page,
    totalPages: Math.max(1, Math.ceil(users.length / pageSize)),
  };
}

export async function getTopLeaderboardUsers() {
  const raw = await fetchAllUsers();
  return applyCompetitionRanking(raw);
}

export async function getLeaderboardUsers({ page = 1, pageSize = PAGE_SIZE, search = "" } = {}) {
  const raw = await fetchAllUsers();
  const ranked = applyCompetitionRanking(raw);
  const filtered = searchFilter(ranked, search);
  return paginate(filtered, page, pageSize);
}

async function fetchAllUsers() {
  if (!isFirebaseConfigured) {
    const { readLocalState } = await import("./localStore.js");
    const state = readLocalState();
    return Object.entries(state.users || {}).map(([uid, data]) => stripAdminFields({
      id: uid,
      ...data.profile,
      xp: data.xp ?? data.profile?.xp ?? 0,
      energy: data.energy ?? data.profile?.energy ?? 0,
      totalScore: data.totalScore ?? data.profile?.totalScore ?? 0,
    }));
  }
  if (!db) throw new Error("Firebase is not configured.");
  const usersSnap = await getDocs(
    query(collection(db, "users"), orderBy("totalScore", "desc"), limit(5000))
  );
  return usersSnap.docs.map((doc) => stripAdminFields({ id: doc.id, ...doc.data() }));
}

export function mapUserData(doc) {
  return stripAdminFields({
    id: doc.id,
    ...doc.data(),
    xp: doc.data().xp ?? 0,
    energy: doc.data().energy ?? 0,
    totalScore: doc.data().totalScore ?? 0,
  });
}

export async function findUserPage(uid, search = "", pageSize = PAGE_SIZE) {
  const raw = await fetchAllUsers();
  const ranked = applyCompetitionRanking(raw);
  const filtered = searchFilter(ranked, search);
  const idx = filtered.findIndex((u) => u.id === uid);
  if (idx === -1) return null;
  return Math.floor(idx / pageSize) + 1;
}

export function subscribeToLeaderboard(onChange) {
  const cleanups = [];

  const handler = () => onChange();

  if (!isFirebaseConfigured) {
    cleanups.push(subscribeLocalState(handler));
  }

  cleanups.push(onScoreChanged(handler));
  cleanups.push(onLessonCompleted(handler));
  cleanups.push(onSessionCompleted(handler));

  return () => cleanups.forEach((fn) => fn());
}

export { PAGE_SIZE };

export function buildLeaderboardResult(rawUsers, page = 1, pageSize = PAGE_SIZE, search = "") {
  const ranked = applyCompetitionRanking(rawUsers);
  const filtered = searchFilter(ranked, search);
  return paginate(filtered, page, pageSize);
}
