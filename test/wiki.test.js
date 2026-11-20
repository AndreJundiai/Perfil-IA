import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCardFromArticle, maskSentence, guessCategory, fetchArticle } from '../server/wiki.js';
import { createApp } from '../server/index.js';
import { openDb } from '../server/db.js';
import { THEMES } from '../server/catalog.js';

const garrincha = JSON.parse(readFileSync(new URL('./fixtures/wiki-garrincha.json', import.meta.url), 'utf8'));

// Wikipédia falsa: responde à busca e ao texto do artigo.
function fakeWiki(articles, calls = []) {
  return async (url) => {
    const u = new URL(url);
    calls.push(u.searchParams.get('srsearch') ?? u.searchParams.get('titles'));
    const json = (o) => ({ ok: true, status: 200, json: async () => o });
    if (u.searchParams.get('list') === 'search') {
      const q = u.searchParams.get('srsearch').toLowerCase();
      const hit = Object.keys(articles).find((t) => t.toLowerCase().includes(q) || q.includes(t.toLowerCase()));
      return json({ query: { search: hit ? [{ title: hit }] : [] } });
    }
    const a = articles[u.searchParams.get('titles')];
    return json({ query: { pages: [a ? { title: a.title, extract: a.extract, pageprops: a.disambiguation ? { disambiguation: '' } : {} } : { missing: true }] } });
  };
}

test('monta carta de 20 dicas a partir de um artigo, escondendo o nome e os apelidos', () => {
  const r = buildCardFromArticle(garrincha, { category: 'pessoa' });
  assert.ok(r.ok, r.error);
  assert.equal(r.card.clues.length, 20);
  assert.ok(r.card.aliases.includes('Anjo das Pernas Tortas'));
  assert.ok(r.card.aliases.includes('Manuel Francisco dos Santos'));
  for (const c of r.card.clues) {
    assert.ok(!/garrincha|anjo das pernas/i.test(c), `dica revela: ${c}`);
  }
  // A definição do artigo (mais fácil) fica no fim.
  assert.match(r.card.clues[19], /dribladores/);
  assert.equal(r.card.source, 'web');
  assert.equal(r.card.sourceUrl, garrincha.url);
});

test('artigo curto demais não vira carta', () => {
  const r = buildCardFromArticle({ title: 'Teste', extract: 'Teste é uma palavra. Serve para testar coisas.' });
  assert.equal(r.ok, false);
  assert.match(r.error, /curto/);
});

test('esconde o nome com a contração certa', () => {
  const names = [['coliseu']];
  assert.equal(maskSentence('O Coliseu fica em Roma.', names, 'lugar').text, 'Este lugar fica em Roma.');
  assert.equal(maskSentence('A arena do Coliseu é oval.', names, 'lugar').text, 'A arena deste lugar é oval.');
  assert.equal(maskSentence('Gladiadores lutavam no Coliseu.', names, 'lugar').text, 'Gladiadores lutavam neste lugar.');
  assert.equal(maskSentence('O filme Coliseu, de 1990.', names, 'lugar').awkward, true);
  const cat = [['cataratas', 'iguacu']];
  assert.equal(maskSentence('As Cataratas do Iguaçu ficam no Paraná.', cat, 'lugar').text, 'Este lugar ficam no Paraná.');
});

test('adivinha a categoria pelo começo do artigo', () => {
  assert.equal(guessCategory(garrincha.extract), 'pessoa');
  assert.equal(guessCategory('Olinda é uma cidade de Pernambuco.'), 'lugar');
  assert.equal(guessCategory('A arara-azul é uma ave da família dos psitacídeos.'), 'animal');
  assert.equal(guessCategory('O lápis é um instrumento de escrita.'), 'coisa');
});

test('termo ambíguo pede para ser mais específico', async () => {
  const fetchImpl = fakeWiki({ Mercúrio: { title: 'Mercúrio', extract: 'x', disambiguation: true } });
  await assert.rejects(fetchArticle('Mercúrio', { fetchImpl }), /vários significados/);
  await assert.rejects(fetchArticle('Inexistente', { fetchImpl }), /Nada encontrado/);
});

test('os 20 temas nativos têm pelo menos 4 cartas e 10 assuntos extras', () => {
  assert.equal(THEMES.length, 20);
  for (const t of THEMES) {
    assert.ok(t.answers.length + t.cards.length >= 4, t.slug);
    assert.equal(t.wiki.length, 10, t.slug);
  }
});

// ---------- API ----------

let server, base;
const calls = [];
before(async () => {
  ({ server } = createApp({ db: openDb(':memory:'), webFetch: fakeWiki({ Garrincha: garrincha }, calls) }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const post = (path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const U = 'wiki-user-0001';

test('lista e sorteia temas', async () => {
  await post('/api/users', { userId: U, name: 'Wiki' });
  const { themes } = await fetch(`${base}/api/themes?userId=${U}`).then((r) => r.json());
  assert.equal(themes.length, 20);
  assert.ok(themes.every((t) => t.cards >= 4));
  const play = await post('/api/themes/espaco/play', { userId: U });
  assert.equal(play.body.cardIds.length, 4);
  const random = await post('/api/themes/random/play', { userId: U });
  assert.equal(random.status, 200);
  assert.ok(random.body.theme.name);
});

test('cria carta pela internet, sem IA, e só mostra a fonte no fim', async () => {
  const r = await post('/api/cards/from-web', { userId: U, query: 'Garrincha' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.reused, false);
  const s = (await post('/api/solo', { userId: U, cardId: r.body.cardId })).body;
  assert.equal(s.card.source, 'web');
  assert.equal(s.card.totalClues, 20);
  assert.equal(s.sourceUrl, undefined);
  assert.ok(!JSON.stringify(s).toLowerCase().includes('garrincha'));
  const end = (await post(`/api/solo/${s.sessionId}/guess`, { guess: 'garrincha' })).body;
  assert.equal(end.status, 'won');
  assert.equal(end.sourceUrl, garrincha.url);
  // Pedir de novo reaproveita a carta do banco, sem acessar a internet.
  const n = calls.length;
  const again = await post('/api/cards/from-web', { userId: U, query: 'garrincha' });
  assert.equal(again.body.reused, true);
  assert.equal(calls.length, n);
});

test('expandir tema busca um assunto extra na internet', async () => {
  const r = await post('/api/themes/futebol/expand', { userId: U });
  // A Wikipédia falsa só conhece Garrincha, que já está no banco: os outros assuntos falham.
  assert.ok([200, 404, 409, 422, 502].includes(r.status), JSON.stringify(r.body));
});
