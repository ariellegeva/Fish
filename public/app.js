// ===================== CONSTANTS =====================
const EMOJIS = ['😀','😎','🐟','🦈','🐙','🦊','🐻','🐼','🦁','🐯','🐸','🦋','🌊','⭐','🎯','🎲','🍕','🚀'];

const HALF_SUITS = [
  { id: 'low_hearts',    name: 'Low',    suit: '♥', cards: ['2♥','3♥','4♥','5♥','6♥','7♥'],   red: true },
  { id: 'high_hearts',   name: 'High',   suit: '♥', cards: ['9♥','10♥','J♥','Q♥','K♥','A♥'],  red: true },
  { id: 'low_clubs',     name: 'Low',    suit: '♣', cards: ['2♣','3♣','4♣','5♣','6♣','7♣'],   red: false },
  { id: 'high_clubs',    name: 'High',   suit: '♣', cards: ['9♣','10♣','J♣','Q♣','K♣','A♣'],  red: false },
  { id: 'low_diamonds',  name: 'Low',    suit: '♦', cards: ['2♦','3♦','4♦','5♦','6♦','7♦'],   red: true },
  { id: 'high_diamonds', name: 'High',   suit: '♦', cards: ['9♦','10♦','J♦','Q♦','K♦','A♦'],  red: true },
  { id: 'low_spades',    name: 'Low',    suit: '♠', cards: ['2♠','3♠','4♠','5♠','6♠','7♠'],   red: false },
  { id: 'high_spades',   name: 'High',   suit: '♠', cards: ['9♠','10♠','J♠','Q♠','K♠','A♠'],  red: false },
];

function cardSuit(card) {
  if (card.includes('♥')) return '♥';
  if (card.includes('♦')) return '♦';
  if (card.includes('♣')) return '♣';
  return '♠';
}
function cardRank(card) { return card.replace(/[♥♦♣♠]/g, ''); }
function cardRed(card)  { return card.includes('♥') || card.includes('♦'); }
function cardToHalfSuit(card) { return HALF_SUITS.find(hs => hs.cards.includes(card)); }

// ===================== STATE =====================
let socket;
let state = {
  adminIcon: '😀', joinIcon: '😀',
  pendingCode: null,
  selectedCount: 6,
  room: null,
  myHand: [],
  myId: null,
  // asking state
  askSuit: null,       // selected half-suit id in ASK panel
  selectedCard: null,
  selectedTarget: null,
  // score/panel
  panelCards: [],
  rightPanelMode: 'ask', // 'ask' | 'score'
  inCreateFlow: false,
};

let eventOverlayTimer = null;

// ===================== INIT =====================
window.addEventListener('DOMContentLoaded', () => {
  buildEmojiGrids();
  buildCountGrid();
  initSocket();

  const urlCode = getUrlCode();
  if (urlCode) {
    state.pendingCode = urlCode;
    document.getElementById('join-display-code').textContent = urlCode;
    showPage('join-name');
  } else {
    checkRestore();
  }
});

function initSocket() {
  socket = io();
  socket.on('connect', () => { state.myId = socket.id; });

  socket.on('room_update', (room) => {
    const wasPlaying = state.room && state.room.phase === 'playing';
    state.room = room;
    if (!wasPlaying && room.phase === 'playing') {
      document.getElementById('nav').classList.remove('hidden');
      updateNav();
      showTab('game');
      return;
    }
    renderAll();
  });

  socket.on('your_hand', (hand) => {
    state.myHand = hand;
    state.panelCards = state.panelCards.filter(c => hand.includes(c));
    // If selected card no longer in hand, clear ask state
    if (state.selectedCard && !hand.includes(state.selectedCard)) clearAsk();
    renderHand();
    renderActionStrip();
    renderPanelTray();
  });

  socket.on('chat_message', (msg) => appendChat(msg));

  socket.on('player_exited', ({ name }) => {
    document.getElementById('exit-modal-text').textContent = `${name} exited the game.`;
    document.getElementById('exit-modal').classList.remove('hidden');
  });

  socket.on('ask_result', (data) => showEventOverlay(data));
}

function checkRestore() {
  const saved = getSaved();
  if (!saved) return;
  const doRejoin = () => {
    if (state.inCreateFlow) return;
    state.myId = socket.id;
    socket.emit('join_room', { code: saved.code, name: saved.name, icon: saved.icon }, (res) => {
      if (!res.ok || state.inCreateFlow) return;
      state.room = res.room;
      state.myHand = res.myHand || [];
      showPage('lobby');
      updateNav();
      if (res.room.phase !== 'lobby') showTab('game');
    });
  };
  if (socket.connected) doRejoin();
  else socket.once('connect', doRejoin);
}

