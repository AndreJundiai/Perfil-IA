import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as store from './db.js';
import { TOKEN_RULES, CATEGORIES, DIFFICULTIES } from './db.js';
import { SoloSession, Room, makeRoomCode } from './game.js';
import { aiAvailable, generateCards, generateHint, AiError } from './ai.js';

const here = dirname(fileURLToPath(import.meta.url));

export function createApp({ db = store.openDb() } = {}) {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(join(here, '..', 'public')));

  const soloSessions = new Map();
  const rooms = new Map();

  // Limpa partidas abandonadas.
  const janitor = setInterval(() => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, s] of soloSessions) if (s.touched < cutoff) soloSessions.delete(id);
    for (const [code, r] of rooms) if (r.isEmpty && r.touched < Date.now() - 10 * 60 * 1000) rooms.delete(code);
  }, 60 * 1000);
  janitor.unref();

  const asyncRoute = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((err) => {
      if (err instanceof AiError) return res.status(502).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'Erro interno.' });
    });

  function requireUser(req, res) {
    const userId = req.body?.userId ?? req.query.userId;
    const user = typeof userId === 'string' ? store.getUser(db, userId) : null;
    if (!user) {
      res.status(401).json({ error: 'Usuário não identificado. Recarregue a página.' });
      return null;
    }
    return user;
  }

  // Só deixa uma chamada de IA por usuário de cada vez.
  const aiBusy = new Set();
  async function withTokens(user, cost, reason, fn) {
    if (!aiAvailable()) throw new AiError('IA indisponível: o servidor não tem ANTHROPIC_API_KEY configurada.');
    if (aiBusy.has(user.id)) throw new AiError('Aguarde a IA terminar o pedido anterior.');
    const charged = store.spendTokens(db, user.id, cost, reason);
    if (!charged) {
      const e = new AiError(`Tokens insuficientes: este recurso custa ${cost}.`);
      e.status = 402;
      throw e;
    }
    aiBusy.add(user.id);
    try {
      return await fn();
    } catch (err) {
      store.addTokens(db, user.id, cost, `reembolso: ${reason}`);
      throw err;
    } finally {
      aiBusy.delete(user.id);
    }
  }

  // ---------- Configuração e usuários ----------

  app.get('/api/config', (_req, res) => {
    res.json({ aiAvailable: aiAvailable(), tokenRules: TOKEN_RULES, categories: CATEGORIES, difficulties: DIFFICULTIES });
  });

  app.post('/api/users', (req, res) => {
    const { userId, name } = req.body ?? {};
    if (typeof userId !== 'string' || !/^[\w-]{8,64}$/.test(userId)) return res.status(400).json({ error: 'ID inválido.' });
    res.json({ user: store.upsertUser(db, userId, name) });
  });

  app.get('/api/users/:id', (req, res) => {
    const user = store.getUser(db, req.params.id);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json({ user, history: store.tokenHistory(db, user.id) });
  });

  app.post('/api/tokens/daily', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const result = store.claimDailyBonus(db, user.id);
    if (!result.ok) return res.status(409).json({ error: result.error, user: result.user });
    res.json({ user: result.user });
  });

  app.get('/api/leaderboard', (_req, res) => res.json({ leaderboard: store.leaderboard(db) }));

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
        timesPlayed: c.timesPlayed,
        timesSolved: c.timesSolved,
        createdAt: c.createdAt,
        firstClue: c.clues[0],
      })),
    });
  });

  app.post(
    '/api/cards/generate',
    asyncRoute(async (req, res) => {
      const user = requireUser(req, res);
      if (!user) return;
      const { category, theme, difficulty } = req.body;
      const cat = CATEGORIES.includes(category) ? category : undefined;
      const diff = DIFFICULTIES.includes(difficulty) ? difficulty : 'medio';
      const cleanTheme = typeof theme === 'string' ? theme.trim().slice(0, 120) : '';
      try {
        const saved = await withTokens(user, TOKEN_RULES.costGenerateCard, 'carta criada pela IA', async () => {
          const avoid = store.listCards(db, { category: cat, limit: 200 }).cards.map((c) => c.answer);
          const [card] = await generateCards({ category: cat, theme: cleanTheme, difficulty: diff, count: 1, avoid });
          return store.insertCard(db, { ...card, theme: cleanTheme || null, source: 'ia', authorId: user.id }).card;
        });
        res.json({ cardId: saved.id, user: store.getUser(db, user.id) });
      } catch (err) {
        if (err.status === 402) return res.status(402).json({ error: err.message });
        throw err;
      }
    })
  );

  // Desafio personalizado: a IA cria uma sequência de cartas sobre um tema.
  app.post(
    '/api/challenges',
    asyncRoute(async (req, res) => {
      const user = requireUser(req, res);
      if (!user) return;
      const theme = typeof req.body.theme === 'string' ? req.body.theme.trim().slice(0, 120) : '';
      if (!theme) return res.status(400).json({ error: 'Escolha um tema para o desafio.' });
      const diff = DIFFICULTIES.includes(req.body.difficulty) ? req.body.difficulty : 'medio';
      try {
        const cardIds = await withTokens(user, TOKEN_RULES.costChallenge, `desafio: ${theme}`, async () => {
          const avoid = store.listCards(db, { limit: 200 }).cards.map((c) => c.answer);
          const cards = await generateCards({ theme, difficulty: diff, count: 5, avoid });
          return cards.map((c) => store.insertCard(db, { ...c, theme, source: 'ia', authorId: user.id }).card.id);
        });
        res.json({ theme, cardIds, user: store.getUser(db, user.id) });
      } catch (err) {
        if (err.status === 402) return res.status(402).json({ error: err.message });
        throw err;
      }
    })
  );

  // ---------- Partida individual ----------

  function getSession(req, res) {
    const s = soloSessions.get(req.params.id);
    if (!s) {
      res.status(404).json({ error: 'Partida não encontrada.' });
      return null;
    }
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

  app.post('/api/solo', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const { cardId, category, excludeIds } = req.body;
    const card = cardId
      ? store.getCard(db, cardId)
      : store.randomCard(db, { category, excludeIds: Array.isArray(excludeIds) ? excludeIds.slice(-100).map(String) : [] });
    if (!card) return res.status(404).json({ error: 'Carta não encontrada.' });
    const s = new SoloSession(card, user.id);
    soloSessions.set(s.id, s);
    res.json(s.view());
  });

  app.get('/api/solo/:id', (req, res) => {
    const s = getSession(req, res);
    if (s) res.json(s.view());
  });

  app.post('/api/solo/:id/clue', (req, res) => {
    const s = getSession(req, res);
    if (!s) return;
    const r = s.nextClue();
    if (!r.ok) return res.status(409).json({ error: r.error });
    res.json(s.view());
  });

  app.post('/api/solo/:id/guess', (req, res) => {
    const s = getSession(req, res);
    if (!s) return;
    const r = s.guess(req.body?.guess);
    if (!r.ok) return res.status(409).json({ error: r.error });
    const view = s.view();
    if (s.status !== 'playing') view.tokenReward = finishSolo(s);
    res.json({ ...view, correct: r.correct, user: store.getUser(db, s.userId) });
  });

  app.post('/api/solo/:id/give-up', (req, res) => {
    const s = getSession(req, res);
    if (!s) return;
    const wasPlaying = s.status === 'playing';
    s.giveUp();
    if (wasPlaying) finishSolo(s);
    res.json(s.view());
  });

  app.post(
    '/api/solo/:id/ai-hint',
    asyncRoute(async (req, res) => {
      const s = getSession(req, res);
      if (!s) return;
      if (s.status !== 'playing') return res.status(409).json({ error: 'A partida já terminou.' });
      if (s.extraHints.length >= 3) return res.status(409).json({ error: 'Limite de 3 dicas da IA por carta.' });
      const user = store.getUser(db, s.userId);
      try {
        const hint = await withTokens(user, TOKEN_RULES.costAiHint, 'dica extra da IA', () =>
          generateHint({ card: s.card, revealedClues: [...s.card.clues.slice(0, s.revealed), ...s.extraHints] })
        );
        s.extraHints.push(hint);
        res.json({ ...s.view(), user: store.getUser(db, s.userId) });
      } catch (err) {
        if (err.status === 402) return res.status(402).json({ error: err.message });
        throw err;
      }
    })
  );

  // ---------- Multiplayer (Socket.IO) ----------

  const server = createServer(app);
  const io = new Server(server);

  const drawCard = (opts) => store.randomCard(db, opts);

  function broadcast(room) {
    io.to(room.code).emit('room:state', room.view());
  }

  function afterRoundChange(room) {
    if ((room.state === 'roundEnd' || room.state === 'finished') && room.lastResult && !room.lastResult.recorded) {
      room.lastResult.recorded = true;
      store.recordCardResult(db, room.lastResult.cardId, Boolean(room.lastResult.winnerId));
      if (room.state === 'finished') {
        for (const p of room.players) store.recordUserResult(db, p.id, { solved: false, score: p.score });
      }
    }
    broadcast(room);
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
      broadcast(room);
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
        const r = fn(room, payload);
        reply(cb, r);
        if (r.ok) afterRoundChange(room);
      });

    action('room:settings', (room, p) => room.updateSettings(joined.userId, p));
    action('room:start', (room) => room.start(joined.userId));
    action('room:guess', (room, p) => room.guess(joined.userId, p.guess));
    action('room:pass', (room) => room.pass(joined.userId));
    action('room:next', (room) => room.nextRound(joined.userId));

    socket.on('disconnect', leave);
  });

  return { app, server, io, db, rooms, soloSessions };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createApp();
  server.listen(port, () => {
    console.log(`Perfil IA rodando em http://localhost:${port}`);
    console.log(aiAvailable() ? 'IA ativada.' : 'IA desativada (sem ANTHROPIC_API_KEY): usando só o banco de cartas.');
  });
}
