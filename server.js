// server.js
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

// ==== DB bootstrap (env-configurable path) ====
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'game.db');

function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function initDbAt(filePath) {
  ensureDirExists(filePath);
  const db = new Database(filePath);
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  db.close();
  console.log('Database initialized at', filePath);
}
if (!fs.existsSync(DB_FILE)) {
  console.log('DB not found, initializing at', DB_FILE);
  initDbAt(DB_FILE);
}
const db = new Database(DB_FILE);

// ==== Prepared statements ====
const q = {
  subjectsAll: db.prepare('SELECT id, name FROM subjects ORDER BY name'),
  itemsBySubject: db.prepare('SELECT id, value FROM items WHERE subject_id = ? ORDER BY value'),
  subjectByName: db.prepare('SELECT id FROM subjects WHERE name = ?'),
  subjectInsert: db.prepare('INSERT OR IGNORE INTO subjects (name) VALUES (?)'),
  itemInsert: db.prepare('INSERT OR IGNORE INTO items (subject_id, value) VALUES (?, ?)'),
  itemDelete: db.prepare('DELETE FROM items WHERE id = ?'),
  addScore: db.prepare('INSERT INTO scores (nickname, points) VALUES (?, ?) ON CONFLICT(nickname) DO UPDATE SET points = points + excluded.points'),
  topScores: db.prepare('SELECT nickname, points FROM scores ORDER BY points DESC LIMIT 50'),
  scoresClear: db.prepare('DELETE FROM scores')
};

// ==== In-memory room state ====
/**
 room = {
   code, hostId,
   players: { socketId: { id, name, score, inRoundRole } },
   order: [socketId,...],
   phase: 'LOBBY'|'REVEAL'|'QA'|'VOTE'|'GUESS'|'RESULT',
   subjectId, subjectName, secretItem,
   outSocketId,
   asked: Set<socketId>,
   answered: Set<socketId>,
   votes: { voterId: targetId },
   roundNumber,
   guessOptions: string[]|null,
   outGuess: { choice, correct }|null
 }
*/
const rooms = new Map();

const makeRoomCode = () => nanoid(6).toUpperCase();
const randomChoice = arr => arr[Math.floor(Math.random() * arr.length)];
const shuffle = a => { for (let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };

function ensureRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code, hostId: null,
      players: {}, order: [],
      phase: 'LOBBY',
      subjectId: null, subjectName: '', secretItem: '',
      outSocketId: null,
      asked: new Set(), answered: new Set(),
      votes: {}, roundNumber: 0,
      guessOptions: null, outGuess: null
    });
  }
  return rooms.get(code);
}
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
const broadcastRoom = (io, room) => io.to(room.code).emit('room:update', roomPublicState(room));
function qaCoverageMet(room) {
  const ids = Object.keys(room.players);
  if (ids.length < 2) return false;
  // Each player must have asked at least once OR answered at least once
  return ids.every(id => room.asked.has(id) || room.answered.has(id));
}

// ==== HTTP + APIs ====
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Admin APIs
app.get('/api/subjects', (req, res) => {
  const subjects = q.subjectsAll.all();
  res.json(subjects.map(s => ({ ...s, items: q.itemsBySubject.all(s.id) })));
});
app.post('/api/subjects', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Missing name' });
  q.subjectInsert.run(String(name).trim());
  res.json({ ok: true });
});
app.post('/api/items', (req, res) => {
  const { subjectName, value } = req.body || {};
  if (!subjectName || !value) return res.status(400).json({ error: 'Missing fields' });
  const subj = q.subjectByName.get(String(subjectName));
  if (!subj) return res.status(400).json({ error: 'Unknown subject' });
  q.itemInsert.run(subj.id, String(value).trim());
  res.json({ ok: true });
});
app.delete('/api/items/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
  q.itemDelete.run(id);
  res.json({ ok: true });
});
app.get('/api/scores', (req, res) => res.json(q.topScores.all()));
app.delete('/api/scores', (req, res) => { q.scoresClear.run(); res.json({ ok: true }); });

const server = http.createServer(app);
const io = new SocketIOServer(server);

