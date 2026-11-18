import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import * as store from './db.js';
import { TOKEN_RULES, DIFFICULTIES } from './db.js';
import { CLUES_PER_CARD, slugify } from './cards.js';
import { SoloSession, Room, makeRoomCode } from './game.js';
import { createAi, AiError, aiLimits } from './ai.js';

const here = dirname(fileURLToPath(import.meta.url));

// Origens liberadas para o app Android (Capacitor) e para desenvolvimento.
function allowedOrigins() {
  const extra = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return new Set(['http://localhost', 'https://localhost', 'capacitor://localhost', ...extra]);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp({ db = store.openDb(), aiClient } = {}) {
  const ai = createAi({ db, client: aiClient });
  const app = express();
  const origins = allowedOrigins();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(join(here, '..', 'public')));
  app.get('/vendor/socket.io.min.js', (_req, res) =>
    res.sendFile(join(here, '..', 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js'))
  );

  const soloSessions = new Map();
  const rooms = new Map();

  const janitor = setInterval(() => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, s] of soloSessions) if (s.touched < cutoff) soloSessions.delete(id);
    for (const [code, r] of rooms) if (r.isEmpty && r.touched < Date.now() - 10 * 60 * 1000) rooms.delete(code);
  }, 60 * 1000);
  janitor.unref();

  const route = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((err) => {
      if (err instanceof AiError || err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'Erro interno.' });
    });

  function requireUser(req) {
    const userId = req.body?.userId ?? req.query.userId;
    const user = typeof userId === 'string' ? store.getUser(db, userId) : null;
    if (!user) throw new HttpError(401, 'Usuário não identificado. Recarregue a página.');
    return user;
  }

  // Cobra os tokens do jogo e devolve se a geração falhar.
  async function withTokens(user, cost, reason, fn) {
    if (!ai.available()) throw new AiError('IA indisponível: o servidor não tem ANTHROPIC_API_KEY configurada.', 503);
    if (!store.spendTokens(db, user.id, cost, reason)) throw new HttpError(402, `Tokens insuficientes: este recurso custa ${cost}.`);
    try {
      return await fn();
    } catch (err) {
      store.addTokens(db, user.id, cost, `reembolso: ${reason}`);
      throw err;
    }
  }

  // Resolve a categoria pedida: existente (slug) ou nova (nome livre).
  function resolveCategory({ category, newCategory }) {
    const label = typeof newCategory === 'string' ? newCategory.trim().slice(0, 30) : '';
    if (label) {
      const slug = slugify(label);
      if (!slug) throw new HttpError(400, 'Nome de categoria inválido.');
      const existing = store.getCategory(db, slug);
      return existing ?? { slug, label: label[0].toUpperCase() + label.slice(1), question: '', isNew: true };
    }
    if (!category) return null;
    const existing = store.getCategory(db, String(category));
    if (!existing) throw new HttpError(400, 'Categoria não encontrada.');
    return existing;
  }

  const cleanTheme = (t) => (typeof t === 'string' ? t.trim().replace(/\s+/g, ' ').slice(0, 120) : '');

  // ---------- Configuração e usuários ----------

  app.get('/api/config', (_req, res) => {
    res.json({
      aiAvailable: ai.available(),
      tokenRules: TOKEN_RULES,
      categories: store.listCategories(db),
      difficulties: DIFFICULTIES,
      cluesPerCard: CLUES_PER_CARD,
    });
  });

  app.get('/api/categories', (_req, res) => res.json({ categories: store.listCategories(db) }));

  app.post('/api/users', (req, res) => {
    const { userId, name } = req.body ?? {};
    if (typeof userId !== 'string' || !/^[\w-]{8,64}$/.test(userId)) return res.status(400).json({ error: 'ID inválido.' });
    res.json({ user: store.upsertUser(db, userId, name) });
  });

  app.get('/api/users/:id', (req, res) => {
    const user = store.getUser(db, req.params.id);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json({ user, history: store.tokenHistory(db, user.id), aiUsage: store.aiUsageSummary(db, { userId: user.id }).totals });
  });

  app.post('/api/tokens/daily', route((req, res) => {
    const user = requireUser(req);
    const result = store.claimDailyBonus(db, user.id);
    if (!result.ok) return res.status(409).json({ error: result.error, user: result.user });
    res.json({ user: result.user });
  }));

  app.get('/api/leaderboard', (_req, res) => res.json({ leaderboard: store.leaderboard(db) }));

  // Consumo real da IA (tokens da API e custo em US$). Protegido por ADMIN_TOKEN.
  app.get('/api/admin/usage', (req, res) => {
    const expected = process.env.ADMIN_TOKEN;
    const given = String(req.headers['x-admin-token'] ?? '');
    if (!expected) return res.status(404).json({ error: 'Defina ADMIN_TOKEN no servidor para ver o consumo.' });
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(403).json({ error: 'Token de administrador inválido.' });
    const days = Number(req.query.days) || 30;
    res.json({ limits: aiLimits(), spentTodayUsd: store.aiSpendToday(db), ...store.aiUsageSummary(db, { days }) });
  });

  // ---------- Banco de cartas ----------

  app.get('/api/cards', (req, res) => {
    const { category, source, search } = req.query;
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;
    const { total, cards } = store.listCards(db, { category, source, search, limit, offset });
    // A resposta não é enviada para não estragar a surpresa.
    res.json({
      total,
      cards: cards.map((c) => ({
        id: c.id,
        category: c.category,
        difficulty: c.difficulty,
        theme: c.theme,
        source: c.source,
        totalClues: c.clues.length,
        timesPlayed: c.timesPlayed,
        timesSolved: c.timesSolved,
        createdAt: c.createdAt,
        firstClue: c.clues[0],
      })),
    });
  });

  // Carta inteligente: reaproveita uma carta do banco quando existe; só chama a IA se não houver.
  app.post('/api/cards/generate', route(async (req, res) => {
    const user = requireUser(req);
    const category = resolveCategory(req.body);
    const asked = DIFFICULTIES.includes(req.body.difficulty) ? req.body.difficulty : undefined;
    const difficulty = asked ?? 'medio';
    const theme = cleanTheme(req.body.theme);

    if (!category?.isNew) {
      const [reuse] = store.findReusableCards(db, { userId: user.id, category: category?.slug, difficulty: asked, theme: theme || undefined });
      if (reuse) return res.json({ cardId: reuse.id, reused: true, user });
    }
    const { saved } = await withTokens(user, TOKEN_RULES.costGenerateCard, 'carta criada pela IA', () =>
      ai.generateCards({ userId: user.id, category, theme, difficulty, count: 1 })
    );
    res.json({ cardId: saved[0].id, reused: false, user: store.getUser(db, user.id) });
  }));

  // Desafio personalizado: 5 cartas de um tema. Usa o banco se já houver cartas suficientes do tema.
  app.post('/api/challenges', route(async (req, res) => {
    const user = requireUser(req);
    const theme = cleanTheme(req.body.theme);
    if (!theme) throw new HttpError(400, 'Escolha um tema para o desafio.');
    const difficulty = DIFFICULTIES.includes(req.body.difficulty) ? req.body.difficulty : 'medio';
    const size = 5;

    const reusable = store.findReusableCards(db, { userId: user.id, theme, limit: size });
    if (reusable.length >= size) {
      return res.json({ theme, cardIds: reusable.map((c) => c.id), reused: true, user });
    }
    const { saved } = await withTokens(user, TOKEN_RULES.costChallenge, `desafio: ${theme}`, () =>
      ai.generateCards({ userId: user.id, theme, difficulty, count: size - reusable.length })
    );
    const cardIds = [...reusable, ...saved].map((c) => c.id);
    res.json({ theme, cardIds, reused: false, user: store.getUser(db, user.id) });
  }));

  // ---------- Partida individual ----------

  function getSession(req) {
    const s = soloSessions.get(req.params.id);
    if (!s) throw new HttpError(404, 'Partida não encontrada.');
    return s;
  }

  function finishSolo(s) {
    store.recordCardResult(db, s.card.id, s.status === 'won');
    store.recordUserResult(db, s.userId, { solved: s.status === 'won', score: s.score });
    if (s.status === 'won' && s.revealed <= 3) {
      store.addTokens(db, s.userId, TOKEN_RULES.rewardQuickGuess, 'acerto rápido');
      return TOKEN_RULES.rewardQuickGuess;
    }
    return 0;
  }

  app.post('/api/solo', route((req, res) => {
    const user = requireUser(req);
    const { cardId, category, excludeIds } = req.body;
    const card = cardId
      ? store.getCard(db, String(cardId))
      : store.randomCard(db, {
          category: category || undefined,
          userId: user.id,
          excludeIds: Array.isArray(excludeIds) ? excludeIds.slice(-100).map(String) : [],
        });
    if (!card) throw new HttpError(404, 'Carta não encontrada.');
    store.markPlayed(db, user.id, card.id);
    const s = new SoloSession(card, user.id);
    soloSessions.set(s.id, s);
    res.json(s.view());
  }));

  app.get('/api/solo/:id', route((req, res) => res.json(getSession(req).view())));

  app.post('/api/solo/:id/clue', route((req, res) => {
    const s = getSession(req);
    const r = s.nextClue();
    if (!r.ok) throw new HttpError(409, r.error);
    res.json(s.view());
  }));

  app.post('/api/solo/:id/guess', route((req, res) => {
    const s = getSession(req);
    const r = s.guess(req.body?.guess);
    if (!r.ok) throw new HttpError(409, r.error);
    const view = s.view();
    if (s.status !== 'playing') view.tokenReward = finishSolo(s);
    res.json({ ...view, correct: r.correct, user: store.getUser(db, s.userId) });
  }));

  app.post('/api/solo/:id/give-up', route((req, res) => {
    const s = getSession(req);
    const wasPlaying = s.status === 'playing';
    s.giveUp();
    if (wasPlaying) finishSolo(s);
    res.json(s.view());
  }));

  // Dica extra: usa primeiro as dicas já geradas para esta carta; só chama a IA se não houver.
  app.post('/api/solo/:id/ai-hint', route(async (req, res) => {
    const s = getSession(req);
    if (s.status !== 'playing') throw new HttpError(409, 'A partida já terminou.');
    if (s.extraHints.length >= 3) throw new HttpError(409, 'Limite de 3 dicas extras por carta.');
    const user = store.getUser(db, s.userId);
    const cached = store.cardHints(db, s.card.id).find((h) => !s.extraHints.includes(h));
    let reused = false;
    if (cached) {
      if (!store.spendTokens(db, user.id, TOKEN_RULES.costAiHint, 'dica extra (banco)')) {
        throw new HttpError(402, `Tokens insuficientes: este recurso custa ${TOKEN_RULES.costAiHint}.`);
      }
      s.extraHints.push(cached);
      reused = true;
    } else {
      const hint = await withTokens(user, TOKEN_RULES.costAiHint, 'dica extra da IA', () =>
        ai.generateHint({ userId: user.id, card: s.card, seenClues: [...s.card.clues.slice(0, s.revealed), ...s.extraHints] })
      );
      s.extraHints.push(hint);
    }
    res.json({ ...s.view(), reused, user: store.getUser(db, s.userId) });
  }));

  // ---------- Multiplayer (Socket.IO) ----------

  const server = createServer(app);
  const io = new Server(server, { cors: { origin: [...origins] } });

  const drawCard = (opts) => store.randomCard(db, opts);

  function afterRoundChange(room) {
    if (room.card && room.markedCardId !== room.card.id) {
      room.markedCardId = room.card.id;
      for (const p of room.players) store.markPlayed(db, p.id, room.card.id);
    }
    if ((room.state === 'roundEnd' || room.state === 'finished') && room.lastResult && !room.lastResult.recorded) {
      room.lastResult.recorded = true;
      store.recordCardResult(db, room.lastResult.cardId, Boolean(room.lastResult.winnerId));
      if (room.state === 'finished') {
        for (const p of room.players) store.recordUserResult(db, p.id, { solved: false, score: p.score });
      }
    }
    io.to(room.code).emit('room:state', room.view());
  }

  const ticker = setInterval(() => {
    for (const room of rooms.values()) if (room.tick()) afterRoundChange(room);
  }, 1000);
  ticker.unref();

  io.on('connection', (socket) => {
    let joined = null; // { code, userId }
    const reply = (cb, payload) => typeof cb === 'function' && cb(payload);

    function join(code, userId, cb) {
      const user = store.getUser(db, userId);
      if (!user) return reply(cb, { ok: false, error: 'Usuário não identificado.' });
      const room = rooms.get(String(code).toUpperCase());
      if (!room) return reply(cb, { ok: false, error: 'Sala não encontrada.' });
      const r = room.addPlayer(user.id, user.name);
      if (!r.ok) return reply(cb, r);
      if (joined && joined.code !== room.code) leave();
      joined = { code: room.code, userId: user.id };
      socket.join(room.code);
      reply(cb, { ok: true, code: room.code });
      afterRoundChange(room);
    }

    function leave() {
      if (!joined) return;
      const room = rooms.get(joined.code);
      socket.leave(joined.code);
      if (room) {
        const wasTurn = room.state === 'playing' && room.currentPlayer()?.id === joined.userId;
        room.setConnected(joined.userId, false);
        if (wasTurn) room.advanceTurn();
        if (room.state === 'playing' && room.connectedPlayers.length < 2) {
          room.log.push({ type: 'none', text: 'Jogadores insuficientes: a partida foi encerrada.' });
          room.endRound(null);
          room.state = 'finished';
        }
        afterRoundChange(room);
      }
      joined = null;
    }

    socket.on('room:create', ({ userId } = {}, cb) => {
      const code = makeRoomCode(new Set(rooms.keys()));
      rooms.set(code, new Room(code, { drawCard }));
      join(code, userId, cb);
    });
    socket.on('room:join', ({ code, userId } = {}, cb) => join(code, userId, cb));
    socket.on('room:leave', (_p, cb) => {
      leave();
      reply(cb, { ok: true });
    });

    const action = (name, fn) =>
      socket.on(name, (payload = {}, cb) => {
        const room = joined && rooms.get(joined.code);
        if (!room) return reply(cb, { ok: false, error: 'Você não está em uma sala.' });
        const r = fn(room, payload ?? {});
        reply(cb, r);
        if (r.ok) afterRoundChange(room);
      });

    action('room:settings', (room, p) => room.updateSettings(joined.userId, p, store.listCategories(db).map((c) => c.slug)));
    action('room:start', (room) => room.start(joined.userId));
    action('room:guess', (room, p) => room.guess(joined.userId, p.guess));
    action('room:pass', (room) => room.pass(joined.userId));
    action('room:next', (room) => room.nextRound(joined.userId));

    socket.on('disconnect', leave);
  });

  return { app, server, io, db, ai, rooms, soloSessions };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const { server, ai } = createApp();
  server.listen(port, () => {
    console.log(`Perfil IA rodando em http://localhost:${port}`);
    console.log(ai.available() ? 'IA ativada.' : 'IA desativada (sem ANTHROPIC_API_KEY): usando só o banco de cartas.');
  });
}
