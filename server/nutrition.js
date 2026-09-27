// 能量与营养目标计算。纯函数，不依赖数据库，便于测试。

export const KCAL_PER_KG = 7700;

export const ACTIVITY_LEVELS = {
  sedentary: { factor: 1.2, label: '久坐（办公室，几乎不走动）' },
  light: { factor: 1.375, label: '轻度（日常步行较多）' },
  moderate: { factor: 1.55, label: '中度（经常站立/走动）' },
  high: { factor: 1.725, label: '高（体力工作）' },
};

// 每种目标：每周体重变化（占体重比例）、蛋白质系数 g/kg
export const GOALS = {
  cut: { label: '减脂', weeklyRate: -0.005, proteinPerKg: 2.0 },
  maintain: { label: '维持', weeklyRate: 0, proteinPerKg: 1.6 },
  bulk: { label: '增肌', weeklyRate: 0.0025, proteinPerKg: 1.8 },
  recomp: { label: '重组（减脂同时增肌）', weeklyRate: -0.002, proteinPerKg: 2.2 },
};

export function ageFrom(birthDate, onDate = new Date()) {
  const b = new Date(birthDate);
  let age = onDate.getFullYear() - b.getFullYear();
  const m = onDate.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && onDate.getDate() < b.getDate())) age--;
  return age;
}

// Mifflin-St Jeor；有体脂率时用 Katch-McArdle
export function bmr({ sex, weightKg, heightCm, age, bodyFatPct }) {
  if (bodyFatPct && bodyFatPct > 3 && bodyFatPct < 60) {
    const lean = weightKg * (1 - bodyFatPct / 100);
    return 370 + 21.6 * lean;
  }
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === 'female' ? base - 161 : base + 5;
}

export function formulaTdee(profile, weightKg, onDate) {
  const age = ageFrom(profile.birth_date, onDate);
  const b = bmr({
    sex: profile.sex,
    weightKg,
    heightCm: profile.height_cm,
    age,
    bodyFatPct: profile.body_fat_pct,
  });
  const factor = (ACTIVITY_LEVELS[profile.activity_level] || ACTIVITY_LEVELS.sedentary).factor;
  return { bmr: b, tdee: b * factor };
}

// 7 天移动平均，输入按日期升序的 [{date, kg}]
export function movingAverage(weights, window = 7) {
  return weights.map((w) => {
    const from = addDays(w.date, -(window - 1));
    const slice = weights.filter((x) => x.date >= from && x.date <= w.date);
    const avg = slice.reduce((s, x) => s + x.kg, 0) / slice.length;
    return { date: w.date, kg: w.kg, avg: round(avg, 2) };
  });
}

// 根据体重趋势 + 记录的摄入反推真实 TDEE。
// weights: 升序 [{date, kg}]；intakeByDate: {date: kcal}（只含有记录的日子）
export function adaptiveTdee(weights, intakeByDate, { windowDays = 28, minDays = 14 } = {}) {
  if (weights.length < 2) return null;
  const end = weights[weights.length - 1].date;
  const start = addDays(end, -(windowDays - 1));
  const w = weights.filter((x) => x.date >= start);
  const span = w.length ? daysBetween(end, w[0].date) : 0;
  const loggedDays = Object.entries(intakeByDate).filter(([d, kcal]) => d >= start && d <= end && kcal > 0);
  if (span < minDays - 1 || w.length < 7 || loggedDays.length < minDays * 0.7) return null;

  // 对体重做线性回归，斜率即 kg/天，比首尾相减更抗日常波动
  const xs = w.map((x) => daysBetween(x.date, w[0].date));
  const ys = w.map((x) => x.kg);
  const slope = linearSlope(xs, ys);
  const avgIntake = loggedDays.reduce((s, [, k]) => s + k, 0) / loggedDays.length;
  return {
    tdee: avgIntake - slope * KCAL_PER_KG,
    avgIntake,
    kgPerWeek: slope * 7,
    days: span + 1,
    loggedDays: loggedDays.length,
  };
}

// 公式值与自适应值按数据量混合：数据越多越相信自适应值
export function blendTdee(formula, adaptive, windowDays = 28) {
  if (!adaptive) return { tdee: formula, source: 'formula', weight: 0 };
  const weight = Math.min(1, adaptive.loggedDays / windowDays);
  return {
    tdee: formula * (1 - weight) + adaptive.tdee * weight,
    source: 'adaptive',
    weight,
  };
}

export function dailyTargets({ profile, weightKg, tdee, bmrValue }) {
  const goal = GOALS[profile.goal] || GOALS.maintain;
  const rate = profile.goal_rate ?? goal.weeklyRate;
  let delta = (weightKg * rate * KCAL_PER_KG) / 7;
  // 赤字不超过 TDEE 的 25%，盈余不超过 15%
  delta = Math.max(-0.25 * tdee, Math.min(0.15 * tdee, delta));
  const floor = Math.max(bmrValue, profile.sex === 'female' ? 1200 : 1500);
  const kcal = Math.max(floor, tdee + delta);

  const protein = weightKg * goal.proteinPerKg;
  const fat = Math.max(weightKg * 0.8, (kcal * 0.2) / 9);
  const carbs = Math.max(0, (kcal - protein * 4 - fat * 9) / 4);
  return {
    kcal: Math.round(kcal),
    protein: Math.round(protein),
    fat: Math.round(fat),
    carbs: Math.round(carbs),
    fiber: Math.round((kcal / 1000) * 14),
    waterMl: Math.round(weightKg * 35 / 50) * 50,
    deltaKcal: Math.round(kcal - tdee),
    flooredBySafety: kcal > tdee + delta,
  };
}

// 运动消耗：净消耗 = (MET - 1) × 体重 × 小时（扣掉本来就会消耗的静息部分，避免和 TDEE 重复计算）
export function exerciseKcal(met, weightKg, minutes) {
  return Math.max(0, (met - 1) * weightKg * (minutes / 60));
}

// 力量训练没填时长时，按每组约 2.5 分钟（含组间休息）估算
export const MINUTES_PER_SET = 2.5;

export function round(n, d = 0) {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

export function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);
}

function linearSlope(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}
