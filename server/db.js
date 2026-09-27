import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { EXERCISES, DEFAULT_CONDIMENTS } from './exercises.js';

export function openDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'life.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  seed(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sex TEXT NOT NULL DEFAULT 'male',
      birth_date TEXT NOT NULL DEFAULT '2000-01-01',
      height_cm REAL NOT NULL DEFAULT 175,
      body_fat_pct REAL,
      activity_level TEXT NOT NULL DEFAULT 'sedentary',
      goal TEXT NOT NULL DEFAULT 'maintain',
      goal_rate REAL,
      eat_back_ratio REAL NOT NULL DEFAULT 0.5,
      weight_unit TEXT NOT NULL DEFAULT 'kg',
      updated_at TEXT
    );

    -- 目标会随时间切换，保留历史便于回看每个阶段
    CREATE TABLE IF NOT EXISTS goal_history (
      id INTEGER PRIMARY KEY,
      goal TEXT NOT NULL,
      goal_rate REAL,
      start_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS weight_log (
      date TEXT PRIMARY KEY,
      kg REAL NOT NULL,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS meal (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      time TEXT,
      meal_type TEXT NOT NULL,
      photo TEXT,
      note TEXT,
      ai_raw TEXT,
      ai_confidence TEXT,
      kcal_low REAL,
      kcal_high REAL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS meal_date ON meal(date);

    CREATE TABLE IF NOT EXISTS meal_item (
      id INTEGER PRIMARY KEY,
      meal_id INTEGER NOT NULL REFERENCES meal(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      grams REAL,
      quantity REAL,
      unit TEXT,
      kcal REAL NOT NULL,
      protein REAL NOT NULL DEFAULT 0,
      carbs REAL NOT NULL DEFAULT 0,
      fat REAL NOT NULL DEFAULT 0,
      fiber REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'ai',
      ai_name TEXT
    );

    CREATE TABLE IF NOT EXISTS condiment (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      unit TEXT NOT NULL,
      kcal REAL NOT NULL,
      protein REAL NOT NULL DEFAULT 0,
      carbs REAL NOT NULL DEFAULT 0,
      fat REAL NOT NULL DEFAULT 0,
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used TEXT
    );

    -- 长期记忆：用户修正过的食物（按每 100g 记营养），以及 AI 识别名到用户名的别名
    CREATE TABLE IF NOT EXISTS food_memory (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      aliases TEXT NOT NULL DEFAULT '[]',
      kcal_100g REAL NOT NULL,
      protein_100g REAL NOT NULL DEFAULT 0,
      carbs_100g REAL NOT NULL DEFAULT 0,
      fat_100g REAL NOT NULL DEFAULT 0,
      typical_grams REAL,
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used TEXT
    );

    CREATE TABLE IF NOT EXISTS exercise (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      muscle TEXT NOT NULL,
      kind TEXT NOT NULL,
      met REAL NOT NULL,
      custom INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS workout (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      duration_min REAL,
      rpe REAL,
      note TEXT,
      kcal REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workout_date ON workout(date);

    CREATE TABLE IF NOT EXISTS workout_entry (
      id INTEGER PRIMARY KEY,
      workout_id INTEGER NOT NULL REFERENCES workout(id) ON DELETE CASCADE,
      exercise_id INTEGER NOT NULL REFERENCES exercise(id),
      position INTEGER NOT NULL,
      duration_min REAL,
      kcal REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS workout_set (
      id INTEGER PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES workout_entry(id) ON DELETE CASCADE,
      set_no INTEGER NOT NULL,
      reps INTEGER,
      weight_kg REAL
    );
  `);

  // 已有数据库补新列（CREATE TABLE IF NOT EXISTS 不会给旧表加列）
  const cols = db.prepare('PRAGMA table_info(profile)').all().map((c) => c.name);
  if (!cols.includes('weight_unit')) db.exec("ALTER TABLE profile ADD COLUMN weight_unit TEXT NOT NULL DEFAULT 'kg'");
}

function seed(db) {
  const insEx = db.prepare('INSERT OR IGNORE INTO exercise (name, muscle, kind, met) VALUES (?, ?, ?, ?)');
  for (const e of EXERCISES) insEx.run(e.name, e.muscle, e.kind, e.met);
  const insC = db.prepare(
    'INSERT OR IGNORE INTO condiment (name, unit, kcal, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const c of DEFAULT_CONDIMENTS) insC.run(c.name, c.unit, c.kcal, c.protein, c.carbs, c.fat);
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
