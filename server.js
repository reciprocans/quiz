'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = String(process.env.ADMIN_KEY || '');
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const FILE = path.join(DATA_DIR, 'state.json');
if (!ADMIN_KEY || ADMIN_KEY === '1234') console.warn('WARNUNG: Bitte ADMIN_KEY als sichere Umgebungsvariable festlegen!');
fs.mkdirSync(DATA_DIR, { recursive: true });

const starterQuestions = [
  { id: crypto.randomUUID(), type: 'choice', text: 'Welcher Planet ist der Sonne am nächsten?', options: ['Venus','Merkur','Mars','Erde'], correct: 1, duration: 30, points: 100 },
  { id: crypto.randomUUID(), type: 'order', text: 'Sortiert diese Ereignisse von früh nach spät.', options: ['Erste Mondlandung (1969)','Buchdruck mit beweglichen Lettern (um 1450)','Fall der Berliner Mauer (1989)','Erster Motorflug der Wright-Brüder (1903)'], correctOrder: [1,3,0,2], duration: 45, points: 150 },
  { id: crypto.randomUUID(), type: 'buzzer', text: 'Wie heißt die Hauptstadt von Kanada?', solution: 'Ottawa', duration: 25, points: 100 },
  { id: crypto.randomUUID(), type: 'estimate', text: 'Wie viele Minuten hat ein Tag?', target: 1440, unit: 'Minuten', duration: 35, points: 150 }
];
function initialState() {
  return {
    settings: { title: 'QUIZ BATTLE', theme: 'standard', teamCount: 4, music: true },
    teams: Array.from({ length: 4 }, (_, i) => ({ id: i+1, name: `Team ${i+1}`, score: 0 })),
    questions: starterQuestions,
    phase: 'lobby', currentId: null, answers: {}, results: {}, deadline: null, buzzerTeam: null, usedBuzzers: [], round: 0
  };
}
let state;
try {
  const loaded = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  state = { ...initialState(), ...loaded };
  if (!Array.isArray(state.teams) || !Array.isArray(state.questions)) throw new Error('invalid state');
} catch { state = initialState(); }
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const file = `${FILE}.tmp`;
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
    fs.renameSync(file, FILE);
  }, 120);
}
const activeCount = () => Math.max(2, Math.min(4, Number(state.settings.teamCount) || 4));
const activeTeams = () => state.teams.slice(0, activeCount());
const getQ = () => state.questions.find(q => q.id === state.currentId);
const isOpen = () => state.phase === 'question' && (!state.deadline || Date.now() <= state.deadline);
const safeText = (s, limit=250) => String(s ?? '').trim().slice(0, limit);
const int = (x, min, max, fallback) => Number.isFinite(Number(x)) ? Math.min(max, Math.max(min, Math.round(Number(x)))) : fallback;

