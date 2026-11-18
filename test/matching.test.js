import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCorrectGuess, normalize } from '../server/matching.js';

test('normaliza acentos, artigos e pontuação', () => {
  assert.equal(normalize('  A Torre  Eiffel! '), 'torre eiffel');
  assert.equal(normalize('Japão'), 'japao');
});

test('aceita resposta, apelidos e erros leves de digitação', () => {
  assert.ok(isCorrectGuess('pele', 'Pelé'));
  assert.ok(isCorrectGuess('Edson Arantes do Nascimento', 'Pelé', ['Edson Arantes do Nascimento']));
  assert.ok(isCorrectGuess('santos dumon', 'Santos Dumont'));
  assert.ok(isCorrectGuess('cataratas do iguacu', 'Cataratas do Iguaçu'));
});

test('rejeita palpites errados ou vazios', () => {
  assert.ok(!isCorrectGuess('', 'Pelé'));
  assert.ok(!isCorrectGuess('Zico', 'Pelé'));
  assert.ok(!isCorrectGuess('cafe', 'Chá')); // palavras curtas não têm tolerância
  assert.ok(!isCorrectGuess('Japao', 'Egito'));
});

test('aceita palpites com palavras de preenchimento', () => {
  assert.ok(isCorrectGuess('acho que é o Pelé', 'Pelé'));
  assert.ok(isCorrectGuess('é a Torre Eiffel', 'Torre Eiffel'));
  assert.ok(!isCorrectGuess('acho que é o Zico', 'Pelé'));
});
