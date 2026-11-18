// Regras do jogo: pontuação, partida individual e salas multiplayer.
import { randomUUID } from 'node:crypto';
import { isCorrectGuess } from './matching.js';

export const MAX_POINTS = 10;

// Pontos por acertar depois de ver `revealed` dicas (1 dica => 10 pontos, 10 dicas => 1 ponto).
export function pointsFor(revealed, totalClues = 10) {
  return Math.max(1, MAX_POINTS - Math.round(((revealed - 1) * (MAX_POINTS - 1)) / Math.max(1, totalClues - 1)));
}

// Visão pública de uma carta: nunca inclui a resposta enquanto o jogo está em andamento.
export function publicCard(card, revealed, extraHints = []) {
  return {
    id: card.id,
    category: card.category,
    difficulty: card.difficulty,
    theme: card.theme,
    source: card.source,
    totalClues: card.clues.length,
    clues: card.clues.slice(0, revealed),
    extraHints,
  };
}

// ---------- Partida individual ----------

export class SoloSession {
  constructor(card, userId) {
    this.id = randomUUID();
    this.card = card;
    this.userId = userId;
    this.revealed = 1;
    this.extraHints = [];
    this.wrongGuesses = [];
    this.status = 'playing'; // playing | won | lost
    this.score = 0;
    this.touched = Date.now();
  }

  view() {
    const base = {
      sessionId: this.id,
      status: this.status,
      revealed: this.revealed,
      wrongGuesses: this.wrongGuesses,
      potentialPoints: pointsFor(this.revealed, this.card.clues.length),
      card: publicCard(this.card, this.revealed, this.extraHints),
    };
    if (this.status !== 'playing') {
      base.answer = this.card.answer;
      base.score = this.score;
      base.card.clues = this.card.clues; // ao fim mostramos todas as dicas
    }
    return base;
  }

  nextClue() {
    this.touched = Date.now();
    if (this.status !== 'playing') return { ok: false, error: 'A partida já terminou.' };
    if (this.revealed >= this.card.clues.length) return { ok: false, error: 'Não há mais dicas. Dê seu palpite ou desista.' };
    this.revealed++;
    return { ok: true };
  }

  // Palpite errado custa uma dica. Errar com todas as dicas abertas encerra a partida.
  guess(text) {
    this.touched = Date.now();
    if (this.status !== 'playing') return { ok: false, error: 'A partida já terminou.' };
    const guess = String(text ?? '').trim().slice(0, 80);
    if (!guess) return { ok: false, error: 'Digite um palpite.' };
    if (isCorrectGuess(guess, this.card.answer, this.card.aliases)) {
      this.status = 'won';
      // Cada dica extra da IA custa um ponto.
      this.score = Math.max(1, pointsFor(this.revealed, this.card.clues.length) - this.extraHints.length);
      return { ok: true, correct: true };
    }
    this.wrongGuesses.push(guess);
    if (this.revealed >= this.card.clues.length) {
      this.status = 'lost';
    } else {
      this.revealed++;
    }
    return { ok: true, correct: false };
  }

  giveUp() {
    this.touched = Date.now();
    if (this.status === 'playing') this.status = 'lost';
    return { ok: true };
  }
}

// ---------- Multiplayer ----------

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export function makeRoomCode(existing = new Set()) {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!existing.has(code)) return code;
  }
}

export const MAX_PLAYERS = 8;

export class Room {
  /**
   * @param {string} code
   * @param {{ drawCard: (opts: {category?: string, excludeIds: string[]}) => object }} deps
   */
  constructor(code, deps) {
    this.code = code;
    this.deps = deps;
    this.players = []; // { id, name, connected, score }
    this.hostId = null;
    this.settings = { rounds: 5, category: '', turnSeconds: 45 };
    this.state = 'lobby'; // lobby | playing | roundEnd | finished
    this.round = 0;
    this.card = null;
    this.revealed = 0;
    this.turnIndex = 0;
    this.exhaustedTurns = 0;
    this.usedCardIds = [];
    this.lastResult = null;
    this.log = [];
    this.turnDeadline = null;
    this.touched = Date.now();
  }

