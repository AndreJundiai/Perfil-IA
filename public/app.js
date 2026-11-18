// Perfil IA — cliente web
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Preenchidos a partir das categorias do servidor (a IA pode criar categorias novas).
let CAT_LABEL = {};
let CAT_TITLE = {};
const CAT_COLORS = { pessoa: 'var(--pessoa)', lugar: 'var(--lugar)', coisa: 'var(--coisa)' };
const catColor = (slug) => {
  if (CAT_COLORS[slug]) return CAT_COLORS[slug];
  let h = 0;
  for (const ch of String(slug)) h = (h * 37 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 50% 42%)`;
};
const DIFF_LABEL = { facil: 'Fácil', medio: 'Médio', dificil: 'Difícil' };
const THEME_IDEAS = ['Copa do Mundo', 'Música brasileira', 'Mitologia grega', 'Espaço sideral', 'Desenhos animados', 'Comidas do Nordeste', 'Inventores', 'Capitais europeias'];

const storage = {
  get(k, d = null) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* armazenamento indisponível */ } },
};

const state = {
  config: null,
  user: null,
  userId: storage.get('perfil.userId') || crypto.randomUUID(),
  soloCategory: '',
  solo: null,
  lastRevealed: 0,
  seen: storage.get('perfil.seen', []),
  challenge: null, // { theme, cardIds, index, score }
  room: null,
  socket: null,
};
storage.set('perfil.userId', state.userId);

// ---------- utilidades ----------

// Versão web: mesmo endereço da página. APK: endereço salvo nas configurações ou o padrão do build.
const isApp = Boolean(window.Capacitor?.isNativePlatform?.());
const serverUrl = () => String(storage.get('perfil.server') || window.PERFIL_SERVER_URL || '').replace(/\/+$/, '');

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(serverUrl() + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify({ userId: state.userId, ...body }) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  if (data.user) setUser(data.user);
  return data;
}

let toastTimer;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 3200);
}

async function withLoading(text, fn) {
  $('#loadingText').textContent = text;
  $('#loading').hidden = false;
  try { return await fn(); } finally { $('#loading').hidden = true; }
}

function setUser(user) {
  state.user = user;
  $('#tokenCount').textContent = user.tokens;
  $('#tokenCount2').textContent = user.tokens;
  if (document.activeElement !== $('#nameInput')) $('#nameInput').value = user.name;
  $('#myStats').innerHTML = `
    <dt>Partidas</dt><dd>${user.gamesPlayed}</dd>
    <dt>Cartas descobertas</dt><dd>${user.cardsSolved}</dd>
    <dt>Pontuação total</dt><dd>${user.totalScore}</dd>`;
}

function avatarColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
}

// ---------- navegação ----------

function go(view, { autostart = true } = {}) {
  $$('.view').forEach((v) => (v.hidden = v.id !== `view-${view}`));
  $$('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.go === view));
  if (view === 'home') loadHome();
  if (view === 'bank') loadBank();
  if (view === 'solo' && !state.solo && autostart) startSolo();
  if (view === 'create') $('#aiOff').hidden = state.config?.aiAvailable;
  window.scrollTo({ top: 0 });
}
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-go]');
  if (target) go(target.dataset.go);
});

// ---------- início ----------

async function loadHome() {
  const { leaderboard } = await api('/api/leaderboard');
  $('#ranking').innerHTML = leaderboard.length
    ? leaderboard.map((r) => `<li><span>${esc(r.name)}</span><b>${r.totalScore}</b></li>`).join('')
    : '<li class="muted">Ninguém pontuou ainda.</li>';
}

let nameTimer;
$('#nameInput').addEventListener('input', (e) => {
  clearTimeout(nameTimer);
  const name = e.target.value.trim();
  if (!name) return;
  nameTimer = setTimeout(async () => {
    await api('/api/users', { method: 'POST', body: { name } });
    storage.set('perfil.name', name);
  }, 500);
});

$('#dailyBtn').addEventListener('click', async () => {
  try {
    await api('/api/tokens/daily', { method: 'POST', body: {} });
    toast(`+${state.config.tokenRules.dailyBonus} tokens! Volte amanhã para mais.`);
  } catch (err) { toast(err.message, 'error'); }
});

// ---------- partida individual ----------

$('#soloCategory').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.soloCategory = b.dataset.cat;
  $$('#soloCategory button').forEach((x) => x.classList.toggle('on', x === b));
  state.challenge = null;
  startSolo();
});
$('#newCardBtn').addEventListener('click', () => {
  if (state.challenge && state.solo?.status !== 'playing') return nextChallengeCard();
  state.challenge = null;
  startSolo();
});

async function startSolo(cardId) {
  try {
    const data = await api('/api/solo', {
      method: 'POST',
      body: cardId ? { cardId } : { category: state.soloCategory, excludeIds: state.seen },
    });
    state.solo = data;
    state.lastRevealed = 0;
    if (!state.seen.includes(data.card.id)) {
      state.seen = [...state.seen, data.card.id].slice(-100);
      storage.set('perfil.seen', state.seen);
    }
    renderSolo();
  } catch (err) { toast(err.message, 'error'); }
}

function cardHtml(view, { extraHints = view.card.extraHints ?? [], highlightFrom = 0 } = {}) {
  const c = view.card;
  const done = view.status && view.status !== 'playing';
  const rows = [];
  c.clues.forEach((clue, i) => {
    const isNew = i >= highlightFrom && !done;
    rows.push(`<li class="clue open ${isNew ? 'new' : ''}"><span class="n">${i + 1}</span><span class="txt">${esc(clue)}</span></li>`);
  });
  extraHints.forEach((h) => rows.push(`<li class="clue open extra"><span class="n">+</span><span class="txt">${esc(h)}</span></li>`));
  // Dicas fechadas ficam compactas (cartas da IA têm 20 dicas).
  const locked = c.totalClues - c.clues.length;
  if (locked > 0) {
    const dots = Array.from({ length: locked }, (_, k) => `<span class="lock-dot">${c.clues.length + k + 1}</span>`).join('');
    rows.push(`<li class="clue locked-row"><span class="muted">${locked} dica(s) fechada(s)</span><span class="lock-dots">${dots}</span></li>`);
  }
  return `<article class="card">
    <div class="card-head" style="--cat:${catColor(c.category)}">
      <div><div class="label">${esc(CAT_LABEL[c.category] ?? c.category)}</div><div class="title">${esc(CAT_TITLE[c.category] ?? 'Quem sou eu?')}</div></div>
      <div class="badges">
        <span class="badge">${esc(DIFF_LABEL[c.difficulty] ?? c.difficulty)}</span>
        ${c.source === 'ia' ? '<span class="badge">✦ IA</span>' : ''}
        ${c.theme ? `<span class="badge">${esc(c.theme)}</span>` : ''}
      </div>
    </div>
    <ol class="clues">${rows.join('')}</ol>
  </article>`;
}

function renderSolo() {
  const s = state.solo;
  const board = $('#soloBoard');
  const rules = state.config.tokenRules;
  const tag = $('#challengeTag');
  tag.hidden = !state.challenge;
  if (state.challenge) {
    tag.textContent = `Desafio "${state.challenge.theme}" · carta ${state.challenge.index + 1}/${state.challenge.cardIds.length} · ${state.challenge.score} pts`;
  }
  $('#newCardBtn').textContent = state.challenge
    ? state.challenge.index + 1 < state.challenge.cardIds.length ? 'Próxima carta do desafio' : 'Encerrar desafio'
    : 'Nova carta';
  $('#newCardBtn').disabled = Boolean(state.challenge && s.status === 'playing');

  let side;
  if (s.status === 'playing') {
    const pct = (s.potentialPoints / 10) * 100;
    side = `
      <div class="panel">
        <div class="muted">Valendo</div>
        <div class="points"><span class="value">${s.potentialPoints}</span><span class="muted">pontos</span></div>
        <div class="meter"><span style="width:${pct}%"></span></div>
        <div class="muted" style="font-size:14px">${s.revealed} de ${s.card.totalClues} dicas abertas. Palpite errado abre mais uma dica.</div>
      </div>
      <form class="panel" id="guessForm">
        <div class="guess-form">
          <input id="guessInput" placeholder="Seu palpite…" autocomplete="off" maxlength="80" />
          <button class="btn primary">Chutar</button>
        </div>
        <div class="actions">
          <button type="button" class="btn" id="clueBtn" ${s.revealed >= s.card.totalClues ? 'disabled' : ''}>Próxima dica</button>
          <button type="button" class="btn" id="aiHintBtn" ${state.config.aiAvailable ? '' : 'disabled title="IA indisponível"'}>
            ✦ Dica da IA <span class="coin">◆</span>${rules.costAiHint}</button>
          <button type="button" class="btn" id="giveUpBtn">Desistir</button>
        </div>
        ${s.wrongGuesses.length ? `<div class="wrong-list">${s.wrongGuesses.map((g) => `<span>${esc(g)}</span>`).join('')}</div>` : ''}
      </form>`;
  } else {
    const won = s.status === 'won';
    side = `
      <div class="panel result ${won ? 'won' : 'lost'}">
        <h3>${won ? 'Você acertou!' : 'Não foi dessa vez'}</h3>
        <div class="muted">A resposta era</div>
        <div class="answer">${esc(s.answer)}</div>
        ${won ? `<p><b>+${s.score} pontos</b> com ${s.revealed} dica(s)${s.tokenReward ? ` · <span class="coin">◆</span> +${s.tokenReward} token por acerto rápido` : ''}</p>` : ''}
        <button class="btn primary wide" id="againBtn">${state.challenge ? $('#newCardBtn').textContent : 'Jogar outra carta'}</button>
      </div>`;
  }
  board.innerHTML = `<div class="board">${cardHtml(s, { highlightFrom: state.lastRevealed })}<div class="side">${side}</div></div>`;
  state.lastRevealed = s.revealed;

  if (s.status === 'playing') {
    $('#guessInput').focus();
    $('#guessForm').addEventListener('submit', onGuess);
    $('#clueBtn').addEventListener('click', () => soloAction('clue'));
    $('#giveUpBtn').addEventListener('click', () => soloAction('give-up').then(afterSoloEnd));
    $('#aiHintBtn').addEventListener('click', onAiHint);
  } else {
    $('#againBtn').addEventListener('click', () => $('#newCardBtn').click());
  }
}

async function soloAction(action, body = {}) {
  try {
    state.solo = await api(`/api/solo/${state.solo.sessionId}/${action}`, { method: 'POST', body });
    renderSolo();
    return state.solo;
  } catch (err) { toast(err.message, 'error'); }
}

async function onGuess(e) {
  e.preventDefault();
  const guess = $('#guessInput').value.trim();
  if (!guess) return;
  const r = await soloAction('guess', { guess });
  if (!r) return;
  if (r.correct === false && r.status === 'playing') {
    $('#guessForm')?.classList.add('shake');
    toast(`"${guess}" não é a resposta. Mais uma dica aberta!`);
  }
  afterSoloEnd(r);
}

function afterSoloEnd(r) {
  if (!r || r.status === 'playing') return;
  if (state.challenge && r.status === 'won') {
    state.challenge.score += r.score;
    renderSolo();
  }
  api(`/api/users/${state.userId}`).catch(() => {});
}

async function onAiHint() {
  try {
    await withLoading('A IA está criando uma dica…', async () => {
      state.solo = await api(`/api/solo/${state.solo.sessionId}/ai-hint`, { method: 'POST', body: {} });
    });
    renderSolo();
    toast('Dica extra! (cada dica extra custa 1 ponto no acerto)');
  } catch (err) { toast(err.message, 'error'); }
}

function nextChallengeCard() {
  const ch = state.challenge;
  ch.index++;
  if (ch.index >= ch.cardIds.length) {
    toast(`Desafio "${ch.theme}" concluído com ${ch.score} pontos!`);
    state.challenge = null;
    return startSolo();
  }
  startSolo(ch.cardIds[ch.index]);
}

// ---------- criar com IA ----------

function fillCosts() {
  $$('.cost').forEach((el) => (el.innerHTML = `Custa <span class="coin">◆</span>${state.config.tokenRules[el.dataset.cost]} tokens.`));
  const r = state.config.tokenRules;
  $('#tokenRules').innerHTML = `
    <li>Carta inteligente: ${r.costGenerateCard} tokens</li>
    <li>Desafio personalizado: ${r.costChallenge} tokens</li>
    <li>Dica extra: ${r.costAiHint} token</li>
    <li>Carta que já existe no banco: grátis</li>
    <li>Acerte com até 3 dicas: +${r.rewardQuickGuess} token</li>
    <li>Bônus diário: +${r.dailyBonus} tokens</li>`;
  $('#themeIdeas').innerHTML = THEME_IDEAS.map((t) => `<button type="button" class="chip">${esc(t)}</button>`).join('');
}
$('#themeIdeas').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) $('#challengeForm [name=theme]').value = chip.textContent;
});

$('#genCardForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  if (body.category === '__nova') {
    body.category = '';
    if (!body.newCategory?.trim()) return toast('Digite o nome da nova categoria.', 'error');
  } else delete body.newCategory;
  try {
    const { cardId, reused } = await withLoading('Procurando no banco ou criando com a IA…', () => api('/api/cards/generate', { method: 'POST', body }));
    toast(reused ? 'Achamos no banco uma carta assim que você ainda não jogou. Nenhum token gasto!' : 'Carta criada pela IA e salva no banco!');
    if (!reused) await refreshCategories();
    state.challenge = null;
    go('solo', { autostart: false });
    await startSolo(cardId);
  } catch (err) { toast(err.message, 'error'); }
});

$('#challengeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try {
    const { theme, cardIds, reused } = await withLoading('Montando seu desafio…', () => api('/api/challenges', { method: 'POST', body }));
    if (reused) toast('Desafio montado com cartas do banco. Nenhum token gasto!');
    state.challenge = { theme, cardIds, index: 0, score: 0 };
    state.solo = null;
    go('solo', { autostart: false });
    await startSolo(cardIds[0]);
  } catch (err) { toast(err.message, 'error'); }
});

// ---------- banco de cartas ----------

let bankTimer;
async function loadBank() {
  const params = new URLSearchParams({
    search: $('#bankSearch').value.trim(),
    category: $('#bankCategory').value,
    source: $('#bankSource').value,
    limit: '120',
  });
  const { total, cards } = await api(`/api/cards?${params}`);
  $('#bankCount').textContent = `${total} carta(s) no banco`;
  $('#bankGrid').innerHTML = cards
    .map((c) => {
      const rate = c.timesPlayed ? Math.round((c.timesSolved / c.timesPlayed) * 100) : null;
      return `<div class="bank-card" style="border-top-color:${catColor(c.category)}">
        <div class="meta">
          <span class="tag">${esc(CAT_LABEL[c.category] ?? c.category)}</span>
          <span class="tag">${c.totalClues} dicas</span>
          <span class="tag">${esc(DIFF_LABEL[c.difficulty] ?? c.difficulty)}</span>
          ${c.source === 'ia' ? '<span class="tag">✦ IA</span>' : ''}
          ${c.theme ? `<span class="tag">${esc(c.theme)}</span>` : ''}
        </div>
        <div class="first">“${esc(c.firstClue)}”</div>
        <div class="foot">
          <span>${c.timesPlayed} jogos${rate !== null ? ` · ${rate}% acertos` : ''}</span>
          <button class="btn small" data-play="${esc(c.id)}">Jogar</button>
        </div>
      </div>`;
    })
    .join('');
}
['input', 'change'].forEach((ev) =>
  ['#bankSearch', '#bankCategory', '#bankSource'].forEach((sel) =>
    $(sel).addEventListener(ev, () => { clearTimeout(bankTimer); bankTimer = setTimeout(loadBank, 250); })
  )
);
$('#bankGrid').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-play]');
  if (!b) return;
  state.challenge = null;
  go('solo', { autostart: false });
  await startSolo(b.dataset.play);
});

// ---------- multiplayer ----------

function socket() {
  if (state.socket) return state.socket;
  const s = serverUrl() ? io(serverUrl()) : io();
  s.on('room:state', (room) => { state.room = room; renderRoom(); });
  s.on('connect', () => {
    // Reconecta automaticamente à sala depois de uma queda.
    const code = state.room?.code || storage.get('perfil.room');
    if (code) s.emit('room:join', { code, userId: state.userId }, (r) => { if (!r.ok) leaveRoomUi(); });
  });
  state.socket = s;
  return s;
}

function emit(event, payload = {}) {
  return new Promise((resolve) => socket().emit(event, payload, (r) => {
    if (r && !r.ok) toast(r.error, 'error');
    resolve(r);
  }));
}

$('#createRoomBtn').addEventListener('click', async () => {
  const r = await emit('room:create', { userId: state.userId });
  if (r?.ok) storage.set('perfil.room', r.code);
});
$('#joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#roomCodeInput').value.trim().toUpperCase();
  if (code.length !== 4) return toast('O código tem 4 letras.', 'error');
  const r = await emit('room:join', { code, userId: state.userId });
  if (r?.ok) storage.set('perfil.room', r.code);
});

function leaveRoomUi() {
  state.room = null;
  storage.set('perfil.room', null);
  renderRoom();
}

let timerInterval;
function renderRoom() {
  const room = state.room;
  $('#multiLobby').hidden = Boolean(room);
  $('#roomView').hidden = !room;
  clearInterval(timerInterval);
  if (!room) return;
  const me = state.userId;
  const isHost = room.hostId === me;
  const turnPlayer = room.players.find((p) => p.id === room.turnPlayerId);
  const myTurn = room.turnPlayerId === me;

  const playersHtml = `<ul class="players">${[...room.players]
    .sort((a, b) => (room.state === 'lobby' ? 0 : b.score - a.score))
    .map((p) => `<li class="${p.id === room.turnPlayerId ? 'turn' : ''} ${p.connected ? '' : 'off'}">
        <span class="avatar" style="background:${avatarColor(p.name)}">${esc(p.name[0]?.toUpperCase() ?? '?')}</span>
        <span class="nm">${esc(p.name)} ${p.id === me ? '<span class="tag">você</span>' : ''} ${p.id === room.hostId ? '<span class="tag">anfitrião</span>' : ''}</span>
        ${room.state !== 'lobby' ? `<span class="sc">${p.score}</span>` : ''}
      </li>`)
    .join('')}</ul>`;

  const header = `<div class="toolbar">
      <div><div class="muted" style="font-size:13px">Código da sala</div><div class="room-code">${esc(room.code)}</div></div>
      <button class="btn" id="copyCodeBtn">Copiar convite</button>
      <button class="btn" id="leaveRoomBtn">Sair da sala</button>
    </div>`;

  let body;
  if (room.state === 'lobby') {
    body = `<div class="grid2">
      <div class="panel"><h3>Jogadores (${room.players.length}/8)</h3>${playersHtml}</div>
      <div class="panel">
        <h3>Regras da partida</h3>
        <div class="settings-row">
          <label>Rodadas<select id="setRounds" ${isHost ? '' : 'disabled'}>${[3, 5, 7, 10].map((n) => `<option ${n === room.settings.rounds ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label>Categoria<select id="setCategory" ${isHost ? '' : 'disabled'}>
            ${[['', 'Todas'], ...Object.entries(CAT_LABEL)].map(([v, l]) => `<option value="${esc(v)}" ${v === room.settings.category ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select></label>
          <label>Tempo por vez<select id="setTime" ${isHost ? '' : 'disabled'}>${[30, 45, 60, 90].map((n) => `<option value="${n}" ${n === room.settings.turnSeconds ? 'selected' : ''}>${n}s</option>`).join('')}</select></label>
        </div>
        <p class="muted" style="font-size:14px">Na sua vez: chute a resposta ou peça mais uma dica. Errou? Abre a próxima dica e a vez passa. Quem acertar primeiro leva os pontos da carta.</p>
        ${isHost
          ? `<button class="btn primary wide" id="startBtn" ${room.players.length < 2 ? 'disabled' : ''}>${room.players.length < 2 ? 'Aguardando jogadores…' : 'Começar partida'}</button>`
          : '<p class="muted">Aguardando o anfitrião começar…</p>'}
      </div></div>`;
  } else {
    let action = '';
    if (room.state === 'playing') {
      action = `<div class="turn-banner ${myTurn ? 'mine' : ''}">
          <span>${myTurn ? 'Sua vez!' : `Vez de ${esc(turnPlayer?.name ?? '…')}`}</span>
          <span class="timer" id="turnTimer"></span>
        </div>
        <div class="panel">
          <div class="muted">Rodada ${room.round} de ${room.settings.rounds} · valendo</div>
          <div class="points"><span class="value">${room.potentialPoints}</span><span class="muted">pontos</span></div>
          ${myTurn
            ? `<form id="mpGuessForm" style="margin-top:12px"><div class="guess-form"><input id="mpGuess" placeholder="Seu palpite…" autocomplete="off" maxlength="80" /><button class="btn primary">Chutar</button></div>
               <div class="actions"><button type="button" class="btn" id="mpPassBtn">Pedir mais uma dica</button></div></form>`
            : '<p class="muted">Aguarde sua vez. Fique de olho nas dicas!</p>'}
        </div>`;
    } else {
      const r = room.lastResult;
      const winner = room.players.find((p) => p.id === r?.winnerId);
      const final = room.state === 'finished';
      const champion = [...room.players].sort((a, b) => b.score - a.score)[0];
      action = `<div class="panel result ${winner ? 'won' : 'lost'}">
          <h3>${winner ? `${esc(winner.name)} acertou! +${r.points}` : 'Ninguém acertou'}</h3>
          <div class="muted">A resposta era</div>
          <div class="answer">${esc(r?.answer)}</div>
          ${final ? `<p>🏆 <b>${esc(champion?.name)}</b> venceu a partida com ${champion?.score} pontos!</p>` : ''}
          ${isHost
            ? final
              ? '<button class="btn primary wide" id="startBtn">Jogar de novo</button>'
              : '<button class="btn primary wide" id="nextBtn">Próxima rodada</button>'
            : '<p class="muted">Aguardando o anfitrião…</p>'}
        </div>`;
    }
    const cardView = { card: room.card, status: room.state === 'playing' ? 'playing' : 'done' };
    if (room.state !== 'playing' && room.lastResult) cardView.card = { ...room.card, clues: room.lastResult.clues };
    const seenKey = room.card.id + ':' + room.round;
    const highlightFrom = state.roomSeen?.key === seenKey ? state.roomSeen.revealed : room.revealed - 1;
    state.roomSeen = { key: seenKey, revealed: room.revealed };
    body = `<div class="board">
        ${cardHtml(cardView, { extraHints: [], highlightFrom })}
        <div class="side">
          ${action}
          <div class="panel"><h3>Placar</h3>${playersHtml}</div>
          <div class="panel"><h3>Lances</h3><ul class="log">${[...room.log].reverse().map((l) => `<li class="${esc(l.type)}">${esc(l.text)}</li>`).join('')}</ul></div>
        </div>
      </div>`;
  }
  $('#roomView').innerHTML = header + body;

  $('#copyCodeBtn').addEventListener('click', () => {
    const text = `Bora jogar Perfil IA! Entre em ${location.origin} e use o código ${room.code}`;
    navigator.clipboard?.writeText(text).then(() => toast('Convite copiado!'), () => toast(text));
  });
  $('#leaveRoomBtn').addEventListener('click', async () => { await emit('room:leave'); leaveRoomUi(); });
  $('#startBtn')?.addEventListener('click', () => emit('room:start'));
  $('#nextBtn')?.addEventListener('click', () => emit('room:next'));
  const sendSettings = () => emit('room:settings', {
    rounds: Number($('#setRounds').value), category: $('#setCategory').value, turnSeconds: Number($('#setTime').value),
  });
  ['#setRounds', '#setCategory', '#setTime'].forEach((s) => $(s)?.addEventListener('change', sendSettings));
  $('#mpGuessForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const guess = $('#mpGuess').value.trim();
    if (guess) await emit('room:guess', { guess });
  });
  $('#mpPassBtn')?.addEventListener('click', () => emit('room:pass'));
  $('#mpGuess')?.focus();

  if (room.state === 'playing' && room.turnDeadline) {
    const tick = () => {
      const el = $('#turnTimer');
      if (!el) return clearInterval(timerInterval);
      el.textContent = `${Math.max(0, Math.ceil((room.turnDeadline - Date.now()) / 1000))}s`;
    };
    tick();
    timerInterval = setInterval(tick, 500);
  }
}

// ---------- inicialização ----------

function applyCategories(categories) {
  state.config.categories = categories;
  CAT_LABEL = Object.fromEntries(categories.map((c) => [c.slug, c.label]));
  CAT_TITLE = Object.fromEntries(categories.map((c) => [c.slug, c.question]));
  $('#soloCategory').innerHTML = [['', 'Todas'], ...categories.map((c) => [c.slug, c.label])]
    .map(([v, l]) => `<button data-cat="${esc(v)}" class="${v === state.soloCategory ? 'on' : ''}">${esc(l)}</button>`)
    .join('');
  $$('[data-cat-select]').forEach((sel) => {
    const value = sel.value;
    sel.innerHTML =
      `<option value="">${esc(sel.dataset.catSelect)}</option>` +
      categories.map((c) => `<option value="${esc(c.slug)}">${esc(c.label)}</option>`).join('') +
      (sel.id === 'genCategory' ? '<option value="__nova">+ Nova categoria (a IA cria)</option>' : '');
    sel.value = value;
  });
}
async function refreshCategories() {
  const { categories } = await api('/api/categories');
  applyCategories(categories);
}
$('#genCategory').addEventListener('change', (e) => {
  $('#newCategoryField').hidden = e.target.value !== '__nova';
});

$('#serverForm').addEventListener('submit', (e) => {
  e.preventDefault();
  storage.set('perfil.server', $('#serverInput').value.trim());
  location.reload();
});

async function init() {
  $('#serverPanel').hidden = !isApp;
  $('#serverInput').value = serverUrl();
  try {
    state.config = await api('/api/config');
  } catch {
    $('#serverPanel').hidden = false;
    $$('.view').forEach((v) => (v.hidden = v.id !== 'view-home'));
    return toast(isApp ? 'Não conectou ao servidor. Configure o endereço em "Servidor".' : 'Servidor indisponível.', 'error');
  }
  applyCategories(state.config.categories);
  const name = storage.get('perfil.name') || `Jogador ${Math.floor(Math.random() * 900 + 100)}`;
  await api('/api/users', { method: 'POST', body: { name } });
  fillCosts();
  go('home');
  if (storage.get('perfil.room')) socket();
}
init().catch((err) => toast(err.message, 'error'));
