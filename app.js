/* ============================================================
   app.js  —  메인 앱 컨트롤러
   네비게이션, 페이지 렌더링, 문제 CRUD, 설정, 통계, 유틸리티
============================================================ */

/* ============================================================
   전역 상태
============================================================ */
let _currentPage = 'dashboard';
let _editingQuestionId = null;
let _selectedColor = '';
let _confirmCallback = null;

/* ============================================================
   초기화
============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  _applySettings();
  _initNavigation();
  _initSetupPage();

  // Supabase 초기화: 원격 데이터가 더 최신이면 pull 후 설정 재적용
  if (typeof SupabaseSync !== 'undefined' && SupabaseSync.isConfigured()) {
    const updated = await SupabaseSync.init();
    if (updated) _applySettings();
  }

  navigate('dashboard');
});

/* ============================================================
   설정 적용 (다크모드 등)
============================================================ */
function _applySettings() {
  const s = Storage.getSettings();
  if (s.darkMode) {
    document.documentElement.setAttribute('data-theme', 'dark');
    const el = document.getElementById('setting-dark');
    if (el) el.checked = true;
  }
  const modelEl = document.getElementById('setting-model');
  if (modelEl) modelEl.value = s.geminiModel || 'gemini-2.5-flash';
  const apiKeyEl = document.getElementById('setting-apikey');
  if (apiKeyEl) apiKeyEl.value = Storage.getApiKey();
}

/* ============================================================
   네비게이션
============================================================ */
function _initNavigation() {
  // 사이드바 nav-item
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.page));
  });
  // 하단 내비
  document.querySelectorAll('.bottom-nav-item[data-page]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.page));
  });
}

function navigate(pageId) {
  _currentPage = pageId;

  // 페이지 전환
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById(`page-${pageId}`);
  if (target) target.classList.add('active');

  // 네비 활성화
  document.querySelectorAll('.nav-item[data-page], .bottom-nav-item[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === pageId);
  });

  // 페이지별 렌더링
  if (pageId === 'dashboard')   renderDashboard();
  if (pageId === 'questions')   renderQuestions();
  if (pageId === 'wrong')       WrongNote.render();
  if (pageId === 'stats')       renderStats();
  if (pageId === 'settings')    renderSettings();
  if (pageId === 'study-setup') { _initSetupSubjects(); _refreshSetupCount(); }
}

/* ============================================================
   모달 열기/닫기
============================================================ */
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

// 오버레이 클릭 닫기
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

/* ============================================================
   대시보드
============================================================ */
function renderDashboard() {
  const stats     = Storage.calcStats();
  const subjects  = Storage.calcSubjectStats();
  const records   = Storage.getRecords();
  const questions = Storage.getQuestions();

  // 날짜
  const dateEl = document.getElementById('dash-date');
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString('ko-KR', {
      year:'numeric', month:'long', day:'numeric', weekday:'short',
    });
  }

  // 통계 카드
  const statsEl = document.getElementById('dash-stats');
  if (statsEl) {
    statsEl.innerHTML = [
      { label:'전체 문제', value: stats.total, note: '등록된 문제 수', cls:'primary' },
      { label:'학습중',    value: stats.learning, note: '1회 이상 학습', cls:'warning' },
      { label:'암기완료',  value: stats.memorized, note: `전체의 ${stats.memorizeRate}%`, cls:'success' },
      { label:'오답노트',  value: stats.wrongCount, note: '복습 필요', cls:'danger' },
      { label:'정답률',    value: stats.correctRate + '%', note: `${stats.correctAttempts}/${stats.totalAttempts}회`, cls:'primary' },
      { label:'암기율',    value: stats.memorizeRate + '%', note: `${stats.memorized}/${stats.total}문제`, cls:'success' },
    ].map(s => `
      <div class="stat-card ${s.cls}">
        <div class="stat-label">${s.label}</div>
        <div class="stat-value">${s.value}</div>
        <div class="stat-note">${s.note}</div>
      </div>`).join('');
  }

  // 최근 학습 문제 (최대 5개)
  const recentEl = document.getElementById('dash-recent');
  if (recentEl) {
    const recent = questions
      .filter(q => records[q.id]?.lastStudied)
      .sort((a, b) => new Date(records[b.id].lastStudied) - new Date(records[a.id].lastStudied))
      .slice(0, 5);

    if (recent.length === 0) {
      recentEl.innerHTML = '<div class="text-sec" style="font-size:13px;padding:8px 0">아직 학습한 문제가 없습니다.</div>';
    } else {
      recentEl.innerHTML = recent.map(q => `
        <div class="dash-recent-item">
          <span class="subject-tag" style="background:${q.subjectColor}">${_esc(q.subject)}</span>
          <span style="flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${_esc(q.question)}
          </span>
          <span class="status-badge ${_statusClass(records[q.id]?.status)}">
            ${_statusText(records[q.id]?.status)}
          </span>
        </div>`).join('');
    }
  }

  // 과목별 현황
  const subjectsEl = document.getElementById('dash-subjects');
  if (subjectsEl) {
    if (subjects.length === 0) {
      subjectsEl.innerHTML = '<div class="text-sec" style="font-size:13px;padding:8px 0">등록된 과목이 없습니다.</div>';
    } else {
      subjectsEl.innerHTML = subjects.map(s => {
        const memRate = s.total > 0 ? Math.round(s.memorized / s.total * 100) : 0;
        return `
          <div class="dash-subject-row">
            <div style="display:flex;align-items:center;gap:8px;flex:1">
              <span class="subject-tag" style="background:${s.color}">${_esc(s.name)}</span>
              <div class="stats-bar" style="flex:1;height:6px">
                <div class="stats-bar-fill" style="width:${memRate}%;background:${s.color}"></div>
              </div>
            </div>
            <span class="text-sec" style="font-size:12px;white-space:nowrap">
              ${s.memorized}/${s.total}
            </span>
          </div>`;
      }).join('');
    }
  }
}

