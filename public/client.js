const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const socket = io();
let ME = { id: null, name: '' };
let ROOM = { code: null, hostId: null, players: [], phase: 'LOBBY', subjectName: '', roundNumber: 0 };
let OUT_ID = null; // track current round OUT
let OUT_OPTIONS = []; // options shown to OUT

// Tabs
function showTab(id){
  $$('#pane-game, #pane-admin, #pane-leaderboard').forEach(el => el.classList.add('hidden'));
  $(id).classList.remove('hidden');
  $$('#tab-game, #tab-admin, #tab-leaderboard').forEach(b => b.classList.remove('active'));
  if (id === '#pane-game') $('#tab-game').classList.add('active');
  if (id === '#pane-admin') $('#tab-admin').classList.add('active');
  if (id === '#pane-leaderboard') $('#tab-leaderboard').classList.add('active');
}

$('#tab-game').onclick = () => showTab('#pane-game');
$('#tab-admin').onclick = () => { refreshAdmin(); showTab('#pane-admin'); };
$('#tab-leaderboard').onclick = () => { loadLeaderboard(); showTab('#pane-leaderboard'); };

// Room actions
$('#btn-create').onclick = () => {
  const nickname = $('#nickname').value.trim() || 'Player';
  ME.name = nickname; localStorage.setItem('nickname', nickname);
  socket.emit('room:create', { nickname });
};

socket.on('room:host', ({ code }) => {
  $('#room-code').value = code;
  joinRoom();
});

$('#btn-join').onclick = () => joinRoom();
function joinRoom(){
  const code = ($('#room-code').value || '').toUpperCase().trim();
  if (!code) return alert('Enter room code');
  const nickname = $('#nickname').value.trim() || 'Player';
  ME.name = nickname; localStorage.setItem('nickname', nickname);
  socket.emit('room:join', { code, nickname });
}

socket.on('connect', () => { ME.id = socket.id; $('#nickname').value = localStorage.getItem('nickname') || ''; });

socket.on('room:update', (state) => {
  ROOM = state;
  $('#room-info').textContent = `Room ${state.code} • Round ${state.roundNumber} • Phase ${state.phase}`;

  // players list
  const ul = $('#players');
  ul.innerHTML = '';
  state.players.forEach(p => {
    const li = document.createElement('li');
    li.className = 'player-pill';
    li.innerHTML = `<span>${p.name}</span><span class="muted">${p.score} pts${p.id === state.hostId ? ' • Host' : ''}</span>`;
    ul.appendChild(li);
  });

  // host controls visibility
  $('#host-controls').style.display = (state.hostId === ME.id) ? 'flex' : 'none';

  // phase panes
  showPhase(state.phase);

  // subjects dropdown refresh
  loadSubjectsForSelect();

  // voting grid refresh
  if (state.phase === 'VOTE') buildVoteGrid(state.players);
});

function showPhase(phase){
  $$('#phase-reveal, #phase-qa, #phase-vote, #phase-guess, #phase-result').forEach(el => el.classList.add('hidden'));
  if (phase === 'REVEAL') $('#phase-reveal').classList.remove('hidden');
  if (phase === 'QA') $('#phase-qa').classList.remove('hidden');
  if (phase === 'VOTE') $('#phase-vote').classList.remove('hidden');
  if (phase === 'GUESS') $('#phase-guess').classList.remove('hidden');
  if (phase === 'RESULT') $('#phase-result').classList.remove('hidden');

  // Enable/disable host buttons according to phase
  $('#btn-start-round').disabled = !(phase === 'LOBBY' || phase === 'RESULT');
  $('#btn-to-qa').disabled = !(phase === 'REVEAL');
  $('#btn-random-prompt').disabled = !(phase === 'QA');
  $('#btn-to-vote').disabled = !(phase === 'QA');
  $('#btn-announce-out').disabled = !(phase === 'VOTE');
}

// Host controls
$('#btn-start-round').onclick = () => {
  const subjectName = $('#subject-select').value;
  if (!subjectName) return alert('Pick a subject');
  socket.emit('game:startRound', { code: ROOM.code, subjectName });
};
$('#btn-to-qa').onclick = () => socket.emit('game:toQA', { code: ROOM.code });
$('#btn-random-prompt').onclick = () => socket.emit('game:randomPrompt', { code: ROOM.code });
$('#btn-to-vote').onclick = () => socket.emit('game:toVote', { code: ROOM.code });
$('#btn-announce-out').onclick = () => socket.emit('game:announceOut', { code: ROOM.code });

// Errors & coverage status
socket.on('game:error', ({ message }) => {
  $('#error-box').textContent = message || 'Error';
  setTimeout(() => $('#error-box').textContent = '', 3000);
});
socket.on('game:coverage', ({ met }) => {
  $('#coverage-hint').textContent = met ? 'Q&A coverage met ✅ — You can proceed to Voting.' : 'Q&A coverage not met ❌ — keep prompting.';
});

// Reveal DM
socket.on('game:reveal', ({ role, subjectName, secret }) => {
  const text = (role === 'IN')
    ? `You are IN. Subject: ${subjectName}. SECRET: ${secret}`
    : `You are OUT. Subject: ${subjectName}. Try to blend in!`;
  $('#reveal-text').textContent = text;
  showPhase('REVEAL');
});

