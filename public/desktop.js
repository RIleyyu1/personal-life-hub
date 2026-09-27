// 电脑端：只看数据，不做记录。选一个时间范围，热量、蛋白质、体重、训练一屏看完；点某天看当天明细。
import { api, esc, fmt1, fmtDate, fmtInt, fmtWeight, kgToDisplay, r0, r1, weightUnit } from './lib.js';
import { legend, mountChart, releaseCharts, weightTrendSpec } from './charts.js';

const $view = document.getElementById('view');
const RANGES = [
  [7, '近 7 天'],
  [30, '近 30 天'],
  [90, '近 90 天'],
];
const MEAL_LABEL = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };

let status = {};
let range = 30;
try {
  const saved = Number(localStorage.getItem('overviewRange'));
  if (RANGES.some(([n]) => n === saved)) range = saved;
} catch {
  // 无痕模式等情况下读不到本地存储，用默认 30 天
}

export function start(s) {
  status = s || {};
  document.title = '数据总览 · 个人生活助手';
  $view.addEventListener('click', onClick);
  render();
}

async function render() {
  // 刷新时保留上一次的画面并调淡，不闪白、不跳版
  $view.classList.add('loading');
  let o;
  try {
    o = await api(`/overview?days=${range}`);
  } catch (e) {
    $view.innerHTML = `<div class="card"><p>加载失败：${esc(e.message)}</p><button type="button" data-retry>重试</button></div>`;
    return;
  } finally {
    $view.classList.remove('loading');
  }
  releaseCharts($view);
  $view.innerHTML = page(o);
  mountCharts(o);
}

async function onClick(e) {
  const r = e.target.closest('[data-range]');
  if (r) {
    range = Number(r.dataset.range);
    try {
      localStorage.setItem('overviewRange', String(range));
    } catch {
      // 记不住选择也不影响使用
    }
    return render();
  }
  if (e.target.closest('[data-retry]')) return render();
  const row = e.target.closest('tr.day-row');
  if (row) return toggleDay(row);
}

// ---------- 页面 ----------
function page(o) {
  const s = o.summary;
  const hasData = s.loggedDays > 0 || s.workouts > 0 || o.days.some((d) => d.weight != null);
  const phone = status.phoneUrls?.[0];
  return `
    <header class="dk-head">
      <div>
        <h1>数据总览</h1>
        <p class="muted small">${fmtMD(o.from)} – ${fmtMD(o.to)} · 电脑端只用于查看，记录请在手机上完成${phone ? `（手机打开 <span class="num">${esc(phone)}</span>）` : ''}</p>
      </div>
      <div class="seg dk-range" role="group" aria-label="时间范围">${RANGES.map(
        ([n, label]) => `<button type="button" data-range="${n}" class="${n === range ? 'on' : ''}" aria-pressed="${n === range}">${label}</button>`,
      ).join('')}</div>
    </header>

    ${hasData ? '' : '<div class="banner">这段时间还没有数据。先在手机上记录几天，这里会自动汇总。</div>'}

    <section class="kpis" aria-label="汇总">${tiles(o)}</section>

    <div class="dk-grid">
      <figure class="card chart-card">
        <figcaption><h2>每日热量</h2>${legend([['bar', 'var(--viz-1)', '摄入'], ['line', 'var(--viz-ref)', '当日预算']])}</figcaption>
        <div data-chart="kcal"></div>
      </figure>
      <figure class="card chart-card">
        <figcaption><h2>体重（${weightUnit()}）</h2>${legend([['dot', 'var(--viz-muted)', '每日体重'], ['line', 'var(--viz-1)', '7 天平均']])}</figcaption>
        <div data-chart="weight"></div>
      </figure>
      <figure class="card chart-card">
        <figcaption><h2>每日蛋白质</h2>${legend([['bar', 'var(--viz-protein)', '摄入'], ['line', 'var(--viz-ref)', '目标']])}</figcaption>
        <div data-chart="protein"></div>
      </figure>
      <figure class="card chart-card">
        <figcaption><h2>力量训练组数</h2><span class="muted small">有氧共 ${fmtInt(s.cardioMinutes)} 分钟</span></figcaption>
        <div data-chart="muscles"></div>
      </figure>
    </div>

    <section class="card">
      <div class="row between wrap"><h2>每日明细</h2><span class="muted small">只列出有记录的日子，点一行查看当天吃了什么、练了什么</span></div>
      ${dayTable(o)}
    </section>

    <div class="dk-grid">
      <section class="card">${profileCard(o)}</section>
      <section class="card"><h2>个人纪录</h2>${recordsTable(o.records)}</section>
    </div>

    <section class="card"><h2>长期记忆 · 常吃食物</h2>${memoryTable(o.memory)}</section>`;
}

