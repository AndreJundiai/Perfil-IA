// Modo sem servidor: o próprio app faz o papel do servidor.
// Responde às mesmas rotas de /api que o servidor Node, usando as regras de shared/
// e guardando tudo no aparelho (localStorage). Multiplayer e IA continuam precisando do servidor.
import { SoloSession } from './shared/game.js';
import { CATALOG, THEMES, EXTRA_CATEGORIES, themeBySlug } from './shared/catalog.js';
import { BASE_CATEGORIES, CLUES_PER_CARD, DIFFICULTIES, answerKey } from './shared/cards.js';
import { cardFromWeb } from './shared/wiki.js';
import { TOKEN_RULES } from './shared/rules.js';

const KEYS = { user: 'perfil.local.user', cards: 'perfil.local.cards', plays: 'perfil.local.plays', stats: 'perfil.local.stats' };

const read = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d;
  } catch {
    return d;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* armazenamento cheio ou indisponível: segue só na memória */
  }
};

const fail = (status, message) => Object.assign(new Error(message), { status });
const slugId = (answer) => `n-${answerKey(answer).replace(/\s+/g, '-')}`;
const today = () => new Date().toISOString().slice(0, 10);

const NATIVE = CATALOG.map((c) => ({ ...c, id: slugId(c.answer), source: 'seed', timesPlayed: 0, timesSolved: 0 }));
const CATEGORIES = [...BASE_CATEGORIES, ...EXTRA_CATEGORIES];

function customCards() {
  return read(KEYS.cards, []);
}
function allCards() {
  const stats = read(KEYS.stats, {});
  return [...NATIVE, ...customCards()].map((c) => ({ ...c, timesPlayed: stats[c.id]?.p ?? 0, timesSolved: stats[c.id]?.s ?? 0 }));
}
const getCard = (id) => allCards().find((c) => c.id === id) ?? null;

function findDuplicate(answer, aliases = []) {
  const keys = new Set([answer, ...aliases].map(answerKey).filter(Boolean));
  return allCards().find((c) => [c.answer, ...(c.aliases ?? [])].some((n) => keys.has(answerKey(n)))) ?? null;
}

const plays = () => new Set(read(KEYS.plays, []));
function markPlayed(id) {
  const p = plays();
  p.add(id);
  write(KEYS.plays, [...p]);
}
function recordCard(id, solved) {
  const stats = read(KEYS.stats, {});
  stats[id] = { p: (stats[id]?.p ?? 0) + 1, s: (stats[id]?.s ?? 0) + (solved ? 1 : 0) };
  write(KEYS.stats, stats);
}

// ---------- jogador e tokens ----------

function getUser(id, name) {
  let u = read(KEYS.user, null);
  if (!u) {
    u = { id, name: name || 'Jogador', tokens: TOKEN_RULES.initial, lastBonus: null, gamesPlayed: 0, cardsSolved: 0, totalScore: 0 };
    write(KEYS.user, u);
  }
  return u;
}
function saveUser(u) {
  write(KEYS.user, u);
  return u;
}

// ---------- categorias, temas e banco ----------

function listCategories() {
  const cards = allCards();
  return CATEGORIES.map((c) => ({ ...c, source: 'base', cards: cards.filter((k) => k.category === c.slug).length }));
}

function listThemes() {
  const cards = allCards();
  const p = plays();
  return THEMES.map((t) => {
    const mine = cards.filter((c) => c.theme === t.name);
    return { slug: t.slug, name: t.name, emoji: t.emoji, cards: mine.length, unplayed: mine.filter((c) => !p.has(c.id)).length, webTopics: t.wiki.length };
  });
}

const shuffle = (a) => {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
};

function themeCardIds(theme, limit = 5) {
  const p = plays();
  const mine = allCards().filter((c) => c.theme === theme.name);
  const fresh = shuffle(mine.filter((c) => !p.has(c.id)));
  const rest = shuffle(mine.filter((c) => p.has(c.id)));
  return [...fresh, ...rest].slice(0, limit).map((c) => c.id);
}

