import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SEED_CARDS } from './seed.js';
import { BASE_CATEGORIES, DIFFICULTIES, answerKey, slugify } from './cards.js';

export { DIFFICULTIES };

// Custos e recompensas do sistema de tokens do jogo (créditos do jogador, não tokens da API).
export const TOKEN_RULES = {
  initial: 20,
  dailyBonus: 5,
  costGenerateCard: 2,
  costChallenge: 5,
  costAiHint: 1,
  rewardQuickGuess: 1, // acertar usando até 3 dicas
};

function addColumnIfMissing(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function openDb(path = process.env.DB_PATH || './data/perfil.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tokens INTEGER NOT NULL,
      last_bonus TEXT,
      games_played INTEGER NOT NULL DEFAULT 0,
      cards_solved INTEGER NOT NULL DEFAULT 0,
      total_score INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS categories (
      slug TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      question TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'base',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      answer TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      clues TEXT NOT NULL,
      difficulty TEXT NOT NULL DEFAULT 'medio',
      theme TEXT,
      source TEXT NOT NULL DEFAULT 'seed',
      author_id TEXT,
      times_played INTEGER NOT NULL DEFAULT 0,
      times_solved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS answer_keys (
      key TEXT PRIMARY KEY,
      card_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plays (
      user_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, card_id)
    );
    CREATE TABLE IF NOT EXISTS card_hints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      hint TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS token_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      kind TEXT NOT NULL,
      model TEXT,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      cards_saved INTEGER NOT NULL DEFAULT 0,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  addColumnIfMissing(db, 'cards', 'answer_key', 'answer_key TEXT');
  addColumnIfMissing(db, 'cards', 'theme_key', 'theme_key TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS cards_category ON cards(category);
    CREATE INDEX IF NOT EXISTS cards_theme ON cards(theme_key);
    CREATE INDEX IF NOT EXISTS hints_card ON card_hints(card_id);
    CREATE INDEX IF NOT EXISTS usage_day ON ai_usage(created_at);
  `);

  for (const c of BASE_CATEGORIES) {
    db.prepare('INSERT OR IGNORE INTO categories (slug, label, question) VALUES (?, ?, ?)').run(c.slug, c.label, c.question);
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM cards').get().n;
  if (count === 0) {
    for (const card of SEED_CARDS) insertCard(db, { ...card, source: 'seed' });
  }
  return db;
}

// ---------- Categorias ----------

export function listCategories(db) {
  return db
    .prepare(
      `SELECT c.slug, c.label, c.question, c.source, COUNT(k.id) AS cards
       FROM categories c LEFT JOIN cards k ON k.category = c.slug
       GROUP BY c.slug ORDER BY c.source = 'base' DESC, c.label`
    )
    .all()
    .map((r) => ({ ...r }));
}

export function getCategory(db, slug) {
  const row = db.prepare('SELECT slug, label, question, source FROM categories WHERE slug = ?').get(slug);
  return row ? { ...row } : null;
}

export function ensureCategory(db, { slug, label, question }) {
  const clean = slugify(slug || label);
  if (!clean) throw new Error('Categoria inválida.');
  const existing = getCategory(db, clean);
  if (existing) return existing;
  db.prepare("INSERT INTO categories (slug, label, question, source) VALUES (?, ?, ?, 'ia')").run(
    clean,
    String(label || clean).slice(0, 30),
    String(question || 'O que sou eu?').slice(0, 40)
  );
  return getCategory(db, clean);
}

// ---------- Cartas ----------

function rowToCard(row) {
  if (!row) return null;
  return {
    id: row.id,
    category: row.category,
    answer: row.answer,
    aliases: JSON.parse(row.aliases),
    clues: JSON.parse(row.clues),
    difficulty: row.difficulty,
    theme: row.theme,
    source: row.source,
    authorId: row.author_id,
    timesPlayed: row.times_played,
    timesSolved: row.times_solved,
    createdAt: row.created_at,
  };
}

// Procura uma carta que já usa esta resposta ou algum destes apelidos (em qualquer categoria).
export function findDuplicate(db, answer, aliases = []) {
  for (const name of [answer, ...aliases]) {
    const key = answerKey(name);
    if (!key) continue;
    const hit = db.prepare('SELECT card_id FROM answer_keys WHERE key = ?').get(key);
    if (hit) return getCard(db, hit.card_id);
  }
  return null;
}

export function knownAnswers(db) {
  return db.prepare('SELECT answer FROM cards ORDER BY created_at DESC LIMIT 300').all().map((r) => r.answer);
}

// Insere uma carta; se a resposta (ou um apelido) já existir, devolve a carta existente.
export function insertCard(db, card) {
  if (!card.category) throw new Error('Carta sem categoria.');
  const dup = findDuplicate(db, card.answer, card.aliases);
  if (dup) return { card: dup, created: false };
  const id = randomUUID();
  db.prepare(
    `INSERT INTO cards (id, category, answer, answer_key, aliases, clues, difficulty, theme, theme_key, source, author_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    card.category,
    card.answer,
    answerKey(card.answer),
    JSON.stringify(card.aliases ?? []),
    JSON.stringify(card.clues),
    card.difficulty ?? 'medio',
    card.theme ?? null,
    card.theme ? answerKey(card.theme) : null,
    card.source ?? 'seed',
    card.authorId ?? null
  );
  const addKey = db.prepare('INSERT OR IGNORE INTO answer_keys (key, card_id) VALUES (?, ?)');
  for (const name of [card.answer, ...(card.aliases ?? [])]) {
    const key = answerKey(name);
    if (key) addKey.run(key, id);
  }
  return { card: getCard(db, id), created: true };
}

export function getCard(db, id) {
  return rowToCard(db.prepare('SELECT * FROM cards WHERE id = ?').get(id));
}

function cardFilter({ category, difficulty, theme, userId, excludeIds = [] }) {
  const params = [];
  let where = '1=1';
  if (category) {
    where += ' AND category = ?';
    params.push(category);
  }
  if (difficulty) {
    where += ' AND difficulty = ?';
    params.push(difficulty);
  }
  if (theme) {
    where += ' AND theme_key = ?';
    params.push(answerKey(theme));
  }
  if (userId) {
    where += ' AND id NOT IN (SELECT card_id FROM plays WHERE user_id = ?)';
    params.push(userId);
  }
  if (excludeIds.length) {
    where += ` AND id NOT IN (${excludeIds.map(() => '?').join(',')})`;
    params.push(...excludeIds);
  }
  return { where, params };
}

// Cartas do banco que atendem ao pedido e que o jogador ainda não jogou.
// Usado para não chamar a IA quando já existe conteúdo pronto.
export function findReusableCards(db, { userId, category, difficulty, theme, limit = 1 }) {
  const { where, params } = cardFilter({ category, difficulty, theme, userId });
  return db
    .prepare(`SELECT * FROM cards WHERE ${where} ORDER BY RANDOM() LIMIT ?`)
    .all(...params, limit)
    .map(rowToCard);
}

// Sorteia uma carta, preferindo as que o jogador ainda não viu.
export function randomCard(db, { category, userId, excludeIds = [] } = {}) {
  const attempts = [
    { category, userId, excludeIds },
    { category, excludeIds },
    { category },
  ];
  for (const opts of attempts) {
    const { where, params } = cardFilter(opts);
    const row = db.prepare(`SELECT * FROM cards WHERE ${where} ORDER BY RANDOM() LIMIT 1`).get(...params);
    if (row) return rowToCard(row);
  }
  return null;
}

export function markPlayed(db, userId, cardId) {
  db.prepare('INSERT OR IGNORE INTO plays (user_id, card_id) VALUES (?, ?)').run(userId, cardId);
}

export function listCards(db, { category, source, search, limit = 50, offset = 0 } = {}) {
  const params = [];
  let where = '1=1';
  if (category) {
    where += ' AND category = ?';
    params.push(category);
  }
  if (source === 'ia' || source === 'seed') {
    where += ' AND source = ?';
    params.push(source);
  }
  if (search) {
    where += ' AND (theme LIKE ? OR category LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM cards WHERE ${where}`).get(...params).n;
  const rows = db
    .prepare(`SELECT * FROM cards WHERE ${where} ORDER BY created_at DESC, answer LIMIT ? OFFSET ?`)
    .all(...params, Math.min(limit, 200), offset);
  return { total, cards: rows.map(rowToCard) };
}

export function recordCardResult(db, cardId, solved) {
  db.prepare('UPDATE cards SET times_played = times_played + 1, times_solved = times_solved + ? WHERE id = ?').run(
    solved ? 1 : 0,
    cardId
  );
}

// ---------- Dicas extras (cache) ----------

export function cardHints(db, cardId) {
  return db.prepare('SELECT hint FROM card_hints WHERE card_id = ? ORDER BY id').all(cardId).map((r) => r.hint);
}

export function saveHint(db, cardId, hint) {
  db.prepare('INSERT INTO card_hints (card_id, hint) VALUES (?, ?)').run(cardId, hint);
}

// ---------- Consumo real da IA ----------

export function logAiUsage(db, entry) {
  db.prepare(
    `INSERT INTO ai_usage (user_id, kind, model, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cards_saved, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.userId ?? null,
    entry.kind,
    entry.model ?? null,
    entry.status,
    entry.inputTokens ?? 0,
    entry.outputTokens ?? 0,
    entry.cacheReadTokens ?? 0,
    entry.cacheWriteTokens ?? 0,
    entry.costUsd ?? 0,
    entry.cardsSaved ?? 0,
    entry.detail ? String(entry.detail).slice(0, 500) : null
  );
}

export function aiSpendToday(db) {
  return db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM ai_usage WHERE created_at >= date('now')").get().c;
}

export function aiCallsToday(db, userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE user_id = ? AND created_at >= date('now')").get(userId).n;
}

export function aiUsageSummary(db, { days = 30, userId } = {}) {
  const params = [`-${Math.max(1, Math.min(days, 365))} days`];
  let where = "created_at >= datetime('now', ?)";
  if (userId) {
    where += ' AND user_id = ?';
    params.push(userId);
  }
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens,
              COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens, COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens,
              COALESCE(SUM(cost_usd),0) AS costUsd, COALESCE(SUM(cards_saved),0) AS cardsSaved
       FROM ai_usage WHERE ${where}`
    )
    .get(...params);
  const byKind = db
    .prepare(
      `SELECT kind, status, COUNT(*) AS calls, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens, SUM(cost_usd) AS costUsd
       FROM ai_usage WHERE ${where} GROUP BY kind, status ORDER BY kind, status`
    )
    .all(...params)
    .map((r) => ({ ...r }));
  const byDay = db
    .prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS calls, SUM(cost_usd) AS costUsd
       FROM ai_usage WHERE ${where} GROUP BY day ORDER BY day DESC`
    )
    .all(...params)
    .map((r) => ({ ...r }));
  return { totals: { ...totals }, byKind, byDay };
}

// ---------- Usuários e tokens do jogo ----------

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    tokens: row.tokens,
    lastBonus: row.last_bonus,
    gamesPlayed: row.games_played,
    cardsSolved: row.cards_solved,
    totalScore: row.total_score,
  };
}

export function getUser(db, id) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

export function upsertUser(db, id, name) {
  const cleanName = String(name || 'Jogador').trim().slice(0, 24) || 'Jogador';
  const existing = getUser(db, id);
  if (existing) {
    if (existing.name !== cleanName) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(cleanName, id);
    return getUser(db, id);
  }
  db.prepare('INSERT INTO users (id, name, tokens) VALUES (?, ?, ?)').run(id, cleanName, TOKEN_RULES.initial);
  logTokens(db, id, TOKEN_RULES.initial, 'boas-vindas');
  return getUser(db, id);
}

function logTokens(db, userId, delta, reason) {
  db.prepare('INSERT INTO token_log (user_id, delta, reason) VALUES (?, ?, ?)').run(userId, delta, reason);
}

export function addTokens(db, userId, delta, reason) {
  db.prepare('UPDATE users SET tokens = tokens + ? WHERE id = ?').run(delta, userId);
  logTokens(db, userId, delta, reason);
  return getUser(db, userId);
}

// Debita tokens de forma atômica; retorna null se o saldo for insuficiente.
export function spendTokens(db, userId, amount, reason) {
  const res = db.prepare('UPDATE users SET tokens = tokens - ? WHERE id = ? AND tokens >= ?').run(amount, userId, amount);
  if (res.changes === 0) return null;
  logTokens(db, userId, -amount, reason);
  return getUser(db, userId);
}

export function claimDailyBonus(db, userId, today = new Date().toISOString().slice(0, 10)) {
  const user = getUser(db, userId);
  if (!user) return { ok: false, error: 'Usuário não encontrado.' };
  if (user.lastBonus === today) return { ok: false, error: 'Bônus de hoje já resgatado. Volte amanhã!', user };
  db.prepare('UPDATE users SET last_bonus = ? WHERE id = ?').run(today, userId);
  return { ok: true, user: addTokens(db, userId, TOKEN_RULES.dailyBonus, 'bônus diário') };
}

export function tokenHistory(db, userId, limit = 20) {
  return db
    .prepare('SELECT delta, reason, created_at AS createdAt FROM token_log WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit)
    .map((r) => ({ ...r }));
}

export function recordUserResult(db, userId, { solved, score }) {
  db.prepare(
    'UPDATE users SET games_played = games_played + 1, cards_solved = cards_solved + ?, total_score = total_score + ? WHERE id = ?'
  ).run(solved ? 1 : 0, score, userId);
}

export function leaderboard(db, limit = 10) {
  return db
    .prepare('SELECT name, total_score AS totalScore, cards_solved AS cardsSolved FROM users WHERE total_score > 0 ORDER BY total_score DESC LIMIT ?')
    .all(limit)
    .map((r) => ({ ...r }));
}
