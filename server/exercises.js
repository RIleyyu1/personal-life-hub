// 动作库种子数据。MET 取自 Compendium of Physical Activities 的近似值。
// kind: strength = 按组记录（次数 × 重量），cardio = 按时长记录
export const EXERCISES = [
  // 胸
  { name: '杠铃卧推', muscle: '胸', kind: 'strength', met: 5.0 },
  { name: '哑铃卧推', muscle: '胸', kind: 'strength', met: 5.0 },
  { name: '上斜哑铃卧推', muscle: '胸', kind: 'strength', met: 5.0 },
  { name: '器械夹胸', muscle: '胸', kind: 'strength', met: 3.5 },
  { name: '俯卧撑', muscle: '胸', kind: 'strength', met: 3.8 },
  { name: '双杠臂屈伸', muscle: '胸', kind: 'strength', met: 5.0 },
  // 背
  { name: '引体向上', muscle: '背', kind: 'strength', met: 5.0 },
  { name: '高位下拉', muscle: '背', kind: 'strength', met: 3.5 },
  { name: '杠铃划船', muscle: '背', kind: 'strength', met: 5.0 },
  { name: '坐姿划船', muscle: '背', kind: 'strength', met: 3.5 },
  { name: '单臂哑铃划船', muscle: '背', kind: 'strength', met: 3.5 },
  { name: '硬拉', muscle: '背', kind: 'strength', met: 6.0 },
  // 腿
  { name: '杠铃深蹲', muscle: '腿', kind: 'strength', met: 6.0 },
  { name: '腿举', muscle: '腿', kind: 'strength', met: 5.0 },
  { name: '罗马尼亚硬拉', muscle: '腿', kind: 'strength', met: 5.0 },
  { name: '箭步蹲', muscle: '腿', kind: 'strength', met: 5.0 },
  { name: '腿屈伸', muscle: '腿', kind: 'strength', met: 3.5 },
  { name: '腿弯举', muscle: '腿', kind: 'strength', met: 3.5 },
  { name: '提踵', muscle: '腿', kind: 'strength', met: 3.5 },
  { name: '臀推', muscle: '腿', kind: 'strength', met: 5.0 },
  // 肩
  { name: '杠铃推举', muscle: '肩', kind: 'strength', met: 5.0 },
  { name: '哑铃推举', muscle: '肩', kind: 'strength', met: 5.0 },
  { name: '哑铃侧平举', muscle: '肩', kind: 'strength', met: 3.5 },
  { name: '面拉', muscle: '肩', kind: 'strength', met: 3.5 },
  // 手臂
  { name: '杠铃弯举', muscle: '手臂', kind: 'strength', met: 3.5 },
  { name: '哑铃弯举', muscle: '手臂', kind: 'strength', met: 3.5 },
  { name: '绳索下压', muscle: '手臂', kind: 'strength', met: 3.5 },
  { name: '窄距卧推', muscle: '手臂', kind: 'strength', met: 5.0 },
  // 核心
  { name: '平板支撑', muscle: '核心', kind: 'strength', met: 3.8 },
  { name: '卷腹', muscle: '核心', kind: 'strength', met: 3.8 },
  { name: '悬垂举腿', muscle: '核心', kind: 'strength', met: 3.8 },
  // 有氧
  { name: '跑步（8 km/h）', muscle: '有氧', kind: 'cardio', met: 8.3 },
  { name: '跑步（10 km/h）', muscle: '有氧', kind: 'cardio', met: 9.8 },
  { name: '快走', muscle: '有氧', kind: 'cardio', met: 4.3 },
  { name: '爬坡走（跑步机）', muscle: '有氧', kind: 'cardio', met: 6.0 },
  { name: '动感单车', muscle: '有氧', kind: 'cardio', met: 8.5 },
  { name: '椭圆机', muscle: '有氧', kind: 'cardio', met: 5.0 },
  { name: '划船机', muscle: '有氧', kind: 'cardio', met: 7.0 },
  { name: '跳绳', muscle: '有氧', kind: 'cardio', met: 11.0 },
  { name: '游泳（中速）', muscle: '有氧', kind: 'cardio', met: 7.0 },
  { name: '篮球', muscle: '有氧', kind: 'cardio', met: 6.5 },
  { name: '羽毛球', muscle: '有氧', kind: 'cardio', met: 5.5 },
  { name: 'HIIT', muscle: '有氧', kind: 'cardio', met: 8.0 },
];

// 常用调料/易漏记的"隐形热量"，数值为每 1 单位
export const DEFAULT_CONDIMENTS = [
  { name: '食用油', unit: '勺(10g)', kcal: 90, protein: 0, carbs: 0, fat: 10 },
  { name: '辣椒油', unit: '勺(10g)', kcal: 85, protein: 0, carbs: 0.5, fat: 9.3 },
  { name: '芝麻酱', unit: '勺(15g)', kcal: 95, protein: 3, carbs: 3, fat: 8 },
  { name: '花生酱', unit: '勺(15g)', kcal: 90, protein: 3.8, carbs: 3, fat: 7.5 },
  { name: '沙拉酱', unit: '勺(15g)', kcal: 100, protein: 0.2, carbs: 1, fat: 11 },
  { name: '番茄酱', unit: '勺(15g)', kcal: 16, protein: 0.2, carbs: 4, fat: 0 },
  { name: '白糖', unit: '勺(10g)', kcal: 40, protein: 0, carbs: 10, fat: 0 },
  { name: '蚝油/酱油', unit: '勺(10g)', kcal: 10, protein: 1, carbs: 1.5, fat: 0 },
  { name: '黄油', unit: '块(10g)', kcal: 72, protein: 0.1, carbs: 0, fat: 8.1 },
  { name: '蜂蜜', unit: '勺(15g)', kcal: 46, protein: 0, carbs: 12, fat: 0 },
];
