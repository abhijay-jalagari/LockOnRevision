import { collection, doc, onSnapshot, orderBy, query, serverTimestamp, writeBatch } from "firebase/firestore";
import { db, isFirebaseConfigured } from "../config/firebase.js";
import { getLocalUser, makeId, subscribeLocalState, updateLocalUser } from "./localStore.js";
import { apiFetch } from "../utils/apiFetch.js";
import i18n from "../i18n/index.js";

const STORAGE_KEY = "lockon-timetable-preferences";
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WEEKEND = new Set(["Saturday", "Sunday"]);

// ── Local persistence ────────────────────────────────────────────────

export function savePreferencesLocally(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch { /* noop */ }
}

export function loadPreferencesLocally() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── Generation ───────────────────────────────────────────────────────

export async function generateTimetable(preferences) {
  const payload = {
    ...preferences,
    preferredLanguage: i18n.language,
    subjects: (preferences.subjects || []).map((s) => ({
      title: s.title,
      difficulty: s.difficulty || "medium",
      confidence: Number(s.confidence) || 5,
      currentChapter: s.currentChapter || "",
    })),
  };

  if (!isFirebaseConfigured) {
    return generateLocalFallback(payload);
  }

  try {
    const response = await apiFetch("/api/generate-timetable", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `API request failed: ${response.status}`);
    }
    return response.json();
  } catch (error) {
    console.error("Timetable API error:", error);
    return generateLocalFallback(payload);
  }
}

function generateLocalFallback(prefs) {
  const {
    subjects = [],
    dailyMinutes = 60,
    weekendMinutes,
    preferredTime = "09:00",
    durationWeeks = 4,
  } = prefs;

  const weekMinutes = dailyMinutes * 5 + (weekendMinutes ?? dailyMinutes) * 2;
  const totalMinutes = weekMinutes * durationWeeks;

  const weighted = subjects.map((s) => {
    const diff = ({ easy: 1, medium: 2, hard: 3 })[s.difficulty] || 2;
    const need = Math.max(1, 10 - (Number(s.confidence) || 5));
    return { ...s, weight: diff + need };
  });

  const totalWeight = weighted.reduce((sum, s) => sum + s.weight, 0) || 1;
  const allocated = weighted.map((s) => ({
    ...s,
    remaining: Math.round((s.weight / totalWeight) * totalMinutes),
  }));

  const startDate = new Date();
  const daysUntilMonday = (1 - startDate.getDay() + 7) % 7;
  startDate.setDate(startDate.getDate() + daysUntilMonday);
  const weeks = fillWeeks(durationWeeks, startDate, allocated, dailyMinutes, weekendMinutes, preferredTime);
  return { weeks, preferences: prefs };
}

function fillWeeks(durationWeeks, startDate, allocated, dailyMinutes, weekendMinutes, preferredTime, slotSeed) {
  let slotId = slotSeed || 0;
  const weeks = [];

  for (let w = 0; w < durationWeeks; w++) {
    const weekStart = new Date(startDate);
    weekStart.setDate(weekStart.getDate() + w * 7);
    const days = {};
    const preferredHour = parseInt(preferredTime.split(":")[0] || 9, 10);

    for (const day of DAYS) {
      const dayMin = WEEKEND.has(day) ? (weekendMinutes ?? dailyMinutes) : dailyMinutes;
      if (dayMin <= 0) continue;

      const slots = [];
      let used = 0;
      const sessionLen = 30;

      while (used < dayMin) {
        const available = allocated.filter((s) => s.remaining > 0);
        if (!available.length) break;

        available.sort((a, b) => b.remaining - a.remaining);
        const pick = available[0];
        const sessionMin = Math.min(sessionLen, pick.remaining, dayMin - used);

        const startH = preferredHour + Math.floor(used / 60);
        const startM = used % 60;

        slots.push({
          id: `slot-${slotId++}`,
          subject: pick.title,
          topic: pick.currentChapter || pick.title,
          duration: sessionMin,
          timeSlot: `${String(startH).padStart(2, "0")}:${String(startM).padStart(2, "0")}`,
          type: used % 60 === 0 ? "revision" : "practice",
          completed: false,
          skipped: false,
        });

        pick.remaining -= sessionMin;
        used += sessionMin;
      }

      if (slots.length > 0) days[day] = slots;
    }

    weeks.push({ weekNumber: w + 1, startDate: weekStart.toISOString().split("T")[0], days });
  }

  return weeks;
}

