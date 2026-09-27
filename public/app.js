// 单页应用：hash 路由 + 原生 DOM，无构建步骤。

const $view = document.getElementById('view');
const MEAL_LABEL = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };
const CONF_LABEL = { high: '把握较大', medium: '中等把握', low: '把握较小' };

const state = {
  date: todayStr(),
  status: null,
  mealDraft: null, // 记一餐的编辑中数据
  workoutDraft: null,
};

// ---------- 工具 ----------
function todayStr() {
  return new Date().toLocaleDateString('sv');
}
function shiftDate(d, n) {
  const x = new Date(d + 'T12:00:00');
  x.setDate(x.getDate() + n);
  return x.toLocaleDateString('sv');
}
function fmtDate(d) {
  if (d === todayStr()) return '今天';
  if (d === shiftDate(todayStr(), -1)) return '昨天';
  const x = new Date(d + 'T12:00:00');
  return `${x.getMonth() + 1}月${x.getDate()}日 周${'日一二三四五六'[x.getDay()]}`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const r0 = (n) => Math.round(Number(n) || 0);
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      toast(e.message);
    }
  };
}

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

function dateBar(onChange) {
  const el = document.createElement('div');
  el.className = 'datebar';
  el.innerHTML = `
    <button class="ghost" data-d="-1" aria-label="前一天">‹</button>
    <strong>${fmtDate(state.date)}</strong>
    <button class="ghost" data-d="1" aria-label="后一天" ${state.date >= todayStr() ? 'disabled' : ''}>›</button>`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-d]');
    if (!b) return;
    state.date = shiftDate(state.date, Number(b.dataset.d));
    onChange();
  });
  return el;
}

function macroBar(label, value, target, color, unit = 'g') {
  const pct = target ? Math.min(100, (value / target) * 100) : 0;
  return `<div class="macro">
    <div class="row between"><span>${label}</span><span class="num">${r0(value)} / ${r0(target)} ${unit}</span></div>
    <div class="bar"><i style="width:${pct}%;background:${color}"></i></div>
  </div>`;
}

function ring(eaten, budget) {
  const r = 54;
  const c = 2 * Math.PI * r;
  const pct = budget ? Math.min(1, eaten / budget) : 0;
  const over = eaten > budget;
  const left = budget - eaten;
  return `<svg class="ring" viewBox="0 0 132 132" role="img" aria-label="剩余 ${r0(left)} 千卡">
    <circle cx="66" cy="66" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="12"/>
    <circle cx="66" cy="66" r="${r}" fill="none" stroke="${over ? 'var(--warn)' : 'var(--accent)'}" stroke-width="12"
      stroke-linecap="round" stroke-dasharray="${c * pct} ${c}" transform="rotate(-90 66 66)"/>
    <text x="66" y="62" text-anchor="middle" font-size="24" font-weight="700">${r0(Math.abs(left))}</text>
    <text x="66" y="84" text-anchor="middle" font-size="12" style="fill:var(--muted)">${over ? '已超出 kcal' : '剩余 kcal'}</text>
  </svg>`;
}