function getUrlCode() {
  const p = new URLSearchParams(window.location.search);
  return p.get('code') ? p.get('code').toUpperCase() : null;
}
function getSaved() { try { return JSON.parse(localStorage.getItem('fish_session')); } catch { return null; } }
function saveSession(code, name, icon) { localStorage.setItem('fish_session', JSON.stringify({ code, name, icon })); }

// ===================== PAGES / TABS =====================
function showPage(name) {
  document.querySelectorAll('[id^="page-"],[id^="tab-"]').forEach(el => el.classList.add('hidden'));
  document.getElementById('nav').classList.add('hidden');
  if (name === 'lobby') {
    document.getElementById('nav').classList.remove('hidden');
    document.getElementById('tab-lobby').classList.remove('hidden');
    updateNav(); renderLobby(); return;
  }
  document.getElementById('page-' + name)?.classList.remove('hidden');
}

function showTab(name) {
  document.querySelectorAll('[id^="tab-"]').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + name)?.classList.remove('hidden');
  document.getElementById('nav-' + name)?.classList.add('active');
  if (name === 'game') renderGameTab();
  if (name === 'settings') renderSettings();
}

function updateNav() {
  const room = state.room; if (!room) return;
  document.getElementById('nav').classList.remove('hidden');
  document.getElementById('nav-chat').style.display = room.settings.chatEnabled ? '' : 'none';
  let ln = document.getElementById('nav-lobby');
  if (!ln) {
    ln = document.createElement('span');
    ln.className = 'nav-item'; ln.id = 'nav-lobby'; ln.textContent = 'Lobby';
    ln.onclick = () => { showTab('lobby'); renderLobby(); };
    document.getElementById('nav').prepend(ln);
  }
  ln.style.display = room.phase === 'lobby' ? '' : 'none';
}

// ===================== EMOJI / COUNT =====================
function buildEmojiGrids() {
  ['admin','join'].forEach(prefix => {
    const grid = document.getElementById(`${prefix}-emoji-grid`);
    EMOJIS.forEach(e => {
      const d = document.createElement('div');
      d.className = 'emoji-opt'; d.textContent = e;
      d.onclick = () => selectEmoji(prefix, e, d);
      grid.appendChild(d);
    });
  });
}
function selectEmoji(prefix, emoji, el) {
  document.querySelectorAll(`#${prefix}-emoji-grid .emoji-opt`).forEach(x => x.classList.remove('selected'));
  el.classList.add('selected');
  state[`${prefix}Icon`] = emoji;
  document.getElementById(`${prefix}-icon-preview`).innerHTML = emoji;
}
function handleIconUpload(prefix) {
  const file = document.getElementById(`${prefix}-icon-file`).files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = e => {
    state[`${prefix}Icon`] = e.target.result;
    document.getElementById(`${prefix}-icon-preview`).innerHTML = `<img src="${e.target.result}">`;
  };
  r.readAsDataURL(file);
}
function buildCountGrid() {
  const counts = [6,8,7,10,9,5,2];
  const grid = document.getElementById('count-grid');
  counts.forEach(n => {
    const b = document.createElement('div');
    b.className = 'count-btn' + (n === state.selectedCount ? ' selected' : '');
    b.innerHTML = `${n}${n===2 ? '<span class="cs-label">test</span>' : ''}`;
    b.onclick = () => selectCount(n);
    grid.appendChild(b);
  });
}
function selectCount(n) {
  state.selectedCount = n;
  document.querySelectorAll('.count-btn').forEach(b => b.classList.toggle('selected', parseInt(b.textContent) === n));
}
function toggleTimerSub() {
  document.getElementById('timer-sub').classList.toggle('hidden', !document.getElementById('timer-toggle').checked);
}

// ===================== ADMIN FLOW =====================
function goAdminSettings() {
  if (!document.getElementById('admin-name-input').value.trim()) return alert('Please enter your name.');
  state.inCreateFlow = true;
  localStorage.removeItem('fish_session');
  showPage('admin-settings');
}
function createRoom() {
  const name = document.getElementById('admin-name-input').value.trim();
  const icon = state.adminIcon;
  const settings = {
    numPlayers: state.selectedCount,
    timerEnabled: document.getElementById('timer-toggle').checked,
    timerSeconds: parseInt(document.getElementById('timer-seconds').value) || 60,
    chatEnabled: document.getElementById('chat-toggle').checked,
    teamSelection: document.getElementById('team-selection-toggle').checked,
  };
  socket.emit('create_room', { name, icon, settings }, (res) => {
    if (!res.ok) return alert('Error creating room');
    state.room = res.room; state.myHand = []; saveSession(res.code, name, icon);
    document.getElementById('display-code').textContent = res.code;
    const link = `${location.origin}?code=${res.code}`;
    document.getElementById('share-link').textContent = link;
    document.getElementById('share-link').href = link;
    showPage('lobby-code');
  });
}
function copyLink() {
  if (state.room) navigator.clipboard.writeText(`${location.origin}?code=${state.room.code}`);
}

