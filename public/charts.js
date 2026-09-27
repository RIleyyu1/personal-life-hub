// 响应式 SVG 图表：按容器实际宽度绘制（文字和圆点不会被拉伸），带悬停与键盘提示。
// 颜色都取自 styles.css 里的 --viz-* 变量，浅色/深色模式各自校验过。
import { esc, fmt1, fmtDate, kgToDisplay, weightUnit } from './lib.js';

const observer = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => entries.forEach((e) => draw(e.target))) : null;
const RENDER = { columns, trend, hbars };

export function mountChart(box, spec) {
  if (!box) return;
  box.classList.add('chart-box');
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', spec.label);
  box._spec = spec;
  box._width = 0;
  draw(box);
  observer?.observe(box);
  if (!box._wired) wire(box);
}

// 页面整块重绘前调用，停止观察即将被替换的图表
export function releaseCharts(root) {
  root.querySelectorAll('.chart-box').forEach((box) => observer?.unobserve(box));
}

function draw(box) {
  const width = Math.floor(box.clientWidth);
  if (!box._spec || !width || width === box._width) return;
  box._width = width;
  const geo = RENDER[box._spec.type](width, box._spec);
  box.innerHTML = geo.svg + (geo.xs ? '<div class="chart-tip" hidden></div>' : '');
  box.tabIndex = geo.xs ? 0 : -1;
  box._geo = geo;
  box._active = null;
}

// ---------- 交互：指针找最近的日期，键盘左右键逐个移动 ----------
function wire(box) {
  box._wired = true;
  const onPoint = (e) => {
    const g = box._geo;
    if (!g?.xs) return;
    const x = e.clientX - box.getBoundingClientRect().left;
    let best = -1;
    g.xs.forEach((gx, i) => {
      if (g.valid[i] && (best < 0 || Math.abs(gx - x) < Math.abs(g.xs[best] - x))) best = i;
    });
    if (best >= 0) show(box, best);
  };
  box.addEventListener('pointermove', onPoint);
  box.addEventListener('pointerdown', onPoint);
  // 触屏点一下后手指抬起就会触发 leave，提示保留到点别处（失焦）再收起
  box.addEventListener('pointerleave', (e) => e.pointerType !== 'touch' && hide(box));
  box.addEventListener('focus', () => box._geo?.xs && show(box, box._active ?? box._geo.last));
  box.addEventListener('blur', () => hide(box));
  box.addEventListener('keydown', (e) => {
    const g = box._geo;
    if (!g?.xs) return;
    if (e.key === 'Escape') return hide(box);
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!step) return;
    e.preventDefault();
    let i = box._active ?? g.last;
    do i += step;
    while (i >= 0 && i < g.xs.length && !g.valid[i]);
    if (i >= 0 && i < g.xs.length) show(box, i);
  });
}

function show(box, i) {
  const g = box._geo;
  const tip = box.querySelector('.chart-tip');
  if (!tip) return;
  box._active = i;
  const { title, rows } = box._spec.tip(i);
  const head = document.createElement('div');
  head.className = 'tip-title';
  head.textContent = title;
  // 值在前、名称在后；名称和数值一律用 textContent 写入
  tip.replaceChildren(
    head,
    ...rows.map((r) => {
      const row = document.createElement('div');
      row.className = 'tip-row';
      const key = document.createElement('i');
      key.className = `key key-${r.key}`;
      key.style.background = r.color;
      const v = document.createElement('strong');
      v.textContent = r.value;
      const l = document.createElement('span');
      l.textContent = r.label;
      row.append(key, v, l);
      return row;
    }),
  );
  tip.hidden = false;
  const cross = box.querySelector('.cross');
  if (cross) {
    cross.setAttribute('x1', g.xs[i]);
    cross.setAttribute('x2', g.xs[i]);
    cross.style.display = '';
  }
  box.querySelectorAll('.bar.on').forEach((el) => el.classList.remove('on'));
  box.querySelector(`.bar[data-i="${i}"]`)?.classList.add('on');
  let left = g.xs[i] + 14;
  if (left + tip.offsetWidth > box.clientWidth) left = g.xs[i] - 14 - tip.offsetWidth;
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${g.top}px`;
}

function hide(box) {
  const tip = box.querySelector('.chart-tip');
  if (tip) tip.hidden = true;
  const cross = box.querySelector('.cross');
  if (cross) cross.style.display = 'none';
  box.querySelectorAll('.bar.on').forEach((el) => el.classList.remove('on'));
}

// ---------- 刻度 ----------
function niceRange(lo, hi, ticks = 4) {
  if (hi - lo < 1) {
    const mid = (lo + hi) / 2;
    lo = mid - 0.5;
    hi = mid + 0.5;
  }
  const raw = (hi - lo) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw);
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, step };
}

function tickValues({ min, max, step }) {
  const out = [];
  for (let k = 0; min + k * step <= max + step / 1e6; k++) out.push(min + k * step);
  return out;
}

const fmtTick = (v, step) => (step < 1 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US'));

function gridAndTicks(scale, y, left, right) {
  return tickValues(scale)
    .map((v) => `<line class="grid" x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${left - 8}" y="${y(v) + 4}" text-anchor="end">${fmtTick(v, scale.step)}</text>`)
    .join('');
}