function weightChart(rows) {
  if (rows.length < 2) return '<p class="muted small">记录 2 天以上体重后显示趋势图。</p>';
  const W = 600;
  const H = 180;
  const pad = { l: 36, r: 8, t: 10, b: 22 };
  const all = rows.flatMap((r) => [r.kg, r.avg]);
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (max - min < 1) { min -= 0.5; max += 0.5; }
  const t0 = new Date(rows[0].date).getTime();
  const t1 = new Date(rows.at(-1).date).getTime();
  const x = (d) => pad.l + ((new Date(d).getTime() - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);
  const ticks = [min, (min + max) / 2, max];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="体重趋势">
    ${ticks.map((v) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="2" y="${y(v) + 4}">${r1(v)}</text>`).join('')}
    ${rows.map((r) => `<circle class="raw" cx="${x(r.date)}" cy="${y(r.kg)}" r="3"/>`).join('')}
    <polyline class="avg" points="${rows.map((r) => `${x(r.date)},${y(r.avg)}`).join(' ')}"/>
    <text x="${pad.l}" y="${H - 4}">${rows[0].date.slice(5)}</text>
    <text x="${W - pad.r}" y="${H - 4}" text-anchor="end">${rows.at(-1).date.slice(5)}</text>
  </svg>
  <p class="muted small">点 = 每日体重，线 = 7 天平均（看这条线，不看单日）</p>`;
}

// ---------- 今天 ----------
async function renderToday() {
  const d = await api(`/dashboard?date=${state.date}`);
  $view.innerHTML = '';
  $view.append(dateBar(renderToday));
  const m = d.model;
  const wrap = document.createElement('div');

  if (m.ready) {
    const t = m.targets;
    wrap.innerHTML += `
      <section class="card">
        <div class="energy">
          ${ring(d.intake.kcal, d.budget)}
          <dl class="num grow">
            <dt>基础目标</dt><dd>${t.kcal}</dd>
            <dt>运动 +${r0(d.workoutKcal * m.profile.eat_back_ratio)}</dt><dd class="muted">消耗 ${r0(d.workoutKcal)}</dd>
            <dt>今日预算</dt><dd>${d.budget}</dd>
            <dt>已吃</dt><dd>${r0(d.intake.kcal)}</dd>
          </dl>
        </div>
      </section>
      <section class="card">
        ${macroBar('蛋白质', d.intake.protein, t.protein, 'var(--protein)')}
        ${macroBar('碳水', d.intake.carbs, t.carbs, 'var(--carbs)')}
        ${macroBar('脂肪', d.intake.fat, t.fat, 'var(--fat)')}
        ${macroBar('膳食纤维', d.intake.fiber, t.fiber, 'var(--fiber)')}
        <p class="muted small" style="margin-top:10px">饮水建议约 ${t.waterMl} ml · 目标：${esc(m.profile.goal && ({ cut: '减脂', maintain: '维持', bulk: '增肌', recomp: '重组' })[m.profile.goal])}</p>
      </section>`;
  }

  if (d.tips.length) {
    wrap.innerHTML += `<section class="card"><h2>建议</h2><ul class="tips">${d.tips.map((t) => `<li class="${t.level}">${esc(t.text)}</li>`).join('')}</ul></section>`;
  }

  wrap.innerHTML += `
    <section class="card">
      <div class="row between"><h2>饮食</h2><a class="btn small primary" href="#/meal">＋ 记一餐</a></div>
      ${d.meals.length ? `<ul class="list">${d.meals.map(mealRow).join('')}</ul>` : '<p class="muted small">还没有记录。</p>'}
    </section>
    <section class="card">
      <div class="row between"><h2>训练</h2><a class="btn small" href="#/workout">＋ 记训练</a></div>
      ${d.workouts.length ? `<ul class="list">${d.workouts.map(workoutRow).join('')}</ul>` : '<p class="muted small">今天没有训练记录。</p>'}
    </section>
    <section class="card">
      <div class="row between"><h2>体重</h2><a class="btn small" href="#/weight">记录</a></div>
      ${weightChart(d.weights.slice(-30))}
    </section>`;
  $view.append(wrap);

  wrap.addEventListener('click', guard(async (e) => {
    const del = e.target.closest('[data-del-meal],[data-del-workout]');
    if (!del || !confirm('确定删除这条记录？')) return;
    if (del.dataset.delMeal) await api(`/meals/${del.dataset.delMeal}`, { method: 'DELETE' });
    else await api(`/workouts/${del.dataset.delWorkout}`, { method: 'DELETE' });
    toast('已删除');
    renderToday();
  }));
}

function mealRow(meal) {
  const names = meal.items.filter((i) => i.source !== 'condiment').map((i) => i.name).join('、');
  const conds = meal.items.filter((i) => i.source === 'condiment').map((i) => `${i.name}×${i.quantity}`).join('、');
  return `<li>
    ${meal.photo ? `<img class="thumb" src="/photos/${esc(meal.photo)}" alt="" loading="lazy">` : '<div class="thumb"></div>'}
    <div class="grow">
      <div class="row between"><strong>${MEAL_LABEL[meal.meal_type]}${meal.time ? ` <span class="muted small">${esc(meal.time)}</span>` : ''}</strong><span class="num">${r0(meal.totals.kcal)} kcal</span></div>
      <div class="small muted">${esc(names)}${conds ? ` · 调料：${esc(conds)}` : ''}</div>
      <div class="small muted num">蛋白 ${r0(meal.totals.protein)}g · 碳水 ${r0(meal.totals.carbs)}g · 脂肪 ${r0(meal.totals.fat)}g</div>
    </div>
    <button class="ghost small" data-del-meal="${meal.id}" aria-label="删除">✕</button>
  </li>`;
}

function workoutRow(w) {
  return `<li>
    <div class="grow">
      <div class="row between"><strong>${w.entries.map((e) => esc(e.name)).join('、')}</strong><span class="num">${r0(w.kcal)} kcal</span></div>
      <div class="small muted">${w.duration_min ? `${r0(w.duration_min)} 分钟` : ''}${w.rpe ? ` · 强度 ${w.rpe}/10` : ''}${w.note ? ` · ${esc(w.note)}` : ''}</div>
    </div>
    <button class="ghost small" data-del-workout="${w.id}" aria-label="删除">✕</button>
  </li>`;
}

// ---------- 记一餐 ----------
async function renderMeal() {
  const condiments = await api('/condiments');
  state.mealDraft ??= newMealDraft();
  const draft = state.mealDraft;
  draft.condimentList = condiments;
  drawMeal();
}

function newMealDraft() {
  return {
    date: state.date,
    time: new Date().toTimeString().slice(0, 5),
    meal_type: defaultMealType(),
    image: null,
    photo: null,
    note: '',
    analysis: null,
    items: [],
    condiments: {}, // id -> quantity
    analyzing: false,
    portion: 1,
  };
}

function drawMeal() {
  const d = state.mealDraft;
  const totals = mealTotals(d);
  const hasResult = d.analysis || d.items.length;

  $view.innerHTML = `
    <h1>记一餐</h1>
    ${d.analysis?.demo ? `<div class="banner">${esc(d.analysis.notes)} 在项目根目录的 .env 里填入 ANTHROPIC_API_KEY 后重启即可使用真实识别。</div>` : ''}
    <section class="card">
      ${d.image
        ? `<img class="photo-preview" src="${d.image}" alt="餐食照片">
           <div class="row" style="margin-top:10px">
             <label class="btn small file-btn">重拍<input type="file" accept="image/*" capture="environment" data-photo></label>
             <label class="btn small file-btn">从相册换一张<input type="file" accept="image/*" data-photo></label>
           </div>`
        : `<div class="photo-drop">
             <p class="muted">俯拍整份餐食，旁边放双筷子或手做参照，份量估得更准</p>
             <label class="btn primary file-btn">📷 拍照<input type="file" accept="image/*" capture="environment" data-photo></label>
             <label class="btn small file-btn">从相册选择<input type="file" accept="image/*" data-photo></label>
           </div>`}
      <label class="field" style="margin-top:10px"><span>补充说明（可选）：比如"只吃了一半""少油""外卖"</span>
        <input data-f="note" value="${esc(d.note)}" placeholder="会一起发给识别模型">
      </label>
      ${d.image ? `<button class="primary block" style="margin-top:10px" data-act="analyze" ${d.analyzing ? 'disabled' : ''}>
        ${d.analyzing ? '<span class="spinner"></span> 识别中…' : hasResult ? '重新识别' : '识别热量'}</button>` : ''}
    </section>

    ${hasResult ? `
    <section class="card">
      ${d.analysis ? `<div class="row between wrap" style="margin-bottom:6px">
          <h2 style="margin:0">识别结果</h2>
          <span class="pill">${CONF_LABEL[d.analysis.confidence] || ''} · 约 ${r0(d.analysis.kcal_low)}–${r0(d.analysis.kcal_high)} kcal</span>
        </div>
        ${d.analysis.notes && !d.analysis.demo ? `<p class="muted small">${esc(d.analysis.notes)}</p>` : ''}
        <div class="row" style="margin:8px 0"><span class="small muted">整体份量</span>
          <div class="seg grow">${[0.5, 0.75, 1, 1.25, 1.5].map((p) => `<button data-portion="${p}" class="${d.portion === p ? 'on' : ''}">${p}×</button>`).join('')}</div>
        </div>` : '<h2>食物</h2>'}
      <div data-items>${d.items.map(itemRow).join('')}</div>
      <button class="small" data-act="add-item">＋ 添加食物</button>
      <p class="muted small" style="margin-top:8px">改过的名称或数值会存进长期记忆，下次识别同样的菜会参考。</p>
    </section>` : ''}

    <section class="card">
      <h2>调料 / 隐形热量</h2>
      <p class="muted small">点一下 +1，常用的会自动排到前面。</p>
      <div class="chips">${d.condimentList.map((c) => {
        const q = d.condiments[c.id] || 0;
        return `<span class="chip ${q ? 'on' : ''}" data-cond="${c.id}" role="button" tabindex="0">${esc(c.name)}${q ? ` ×${q}` : ''}
          ${q ? `<button class="x" data-cond-minus="${c.id}" aria-label="减少">−</button>` : ''}</span>`;
      }).join('')}
        <span class="chip" data-act="new-cond" role="button" tabindex="0">＋ 自定义</span>
      </div>
      <div data-newcond hidden style="margin-top:10px">
        <div class="grid2">
          <label class="field"><span>名称</span><input data-nc="name" placeholder="如：老干妈"></label>
          <label class="field"><span>单位</span><input data-nc="unit" placeholder="勺(15g)"></label>
          <label class="field"><span>每单位热量 kcal</span><input data-nc="kcal" type="number" inputmode="decimal"></label>
          <label class="field"><span>脂肪 g</span><input data-nc="fat" type="number" inputmode="decimal"></label>
        </div>
        <button class="small" style="margin-top:8px" data-act="save-cond">保存调料</button>
      </div>
    </section>

    <section class="card">
      <div class="grid2">
        <label class="field"><span>餐次</span>
          <select data-f="meal_type">${Object.entries(MEAL_LABEL).map(([k, v]) => `<option value="${k}" ${d.meal_type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </label>
        <label class="field"><span>时间</span><input type="time" data-f="time" value="${esc(d.time)}"></label>
      </div>
      <label class="field" style="margin-top:10px"><span>日期</span><input type="date" data-f="date" value="${d.date}" max="${todayStr()}"></label>
      <div class="row between" style="margin-top:12px">
        <div class="num"><strong>${r0(totals.kcal)} kcal</strong>
          <div class="small muted">蛋白 ${r0(totals.protein)}g · 碳水 ${r0(totals.carbs)}g · 脂肪 ${r0(totals.fat)}g</div></div>
        <button class="primary" data-act="save" ${totals.kcal > 0 ? '' : 'disabled'}>保存这餐</button>
      </div>
      <button class="ghost small block" data-act="reset">清空重来</button>
    </section>`;
}

function itemRow(it, idx) {
  const f = (k, label) => `<label class="field"><span>${label}</span><input type="number" inputmode="decimal" data-item="${idx}" data-k="${k}" value="${r1(it[k])}"></label>`;
  return `<div class="item-row">
    <div class="row">
      <input class="grow" data-item="${idx}" data-k="name" value="${esc(it.name)}" aria-label="食物名">
      <input style="width:84px" type="number" inputmode="decimal" data-item="${idx}" data-k="grams" value="${r0(it.grams)}" aria-label="克">
      <span class="small muted">g</span>
      <button class="ghost small" data-del-item="${idx}" aria-label="删除">✕</button>
    </div>
    <div class="macros">${f('kcal', '热量')}${f('protein', '蛋白')}${f('carbs', '碳水')}${f('fat', '脂肪')}</div>
  </div>`;
}

function mealTotals(d) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const i of d.items) for (const k in t) t[k] += Number(i[k]) || 0;
  for (const c of d.condimentList || []) {
    const q = d.condiments[c.id] || 0;
    for (const k in t) t[k] += (c[k] || 0) * q;
  }
  return t;
}

const NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat', 'fiber'];

function scaleItem(it, factor) {
  it.grams = (Number(it.grams) || 0) * factor;
  for (const k of NUTRIENTS) it[k] = (Number(it[k]) || 0) * factor;
}

$view.addEventListener('change', guard(async (e) => {
  if (location.hash !== '#/meal') return;
  const d = state.mealDraft;
  if (e.target.matches('[data-photo]')) {
    const file = e.target.files?.[0];
    if (!file) return;
    d.image = await resizeImage(file);
    d.analysis = null;
    d.items = [];
    d.photo = null;
    drawMeal();
    return analyze();
  }
}));

$view.addEventListener('input', (e) => {
  if (location.hash !== '#/meal') return;
  const d = state.mealDraft;
  const t = e.target;
  if (t.dataset.f) {
    d[t.dataset.f] = t.value;
    return;
  }
  if (t.dataset.item !== undefined) {
    const it = d.items[Number(t.dataset.item)];
    const k = t.dataset.k;
    it.edited = true;
    if (k === 'name') {
      it.name = t.value;
      return;
    }
    const v = Number(t.value) || 0;
    // 改重量时按比例联动营养素，改营养素则只改那一项
    if (k === 'grams' && it.grams > 0) {
      const f = v / it.grams;
      for (const n of NUTRIENTS) it[n] = (Number(it[n]) || 0) * f;
      it.grams = v;
      const row = t.closest('.item-row');
      for (const n of ['kcal', 'protein', 'carbs', 'fat']) row.querySelector(`[data-k="${n}"]`).value = r1(it[n]);
    } else {
      it[k] = v;
    }
    updateMealTotals();
  }
});

function updateMealTotals() {
  const t = mealTotals(state.mealDraft);
  const box = $view.querySelector('[data-act="save"]')?.previousElementSibling;
  if (box) box.innerHTML = `<strong>${r0(t.kcal)} kcal</strong><div class="small muted">蛋白 ${r0(t.protein)}g · 碳水 ${r0(t.carbs)}g · 脂肪 ${r0(t.fat)}g</div>`;
  const save = $view.querySelector('[data-act="save"]');
  if (save) save.disabled = !(t.kcal > 0);
}

$view.addEventListener('click', guard(async (e) => {
  if (location.hash !== '#/meal') return;
  const d = state.mealDraft;
  const t = e.target;

  const minus = t.closest('[data-cond-minus]');
  if (minus) {
    e.stopPropagation();
    const id = minus.dataset.condMinus;
    d.condiments[id] = Math.max(0, (d.condiments[id] || 0) - 1);
    return drawMeal();
  }
  const chip = t.closest('[data-cond]');
  if (chip) {
    const id = chip.dataset.cond;
    d.condiments[id] = (d.condiments[id] || 0) + 1;
    return drawMeal();
  }
  const portion = t.closest('[data-portion]');
  if (portion) {
    const p = Number(portion.dataset.portion);
    const factor = p / d.portion;
    d.items.filter((i) => i.source === 'ai').forEach((i) => scaleItem(i, factor));
    d.portion = p;
    return drawMeal();
  }
  const delItem = t.closest('[data-del-item]');
  if (delItem) {
    d.items.splice(Number(delItem.dataset.delItem), 1);
    return drawMeal();
  }

  switch (t.closest('[data-act]')?.dataset.act) {
    case 'analyze':
      return analyze();
    case 'add-item':
      d.items.push({ name: '', grams: 100, kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, source: 'user', edited: true });
      return drawMeal();
    case 'new-cond':
      $view.querySelector('[data-newcond]').hidden = false;
      return;
    case 'save-cond': {
      const val = (k) => $view.querySelector(`[data-nc="${k}"]`).value;
      const c = await api('/condiments', { method: 'POST', body: { name: val('name'), unit: val('unit') || '份', kcal: val('kcal'), fat: val('fat') || 0 } });
      d.condimentList = await api('/condiments');
      d.condiments[c.id] = (d.condiments[c.id] || 0) + 1;
      toast('已加入调料库');
      return drawMeal();
    }
    case 'reset':
      state.mealDraft = newMealDraft();
      state.mealDraft.condimentList = d.condimentList;
      return drawMeal();
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
      await api('/meals', { method: 'POST', body });
      state.date = d.date;
      state.mealDraft = null;
      toast('已保存');
      location.hash = '#/today';
    }
  }
}));

async function analyze() {
  const d = state.mealDraft;
  d.analyzing = true;
  drawMeal();
  try {
    const { photo, analysis } = await api('/meals/analyze', { method: 'POST', body: { image: d.image, note: d.note } });
    d.photo = photo;
    d.analysis = analysis;
    d.portion = 1;
    if (!analysis.is_food) toast('这张照片看起来不是食物');
    d.items = analysis.items.map((i) => ({ ...i, source: 'ai', ai_name: i.name, edited: false }));
  } finally {
    d.analyzing = false;
    if (location.hash === '#/meal') drawMeal();
  }
}

// ---------- 训练 ----------
let exerciseCache;
let workoutHistory = [];
let workoutRecords = [];
async function renderWorkout() {
  exerciseCache ??= await api('/exercises');
  [workoutHistory, workoutRecords] = await Promise.all([api('/workouts?days=30'), api('/records')]);
  state.workoutDraft ??= { date: state.date, entries: [], duration_min: '', rpe: '', note: '' };
  drawWorkout();
}

function drawWorkout() {
  const w = state.workoutDraft;
  const history = workoutHistory;
  const records = workoutRecords;
  const byMuscle = Object.groupBy ? Object.groupBy(exerciseCache, (x) => x.muscle) : groupBy(exerciseCache, (x) => x.muscle);
  const exName = (id) => exerciseCache.find((x) => x.id === Number(id));

  $view.innerHTML = `
    <h1>训练</h1>
    <section class="card stack">
      <div class="row">
        <select class="grow" data-pick>
          <option value="">＋ 选择动作…</option>
          ${Object.entries(byMuscle).map(([m, list]) => `<optgroup label="${esc(m)}">${list.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</optgroup>`).join('')}
        </select>
        <button class="small" data-act="custom-ex">自定义</button>
      </div>
      <div data-custom hidden class="grid2">
        <label class="field"><span>动作名</span><input data-cx="name"></label>
        <label class="field"><span>类型</span><select data-cx="kind"><option value="strength">力量</option><option value="cardio">有氧</option></select></label>
        <label class="field"><span>部位</span><select data-cx="muscle">${['胸', '背', '腿', '肩', '手臂', '核心', '有氧', '其他'].map((m) => `<option>${m}</option>`).join('')}</select></label>
        <div class="field" style="align-self:end"><button class="small block" data-act="save-ex">添加到动作库</button></div>
      </div>

      ${w.entries.map((en, i) => {
        const ex = exName(en.exercise_id);
        return `<div class="card" style="margin:0">
          <div class="row between"><strong>${esc(ex.name)}</strong><button class="ghost small" data-del-entry="${i}" aria-label="删除">✕</button></div>
          ${ex.kind === 'cardio'
            ? `<label class="field"><span>时长（分钟）</span><input type="number" inputmode="decimal" data-en="${i}" data-k="duration_min" value="${esc(en.duration_min)}"></label>`
            : `<div class="set-row small muted"><span>组</span><span>次数</span><span>重量 kg</span><span></span></div>
               ${en.sets.map((s, j) => `<div class="set-row">
                 <span class="muted num">${j + 1}</span>
                 <input type="number" inputmode="numeric" data-en="${i}" data-set="${j}" data-k="reps" value="${esc(s.reps)}">
                 <input type="number" inputmode="decimal" data-en="${i}" data-set="${j}" data-k="weight_kg" value="${esc(s.weight_kg)}">
                 <button class="ghost small" data-del-set="${i}:${j}" aria-label="删除这组">✕</button></div>`).join('')}
               <button class="small" style="margin-top:8px" data-add-set="${i}">＋ 加一组</button>`}
        </div>`;
      }).join('')}

      ${w.entries.length ? `
      <div class="grid2">
        <label class="field"><span>总时长（分钟，可选）</span><input type="number" inputmode="decimal" data-w="duration_min" value="${esc(w.duration_min)}"></label>
        <label class="field"><span>主观强度 1–10（可选）</span><input type="number" inputmode="numeric" min="1" max="10" data-w="rpe" value="${esc(w.rpe)}"></label>
      </div>
      <label class="field"><span>日期</span><input type="date" data-w="date" value="${w.date}" max="${todayStr()}"></label>
      <label class="field"><span>备注</span><input data-w="note" value="${esc(w.note)}"></label>
      <button class="primary block" data-act="save-workout">保存训练</button>
      <p class="muted small">消耗按 MET 公式估算（力量训练没填时长时按每组 2.5 分钟算），只是粗略参考。</p>` : '<p class="muted small">选择动作开始记录。力量训练按组记次数和重量，有氧记时长。</p>'}
    </section>

    ${records.length ? `<section class="card"><h2>个人纪录</h2>
      <ul class="list">${records.map((r) => `<li><span class="grow">${esc(r.name)}</span><span class="num small">最大 ${r1(r.max_weight)}kg · 估算 1RM ${r.e1rm}kg</span></li>`).join('')}</ul></section>` : ''}

    <section class="card"><h2>最近 30 天</h2>
      ${history.length ? `<ul class="list">${history.map((h) => `<li><div class="grow"><div class="row between"><strong>${fmtDate(h.date)}</strong><span class="num">${r0(h.kcal)} kcal</span></div>
        <div class="small muted">${h.entries.map((e) => `${esc(e.name)}${e.sets.length ? ` ${e.sets.length}组` : e.duration_min ? ` ${r0(e.duration_min)}分钟` : ''}`).join('、')}</div></div></li>`).join('')}</ul>`
        : '<p class="muted small">还没有训练记录。</p>'}
    </section>`;
}

function groupBy(arr, fn) {
  return arr.reduce((acc, x) => ((acc[fn(x)] ??= []).push(x), acc), {});
}

$view.addEventListener('change', (e) => {
  if (location.hash !== '#/workout') return;
  const t = e.target;
  if (t.matches('[data-pick]') && t.value) {
    const ex = exerciseCache.find((x) => x.id === Number(t.value));
    // 同一动作沿用上次这组的数据，少打字
    const last = state.workoutDraft.entries.findLast((en) => en.exercise_id === ex.id);
    state.workoutDraft.entries.push({
      exercise_id: ex.id,
      duration_min: '',
      sets: ex.kind === 'strength' ? (last ? last.sets.map((s) => ({ ...s })) : [{ reps: '', weight_kg: '' }]) : [],
    });
    drawWorkout();
  }
});

$view.addEventListener('input', (e) => {
  if (location.hash !== '#/workout') return;
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
  if (location.hash !== '#/workout') return;
  const t = e.target;
  const w = state.workoutDraft;
  const addSet = t.closest('[data-add-set]');
  if (addSet) {
    const en = w.entries[Number(addSet.dataset.addSet)];
    en.sets.push({ ...(en.sets.at(-1) || { reps: '', weight_kg: '' }) });
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
      return;
    case 'save-ex': {
      const val = (k) => $view.querySelector(`[data-cx="${k}"]`).value;
      const kind = val('kind');
      const ex = await api('/exercises', { method: 'POST', body: { name: val('name'), kind, muscle: kind === 'cardio' ? '有氧' : val('muscle') } });
      exerciseCache = await api('/exercises');
      w.entries.push({ exercise_id: ex.id, duration_min: '', sets: kind === 'strength' ? [{ reps: '', weight_kg: '' }] : [] });
      toast('已加入动作库');
      return drawWorkout();
    }
    case 'save-workout': {
      const saved = await api('/workouts', { method: 'POST', body: w });
      toast(`已保存，估算消耗 ${r0(saved.kcal)} kcal`);
      state.date = w.date;
      state.workoutDraft = null;
      location.hash = '#/today';
    }
  }
}));

// ---------- 体重 ----------
async function renderWeight() {
  const rows = await api('/weights?days=90');
  const today = rows.find((r) => r.date === todayStr());
  $view.innerHTML = `
    <h1>体重</h1>
    <section class="card">
      <form class="stack" data-weight-form>
        <div class="grid2">
          <label class="field"><span>日期</span><input type="date" name="date" value="${todayStr()}" max="${todayStr()}"></label>
          <label class="field"><span>体重 kg</span><input type="number" name="kg" step="0.1" inputmode="decimal" required value="${today ? today.kg : ''}" placeholder="${rows.at(-1)?.kg ?? ''}"></label>
        </div>
        <button class="primary block">保存</button>
        <p class="muted small">每天早上起床、如厕后、吃东西前称，条件越一致越好。</p>
      </form>
    </section>
    <section class="card"><h2>趋势</h2>${weightChart(rows)}</section>
    <section class="card"><h2>记录</h2>
      ${rows.length ? `<ul class="list">${[...rows].reverse().map((r) => `<li><span class="grow">${fmtDate(r.date)}</span>
        <span class="num">${r1(r.kg)} kg</span><span class="num small muted" style="width:88px;text-align:right">均 ${r1(r.avg)}</span>
        <button class="ghost small" data-del-weight="${r.date}" aria-label="删除">✕</button></li>`).join('')}</ul>` : '<p class="muted small">还没有记录。</p>'}
    </section>`;

  $view.querySelector('[data-weight-form]').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/weights', { method: 'POST', body: { date: f.get('date'), kg: f.get('kg') } });
    toast('已保存');
    renderWeight();
  }));
  $view.querySelectorAll('[data-del-weight]').forEach((b) =>
    b.addEventListener('click', guard(async () => {
      if (!confirm('删除这条体重记录？')) return;
      await api(`/weights/${b.dataset.delWeight}`, { method: 'DELETE' });
      renderWeight();
    })),
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
  const rates = RATE_OPTIONS[goal];
  const rate = p.goal_rate ?? p.goals[goal].weeklyRate;

  $view.innerHTML = `
    <h1>我的</h1>
    ${!p.configured ? '<div class="banner">先填写下面的个人参数，保存后就能计算每日目标。</div>' : ''}
    <form class="card stack" data-profile>
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

      <h2 style="margin-top:14px">当前目标</h2>
      <p class="muted small">随时可以切换，每次切换都会记入历史。</p>
      <div class="goal-cards">${Object.entries(p.goals).map(([k, v]) => `<label><input type="radio" name="goal" value="${k}" ${goal === k ? 'checked' : ''}><strong>${esc(v.label)}</strong><div class="small muted">蛋白 ${v.proteinPerKg} g/kg</div></label>`).join('')}</div>
      <label class="field"><span>速度</span>
        <select name="goal_rate">${rates.map(([v, l]) => `<option value="${v}" ${Math.abs(v - rate) < 1e-6 ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </label>
      <label class="field"><span>运动消耗计入今日预算的比例</span>
        <select name="eat_back_ratio">${[[0, '不计入'], [0.5, '计入一半（推荐，估算普遍偏高）'], [1, '全部计入']].map(([v, l]) => `<option value="${v}" ${p.eat_back_ratio === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </label>
      <button class="primary block">保存</button>
    </form>

    <section class="card">
      <h2>我的能量模型</h2>
      ${e.ready ? `
        <dl class="num" style="display:grid;grid-template-columns:1fr auto;gap:6px 12px;margin:0">
          <dt>当前体重（7 天平均）</dt><dd style="margin:0">${e.weightKg} kg</dd>
          <dt>基础代谢 BMR</dt><dd style="margin:0">${e.bmr} kcal</dd>
          <dt>公式估算 TDEE</dt><dd style="margin:0">${e.formulaTdee} kcal</dd>
          <dt>体重反推 TDEE</dt><dd style="margin:0">${e.adaptive ? `${e.adaptive.tdee} kcal` : '<span class="muted">数据不足</span>'}</dd>
          <dt><strong>采用的 TDEE</strong></dt><dd style="margin:0"><strong>${e.tdee} kcal</strong></dd>
          <dt>每日目标热量</dt><dd style="margin:0">${e.targets.kcal} kcal（${e.targets.deltaKcal >= 0 ? '+' : ''}${e.targets.deltaKcal}）</dd>
          <dt>蛋白 / 碳水 / 脂肪</dt><dd style="margin:0">${e.targets.protein} / ${e.targets.carbs} / ${e.targets.fat} g</dd>
        </dl>
        <p class="muted small" style="margin-top:10px">${e.adaptive
          ? `最近 ${e.adaptive.days} 天体重变化约 ${e.adaptive.kgPerWeek} kg/周，平均摄入 ${e.adaptive.avgIntake} kcal。反推值权重 ${Math.round(e.adaptiveWeight * 100)}%，数据越多越依赖它。`
          : '需要至少 14 天体重记录，并且大部分日子都记了饮食，才能用真实数据校准。'}
          ${e.targets.flooredBySafety ? '<br>目标已被安全下限（不低于基础代谢）托住。' : ''}</p>`
        : '<p class="muted small">填写个人参数并记录一次体重后显示。</p>'}
    </section>

    ${p.goalHistory.length ? `<section class="card"><h2>目标历史</h2><ul class="list">${p.goalHistory.map((g) => `<li><span class="grow">${esc(p.goals[g.goal]?.label || g.goal)}</span><span class="small muted">${g.start_date} 起</span></li>`).join('')}</ul></section>` : ''}

    <section class="card"><h2>长期记忆 · 食物</h2>
      ${memory.length ? `<ul class="list">${memory.map((f) => `<li><div class="grow"><strong>${esc(f.name)}</strong>
        ${f.aliases.length ? `<span class="small muted"> ← ${esc(f.aliases.join('、'))}</span>` : ''}
        <div class="small muted num">每 100g：${r0(f.kcal_100g)} kcal · 蛋白 ${r1(f.protein_100g)} · 碳水 ${r1(f.carbs_100g)} · 脂肪 ${r1(f.fat_100g)}${f.typical_grams ? ` · 常吃 ${r0(f.typical_grams)}g` : ''}</div></div>
        <span class="pill">${f.use_count} 次</span></li>`).join('')}</ul>`
        : '<p class="muted small">在记一餐时修改识别结果，修改会被记住并用于下次识别。</p>'}
    </section>

    <section class="card"><h2>长期记忆 · 调料</h2>
      <div class="chips">${condiments.map((c) => `<span class="chip">${esc(c.name)} <span class="muted">${esc(c.unit)} ${r0(c.kcal)}kcal</span>${c.use_count ? ` <span class="pill">${c.use_count}</span>` : ''}</span>`).join('')}</div>
    </section>

    <p class="muted small">识别模型：${status.ai.enabled ? esc(status.ai.model) : '未配置（演示模式）'}</p>`;

  const form = $view.querySelector('[data-profile]');
  form.addEventListener('change', (ev) => {
    if (ev.target.name !== 'goal') return;
    const g = ev.target.value;
    const def = p.goals[g].weeklyRate;
    form.goal_rate.innerHTML = RATE_OPTIONS[g].map(([v, l]) => `<option value="${v}" ${Math.abs(v - def) < 1e-6 ? 'selected' : ''}>${l}</option>`).join('');
  });
  form.addEventListener('submit', guard(async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    await api('/profile', { method: 'PUT', body });
    toast('已保存');
    renderMe();
  }));
}

// ---------- 路由 ----------
const ROUTES = { today: renderToday, meal: renderMeal, workout: renderWorkout, weight: renderWeight, me: renderMe };

async function route() {
  const name = location.hash.replace('#/', '') || 'today';
  const render = ROUTES[name] || renderToday;
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  try {
    await render();
  } catch (e) {
    $view.innerHTML = `<div class="card"><p>加载失败：${esc(e.message)}</p><button data-retry>重试</button></div>`;
    $view.querySelector('[data-retry]').onclick = route;
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();
