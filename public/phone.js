// 手机端（视觉方向 C「手帐」）：每天的记录都在这里完成。hash 路由 + 原生 DOM，无构建步骤。
import {
  KG_PER_LB,
  api,
  countUp,
  deleteWithUndo,
  displayToKg,
  esc,
  flushDeletes,
  fmt1,
  fmtDate,
  fmtInt,
  fmtWeight,
  greeting,
  guard,
  haptic,
  kgToDisplay,
  monthDayCn,
  r0,
  r1,
  setWeightUnit,
  shiftDate,
  toast,
  todayStr,
  weekdayCn,
  weightUnit,
} from './lib.js';
import { legend, mountChart, releaseCharts, weightTrendSpec } from './charts.js';

const $view = document.getElementById('view');
const $sheet = document.getElementById('sheet');
const $scrim = document.querySelector('[data-scrim]');
const MEAL_LABEL = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };
const GOAL_NAME = { cut: '减脂', maintain: '维持', bulk: '增肌', recomp: '重组' };
const CONF_LABEL = { high: '把握较大', medium: '中等把握', low: '把握较小' };
// 到了饭点还没记的正餐，在今天的时间线上留一个空位，点一下直接拍照
const MEAL_SLOTS = [
  { type: 'breakfast', time: '08:00', from: 6 },
  { type: 'lunch', time: '12:00', from: 11 },
  { type: 'dinner', time: '18:30', from: 17 },
];

const svg = (d, size = 22, sw = 1.5) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  camera: svg('<path d="M4.5 8.5h2.8l1.7-2.5h6l1.7 2.5h2.8a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.3" r="3.3"/>'),
  image: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 16-5-5-8.5 8.5"/>'),
  dumbbell: svg('<path d="M6.5 7.5v9M3.5 9.5v5M17.5 7.5v9M20.5 9.5v5M6.5 12h11"/>'),
  scale: svg('<rect x="3.5" y="4" width="17" height="16" rx="4"/><path d="M8.6 10.2a4.2 4.2 0 0 1 6.8 0L12 12.4z"/>'),
  chevL: svg('<path d="m14.5 6.5-5.5 5.5 5.5 5.5"/>', 20, 1.8),
  chevR: svg('<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>', 20, 1.8),
  x: svg('<path d="M7 7l10 10M17 7 7 17"/>', 18, 1.6),
};

const state = {
  date: todayStr(),
  mealDraft: null, // 记一餐的编辑中数据
  workoutDraft: null,
  pendingPhoto: null, // 从 + 菜单或时间线空位拍的照片，进入记一餐页后自动识别
  pendingSlot: null, // 从时间线空位拍照时预设的餐次和时间
  shown: null, // 今天页上一次显示的余量和进度，重绘时从这里过渡到新值
};