function tiles(o) {
  const s = o.summary;
  const e = o.energy;
  const u = weightUnit();
  const tile = (label, value, sub) =>
    `<div class="card tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div><div class="tile-sub">${sub}</div></div>`;
  const change = s.weightChange;
  const sign = change > 0 ? '+' : change < 0 ? '−' : '±';
  return [
    tile(
      '平均每日摄入',
      s.avgIntake == null ? '—' : `${fmtInt(s.avgIntake)}<small>kcal</small>`,
      `${s.avgBudget == null ? '' : `预算 ${fmtInt(s.avgBudget)} · `}记录了 ${s.loggedDays} / ${s.days} 天`,
    ),
    tile('热量达标', s.judgedDays ? `${s.onTargetDays}<small>/ ${s.judgedDays} 天</small>` : '—', '摄入在当日预算 ±10% 以内'),
    tile(
      '平均蛋白质',
      s.avgProtein == null ? '—' : `${fmtInt(s.avgProtein)}<small>g</small>`,
      s.avgProteinTarget == null ? '记录饮食后显示' : `目标 ${fmtInt(s.avgProteinTarget)} g · 达标 ${s.proteinOkDays} 天`,
    ),
    tile(
      '体重变化',
      change == null ? '—' : `${sign}${fmt1(Math.abs(kgToDisplay(change)))}<small>${u}</small>`,
      change == null ? '称重 2 天以上后显示' : `7 天平均 ${fmt1(kgToDisplay(s.weightStart))} → ${fmt1(kgToDisplay(s.weightEnd))}`,
    ),
    tile('训练', `${s.workouts}<small>次</small>`, `估算消耗 ${fmtInt(s.workoutKcal)} kcal`),
    tile(
      '当前每日消耗',
      e.ready ? `${fmtInt(e.tdee)}<small>kcal</small>` : '—',
      e.ready ? (e.adaptive ? `体重反推占 ${Math.round(e.adaptiveWeight * 100)}%` : '公式估算，数据够了会自动校准') : '在手机上填写档案并称重后显示',
    ),
  ].join('');
}

function mountCharts(o) {
  const days = o.days;
  const labels = days.map((d) => d.date.slice(5));
  const q = (name) => $view.querySelector(`[data-chart="${name}"]`);

  mountChart(q('kcal'), {
    type: 'columns',
    label: '每日热量：柱为摄入，线为当日预算。数值见下方每日明细表',
    empty: '这段时间还没有饮食记录',
    values: days.map((d) => d.intake.kcal),
    refs: days.map((d) => d.budget),
    labels,
    color: 'var(--viz-1)',
    tip: (i) => {
      const d = days[i];
      return {
        title: fmtDate(d.date),
        rows: [
          { key: 'bar', color: 'var(--viz-1)', value: d.meals ? `${fmtInt(d.intake.kcal)} kcal` : '未记录', label: '摄入' },
          d.budget != null && { key: 'line', color: 'var(--viz-ref)', value: `${fmtInt(d.budget)} kcal`, label: '当日预算' },
          d.workoutKcal > 0 && { key: 'none', color: 'transparent', value: `${fmtInt(d.workoutKcal)} kcal`, label: '训练消耗' },
        ].filter(Boolean),
      };
    },
  });

  mountChart(q('weight'), weightTrendSpec(days));

  mountChart(q('protein'), {
    type: 'columns',
    label: '每日蛋白质：柱为摄入，线为目标。数值见下方每日明细表',
    empty: '这段时间还没有饮食记录',
    values: days.map((d) => d.intake.protein),
    refs: days.map((d) => d.target?.protein ?? null),
    labels,
    color: 'var(--viz-protein)',
    tip: (i) => {
      const d = days[i];
      return {
        title: fmtDate(d.date),
        rows: [
          { key: 'bar', color: 'var(--viz-protein)', value: d.meals ? `${r0(d.intake.protein)} g` : '未记录', label: '摄入' },
          d.target && { key: 'line', color: 'var(--viz-ref)', value: `${d.target.protein} g`, label: '目标' },
        ].filter(Boolean),
      };
    },
  });

  const totalSets = o.muscles.reduce((s, m) => s + m.sets, 0);
  mountChart(q('muscles'), {
    type: 'hbars',
    label: '按部位统计的力量训练组数',
    empty: '这段时间没有力量训练',
    items: totalSets ? o.muscles.map((m) => ({ label: m.muscle, value: m.sets })) : [],
    color: 'var(--viz-1)',
    suffix: '组',
  });
}