/* ============================================================
   문제 관리 페이지
============================================================ */
function renderQuestions() {
  const search    = (document.getElementById('q-search')?.value || '').toLowerCase();
  const subFilter = document.getElementById('q-subject-filter')?.value || '';
  const stFilter  = document.getElementById('q-status-filter')?.value || '';
  const typeFilter= document.getElementById('q-type-filter')?.value || '';

  let questions = Storage.getQuestions();
  const records = Storage.getRecords();

  // 필터 적용
  if (search)    questions = questions.filter(q =>
    q.question.toLowerCase().includes(search) ||
    q.answer.toLowerCase().includes(search) ||
    q.subject.toLowerCase().includes(search)
  );
  if (subFilter) questions = questions.filter(q => q.subject === subFilter);
  if (stFilter)  questions = questions.filter(q => (records[q.id]?.status || 'unseen') === stFilter);
  if (typeFilter)questions = questions.filter(q => q.answerType === typeFilter);

  // 과목 필터 드롭다운 갱신
  _updateSubjectFilter();

  // 카운트
  const countEl = document.getElementById('q-count-label');
  if (countEl) countEl.textContent = `${questions.length}개 문제`;

  const listEl = document.getElementById('question-list');
  if (!listEl) return;

  if (questions.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <h3>${search || subFilter || stFilter || typeFilter ? '검색 결과가 없습니다' : '등록된 문제가 없습니다'}</h3>
        <p>${search || subFilter ? '다른 검색어나 필터를 시도해보세요.' : '문제 추가 버튼을 눌러 첫 문제를 등록하세요.'}</p>
      </div>`;
    return;
  }

  listEl.innerHTML = questions.map(q => {
    const rec    = records[q.id];
    const status = rec?.status || 'unseen';
    const kws    = q.analysis?.keywords || [];
    const method = q.analysis?.method || 'none';

    return `
      <div class="question-item">
        <div class="question-item-header">
          <span class="subject-tag" style="background:${q.subjectColor || '#3b82f6'}">
            ${_esc(q.subject)}
          </span>
          <div class="question-text">${_esc(q.question)}</div>
        </div>
        <div class="question-meta">
          <span class="status-badge ${_statusClass(status)}">${_statusText(status)}</span>
          <span class="type-badge">${Analyzer.getTypeName(q.answerType)}</span>
          <span class="analysis-badge ${method === 'ai' ? 'ai' : ''}">
            ${method === 'ai' ? 'AI 분석' : method === 'rule' ? '규칙 분석' : '미분석'}
          </span>
          ${rec?.totalAttempts ? `<span>학습 ${rec.totalAttempts}회</span>` : ''}
          ${rec?.lastStudied   ? `<span>${_formatDate(rec.lastStudied)}</span>` : ''}
        </div>
        ${kws.length > 0 ? `
        <div class="hint-keywords mt-2">
          ${kws.slice(0,5).map(k => `<span class="hint-kw">${_esc(k)}</span>`).join('')}
          ${kws.length > 5 ? `<span class="text-sec" style="font-size:11.5px">+${kws.length-5}</span>` : ''}
        </div>` : ''}
        <div class="question-actions">
          <button class="btn btn-primary btn-sm" onclick="Study.startWithIds(['${q.id}'],{difficulty:'easy',label:'1문제 학습'})">학습</button>
          <button class="btn btn-outline btn-sm" onclick="openAddQuestion('${q.id}')">수정</button>
          <button class="btn btn-outline btn-sm" onclick="_reanalyzeQuestion('${q.id}')">재분석</button>
          <button class="btn btn-ghost btn-sm" onclick="_deleteQuestion('${q.id}')">삭제</button>
        </div>
      </div>`;
  }).join('');
}

function _updateSubjectFilter() {
  const sel = document.getElementById('q-subject-filter');
  if (!sel) return;
  const current = sel.value;
  const subjects = Storage.getSubjects();
  sel.innerHTML = '<option value="">전체 과목</option>' +
    subjects.map(s => `<option value="${_esc(s.name)}" ${s.name===current?'selected':''}>${_esc(s.name)}</option>`).join('');

  // datalist 업데이트
  const dl = document.getElementById('subject-datalist');
  if (dl) dl.innerHTML = subjects.map(s => `<option value="${_esc(s.name)}">`).join('');
}

/* ============================================================
   문제 추가/수정 모달
============================================================ */
function openAddQuestion(id = null) {
  _editingQuestionId = id || null;

  const titleEl = document.getElementById('modal-question-title');
  if (titleEl) titleEl.textContent = id ? '문제 수정' : '문제 추가';

  // 컬러 피커 렌더링
  _renderColorPicker('q-color-picker', '');

  // datalist 갱신
  _updateSubjectFilter();

  if (id) {
    const q = Storage.getQuestion(id);
    if (!q) return;
    document.getElementById('q-edit-id').value   = id;
    document.getElementById('q-subject').value   = q.subject;
    document.getElementById('q-question').value  = q.question;
    document.getElementById('q-answer').value    = q.answer;
    _selectedColor = q.subjectColor || Storage.PALETTE[0];
    _renderColorPicker('q-color-picker', _selectedColor);
    _setAnswerTypeBtns(q.answerType);
    _renderAnalysisPreview(q.analysis);
  } else {
    document.getElementById('q-edit-id').value  = '';
    document.getElementById('q-subject').value  = '';
    document.getElementById('q-question').value = '';
    document.getElementById('q-answer').value   = '';
    _selectedColor = Storage.PALETTE[0];
    _renderColorPicker('q-color-picker', _selectedColor);
    _setAnswerTypeBtns('');
    document.getElementById('q-analysis-preview').innerHTML = '';
  }

  openModal('modal-question');
}

function _renderColorPicker(containerId, selected) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = Storage.PALETTE.map(c => `
    <span class="color-swatch ${c === (selected||_selectedColor) ? 'selected' : ''}"
      style="background:${c}" title="${c}"
      onclick="_pickColor('${c}','${containerId}')"></span>
  `).join('');
}

function _pickColor(color, containerId) {
  _selectedColor = color;
  _renderColorPicker(containerId, color);
}

function selectAnswerType(type) {
  _setAnswerTypeBtns(type);
}

function _setAnswerTypeBtns(type) {
  document.querySelectorAll('#q-type-toggle .type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === type);
  });
}

function _getSelectedAnswerType() {
  const active = document.querySelector('#q-type-toggle .type-btn.active');
  return active?.dataset?.value || 'descriptive';
}

function autoDetectType() {
  const q = document.getElementById('q-question')?.value || '';
  const a = document.getElementById('q-answer')?.value   || '';
  if (!a.trim()) return;
  const detected = Analyzer.detectAnswerType(q, a);
  _setAnswerTypeBtns(detected);
  _updateAnalysisPreview(q, a, detected);
}

function autoAssignColor() {
  const subject = document.getElementById('q-subject')?.value?.trim() || '';
  if (!subject) return;
  const colors = Storage.getSubjectColors();
  const color  = colors[subject] || Storage.getAutoColor(subject);
  _selectedColor = color;
  _renderColorPicker('q-color-picker', color);
}

function _updateAnalysisPreview(question, answer, type) {
  if (!answer.trim()) return;
  const analysis = Analyzer.analyzeWithRules(question, answer);
  _renderAnalysisPreview(analysis);
}

function _renderAnalysisPreview(analysis) {
  const el = document.getElementById('q-analysis-preview');
  if (!el || !analysis) return;
  const kws = analysis.keywords || [];
  if (kws.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="analysis-preview-box">
      <div class="analysis-preview-title">추출된 핵심 키워드</div>
      <div class="keyword-chips">
        ${kws.map(k => `<span class="keyword-chip">${_esc(k)}</span>`).join('')}
      </div>
      ${analysis.structure ? `<div class="text-sec mt-2" style="font-size:12px">${_esc(analysis.structure)}</div>` : ''}
    </div>`;
}

async function saveQuestion() {
  const subject  = document.getElementById('q-subject')?.value.trim();
  const question = document.getElementById('q-question')?.value.trim();
  const answer   = document.getElementById('q-answer')?.value.trim();
  const type     = _getSelectedAnswerType();

  if (!subject || !question || !answer) {
    showToast('과목명, 문제, 답안을 모두 입력하세요.', 'warning');
    return;
  }

  const saveBtn = document.querySelector('#modal-question .btn-primary');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<span class="spinner"></span> 분석 중...'; }

  // AI / 규칙 분석
  let analysisResult;
  const { analysis, usedAI, error: aiError } = await GeminiAPI.analyzeQuestion(question, answer);
  analysis.answerType = type;
  analysisResult = analysis;
  if (!usedAI && aiError) {
    const msg = _parseQuotaError(aiError);
    showToast(msg, 'warning');
  }

  const data = {
    subject, question, answer,
    answerType:   type,
    subjectColor: _selectedColor || Storage.getAutoColor(subject),
    analysis:     analysisResult,
  };

  if (_editingQuestionId) {
    Storage.updateQuestion(_editingQuestionId, data);
    showToast('문제가 수정되었습니다.', 'success');
  } else {
    Storage.addQuestion(data);
    showToast('문제가 등록되었습니다.', 'success');
  }

  if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '저장'; }
  closeModal('modal-question');
  renderQuestions();
}

