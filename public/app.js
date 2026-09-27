// 入口：按设备加载手机端（记录）或电脑端（只看数据）。
import { api, setWeightUnit, viewMode } from './lib.js';

let status = {};
try {
  status = await api('/status');
} catch {
  // 状态接口失败时按默认单位继续，页面自己的请求会显示具体错误
}
setWeightUnit(status.weightUnit);

if (viewMode() === 'desktop') (await import('./desktop.js')).start(status);
else (await import('./phone.js')).start(status);
