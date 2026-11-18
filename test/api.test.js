import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createApp } from '../server/index.js';
import { openDb, TOKEN_RULES } from '../server/db.js';
import { costOf } from '../server/ai.js';
import { twentyClues } from './fixtures.js';

// Cliente falso da Claude API: conta as chamadas e devolve JSON estruturado previsível.
let nextResponse;
let calls = 0;
const fakeClient = { beta: { messages: { create: async () => { calls++; return nextResponse(); } } } };
const reply = (obj, usage = { input_tokens: 1000, output_tokens: 2000 }) => ({
  model: 'claude-opus-5-5', stop_reason: 'end_turn', usage, content: [{ type: 'text', text: JSON.stringify(obj) }],
});
const aiCard = (answer, over = {}) => ({
  category: 'coisa', category_label: 'Coisa', category_question: 'O que sou eu?', answer, aliases: [], difficulty: 'facil',
  clues: twentyClues(), ...over,
});

let server, base, db;
before(async () => {
  process.env.ADMIN_TOKEN = 'segredo-admin';
  db = openDb(':memory:');
  ({ server } = createApp({ db, aiClient: fakeClient }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (path, headers) => fetch(base + path, { headers }).then(async (r) => ({ status: r.status, body: await r.json() }));
const tokensOf = async (id) => (await get(`/api/users/${id}`)).body.user.tokens;

const USER = 'test-user-0001';

test('cria usuário com tokens iniciais', async () => {
  const { body } = await post('/api/users', { userId: USER, name: 'Tester' });
  assert.equal(body.user.tokens, TOKEN_RULES.initial);
});

test('bônus diário só uma vez por dia', async () => {
  assert.equal((await post('/api/tokens/daily', { userId: USER })).body.user.tokens, TOKEN_RULES.initial + TOKEN_RULES.dailyBonus);
  assert.equal((await post('/api/tokens/daily', { userId: USER })).status, 409);
});

test('partida solo completa pela API', async () => {
  const start = await post('/api/solo', { userId: USER, category: 'lugar' });
  assert.equal(start.body.card.category, 'lugar');
  assert.equal(start.body.answer, undefined);
  const id = start.body.sessionId;
  assert.equal((await post(`/api/solo/${id}/guess`, { guess: 'resposta impossível' })).body.correct, false);
  const end = await post(`/api/solo/${id}/give-up`, {});
  assert.equal(end.body.status, 'lost');
  assert.ok(end.body.answer);
});

test('banco de cartas não revela respostas', async () => {
  const { body } = await get('/api/cards?limit=5');
  assert.ok(body.total >= 20);
  assert.equal(body.cards[0].answer, undefined);
});

test('carta da IA: 20 dicas, salva no banco, cobra tokens e registra consumo real', async () => {
  const before = await tokensOf(USER);
  nextResponse = () => reply({ cards: [aiCard('Guarda-chuva', { aliases: ['Sombrinha'], category: 'objeto', category_label: 'Objeto', category_question: 'Que objeto sou eu?' })] });
  const r = await post('/api/cards/generate', { userId: USER, newCategory: 'Objeto', theme: 'chuva' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.reused, false);
  assert.equal(r.body.user.tokens, before - TOKEN_RULES.costGenerateCard);
  const play = await post('/api/solo', { userId: USER, cardId: r.body.cardId });
  assert.equal(play.body.card.totalClues, 20);
  assert.equal(play.body.card.category, 'objeto');
  const cats = (await get('/api/categories')).body.categories;
  assert.ok(cats.some((c) => c.slug === 'objeto'));
  const usage = (await get('/api/admin/usage', { 'x-admin-token': 'segredo-admin' })).body;
  assert.equal(usage.totals.calls, 1);
  assert.equal(usage.totals.inputTokens, 1000);
  assert.equal(usage.totals.outputTokens, 2000);
  assert.equal(usage.totals.cardsSaved, 1);
  assert.ok(Math.abs(usage.totals.costUsd - costOf('claude-opus-5-5', { input_tokens: 1000, output_tokens: 2000 })) < 1e-9);
});

test('reaproveita carta do banco em vez de chamar a IA', async () => {
  const OTHER = 'test-user-0002';
  await post('/api/users', { userId: OTHER, name: 'Outro' });
  const before = calls;
  const r = await post('/api/cards/generate', { userId: OTHER, category: 'objeto', theme: 'chuva' });
  assert.equal(r.body.reused, true);
  assert.equal(calls, before);
  assert.equal(await tokensOf(OTHER), TOKEN_RULES.initial); // nada cobrado
});

test('carta inválida ou duplicada não é salva e os tokens voltam', async () => {
  const before = await tokensOf(USER);
  const cardsBefore = (await get('/api/cards')).body.total;
  nextResponse = () => reply({ cards: [aiCard('Pelé', { category: 'pessoa' }), aiCard('Lápis', { clues: twentyClues().slice(0, 10) })] });
  const r = await post('/api/cards/generate', { userId: USER, theme: 'tema novo' });
  assert.equal(r.status, 502);
  assert.equal(await tokensOf(USER), before);
  assert.equal((await get('/api/cards')).body.total, cardsBefore);
  const usage = (await get('/api/admin/usage', { 'x-admin-token': 'segredo-admin' })).body;
  assert.ok(usage.byKind.some((k) => k.status === 'rejected'));
});

test('recusa e JSON inválido também devolvem os tokens', async () => {
  const before = await tokensOf(USER);
  nextResponse = () => ({ model: 'claude-opus-5-5', stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 0 }, content: [] });
  assert.equal((await post('/api/challenges', { userId: USER, theme: 'qualquer' })).status, 502);
  nextResponse = () => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: '{quebrado' }] });
  assert.equal((await post('/api/challenges', { userId: USER, theme: 'qualquer' })).status, 502);
  assert.equal(await tokensOf(USER), before);
});

