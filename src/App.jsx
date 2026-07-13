/**
 * Kettlebell Journal — a training tracker for kettlebell sport.
 *
 * ARCHITECTURE
 * Single file, four tabs (bottom navigation):
 *   Today    — guided workout: day plan → pre-workout survey → start → set chain → summary to journal;
 *   PlanView — plan overview by week + plan import/export/editing (raw JSON or via LLM);
 *   Timer    — free-form interval timer for work outside the program;
 *   Journal  — retrospective: manual entries, history, CSV/JSON export.
 *
 * PLAN DATA (single source of truth; mutated in place when a custom plan is imported):
 *   WEEKS  — week metadata: label, mon{method,kg,note}, fri{kg,note}, ladder[warm-up weights];
 *   EX     — exercises per day of week; GYM_EX — Saturday gym (shared across all weeks).
 *   Exercise spec: { n, kg|null, uni, planned, pr } + exactly one of:
 *     t:{m:"m1|m2|m3|m4|fri",work,rest,sets} — timed (sets are unrolled by genSets per method);
 *     s:{sets,rest}                          — rep-based sets without a timer;
 *     c:true                                 — cardio (distance + time).
 *
 * SET STATE MACHINE (active workout):
 *   locked → ready → run(work) → done → [auto rest] → auto-start of the next set.
 *   Statuses live in acts["exIdx-setIdx"].st; actual reps stay editable after done.
 *
 * RUNTIME ENVIRONMENTS
 *   Claude artifact: persistence via window.storage (see artifact docs);
 *   Browser (Vite build): a window.storage shim over localStorage is added in src/App.jsx.
 *
 * NOTE ON LANGUAGE: UI strings and the LLM prompt are intentionally in Russian —
 * that is the product language. Code comments and docs are in English.
 *
 * LINKS
 *   React (hooks, functional updates):      https://react.dev/reference/react
 *   Web Audio (timer beeps):                https://developer.mozilla.org/docs/Web/API/AudioContext
 *   Vibration API:                          https://developer.mozilla.org/docs/Web/API/Navigator/vibrate
 *   Blob + createObjectURL (file export):   https://developer.mozilla.org/docs/Web/API/URL/createObjectURL_static
 *   Anthropic Messages API (plan import):   https://docs.claude.com/en/api/messages
 *   Browser CORS access to the API:         https://docs.claude.com/en/api/client-sdks#browser-usage
 */
import { useState, useEffect, useRef, useCallback } from "react";

// ── Storage: Claude artifacts provide window.storage; in a plain browser we shim it over localStorage ──
// A single async get/set/delete interface lets the code run unchanged in both environments.
// localStorage: https://developer.mozilla.org/docs/Web/API/Window/localStorage
// ~5 MB per-origin limit; if the journal outgrows it, see IndexedDB (DEVELOPMENT.md, §8).
if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    async get(key) {
      const v = localStorage.getItem("kbapp:" + key);
      if (v == null) throw new Error("not found");
      return { key, value: v };
    },
    async set(key, value) {
      localStorage.setItem("kbapp:" + key, value);
      return { key, value };
    },
    async delete(key) {
      localStorage.removeItem("kbapp:" + key);
      return { key, deleted: true };
    },
  };
}


// ── Palette: cast iron & chalk; weights follow competition kettlebell colors ──
const C = {
  bg: "#14161A",
  surface: "#1E2228",
  surface2: "#262B33",
  line: "#333A44",
  text: "#F2EFE8",
  muted: "#8B919C",
  kg10: "#7A8794",
  kg16: "#E8B33C",
  kg20: "#8E6BC0",
  kg24: "#3F9B63",
  stop: "#C4534A",
  ok: "#3F9B63",
};

const KG_COLOR = { 10: C.kg10, 16: C.kg16, 20: C.kg20, 24: C.kg24 };

// ── Plan: transition month (16→20 kg) and the maintenance cycle ──
const WEEKS = {
  "1": {
    label: "Неделя 1 · всё на 16 кг",
    mon: { method: "m3", kg: 16, note: "Рывок, метод 3: 5×1 мин на руку, отдых 30 сек. Затем полурывок 16 кг 2 подхода на слабую сторону, приседания с гирей на груди 3×8." },
    fri: { kg: 16, note: "Толчок одной 16 кг 4×1,5 мин на руку + постоянный блок: bottoms-up 16 кг 2×3, турецкий подъём 2 на сторону, фермерская прогулка 2×40–60 сек." },
    ladder: [10, 16],
  },
  "2": {
    label: "Неделя 2 · 20 кг входит (~треть объёма)",
    mon: { method: "m2", kg: 16, note: "Рывок 16 кг, метод 2: 3×(1+1 мин) без отдыха внутри, отдых 2 мин. Затем метод 3 на 20 кг: 2–3×1 мин на руку в спокойном темпе." },
    fri: { kg: 16, note: "Длинный цикл одной 16 кг 3×2 мин на руку; жим 20 кг 2×3–4 на сторону + постоянный блок." },
    ladder: [10, 16, 20],
  },
  "3": {
    label: "Неделя 3 · соотношение переворачивается",
    mon: { method: "m4", kg: 16, note: "Рывок 16 кг, метод 4: 3 мин правой — полный отдых — 3 мин левой; второй круг по 2 мин. Затем 20 кг: 3×1 мин на руку." },
    fri: { kg: 20, note: "Толчок одной 20 кг 3×1,5 мин; жим 20 кг 2×4. Bottoms-up остаётся на 16 кг + постоянный блок." },
    ladder: [10, 16, 20],
  },
  "4": {
    label: "Неделя 4 · контрольная точка",
    mon: { method: "m1", kg: 16, note: "Проходка 16 кг: 8 минут, одна смена рук. Записать повторения на каждую руку и минуту, где правая начинает проседать. Больше ничего тяжёлого." },
    fri: { kg: 16, note: "Лёгкая сессия: швунги 16 кг, турецкий подъём, растяжка." },
    ladder: [10, 16],
  },
  A: {
    label: "Неделя A · метод 3 (интервалы)",
    mon: { method: "m3", kg: 20, note: "Рывок 20 кг: 4–5×1–1,5 мин на руку с коротким отдыхом." },
    fri: { kg: 20, note: "Толчок одной 20 кг 4–6 мин работы на руку + постоянный блок (bottoms-up 16, турецкий подъём, фермерская)." },
    ladder: [10, 16, 20],
  },
  B: {
    label: "Неделя B · метод 2 (смена рук)",
    mon: { method: "m2", kg: 20, note: "Рывок 20 кг: 3–4 подхода со сменой рук (1+1 мин или 1,5+1,5 мин)." },
    fri: { kg: 20, note: "Длинный цикл одной 20 кг + постоянный блок." },
    ladder: [10, 16, 20],
  },
  C: {
    label: "Неделя C · метод 4 (длинные подходы)",
    mon: { method: "m4", kg: 20, note: "Рывок 20 кг: 2 круга (3 мин правой — полный отдых — 3 мин левой). Со временем один подход растёт к 4 минутам." },
    fri: { kg: 20, note: "Швунги с фиксацией 20 кг + постоянный блок. Сессию сделать легче обычного, если в понедельник проходка." },
    ladder: [10, 16, 20],
  },
  D: {
    label: "Неделя D · метод 1 (проходка)",
    mon: { method: "m1", kg: 16, note: "Проходка 8 минут с одной сменой — сначала 16 кг, через пару циклов 20 кг. Контрольный замер асимметрии." },
    fri: { kg: 16, note: "Лёгкая пятница перед проходкой следующего понедельника: швунги 16 кг, турецкий подъём, растяжка." },
    ladder: [10, 16],
  },
};

const GYM = [
  "Приседания со штангой 4×6",
  "Жим лёжа 4×6 (или гантели 3×8 + брусья 3×6–8 — через неделю)",
  "Румынская тяга 3×8 — спину слушать",
  "Тяга с опорой на грудь 3×10 + однорукая тяга гантели 3×10",
  "Подтягивания нейтральным хватом, 3 подхода с запасом 2–3",
];

