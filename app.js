// ── CONSTANTS ──
const DOMAINS = [
  { id:'general',       name:'General Security Concepts',                  weight:12 },
  { id:'threats',       name:'Threats, Vulnerabilities & Mitigations',     weight:22 },
  { id:'architecture',  name:'Security Architecture',                      weight:18 },
  { id:'operations',    name:'Security Operations',                        weight:28 },
  { id:'governance',    name:'Security Program Management & Oversight',    weight:20 },
];
const TYPE_LABELS = { mc:'Multiple Choice', fitb:'Fill in the Blank', match:'Matching', sort:'Sort the Steps', tf:'True or False', phish:'Spot the Threat' };
const STORAGE_KEY = 'secplus_v1';

// ── STATE ──
function defaultState() {
  const ds = {};
  DOMAINS.forEach(d => { ds[d.id] = { correct:0, total:0 }; });
  return { totalCorrect:0, totalAnswered:0, streak:0, domainStats:ds, history:[], missedIds:[], studyLog:[] };
}
function loadState() { try { const s = localStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) : null; } catch { return null; } }
function saveState() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {} }

let state = loadState() || defaultState();
if (!state.studyLog) state.studyLog = [];
if (!state.missedIds) state.missedIds = [];

// ── SESSION ──
let session = {
  mode: null,       // 'practice' | 'exam' | 'review'
  questions: [],
  idx: 0,
  correct: 0,
  domains: DOMAINS.map(d => d.id),
  count: 15,
  startTime: null,
  timerInterval: null,
  hintUsed: false,
  eliminatedIdx: null,
};

let currentQ = null;
let answered = false;
let matchLeft = null;
let matchState = {};
let sortOrder = [];

// ── UTILITIES ──
function pct(c,t) { return t === 0 ? 0 : Math.round((c/t)*100); }
function shuffle(a) { const b=[...a]; for(let i=b.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1));[b[i],b[j]]=[b[j],b[i]]; } return b; }
function render(html) { document.getElementById('screen').innerHTML = html; }
function qs(sel) { return document.querySelector(sel); }
function qsa(sel) { return document.querySelectorAll(sel); }

function weakDomains() {
  return DOMAINS.filter(d => {
    const s = state.domainStats[d.id];
    return s.total >= 3 && pct(s.correct, s.total) < 60;
  }).map(d => d.id);
}

function domainQCount(id) { return ALL_Q.filter(q => q.domain === id).length; }

// ── HABIT TRACKER ──
function getWeekDays() {
  const today = new Date();
  const dow = today.getDay(); // 0=Sun
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }
  return days;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function markStudiedToday() {
  const key = todayKey();
  if (!state.studyLog.includes(key)) {
    state.studyLog.push(key);
    if (state.studyLog.length > 90) state.studyLog = state.studyLog.slice(-90);
    saveState();
  }
}

function habitTrackerHTML() {
  const days = getWeekDays();
  const labels = ['M','T','W','T','F','S','S'];
  const todayD = new Date();
  const todayStr = todayKey();

  const dotsHTML = days.map((d, i) => {
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const isToday = key === todayStr;
    const studied = state.studyLog.includes(key);
    let cls = 'habit-dot';
    if (isToday && studied) cls += ' today-studied';
    else if (isToday && !studied) cls += ' today-empty';
    else if (studied) cls += ' studied';
    return `<div class="habit-day"><div class="${cls}"></div><div class="habit-day-lbl">${labels[i]}</div></div>`;
  }).join('');

  return `<div class="habit-wrap"><div class="habit-label">This week</div><div class="habit-days">${dotsHTML}</div></div>`;
}

