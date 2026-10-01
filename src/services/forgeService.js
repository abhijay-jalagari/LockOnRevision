import {
  addDoc,
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import { db, isFirebaseConfigured } from "../config/firebase.js";
import { getLocalUser, makeId, subscribeLocalState, updateLocalUser } from "./localStore.js";
import { uploadTempFile, deleteStorageFile, uploadAndGetContent } from "../utils/storage.js";
import { apiFetch } from "../utils/apiFetch.js";
import i18n from "../i18n/index.js";

function sortByOrder(items) {
  return [...items].sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
}

function normalizeGeneratedStructure(generated) {
  const subject = generated?.subject;
  if (!subject) {
    throw new Error("Generated response is missing subject field");
  }

  const units = (subject.units || []).slice(0, 10).map((unit, unitIndex) => ({
    title: unit.title || `Unit ${unitIndex + 1}`,
    summary: unit.summary || "",
    subUnits: (unit.subUnits || []).slice(0, 10).map((subUnit, subIndex) => ({
      title: subUnit.title || `Sub Unit ${subIndex + 1}`,
      summary: subUnit.summary || "",
      lessons: (subUnit.lessons || []).slice(0, 10).map((lesson, lessonIndex) => ({
        title: lesson.title || `Lesson ${lessonIndex + 1}`,
        summary: lesson.summary || "",
        concept: lesson.concept || lesson.summary || lesson.title || `Lesson ${lessonIndex + 1}`,
        durationMinutes: Number(lesson.durationMinutes || 3),
        xpReward: Number(lesson.xpReward || 15),
        difficulty: lesson.difficulty || "medium",
        interactionTypes: Array.isArray(lesson.interactionTypes) ? lesson.interactionTypes : ["multipleChoice"],
        exercises: Array.isArray(lesson.exercises) ? lesson.exercises.map(ex => ({
            id: makeId("exercise"),
            ...ex
        })) : [],
        keyPoints: Array.isArray(lesson.keyPoints) ? lesson.keyPoints : [],
      })),
    })),
  }));

  return {
    subject: {
      title: subject.title || "Generated Subject",
      description: subject.description || "AI-generated learning path.",
      units,
    },
  };
}


function normalizeExercise(exercise, lesson) {
  return {
    id: exercise?.id || makeId("exercise"),
    type: exercise?.type || "multipleChoice",
    question: exercise?.question || `Question about ${lesson.title}`,
    options: Array.isArray(exercise?.options) ? exercise.options : [],
    correctAnswer: exercise?.correctAnswer || "",
    explanation: exercise?.explanation || "Review the lesson material.",
  };
}


function buildLessonExercises(lesson) {
  const provided = Array.isArray(lesson.exercises) ? lesson.exercises : [];
  return provided.map((exercise) => normalizeExercise(exercise, lesson));
}


function flattenStructure(subjectInput, sourceFileIds = [], sourceText = "") {
  const now = new Date().toISOString();
  const subject = {
    id: makeId("subject"),
    title: subjectInput.title,
    description: subjectInput.description,
    unitCount: subjectInput.units.length,
    sourceFileIds,
    forge: true,
    order: 0,
    createdAt: now,
    updatedAt: now,
  };

  const units = [];
  const subUnits = [];
  const lessons = [];

  subjectInput.units.forEach((unitInput, unitOrder) => {
    const unit = {
      id: makeId("unit"),
      subjectId: subject.id,
      subjectName: subject.title,
      title: unitInput.title,
      summary: unitInput.summary || "",
      order: unitOrder,
      sourceFileIds,
      createdAt: now,
      updatedAt: now,
    };
    units.push(unit);

    (unitInput.subUnits || []).forEach((subUnitInput, subOrder) => {
      const subUnit = {
        id: makeId("subunit"),
        subjectId: subject.id,
        unitId: unit.id,
        unitName: unit.title,
        title: subUnitInput.title,
        summary: subUnitInput.summary || "",
        order: subOrder,
        createdAt: now,
        updatedAt: now,
      };
      subUnits.push(subUnit);

      (subUnitInput.lessons || []).forEach((lessonInput, lessonOrder) => {
        const lesson = {
          ...lessonInput,
          title: lessonInput.title || `Lesson ${lessonOrder + 1}`,
          summary: lessonInput.summary || "",
          keyPoints: Array.isArray(lessonInput.keyPoints) ? lessonInput.keyPoints : [],
          xpReward: Number(lessonInput.xpReward || 15),
        };
        lessons.push({
          id: makeId("lesson"),
          subjectId: subject.id,
          unitId: unit.id,
          subUnitId: subUnit.id,
          subjectName: subject.title,
          unitName: unit.title,
          subUnitName: subUnit.title,
          title: lesson.title,
          summary: lesson.summary,
          concept: lessonInput.concept || lesson.summary || lesson.title,
          durationMinutes: Number(lessonInput.durationMinutes || 3),
          xpReward: lesson.xpReward,
          interactionTypes: lessonInput.interactionTypes || ["multipleChoice"],
          exercises: buildLessonExercises(lesson),
          keyPoints: lesson.keyPoints,
          order: lessonOrder,
          mastery: 0,
          difficulty: lessonInput.difficulty || "medium",
          completed: false,
          xpEarned: 0,
          sourceFileIds,
          createdAt: now,
          updatedAt: now,
        });
      });
    });
  });

  return { subject, units, subUnits, lessons, sourceText };
}

async function generateStructureFromText(sourceText) {
  if (!isFirebaseConfigured) {
    throw new Error("Gemini API is not available in local mode. Configure Firebase to use AI generation.");
  }

  const response = await apiFetch('/api/generate-forge-structure', {
    method: 'POST',
    body: JSON.stringify({ sourceText, preferredLanguage: i18n.language }),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `API request failed: ${response.status}`);
  }

  const result = await response.json();
  return normalizeGeneratedStructure(result);
}

function assembleForgeTree(subject, units, subUnits, lessons) {
  const sortedUnits = sortByOrder(units.filter((unit) => unit.subjectId === subject.id));
  return {
    ...subject,
    units: sortedUnits.map((unit) => ({
      ...unit,
      subUnits: sortByOrder(subUnits.filter((subUnit) => subUnit.unitId === unit.id)).map((subUnit) => ({
        ...subUnit,
        lessons: sortByOrder(lessons.filter((lesson) => lesson.subUnitId === subUnit.id)),
      })),
    })),
  };
}

function localForgeSubjects(uid) {
  const userData = getLocalUser(uid);
  if (!userData) return [];
  const forgeSubjects = userData.subjects.filter((subject) => subject.forge);
  return forgeSubjects.map((subject) =>
    assembleForgeTree(subject, userData.units, userData.subUnits || [], userData.lessons),
  );
}

export function subscribeForgeSubjects(uid, callback) {
  if (!isFirebaseConfigured) {
    return subscribeLocalState(() => callback(localForgeSubjects(uid)));
  }

  let cancelled = false;
  const unsub = onSnapshot(
    query(collection(db, "users", uid, "subjects"), orderBy("updatedAt", "desc")),
    () => {
      if (!cancelled) fetchForgeSubjects(uid).then(callback).catch(() => {});
    },
    (error) => {
      console.error("[forgeService] Failed to subscribe to Forge subjects:", error);
    },
  );
  return () => { cancelled = true; unsub(); };
}

export function subscribeForgeUnits(uid, callback) {
  if (!isFirebaseConfigured) {
    return subscribeLocalState(() => callback(getLocalUser(uid)?.units || []));
  }

  return onSnapshot(query(collection(db, "users", uid, "units"), orderBy("updatedAt", "desc")), (snapshot) => {
    callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
  }, (error) => {
    console.error("[forgeService] Failed to subscribe to Forge units:", error);
  });
}

export function subscribeForgeSubUnits(uid, callback) {
  if (!isFirebaseConfigured) {
    return subscribeLocalState(() => callback(getLocalUser(uid)?.subUnits || []));
  }

  return onSnapshot(query(collection(db, "users", uid, "subUnits"), orderBy("updatedAt", "desc")), (snapshot) => {
    callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
  }, (error) => {
    console.error("[forgeService] Failed to subscribe to Forge sub-units:", error);
  });
}

export function subscribeForgeLessons(uid, callback) {
  if (!isFirebaseConfigured) {
    return subscribeLocalState(() => callback(getLocalUser(uid)?.lessons || []));
  }

  return onSnapshot(query(collection(db, "users", uid, "lessons"), orderBy("updatedAt", "desc")), (snapshot) => {
    callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
  }, (error) => {
    console.error("[forgeService] Failed to subscribe to Forge lessons:", error);
  });
}

export async function fetchForgeSubjects(uid) {
  if (!isFirebaseConfigured) {
    return localForgeSubjects(uid);
  }

  const [subjectsSnap, unitsSnap, subUnitsSnap, lessonsSnap] = await Promise.all([
    getDocs(query(collection(db, "users", uid, "subjects"), orderBy("updatedAt", "desc"))),
    getDocs(collection(db, "users", uid, "units")),
    getDocs(collection(db, "users", uid, "subUnits")),
    getDocs(collection(db, "users", uid, "lessons")),
  ]);

  const subjects = subjectsSnap.docs.map((item) => ({ id: item.id, ...item.data() })).filter((item) => item.forge);
  const units = unitsSnap.docs.map((item) => ({ id: item.id, ...item.data() }));
  const subUnits = subUnitsSnap.docs.map((item) => ({ id: item.id, ...item.data() }));
  const lessons = lessonsSnap.docs.map((item) => ({ id: item.id, ...item.data() }));

  return subjects.map((subject) => assembleForgeTree(subject, units, subUnits, lessons));
}

export async function readFileContent(file) {
  if (/\.(txt|md|csv|json)$/i.test(file.name)) {
    return file.text();
  }
  return `[File: ${file.name}]\nType: ${file.type || "unknown"}\nSize: ${file.size} bytes\nExtract readable concepts from this uploaded document when generating the learning path.`;
}

export async function uploadForgeFiles(uid, files, onProgress) {
  const uploaded = [];
  const contents = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];

    try {
      const result = await uploadAndGetContent(uid, file);
      contents.push(result.content);

      if (!isFirebaseConfigured) {
        const localFile = {
          id: makeId("file"),
          name: file.name,
          size: file.size,
          type: file.type,
          content: result.content,
          status: "uploaded",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        updateLocalUser(uid, (userData) => ({ ...userData, files: [localFile, ...userData.files] }));
        uploaded.push(localFile);
        onProgress?.(Math.round(((index + 1) / files.length) * 100));
        continue;
      }

      if (result.type === "text" || result.type === "placeholder") {
        const fileDoc = await addDoc(collection(db, "users", uid, "files"), {
          name: file.name,
          size: file.size,
          type: file.type,
          content: result.content?.slice(0, 50000) || "",
          status: "uploaded",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        uploaded.push({ id: fileDoc.id, name: file.name, content: result.content, type: file.type });
      } else {
        const uploadResult = await uploadTempFile(uid, file);
        const fileDoc = await addDoc(collection(db, "users", uid, "files"), {
          name: file.name,
          size: file.size,
          type: file.type,
          content: result.content?.slice(0, 50000) || "",
          url: uploadResult.url,
          publicId: uploadResult.publicId,
          resourceType: uploadResult.resourceType,
          status: "uploaded",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        uploaded.push({
          id: fileDoc.id,
          name: file.name,
          content: result.content,
          url: uploadResult.url,
          type: file.type,
          publicId: uploadResult.publicId,
          resourceType: uploadResult.resourceType,
        });
      }
      onProgress?.(Math.round(((index + 1) / files.length) * 100));
    } catch (error) {
      console.warn(`Failed to process file ${file.name}:`, error.message);
      // Add a placeholder entry for failed files
      const placeholderFile = {
        id: makeId("file"),
        name: file.name,
        size: file.size,
        type: file.type,
        content: "",
        status: "uploaded",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      uploaded.push(placeholderFile);
      onProgress?.(Math.round(((index + 1) / files.length) * 100));
    }
  }

  const combinedText = contents.join("\n\n---\n\n");
  return { uploaded, combinedText };
}

export async function cleanupUploadedFiles(uploaded) {
  for (const file of uploaded) {
    if (file.publicId) {
      await deleteStorageFile(file.publicId, file.resourceType);
    }
  }
}

export async function generateForgeStructure(uid, sourceText, sourceFileIds = [], files = []) {
  if (!isFirebaseConfigured) {
    throw new Error("Gemini API is not available in local mode. Configure Firebase to use AI generation.");
  }

  let normalized;
  if (files.length > 0) {
    const hasBinaryFiles = files.some(f => f.url);
    if (hasBinaryFiles) {
      const response = await apiFetch('/api/process-uploaded-notes', {
        method: 'POST',
        body: JSON.stringify({
          uid,
          files: files.map(f => ({
            url: f.url,
            mimeType: f.type || "application/octet-stream",
            publicId: f.publicId,
            resourceType: f.resourceType || "raw",
          })),
          preferredLanguage: i18n.language
        }),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.error || `API request failed: ${response.status}`);
      }
      const result = await response.json();
      normalized = normalizeGeneratedStructure(result.data);
    } else {
      normalized = await generateStructureFromText(sourceText);
    }
  } else {
    normalized = await generateStructureFromText(sourceText);
  }

  const flat = flattenStructure(normalized.subject, sourceFileIds, sourceText);

  if (!isFirebaseConfigured) {
    updateLocalUser(uid, (userData) => ({
      ...userData,
      subjects: [flat.subject, ...userData.subjects],
      units: [...flat.units, ...userData.units],
      subUnits: [...flat.subUnits, ...(userData.subUnits || [])],
      lessons: [...flat.lessons, ...userData.lessons],
      forgeSourceText: {
        ...userData.forgeSourceText,
        [flat.subject.id]: sourceText.slice(0, 100000),
      },
    }));
    return assembleForgeTree(flat.subject, flat.units, flat.subUnits, flat.lessons);
  }

  const batch = writeBatch(db);
  const subjectRef = doc(collection(db, "users", uid, "subjects"));
  batch.set(subjectRef, {
    title: flat.subject.title,
    description: flat.subject.description,
    unitCount: flat.units.length,
    sourceFileIds,
    forge: true,
    order: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  const unitIdMap = new Map();
  flat.units.forEach((unit) => {
    const unitRef = doc(collection(db, "users", uid, "units"));
    unitIdMap.set(unit.id, unitRef.id);
    batch.set(unitRef, {
      subjectId: subjectRef.id,
      subjectName: flat.subject.title,
      title: unit.title,
      summary: unit.summary,
      order: unit.order,
      sourceFileIds,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

const subUnitIdMap = new Map();
    flat.subUnits.forEach((subUnit) => {
      const subUnitRef = doc(collection(db, "users", uid, "subUnits"));
      subUnitIdMap.set(subUnit.id, subUnitRef.id);
      batch.set(subUnitRef, {
        subjectId: subjectRef.id,
        unitId: unitIdMap.get(subUnit.unitId),
        unitName: subUnit.unitName,
        title: subUnit.title,
        summary: subUnit.summary,
        order: subUnit.order,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });

  flat.lessons.forEach((lesson) => {
    const { id: _lessonId, ...lessonData } = lesson;
    const lessonRef = doc(collection(db, "users", uid, "lessons"));
    batch.set(lessonRef, {
      ...lessonData,
      subjectId: subjectRef.id,
      unitId: unitIdMap.get(lesson.unitId),
      subUnitId: subUnitIdMap.get(lesson.subUnitId),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  batch.set(doc(db, "users", uid, "forgeSources", subjectRef.id), {
    sourceText: sourceText.slice(0, 100000),
    updatedAt: serverTimestamp(),
  });

  await batch.commit();
  return fetchForgeSubjects(uid).then((items) => items.find((item) => item.id === subjectRef.id));
}

export async function regenerateForgeStructure(uid, subjectId, sourceText) {
  const existing = (await fetchForgeSubjects(uid)).find((item) => item.id === subjectId);
  if (!existing) throw new Error("Forge subject not found.");

  await deleteForgeSubject(uid, subjectId, { skipFetch: true });
  return generateForgeStructure(uid, sourceText, existing.sourceFileIds || []);
}

function treeToFlat(tree) {
  const units = [];
  const subUnits = [];
  const lessons = [];

  tree.units.forEach((unit, unitOrder) => {
    units.push({
      id: unit.id,
      subjectId: tree.id,
      subjectName: tree.title,
      title: unit.title,
      summary: unit.summary || "",
      order: unitOrder,
      sourceFileIds: tree.sourceFileIds || [],
    });

    unit.subUnits.forEach((subUnit, subOrder) => {
      subUnits.push({
        id: subUnit.id,
        subjectId: tree.id,
        unitId: unit.id,
        unitName: unit.title,
        title: subUnit.title,
        summary: subUnit.summary || "",
        order: subOrder,
      });

      subUnit.lessons.forEach((lesson, lessonOrder) => {
        lessons.push({
          id: lesson.id,
          subjectId: tree.id,
          unitId: unit.id,
          subUnitId: subUnit.id,
          subjectName: tree.title,
          unitName: unit.title,
          subUnitName: subUnit.title,
          title: lesson.title,
          summary: lesson.summary || "",
          keyPoints: lesson.keyPoints || [],
          concept: lesson.concept || lesson.summary || lesson.title,
          durationMinutes: Number(lesson.durationMinutes || 3),
          xpReward: Number(lesson.xpReward || 15),
          interactionTypes: lesson.interactionTypes || ["multipleChoice"],
          exercises: buildLessonExercises(lesson),
          order: lessonOrder,
          mastery: lesson.mastery || 0,
          difficulty: lesson.difficulty || "medium",
          sourceFileIds: tree.sourceFileIds || [],
        });
      });
    });
  });

  return {
    subject: {
      id: tree.id,
      title: tree.title,
      description: tree.description || "",
      unitCount: units.length,
      sourceFileIds: tree.sourceFileIds || [],
      forge: true,
    },
    units,
    subUnits,
    lessons,
  };
}

export async function saveForgeStructure(uid, tree) {
  const flat = treeToFlat(tree);
  const now = new Date().toISOString();

  if (!isFirebaseConfigured) {
    updateLocalUser(uid, (userData) => {
      return {
        ...userData,
        subjects: userData.subjects.map((item) =>
          item.id === tree.id ? { ...item, ...flat.subject, updatedAt: now } : item,
        ),
        units: [...userData.units.filter((item) => item.subjectId !== tree.id), ...flat.units],
        subUnits: [...(userData.subUnits || []).filter((item) => item.subjectId !== tree.id), ...flat.subUnits],
        lessons: [...userData.lessons.filter((item) => item.subjectId !== tree.id), ...flat.lessons],
      };
    });
    return assembleForgeTree({ ...flat.subject, updatedAt: now }, flat.units, flat.subUnits, flat.lessons);
  }

  await deleteForgeSubject(uid, tree.id, { skipFetch: true, keepSource: true });

  const batch = writeBatch(db);
  const subjectRef = doc(db, "users", uid, "subjects", tree.id);
  batch.set(subjectRef, {
    title: flat.subject.title,
    description: flat.subject.description,
    unitCount: flat.units.length,
    sourceFileIds: flat.subject.sourceFileIds,
    forge: true,
    order: 0,
    updatedAt: serverTimestamp(),
  }, { merge: true });

  flat.units.forEach((unit) => {
    batch.set(doc(db, "users", uid, "units", unit.id), {
      ...unit,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  });

  flat.subUnits.forEach((subUnit) => {
    batch.set(doc(db, "users", uid, "subUnits", subUnit.id), {
      ...subUnit,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  });

  flat.lessons.forEach((lesson) => {
    batch.set(doc(db, "users", uid, "lessons", lesson.id), {
      ...lesson,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  });

  await batch.commit();
  return fetchForgeSubjects(uid).then((items) => items.find((item) => item.id === tree.id));
}

export async function deleteForgeSubject(uid, subjectId, options = {}) {
  if (!isFirebaseConfigured) {
    updateLocalUser(uid, (userData) => ({
      ...userData,
      subjects: userData.subjects.filter((item) => item.id !== subjectId),
      units: userData.units.filter((item) => item.subjectId !== subjectId),
      subUnits: (userData.subUnits || []).filter((item) => item.subjectId !== subjectId),
      lessons: userData.lessons.filter((item) => item.subjectId !== subjectId),
      forgeSourceText: Object.fromEntries(
        Object.entries(userData.forgeSourceText || {}).filter(([key]) => key !== subjectId),
      ),
    }));
    if (!options.skipFetch) return fetchForgeSubjects(uid);
    return [];
  }

  const [unitsSnap, subUnitsSnap, lessonsSnap] = await Promise.all([
    getDocs(query(collection(db, "users", uid, "units"), orderBy("updatedAt", "desc"))),
    getDocs(collection(db, "users", uid, "subUnits")),
    getDocs(collection(db, "users", uid, "lessons")),
  ]);

  const batch = writeBatch(db);
  batch.delete(doc(db, "users", uid, "subjects", subjectId));

  unitsSnap.docs
    .filter((item) => item.data().subjectId === subjectId)
    .forEach((item) => batch.delete(item.ref));

  subUnitsSnap.docs
    .filter((item) => item.data().subjectId === subjectId)
    .forEach((item) => batch.delete(item.ref));

  lessonsSnap.docs
    .filter((item) => item.data().subjectId === subjectId)
    .forEach((item) => batch.delete(item.ref));

  if (!options.keepSource) {
    batch.delete(doc(db, "users", uid, "forgeSources", subjectId));
  }

  await batch.commit();
  if (!options.skipFetch) return fetchForgeSubjects(uid);
  return [];
}

export async function getForgeContext(uid) {
  const subjects = await fetchForgeSubjects(uid);

  if (!isFirebaseConfigured) {
    const userData = getLocalUser(uid);
    const sourceMap = userData?.forgeSourceText || {};
    return {
      subjects,
      sourceText: Object.values(sourceMap).join("\n\n---\n\n").slice(0, 120000),
    };
  }

  const sourceSnap = await getDocs(collection(db, "users", uid, "forgeSources"));
  const sourceText = sourceSnap.docs.map((item) => item.data().sourceText || "").join("\n\n---\n\n").slice(0, 120000);

  return { subjects, sourceText };
}

export function createEmptyForgeNode(type, parentIds = {}) {
  const id = makeId(type === "unit" ? "unit" : type === "subunit" ? "subunit" : "lesson");
  if (type === "unit") {
    return {
      id,
      title: "New Unit",
      summary: "",
      subUnits: [
        createEmptyForgeNode("subunit", { unitId: id }),
        createEmptyForgeNode("subunit", { unitId: id }),
      ],
    };
  }
  if (type === "subunit") {
    return {
      id,
      title: "New Sub Unit",
      summary: "",
      lessons: [
        createEmptyForgeNode("lesson", { subUnitId: id }),
        createEmptyForgeNode("lesson", { subUnitId: id }),
      ],
    };
  }
  return {
    id,
    title: "New Lesson",
    summary: "",
    keyPoints: [],
    ...parentIds,
  };
}