const currentRoute = () => location.hash.replace('#/', '') || 'today';
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${fmt1(Math.abs(n))}`;

function defaultMealType() {
  const h = new Date().getHours();
  if (h < 10) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h >= 17 && h < 21) return 'dinner';
  return 'snack';
}

// 压缩到最长边 1280px 的 JPEG，减小上传体积和识别成本
function resizeImage(file, max = 1280) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('无法读取这张图片'));
    img.src = url;
  });
}

// 进度线从上次显示的位置（第一次从 0）过渡到新值；余量数字同样从上次的值滚动过去
function animateToday(root, heroValue) {
  const prev = state.shown?.date === state.date ? state.shown : { bars: {} };
  const bars = [...root.querySelectorAll('[data-grow]')];
  const prop = (el) => (el.tagName === 'EM' ? 'left' : 'width');
  for (const el of bars) {
    const from = prev.bars[el.dataset.grow];
    if (from) el.style[prop(el)] = from;
  }
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      for (const el of bars) el.style[prop(el)] = el.dataset.to;
    }),
  );
  const hero = root.querySelector('[data-hero]');
  if (hero) {
    hero.dataset.value = String(prev.hero ?? 0);
    hero.textContent = fmtInt(prev.hero ?? 0);
    countUp(hero, heroValue);
  }
  state.shown = { date: state.date, hero: heroValue, bars: Object.fromEntries(bars.map((el) => [el.dataset.grow, el.dataset.to])) };
}

// ---------- 体重图 ----------
// rows：只含称重日期的升序 [{date, kg, avg}]；补成连续日期再画
function weightChartHtml(rows) {
  if (rows.length < 2) return '<p class="meta">记录 2 天以上体重后显示趋势。</p>';
  return `${legend([['dot', 'var(--viz-muted)', '每日体重'], ['line', 'var(--viz-1)', '7 天平均']])}
    <div data-weight-chart></div>
    <p class="meta" style="margin-top: 6px">看平均线的走势，不用在意单日波动。</p>`;
}

function mountWeightChart(root, rows) {
  const box = root.querySelector('[data-weight-chart]');
  if (!box) return;
  const by = Object.fromEntries(rows.map((r) => [r.date, r]));
  const days = [];
  for (let d = rows[0].date; d <= rows.at(-1).date; d = shiftDate(d, 1)) {
    days.push({ date: d, weight: by[d]?.kg ?? null, weightAvg: by[d]?.avg ?? null });
  }
  mountChart(box, weightTrendSpec(days, { height: 180 }));
}

// ---------- 重量单位：保存到服务器，手机和电脑显示一致 ----------
function unitToggle() {
  return `<div class="seg unit-seg" role="group" aria-label="重量单位">${['kg', 'lb']
    .map((u) => `<button type="button" data-unit="${u}" class="${weightUnit() === u ? 'on' : ''}" aria-pressed="${weightUnit() === u}">${u}</button>`)
    .join('')}</div>`;
}

document.addEventListener('click', guard(async (e) => {
  const b = e.target.closest('[data-unit]');
  if (!b || b.dataset.unit === weightUnit()) return;
  const prev = weightUnit();
  const toKg = (v) => (prev === 'lb' ? Number(v) * KG_PER_LB : Number(v));
  await api('/settings', { method: 'PUT', body: { weight_unit: b.dataset.unit } });
  setWeightUnit(b.dataset.unit);
  // 已填的数字跟着换算，避免 60 kg 变成 60 lb
  for (const en of state.workoutDraft?.entries || []) {
    for (const set of en.sets) {
      if (set.weight === '' || set.weight == null) continue;
      set.weight = r1(kgToDisplay(toKg(set.weight)));
    }
  }
  haptic();
  const input = $sheet.classList.contains('open') && $sheet.querySelector('[data-weigh-input]');
  if (input) {
    if (input.value) input.value = fmt1(kgToDisplay(toKg(input.value)));
    fitWeigh(input);
    $sheet.querySelector('[data-weigh-unit]').textContent = weightUnit();
    b.closest('.unit-seg').outerHTML = unitToggle();
    return;
  }
  toast(`已切换为 ${weightUnit()}`);
  refresh();
}));

// ---------- 底部弹层 ----------
let sheetOpener = null;
$sheet.inert = true;
$sheet.tabIndex = -1;

function openSheet(html, label) {
  if (!$sheet.classList.contains('open')) sheetOpener = document.activeElement;
  $sheet.innerHTML = `<div class="sheet-handle" aria-hidden="true"><div class="sheet-grip"></div></div><div class="sheet-body">${html}</div>`;
  $sheet.setAttribute('aria-label', label);
  $sheet.setAttribute('aria-hidden', 'false');
  $sheet.inert = false;
  $sheet.classList.add('open');
  $scrim.classList.add('open');
  // 焦点移进弹层（不直接聚焦输入框，免得手机弹出键盘挡住步进按钮）
  $sheet.focus({ preventScroll: true });
  haptic();
}

function closeSheet() {
  if (!$sheet.classList.contains('open')) return;
  $sheet.classList.remove('open');
  $scrim.classList.remove('open');
  $sheet.setAttribute('aria-hidden', 'true');
  $sheet.inert = true;
  clearTimeout(holdTimer);
  if (sheetOpener?.isConnected) sheetOpener.focus({ preventScroll: true });
  sheetOpener = null;
}

$scrim.addEventListener('click', closeSheet);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
});

// 按住顶部把手往下拖可以关掉弹层
let drag = null;
$sheet.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.sheet-handle, .sheet-title')) return;
  drag = { y: e.clientY, dy: 0, id: e.pointerId };
  $sheet.setPointerCapture(e.pointerId);
});
$sheet.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag.dy = Math.max(0, e.clientY - drag.y);
  $sheet.classList.add('dragging');
  $sheet.style.transform = `translateY(${drag.dy}px)`;
});
const endDrag = () => {
  if (!drag) return;
  const { dy } = drag;
  drag = null;
  $sheet.classList.remove('dragging');
  $sheet.style.transform = '';
  if (dy > 90) closeSheet();
};
$sheet.addEventListener('pointerup', endDrag);
$sheet.addEventListener('pointercancel', endDrag);

// ---------- + 菜单 ----------
function sheetRow(act, icon, title, desc, accent = false) {
  return `<button type="button" class="sheet-row" data-sheet="${act}">
    <span style="color: ${accent ? 'var(--accent)' : 'var(--ink)'}">${icon}</span>
    <span class="tl-text"><span class="tl-title">${title}</span><span class="tl-desc">${desc}</span></span>
    <span class="arrow" aria-hidden="true">→</span>
  </button>`;
}

function openMenu() {
  state.pendingSlot = null;
  openSheet(
    `<h2 class="sheet-title">记一笔</h2>
    ${sheetRow('camera', ICON.camera, '拍照记一餐', '拍下来，自动估算热量和营养', true)}
    ${sheetRow('album', ICON.image, '从相册选一张', '已经拍好的照片也可以')}
    ${sheetRow('workout', ICON.dumbbell, '记训练', '按组记录，沿用上次的重量')}
    ${sheetRow('weigh', ICON.scale, '称体重', '早上空腹称，看趋势不看单日')}`,
    '记一笔',
  );
}

document.querySelector('[data-open-menu]').addEventListener('click', () => openMenu());

$sheet.addEventListener('click', guard(async (e) => {
  const act = e.target.closest('[data-sheet]')?.dataset.sheet;
  // 选照片必须在点击的同一轮里触发，浏览器才允许打开相机
  if (act === 'camera') return document.getElementById('camera-input').click();
  if (act === 'album') return document.getElementById('album-input').click();
  if (act === 'workout') {
    closeSheet();
    location.hash = '#/workout';
    return;
  }
  if (act === 'weigh') return openWeigh();
  if (act === 'weigh-save') return saveWeigh();
  const step = e.target.closest('[data-step]');
  if (step && e.detail === 0) stepWeigh(Number(step.dataset.step)); // 键盘触发；手指按住由 pointer 事件处理
}));

for (const id of ['camera-input', 'album-input']) {
  document.getElementById(id).addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    closeSheet();
    state.mealDraft = newMealDraft();
    const slot = state.pendingSlot;
    state.pendingSlot = null;
    if (slot) {
      // 补记已经过了饭点的一餐时，时间用那一餐的默认时间，时间线顺序才对
      if (slot.type !== state.mealDraft.meal_type) state.mealDraft.time = slot.time;
      state.mealDraft.meal_type = slot.type;
    }
    state.pendingPhoto = file;
    if (currentRoute() === 'meal') paint(renderMeal, { animate: false });
    else location.hash = '#/meal';
  });
}

// ---------- 称体重（弹层） ----------
let weighCtx = null;
async function openWeigh() {
  const rows = await api('/weights?days=30');
  const today = rows.find((r) => r.date === todayStr());
  const last = rows.at(-1);
  const start = today?.kg ?? last?.kg;
  weighCtx = { recentAvg: last?.avg ?? null, prevToday: today?.kg ?? null, confirmed: false };
  openSheet(
    `<h2 class="sheet-title">称体重</h2>
    <p class="meta">${last ? `上次 ${fmtWeight(last.kg)} · ${fmtDate(last.date)}` : '第一次记录，早上空腹、如厕后称最准'}</p>
    <div class="weigh">
      <button type="button" class="step" data-step="-1" aria-label="减少 0.1">−</button>
      <label class="weigh-val"><input type="number" inputmode="decimal" step="0.1" data-weigh-input value="${start == null ? '' : fmt1(kgToDisplay(start))}" placeholder="0.0" aria-label="体重"><span data-weigh-unit>${weightUnit()}</span></label>
      <button type="button" class="step" data-step="1" aria-label="增加 0.1">+</button>
    </div>
    <p class="warn-note" data-weigh-warn hidden></p>
    <div class="row between" style="margin: 12px 0 18px">${unitToggle()}<a class="link-btn btn" href="#/weight">历史记录 →</a></div>
    <button type="button" class="primary block" data-sheet="weigh-save">保存</button>`,
    '称体重',
  );
  fitWeigh($sheet.querySelector('[data-weigh-input]'));
}

function resetWeighConfirm() {
  if (!weighCtx) return;
  weighCtx.confirmed = false;
  const warn = $sheet.querySelector('[data-weigh-warn]');
  if (warn) warn.hidden = true;
  const btn = $sheet.querySelector('[data-sheet="weigh-save"]');
  if (btn) btn.textContent = '保存';
}

function stepWeigh(dir) {
  const input = $sheet.querySelector('[data-weigh-input]');
  if (!input) return;
  const cur = Number(input.value) || 0;
  input.value = Math.max(0, cur + dir * 0.1).toFixed(1);
  fitWeigh(input);
  resetWeighConfirm();
  haptic(4);
}

function fitWeigh(input) {
  const v = input.value || input.placeholder;
  input.style.width = `${v.replace(/\D/g, '').length + (v.includes('.') ? 0.5 : 0) + 0.4}ch`;
}

// 按住 +/− 连续调整；手指抬起或移出按钮就停
let holdTimer = null;
$sheet.addEventListener('pointerdown', (e) => {
  const step = e.target.closest('[data-step]');
  if (!step) return;
  const dir = Number(step.dataset.step);
  stepWeigh(dir);
  clearTimeout(holdTimer);
  holdTimer = setTimeout(function repeat() {
    stepWeigh(dir);
    holdTimer = setTimeout(repeat, 70);
  }, 420);
});
const stopHold = () => clearTimeout(holdTimer);
addEventListener('pointerup', stopHold);
addEventListener('pointercancel', stopHold);
$sheet.addEventListener('pointerleave', (e) => e.target.closest?.('[data-step]') && stopHold(), true);
$sheet.addEventListener('input', (e) => {
  if (!e.target.matches('[data-weigh-input]')) return;
  fitWeigh(e.target);
  resetWeighConfirm();
});

async function saveWeigh() {
  const input = $sheet.querySelector('[data-weigh-input]');
  const value = Number(input.value);
  if (!value) {
    input.focus();
    return;
  }
  const kg = displayToKg(value);
  const avg = weighCtx.recentAvg;
  // 切换 kg/lb 后最容易出的错是单位填反；差太多时先提示，再点一次才保存
  if (avg && Math.abs(kg - avg) / avg > 0.05 && !weighCtx.confirmed) {
    weighCtx.confirmed = true;
    const warn = $sheet.querySelector('[data-weigh-warn]');
    warn.textContent = `${fmtWeight(kg)} 和最近 7 天平均 ${fmtWeight(avg)} 相差较大，单位是 ${weightUnit()} 吗？确认无误再点一次。`;
    warn.hidden = false;
    $sheet.querySelector('[data-sheet="weigh-save"]').textContent = '确认保存';
    haptic(20);
    return;
  }
  const date = todayStr();
  const prev = weighCtx.prevToday;
  await api('/weights', { method: 'POST', body: { date, kg } });
  closeSheet();
  haptic();
  toast(`已记录 ${fmtWeight(kg)}`, {
    action: '撤销',
    onAction: guard(async () => {
      if (prev != null) await api('/weights', { method: 'POST', body: { date, kg: prev } });
      else await api(`/weights/${date}`, { method: 'DELETE' });
      refresh();
    }),
  });
  refresh();
}

// 留在当前页的重绘：不回到顶部，也不重播进场动画
function refresh() {
  const render = ROUTES[currentRoute()];
  if (!render || currentRoute() === 'meal') return;
  return paint(render, { animate: false });
}

// 所有整页重绘排队执行，后发起的一定最后落地，不会被较慢的旧请求覆盖。
// 新内容先在 .still（无进场动画）下插入，需要动画时再移除 .still，让各段从头播放。
let paintChain = Promise.resolve();
function paint(render, { animate }) {
  const run = async () => {
    $view.classList.add('still');
    releaseCharts($view);
    try {
      await render();
    } catch (e) {
      if (!animate) return toast(e.message);
      $view.innerHTML = `<div class="sec"><p>加载失败：${esc(e.message)}</p><button type="button" data-retry>重试</button></div>`;
      $view.querySelector('[data-retry]').onclick = route;
    }
    if (animate) $view.classList.remove('still');
  };
  paintChain = paintChain.then(run, run);
  return paintChain;
}

// ---------- 今天 ----------
async function renderToday() {
  const d = await api(`/dashboard?date=${state.date}`);
  const isToday = state.date === todayStr();
  const m = d.model;
  const weights = d.weights;
  const latest = weights.at(-1);
  const base = latest ? [...weights].reverse().find((w) => w.date <= shiftDate(latest.date, -7)) : null;
  const weekChange = latest && base ? latest.avg - base.avg : null;

  let html = `
    <header class="page-head rise">
      <div>
        <div class="date-nav">
          <button type="button" class="icon-btn" data-d="-1" aria-label="前一天">${ICON.chevL}</button>
          <span class="eyebrow">${isToday ? `${monthDayCn(state.date)} · ${weekdayCn(state.date)}` : '回看'}</span>
          <button type="button" class="icon-btn" data-d="1" aria-label="后一天" ${isToday ? 'disabled' : ''}>${ICON.chevR}</button>
        </div>
        <h1>${isToday ? greeting() : fmtDate(state.date)}</h1>
      </div>
      ${latest ? `<a class="weight-mini" href="#/weight" aria-label="体重 7 天平均">
        <span><span class="num">${fmt1(kgToDisplay(latest.avg))}</span> <span class="meta">${weightUnit()}</span></span>
        <span class="meta">${weekChange == null ? '7 天平均' : `本周 ${signed(kgToDisplay(weekChange))}`}</span>
      </a>` : ''}
    </header>`;

  const draft = state.mealDraft;
  if (draft?.image) {
    html += `<a class="banner draft-link rise" href="#/meal">
      <img class="thumb" src="${draft.image}" alt="">
      <span class="grow">有一餐还没保存<span class="meta"> · ${draft.analyzing ? '正在识别' : draft.items.length ? `已识别 ${draft.items.length} 项` : '待识别'}</span></span>
      <span aria-hidden="true">继续 →</span>
    </a>`;
  }

  if (m.ready) {
    const t = m.targets;
    const eaten = d.intake.kcal;
    const left = d.budget - eaten;
    const pct = `${Math.min(100, (eaten / d.budget) * 100).toFixed(1)}%`;
    html += `
      <section class="sec hero rise" style="animation-delay: 60ms">
        <div class="row between">
          <span class="eyebrow">${left < 0 ? '今日超出' : '今日余量'}</span>
          <span class="meta">预算 <b>${fmtInt(d.budget)}</b></span>
        </div>
        <div class="hero-num ${left < 0 ? 'over' : ''}">
          <span class="num" data-hero>0</span><span class="serif meta">千卡</span>
        </div>
        <div class="progress" role="img" aria-label="已吃 ${fmtInt(eaten)} 千卡，预算 ${fmtInt(d.budget)} 千卡"><i data-grow="kcal" data-to="${pct}"></i><em data-grow="kcal-mark" data-to="${pct}"></em></div>
        <div class="hero-stats">
          <span>已吃 <b>${fmtInt(eaten)}</b></span><span class="vr"></span>
          <span>运动加回 <b>+${fmtInt(d.workoutKcal * m.profile.eat_back_ratio)}</b></span>
        </div>
      </section>
      <section class="sec rise" style="animation-delay: 120ms">
        <div class="macros">
          ${[
            ['protein', '蛋白质', d.intake.protein, t.protein],
            ['carbs', '碳水', d.intake.carbs, t.carbs],
            ['fat', '脂肪', d.intake.fat, t.fat],
          ]
            .map(
              ([key, label, v, target]) => `<div class="macro-col">
                <span class="eyebrow">${label}</span>
                <span class="num">${r0(v)}</span>
                <span class="meta">/ ${r0(target)} g</span>
                <div class="line"><i data-grow="${key}" data-to="${Math.min(100, target ? (v / target) * 100 : 0).toFixed(1)}%" style="background: var(--${key})"></i></div>
              </div>`,
            )
            .join('')}
        </div>
        <p class="meta" style="margin: 14px 0 0">纤维 ${r0(d.intake.fiber)} / ${t.fiber} g · 饮水建议 ${fmtInt(t.waterMl)} ml · 目标：${GOAL_NAME[m.goal] || ''}</p>
      </section>`;
  } else {
    html += `
      <section class="sec hero rise" style="animation-delay: 60ms">
        <span class="eyebrow">开始之前</span>
        <p class="serif" style="font-size: 18px; line-height: 1.7">${m.profile.configured ? '称一次体重，就能算出每天的预算。' : '先填写个人参数，再称一次体重，就能算出每天的预算。'}</p>
        <div class="row">
          ${m.profile.configured ? '' : '<a class="btn" href="#/me">填写参数</a>'}
          <button type="button" class="primary" data-open-weigh>称体重</button>
        </div>
      </section>`;
  }

  if (m.ready && d.tips.length) {
    html += `<section class="sec rise" style="animation-delay: 180ms"><ul class="tips">${d.tips.map((t) => `<li class="${t.level}">${esc(t.text)}</li>`).join('')}</ul></section>`;
  }

  const hour = new Date().getHours();
  const slots = isToday ? MEAL_SLOTS.filter((s) => hour >= s.from && !d.meals.some((ml) => ml.meal_type === s.type)) : [];
  const rows = [
    ...d.meals.map((meal) => ({ key: meal.time || '99:99', html: mealRow(meal) })),
    ...slots.map((s) => ({ key: s.time, html: slotRow(s) })),
  ].sort((a, b) => a.key.localeCompare(b.key));
  html += `
    <section class="sec rise" style="animation-delay: 240ms">
      <div class="sec-head"><h2>${isToday ? '今日饮食' : '这天的饮食'}</h2><span class="meta"><b>${fmtInt(d.intake.kcal)}</b> 千卡</span></div>
      ${rows.length ? `<ol class="timeline">${rows.map((r) => r.html).join('')}</ol>` : '<p class="meta">还没有记录。点下方 + 拍一张。</p>'}
    </section>
    <section class="sec rise" style="animation-delay: 300ms">
      <div class="sec-head"><h2>训练</h2>${d.workouts.length ? `<span class="meta">消耗 <b>${fmtInt(d.workoutKcal)}</b> 千卡</span>` : ''}</div>
      ${d.workouts.length ? `<ol class="timeline">${d.workouts.map(workoutRow).join('')}</ol>` : `<p class="meta">${isToday ? '今天还没有训练。' : '这天没有训练。'} <a class="link-btn" href="#/workout">记训练 →</a></p>`}
    </section>
    <section class="sec rise" style="animation-delay: 360ms">
      <div class="sec-head"><h2>体重趋势</h2><a class="link-btn" href="#/weight">全部记录 →</a></div>
      ${weightChartHtml(weights.slice(-30))}
    </section>`;

  $view.innerHTML = html;
  if (weights.length >= 2) mountWeightChart($view, weights.slice(-30));
  animateToday($view, m.ready ? Math.abs(d.budget - d.intake.kcal) : 0);
}

function mealRow(meal) {
  const names = meal.items.filter((i) => i.source !== 'condiment').map((i) => i.name).join('、');
  const conds = meal.items.filter((i) => i.source === 'condiment').map((i) => `${i.name}×${i.quantity}`).join('、');
  return `<li class="tl-row">
    <span class="tl-time">${esc(meal.time || '')}</span>
    <span class="tl-main">
      ${meal.photo ? `<img class="thumb" src="/photos/${esc(meal.photo)}" alt="" loading="lazy">` : ''}
      <span class="tl-text"><span class="tl-title">${MEAL_LABEL[meal.meal_type]}</span><span class="tl-desc">${esc(names)}${conds ? ` · ${esc(conds)}` : ''}</span></span>
    </span>
    <span class="tl-kcal">${fmtInt(meal.totals.kcal)}</span>
    <button type="button" class="icon-btn" data-del-meal="${meal.id}" aria-label="删除这顿${MEAL_LABEL[meal.meal_type]}">${ICON.x}</button>
  </li>`;
}

function slotRow(slot) {
  return `<li class="tl-row slot">
    <span class="tl-time">${slot.time}</span>
    <span class="tl-main"><span class="tl-text"><span class="tl-title">${MEAL_LABEL[slot.type]}</span><span class="tl-desc">待记录</span></span></span>
    <button type="button" class="small" data-snap="${slot.type}" style="color: var(--accent); border-color: var(--accent)">${ICON.camera}拍照</button>
    <span></span>
  </li>`;
}

function workoutRow(w) {
  // 补记的训练只知道日期，不显示保存时的钟点
  const created = w.created_at ? new Date(w.created_at) : null;
  const time = created && created.toLocaleDateString('sv') === w.date ? created.toTimeString().slice(0, 5) : '';
  const desc = [w.duration_min ? `${r0(w.duration_min)} 分钟` : '', w.rpe ? `强度 ${w.rpe}/10` : '', w.note ? esc(w.note) : ''].filter(Boolean).join(' · ');
  return `<li class="tl-row">
    <span class="tl-time">${time}</span>
    <span class="tl-main"><span class="tl-text"><span class="tl-title">${w.entries.map((e) => esc(e.name)).join('、')}</span><span class="tl-desc">${desc}</span></span></span>
    <span class="tl-kcal">${fmtInt(w.kcal)}</span>
    <button type="button" class="icon-btn" data-del-workout="${w.id}" aria-label="删除这次训练">${ICON.x}</button>
  </li>`;
}

// 删除：先从列表里滑走，5 秒内可撤销；真正删除后若还在这一页，重绘一次更新合计
function removeRow(btn, { key, label, path }) {
  const origin = currentRoute();
  const row = btn.closest('.tl-row');
  // 先淡出右移，再把这一行的高度收起，下面的行平滑补上
  row.style.height = `${row.offsetHeight}px`;
  row.classList.add('leaving');
  haptic();
  const collapseTimer = setTimeout(() => row.classList.add('collapsed'), 200);
  deleteWithUndo({
    key,
    label,
    commit: () => api(path, { method: 'DELETE', keepalive: true }).then(() => currentRoute() === origin && refresh()),
    restore: () => {
      clearTimeout(collapseTimer);
      row.classList.remove('collapsed', 'leaving');
      setTimeout(() => (row.style.height = ''), 400);
    },
  });
}

$view.addEventListener('click', guard(async (e) => {
  const route = currentRoute();
  if (e.target.closest('[data-open-weigh]')) return openWeigh();
  const snap = e.target.closest('[data-snap]');
  if (snap) {
    state.pendingSlot = MEAL_SLOTS.find((s) => s.type === snap.dataset.snap);
    document.getElementById('camera-input').click();
    return;
  }
  if (route !== 'today') return;
  const nav = e.target.closest('[data-d]');
  if (nav) {
    await flushDeletes();
    state.date = shiftDate(state.date, Number(nav.dataset.d));
    return paint(renderToday, { animate: true });
  }
  const delMeal = e.target.closest('[data-del-meal]');
  if (delMeal) {
    const id = delMeal.dataset.delMeal;
    return removeRow(delMeal, { key: `meal:${id}`, label: '已删除这一餐', path: `/meals/${id}` });
  }
  const delWorkout = e.target.closest('[data-del-workout]');
  if (delWorkout) {
    const id = delWorkout.dataset.delWorkout;
    return removeRow(delWorkout, { key: `workout:${id}`, label: '已删除这次训练', path: `/workouts/${id}` });
  }
}));

// ---------- 记一餐 ----------
function newMealDraft() {
  return {
    date: todayStr(),
    time: new Date().toTimeString().slice(0, 5),
    meal_type: defaultMealType(),
    image: null,
    photo: null,
    note: '',
    analysis: null,
    items: [],
    condiments: {}, // id -> quantity
    analyzing: false,
    animateItems: false,
    portion: 1,
  };
}

async function renderMeal() {
  const condiments = await api('/condiments');
  state.mealDraft ??= newMealDraft();
  const d = state.mealDraft;
  d.condimentList = condiments;
  const file = state.pendingPhoto;
  state.pendingPhoto = null;
  drawMeal();
  // 识别在后台进行，不挡住切换页面
  if (file) usePhoto(file);
}

async function usePhoto(file) {
  const d = state.mealDraft;
  try {
    d.image = await resizeImage(file);
  } catch (e) {
    toast(e.message);
    return;
  }
  d.analysis = null;
  d.items = [];
  d.photo = null;
  return analyze();
}

const NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat', 'fiber'];

function mealTotals(d) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const i of d.items) for (const k in t) t[k] += Number(i[k]) || 0;
  for (const c of d.condimentList || []) {
    const q = d.condiments[c.id] || 0;
    for (const k in t) t[k] += (c[k] || 0) * q;
  }
  return t;
}

function drawMeal() {
  const d = state.mealDraft;
  const hasResult = Boolean(d.analysis || d.items.length);
  const a = d.analysis;
  $view.innerHTML = `
    <header class="page-head">
      <div><span class="eyebrow" data-meal-date>${mealDateLabel(d.date)}</span><h1>${MEAL_LABEL[d.meal_type]}</h1></div>
      <button type="button" class="icon-btn" data-act="close" aria-label="先离开，草稿会保留">${ICON.x}</button>
    </header>
    <section class="sec">
      ${d.image
        ? `<div class="photo-frame"><img src="${d.image}" alt="餐食照片">${d.analyzing ? '<div class="scan-veil"></div><div class="scan-line"></div>' : ''}</div>
          <div class="row between" style="margin-top: 10px">
            <span class="meta">${d.analyzing ? '正在识别<span class="dots"><span>.</span><span>.</span><span>.</span></span>' : a ? `${CONF_LABEL[a.confidence] || ''} · 约 ${fmtInt(a.kcal_low)}–${fmtInt(a.kcal_high)} 千卡` : ''}</span>
            <span class="row">
              <label class="btn small file-btn">重拍<input type="file" accept="image/*" capture="environment" data-photo></label>
              <label class="btn small file-btn">相册<input type="file" accept="image/*" data-photo></label>
            </span>
          </div>`
        : `<div class="photo-empty">
            <p class="serif" style="margin: 0">俯拍整份餐食，旁边放双筷子做参照，份量估得更准。</p>
            <label class="btn primary file-btn">${ICON.camera}拍照<input type="file" accept="image/*" capture="environment" data-photo></label>
            <label class="btn small file-btn">从相册选择<input type="file" accept="image/*" data-photo></label>
          </div>`}
      <label class="field" style="margin-top: 14px"><span>补充说明（可选，会一起发给识别）</span>
        <input data-f="note" value="${esc(d.note)}" placeholder="只吃了一半 / 少油 / 外卖">
      </label>
      ${d.image && !d.analyzing ? `<button type="button" class="small" data-act="analyze" style="margin-top: 12px">${hasResult ? '重新识别' : '识别热量'}</button>` : ''}
    </section>
    ${a?.demo ? `<div class="banner">${esc(a.notes)} 在项目根目录的 .env 里填入 ANTHROPIC_API_KEY 后重启即可使用真实识别。</div>` : ''}
    ${hasResult ? `
    <section class="sec">
      <div class="sec-head"><h2>识别结果</h2><span class="meta">点一项可以修改</span></div>
      ${a?.notes && !a.demo ? `<p class="meta">${esc(a.notes)}</p>` : ''}
      ${a ? `<div class="row" style="margin: 8px 0 4px"><span class="meta">整体份量</span>
        <div class="seg grow" data-portions>${portionButtons(d)}</div></div>` : ''}
      <div data-items>${d.items.map(itemRow).join('')}</div>
      <button type="button" class="small" data-act="add-item" style="margin-top: 12px">＋ 添加一项</button>
      <p class="meta" style="margin-top: 10px">改过的名称和数值会记住，下次识别同样的菜会参考。</p>
    </section>` : ''}
    <section class="sec">
      <div class="sec-head"><h2>调料</h2><span class="meta">点一下 +1，常用的排在前面</span></div>
      <div class="chips" data-chips>${chipsHtml(d)}</div>
      <div data-newcond hidden style="margin-top: 12px">
        <div class="grid2">
          <label class="field"><span>名称</span><input data-nc="name" placeholder="如：老干妈"></label>
          <label class="field"><span>单位</span><input data-nc="unit" placeholder="勺(15g)"></label>
          <label class="field"><span>每单位热量 kcal</span><input data-nc="kcal" type="number" inputmode="decimal"></label>
          <label class="field"><span>脂肪 g</span><input data-nc="fat" type="number" inputmode="decimal"></label>
        </div>
        <button type="button" class="small" style="margin-top: 12px" data-act="save-cond">保存调料</button>
      </div>
    </section>
    <section class="sec">
      <div class="grid2">
        <label class="field"><span>餐次</span>
          <select data-f="meal_type">${Object.entries(MEAL_LABEL).map(([k, v]) => `<option value="${k}" ${d.meal_type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </label>
        <label class="field"><span>时间</span><input type="time" data-f="time" value="${esc(d.time)}"></label>
      </div>
      <label class="field" style="margin-top: 12px"><span>日期</span><input type="date" data-f="date" value="${d.date}" max="${todayStr()}"></label>
      ${d.image || d.items.length ? '<button type="button" class="ghost small" data-act="discard" style="margin-top: 16px; padding: 0">放弃这一餐</button>' : ''}
    </section>
    <div class="save-bar" data-save-bar>${saveBarHtml(d)}</div>`;
  d.animateItems = false;
}

function mealDateLabel(date) {
  return date === todayStr() ? '记一餐' : `记一餐 · <span style="color: var(--accent)">${fmtDate(date)}</span>`;
}

function portionButtons(d) {
  return [0.5, 0.75, 1, 1.25, 1.5].map((p) => `<button type="button" data-portion="${p}" class="${d.portion === p ? 'on' : ''}">${p}×</button>`).join('');
}

function chipsHtml(d) {
  return `${(d.condimentList || [])
    .map((c) => {
      const q = d.condiments[c.id] || 0;
      return `<span class="chip ${q ? 'on' : ''}" data-cond="${c.id}" role="button" tabindex="0" aria-label="${esc(c.name)}${q ? `，已加 ${q} 份` : ''}">${esc(c.name)}${q ? ` ×${q}` : ''}${q ? `<button type="button" class="x" data-cond-minus="${c.id}" aria-label="减少">−</button>` : ''}</span>`;
    })
    .join('')}<span class="chip" data-act="new-cond" role="button" tabindex="0">＋ 自定义</span>`;
}

function saveBarHtml(d) {
  const t = mealTotals(d);
  return `<div class="grow">
      <span class="num" style="font-size: 30px; line-height: 1">${fmtInt(t.kcal)}</span><span class="meta"> 千卡</span>
      <div class="meta">蛋白 ${r0(t.protein)} g · 碳水 ${r0(t.carbs)} g · 脂肪 ${r0(t.fat)} g</div>
    </div>
    <button type="button" class="primary" data-act="save" ${t.kcal > 0 && !d.analyzing ? '' : 'disabled'}>记为${MEAL_LABEL[d.meal_type]}</button>`;
}

function itemRow(it, idx) {
  const d = state.mealDraft;
  const f = (k, label) => `<label class="field"><span>${label}</span><input type="number" inputmode="decimal" data-item="${idx}" data-k="${k}" value="${r1(it[k])}"></label>`;
  return `<details class="item ${d.animateItems ? 'item-in' : ''}" style="animation-delay: ${idx * 90}ms" data-item-row="${idx}" ${it.open ? 'open' : ''}>
    <summary>
      <span class="tl-text"><span class="tl-title">${esc(it.name || '未命名')}</span><span class="tl-desc" data-desc>${itemDesc(it)}</span></span>
      <span class="tl-kcal" data-kcal>${fmtInt(it.kcal)}</span>
    </summary>
    <div class="item-body">
      <label class="field wide"><span>名称</span><input data-item="${idx}" data-k="name" value="${esc(it.name)}"></label>
      <label class="field"><span>克</span><input type="number" inputmode="decimal" data-item="${idx}" data-k="grams" value="${r0(it.grams)}"></label>
      ${f('kcal', '热量')}${f('protein', '蛋白')}${f('carbs', '碳水')}${f('fat', '脂肪')}
      <button type="button" class="ghost small" data-del-item="${idx}" style="grid-column: 1 / -1; justify-self: start; padding: 0; color: var(--accent)">删掉这一项</button>
    </div>
  </details>`;
}

const itemDesc = (it) => `${r0(it.grams)} g · 蛋白 ${r0(it.protein)} · 碳水 ${r0(it.carbs)} · 脂肪 ${r0(it.fat)}`;

function redrawItems() {
  const d = state.mealDraft;
  const box = $view.querySelector('[data-items]');
  if (box) box.innerHTML = d.items.map(itemRow).join('');
  const seg = $view.querySelector('[data-portions]');
  if (seg) seg.innerHTML = portionButtons(d);
  updateSaveBar();
}

function updateSaveBar() {
  const bar = $view.querySelector('[data-save-bar]');
  if (bar && state.mealDraft) bar.innerHTML = saveBarHtml(state.mealDraft);
}

function scaleItem(it, factor) {
  it.grams = (Number(it.grams) || 0) * factor;
  for (const k of NUTRIENTS) it[k] = (Number(it[k]) || 0) * factor;
}

$view.addEventListener('change', guard(async (e) => {
  if (currentRoute() !== 'meal') return;
  const d = state.mealDraft;
  if (e.target.matches('[data-photo]')) {
    const file = e.target.files?.[0];
    if (file) usePhoto(file);
    return;
  }
  if (e.target.matches('[data-f="meal_type"]')) {
    d.meal_type = e.target.value;
    $view.querySelector('.page-head h1').textContent = MEAL_LABEL[d.meal_type];
    updateSaveBar();
  }
}));

$view.addEventListener('toggle', (e) => {
  if (currentRoute() !== 'meal' || !e.target.matches?.('[data-item-row]')) return;
  const it = state.mealDraft?.items[Number(e.target.dataset.itemRow)];
  if (it) it.open = e.target.open;
}, true);

$view.addEventListener('input', (e) => {
  if (currentRoute() !== 'meal') return;
  const d = state.mealDraft;
  const t = e.target;
  if (t.dataset.f) {
    d[t.dataset.f] = t.value;
    if (t.dataset.f === 'date') $view.querySelector('[data-meal-date]').innerHTML = mealDateLabel(t.value);
    return;
  }
  if (t.dataset.item === undefined) return;
  const it = d.items[Number(t.dataset.item)];
  const row = t.closest('[data-item-row]');
  it.edited = true;
  if (t.dataset.k === 'name') {
    it.name = t.value;
    row.querySelector('.tl-title').textContent = t.value || '未命名';
    return;
  }
  const v = Number(t.value) || 0;
  // 改重量时营养素按比例联动；改某一项营养素只改那一项
  if (t.dataset.k === 'grams' && it.grams > 0) {
    const f = v / it.grams;
    for (const n of NUTRIENTS) it[n] = (Number(it[n]) || 0) * f;
    it.grams = v;
    for (const n of ['kcal', 'protein', 'carbs', 'fat']) row.querySelector(`[data-k="${n}"]`).value = r1(it[n]);
  } else {
    it[t.dataset.k] = v;
  }
  row.querySelector('[data-desc]').textContent = itemDesc(it);
  row.querySelector('[data-kcal]').textContent = fmtInt(it.kcal);
  updateSaveBar();
});

$view.addEventListener('keydown', (e) => {
  if (currentRoute() !== 'meal' || (e.key !== 'Enter' && e.key !== ' ')) return;
  if (e.target.matches('.chip')) {
    e.preventDefault();
    e.target.click();
  }
});

$view.addEventListener('click', guard(async (e) => {
  if (currentRoute() !== 'meal') return;
  const d = state.mealDraft;
  const t = e.target;

  const minus = t.closest('[data-cond-minus]');
  if (minus) {
    e.stopPropagation();
    const id = minus.dataset.condMinus;
    d.condiments[id] = Math.max(0, (d.condiments[id] || 0) - 1);
    haptic(4);
    $view.querySelector('[data-chips]').innerHTML = chipsHtml(d);
    return updateSaveBar();
  }
  const chip = t.closest('[data-cond]');
  if (chip) {
    const id = chip.dataset.cond;
    d.condiments[id] = (d.condiments[id] || 0) + 1;
    haptic(4);
    $view.querySelector('[data-chips]').innerHTML = chipsHtml(d);
    return updateSaveBar();
  }
  const portion = t.closest('[data-portion]');
  if (portion) {
    const p = Number(portion.dataset.portion);
    const factor = p / d.portion;
    d.items.filter((i) => i.source === 'ai').forEach((i) => scaleItem(i, factor));
    d.portion = p;
    haptic(4);
    return redrawItems();
  }
  const delItem = t.closest('[data-del-item]');
  if (delItem) {
    d.items.splice(Number(delItem.dataset.delItem), 1);
    return redrawItems();
  }

  switch (t.closest('[data-act]')?.dataset.act) {
    case 'analyze':
      return analyze();
    case 'add-item':
      d.items.push({ name: '', grams: 100, kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, source: 'user', edited: true, open: true });
      return redrawItems();
    case 'new-cond':
      $view.querySelector('[data-newcond]').hidden = false;
      $view.querySelector('[data-nc="name"]').focus();
      return;
    case 'save-cond': {
      const val = (k) => $view.querySelector(`[data-nc="${k}"]`).value;
      const c = await api('/condiments', { method: 'POST', body: { name: val('name'), unit: val('unit') || '份', kcal: val('kcal'), fat: val('fat') || 0 } });
      d.condimentList = await api('/condiments');
      d.condiments[c.id] = (d.condiments[c.id] || 0) + 1;
      $view.querySelector('[data-newcond]').hidden = true;
      $view.querySelector('[data-chips]').innerHTML = chipsHtml(d);
      toast('已加入调料库');
      return updateSaveBar();
    }
    case 'close':
      // 什么都没填就不留草稿，免得下次打开还是旧的时间
      if (!d.image && !d.items.length) state.mealDraft = null;
      location.hash = '#/today';
      return;
    case 'discard': {
      const kept = state.mealDraft;
      state.mealDraft = null;
      location.hash = '#/today';
      toast('已放弃这一餐', {
        action: '撤销',
        onAction: () => {
          state.mealDraft = kept;
          location.hash = '#/meal';
        },
      });
      return;
    }
    case 'save': {
      const body = {
        date: d.date,
        time: d.time,
        meal_type: d.meal_type,
        photo: d.photo,
        note: d.note,
        analysis: d.analysis && !d.analysis.demo ? d.analysis : null,
        items: d.items.filter((i) => i.name.trim() || i.kcal > 0),
        condiments: Object.entries(d.condiments).map(([id, quantity]) => ({ id, quantity })),
      };
      const saved = await api('/meals', { method: 'POST', body });
      state.date = d.date;
      state.mealDraft = null;
      haptic();
      location.hash = '#/today';
      toast(`已记为${MEAL_LABEL[saved.meal_type]} · ${fmtInt(saved.totals.kcal)} 千卡`, {
        action: '撤销',
        onAction: guard(async () => {
          await api(`/meals/${saved.id}`, { method: 'DELETE' });
          refresh();
        }),
      });
    }
  }
}));

async function analyze() {
  const d = state.mealDraft;
  const onMealPage = () => currentRoute() === 'meal' && state.mealDraft === d;
  d.analyzing = true;
  if (onMealPage()) drawMeal();
  try {
    const { photo, analysis } = await api('/meals/analyze', { method: 'POST', body: { image: d.image, note: d.note } });
    if (state.mealDraft !== d) return; // 识别期间已放弃或换了新照片
    d.photo = photo;
    d.analysis = analysis;
    d.portion = 1;
    if (!analysis.is_food) toast('这张照片看起来不是食物');
    d.items = analysis.items.map((i) => ({ ...i, source: 'ai', ai_name: i.name, edited: false }));
    d.animateItems = true;
    haptic();
    if (!onMealPage()) toast('这一餐识别好了', { action: '去看看', onAction: () => (location.hash = '#/meal') });
  } catch (e) {
    toast(`识别失败：${e.message}`);
  } finally {
    d.analyzing = false;
    if (onMealPage()) drawMeal();
  }
}

// ---------- 训练 ----------
let exerciseCache;
let workoutHistory = [];
let workoutRecords = [];
async function renderWorkout() {
  exerciseCache ??= await api('/exercises');
  [workoutHistory, workoutRecords] = await Promise.all([api('/workouts?days=30'), api('/records')]);
  state.workoutDraft ??= { date: todayStr(), entries: [], duration_min: '', rpe: '', note: '' };
  drawWorkout();
}

function drawWorkout() {
  const w = state.workoutDraft;
  const byMuscle = groupBy(exerciseCache, (x) => x.muscle);
  const exById = (id) => exerciseCache.find((x) => x.id === Number(id));

  $view.innerHTML = `
    <header class="page-head rise">
      <div><span class="eyebrow">${monthDayCn(w.date)} · ${weekdayCn(w.date)}</span><h1>训练</h1></div>
      ${unitToggle()}
    </header>
    <section class="sec rise" style="animation-delay: 60ms">
      <label class="field"><span>添加动作</span>
        <select data-pick>
          <option value="">选择动作…</option>
          ${Object.entries(byMuscle).map(([m, list]) => `<optgroup label="${esc(m)}">${list.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</optgroup>`).join('')}
        </select>
      </label>
      <button type="button" class="link-btn" data-act="custom-ex">找不到？自定义一个动作</button>
      <div data-custom hidden class="grid2" style="margin-top: 8px">
        <label class="field"><span>动作名</span><input data-cx="name"></label>
        <label class="field"><span>类型</span><select data-cx="kind"><option value="strength">力量</option><option value="cardio">有氧</option></select></label>
        <label class="field"><span>部位</span><select data-cx="muscle">${['胸', '背', '腿', '肩', '手臂', '核心', '其他'].map((m) => `<option>${m}</option>`).join('')}</select></label>
        <div style="align-self: end"><button type="button" class="small block" data-act="save-ex">加入动作库</button></div>
      </div>

      ${w.entries.map((en, i) => {
        const ex = exById(en.exercise_id);
        return `<div class="entry">
          <div class="row between"><h2 style="font-size: 17px">${esc(ex.name)}</h2><button type="button" class="icon-btn" data-del-entry="${i}" aria-label="删除这个动作">${ICON.x}</button></div>
          ${ex.kind === 'cardio'
            ? `<label class="field"><span>时长（分钟）</span><input type="number" inputmode="decimal" data-en="${i}" data-k="duration_min" value="${esc(en.duration_min)}"></label>`
            : `<div class="set-row meta" style="margin-top: 6px"><span>组</span><span>次数</span><span>重量 ${weightUnit()}</span><span></span></div>
              ${en.sets.map((s, j) => `<div class="set-row">
                <span class="num" style="font-size: 20px; color: var(--muted)">${j + 1}</span>
                <input type="number" inputmode="numeric" data-en="${i}" data-set="${j}" data-k="reps" value="${esc(s.reps)}" aria-label="第 ${j + 1} 组次数">
                <input type="number" inputmode="decimal" data-en="${i}" data-set="${j}" data-k="weight" value="${esc(s.weight)}" aria-label="第 ${j + 1} 组重量">
                <button type="button" class="icon-btn" data-del-set="${i}:${j}" aria-label="删除第 ${j + 1} 组">${ICON.x}</button>
              </div>`).join('')}
              <button type="button" class="small" style="margin-top: 10px" data-add-set="${i}">＋ 加一组</button>`}
        </div>`;
      }).join('')}

      ${w.entries.length ? `
      <div class="grid2" style="margin-top: 16px">
        <label class="field"><span>总时长（分钟，可选）</span><input type="number" inputmode="decimal" data-w="duration_min" value="${esc(w.duration_min)}"></label>
        <label class="field"><span>主观强度 1–10（可选）</span><input type="number" inputmode="numeric" min="1" max="10" data-w="rpe" value="${esc(w.rpe)}"></label>
      </div>
      <div class="grid2" style="margin-top: 12px">
        <label class="field"><span>日期</span><input type="date" data-w="date" value="${w.date}" max="${todayStr()}"></label>
        <label class="field"><span>备注</span><input data-w="note" value="${esc(w.note)}"></label>
      </div>
      <button type="button" class="primary block" style="margin-top: 18px" data-act="save-workout">保存训练</button>
      <p class="meta" style="margin-top: 10px">消耗按 MET 估算（力量训练没填时长时按每组 2.5 分钟算），只作参考。</p>` : '<p class="meta" style="margin-top: 12px">选一个动作开始。力量训练按组记次数和重量，有氧记时长。</p>'}
    </section>

    ${workoutRecords.length ? `<section class="sec rise" style="animation-delay: 120ms">
      <div class="sec-head"><h2>个人纪录</h2><span class="meta">估算 1RM</span></div>
      <ol class="timeline">${workoutRecords.map((r) => `<li class="tl-row" style="grid-template-columns: minmax(0, 1fr) auto">
        <span class="tl-text"><span class="tl-title">${esc(r.name)}</span><span class="tl-desc">最大 ${fmtWeight(r.max_weight)}</span></span>
        <span class="tl-kcal">${fmt1(kgToDisplay(r.e1rm))}<span class="meta"> ${weightUnit()}</span></span>
      </li>`).join('')}</ol>
    </section>` : ''}

    <section class="sec rise" style="animation-delay: 180ms">
      <div class="sec-head"><h2>最近 30 天</h2></div>
      ${workoutHistory.length ? `<ol class="timeline">${workoutHistory.map((h) => `<li class="tl-row" style="grid-template-columns: 64px minmax(0, 1fr) auto">
        <span class="tl-time" style="font-size: 16px">${fmtDate(h.date).replace(/ 周.$/, '')}</span>
        <span class="tl-text"><span class="tl-title">${h.entries.map((e) => esc(e.name)).join('、')}</span>
          <span class="tl-desc">${h.entries.map((e) => (e.sets.length ? `${e.sets.length} 组` : e.duration_min ? `${r0(e.duration_min)} 分钟` : '')).filter(Boolean).join(' · ')}</span></span>
        <span class="tl-kcal">${fmtInt(h.kcal)}</span>
      </li>`).join('')}</ol>` : '<p class="meta">还没有训练记录。</p>'}
    </section>`;
}

function groupBy(arr, fn) {
  return arr.reduce((acc, x) => ((acc[fn(x)] ??= []).push(x), acc), {});
}

$view.addEventListener('change', (e) => {
  if (currentRoute() !== 'workout') return;
  const t = e.target;
  if (t.matches('[data-pick]') && t.value) {
    const ex = exerciseCache.find((x) => x.id === Number(t.value));
    // 同一动作沿用上次这组的数据，少打字
    const last = state.workoutDraft.entries.findLast((en) => en.exercise_id === ex.id);
    state.workoutDraft.entries.push({
      exercise_id: ex.id,
      duration_min: '',
      sets: ex.kind === 'strength' ? (last ? last.sets.map((s) => ({ ...s })) : [{ reps: '', weight: '' }]) : [],
    });
    haptic();
    drawWorkout();
  }
});

$view.addEventListener('input', (e) => {
  if (currentRoute() !== 'workout') return;
  const t = e.target;
  const w = state.workoutDraft;
  if (t.dataset.w) w[t.dataset.w] = t.value;
  else if (t.dataset.en !== undefined) {
    const en = w.entries[Number(t.dataset.en)];
    if (t.dataset.set !== undefined) en.sets[Number(t.dataset.set)][t.dataset.k] = t.value;
    else en[t.dataset.k] = t.value;
  }
});

$view.addEventListener('click', guard(async (e) => {
  if (currentRoute() !== 'workout') return;
  const t = e.target;
  const w = state.workoutDraft;
  const addSet = t.closest('[data-add-set]');
  if (addSet) {
    const en = w.entries[Number(addSet.dataset.addSet)];
    en.sets.push({ ...(en.sets.at(-1) || { reps: '', weight: '' }) });
    haptic(4);
    return drawWorkout();
  }
  const delSet = t.closest('[data-del-set]');
  if (delSet) {
    const [i, j] = delSet.dataset.delSet.split(':').map(Number);
    w.entries[i].sets.splice(j, 1);
    return drawWorkout();
  }
  const delEntry = t.closest('[data-del-entry]');
  if (delEntry) {
    w.entries.splice(Number(delEntry.dataset.delEntry), 1);
    return drawWorkout();
  }
  switch (t.closest('[data-act]')?.dataset.act) {
    case 'custom-ex':
      $view.querySelector('[data-custom]').hidden = false;
      $view.querySelector('[data-cx="name"]').focus();
      return;
    case 'save-ex': {
      const val = (k) => $view.querySelector(`[data-cx="${k}"]`).value;
      const kind = val('kind');
      const ex = await api('/exercises', { method: 'POST', body: { name: val('name'), kind, muscle: kind === 'cardio' ? '有氧' : val('muscle') } });
      exerciseCache = await api('/exercises');
      w.entries.push({ exercise_id: ex.id, duration_min: '', sets: kind === 'strength' ? [{ reps: '', weight: '' }] : [] });
      toast('已加入动作库');
      return drawWorkout();
    }
    case 'save-workout': {
      const body = {
        ...w,
        entries: w.entries.map((en) => ({
          ...en,
          sets: en.sets.map((s) => ({ reps: s.reps, weight_kg: s.weight === '' || s.weight == null ? '' : displayToKg(Number(s.weight)) })),
        })),
      };
      const saved = await api('/workouts', { method: 'POST', body });
      state.date = w.date;
      state.workoutDraft = null;
      haptic();
      location.hash = '#/today';
      toast(`已保存训练 · 约 ${fmtInt(saved.kcal)} 千卡`, {
        action: '撤销',
        onAction: guard(async () => {
          await api(`/workouts/${saved.id}`, { method: 'DELETE' });
          refresh();
        }),
      });
    }
  }
}));

// ---------- 体重 ----------
async function renderWeight() {
  const rows = await api('/weights?days=90');
  const latest = rows.at(-1);
  $view.innerHTML = `
    <header class="page-head rise">
      <div>
        <span class="eyebrow">7 天平均</span>
        <h1>${latest ? `<span class="num" style="font-size: 48px; font-weight: 400; letter-spacing: 0">${fmt1(kgToDisplay(latest.avg))}</span> <span class="meta">${weightUnit()}</span>` : '体重'}</h1>
      </div>
      ${unitToggle()}
    </header>
    <section class="sec rise" style="animation-delay: 60ms">
      <button type="button" class="primary block" data-open-weigh>称体重</button>
      <p class="meta" style="margin-top: 10px">每天早上起床、如厕后、吃东西前称，条件越一致越好。</p>
    </section>
    <section class="sec rise" style="animation-delay: 120ms"><div class="sec-head"><h2>趋势</h2></div>${weightChartHtml(rows)}</section>
    <section class="sec rise" style="animation-delay: 180ms">
      <div class="sec-head"><h2>记录</h2><span class="meta">均 = 7 天平均</span></div>
      ${rows.length ? `<ol class="timeline">${[...rows].reverse().map((r) => `<li class="tl-row" style="grid-template-columns: 72px minmax(0, 1fr) auto auto">
        <span class="tl-time" style="font-size: 16px">${fmtDate(r.date).replace(/ 周.$/, '')}</span>
        <span class="tl-kcal" style="font-size: 24px">${fmt1(kgToDisplay(r.kg))}<span class="meta"> ${weightUnit()}</span></span>
        <span class="meta">均 ${fmt1(kgToDisplay(r.avg))}</span>
        <button type="button" class="icon-btn" data-del-weight="${r.date}" aria-label="删除 ${r.date} 的体重">${ICON.x}</button>
      </li>`).join('')}</ol>` : '<p class="meta">还没有记录。</p>'}
    </section>
    <section class="sec rise" style="animation-delay: 240ms">
      <div class="sec-head"><h2>补记其他日期</h2></div>
      <form class="grid2" data-backfill>
        <label class="field"><span>日期</span><input type="date" name="date" max="${todayStr()}" required></label>
        <label class="field"><span>体重 ${weightUnit()}</span><input type="number" name="weight" step="0.1" inputmode="decimal" required></label>
        <button type="submit" class="small" style="grid-column: 1 / -1; justify-self: start">保存</button>
      </form>
    </section>`;
  if (rows.length >= 2) mountWeightChart($view, rows);

  $view.querySelector('[data-backfill]').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/weights', { method: 'POST', body: { date: f.get('date'), kg: displayToKg(Number(f.get('weight'))) } });
    toast('已保存');
    refresh();
  }));
  $view.querySelectorAll('[data-del-weight]').forEach((b) =>
    b.addEventListener('click', () =>
      removeRow(b, { key: `weight:${b.dataset.delWeight}`, label: '已删除这条体重', path: `/weights/${b.dataset.delWeight}` }),
    ),
  );
}