// ===================== JOIN FLOW =====================
function joinWithCode() {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (code.length < 4) return alert('Please enter a 4-character code.');
  state.inCreateFlow = true;
  localStorage.removeItem('fish_session');
  state.pendingCode = code;
  document.getElementById('join-display-code').textContent = code;
  showPage('join-name');
}
function joinRoom(teamOverride) {
  const name = document.getElementById('join-name-input').value.trim();
  if (!name) return alert('Please enter your name.');
  const icon = state.joinIcon;
  const code = state.pendingCode || getUrlCode();
  if (!code) return;
  socket.emit('join_room', { code, name, icon, team: teamOverride || null }, (res) => {
    if (!res.ok) { document.getElementById('join-error').textContent = res.error || 'Could not join.'; return; }
    state.room = res.room; state.myHand = res.myHand || []; saveSession(code, name, icon);
    if (res.room.settings.teamSelection && res.room.phase === 'lobby' && !teamOverride) {
      showPage('join-team'); renderTeamTable();
    } else {
      showPage('lobby'); updateNav(); renderLobby();
      if (res.room.phase !== 'lobby') showTab('game');
    }
  });
}
function joinTeam(team) {
  const name = document.getElementById('join-name-input').value.trim();
  const code = state.pendingCode || getUrlCode();
  socket.emit('join_room', { code, name, icon: state.joinIcon, team }, (res) => {
    if (!res.ok) return alert(res.error || 'Could not join team.');
    state.room = res.room; saveSession(code, name, state.joinIcon);
    showPage('lobby'); updateNav(); renderLobby();
  });
}
function renderTeamTable() {
  const room = state.room; if (!room) return;
  const t1 = room.players.filter(p => p.team === 1), t2 = room.players.filter(p => p.team === 2);
  const tbody = document.getElementById('team-table-body');
  tbody.innerHTML = '';
  for (let i = 0; i < Math.max(t1.length, t2.length, 1); i++) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${t1[i] ? playerInline(t1[i]) : ''}</td><td>${t2[i] ? playerInline(t2[i]) : ''}</td>`;
    tbody.appendChild(tr);
  }
}

// ===================== LOBBY =====================
function renderLobby() {
  const room = state.room; if (!room) return;
  document.getElementById('lobby-code').textContent = room.code;
  const isAdmin = room.adminId === socket.id;
  const canStart = isAdmin && room.players.length >= 2;
  document.getElementById('lobby-start-btn-wrap').style.display = isAdmin ? '' : 'none';
  document.getElementById('lobby-start-btn').disabled = !canStart;
  const needed = room.settings.numPlayers - room.players.length;
  document.getElementById('lobby-waiting-msg').textContent =
    needed > 0 ? `Waiting for ${needed} more player${needed !== 1 ? 's' : ''}...` : 'All players present!';
  document.getElementById('lobby-player-list').innerHTML = room.players.map(p => `
    <div class="player-card ${p.connected ? '' : 'disconnected'}">
      <div class="player-avatar avatar-t${p.team}">${isImg(p.icon) ? `<img src="${p.icon}">` : p.icon}</div>
      <div class="player-info">
        <div class="player-name">${p.name} ${p.id === room.adminId ? '👑' : ''}</div>
        <div class="player-meta">${p.connected ? 'Online' : 'Disconnected'}</div>
      </div>
      <span class="team-badge team${p.team}">Team ${p.team}</span>
    </div>`).join('');
}
function startGame() {
  socket.emit('start_game', {}, (res) => {
    if (!res?.ok) return alert(res?.error || 'Could not start');
    updateNav(); showTab('game');
  });
}

// ===================== RENDER ALL =====================
function renderAll() {
  updateNav();
  const room = state.room; if (!room) return;
  if (!document.getElementById('tab-lobby').classList.contains('hidden')) renderLobby();
  if (!document.getElementById('tab-game').classList.contains('hidden'))  renderGameTab();
  if (!document.getElementById('tab-settings').classList.contains('hidden')) renderSettings();
}

// ===================== GAME TAB =====================
function renderGameTab() {
  const room = state.room; if (!room) return;
  renderTurnBanner();
  renderOvalPlayers();
  renderHand();
  renderActionStrip();
  renderRightPanel();
}

function renderTurnBanner() {
  const room = state.room;
  const banner = document.getElementById('turn-banner-v2');
  const current = room.players.find(p => p.id === room.currentTurn);
  if (room.phase !== 'playing' || !current) { banner.className = ''; return; }
  const mine = current.id === socket.id;
  banner.className = 'show ' + (mine ? 'mine' : 'other');
  banner.textContent = mine ? '🎯 Your turn!' : `${current.name}'s turn`;
}

