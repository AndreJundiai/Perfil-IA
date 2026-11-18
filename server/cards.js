// Validação de cartas, categorias e detecção de duplicatas.
// Toda carta vinda da IA passa por validateCard() antes de ser salva.
import { normalize, levenshtein } from './matching.js';

export const CLUES_PER_CARD = 20;
export const DIFFICULTIES = ['facil', 'medio', 'dificil'];

export const BASE_CATEGORIES = [
  { slug: 'pessoa', label: 'Pessoa', question: 'Quem sou eu?' },
  { slug: 'lugar', label: 'Lugar', question: 'Que lugar sou eu?' },
  { slug: 'coisa', label: 'Coisa', question: 'O que sou eu?' },
];

const LIMITS = {
  answerMin: 2,
  answerMax: 80,
  clueMin: 12,
  clueMax: 160,
  aliasesMax: 8,
  labelMax: 30,
  questionMax: 40,
};

// Palavras da resposta que não podem aparecer nas dicas (ex.: "Eiffel" em "Torre Eiffel").
const COMMON = new Set(['santa', 'santo', 'sao', 'monte', 'cidade', 'grande', 'nova', 'novo', 'parque', 'nacional', 'praia']);

export function answerKey(text) {
  return normalize(text);
}

export function slugify(label) {
  return normalize(label).replace(/\s+/g, '-').slice(0, 30);
}

function forbiddenTerms(answer, aliases) {
  const terms = new Set();
  for (const opt of [answer, ...aliases]) {
    const n = normalize(opt);
    if (n.length >= 3) terms.add(n);
  }
  for (const word of normalize(answer).split(' ')) {
    if (word.length >= 5 && !COMMON.has(word)) terms.add(word);
  }
  return [...terms];
}

export function clueRevealsAnswer(clue, answer, aliases = []) {
  const words = normalize(clue).split(' ');
  const padded = ` ${words.join(' ')} `;
  return forbiddenTerms(answer, aliases).some((term) => {
    if (padded.includes(` ${term} `)) return true;
    // Palavra isolada com erro de grafia (ex.: "Eifel").
    if (!term.includes(' ') && term.length >= 6) return words.some((w) => w.length >= 5 && levenshtein(w, term) <= 1);
    return false;
  });
}

// Dicas vagas, que servem para qualquer resposta e não ajudam o jogador.
const VAGUE = [
  /^sou (muito )?(famos[oa]|conhecid[oa]|importante|popular|especial|incrivel|unic[oa])\.?$/,
  /^(todo mundo|muita gente|muitas pessoas) (me )?(conhece|sabe quem sou|ja ouviu falar de mim)\.?$/,
  /^(voce|vc) (com certeza|certamente|ja) (me )?(conhece|sabe)/,
  /^sou (uma? )?(pessoa|lugar|coisa|objeto)\.?$/,
  /^(adivinhe|descubra|quem sou eu|o que sou eu)/,
];
export function isVagueClue(clue) {
  const n = normalize(clue);
  return String(clue).trim().split(/\s+/).length < 3 || VAGUE.some((re) => re.test(n));
}

function nearDuplicate(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (x === y) return true;
  const longest = Math.max(x.length, y.length);
  return longest > 0 && levenshtein(x, y) / longest < 0.2;
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Valida o JSON de uma carta. Nunca lança: devolve { ok, card, errors }.
 * @param {unknown} raw objeto vindo da IA
 * @param {{ category?: string, allowed?: string[] }} expected categoria pedida, ou lista de categorias aceitas
 */
export function validateCard(raw, expected = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['A carta não é um objeto JSON.'] };
  }

  const answer = str(raw.answer);
  if (answer.length < LIMITS.answerMin || answer.length > LIMITS.answerMax) errors.push('Resposta ausente ou com tamanho inválido.');

  const categoryLabel = str(raw.category_label) || str(raw.category);
  const category = slugify(str(raw.category) || categoryLabel);
  if (!category) errors.push('Carta sem categoria.');
  if (expected.category && category !== expected.category) {
    errors.push(`Categoria "${category}" diferente da pedida ("${expected.category}").`);
  }
  if (!expected.category && expected.allowed && category && !expected.allowed.includes(category)) {
    errors.push(`Categoria "${category}" não existe.`);
  }
  const categoryQuestion = str(raw.category_question).slice(0, LIMITS.questionMax);

  const difficulty = str(raw.difficulty);
  if (!DIFFICULTIES.includes(difficulty)) errors.push('Dificuldade inválida.');

  if (raw.aliases !== undefined && !Array.isArray(raw.aliases)) errors.push('"aliases" precisa ser uma lista.');
  const aliases = [];
  for (const a of Array.isArray(raw.aliases) ? raw.aliases : []) {
    const alias = str(a).slice(0, LIMITS.answerMax);
    if (alias && answerKey(alias) !== answerKey(answer) && !aliases.some((x) => answerKey(x) === answerKey(alias))) aliases.push(alias);
  }

  if (!Array.isArray(raw.clues)) {
    errors.push('"clues" precisa ser uma lista.');
  } else {
    if (raw.clues.length !== CLUES_PER_CARD) errors.push(`São necessárias exatamente ${CLUES_PER_CARD} dicas (vieram ${raw.clues.length}).`);
    raw.clues.forEach((c, i) => {
      const clue = str(c);
      const n = i + 1;
      if (typeof c !== 'string') return errors.push(`Dica ${n} não é texto.`);
      if (clue.length < LIMITS.clueMin) errors.push(`Dica ${n} curta demais.`);
      if (clue.length > LIMITS.clueMax) errors.push(`Dica ${n} longa demais.`);
      if (answer && clueRevealsAnswer(clue, answer, aliases)) errors.push(`Dica ${n} revela a resposta.`);
      if (clue.length >= LIMITS.clueMin && isVagueClue(clue)) errors.push(`Dica ${n} é vaga demais.`);
      for (let j = 0; j < i; j++) {
        if (nearDuplicate(clue, str(raw.clues[j]))) {
          errors.push(`Dica ${n} repete a dica ${j + 1}.`);
          break;
        }
      }
    });
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    card: {
      category,
      categoryLabel: categoryLabel.slice(0, LIMITS.labelMax),
      categoryQuestion,
      answer,
      aliases: aliases.slice(0, LIMITS.aliasesMax),
      difficulty,
      clues: raw.clues.map(str),
    },
  };
}