  addPlayer(id, name) {
    this.touched = Date.now();
    const existing = this.players.find((p) => p.id === id);
    if (existing) {
      existing.connected = true;
      existing.name = name || existing.name;
      if (!this.hostId) this.hostId = id;
      return { ok: true, rejoined: true };
    }
    if (this.state !== 'lobby') return { ok: false, error: 'A partida já começou.' };
    if (this.players.length >= MAX_PLAYERS) return { ok: false, error: 'A sala está cheia.' };
    this.players.push({ id, name, connected: true, score: 0 });
    if (!this.hostId) this.hostId = id;
    return { ok: true };
  }

  setConnected(id, connected) {
    const p = this.players.find((x) => x.id === id);
    if (!p) return;
    p.connected = connected;
    if (this.state === 'lobby' && !connected) {
      this.players = this.players.filter((x) => x.id !== id);
    }
    if (this.hostId === id && !connected) {
      const next = this.players.find((x) => x.connected);
      this.hostId = next ? next.id : null;
    }
  }

  get connectedPlayers() {
    return this.players.filter((p) => p.connected);
  }

  get isEmpty() {
    return this.connectedPlayers.length === 0;
  }

  currentPlayer() {
    return this.players[this.turnIndex] ?? null;
  }

  updateSettings(byId, settings) {
    if (byId !== this.hostId) return { ok: false, error: 'Só o anfitrião pode mudar as regras.' };
    if (this.state !== 'lobby' && this.state !== 'finished') return { ok: false, error: 'Partida em andamento.' };
    const rounds = Number(settings.rounds);
    if (Number.isInteger(rounds) && rounds >= 1 && rounds <= 20) this.settings.rounds = rounds;
    if (['', 'pessoa', 'lugar', 'coisa'].includes(settings.category)) this.settings.category = settings.category;
    const secs = Number(settings.turnSeconds);
    if (Number.isInteger(secs) && secs >= 15 && secs <= 120) this.settings.turnSeconds = secs;
    return { ok: true };
  }

  start(byId) {
    if (byId !== this.hostId) return { ok: false, error: 'Só o anfitrião pode começar.' };
    if (this.state === 'playing' || this.state === 'roundEnd') return { ok: false, error: 'A partida já começou.' };
    if (this.connectedPlayers.length < 2) return { ok: false, error: 'São necessários pelo menos 2 jogadores.' };
    // Remove quem saiu e zera o placar para uma nova partida.
    this.players = this.connectedPlayers;
    for (const p of this.players) p.score = 0;
    this.round = 0;
    this.usedCardIds = [];
    this.turnIndex = Math.floor(Math.random() * this.players.length);
    return this.startRound();
  }

  startRound() {
    const card = this.deps.drawCard({ category: this.settings.category || undefined, excludeIds: this.usedCardIds });
    if (!card) return { ok: false, error: 'Não há cartas no banco.' };
    this.round++;
    this.card = card;
    this.usedCardIds.push(card.id);
    this.revealed = 1;
    this.exhaustedTurns = 0;
    this.lastResult = null;
    this.state = 'playing';
    this.log = [{ type: 'round', text: `Rodada ${this.round} começou!` }];
    this.ensureTurnOnConnected();
    this.resetDeadline();
    return { ok: true };
  }

  resetDeadline(now = Date.now()) {
    this.turnDeadline = now + this.settings.turnSeconds * 1000;
  }

  ensureTurnOnConnected() {
    for (let i = 0; i < this.players.length; i++) {
      if (this.players[this.turnIndex]?.connected) return;
      this.turnIndex = (this.turnIndex + 1) % this.players.length;
    }
  }

  advanceTurn() {
    this.turnIndex = (this.turnIndex + 1) % this.players.length;
    this.ensureTurnOnConnected();
    this.resetDeadline();
  }

