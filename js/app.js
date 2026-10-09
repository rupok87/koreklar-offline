/* Koreklar Offline — PWA port of the native Android app. Vanilla JS, hash-routed SPA.
   Content ships as a bundled JSON + media tree, cached offline by the service worker.
   Progress (read pages, test attempts) is stored in IndexedDB via db.js. */

const TEST_DURATION_SECONDS = 45 * 60;

let content = null;
let readPageIds = new Set();
let currentHash = '';
let activeIntervalId = null;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function imageAssetPath(rel) { return rel ? `assets/media/images/${rel}` : null; }
function audioAssetPath(rel) { return rel ? `assets/media/audio/${rel}` : null; }

/** Fetches a media asset with retries and returns an object URL — hides transient network/tunnel
 * blips behind automatic retries instead of leaving a permanently broken <img>/<audio src>. */
async function loadAssetObjectUrl(path, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(path);
      if (res.ok) return URL.createObjectURL(await res.blob());
    } catch (e) { /* retry below */ }
    if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  return null;
}

/** Loads an image into #<elId> (a wrapper div), with a loading state and a tap-to-retry on failure. */
async function mountImage(elId, path) {
  const el = document.getElementById(elId);
  if (!el || !path) return;
  el.innerHTML = '<div class="asset-status">Loading image…</div>';
  const url = await loadAssetObjectUrl(path);
  const current = document.getElementById(elId);
  if (!current) return; // navigated away before this resolved
  if (url) {
    current.innerHTML = `<img class="asset-image" src="${url}" alt="">`;
  } else {
    current.innerHTML = '<div class="asset-status error">Couldn\'t load image. <button class="retry-btn">Retry</button></div>';
    current.querySelector('.retry-btn').onclick = () => mountImage(elId, path);
  }
}

/** Loads a narration audio's play button into #<elId>, with a loading state and tap-to-retry. */
async function mountAudio(elId, path, autoPlay) {
  const el = document.getElementById(elId);
  if (!el || !path) return;
  el.innerHTML = '<span class="asset-status">Loading audio…</span>';
  const url = await loadAssetObjectUrl(path);
  const current = document.getElementById(elId);
  if (!current) return;
  if (url) {
    current.innerHTML = `<button id="${elId}-btn">▶</button><span>Play narration</span><audio id="${elId}-audio" src="${url}" preload="auto"></audio>`;
    wireAudioButton(`${elId}-btn`, `${elId}-audio`, autoPlay);
  } else {
    current.innerHTML = '<span class="asset-status error">Couldn\'t load audio. <button class="retry-btn">Retry</button></span>';
    current.querySelector('.retry-btn').onclick = () => mountAudio(elId, path, autoPlay);
  }
}