// ── BUILD QUEUE ──
function buildQueue(mode) {
  const weak = weakDomains();
  const pool = ALL_Q.filter(q => session.domains.includes(q.domain));
  const limit = Math.min(session.count, pool.length);

  function scoreQ(q) {
    let w = 1;
    if (weak.includes(q.domain)) w += 2;
    const hist = state.history.filter(h => h.id === q.id);
    if (hist.length === 0) w += 1;
    else { const cr = hist.filter(h => h.correct).length; if (cr/hist.length < 0.5) w += 2; }
    return w;
  }

  function pickFrom(arr, used, n) {
    const avail = arr.filter(q => !used.has(q.id));
    const picked = [];
    for (let i = 0; i < n && avail.length > 0; i++) {
      const totalW = avail.reduce((s,q) => s + scoreQ(q), 0);
      if (totalW === 0) break;
      let r = Math.random() * totalW;
      for (let j = 0; j < avail.length; j++) {
        r -= scoreQ(avail[j]);
        if (r <= 0) { picked.push(avail[j]); used.add(avail[j].id); avail.splice(j,1); break; }
      }
    }
    return picked;
  }

  const used = new Set();
  const selected = [];

  if (mode === 'exam') {
    // Proportional by domain weight, target 90 questions
    const target = 90;
    DOMAINS.forEach(d => {
      const n = Math.round(target * d.weight / 100);
      const domPool = ALL_Q.filter(q => q.domain === d.id);
      selected.push(...pickFrom(domPool, used, n));
    });
    // Top up to 90
    while (selected.length < target) {
      const rem = ALL_Q.filter(q => !used.has(q.id));
      if (!rem.length) break;
      const picks = pickFrom(rem, used, target - selected.length);
      selected.push(...picks);
    }
    return shuffle(selected).slice(0, target);
  }

  if (mode === 'review') {
    const missed = ALL_Q.filter(q => state.missedIds.includes(q.id));
    return shuffle(missed);
  }

  // Practice: 70% MC, 30% alt types
  const byType = { mc:[], fitb:[], match:[], sort:[], tf:[], phish:[] };
  pool.forEach(q => { const t = q.type || 'mc'; if (byType[t]) byType[t].push(q); });

  const mcTarget = Math.round(limit * 0.70);
  const altTarget = limit - mcTarget;
  const altTypes = ['fitb','match','sort','tf','phish'].filter(t => byType[t].length > 0);
  const perAlt = altTypes.length > 0 ? Math.ceil(altTarget / altTypes.length) : 0;

  altTypes.forEach(t => selected.push(...pickFrom(byType[t], used, perAlt)));
  selected.push(...pickFrom(byType['mc'], used, limit - selected.length));

  if (selected.length < limit) {
    selected.push(...pickFrom(pool.filter(q => !used.has(q.id)), used, limit - selected.length));
  }

  return shuffle(selected).slice(0, limit);
}

// ── DASHBOARD ──
function showDashboard() {
  const weak = weakDomains();
  const op = pct(state.totalCorrect, state.totalAnswered);

  const domainRows = DOMAINS.map(d => {
    const s = state.domainStats[d.id];
    const p = pct(s.correct, s.total);
    const color = p >= 70 ? '#00ffb4' : p >= 50 ? '#ffd060' : '#ff4f6a';
    const qc = domainQCount(d.id);
    return `<div class="domain-row">
      <span class="domain-name" title="${d.name}">${d.name}</span>
      <div class="domain-bar-bg"><div class="domain-bar" style="width:${s.total?p:0}%;background:${color}"></div></div>
      <span class="domain-pct" style="color:${color}">${s.total ? p+'%' : '--'}</span>
      <span class="domain-count">${qc}q</span>
      ${weak.includes(d.id) ? '<span class="weak-tag">WEAK</span>' : ''}
    </div>`;
  }).join('');

  const missedBtn = state.missedIds.length > 0
    ? `<button class="btn btn-review" onclick="startReview()">[ REVIEW MISSED — ${state.missedIds.length} ]</button>`
    : '';
  const resetBtn = state.totalAnswered > 0
    ? `<button class="btn btn-danger" onclick="confirmReset()">[ RESET ALL PROGRESS ]</button>`
    : '';

  render(`
    <div class="hud">
      <div class="hud-dot"></div>
      <div class="hud-title">SEC+ Mission Control</div>
    </div>
    ${habitTrackerHTML()}
    <div class="dash-grid">
      <div class="stat-card"><div class="stat-val">${op}<span style="font-size:20px">%</span></div><div class="stat-lbl">Accuracy</div></div>
      <div class="stat-card"><div class="stat-val">${state.totalAnswered}</div><div class="stat-lbl">Answered</div></div>
    </div>
    <div class="section-label">Domain Performance</div>
    <div class="domain-list">${domainRows}</div>
    <div style="font-family:'Share Tech Mono',monospace;font-size:10px;color:rgba(200,216,240,.2);text-align:center;margin-bottom:14px">${ALL_Q.length} questions in bank</div>
    <button class="btn btn-primary" onclick="showSetup()">[ START SESSION ]</button>
    <button class="btn btn-exam" onclick="startExam()">[ EXAM SIMULATION — 90Q ]</button>
    ${missedBtn}
    ${resetBtn}
  `);
}

