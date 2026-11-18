import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCard, clueRevealsAnswer, CLUES_PER_CARD, slugify } from '../server/cards.js';
import { openDb, insertCard, findDuplicate, ensureCategory } from '../server/db.js';
import { twentyClues } from './fixtures.js';

const base = (over = {}) => ({
  category: 'lugar', category_label: 'Lugar', category_question: 'Que lugar sou eu?',
  answer: 'Torre Eiffel', aliases: ['Tour Eiffel'], difficulty: 'facil', clues: twentyClues(), ...over,
});

test('aceita carta válida com exatamente 20 dicas', () => {
  const r = validateCard(base());
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.card.clues.length, 20);
});

test('exige exatamente 20 dicas', () => {
  assert.ok(!validateCard(base({ clues: twentyClues().slice(0, 19) })).ok);
  assert.ok(!validateCard(base({ clues: [...twentyClues(), 'Uma dica a mais aqui.'] })).ok);
});

test('rejeita carta sem categoria ou fora da categoria pedida', () => {
  assert.ok(!validateCard(base({ category: '', category_label: '' })).ok);
  assert.ok(!validateCard(base(), { category: 'pessoa' }).ok);
  assert.ok(!validateCard(base({ category: 'planeta', category_label: 'Planeta' }), { allowed: ['pessoa', 'lugar'] }).ok);
});

test('rejeita dicas que revelam a resposta, mesmo a última e mesmo parcialmente', () => {
  const clues = twentyClues();
  clues[19] = 'Levo o nome do engenheiro Gustave Eiffel.';
  const r = validateCard(base({ clues }));
  assert.ok(!r.ok);
  assert.match(r.errors.join(), /Dica 20 revela/);
  assert.ok(clueRevealsAnswer('Sou a famosa Torre Eifel de Paris', 'Torre Eiffel'));
  assert.ok(!clueRevealsAnswer('Fico às margens do rio Sena', 'Torre Eiffel'));
});

test('rejeita dicas repetidas, curtas e JSON malformado', () => {
  const clues = twentyClues();
  clues[5] = clues[4];
  assert.match(validateCard(base({ clues })).errors.join(), /repete/);
  const short = twentyClues();
  short[0] = 'Curta';
  assert.match(validateCard(base({ clues: short })).errors.join(), /curta/);
  assert.ok(!validateCard(null).ok);
  assert.ok(!validateCard([]).ok);
  assert.ok(!validateCard(base({ clues: 'texto' })).ok);
  assert.ok(!validateCard(base({ difficulty: 'impossivel' })).ok);
});

test('detecta respostas duplicadas por nome ou apelido', () => {
  const db = openDb(':memory:');
  assert.ok(findDuplicate(db, 'pele'));
  assert.ok(findDuplicate(db, 'Edson Arantes do Nascimento'));
  assert.ok(findDuplicate(db, 'Novo nome', ['Tour Eiffel']));
  assert.equal(findDuplicate(db, 'Guarda-chuva'), null);
  const again = insertCard(db, { category: 'pessoa', answer: 'PELÉ', aliases: [], clues: twentyClues(), difficulty: 'facil' });
  assert.equal(again.created, false);
  assert.throws(() => insertCard(db, { answer: 'Sem categoria', clues: twentyClues() }));
});

test('cria categorias novas', () => {
  const db = openDb(':memory:');
  assert.equal(slugify('Animais Marinhos'), 'animais-marinhos');
  const c = ensureCategory(db, { slug: 'animal', label: 'Animal', question: 'Que animal sou eu?' });
  assert.equal(c.source, 'ia');
  assert.equal(ensureCategory(db, { slug: 'animal', label: 'Outro' }).label, 'Animal');
});