function findModule(moduleId) { return content.education.find((m) => m.id === moduleId) || null; }
function findChapter(moduleId, chapterId) {
  const m = findModule(moduleId);
  return m ? (m.children.find((c) => c.id === chapterId) || null) : null;
}
function findTestCategory(categoryId) { return content.tests.find((c) => c.id === categoryId) || null; }
function findTestEntry(categoryId, testId) {
  const cat = findTestCategory(categoryId);
  return cat ? (cat.children.find((t) => t.id === testId) || null) : null;
}
function questionsFor(entry) {
  return entry.testMeta.questionIds.map((id) => content.questions[id]).filter(Boolean);
}
function correctIndices(question) {
  return new Set(
    String(question.correct || '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n))
      .map((n) => n - 1)
  );
}
function totalPageCount() {
  return content.education.reduce((sum, m) => sum + m.children.reduce((s, c) => s + c.pages.length, 0), 0);
}

function clearActiveInterval() {
  if (activeIntervalId !== null) {
    clearInterval(activeIntervalId);
    activeIntervalId = null;
  }
}

function navigate(path) {
  location.hash = path;
  route(path);
}

function shell(title, backTo, bodyHtml, actionsHtml = '') {
  document.getElementById('app').innerHTML = `
    <div class="topbar">
      <button class="iconbtn" id="menuBtn">&#9776;</button>
      ${backTo !== null ? '<button class="iconbtn" id="backBtn">&larr;</button>' : ''}
      <h1>${escapeHtml(title)}</h1>
      ${actionsHtml}
    </div>
    <div class="content" id="content">${bodyHtml}</div>
  `;
  document.getElementById('menuBtn').onclick = openDrawer;
  if (backTo !== null) document.getElementById('backBtn').onclick = () => navigate(backTo);
}

/* ---------- Navigation drawer ---------- */

const DRAWER_LINKS = [
  { label: 'Home', hash: '#/', emoji: '🏠' },
  { label: 'Lessons', hash: '#/lessons', emoji: '📖' },
  { label: 'Practice Tests', hash: '#/tests', emoji: '📝' },
  { label: 'Progress', hash: '#/stats', emoji: '📊' },
];

function ensureDrawer() {
  if (document.getElementById('drawerOverlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'drawerOverlay';
  overlay.className = 'drawer-overlay';

  const panel = document.createElement('nav');
  panel.id = 'drawerPanel';
  panel.className = 'drawer-panel';
  panel.innerHTML = `
    <div class="drawer-header">Koreklar Offline</div>
    ${DRAWER_LINKS.map((l) => `<a href="${l.hash}" class="drawer-link" data-hash="${l.hash}">
      <span class="drawer-emoji">${l.emoji}</span>${l.label}
    </a>`).join('')}
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(panel);

  overlay.addEventListener('click', closeDrawer);
  panel.querySelectorAll('.drawer-link').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const hash = a.dataset.hash;
      closeDrawer();
      if (activeIntervalId !== null && hash !== location.hash) {
        if (!confirm('Quit this test? Your progress on it will not be saved.')) return;
      }
      navigate(hash);
    });
  });
}

function openDrawer() {
  document.getElementById('drawerOverlay')?.classList.add('open');
  document.getElementById('drawerPanel')?.classList.add('open');
}

function closeDrawer() {
  document.getElementById('drawerOverlay')?.classList.remove('open');
  document.getElementById('drawerPanel')?.classList.remove('open');
}

/* ---------- Home ---------- */

async function renderHome() {
  const attempts = await DB.getAllAttempts();
  const totalPages = totalPageCount();
  const totalQuestions = Object.keys(content.questions).length;

  shell('Koreklar Offline', null, `
    <div class="card home-card" id="goLessons">
      <div class="emoji">📖</div>
      <div>
        <h2>Lessons</h2>
        <p>${readPageIds.size}/${totalPages} pages read</p>
      </div>
    </div>
    <div class="card home-card" id="goTests">
      <div class="emoji">📝</div>
      <div>
        <h2>Practice Tests</h2>
        <p>${totalQuestions} questions, ${attempts.length} attempts taken</p>
      </div>
    </div>
    <div class="card home-card" id="goStats">
      <div class="emoji">📊</div>
      <div>
        <h2>Progress</h2>
        <p>Review your test history</p>
      </div>
    </div>
  `);
  document.getElementById('goLessons').onclick = () => navigate('#/lessons');
  document.getElementById('goTests').onclick = () => navigate('#/tests');
  document.getElementById('goStats').onclick = () => navigate('#/stats');
}

/* ---------- Lessons ---------- */

function renderModuleList() {
  const items = content.education.map((m) => {
    const totalPages = m.children.reduce((s, c) => s + c.pages.length, 0);
    const readCount = m.children.reduce((s, c) => s + c.pages.filter((p) => readPageIds.has(p.pageid)).length, 0);
    return `<div class="card" data-id="${m.id}">
      <h2>${escapeHtml(m.title)}</h2>
      <p>${m.children.length} chapters · ${readCount}/${totalPages} pages read</p>
    </div>`;
  }).join('');

  shell('Lessons', '#/', items || '<p class="center-note">No lessons found.</p>');
  document.querySelectorAll('#content .card').forEach((el) => {
    el.onclick = () => navigate(`#/lessons/m/${el.dataset.id}`);
  });
}

function renderChapterList(moduleId) {
  const module = findModule(moduleId);
  const items = (module?.children || []).map((c) => {
    const readCount = c.pages.filter((p) => readPageIds.has(p.pageid)).length;
    return `<div class="card" data-id="${c.id}">
      <h2>${escapeHtml(c.title)}</h2>
      <p>${c.pages.length} pages · ${readCount} read</p>
    </div>`;
  }).join('');

  shell(module?.title || 'Module', '#/lessons', items || '<p class="center-note">No chapters found.</p>');
  document.querySelectorAll('#content .card').forEach((el) => {
    el.onclick = () => navigate(`#/lessons/m/${moduleId}/c/${el.dataset.id}`);
  });
}

function renderPageList(moduleId, chapterId) {
  const chapter = findChapter(moduleId, chapterId);
  const items = (chapter?.pages || []).map((p, index) => `
    <div class="card" data-index="${index}">
      <h2>${escapeHtml(p.title)} ${readPageIds.has(p.pageid) ? '✅' : ''}</h2>
    </div>`).join('');

  shell(chapter?.title || 'Chapter', `#/lessons/m/${moduleId}`, items || '<p class="center-note">No pages found.</p>');
  document.querySelectorAll('#content .card').forEach((el) => {
    el.onclick = () => navigate(`#/lessons/m/${moduleId}/c/${chapterId}/p/${el.dataset.index}`);
  });
}

async function renderPage(moduleId, chapterId, pageIndex) {
  const chapter = findChapter(moduleId, chapterId);
  const pages = chapter?.pages || [];
  const page = pages[pageIndex];

  if (!page) {
    shell(chapter?.title || 'Page', `#/lessons/m/${moduleId}/c/${chapterId}`, '<p class="center-note">Page not found.</p>');
    return;
  }

  await DB.markRead(moduleId, chapterId, page.pageid);
  readPageIds.add(page.pageid);

  const imgPath = imageAssetPath(page.image);
  const audioPath = audioAssetPath(page.audio);

  shell(chapter?.title || 'Page', `#/lessons/m/${moduleId}/c/${chapterId}`, `
    <p class="badge">Page ${pageIndex + 1} of ${pages.length}</p>
    <h2 style="margin-top:10px">${escapeHtml(page.title)}</h2>
    ${imgPath ? '<div id="pageImage"></div>' : ''}
    <div class="page-text">${page.text || ''}</div>
    ${audioPath ? '<div class="audio-row" id="pageAudio"></div>' : ''}
    <div class="row-between">
      <button class="action secondary" id="prevBtn" ${pageIndex === 0 ? 'disabled' : ''}>Previous</button>
      <button class="action" id="nextBtn" ${pageIndex >= pages.length - 1 ? 'disabled' : ''}>Next</button>
    </div>
  `);

  if (imgPath) mountImage('pageImage', imgPath);
  if (audioPath) mountAudio('pageAudio', audioPath, true);

  document.getElementById('prevBtn').onclick = () => navigate(`#/lessons/m/${moduleId}/c/${chapterId}/p/${pageIndex - 1}`);
  document.getElementById('nextBtn').onclick = () => navigate(`#/lessons/m/${moduleId}/c/${chapterId}/p/${pageIndex + 1}`);
}

/** Wires a play/pause icon button to an <audio> element; optionally autoplays once on setup. */
function wireAudioButton(btnId, audioId, autoPlay) {
  const btn = document.getElementById(btnId);
  const audioEl = document.getElementById(audioId);
  if (!btn || !audioEl) return;

  const setIcon = () => { btn.textContent = audioEl.paused ? '▶' : '⏸'; };
  audioEl.addEventListener('play', setIcon);
  audioEl.addEventListener('pause', setIcon);
  audioEl.addEventListener('ended', setIcon);

  btn.onclick = () => {
    if (audioEl.paused) audioEl.play().catch(() => {});
    else audioEl.pause();
  };

  if (autoPlay) {
    audioEl.play().catch(() => {});
  }
}

/* ---------- Practice Tests ---------- */

function renderTestCategoryList() {
  const items = content.tests.map((cat) => `
    <div class="card" data-id="${cat.id}">
      <h2>${escapeHtml(cat.title)}</h2>
      <p>${cat.children.length} tests</p>
    </div>`).join('');

  shell('Practice Tests', '#/', items || '<p class="center-note">No test categories found.</p>');
  document.querySelectorAll('#content .card').forEach((el) => {
    el.onclick = () => navigate(`#/tests/c/${el.dataset.id}`);
  });
}

async function renderTestList(categoryId) {
  const category = findTestCategory(categoryId);
  const attempts = await DB.getAllAttempts();
  const lastByTest = {};
  attempts.forEach((a) => {
    if (!lastByTest[a.testId] || a.takenAt > lastByTest[a.testId].takenAt) lastByTest[a.testId] = a;
  });

  const items = (category?.children || []).map((test) => {
    const last = lastByTest[test.id];
    return `<div class="card" data-id="${test.id}">
      <h2>${escapeHtml(test.title)}</h2>
      <p>${test.testMeta.questionIds.length} questions</p>
      ${last ? `<p>Last attempt: ${last.score}/${last.total} · ${last.passed ? 'Passed' : 'Not passed'}</p>` : ''}
    </div>`;
  }).join('');

  shell(category?.title || 'Tests', '#/tests', items || '<p class="center-note">No tests found.</p>');
  document.querySelectorAll('#content .card').forEach((el) => {
    el.onclick = () => navigate(`#/tests/c/${categoryId}/t/${el.dataset.id}`);
  });
}

async function renderTestIntro(categoryId, testId) {
  const entry = findTestEntry(categoryId, testId);
  const attempts = await DB.getAttemptsForTest(testId);
  const dateFmt = (ms) => new Date(ms).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const attemptItems = attempts.map((a) => `
    <div class="card" style="cursor:default">
      <p>${a.score}/${a.total} · ${a.passed ? 'Passed' : 'Not passed'}</p>
      <p>${dateFmt(a.takenAt)}</p>
    </div>`).join('') || '<p class="center-note">No attempts yet.</p>';

  shell(entry?.title || 'Test', `#/tests/c/${categoryId}`, `
    <p class="badge">${entry?.testMeta?.questionIds?.length || 0} questions · pass mark ${entry?.testMeta?.passpct || '80'}%</p>
    <div class="row-between" style="justify-content:flex-start;margin-top:16px">
      <button class="action" id="startBtn">Start Test</button>
    </div>
    <h2 style="margin-top:24px">Previous attempts</h2>
    ${attemptItems}
  `);

  document.getElementById('startBtn').onclick = () => navigate(`#/tests/c/${categoryId}/t/${testId}/take`);
}

function renderTestTaking(categoryId, testId) {
  const entry = findTestEntry(categoryId, testId);
  const questions = entry ? questionsFor(entry) : [];

  if (questions.length === 0) {
    shell(entry?.title || 'Test', `#/tests/c/${categoryId}/t/${testId}`, '<p class="center-note">No questions in this test.</p>');
    return;
  }

  let currentIndex = 0;
  let answers = {}; // pageid -> Set<number>
  let remainingSeconds = TEST_DURATION_SECONDS;
  let hasSubmitted = false;

  async function submit() {
    if (hasSubmitted) return;
    hasSubmitted = true;
    clearActiveInterval();

    const results = questions.map((q) => {
      const selected = answers[q.pageid] || new Set();
      const correct = correctIndices(q);
      const isCorrect = selected.size === correct.size && [...selected].every((i) => correct.has(i));
      return { question: q, selected, isCorrect };
    });
    const score = results.filter((r) => r.isCorrect).length;
    const total = questions.length;
    const scorePct = total === 0 ? 0 : Math.floor((score * 100) / total);
    const passPct = parseInt(entry?.testMeta?.passpct, 10) || 80;

    const attemptId = await DB.insertAttempt({
      categoryId, testId,
      testTitle: entry?.title || 'Test',
      score, total, passPct,
      passed: scorePct >= passPct,
      takenAt: Date.now(),
    });

    await DB.insertQuestionAttempts(results.map((r) => ({
      attemptId,
      questionId: r.question.pageid,
      selected: [...r.selected].sort((a, b) => a - b).join(','),
      isCorrect: r.isCorrect,
    })));

    navigate(`#/tests/result/${attemptId}`);
  }

  function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function renderQuestion(autoPlayAudio) {
    const q = questions[currentIndex];
    const maxAnswers = parseInt(q.maxanswers, 10) || 1;
    const selected = answers[q.pageid] || new Set();
    const imgPath = imageAssetPath(q.image);
    const audioPath = audioAssetPath(q.audio);
    const inputType = maxAnswers > 1 ? 'checkbox' : 'radio';

    const answersHtml = q.answers.map((text, index) => `
      <label class="answer" data-index="${index}">
        <input type="${inputType}" name="answer" ${selected.has(index) ? 'checked' : ''}>
        <span class="label">${escapeHtml(text)}</span>
      </label>`).join('');

    document.getElementById('content').innerHTML = `
      <p class="badge">Question ${currentIndex + 1} of ${questions.length}</p>
      <div class="question-text" style="margin-top:8px">${q.question || ''}</div>
      ${imgPath ? '<div id="questionImage" style="margin-top:12px"></div>' : ''}
      ${audioPath ? '<div class="audio-row" id="questionAudio" style="margin-top:12px"></div>' : ''}
      <div style="margin-top:12px">${answersHtml}</div>
      <div class="row-between">
        <button class="action secondary" id="prevBtn" ${currentIndex === 0 ? 'disabled' : ''}>Previous</button>
        ${currentIndex < questions.length - 1
          ? '<button class="action" id="nextBtn">Next</button>'
          : '<button class="action" id="submitBtn">Submit</button>'}
      </div>
    `;

    if (imgPath) mountImage('questionImage', imgPath);
    if (audioPath) mountAudio('questionAudio', audioPath, autoPlayAudio);

    document.querySelectorAll('#content .answer').forEach((el) => {
      el.querySelector('input').onchange = (e) => {
        const idx = parseInt(el.dataset.index, 10);
        const set = answers[q.pageid] || new Set();
        if (maxAnswers > 1) {
          if (e.target.checked) set.add(idx); else set.delete(idx);
        } else {
          set.clear();
          set.add(idx);
        }
        answers[q.pageid] = set;
      };
    });

    const prevBtn = document.getElementById('prevBtn');
    if (prevBtn) prevBtn.onclick = () => { currentIndex -= 1; renderQuestion(true); };
    const nextBtn = document.getElementById('nextBtn');
    if (nextBtn) nextBtn.onclick = () => { currentIndex += 1; renderQuestion(true); };
    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) submitBtn.onclick = () => submit();
  }

  function updateTimerDisplay() {
    const timerEl = document.getElementById('timerDisplay');
    if (!timerEl) return;
    timerEl.textContent = formatTime(remainingSeconds);
    timerEl.classList.toggle('low', remainingSeconds <= 60);
  }

  shell(entry?.title || 'Test', null, '', '<span class="timer" id="timerDisplay"></span>');
  updateTimerDisplay();
  renderQuestion(true);

  clearActiveInterval();
  activeIntervalId = setInterval(() => {
    remainingSeconds -= 1;
    updateTimerDisplay();
    if (remainingSeconds <= 0) {
      submit();
    }
  }, 1000);
}

