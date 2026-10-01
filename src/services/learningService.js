import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db, isFirebaseConfigured } from "../config/firebase.js";
import { getLocalUser, makeId, subscribeLocalState, updateLocalUser } from "./localStore.js";
import { uploadToCloudinary } from "../utils/cloudinary.js";
import { apiFetch } from "../utils/apiFetch.js";
import i18n from "../i18n/index.js";
import { emitScoreChanged } from "./forgeEvents.js";
import { calculateLessonReward } from "./energyService.js";

function localList(uid, name) {
  return getLocalUser(uid)?.[name] || [];
}

function sortByUpdated(items) {
  return [...items].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function emitLocalCollection(uid, name, callback) {
  return subscribeLocalState(() => {
    const items = localList(uid, name);
    if (name === "questions") {
      callback(sortByUpdated(items.filter((item) => Number(item.mastery || 0) < 70)).slice(0, 20));
      return;
    }
    callback(sortByUpdated(items).slice(0, name === "lessons" ? 24 : undefined));
  });
}

async function writeFirebaseCourse(uid, generated, sourceFileId = null) {
  const created = {
    subjects: [],
    units: [],
    lessons: [],
    questions: [],
  };

  for (const subjectInput of generated.subjects || []) {
    const subjectRef = await addDoc(collection(db, "users", uid, "subjects"), {
      title: subjectInput.title || "Generated Subject",
      description: subjectInput.description || "Generated from your notes.",
      unitCount: subjectInput.units?.length || 0,
      sourceFileId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    created.subjects.push(subjectRef.id);

    for (const unitInput of subjectInput.units || []) {
      const unitRef = await addDoc(collection(db, "users", uid, "units"), {
        subjectId: subjectRef.id,
        subjectName: subjectInput.title || "Generated Subject",
        title: unitInput.title || "Generated Unit",
        summary: unitInput.summary || "",
        sourceFileId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      created.units.push(unitRef.id);

      for (const lessonInput of unitInput.lessons || []) {
         const lessonRef = await addDoc(collection(db, "users", uid, "lessons"), {
           subjectId: subjectRef.id,
           unitId: unitRef.id,
           subjectName: subjectInput.title || "Generated Subject",
           unitName: unitInput.title || "Generated Unit",
           title: lessonInput.title || "Generated Lesson",
           summary: lessonInput.summary || "",
           explanation: lessonInput.explanation || "",
           examples: lessonInput.examples || [],
           mastery: 45,
           difficulty: lessonInput.difficulty || "medium",
           sourceFileId,
           createdAt: serverTimestamp(),
           updatedAt: serverTimestamp(),
         });
        created.lessons.push(lessonRef.id);

        for (const questionInput of lessonInput.questions || []) {
          const options = Array.isArray(questionInput.options) ? questionInput.options.slice(0, 4) : [];
          const questionRef = await addDoc(collection(db, "users", uid, "questions"), {
            subjectId: subjectRef.id,
            unitId: unitRef.id,
            lessonId: lessonRef.id,
            subjectName: subjectInput.title || "Generated Subject",
            unitName: unitInput.title || "Generated Unit",
            lessonTitle: lessonInput.title || "Generated Lesson",
            prompt: questionInput.prompt || `What is the key idea in ${lessonInput.title || "this lesson"}?`,
            options,
            correctAnswer: questionInput.correctAnswer || options[0],
            explanation: questionInput.explanation || "",
            topic: questionInput.topic || lessonInput.title || "Generated Lesson",
            difficulty: questionInput.difficulty || lessonInput.difficulty || "medium",
            mastery: 45,
            attempts: 0,
            correctAttempts: 0,
            sourceFileId,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          created.questions.push(questionRef.id);
        }
      }
    }
  }

  await updateDoc(doc(db, "users", uid), {
    "dailyUsage.aiRequests": increment(1),
    "dailyUsage.uploadsProcessed": increment(1),
    updatedAt: serverTimestamp(),
  });

  return created;
}

async function buildFirebaseGeminiCourse(uid, sourceText, sourceFileId = null) {
  const response = await apiFetch('/api/generate-learning-content', {
    method: 'POST',
    body: JSON.stringify({ sourceText, preferredLanguage: i18n.language }),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `API request failed: ${response.status}`);
  }

  const generated = await response.json();
  return writeFirebaseCourse(uid, generated, sourceFileId);
}

export function subscribeUserCollection(uid, name, callback, constraints = []) {
  if (!isFirebaseConfigured) {
    return emitLocalCollection(uid, name, callback);
  }
  return onSnapshot(query(collection(db, "users", uid, name), ...constraints), (snapshot) => {
    callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
  }, (error) => {
    console.error(`[learningService] Failed to subscribe to ${name}:`, error);
  });
}

export function subscribeSubjects(uid, callback) {
  return subscribeUserCollection(uid, "subjects", callback, [orderBy("updatedAt", "desc")]);
}

export function subscribeLessons(uid, callback) {
  return subscribeUserCollection(uid, "lessons", callback, [orderBy("updatedAt", "desc"), limit(24)]);
}

export function subscribeWeakQuestions(uid, callback) {
  return subscribeUserCollection(uid, "questions", callback, [
    where("mastery", "<", 70),
    orderBy("mastery", "asc"),
    limit(20),
  ]);
}

export async function getWrongAnswers(uid) {
  if (!isFirebaseConfigured) {
    return sortByUpdated(localList(uid, "answers").filter((answer) => !answer.isCorrect)).slice(0, 20);
  }
  const snapshot = await getDocs(
    query(
      collection(db, "users", uid, "answers"),
      where("isCorrect", "==", false),
      orderBy("answeredAt", "desc"),
      limit(20),
    ),
  );
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

export async function uploadNoteFile(uid, file, onProgress) {
  if (!isFirebaseConfigured) {
    onProgress?.(35);
    const content = /\.(txt|md)$/i.test(file.name) ? await file.text() : `Notes uploaded as ${file.name}.`;
    onProgress?.(100);
    const localFile = {
      id: makeId("file"),
      name: file.name,
      size: file.size,
      type: file.type,
      content,
      status: "uploaded",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    updateLocalUser(uid, (userData) => ({ ...userData, files: [localFile, ...userData.files] }));
    return localFile;
  }

  onProgress?.(20);

  const resourceType = file.type === 'application/pdf' ? 'raw' : 'auto';
  const uploadResult = await uploadToCloudinary(file, {
    folder: `lockon-revision/${uid}/learning`,
    resourceType,
  });

  onProgress?.(80);

  const fileDoc = await addDoc(collection(db, "users", uid, "files"), {
    name: file.name,
    size: file.size,
    type: file.type,
    cloudinaryPublicId: uploadResult.publicId,
    url: uploadResult.url,
    format: uploadResult.format,
    width: uploadResult.width,
    height: uploadResult.height,
    status: "uploaded",
    createdAt: serverTimestamp(),
  });

  onProgress?.(100);

  return { id: fileDoc.id, url: uploadResult.url, cloudinaryPublicId: uploadResult.publicId };
}

export async function processUploadedFile(uid, fileId) {
  if (!isFirebaseConfigured) {
    throw new Error("Gemini API is not available in local mode. Configure Firebase to use AI generation.");
  }

  const fileSnap = await getDoc(doc(db, "users", uid, "files", fileId));
  if (!fileSnap.exists()) throw new Error("File not found in database.");
  const fileData = fileSnap.data();

  const response = await apiFetch('/api/process-uploaded-notes', {
    method: 'POST',
    body: JSON.stringify({
      uid,
      fileId,
      url: fileData.url,
      mimeType: fileData.type,
      preferredLanguage: i18n.language
    }),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `API request failed: ${response.status}`);
  }

  return await response.json();
}

export async function processRawNotes(uid, text) {
  if (!isFirebaseConfigured) {
    throw new Error("Gemini API is not available in local mode. Configure Firebase to use AI generation.");
  }
  return buildFirebaseGeminiCourse(uid, text);
}

export async function getUserLearningContext(uid) {
  if (!isFirebaseConfigured) {
    const state = JSON.parse(localStorage.getItem("lockon-revision-local-state") || "{}");
    const userData = state.users?.[uid];
    if (!userData) return null;

    return {
      subjects: userData.subjects || [],
      units: userData.units || [],
      lessons: userData.lessons || [],
    };
  }

  try {
    const subjectsSnap = await getDocs(collection(db, "users", uid, "subjects"));
    const unitsSnap = await getDocs(collection(db, "users", uid, "units"));
    const lessonsSnap = await getDocs(collection(db, "users", uid, "lessons"));

    return {
      subjects: subjectsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      units: unitsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      lessons: lessonsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    };
  } catch (error) {
    console.error("Error fetching learning context:", error);
    return null;
  }
}

export async function getHint(questionId) {
  if (!isFirebaseConfigured) {
    throw new Error("Gemini API is not available in local mode. Configure Firebase to use AI generation.");
  }

  const response = await apiFetch('/api/generate-question-hint', {
    method: 'POST',
    body: JSON.stringify({ questionId, preferredLanguage: i18n.language }),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `API request failed: ${response.status}`);
  }

  const result = await response.json();
  return result.hint;
}

export async function explainWrongAnswer(questionId, selectedAnswer) {
  if (!isFirebaseConfigured) {
    throw new Error("Gemini API is not available in local mode. Configure Firebase to use AI generation.");
  }

  const response = await apiFetch('/api/explain-wrong-answer', {
    method: 'POST',
    body: JSON.stringify({ questionId, selectedAnswer, preferredLanguage: i18n.language }),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `API request failed: ${response.status}`);
  }

  const result = await response.json();
  return result.explanation;
}

export async function recordAnswer(uid, question, selectedAnswer) {
  if (!isFirebaseConfigured) {
    const isCorrect = selectedAnswer === question.correctAnswer;
    const now = new Date().toISOString();
    updateLocalUser(uid, (userData) => ({
      ...userData,
      answers: [
        {
          id: makeId("answer"),
          questionId: question.id,
          lessonId: question.lessonId,
          subjectId: question.subjectId,
          prompt: question.prompt,
          selectedAnswer,
          correctAnswer: question.correctAnswer,
          isCorrect,
          answeredAt: now,
          updatedAt: now,
        },
        ...userData.answers,
      ],
      xp: userData.xp + (isCorrect ? 10 : 0),
      totalScore: (userData.totalScore || 0) + (isCorrect ? 10 : 0),
    }));
    emitScoreChanged({ uid, reason: "answer", xpEarned: isCorrect ? 10 : 0 });
    return { isCorrect, xpEarned: isCorrect ? 10 : 0 };
  }

  const isCorrect = selectedAnswer === question.correctAnswer;
  const xpEarned = isCorrect ? 10 : 0;
  const now = serverTimestamp();

  await addDoc(collection(db, "users", uid, "answers"), {
    questionId: question.id,
    lessonId: question.lessonId,
    subjectId: question.subjectId,
    prompt: question.prompt,
    selectedAnswer,
    correctAnswer: question.correctAnswer,
    isCorrect,
    answeredAt: now,
    updatedAt: now,
  });

  await updateDoc(doc(db, "users", uid), {
    xp: increment(xpEarned),
    totalScore: increment(xpEarned),
    "dailyUsage.answersCount": increment(1),
    updatedAt: now,
  });

  emitScoreChanged({ uid, reason: "answer", xpEarned });
  return { isCorrect, xpEarned };
}

export async function completeLesson(uid, lessonId, xpEarned, perfectLesson = false, options = {}) {
  const bonusXP = perfectLesson ? 5 : 0;
  const totalXP = xpEarned + bonusXP;

  const difficulty = options.difficulty || "medium";
  const grade = options.grade;
  const curriculum = options.curriculum;
  const subjectName = options.subjectName;

  const accuracy = options.accuracy !== undefined ? options.accuracy : 100;

  const energyAward = calculateLessonReward(
    { difficulty, accuracy, perfect: perfectLesson, subjectName },
    { grade, curriculum },
  );

  if (!isFirebaseConfigured) {
    const localState = JSON.parse(localStorage.getItem("lockon-revision-local-state") || "{}");
    const localUser = localState.users?.[uid];
    const localLesson = (localUser?.lessons || []).find((l) => l.id === lessonId);
    if (localLesson?.completed) {
      return { success: false, totalXP: 0, energyAward: 0, reason: "already-completed" };
    }
    const today = new Date().toISOString().split("T")[0];
    updateLocalUser(uid, (userData) => {
      const now = new Date().toISOString();
      const existing = userData.activity?.[today] || 0;
      return {
        ...userData,
        lessons: (userData.lessons || []).map((l) =>
          l.id === lessonId
            ? { ...l, completed: true, completedAt: now, xpEarned: totalXP, perfect: perfectLesson }
            : l,
        ),
        xp: (userData.xp || 0) + totalXP,
        energy: (userData.energy || 0) + energyAward,
        totalScore: (userData.totalScore || 0) + totalXP + energyAward * 100,
        streak: (userData.streak || 0) + 1,
        totalStudyHours: (userData.totalStudyHours || 0) + 0.25,
        completedLessons: ((userData.completedLessons || 0)) + 1,
        activity: { ...(userData.activity || {}), [today]: existing + 0.25 },
      };
    });
    emitLessonCompleted({ lessonId, uid, xpEarned: totalXP, energyAward, perfect: perfectLesson });
    return { success: true, totalXP, energyAward };
  }

  const lessonRef = doc(db, "users", uid, "lessons", lessonId);
  const lessonSnap = await getDoc(lessonRef);
  const alreadyCompleted = lessonSnap.exists() && lessonSnap.data()?.completed === true;

  if (alreadyCompleted) {
    return { success: false, totalXP: 0, energyAward: 0, reason: "already-completed" };
  }

  const now = serverTimestamp();
  const today = new Date().toISOString().split("T")[0];

  const batch = writeBatch(db);

  batch.set(lessonRef, {
    completed: true,
    completedAt: now,
    xpEarned: totalXP,
    perfect: perfectLesson,
    updatedAt: now,
  }, { merge: true });

  batch.update(doc(db, "users", uid), {
    xp: increment(totalXP),
    energy: increment(energyAward),
    totalScore: increment(totalXP + energyAward * 100),
    streak: increment(1),
    totalStudyHours: increment(0.25),
    completedLessons: increment(1),
    [`activity.${today}`]: increment(0.25),
    updatedAt: now,
  });

  await batch.commit();

  emitLessonCompleted({ lessonId, uid, xpEarned: totalXP, energyAward, perfect: perfectLesson });

  return { success: true, totalXP, energyAward };
}

export async function submitExerciseAnswer(uid, lessonId, exerciseId, answer) {
  let exercise;
  if (!isFirebaseConfigured) {
    const state = JSON.parse(localStorage.getItem("lockon-revision-local-state") || "{}");
    const userData = state.users?.[uid];
    const lesson = userData?.lessons?.find(l => l.id === lessonId);
    exercise = lesson?.exercises?.find(e => e.id === exerciseId);
    
    if (!exercise) {
      throw new Error("Exercise not found");
    }

    const isCorrect = answer === exercise.correctAnswer;
    const now = new Date().toISOString();
    
    updateLocalUser(uid, (userData) => ({
      ...userData,
      exerciseAnswers: [
        {
          id: makeId("exercise-answer"),
          lessonId,
          exerciseId,
          answer,
          correctAnswer: exercise.correctAnswer,
          isCorrect,
          answeredAt: now,
        },
        ...(userData.exerciseAnswers || []),
      ],
    }));

    return { isCorrect, explanation: exercise.explanation };
  }

  const lessonSnap = await getDoc(doc(db, "users", uid, "lessons", lessonId));
  if (!lessonSnap.exists()) throw new Error("Lesson not found");
  const lessonData = lessonSnap.data();
  exercise = (lessonData.exercises || []).find(e => e.id === exerciseId);
  if (!exercise) throw new Error("Exercise not found in lesson");

  const isCorrect = answer === exercise.correctAnswer;
  const now = serverTimestamp();
  
  await addDoc(collection(db, "users", uid, "exerciseAnswers"), {
    lessonId,
    exerciseId,
    answer,
    correctAnswer: exercise.correctAnswer,
    isCorrect,
    answeredAt: now,
  });

  return { isCorrect, explanation: exercise.explanation };
}

export function findNextLesson(lessons = [], questions = []) {
  const weakByLesson = questions.reduce((acc, question) => {
    acc[question.lessonId] = Math.min(acc[question.lessonId] ?? 100, question.mastery ?? 50);
    return acc;
  }, {});

  return [...lessons].sort((a, b) => {
    const aScore = weakByLesson[a.id] ?? a.mastery ?? 100;
    const bScore = weakByLesson[b.id] ?? b.mastery ?? 100;
    return aScore - bScore;
  })[0];
}