// ==== Socket.IO ====
io.on('connection', (socket) => {
  let joinedCode = null;

  // --- Room creation: creator is ALWAYS host & auto-joined as a player
  socket.on('room:create', ({ nickname }) => {
    const code = makeRoomCode();
    const room = ensureRoom(code);
    room.hostId = socket.id;

    // Auto-join creator
    socket.join(code);
    joinedCode = code;
    const name = String(nickname || 'Player').trim();
    room.players[socket.id] = { id: socket.id, name, score: 0, inRoundRole: null };
    room.order.push(socket.id);

    // Tell creator their code; also broadcast state so lobby shows them as host
    socket.emit('room:host', { code });
    broadcastRoom(io, room);
  });

  // --- Join
  socket.on('room:join', ({ code, nickname }) => {
    code = String(code || '').toUpperCase().trim();
    const name = String(nickname || 'Player').trim();
    if (!code) return socket.emit('game:error', { message: 'Missing room code' });

    const room = ensureRoom(code);
    socket.join(code);
    joinedCode = code;

    room.players[socket.id] = { id: socket.id, name, score: 0, inRoundRole: null };
    room.order.push(socket.id);

    // DO NOT steal host from existing host; only set if null (brand new room without creator)
    if (!room.hostId) room.hostId = socket.id;

    broadcastRoom(io, room);
  });

  // --- Leave
  socket.on('room:leave', () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;

    delete room.players[socket.id];
    room.order = room.order.filter(id => id !== socket.id);
    socket.leave(joinedCode);

    // Reassign host ONLY if the host disconnected
    if (room.hostId === socket.id) room.hostId = room.order[0] || null;

    broadcastRoom(io, room);
  });

  // --- Game flow
  socket.on('game:startRound', ({ code, subjectName }) => {
    const room = rooms.get(code);
    if (!room) return;

    // Only host can start rounds
    if (socket.id !== room.hostId) return socket.emit('game:error', { message: 'Only the room admin can start a round.' });

    const subj = q.subjectByName.get(subjectName);
    if (!subj) return socket.emit('game:error', { message: 'Unknown subject' });
    const items = q.itemsBySubject.all(subj.id);
    if (!items.length) return socket.emit('game:error', { message: 'No items for this subject' });

    const playerIds = Object.keys(room.players);
    if (playerIds.length < 2) {
      io.to(room.code).emit('game:error', { message: 'Need at least 2 players to start.' });
      return;
    }

    const secret = randomChoice(items).value;
    room.subjectId = subj.id;
    room.subjectName = subjectName;
    room.secretItem = secret;
    room.phase = 'REVEAL';
    room.roundNumber += 1;

    // choose OUT
    const outId = randomChoice(playerIds);
    room.outSocketId = outId;
    for (const pid of playerIds) {
      room.players[pid].inRoundRole = (pid === outId) ? 'OUT' : 'IN';
    }

    // reset trackers
    room.asked.clear();
    room.answered.clear();
    room.votes = {};
    room.guessOptions = null;
    room.outGuess = null;

    // private reveals
    for (const pid of playerIds) {
      const isIn = pid !== outId;
      io.to(pid).emit('game:reveal', {
        role: isIn ? 'IN' : 'OUT',
        subjectName: room.subjectName,
        secret: isIn ? secret : null
      });
    }
    broadcastRoom(io, room);
  });

  socket.on('game:toQA', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    room.phase = 'QA';
    broadcastRoom(io, room);
  });

  // Robust random prompt (never self, prioritizes unmet coverage)
  socket.on('game:randomPrompt', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'QA') return;
    const players = Object.values(room.players);
    if (players.length < 2) return;

    // Prefer an asker who hasn't asked yet; else any
    const askerPool = players.filter(p => !room.asked.has(p.id));
    const asker = randomChoice(askerPool.length ? askerPool : players);

    // Prefer a target who hasn't answered yet (and is not the asker); else any excluding asker
    const notAsker = players.filter(p => p.id !== asker.id);
    const targetPool = notAsker.filter(p => !room.answered.has(p.id));
    const target = randomChoice(targetPool.length ? targetPool : notAsker);

    room.asked.add(asker.id);
    room.answered.add(target.id);

    io.to(room.code).emit('game:prompt', { askerId: asker.id, targetId: target.id });
    io.to(room.code).emit('game:coverage', { met: qaCoverageMet(room) });
  });

  socket.on('game:toVote', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.hostId) return;

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

  socket.on('game:announceOut', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'VOTE') return;
    if (socket.id !== room.hostId) return;
    const outId = room.outSocketId;
    if (!outId) return;

    const pool = q.itemsBySubject.all(room.subjectId)
      .map(i => i.value)
      .filter(v => v !== room.secretItem);
    const distractors = shuffle(pool).slice(0, Math.min(3, pool.length));
    const options = shuffle([room.secretItem, ...distractors]);

    room.guessOptions = options;
    room.phase = 'GUESS';

    io.to(room.code).emit('game:guess:start', { outId, subjectName: room.subjectName });
    io.to(outId).emit('game:guess:options', { options });
    broadcastRoom(io, room);
  });

  socket.on('game:guess:answer', ({ code, choice }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'GUESS') return;
    if (socket.id !== room.outSocketId) return;
    if (!room.guessOptions || !room.guessOptions.includes(choice)) return;

    const correct = choice === room.secretItem;
    room.outGuess = { choice, correct };

    const outId = room.outSocketId;
    const voters = Object.entries(room.votes);
    const correctVoters = voters.filter(([v, t]) => t === outId).map(([v]) => v);
    const anyCorrect = correctVoters.length > 0;

    for (const pid of Object.keys(room.players)) {
      const p = room.players[pid];
      let delta = 0;
      if (pid === outId) {
        if (!anyCorrect) delta += 3; // escaped detection
        if (correct) delta += 2;     // guessed secret
      } else {
        if (correctVoters.includes(pid)) delta += 2;
      }
      p.score += delta;
      if (delta) q.addScore.run(p.name, delta);
    }

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
