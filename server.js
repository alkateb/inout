import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';
import url from 'url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === DB ===
const DB_PATH = path.join(__dirname, 'game.db');

function initDb() {
  const db = new Database(DB_PATH);
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  db.close();
}

if (process.argv.includes('--init-db')) {
  initDb();
  console.log('DB initialized.');
  process.exit(0);
}

const db = new Database(DB_PATH);

const q = {
  subjectsAll: db.prepare('SELECT id, name FROM subjects ORDER BY name'),
  itemsBySubject: db.prepare('SELECT id, value FROM items WHERE subject_id = ? ORDER BY value'),
  subjectByName: db.prepare('SELECT id FROM subjects WHERE name = ?'),
  subjectInsert: db.prepare('INSERT OR IGNORE INTO subjects (name) VALUES (?)'),
  itemInsert: db.prepare('INSERT OR IGNORE INTO items (subject_id, value) VALUES (?, ?)'),
  itemDelete: db.prepare('DELETE FROM items WHERE id = ?'),
  addScore: db.prepare('INSERT INTO scores (nickname, points) VALUES (?, ?) ON CONFLICT(nickname) DO UPDATE SET points = points + excluded.points'),
  topScores: db.prepare('SELECT nickname, points FROM scores ORDER BY points DESC LIMIT 50')
};

// === In-memory game state ===
/**
 rooms[code] = {
   code,
   hostId,
   players: { socketId: { id, name, score, inRoundRole: 'IN'|'OUT'|null } },
   order: [socketId,...],
   phase: 'LOBBY'|'REVEAL'|'QA'|'VOTE'|'GUESS'|'RESULT',
   subjectId,
   subjectName,
   secretItem,
   outSocketId,
   asked: Set<socketId>,
   answered: Set<socketId>,
   votes: { voterSocketId: targetSocketId },
   roundNumber,
   guessOptions: string[] | null,
   outGuess: { choice: string, correct: boolean } | null
 }
*/
const rooms = new Map();

// helpers
function makeRoomCode() { return nanoid(6).toUpperCase(); }
function roomPublicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, score: p.score })),
    hostId: room.hostId,
    subjectName: room.subjectName,
    roundNumber: room.roundNumber
  };
}
function broadcastRoom(io, room) { io.to(room.code).emit('room:update', roomPublicState(room)); }
function randomChoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }

function ensureRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      hostId: null,
      players: {},
      order: [],
      phase: 'LOBBY',
      subjectId: null,
      subjectName: '',
      secretItem: '',
      outSocketId: null,
      asked: new Set(),
      answered: new Set(),
      votes: {},
      roundNumber: 0,
      guessOptions: null,
      outGuess: null
    });
  }
  return rooms.get(code);
}

function qaCoverageMet(room) {
  const ids = Object.keys(room.players);
  if (ids.length < 2) return false;
  // each player must have asked at least once OR answered at least once
  return ids.every(id => room.asked.has(id) || room.answered.has(id));
}

// === HTTP + Socket.IO ===
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Admin APIs
app.get('/api/subjects', (req, res) => {
  const subjects = q.subjectsAll.all();
  const withItems = subjects.map(s => ({ ...s, items: q.itemsBySubject.all(s.id) }));
  res.json(withItems);
});
app.post('/api/subjects', (req, res) => {
  const { name } = req.body;
  q.subjectInsert.run(name.trim());
  res.json({ ok: true });
});
app.post('/api/items', (req, res) => {
  const { subjectName, value } = req.body;
  const subj = q.subjectByName.get(subjectName);
  if (!subj) return res.status(400).json({ error: 'Unknown subject' });
  q.itemInsert.run(subj.id, value.trim());
  res.json({ ok: true });
});
app.delete('/api/items/:id', (req, res) => {
  q.itemDelete.run(Number(req.params.id));
  res.json({ ok: true });
});
app.get('/api/scores', (req, res) => {
  res.json(q.topScores.all());
});

const server = http.createServer(app);
const io = new SocketIOServer(server);