// ── SETUP ──
function showSetup() {
  const weak = weakDomains();
  const domOpts = DOMAINS.map(d => {
    const sel = session.domains.includes(d.id);
    const isW = weak.includes(d.id);
    const qc = domainQCount(d.id);
    return `<div class="domain-option ${sel ? 'active' : ''}" onclick="toggleDomain('${d.id}',this)">
      <span>${d.name}</span>
      <span class="domain-option-right">
        ${isW ? '<span class="weak-tag">NEEDS WORK</span>' : ''}
        <span class="setup-count-tag">${qc}q</span>
      </span>
    </div>`;
  }).join('');
  const avail = ALL_Q.filter(q => session.domains.includes(q.domain)).length;

  render(`
    <div class="hud">
      <div class="hud-dot"></div>
      <div class="hud-title">Configure Session</div>
      <div class="hud-spacer"></div>
      <button class="btn btn-small" onclick="showDashboard()">BACK</button>
    </div>
    <div class="section-label">Focus Domains <span style="color:rgba(200,216,240,.2)">(tap to toggle)</span></div>
    ${domOpts}
    <div class="section-label">Questions: <span id="cntVal" style="color:#00ffb4">${session.count}</span> <span style="color:rgba(200,216,240,.2);font-size:9px">(${avail} available)</span></div>
    <input type="range" min="5" max="50" step="5" value="${session.count}" oninput="session.count=+this.value;document.getElementById('cntVal').textContent=this.value">
    <button class="btn btn-primary" onclick="startPractice()">[ LAUNCH ]</button>
  `);
}

function toggleDomain(id, el) {
  const i = session.domains.indexOf(id);
  if (i >= 0) { if (session.domains.length > 1) { session.domains.splice(i,1); el.classList.remove('active'); } }
  else { session.domains.push(id); el.classList.add('active'); }
}

// ── START MODES ──
function startPractice() {
  session.mode = 'practice';
  session.questions = buildQueue('practice');
  session.idx = 0; session.correct = 0;
  markStudiedToday();
  saveState();
  showQ();
}

function startExam() {
  session.mode = 'exam';
  session.questions = buildQueue('exam');
  session.idx = 0; session.correct = 0;
  session.startTime = Date.now();
  markStudiedToday();
  saveState();
  showQ();
}

function startReview() {
  session.mode = 'review';
  session.questions = buildQueue('review');
  session.idx = 0; session.correct = 0;
  markStudiedToday();
  saveState();
  showQ();
}

// ── QUESTION ROUTER ──
function showQ() {
  if (session.idx >= session.questions.length) { showResults(); return; }
  currentQ = session.questions[session.idx];
  answered = false;
  session.hintUsed = false;
  session.eliminatedIdx = null;
  const t = currentQ.type || 'mc';
  if (t === 'fitb') renderFITB();
  else if (t === 'match') renderMatch();
  else if (t === 'sort') renderSort();
  else if (t === 'tf') renderTF();
  else if (t === 'phish') renderPhish();
  else renderMC();
  bindKeys();
}

// ── SHARED HEADER / FOOTER ──
function qHUD() {
  const dom = DOMAINS.find(d => d.id === currentQ.domain);
  const t = currentQ.type || 'mc';
  const isExam = session.mode === 'exam';
  const isReview = session.mode === 'review';

  let right = '';
  if (isExam) {
    const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
    const rem = Math.max(0, 90*60 - elapsed);
    const mm = String(Math.floor(rem/60)).padStart(2,'0');
    const ss = String(rem%60).padStart(2,'0');
    right = `<span class="hud-right hud-timer" id="examTimer">${mm}:${ss}</span>`;
  } else {
    right = `<span class="hud-right">SCORE: ${session.correct}/${session.idx}</span>`;
  }

  const title = isExam ? `EXAM SIM — Q${session.idx+1}/90` : isReview ? `MISSED REVIEW — ${session.idx+1}/${session.questions.length}` : `QUESTION ${session.idx+1} / ${session.questions.length}`;
  const pct_prog = Math.round((session.idx / session.questions.length) * 100);

  return `
    <div class="hud">
      <div class="hud-dot"></div>
      <div class="hud-title">${title}</div>
      <div class="hud-spacer"></div>
      ${right}
    </div>
    <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${pct_prog}%"></div></div>
    <div class="q-meta">
      <span class="q-domain-badge">${dom ? dom.name.split(' ')[0] : ''}</span>
      <span class="q-type-label">${TYPE_LABELS[t] || ''}</span>
    </div>`;
}

function toolbarHTML() {
  const t = currentQ.type || 'mc';
  const isExam = session.mode === 'exam';
  const showHint = t === 'mc' && !isExam;
  const showReport = !isExam;
  if (!showHint && !showReport) return '';
  return `<div class="q-toolbar">
    ${showHint ? `<button class="btn btn-small" id="hintBtn" onclick="useHint()" style="border-color:rgba(255,208,96,.3);color:#ffd060">HINT</button>` : ''}
    <div class="hud-spacer"></div>
    ${showReport ? `<button class="btn btn-small" onclick="showReport()" style="border-color:rgba(200,216,240,.15);color:rgba(200,216,240,.4)">REPORT</button>` : ''}
  </div>`;
}

