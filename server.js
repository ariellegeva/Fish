const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- Game State ---
const rooms = {}; // code -> room

const HALF_SUITS = [
  { id: 'low_hearts',   name: 'Low ♥',   cards: ['2♥','3♥','4♥','5♥','6♥','7♥'] },
  { id: 'high_hearts',  name: 'High ♥',  cards: ['9♥','10♥','J♥','Q♥','K♥','A♥'] },
  { id: 'low_clubs',    name: 'Low ♣',   cards: ['2♣','3♣','4♣','5♣','6♣','7♣'] },
  { id: 'high_clubs',   name: 'High ♣',  cards: ['9♣','10♣','J♣','Q♣','K♣','A♣'] },
  { id: 'low_diamonds', name: 'Low ♦',   cards: ['2♦','3♦','4♦','5♦','6♦','7♦'] },
  { id: 'high_diamonds',name: 'High ♦',  cards: ['9♦','10♦','J♦','Q♦','K♦','A♦'] },
  { id: 'low_spades',   name: 'Low ♠',   cards: ['2♠','3♠','4♠','5♠','6♠','7♠'] },
  { id: 'high_spades',  name: 'High ♠',  cards: ['9♠','10♠','J♠','Q♠','K♠','A♠'] },
];

function cardToHalfSuit(card) {
  return HALF_SUITS.find(hs => hs.cards.includes(card));
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (rooms[code]);
  return code;
}

