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
    keepalive: Boolean(opts.keepalive),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

// 提示条：可带一个操作按钮（如"撤销"），带操作时停留更久
let toastTimer;
let toastAction = null;
export function toast(msg, { action, onAction, duration } = {}) {
  const el = document.getElementById('toast');
  const btn = el.querySelector('[data-toast-action]');
  el.querySelector('[data-toast-text]').textContent = msg;
  toastAction = onAction || null;
  btn.hidden = !action;
  btn.textContent = action || '';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration ?? (action ? 5000 : 2400));
}
export function hideToast() {
  document.getElementById('toast').classList.remove('show');
  toastAction = null;
}
document.querySelector('#toast [data-toast-action]')?.addEventListener('click', () => {
  const fn = toastAction;
  hideToast();
  fn?.();
});

// 轻触反馈：支持震动的设备（多为安卓）震一下
export function haptic(ms = 8) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // 不支持就算了
  }
}

// 删除先从界面上拿掉，5 秒内可撤销；到时或离开页面时才真正删除
const pendingDeletes = new Map();
export function deleteWithUndo({ key, label, commit, restore }) {
  const run = () => {
    pendingDeletes.delete(key);
    return commit().catch((e) => {
      toast(e.message);
      restore();
    });
  };
  const timer = setTimeout(run, 5000);
  pendingDeletes.set(key, { timer, run });
  toast(label, {
    action: '撤销',
    duration: 5000,
    onAction: () => {
      clearTimeout(timer);
      pendingDeletes.delete(key);
      restore();
    },
  });
}
export async function flushDeletes() {
  const runs = [...pendingDeletes.values()];
  for (const p of runs) clearTimeout(p.timer);
  if (runs.length) hideToast();
  await Promise.all(runs.map((p) => p.run()));
}
addEventListener('pagehide', () => flushDeletes());

export function greeting(now = new Date()) {
  const h = now.getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 13) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

export function weekdayCn(d) {
  return `星期${'日一二三四五六'[new Date(d + 'T12:00:00').getDay()]}`;
}
export function monthDayCn(d) {
  const [, m, day] = d.split('-').map(Number);
  return `${m}月${day}日`;
}

// 数字从当前值滚动到目标值（尊重"减少动态效果"设置）
export function countUp(el, to, { duration = 1100, format = (n) => Math.round(n).toLocaleString('en-US') } = {}) {
  if (!el) return;
  const from = Number(el.dataset.value ?? 0);
  el.dataset.value = String(to);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || from === to) {
    el.textContent = format(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const e = 1 - Math.pow(1 - t, 3);
    el.textContent = format(from + (to - from) * e);
    if (t < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
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
