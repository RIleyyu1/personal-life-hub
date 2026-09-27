// 手机端和电脑端共用的小工具。

export function todayStr() {
  return new Date().toLocaleDateString('sv');
}

export function shiftDate(d, n) {
  const x = new Date(d + 'T12:00:00');
  x.setDate(x.getDate() + n);
  return x.toLocaleDateString('sv');
}

export function fmtDate(d) {
  if (d === todayStr()) return '今天';
  if (d === shiftDate(todayStr(), -1)) return '昨天';
  const x = new Date(d + 'T12:00:00');
  return `${x.getMonth() + 1}月${x.getDate()}日 周${'日一二三四五六'[x.getDay()]}`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const r0 = (n) => Math.round(Number(n) || 0);
export const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
// 体重类数值固定一位小数，79 显示为 79.0，列表对齐
export const fmt1 = (n) => r1(n).toFixed(1);
export const fmtInt = (n) => r0(n).toLocaleString('en-US');

export async function api(path, opts = {}) {
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
export function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

export function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      toast(e.message);
    }
  };
}

// ---------- 重量单位：数据库一律存 kg，只在显示和输入时换算 ----------
export const KG_PER_LB = 0.45359237;
let unit = 'kg';

export function setWeightUnit(u) {
  unit = u === 'lb' ? 'lb' : 'kg';
}
export function weightUnit() {
  return unit;
}
export function kgToDisplay(kg) {
  return unit === 'lb' ? kg / KG_PER_LB : kg;
}
export function displayToKg(v) {
  return unit === 'lb' ? v * KG_PER_LB : v;
}
export function fmtWeight(kg) {
  return kg == null ? '—' : `${fmt1(kgToDisplay(kg))} ${unit}`;
}

// 手机负责记录，电脑只看数据。index.html 里已按设备写好 data-mode，这里只读取
export function viewMode() {
  return document.documentElement.dataset.mode === 'desktop' ? 'desktop' : 'phone';
}