function feedbackFooter(showStreak=true) {
  const isExam = session.mode === 'exam';
  const examNote = isExam ? `<div style="font-family:'Share Tech Mono',monospace;font-size:10px;color:rgba(200,216,240,.2);text-align:center;margin-bottom:6px">Feedback shown at end of exam</div>` : '';
  const streakEl = showStreak && !isExam ? `<div class="streak-flash" id="streakFlash"></div>` : '';
  return `${streakEl}<div class="feedback" id="feedbackBox"></div>${examNote}<button class="btn btn-primary" id="nextBtn" style="display:none" onclick="nextQ()">[ NEXT &rarr; ]</button>`;
}

// ── START EXAM TIMER ──
function startTimer() {
  clearInterval(session.timerInterval);
  session.timerInterval = setInterval(() => {
    const el = document.getElementById('examTimer');
    if (!el) { clearInterval(session.timerInterval); return; }
    const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
    const rem = Math.max(0, 90*60 - elapsed);
    const mm = String(Math.floor(rem/60)).padStart(2,'0');
    const ss = String(rem%60).padStart(2,'0');
    el.textContent = `${mm}:${ss}`;
    if (rem === 0) { clearInterval(session.timerInterval); if (!answered) recordResult(false); }
  }, 1000);
}

// ── MULTIPLE CHOICE ──
let mcShuffled = [];
function renderMC() {
  mcShuffled = shuffle(currentQ.choices.map((text,i) => ({ text, correct: i===0 })));
  const keys = ['A','B','C','D'];
  const opts = mcShuffled.map((o,i) =>
    `<div class="option" id="opt${i}" onclick="selectMC(${i})"><span class="opt-key">${keys[i]}</span><span>${o.text}</span></div>`
  ).join('');
  render(qHUD() + toolbarHTML() + `<div class="q-text">${currentQ.q}</div><div class="options">${opts}</div>` + feedbackFooter());
  if (session.mode === 'exam') startTimer();
}

function selectMC(idx) {
  if (answered) return;
  if (session.eliminatedIdx === idx) return;
  answered = true;
  const isCorrect = mcShuffled[idx].correct;
  qsa('.option').forEach((el,i) => {
    el.classList.add('disabled');
    if (session.mode === 'exam') {
      if (i === idx) el.classList.add('exam-picked');
    } else {
      if (i === idx) el.classList.add(isCorrect ? 'correct' : 'incorrect');
      else if (!isCorrect && mcShuffled[i] && mcShuffled[i].correct) el.classList.add('correct');
    }
  });
  recordResult(isCorrect, currentQ.exp);
}

function useHint() {
  if (answered || session.hintUsed) return;
  session.hintUsed = true;
  const wrongIdxs = mcShuffled
    .map((o,i) => ({ o, i }))
    .filter(({ o, i }) => !o.correct && i !== session.eliminatedIdx);
  if (!wrongIdxs.length) return;
  const pick = wrongIdxs[Math.floor(Math.random() * wrongIdxs.length)];
  session.eliminatedIdx = pick.i;
  const el = document.getElementById('opt' + pick.i);
  if (el) { el.classList.add('eliminated'); el.onclick = null; }
  const hintBtn = document.getElementById('hintBtn');
  if (hintBtn) { hintBtn.disabled = true; hintBtn.style.opacity = '.35'; hintBtn.style.cursor = 'default'; }
  if (!state.missedIds.includes(currentQ.id)) state.missedIds.push(currentQ.id);
  saveState();
}

// ── FILL IN THE BLANK ──
let fitbBank = [];
function renderFITB() {
  fitbBank = shuffle([...currentQ.bank]);
  fitbBank.forEach((w,i) => { window['_chip'+i] = w; });
  const chips = fitbBank.map((w,i) =>
    `<div class="chip" id="chip${i}" onclick="selectChip(${i})">${w}</div>`
  ).join('');
  const sentence = currentQ.q.replace('___', '<span class="fitb-blank" id="fitbBlank">___</span>');
  render(qHUD() + toolbarHTML() + `<div class="fitb-sentence">${sentence}</div><div class="chip-bank">${chips}</div>` + feedbackFooter());
  if (session.mode === 'exam') startTimer();
}