// ---------- 我的 ----------
const RATE_OPTIONS = {
  cut: [[-0.0025, '慢：每周 −0.25%'], [-0.005, '标准：每周 −0.5%'], [-0.0075, '快：每周 −0.75%'], [-0.01, '很快：每周 −1%']],
  maintain: [[0, '保持体重']],
  bulk: [[0.001, '精益：每周 +0.1%'], [0.0025, '标准：每周 +0.25%'], [0.005, '快：每周 +0.5%']],
  recomp: [[-0.002, '轻微热量缺口'], [0, '维持热量']],
};

async function renderMe() {
  const [p, memory, condiments, status] = await Promise.all([api('/profile'), api('/memory'), api('/condiments'), api('/status')]);
  const e = p.energy;
  const goal = p.goal;
  const rate = p.goal_rate ?? p.goals[goal].weeklyRate;

  $view.innerHTML = `
    <header class="page-head rise"><div><span class="eyebrow">设置与档案</span><h1>我的</h1></div></header>
    ${!p.configured ? '<div class="banner rise">先填写下面的个人参数，保存后就能计算每日目标。</div>' : ''}
    <form class="sec stack rise" style="animation-delay: 60ms" data-profile>
      <h2>个人参数</h2>
      <div class="grid2">
        <label class="field"><span>性别</span><select name="sex"><option value="male" ${p.sex === 'male' ? 'selected' : ''}>男</option><option value="female" ${p.sex === 'female' ? 'selected' : ''}>女</option></select></label>
        <label class="field"><span>出生日期</span><input type="date" name="birth_date" value="${p.birth_date}" required></label>
        <label class="field"><span>身高 cm</span><input type="number" name="height_cm" step="0.1" inputmode="decimal" value="${p.height_cm}" required></label>
        <label class="field"><span>体脂率 %（可选）</span><input type="number" name="body_fat_pct" step="0.1" inputmode="decimal" value="${p.body_fat_pct ?? ''}"></label>
      </div>
      <label class="field"><span>日常活动水平（不含专门训练，训练单独记录）</span>
        <select name="activity_level">${Object.entries(p.activityLevels).map(([k, v]) => `<option value="${k}" ${p.activity_level === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
      </label>
      <h2 style="padding-top: 8px">当前目标</h2>
      <p class="meta">随时可以切换，每次切换都会记入历史。</p>
      <div class="goal-cards">${Object.entries(p.goals).map(([k, v]) => `<label><input type="radio" name="goal" value="${k}" ${goal === k ? 'checked' : ''}><span class="serif" style="font-weight: 600">${esc(v.label)}</span><div class="meta">蛋白 ${v.proteinPerKg} g/kg</div></label>`).join('')}</div>
      <label class="field"><span>速度</span>
        <select name="goal_rate">${RATE_OPTIONS[goal].map(([v, l]) => `<option value="${v}" ${Math.abs(v - rate) < 1e-6 ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </label>
      <label class="field"><span>运动消耗计入今日预算的比例</span>
        <select name="eat_back_ratio">${[[0, '不计入'], [0.5, '计入一半（推荐，估算普遍偏高）'], [1, '全部计入']].map(([v, l]) => `<option value="${v}" ${p.eat_back_ratio === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </label>
      <button type="submit" class="primary block">保存</button>
    </form>

    <section class="sec rise" style="animation-delay: 120ms">
      <div class="sec-head"><h2>重量单位</h2>${unitToggle()}</div>
      <p class="meta">体重和训练重量都按这里显示；数据统一按 kg 保存，随时切换不丢精度。</p>
    </section>

    <section class="sec rise" style="animation-delay: 180ms">
      <h2 style="margin-bottom: 10px">我的能量模型</h2>
      ${e.ready ? `
        <dl class="kv">
          <dt>当前体重（7 天平均）</dt><dd>${fmtWeight(e.weightKg)}</dd>
          <dt>基础代谢</dt><dd>${fmtInt(e.bmr)} kcal</dd>
          <dt>公式估算消耗</dt><dd>${fmtInt(e.formulaTdee)} kcal</dd>
          <dt>体重反推消耗</dt><dd>${e.adaptive ? `${fmtInt(e.adaptive.tdee)} kcal` : '数据不足'}</dd>
          <dt><strong>采用的每日消耗</strong></dt><dd><strong>${fmtInt(e.tdee)} kcal</strong></dd>
          <dt>每日目标热量</dt><dd>${fmtInt(e.targets.kcal)} kcal（${e.targets.deltaKcal >= 0 ? '+' : ''}${e.targets.deltaKcal}）</dd>
          <dt>蛋白 / 碳水 / 脂肪</dt><dd>${e.targets.protein} / ${e.targets.carbs} / ${e.targets.fat} g</dd>
        </dl>
        <p class="meta">${e.adaptive
          ? `最近 ${e.adaptive.days} 天体重变化约 ${kgToDisplay(e.adaptive.kgPerWeek).toFixed(2)} ${weightUnit()}/周，平均摄入 ${fmtInt(e.adaptive.avgIntake)} kcal。反推值权重 ${Math.round(e.adaptiveWeight * 100)}%，数据越多越依赖它。`
          : '需要至少 14 天体重记录，并且大部分日子都记了饮食，才能用真实数据校准。'}
          ${e.targets.flooredBySafety ? '目标已被安全下限（不低于基础代谢）托住。' : ''}</p>`
        : '<p class="meta">填写个人参数并称一次体重后显示。</p>'}
    </section>

    ${p.goalHistory.length ? `<section class="sec rise" style="animation-delay: 240ms"><h2 style="margin-bottom: 6px">目标历史</h2>
      <ol class="timeline">${p.goalHistory.map((g) => `<li class="tl-row" style="grid-template-columns: minmax(0, 1fr) auto"><span class="tl-title">${esc(p.goals[g.goal]?.label || g.goal)}</span><span class="meta">${g.start_date} 起</span></li>`).join('')}</ol></section>` : ''}

    <section class="sec rise" style="animation-delay: 300ms"><h2 style="margin-bottom: 6px">长期记忆 · 食物</h2>
      ${memory.length ? `<ol class="timeline">${memory.map((f) => `<li class="tl-row" style="grid-template-columns: minmax(0, 1fr) auto">
        <span class="tl-text"><span class="tl-title">${esc(f.name)}${f.aliases.length ? `<span class="meta" style="font-family: var(--font-sans); font-weight: 400"> ← ${esc(f.aliases.join('、'))}</span>` : ''}</span>
          <span class="tl-desc">每 100g：${r0(f.kcal_100g)} kcal · 蛋白 ${r1(f.protein_100g)} · 碳水 ${r1(f.carbs_100g)} · 脂肪 ${r1(f.fat_100g)}${f.typical_grams ? ` · 常吃 ${r0(f.typical_grams)}g` : ''}</span></span>
        <span class="meta">${f.use_count} 次</span></li>`).join('')}</ol>`
        : '<p class="meta">在记一餐时修改识别结果，修改会被记住并用于下次识别。</p>'}
    </section>

    <section class="sec rise" style="animation-delay: 360ms"><h2 style="margin-bottom: 10px">长期记忆 · 调料</h2>
      <div class="chips">${condiments.map((c) => `<span class="chip" style="cursor: default">${esc(c.name)} <span class="meta">${esc(c.unit)} ${r0(c.kcal)}kcal${c.use_count ? ` · ${c.use_count} 次` : ''}</span></span>`).join('')}</div>
    </section>

    <p class="meta" style="padding-top: 16px">识别模型：${status.ai.enabled ? esc(status.ai.model) : '未配置（演示模式）'}</p>`;

  const form = $view.querySelector('[data-profile]');
  form.addEventListener('change', (ev) => {
    if (ev.target.name !== 'goal') return;
    const g = ev.target.value;
    const def = p.goals[g].weeklyRate;
    form.goal_rate.innerHTML = RATE_OPTIONS[g].map(([v, l]) => `<option value="${v}" ${Math.abs(v - def) < 1e-6 ? 'selected' : ''}>${l}</option>`).join('');
  });
  form.addEventListener('submit', guard(async (ev) => {
    ev.preventDefault();
    await api('/profile', { method: 'PUT', body: Object.fromEntries(new FormData(form)) });
    haptic();
    toast('已保存');
    refresh();
  }));
}

// ---------- 路由 ----------
const ROUTES = { today: renderToday, meal: renderMeal, workout: renderWorkout, weight: renderWeight, me: renderMe };

async function route() {
  await flushDeletes();
  closeSheet();
  const name = currentRoute();
  const render = ROUTES[name] || renderToday;
  document.body.dataset.route = name;
  document.querySelectorAll('.tabbar a').forEach((a) => {
    const on = a.dataset.tab === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  await paint(async () => {
    await render();
    window.scrollTo(0, 0);
  }, { animate: true });
}

document.querySelector('.tabbar a[data-tab="today"]').addEventListener('click', (e) => {
  const wasOtherDay = state.date !== todayStr();
  state.date = todayStr();
  if (currentRoute() !== 'today') return;
  e.preventDefault();
  if (wasOtherDay) paint(renderToday, { animate: true });
  else window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
});

export function start() {
  window.addEventListener('hashchange', route);
  route();
}
