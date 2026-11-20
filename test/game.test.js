import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoloSession, Room, pointsFor } from '../shared/game.js';

const card = (answer = 'Pelé', id = 'id-' + answer.length) => ({
  id, category: 'pessoa', answer, aliases: [], difficulty: 'facil', clues: Array.from({ length: 10 }, (_, i) => `dica ${i + 1}`),
});

test('pontuação vai de 10 (1 dica) a 1 (10 dicas)', () => {
  assert.equal(pointsFor(1), 10);
  assert.equal(pointsFor(10), 1);
  assert.equal(pointsFor(5), 6);
});

test('solo: não expõe a resposta enquanto joga', () => {
  const s = new SoloSession(card(), 'u1');
  const v = s.view();
  assert.equal(v.answer, undefined);
  assert.equal(v.card.clues.length, 1);
  assert.ok(!JSON.stringify(v).includes('Pelé'));
});

test('solo: palpite errado abre dica; acerto pontua', () => {
  const s = new SoloSession(card(), 'u1');
  s.guess('Zico');
  assert.equal(s.revealed, 2);
  s.nextClue();
  s.guess('pele');
  assert.equal(s.status, 'won');
  assert.equal(s.score, pointsFor(3));
  assert.equal(s.view().answer, 'Pelé');
});

test('solo: errar com todas as dicas abertas perde', () => {
  const s = new SoloSession(card(), 'u1');
  for (let i = 0; i < 9; i++) s.nextClue();
  assert.equal(s.nextClue().ok, false);
  s.guess('nada');
  assert.equal(s.status, 'lost');
});

function makeRoom(cards = [card('Pelé', 'a'), card('Senna', 'b'), card('Einstein', 'c')]) {
  let i = 0;
  const room = new Room('ABCD', { drawCard: () => cards[i++ % cards.length] });
  room.addPlayer('p1', 'Ana');
  room.addPlayer('p2', 'Bia');
  return room;
}

test('sala: só o anfitrião começa, com 2+ jogadores', () => {
  const room = new Room('ABCD', { drawCard: () => card() });
  room.addPlayer('p1', 'Ana');
  assert.equal(room.start('p1').ok, false);
  room.addPlayer('p2', 'Bia');
  assert.equal(room.start('p2').ok, false);
  assert.equal(room.start('p1').ok, true);
  assert.equal(room.addPlayer('p3', 'Caio').ok, false); // já começou
});

test('sala: turnos, palpites e fim de rodada', () => {
  const room = makeRoom();
  room.updateSettings('p1', { rounds: 2 });
  room.start('p1');
  const first = room.currentPlayer().id;
  const second = first === 'p1' ? 'p2' : 'p1';
  assert.equal(room.guess(second, 'x').ok, false); // fora da vez
  room.guess(first, 'errado');
  assert.equal(room.revealed, 2);
  assert.equal(room.currentPlayer().id, second);
  const r = room.guess(second, room.card.answer);
  assert.ok(r.correct);
  assert.equal(room.state, 'roundEnd');
  assert.equal(room.players.find((p) => p.id === second).score, pointsFor(2));
  assert.ok(room.view().lastResult.answer);
  room.nextRound('p1');
  assert.equal(room.round, 2);
  room.guess(room.currentPlayer().id, room.card.answer);
  assert.equal(room.state, 'finished');
});

test('sala: a resposta não aparece na visão pública durante a rodada', () => {
  const room = makeRoom();
  room.start('p1');
  assert.ok(!JSON.stringify(room.view()).includes(room.card.answer));
});

test('sala: dicas esgotadas dão uma última chance a cada jogador', () => {
  const room = makeRoom();
  room.start('p1');
  for (let i = 0; i < 9; i++) room.pass(room.currentPlayer().id);
  assert.equal(room.revealed, 10);
  room.pass(room.currentPlayer().id);
  assert.equal(room.state, 'playing');
  room.pass(room.currentPlayer().id);
  assert.equal(room.state, 'roundEnd');
  assert.equal(room.lastResult.winnerId, null);
});

test('sala: tempo esgotado passa a vez', () => {
  const room = makeRoom();
  room.start('p1');
  const first = room.currentPlayer().id;
  assert.equal(room.tick(Date.now()), false);
  assert.equal(room.tick(room.turnDeadline + 1), true);
  assert.notEqual(room.currentPlayer().id, first);
  assert.equal(room.revealed, 2);
});
