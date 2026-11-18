import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_CARDS } from '../server/seed.js';
import { validateCard, BASE_CATEGORIES, isVagueClue } from '../server/cards.js';
import { answerKey } from '../server/cards.js';

test('todas as cartas clássicas passam no validador de qualidade', () => {
  const problems = [];
  for (const c of SEED_CARDS) {
    const cat = BASE_CATEGORIES.find((b) => b.slug === c.category);
    const r = validateCard({ ...c, category_label: cat.label, category_question: cat.question }, { category: c.category });
    if (!r.ok) problems.push(`${c.answer}: ${r.errors.join('; ')}`);
  }
  assert.deepEqual(problems, []);
});

test('cartas clássicas não têm respostas nem apelidos repetidos', () => {
  const seen = new Map();
  for (const c of SEED_CARDS) {
    for (const name of [c.answer, ...c.aliases]) {
      const k = answerKey(name);
      assert.ok(!seen.has(k) || seen.get(k) === c.answer, `"${name}" repetido em ${c.answer} e ${seen.get(k)}`);
      seen.set(k, c.answer);
    }
  }
});

test('detecta dicas vagas', () => {
  assert.ok(isVagueClue('Sou muito famoso.'));
  assert.ok(isVagueClue('Todo mundo me conhece.'));
  assert.ok(isVagueClue('Sou uma pessoa.'));
  assert.ok(!isVagueClue('Nasci em 1940, em Três Corações.'));
  assert.ok(!isVagueClue('Tenho um mostrador.'));
});

test('banco antigo com cartas de 10 dicas é atualizado sem perder estatísticas', async () => {
  const { openDb, findDuplicate } = await import('../server/db.js');
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const path = join(mkdtempSync(join(tmpdir(), 'perfil-')), 'old.db');
  let db = openDb(path);
  const pele = findDuplicate(db, 'Pelé');
  db.prepare('UPDATE cards SET clues = ?, times_played = 7 WHERE id = ?').run(JSON.stringify(['a', 'b', 'c']), pele.id);
  db.close();
  db = openDb(path);
  const updated = findDuplicate(db, 'Pelé');
  assert.equal(updated.id, pele.id);
  assert.equal(updated.clues.length, 20);
  assert.equal(updated.timesPlayed, 7);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cards').get().n, SEED_CARDS.length);
});