// ── Persistence ──────────────────────────────────────────────────────

export async function saveTimetable(uid, timetable) {
  const id = makeId("timetable");
  const now = new Date().toISOString();

  if (!isFirebaseConfigured) {
    updateLocalUser(uid, (userData) => ({
      ...userData,
      timetables: [{ id, ...timetable, createdAt: now, updatedAt: now }, ...(userData.timetables || [])],
    }));
    return id;
  }

  const batch = writeBatch(db);
  const ref = doc(collection(db, "users", uid, "timetables"));
  batch.set(ref, { ...timetable, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  await batch.commit();
  return ref.id;
}

export async function updateTimetable(uid, timetableId, updatedFields) {
  if (!isFirebaseConfigured) {
    updateLocalUser(uid, (userData) => ({
      ...userData,
      timetables: (userData.timetables || []).map((t) =>
        t.id === timetableId ? { ...t, ...updatedFields, updatedAt: new Date().toISOString() } : t
      ),
    }));
    return;
  }

  const ref = doc(db, "users", uid, "timetables", timetableId);
  const batch = writeBatch(db);
  batch.update(ref, { ...updatedFields, updatedAt: serverTimestamp() });
  await batch.commit();
}

export function subscribeTimetables(uid, callback) {
  if (!isFirebaseConfigured) {
    return subscribeLocalState(() => callback(getLocalUser(uid)?.timetables || []));
  }
  return onSnapshot(
    query(collection(db, "users", uid, "timetables"), orderBy("updatedAt", "desc")),
    (snapshot) => callback(snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (error) => {
      console.error("[timetableService] Failed to subscribe to timetables:", error);
    },
  );
}

// ── Session mutation helpers ─────────────────────────────────────────

export function cloneTimetable(timetable) {
  return JSON.parse(JSON.stringify(timetable));
}

export function markSessionCompleted(timetable, weekIdx, day, slotId) {
  const t = cloneTimetable(timetable);
  const slots = t.weeks?.[weekIdx]?.days?.[day];
  if (!slots) return t;
  const slot = slots.find((s) => s.id === slotId);
  if (slot) { slot.completed = true; slot.skipped = false; }
  return t;
}

export function markSessionSkipped(timetable, weekIdx, day, slotId) {
  const t = cloneTimetable(timetable);
  const slots = t.weeks?.[weekIdx]?.days?.[day];
  if (!slots) return t;
  const slot = slots.find((s) => s.id === slotId);
  if (slot) { slot.skipped = true; slot.completed = false; }
  return t;
}

// ── Intelligent regeneration ─────────────────────────────────────────

export function regenerateRemaining(timetable) {
  const prefs = timetable.preferences || {};
  const { dailyMinutes = 60, weekendMinutes, preferredTime = "09:00" } = prefs;

  const now = new Date();
  const t = cloneTimetable(timetable);

  // Calculate remaining minutes per subject
  const completedMinutes = {};
  const allocatedMinutes = {};
  const weights = {};

  for (const week of t.weeks) {
    for (const day of DAYS) {
      const slots = week.days?.[day] || [];
      for (const slot of slots) {
        if (!completedMinutes[slot.subject]) completedMinutes[slot.subject] = 0;
        if (!allocatedMinutes[slot.subject]) allocatedMinutes[slot.subject] = 0;
        allocatedMinutes[slot.subject] += slot.duration || 0;
        if (slot.completed) completedMinutes[slot.subject] += slot.duration || 0;
      }
    }
  }

  // Build weight map from original preferences
  const subPrefs = {};
  for (const s of (prefs.subjects || [])) {
    const diff = ({ easy: 1, medium: 2, hard: 3 })[s.difficulty] || 2;
    const need = Math.max(1, 10 - (Number(s.confidence) || 5));
    weights[s.title] = diff + need;
    subPrefs[s.title] = s;
  }

  // Find the first uncompleted slot that is now or in the future
  let foundStart = false;
  const futureAllocated = [];

  for (let w = 0; w < t.weeks.length; w++) {
    const week = t.weeks[w];
    const weekStart = new Date(week.startDate + "T00:00:00");
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    for (const day of DAYS) {
      const slots = week.days?.[day] || [];
      if (!slots.length) continue;

      // Determine if this day is in the future
      const dayDate = new Date(weekStart);
      dayDate.setDate(dayDate.getDate() + DAYS.indexOf(day));

      for (const slot of slots) {
        const slotDateTime = new Date(`${dayDate.toISOString().split("T")[0]}T${slot.timeSlot}:00`);

        if (slot.completed) continue;

        if (!foundStart && slotDateTime <= now) {
          // Past uncompleted (skipped) — just mark it as skipped
          slot.skipped = true;
          continue;
        }

        if (!foundStart && slotDateTime > now) {
          foundStart = true;
        }

        if (foundStart) {
          futureAllocated.push({
            subject: slot.subject,
            duration: slot.duration,
            weight: weights[slot.subject] || 5,
          });
          slot._regenerated = true; // mark for replacement
        }
      }
    }
  }

  // If nothing to regenerate, return as-is
  if (futureAllocated.length === 0) return t;

  // Rebalance: reallocate remaining minutes proportionally
  const subjectRemaining = {};
  const subjectWeight = {};
  for (const s of futureAllocated) {
    subjectRemaining[s.subject] = (subjectRemaining[s.subject] || 0) + s.duration;
    subjectWeight[s.subject] = s.weight;
  }

  // Calculate how many future weeks we have
  let futureWeeks = 0;
  let futureStartDate = null;
  let slotSeed = 0;

  for (let w = 0; w < t.weeks.length; w++) {
    const week = t.weeks[w];
    let hasFuture = false;
    for (const day of DAYS) {
      const slots = week.days?.[day] || [];
      for (const slot of slots) {
        if (slot._regenerated) { hasFuture = true; break; }
        slotSeed = Math.max(slotSeed, parseInt((slot.id || "slot-0").replace("slot-", ""), 10) + 1);
      }
      if (hasFuture) break;
    }
    if (hasFuture) {
      if (!futureStartDate) {
        futureStartDate = new Date(week.startDate + "T00:00:00");
      }
      futureWeeks++;
    }
  }

  if (!futureStartDate || futureWeeks === 0) return t;

  // Remove regenerated slots
  for (const week of t.weeks) {
    for (const day of DAYS) {
      if (week.days?.[day]) {
        week.days[day] = week.days[day].filter((s) => !s._regenerated);
        if (week.days[day].length === 0) delete week.days[day];
      }
      delete week._regenerated;
    }
  }

  // Calculate allocated for future
  const totalFutureMinutes = Object.values(subjectRemaining).reduce((sum, m) => sum + m, 0);
  const daily = dailyMinutes;
  const weekend = weekendMinutes ?? dailyMinutes;
  const weekMins = daily * 5 + weekend * 2;
  const availableFuture = weekMins * futureWeeks;

  const scale = availableFuture > 0 ? totalFutureMinutes / availableFuture : 1;

  const newAllocated = Object.entries(subjectRemaining).map(([subject, mins]) => {
    const weight = subjectWeight[subject] || 5;
    return {
      title: subject,
      difficulty: subPrefs[subject]?.difficulty || "medium",
      confidence: subPrefs[subject]?.confidence || 5,
      currentChapter: subPrefs[subject]?.currentChapter || subject,
      weight,
      remaining: Math.round(mins * Math.min(1, scale)),
    };
  });

  // Generate new weeks
  const newWeeks = fillWeeks(futureWeeks, futureStartDate, newAllocated, dailyMinutes, weekendMinutes, preferredTime, slotSeed);

  // Merge back
  let nwIdx = 0;
  for (let w = 0; w < t.weeks.length; w++) {
    if (nwIdx < newWeeks.length) {
      const existing = t.weeks[w];
      // Check if this week has been cleared (had future slots)
      const hasExistingSlots = DAYS.some((d) => existing.days?.[d]?.length > 0);
      if (!hasExistingSlots) {
        t.weeks[w] = newWeeks[nwIdx];
        t.weeks[w].weekNumber = w + 1;
        nwIdx++;
      }
    }
  }

  return t;
}

// ── Dashboard helpers ────────────────────────────────────────────────

export function getTodaySessions(timetable) {
  if (!timetable?.weeks) return [];
  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];

  for (const week of timetable.weeks) {
    const weekStart = week.startDate;
    const weekEnd = new Date(weekStart + "T00:00:00");
    weekEnd.setDate(weekEnd.getDate() + 7);
    const today = new Date(todayStr + "T00:00:00");

    if (today >= new Date(weekStart + "T00:00:00") && today < weekEnd) {
      const dayName = DAYS[(today.getDay() + 6) % 7];
      const slots = week.days?.[dayName] || [];
      return slots.filter((s) => !s.completed && !s.skipped);
    }
  }
  return [];
}

export function getUpcomingLessons(timetable, limitCount = 5) {
  if (!timetable?.weeks) return [];
  const now = new Date();
  const upcoming = [];

  for (const week of timetable.weeks) {
    const weekStart = new Date(week.startDate + "T00:00:00");
    for (const day of DAYS) {
      const dayDate = new Date(weekStart);
      dayDate.setDate(dayDate.getDate() + DAYS.indexOf(day));
      const slots = week.days?.[day] || [];

      for (const slot of slots) {
        if (slot.completed || slot.skipped) continue;
        const slotDate = new Date(`${dayDate.toISOString().split("T")[0]}T${slot.timeSlot}:00`);
        if (slotDate > now) {
          upcoming.push({ ...slot, date: dayDate.toISOString().split("T")[0] });
          if (upcoming.length >= limitCount) return upcoming;
        }
      }
    }
  }
  return upcoming;
}

export function getWeeklyCompletion(timetable) {
  if (!timetable?.weeks) return { completed: 0, total: 0, percent: 0 };

  const now = new Date();
  let completed = 0;
  let total = 0;

  for (const week of timetable.weeks) {
    const weekStart = new Date(week.startDate + "T00:00:00");
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    if (now >= weekEnd) continue; // past weeks — skip or count fully?

    for (const day of DAYS) {
      const slots = week.days?.[day] || [];
      for (const slot of slots) {
        total++;
        if (slot.completed) completed++;
      }
    }
    break; // only current week
  }

  return {
    completed,
    total,
    percent: total > 0 ? Math.round((completed / total) * 100) : 0,
  };
}

export function getRemainingWorkload(timetable) {
  if (!timetable?.weeks) return { totalMinutes: 0, bySubject: [] };

  const now = new Date();
  const bySubject = {};
  let totalMinutes = 0;

  for (const week of timetable.weeks) {
    const weekStart = new Date(week.startDate + "T00:00:00");
    for (const day of DAYS) {
      const dayDate = new Date(weekStart);
      dayDate.setDate(dayDate.getDate() + DAYS.indexOf(day));
      const slots = week.days?.[day] || [];

      for (const slot of slots) {
        if (slot.completed) continue;
        const slotDate = new Date(`${dayDate.toISOString().split("T")[0]}T${slot.timeSlot}:00`);
        if (!slot.skipped && slotDate > now) {
          const mins = slot.duration || 0;
          totalMinutes += mins;
          bySubject[slot.subject] = (bySubject[slot.subject] || 0) + mins;
        }
      }
    }
  }

  return {
    totalMinutes,
    bySubject: Object.entries(bySubject)
      .map(([subject, minutes]) => ({ subject, minutes }))
      .sort((a, b) => b.minutes - a.minutes),
  };
}
