import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApi, HttpError } from './api.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');
const publicDir = path.join(root, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 20 * 1024 * 1024;

const api = createApi({ db: openDb(dataDir), dataDir });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

// [method, pattern, handler(params, query, body)]
const routes = [
  ['GET', '/api/status', async () => ({ ...(await api.status()), phoneUrls: lanUrls() })],
  ['GET', '/api/profile', () => api.getProfile()],
  ['PUT', '/api/profile', (_, __, b) => api.updateProfile(b)],
  ['PUT', '/api/settings', (_, __, b) => api.updateSettings(b)],
  ['GET', '/api/overview', (_, q) => api.overview(q.get('days'))],
  ['GET', '/api/dashboard', (_, q) => api.dashboard(q.get('date'))],
  ['GET', '/api/weights', (_, q) => api.listWeights(Number(q.get('days')) || 90)],
  ['POST', '/api/weights', (_, __, b) => api.saveWeight(b)],
  ['DELETE', '/api/weights/:date', (p) => api.deleteWeight(p.date)],
  ['POST', '/api/meals/analyze', (_, __, b) => api.analyzeMeal(b)],
  ['GET', '/api/meals', (_, q) => api.listMeals(q.get('date'))],
  ['POST', '/api/meals', (_, __, b) => api.saveMeal(b)],
  ['DELETE', '/api/meals/:id', (p) => api.deleteMeal(Number(p.id))],
  ['GET', '/api/condiments', () => api.listCondiments()],
  ['POST', '/api/condiments', (_, __, b) => api.addCondiment(b)],
  ['GET', '/api/memory', () => api.foodMemory(200)],
  ['GET', '/api/exercises', () => api.listExercises()],
  ['POST', '/api/exercises', (_, __, b) => api.addExercise(b)],
  ['GET', '/api/workouts', (_, q) => api.listWorkouts({ date: q.get('date'), days: Number(q.get('days')) || 30 })],
  ['POST', '/api/workouts', (_, __, b) => api.saveWorkout(b)],
  ['DELETE', '/api/workouts/:id', (p) => api.deleteWorkout(Number(p.id))],
  ['GET', '/api/records', () => api.personalRecords()],
].map(([method, pattern, handler]) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  return { method, re, keys, handler };
});

// 同一 Wi-Fi 下手机可访问的地址（只监听本机时为空）
function lanUrls() {
  if (HOST !== '0.0.0.0') return [];
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${PORT}`);
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, '上传内容太大');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求格式错误');
  }
}

async function serveFile(res, dir, rel) {
  const file = path.join(dir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(dir + path.sep)) return send(res, 404, { error: 'not found' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        const m = r.method === req.method && r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : undefined;
        return send(res, 200, await r.handler(params, url.searchParams, body));
      }
      return send(res, 404, { error: '接口不存在' });
    }
    if (url.pathname.startsWith('/photos/')) {
      return serveFile(res, api.photoDir, url.pathname.slice('/photos/'.length));
    }
    return serveFile(res, publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(err);
    return send(res, 500, { error: err.message || '服务器错误' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n个人生活助手已启动：`);
  console.log(`  电脑（查看数据）：http://localhost:${PORT}`);
  for (const url of lanUrls()) console.log(`  手机（每日记录）：${url}  （需与电脑在同一 Wi-Fi）`);
  api.status().then(({ ai }) => {
    console.log(ai.enabled ? `  识别模型：${ai.model}` : '  识别模型：未配置 ANTHROPIC_API_KEY，拍照识别使用演示数据');
    console.log(`  数据目录：${dataDir}\n`);
  });
});
