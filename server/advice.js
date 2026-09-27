// 规则建议：稳定、可解释。AI 总结放到第二阶段。

const PROTEIN_FOODS = '鸡胸肉 150g（≈35g）、2 个鸡蛋 + 1 杯牛奶（≈20g）、北豆腐 200g（≈24g）、希腊酸奶 200g（≈20g）、一勺蛋白粉（≈24g）';

export function buildTips({ targets, intake, budget, weightLoggedToday, adaptive, trend, recentIntake, bmr, muscleGap, isToday }) {
  const tips = [];

  if (isToday && !weightLoggedToday) {
    tips.push({ level: 'info', text: '今天还没称重。建议每天早上空腹、如厕后称一次，趋势比单次数值重要。' });
  }

  if (!adaptive) {
    tips.push({
      level: 'info',
      text: '坚持记录 2–4 周体重和每餐，系统会用真实体重变化校准你的每日消耗，目标会越来越准。',
    });
  }

  if (intake.kcal > 0) {
    const proteinLeft = targets.protein - intake.protein;
    if (proteinLeft > 25) {
      tips.push({ level: 'action', text: `蛋白质还差约 ${Math.round(proteinLeft)}g。可以选：${PROTEIN_FOODS}。` });
    }
    const over = intake.kcal - budget;
    if (over > budget * 0.1) {
      tips.push({ level: 'warn', text: `今天已超出预算约 ${Math.round(over)} kcal。不用补偿性节食，明天回到正常目标即可。` });
    } else if (isToday && budget - intake.kcal > 0 && budget - intake.kcal < 250) {
      tips.push({ level: 'info', text: `今天还剩约 ${Math.round(budget - intake.kcal)} kcal，适合加一份水果或酸奶。` });
    }
  }

  if (recentIntake.length >= 3) {
    const avg = recentIntake.reduce((s, x) => s + x, 0) / recentIntake.length;
    if (avg < bmr * 0.9) {
      tips.push({ level: 'warn', text: `最近 ${recentIntake.length} 天平均摄入约 ${Math.round(avg)} kcal，低于基础代谢。长期过低会掉肌肉、影响恢复，也可能是有餐没记。` });
    }
  }

  if (trend && trend.pctPerWeek < -1) {
    tips.push({ level: 'warn', text: `体重下降速度约每周 ${Math.abs(trend.pctPerWeek).toFixed(1)}%，偏快。建议每周不超过体重的 1%，以免流失肌肉。` });
  }

  if (muscleGap.length) {
    tips.push({ level: 'action', text: `最近 7 天还没练：${muscleGap.join('、')}。` });
  }

  return tips;
}
