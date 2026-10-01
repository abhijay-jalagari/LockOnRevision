import { GoogleGenAI } from '@google/genai';
import { createLogger, withTimeout, retry } from './_lib/forge-integrity.js';
import { requireAuth } from './_lib/auth.js';

const log = createLogger('generate-timetable');

let googleAI;
let geminiModel;

try {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  geminiModel = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

  if (!geminiApiKey) {
    log.warn('GEMINI_API_KEY not set. AI functions will fail.');
  } else {
    googleAI = new GoogleGenAI({ apiKey: geminiApiKey });
  }
} catch (initError) {
  log.error('Module initialization error', initError);
}

function isConfigured() {
  return !!googleAI;
}

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function isWeekend(day) {
  return day === "Saturday" || day === "Sunday";
}

function generateAlgorithmicTimetable(prefs) {
  const {
    subjects,
    dailyMinutes,
    weekendMinutes,
    preferredTime,
    durationWeeks = 4,
    examDates: _examDates = [],
  } = prefs;

  const weekMinutes = dailyMinutes * 5 + (weekendMinutes || dailyMinutes) * 2;
  const totalMinutes = weekMinutes * durationWeeks;

  const subjectScores = subjects.map((s) => {
    const diff = ({ easy: 1, medium: 2, hard: 3 })[s.difficulty] || 2;
    const conf = Math.max(1, 10 - (s.confidence || 5));
    return { ...s, weight: diff + conf };
  });

  const totalWeight = subjectScores.reduce((sum, s) => sum + s.weight, 0);
  const subjectAllocation = subjectScores.map((s) => ({
    ...s,
    allocatedMinutes: Math.round((s.weight / totalWeight) * totalMinutes),
  }));

  const startDate = new Date();
  startDate.setDate(startDate.getDate() + (1 - startDate.getDay() || 7));
  const weeks = [];

  const subjectQueue = subjectAllocation.map((s) => ({ ...s, remaining: s.allocatedMinutes }));
  let slotCounter = 0;

  for (let w = 0; w < durationWeeks; w++) {
    const weekStart = new Date(startDate);
    weekStart.setDate(weekStart.getDate() + w * 7);
    const days = {};

    for (const day of DAYS) {
      const dayMin = isWeekend(day) ? (weekendMinutes || dailyMinutes) : dailyMinutes;
      if (dayMin <= 0) continue;

      const slots = [];
      let slotMin = 0;
      const sessionLen = 30;
      const preferredHour = parseInt(preferredTime?.split(":")[0] || 9, 10);

      while (slotMin < dayMin) {
        const available = subjectQueue.filter((s) => s.remaining > 0);
        if (!available.length) break;

        available.sort((a, b) => b.remaining - a.remaining);
        const pick = available[0];
        const sessionMinutes = Math.min(sessionLen, pick.remaining, dayMin - slotMin);

        const startH = preferredHour + Math.floor(slotMin / 60);
        const startM = slotMin % 60;

        slots.push({
          id: `slot-${slotCounter++}`,
          subject: pick.title,
          topic: pick.currentChapter || pick.title,
          duration: sessionMinutes,
          timeSlot: `${String(startH).padStart(2, "0")}:${String(startM).padStart(2, "0")}`,
          type: slotMin % 60 === 0 ? "revision" : "practice",
        });

        pick.remaining -= sessionMinutes;
        slotMin += sessionMinutes;
      }

      if (slots.length) days[day] = slots;
    }

    weeks.push({ weekNumber: w + 1, startDate: weekStart.toISOString().split("T")[0], days });
  }

  return { weeks, preferences: prefs };
}

export default requireAuth(async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const preferences = req.body;

    if (!preferences.subjects || !preferences.subjects.length) {
      return res.status(400).json({ error: "At least one subject is required." });
    }

    if (!preferences.dailyMinutes || preferences.dailyMinutes < 15) {
      return res.status(400).json({ error: "Daily study time must be at least 15 minutes." });
    }

    let timetable;

    if (!isConfigured()) {
      log.warn('Gemini not configured, using algorithmic fallback');
      timetable = generateAlgorithmicTimetable(preferences);
    } else {
      try {
        const prompt = buildPrompt(preferences);
        log.info('Calling Gemini for timetable generation');

        const result = await withTimeout(
          retry(() => googleAI.models.generateContent({ model: geminiModel, contents: prompt }), { logger: log }),
          30000
        );
        const raw = result.text;
        timetable = parseResponse(raw, preferences);
        log.info('Gemini timetable generated successfully');
      } catch (aiError) {
        log.warn('Gemini timetable generation failed, using algorithmic fallback', aiError);
        timetable = generateAlgorithmicTimetable(preferences);
      }
    }

    return res.status(200).json(timetable);
  } catch (error) {
    log.error("Error in generate-timetable", error);
    return res.status(500).json({ error: error.message });
  }
});

function buildPrompt(prefs) {
  const {
    grade,
    subjects,
    examDates = [],
    dailyMinutes,
    weekendMinutes,
    preferredTime = "09:00",
    durationWeeks = 4,
  } = prefs;

  const subjectLines = subjects
    .map(
      (s, i) =>
        `${i + 1}. "${s.title}" — difficulty: ${s.difficulty || "medium"}, confidence: ${s.confidence || 5}/10, chapter: "${s.currentChapter || s.title}"`,
    )
    .join("\n");

  const examLines = examDates.length
    ? examDates.map((e) => `- "${e.subject}" on ${e.date}`).join("\n")
    : "None specified yet.";

  const lang = prefs.preferredLanguage || "en";
  return `You are a study timetable planner. Generate a balanced weekly revision timetable in valid JSON.

IMPORTANT: Generate all content ONLY in the user's preferred language: "${lang}". All subject names, topic names, and any text in the timetable must be in this language. Maintain educational terminology appropriate for that language. Never translate from English afterwards.

STUDENT INFO:
- Grade: ${grade || "Not specified"}
- Daily study time: ${dailyMinutes} minutes
- Weekend study time: ${weekendMinutes || dailyMinutes} minutes
- Preferred start time: ${preferredTime}
- Duration: ${durationWeeks} weeks

SUBJECTS (with difficulty, confidence, and current chapter):
${subjectLines}

EXAM DATES:
${examLines}

Rules:
1. Each day must not exceed the available daily/ weekend time.
2. Distribute sessions across subjects proportionally — weaker/lower-confidence subjects get more time.
3. Sessions should be 30–60 minutes each.
4. No single subject should appear more than twice on the same day.
5. Prioritize subjects with upcoming exam dates in the final weeks.
6. Include short breaks (5-10 min) implicitly between sessions.
7. Return ONLY valid JSON — no markdown, no code fences.
8. Response format:
{
  "weeks": [
    {
      "weekNumber": 1,
      "startDate": "YYYY-MM-DD",
      "days": {
        "Monday": [ { "id": "slot-0", "subject": "...", "topic": "...", "duration": 45, "timeSlot": "09:00", "type": "revision" } ],
        "Tuesday": [],
        "Wednesday": [],
        "Thursday": [],
        "Friday": [],
        "Saturday": [],
        "Sunday": []
      }
    }
  ]
}`;
}

function parseResponse(raw, preferences) {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (parseError) {
    throw new Error("Invalid JSON response from AI model.");
  }

  if (!parsed.weeks || !Array.isArray(parsed.weeks)) {
    throw new Error("Invalid response structure: missing weeks array.");
  }

  return { ...parsed, preferences };
}