function _deleteQuestion(id) {
  const q = Storage.getQuestion(id);
  showConfirm(
    '문제 삭제',
    `"${(q?.question||'').slice(0, 40)}..." 를 삭제하시겠습니까?<br>
     <span class="text-sec" style="font-size:12px">관련 학습 기록도 함께 삭제됩니다.</span>`,
    () => {
      Storage.deleteQuestion(id);
      renderQuestions();
      showToast('삭제되었습니다.', 'success');
    }
  );
}

async function _reanalyzeQuestion(id) {
  const q = Storage.getQuestion(id);
  if (!q) return;

  showToast('분석 중...', '');

  const { analysis, usedAI, error: aiError } = await GeminiAPI.analyzeQuestion(q.question, q.answer);
  analysis.answerType = q.answerType;
  Storage.updateQuestion(id, { analysis });
  renderQuestions();
  if (usedAI) {
    showToast('AI 재분석 완료', 'success');
  } else {
    showToast(_parseQuotaError(aiError), 'warning');
  }
}

/* ============================================================
   일괄 등록
============================================================ */
function openBulkAdd() {
  document.getElementById('bulk-subject').value = '';
  document.getElementById('bulk-text').value    = '';
  document.getElementById('bulk-preview-area').innerHTML = '';
  document.getElementById('btn-bulk-save').disabled = true;
  document.getElementById('bulk-save-label').textContent = '등록하기';
  openModal('modal-bulk');
}