async function renderTestResult(attemptIdStr) {
  const attemptId = parseInt(attemptIdStr, 10);
  const attempt = await DB.getAttempt(attemptId);
  const questionAttempts = await DB.getQuestionAttempts(attemptId);

  const cards = questionAttempts.map((qa, qIndex) => {
    const q = content.questions[qa.questionId];
    const selectedIndices = new Set(String(qa.selected || '').split(',').filter(Boolean).map((n) => parseInt(n, 10)));
    if (!q) return `<div class="card" style="cursor:default"><p>Question ${qIndex + 1} (${escapeHtml(qa.questionId)})</p></div>`;

    const correct = correctIndices(q);
    const answersHtml = q.answers.map((text, index) => {
      const isCorrectChoice = correct.has(index);
      const wasSelected = selectedIndices.has(index);
      let cls = 'answer';
      let marker = '';
      if (isCorrectChoice && wasSelected) { cls += ' correct'; marker = 'correct'; }
      else if (wasSelected && !isCorrectChoice) { cls += ' incorrect'; marker = 'your answer - incorrect'; }
      return `<div class="${cls}">
        <span class="label">${index + 1}. ${escapeHtml(text)}</span>
        ${marker ? `<span class="marker">${marker}</span>` : ''}
        ${isCorrectChoice && !wasSelected ? '<span class="missed-tick">&#10003;</span>' : ''}
      </div>`;
    }).join('');

    const imgPath = imageAssetPath(q.image);

    return `<div class="card" style="cursor:default">
      <h2>Question ${qIndex + 1}</h2>
      <div class="question-text">${q.question || ''}</div>
      ${imgPath ? `<div id="resultImage-${qIndex}" style="margin-top:8px"></div>` : ''}
      <div style="margin-top:8px">${answersHtml}</div>
    </div>`;
  }).join('');

  shell(attempt?.testTitle || 'Result', '#/', `
    ${attempt ? `
      <p class="badge ${attempt.passed ? 'pass' : 'fail'}">
        ${attempt.score}/${attempt.total} correct (${attempt.total > 0 ? Math.floor(attempt.score * 100 / attempt.total) : 0}%)
      </p>
      <h2 style="margin-top:8px">${attempt.passed ? 'Passed' : 'Not passed'} (pass mark ${attempt.passPct}%)</h2>
    ` : ''}
    <div style="margin-top:16px">${cards}</div>
  `);

  questionAttempts.forEach((qa, qIndex) => {
    const q = content.questions[qa.questionId];
    const imgPath = q && imageAssetPath(q.image);
    if (imgPath) mountImage(`resultImage-${qIndex}`, imgPath);
  });
}

