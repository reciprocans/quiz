'use strict';
const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const view = params.get('view') || 'home';
const teamId = Number(params.get('team') || 1);
let socket, state, admin, pin = sessionStorage.getItem('quiz-admin-pin') || '';
let draft = null, selected = null, order = null, lastQuestion = null, lastPhase = null, soundOn = localStorage.getItem('quiz-sound') !== 'off';
let audioCtx, musicInterval, melodyStep = 0, confettiTimer;
const types = { choice:'Multiple Choice',order:'Richtige Reihenfolge',buzzer:'Buzzer-Battle',estimate:'Schätzfrage' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attr = esc;
const teamURL = id => `${location.origin}/?view=team&team=${id}`;
const icon = type => ({choice:'🔠',order:'🔀',buzzer:'🚨',estimate:'🎯'}[type] || '❔');
function toast(message, kind='info') {
  const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = message;
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), 3800);
}
function emit(event, data) { if (socket?.connected) socket.emit(event, data); else toast('Keine Serververbindung.','error'); }
function initializeSocket(role) {
  socket?.disconnect();
  socket = io({ auth: { role, teamId, pin: role === 'mod' ? pin : undefined }, reconnection: true });
  socket.on('connect', () => { if (role === 'mod') toast('Moderation verbunden','success'); });
  socket.on('disconnect', () => toast('Serververbindung unterbrochen – verbinde neu …', 'error'));
  socket.on('auth-error', msg => { if (role === 'mod') { sessionStorage.removeItem('quiz-admin-pin'); pin=''; renderLogin(msg); } else toast(msg,'error'); });
  socket.on('notice', x => toast(x.text, x.type));
  socket.on('admin', a => { admin = a; if (role === 'mod') renderAdmin(); });
  socket.on('cue', cue => { playCue(cue); if (cue === 'victory') confetti(9000); });
  socket.on('state', s => {
    const qId = s.question?.id;
    if (qId !== lastQuestion || s.phase !== lastPhase) {
      if (qId !== lastQuestion || s.phase === 'question') { selected=null; order=null; }
      lastQuestion=qId; lastPhase=s.phase;
    }
    state=s; document.body.dataset.theme = s.settings.theme;
    if (role === 'show') renderShow();
    if (role === 'team') renderTeam();
    if (role === 'mod') renderAdmin();
    manageMusic();
  });
}
function header(tag='QUIZ BATTLE') {
  return `<div class="bar"><div class="brand">${esc(state?.settings?.title || tag)} <em>✦</em></div><div class="actions"><span class="chip" id="connection">● LIVE</span><button class="button small" data-action="sound">${soundOn ? '🔊':'🔇'}</button><button class="button small" data-action="fullscreen">⛶ Vollbild</button></div></div>`;
}
function screen(body, name='') { $('#app').innerHTML = `<main class="screen ${name}"><div class="sternsinger-stars"></div>${header()}${body}</main>`; tick(); }
function scoreStrip() {
  return `<div class="score-strip" style="--count:${state.teams.length}">${state.teams.map(t => {
    const a = state.answers[t.id] || {}, verdict = a.result;
    let style = verdict ? (verdict.correct ? 'correct':'incorrect') : (state.buzzerTeam === t.id ? 'active':'');
    const status = state.phase === 'reveal' ? (!a.submitted ? '— Keine Antwort' : `${verdict?.correct ? '✓ RICHTIG':'✕ FALSCH'} ${verdict?.awarded ? '+'+verdict.awarded : ''}`) :
      state.buzzerTeam === t.id ? '⚡ AM BUZZER' : a.buzzed ? '✕ BUZZER' : a.submitted ? '✓ Abgegeben' : (t.online ? '● Bereit':'○ Offline');
    let reply = '';
    if (state.phase === 'reveal' && a.submitted && state.question) {
      const q = state.question;
      if (q.type === 'choice') reply = q.options[a.value] ?? '';
      if (q.type === 'order' && Array.isArray(a.value)) reply = a.value.map(i => q.options[i]).join(' → ');
      if (q.type === 'estimate') reply = `${a.value} ${q.unit || ''}`;
      if (q.type === 'buzzer') reply = a.value === 'correct' ? 'Buzzer gewonnen' : 'Buzzer falsch';
    }
    return `<div class="score-card ${style}"><div class="name">${esc(t.name)}</div><div class="score">${t.score}</div><div class="status">${esc(status)}</div>${reply ? `<div class="answer-preview" title="${attr(reply)}">${esc(reply)}</div>` : ''}</div>`;
  }).join('')}</div>`;
}
function stageIntro() {
 return `<div class="show-stage show-center"><div class="lobby-logo">${state.settings.theme === 'sternsinger' ? '🌟':'🏆'}</div><div class="eyebrow">BEREIT FÜR DAS DUELL?</div><h1 class="hero-title">${esc(state.settings.title)}</h1><div class="hero-sub">${state.teams.length} Teams · ${state.questionCount} Fragen · Ein Champion</div><div class="chip" style="align-self:center;margin-top:12px">Moderator startet die nächste Runde</div></div>`;
}
function remaining() { return state?.deadline && state.deadline > 0 ? Math.max(0,Math.ceil((state.deadline-Date.now())/1000)) : 0; }
function timerHTML() { return `<div class="timer-ring" id="timer">${remaining()}</div>`; }
function resultSolution(q) {
  if (state.phase !== 'reveal') return '';
  let solution = q.type === 'choice' ? q.options[q.correct] : q.type === 'order' ? q.correctOrder.map(i=>q.options[i]).join(' → ') : q.type === 'estimate' ? `${q.target} ${q.unit || ''}` : q.solution;
  return `<div class="panel center" style="border-color:var(--good);max-width:950px;margin:0 auto"><div class="eyebrow">DIE LÖSUNG</div><div style="font-size:clamp(19px,2.8vw,37px);font-weight:900;margin-top:8px">${esc(solution)}</div></div>`;
}
function renderShow() {
  if (!state) return;
  if (state.phase === 'podium') { screen(podiumHTML(),'show-screen'); return; }
  if (state.phase === 'lobby' || !state.question) { screen(stageIntro()+scoreStrip(),'show-screen'); return; }
  const q = state.question;
  const label = state.phase === 'reveal' ? 'DIE AUFLÖSUNG' : `RUNDE ${state.round} · ${types[q.type].toUpperCase()}`;
  let content = `<div class="show-stage"><div class="show-center"><div class="eyebrow">${label}</div><h1 class="question-title">${esc(q.text)}</h1></div>`;
  if (state.phase === 'reveal') content += resultSolution(q);
  else if (q.type === 'choice') content += `<div class="show-options">${q.options.map((opt,i)=>`<div class="option"><b>${String.fromCharCode(65+i)}</b>${esc(opt)}</div>`).join('')}</div>`;
  else if (q.type === 'order') content += `<div class="show-options">${q.options.map((opt,i)=>`<div class="option"><b>${i+1}</b>${esc(opt)}</div>`).join('')}</div>`;
  else if (q.type === 'buzzer') content += `<div class="center"><div class="big-number">${state.buzzerTeam ? '⚡':'🚨'}</div><div class="hero-sub">${state.buzzerTeam ? esc(state.teams.find(t=>t.id===state.buzzerTeam)?.name) + ' hat gebuzzert!' : 'Wer weiß es zuerst?'}</div></div>`;
  else content += `<div class="center"><div class="big-number">🎯</div><div class="hero-sub">Die genaueste Schätzung gewinnt!</div></div>`;
  if (state.phase === 'question') content += `<div style="display:flex;justify-content:center">${timerHTML()}</div>`;
  content += `</div>${scoreStrip()}`;
  screen(content,'show-screen');
}
function podiumHTML() {
 const ranking = [...state.teams].sort((a,b)=>b.score-a.score);
 const list = [ranking[1],ranking[0],ranking[2]].filter(Boolean);
 return `<div class="show-stage show-center"><div class="eyebrow">DIE GROSSE SIEGEREHRUNG</div><h1 class="hero-title">🏆 CHAMPIONS 🏆</h1><div class="podium">${list.map(t=>{
   const rank=ranking.indexOf(t)+1;
   return `<div class="podium-col ${rank===1?'first':rank===3?'third':''}"><div class="podium-crown">${rank===1?'👑':rank===2?'🥈':'🥉'}</div><div class="podium-name">${esc(t.name)}</div><div class="podium-score">${t.score} Punkte</div><div class="podium-stand">${rank}</div></div>`;
 }).join('')}</div>${ranking.length>3?`<div class="hero-sub">Platz 4: ${esc(ranking[3].name)} · ${ranking[3].score} Punkte</div>`:''}</div>`;
}
function renderTeam() {
  if (!state) return;
  const team = state.teams.find(t=>t.id===teamId);
  if (!team) return screen(`<div class="show-stage center"><h1>Team nicht aktiv</h1><p>Moderator muss dieses Team freischalten.</p></div>`,'team-screen');
  if (state.phase === 'podium') return screen(podiumHTML(),'team-screen');
  const top = `<div class="bar"><span class="chip">${esc(team.name)}</span><span class="chip">${team.score} PUNKTE</span></div>`;
  if (state.phase === 'lobby' || !state.question) return screen(`${top}<div class="show-stage center"><div class="lobby-logo">🙌</div><div class="eyebrow">${esc(team.name)}</div><h1 class="hero-title">SEID IHR BEREIT?</h1><div class="hero-sub">Die Moderation startet gleich.</div></div>`,'team-screen');
  const q=state.question, sent=state.answers[teamId]?.submitted, done=state.phase === 'reveal', closed=!state.deadline || state.deadline < 0 || remaining() <= 0;
  let middle = '';
  if (done) {
    const result = state.answers[teamId]?.result;
    middle = `<div class="show-stage center"><div class="big-number">${result?.correct?'✅':'❌'}</div><h1 class="hero-title" style="font-size:clamp(35px,8vw,87px)">${result?.correct?'RICHTIG!':'NÄCHSTE RUNDE!'}</h1><div class="hero-sub">${result?.correct?`+${result.awarded} Punkte`:'Diesmal keine Punkte'}</div>${resultSolution(q)}</div>`;
  } else if (sent) {
    middle = `<div class="show-stage center"><div class="big-number">✅</div><h1 class="hero-title">GESPEICHERT</h1><div class="hero-sub">Wartet auf die Auflösung!</div></div>`;
  } else if (closed && !(q.type==='buzzer' && state.buzzerTeam)) {
    middle = `<div class="show-stage center"><div class="big-number">⌛</div><h1 class="hero-title">ZEIT UM!</h1></div>`;
  } else {
    middle = `<div class="show-stage"><div class="center"><div class="eyebrow">${types[q.type]} · Runde ${state.round}</div><h2 class="team-title">${esc(q.text)}</h2></div>`;
    if (q.type==='choice') middle += `<div class="team-options">${q.options.map((o,i)=>`<button class="team-choice ${selected===i?'selected':''}" data-action="pick" data-index="${i}">${String.fromCharCode(65+i)} · ${esc(o)}</button>`).join('')}</div>`;
    if (q.type==='order') {
      if (!order || order.length !== q.options.length) order = q.options.map((_,i)=>i);
      middle += `<div class="reorder">${order.map((idx,pos)=>`<div class="reorder-item"><b>${pos+1}.</b><span class="label">${esc(q.options[idx])}</span><button class="move" data-action="up" data-index="${pos}" ${pos===0?'disabled':''}>↑</button><button class="move" data-action="down" data-index="${pos}" ${pos===order.length-1?'disabled':''}>↓</button></div>`).join('')}</div>`;
    }
    if (q.type==='estimate') middle += `<div class="center"><input id="estimate" type="number" step="any" inputmode="decimal" placeholder="Eure Schätzung ${esc(q.unit||'')}" style="font-size:clamp(20px,4vw,34px);text-align:center;width:min(480px,90%)" value="${selected ?? ''}"></div>`;
    if (q.type==='buzzer') {
      const buzzed=state.answers[teamId]?.buzzed;
      middle += `<div class="center"><button class="buzzer" data-action="buzz" ${buzzed || state.buzzerTeam || closed?'disabled':''}>${state.buzzerTeam===teamId?'IHR SEID DRAN!':buzzed?'GEBUZZERT':'BUZZ!'}</button><div class="hero-sub" style="margin-top:25px">${state.buzzerTeam ? `${esc(state.teams.find(t=>t.id===state.buzzerTeam)?.name)} antwortet jetzt mündlich`:'Schneller als die anderen drücken!'}</div></div>`;
    } else middle += `<div class="team-footer"><button class="button primary big" data-action="submit" ${q.type==='choice' && selected===null?'disabled':''}>✓ Antwort abgeben</button></div>`;
    middle += `</div>`;
  }
  screen(`${top}${middle}${!done&&state.phase==='question'?`<div class="center" style="display:flex;justify-content:center">${timerHTML()}</div>`:''}`,'team-screen');
}
function renderHome() {
 $('#app').innerHTML=`<main class="home"><div class="home-inner"><div style="font-size:75px">🏆</div><div class="eyebrow">DIE SELF-HOSTED QUIZSHOW</div><h1 class="hero-title">QUIZ BATTLE</h1><div class="hero-sub">Vier Spielmodi · Bis zu vier Teams · Live & in Farbe</div><div class="home-links"><a class="home-link" href="/?view=show"><span class="icon">📺</span>Show-Bildschirm</a><a class="home-link" href="/?view=join"><span class="icon">📱</span>Als Team spielen</a><a class="home-link" href="/?view=mod"><span class="icon">🎛️</span>Moderation</a></div></div></main>`;
}
function renderJoin() {
 $('#app').innerHTML=`<main class="home"><div class="panel auth"><div class="eyebrow">TEAM BEITRETEN</div><h1 class="hero-title" style="font-size:60px">EUER TEAM</h1><div class="team-select">${[1,2,3,4].map(i=>`<a class="home-link" href="/?view=team&team=${i}">📱 Team ${i}</a>`).join('')}</div><p class="subtle">Wählt eure Teamnummer. Die Namen legt die Moderation fest.</p><a href="/" class="muted">← Startseite</a></div></main>`;
}
function renderLogin(error='') {
 $('#app').innerHTML=`<main class="home"><form id="pin-form" class="panel auth"><div style="font-size:50px">🔐</div><h1 class="hero-title" style="font-size:52px">MODERATION</h1><p class="muted">Moderator-Schlüssel aus der Portainer-Konfiguration eingeben</p>${error?`<p style="color:var(--bad)">${esc(error)}</p>`:''}<div class="field"><input id="pin" type="password" autocomplete="current-password" required placeholder="Moderator-Schlüssel"></div><button class="button primary" style="width:100%">Anmelden</button></form></main>`;
 $('#pin-form').addEventListener('submit',e=>{e.preventDefault(); pin=$('#pin').value; sessionStorage.setItem('quiz-admin-pin',pin); initializeSocket('mod');});
}
function blankQuestion(type='choice') {
 const out={id:null,type,text:'',duration:30,points:100,options:['','','',''],correct:0,correctOrder:[0,1,2,3],solution:'',target:0,unit:''};
 return out;
}
function captureDraft() {
 if (!draft) return;
 const get=id => document.getElementById(id);
 if (get('q-text')) draft.text=get('q-text').value;
 if (get('q-duration')) draft.duration=Number(get('q-duration').value);
 if (get('q-points')) draft.points=Number(get('q-points').value);
 if (get('q-type')) draft.type=get('q-type').value;
 if (draft.type==='choice'||draft.type==='order') {
   draft.options=Array.from(document.querySelectorAll('[data-option]')).map(x=>x.value);
   if (draft.type==='choice') draft.correct=Number(document.querySelector('[name=correct]:checked')?.value ?? 0);
   if (draft.type==='order') draft.correctOrder=Array.from(document.querySelectorAll('[data-position]')).map(x=>Number(x.value));
 }
 if (get('q-solution')) draft.solution=get('q-solution').value;
 if (get('q-target')) draft.target=get('q-target').value;
 if (get('q-unit')) draft.unit=get('q-unit').value;
}
function editorHTML() {
 if (!draft) return `<p class="muted">Wähle eine Frage aus oder erstelle eine neue Frage.</p>`;
 const q=draft;
 let specific='';
 if(q.type==='choice') specific=`<div class="field"><label>Antwortmöglichkeiten (richtige Antwort markieren)</label><div class="options-edit">${q.options.map((o,i)=>`<div class="option-edit"><input type="radio" name="correct" value="${i}" ${q.correct===i?'checked':''} title="Richtige Antwort"><input data-option type="text" maxlength="130" value="${attr(o)}" placeholder="Antwort ${i+1}"><button class="button small" data-action="remove-option" data-index="${i}">✕</button></div>`).join('')}</div></div><button class="button small" data-action="add-option" ${q.options.length>=6?'disabled':''}>+ Antwort hinzufügen</button>`;
 if(q.type==='order') specific=`<div class="field"><label>Einträge – rechts die richtige Position wählen</label><div class="options-edit">${q.options.map((o,i)=>`<div class="option-edit"><input data-option type="text" value="${attr(o)}" placeholder="Eintrag ${i+1}"><select data-position title="Richtige Position">${q.options.map((_,pos)=>`<option value="${pos}" ${q.correctOrder[pos]===i?'selected':''}>Platz ${pos+1}</option>`).join('')}</select><button class="button small" data-action="remove-option" data-index="${i}">✕</button></div>`).join('')}</div></div><p class="subtle">Jeder Platz darf nur einmal verwendet werden. Auf den iPads wird die Reihenfolge per Pfeiltasten sortiert.</p><button class="button small" data-action="add-option" ${q.options.length>=6?'disabled':''}>+ Eintrag hinzufügen</button>`;
 if(q.type==='buzzer') specific=`<div class="field"><label>Lösung für die Moderation</label><input id="q-solution" value="${attr(q.solution||'')}" placeholder="z. B. Ottawa"></div><p class="subtle">Das schnellste Team buzzert und antwortet mündlich. Die Moderation entscheidet richtig oder falsch.</p>`;
 if(q.type==='estimate') specific=`<div class="flex"><div class="field"><label>Richtiger Zahlenwert</label><input id="q-target" type="number" step="any" value="${attr(q.target)}"></div><div class="field"><label>Einheit</label><input id="q-unit" value="${attr(q.unit||'')}" placeholder="z. B. Kilometer"></div></div><p class="subtle">Die geringste absolute Abweichung gewinnt. Bei Gleichstand erhalten alle besten Teams Punkte.</p>`;
 return `<div class="field"><label>Spielmodus</label><select id="q-type">${Object.entries(types).map(([k,v])=>`<option value="${k}" ${q.type===k?'selected':''}>${icon(k)} ${v}</option>`).join('')}</select></div><div class="field"><label>Frage</label><textarea id="q-text" rows="2" placeholder="Was möchtest du fragen?">${esc(q.text)}</textarea></div>${specific}<div class="flex" style="margin-top:14px"><div class="field"><label>Zeit in Sekunden</label><input id="q-duration" type="number" min="10" max="180" value="${q.duration}"></div><div class="field"><label>Punkte</label><input id="q-points" type="number" min="10" max="1000" value="${q.points}"></div></div><div class="flex"><button class="button primary" data-action="save-question">💾 Frage speichern</button><button class="button" data-action="cancel-edit">Schließen</button></div>`;
}
function renderAdmin() {
 if (!state || !admin || view!=='mod') return;
 const live = state.phase==='question';
 $('#app').innerHTML=`<main class="admin"><div class="admin-header"><div class="brand">🎛️ ${esc(state.settings.title)} <em>· REGIE</em></div><div class="actions"><a class="button small" href="/?view=show" target="_blank" style="text-decoration:none">📺 Show öffnen</a><button class="button small" data-action="sound">${soundOn?'🔊 Ton an':'🔇 Ton aus'}</button><button class="button small" data-action="fullscreen">⛶ Vollbild</button><button class="button small" data-action="logout">Abmelden</button></div></div><div class="admin-grid"><aside><section class="panel"><h2>⚙️ Veranstaltung</h2><div class="field"><label>Titel</label><input id="s-title" maxlength="45" value="${attr(state.settings.title)}"></div><div class="flex"><div class="field"><label>Design</label><select id="s-theme"><option value="standard" ${state.settings.theme==='standard'?'selected':''}>⚡ Standard</option><option value="sternsinger" ${state.settings.theme==='sternsinger'?'selected':''}>🌟 Sternsinger</option></select></div><div class="field"><label>Teams</label><select id="s-count">${[2,3,4].map(n=>`<option value="${n}" ${state.settings.teamCount===n?'selected':''}>${n} Teams</option>`).join('')}</select></div></div><div class="field"><label>Teamnamen</label>${state.teams.map((t,i)=>`<input class="s-team-name" style="margin-bottom:7px" value="${attr(t.name)}" placeholder="Team ${i+1}" maxlength="24">`).join('')}</div><label class="subtle"><input id="s-music" type="checkbox" ${state.settings.music?'checked':''}> Spannungsmusik auf Show-Bildschirm</label><div style="margin-top:12px"><button class="button primary" data-action="save-settings" style="width:100%">Einstellungen speichern</button></div></section><section class="panel"><h2>🔗 iPad-Links</h2>${state.teams.map(t=>`<div class="flex" style="align-items:center;margin-bottom:7px"><span class="subtle">${esc(t.name)} ${t.online?'🟢':'⚪'}</span><button class="button small" data-action="copy" data-link="${attr(teamURL(t.id))}">Link kopieren</button></div>`).join('')}<p class="subtle">iPads müssen den Server über das gleiche Netzwerk erreichen können.</p></section><section class="panel"><h2>🏅 Punktestand</h2>${state.teams.map(t=>`<div style="display:flex;justify-content:space-between;margin:6px 0"><strong>${esc(t.name)}</strong><b>${t.score} P</b></div>`).join('')}<button class="button small" style="margin-top:15px" data-action="reset">↻ Neues Spiel / Punkte zurücksetzen</button></section></aside><section><div class="panel"><h2>🎬 Live-Steuerung <span class="chip">${esc(state.phase.toUpperCase())}</span></h2><div class="playbar"><div><b>${state.question ? esc(state.question.text):'Noch keine Frage gestartet'}</b></div><div class="subtle" style="margin-top:5px">${state.buzzerTeam?`⚡ ${esc(state.teams.find(t=>t.id===state.buzzerTeam)?.name)} ist am Buzzer`:`Runde ${state.round} · ${state.answers ? Object.values(state.answers).filter(x=>x.submitted).length:0} Antworten`}</div><div class="buttons">${state.buzzerTeam ? `<button class="button good" data-action="judge-correct">✓ Richtig</button><button class="button bad" data-action="judge-wrong">✕ Falsch / Weiterbuzzern</button>` : ''}<button class="button primary" data-action="reveal" ${!live||state.buzzerTeam?'disabled':''}>✅ Auflösen</button><button class="button" data-action="lobby" ${live?'disabled':''}>🏠 Lobby</button><button class="button" data-action="podium" ${live?'disabled':''}>🏆 Siegerehrung</button></div></div></div><div class="panel"><div class="flex" style="align-items:center"><h2 style="flex:1">📝 Fragen <span class="chip">${admin.questions.length}</span></h2><button class="button primary small" data-action="new-question">+ Neue Frage</button></div><div class="q-list">${admin.questions.map((q,i)=>`<div class="q-row ${draft?.id===q.id?'active':''}"><span class="q-type">${icon(q.type)} ${i+1}</span><span class="q-text">${esc(q.text)}</span><button class="button small primary" data-action="start" data-id="${attr(q.id)}" ${live?'disabled':''}>▶</button><button class="button small" data-action="edit" data-id="${attr(q.id)}">✎</button><button class="button small bad" data-action="delete" data-id="${attr(q.id)}">✕</button></div>`).join('')}</div><div class="flex"><button class="button small" data-action="export">⬇ Fragen exportieren</button><button class="button small" data-action="import">⬆ Fragen importieren</button><input type="file" id="import-file" accept="application/json,.json" style="display:none"></div></div><div class="panel" id="editor"><h2>${draft?.id?'✏️ Frage bearbeiten':'✨ Fragen-Editor'}</h2>${editorHTML()}</div></section></div></main>`;
}
function tick() {
 const el=$('#timer'); if (!el || !state) return;
 const t=remaining(); el.textContent=t;
 el.classList.toggle('danger',t<=5);
}
setInterval(tick,250);
function unlockSound() { try { audioCtx ||= new (window.AudioContext||window.webkitAudioContext)(); if(audioCtx.state==='suspended') audioCtx.resume(); }catch{} manageMusic(); }
function tone(freq=440,duration=.18,type='sine',gain=.07,delay=0) {
 if(!soundOn || !audioCtx || audioCtx.state!=='running') return;
 const now=audioCtx.currentTime+delay;
 const o=audioCtx.createOscillator(),g=audioCtx.createGain(); o.type=type; o.frequency.setValueAtTime(freq,now); g.gain.setValueAtTime(.001,now); g.gain.exponentialRampToValueAtTime(gain,now+.015); g.gain.exponentialRampToValueAtTime(.001,now+duration); o.connect(g);g.connect(audioCtx.destination);o.start(now);o.stop(now+duration+.02);
}
function playCue(name) {
 if(!soundOn) return;
 if(name==='start') [392,523,784].forEach((n,i)=>tone(n,.19,'triangle',.09,i*.14));
 if(name==='buzz') [180,140].forEach((n,i)=>tone(n,.24,'sawtooth',.12,i*.12));
 if(name==='wrong') [260,175].forEach((n,i)=>tone(n,.25,'square',.06,i*.2));
 if(name==='reveal') [392,494,587,784].forEach((n,i)=>tone(n,.28,'triangle',.08,i*.11));
 if(name==='victory') [523,659,784,1046,784,1046].forEach((n,i)=>tone(n,.33,'triangle',.09,i*.16));
 if(name==='timeout') [500,380,250].forEach((n,i)=>tone(n,.15,'square',.04,i*.16));
}
function manageMusic() {
 const should=Boolean(soundOn && state?.settings.music && view==='show' && state.phase==='question' && audioCtx?.state==='running');
 if(!should) {clearInterval(musicInterval);musicInterval=null;return;}
 if(musicInterval) return;
 const notes=[196,247,294,247,220,262,330,262];
 musicInterval=setInterval(()=>{const idx=melodyStep++%notes.length; tone(notes[idx],.2,'triangle',.028); if(idx%4===0) tone(notes[idx]/2,.45,'sine',.033);},310);
}
function confetti(ms) {
 const canvas=$('#confetti'), ctx=canvas.getContext('2d');
 if(!ctx)return;
 cancelAnimationFrame(confettiTimer);
 let pieces=Array.from({length:150},()=>({x:Math.random()*innerWidth,y:-Math.random()*innerHeight,v:1.5+Math.random()*4,a:Math.random()*6.28,c:['#ffd46a','#7f77ff','#28ddc0','#ff6a8e','#fff'][Math.floor(Math.random()*5)],w:4+Math.random()*8}));
 const until=performance.now()+ms;
 function frame(now){canvas.width=innerWidth;canvas.height=innerHeight;ctx.clearRect(0,0,innerWidth,innerHeight);for(const p of pieces){p.y+=p.v;p.x+=Math.sin(p.a+=.035)*1.4;if(p.y>innerHeight)p.y=-10;ctx.fillStyle=p.c;ctx.fillRect(p.x,p.y,p.w,5)}if(now<until)confettiTimer=requestAnimationFrame(frame);else ctx.clearRect(0,0,canvas.width,canvas.height)}
 confettiTimer=requestAnimationFrame(frame);
}
function download(name,text) {const a=document.createElement('a');const u=URL.createObjectURL(new Blob([text],{type:'application/json'}));a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),2000);}
function action(e) {
 const button=e.target.closest('[data-action]'); if(!button)return;
 const act=button.dataset.action, idx=Number(button.dataset.index), id=button.dataset.id;
 if(act==='fullscreen') { if(!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(()=>toast('Vollbild ist auf diesem Gerät eventuell nicht verfügbar.')); else document.exitFullscreen?.(); return; }
 if(act==='sound'){soundOn=!soundOn;localStorage.setItem('quiz-sound',soundOn?'on':'off');unlockSound();if(view==='show')renderShow();if(view==='team')renderTeam();if(view==='mod')renderAdmin();return;}
 unlockSound();
 if(act==='logout'){sessionStorage.removeItem('quiz-admin-pin');pin='';socket?.disconnect();state=null;admin=null;renderLogin();return;}
 if(act==='pick'){selected=idx;renderTeam();return;}
 if(act==='up'||act==='down'){const a=idx,b=idx+(act==='up'?-1:1);if(b>=0&&b<order.length){[order[a],order[b]]=[order[b],order[a]];renderTeam();}return;}
 if(act==='submit') {const q=state.question;if(q.type==='choice')emit('team:answer',selected);if(q.type==='order')emit('team:answer',order);if(q.type==='estimate'){const raw=$('#estimate')?.value?.trim();if(!raw||!Number.isFinite(Number(raw)))return toast('Bitte eine Zahl eingeben.','error');emit('team:answer',Number(raw));}return;}
 if(act==='buzz'){emit('team:buzz');return;}
 if(act==='save-settings') {emit('mod:settings',{title:$('#s-title').value,theme:$('#s-theme').value,teamCount:Number($('#s-count').value),music:$('#s-music').checked,names:[...document.querySelectorAll('.s-team-name')].map(el=>el.value)});return;}
 if(act==='copy'){navigator.clipboard?.writeText(button.dataset.link).then(()=>toast('Team-Link kopiert','success')).catch(()=>toast('Link: '+button.dataset.link));return;}
 if(act==='new-question'){draft=blankQuestion();renderAdmin();$('#editor')?.scrollIntoView({behavior:'smooth'});return;}
 if(act==='edit'){draft=structuredClone(admin.questions.find(q=>q.id===id));renderAdmin();$('#editor')?.scrollIntoView({behavior:'smooth'});return;}
 if(act==='cancel-edit'){draft=null;renderAdmin();return;}
 if(act==='add-option'){captureDraft();if(draft.options.length<6){draft.options.push('');draft.correctOrder=draft.options.map((_,i)=>i);}renderAdmin();return;}
 if(act==='remove-option'){captureDraft();if(draft.options.length<=2)return toast('Mindestens zwei Einträge erforderlich.','error');draft.options.splice(idx,1);draft.correct=Math.min(draft.correct,draft.options.length-1);draft.correctOrder=draft.options.map((_,i)=>i);renderAdmin();return;}
 if(act==='save-question'){captureDraft();if(draft.type==='order'){const pos=[...document.querySelectorAll('[data-position]')].map(x=>Number(x.value));if(new Set(pos).size!==pos.length)return toast('Jede Position muss genau einmal vorkommen.','error');const right=[];pos.forEach((p,i)=>right[p]=i);draft.correctOrder=right;}emit('mod:save-question',draft);draft=null;return;}
 if(act==='delete'){if(confirm('Frage wirklich löschen?'))emit('mod:delete-question',id);return;}
 if(act==='start'){if(confirm('Diese Frage jetzt auf allen Bildschirmen starten?'))emit('mod:start',id);return;}
 if(act==='reveal'){emit('mod:reveal');return;}
 if(act==='lobby'){emit('mod:lobby');return;}
 if(act==='podium'){emit('mod:podium');return;}
 if(act==='judge-correct'){emit('mod:buzzer-judge',true);return;}
 if(act==='judge-wrong'){emit('mod:buzzer-judge',false);return;}
 if(act==='reset'){if(confirm('Alle Punkte wirklich löschen und neues Spiel starten?'))emit('mod:reset');return;}
 if(act==='export'){download('quiz-fragen.json',JSON.stringify(admin.questions,null,2));return;}
 if(act==='import'){$('#import-file')?.click();return;}
}
document.addEventListener('click',action);
document.addEventListener('change',e=>{
 if(e.target.id==='q-type') {captureDraft();const type=e.target.value;draft= {...blankQuestion(type),id:draft.id,text:draft.text,duration:draft.duration,points:draft.points};renderAdmin();}
 if(e.target.id==='import-file' && e.target.files?.[0]) {const reader=new FileReader();reader.onload=()=>{try{const v=JSON.parse(reader.result);if(!Array.isArray(v))throw Error('Datei muss eine Fragenliste enthalten.');if(confirm(`Alle bisherigen Fragen durch ${v.length} importierte Fragen ersetzen?`))emit('mod:import',v);}catch(err){toast('Import fehlgeschlagen: '+err.message,'error')}};reader.readAsText(e.target.files[0]);}
});
document.addEventListener('input',e=>{if(e.target.id==='estimate')selected=e.target.value;});
document.addEventListener('pointerdown',unlockSound,{once:true});
if(view==='home')renderHome();else if(view==='join')renderJoin();else if(view==='mod'){renderLogin();if(pin)initializeSocket('mod');}else if(view==='team')initializeSocket('team');else initializeSocket('show');