function previewBulk() {
  const text    = document.getElementById('bulk-text')?.value || '';
  const preview = document.getElementById('bulk-preview-area');
  const btn     = document.getElementById('btn-bulk-save');
  const label   = document.getElementById('bulk-save-label');
  if (!preview) return;

  const parsed = _parseBulkText(text);

  if (parsed.length === 0) {
    preview.innerHTML = '';
    if (btn) btn.disabled = true;
    return;
  }

  if (btn) btn.disabled = false;
  if (label) label.textContent = `${parsed.length}개 등록하기`;

  preview.innerHTML = `
    <div class="bulk-preview">
      <div class="bulk-preview-header">미리보기 — ${parsed.length}개 문제 인식됨</div>
      ${parsed.map((item, i) => `
        <div class="bulk-preview-item">
          <div class="bpi-q">${i+1}. ${_esc(item.question)}</div>
          <div class="bpi-a">${_esc(item.answer.slice(0, 120))}${item.answer.length > 120 ? '...' : ''}</div>
          <div class="bpi-meta">
            <span class="type-badge">${Analyzer.getTypeName(Analyzer.detectAnswerType(item.question, item.answer))}</span>
          </div>
        </div>`).join('')}
    </div>`;
}

function _parseBulkText(text) {
  const results = [];
  // Q. ... A. ... 패턴으로 분리
  const blocks  = text.split(/(?=^Q\.)/m).filter(b => b.trim());

  for (const block of blocks) {
    const qMatch = block.match(/^Q\.\s*(.+?)(?=\nA\.|\nA\s)/s);
    const aMatch = block.match(/\nA[\. ]\s*([\s\S]+)/);
    if (!qMatch || !aMatch) continue;
    const question = qMatch[1].trim();
    const answer   = aMatch[1].trim();
    if (question && answer) results.push({ question, answer });
  }
  return results;
}