// ── Exercises per day: uni — one-armed; t — timed sets; s — untimed rep sets ──
const FRI_BLOCK = (kg) => [
  { n: "Bottoms-up жим", kg: 16, uni: true, s: { sets: 2, rest: 60 }, planned: "2×3 на сторону", pr: "3" },
  { n: "Турецкий подъём", kg: 16, uni: true, s: { sets: 2, rest: 60 }, planned: "2×1 на сторону", pr: "1" },
  { n: "Фермерская прогулка / удержание", kg, uni: true, t: { m: "fri", work: 45, rest: 60, sets: 2 }, planned: "2×40–60 сек", pr: "40–60 с" },
];
const EX = {
  "1": {
    mon: [
      { n: "Рывок · метод 3 (интервалы)", kg: 16, uni: true, t: { m: "m3", work: 60, rest: 30, sets: 5 }, planned: "5×1 мин, 12–14/мин", pr: "12–14" },
      { n: "Полурывок", kg: 16, uni: true, s: { sets: 2, rest: 90 }, planned: "2 подхода, слабая сторона", pr: "10–12" },
      { n: "Приседания с гирей на груди", kg: 16, uni: false, s: { sets: 3, rest: 90 }, planned: "3×8", pr: "8" },
    ],
    fri: [
      { n: "Толчок одной", kg: 16, uni: true, t: { m: "fri", work: 90, rest: 90, sets: 4 }, planned: "4×1,5 мин", pr: "12–15" },
      ...FRI_BLOCK(16),
    ],
  },
  "2": {
    mon: [
      { n: "Рывок · метод 2 (смена рук)", kg: 16, uni: true, t: { m: "m2", work: 60, rest: 120, sets: 3 }, planned: "3×(1+1 мин)", pr: "12–14" },
      { n: "Рывок · интервалы", kg: 20, uni: true, t: { m: "m3", work: 60, rest: 60, sets: 3 }, planned: "2–3×1 мин, спокойно", pr: "10–12" },
    ],
    fri: [
      { n: "Длинный цикл одной", kg: 16, uni: true, t: { m: "fri", work: 120, rest: 120, sets: 3 }, planned: "3×2 мин", pr: "18–24" },
      { n: "Жим одной рукой", kg: 20, uni: true, s: { sets: 2, rest: 90 }, planned: "2×3–4", pr: "3–4" },
      ...FRI_BLOCK(16),
    ],
  },
  "3": {
    mon: [
      { n: "Рывок · метод 4 (длинные)", kg: 16, uni: true, t: { m: "m4", work: 180, rest: 180, sets: 2 }, planned: "круг 3 мин + круг 2 мин", pr: "30–40" },
      { n: "Рывок · интервалы", kg: 20, uni: true, t: { m: "m3", work: 60, rest: 60, sets: 3 }, planned: "3×1 мин", pr: "10–12" },
    ],
    fri: [
      { n: "Толчок одной", kg: 20, uni: true, t: { m: "fri", work: 90, rest: 90, sets: 3 }, planned: "3×1,5 мин", pr: "12–15" },
      { n: "Жим одной рукой", kg: 20, uni: true, s: { sets: 2, rest: 90 }, planned: "2×4", pr: "4" },
      ...FRI_BLOCK(16),
    ],
  },
  "4": {
    mon: [
      { n: "Проходка · одна смена", kg: 16, uni: true, t: { m: "m1", work: 240, rest: 0, sets: 1 }, planned: "8 мин, замер асимметрии", pr: "45–55" },
    ],
    fri: [
      { n: "Швунги", kg: 16, uni: true, s: { sets: 3, rest: 90 }, planned: "легко", pr: "5–8" },
      { n: "Турецкий подъём", kg: 16, uni: true, s: { sets: 2, rest: 60 }, planned: "2×1 на сторону", pr: "1" },
    ],
  },
  A: {
    mon: [
      { n: "Рывок · метод 3 (интервалы)", kg: 20, uni: true, t: { m: "m3", work: 75, rest: 45, sets: 4 }, planned: "4–5×1–1,5 мин", pr: "14–18" },
    ],
    fri: [
      { n: "Толчок одной", kg: 20, uni: true, t: { m: "fri", work: 90, rest: 90, sets: 3 }, planned: "4–6 мин на руку", pr: "10–15" },
      ...FRI_BLOCK(20),
    ],
  },
  B: {
    mon: [
      { n: "Рывок · метод 2 (смена рук)", kg: 20, uni: true, t: { m: "m2", work: 60, rest: 120, sets: 3 }, planned: "3–4×(1+1) или (1,5+1,5)", pr: "12–16" },
    ],
    fri: [
      { n: "Длинный цикл одной", kg: 20, uni: true, t: { m: "fri", work: 90, rest: 90, sets: 3 }, planned: "4–6 мин на руку", pr: "10–15" },
      ...FRI_BLOCK(20),
    ],
  },
  C: {
    mon: [
      { n: "Рывок · метод 4 (длинные)", kg: 20, uni: true, t: { m: "m4", work: 180, rest: 180, sets: 2 }, planned: "2 круга по 3 мин", pr: "30–36" },
    ],
    fri: [
      { n: "Швунги с фиксацией", kg: 20, uni: true, s: { sets: 3, rest: 90 }, planned: "3 подхода, фиксация 3–5 сек", pr: "4–6" },
      ...FRI_BLOCK(20),
    ],
  },
  D: {
    mon: [
      { n: "Проходка · одна смена", kg: 16, uni: true, t: { m: "m1", work: 240, rest: 0, sets: 1 }, planned: "8 мин, замер асимметрии", pr: "45–55" },
    ],
    fri: [
      { n: "Швунги", kg: 16, uni: true, s: { sets: 3, rest: 90 }, planned: "легко", pr: "5–8" },
      { n: "Турецкий подъём", kg: 16, uni: true, s: { sets: 2, rest: 60 }, planned: "2×1 на сторону", pr: "1" },
    ],
  },
};
const GYM_EX = [
  { n: "Приседания со штангой", kg: null, uni: false, s: { sets: 4, rest: 180 }, planned: "4×6", pr: "6" },
  { n: "Жим лёжа / гантели + брусья", kg: null, uni: false, s: { sets: 4, rest: 180 }, planned: "4×6 или 3×8 + брусья", pr: "6–8" },
  { n: "Румынская тяга", kg: null, uni: false, s: { sets: 3, rest: 150 }, planned: "3×8, спину слушать", pr: "8" },
  { n: "Тяга с опорой на грудь", kg: null, uni: false, s: { sets: 3, rest: 120 }, planned: "3×10", pr: "10" },
  { n: "Однорукая тяга гантели", kg: null, uni: true, s: { sets: 3, rest: 90 }, planned: "3×10", pr: "10" },
  { n: "Подтягивания нейтральным хватом", kg: null, uni: false, s: { sets: 3, rest: 120 }, planned: "запас 2–3", pr: "5–8" },
];
function dayExercises(week, d) {
  if (d === 1) return EX[week]?.mon || [];
  if (d === 5) return EX[week]?.fri || [];
  if (d === 6) return GYM_EX;
  if (d === 3) return [{ n: "Плавание (кроль)", kg: null, uni: false, c: true, s: { sets: 1 }, planned: "кроль в приоритете" }];
  return [];
}

// ── Custom plan: partial merge (week / day / gym), snapshot, reset ──
const WEEKS_DEFAULT = JSON.parse(JSON.stringify(WEEKS));
const EX_DEFAULT = JSON.parse(JSON.stringify(EX));
const GYM_DEFAULT = JSON.parse(JSON.stringify(GYM_EX));

// data may be partial: only the weeks, days, or gym being changed.
// Mutating module-level constants instead of React state is a deliberate prototype
// simplification: it avoids threading the plan through the whole tree; re-render is
// forced by planVer in App. For production, replace with context/store (see DEVELOPMENT.md).
// weeks."2".fri replaces only Friday of week 2; ex."2".mon — only Monday; gym — the whole gym list.
function applyPlanData(data) {
  if (data?.weeks) {
    for (const [k, v] of Object.entries(data.weeks)) {
      WEEKS[k] = { ...(WEEKS[k] || {}), ...v };
    }
  }
  if (data?.ex) {
    for (const [k, v] of Object.entries(data.ex)) {
      EX[k] = { ...(EX[k] || {}), ...v };
    }
  }
  if (Array.isArray(data?.gym) && data.gym.length) {
    GYM_EX.length = 0;
    GYM_EX.push(...data.gym);
  }
}
// Full snapshot of the current plan — for persistence and export
function snapshotPlan() {
  return JSON.parse(JSON.stringify({ weeks: WEEKS, ex: EX, gym: GYM_EX }));
}
function resetPlanData() {
  Object.keys(WEEKS).forEach((k) => delete WEEKS[k]);
  Object.assign(WEEKS, JSON.parse(JSON.stringify(WEEKS_DEFAULT)));
  Object.keys(EX).forEach((k) => delete EX[k]);
  Object.assign(EX, JSON.parse(JSON.stringify(EX_DEFAULT)));
  GYM_EX.length = 0;
  GYM_EX.push(...JSON.parse(JSON.stringify(GYM_DEFAULT)));
}

// ── Timer presets: segments are built from settings (work/rest/sets) ──
function buildPreset(id, cfg) {
  const { work, rest, sets, prep = 0 } = cfg;
  const seg = (label, s, arm) => ({ label, s, arm });
  const core = buildCore();
  return prep > 0 ? [seg("Подготовка", prep), ...core] : core;

  function buildCore() {
  const arr = [];
  switch (id) {
    case "m3": {
      for (const arm of ["Правая", "Левая"]) {
        for (let i = 1; i <= sets; i++) {
          arr.push(seg(`${arm} · подход ${i}`, work, arm));
          if (i < sets && rest > 0) arr.push(seg("Отдых", rest));
        }
        if (arm === "Правая") arr.push(seg("Отдых между руками", Math.max(rest, 120)));
      }
      return arr;
    }
    case "m2": {
      for (let i = 1; i <= sets; i++) {
        arr.push(seg(`Подход ${i} · правая`, work, "Правая"));
        arr.push(seg(`Подход ${i} · левая (без отдыха)`, work, "Левая"));
        if (i < sets && rest > 0) arr.push(seg("Отдых", rest));
      }
      return arr;
    }
    case "m4": {
      for (let i = 1; i <= sets; i++) {
        arr.push(seg(sets > 1 ? `Круг ${i} · правая` : "Правая", work, "Правая"));
        if (rest > 0) arr.push(seg("Полный отдых", rest));
        arr.push(seg(sets > 1 ? `Круг ${i} · левая` : "Левая", work, "Левая"));
        if (i < sets && rest > 0) arr.push(seg("Отдых между кругами", rest));
      }
      return arr;
    }
    case "m1":
      return [seg("Проходка · правая", work, "Правая"), seg("Проходка · левая", work, "Левая")];
    case "fri": {
      for (let i = 1; i <= sets; i++) {
        arr.push(seg(`Правая · подход ${i}`, work, "Правая"));
        if (rest > 0) arr.push(seg("Отдых", rest));
        arr.push(seg(`Левая · подход ${i}`, work, "Левая"));
        if (i < sets && rest > 0) arr.push(seg("Отдых", rest));
      }
      return arr;
    }
    default:
      return arr;
  }
  }
}

// Defaults come from the training program
const DEFAULTS = {
  m3: { work: 60, rest: 30, sets: 5, prep: 10 },
  m2: { work: 60, rest: 120, sets: 3, prep: 10 },
  m4: { work: 180, rest: 180, sets: 1, prep: 10 },
  m1: { work: 240, rest: 0, sets: 1, prep: 10 },
  fri: { work: 90, rest: 90, sets: 4, prep: 10 },
};

const PRESETS = [
  { id: "m3", name: "Метод 3 · интервалы одной рукой" },
  { id: "m2", name: "Метод 2 · смена рук без отдыха" },
  { id: "m4", name: "Метод 4 · длинные подходы" },
  { id: "m1", name: "Метод 1 · проходка (одна смена)" },
  { id: "fri", name: "Пятница · толчок / длинный цикл" },
];

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// ── Downloading a file from the app ──
// Classic pattern: Blob → object URL → programmatic click on <a download>:
// https://developer.mozilla.org/docs/Web/API/URL/createObjectURL_static
// The URL is revoked with a delay so the browser has time to start the download.
function downloadFile(name, content, type = "application/json;charset=utf-8") {
  try {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (e) {
    return false;
  }
}

// ── Journal → CSV (";" separator, BOM for Excel) ──
// ";" instead of comma — this way the CSV opens in columns in Excel with a Russian locale;
// a leading BOM (\ufeff) forces Excel to read the file as UTF-8 (Cyrillic breaks otherwise).
// "Long" format: one row per exercise, session fields repeated — convenient for pivot tables.
// Escaping per RFC 4180: https://datatracker.ietf.org/doc/html/rfc4180
function logToCsv(log) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = ["дата", "день", "неделя", "длительность_мин", "самочувствие_до", "сон", "энергия",
    "оценка_тренировки", "упражнение", "кг", "правая", "левая", "значение", "заметка"];
  const rows = [head.join(";")];
  for (const e of log) {
    const base = [e.date, e.dow !== undefined ? DOW[e.dow] : "", e.week || "", e.dur || "",
      e.pre?.well || "", e.pre?.sleep || "", e.pre?.energy || "", e.feel || (e.pain !== undefined ? `боль ${e.pain}/10` : "")];
    const exs = e.exercises && e.exercises.length
      ? e.exercises
      : [{ n: "", kg: e.kg || "", r: e.repsR ?? "", l: e.repsL ?? "", val: "" }];
    for (const ex of exs) {
      rows.push([...base, ex.n || "", ex.kg || "", ex.r ?? "", ex.l ?? "", ex.val || "", e.note || ""]
        .map(esc).join(";"));
    }
  }
  return "\ufeff" + rows.join("\n");
}
const DOW = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];