function selectChip(idx) {
  if (answered) return;
  answered = true;
  const word = window['_chip'+idx];
  const isCorrect = word.toLowerCase() === currentQ.answer.toLowerCase();
  qsa('.chip').forEach((el,i) => {
    el.classList.add('disabled');
    if (session.mode === 'exam') {
      if (i === idx) el.classList.add('exam-picked');
    } else {
      if (fitbBank[i].toLowerCase() === currentQ.answer.toLowerCase()) el.classList.add('correct');
      else if (i === idx && !isCorrect) el.classList.add('incorrect');
    }
  });
  const blank = document.getElementById('fitbBlank');
  if (blank) {
    blank.textContent = isCorrect ? word : currentQ.answer;
    blank.style.color = session.mode === 'exam' ? 'rgba(200,216,240,.5)' : (isCorrect ? '#00ffb4' : '#ff4f6a');
    blank.style.borderColor = session.mode === 'exam' ? 'rgba(200,216,240,.3)' : (isCorrect ? '#00ffb4' : '#ff4f6a');
  }
  recordResult(isCorrect, currentQ.exp);
}

// ── MATCHING ──
function renderMatch() {
  matchLeft = null; matchState = {};
  const rights = shuffle(currentQ.pairs.map(p => p.right));
  rights.forEach((r,i) => { window['_mr'+i] = r; });
  const leftHTML = currentQ.pairs.map((p,i) =>
    `<div class="match-left" id="ml${i}" onclick="selectLeft(${i})">${p.left}</div>`
  ).join('');
  const rightHTML = rights.map((r,i) =>
    `<div class="match-right" id="mr${i}" onclick="selectRight(${i})">${r}</div>`
  ).join('');
  render(qHUD() + toolbarHTML() + `<div class="q-text" style="font-size:13px;margin-bottom:10px">${currentQ.q}</div>
    <div class="match-grid"><div class="match-col">${leftHTML}</div><div class="match-col">${rightHTML}</div></div>
    <div style="font-family:'Share Tech Mono',monospace;font-size:10px;color:rgba(200,216,240,.25);text-align:center;margin:8px 0">TAP LEFT THEN RIGHT TO PAIR</div>
  ` + feedbackFooter());
  if (session.mode === 'exam') startTimer();
}

function selectLeft(idx) {
  if (answered) return;
  qsa('.match-left').forEach(e => e.classList.remove('match-active'));
  document.getElementById('ml'+idx).classList.add('match-active');
  matchLeft = idx;
}

function selectRight(ridx) {
  if (answered || matchLeft === null) return;
  const rtext = window['_mr'+ridx];
  const lidx = matchLeft;
  matchState[lidx] = rtext;
  const lel = document.getElementById('ml'+lidx);
  lel.classList.remove('match-active');
  lel.classList.add('match-paired');
  const rel = document.getElementById('mr'+ridx);
  rel.classList.add('match-paired');
  matchLeft = null;
  const allPaired = currentQ.pairs.every((_,i) => matchState[i] !== undefined);
  if (allPaired && !document.getElementById('matchConfirm')) {
    const nb = document.getElementById('nextBtn');
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary'; btn.id = 'matchConfirm';
    btn.style.marginBottom = '8px'; btn.textContent = '[ CONFIRM ]';
    btn.onclick = confirmMatch;
    nb.parentNode.insertBefore(btn, nb);
  }
}

function confirmMatch() {
  if (answered) return;
  answered = true;
  const allCorrect = currentQ.pairs.every((p,i) => matchState[i] === p.right);
  currentQ.pairs.forEach((p,i) => {
    const lel = document.getElementById('ml'+i);
    lel.classList.remove('match-paired');
    lel.classList.add(matchState[i] === p.right ? 'match-correct' : 'match-incorrect');
  });
  qsa('.match-right').forEach(el => {
    const rtext = el.textContent;
    const correct = currentQ.pairs.find(p => p.right === rtext);
    const paired = Object.entries(matchState).find(([,v]) => v === rtext);
    if (paired && correct) {
      el.classList.remove('match-paired');
      el.classList.add(paired[0] !== undefined && matchState[parseInt(paired[0])] === correct.right ? 'match-correct' : 'match-incorrect');
    }
  });
  document.getElementById('matchConfirm')?.remove();
  recordResult(allCorrect, currentQ.exp);
}

// ── SORTER ──
function renderSort() {
  sortOrder = shuffle([...currentQ.steps]);
  drawSort();
}

function drawSort() {
  const items = sortOrder.map((s,i) =>
    `<div class="sort-item" id="si${i}">
      <span class="sort-num">${i+1}</span>
      <span class="sort-text">${s}</span>
      <span class="sort-arrows">
        <button class="sort-arrow" onclick="moveSort(${i},-1)">&#9650;</button>
        <button class="sort-arrow" onclick="moveSort(${i},1)">&#9660;</button>
      </span>
    </div>`
  ).join('');
  render(qHUD() + toolbarHTML() + `<div class="q-text" style="font-size:13px;margin-bottom:10px">${currentQ.q}</div>
    <div class="sort-list">${items}</div>
    <div style="font-family:'Share Tech Mono',monospace;font-size:10px;color:rgba(200,216,240,.25);text-align:center;margin-bottom:10px">USE ARROWS TO REORDER</div>
    <button class="btn btn-primary" id="sortConfirm" style="margin-bottom:8px" onclick="confirmSort()">[ CONFIRM ORDER ]</button>
  ` + feedbackFooter(false));
  if (session.mode === 'exam') startTimer();
}