async function saveBulk() {
  const subject = document.getElementById('bulk-subject')?.value.trim();
  const text    = document.getElementById('bulk-text')?.value || '';
  if (!subject) { showToast('과목명을 입력하세요.', 'warning'); return; }

  const parsed = _parseBulkText(text);
  if (parsed.length === 0) { showToast('파싱된 문제가 없습니다.', 'warning'); return; }

  const btn   = document.getElementById('btn-bulk-save');
  const label = document.getElementById('bulk-save-label');
  if (btn) btn.disabled = true;
  if (label) label.innerHTML = '<span class="spinner"></span> 등록 중...';

  const color = Storage.getAutoColor(subject);

  for (const item of parsed) {
    const type     = Analyzer.detectAnswerType(item.question, item.answer);
    const analysis = Analyzer.analyzeWithRules(item.question, item.answer);
    analysis.answerType = type;
    Storage.addQuestion({
      subject, question: item.question, answer: item.answer,
      answerType: type, subjectColor: color, analysis,
    });
  }

  // AI 분석 (API Key 있을 때 백그라운드 처리 권장 — 여기선 규칙 기반으로 완료)
  if (label) label.textContent = `${parsed.length}개 등록하기`;
  if (btn)   btn.disabled = false;

  closeModal('modal-bulk');
  navigate('questions');
  showToast(`${parsed.length}개 문제가 등록되었습니다.`, 'success');
}

/* ============================================================
   학습 설정 페이지 초기화
============================================================ */
function _initSetupPage() {
  // 모드 카드 클릭
  document.querySelectorAll('#setup-mode .mode-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('#setup-mode .mode-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      _refreshSetupCount();
    });
  });

  // 범위 버튼 클릭
  document.querySelectorAll('#setup-range .type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#setup-range .type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _refreshSetupCount();
    });
  });
}

function _initSetupSubjects() {
  const container = document.getElementById('setup-subjects');
  if (!container) return;

  const subjects = Storage.getSubjects();
  const btns     = [`<button class="type-btn active" data-subject="all">전체</button>`];

  subjects.forEach(s => {
    btns.push(`<button class="type-btn" data-subject="${_esc(s.name)}"
      style="border-color:${s.color};color:${s.color}"
      onmouseenter="this.style.background='${s.color}';this.style.color='#fff'"
      onmouseleave="this.style.background='';this.style.color='${s.color}'"
    >${_esc(s.name)}</button>`);
  });

  container.innerHTML = btns.join('');

  // 클릭 핸들러
  container.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.subject === 'all') {
        container.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      } else {
        container.querySelector('[data-subject="all"]')?.classList.remove('active');
        btn.classList.toggle('active');
        // 아무것도 선택 안 되면 전체 선택
        const anyActive = [...container.querySelectorAll('.type-btn:not([data-subject="all"])')].some(b => b.classList.contains('active'));
        if (!anyActive) container.querySelector('[data-subject="all"]')?.classList.add('active');
      }
      _refreshSetupCount();
    });
  });
}

