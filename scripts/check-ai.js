// 检查拍照识别是否配置好：用一张纯色小图，走一遍和「记一餐」完全相同的调用。
// 用法：npm run check-ai
import { aiStatus, analyzeMealPhoto } from '../server/ai.js';

// 64×64 浅灰色 PNG（不是食物，模型应返回 is_food=false）
const TEST_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATklEQVR42u3PQQkAAAgEsOtfVTGDEXwLgxVYeuq1CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAhcFud4UpVrSp+qAAAAAElFTkSuQmCC';

const status = await aiStatus();
if (!status.enabled) {
  console.log('未启用识别：没有读到 ANTHROPIC_API_KEY，或者还没运行 npm install。');
  console.log('请在项目根目录的 .env 里填入 key（参考 .env.example），再运行一次 npm run check-ai。');
  process.exit(1);
}

console.log(`正在调用 ${status.model} …`);
const started = Date.now();
try {
  const r = await analyzeMealPhoto({ imageBase64: TEST_PNG, mediaType: 'image/png' });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`识别接口正常：模型 ${r.model}，用时 ${seconds} 秒，is_food=${r.is_food}（测试图不是食物，false 属于正常）。`);
} catch (e) {
  // 401 = key 不对；404 = 模型名不可用；400 = 请求参数被拒绝
  console.error(`识别接口调用失败${e.status ? `（HTTP ${e.status}）` : ''}：${e.message}`);
  process.exit(1);
}