test('desafio: gera 5 cartas; repetir o tema reaproveita sem IA', async () => {
  nextResponse = () => reply({ cards: ['Tundra', 'Bússola', 'Ampulheta', 'Lanterna', 'Mochila'].map((a) => aiCard(a)) });
  const r = await post('/api/challenges', { userId: USER, theme: 'Paisagens' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cardIds.length, 5);
  const OTHER = 'test-user-0003';
  await post('/api/users', { userId: OTHER, name: 'Terceiro' });
  const before = calls;
  const again = await post('/api/challenges', { userId: OTHER, theme: 'paisagens' });
  assert.equal(again.body.reused, true);
  assert.equal(calls, before);
});

test('dica extra fica salva e é reaproveitada sem nova chamada', async () => {
  const cardId = (await post('/api/cards/generate', { userId: 'test-user-0003', category: 'objeto', theme: 'chuva' })).body.cardId;
  nextResponse = () => reply({ hint: 'Muita gente me esquece pendurado no braço da cadeira.' });
  const s1 = (await post('/api/solo', { userId: USER, cardId })).body;
  const h1 = await post(`/api/solo/${s1.sessionId}/ai-hint`, {});
  assert.equal(h1.status, 200, JSON.stringify(h1.body));
  assert.equal(h1.body.reused, false);
  const before = calls;
  const s2 = (await post('/api/solo', { userId: 'test-user-0003', cardId })).body;
  const h2 = await post(`/api/solo/${s2.sessionId}/ai-hint`, { });
  assert.equal(h2.body.reused, true);
  assert.equal(calls, before);
  assert.deepEqual(h2.body.card.extraHints, h1.body.card.extraHints);
});

test('dica que entrega a resposta é rejeitada', async () => {
  const cardId = (await post('/api/solo', { userId: USER, category: 'objeto' })).body.card.id;
  db.prepare('DELETE FROM card_hints').run();
  nextResponse = () => reply({ hint: 'Sou o guarda-chuva que você leva quando chove.' });
  const s = (await post('/api/solo', { userId: USER, cardId })).body;
  const before = await tokensOf(USER);
  assert.equal((await post(`/api/solo/${s.sessionId}/ai-hint`, {})).status, 502);
  assert.equal(await tokensOf(USER), before);
});

test('orçamento diário esgotado bloqueia a IA antes da chamada', async () => {
  process.env.AI_DAILY_BUDGET_USD = '0.0001';
  const before = calls;
  const r = await post('/api/cards/generate', { userId: USER, newCategory: 'Planeta' });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /orçamento/);
  assert.equal(calls, before);
  delete process.env.AI_DAILY_BUDGET_USD;
});

test('tokens insuficientes bloqueiam o recurso', async () => {
  const POOR = 'pobre-0000001';
  await post('/api/users', { userId: POOR, name: 'Sem grana' });
  db.prepare('UPDATE users SET tokens = 1 WHERE id = ?').run(POOR);
  assert.equal((await post('/api/challenges', { userId: POOR, theme: 'tema inédito' })).status, 402);
});

test('relatório de consumo exige token de administrador', async () => {
  assert.equal((await get('/api/admin/usage')).status, 403);
  assert.equal((await get('/api/admin/usage', { 'x-admin-token': 'errado-errado' })).status, 403);
});

test('CORS liberado para o app Android', async () => {
  const r = await fetch(base + '/api/config', { headers: { Origin: 'http://localhost' } });
  assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost');
  const bad = await fetch(base + '/api/config', { headers: { Origin: 'https://site-malicioso.com' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const cfg = await r.json();
  assert.equal(cfg.cluesPerCard, 20);
  assert.ok(!JSON.stringify(cfg).toLowerCase().includes('key'));
});

test('nenhuma chave de API no código do cliente', () => {
  for (const f of readdirSync('public')) {
    const src = readFileSync(`public/${f}`, 'utf8');
    assert.ok(!/sk-ant-[\w-]+|x-api-key/i.test(src), `${f} contém referência a chave`);
  }
});
