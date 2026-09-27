// 食物照片识别。用 Claude 视觉模型输出结构化 JSON；
// 没配置 ANTHROPIC_API_KEY 或没装 SDK 时进入演示模式，方便先把流程跑通。

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';

const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'grams', 'kcal', 'protein', 'carbs', 'fat', 'fiber'],
  properties: {
    name: { type: 'string', description: '中文食物名，尽量具体（如"青椒肉丝"而不是"炒菜"）' },
    grams: { type: 'number', description: '估算的可食用重量（克）' },
    kcal: { type: 'number' },
    protein: { type: 'number', description: '克' },
    carbs: { type: 'number', description: '克' },
    fat: { type: 'number', description: '克，包含烹饪用油' },
    fiber: { type: 'number', description: '克' },
  },
};

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_food', 'items', 'kcal_low', 'kcal_high', 'confidence', 'notes'],
  properties: {
    is_food: { type: 'boolean', description: '照片里是否是可以记录的食物' },
    items: { type: 'array', items: ITEM_SCHEMA },
    kcal_low: { type: 'number', description: '整餐热量的合理下限' },
    kcal_high: { type: 'number', description: '整餐热量的合理上限' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string', description: '一句话说明主要不确定来源，例如油量、被遮挡的部分' },
  },
};

const SYSTEM = `你是一名注册营养师，帮用户根据餐食照片估算热量和营养素。
- 逐个列出能看到的食物，估算可食用重量（去骨去壳）和营养素；把烹饪用油算进对应菜品的脂肪里。
- 用盘子、碗、筷子、手等参照物判断份量；中餐外卖和食堂菜通常比家常菜油多。
- 宁可给出合理区间，也不要假装精确：kcal_low / kcal_high 要反映真实的不确定性。
- 如果用户提供了过往修正记录，同名或相似的食物优先参考那些数值。
- 如果照片不是食物，is_food 设为 false，items 为空。`;

let clientPromise;
async function getClient() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  clientPromise ??= import('@anthropic-ai/sdk')
    .then(({ default: Anthropic }) => new Anthropic())
    .catch(() => null);
  return clientPromise;
}

export async function aiStatus() {
  const client = await getClient();
  return { enabled: Boolean(client), model: client ? MODEL : null };
}

// imageBase64: 不带 data: 前缀的 JPEG base64；memory: {foods, condiments}
export async function analyzeMealPhoto({ imageBase64, mediaType = 'image/jpeg', note, memory }) {
  const client = await getClient();
  if (!client) return demoResult();

  const context = [];
  if (memory?.foods?.length) {
    context.push(
      '用户过往修正过的食物（每 100g）：\n' +
        memory.foods
          .map((f) => `- ${f.name}${f.aliases.length ? `（曾被识别为：${f.aliases.join('、')}）` : ''}：${f.kcal_100g} kcal，蛋白 ${f.protein_100g}g，碳水 ${f.carbs_100g}g，脂肪 ${f.fat_100g}g${f.typical_grams ? `，常吃份量约 ${f.typical_grams}g` : ''}`)
          .join('\n'),
    );
  }
  if (note) context.push(`用户备注：${note}`);

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: RESULT_SCHEMA } },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: [...context, '请识别这顿饭并估算营养。'].join('\n\n') },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('模型拒绝了这次识别，请换一张照片或手动填写');
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = JSON.parse(text);
  return { ...parsed, model: response.model, demo: false };
}

function demoResult() {
  return {
    demo: true,
    is_food: true,
    items: [
      { name: '米饭', grams: 200, kcal: 232, protein: 5.2, carbs: 51.8, fat: 0.6, fiber: 0.6 },
      { name: '青椒肉丝', grams: 180, kcal: 310, protein: 18, carbs: 8, fat: 23, fiber: 2 },
      { name: '清炒西兰花', grams: 150, kcal: 95, protein: 4.5, carbs: 10, fat: 4.5, fiber: 4 },
    ],
    kcal_low: 520,
    kcal_high: 760,
    confidence: 'medium',
    notes: '演示数据：未配置 ANTHROPIC_API_KEY，这不是对你照片的真实识别。',
  };
}