/* ---------- Progress / Stats ---------- */

async function renderStats() {
  const attempts = await DB.getAllAttempts();
  const totalPages = totalPageCount();
  const avgScorePct = attempts.length === 0 ? 0 : Math.floor(
    attempts.reduce((sum, a) => sum + (a.total > 0 ? (a.score * 100) / a.total : 0), 0) / attempts.length
  );
  const dateFmt = (ms) => new Date(ms).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const items = attempts.map((a) => `
    <div class="card" style="cursor:default">
      <h2>${escapeHtml(a.testTitle)}</h2>
      <p>${a.score}/${a.total} · ${a.passed ? 'Passed' : 'Not passed'}</p>
      <p>${dateFmt(a.takenAt)}</p>
    </div>`).join('') || '<p class="center-note">No attempts yet.</p>';

  shell('Progress', '#/', `
    <p>Lessons: ${readPageIds.size}/${totalPages} pages read</p>
    <p>Tests taken: ${attempts.length}</p>
    <p>Average score: ${avgScorePct}%</p>
    <h2 style="margin-top:16px">Recent attempts</h2>
    ${items}
  `);
}

/* ---------- Router ---------- */

function route(hash) {
  currentHash = hash;
  clearActiveInterval();
  const path = hash.replace(/^#/, '') || '/';
  const seg = path.split('/').filter(Boolean);

  if (seg.length === 0) { renderHome(); return; }

  if (seg[0] === 'lessons') {
    if (seg.length === 1) { renderModuleList(); return; }
    if (seg[1] === 'm') {
      const moduleId = seg[2];
      if (seg.length === 3) { renderChapterList(moduleId); return; }
      if (seg[3] === 'c') {
        const chapterId = seg[4];
        if (seg.length === 5) { renderPageList(moduleId, chapterId); return; }
        if (seg[5] === 'p') { renderPage(moduleId, chapterId, parseInt(seg[6], 10) || 0); return; }
      }
    }
  }

  if (seg[0] === 'tests') {
    if (seg.length === 1) { renderTestCategoryList(); return; }
    if (seg[1] === 'result') { renderTestResult(seg[2]); return; }
    if (seg[1] === 'c') {
      const categoryId = seg[2];
      if (seg.length === 3) { renderTestList(categoryId); return; }
      if (seg[3] === 't') {
        const testId = seg[4];
        if (seg.length === 5) { renderTestIntro(categoryId, testId); return; }
        if (seg[5] === 'take') { renderTestTaking(categoryId, testId); return; }
      }
    }
  }

  if (seg[0] === 'stats') { renderStats(); return; }

  renderHome();
}

function onHashChange() {
  if (location.hash === currentHash) return;
  route(location.hash);
}

async function boot() {
  document.getElementById('app').innerHTML = '<div class="content"><p class="center-note">Loading…</p></div>';
  const [contentData, savedReadPages] = await Promise.all([
    fetch('assets/koreklar_data.json').then((r) => r.json()),
    DB.getReadPageIds(),
  ]);
  content = contentData;
  readPageIds = savedReadPages;

  ensureDrawer();
  window.addEventListener('hashchange', onHashChange);
  route(location.hash || '#/');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'cache-progress') showCacheProgress(event.data.done, event.data.total);
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

let progressBannerEl = null;

function showCacheProgress(done, total) {
  if (!progressBannerEl) {
    progressBannerEl = document.createElement('div');
    progressBannerEl.className = 'install-banner';
    progressBannerEl.id = 'cacheProgressBanner';
    document.body.prepend(progressBannerEl);
  }
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressBannerEl.textContent = `Downloading offline content: ${pct}% (${done}/${total} files) — keep this open until it finishes.`;
  if (done >= total) {
    progressBannerEl.textContent = 'Offline content ready — this app now works without internet.';
    setTimeout(() => { progressBannerEl?.remove(); progressBannerEl = null; }, 4000);
  }
}

boot();
