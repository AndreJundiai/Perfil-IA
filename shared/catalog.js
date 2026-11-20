// Catálogo nativo: junta as cartas clássicas (seed.js) e as cartas dos temas (themes.js),
// marcando cada carta com o nome do seu tema.
import { SEED_CARDS } from './seed.js';
import { THEMES, EXTRA_CATEGORIES } from './themes.js';
import { answerKey } from './cards.js';

export { THEMES, EXTRA_CATEGORIES };

function build() {
  const bySeedAnswer = new Map(SEED_CARDS.map((c) => [answerKey(c.answer), c]));
  const used = new Set();
  const cards = [];
  for (const theme of THEMES) {
    for (const answer of theme.answers) {
      const seed = bySeedAnswer.get(answerKey(answer));
      if (!seed) throw new Error(`Tema ${theme.slug}: carta clássica "${answer}" não existe.`);
      used.add(answerKey(answer));
      cards.push({ ...seed, theme: theme.name });
    }
    for (const card of theme.cards) cards.push({ ...card, theme: theme.name });
  }
  // Cartas clássicas que não entraram em nenhum tema continuam no banco, sem tema.
  for (const seed of SEED_CARDS) if (!used.has(answerKey(seed.answer))) cards.push({ ...seed, theme: null });
  return cards;
}

export const CATALOG = build();

export function themeBySlug(slug) {
  return THEMES.find((t) => t.slug === slug) ?? null;
}