// ── Sound ──
// Web Audio: https://developer.mozilla.org/docs/Web/API/AudioContext
// Note: browsers only allow creating/resuming an AudioContext after a user gesture
// (autoplay policy), so the context is created lazily on the first beep, which always
// follows a "Start" tap. Vibration is progressive enhancement: works on Android,
// ignored by iOS Safari: https://developer.mozilla.org/docs/Web/API/Navigator/vibrate
function useBeep() {
  const ctxRef = useRef(null);
  return useCallback((freq = 880, dur = 0.18, times = 1) => {
    try {
      if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = ctxRef.current;
      for (let i = 0; i < times; i++) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = freq;
        o.type = "square";
        g.gain.setValueAtTime(0.12, ctx.currentTime + i * 0.28);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.28 + dur);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + i * 0.28);
        o.stop(ctx.currentTime + i * 0.28 + dur);
      }
      if (navigator.vibrate) navigator.vibrate(times === 1 ? 120 : [120, 100, 120]);
    } catch (e) { /* no sound */ }
  }, []);
}

// ── Weight badge ──
function KgBadge({ kg }) {
  return (
    <span className="inline-flex items-center justify-center rounded-full text-xs font-bold px-2 py-1"
      style={{ background: KG_COLOR[kg] || C.surface2, color: kg === 16 ? "#1C1608" : C.text }}>
      {kg} кг
    </span>
  );
}