// 首、（区间较长时）中、尾三个日期标签
function xLabels(labels, xs, y, left, right) {
  const n = labels.length;
  const idx = n === 1 ? [0] : n >= 14 ? [0, Math.floor((n - 1) / 2), n - 1] : [0, n - 1];
  return idx
    .map((i, k) => {
      const anchor = idx.length === 1 ? 'middle' : k === 0 ? 'start' : k === idx.length - 1 ? 'end' : 'middle';
      const x = anchor === 'start' ? left : anchor === 'end' ? right : xs[i];
      return `<text class="tick" x="${x}" y="${y}" text-anchor="${anchor}">${esc(labels[i])}</text>`;
    })
    .join('');
}

const empty = (text) => ({ svg: `<p class="chart-empty">${esc(text || '暂无数据')}</p>`, xs: null });

// 柱子：数据端 4px 圆角，基线端方角
function colPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`;
}

function rowPath(x, y, w, h) {
  const r = Math.min(4, h / 2, w);
  return `M${x},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h - r}A${r},${r} 0 0 1 ${x + w - r},${y + h}H${x}Z`;
}

// ---------- 每日柱状图 + 目标阶梯线 ----------
// spec: { values: number[], refs?: (number|null)[], labels: string[], color, tip(i), label, empty }
function columns(W, s) {
  if (!s.values.some((v) => v > 0) && !(s.refs || []).some((v) => v > 0)) return empty(s.empty);
  const H = s.height ?? 220;
  const pad = { l: 52, r: 12, t: 14, b: 26 };
  const n = s.values.length;
  const pw = Math.max(10, W - pad.l - pad.r);
  const ph = H - pad.t - pad.b;
  const scale = niceRange(0, Math.max(1, ...s.values, ...(s.refs || []).map((v) => v || 0)));
  const y = (v) => pad.t + ph * (1 - v / scale.max);
  const slot = pw / n;
  const bw = Math.max(1, Math.min(24, slot * 0.7, slot - 2));
  const xs = s.values.map((_, i) => pad.l + slot * (i + 0.5));

  let ref = '';
  if (s.refs) {
    let prev = null;
    s.refs.forEach((v, i) => {
      if (v == null) return void (prev = null);
      ref += `${prev == null ? `M${pad.l + slot * i},${y(v)}` : `V${y(v)}`}H${pad.l + slot * (i + 1)}`;
      prev = v;
    });
  }

  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    ${gridAndTicks(scale, y, pad.l, W - pad.r)}
    ${s.values.map((v, i) => (v > 0 ? `<path class="bar" data-i="${i}" fill="${s.color}" d="${colPath(xs[i] - bw / 2, y(v), bw, y(0) - y(v))}"/>` : '')).join('')}
    <line class="axis" x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}"/>
    ${ref ? `<path class="ref" d="${ref}"/>` : ''}
    ${xLabels(s.labels, xs, H - 6, pad.l, W - pad.r)}
  </svg>`;
  return { svg, xs, valid: xs.map(() => true), last: n - 1, top: pad.t };
}