function randomCard({ category, excludeIds = [] }) {
  const p = plays();
  const ex = new Set(excludeIds);
  const pool = allCards().filter((c) => !category || c.category === category);
  const tries = [pool.filter((c) => !p.has(c.id) && !ex.has(c.id)), pool.filter((c) => !ex.has(c.id)), pool];
  for (const list of tries) if (list.length) return list[Math.floor(Math.random() * list.length)];
  return null;
}

function listCardsSummary({ category, source, search }) {
  const q = (search ?? '').toLowerCase();
  const cards = allCards()
    .filter((c) => !category || c.category === category)
    .filter((c) => !source || c.source === source)
    .filter((c) => !q || (c.theme ?? '').toLowerCase().includes(q) || c.category.includes(q))
    .reverse();
  return {
    total: cards.length,
    cards: cards.slice(0, 200).map((c) => ({
      id: c.id, category: c.category, difficulty: c.difficulty, theme: c.theme, source: c.source,
      totalClues: c.clues.length, timesPlayed: c.timesPlayed, timesSolved: c.timesSolved, firstClue: c.clues[0],
    })),
  };
}

// ---------- cartas da internet ----------

let webBusy = false;
async function createFromWeb(query, { category, theme }) {
  if (webBusy) throw fail(429, 'Aguarde a busca anterior terminar.');
  webBusy = true;
  try {
    const card = await cardFromWeb(query, { category, theme });
    const dup = findDuplicate(card.answer, card.aliases);
    if (dup) return { card: dup, reused: true };
    const saved = { ...card, id: `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, createdAt: new Date().toISOString() };
    write(KEYS.cards, [...customCards(), saved]);
    return { card: saved, reused: false };
  } catch (err) {
    if (err.status) throw err;
    throw fail(502, 'Não foi possível acessar a Wikipédia. Verifique a internet do celular.');
  } finally {
    webBusy = false;
  }
}

// ---------- partidas ----------

const sessions = new Map();

function finishSolo(s, user) {
  recordCard(s.card.id, s.status === 'won');
  user.gamesPlayed++;
  if (s.status === 'won') {
    user.cardsSolved++;
    user.totalScore += s.score;
  }
  let reward = 0;
  if (s.status === 'won' && s.revealed <= 3) {
    user.tokens += TOKEN_RULES.rewardQuickGuess;
    reward = TOKEN_RULES.rewardQuickGuess;
  }
  saveUser(user);
  return reward;
}

// ---------- roteador ----------

export function createLocalApi(userId) {
  return async function localApi(path, { method = 'GET', body = {} } = {}) {
    const url = new URL(path, 'http://local');
    const p = url.pathname;
    const q = Object.fromEntries(url.searchParams);
    const user = () => getUser(userId, body.name);
    let m;

    if (p === '/api/config') {
      return { aiAvailable: false, offline: true, tokenRules: TOKEN_RULES, categories: listCategories(), difficulties: DIFFICULTIES, cluesPerCard: CLUES_PER_CARD, webAvailable: true };
    }
    if (p === '/api/users' && method === 'POST') {
      const u = user();
      if (body.name && body.name !== u.name) u.name = String(body.name).slice(0, 24);
      return { user: saveUser(u) };
    }
    if ((m = p.match(/^\/api\/users\/[^/]+$/))) return { user: user(), history: [] };
    if (p === '/api/tokens/daily') {
      const u = user();
      if (u.lastBonus === today()) throw Object.assign(fail(409, 'Bônus de hoje já resgatado. Volte amanhã!'), { user: u });
      u.lastBonus = today();
      u.tokens += TOKEN_RULES.dailyBonus;
      return { user: saveUser(u) };
    }
    if (p === '/api/leaderboard') {
      const u = user();
      return { leaderboard: u.totalScore > 0 ? [{ name: u.name, totalScore: u.totalScore, cardsSolved: u.cardsSolved }] : [] };
    }
    if (p === '/api/categories') return { categories: listCategories() };
    if (p === '/api/cards' && method === 'GET') return listCardsSummary(q);
    if (p === '/api/themes') return { themes: listThemes() };

    if ((m = p.match(/^\/api\/themes\/([^/]+)\/play$/))) {
      let theme = themeBySlug(m[1]);
      if (m[1] === 'random') {
        const list = listThemes().filter((t) => t.cards > 0);
        const fresh = list.filter((t) => t.unplayed > 0);
        const pool = fresh.length ? fresh : list;
        theme = themeBySlug(pool[Math.floor(Math.random() * pool.length)].slug);
      }
      if (!theme) throw fail(404, 'Tema não encontrado.');
      return { theme: { slug: theme.slug, name: theme.name, emoji: theme.emoji }, cardIds: themeCardIds(theme) };
    }
    if ((m = p.match(/^\/api\/themes\/([^/]+)\/expand$/))) {
      const theme = themeBySlug(m[1]);
      if (!theme) throw fail(404, 'Tema não encontrado.');
      const counts = {};
      for (const c of allCards().filter((x) => x.theme === theme.name)) counts[c.category] = (counts[c.category] ?? 0) + 1;
      const category = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'coisa';
      const pending = shuffle(theme.wiki.filter((t) => !findDuplicate(t.replace(/\s*\([^)]*\)\s*$/, ''))));
      if (!pending.length) throw fail(409, 'Todos os assuntos extras deste tema já viraram cartas.');
      let last;
      for (const topic of pending.slice(0, 3)) {
        try {
          const { card } = await createFromWeb(topic, { category, theme: theme.name });
          return { cardId: card.id, topic, remaining: pending.length - 1 };
        } catch (err) {
          if (err.status === 429) throw err;
          last = err;
        }
      }
      throw last;
    }
    if (p === '/api/cards/from-web') {
      const query = String(body.query ?? '').trim().slice(0, 100);
      if (query.length < 2) throw fail(400, 'Digite o que você quer buscar.');
      const existing = findDuplicate(query);
      if (existing) return { cardId: existing.id, reused: true };
      const category = CATEGORIES.some((c) => c.slug === body.category) ? body.category : undefined;
      const { card, reused } = await createFromWeb(query, { category, theme: null });
      return { cardId: card.id, reused };
    }
    if (p === '/api/cards/generate' || p === '/api/challenges') {
      throw fail(503, 'Criar com IA precisa do servidor com a chave da Anthropic. Sem servidor, use os temas ou a busca na internet.');
    }

    if (p === '/api/solo' && method === 'POST') {
      const card = body.cardId ? getCard(String(body.cardId)) : randomCard({ category: body.category, excludeIds: body.excludeIds ?? [] });
      if (!card) throw fail(404, 'Carta não encontrada.');
      markPlayed(card.id);
      const s = new SoloSession(card, userId);
      sessions.set(s.id, s);
      return s.view();
    }
    if ((m = p.match(/^\/api\/solo\/([^/]+)(?:\/([a-z-]+))?$/))) {
      const s = sessions.get(m[1]);
      if (!s) throw fail(404, 'Partida não encontrada.');
      const action = m[2];
      if (!action) return s.view();
      if (action === 'clue') {
        const r = s.nextClue();
        if (!r.ok) throw fail(409, r.error);
        return s.view();
      }
      if (action === 'guess') {
        const r = s.guess(body.guess);
        if (!r.ok) throw fail(409, r.error);
        const view = s.view();
        const u = user();
        if (s.status !== 'playing') view.tokenReward = finishSolo(s, u);
        return { ...view, correct: r.correct, user: user() };
      }
      if (action === 'give-up') {
        const was = s.status === 'playing';
        s.giveUp();
        if (was) finishSolo(s, user());
        return s.view();
      }
      if (action === 'ai-hint') throw fail(503, 'A dica da IA precisa do servidor. Use "Próxima dica".');
    }
    throw fail(404, 'Recurso indisponível sem servidor.');
  };
}