function moveSort(idx, dir) {
  if (answered) return;
  const ni = idx + dir;
  if (ni < 0 || ni >= sortOrder.length) return;
  [sortOrder[idx], sortOrder[ni]] = [sortOrder[ni], sortOrder[idx]];
  drawSort();
}

function confirmSort() {
  if (answered) return;
  answered = true;
  const isCorrect = sortOrder.every((s,i) => s === currentQ.steps[i]);
  qsa('.sort-item').forEach((el,i) => {
    el.classList.add(sortOrder[i] === currentQ.steps[i] ? 'sort-correct' : 'sort-incorrect');
    el.querySelector('.sort-arrows').remove();
  });
  document.getElementById('sortConfirm')?.remove();
  const exp = isCorrect ? currentQ.exp : `Correct order:<br>${currentQ.steps.map((s,i)=>`${i+1}. ${s}`).join('<br>')}<br><br>${currentQ.exp}`;
  recordResult(isCorrect, exp);
}

// ── TRUE / FALSE ──
function renderTF() {
  render(qHUD() + toolbarHTML() + `<div class="q-text">${currentQ.q}</div>
    <div class="tf-btns">
      <div class="tf-btn" id="tfTrue" onclick="selectTF(true)">TRUE</div>
      <div class="tf-btn" id="tfFalse" onclick="selectTF(false)">FALSE</div>
    </div>
    <div id="tfFollowWrap" style="display:none">
      <div class="tf-follow-label">Which part is incorrect?</div>
      <div class="options" id="tfFollowOpts"></div>
    </div>
  ` + feedbackFooter());
  if (session.mode === 'exam') startTimer();
}

function selectTF(choice) {
  if (answered) return;
  qsa('.tf-btn').forEach(b => b.classList.add('disabled'));
  document.getElementById(choice ? 'tfTrue' : 'tfFalse').classList.add('tf-picked');

  if (choice === false && currentQ.correct === false && currentQ.wrongParts) {
    // User said FALSE for a FALSE statement → show "which part is wrong?" follow-up.
    // Don't resolve yet; selectWrongPart() will call recordResult().
    const wrap = document.getElementById('tfFollowWrap');
    wrap.style.display = 'block';
    const shuffled = shuffle(currentQ.wrongParts.map((p,i) => ({ text:p, correct: i===currentQ.wrongAnswer })));
    const keys = ['A','B','C','D'];
    document.getElementById('tfFollowOpts').innerHTML = shuffled.map((o,i) =>
      `<div class="option" id="wp${i}" onclick="selectWrongPart(${i},${o.correct})">
        <span class="opt-key">${keys[i]}</span><span>${o.text}</span>
      </div>`
    ).join('');
  } else {
    // All other cases resolve immediately:
    //   TRUE question + say TRUE  → correct
    //   TRUE question + say FALSE → incorrect
    //   FALSE question + say TRUE → incorrect
    answered = true;
    const isCorrect = choice === currentQ.correct;
    document.getElementById(choice ? 'tfTrue' : 'tfFalse').classList.remove('tf-picked');
    document.getElementById(currentQ.correct ? 'tfTrue' : 'tfFalse').classList.add('correct');
    document.getElementById(currentQ.correct ? 'tfFalse' : 'tfTrue').classList.add('incorrect');
    recordResult(isCorrect, currentQ.exp);
  }
}

function selectWrongPart(idx, isCorrect) {
  if (answered) return;
  answered = true;
  // Reveal the T/F buttons now that the follow-up is resolved.
  document.getElementById('tfFalse').classList.remove('tf-picked');
  document.getElementById('tfFalse').classList.add('correct');
  document.getElementById('tfTrue').classList.add('incorrect');
  qsa('#tfFollowOpts .option').forEach((el,i) => {
    el.classList.add('disabled');
    if (i === idx) el.classList.add(isCorrect ? 'correct' : 'incorrect');
    else if (!isCorrect && el.getAttribute('onclick').includes(',true)')) el.classList.add('correct');
  });
  recordResult(isCorrect, currentQ.exp);
}

