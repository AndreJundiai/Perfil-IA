import { CLUES_PER_CARD } from '../shared/cards.js';

const SUBJECTS = ['montanhas', 'oceanos', 'florestas', 'cidades', 'rios', 'desertos', 'ilhas', 'vulcões', 'geleiras', 'planícies',
  'cavernas', 'lagos', 'vales', 'savanas', 'pântanos', 'cânions', 'recifes', 'dunas', 'cachoeiras', 'penhascos'];
const VERBS = ['Já inspirei', 'Costumo aparecer em', 'Fui citado em', 'Muitos me ligam a', 'Apareço perto de', 'Sou lembrado junto a',
  'Tenho relação com', 'Já fui comparado a', 'Me encontram entre', 'Combino com', 'Pesquisadores me estudam com', 'Viajantes me associam a',
  'Livros me colocam ao lado de', 'Documentários me mostram com', 'Turistas me fotografam com', 'Crianças me desenham com',
  'Pintores me retratam com', 'Poetas me rimam com', 'Mapas me marcam perto de', 'Guias me apresentam com'];

// 20 dicas distintas e válidas para testes.
export const twentyClues = (tag = '') =>
  Array.from({ length: CLUES_PER_CARD }, (_, i) => `${VERBS[i]} ${SUBJECTS[(i * 7) % 20]} ${tag}`.trim() + '.');
