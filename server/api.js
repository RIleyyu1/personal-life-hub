import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { tx } from './db.js';
import { analyzeMealPhoto, aiStatus } from './ai.js';
import { buildTips } from './advice.js';
import {
  ACTIVITY_LEVELS,
  GOALS,
  MINUTES_PER_SET,
  addDays,
  adaptiveTdee,
  blendTdee,
  dailyTargets,
  exerciseKcal,
  formulaTdee,
  movingAverage,
  round,
} from './nutrition.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];

export function localToday() {
  return new Date().toLocaleDateString('sv');
}

function requireDate(d) {
  if (!DATE_RE.test(d || '')) throw new HttpError(400, '日期格式应为 YYYY-MM-DD');
  return d;
}

function num(v, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if ((v === null || v === undefined || v === '') && optional) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} 不合法`);
  return n;
}

export function createApi({ db, dataDir }) {
  const photoDir = path.join(dataDir, 'photos');
  mkdirSync(photoDir, { recursive: true });

  // ---------- 档案 ----------
  function getProfile() {
    let p = db.prepare('SELECT * FROM profile WHERE id = 1').get();
    if (!p) {
      db.prepare('INSERT INTO profile (id) VALUES (1)').run();
      p = db.prepare('SELECT * FROM profile WHERE id = 1').get();
    }
    return { ...p, configured: Boolean(p.updated_at) };
  }

  function updateProfile(body) {
    const prev = getProfile();
    const next = {
      sex: body.sex === 'female' ? 'female' : 'male',
      birth_date: requireDate(body.birth_date),
      height_cm: num(body.height_cm, '身高', { min: 100, max: 250 }),
      body_fat_pct: num(body.body_fat_pct, '体脂率', { min: 3, max: 60, optional: true }),
      activity_level: ACTIVITY_LEVELS[body.activity_level] ? body.activity_level : 'sedentary',
      goal: GOALS[body.goal] ? body.goal : 'maintain',
      goal_rate: num(body.goal_rate, '目标速度', { min: -0.01, max: 0.01, optional: true }),
      eat_back_ratio: num(body.eat_back_ratio ?? 0.5, '运动热量计入比例', { min: 0, max: 1 }),
    };
    tx(db, () => {
      db.prepare(
        `UPDATE profile SET sex=?, birth_date=?, height_cm=?, body_fat_pct=?, activity_level=?, goal=?, goal_rate=?, eat_back_ratio=?, updated_at=? WHERE id=1`,
      ).run(next.sex, next.birth_date, next.height_cm, next.body_fat_pct, next.activity_level, next.goal, next.goal_rate, next.eat_back_ratio, new Date().toISOString());
      if (!prev.configured || prev.goal !== next.goal || prev.goal_rate !== next.goal_rate) {
        db.prepare('INSERT INTO goal_history (goal, goal_rate, start_date) VALUES (?, ?, ?)').run(next.goal, next.goal_rate, localToday());
      }
    });
    return getProfile();
  }

  // ---------- 体重 ----------
  function weightsUntil(date, days) {
    return db
      .prepare('SELECT date, kg FROM weight_log WHERE date <= ? AND date >= ? ORDER BY date')
      .all(date, addDays(date, -(days - 1)));
  }

  function listWeights(days = 90) {
    const rows = weightsUntil(localToday(), days);
    return rows.length ? movingAverage(rows) : [];
  }

  function saveWeight(body) {
    const date = requireDate(body.date);
    const kg = num(body.kg, '体重', { min: 20, max: 300 });
    db.prepare('INSERT INTO weight_log (date, kg, note) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET kg=excluded.kg, note=excluded.note')
      .run(date, kg, body.note || null);
    return { date, kg };
  }

  function currentWeight(date) {
    // 用 7 天平均，避免单日水分波动影响目标
    const rows = weightsUntil(date, 7);
    if (rows.length) return round(rows.reduce((s, r) => s + r.kg, 0) / rows.length, 2);
    const last = db.prepare('SELECT kg FROM weight_log WHERE date <= ? ORDER BY date DESC LIMIT 1').get(date);
    return last?.kg ?? null;
  }

  // ---------- 记忆 ----------
  function foodMemory(limit = 40) {
    return db
      .prepare('SELECT * FROM food_memory ORDER BY use_count DESC, last_used DESC LIMIT ?')
      .all(limit)
      .map((f) => ({ ...f, aliases: JSON.parse(f.aliases) }));
  }

  function listCondiments() {
    return db.prepare('SELECT * FROM condiment ORDER BY use_count DESC, name').all();
  }

  function addCondiment(body) {
    const name = String(body.name || '').trim();
    if (!name) throw new HttpError(400, '请填写调料名');
    db.prepare(
      `INSERT INTO condiment (name, unit, kcal, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET unit=excluded.unit, kcal=excluded.kcal, protein=excluded.protein, carbs=excluded.carbs, fat=excluded.fat`,
    ).run(
      name,
      String(body.unit || '份'),
      num(body.kcal, '热量', { min: 0, max: 2000 }),
      num(body.protein ?? 0, '蛋白质', { min: 0, max: 200 }),
      num(body.carbs ?? 0, '碳水', { min: 0, max: 200 }),
      num(body.fat ?? 0, '脂肪', { min: 0, max: 200 }),
    );
    return db.prepare('SELECT * FROM condiment WHERE name = ?').get(name);
  }

  function rememberFood(item, now) {
    if (!item.grams || item.grams <= 0) return;
    const per = (v) => round((Number(v) || 0) * (100 / item.grams), 1);
    const existing = db.prepare('SELECT * FROM food_memory WHERE name = ?').get(item.name);
    const aliases = new Set(existing ? JSON.parse(existing.aliases) : []);
    if (item.ai_name && item.ai_name !== item.name) aliases.add(item.ai_name);
    if (existing) {
      const n = existing.use_count;
      db.prepare(
        `UPDATE food_memory SET aliases=?, kcal_100g=?, protein_100g=?, carbs_100g=?, fat_100g=?, typical_grams=?, use_count=use_count+1, last_used=? WHERE id=?`,
      ).run(
        JSON.stringify([...aliases]),
        per(item.kcal),
        per(item.protein),
        per(item.carbs),
        per(item.fat),
        round(((existing.typical_grams || item.grams) * n + item.grams) / (n + 1)),
        now,
        existing.id,
      );
    } else {
      db.prepare(
        `INSERT INTO food_memory (name, aliases, kcal_100g, protein_100g, carbs_100g, fat_100g, typical_grams, use_count, last_used) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      ).run(item.name, JSON.stringify([...aliases]), per(item.kcal), per(item.protein), per(item.carbs), per(item.fat), item.grams, now);
    }
  }

  // ---------- 餐 ----------
  async function analyzeMeal(body) {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(body.image || '');
    if (!match) throw new HttpError(400, '请上传 JPEG/PNG/WebP 图片');
    const [, mediaType, data] = match;
    const ext = mediaType.split('/')[1].replace('jpeg', 'jpg');
    const photo = `${randomUUID()}.${ext}`;
    writeFileSync(path.join(photoDir, photo), Buffer.from(data, 'base64'));
    const analysis = await analyzeMealPhoto({
      imageBase64: data,
      mediaType,
      note: body.note,
      memory: { foods: foodMemory() },
    });
    return { photo, analysis };
  }

  function saveMeal(body) {
    const date = requireDate(body.date);
    const mealType = MEAL_TYPES.includes(body.meal_type) ? body.meal_type : 'snack';
    const photo = /^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(body.photo || '') ? body.photo : null;
    const items = (body.items || []).map((i) => ({
      name: String(i.name || '').trim() || '未命名',
      grams: num(i.grams, '重量', { min: 0, max: 5000, optional: true }),
      kcal: num(i.kcal, '热量', { min: 0, max: 10000 }),
      protein: num(i.protein ?? 0, '蛋白质', { min: 0, max: 1000 }),
      carbs: num(i.carbs ?? 0, '碳水', { min: 0, max: 2000 }),
      fat: num(i.fat ?? 0, '脂肪', { min: 0, max: 1000 }),
      fiber: num(i.fiber ?? 0, '纤维', { min: 0, max: 500 }),
      source: i.source === 'user' ? 'user' : 'ai',
      ai_name: i.ai_name || null,
      edited: Boolean(i.edited),
    }));
    const condiments = (body.condiments || [])
      .map((c) => ({ id: Number(c.id), quantity: num(c.quantity, '调料数量', { min: 0, max: 50 }) }))
      .filter((c) => c.quantity > 0);
    if (!items.length && !condiments.length) throw new HttpError(400, '这餐还没有任何食物');

    const now = new Date().toISOString();
    const a = body.analysis || {};
    return tx(db, () => {
      const { lastInsertRowid: mealId } = db
        .prepare(
          `INSERT INTO meal (date, time, meal_type, photo, note, ai_raw, ai_confidence, kcal_low, kcal_high, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(date, body.time || null, mealType, photo, body.note || null, body.analysis ? JSON.stringify(body.analysis) : null, a.confidence || null, a.kcal_low ?? null, a.kcal_high ?? null, now);
      const ins = db.prepare(
        `INSERT INTO meal_item (meal_id, name, grams, quantity, unit, kcal, protein, carbs, fat, fiber, source, ai_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const i of items) {
        ins.run(mealId, i.name, i.grams, null, null, i.kcal, i.protein, i.carbs, i.fat, i.fiber, i.source, i.ai_name);
        // 只有用户确认过/改过的食物才进入长期记忆，AI 原样结果不算
        if (i.edited || i.source === 'user') rememberFood(i, now);
      }
      for (const c of condiments) {
        const row = db.prepare('SELECT * FROM condiment WHERE id = ?').get(c.id);
        if (!row) continue;
        ins.run(mealId, row.name, null, c.quantity, row.unit, row.kcal * c.quantity, row.protein * c.quantity, row.carbs * c.quantity, row.fat * c.quantity, 0, 'condiment', null);
        db.prepare('UPDATE condiment SET use_count = use_count + 1, last_used = ? WHERE id = ?').run(now, c.id);
      }
      return getMeal(Number(mealId));
    });
  }

  function getMeal(id) {
    const meal = db.prepare('SELECT * FROM meal WHERE id = ?').get(id);
    if (!meal) return null;
    const items = db.prepare('SELECT * FROM meal_item WHERE meal_id = ? ORDER BY id').all(id);
    return { ...meal, ai_raw: undefined, items, totals: sumItems(items) };
  }

  function listMeals(date) {
    requireDate(date);
    return db
      .prepare('SELECT id FROM meal WHERE date = ? ORDER BY COALESCE(time, created_at)')
      .all(date)
      .map((r) => getMeal(r.id));
  }

  function deleteMeal(id) {
    db.prepare('DELETE FROM meal WHERE id = ?').run(id);
    return { ok: true };
  }

  function intakeByDate(from, to) {
    const rows = db
      .prepare(
        `SELECT m.date, SUM(i.kcal) AS kcal FROM meal m JOIN meal_item i ON i.meal_id = m.id WHERE m.date BETWEEN ? AND ? GROUP BY m.date`,
      )
      .all(from, to);
    return Object.fromEntries(rows.map((r) => [r.date, r.kcal]));
  }

  // ---------- 训练 ----------
  function listExercises() {
    return db.prepare('SELECT * FROM exercise ORDER BY muscle, id').all();
  }

  function addExercise(body) {
    const name = String(body.name || '').trim();
    if (!name) throw new HttpError(400, '请填写动作名');
    const kind = body.kind === 'cardio' ? 'cardio' : 'strength';
    db.prepare('INSERT INTO exercise (name, muscle, kind, met, custom) VALUES (?, ?, ?, ?, 1)').run(
      name,
      String(body.muscle || (kind === 'cardio' ? '有氧' : '其他')),
      kind,
      num(body.met ?? (kind === 'cardio' ? 6 : 4), 'MET', { min: 1, max: 20 }),
    );
    return db.prepare('SELECT * FROM exercise WHERE name = ?').get(name);
  }

  function saveWorkout(body) {
    const date = requireDate(body.date);
    const weightKg = currentWeight(date);
    if (!weightKg) throw new HttpError(400, '请先记录一次体重，才能估算运动消耗');
    const entries = (body.entries || []).map((e, idx) => {
      const ex = db.prepare('SELECT * FROM exercise WHERE id = ?').get(Number(e.exercise_id));
      if (!ex) throw new HttpError(400, '动作不存在');
      const sets = (e.sets || [])
        .map((s) => ({
          reps: num(s.reps, '次数', { min: 0, max: 1000, optional: true }),
          weight_kg: num(s.weight_kg, '重量', { min: 0, max: 1000, optional: true }),
        }))
        .filter((s) => s.reps || s.weight_kg);
      let minutes = num(e.duration_min, '时长', { min: 0, max: 600, optional: true });
      if (!minutes && ex.kind === 'strength') minutes = sets.length * MINUTES_PER_SET;
      return { ex, idx, sets, minutes: minutes || 0, kcal: exerciseKcal(ex.met, weightKg, minutes || 0) };
    });
    if (!entries.length) throw new HttpError(400, '至少添加一个动作');
    const total = entries.reduce((s, e) => s + e.kcal, 0);
    const duration = num(body.duration_min, '总时长', { min: 0, max: 600, optional: true }) ?? entries.reduce((s, e) => s + e.minutes, 0);

    return tx(db, () => {
      const { lastInsertRowid: wid } = db
        .prepare('INSERT INTO workout (date, duration_min, rpe, note, kcal, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(date, duration, num(body.rpe, 'RPE', { min: 1, max: 10, optional: true }), body.note || null, round(total), new Date().toISOString());
      for (const e of entries) {
        const { lastInsertRowid: eid } = db
          .prepare('INSERT INTO workout_entry (workout_id, exercise_id, position, duration_min, kcal) VALUES (?, ?, ?, ?, ?)')
          .run(wid, e.ex.id, e.idx, e.minutes, round(e.kcal));
        e.sets.forEach((s, i) => {
          db.prepare('INSERT INTO workout_set (entry_id, set_no, reps, weight_kg) VALUES (?, ?, ?, ?)').run(eid, i + 1, s.reps, s.weight_kg);
        });
      }
      return getWorkout(Number(wid));
    });
  }

  function getWorkout(id) {
    const w = db.prepare('SELECT * FROM workout WHERE id = ?').get(id);
    if (!w) return null;
    const entries = db
      .prepare(
        `SELECT e.*, x.name, x.muscle, x.kind FROM workout_entry e JOIN exercise x ON x.id = e.exercise_id WHERE e.workout_id = ? ORDER BY e.position`,
      )
      .all(id)
      .map((e) => ({ ...e, sets: db.prepare('SELECT set_no, reps, weight_kg FROM workout_set WHERE entry_id = ? ORDER BY set_no').all(e.id) }));
    return { ...w, entries };
  }

  function listWorkouts({ date, days }) {
    const rows = date
      ? db.prepare('SELECT id FROM workout WHERE date = ? ORDER BY created_at').all(requireDate(date))
      : db.prepare('SELECT id FROM workout WHERE date >= ? ORDER BY date DESC, created_at DESC').all(addDays(localToday(), -((days || 30) - 1)));
    return rows.map((r) => getWorkout(r.id));
  }

  function deleteWorkout(id) {
    db.prepare('DELETE FROM workout WHERE id = ?').run(id);
    return { ok: true };
  }

  // 每个动作的历史最好成绩（估算 1RM，Epley 公式）
  function personalRecords() {
    return db
      .prepare(
        `SELECT x.name, MAX(s.weight_kg * (1 + s.reps / 30.0)) AS e1rm, MAX(s.weight_kg) AS max_weight
         FROM workout_set s JOIN workout_entry e ON e.id = s.entry_id JOIN exercise x ON x.id = e.exercise_id
         WHERE s.weight_kg > 0 AND s.reps > 0 GROUP BY x.id ORDER BY x.muscle, x.name`,
      )
      .all()
      .map((r) => ({ ...r, e1rm: round(r.e1rm, 1) }));
  }

  // ---------- 汇总 ----------
  function energyModel(date) {
    const profile = getProfile();
    const weightKg = currentWeight(date);
    if (!profile.configured || !weightKg) return { profile, weightKg, ready: false };
    const { bmr, tdee: formula } = formulaTdee(profile, weightKg, new Date(date + 'T12:00:00'));
    const weights = weightsUntil(date, 28);
    const adaptive = adaptiveTdee(weights, intakeByDate(addDays(date, -27), addDays(date, -1)));
    const blended = blendTdee(formula, adaptive);
    const targets = dailyTargets({ profile, weightKg, tdee: blended.tdee, bmrValue: bmr });
    return {
      ready: true,
      profile,
      weightKg,
      bmr: Math.round(bmr),
      formulaTdee: Math.round(formula),
      adaptive: adaptive && { ...adaptive, tdee: Math.round(adaptive.tdee), avgIntake: Math.round(adaptive.avgIntake), kgPerWeek: round(adaptive.kgPerWeek, 2) },
      tdee: Math.round(blended.tdee),
      tdeeSource: blended.source,
      adaptiveWeight: round(blended.weight, 2),
      targets,
    };
  }

  function dashboard(date) {
    requireDate(date);
    const model = energyModel(date);
    const meals = listMeals(date);
    const workouts = listWorkouts({ date });
    const intake = sumItems(meals.flatMap((m) => m.items));
    const workoutKcal = round(workouts.reduce((s, w) => s + w.kcal, 0));
    const weights = listWeights(60).filter((w) => w.date <= date);
    const base = { date, meals, workouts, intake, workoutKcal, weights, model };
    if (!model.ready) {
      return { ...base, tips: [{ level: 'action', text: model.profile.configured ? '记录一次体重后即可计算每日目标。' : '先在「我的」里填写个人参数，再记录一次体重。' }] };
    }

    const budget = Math.round(model.targets.kcal + workoutKcal * model.profile.eat_back_ratio);
    const recent = intakeByDate(addDays(date, -3), addDays(date, -1));
    const trendRows = weights.slice(-14);
    const trend =
      trendRows.length >= 7
        ? { pctPerWeek: ((trendRows.at(-1).avg - trendRows[0].avg) / trendRows[0].avg) * 100 * (7 / Math.max(1, trendRows.length - 1)) }
        : null;

    const trained = db
      .prepare(
        `SELECT DISTINCT x.muscle FROM workout w JOIN workout_entry e ON e.workout_id = w.id JOIN exercise x ON x.id = e.exercise_id WHERE w.date BETWEEN ? AND ?`,
      )
      .all(addDays(date, -6), date)
      .map((r) => r.muscle);
    const everTrained = db.prepare('SELECT COUNT(*) AS n FROM workout WHERE date BETWEEN ? AND ?').get(addDays(date, -13), date).n > 0;
    const muscleGap = everTrained ? ['胸', '背', '腿', '肩'].filter((m) => !trained.includes(m)) : [];

    const tips = buildTips({
      targets: model.targets,
      intake,
      budget,
      weightLoggedToday: weights.some((w) => w.date === date),
      adaptive: model.adaptive,
      trend,
      recentIntake: Object.values(recent),
      bmr: model.bmr,
      muscleGap,
      isToday: date === localToday(),
    });
    return { ...base, budget, remaining: budget - Math.round(intake.kcal), tips };
  }

  return {
    status: async () => ({ ai: await aiStatus(), today: localToday() }),
    getProfile: () => ({ ...getProfile(), energy: energyModel(localToday()), goals: GOALS, activityLevels: ACTIVITY_LEVELS, goalHistory: db.prepare('SELECT * FROM goal_history ORDER BY start_date DESC, id DESC').all() }),
    updateProfile,
    listWeights,
    saveWeight,
    deleteWeight: (date) => (db.prepare('DELETE FROM weight_log WHERE date = ?').run(requireDate(date)), { ok: true }),
    analyzeMeal,
    saveMeal,
    listMeals,
    deleteMeal,
    listCondiments,
    addCondiment,
    foodMemory,
    listExercises,
    addExercise,
    saveWorkout,
    listWorkouts,
    deleteWorkout,
    personalRecords,
    dashboard,
    photoDir,
  };
}

function sumItems(items) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  for (const i of items) for (const k of Object.keys(t)) t[k] += i[k] || 0;
  for (const k of Object.keys(t)) t[k] = round(t[k], 1);
  return t;
}