// ── PHISHING EMAIL ──
let phishShuffled = [];
function renderPhish() {
  const e = currentQ.email;
  phishShuffled = shuffle(currentQ.redFlags.map((f,i) => ({ text:f, correct: i===currentQ.correct })));
  const keys = ['A','B','C','D'];
  const opts = phishShuffled.map((o,i) =>
    `<div class="option" id="ph${i}" onclick="selectPhish(${i})">
      <span class="opt-key">${keys[i]}</span><span>${o.text}</span>
    </div>`
  ).join('');
  render(qHUD() + toolbarHTML() + `
    <div class="q-text" style="font-size:13px;margin-bottom:10px">What is the PRIMARY red flag in this email?</div>
    <div class="email-card">
      <div class="email-headers">
        <div class="email-row"><span class="email-field">FROM</span><span class="email-from">${e.from}</span></div>
        <div class="email-row"><span class="email-field">TO</span><span>${e.to}</span></div>
        <div class="email-row"><span class="email-field">SUBJ</span><span class="email-subject">${e.subject}</span></div>
      </div>
      <div class="email-body">${e.body}</div>
    </div>
    <div class="section-label" style="margin-top:0">Select the primary red flag</div>
    <div class="options">${opts}</div>
  ` + feedbackFooter());
  if (session.mode === 'exam') startTimer();
}

function selectPhish(idx) {
  if (answered) return;
  answered = true;
  const isCorrect = phishShuffled[idx].correct;
  qsa('.option').forEach((el,i) => {
    el.classList.add('disabled');
    if (session.mode === 'exam') {
      if (i === idx) el.classList.add('exam-picked');
    } else {
      if (i === idx) el.classList.add(isCorrect ? 'correct' : 'incorrect');
      else if (!isCorrect && phishShuffled[i].correct) el.classList.add('correct');
    }
  });
  recordResult(isCorrect, currentQ.exp);
}

// ── RECORD RESULT ──
function recordResult(isCorrect, exp) {
  if (isCorrect) {
    session.correct++; state.totalCorrect++; state.streak++;
    if (state.missedIds.includes(currentQ.id)) {
      state.missedIds = state.missedIds.filter(id => id !== currentQ.id);
    }
  } else {
    state.streak = 0;
    if (!state.missedIds.includes(currentQ.id)) state.missedIds.push(currentQ.id);
  }
  state.totalAnswered++;
  state.domainStats[currentQ.domain].total++;
  if (isCorrect) state.domainStats[currentQ.domain].correct++;
  state.history.push({ id: currentQ.id, domain: currentQ.domain, correct: isCorrect });
  if (state.history.length > 600) state.history = state.history.slice(-400);
  saveState();

  const fb = document.getElementById('feedbackBox');
  if (fb && session.mode !== 'exam') {
    fb.className = 'feedback ' + (isCorrect ? 'correct' : 'incorrect');
    fb.style.display = 'block';
    fb.innerHTML = (isCorrect ? '&#10003; Correct! ' : '&#10007; Incorrect. ') + (exp || '');
  }

  const sf = document.getElementById('streakFlash');
  if (sf && isCorrect) {
    if (state.streak >= 10) sf.textContent = `[ STREAK x${state.streak} — ELITE ]`;
    else if (state.streak >= 5) sf.textContent = `[ STREAK x${state.streak} — ON FIRE ]`;
    else if (state.streak >= 3) sf.textContent = `[ STREAK x${state.streak} ]`;
  }

  const nb = document.getElementById('nextBtn');
  if (nb) nb.style.display = 'block';
}

function nextQ() {
  clearInterval(session.timerInterval);
  session.idx++;
  showQ();
}

// ── KEYBOARD SHORTCUTS ──
function bindKeys() {
  document.onkeydown = (e) => {
    if (e.target.tagName === 'INPUT') return;
    const t = currentQ.type || 'mc';
    if (!answered) {
      if (t === 'mc') {
        const map = {'1':0,'2':1,'3':2,'4':3,'a':0,'b':1,'c':2,'d':3};
        const idx = map[e.key.toLowerCase()];
        if (idx !== undefined) { selectMC(idx); return; }
        if (e.key === 'h' || e.key === 'H') { useHint(); return; }
      }
      if (t === 'tf') {
        if (e.key === 't' || e.key === 'T') selectTF(true);
        if (e.key === 'f' || e.key === 'F') selectTF(false);
      }
      if (t === 'phish') {
        const map = {'1':0,'2':1,'3':2,'4':3,'a':0,'b':1,'c':2,'d':3};
        const idx = map[e.key.toLowerCase()];
        if (idx !== undefined) selectPhish(idx);
      }
    } else {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        const nb = document.getElementById('nextBtn');
        if (nb && nb.style.display !== 'none') nextQ();
      }
    }
  };
}