io.on('connection', (socket) => {
  let joinedCode = null;

  socket.on('room:create', ({ nickname }) => {
    const code = makeRoomCode();
    const room = ensureRoom(code);
    room.hostId = socket.id;
    io.emit('room:created', { code });
    socket.emit('room:host', { code });
  });

  socket.on('room:join', ({ code, nickname }) => {
    code = code.toUpperCase();
    const room = ensureRoom(code);
    socket.join(code);
    joinedCode = code;
    room.players[socket.id] = { id: socket.id, name: nickname.trim(), score: 0, inRoundRole: null };
    room.order.push(socket.id);
    if (!room.hostId) room.hostId = socket.id; // first joiner becomes host
    broadcastRoom(io, room);
  });

  socket.on('room:leave', () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    delete room.players[socket.id];
    room.order = room.order.filter(id => id !== socket.id);
    socket.leave(joinedCode);
    if (room.hostId === socket.id) room.hostId = room.order[0] || null;
    broadcastRoom(io, room);
  });

  // === Round flow ===
  socket.on('game:startRound', ({ code, subjectName }) => {
    const room = rooms.get(code);
    if (!room) return;
    const subj = q.subjectByName.get(subjectName);
    if (!subj) return;
    const items = q.itemsBySubject.all(subj.id);
    if (!items.length) return;

    const secret = randomChoice(items).value;
    room.subjectId = subj.id;
    room.subjectName = subjectName;
    room.secretItem = secret;
    room.phase = 'REVEAL';
    room.roundNumber += 1;

    // choose one OUT
    const playerIds = Object.keys(room.players);
    if (playerIds.length < 2) {
      io.to(room.code).emit('game:error', { message: 'Need at least 2 players to start.' });
      return;
    }
    const outId = randomChoice(playerIds);
    room.outSocketId = outId;

    // assign roles
    for (const pid of playerIds) {
      room.players[pid].inRoundRole = (pid === outId) ? 'OUT' : 'IN';
    }
    room.asked.clear();
    room.answered.clear();
    room.votes = {};
    room.guessOptions = null;
    room.outGuess = null;

    // DM reveal
    for (const pid of playerIds) {
      const isIn = pid !== outId;
      io.to(pid).emit('game:reveal', {
        role: isIn ? 'IN' : 'OUT',
        subjectName: subjectName,
        secret: isIn ? secret : null
      });
    }
    broadcastRoom(io, room);
  });

  socket.on('game:toQA', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    room.phase = 'QA';
    broadcastRoom(io, room);
  });

  socket.on('game:randomPrompt', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'QA') return;
    const players = Object.values(room.players);
    if (players.length < 2) return;

    const asker = randomChoice(players);
    let target = randomChoice(players);
    let guard = 0;
    while ((target.id === asker.id || room.answered.has(target.id)) && guard++ < 20) {
      target = randomChoice(players);
    }
    room.asked.add(asker.id);
    room.answered.add(target.id);
    io.to(room.code).emit('game:prompt', { askerId: asker.id, targetId: target.id });

    // Also broadcast coverage hint
    io.to(room.code).emit('game:coverage', { met: qaCoverageMet(room) });
  });

  socket.on('game:toVote', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (!qaCoverageMet(room)) {
      io.to(socket.id).emit('game:error', { message: 'Q&A coverage not met yet: each player must have asked or answered at least once.' });
      return;
    }
    room.phase = 'VOTE';
    room.votes = {};
    broadcastRoom(io, room);
  });

  socket.on('game:vote', ({ code, targetId }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'VOTE') return;
    if (!room.players[targetId]) return;
    room.votes[socket.id] = targetId;
    io.to(room.code).emit('game:votes:update', { count: Object.keys(room.votes).length });
  });

  // Announce OUT and start GUESS phase for OUT to pick the secret from options
  socket.on('game:announceOut', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'VOTE') return;
    const outId = room.outSocketId;
    if (!outId) return;

    // Build guess options: secret + 3 distractors from same subject
    const all = q.itemsBySubject.all(room.subjectId).map(i => i.value).filter(v => v !== room.secretItem);
    const distractors = shuffle(all).slice(0, Math.min(3, all.length));
    const options = shuffle([room.secretItem, ...distractors]);
    room.guessOptions = options;

    // Move to GUESS phase
    room.phase = 'GUESS';
    io.to(room.code).emit('game:guess:start', { outId, subjectName: room.subjectName });

    // Send options only to OUT
    io.to(outId).emit('game:guess:options', { options });
    broadcastRoom(io, room);
  });

  socket.on('game:guess:answer', ({ code, choice }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'GUESS') return;
    if (socket.id !== room.outSocketId) return; // only OUT can answer
    if (!room.guessOptions || !room.guessOptions.includes(choice)) return;

    const correct = choice === room.secretItem;
    room.outGuess = { choice, correct };

    // Finalize scoring now
    const outId = room.outSocketId;

    // voting results
    const voters = Object.entries(room.votes); // [voterId, targetId]
    const correctVoters = voters.filter(([v, t]) => t === outId).map(([v]) => v);
    const anyCorrect = correctVoters.length > 0;

    // scoring
    for (const pid of Object.keys(room.players)) {
      const p = room.players[pid];
      let delta = 0;
      if (pid === outId) {
        // baseline: +3 if nobody guessed you in voting
        delta += anyCorrect ? 0 : 3;
        // bonus: +2 if guessed secret correctly
        if (correct) delta += 2;
      } else {
        // voters +2 if they picked the OUT
        if (correctVoters.includes(pid)) delta += 2;
      }
      p.score += delta;
      if (delta) q.addScore.run(p.name, delta);
    }

    // Move to RESULT & broadcast
    room.phase = 'RESULT';
    io.to(room.code).emit('game:result', {
      outId,
      secret: room.secretItem,
      outGuess: room.outGuess,
      votes: room.votes
    });
    broadcastRoom(io, room);
  });

  socket.on('disconnect', () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    delete room.players[socket.id];
    room.order = room.order.filter(id => id !== socket.id);
    if (room.hostId === socket.id) room.hostId = room.order[0] || null;
    broadcastRoom(io, room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server listening on :' + PORT));