// ===================== OVAL PLAYERS =====================
function renderOvalPlayers() {
  const room = state.room; if (!room) return;
  const container = document.getElementById('oval-players');
  container.innerHTML = '';
  const players = room.players;
  const myIdx = players.findIndex(p => p.id === socket.id);
  const n = players.length;
  const me = players[myIdx];
  const myTurn = room.currentTurn === socket.id;

  players.forEach((p, i) => {
    const offset = (i - myIdx + n) % n;
    const angleDeg = 90 + (offset / n) * 360;
    const angleRad = (angleDeg * Math.PI) / 180;
    const rx = 38, ry = 32;
    const xPct = 50 + rx * Math.cos(angleRad);
    const yPct = 50 + ry * Math.sin(angleRad);

    const isCurrent = p.id === room.currentTurn;
    const isOpponent = me && p.team !== me.team;
    const isClickable = myTurn && isOpponent && p.connected && state.selectedCard;
    const isTargeted = state.selectedTarget === p.id;
    const isMe = p.id === socket.id;

    const cardCount = p.cardCount || 0;
    const stackHTML = cardCount > 0
      ? `<div class="card-stack-wrap" id="stack-${p.id}" style="margin-top:4px">
           <div class="stack-shadow-2"></div>
           <div class="stack-shadow-1"></div>
           <div class="card-back"></div>
           <span class="card-stack-count">${cardCount}</span>
         </div>`
      : `<div style="height:30px;font-size:11px;color:#9a8a7a;font-weight:700;padding-top:8px">no cards</div>`;

    const tile = document.createElement('div');
    tile.className = ['player-oval-tile', isCurrent?'current-turn':'', isClickable?'clickable':'',
      isTargeted?'targeted':'', !p.connected?'disconnected':''].join(' ');
    tile.style.left = xPct + '%';
    tile.style.top = yPct + '%';
    if (isClickable || (myTurn && isOpponent)) tile.onclick = () => selectTarget(p.id);

    tile.innerHTML = `
      <div class="player-avatar-big avatar-t${p.team}">${isImg(p.icon) ? `<img src="${p.icon}">` : p.icon}</div>
      <div class="player-oval-name">${p.name}${p.id === room.adminId ? ' 👑' : ''}${isMe ? ' (you)' : ''}</div>
      <span class="player-oval-team t${p.team}">T${p.team}</span>
      ${stackHTML}`;
    container.appendChild(tile);
  });
}

// ===================== HAND =====================
function renderHand() {
  const container = document.getElementById('hand-container-v2');
  document.getElementById('hand-count').textContent = `(${state.myHand.length})`;

  // Which cards are in the selected suit (for dimming others)
  const suitCards = state.askSuit
    ? (HALF_SUITS.find(h => h.id === state.askSuit)?.cards || [])
    : null;

  container.innerHTML = state.myHand.map(card => {
    const red = cardRed(card);
    const rank = cardRank(card), suit = cardSuit(card);
    const isSelectedAsk = state.selectedCard === card;
    const isInPanel    = state.panelCards.includes(card);
    const isDimmed     = suitCards && !suitCards.includes(card) && !isSelectedAsk;
    const cls = ['hand-card-v2', red?'red':'black',
      isSelectedAsk?'selected':'', isInPanel?'in-panel':'', isDimmed?'dimmed':''].join(' ');
    return `<div class="${cls}" onclick="handleCardClick('${card}')">
      <div class="rank-top">${rank}<span class="suit-small">${suit}</span></div>
      <div class="suit-center">${suit}</div>
      <div class="rank-bottom">${rank}</div>
    </div>`;
  }).join('');
}

function handleCardClick(card) {
  if (state.rightPanelMode === 'score') { togglePanelCard(card); return; }
  // In ask mode: only selectable if in the chosen suit (or no suit chosen yet)
  const suitCards = state.askSuit ? (HALF_SUITS.find(h => h.id === state.askSuit)?.cards || []) : null;
  if (suitCards && !suitCards.includes(card)) return;
  selectCard(card);
}