export default function KettlebellTracker() {
  const [tab, setTab] = useState("today");
  const [week, setWeek] = useState("1");
  const [log, setLog] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [, setPlanVer] = useState(0);
  const planChanged = () => {
    setPlanVer((v) => v + 1);
    setWeek((prev) => (WEEKS[prev] ? prev : Object.keys(WEEKS)[0]));
  };

  // load persisted state
  useEffect(() => {
    (async () => {
      try {
        const s = await window.storage.get("kb-week");
        if (s?.value) setWeek(JSON.parse(s.value));
      } catch (e) { /* nothing saved yet */ }
      try {
        const l = await window.storage.get("kb-log");
        if (l?.value) setLog(JSON.parse(l.value));
      } catch (e) { /* empty journal */ }
      try {
        const p = await window.storage.get("kb-custom-plan");
        if (p?.value) applyPlanData(JSON.parse(p.value));
      } catch (e) { /* built-in plan */ }
      setWeek((prev) => (WEEKS[prev] ? prev : Object.keys(WEEKS)[0]));
      setLoaded(true);
    })();
  }, []);

  const saveWeek = async (w) => {
    setWeek(w);
    try { await window.storage.set("kb-week", JSON.stringify(w)); } catch (e) { /* offline */ }
  };
  const saveLog = async (next) => {
    setLog(next);
    try { await window.storage.set("kb-log", JSON.stringify(next)); } catch (e) { /* offline */ }
  };

  return (
    <div className="min-h-screen w-full flex flex-col" style={{ background: C.bg, color: C.text, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <header className="px-5 pt-5 pb-3 flex items-baseline justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest" style={{ color: C.muted }}>Рывок · 10 минут · одна смена</div>
          <h1 className="text-2xl font-extrabold mt-1">Гиревой дневник</h1>
        </div>
        <select value={week} onChange={(e) => saveWeek(e.target.value)}
          className="rounded-lg px-2 py-1 text-sm font-semibold"
          style={{ background: C.surface2, color: C.text, border: `1px solid ${C.line}` }}>
          {Object.keys(WEEKS).map((k) => (
            <option key={k} value={k}>Нед. {k}</option>
          ))}
        </select>
      </header>

      <main className="flex-1 px-5 pb-28">
        {tab === "today" && <Today week={week} log={log} onSave={saveLog} />}
        {tab === "timer" && <Timer week={week} onFinish={(entry) => saveLog([entry, ...log])} />}
        {tab === "log" && <Journal week={week} log={log} onSave={saveLog} loaded={loaded} />}
        {tab === "plan" && <PlanView onChanged={planChanged} />}
      </main>

      <nav className="fixed bottom-0 left-0 right-0 flex" style={{ background: C.surface, borderTop: `1px solid ${C.line}` }}>
        {[["today", "Сегодня"], ["plan", "План"], ["timer", "Таймер"], ["log", "Журнал"]].map(([id, name]) => (
          <button key={id} onClick={() => setTab(id)}
            className="flex-1 py-4 text-sm font-bold"
            style={{ color: tab === id ? C.text : C.muted, borderTop: tab === id ? `3px solid ${C.kg20}` : "3px solid transparent" }}>
            {name}
          </button>
        ))}
      </nav>
    </div>
  );
}

// ── Unrolling an exercise spec into its sets ──
// For t-exercises, expands the method into a flat list of sets in execution order:
//   m3 — all right-arm sets (short rests), a long rest, then all left-arm sets;
//   m2 — "right → left without rest" pairs, rest between pairs;
//   m4 — rounds of "right → full rest → left";
//   m1 — test run: right → left, no rest (a single hand switch);
//   fri — generic right/left pairs with rest (jerk, long cycle, farmer's carry).
// A set's rest = the pause AFTER it; the auto-chain in Today relies on this field.
function genSets(ex) {
  if (ex.t) {
    const { m, work, rest, sets } = ex.t;
    const out = [];
    if (m === "m3") {
      for (let i = 1; i <= sets; i++) out.push({ arm: "П", work, rest: i < sets ? rest : Math.max(rest, 120), label: `Правая · ${i}` });
      for (let i = 1; i <= sets; i++) out.push({ arm: "Л", work, rest: i < sets ? rest : 0, label: `Левая · ${i}` });
    } else if (m === "m2") {
      for (let i = 1; i <= sets; i++) {
        out.push({ arm: "П", work, rest: 0, label: `${i} · правая` });
        out.push({ arm: "Л", work, rest: i < sets ? rest : 0, label: `${i} · левая (сразу)` });
      }
    } else if (m === "m4") {
      for (let i = 1; i <= sets; i++) {
        out.push({ arm: "П", work, rest, label: sets > 1 ? `Круг ${i} · правая` : "Правая" });
        out.push({ arm: "Л", work, rest: i < sets ? rest : 0, label: sets > 1 ? `Круг ${i} · левая` : "Левая" });
      }
    } else if (m === "m1") {
      out.push({ arm: "П", work, rest: 0, label: "Проходка · правая" });
      out.push({ arm: "Л", work, rest: 0, label: "Проходка · левая" });
    } else {
      for (let i = 1; i <= sets; i++) {
        out.push({ arm: "П", work, rest, label: `Правая · ${i}` });
        out.push({ arm: "Л", work, rest: i < sets ? rest : 0, label: `Левая · ${i}` });
      }
    }
    return out;
  }
  const n = ex.s?.sets || 1;
  return Array.from({ length: n }, (_, i) => ({ arm: null, work: 0, rest: 0, label: `Подход ${i + 1}` }));
}

// ── Checklist (warm-up / cool-down) ──
function Checklist({ title, items, done, onToggle }) {
  return (
    <div className="rounded-2xl p-4 mb-3" style={{ background: C.surface2, border: `1px solid ${C.line}` }}>
      <div className="font-bold mb-2">{title}</div>
      {items.map((it, i) => (
        <button key={i} onClick={() => onToggle(i)}
          className="w-full flex items-center gap-3 py-2 text-left">
          <span className="w-6 h-6 rounded-md flex items-center justify-center text-sm font-bold shrink-0"
            style={{ background: done[i] ? C.ok : C.surface, border: `1px solid ${done[i] ? C.ok : C.line}`, color: C.text }}>
            {done[i] ? "✓" : ""}
          </span>
          <span className="text-sm" style={{ color: done[i] ? C.muted : C.text, textDecoration: done[i] ? "line-through" : "none" }}>
            {it}
          </span>
        </button>
      ))}
    </div>
  );
}

// ═══ Exercise type components ═══
// Sets run as a chain: work → auto rest → auto-start of the next set.
// A completed set is frozen, but its actual rep count stays editable at any time
// (including later — e.g. after recounting from a video).
function ExerciseBlock(props) {
  const { ex } = props;
  if (ex.t) return <TimedUniExercise {...props} />;
  if (ex.c) return <CardioExercise {...props} />;
  if (ex.uni) return <RepsUniExercise {...props} />;
  return <RepsBiExercise {...props} />;
}

// Shared exercise card: name, planned line, weight badge
function ExerciseCard({ ex, children }) {
  return (
    <div className="rounded-2xl p-4 mb-3" style={{ background: C.surface, border: `1px solid ${C.line}` }}>
      <div className="flex items-center justify-between mb-2">
        <div className="font-bold text-sm">{ex.n}</div>
        <div className="flex items-center gap-2 shrink-0">
          {ex.planned && <span className="text-xs" style={{ color: C.muted }}>план: {ex.planned}</span>}
          {ex.kg && <KgBadge kg={ex.kg} />}
        </div>
      </div>
      {children}
    </div>
  );
}

const INP = () => ({ background: C.bg, color: C.text, border: `1px solid ${C.line}` });

// Small per-row buttons
function SkipBtn({ onClick }) {
  return (
    <button onClick={onClick} title="Пропустить подход"
      className="px-2 py-2 rounded-lg text-xs font-bold shrink-0"
      style={{ background: "transparent", color: C.muted, border: `1px solid ${C.line}` }}>
      Проп.
    </button>
  );
}
function ConfirmBtn({ onClick }) {
  return (
    <button onClick={onClick} title="Подход выполнен"
      className="w-11 py-2 rounded-lg text-base font-extrabold shrink-0"
      style={{ background: C.ok, color: C.text, border: `1px solid ${C.ok}` }}>
      ✓
    </button>
  );
}

// Set status within the sequence
function setState(acts, exIdx, sets, j, tmKey) {
  const st = (k) => acts[`${exIdx}-${k}`]?.st;
  let active = sets.findIndex((_, k) => st(k) !== "done" && st(k) !== "skip");
  if (active === -1) active = sets.length;
  const a = acts[`${exIdx}-${j}`] || {};
  if (a.st === "done") return "done";
  if (a.st === "skip") return "skip";
  if (j > active) return "locked";
  if (tmKey === `${exIdx}-${j}`) return "run";
  if (a.st === "await") return "await";
  return "ready";
}

// Timed one-armed: starting the first set launches the whole chain
function TimedUniExercise({ ex, exIdx, acts, setAct, tm, running, onStartSet, onToggle, onConfirm, onSkip }) {
  const sets = genSets(ex);
  return (
    <ExerciseCard ex={ex}>
      {sets.map((s, j) => {
        const key = `${exIdx}-${j}`;
        const a = acts[key] || {};
        const state = setState(acts, exIdx, sets, j, tm?.key);
        const armColor = s.arm === "П" ? C.kg16 : C.kg20;
        return (
          <div key={j} className="rounded-xl px-3 py-2 mb-1 flex items-center gap-2"
            style={{
              opacity: state === "locked" ? 0.45 : 1,
              background: state === "run" ? C.surface2 : "transparent",
              border: `1px solid ${state === "run" ? (tm.phase === "work" ? armColor : C.muted) : C.line}`,
            }}>
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate"
                style={{ color: state === "skip" ? C.muted : armColor, textDecoration: state === "skip" ? "line-through" : "none" }}>
                {s.label}
              </div>
              <div className="text-xs" style={{ color: C.muted }}>
                {fmt(s.work)}{s.rest > 0 ? ` · отдых ${fmt(s.rest)}` : ""}{ex.pr ? ` · план ${ex.pr}` : ""}
              </div>
            </div>
            {state === "ready" && (
              <>
                <SkipBtn onClick={() => onSkip(key)} />
                <button onClick={() => onStartSet(key, s)}
                  className="w-16 py-2 rounded-lg text-sm font-extrabold shrink-0"
                  style={{ background: C.ok, color: C.text, border: `1px solid ${C.ok}` }}>
                  Старт
                </button>
              </>
            )}
            {state === "run" && (
              <button onClick={onToggle}
                className="w-20 py-2 rounded-lg text-sm font-extrabold shrink-0"
                style={{ background: C.surface, color: C.text, border: `1px solid ${C.line}`, fontVariantNumeric: "tabular-nums" }}>
                {running ? fmt(tm.left) : "▶ " + fmt(tm.left)}
              </button>
            )}
            {state === "done" && (
              <>
                <input inputMode="numeric" placeholder="повт." value={a.v || ""}
                  onChange={(e) => setAct(key, "v", e.target.value.replace(/\D/g, ""))}
                  className="w-16 rounded-lg px-2 py-2 text-sm text-center shrink-0" style={INP()} />
                <div className="w-8 text-center text-lg font-extrabold shrink-0" style={{ color: C.ok }}>✓</div>
              </>
            )}
            {state === "skip" && <div className="text-xs shrink-0" style={{ color: C.muted }}>пропущен</div>}
          </div>
        );
      })}
    </ExerciseCard>
  );
}

// One-armed rep-based: actual R/L → ✓ (rest starts automatically)
function RepsUniExercise({ ex, exIdx, acts, setAct, onConfirm, onSkip, onStartRest }) {
  const sets = genSets(ex);
  return (
    <ExerciseCard ex={ex}>
      {sets.map((s, j) => {
        const key = `${exIdx}-${j}`;
        const a = acts[key] || {};
        const state = setState(acts, exIdx, sets, j, null);
        const confirm = () => {
          onConfirm(key);
          if (ex.s?.rest > 0 && j < sets.length - 1) onStartRest(key, ex.s.rest, ex.n);
        };
        return (
          <div key={j} className="rounded-xl px-3 py-2 mb-1 flex items-center gap-2"
            style={{ opacity: state === "locked" ? 0.45 : 1, border: `1px solid ${C.line}` }}>
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate"
                style={{ color: state === "skip" ? C.muted : C.text, textDecoration: state === "skip" ? "line-through" : "none" }}>
                {s.label}
              </div>
              {ex.pr && <div className="text-xs" style={{ color: C.muted }}>план {ex.pr} на сторону</div>}
            </div>
            {state === "ready" && (
              <>
                <input inputMode="numeric" placeholder="П" value={a.r || ""}
                  onChange={(e) => setAct(key, "r", e.target.value.replace(/\D/g, ""))}
                  className="w-12 rounded-lg px-1 py-2 text-sm text-center shrink-0" style={INP()} />
                <input inputMode="numeric" placeholder="Л" value={a.l || ""}
                  onChange={(e) => setAct(key, "l", e.target.value.replace(/\D/g, ""))}
                  className="w-12 rounded-lg px-1 py-2 text-sm text-center shrink-0" style={INP()} />
                <SkipBtn onClick={() => onSkip(key)} />
                <ConfirmBtn onClick={confirm} />
              </>
            )}
            {state === "done" && (
              <>
                <input inputMode="numeric" placeholder="П" value={a.r || ""}
                  onChange={(e) => setAct(key, "r", e.target.value.replace(/\D/g, ""))}
                  className="w-12 rounded-lg px-1 py-2 text-sm text-center shrink-0" style={INP()} />
                <input inputMode="numeric" placeholder="Л" value={a.l || ""}
                  onChange={(e) => setAct(key, "l", e.target.value.replace(/\D/g, ""))}
                  className="w-12 rounded-lg px-1 py-2 text-sm text-center shrink-0" style={INP()} />
                <div className="w-6 text-center text-lg font-extrabold shrink-0" style={{ color: C.ok }}>✓</div>
              </>
            )}
            {state === "skip" && <div className="text-xs shrink-0" style={{ color: C.muted }}>пропущен</div>}
          </div>
        );
      })}
    </ExerciseCard>
  );
}

// Bilateral rep-based: one actual value per set → ✓
function RepsBiExercise({ ex, exIdx, acts, setAct, onConfirm, onSkip, onStartRest }) {
  const sets = genSets(ex);
  const freeText = ex.kg == null; // gym exercises: weight is typed inline (e.g. "6×80")
  return (
    <ExerciseCard ex={ex}>
      {sets.map((s, j) => {
        const key = `${exIdx}-${j}`;
        const a = acts[key] || {};
        const state = setState(acts, exIdx, sets, j, null);
        const confirm = () => {
          onConfirm(key);
          if (ex.s?.rest > 0 && j < sets.length - 1) onStartRest(key, ex.s.rest, ex.n);
        };
        return (
          <div key={j} className="rounded-xl px-3 py-2 mb-1 flex items-center gap-2"
            style={{ opacity: state === "locked" ? 0.45 : 1, border: `1px solid ${C.line}` }}>
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate"
                style={{ color: state === "skip" ? C.muted : C.text, textDecoration: state === "skip" ? "line-through" : "none" }}>
                {s.label}
              </div>
              {ex.pr && <div className="text-xs" style={{ color: C.muted }}>план {ex.pr}</div>}
            </div>
            {state === "ready" && (
              <>
                <input inputMode={freeText ? "text" : "numeric"}
                  placeholder={freeText ? "напр. 6×80" : "факт"} value={a.v || ""}
                  onChange={(e) => setAct(key, "v", freeText ? e.target.value : e.target.value.replace(/\D/g, ""))}
                  className="w-24 rounded-lg px-2 py-2 text-sm text-center shrink-0" style={INP()} />
                <SkipBtn onClick={() => onSkip(key)} />
                <ConfirmBtn onClick={confirm} />
              </>
            )}
            {state === "done" && (
              <>
                <input inputMode={freeText ? "text" : "numeric"}
                  placeholder={freeText ? "напр. 6×80" : "факт"} value={a.v || ""}
                  onChange={(e) => setAct(key, "v", freeText ? e.target.value : e.target.value.replace(/\D/g, ""))}
                  className="w-24 rounded-lg px-2 py-2 text-sm text-center shrink-0" style={INP()} />
                <div className="w-6 text-center text-lg font-extrabold shrink-0" style={{ color: C.ok }}>✓</div>
              </>
            )}
            {state === "skip" && <div className="text-xs shrink-0" style={{ color: C.muted }}>пропущен</div>}
          </div>
        );
      })}
    </ExerciseCard>
  );
}

// Cardio: distance and time
function CardioExercise({ ex, exIdx, acts, setAct }) {
  const key = `${exIdx}-0`;
  const a = acts[key] || {};
  return (
    <ExerciseCard ex={ex}>
      <div className="flex gap-2">
        <input inputMode="numeric" placeholder="Дистанция, м" value={a.dist || ""}
          onChange={(e) => setAct(key, "dist", e.target.value.replace(/\D/g, ""))}
          className="flex-1 rounded-lg px-3 py-2 text-sm" style={INP()} />
        <input inputMode="numeric" placeholder="Время, мин" value={a.min || ""}
          onChange={(e) => setAct(key, "min", e.target.value.replace(/\D/g, ""))}
          className="flex-1 rounded-lg px-3 py-2 text-sm" style={INP()} />
      </div>
    </ExerciseCard>
  );
}

// ── Today: guided workout ──
function Today({ week, log, onSave }) {
  const w = WEEKS[week];
  const today = new Date().getDay();
  const [d, setD] = useState(today);
  const DAYS_SHORT = [["Пн", 1], ["Вт", 2], ["Ср", 3], ["Чт", 4], ["Пт", 5], ["Сб", 6], ["Вс", 0]];
  const plan = dayExercises(week, d);
  const trainDay = plan.length > 0;
  const kbDay = d === 1 || d === 5;

  const [pre, setPre] = useState({ well: 0, sleep: 0, energy: 0 });
  const [startTs, setStartTs] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [acts, setActs] = useState({});
  const [wu, setWu] = useState({});
  const [cd, setCd] = useState({});
  const [finishing, setFinishing] = useState(false);
  const [feel, setFeel] = useState(0);
  const [note, setNote] = useState("");
  const [tm, setTm] = useState(null);
  const [running, setRunning] = useState(false);
  const beep = useBeep();

  useEffect(() => {
    setPre({ well: 0, sleep: 0, energy: 0 }); setStartTs(null); setActs({});
    setWu({}); setCd({}); setFinishing(false); setFeel(0); setNote("");
    setTm(null); setRunning(false);
  }, [week, d]);

  useEffect(() => {
    if (!startTs) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [startTs]);

  // A single interval drives the whole chain: work → done → rest → auto-start of the next set.
  // The logic lives inside setTm's functional update so each tick sees fresh state without
  // recreating the interval (https://react.dev/reference/react/useState#updating-state-based-on-the-previous-state).
  // Side effects (beep, markDone) inside the updater are a deliberate prototype trade-off:
  // in dev StrictMode the updater may run twice; markDone is idempotent, an extra beep is harmless.
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => {
      setTm((t) => {
        if (!t) return t;
        if (t.left > 1) {
          if (t.left <= 4) beep(660, 0.1, 1);
          return { ...t, left: t.left - 1 };
        }
        if (t.phase === "work") {
          markDone(t.key);
          if (t.rest > 0) {
            beep(440, 0.22, 1);
            return { ...t, phase: "rest", left: t.rest };
          }
        }
        const nx = nextTm(t.key);
        if (nx) {
          beep(980, 0.22, 2);
          return nx;
        }
        beep(520, 0.35, 2);
        setRunning(false);
        return null;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [running, beep]);

  const startSet = (key, s) => {
    beep(980, 0.22, 2);
    setTm({ key, phase: "work", left: s.work, rest: s.rest, label: s.label });
    setRunning(true);
  };
  const startRest = (key, restS, label) => {
    beep(440, 0.22, 1);
    setTm({ key: key + "-r", phase: "rest", left: restS, rest: 0, label });
    setRunning(true);
  };
  const skipPhase = () => {
    setTm((t) => {
      if (!t) return t;
      if (t.phase === "work") {
        markDone(t.key);
        if (t.rest > 0) {
          beep(440, 0.22, 1);
          return { ...t, phase: "rest", left: t.rest };
        }
      }
      const nx = nextTm(t.key);
      if (nx) {
        beep(980, 0.22, 2);
        return nx;
      }
      beep(520, 0.35, 2);
      setRunning(false);
      return null;
    });
  };
  const stopTimer = () => { setTm(null); setRunning(false); };
  const openFinish = () => { stopTimer(); setFinishing(true); };
  const setAct = (key, field, val) =>
    setActs((a) => ({ ...a, [key]: { ...(a[key] || {}), [field]: val } }));
  const markDone = (key) => {
    if (!key || key.endsWith("-r")) return;
    setActs((a) => {
      const cur = a[key] || {};
      if (cur.st === "done" || cur.st === "skip") return a;
      return { ...a, [key]: { ...cur, st: "done" } };
    });
  };
  // Next set of the same exercise — used to auto-start after rest
  const nextTm = (key) => {
    const m = /^(\d+)-(\d+)$/.exec(key || "");
    if (!m) return null;
    const ei = Number(m[1]), sj = Number(m[2]);
    const ex = plan[ei];
    if (!ex || !ex.t) return null;
    const sets = genSets(ex);
    const nj = sj + 1;
    if (nj >= sets.length) return null;
    const s = sets[nj];
    return { key: `${ei}-${nj}`, phase: "work", left: s.work, rest: s.rest, label: s.label };
  };
  const confirmSet = (key) => setActs((a) => ({ ...a, [key]: { ...(a[key] || {}), st: "done" } }));
  const skipSet = (key) => setActs((a) => ({ ...a, [key]: { ...(a[key] || {}), st: "skip" } }));

  const elapsed = startTs ? Math.floor((now - startTs) / 1000) : 0;

  const finish = () => {
    const exercises = plan.map((ex, i) => {
      const sets = genSets(ex);
      if (ex.uni) {
        let r = 0, l = 0;
        sets.forEach((s, j) => {
          const a = acts[`${i}-${j}`] || {};
          if (s.arm === "П") r += Number(a.v) || 0;
          else if (s.arm === "Л") l += Number(a.v) || 0;
          else { r += Number(a.r) || 0; l += Number(a.l) || 0; }
        });
        return { n: ex.n, kg: ex.kg, uni: true, r: r ? String(r) : "", l: l ? String(l) : "" };
      }
      if (ex.c) {
        const a = acts[`${i}-0`] || {};
        const val = [a.dist ? `${a.dist} м` : null, a.min ? `${a.min} мин` : null].filter(Boolean).join(" · ");
        return { n: ex.n, kg: ex.kg, uni: false, val };
      }
      const vals = sets.map((s, j) => (acts[`${i}-${j}`] || {}).v).filter(Boolean);
      return { n: ex.n, kg: ex.kg, uni: false, val: vals.join(" / ") };
    }).filter((ex) => ex.r || ex.l || ex.val);
    const entry = {
      id: Date.now(),
      date: new Date(startTs || Date.now()).toISOString().slice(0, 10),
      dow: d, week, exercises,
      dur: startTs ? Math.max(1, Math.round(elapsed / 60)) : null,
      pre: pre.well || pre.sleep || pre.energy ? pre : null,
      feel: Number(feel) || null,
      note: note.trim(),
    };
    onSave([entry, ...log]);
    setStartTs(null); setFinishing(false); setActs({}); setTm(null); setRunning(false);
    setFeel(0); setNote(""); setPre({ well: 0, sleep: 0, energy: 0 }); setWu({}); setCd({});
  };

  const inp = { background: C.bg, color: C.text, border: `1px solid ${C.line}` };
  const wuItems = kbDay ? w.ladder.map((kg) => `${kg} кг · 10 махов + 10 рывков с доп. махом + 10 рывков (каждой рукой)`) : [];
  const cdItems = kbDay ? ["Круги лопатками", "Растяжка левой боковой поверхности шеи"] : [];

  // ── Recovery days ──
  if (!trainDay) {
    const txt = d === 0
      ? "Воскресенье · полный отдых."
      : "Массаж и восстановление. Микропаузы за рабочим столом каждые 30–45 минут.";
    return (
      <div>
        <DayChips d={d} setD={setD} today={today} DAYS_SHORT={DAYS_SHORT} />
        <div className="text-sm font-semibold mb-1" style={{ color: C.kg16 }}>
          {DOW[d]}{d === today ? " · сегодня" : ""} · {w.label}
        </div>
        <div className="rounded-2xl p-4" style={{ background: C.surface, border: `1px solid ${C.line}` }}>
          <div className="text-sm leading-relaxed" style={{ color: C.muted }}>{txt}</div>
        </div>
      </div>
    );
  }

  // ── Pre-start: plan + survey + start button ──
  if (!startTs) {
    return (
      <div>
        <DayChips d={d} setD={setD} today={today} DAYS_SHORT={DAYS_SHORT} />
        <div className="text-sm font-semibold mb-2" style={{ color: C.kg16 }}>
          {DOW[d]}{d === today ? " · сегодня" : ""} · {w.label}
        </div>

        <div className="rounded-2xl p-4 mb-3" style={{ background: C.surface, border: `1px solid ${C.line}` }}>
          <div className="font-bold mb-2">План</div>
          {kbDay && (
            <div className="text-sm mb-2 pb-2" style={{ color: C.muted, borderBottom: `1px solid ${C.line}` }}>
              Разминка · лестница: {w.ladder.join(" → ")} кг
            </div>
          )}
          {plan.map((ex, i) => (
            <div key={i} className="flex items-center justify-between py-1">
              <div className="text-sm">{ex.n}</div>
              <div className="flex items-center gap-2 shrink-0">
                {ex.planned && <span className="text-xs" style={{ color: C.muted }}>{ex.planned}</span>}
                {ex.kg && <KgBadge kg={ex.kg} />}
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-2xl p-4 mb-3" style={{ background: C.surface, border: `1px solid ${C.line}` }}>
          <div className="font-bold mb-2">До тренировки</div>
          <MiniRate label="Самочувствие" value={pre.well} onChange={(v) => setPre((p) => ({ ...p, well: v }))} />
          <MiniRate label="Сон" value={pre.sleep} onChange={(v) => setPre((p) => ({ ...p, sleep: v }))} />
          <MiniRate label="Энергия" value={pre.energy} onChange={(v) => setPre((p) => ({ ...p, energy: v }))} />
        </div>

        <button onClick={() => { setStartTs(Date.now()); setNow(Date.now()); }}
          className="w-full py-5 rounded-2xl text-lg font-extrabold mb-3"
          style={{ background: C.ok, color: C.text }}>
          Начать тренировку
        </button>

        <div className="rounded-2xl p-4" style={{ background: C.bg, border: `1px dashed ${C.stop}` }}>
          <div className="font-bold mb-1" style={{ color: C.stop }}>Правила безопасности</div>
          <div className="text-sm leading-relaxed" style={{ color: C.muted }}>
            Ноющая боль в шее или под лопаткой — стоп, откат на 16 кг до конца недели. Гиря уползает из пальцев — поставить раньше.
          </div>
        </div>
      </div>
    );
  }

  // ── Active workout ──
  return (
    <div style={{ paddingBottom: tm ? 170 : 100 }}>
      <div className="rounded-2xl p-4 mb-3 flex items-center justify-between sticky top-2 z-10"
        style={{ background: C.surface, border: `1px solid ${C.kg20}` }}>
        <div>
          <div className="text-xs" style={{ color: C.muted }}>{DOW[d]} · идёт тренировка</div>
          <div className="text-3xl font-extrabold" style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(elapsed)}</div>
        </div>
        <button onClick={openFinish}
          className="px-4 py-3 rounded-xl font-bold text-sm"
          style={{ background: C.surface2, color: C.stop, border: `1px solid ${C.line}` }}>
          Закончить
        </button>
      </div>

      {wuItems.length > 0 && (
        <Checklist title="Разминка · лестница" items={wuItems} done={wu}
          onToggle={(i) => setWu((x) => ({ ...x, [i]: !x[i] }))} />
      )}

      {plan.map((ex, i) => (
        <ExerciseBlock key={`${week}-${d}-${i}`} ex={ex} exIdx={i}
          acts={acts} setAct={setAct} tm={tm} running={running}
          onStartSet={startSet} onStartRest={startRest} onToggle={() => setRunning((r) => !r)}
          onConfirm={confirmSet} onSkip={skipSet} />
      ))}

      {cdItems.length > 0 && (
        <Checklist title="Заминка" items={cdItems} done={cd}
          onToggle={(i) => setCd((x) => ({ ...x, [i]: !x[i] }))} />
      )}

      <button onClick={openFinish}
        className="w-full py-5 rounded-2xl text-lg font-extrabold"
        style={{ background: C.surface2, color: C.stop, border: `1px solid ${C.stop}` }}>
        Закончить тренировку
      </button>

      {finishing && (
        <div className="fixed inset-0 z-30 flex items-end justify-center p-3"
          style={{ background: "rgba(10,12,15,0.75)" }}
          onClick={() => setFinishing(false)}>
          <div className="w-full rounded-2xl p-4" onClick={(e) => e.stopPropagation()}
            style={{ background: C.surface, border: `1px solid ${C.ok}`, marginBottom: 60 }}>
            <div className="font-bold mb-2">Итог · {fmt(elapsed)}</div>
            <div className="mb-2 text-sm" style={{ color: C.muted }}>Ощущение от тренировки</div>
            <div className="flex gap-2 mb-3">
              {[1, 2, 3, 4, 5].map((v) => (
                <button key={v} onClick={() => setFeel(feel === v ? 0 : v)}
                  className="flex-1 py-3 rounded-xl font-extrabold"
                  style={{
                    background: feel === v ? (v <= 2 ? C.stop : v === 3 ? C.surface2 : C.ok) : C.surface2,
                    color: feel === v ? C.text : C.muted,
                    border: `1px solid ${feel === v ? (v <= 2 ? C.stop : C.ok) : C.line}`,
                  }}>
                  {v}
                </button>
              ))}
            </div>
            <input placeholder="Заметка: хват, асимметрия, ощущения…" value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-xl px-3 py-3 text-sm mb-3"
              style={{ background: C.surface2, color: C.text, border: `1px solid ${C.line}` }} />
            <div className="flex gap-2">
              <button onClick={finish} className="flex-1 py-4 rounded-2xl font-extrabold"
                style={{ background: C.ok, color: C.text }}>
                Сохранить в журнал
              </button>
              <button onClick={() => setFinishing(false)} className="px-4 py-4 rounded-2xl font-bold"
                style={{ background: C.surface2, color: C.muted }}>
                Назад
              </button>
            </div>
          </div>
        </div>
      )}

      {tm && (
        <div className="fixed left-3 right-3 rounded-2xl px-4 py-3 flex items-center gap-3 z-20"
          style={{ bottom: 72, background: C.surface2, border: `2px solid ${tm.phase === "work" ? C.kg20 : C.muted}` }}>
          <div className="flex-1 min-w-0" onClick={() => setRunning((r) => !r)}>
            <div className="text-xs truncate" style={{ color: C.muted }}>
              {tm.phase === "work" ? tm.label : `Отдых · ${tm.label}`}{!running ? " · пауза" : ""} · тап — пауза
            </div>
            <div className="text-3xl font-extrabold" style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(tm.left)}</div>
          </div>
          <button onClick={skipPhase} title="Пропустить"
            className="w-11 h-11 rounded-xl text-lg font-extrabold shrink-0"
            style={{ background: C.surface, color: C.text, border: `1px solid ${C.line}` }}>
            ⏭
          </button>
          <button onClick={stopTimer} title="Отменить таймер"
            className="w-11 h-11 rounded-xl text-lg font-extrabold shrink-0"
            style={{ background: C.surface, color: C.stop, border: `1px solid ${C.line}` }}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

// ── Day-of-week switcher ──
function DayChips({ d, setD, today, DAYS_SHORT }) {
  return (
    <div className="flex gap-1 mb-3">
      {DAYS_SHORT.map(([name, idx]) => (
        <button key={idx} onClick={() => setD(idx)}
          className="flex-1 py-2 rounded-xl text-sm font-bold"
          style={{
            background: d === idx ? C.kg20 : C.surface2,
            color: d === idx ? C.text : C.muted,
            border: `1px solid ${idx === today ? C.kg16 : C.line}`,
          }}>
          {name}
        </button>
      ))}
    </div>
  );
}

// ── Settings stepper ──
function Stepper({ label, value, onDec, onInc }) {
  return (
    <div className="flex-1 rounded-xl p-2 text-center" style={{ background: C.surface2, border: `1px solid ${C.line}` }}>
      <div className="text-xs mb-1" style={{ color: C.muted }}>{label}</div>
      <div className="flex items-center justify-between">
        <button onClick={onDec} className="w-9 h-9 rounded-lg font-extrabold text-lg" style={{ background: C.surface, color: C.text }}>−</button>
        <div className="font-bold text-sm px-1" style={{ fontVariantNumeric: "tabular-nums" }}>{value}</div>
        <button onClick={onInc} className="w-9 h-9 rounded-lg font-extrabold text-lg" style={{ background: C.surface, color: C.text }}>+</button>
      </div>
    </div>
  );
}

// ── Timer tab ──
function Timer({ week, onFinish }) {
  const defaultPreset = WEEKS[week]?.mon?.method || "m3";
  const [presetId, setPresetId] = useState(defaultPreset);
  const [cfg, setCfg] = useState({ ...DEFAULTS[defaultPreset] });
  const [segs, setSegs] = useState(() => buildPreset(defaultPreset, DEFAULTS[defaultPreset]));
  const [idx, setIdx] = useState(0);
  const [left, setLeft] = useState(segs[0]?.s || 0);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const beep = useBeep();
  const tickRef = useRef(null);

  const reset = (id = presetId, c = cfg) => {
    const s = buildPreset(id, c);
    setSegs(s); setIdx(0); setLeft(s[0]?.s || 0); setRunning(false); setDone(false);
  };

  // Method change — load defaults from the program
  useEffect(() => {
    const c = { ...DEFAULTS[presetId] };
    setCfg(c);
    reset(presetId, c);
  }, [presetId]);

  // Setting changes apply immediately (the timer resets)
  const updCfg = (key, delta, min, max) => {
    const c = { ...cfg, [key]: Math.min(max, Math.max(min, cfg[key] + delta)) };
    setCfg(c);
    reset(presetId, c);
  };

  useEffect(() => {
    if (!running) { clearInterval(tickRef.current); return; }
    tickRef.current = setInterval(() => {
      setLeft((prev) => {
        if (prev > 1) {
          if (prev <= 4) beep(660, 0.1, 1);
          return prev - 1;
        }
        // end of segment
        setIdx((i) => {
          const next = i + 1;
          if (next >= segs.length) {
            beep(520, 0.4, 3);
            setRunning(false); setDone(true);
            return i;
          }
          const arm = segs[next].arm;
          beep(arm ? 980 : 440, 0.22, arm ? 2 : 1);
          setLeft(segs[next].s);
          return next;
        });
        return 0;
      });
    }, 1000);
    return () => clearInterval(tickRef.current);
  }, [running, segs, beep]);

  const cur = segs[idx];
  const total = segs.reduce((a, s) => a + s.s, 0);
  const elapsed = segs.slice(0, idx).reduce((a, s) => a + s.s, 0) + (cur ? cur.s - left : 0);
  const isWork = !!cur?.arm;

  return (
    <div className="flex flex-col items-center">
      <select value={presetId} onChange={(e) => setPresetId(e.target.value)}
        className="w-full rounded-xl px-3 py-3 text-sm font-semibold mb-3"
        style={{ background: C.surface2, color: C.text, border: `1px solid ${C.line}` }}>
        {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>

      <div className="grid grid-cols-2 gap-2 w-full mb-2">
        <Stepper label="Подготовка" value={fmt(cfg.prep)}
          onDec={() => updCfg("prep", -5, 0, 60)} onInc={() => updCfg("prep", 5, 0, 60)} />
        <Stepper label={presetId === "m1" ? "На руку" : "Подход"} value={fmt(cfg.work)}
          onDec={() => updCfg("work", -15, 15, 600)} onInc={() => updCfg("work", 15, 15, 600)} />
        {presetId !== "m1" && (
          <Stepper label="Отдых" value={fmt(cfg.rest)}
            onDec={() => updCfg("rest", -15, 0, 600)} onInc={() => updCfg("rest", 15, 0, 600)} />
        )}
        {presetId !== "m1" && (
          <Stepper label="Подходы" value={cfg.sets}
            onDec={() => updCfg("sets", -1, 1, 10)} onInc={() => updCfg("sets", 1, 1, 10)} />
        )}
      </div>
      <div className="text-xs mb-5" style={{ color: C.muted }}>
        По умолчанию — значения из тренировочной программы. Изменение настроек сбрасывает таймер.
      </div>

      <div className="text-sm font-bold uppercase tracking-widest mb-1"
        style={{ color: isWork ? (cur.arm === "Правая" ? C.kg16 : C.kg20) : C.muted }}>
        {done ? "Готово" : cur?.label || "—"}
      </div>

      <div className="font-extrabold select-none"
        onClick={() => !done && segs.length > 0 && setRunning((r) => !r)}
        style={{ fontSize: "min(28vw, 128px)", lineHeight: 1.05, fontVariantNumeric: "tabular-nums", color: isWork ? C.text : C.muted, cursor: "pointer" }}>
        {fmt(left)}
      </div>

      <div className="text-xs mb-6" style={{ color: C.muted, fontVariantNumeric: "tabular-nums" }}>
        сегмент {Math.min(idx + 1, segs.length)}/{segs.length} · всего {fmt(elapsed)} из {fmt(total)} · тап по цифрам — пауза
      </div>

      <div className="w-full h-2 rounded-full mb-8" style={{ background: C.surface2 }}>
        <div className="h-2 rounded-full" style={{ width: `${(elapsed / total) * 100}%`, background: isWork ? C.kg20 : C.muted, transition: "width 1s linear" }} />
      </div>

      <div className="flex gap-3 w-full">
        <button onClick={() => setRunning((r) => !r)} disabled={done}
          className="flex-1 py-5 rounded-2xl text-lg font-extrabold"
          style={{ background: running ? C.surface2 : C.ok, color: C.text, opacity: done ? 0.4 : 1 }}>
          {running ? "Пауза" : "Старт"}
        </button>
        <button onClick={() => reset()} className="px-6 py-5 rounded-2xl text-lg font-extrabold"
          style={{ background: C.surface2, color: C.stop }}>
          Сброс
        </button>
      </div>

      {done && (
        <div className="w-full mt-6 rounded-2xl p-4 text-center" style={{ background: C.surface, border: `1px solid ${C.ok}` }}>
          <div className="font-bold mb-1" style={{ color: C.ok }}>Сессия завершена</div>
          <div className="text-sm" style={{ color: C.muted }}>Запиши подходы и вечернюю оценку во вкладке «Журнал».</div>
        </div>
      )}
    </div>
  );
}

// ── Compact 1–5 rating ──
function MiniRate({ label, value, onChange }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <div className="text-sm" style={{ color: C.muted }}>{label}</div>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((v) => (
          <button key={v} onClick={() => onChange(value === v ? 0 : v)}
            className="w-9 h-9 rounded-lg text-sm font-bold"
            style={{
              background: value === v ? (v <= 2 ? C.stop : v === 3 ? C.surface : C.ok) : C.surface2,
              color: value === v ? C.text : C.muted,
              border: `1px solid ${C.line}`,
            }}>
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Journal: an entry per exercise from the day's plan ──
function Journal({ week, log, onSave, loaded }) {
  const today = new Date().getDay();
  const [d, setD] = useState(today);
  const DAYS_SHORT = [["Пн", 1], ["Вт", 2], ["Ср", 3], ["Чт", 4], ["Пт", 5], ["Сб", 6], ["Вс", 0]];

  const plan = dayExercises(week, d);
  const emptyRows = (p) => p.map(() => ({ r: "", l: "", val: "" }));
  const [rows, setRows] = useState(() => emptyRows(plan));
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [dur, setDur] = useState("");
  const [pre, setPre] = useState({ well: 0, sleep: 0, energy: 0 });
  const [feel, setFeel] = useState(0);
  const [note, setNote] = useState("");

  useEffect(() => { setRows(emptyRows(dayExercises(week, d))); }, [week, d]);

  const setRow = (i, k, v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  const filled = rows.some((r) => r.r || r.l || r.val) || note.trim();
  const add = () => {
    const exercises = plan
      .map((ex, i) => ({ ...ex, ...rows[i] }))
      .filter((ex) => ex.r || ex.l || ex.val);
    const entry = {
      id: Date.now(),
      date,
      dow: d,
      week,
      exercises,
      dur: Number(dur) || null,
      pre: pre.well || pre.sleep || pre.energy ? pre : null,
      feel: Number(feel) || null,
      note: note.trim(),
    };
    onSave([entry, ...log]);
    setRows(emptyRows(plan));
    setDate(new Date().toISOString().slice(0, 10));
    setDur(""); setPre({ well: 0, sleep: 0, energy: 0 });
    setFeel(0); setNote("");
  };
  const remove = (id) => onSave(log.filter((e) => e.id !== id));

  const inp = { background: C.surface2, color: C.text, border: `1px solid ${C.line}` };

  return (
    <div>
      <div className="flex gap-1 mb-3">
        {DAYS_SHORT.map(([name, idx]) => (
          <button key={idx} onClick={() => setD(idx)}
            className="flex-1 py-2 rounded-xl text-sm font-bold"
            style={{
              background: d === idx ? C.kg20 : C.surface2,
              color: d === idx ? C.text : C.muted,
              border: `1px solid ${idx === today ? C.kg16 : C.line}`,
            }}>
            {name}
          </button>
        ))}
      </div>

      <div className="rounded-2xl p-4 mb-4" style={{ background: C.surface, border: `1px solid ${C.line}` }}>
        <div className="font-bold mb-1">{DOW[d]}{d === today ? " · сегодня" : ""}</div>
        <div className="text-xs mb-3" style={{ color: C.muted }}>Упражнения — из плана на этот день ({WEEKS[week].label}). Пустые строки не сохраняются.</div>

        <div className="flex gap-2 mb-3">
          <div className="flex-1">
            <div className="text-xs mb-1" style={{ color: C.muted }}>Дата</div>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm" style={{ ...inp, background: C.bg, colorScheme: "dark" }} />
          </div>
          <div className="flex-1">
            <div className="text-xs mb-1" style={{ color: C.muted }}>Длительность, мин</div>
            <input inputMode="numeric" placeholder="Например: 45" value={dur}
              onChange={(e) => setDur(e.target.value.replace(/\D/g, ""))}
              className="w-full rounded-lg px-3 py-2 text-sm" style={{ ...inp, background: C.bg }} />
          </div>
        </div>

        <div className="rounded-xl p-3 mb-3" style={{ background: C.bg, border: `1px solid ${C.line}` }}>
          <div className="text-sm font-semibold mb-2">До тренировки</div>
          <MiniRate label="Самочувствие" value={pre.well} onChange={(v) => setPre((p) => ({ ...p, well: v }))} />
          <MiniRate label="Сон" value={pre.sleep} onChange={(v) => setPre((p) => ({ ...p, sleep: v }))} />
          <MiniRate label="Энергия" value={pre.energy} onChange={(v) => setPre((p) => ({ ...p, energy: v }))} />
        </div>

        {plan.length === 0 && (
          <div className="text-sm mb-3" style={{ color: C.muted }}>
            На этот день упражнений по плану нет — восстановление. Можно оставить заметку и вечернюю оценку.
          </div>
        )}

        {plan.map((ex, i) => (
          <div key={`${week}-${d}-${i}`} className="rounded-xl p-3 mb-2" style={{ background: C.surface2, border: `1px solid ${C.line}` }}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold">{ex.n}</div>
              {ex.kg && <KgBadge kg={ex.kg} />}
            </div>
            {ex.uni ? (
              <div className="flex gap-2">
                <input inputMode="numeric" placeholder="Правая" value={rows[i]?.r || ""}
                  onChange={(e) => setRow(i, "r", e.target.value.replace(/\D/g, ""))}
                  className="flex-1 rounded-lg px-3 py-2 text-sm" style={{ ...inp, background: C.bg }} />
                <input inputMode="numeric" placeholder="Левая" value={rows[i]?.l || ""}
                  onChange={(e) => setRow(i, "l", e.target.value.replace(/\D/g, ""))}
                  className="flex-1 rounded-lg px-3 py-2 text-sm" style={{ ...inp, background: C.bg }} />
              </div>
            ) : (
              <input placeholder="Например: 4×6, 80 кг" value={rows[i]?.val || ""}
                onChange={(e) => setRow(i, "val", e.target.value)}
                className="w-full rounded-lg px-3 py-2 text-sm" style={{ ...inp, background: C.bg }} />
            )}
          </div>
        ))}

        <div className="mb-2 mt-3 text-sm" style={{ color: C.muted }}>Ощущение от тренировки</div>
        <div className="flex gap-2 mb-3">
          {[1, 2, 3, 4, 5].map((v) => (
            <button key={v} onClick={() => setFeel(feel === v ? 0 : v)}
              className="flex-1 py-3 rounded-xl font-extrabold"
              style={{
                background: feel === v ? (v <= 2 ? C.stop : v === 3 ? C.surface : C.ok) : C.surface2,
                color: feel === v ? C.text : C.muted,
                border: `1px solid ${feel === v ? (v <= 2 ? C.stop : v === 3 ? C.line : C.ok) : C.line}`,
              }}>
              {v}
            </button>
          ))}
        </div>
        <div className="text-xs mb-3" style={{ color: C.muted }}>1 — плохо · 5 — отлично</div>
        <input placeholder="Заметка: хват, асимметрия, ощущения…" value={note}
          onChange={(e) => setNote(e.target.value)}
          className="w-full rounded-xl px-3 py-3 text-sm mb-3" style={inp} />
        <button onClick={add} disabled={!filled}
          className="w-full py-4 rounded-2xl font-extrabold"
          style={{ background: C.kg20, color: C.text, opacity: filled ? 1 : 0.4 }}>
          Сохранить сессию
        </button>
        {feel > 0 && feel <= 2 && (
          <div className="text-xs mt-2" style={{ color: C.stop }}>
            Если было ноющее ощущение в шее или под лопаткой — следующая гиревая сессия на 16 кг.
          </div>
        )}
      </div>

      {loaded && log.length > 0 && (
        <div className="flex items-center gap-2 mb-3">
          <div className="flex-1 text-xs" style={{ color: C.muted }}>
            История: {log.length} {log.length === 1 ? "запись" : log.length < 5 ? "записи" : "записей"}
          </div>
          <button onClick={() => downloadFile(`kb-journal-${new Date().toISOString().slice(0, 10)}.csv`, logToCsv(log), "text/csv;charset=utf-8")}
            className="px-3 py-2 rounded-lg text-xs font-bold"
            style={{ background: C.surface2, color: C.text, border: `1px solid ${C.line}` }}>
            CSV
          </button>
          <button onClick={() => downloadFile(`kb-journal-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(log, null, 1))}
            className="px-3 py-2 rounded-lg text-xs font-bold"
            style={{ background: C.surface2, color: C.text, border: `1px solid ${C.line}` }}>
            JSON
          </button>
        </div>
      )}

      {!loaded && <div className="text-sm" style={{ color: C.muted }}>Загружаю журнал…</div>}
      {loaded && log.length === 0 && (
        <div className="text-sm text-center py-8" style={{ color: C.muted }}>
          Пока пусто. Первая сессия появится здесь — с балансом право/лево по каждому упражнению.
        </div>
      )}

      {log.map((e) => (
        <div key={e.id} className="rounded-2xl p-4 mb-3" style={{ background: C.surface, border: `1px solid ${C.line}` }}>
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-bold" style={{ fontVariantNumeric: "tabular-nums" }}>
              {e.date}{e.dow !== undefined ? ` · ${DOW[e.dow]}` : ""}{e.week ? ` · нед. ${e.week}` : ""}
            </div>
            <div className="flex items-center gap-2">
              {e.feel ? (
                <span className="text-xs font-bold px-2 py-1 rounded-full"
                  style={{ background: e.feel <= 2 ? C.stop : e.feel >= 4 ? C.ok : C.surface2, color: C.text }}>
                  {e.feel}/5
                </span>
              ) : e.pain !== undefined ? (
                <span className="text-xs font-bold px-2 py-1 rounded-full"
                  style={{ background: e.pain >= 3 ? C.stop : C.surface2, color: C.text }}>
                  {e.pain}/10
                </span>
              ) : null}
              <button onClick={() => remove(e.id)} className="text-xs px-2 py-1 rounded-lg" style={{ color: C.muted, border: `1px solid ${C.line}` }}>×</button>
            </div>
          </div>

          {(e.dur || e.pre) && (
            <div className="text-xs mb-2" style={{ color: C.muted }}>
              {e.dur ? `${e.dur} мин` : ""}
              {e.dur && e.pre ? " · " : ""}
              {e.pre ? [
                e.pre.well ? `самочувствие ${e.pre.well}` : null,
                e.pre.sleep ? `сон ${e.pre.sleep}` : null,
                e.pre.energy ? `энергия ${e.pre.energy}` : null,
              ].filter(Boolean).join(" · ") : ""}
            </div>
          )}

          {/* New format: per exercise */}
          {e.exercises && e.exercises.map((ex, i) => {
            const r = Number(ex.r) || 0, l = Number(ex.l) || 0;
            const max = Math.max(r, l, 1);
            return (
              <div key={i} className="mb-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm">{ex.n}{ex.kg ? ` · ${ex.kg} кг` : ""}</div>
                  <div className="text-sm font-bold" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {ex.uni ? `П ${r} · Л ${l}` : ex.val}
                  </div>
                </div>
                {ex.uni && (r > 0 || l > 0) && (
                  <div className="flex gap-1 mt-1">
                    <div className="flex-1 h-1 rounded-full" style={{ background: C.surface2 }}>
                      <div className="h-1 rounded-full" style={{ width: `${(r / max) * 100}%`, background: C.kg16 }} />
                    </div>
                    <div className="flex-1 h-1 rounded-full" style={{ background: C.surface2 }}>
                      <div className="h-1 rounded-full" style={{ width: `${(l / max) * 100}%`, background: C.kg20 }} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Legacy single-entry format */}
          {!e.exercises && (
            <div className="text-sm" style={{ fontVariantNumeric: "tabular-nums" }}>
              {e.kg ? `${e.kg} кг · ` : ""}П {e.repsR} · Л {e.repsL}
            </div>
          )}

          {e.note && <div className="text-sm mt-2" style={{ color: C.muted }}>{e.note}</div>}
        </div>
      ))}
    </div>
  );
}

// ═══ Plan tab: monthly overview + program import via LLM ═══
// Prompt for the Messages API (https://docs.claude.com/en/api/messages).
// The schema in the prompt must stay in sync with the exercise spec (see file header):
// if you change the t/s/c format or week fields, update the prompt too — otherwise the
// import starts generating incompatible data. The model reply is parsed as JSON after
// stripping markdown fences. The prompt itself is in Russian on purpose: it instructs
// the model to produce Russian-language plan content for a Russian-language UI.
const PLAN_PROMPT = `Ты — генератор данных для приложения гиревых тренировок. Прочитай документ тренировочного плана и верни ТОЛЬКО валидный JSON без пояснений и без markdown-ограждений, строго такой структуры:
{"weeks":{"<id>":{"label":"строка","mon":{"method":"m3","kg":16,"note":"строка"},"fri":{"kg":16,"note":"строка"},"ladder":[10,16]}},"ex":{"<id>":{"mon":[УПР,...],"fri":[УПР,...]}}}
Правила:
- id недель: "1".."4" для переходного месяца, "A".."D" для поддерживающего цикла; включай только недели, описанные в документе.
- method понедельника: m3 — интервалы одной рукой с коротким отдыхом; m2 — смена рук без отдыха внутри подхода; m4 — длинные подходы с полным отдыхом; m1 — проходка с одной сменой рук.
- УПР: {"n":"название","kg":число или null,"uni":true если однорукое,"planned":"краткое описание плана","pr":"плановые повторения за подход"} плюс РОВНО ОДНО из:
  "t":{"m":"m3|m2|m4|m1|fri","work":секунды,"rest":секунды,"sets":число} — таймированное гиревое (рывок, толчок, длинный цикл, фермерская); m="fri" — простые пары правая/левая с отдыхом;
  "s":{"sets":число,"rest":секунды} — подходы на повторения без таймера (жимы, приседания, зал, турецкий подъём);
  "c":true плюс "s":{"sets":1} — кардио (плавание).
- Если документ упоминает постоянный пятничный блок (bottoms-up 16 кг, турецкий подъём, фермерская прогулка) — включи его в fri каждой недели.
- ladder: веса разминочной лестницы недели из документа (например [10,16] или [10,16,20]).
- Субботний зал: необязательный ключ верхнего уровня "gym":[УПР,...] (упражнения зала, kg обычно null, у односторонних uni:true).
- ЧАСТИЧНЫЕ ПРАВКИ: тебе передают текущий план и запрос. Верни ТОЛЬКО изменяемое: только затронутые недели в weeks/ex (внутри недели — только изменяемые дни mon/fri), и gym только если правится зал. Не повторяй неизменённые данные. Например, запрос «замени жим лёжа на жим гантелей» → верни только {"gym":[...полный новый список зала...]}.
- Все тексты по-русски, кратко. Никакого текста вне JSON.`;

function PlanView({ onChanged }) {
  const [md, setMd] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [custom, setCustom] = useState(false);
  // The API key is optional (the primary path is the keyless "Prompt" button).
  // It lives in localStorage: acceptable for personal use only — see DEVELOPMENT.md §7.
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("kbapp:anthropic-key") || "");
  const saveKey = (k) => {
    setApiKey(k);
    localStorage.setItem("kbapp:anthropic-key", k);
  };

  useEffect(() => {
    (async () => {
      try {
        const p = await window.storage.get("kb-custom-plan");
        setCustom(!!p?.value);
      } catch (e) { /* no custom plan */ }
    })();
  }, []);

  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setMd(String(r.result || ""));
    r.readAsText(f);
  };

  const applyAndStore = async (patch) => {
    applyPlanData(patch);
    await window.storage.set("kb-custom-plan", JSON.stringify(snapshotPlan()));
    setCustom(true);
    onChanged();
  };

  const generate = async () => {
    if (!md.trim() || busy) return;
    // If the field already contains valid JSON — apply directly, no LLM round-trip
    try {
      const direct = JSON.parse(md);
      if (direct && (direct.weeks || direct.ex || direct.gym)) {
        await applyAndStore(direct);
        setMsg("JSON применён напрямую ✓");
        return;
      }
    } catch (e) { /* not JSON — go through the LLM */ }

    if (!apiKey.trim()) {
      setMsg("Без ключа API используй кнопку «Промпт»: отправь промпт Claude вручную и вставь сюда JSON из ответа. Либо введи ключ в поле выше.");
      return;
    }
    setBusy(true);
    setMsg("Разбираю документ и генерирую изменения…");
    try {
      const current = JSON.stringify(snapshotPlan());
      // Direct browser call to the Messages API: https://docs.claude.com/en/api/client-sdks#browser-usage
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey.trim(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: PLAN_PROMPT + "\n\nТекущий план приложения (JSON):\n" + current +
              "\n\nДокумент или запрос на изменение:\n" + md,
          }],
        }),
      });
      const data = await response.json();
      const text = (data.content || []).filter((i) => i.type === "text").map((i) => i.text).join("\n");
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (!parsed.weeks && !parsed.ex && !parsed.gym) throw new Error("empty");
      await applyAndStore(parsed);
      const parts = [];
      if (parsed.weeks) parts.push(`недели: ${Object.keys(parsed.weeks).join(", ")}`);
      if (parsed.ex && !parsed.weeks) parts.push(`дни недель: ${Object.keys(parsed.ex).join(", ")}`);
      if (parsed.gym) parts.push("зал");
      setMsg(`Применено ✓ ${parts.join(" · ")}`);
    } catch (e) {
      setMsg("Не получилось разобрать изменения. Уточни запрос (какая неделя/день) или сократи документ — и запусти ещё раз.");
    }
    setBusy(false);
  };

  const buildPrompt = () =>
    PLAN_PROMPT +
    "\n\nТекущий план приложения (JSON):\n" + JSON.stringify(snapshotPlan()) +
    "\n\nДокумент или запрос на изменение:\n" + md;

  const exportPrompt = () => {
    if (!md.trim()) {
      setMsg("Сначала вставь документ или запрос на изменение — он войдёт в промпт.");
      return;
    }
    const p = buildPrompt();
    console.log(p);
    try { navigator.clipboard?.writeText(p); } catch (e) { /* clipboard unavailable */ }
    const ok = downloadFile(`kb-plan-prompt-${new Date().toISOString().slice(0, 10)}.txt`, p, "text/plain;charset=utf-8");
    setMsg((ok ? "Промпт скачан файлом, скопирован в буфер и выведен в консоль. " : "Промпт скопирован в буфер и выведен в консоль. ") +
      "Отправь его Claude (чат или консоль Anthropic), полученный JSON вставь сюда и нажми «Сгенерировать» — применится без API-ключа.");
  };

  const exportPlan = () => {
    const json = JSON.stringify(snapshotPlan(), null, 1);
    const ok = downloadFile(`kb-plan-${new Date().toISOString().slice(0, 10)}.json`, json);
    setMd(json);
    setMsg(ok
      ? "План скачан файлом и выгружен в поле. Правь JSON (файл или поле) и применяй через «Сгенерировать» / «Файл…»."
      : "Скачать не удалось, но план выгружен в поле — скопируй его отсюда.");
  };

  const reset = async () => {
    resetPlanData();
    try { await window.storage.delete("kb-custom-plan"); } catch (e) { /* already empty */ }
    setCustom(false);
    setMsg("Встроенный план восстановлен");
    onChanged();
  };

  return (
    <div>
      {/* ── Import ── */}
      <div className="rounded-2xl p-4 mb-4" style={{ background: C.surface, border: `1px solid ${C.kg20}` }}>
        <div className="font-bold mb-1">Импорт плана из документа</div>
        <div className="text-xs mb-3" style={{ color: C.muted }}>
          Способы: (1) вставь программу или запрос на правку («замени жим лёжа на жим гантелей») и нажми «Сгенерировать» — Claude применит только изменяемое; (2) «Промпт» соберёт готовый промпт с текущим планом — отправь его Claude вручную и вставь сюда JSON из ответа, ключ не нужен; (3) готовый JSON применяется напрямую; (4) «Экспорт» выгрузит план для ручной правки.
        </div>
        <input type="password" placeholder="Ключ Anthropic API (необязательно — есть путь через «Промпт»)"
          value={apiKey} onChange={(e) => saveKey(e.target.value)}
          className="w-full rounded-xl px-3 py-2 text-sm mb-2"
          style={{ background: C.bg, color: C.text, border: `1px solid ${C.line}` }} />
        <textarea value={md} onChange={(e) => setMd(e.target.value)} rows={6}
          placeholder="## Неделя 1 — всё на 16 кг&#10;Пн: рывок, метод 3: 5×1 мин на руку, отдых 30 сек…&#10;Пт: толчок одной 16 кг 4×1,5 мин…"
          className="w-full rounded-xl px-3 py-3 text-sm mb-2"
          style={{ background: C.bg, color: C.text, border: `1px solid ${C.line}`, resize: "vertical" }} />
        <div className="flex gap-2 mb-2">
          <label className="flex-1 py-3 rounded-xl text-sm font-bold cursor-pointer text-center"
            style={{ background: C.surface2, color: C.text, border: `1px solid ${C.line}` }}>
            Файл…
            <input type="file" accept=".md,.txt,.markdown,.json" onChange={onFile} className="hidden" />
          </label>
          <button onClick={exportPrompt} disabled={busy}
            className="flex-1 py-3 rounded-xl text-sm font-bold"
            style={{ background: C.surface2, color: C.text, border: `1px solid ${C.line}`, opacity: busy ? 0.5 : 1 }}>
            Промпт
          </button>
          <button onClick={exportPlan} disabled={busy}
            className="flex-1 py-3 rounded-xl text-sm font-bold"
            style={{ background: C.surface2, color: C.text, border: `1px solid ${C.line}`, opacity: busy ? 0.5 : 1 }}>
            Экспорт
          </button>
        </div>
        <button onClick={generate} disabled={busy || !md.trim()}
          className="w-full py-3 rounded-xl font-extrabold mb-2"
          style={{ background: C.kg20, color: C.text, opacity: busy || !md.trim() ? 0.5 : 1 }}>
          {busy ? "Генерирую…" : "Сгенерировать"}
        </button>
        {custom && (
          <button onClick={reset} className="w-full py-2 rounded-xl text-sm font-bold"
            style={{ background: "transparent", color: C.stop, border: `1px solid ${C.line}` }}>
            Сбросить к встроенному плану
          </button>
        )}
        {msg && <div className="text-xs mt-2" style={{ color: msg.includes("✓") ? C.ok : C.muted }}>{msg}</div>}
      </div>

      {/* ── Monthly overview ── */}
      <div className="text-sm font-bold mb-2" style={{ color: C.kg16 }}>
        Обзор плана{custom ? " · свой план" : " · встроенный"}
      </div>
      {Object.entries(WEEKS).map(([k, wk]) => (
        <div key={k} className="rounded-2xl p-4 mb-3" style={{ background: C.surface, border: `1px solid ${C.line}` }}>
          <div className="flex items-center justify-between mb-2">
            <div className="font-bold text-sm">{wk.label}</div>
            <div className="flex gap-1">
              {(wk.ladder || []).map((kg) => <KgBadge key={kg} kg={kg} />)}
            </div>
          </div>
          {wk.mon && (
            <div className="text-xs mb-2 leading-relaxed" style={{ color: C.muted }}>
              <b style={{ color: C.text }}>Пн · рывок:</b> {wk.mon.note}
            </div>
          )}
          {wk.fri && (
            <div className="text-xs leading-relaxed" style={{ color: C.muted }}>
              <b style={{ color: C.text }}>Пт · толчковая:</b> {wk.fri.note}
            </div>
          )}
        </div>
      ))}
      <div className="rounded-2xl p-4" style={{ background: C.surface2, border: `1px solid ${C.line}` }}>
        <div className="font-bold text-sm mb-1">Каждую неделю</div>
        <div className="text-xs leading-relaxed mb-2" style={{ color: C.muted }}>
          Ср — бассейн (кроль). Вт/Чт — массаж и восстановление. Вс — отдых.
        </div>
        <div className="text-xs font-bold mb-1" style={{ color: C.text }}>Сб · зал:</div>
        {GYM_EX.map((g, i) => (
          <div key={i} className="text-xs leading-relaxed" style={{ color: C.muted }}>
            — {g.n}{g.planned ? ` · ${g.planned}` : ""}
          </div>
        ))}
      </div>
    </div>
  );
}