  // Abre a próxima dica. Quando acabam as dicas, cada jogador ainda tem uma última chance.
  openNextClueOrExhaust() {
    if (this.revealed < this.card.clues.length) {
      this.revealed++;
      return false;
    }
    this.exhaustedTurns++;
    if (this.exhaustedTurns >= this.connectedPlayers.length) {
      this.endRound(null);
      return true;
    }
    return false;
  }

  guess(byId, text) {
    this.touched = Date.now();
    if (this.state !== 'playing') return { ok: false, error: 'Não há rodada em andamento.' };
    const player = this.currentPlayer();
    if (!player || player.id !== byId) return { ok: false, error: 'Não é a sua vez.' };
    const guess = String(text ?? '').trim().slice(0, 80);
    if (!guess) return { ok: false, error: 'Digite um palpite.' };
    if (isCorrectGuess(guess, this.card.answer, this.card.aliases)) {
      const points = pointsFor(this.revealed, this.card.clues.length);
      player.score += points;
      this.log.push({ type: 'correct', text: `${player.name} acertou: "${guess}" (+${points})` });
      this.endRound({ winnerId: player.id, points });
      return { ok: true, correct: true, points };
    }
    this.log.push({ type: 'wrong', text: `${player.name} chutou "${guess}" e errou.` });
    const ended = this.openNextClueOrExhaust();
    if (!ended) this.advanceTurn();
    return { ok: true, correct: false };
  }

  pass(byId, { timeout = false } = {}) {
    this.touched = Date.now();
    if (this.state !== 'playing') return { ok: false, error: 'Não há rodada em andamento.' };
    const player = this.currentPlayer();
    if (!player || player.id !== byId) return { ok: false, error: 'Não é a sua vez.' };
    this.log.push({ type: 'pass', text: timeout ? `O tempo de ${player.name} acabou.` : `${player.name} pediu mais uma dica.` });
    const ended = this.openNextClueOrExhaust();
    if (!ended) this.advanceTurn();
    return { ok: true };
  }

  // Chamado periodicamente pelo servidor para pular quem estourou o tempo.
  tick(now = Date.now()) {
    if (this.state !== 'playing' || !this.turnDeadline || now < this.turnDeadline) return false;
    const player = this.currentPlayer();
    if (!player) return false;
    this.pass(player.id, { timeout: true });
    return true;
  }

  endRound(result) {
    this.turnDeadline = null;
    this.lastResult = {
      answer: this.card.answer,
      winnerId: result?.winnerId ?? null,
      points: result?.points ?? 0,
      clues: this.card.clues,
      cardId: this.card.id,
    };
    if (!result) this.log.push({ type: 'none', text: `Ninguém acertou. Era "${this.card.answer}".` });
    this.state = this.round >= this.settings.rounds ? 'finished' : 'roundEnd';
  }

  nextRound(byId) {
    if (byId !== this.hostId) return { ok: false, error: 'Só o anfitrião pode avançar.' };
    if (this.state !== 'roundEnd') return { ok: false, error: 'A rodada ainda não terminou.' };
    this.turnIndex = (this.turnIndex + 1) % this.players.length;
    return this.startRound();
  }

  view() {
    const current = this.currentPlayer();
    return {
      code: this.code,
      state: this.state,
      hostId: this.hostId,
      settings: this.settings,
      round: this.round,
      players: this.players.map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected })),
      turnPlayerId: this.state === 'playing' ? current?.id ?? null : null,
      turnDeadline: this.turnDeadline,
      revealed: this.revealed,
      potentialPoints: this.card ? pointsFor(this.revealed, this.card.clues.length) : 0,
      card: this.card && this.state !== 'lobby' ? publicCard(this.card, this.revealed) : null,
      lastResult: this.state === 'roundEnd' || this.state === 'finished' ? this.lastResult : null,
      log: this.log.slice(-12),
    };
  }
}