// ---------- 体重：每日点 + 7 天平均线 ----------
// spec: { raw: (number|null)[], avg: (number|null)[], labels, unit, tip(i), label }
function trend(W, s) {
  const vals = [...s.raw, ...s.avg].filter((v) => v != null);
  if (!vals.length) return empty(s.empty);
  const H = s.height ?? 220;
  const pad = { l: 52, r: 64, t: 16, b: 26 };
  const n = s.raw.length;
  const pw = Math.max(10, W - pad.l - pad.r);
  const ph = H - pad.t - pad.b;
  const scale = niceRange(Math.min(...vals), Math.max(...vals));
  const x = (i) => pad.l + (n === 1 ? pw / 2 : (pw * i) / (n - 1));
  const y = (v) => pad.t + ph * (1 - (v - scale.min) / (scale.max - scale.min));
  const xs = s.raw.map((_, i) => x(i));

  // 平均线：相邻两次称重超过 7 天就断开，不假装中间有数据
  let line = '';
  let prevI = null;
  s.avg.forEach((v, i) => {
    if (v == null) return;
    line += `${prevI == null || i - prevI > 7 ? 'M' : 'L'}${x(i)},${y(v)}`;
    prevI = i;
  });
  const lastAvg = s.avg.findLastIndex((v) => v != null);
  const valid = s.raw.map((v, i) => v != null || s.avg[i] != null);

  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    ${gridAndTicks(scale, y, pad.l, W - pad.r)}
    <line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" style="display:none"/>
    <path class="avg" d="${line}"/>
    ${s.raw.map((v, i) => (v == null ? '' : `<circle class="raw" cx="${x(i)}" cy="${y(v)}" r="4"/>`)).join('')}
    ${lastAvg >= 0 ? `<circle class="end" cx="${x(lastAvg)}" cy="${y(s.avg[lastAvg])}" r="4"/>
      <text class="endlabel" x="${x(lastAvg) + 10}" y="${y(s.avg[lastAvg]) + 4}">${fmt1(s.avg[lastAvg])} ${esc(s.unit)}</text>` : ''}
    ${xLabels(s.labels, xs, H - 6, pad.l, W - pad.r)}
  </svg>`;
  return { svg, xs, valid, last: valid.lastIndexOf(true), top: pad.t };
}

// ---------- 横向条形：每个条都直接标数值 ----------
// spec: { items: [{label, value}], color, suffix, label }
function hbars(W, s) {
  if (!s.items.length) return empty(s.empty);
  const rowH = 30;
  const bar = 14;
  const pad = { l: 56, r: 64, t: 4, b: 4 };
  const H = pad.t + pad.b + rowH * s.items.length;
  const max = Math.max(1, ...s.items.map((i) => i.value));
  const pw = Math.max(10, W - pad.l - pad.r);
  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <line class="axis" x1="${pad.l}" x2="${pad.l}" y1="${pad.t}" y2="${H - pad.b}"/>
    ${s.items
      .map((it, k) => {
        const mid = pad.t + rowH * k + rowH / 2;
        const w = (pw * it.value) / max;
        return `<g class="hrow"><title>${esc(`${it.label}：${it.value} ${s.suffix}`)}</title>
          <text class="rowlabel" x="${pad.l - 10}" y="${mid + 4}" text-anchor="end">${esc(it.label)}</text>
          ${it.value > 0 ? `<path class="bar" fill="${s.color}" d="${rowPath(pad.l, mid - bar / 2, w, bar)}"/>` : ''}
          <text class="value" x="${pad.l + w + 8}" y="${mid + 4}">${esc(`${it.value} ${s.suffix}`)}</text></g>`;
      })
      .join('')}
  </svg>`;
  return { svg, xs: null };
}

// ---------- 体重图的数据准备（手机和电脑共用） ----------
// days: 连续日期 [{date, weight, weightAvg}]（kg，没称重的日子为 null）
export function weightTrendSpec(days, { height } = {}) {
  const unit = weightUnit();
  const conv = (v) => (v == null ? null : kgToDisplay(v));
  const raw = days.map((d) => conv(d.weight));
  const avg = days.map((d) => conv(d.weightAvg));
  return {
    type: 'trend',
    height,
    raw,
    avg,
    unit,
    labels: days.map((d) => d.date.slice(5)),
    label: `体重趋势（${unit}）：点为每日体重，线为 7 天平均`,
    empty: '还没有体重记录',
    tip: (i) => ({
      title: fmtDate(days[i].date),
      rows: [
        raw[i] != null && { key: 'dot', color: 'var(--viz-muted)', value: `${fmt1(raw[i])} ${unit}`, label: '当日体重' },
        avg[i] != null && { key: 'line', color: 'var(--viz-1)', value: `${fmt1(avg[i])} ${unit}`, label: '7 天平均' },
      ].filter(Boolean),
    }),
  };
}

export function legend(items) {
  return `<div class="legend">${items.map(([kind, color, text]) => `<span><i class="sw sw-${kind}" style="background:${color}"></i>${esc(text)}</span>`).join('')}</div>`;
}