// ── REPORT PROBLEM ──
function showReport() {
  const q = currentQ;
  const t = q.type || 'mc';
  const msg = `Hi! Question #${q.id} might have an issue.\n\nType: ${TYPE_LABELS[t]}\nQuestion: "${q.q || q.q}"`;
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay" id="reportModal">
      <div class="modal-box">
        <h3 class="info">Report a Problem</h3>
        <p style="font-size:12px;color:rgba(200,216,240,.6);margin-bottom:4px">Copy and send this to Brande:</p>
        <div class="report-text" id="reportText">${msg}</div>
        <div class="copy-confirm" id="copyConfirm"></div>
        <div class="modal-actions">
          <button class="btn btn-primary" onclick="copyReport()">[ COPY ]</button>
          <button class="btn" onclick="document.getElementById('reportModal').remove()">CLOSE</button>
        </div>
      </div>
    </div>`);
}

function copyReport() {
  const text = document.getElementById('reportText').textContent;
  navigator.clipboard.writeText(text).then(() => {
    const el = document.getElementById('copyConfirm');
    if (el) { el.textContent = '[ COPIED TO CLIPBOARD ]'; setTimeout(() => { if(el) el.textContent = ''; }, 2000); }
  }).catch(() => {
    document.getElementById('reportText').select?.();
    const el = document.getElementById('copyConfirm');
    if (el) el.textContent = 'Select the text above and copy manually';
  });
}

// ── RESULTS ──
function showResults() {
  clearInterval(session.timerInterval);
  document.onkeydown = null;
  const total = session.questions.length;
  const p = total > 0 ? Math.round((session.correct/total)*100) : 0;
  const isExam = session.mode === 'exam';
  const color = p >= 80 ? '#00ffb4' : p >= 65 ? '#ffd060' : '#ff4f6a';

  let bigNum, subLabel, verdict;
  if (isExam) {
    bigNum = Math.round(100 + (p/100)*900);
    subLabel = 'Estimated Scale Score — Passing: 750';
    verdict = bigNum >= 750 ? 'PASS THRESHOLD MET' : 'BELOW PASSING THRESHOLD';
  } else {
    bigNum = p + '%';
    subLabel = `${session.correct} / ${total} correct`;
    verdict = p >= 80 ? 'MISSION ACCOMPLISHED' : p >= 70 ? 'ALMOST THERE' : p >= 55 ? 'NEEDS WORK' : 'REPORT FOR RETRAINING';
  }

  const domRows = DOMAINS.map(d => {
    const s = state.domainStats[d.id];
    const p2 = pct(s.correct, s.total);
    const c = p2 >= 70 ? '#00ffb4' : p2 >= 50 ? '#ffd060' : '#ff4f6a';
    return `<div class="domain-row">
      <span class="domain-name">${d.name}</span>
      <div class="domain-bar-bg"><div class="domain-bar" style="width:${s.total?p2:0}%;background:${c}"></div></div>
      <span class="domain-pct" style="color:${c}">${s.total ? p2+'%' : '--'}</span>
    </div>`;
  }).join('');

  const retakeBtn = isExam
    ? `<button class="btn btn-exam" onclick="startExam()">[ RETAKE EXAM SIM ]</button>`
    : `<button class="btn btn-primary" onclick="showSetup()">[ NEW SESSION ]</button>`;

  render(`
    <div class="hud"><div class="hud-dot"></div><div class="hud-title">${isExam ? 'Exam Simulation Complete' : 'Session Complete'}</div></div>
    <div class="results-score">
      <div class="results-big" style="color:${color}">${bigNum}</div>
      <div class="results-sub">${subLabel}</div>
      <div class="results-verdict" style="color:${color}">${verdict}</div>
    </div>
    <div class="section-label">All-Time Domain Performance</div>
    <div class="domain-list" style="margin-bottom:18px">${domRows}</div>
    ${retakeBtn}
    <button class="btn btn-review" onclick="showDashboard()">[ MISSION CONTROL ]</button>
  `);
}

// ── RESET ──
function confirmReset() {
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay" id="resetModal">
      <div class="modal-box">
        <h3 class="danger">Reset All Progress?</h3>
        <p>This will permanently erase all scores, streaks, domain stats, and study history. This cannot be undone.</p>
        <div class="modal-actions">
          <button class="btn btn-danger" onclick="doReset()">RESET</button>
          <button class="btn" onclick="document.getElementById('resetModal').remove()">CANCEL</button>
        </div>
      </div>
    </div>`);
}

function doReset() {
  state = defaultState();
  saveState();
  document.getElementById('resetModal')?.remove();
  showDashboard();
}

// ── INIT ──
showDashboard();
