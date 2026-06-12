/* ============================================================
   wrongnote.js  —  오답노트 렌더링 및 관리 모듈
============================================================ */

const WrongNote = (() => {

  /* ----------------------------------------------------------
     오답노트 페이지 렌더링
  ---------------------------------------------------------- */
  function render() {
    const notes     = Storage.getWrongNotes();
    const questions = Storage.getQuestions();
    const qMap      = Object.fromEntries(questions.map(q => [q.id, q]));

    // 틀린 횟수 내림차순 정렬
    const sorted = [...notes]
      .filter(n => qMap[n.questionId])          // 삭제된 문제 제외
      .sort((a, b) => b.wrongCount - a.wrongCount);

    // 헤더 카운트 업데이트
    const label = document.getElementById('wrong-count-label');
    if (label) label.textContent = `총 ${sorted.length}개 문제`;

    // 집중학습 버튼 활성화 여부
    const btn = document.getElementById('btn-study-wrong');
    if (btn) btn.disabled = sorted.length === 0;

    const container = document.getElementById('wrong-list');
    if (!container) return;

    if (sorted.length === 0) {
      container.innerHTML = _emptyState();
      return;
    }

    container.innerHTML = sorted.map(note => {
      const q = qMap[note.questionId];
      if (!q) return '';
      const record   = Storage.getRecord(q.id);
      const lastDate = note.lastWrong
        ? _formatDate(note.lastWrong)
        : '기록 없음';

      return `
        <div class="wrong-item" data-id="${q.id}">
          <div class="wrong-item-header">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
                <span class="subject-tag" style="background:${q.subjectColor || '#3b82f6'}">
                  ${_esc(q.subject)}
                </span>
                <span class="type-badge">${Analyzer.getTypeName(q.answerType)}</span>
                <span class="status-badge ${_statusClass(record.status)}">
                  ${_statusText(record.status)}
                </span>
              </div>
              <div class="question-text" style="font-size:14px;font-weight:500;line-height:1.55">
                ${_esc(q.question)}
              </div>
            </div>
            <div style="text-align:center;flex-shrink:0">
              <span class="wrong-count-badge">${note.wrongCount}회 오답</span>
              <div class="text-sec mt-1" style="font-size:11px;white-space:nowrap">
                ${lastDate}
              </div>
            </div>
          </div>

          ${_recentDots(note.recentResults)}

          ${_answerPreview(q)}

          <div class="question-actions">
            <button class="btn btn-primary btn-sm"
              onclick="WrongNote.studySingle('${q.id}')">
              집중 학습
            </button>
            <button class="btn btn-outline btn-sm"
              onclick="WrongNote.viewAnswer('${q.id}')">
              정답 보기
            </button>
            <button class="btn btn-ghost btn-sm"
              onclick="WrongNote.removeNote('${q.id}')">
              오답에서 제거
            </button>
          </div>
        </div>`;
    }).join('');
  }

  /* ----------------------------------------------------------
     최근 결과 점 표시 (최대 3개)
  ---------------------------------------------------------- */
  function _recentDots(recentResults) {
    if (!recentResults || recentResults.length === 0) return '';

    const dots = recentResults.slice(-3).map(r =>
      `<span class="dot ${r ? 'correct' : 'wrong'}" title="${r ? '정답' : '오답'}"></span>`
    ).join('');

    return `
      <div class="wrong-recent-dots">
        <span class="text-sec" style="font-size:11px;margin-right:4px">최근</span>
        ${dots}
      </div>`;
  }

  /* ----------------------------------------------------------
     답안 미리보기 (접기 가능)
  ---------------------------------------------------------- */
  function _answerPreview(q) {
    const analysis = q.analysis;
    const keywords = analysis?.keywords || [];

    if (keywords.length === 0) return '';

    const chips = keywords.slice(0, 6).map(kw =>
      `<span class="hint-kw">${_esc(kw)}</span>`
    ).join('');

    const more = keywords.length > 6
      ? `<span class="text-sec" style="font-size:11.5px">+${keywords.length - 6}개</span>`
      : '';

    return `
      <div style="margin:8px 0 4px">
        <div class="text-sec" style="font-size:11.5px;margin-bottom:5px">핵심 키워드</div>
        <div class="hint-keywords">${chips}${more}</div>
      </div>`;
  }

  /* ----------------------------------------------------------
     오답 집중학습 — 오답노트 전체 문제로 세션 시작
  ---------------------------------------------------------- */
  function studyAll() {
    const notes = Storage.getWrongNotes();
    if (notes.length === 0) {
      showToast('오답노트에 문제가 없습니다.', 'warning');
      return;
    }

    // study.js의 startStudyWithIds 호출
    Study.startWithIds(
      notes.map(n => n.questionId),
      { range: 'wrong', difficulty: 'easy', label: '오답 집중학습' }
    );
  }

  /* ----------------------------------------------------------
     단일 문제 집중학습
  ---------------------------------------------------------- */
  function studySingle(questionId) {
    Study.startWithIds(
      [questionId],
      { range: 'wrong', difficulty: 'easy', label: '1문제 집중학습' }
    );
  }

  /* ----------------------------------------------------------
     정답 보기 인라인 토글
  ---------------------------------------------------------- */
  function viewAnswer(questionId) {
    const q = Storage.getQuestion(questionId);
    if (!q) return;

    // 간이 모달 대신 confirm 모달에 내용 표시
    const keywords = q.analysis?.keywords || [];
    const keyChips = keywords.map(kw =>
      `<span class="keyword-highlight">${_esc(kw)}</span>`
    ).join(' ');

    const body = `
      <div class="mb-3">
        <div class="text-sec mb-1" style="font-size:12px">문제</div>
        <div style="font-weight:600;line-height:1.6">${_esc(q.question)}</div>
      </div>
      <div class="mb-3">
        <div class="text-sec mb-1" style="font-size:12px">정답</div>
        <div class="answer-reveal-box" style="white-space:pre-wrap">${_esc(q.answer)}</div>
      </div>
      ${keywords.length > 0 ? `
      <div>
        <div class="text-sec mb-1" style="font-size:12px">핵심 키워드</div>
        <div style="line-height:2">${keyChips}</div>
      </div>` : ''}`;

    showConfirm('정답 확인', body, null, '닫기');
  }

  /* ----------------------------------------------------------
     오답노트에서 수동 제거
  ---------------------------------------------------------- */
  function removeNote(questionId) {
    const q = Storage.getQuestion(questionId);
    const title = q ? `"${q.question.slice(0, 30)}..."` : '이 문제';

    showConfirm(
      '오답노트 제거',
      `${title}를 오답노트에서 제거하시겠습니까?<br>
       <span class="text-sec" style="font-size:12px">학습 기록은 유지됩니다.</span>`,
      () => {
        Storage.removeWrongNote(questionId);
        render();
        showToast('오답노트에서 제거했습니다.', 'success');
      }
    );
  }

  /* ----------------------------------------------------------
     내부 유틸
  ---------------------------------------------------------- */
  function _emptyState() {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">✓</div>
        <h3>오답노트가 비어 있습니다</h3>
        <p>틀린 문제가 없거나 모두 3회 연속 정답으로 자동 제거되었습니다.</p>
      </div>`;
  }

  function _statusClass(status) {
    return { unseen: 'status-unseen', learning: 'status-learning', memorized: 'status-memorized' }[status] || 'status-unseen';
  }

  function _statusText(status) {
    return { unseen: '미학습', learning: '학습중', memorized: '암기완료' }[status] || '미학습';
  }

  function _formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const diff = Math.floor((now - d) / (1000 * 60 * 60 * 24));
    if (diff === 0) return '오늘';
    if (diff === 1) return '어제';
    if (diff < 7)  return `${diff}일 전`;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function _esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ----------------------------------------------------------
     공개 API
  ---------------------------------------------------------- */
  return {
    render,
    studyAll,
    studySingle,
    viewAnswer,
    removeNote,
  };

})();