// ---------- 每日明细（也是上面三张图的表格版） ----------
function dayTable(o) {
  const rows = o.days.filter((d) => d.meals || d.workouts || d.weight != null).reverse();
  if (!rows.length) return '<p class="muted small">还没有记录。</p>';
  const u = weightUnit();
  const diff = (d) => {
    if (!d.meals || d.budget == null) return '';
    const v = d.intake.kcal - d.budget;
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtInt(Math.abs(v))}`;
  };
  return `<div class="table-wrap"><table class="table">
    <thead><tr>
      <th scope="col">日期</th><th scope="col">摄入 kcal</th><th scope="col">当日预算</th><th scope="col">差值</th>
      <th scope="col">蛋白 g</th><th scope="col">碳水 g</th><th scope="col">脂肪 g</th><th scope="col">训练 kcal</th><th scope="col">体重 ${u}</th>
    </tr></thead>
    <tbody>${rows
      .map(
        (d) => `<tr class="day-row" data-date="${d.date}">
          <th scope="row"><button type="button" class="day-toggle" aria-expanded="false">${fmtDate(d.date)}</button></th>
          <td>${d.meals ? fmtInt(d.intake.kcal) : '<span class="muted">未记录</span>'}</td>
          <td>${d.budget == null ? '—' : fmtInt(d.budget)}</td>
          <td>${diff(d)}</td>
          <td>${d.meals ? r0(d.intake.protein) : ''}</td>
          <td>${d.meals ? r0(d.intake.carbs) : ''}</td>
          <td>${d.meals ? r0(d.intake.fat) : ''}</td>
          <td>${d.workouts ? fmtInt(d.workoutKcal) : ''}</td>
          <td>${d.weight == null ? '' : fmt1(kgToDisplay(d.weight))}</td>
        </tr>`,
      )
      .join('')}</tbody>
  </table></div>`;
}

async function toggleDay(row) {
  const btn = row.querySelector('.day-toggle');
  const next = row.nextElementSibling;
  if (next?.classList.contains('day-detail')) {
    next.remove();
    btn.setAttribute('aria-expanded', 'false');
    return;
  }
  btn.setAttribute('aria-expanded', 'true');
  const detail = document.createElement('tr');
  detail.className = 'day-detail';
  detail.innerHTML = `<td colspan="9"><p class="muted small">加载中…</p></td>`;
  row.after(detail);
  try {
    const d = await api(`/dashboard?date=${row.dataset.date}`);
    detail.firstElementChild.innerHTML = dayDetail(d);
  } catch (e) {
    detail.firstElementChild.innerHTML = `<p class="muted small">加载失败：${esc(e.message)}</p>`;
  }
}

function dayDetail(d) {
  const u = weightUnit();
  const meals = d.meals.length
    ? `<div class="meal-cards">${d.meals
        .map((m) => {
          const items = m.items
            .map(
              (i) => `<li><span>${esc(i.name)}${i.source === 'condiment' ? ` ×${i.quantity}` : i.grams ? ` <span class="muted">${r0(i.grams)}g</span>` : ''}</span><span class="num">${fmtInt(i.kcal)}</span></li>`,
            )
            .join('');
          return `<article class="meal-card">
            ${m.photo ? `<img src="/photos/${esc(m.photo)}" alt="${MEAL_LABEL[m.meal_type]}照片" loading="lazy">` : ''}
            <div class="meal-card-body">
              <div class="row between"><strong>${MEAL_LABEL[m.meal_type]}${m.time ? ` <span class="muted small">${esc(m.time)}</span>` : ''}</strong><span class="num">${fmtInt(m.totals.kcal)} kcal</span></div>
              <div class="small muted">蛋白 ${r0(m.totals.protein)}g · 碳水 ${r0(m.totals.carbs)}g · 脂肪 ${r0(m.totals.fat)}g</div>
              <ul class="item-list small">${items}</ul>
              ${m.note ? `<p class="small muted">${esc(m.note)}</p>` : ''}
            </div>
          </article>`;
        })
        .join('')}</div>`
    : '<p class="muted small">这天没有饮食记录。</p>';
  const setText = (e) =>
    e.sets.length
      ? `${e.sets.map((s) => `${s.reps ?? '–'}×${s.weight_kg ? r1(kgToDisplay(s.weight_kg)) : '自重'}`).join('、')}${e.sets.some((s) => s.weight_kg) ? ` ${u}` : ''}`
      : e.duration_min
        ? `${r0(e.duration_min)} 分钟`
        : '';
  const workouts = d.workouts.length
    ? d.workouts
        .map(
          (w) => `<div class="workout-block">
            <div class="row between"><strong>${w.duration_min ? `${r0(w.duration_min)} 分钟` : '训练'}${w.rpe ? ` · 强度 ${w.rpe}/10` : ''}</strong><span class="num">${fmtInt(w.kcal)} kcal</span></div>
            <ul class="item-list small">${w.entries.map((e) => `<li><span>${esc(e.name)}</span><span class="num muted">${setText(e)}</span></li>`).join('')}</ul>
            ${w.note ? `<p class="small muted">${esc(w.note)}</p>` : ''}
          </div>`,
        )
        .join('')
    : '<p class="muted small">这天没有训练。</p>';
  return `<div class="detail-grid"><div><h3>饮食</h3>${meals}</div><div><h3>训练</h3>${workouts}</div></div>`;
}

// ---------- 档案、纪录、记忆（只读） ----------
function profileCard(o) {
  const e = o.energy;
  const p = e.profile;
  if (!p.configured) return '<h2>档案与目标</h2><p class="muted small">还没有填写个人参数，请在手机「我的」页面填写。</p>';
  return `<h2>档案与目标</h2>
    <dl class="kv">
      <dt>当前目标</dt><dd>${esc(o.goals[e.goal ?? p.goal]?.label)}</dd>
      <dt>身高</dt><dd>${r1(p.height_cm)} cm</dd>
      <dt>日常活动</dt><dd>${esc(o.activityLevels[p.activity_level]?.label)}</dd>
      ${e.ready
        ? `<dt>当前体重（7 天平均）</dt><dd>${fmtWeight(e.weightKg)}</dd>
          <dt>基础代谢</dt><dd>${fmtInt(e.bmr)} kcal</dd>
          <dt>公式估算消耗</dt><dd>${fmtInt(e.formulaTdee)} kcal</dd>
          <dt>体重反推消耗</dt><dd>${e.adaptive ? `${fmtInt(e.adaptive.tdee)} kcal` : '数据不足'}</dd>
          <dt>每日目标</dt><dd>${fmtInt(e.targets.kcal)} kcal · 蛋白 ${e.targets.protein} g</dd>`
        : ''}
    </dl>
    ${o.goalHistory.length ? `<h3>目标历史</h3><ul class="plain small">${o.goalHistory.map((g) => `<li>${esc(o.goals[g.goal]?.label || g.goal)} <span class="muted">${g.start_date} 起</span></li>`).join('')}</ul>` : ''}
    <p class="muted small">修改档案和目标请在手机「我的」页面进行。</p>`;
}

function recordsTable(records) {
  if (!records.length) return '<p class="muted small">还没有力量训练记录。</p>';
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th scope="col">动作</th><th scope="col">最大重量</th><th scope="col">估算 1RM</th></tr></thead>
    <tbody>${records.map((r) => `<tr><th scope="row">${esc(r.name)}</th><td>${fmtWeight(r.max_weight)}</td><td>${fmtWeight(r.e1rm)}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function memoryTable(memory) {
  if (!memory.length) return '<p class="muted small">在手机上修改识别结果后，改过的食物会记在这里，下次识别时参考。</p>';
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th scope="col">食物</th><th scope="col" class="l">曾被识别为</th><th scope="col">每 100g 热量</th><th scope="col">蛋白 g</th><th scope="col">常吃份量</th><th scope="col">次数</th></tr></thead>
    <tbody>${memory
      .map(
        (f) => `<tr><th scope="row">${esc(f.name)}</th><td class="l muted">${esc(f.aliases.join('、'))}</td><td>${fmtInt(f.kcal_100g)} kcal</td>
          <td>${r1(f.protein_100g)}</td><td>${f.typical_grams ? `${r0(f.typical_grams)} g` : ''}</td><td>${f.use_count}</td></tr>`,
      )
      .join('')}</tbody>
  </table></div>`;
}

function fmtMD(d) {
  const [, m, day] = d.split('-').map(Number);
  return `${m}月${day}日`;
}
