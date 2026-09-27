import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveTdee, addDays, bmr, blendTdee, dailyTargets, exerciseKcal, movingAverage } from '../server/nutrition.js';

test('Mifflin-St Jeor BMR', () => {
  assert.equal(bmr({ sex: 'male', weightKg: 70, heightCm: 175, age: 25 }), 700 + 1093.75 - 125 + 5);
  assert.equal(bmr({ sex: 'female', weightKg: 60, heightCm: 165, age: 30 }), 600 + 1031.25 - 150 - 161);
});

test('有体脂率时改用 Katch-McArdle', () => {
  assert.equal(bmr({ sex: 'male', weightKg: 80, heightCm: 180, age: 30, bodyFatPct: 20 }), 370 + 21.6 * 64);
});

test('7 天移动平均只看最近 7 个日历日', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ date: addDays('2026-01-01', i), kg: 70 + i }));
  const avg = movingAverage(rows);
  assert.equal(avg[0].avg, 70);
  assert.equal(avg[9].avg, (73 + 74 + 75 + 76 + 77 + 78 + 79) / 7);
});

test('体重反推 TDEE：每天吃 2000、每周掉 0.5kg ≈ 2550', () => {
  const start = '2026-01-01';
  const weights = [];
  const intake = {};
  for (let i = 0; i < 28; i++) {
    const d = addDays(start, i);
    weights.push({ date: d, kg: 80 - (0.5 / 7) * i });
    intake[d] = 2000;
  }
  const a = adaptiveTdee(weights, intake);
  assert.ok(Math.abs(a.tdee - (2000 + (0.5 / 7) * 7700)) < 1);
  assert.ok(Math.abs(a.kgPerWeek + 0.5) < 1e-6);
});

test('数据不足时不给出反推值，混合结果退回公式', () => {
  const weights = [{ date: '2026-01-01', kg: 70 }, { date: '2026-01-05', kg: 70 }];
  assert.equal(adaptiveTdee(weights, {}), null);
  assert.deepEqual(blendTdee(2400, null), { tdee: 2400, source: 'formula', weight: 0 });
});

test('减脂目标：赤字受 25% 上限和基础代谢下限保护', () => {
  const profile = { sex: 'female', goal: 'cut', goal_rate: -0.01 };
  // 每周 −1% = 每天 −660，被 25% 上限截到 −450 → 1350
  assert.equal(dailyTargets({ profile, weightKg: 60, tdee: 1800, bmrValue: 1300 }).kcal, 1350);
  // 基础代谢 1400 高于 1350，再被托到 1400
  const t = dailyTargets({ profile, weightKg: 60, tdee: 1800, bmrValue: 1400 });
  assert.equal(t.kcal, 1400);
  assert.ok(t.flooredBySafety);
  assert.equal(t.protein, 120);
});

test('宏量营养素加起来约等于目标热量', () => {
  const profile = { sex: 'male', goal: 'maintain' };
  const t = dailyTargets({ profile, weightKg: 75, tdee: 2600, bmrValue: 1700 });
  assert.ok(Math.abs(t.protein * 4 + t.carbs * 4 + t.fat * 9 - t.kcal) < 15);
});

test('运动消耗按净 MET 计算', () => {
  assert.equal(exerciseKcal(8, 70, 30), 7 * 70 * 0.5);
  assert.equal(exerciseKcal(1, 70, 30), 0);
});