// ===================== ACTION STRIP =====================
function renderActionStrip() {
  const room = state.room;
  const myTurn = room && room.currentTurn === socket.id;
  const me = room && room.players.find(p => p.id === socket.id);
  const outOfCards = state.myHand.length === 0;
  const askArea  = document.getElementById('action-strip');
  const passArea = document.getElementById('pass-area');
  const hint     = document.getElementById('hand-strip-hint');

  if (!room || room.phase !== 'playing' || !me) {
    askArea.style.display = 'none'; passArea.style.display = 'none';
    hint.textContent = ''; return;
  }

  if (myTurn && outOfCards) {
    askArea.style.display = 'none'; passArea.style.display = 'flex';
    renderPassTargets();
    hint.textContent = '';
  } else if (myTurn) {
    passArea.style.display = 'none'; askArea.style.display = 'flex';
    const targetPlayer = state.selectedTarget && room.players.find(p => p.id === state.selectedTarget);
    const hs = state.selectedCard && cardToHalfSuit(state.selectedCard);
    const red = state.selectedCard && cardRed(state.selectedCard);
    document.getElementById('ask-summary').innerHTML = state.selectedCard
      ? `Asking <span class="ask-hi">${targetPlayer ? targetPlayer.name : '—'}</span> for <span class="ask-card-badge${red ? ' red' : ''}">${state.selectedCard}</span>${hs ? ` <span style="color:#6a5a4a;font-size:13px">(${hs.name} ${hs.suit})</span>` : ''}`
      : `<span style="color:#5a4a3a">Pick a suit → card → opponent</span>`;
    document.getElementById('ask-btn').disabled = !state.selectedCard || !state.selectedTarget;
    hint.textContent = '';
  } else {
    askArea.style.display = 'none'; passArea.style.display = 'none';
    hint.textContent = state.rightPanelMode === 'score' ? 'Click cards to add to discussion tray' : '';
  }
}

function renderPassTargets() {
  const room = state.room;
  const me = room.players.find(p => p.id === socket.id);
  const teammates = room.players.filter(p => p.team === me.team && p.id !== socket.id && p.connected);
  document.getElementById('pass-targets').innerHTML = teammates.map(p =>
    `<button class="secondary" style="padding:4px 12px;font-size:12px" onclick="passTurn('${p.id}')">${isImg(p.icon)?'':p.icon} ${p.name}</button>`
  ).join('');
}

// ===================== RIGHT PANEL =====================
function showRightPanel(mode) {
  state.rightPanelMode = mode;
  renderRightPanel();
}

function renderRightPanel() {
  const room = state.room; if (!room) return;
  const myTurn = room.currentTurn === socket.id && room.phase === 'playing';

  // Auto-switch to ask panel when it's my turn (unless user manually chose score)
  // Only auto-switch when it BECOMES my turn (handled in renderAll via room_update)
  const mode = state.rightPanelMode;

  document.getElementById('rp-ask').classList.toggle('hidden', mode !== 'ask');
  document.getElementById('rp-score').classList.toggle('hidden', mode !== 'score');

  // Show "◂ Ask" back button only if it's my turn and I'm viewing score
  const backBtn = document.getElementById('rp-back-ask');
  if (backBtn) backBtn.style.display = (myTurn && mode === 'score') ? '' : 'none';

  if (mode === 'ask') renderAskPanel();
  else renderScorePanel();
}

function renderAskPanel() {
  const room = state.room; if (!room) return;
  const myTurn = room.currentTurn === socket.id && room.phase === 'playing';
  const claimed = new Set(room.claimedSuits.map(s => s.id));
  const list = document.getElementById('ask-suit-list');

  if (!myTurn) {
    list.innerHTML = `<div style="padding:20px 0;text-align:center;color:#6a5a4a;font-size:13px;font-weight:700">
      Waiting for your turn…</div>`;
    return;
  }

  const askable = HALF_SUITS.filter(hs =>
    !claimed.has(hs.id) && hs.cards.some(c => state.myHand.includes(c))
  );

  if (askable.length === 0) {
    list.innerHTML = `<div style="padding:20px 0;text-align:center;color:#6a5a4a;font-size:13px;font-weight:700">
      No suits available to ask about</div>`;
    return;
  }

  // Suit buttons
  let html = askable.map(hs => {
    const sel = state.askSuit === hs.id;
    return `<button class="ask-suit-btn ${sel ? 'selected' : ''}" onclick="selectAskSuit('${hs.id}')">
      <span>${hs.name}</span>
      <span class="suit-sym ${hs.red ? 'red' : 'black'}">${hs.suit}</span>
    </button>`;
  }).join('');

  // Card picker — shown after a suit is selected
  if (state.askSuit) {
    const hs = HALF_SUITS.find(h => h.id === state.askSuit);
    if (hs) {
      // Cards in this suit the player does NOT hold (these are what they can ask for)
      const askableCards = hs.cards.filter(c => !state.myHand.includes(c));
      if (askableCards.length > 0) {
        html += `<div class="ask-card-divider">Pick a card to ask for</div>`;
        html += `<div class="ask-card-grid">` + askableCards.map(card => {
          const red = cardRed(card);
          const rank = cardRank(card);
          const suit = cardSuit(card);
          const sel = state.selectedCard === card;
          return `<button class="ask-card-pick ${sel ? 'selected' : ''} ${red ? 'red' : 'black'}"
            onclick="selectCard('${card}')">
            <span class="acp-rank">${rank}</span>
            <span class="acp-suit">${suit}</span>
          </button>`;
        }).join('') + `</div>`;
      }
    }
  }

  list.innerHTML = html;
}