function _refreshSetupCount() {
  const ids  = _buildQueue({
    subjects:   _getSetupSubjects(),
    range:      _getSetupValue('#setup-range', 'all'),
    difficulty: _getSetupValue('#setup-mode', 'easy'),
  });
  const info = document.getElementById('setup-count-info');
  const btn  = document.getElementById('btn-start-study');
  if (info) info.textContent = `${ids.length}개 문제 출제 예정`;
  if (btn)  btn.disabled = ids.length === 0;
}

/* ============================================================
   통계 페이지
============================================================ */
function renderStats() {
  const stats    = Storage.calcStats();
  const subjects = Storage.calcSubjectStats();
  const el       = document.getElementById('stats-content');
  if (!el) return;

  const subjectRows = subjects.map(s => {
    const rate    = s.attempts > 0 ? Math.round(s.correct / s.attempts * 100) : 0;
    const memRate = s.total    > 0 ? Math.round(s.memorized / s.total * 100)  : 0;
    return `
      <tr>
        <td><span class="subject-tag" style="background:${s.color}">${_esc(s.name)}</span></td>
        <td style="text-align:center">${s.total}</td>
        <td style="text-align:center">${s.memorized}</td>
        <td>
          <div class="stats-bar">
            <div class="stats-bar-fill" style="width:${memRate}%;background:${s.color}"></div>
          </div>
        </td>
        <td style="text-align:center">${rate}%</td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="stat-grid mb-4">
      ${[
        { label:'전체 문제', value: stats.total, cls:'primary' },
        { label:'미학습', value: stats.unseen, cls:'warning' },
        { label:'학습중', value: stats.learning, cls:'warning' },
        { label:'암기완료', value: stats.memorized, cls:'success' },
        { label:'정답률', value: stats.correctRate + '%', cls:'primary' },
        { label:'암기율', value: stats.memorizeRate + '%', cls:'success' },
      ].map(s => `
        <div class="stat-card ${s.cls}">
          <div class="stat-label">${s.label}</div>
          <div class="stat-value">${s.value}</div>
        </div>`).join('')}
    </div>

    <div class="card mb-4">
      <div class="card-header">전체 진행률</div>
      <div class="card-body">
        ${_progressBar('학습 진행률', stats.total > 0 ? Math.round((stats.learning + stats.memorized) / stats.total * 100) : 0, 'var(--primary)')}
        ${_progressBar('암기 완료율', stats.memorizeRate, 'var(--success)')}
        ${_progressBar('정답률',     stats.correctRate,   'var(--warning)')}
      </div>
    </div>

    ${subjects.length > 0 ? `
    <div class="card">
      <div class="card-header">과목별 현황</div>
      <div class="card-body" style="overflow-x:auto">
        <table class="stats-table">
          <thead>
            <tr>
              <th>과목</th>
              <th style="text-align:center">전체</th>
              <th style="text-align:center">암기완료</th>
              <th style="min-width:120px">진행률</th>
              <th style="text-align:center">정답률</th>
            </tr>
          </thead>
          <tbody>${subjectRows}</tbody>
        </table>
      </div>
    </div>` : ''}`;
}

function _progressBar(label, pct, color) {
  return `
    <div class="stats-bar-wrap">
      <div class="stats-bar-label">
        <span>${label}</span><span>${pct}%</span>
      </div>
      <div class="stats-bar">
        <div class="stats-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
    </div>`;
}

/* ============================================================
   설정 페이지
============================================================ */
function renderSettings() {
  // 다크모드 체크박스
  const darkEl = document.getElementById('setting-dark');
  if (darkEl) darkEl.checked = Storage.getSettings().darkMode;

  // 모델 선택
  const modelEl = document.getElementById('setting-model');
  if (modelEl) modelEl.value = Storage.getSettings().geminiModel || 'gemini-2.5-flash';

  // API Key
  const keyEl = document.getElementById('setting-apikey');
  if (keyEl) keyEl.value = Storage.getApiKey();

  // API 상태
  _updateApiStatus();

  // 저장 용량 미터
  _renderStorageMeter();

  // 클라우드 동기화 상태
  _renderSyncStatus();
}

function _updateApiStatus() {
  const el = document.getElementById('api-status');
  if (!el) return;
  const key = Storage.getApiKey();
  if (key) {
    el.innerHTML = `<span class="text-success" style="font-size:12.5px">✓ API Key 등록됨</span>`;
  } else {
    el.innerHTML = `<span class="text-sec" style="font-size:12.5px">API Key 미등록 — 규칙 기반 분석 사용 중</span>`;
  }
}

function _renderStorageMeter() {
  const el = document.getElementById('storage-meter');
  if (!el) return;

  const usage = Storage.calcStorageUsage();
  const pct   = parseFloat(usage.percent);
  const color = pct > 80 ? 'var(--danger)' : pct > 60 ? 'var(--warning)' : 'var(--primary)';

  el.innerHTML = `
    <div class="flex justify-between mb-1" style="font-size:13px">
      <span>${usage.usedKB} KB 사용 중</span>
      <span class="text-sec">최대 ${(usage.limitBytes/1024/1024).toFixed(0)} MB</span>
    </div>
    <div class="storage-bar-track">
      <div class="storage-bar-fill" style="width:${pct}%;background:${color}"></div>
    </div>
    <div class="text-sec mt-1" style="font-size:12px">${pct}% 사용 중</div>`;
}

/* ============================================================
   클라우드 동기화 UI
============================================================ */
function _renderSyncStatus() {
  const el = document.getElementById('sync-status');
  if (!el) return;

  if (typeof SupabaseSync === 'undefined' || !SupabaseSync.isConfigured()) {
    el.innerHTML = `<span style="color:var(--warning)">&#9888; 미설정</span> — supabase.js 상단의 URL, KEY, USER_ID를 입력하세요`;
    return;
  }

  if (SupabaseSync.isOnline()) {
    el.innerHTML = `<span style="color:var(--success)">&#9679; 온라인</span> — 데이터 변경 시 자동 동기화 중`;
  } else {
    el.innerHTML = `<span style="color:var(--text-sec)">&#9679; 오프라인</span> — 로컬 저장 전용, 온라인 복귀 시 자동 업로드`;
  }
}

async function manualPush() {
  showToast('동기화 중...', 'success');
  const ok = await SupabaseSync.push();
  showToast(
    ok ? '클라우드에 저장됐습니다' : '저장 실패 — 네트워크를 확인하세요',
    ok ? 'success' : 'warning'
  );
}

async function manualPull() {
  showToast('최신 데이터 확인 중...', 'success');
  const updated = await SupabaseSync.pull();
  if (updated) {
    _applySettings();
    navigate(_currentPage);
    showToast('최신 데이터를 불러왔습니다', 'success');
  } else {
    showToast('이미 최신 상태입니다', 'success');
  }
}

function toggleDarkMode(on) {
  document.documentElement.setAttribute('data-theme', on ? 'dark' : 'light');
  Storage.saveSettings({ darkMode: on });
}

function toggleApiKeyVisibility() {
  const el = document.getElementById('setting-apikey');
  if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
}

async function saveApiSettings() {
  const key   = document.getElementById('setting-apikey')?.value.trim();
  const model = document.getElementById('setting-model')?.value || 'gemini-2.5-flash';

  Storage.saveSettings({ geminiModel: model });

  if (key) {
    const statusEl = document.getElementById('api-status');
    if (statusEl) statusEl.innerHTML = '<span class="spinner spinner-dark"></span> 연결 테스트 중...';

    const result = await GeminiAPI.testApiKey(key, model);

    if (result.ok) {
      Storage.saveApiKey(key);
      showToast('API Key 저장 완료: ' + result.message, 'success');
    } else {
      showToast('API Key 오류: ' + result.message, 'danger');
    }
  } else {
    showToast('설정이 저장되었습니다.', 'success');
  }

  _updateApiStatus();
}

function deleteApiKey() {
  showConfirm('API Key 삭제', 'Gemini API Key를 삭제하시겠습니까?<br>삭제 후 규칙 기반 분석으로 동작합니다.', () => {
    Storage.deleteApiKey();
    const el = document.getElementById('setting-apikey');
    if (el) el.value = '';
    _updateApiStatus();
    showToast('API Key가 삭제되었습니다.', 'success');
  });
}

/* ============================================================
   백업 / 복원
============================================================ */
function exportData() {
  const data     = Storage.exportData();
  const json     = JSON.stringify(data, null, 2);
  const blob     = new Blob([json], { type: 'application/json' });
  const url      = URL.createObjectURL(blob);
  const now      = new Date();
  const dateStr  = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
  const timeStr  = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  const a        = document.createElement('a');
  a.href         = url;
  a.download     = `exam_memory_backup_${dateStr}_${timeStr}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('백업 파일이 다운로드되었습니다.', 'success');
}

function importData(input) {
  const file = input.files?.[0];
  if (!file) return;

  showConfirm(
    '데이터 가져오기',
    `"${file.name}" 파일로 복원하시겠습니까?<br>
     <span class="text-sec" style="font-size:12px">현재 데이터를 덮어씁니다. API Key는 유지됩니다.</span>`,
    () => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const payload = JSON.parse(e.target.result);
          Storage.importData(payload);
          _applySettings();
          navigate('dashboard');
          showToast('데이터 복원이 완료되었습니다.', 'success');
        } catch (err) {
          showToast('파일 오류: ' + err.message, 'danger');
        }
      };
      reader.readAsText(file);
    }
  );

  // input 초기화 (같은 파일 재선택 가능하게)
  input.value = '';
}

function resetAllData() {
  showConfirm(
    '데이터 초기화',
    '모든 문제, 학습 기록, 오답노트를 삭제합니다.<br><strong>복구할 수 없습니다.</strong>',
    () => {
      Storage.resetAllData();
      navigate('dashboard');
      showToast('모든 데이터가 초기화되었습니다.', 'success');
    }
  );
}

/* ============================================================
   토스트 알림
============================================================ */
function showToast(message, type = '') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s';
    toast.style.opacity    = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2800);
}

/* ============================================================
   확인 다이얼로그
============================================================ */
function showConfirm(title, message, onOk, cancelLabel = '취소') {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').innerHTML = message;

  const okBtn = document.getElementById('confirm-ok');
  if (okBtn) {
    // 기존 핸들러 제거
    const newOk = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOk, okBtn);

    if (onOk) {
      newOk.style.display = '';
      newOk.addEventListener('click', () => {
        closeModal('modal-confirm');
        onOk();
      });
    } else {
      newOk.style.display = 'none';
    }
  }

  const cancelBtn = document.querySelector('#modal-confirm .btn-outline');
  if (cancelBtn) cancelBtn.textContent = cancelLabel;

  openModal('modal-confirm');
}

/* ============================================================
   유틸
============================================================ */
function _esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _parseQuotaError(msg) {
  if (!msg) return '규칙 기반 분석으로 저장됨';
  if (msg.includes('quota') || msg.includes('Quota') || msg.includes('429')) {
    const sec = msg.match(/retry in\s+([\d.]+)s/i);
    const wait = sec ? `${Math.ceil(parseFloat(sec[1]))}초 후 재시도하세요.` : '잠시 후 재시도하세요.';
    return `API 한도 초과 — ${wait} (규칙 기반으로 저장됨)`;
  }
  return `AI 분석 실패: ${msg.slice(0, 60)} (규칙 기반으로 저장됨)`;
}

function _statusClass(status) {
  return { unseen:'status-unseen', learning:'status-learning', memorized:'status-memorized' }[status] || 'status-unseen';
}

function _statusText(status) {
  return { unseen:'미학습', learning:'학습중', memorized:'암기완료' }[status] || '미학습';
}

function _formatDate(iso) {
  if (!iso) return '';
  const d    = new Date(iso);
  const now  = new Date();
  const diff = Math.floor((now - d) / (1000 * 60 * 60 * 24));
  if (diff === 0) return '오늘';
  if (diff === 1) return '어제';
  if (diff <  7)  return `${diff}일 전`;
  return `${d.getMonth()+1}/${d.getDate()}`;
}