// Prompt broadcast
socket.on('game:prompt', ({ askerId, targetId }) => {
  const asker = ROOM.players.find(p => p.id === askerId)?.name || 'Someone';
  const target = ROOM.players.find(p => p.id === targetId)?.name || 'Someone';
  $('#prompt-text').textContent = `${asker} → ask → ${target}`;
});

// Voting
function buildVoteGrid(players){
  const grid = $('#vote-grid');
  grid.innerHTML = '';
  players.forEach(p => {
    if (p.id === ME.id) return; // optional: cannot vote yourself
    const card = document.createElement('div');
    card.className = 'vote-card';
    card.innerHTML = `<div style="margin-bottom:8px; font-weight:600;">${p.name}</div>`;
    const btn = document.createElement('button');
    btn.textContent = 'Vote OUT';
    btn.onclick = () => socket.emit('game:vote', { code: ROOM.code, targetId: p.id });
    card.appendChild(btn);
    grid.appendChild(card);
  });
}
socket.on('game:votes:update', ({ count }) => {
  $('#vote-status').textContent = `${count} vote(s) received`;
});

// Announce & Guess
socket.on('game:guess:start', ({ outId, subjectName }) => {
  OUT_ID = outId;
  const outName = ROOM.players.find(p => p.id === outId)?.name || 'Unknown';
  $('#announce-text').textContent = `OUT is ${outName}. Subject: ${subjectName}. Now the OUT must guess the secret.`;
  $('#guess-status').textContent = (ME.id === outId) ? 'Select the correct secret:' : 'Waiting for OUT to guess...';
  $('#guess-options').innerHTML = ''; // will fill when options arrive
  showPhase('GUESS');
});

socket.on('game:guess:options', ({ options }) => {
  OUT_OPTIONS = options || [];
  const cont = $('#guess-options');
  cont.innerHTML = '';
  if (ME.id !== OUT_ID) {
    cont.innerHTML = '<div class="muted">Only the OUT sees the options.</div>';
    return;
  }
  OUT_OPTIONS.forEach(opt => {
    const btn = document.createElement('button');
    btn.textContent = opt;
    btn.onclick = () => {
      $('#guess-status').textContent = `You selected: ${opt}. Sending...`;
      socket.emit('game:guess:answer', { code: ROOM.code, choice: opt });
      // Prevent double clicks
      cont.querySelectorAll('button').forEach(b => b.disabled = true);
    };
    cont.appendChild(btn);
  });
});

// Results
socket.on('game:result', ({ outId, secret, outGuess, votes }) => {
  const outName = ROOM.players.find(p => p.id === outId)?.name || 'Unknown';
  const guessTxt = outGuess
    ? `OUT guessed: "${outGuess.choice}" — ${outGuess.correct ? 'Correct ✅ (+2)' : 'Wrong ❌'}`
    : '';
  const votedCorrectCount = Object.values(votes || {}).filter(t => t === outId).length;
  $('#result-text').textContent = `OUT: ${outName}. Secret was: ${secret}. ${guessTxt}. ${votedCorrectCount} player(s) voted correctly.`;
  showPhase('RESULT');
});

// Subjects / Admin / Leaderboard
async function fetchJSON(url, opts){
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function loadSubjectsForSelect(){
  const data = await fetchJSON('/api/subjects');
  const sel = $('#subject-select');
  const prev = sel.value;
  sel.innerHTML = '<option value="">Select subject…</option>' + data.map(s => `<option>${s.name}</option>`).join('');
  if (prev) sel.value = prev;
  // Render admin list if visible
  if (!$('#pane-admin').classList.contains('hidden')) renderAdminSubjects(data);
}

async function refreshAdmin(){ await loadSubjectsForSelect(); }

$('#btn-add-subject').onclick = async () => {
  const name = $('#new-subject').value.trim();
  if (!name) return;
  await fetchJSON('/api/subjects', { method:'POST', body: JSON.stringify({ name }) });
  $('#new-subject').value='';
  refreshAdmin();
};

$('#btn-add-item').onclick = async () => {
  const subjectName = $('#item-subject').value.trim();
  const value = $('#item-value').value.trim();
  if (!subjectName || !value) return;
  await fetchJSON('/api/items', { method:'POST', body: JSON.stringify({ subjectName, value }) });
  $('#item-value').value='';
  refreshAdmin();
};

function renderAdminSubjects(data){
  const container = $('#subjects');
  container.innerHTML = '';
  data.forEach(s => {
    const box = document.createElement('div');
    box.className = 'subject';
    const title = document.createElement('div');
    title.textContent = `${s.name} (${s.items.length})`;
    box.appendChild(title);
    const list = document.createElement('div');
    list.className = 'stack';
    s.items.forEach(it => {
      const row = document.createElement('div');
      row.className = 'item';
      row.innerHTML = `<span>${it.value}</span>`;
      const del = document.createElement('button');
      del.className = 'secondary';
      del.textContent = 'Delete';
      del.onclick = async () => { await fetchJSON(`/api/items/${it.id}`, { method:'DELETE' }); refreshAdmin(); };
      row.appendChild(del);
      list.appendChild(row);
    });
    box.appendChild(list);
    container.appendChild(box);
  });
}

async function loadLeaderboard(){
  const data = await fetchJSON('/api/scores');
  const ul = $('#leaderboard');
  ul.innerHTML = '';
  data.forEach((r, i) => {
    const li = document.createElement('li');
    li.textContent = `${i+1}. ${r.nickname} – ${r.points} pts`;
    ul.appendChild(li);
  });
}