function selectAskSuit(id) {
  state.askSuit = state.askSuit === id ? null : id;
  // Clear card selection if it's no longer in the new suit
  if (state.selectedCard && state.askSuit) {
    const hs = HALF_SUITS.find(h => h.id === state.askSuit);
    if (hs && !hs.cards.includes(state.selectedCard)) {
      state.selectedCard = null;
      state.selectedTarget = null;
    }
  }
  renderAskPanel();
  renderHand();
  renderActionStrip();
  renderOvalPlayers();
}

// ===================== SCORE PANEL =====================
function renderScorePanel() {
  const room = state.room; if (!room) return;
  document.getElementById('panel-score-t1').textContent = room.scores.team1;
  document.getElementById('panel-score-t2').textContent = room.scores.team2;
  document.getElementById('panel-score-mid').textContent = room.claimedSuits.filter(s => s.winner === 0).length;
  const won1 = room.claimedSuits.filter(s => s.winner === 1);
  const won2 = room.claimedSuits.filter(s => s.winner === 2);
  document.getElementById('won-t1').innerHTML = won1.length
    ? won1.map(s => `<span class="won-suit-badge t1">${s.name}</span>`).join('')
    : '<span style="font-size:12px;color:#4a3a2a;font-weight:600">—</span>';
  document.getElementById('won-t2').innerHTML = won2.length
    ? won2.map(s => `<span class="won-suit-badge t2">${s.name}</span>`).join('')
    : '<span style="font-size:12px;color:#4a3a2a;font-weight:600">—</span>';
  renderPanelTray();
  renderPanelSuits();
}

function renderPanelTray() {
  const tray = document.getElementById('panel-tray');
  const hint = document.getElementById('panel-tray-hint');
  if (state.panelCards.length === 0) { tray.innerHTML = ''; tray.appendChild(hint); return; }
  hint.remove();
  tray.innerHTML = state.panelCards.map(card => {
    const red = cardRed(card); const rank = cardRank(card), suit = cardSuit(card);
    return `<div class="card-face ${red?'red':'black'}" style="width:44px;height:62px;padding:3px 4px;cursor:pointer" onclick="togglePanelCard('${card}')">
      <div class="rank-top" style="font-size:11px">${rank}<span class="suit-small" style="font-size:9px">${suit}</span></div>
      <div class="suit-center" style="font-size:20px">${suit}</div>
    </div>`;
  }).join('');
  tray.appendChild(hint);
}

function renderPanelSuits() {
  const room = state.room;
  const isAdmin = room && room.adminId === socket.id;
  const claimedMap = {};
  room.claimedSuits.forEach(s => claimedMap[s.id] = s);
  document.getElementById('panel-suits-list').innerHTML = HALF_SUITS.map(hs => {
    const award = claimedMap[hs.id]; const done = !!award;
    const winnerEl = award
      ? `<span class="psw ${award.winner===1?'w1':award.winner===2?'w2':'wm'}">${award.winner===0?'Middle':`T${award.winner}`}</span>`
      : '';
    const btns = isAdmin && !done
      ? `<span class="award-btns">
           <button class="ab1" onclick="awardSuit('${hs.id}',1)">T1</button>
           <button class="abm" onclick="awardSuit('${hs.id}',0)">Mid</button>
           <button class="ab2" onclick="awardSuit('${hs.id}',2)">T2</button>
         </span>` : '';
    return `<div class="panel-suit-row ${done?'claimed':''}">
      <span class="psn">${hs.name} ${hs.suit}</span>${winnerEl}${btns}</div>`;
  }).join('');
}

