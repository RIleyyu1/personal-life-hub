import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { createApi, localToday } from '../server/api.js';

delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

// 1x1 像素 JPEG
const TINY_JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'life-'));
  const api = createApi({ db: openDb(dir), dataDir: dir });
  return { api, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

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
