// Cria cartas a partir da Wikipédia, sem usar a API da IA.
// Busca o artigo, transforma frases do texto em dicas (escondendo o nome da resposta)
// e passa o resultado pelo mesmo validador das demais cartas.
import { normalize, levenshtein } from './matching.js';
import { CLUES_PER_CARD, validateCard, clueRevealsAnswer, isVagueClue } from './cards.js';

const API = process.env.WIKI_API_URL || 'https://pt.wikipedia.org/w/api.php';
// A Wikimedia pede um User-Agent que identifique o cliente; WIKI_USER_AGENT permite incluir um contato.
const USER_AGENT = process.env.WIKI_USER_AGENT || 'PerfilIA/1.0 (jogo de adivinhacao educativo)';

export class WikiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function getJson(params, fetchImpl) {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT }, signal: AbortSignal.timeout(12000) });
  } catch {
    throw new WikiError('Não foi possível acessar a Wikipédia agora. Verifique a internet do servidor.');
  }
  if (!res.ok) throw new WikiError(`A Wikipédia respondeu com erro (${res.status}).`);
  return res.json();
}

/** Procura o artigo mais relevante e devolve o texto completo. */
export async function fetchArticle(query, { fetchImpl = fetch } = {}) {
  const q = String(query ?? '').trim().slice(0, 100);
  if (q.length < 2) throw new WikiError('Digite o que você quer buscar.', 400);
  const search = await getJson({ action: 'query', list: 'search', srsearch: q, srlimit: '1', srnamespace: '0' }, fetchImpl);
  const title = search?.query?.search?.[0]?.title;
  if (!title) throw new WikiError(`Nada encontrado na Wikipédia para "${q}".`, 404);
  const data = await getJson(
    { action: 'query', prop: 'extracts|pageprops', explaintext: '1', redirects: '1', titles: title },
    fetchImpl
  );
  const page = data?.query?.pages?.[0];
  if (!page || page.missing) throw new WikiError(`O artigo "${title}" não foi encontrado.`, 404);
  if (page.pageprops && 'disambiguation' in page.pageprops) {
    throw new WikiError(`"${title}" tem vários significados. Seja mais específico (ex.: "${title} (cantor)").`, 422);
  }
  return {
    title: page.title,
    extract: String(page.extract ?? ''),
    url: `https://pt.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
  };
}

// ---------- montagem das dicas ----------

const SUBJECT = {
  pessoa: { base: 'esta pessoa', de: 'desta pessoa', em: 'nesta pessoa' },
  personagem: { base: 'este personagem', de: 'deste personagem', em: 'neste personagem' },
  lugar: { base: 'este lugar', de: 'deste lugar', em: 'neste lugar' },
  animal: { base: 'este animal', de: 'deste animal', em: 'neste animal' },
  astro: { base: 'este astro', de: 'deste astro', em: 'neste astro' },
  coisa: { base: 'isto', de: 'disto', em: 'nisto' },
};
const ARTICLES = new Set(['o', 'a', 'os', 'as', 'um', 'uma']);
const DE = new Set(['de', 'do', 'da', 'dos', 'das']);
const EM = new Set(['em', 'no', 'na', 'nos', 'nas']);
const NAMING = new Set(['apelido', 'apelidado', 'apelidada', 'como', 'chamado', 'chamada', 'nome', 'alcunha', 'denominado', 'denominada', 'batizado', 'batizada']);
const MONTHS = 'janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';

const cleanTitle = (t) => t.replace(/\s*\([^)]*\)\s*$/, '').trim();
const words = (s) => normalize(s).split(' ').filter(Boolean);

// Nomes que precisam ser escondidos nas dicas: resposta, apelidos e palavras marcantes do nome.
function namesToHide(answer, aliases) {
  const list = new Map();
  for (const n of [answer, ...aliases]) {
    const w = words(n);
    if (w.length) list.set(w.join(' '), w);
  }
  for (const w of words(answer)) if (w.length >= 5) list.set(w, [w]);
  return [...list.values()].sort((a, b) => b.length - a.length);
}

// Troca as menções à resposta por "esta pessoa", "deste lugar", "isto"...
export function maskSentence(sentence, names, category) {
  const subj = SUBJECT[category] ?? SUBJECT.coisa;
  const tokens = sentence.split(/(\s+)/); // mantém os espaços
  // Só as palavras que contam para o nome (artigos e "de/do/da" são ignorados, como em normalize()).
  const idx = tokens.map((t, i) => (normalize(t) ? i : -1)).filter((i) => i >= 0);
  const norm = idx.map((i) => normalize(tokens[i]));
  const fold = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // Palavra imediatamente anterior (mesmo que seja artigo/preposição).
  const prevWordPos = (tokenPos) => {
    for (let i = tokenPos - 1; i >= 0; i--) if (tokens[i].trim()) return i;
    return -1;
  };
  const out = [...tokens];
  let changed = false;
  let awkward = false; // nome no meio de um título ("O filme Fulano, ...") não dá para esconder bem
  for (let k = 0; k < idx.length; k++) {
    for (const name of names) {
      if (k + name.length > idx.length) continue;
      let ok = true;
      for (let j = 0; j < name.length && ok; j++) {
        const t = norm[k + j];
        ok = t === name[j] || (name.length === 1 && name[0].length >= 6 && t.length >= 5 && levenshtein(t, name[0]) <= 1);
      }
      if (!ok) continue;
      // Preposição ou artigo antes do nome vira contração: "do Coliseu" → "deste lugar".
      const prevPos = prevWordPos(idx[k]);
      const prev = prevPos >= 0 ? fold(tokens[prevPos]) : '';
      const prevPrev = prevPos >= 0 ? prevWordPos(prevPos) : -1;
      const atStart = prevPos < 0 || (ARTICLES.has(prev) && prevPrev < 0);
      if (!atStart && !(DE.has(prev) || EM.has(prev) || ARTICLES.has(prev))) awkward = true;
      // Frases sobre o próprio nome ("conhecido pelo apelido de X") perdem o sentido ao esconder X.
      if (NAMING.has(prev) || (prevPrev >= 0 && NAMING.has(fold(tokens[prevPrev])))) awkward = true;
      let form = subj.base;
      if (prevPos >= 0 && DE.has(prev)) form = subj.de;
      else if (prevPos >= 0 && EM.has(prev)) form = subj.em;
      if (prevPos >= 0 && (DE.has(prev) || EM.has(prev) || ARTICLES.has(prev))) {
        out[prevPos] = '';
        out[prevPos + 1] = '';
      }
      const last = tokens[idx[k + name.length - 1]];
      const trailing = last.match(/[^\p{L}\p{N}]+$/u)?.[0] ?? '';
      out[idx[k]] = form + trailing;
      for (let t = idx[k] + 1; t <= idx[k + name.length - 1]; t++) out[t] = '';
      changed = true;
      k += name.length - 1;
      break;
    }
  }
  let s = out.join('').replace(/\s{2,}/g, ' ').trim();
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return { text: s, changed, awkward };
}

function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=["“(]?[A-ZÁÉÍÓÚÂÊÔÃÕÇ0-9])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

const stripParens = (s) => {
  let t = s;
  for (let i = 0; i < 3; i++) t = t.replace(/\s*\([^()]*\)/g, '');
  return t.replace(/\s+([,.;:])/g, '$1');
};

// Extrai aliases do primeiro parágrafo: nome completo e "conhecido como ...".
function findAliases(answer, lead) {
  const aliases = new Set();
  const full = lead.split(/\s*[(,]/)[0].trim();
  if (full && full.length <= 60 && normalize(full) !== normalize(answer) && !/\b(é|foi|são|era)\b/i.test(full)) aliases.add(full);
  const re = /(?:mais conhecid[oa]s? como|conhecid[oa]s? (?:simplesmente |popularmente )?(?:como|por)|também chamad[oa]s? de|apelidad[oa]s? de|pelo apelido de|apelido de)\s+["“]?([^,.;()"”]{2,40})/giu;
  for (const m of lead.matchAll(re)) {
    const alias = m[1].trim();
    if (!/^(o|a|um|uma)\s+apelido/i.test(alias)) aliases.add(alias);
  }
  const plain = answer.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (plain !== answer) aliases.add(plain);
  return [...aliases].filter((a) => normalize(a) && normalize(a) !== normalize(answer)).slice(0, 6);
}

// Dicas de nascimento e morte a partir de "(Cidade, 1 de janeiro de 1900 — Cidade, 2 de maio de 1980)".
function lifeClues(lead) {
  const m = lead.match(/\(([^()]{4,160})\)/);
  if (!m) return [];
  const parts = m[1].split(/\s+[—–-]\s+/);
  const date = new RegExp(`(\\d{1,2}º? de (?:${MONTHS}) de \\d{3,4}|\\d{3,4})`, 'i');
  const out = [];
  const describe = (part, verb) => {
    const d = part.match(date);
    if (!d) return null;
    const place = part.slice(0, d.index).replace(/[,;\s]+$/, '').trim();
    const year = d[1].match(/\d{3,4}$/)[0];
    return place && place.length < 50 ? `${verb} em ${year}. Local: ${place}.` : `${verb} em ${year}.`;
  };
  const born = describe(parts[0], 'Nasceu');
  if (born) out.push(born);
  if (parts[1]) {
    const died = describe(parts[1], 'Morreu');
    if (died) out.push(died);
  }
  return out;
}

function goodClue(s) {
  if (s.length < 25 || s.length > 170) return false;
  if (/[=\n]|https?:|\bver também\b|\bcitação\b/i.test(s)) return false;
  const digits = (s.match(/\d/g) ?? []).length;
  if (digits / s.length > 0.25) return false;
  if (!/[.!?]$/.test(s)) return false;
  return !isVagueClue(s);
}

// Quão "específica" (difícil) é uma frase: datas, números e nomes próprios pesam mais.
const specificity = (s) => (s.match(/\d{3,4}/g) ?? []).length * 2 + (s.slice(1).match(/\s[A-ZÁÉÍÓÚ][a-zà-ú]+/g) ?? []).length;

/**
 * Monta uma carta a partir do texto de um artigo.
 * @returns {{ ok: true, card } | { ok: false, error }}
 */
export function buildCardFromArticle({ title, extract, url }, { category = 'coisa', theme = null, difficulty = 'medio' } = {}) {
  const answer = cleanTitle(title);
  const paragraphs = extract.split(/\n+/).map((p) => p.trim()).filter((p) => p && !/^=+.*=+$/.test(p));
  if (!paragraphs.length) return { ok: false, error: 'O artigo está vazio.' };
  const lead = paragraphs[0];
  const aliases = findAliases(answer, lead);
  const names = namesToHide(answer, aliases);

  const prepare = (raw) => {
    const { text, awkward } = maskSentence(stripParens(raw), names, category);
    if (awkward) return null;
    return goodClue(text) && !clueRevealsAnswer(text, answer, aliases) ? text : null;
  };

  const leadClues = splitSentences(lead).map(prepare).filter(Boolean);
  const life = category === 'pessoa' ? lifeClues(lead) : [];
  const body = [];
  paragraphs.slice(1).forEach((p, pi) => {
    for (const s of splitSentences(p)) {
      const clue = prepare(s);
      if (clue) body.push({ clue, pos: pi, score: specificity(clue) });
    }
  });

  // Espalha as escolhas pelo artigo inteiro: divide o corpo em faixas e pega a frase mais específica de cada uma.
  const seen = [];
  const isNew = (c) => {
    if (seen.some((s) => levenshtein(normalize(s), normalize(c)) / Math.max(s.length, c.length) < 0.35)) return false;
    seen.push(c);
    return true;
  };
  const easy = leadClues.slice(0, 5).reverse(); // a primeira frase do artigo (a definição) vira a última dica
  easy.forEach((c) => seen.push(c));
  life.forEach((c) => seen.push(c));
  const needBody = CLUES_PER_CARD - easy.length - life.length + 2;
  const picked = [];
  if (body.length) {
    const bands = Math.max(1, needBody);
    const size = body.length / bands;
    for (let b = 0; b < bands && picked.length < needBody; b++) {
      const slice = body.slice(Math.floor(b * size), Math.max(Math.floor((b + 1) * size), Math.floor(b * size) + 1));
      const best = [...slice].sort((x, y) => y.score - x.score).find((x) => isNew(x.clue));
      if (best) picked.push(best);
    }
    for (const x of [...body].sort((a, b) => b.score - a.score)) {
      if (picked.length >= needBody) break;
      if (!picked.includes(x) && isNew(x.clue)) picked.push(x);
    }
  }
  // Mais específicas (datas, nomes) primeiro = mais difíceis; nascimento no meio; frases do resumo no fim.
  picked.sort((a, b) => b.score - a.score);
  const hard = picked.map((x) => x.clue);
  // Não repete nascimento/morte se o texto já traz o mesmo ano.
  const lifeUsed = life.filter((l) => !hard.some((h) => h.includes(l.match(/\d{3,4}/)[0])) || !/Nasceu|Morreu/.test(l));
  const lifeOk = lifeUsed.filter((l) => {
    const verb = l.startsWith('Nasceu') ? /\bnasceu\b/i : /\bmorreu\b/i;
    return ![...hard, ...easy].some((h) => verb.test(h));
  });
  let clues = [...hard.slice(0, Math.ceil(hard.length / 2)), ...lifeOk, ...hard.slice(Math.ceil(hard.length / 2)), ...easy];
  // Completa com frases extras do resumo se ainda faltar.
  for (const c of leadClues.slice(5)) if (clues.length < CLUES_PER_CARD && !clues.includes(c)) clues.splice(clues.length - easy.length, 0, c);
  clues = clues.slice(-CLUES_PER_CARD);

  if (clues.length < CLUES_PER_CARD) {
    return { ok: false, error: `O artigo "${title}" é curto demais: só deu para tirar ${clues.length} dicas boas (são necessárias ${CLUES_PER_CARD}).` };
  }
  const result = validateCard({ category, category_label: category, answer, aliases, difficulty, clues }, { category });
  if (!result.ok) return { ok: false, error: `Não foi possível montar uma carta boa com "${title}": ${result.errors[0]}` };
  return { ok: true, card: { ...result.card, theme, source: 'web', sourceUrl: url ?? null } };
}

/** Busca um assunto na Wikipédia e devolve a carta pronta (sem salvar). */
export async function cardFromWeb(query, opts = {}) {
  const article = await fetchArticle(query, opts);
  const category = opts.category || guessCategory(article.extract);
  const built = buildCardFromArticle(article, { ...opts, category });
  if (!built.ok) throw new WikiError(built.error, 422);
  return built.card;
}

// Sem categoria escolhida: datas de nascimento entre parênteses indicam uma pessoa.
export function guessCategory(extract) {
  const lead = extract.split('\n')[0] ?? '';
  if (new RegExp(`\\(([^()]*\\d{1,2}º? de (?:${MONTHS}) de \\d{4})`, 'i').test(lead)) return 'pessoa';
  // \b não funciona antes de letras acentuadas ("é") em JavaScript, por isso (?:^|\s).
  if (/(?:^|\s)(?:é|foi) uma? (?:cidade|município|país|ilha|arquipélago|estado|região|monumento|estádio|rio|praia|parque|bairro|capital)\b/i.test(lead)) return 'lugar';
  if (/(?:^|\s)é uma? (?:espécie|ave|mamífero|réptil|peixe|anfíbio|inseto)\b/i.test(lead)) return 'animal';
  return 'coisa';
}