function publicQuestion(q) {
  if (!q) return null;
  const common = { id: q.id, type: q.type, text: q.text, options: q.options, duration: q.duration, points: q.points, unit: q.unit };
  if (state.phase === 'reveal' || state.phase === 'podium') {
    return { ...common, correct: q.correct, correctOrder: q.correctOrder, target: q.target, solution: q.solution };
  }
  return common;
}
function publicState(role, teamId) {
  const q = getQ();
  const answers = {};
  for (const t of activeTeams()) {
    const a = state.answers[t.id];
    const result = state.results[t.id];
    answers[t.id] = {
      submitted: a !== undefined,
      // Team answers become public ONLY on reveal; buzzer participation is shown live.
      value: state.phase === 'reveal' ? a : undefined,
      result: state.phase === 'reveal' ? result : undefined,
      buzzed: state.usedBuzzers.includes(t.id)
    };
  }
  return {
    settings: state.settings,
    teams: activeTeams().map(t => ({ ...t, online: io.sockets.adapter.rooms.get(`team-${t.id}`)?.size > 0 })),
    phase: state.phase, round: state.round, question: publicQuestion(q), answers,
    deadline: state.deadline, buzzerTeam: state.buzzerTeam,
    // Reveal verdict is provided only when the moderator ends the round.
    teamId: role === 'team' ? teamId : null,
    questionCount: state.questions.length
  };
}
function broadcast() {
  for (const s of io.sockets.sockets.values()) {
    s.emit('state', publicState(s.data.role, s.data.teamId));
    if (s.data.role === 'mod') s.emit('admin', { questions: state.questions, settings: state.settings });
  }
  save();
}
function fail(socket, msg) { socket.emit('notice', { type: 'error', text: msg }); }
function noticeAll(text, type='info') { io.emit('notice', { type, text }); }
function judge(q) {
  const results = {};
  if (!q) return results;
  if (q.type === 'estimate') {
    const entries = activeTeams().filter(t => Number.isFinite(Number(state.answers[t.id])) && state.answers[t.id] !== undefined)
      .map(t => ({ id: t.id, diff: Math.abs(Number(state.answers[t.id]) - Number(q.target)) }));
    const best = Math.min(...entries.map(e => e.diff));
    for (const t of activeTeams()) {
      const a = entries.find(e => e.id === t.id);
      results[t.id] = a ? { correct: a.diff === best, awarded: a.diff === best ? q.points : 0, diff: a.diff } : { correct: false, awarded: 0 };
    }
  } else if (q.type === 'choice' || q.type === 'order') {
    for (const t of activeTeams()) {
      const a = state.answers[t.id];
      const correct = q.type === 'choice' ? a === q.correct : Array.isArray(a) && JSON.stringify(a) === JSON.stringify(q.correctOrder);
      results[t.id] = { correct, awarded: correct ? q.points : 0 };
    }
  } else if (q.type === 'buzzer') {
    for (const t of activeTeams()) {
      const correct = state.answers[t.id] === 'correct';
      results[t.id] = { correct, awarded: correct ? q.points : 0 };
    }
  }
  return results;
}
function reveal() {
  if (state.phase !== 'question') return;
  if (getQ()?.type === 'buzzer' && state.buzzerTeam !== null) return;
  state.results = judge(getQ());
  for (const t of activeTeams()) t.score += state.results[t.id]?.awarded || 0;
  state.phase = 'reveal';
  state.deadline = null;
  broadcast();
  io.emit('cue', 'reveal');
}
function normalizeQuestion(input, existingId) {
  const types = ['choice','order','buzzer','estimate'];
  const type = types.includes(input?.type) ? input.type : 'choice';
  const base = { id: existingId || crypto.randomUUID(), type, text: safeText(input?.text, 300), duration: int(input?.duration, 10, 180, 30), points: int(input?.points, 10, 1000, 100) };
  if (base.text.length < 3) throw new Error('Bitte eine Frage mit mindestens 3 Zeichen eingeben.');
  if (type === 'choice' || type === 'order') {
    if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 6) throw new Error('Bitte 2–6 Antworten anlegen.');
    base.options = input.options.map(x => safeText(x, 130));
    if (base.options.some(x => !x)) throw new Error('Antworten dürfen nicht leer sein.');
    if (type === 'choice') base.correct = int(input.correct, 0, base.options.length-1, 0);
    else {
      if (!Array.isArray(input.correctOrder) || input.correctOrder.length !== base.options.length || new Set(input.correctOrder).size !== base.options.length || input.correctOrder.some(x => !Number.isInteger(x) || x < 0 || x >= base.options.length)) throw new Error('Ungültige richtige Reihenfolge.');
      base.correctOrder = input.correctOrder;
    }
  }
  if (type === 'buzzer') base.solution = safeText(input.solution, 200);
  if (type === 'estimate') {
    if (!Number.isFinite(Number(input.target)) || input.target === '') throw new Error('Bitte eine gültige Zielzahl eingeben.');
    base.target = Number(input.target);
    base.unit = safeText(input.unit, 30);
  }
  return base;
}

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/health', (req, res) => res.json({ ok: true, teams: activeCount(), phase: state.phase }));