function togglePanelCard(card) {
  const idx = state.panelCards.indexOf(card);
  if (idx >= 0) state.panelCards.splice(idx, 1); else state.panelCards.push(card);
  renderHand(); renderPanelTray();
}
function clearSelectedCards() { state.panelCards = []; renderHand(); renderPanelTray(); }
function awardSuit(halfSuitId, winner) {
  socket.emit('award_suit', { halfSuitId, winner }, (res) => { if (!res.ok) alert(res.error || 'Could not award suit'); });
}

// ===================== EVENT OVERLAY =====================
function buildCardFaceHTML(card, size = 'sm') {
  const red = cardRed(card); const rank = cardRank(card); const suit = cardSuit(card);
  const w = size === 'lg' ? '80px' : '58px';
  const h = size === 'lg' ? '112px' : '82px';
  const fs = size === 'lg' ? '36px' : '26px';
  const rfs = size === 'lg' ? '18px' : '13px';
  return `<div class="card-face ${red?'red':'black'}" style="width:${w};height:${h};flex-shrink:0">
    <div class="rank-top" style="font-size:${rfs}">${rank}<span class="suit-small" style="font-size:calc(${rfs} - 2px)">${suit}</span></div>
    <div class="suit-center" style="font-size:${fs}">${suit}</div>
    <div class="rank-bottom" style="font-size:${rfs}">${rank}</div>
  </div>`;
}

function showEventOverlay({ askerId, askerName, targetId, targetName, card, hadCard }) {
  const me = socket.id;
  const askerLabel = askerId === me ? `${askerName} (you)` : askerName;
  const targetLabel = targetId === me ? `${targetName} (you)` : targetName;

  const overlay = document.getElementById('event-overlay');
  const box     = document.getElementById('event-box');
  const cardEl  = document.getElementById('event-card-el');
  const names   = document.getElementById('event-names');
  const msgEl   = document.getElementById('event-msg');
  const symEl   = document.getElementById('event-sym');

  // Clear any running timer
  if (eventOverlayTimer) { clearTimeout(eventOverlayTimer); eventOverlayTimer = null; }

  // Phase 1: question
  cardEl.innerHTML = buildCardFaceHTML(card, 'lg');
  names.textContent = `${askerLabel} → ${targetLabel}`;
  msgEl.textContent = `asked for the ${card}`;
  symEl.textContent = '?';
  box.className = '';
  overlay.classList.remove('hidden');
  overlay.classList.add('show');

  // Phase 2: result after 1.4s
  eventOverlayTimer = setTimeout(() => {
    if (hadCard) {
      box.classList.add('got-it');
      msgEl.textContent = `✓ ${targetLabel} had the ${card}!`;
      symEl.textContent = '!';
      // Flip animation on target's stack
      const stackEl = document.getElementById(`stack-${targetId}`);
      if (stackEl) {
        stackEl.classList.remove('card-flip-anim');
        void stackEl.offsetWidth; // reflow to restart
        stackEl.classList.add('card-flip-anim');
      }
    } else {
      box.classList.add('no-card');
      msgEl.textContent = `✗ ${targetLabel} doesn't have it`;
      symEl.textContent = '✕';
    }

    // Phase 3: dismiss after 2.2s
    eventOverlayTimer = setTimeout(() => {
      overlay.classList.add('hidden');
      overlay.classList.remove('show');
      box.className = '';
      eventOverlayTimer = null;
    }, 2200);
  }, 1400);
}

// ===================== CARD ACTIONS =====================
function selectCard(card) {
  state.selectedCard = state.selectedCard === card ? null : card;
  if (!state.selectedCard) state.selectedTarget = null;
  renderHand(); renderOvalPlayers(); renderActionStrip();
}

function selectTarget(playerId) {
  const room = state.room;
  const me = room?.players.find(p => p.id === socket.id);
  const target = room?.players.find(p => p.id === playerId);
  if (!target || !me || target.team === me.team) return;
  state.selectedTarget = state.selectedTarget === playerId ? null : playerId;
  renderOvalPlayers(); renderActionStrip();
}

function clearAsk() {
  state.selectedCard = null; state.selectedTarget = null;
  renderHand(); renderOvalPlayers(); renderActionStrip();
}

function submitAsk() {
  if (!state.selectedCard || !state.selectedTarget) return;
  socket.emit('ask_card', { targetId: state.selectedTarget, card: state.selectedCard }, (res) => {
    if (!res.ok) { alert(res.error || 'Cannot ask'); return; }
    // Reset ask state after asking
    state.askSuit = null;
    clearAsk();
    // Re-render ask panel for the new turn state
    renderRightPanel();
  });
}

