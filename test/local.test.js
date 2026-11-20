// Modo sem servidor (APK sem endereço configurado): o app responde às rotas sozinho.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const { createLocalApi } = await import('../www/local.js');
let api;
beforeEach(() => {
  mem.clear();
  api = createLocalApi('local-user-1');
});

test('sem servidor: carrega config, jogador e os 20 temas', async () => {
  const cfg = await api('/api/config');
  assert.equal(cfg.offline, true);
  assert.equal(cfg.aiAvailable, false);
  assert.ok(cfg.categories.some((c) => c.slug === 'animal'));
  const { user } = await api('/api/users', { method: 'POST', body: { name: 'Ana' } });
  assert.equal(user.tokens, 20);
  const { themes } = await api('/api/themes');
  assert.equal(themes.length, 20);
  assert.ok(themes.every((t) => t.cards === 4 && t.unplayed === 4));
});

test('sem servidor: sorteia tema, joga, acerta e guarda pontos e fichas', async () => {
  const { theme, cardIds } = await api('/api/themes/random/play', { method: 'POST' });
  assert.ok(theme.name);
  assert.equal(cardIds.length, 4);
  const s = await api('/api/solo', { method: 'POST', body: { cardId: cardIds[0] } });
  assert.equal(s.answer, undefined);
  const lost = await api(`/api/solo/${s.sessionId}/give-up`, { method: 'POST' });
  const s2 = await api('/api/solo', { method: 'POST', body: { cardId: cardIds[0] } });
  const won = await api(`/api/solo/${s2.sessionId}/guess`, { method: 'POST', body: { guess: lost.answer } });
  assert.equal(won.status, 'won');
  assert.equal(won.score, 10);
  assert.equal(won.tokenReward, 1);
  assert.equal(won.user.tokens, 21);
  assert.equal(won.user.totalScore, 10);
  const { themes } = await api('/api/themes');
  assert.equal(themes.find((t) => t.name === theme.name).unplayed, 3);
});

test('sem servidor: recursos de IA e multiplayer avisam que precisam do servidor', async () => {
  await assert.rejects(api('/api/cards/generate', { method: 'POST', body: {} }), /servidor/);
  const s = await api('/api/solo', { method: 'POST', body: {} });
  await assert.rejects(api(`/api/solo/${s.sessionId}/ai-hint`, { method: 'POST' }), /servidor/);
});

test('sem servidor: banco de cartas lista as 80 cartas nativas sem revelar respostas', async () => {
  const bank = await api('/api/cards?category=animal');
  assert.equal(bank.total, 4);
  assert.equal(bank.cards[0].answer, undefined);
  assert.equal((await api('/api/cards')).total, 80);
});