io.on('connection', socket => {
  const role = ['mod','team','show'].includes(socket.handshake.auth?.role) ? socket.handshake.auth.role : 'show';
  const teamId = Number(socket.handshake.auth?.teamId);
  if (role === 'mod' && (!ADMIN_KEY || String(socket.handshake.auth?.pin) !== ADMIN_KEY)) {
    socket.emit('auth-error', 'Moderator-Schlüssel ist nicht korrekt oder nicht konfiguriert.'); socket.disconnect(true); return;
  }
  if (role === 'team' && (!Number.isInteger(teamId) || teamId < 1 || teamId > activeCount())) {
    socket.emit('auth-error', 'Ungültige Teamnummer.'); socket.disconnect(true); return;
  }
  socket.data = { role, teamId: role === 'team' ? teamId : null };
  if (role === 'team') socket.join(`team-${teamId}`);
  const mod = fn => (...args) => { if (role !== 'mod') return fail(socket, 'Nur für die Moderation.'); try { fn(...args); } catch(e) { fail(socket, e.message); } };
  const team = fn => (...args) => { if (role !== 'team') return fail(socket, 'Nur für Teams.'); try { fn(...args); } catch(e) { fail(socket, e.message); } };
  socket.emit('state', publicState(role, teamId));
  if (role === 'mod') socket.emit('admin', { questions: state.questions, settings: state.settings });
  broadcast();
  socket.on('disconnect', broadcast);

  socket.on('mod:settings', mod(data => {
    const n = int(data.teamCount, 2, 4, activeCount());
    if (state.phase === 'question') throw new Error('Teamanzahl erst nach der laufenden Frage ändern.');
    state.settings.teamCount = n;
    state.settings.title = safeText(data.title, 45) || 'QUIZ BATTLE';
    state.settings.theme = data.theme === 'sternsinger' ? 'sternsinger' : 'standard';
    state.settings.music = !!data.music;
    if (Array.isArray(data.names)) data.names.slice(0, 4).forEach((name, i) => { state.teams[i].name = safeText(name, 24) || `Team ${i+1}`; });
    broadcast();
  }));
  socket.on('mod:save-question', mod(q => {
    const index = state.questions.findIndex(item => item.id === q?.id);
    if (state.phase === 'question' && state.currentId === q?.id) throw new Error('Die laufende Frage kann nicht bearbeitet werden.');
    const normalized = normalizeQuestion(q, index < 0 ? undefined : state.questions[index].id);
    if (index < 0) state.questions.push(normalized); else state.questions[index] = normalized;
    broadcast(); socket.emit('notice', { type: 'success', text: 'Frage gespeichert.' });
  }));
  socket.on('mod:delete-question', mod(id => {
    if (state.phase === 'question' && state.currentId === id) throw new Error('Die laufende Frage kann nicht gelöscht werden.');
    state.questions = state.questions.filter(q => q.id !== id);
    if (state.currentId === id) state.currentId = null;
    broadcast();
  }));
  socket.on('mod:import', mod(questions => {
    if (state.phase === 'question') throw new Error('Import erst nach der laufenden Frage möglich.');
    if (!Array.isArray(questions) || questions.length > 200) throw new Error('Import muss eine Liste mit maximal 200 Fragen sein.');
    state.questions = questions.map(q => normalizeQuestion(q));
    state.currentId = null; state.phase = 'lobby';
    broadcast();
  }));
  socket.on('mod:start', mod(id => {
    if (state.phase === 'question') throw new Error('Bitte aktuelle Frage zuerst auflösen.');
    const q = state.questions.find(item => item.id === id);
    if (!q) throw new Error('Frage nicht gefunden.');
    state.phase = 'question'; state.currentId = id; state.answers = {}; state.results = {};
    state.buzzerTeam = null; state.usedBuzzers = []; state.round++;
    state.deadline = Date.now() + q.duration * 1000;
    broadcast(); io.emit('cue', 'start');
  }));
  socket.on('mod:reveal', mod(reveal));
  socket.on('mod:lobby', mod(() => {
    state.phase = 'lobby'; state.currentId = null; state.deadline = null; state.buzzerTeam = null;
    broadcast();
  }));
  socket.on('mod:podium', mod(() => {
    if (state.phase === 'question') throw new Error('Bitte zuerst die Frage auflösen.');
    state.phase = 'podium'; state.deadline = null;
    broadcast(); io.emit('cue', 'victory');
  }));
  socket.on('mod:reset', mod(() => {
    state.teams.forEach(t => t.score = 0); state.phase = 'lobby'; state.currentId = null;
    state.answers = {}; state.results = {}; state.round = 0; state.deadline = null; state.buzzerTeam = null; state.usedBuzzers = [];
    broadcast();
  }));
  socket.on('mod:buzzer-judge', mod(correct => {
    const q = getQ();
    if (state.phase !== 'question' || q?.type !== 'buzzer' || state.buzzerTeam == null) throw new Error('Kein offener Buzzer.');
    state.answers[state.buzzerTeam] = correct ? 'correct' : 'wrong';
    state.buzzerTeam = null;
    if (correct) reveal(); else { broadcast(); io.emit('cue', 'wrong'); }
  }));
  socket.on('team:answer', team(value => {
    const q = getQ();
    if (!isOpen() || !q || q.type === 'buzzer') return fail(socket, 'Antwortzeit abgelaufen oder kein aktives Rätsel.');
    if (state.answers[teamId] !== undefined) return fail(socket, 'Antwort bereits abgegeben.');
    if (q.type === 'choice' && (!Number.isInteger(value) || value < 0 || value >= q.options.length)) return fail(socket, 'Ungültige Antwort.');
    if (q.type === 'order' && (!Array.isArray(value) || value.length !== q.options.length || new Set(value).size !== q.options.length || value.some(x => !Number.isInteger(x) || x < 0 || x >= q.options.length))) return fail(socket, 'Ungültige Reihenfolge.');
    if (q.type === 'estimate' && (typeof value !== 'number' || !Number.isFinite(value))) return fail(socket, 'Bitte eine Zahl eingeben.');
    state.answers[teamId] = value;
    broadcast(); socket.emit('notice', { type: 'success', text: 'Antwort abgegeben!' });
  }));
  socket.on('team:buzz', team(() => {
    if (!isOpen() || getQ()?.type !== 'buzzer' || state.buzzerTeam !== null || state.usedBuzzers.includes(teamId)) return fail(socket, 'Buzzer gerade nicht verfügbar.');
    state.buzzerTeam = teamId; state.usedBuzzers.push(teamId);
    broadcast(); io.emit('cue', 'buzz');
  }));
});

setInterval(() => {
  // Server-authoritative timer: notify screens as soon as time expires.
  if (state.phase === 'question' && state.deadline && Date.now() > state.deadline) {
    state.deadline = null;
    // No automatic judging: the host controls when results are shown.
    // A past deadline marker is required to keep submissions closed.
    state.deadline = -1;
    broadcast(); io.emit('cue', 'timeout');
  }
}, 350).unref();

server.listen(PORT, '0.0.0.0', () => console.log(`Quiz Battle auf Port ${PORT}`));
