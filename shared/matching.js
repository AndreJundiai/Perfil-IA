// Verificação de palpites: tolera acentos, maiúsculas, artigos e pequenos erros de digitação.

// Artigos e palavras de preenchimento ("acho que é o Pelé") que não mudam o palpite.
const STOPWORDS = new Set([
  'o', 'a', 'os', 'as', 'um', 'uma', 'de', 'do', 'da', 'dos', 'das', 'the',
  'e', 'eh', 'acho', 'que', 'sera', 'seria', 'resposta', 'eu', 'chuto',
]);

export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .join(' ');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Quantos erros de digitação aceitamos, de acordo com o tamanho da resposta.
function tolerance(len) {
  if (len <= 4) return 0;
  if (len <= 8) return 1;
  return 2;
}

export function isCorrectGuess(guess, answer, aliases = []) {
  const g = normalize(guess);
  if (!g) return false;
  for (const option of [answer, ...aliases]) {
    const o = normalize(option);
    if (!o) continue;
    if (g === o) return true;
    if (levenshtein(g, o) <= tolerance(o.length)) return true;
  }
  return false;
}
