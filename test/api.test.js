import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { openDb, TOKEN_RULES } from '../server/db.js';
import { setClient, sanitizeCard } from '../server/ai.js';

// Cliente falso da Claude API: devolve JSON estruturado previsível.
let nextResponse;
setClient({ beta: { messages: { create: async () => nextResponse() } } });
const jsonReply = (obj) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });

let server, base;
before(async () => {
  ({ server } = createApp({ db: openDb(':memory:') }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (path) => fetch(base + path).then((r) => r.json());

const USER = 'test-user-0001';

test('cria usuário com tokens iniciais', async () => {
  const { body } = await post('/api/users', { userId: USER, name: 'Tester' });
  assert.equal(body.user.tokens, TOKEN_RULES.initial);
});

test('bônus diário só uma vez por dia', async () => {
  const a = await post('/api/tokens/daily', { userId: USER });
  assert.equal(a.body.user.tokens, TOKEN_RULES.initial + TOKEN_RULES.dailyBonus);
  const b = await post('/api/tokens/daily', { userId: USER });
  assert.equal(b.status, 409);
});

test('partida solo completa pela API', async () => {
  const start = await post('/api/solo', { userId: USER, category: 'lugar' });
  assert.equal(start.body.card.category, 'lugar');
  assert.equal(start.body.answer, undefined);
  const id = start.body.sessionId;
  const g = await post(`/api/solo/${id}/guess`, { guess: 'resposta impossível' });
  assert.equal(g.body.correct, false);
  const end = await post(`/api/solo/${id}/give-up`, {});
  assert.equal(end.body.status, 'lost');
  assert.ok(end.body.answer);
});

test('banco de cartas não revela respostas', async () => {
  const { total, cards } = await get('/api/cards?limit=5');
  assert.ok(total >= 20);
  assert.equal(cards[0].answer, undefined);
});

test('carta gerada pela IA é salva no banco e cobra tokens', async () => {
  const before = (await get(`/api/users/${USER}`)).user.tokens;
  nextResponse = () => jsonReply({ cards: [{
    category: 'coisa', answer: 'Guarda-chuva', aliases: ['Sombrinha'], difficulty: 'facil',
    clues: ['Fui popularizado na Inglaterra.', 'Posso ser dobrável.', 'Tenho varetas.', 'Sou aberto quando chove.', 'Tenho um cabo.', 'Me esquecem em ônibus.', 'Protejo do sol também.', 'Sou de tecido impermeável.', 'Você me abre na chuva.', 'Começo com "Guarda".'],
  }] });
  const r = await post('/api/cards/generate', { userId: USER, category: 'coisa' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.tokens, before - TOKEN_RULES.costGenerateCard);
  const { cards } = await get('/api/cards?source=ia');
  assert.ok(cards.some((c) => c.id === r.body.cardId));
  const play = await post('/api/solo', { userId: USER, cardId: r.body.cardId });
  const won = await post(`/api/solo/${play.body.sessionId}/guess`, { guess: 'guarda chuva' });
  assert.equal(won.body.status, 'won');
  assert.equal(won.body.tokenReward, TOKEN_RULES.rewardQuickGuess);
});

test('falha da IA devolve os tokens', async () => {
  const before = (await get(`/api/users/${USER}`)).user.tokens;
  nextResponse = () => ({ stop_reason: 'refusal', content: [] });
  const r = await post('/api/challenges', { userId: USER, theme: 'qualquer' });
  assert.equal(r.status, 502);
  assert.equal((await get(`/api/users/${USER}`)).user.tokens, before);
});

test('tokens insuficientes bloqueiam o recurso', async () => {
  await post('/api/users', { userId: 'pobre-0000001', name: 'Sem grana' });
  nextResponse = () => jsonReply({ cards: [] });
  // gasta 20 tokens em 4 desafios que falham? Não: falhas reembolsam. Testamos com custo maior que o saldo.
  for (let i = 0; i < 4; i++) {
    nextResponse = () => jsonReply({ cards: Array.from({ length: 5 }, (_, k) => ({ category: 'coisa', answer: `Item ${i}-${k}`, aliases: [], difficulty: 'medio', clues: Array.from({ length: 10 }, (_, j) => `pista ${j}`) })) });
    assert.equal((await post('/api/challenges', { userId: 'pobre-0000001', theme: 'teste' })).status, 200);
  }
  const r = await post('/api/challenges', { userId: 'pobre-0000001', theme: 'teste' });
  assert.equal(r.status, 402);
});

test('sanitizeCard remove dicas que entregam a resposta', () => {
  const c = sanitizeCard({ category: 'lugar', answer: 'Paris', aliases: [], difficulty: 'facil',
    clues: ['Sou chamada de Paris.', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'Paris é meu nome.'] });
  assert.equal(c.clues.length, 9);
  assert.ok(!c.clues[0].includes('Paris'));
  assert.equal(sanitizeCard({ answer: 'X', clues: ['a'] }), null);
});