function buildDeck() {
  return HALF_SUITS.flatMap(hs => hs.cards);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

// Distribution per player count
const DIST = {
  6:  { team1: [8,8,8], team2: [8,8,8] },
  7:  { team1: [8,8,8], team2: [6,6,6,6] },
  8:  { team1: [6,6,6,6], team2: [6,6,6,6] },
  9:  { team1: [5,5,5,5,4], team2: [6,6,6,6] },
  10: { team1: [5,5,5,5,4], team2: [5,5,5,5,4] },
  5:  { team1: [8,8,8], team2: [12,12] },
  2:  { team1: [24], team2: [24] },
};

function dealCards(room) {
  const deck = shuffle(buildDeck());
  const dist = DIST[room.settings.numPlayers];
  const team1Players = room.players.filter(p => p.team === 1);
  const team2Players = room.players.filter(p => p.team === 2);

  let idx = 0;
  const t1counts = shuffle([...dist.team1]);
  const t2counts = shuffle([...dist.team2]);

  team1Players.forEach((p, i) => {
    p.hand = deck.slice(idx, idx + t1counts[i]);
    idx += t1counts[i];
  });
  team2Players.forEach((p, i) => {
    p.hand = deck.slice(idx, idx + t2counts[i]);
    idx += t2counts[i];
  });
}

function publicRoom(room) {
  return {
    code: room.code,
    settings: room.settings,
    phase: room.phase,
    players: room.players.map(p => ({
      id: p.id, name: p.name, icon: p.icon,
      team: p.team, cardCount: p.hand ? p.hand.length : 0,
      connected: p.connected,
    })),
    adminId: room.adminId,
    currentTurn: room.currentTurn,
    scores: room.scores,
    claimedSuits: room.claimedSuits,
    log: room.log,
  };
}

function nextTurn(room, toPlayerId) {
  if (toPlayerId) {
    room.currentTurn = toPlayerId;
  } else {
    const activePlayers = room.players.filter(p => p.connected);
    const idx = activePlayers.findIndex(p => p.id === room.currentTurn);
    room.currentTurn = activePlayers[(idx + 1) % activePlayers.length].id;
  }
}

function addLog(room, msg) {
  room.log.push({ msg, ts: Date.now() });
  if (room.log.length > 200) room.log.shift();
}

function checkGameEnd(room) {
  const total = HALF_SUITS.length;
  const claimed = room.claimedSuits.length;
  if (claimed < total) return false;
  const t1 = room.scores.team1;
  const t2 = room.scores.team2;
  addLog(room, `Game over! Team 1: ${t1} suits, Team 2: ${t2} suits. ${t1 > t2 ? 'Team 1 wins!' : t2 > t1 ? 'Team 2 wins!' : 'It\'s a tie!'}`);
  room.phase = 'ended';
  return true;
}

io.on('connection', (socket) => {

  // --- Admin creates room ---
  socket.on('create_room', ({ name, icon, settings }, cb) => {
    const code = generateCode();
    const player = { id: socket.id, name, icon, team: 1, hand: [], connected: true };
    rooms[code] = {
      code,
      adminId: socket.id,
      settings: {
        numPlayers: settings.numPlayers || 6,
        timerEnabled: settings.timerEnabled || false,
        timerSeconds: settings.timerSeconds || 60,
        chatEnabled: settings.chatEnabled !== false,
        teamSelection: settings.teamSelection || false,
      },
      phase: 'lobby',
      players: [player],
      currentTurn: null,
      scores: { team1: 0, team2: 0 },
      claimedSuits: [],
      log: [],
    };
    socket.join(code);
    socket.data = { code, playerId: socket.id };
    cb({ ok: true, code, room: publicRoom(rooms[code]), myHand: [] });
  });

  // --- Player joins room ---
  socket.on('join_room', ({ code, name, icon, team }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: 'Room not found' });
    if (room.phase !== 'lobby') {
      // Rejoin: find existing player
      const existing = room.players.find(p => p.name === name);
      if (existing) {
        existing.id = socket.id;
        existing.connected = true;
        socket.join(code);
        socket.data = { code, playerId: socket.id };
        io.to(code).emit('room_update', publicRoom(room));
        return cb({ ok: true, room: publicRoom(room), myHand: existing.hand || [] });
      }
      return cb({ ok: false, error: 'Game already started' });
    }
    if (room.players.length >= room.settings.numPlayers) return cb({ ok: false, error: 'Room full' });
    if (room.players.find(p => p.name.toLowerCase() === name.toLowerCase()))
      return cb({ ok: false, error: 'That name is already taken — choose another.' });

    let assignedTeam = team;
    if (!room.settings.teamSelection) {
      // Auto-assign alternating
      const t1 = room.players.filter(p=>p.team===1).length;
      const t2 = room.players.filter(p=>p.team===2).length;
      assignedTeam = t1 <= t2 ? 1 : 2;
    }

    const player = { id: socket.id, name, icon, team: assignedTeam, hand: [], connected: true };
    room.players.push(player);
    socket.join(code);
    socket.data = { code, playerId: socket.id };
    addLog(room, `${name} joined the game.`);
    io.to(code).emit('room_update', publicRoom(room));
    cb({ ok: true, room: publicRoom(room), myHand: [] });
  });

  // --- Admin starts game ---
  socket.on('start_game', (_, cb) => {
    const { code } = socket.data || {};
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: 'No room' });
    if (room.adminId !== socket.id) return cb && cb({ ok: false, error: 'Not admin' });

    dealCards(room);
    room.phase = 'playing';
    // First player on team 1 starts
    const starter = room.players.find(p => p.team === 1);
    room.currentTurn = starter.id;
    addLog(room, 'Game started! ' + starter.name + ' goes first.');

    // Send each player their hand privately
    room.players.forEach(p => {
      io.to(p.id).emit('your_hand', p.hand);
    });
    io.to(code).emit('room_update', publicRoom(room));
    cb && cb({ ok: true });
  });

  // --- Ask for a card ---
  socket.on('ask_card', ({ targetId, card }, cb) => {
    const { code } = socket.data || {};
    const room = rooms[code];
    if (!room || room.phase !== 'playing') return cb({ ok: false, error: 'Not in game' });
    if (room.currentTurn !== socket.id) return cb({ ok: false, error: 'Not your turn' });

    const asker = room.players.find(p => p.id === socket.id);
    const target = room.players.find(p => p.id === targetId);
    if (!asker || !target) return cb({ ok: false, error: 'Player not found' });
    if (asker.team === target.team) return cb({ ok: false, error: 'Can only ask opposite team' });

    const hs = cardToHalfSuit(card);
    if (!hs) return cb({ ok: false, error: 'Invalid card' });
    if (!asker.hand.includes(card) && !hs.cards.some(c => asker.hand.includes(c)))
      return cb({ ok: false, error: 'You must hold a card in that half-suit' });
    if (asker.hand.includes(card)) return cb({ ok: false, error: "You can't ask for a card you hold" });

    const hasCard = target.hand.includes(card);
    if (hasCard) {
      target.hand = target.hand.filter(c => c !== card);
      asker.hand.push(card);
      addLog(room, `${asker.name} asked ${target.name} for ${card} — YES! ${asker.name} goes again.`);
      io.to(asker.id).emit('your_hand', asker.hand);
      io.to(target.id).emit('your_hand', target.hand);
      // asker goes again
    } else {
      addLog(room, `${asker.name} asked ${target.name} for ${card} — No. ${target.name}'s turn.`);
      nextTurn(room, targetId);
    }

    io.to(code).emit('room_update', publicRoom(room));
    cb({ ok: true, hadCard: hasCard });
  });

  // --- Pass turn (when out of cards) ---
  socket.on('pass_turn', ({ toPlayerId }, cb) => {
    const { code } = socket.data || {};
    const room = rooms[code];
    if (!room || room.currentTurn !== socket.id) return cb({ ok: false });
    const asker = room.players.find(p => p.id === socket.id);
    const to = room.players.find(p => p.id === toPlayerId);
    if (!to || to.team !== asker.team) return cb({ ok: false, error: 'Must pass to teammate' });
    if (asker.hand.length > 0) return cb({ ok: false, error: 'Can only pass when out of cards' });
    addLog(room, `${asker.name} passes their turn to ${to.name}.`);
    nextTurn(room, toPlayerId);
    io.to(code).emit('room_update', publicRoom(room));
    cb({ ok: true });
  });

  // --- Award suit (admin manually records claim result after phone call) ---
  // winner: 1 | 2 | 0 (middle)
  socket.on('award_suit', ({ halfSuitId, winner }, cb) => {
    const { code } = socket.data || {};
    const room = rooms[code];
    if (!room || room.phase !== 'playing') return cb({ ok: false, error: 'Not in game' });
    if (room.adminId !== socket.id) return cb({ ok: false, error: 'Only admin can award suits' });

    const hs = HALF_SUITS.find(h => h.id === halfSuitId);
    if (!hs) return cb({ ok: false, error: 'Invalid suit' });
    if (room.claimedSuits.find(s => s.id === halfSuitId))
      return cb({ ok: false, error: 'Already awarded' });

    // Remove all cards in this half-suit from all hands
    room.players.forEach(p => {
      p.hand = p.hand.filter(c => !hs.cards.includes(c));
    });
    room.players.forEach(p => io.to(p.id).emit('your_hand', p.hand));

    room.claimedSuits.push({ id: hs.id, name: hs.name, winner });
    if (winner === 1 || winner === 2) {
      room.scores[`team${winner}`]++;
      addLog(room, `${hs.name} awarded to Team ${winner}.`);
    } else {
      addLog(room, `${hs.name} goes to the middle (0 points).`);
    }

    checkGameEnd(room);
    io.to(code).emit('room_update', publicRoom(room));
    cb({ ok: true });
  });

  // --- Chat ---
  socket.on('chat_message', ({ text }) => {
    const { code } = socket.data || {};
    const room = rooms[code];
    if (!room || !room.settings.chatEnabled) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    io.to(code).emit('chat_message', { name: player.name, icon: player.icon, text, ts: Date.now() });
  });

  // --- Exit game ---
  socket.on('exit_game', (_, cb) => {
    const { code } = socket.data || {};
    const room = rooms[code];
    if (!room) return cb && cb({ ok: true });
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      addLog(room, `${player.name} exited the game.`);
      io.to(code).emit('player_exited', { name: player.name, icon: player.icon });
      room.players = room.players.filter(p => p.id !== socket.id);
      io.to(code).emit('room_update', publicRoom(room));
    }
    socket.leave(code);
    socket.data = {};
    cb && cb({ ok: true });
  });

  // --- Update settings (admin only) ---
  socket.on('update_settings', (newSettings, cb) => {
    const { code } = socket.data || {};
    const room = rooms[code];
    if (!room || room.adminId !== socket.id) return cb && cb({ ok: false });
    room.settings = { ...room.settings, ...newSettings };
    io.to(code).emit('room_update', publicRoom(room));
    cb && cb({ ok: true });
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    const { code } = socket.data || {};
    if (!code) return;
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.connected = false;
      addLog(room, `${player.name} disconnected.`);
      io.to(code).emit('room_update', publicRoom(room));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Fish server running on http://localhost:${PORT}`));