function passTurn(toPlayerId) {
  socket.emit('pass_turn', { toPlayerId }, (res) => { if (!res.ok) alert(res.error || 'Cannot pass'); });
}

// When it becomes my turn, auto-switch right panel to ASK mode
function handleTurnChange(room) {
  if (room.currentTurn === socket.id) {
    state.askSuit = null;
    state.rightPanelMode = 'ask';
  }
}

// ===================== SETTINGS =====================
function renderSettings() {
  const room = state.room; if (!room) return;
  const isAdmin = room.adminId === socket.id;
  const s = room.settings;
  document.getElementById('settings-admin-note').classList.toggle('hidden', isAdmin);
  document.getElementById('settings-view').innerHTML = `
    <div class="toggle-row"><div class="toggle-label">Players<span class="sub">${s.numPlayers} players</span></div></div>
    <div class="toggle-row">
      <div class="toggle-label">Turn time limit<span class="sub">${s.timerEnabled ? s.timerSeconds+'s per turn' : 'Off'}</span></div>
      ${isAdmin&&room.phase==='lobby'?`<label class="toggle"><input type="checkbox" ${s.timerEnabled?'checked':''} onchange="updateSetting('timerEnabled',this.checked)"><span class="toggle-slider"></span></label>`:''}
    </div>
    <div class="toggle-row">
      <div class="toggle-label">Chat<span class="sub">${s.chatEnabled?'Enabled':'Disabled'}</span></div>
      ${isAdmin?`<label class="toggle"><input type="checkbox" ${s.chatEnabled?'checked':''} onchange="updateSetting('chatEnabled',this.checked)"><span class="toggle-slider"></span></label>`:''}
    </div>
    <div class="toggle-row">
      <div class="toggle-label">Team selection<span class="sub">${s.teamSelection?'Players choose':'Auto-assigned'}</span></div>
      ${isAdmin&&room.phase==='lobby'?`<label class="toggle"><input type="checkbox" ${s.teamSelection?'checked':''} onchange="updateSetting('teamSelection',this.checked)"><span class="toggle-slider"></span></label>`:''}
    </div>
    <div class="toggle-row">
      <div class="toggle-label">Game code<span class="sub" style="font-family:monospace;font-size:18px;letter-spacing:5px;color:#3a6bc4">${room.code}</span></div>
    </div>`;
}
function updateSetting(key, value) { socket.emit('update_settings', { [key]: value }, () => {}); }

// ===================== RENDER ALL =====================
function renderAll() {
  updateNav();
  const room = state.room; if (!room) return;
  handleTurnChange(room);
  if (!document.getElementById('tab-lobby').classList.contains('hidden')) renderLobby();
  if (!document.getElementById('tab-game').classList.contains('hidden'))  renderGameTab();
  if (!document.getElementById('tab-settings').classList.contains('hidden')) renderSettings();
}

// ===================== CHAT =====================
function sendChat() {
  const inp = document.getElementById('chat-input');
  const text = inp.value.trim(); if (!text) return;
  socket.emit('chat_message', { text }); inp.value = '';
}
function appendChat(msg) {
  const box = document.getElementById('chat-box');
  const d = document.createElement('div'); d.className = 'chat-msg';
  d.innerHTML = `
    <div class="chat-icon">${isImg(msg.icon) ? `<img src="${msg.icon}" style="width:28px;height:28px;border-radius:50%;object-fit:cover">` : msg.icon}</div>
    <div class="chat-bubble"><div class="chat-sender">${msg.name}</div>${escHtml(msg.text)}</div>`;
  box.appendChild(d); box.scrollTop = box.scrollHeight;
}

// ===================== EXIT =====================
function exitGame() {
  if (!confirm('Are you sure you want to exit the game?')) return;
  socket.emit('exit_game', {}, () => { goHome(); });
}
function goHome() {
  localStorage.removeItem('fish_session');
  if (eventOverlayTimer) { clearTimeout(eventOverlayTimer); eventOverlayTimer = null; }
  state.room = null; state.myHand = []; state.inCreateFlow = false;
  state.selectedCard = null; state.selectedTarget = null;
  state.panelCards = []; state.askSuit = null; state.rightPanelMode = 'ask';
  document.getElementById('exit-modal').classList.add('hidden');
  document.getElementById('event-overlay').classList.add('hidden');
  document.getElementById('nav').classList.add('hidden');
  showPage('landing');
}

// ===================== UTILS =====================
function isImg(icon) { return icon && icon.startsWith('data:'); }
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function playerInline(p) { return `${isImg(p.icon) ? '' : p.icon} ${p.name}`; }
