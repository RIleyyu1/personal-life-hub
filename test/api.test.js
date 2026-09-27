import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { createApi, localToday } from '../server/api.js';
import { addDays } from '../server/nutrition.js';

delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

// 1x1 像素 JPEG
const TINY_JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'life-'));
  const db = openDb(dir);
  const api = createApi({ db, dataDir: dir });
  return { api, db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const PROFILE = { sex: 'male', birth_date: '1998-06-01', height_cm: 178, activity_level: 'light' };
const userItem = (kcal, protein = 0) => ({ name: '测试餐', grams: 100, kcal, protein, carbs: 0, fat: 0, source: 'user' });

test('完整流程：档案 → 体重 → 拍照记餐（演示识别）→ 训练 → 仪表盘', async () => {
  const { api, cleanup } = setup();
  try {
    const today = localToday();
    assert.equal(api.dashboard(today).model.ready, false);

    api.updateProfile({ sex: 'male', birth_date: '1998-06-01', height_cm: 178, activity_level: 'light', goal: 'cut' });
    api.saveWeight({ date: today, kg: 75 });

    const { photo, analysis } = await api.analyzeMeal({ image: TINY_JPEG });
    assert.ok(analysis.demo);
    assert.match(photo, /\.jpg$/);

    const condiments = api.listCondiments();
    const oil = condiments.find((c) => c.name === '食用油');
    const items = analysis.items.map((i) => ({ ...i, source: 'ai', ai_name: i.name }));
    // 用户把"青椒肉丝"改名并改了重量
    items[1] = { ...items[1], name: '青椒炒肉', grams: 90, kcal: 155, protein: 9, carbs: 4, fat: 11.5, edited: true };
    const meal = api.saveMeal({ date: today, meal_type: 'lunch', photo, analysis, items, condiments: [{ id: oil.id, quantity: 1 }] });
    assert.equal(meal.items.length, 4);
    assert.equal(meal.totals.kcal, 232 + 155 + 95 + 90);

    const memory = api.foodMemory();
    assert.equal(memory.length, 1);
    assert.equal(memory[0].name, '青椒炒肉');
    assert.deepEqual(memory[0].aliases, ['青椒肉丝']);
    assert.ok(Math.abs(memory[0].kcal_100g - 172.2) < 0.1);
    assert.equal(api.listCondiments()[0].name, '食用油');

    const squat = api.listExercises().find((e) => e.name === '杠铃深蹲');
    const run = api.listExercises().find((e) => e.kind === 'cardio');
    const w = api.saveWorkout({
      date: today,
      entries: [
        { exercise_id: squat.id, sets: [{ reps: 5, weight_kg: 100 }, { reps: 5, weight_kg: 100 }, { reps: 5, weight_kg: 100 }] },
        { exercise_id: run.id, duration_min: 20 },
      ],
    });
    // 深蹲 3 组 × 2.5 分钟，净 MET 5；跑步 20 分钟
    const expected = 5 * 75 * (7.5 / 60) + (run.met - 1) * 75 * (20 / 60);
    assert.ok(Math.abs(w.kcal - expected) < 1);
    assert.equal(api.personalRecords()[0].max_weight, 100);

    const d = api.dashboard(today);
    assert.equal(d.model.ready, true);
    assert.equal(d.intake.kcal, 572);
    assert.equal(d.budget, Math.round(d.model.targets.kcal + d.workoutKcal * 0.5));
    assert.ok(d.model.targets.kcal < d.model.tdee, '减脂目标应低于 TDEE');
    assert.ok(d.tips.some((t) => t.text.includes('蛋白质')));
  } finally {
    cleanup();
  }
});

test('切换目标会记入历史', () => {
  const { api, cleanup } = setup();
  try {
    const base = { sex: 'female', birth_date: '1995-01-01', height_cm: 165, activity_level: 'sedentary' };
    api.updateProfile({ ...base, goal: 'cut' });
    api.updateProfile({ ...base, goal: 'cut' });
    api.updateProfile({ ...base, goal: 'bulk' });
    assert.deepEqual(api.getProfile().goalHistory.map((g) => g.goal), ['bulk', 'cut']);
  } finally {
    cleanup();
  }
});

test('非法输入返回 400', () => {
  const { api, cleanup } = setup();
  try {
    assert.throws(() => api.saveWeight({ date: 'bad', kg: 70 }), { status: 400 });
    assert.throws(() => api.saveWeight({ date: localToday(), kg: 5 }), { status: 400 });
    assert.throws(() => api.saveMeal({ date: localToday(), items: [] }), { status: 400 });
    assert.throws(() => api.saveWorkout({ date: localToday(), entries: [] }), { status: 400 });
  } finally {
    cleanup();
  }
});

test('电脑端总览：每日序列与汇总', () => {
  const { api, cleanup } = setup();
  try {
    const today = localToday();
    const d = (n) => addDays(today, n);
    api.updateProfile({ ...PROFILE, goal: 'maintain' });
    api.saveWeight({ date: d(-6), kg: 80 });
    api.saveWeight({ date: d(-3), kg: 79.5 });
    api.saveWeight({ date: today, kg: 79 });

    // 预算不依赖当天摄入，先取出来再造数据：一天正好吃到预算，一天只吃一半
    const dayA = api.dashboard(d(-2));
    const dayBTarget = api.dashboard(d(-1)).model.targets;
    api.saveMeal({ date: d(-2), meal_type: 'lunch', items: [userItem(dayA.budget, dayA.model.targets.protein)] });
    api.saveMeal({ date: d(-1), meal_type: 'lunch', items: [userItem(Math.round(dayBTarget.kcal / 2), 10)] });

    const squat = api.listExercises().find((e) => e.name === '杠铃深蹲');
    const walk = api.listExercises().find((e) => e.name === '快走');
    api.saveWorkout({ date: d(-1), entries: [{ exercise_id: squat.id, sets: [{ reps: 5, weight_kg: 100 }, { reps: 5, weight_kg: 100 }] }, { exercise_id: walk.id, duration_min: 30 }] });

    const o = api.overview(7);
    assert.equal(o.days.length, 7);
    assert.equal(o.from, d(-6));
    assert.equal(o.to, today);
    assert.equal(o.summary.loggedDays, 2);
    assert.equal(o.summary.judgedDays, 2);
    assert.equal(o.summary.onTargetDays, 1);
    assert.equal(o.summary.proteinOkDays, 1);
    assert.equal(o.summary.workouts, 1);
    assert.equal(o.summary.cardioMinutes, 30);
    // 当天有训练时，预算 = 目标 + 训练消耗 × 计入比例
    const dayB = o.days.find((x) => x.date === d(-1));
    assert.equal(dayB.budget, Math.round(dayB.target.kcal + dayB.workoutKcal * 0.5));
    assert.deepEqual(o.muscles.slice(0, 3), [{ muscle: '胸', sets: 0 }, { muscle: '背', sets: 0 }, { muscle: '腿', sets: 2 }]);
    // 7 天平均：第一次称重 80；最后一天 (80 + 79.5 + 79) / 3
    assert.equal(o.summary.weightStart, 80);
    assert.equal(o.summary.weightEnd, 79.5);
    assert.equal(o.summary.weightChange, -0.5);
    assert.equal(o.days.filter((x) => x.weight != null).length, 3);
  } finally {
    cleanup();
  }
});

test('过去日期按当时生效的目标计算', () => {
  const { api, db, cleanup } = setup();
  try {
    const today = localToday();
    api.updateProfile({ ...PROFILE, goal: 'bulk' });
    api.saveWeight({ date: addDays(today, -20), kg: 75 });
    db.exec('DELETE FROM goal_history');
    db.prepare('INSERT INTO goal_history (goal, goal_rate, start_date) VALUES (?, ?, ?)').run('cut', null, addDays(today, -15));
    db.prepare('INSERT INTO goal_history (goal, goal_rate, start_date) VALUES (?, ?, ?)').run('bulk', null, addDays(today, -2));

    assert.equal(api.dashboard(addDays(today, -5)).model.goal, 'cut');
    assert.ok(api.dashboard(addDays(today, -5)).model.targets.deltaKcal < 0);
    assert.equal(api.dashboard(today).model.goal, 'bulk');
    assert.ok(api.dashboard(today).model.targets.deltaKcal > 0);
    // 比第一次设定目标还早的日子沿用最早的目标
    assert.equal(api.dashboard(addDays(today, -18)).model.goal, 'cut');
  } finally {
    cleanup();
  }
});

test('重量单位设置', async () => {
  const { api, cleanup } = setup();
  try {
    assert.equal((await api.status()).weightUnit, 'kg');
    api.updateSettings({ weight_unit: 'lb' });
    assert.equal((await api.status()).weightUnit, 'lb');
    // 改单位不影响已保存的档案，也不会把未填写的档案标成已填写
    assert.equal(api.getProfile().configured, false);
    assert.throws(() => api.updateSettings({ weight_unit: 'stone' }), { status: 400 });
  } finally {
    cleanup();
  }
});

test('旧数据库自动补上重量单位列，原有数据保留', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'life-old-'));
  try {
    const old = new DatabaseSync(path.join(dir, 'life.db'));
    old.exec(`CREATE TABLE profile (
      id INTEGER PRIMARY KEY CHECK (id = 1), sex TEXT NOT NULL DEFAULT 'male', birth_date TEXT NOT NULL DEFAULT '2000-01-01',
      height_cm REAL NOT NULL DEFAULT 175, body_fat_pct REAL, activity_level TEXT NOT NULL DEFAULT 'sedentary',
      goal TEXT NOT NULL DEFAULT 'maintain', goal_rate REAL, eat_back_ratio REAL NOT NULL DEFAULT 0.5, updated_at TEXT)`);
    old.exec("INSERT INTO profile (id, height_cm, updated_at) VALUES (1, 181, '2026-09-01T00:00:00Z')");
    old.close();

    const api = createApi({ db: openDb(dir), dataDir: dir });
    const p = api.getProfile();
    assert.equal(p.weight_unit, 'kg');
    assert.equal(p.height_cm, 181);
    assert.equal(p.configured, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
